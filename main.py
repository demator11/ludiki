"""One-process classroom prototype with persistent state and WebSocket updates."""
from __future__ import annotations
import asyncio
from collections import defaultdict
from contextlib import asynccontextmanager, suppress
import io
import json
import os
from pathlib import Path
import secrets
import time
from urllib.parse import urlsplit

from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
import qrcode
import qrcode.image.svg
from core import Room, simulate_house, simulate_strategies

ROOT = Path(__file__).resolve().parent
DATA = Path(os.environ.get("LUDIKI_DATA_DIR", str(ROOT / "data")))
DATA.mkdir(parents=True, exist_ok=True)
STATE_FILE, KEY_FILE = DATA / "state.json", DATA / "admin-key.txt"
if not KEY_FILE.exists(): KEY_FILE.write_text(secrets.token_urlsafe(18), encoding="utf-8")
ADMIN_KEY = os.environ.get("ADMIN_PASSWORD") or KEY_FILE.read_text(encoding="utf-8").strip()
try:
    room = Room(json.loads(STATE_FILE.read_text(encoding="utf-8"))) if STATE_FILE.exists() else Room()
except (ValueError, OSError) as exc:
    raise RuntimeError("Не удалось прочитать data/state.json. Сохраните копию и проверьте файл.") from exc
lock = asyncio.Lock()
broadcast_lock = asyncio.Lock()
clients = {}
admin_sessions = {}
login_attempts = defaultdict(list)
sim_busy = False

def persist():
    room.state["revision"] += 1
    temp = STATE_FILE.with_suffix(".tmp")
    temp.write_text(json.dumps(room.state, ensure_ascii=False), encoding="utf-8")
    temp.replace(STATE_FILE)

def online_count():
    return len({token for role,token in clients.values() if role=="participant" and token in room.state["players"]})

def snapshot(role, token=None): return room.snapshot(role, token, online_count())

async def broadcast():
    async def send(ws, role, token):
        try: await asyncio.wait_for(ws.send_json(snapshot(role,token)), timeout=3)
        except Exception: clients.pop(ws,None)
    async with broadcast_lock:
        await asyncio.gather(*(send(ws,*info) for ws,info in list(clients.items())))

async def demo_clock():
    while True:
        await asyncio.sleep(1)
        async with lock:
            changed = room.advance_demo()
            if changed: persist()
        if changed: await broadcast()

@asynccontextmanager
async def lifespan(app):
    if room.state["demo"] and room.state["phase"] == "running":
        room.state["paused"] = True
        room.log("После перезапуска демонстрация на паузе. Нажмите «Продолжить»")
    persist()
    task = asyncio.create_task(demo_clock())
    try:
        yield
    finally:
        task.cancel()
        with suppress(asyncio.CancelledError): await task
        persist()

app = FastAPI(title="Ludiki",docs_url=None,redoc_url=None,openapi_url=None,lifespan=lifespan)
app.mount("/static",StaticFiles(directory=ROOT/"static"),name="static")

@app.middleware("http")
async def response_headers(request,call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"]="nosniff"
    response.headers["Referrer-Policy"]="same-origin"
    response.headers["X-Frame-Options"]="SAMEORIGIN"
    if request.url.path.startswith("/api/"): response.headers["Cache-Control"]="no-store"
    return response

def check_origin(request):
    origin = request.headers.get("origin")
    if origin and urlsplit(origin).netloc!=request.headers.get("host"):
        raise HTTPException(403,"Запрос с другого сайта отклонён.")

def is_admin(cookies): return admin_sessions.get(cookies.get("ludiki_admin",""),0)>time.time()

def require_admin(request):
    check_origin(request)
    if not is_admin(request.cookies): raise HTTPException(401,"Войдите в пульт ведущего.")

async def body(request):
    raw = await request.body()
    if len(raw)>(200_000 if request.url.path=="/api/admin/action" else 20_000): raise HTTPException(413,"Слишком большой запрос.")
    try:
        value=json.loads(raw)
        if not isinstance(value,dict): raise ValueError()
        return value
    except (ValueError,TypeError): raise HTTPException(400,"Некорректный JSON.")

@app.exception_handler(ValueError)
async def value_error(request,exc): return JSONResponse({"detail":str(exc)},status_code=400)

@app.get("/")
@app.get("/play")
@app.get("/screen")
@app.get("/admin")
async def index(): return FileResponse(ROOT/"static"/"index.html",headers={"Cache-Control":"no-cache"})

@app.get("/api/health")
async def health(): return {"ok":True,"app":"ludiki","version":"0.4.0"}

@app.get("/api/state")
async def get_state(request:Request,role:str="participant"):
    if role not in ["participant","screen","admin"]: raise HTTPException(400,"Неизвестная роль.")
    if role=="admin": require_admin(request)
    return snapshot(role,request.cookies.get("ludiki_player"))

@app.post("/api/join")
async def join(request:Request):
    check_origin(request)
    data=await body(request)
    async with lock:
        token=room.join(request.cookies.get("ludiki_player"),str(data.get("name","")))
        persist()
    response=JSONResponse(snapshot("participant",token))
    response.set_cookie("ludiki_player",token,httponly=True,samesite="strict",max_age=86400*7,secure=request.url.scheme=="https")
    await broadcast()
    return response

@app.post("/api/action")
async def action(request:Request):
    check_origin(request)
    data=await body(request)
    token=request.cookies.get("ludiki_player")
    async with lock:
        room.participant_action(token,data)
        persist()
    await broadcast()
    return snapshot("participant",token)

@app.post("/api/admin/login")
async def login(request:Request):
    check_origin(request)
    data=await body(request)
    host=request.client.host if request.client else "local"
    now=time.time()
    login_attempts[host]=[x for x in login_attempts[host] if now-x<60]
    if len(login_attempts[host])>=10: raise HTTPException(429,"Подождите минуту перед следующей попыткой.")
    login_attempts[host].append(now)
    if not secrets.compare_digest(str(data.get("password","")),ADMIN_KEY): raise HTTPException(401,"Неверный пароль ведущего.")
    token=secrets.token_urlsafe(32)
    admin_sessions[token]=now+12*3600
    response=JSONResponse({"ok":True})
    response.set_cookie("ludiki_admin",token,httponly=True,samesite="strict",max_age=12*3600,secure=request.url.scheme=="https")
    return response

@app.post("/api/admin/logout")
async def logout(request:Request):
    require_admin(request)
    admin_sessions.pop(request.cookies.get("ludiki_admin"),None)
    response=JSONResponse({"ok":True}); response.delete_cookie("ludiki_admin")
    return response

@app.post("/api/admin/action")
async def admin_action(request:Request):
    global sim_busy
    require_admin(request)
    data=await body(request)
    if data.get("action") in ["simulate_house","simulate_strategies"]:
        async with lock:
            if sim_busy: raise HTTPException(409,"Расчёт уже выполняется.")
            required_scene = "house" if data["action"] == "simulate_house" else "strategies"
            if room.state["scene"] != required_scene:
                raise HTTPException(400,"Сначала откройте соответствующий модуль.")
            sim_busy=True
            epoch,session=room.state["epoch"],room.state["session"]
        try:
            is_house=data["action"]=="simulate_house"
            result=await asyncio.to_thread(simulate_house if is_house else simulate_strategies)
            async with lock:
                if epoch!=room.state["epoch"] or session!=room.state["session"]: raise ValueError("Сцена изменилась во время расчёта. Запустите его ещё раз.")
                if is_house:
                    room.show_house_simulation(result)
                else:
                    room.state["strategy_sim"]=result
                room.log("Готова симуляция: "+("100 000 раундов" if is_house else "4 × 2 000 сессий"))
                persist()
        finally: sim_busy=False
    else:
        async with lock:
            room.admin_action(data)
            persist()
    await broadcast()
    return snapshot("admin")

@app.get("/api/admin/export")
async def export(request:Request):
    require_admin(request)
    result={"session":room.state["session"],"demo":room.state["demo"],"config":room.state["config"],"stats":room.stats(),"house_sim":room.state["house_sim"],"strategy_sim":room.state["strategy_sim"]}
    return Response(json.dumps(result,ensure_ascii=False,indent=2),media_type="application/json",headers={"Content-Disposition":'attachment; filename="ludiki-results.json"'})

@app.get("/api/qr")
async def qr(request:Request):
    url=(room.state["config"]["public_url"] or str(request.base_url).rstrip("/"))+"/play"
    img=qrcode.make(url,image_factory=qrcode.image.svg.SvgPathImage,box_size=8,border=3)
    buffer=io.BytesIO(); img.save(buffer)
    return Response(buffer.getvalue(),media_type="image/svg+xml",headers={"Cache-Control":"no-cache"})

@app.websocket("/ws")
async def websocket(ws:WebSocket,role:str="participant"):
    origin=ws.headers.get("origin")
    if origin and urlsplit(origin).netloc!=ws.headers.get("host"):
        await ws.close(code=1008); return
    if role not in ["participant","screen","admin"] or (role=="admin" and not is_admin(ws.cookies)):
        await ws.close(code=1008); return
    token=ws.cookies.get("ludiki_player")
    await ws.accept()
    clients[ws]=(role,token)
    await broadcast()
    try:
        while True:
            message=await ws.receive_text()
            if role=="admin" and not is_admin(ws.cookies):
                await ws.close(code=1008); break
            if message=="ping": await ws.send_json({"type":"pong"})
    except (WebSocketDisconnect,RuntimeError): pass
    finally:
        clients.pop(ws,None)
        await broadcast()

if __name__=="__main__":
    import uvicorn
    print("Ludiki: http://localhost:8000 | Пульт: /admin | Пароль: data/admin-key.txt")
    uvicorn.run(app,host=os.environ.get("HOST","127.0.0.1"),port=int(os.environ.get("PORT","8000")),proxy_headers=True,forwarded_allow_ips="127.0.0.1")
