"""Integration check in an isolated temporary room; never touches the demo room."""
import asyncio
import contextlib
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

import httpx
import websockets

ROOT=Path(__file__).resolve().parents[1]

async def run(port, password):
    base=f"http://127.0.0.1:{port}"
    clients=[httpx.AsyncClient(base_url=base,timeout=15) for _ in range(20)]
    host=httpx.AsyncClient(base_url=base,timeout=15)
    sockets=[]; readers=[]; received=[0]
    async def drain(ws):
        try:
            async for message in ws:
                json.loads(message); received[0]+=1
        except websockets.ConnectionClosed: pass
    async def post(client,path,data):
        response=await client.post(path,json=data)
        assert response.status_code==200, (path,response.status_code,response.text)
        return response.json()
    async def admin(action,**extra): return await post(host,"/api/admin/action",{"action":action,**extra})
    try:
        assert (await host.post("/api/admin/action",json={"action":"demo"})).status_code==401
        await post(host,"/api/admin/login",{"password":password})
        players=await asyncio.gather(*(post(c,"/api/join",{"name":f"Load {i}"}) for i,c in enumerate(clients)))
        assert len({p["me"]["name"] for p in players})==20
        specs=[("participant",c.cookies) for c in clients]+[("screen",{})]*4+[("admin",host.cookies)]
        for role,cookies in specs:
            header="; ".join(f"{k}={v}" for k,v in cookies.items())
            ws=await websockets.connect(f"ws://127.0.0.1:{port}/ws?role={role}",extra_headers={"Cookie":header},open_timeout=10)
            sockets.append(ws); readers.append(asyncio.create_task(drain(ws)))
        assert len(sockets)==25
        await admin("scene",scene="house"); current=await admin("start")
        epoch=current["epoch"]
        async def action(c,act,**extra):
            return await post(c,"/api/action",{"action":act,"epoch":epoch,"nonce":secrets.token_hex(6),**extra})
        start=time.perf_counter()
        for _ in range(8): await asyncio.gather(*(action(c,"play",choice="heads") for c in clients))
        elapsed=time.perf_counter()-start
        current=await admin("simulate_house")
        assert current["phase"]=="reveal" and current["house_view"]=="simulation"
        screen=(await host.get("/api/state?role=screen")).json()
        assert screen["house_sim"]["turnover"]==1_000_000
        assert screen["house_sim"]==current["house_sim"]
        assert current["stats"]["house"]["rounds"]==160
        assert current["stats"]["house"]["completed"]==20
        assert current["online"]==20
        # Reconnect uses the original participant cookie and preserves all rounds.
        resumed=(await clients[0].get("/api/state")).json()
        assert len(resumed["me"]["house"])==8
        sim=await admin("simulate_house"); assert sim["house_sim"]["rounds"]==100000
        current=await admin("house_view",view="audience")
        assert current["stats"]["house"]["rounds"]==160
        assert (await host.get("/api/state?role=screen")).json()["house_view"]=="audience"
        await admin("house_view",view="simulation")
        await admin("scene",scene="near"); current=await admin("start"); epoch=current["epoch"]
        for i in range(2):
            await asyncio.gather(*(action(c,"near_spin",kind=players[idx]["me"]["near_order"][i]) for idx,c in enumerate(clients)))
            await asyncio.gather(*(action(c,"near_answer",kind=players[idx]["me"]["near_order"][i],rating=4+i) for idx,c in enumerate(clients)))
        current=await admin("reveal"); assert current["stats"]["near"]["n"]==20
        export=await host.get("/api/admin/export")
        assert export.status_code==200 and "ludiki_admin" not in export.text and password not in export.text
        assert (await clients[0].get("/api/admin/export")).status_code==401
        assert (await host.post("/api/admin/action",headers={"Origin":"http://evil.example"},json={"action":"demo"})).status_code==403
        qr=await host.get("/api/qr"); assert qr.status_code==200 and "<svg" in qr.text
        for path in ["/","/play","/screen","/admin","/static/app.js","/static/experience.js","/static/style.css"]:
            assert (await host.get(path)).status_code==200
        # The fallback progresses on the server even without an open host tab.
        real_stats=current["stats"]
        await admin("demo")
        await admin("scene",scene="house")
        await admin("start")
        for _ in range(30):
            await asyncio.sleep(.1)
            live=(await host.get("/api/state?role=screen")).json()
            if live["demo_board"]["done"]: break
        assert live["demo_board"]["done"]>0, "Demo clock did not advance"
        paused=await admin("pause")
        done=paused["demo_board"]["done"]
        await asyncio.sleep(1.1)
        assert (await host.get("/api/state?role=screen")).json()["demo_board"]["done"]==done
        await admin("demo_speed",speed=4)
        for scene in ["house","near"]:
            await admin("scene",scene=scene)
            complete=await admin("demo_finish")
            assert complete["progress"][scene]==20
            await admin("reveal")
        returned=await admin("clear_demo")
        assert returned["scene"]=="near" and returned["phase"]=="reveal"
        assert returned["stats"]==real_stats
        assert not returned["demo"] and returned["count"]==20
        print("Demo timer, pause, two scenes and return to real answers: passed")
        print(json.dumps({"ok":True,"websockets":25,"participants":20,"house_actions":160,"house_seconds":round(elapsed,2),"websocket_messages":received[0],"modules_completed":2,"auth_origin_qr_export":"passed"}))
    finally:
        await asyncio.gather(*(ws.close() for ws in sockets))
        await asyncio.gather(*readers,return_exceptions=True)
        await asyncio.gather(*(c.aclose() for c in clients),host.aclose())

def main():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1",0)); port=sock.getsockname()[1]
    with tempfile.TemporaryDirectory(prefix="ludiki-test-") as data:
        password=secrets.token_urlsafe(24)
        env={**os.environ,"LUDIKI_DATA_DIR":data,"ADMIN_PASSWORD":password}
        proc=subprocess.Popen([sys.executable,"-m","uvicorn","main:app","--host","127.0.0.1","--port",str(port),"--log-level","error"],cwd=ROOT,env=env,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,creationflags=getattr(subprocess,"CREATE_NO_WINDOW",0))
        try:
            for _ in range(80):
                try:
                    urllib.request.urlopen(f"http://127.0.0.1:{port}/api/health",timeout=.4);break
                except Exception: time.sleep(.1)
            else: raise RuntimeError("Test server did not start")
            asyncio.run(run(port,password))
            saved=json.loads((Path(data)/"state.json").read_text(encoding="utf-8"))
            assert len(saved["players"])==20 and saved["scene"]=="near"
            print("Persistence file: passed")
        finally:
            proc.terminate()
            try: proc.wait(timeout=8)
            except subprocess.TimeoutExpired: proc.kill();proc.wait()
            if proc.stdout: proc.stdout.close()

if __name__=="__main__": main()
