"""Authoritative rules and classroom simulations."""
from __future__ import annotations
import copy
import random
import secrets
import statistics
import time
from texts import validate_texts, apply_text_edit

MODULES = {
    "house": {"title": "По ту сторону казино", "subtitle": "Одна монетка. Два взгляда на результат.", "minutes": "4–5 минут", "note": "Соберите несколько раундов. Раскройте оборот и выплаты, затем запустите большую симуляцию. Короткая сессия вполне может закончиться прибылью игроков.", "takeaway": "Случайность может быть честной. Условия выплат — неравными."},
    "framing": {"title": "Выигрыш или потеря?", "subtitle": "Одинаковые числа. Разное впечатление.", "minutes": "3–4 минуты", "note": "Участники распределяются между нейтральной и праздничной подачей одинаковых 8 выплат. Дождитесь оценок и раскройте сравнение. Маленькая выборка — повод для обсуждения, не доказательство эффекта.", "takeaway": "Возврат части ставки ещё не означает прибыль."},
    "near": {"title": "Почти получилось", "subtitle": "Когда проигрыш выглядит близким к победе.", "minutes": "2–3 минуты", "note": "Каждый оценивает оба исхода. Порядок показа чередуется. Сравниваются только полные пары оценок; оба исхода — проигрыши. Это иллюстрация, а не клинический тест.", "takeaway": "«Почти» не повышает шанс следующего независимого раунда."},
    "strategies": {"title": "Можно ли обыграть систему?", "subtitle": "Проверяем идеи на тысячах виртуальных сессий.", "minutes": "4–5 минут", "note": "Обсудите четыре правила и соберите прогнозы. Запустите расчёт, затем сравните средний итог, долю прибыльных сессий и риск остаться без минимальной ставки. У стратегий разный оборот: частота выигрышей не равна выгодности.", "takeaway": "Часто выигрывать понемногу и быть в плюсе в среднем — разные вещи."},
}
STRATEGIES = [
    {"id": "flat", "name": "Ровная ставка", "detail": "По 10 очков каждый раунд, до 100 раундов."},
    {"id": "double", "name": "Увеличивать после потери", "detail": "После проигрыша ставка ×2, максимум 80. После выигрыша снова 10."},
    {"id": "stop", "name": "Зафиксировать плюс", "detail": "По 10 очков. Остановиться, когда прибыль достигнет 30."},
    {"id": "history", "name": "Верить в смену серии", "detail": "По 10 очков на сторону, противоположную предыдущему броску."},
]
PAYOUTS = [0, 4, 18, 6, 0, 4, 0, 20]
ACTIVE_MODULES = ["house", "near"]

def fresh_state(config=None):
    return {"version": 3, "session": secrets.token_hex(4), "epoch": secrets.token_hex(8), "scene": "lobby", "phase": "intro", "paused": False, "demo": False,
            "config": config or {"title": "Казино под микроскопом", "public_url": "", "house_rounds": 8, "enabled": list(ACTIVE_MODULES), "modules": copy.deepcopy(MODULES)},
            "players": {}, "house_sim": None, "house_view": "audience", "strategy_sim": None, "events": [],
            "revision": 0, "activity": [], "demo_run": {"speed": 1, "recent": [], "return_to": None}}

def empty_answers():
    return {"house": [], "framing_index": 0, "framing_answer": None, "near": {}, "near_spins": {}, "strategy": None, "seen": []}

class Room:
    def __init__(self, state=None, rng=None):
        self.state = state or fresh_state()
        self.state.setdefault("house_view", "audience")
        self.state.setdefault("revision", 0)
        self.state.setdefault("demo_run", {"speed": 1, "recent": [], "return_to": None})
        self.state.setdefault("activity", [])
        self.state["config"].setdefault("texts", {})
        self.state["config"].setdefault("text_version", 0)
        self.state["config"]["enabled"] = [k for k in self.state["config"]["enabled"] if k in ACTIVE_MODULES] or list(ACTIVE_MODULES)
        if self.state["scene"] not in ["lobby", "finish"] + self.state["config"]["enabled"]:
            self.state.update(scene="lobby", phase="intro", paused=False, epoch=secrets.token_hex(8))
        return_to = self.state["demo_run"].get("return_to")
        if return_to and return_to["scene"] not in ["lobby", "finish"] + self.state["config"]["enabled"]:
            return_to.update(scene="lobby", phase="intro", paused=False, house_view="audience")
        for p in self.state["players"].values(): p.setdefault("near_spins", {})
        self.state["version"] = 3
        self.rng = rng or random.SystemRandom()

    def log(self, message):
        self.state["events"] = ([{"at": time.strftime("%H:%M:%S"), "text": message}] + self.state["events"])[:30]

    def join(self, token, name):
        players = self.state["players"]
        if token in players and not players[token]["demo"]: return token
        actual = len([p for p in players.values() if not p["demo"]])
        if actual >= 80: raise ValueError("Комната заполнена (80 участников).")
        token = secrets.token_urlsafe(24)
        players[token] = {"name": name.strip()[:28] or f"Участник {actual+1}", "group": "A" if actual % 2 == 0 else "B", "demo": False, **empty_answers()}
        self.log("Подключился участник")
        return token

    def players(self):
        return [p for p in self.state["players"].values() if p["demo"] == self.state["demo"]]

    def stats(self):
        ps = self.players()
        rounds = [x for p in ps for x in p["house"]]
        turnover, payout = len(rounds)*10, sum(x["payout"] for x in rounds)
        framing = []
        for group in ["A", "B"]:
            answers = [p["framing_answer"] for p in ps if p["group"] == group and p["framing_answer"] is not None]
            framing.append({"group": group, "n": len(answers), "mean": round(statistics.mean(x["wins"] for x in answers), 2) if answers else None, "positive": sum(x["balance"] == "positive" for x in answers)})
        pairs = [p["near"] for p in ps if set(p["near"]) == {"miss", "near"}]
        near = {k: round(statistics.mean(p[k] for p in pairs), 2) if pairs else None for k in ["miss", "near"]}
        return {"house": {"rounds": len(rounds), "turnover": turnover, "payout": payout, "house_net": turnover-payout, "expected": round(turnover*.05, 2), "positive": sum(sum(x["payout"]-10 for x in p["house"]) > 0 for p in ps), "completed": sum(len(p["house"]) >= self.state["config"]["house_rounds"] for p in ps)},
                "framing": framing, "framing_completed": sum(p["framing_answer"] is not None for p in ps), "near": {**near, "n": len(pairs)}, "strategies": {x["id"]: sum(p["strategy"] == x["id"] for p in ps) for x in STRATEGIES}}

    def snapshot(self, role="participant", token=None, online=0):
        s, stats = self.state, self.stats()
        revealed = s["phase"] == "reveal"
        progress = {"house": stats["house"]["completed"], "framing": stats["framing_completed"], "near": stats["near"]["n"], "strategies": sum(stats["strategies"].values())}
        out = {"session": s["session"], "epoch": s["epoch"], "scene": s["scene"], "phase": s["phase"], "paused": s["paused"], "demo": s["demo"], "title": s["config"]["title"], "public_url": s["config"]["public_url"], "enabled": s["config"]["enabled"],
               "modules": {k: {f: v[f] for f in ["title", "subtitle", "minutes", "takeaway"]} for k,v in s["config"]["modules"].items() if k in ACTIVE_MODULES}, "house_rounds": s["config"]["house_rounds"], "count": len(self.players()), "online": online, "progress": progress, "strategies": STRATEGIES,
               "stats": stats if revealed or role == "admin" else None, "house_view": s["house_view"], "house_sim": s["house_sim"] if revealed or role == "admin" else None, "strategy_sim": s["strategy_sim"] if revealed or role == "admin" else None}
        if role == "admin":
            out.update(config=copy.deepcopy(s["config"]), events=s["events"], people=[{"name": p["name"], "group": p["group"], "demo": p["demo"], "rounds": len(p["house"])} for p in s["players"].values()])
            out["text_defaults"] = {"title":"Казино под микроскопом", "modules":{k:copy.deepcopy(MODULES[k]) for k in ACTIVE_MODULES}}
            out["config"]["modules"] = {k:v for k,v in out["config"]["modules"].items() if k in ACTIVE_MODULES}
        if role == "participant" and token in s["players"]:
            p = s["players"][token]
            index = p["framing_index"]
            out["me"] = {"name": p["name"], "group": p["group"], "house": p["house"], "balance": 200+sum(x["payout"]-10 for x in p["house"]), "framing_index": index, "framing_total": len(PAYOUTS), "framing_last": PAYOUTS[index-1] if index else None, "framing_answer": p["framing_answer"], "near": p["near"], "near_spins": p["near_spins"], "near_order": ["miss", "near"] if p["group"] == "A" else ["near", "miss"], "strategy": p["strategy"]}
        else: out["me"] = None
        out["texts"] = s["config"].get("texts", {})
        out["revision"] = s["revision"]
        out["server_time"] = time.time()
        out["live_board"] = self.live_board() if not s["demo"] and s["scene"] in ACTIVE_MODULES else None
        out["demo_board"] = self.demo_board() if s["demo"] else None
        return out

    def live_board(self):
        # Only anonymous progress and coin outcomes are public. Never expose personal ratings.
        s = self.state
        seats = []
        for i, p in enumerate(self.players()):
            step, total = self.demo_progress(p)
            viewing = s["scene"] == "near" and any(k not in p["near"] for k in p["near_spins"])
            seats.append({"id": f"seat-{i+1}", "label": f"{i+1:02}", "step": step, "total": total, "viewing": viewing})
        recent = [e for e in s["activity"] if e["scene"] == s["scene"] and e["epoch"] == s["epoch"]]
        return {"seats": seats, "done": sum(p["step"] for p in seats), "total": sum(p["total"] for p in seats),
                "first": sum(p["step"] >= 1 for p in seats), "second": sum(p["step"] >= 2 for p in seats), "recent": recent[:6]}

    def record_activity(self, token, kind, **details):
        s = self.state
        real_tokens = [k for k,p in s["players"].items() if not p["demo"]]
        event = {"id": secrets.token_hex(8), "at": time.time(), "scene": s["scene"], "epoch": s["epoch"],
                 "seat": f"{real_tokens.index(token)+1:02}", "kind": kind, **details}
        s["activity"] = ([event] + s["activity"])[:12]
        return event

    def demo_progress(self, p):
        scene = self.state["scene"]
        if scene == "house": return len(p["house"]), self.state["config"]["house_rounds"]
        if scene == "framing": return p["framing_index"] + int(p["framing_answer"] is not None), 9
        if scene == "near": return len(p["near"]), 2
        if scene == "strategies": return int(p["strategy"] is not None), 1
        return 0, 1

    def demo_board(self):
        bots = [{"name": p["name"], "group": p["group"], "step": self.demo_progress(p)[0],
                 "total": self.demo_progress(p)[1]} for p in self.players()]
        return {"speed": self.state["demo_run"]["speed"], "bots": bots,
                "done": sum(p["step"] for p in bots), "total": sum(p["total"] for p in bots),
                "recent": self.state["demo_run"]["recent"]}

    def enter_demo(self):
        s = self.state
        if s["demo"]: return
        return_to = {k: s[k] for k in ["scene", "phase", "paused", "house_view"]}
        s["players"] = {k: p for k, p in s["players"].items() if not p["demo"]}
        for i in range(20):
            s["players"][f"demo-{i}"] = {"name": f"Бот {i+1:02}", "demo": True,
                                         "group": "A" if i % 2 == 0 else "B", **empty_answers()}
        s.update(demo=True, phase="intro", paused=False, house_view="audience", epoch=secrets.token_hex(8),
                 demo_run={"speed": 1, "recent": [], "return_to": return_to})
        self.log("Демонстрация: 20 ботов. Реальные ответы сохранены отдельно")

    def advance_demo(self, finish=False):
        """Replay a labelled, reproducible example; ratings are invented, not predicted."""
        s = self.state
        if not s["demo"] or s["scene"] not in MODULES or s["phase"] != "running" or s["paused"]:
            return False
        budget = 1000 if finish else 4 * s["demo_run"]["speed"]
        changed = False
        for _ in range(budget):
            available = [(self.demo_progress(p)[0], i, p) for i, p in enumerate(self.players())
                         if self.demo_progress(p)[0] < self.demo_progress(p)[1]]
            if not available: break
            step, i, p = min(available, key=lambda item: (item[0], (item[1]*7) % 20))
            r = random.Random(f"ludiki-demo:{s['scene']}:{i}:{step}")
            event = {"id": secrets.token_hex(8), "at": time.time(), "name": p["name"], "group": p["group"], "step": step + 1, "scene": s["scene"]}
            if s["scene"] == "house":
                choice, outcome = r.choice(["heads", "tails"]), r.choice(["heads", "tails"])
                payout = 19 if choice == outcome else 0
                p["house"].append({"choice": choice, "outcome": outcome, "payout": payout})
                event.update(outcome=outcome, payout=payout, text=f"{'Орёл' if outcome == 'heads' else 'Решка'} · {payout-10:+} очков")
            elif s["scene"] == "framing":
                if step < 8:
                    p["framing_index"] += 1
                    event.update(payout=PAYOUTS[step], text=f"Раунд {step+1} · возврат {PAYOUTS[step]}")
                else:
                    p["framing_answer"] = {"wins": r.choice([1, 2, 3] if p["group"] == "A" else [2, 3, 4, 5]), "balance": "negative"}
                    event["text"] = "Отправлена вымышленная оценка"
            elif s["scene"] == "near":
                order = ["miss", "near"] if p["group"] == "A" else ["near", "miss"]
                kind = order[step]
                rating = r.randint(1, 6) if kind == "miss" else r.randint(2, 9)
                p["near"][kind] = rating
                event.update(kind=kind, rating=rating, text=f"{'Почти выигрыш' if kind == 'near' else 'Обычный проигрыш'} · оценка {rating}/10")
            else:
                strategy = STRATEGIES[r.randrange(len(STRATEGIES))]
                p["strategy"] = strategy["id"]
                event.update(choice=strategy["id"], text=strategy["name"])
            s["demo_run"]["recent"] = ([event] + s["demo_run"]["recent"])[:4]
            changed = True
        if changed and all(self.demo_progress(p)[0] == self.demo_progress(p)[1] for p in self.players()):
            self.log("Боты завершили сцену. Можно раскрыть результаты")
        return changed

    def participant_action(self, token, data):
        s = self.state
        if token not in s["players"]: raise ValueError("Сначала войдите в комнату.")
        p = s["players"][token]
        if data.get("epoch") != s["epoch"]: raise ValueError("Сцена уже изменилась. Повторите действие на новом экране.")
        nonce = str(data.get("nonce", ""))[:80]
        if not nonce: raise ValueError("Не указан идентификатор действия.")
        if nonce in p["seen"]: return
        if s["phase"] != "running" or s["paused"] or s["demo"]: raise ValueError("Ведущий пока не принимает ответы.")
        action = data.get("action")
        if s["scene"] == "house" and action == "play":
            choice = data.get("choice")
            if choice not in ["heads", "tails"] or len(p["house"]) >= s["config"]["house_rounds"]: raise ValueError("Этот раунд недоступен.")
            outcome = self.rng.choice(["heads", "tails"])
            event = self.record_activity(token, "coin", outcome=outcome, payout=19 if outcome == choice else 0)
            p["house"].append({"outcome": outcome, "choice": choice, "payout": event["payout"], "id": event["id"], "at": event["at"]})
        elif s["scene"] == "framing" and action == "frame_next":
            if p["framing_index"] >= len(PAYOUTS): raise ValueError("Все результаты уже показаны.")
            p["framing_index"] += 1
        elif s["scene"] == "framing" and action == "frame_answer":
            wins, balance = data.get("wins"), data.get("balance")
            if p["framing_index"] != len(PAYOUTS) or p["framing_answer"] is not None or type(wins) is not int or not 0 <= wins <= len(PAYOUTS) or balance not in ["positive", "negative", "zero"]: raise ValueError("Проверьте ответы; их можно отправить один раз.")
            p["framing_answer"] = {"wins": wins, "balance": balance}
        elif s["scene"] == "near" and action == "near_spin":
            order = ["miss", "near"] if p["group"] == "A" else ["near", "miss"]
            remaining = [k for k in order if k not in p["near"]]
            kind = data.get("kind")
            if not remaining or kind != remaining[0] or kind in p["near_spins"]:
                raise ValueError("Этот исход уже открыт или пока недоступен.")
            event = self.record_activity(token, "viewing")
            p["near_spins"][kind] = {"id": event["id"], "at": event["at"]}
        elif s["scene"] == "near" and action == "near_answer":
            kind, rating = data.get("kind"), data.get("rating")
            order = ["miss", "near"] if p["group"] == "A" else ["near", "miss"]
            remaining = [k for k in order if k not in p["near"]]
            if not remaining or kind != remaining[0] or kind not in p["near_spins"] or type(rating) is not int or not 0 <= rating <= 10: raise ValueError("Оцените текущий исход от 0 до 10.")
            p["near"][kind] = rating
            self.record_activity(token, "answer")
        elif s["scene"] == "strategies" and action == "strategy":
            if data.get("choice") not in [x["id"] for x in STRATEGIES] or p["strategy"] is not None: raise ValueError("Прогноз уже принят или правило неизвестно.")
            p["strategy"] = data["choice"]
        else: raise ValueError("Действие не относится к текущей сцене.")
        p["seen"] = (p["seen"] + [nonce])[-40:]

    def reset_module(self):
        scene = self.state["scene"]
        for p in self.players():
            if scene == "house": p["house"] = []
            elif scene == "framing": p.update(framing_index=0, framing_answer=None)
            elif scene == "near": p.update(near={}, near_spins={})
            elif scene == "strategies": p["strategy"] = None
            p["seen"] = []
        if scene == "house": self.state.update(house_sim=None, house_view="audience")
        if scene == "strategies": self.state["strategy_sim"] = None
        self.state["demo_run"]["recent"] = []
        self.state["activity"] = []
        self.state.update(phase="intro", paused=False, epoch=secrets.token_hex(8))

    def show_house_simulation(self, result):
        if self.state["scene"] != "house":
            raise ValueError("Симуляция монетки доступна только в модуле «По ту сторону казино».")
        # Keep the actual classroom answers intact; the slide explicitly selects its data source.
        self.state.update(house_sim=result, house_view="simulation", phase="reveal", paused=False)

    def admin_action(self, data):
        s, action = self.state, data.get("action")
        if action == "scene":
            scene = data.get("scene")
            if scene not in ["lobby", "finish"] + s["config"]["enabled"]: raise ValueError("Сцена отключена или неизвестна.")
            s.update(scene=scene, phase="intro", paused=False, epoch=secrets.token_hex(8))
            s["demo_run"]["recent"] = []
            if scene == "house": s["house_view"] = "audience"
            self.log("Сцена: " + scene)
        elif action == "start":
            if s["scene"] not in MODULES: raise ValueError("Сначала выберите модуль.")
            if s["demo"] and self.demo_board()["done"] == self.demo_board()["total"]:
                self.reset_module()
            if s["scene"] == "house": s["house_view"] = "audience"
            s.update(phase="running", paused=False); self.log("Приём ответов открыт")
        elif action == "pause":
            if s["phase"] != "running": raise ValueError("Пауза доступна во время сбора ответов.")
            s["paused"] = not s["paused"]
            self.log("Пауза" if s["paused"] else "Продолжение")
        elif action == "reveal":
            if s["scene"] not in MODULES: raise ValueError("Сначала выберите модуль.")
            s.update(phase="reveal", paused=False); self.log("Результаты раскрыты")
        elif action == "reset_module":
            self.reset_module(); self.log("Ответы текущей сцены сброшены")
        elif action == "reset_session":
            revision = s["revision"]
            self.state = fresh_state(copy.deepcopy(s["config"]))
            self.state["revision"] = revision
            self.log("Новая сессия")
        elif action == "house_view":
            view = data.get("view")
            if s["scene"] != "house" or s["phase"] != "reveal" or view not in ["audience", "simulation"]:
                raise ValueError("Выбор данных доступен при разборе модуля с монеткой.")
            if view == "simulation" and not s["house_sim"]:
                raise ValueError("Сначала запустите симуляцию.")
            s["house_view"] = view
            self.log("На слайде: " + ("симуляция 100 000 раундов" if view == "simulation" else "результаты аудитории"))
        elif action == "texts":
            s["config"] = apply_text_edit(s["config"], data, ACTIVE_MODULES)
            self.log("Надписи обновлены")
        elif action == "config":
            if 'expected_version' in data and data['expected_version'] != s['config'].get('text_version',0):
                raise ValueError('Настройки уже изменились в другом окне. Закройте и снова откройте настройки.')
            config = data.get("config", {})
            if not isinstance(config, dict) or not isinstance(config.get("modules", {}), dict):
                raise ValueError("Некорректный файл программы.")
            enabled = config.get("enabled", [])
            if not isinstance(enabled, list) or not enabled or any(not isinstance(x,str) for x in enabled) or len(set(enabled)) != len(enabled) or any(x not in MODULES for x in enabled): raise ValueError("Оставьте хотя бы один модуль; повторы недопустимы.")
            enabled = [k for k in enabled if k in ACTIVE_MODULES] or list(ACTIVE_MODULES)
            rounds = config.get("house_rounds", 8)
            if type(rounds) is not int or not 4 <= rounds <= 20: raise ValueError("Число раундов: от 4 до 20.")
            if rounds != s["config"]["house_rounds"] and any(p["house"] for p in s["players"].values()): raise ValueError("Перед изменением числа раундов сбросьте модуль с монеткой.")
            public_url = str(config.get("public_url", "")).strip().rstrip("/")
            if public_url:
                from urllib.parse import urlsplit
                u = urlsplit(public_url)
                if u.scheme not in ["http", "https"] or not u.hostname or u.username or u.password or u.query or u.fragment or u.path not in ["", "/"] or len(public_url) > 250: raise ValueError("Нужен базовый HTTP(S)-адрес без пути и параметров.")
            modules = copy.deepcopy(s["config"]["modules"])
            for key in MODULES:
                fields = config.get("modules", {}).get(key, {})
                if not isinstance(fields, dict): raise ValueError("Некорректные тексты модуля.")
                for field, limit in [("title",80),("subtitle",180),("note",1200),("takeaway",240),("minutes",40)]:
                    if field in fields:
                        val = str(fields[field]).strip()
                        if not val or len(val)>limit: raise ValueError(f"Проверьте текст {key}/{field} (до {limit} символов).")
                        modules[key][field] = val
            title = str(config.get("title", "")).strip()
            if not title or len(title)>90: raise ValueError("Название должно содержать 1–90 символов.")
            texts = validate_texts(config.get("texts", s["config"].get("texts", {})))
            text_version = s["config"].get("text_version",0)+1
            s["config"] = {"texts":texts,"text_version":text_version,"title":title,"public_url":public_url,"house_rounds":rounds,"enabled":enabled,"modules":modules}
            if s["scene"] in MODULES and s["scene"] not in enabled: s.update(scene="lobby",phase="intro",paused=False,epoch=secrets.token_hex(8))
            self.log("Настройки сохранены")
        elif action == "demo":
            self.enter_demo()
        elif action == "demo_speed":
            speed = data.get("speed")
            if not s["demo"] or type(speed) is not int or speed not in [1, 2, 4]:
                raise ValueError("Скорость демонстрации: 1, 2 или 4.")
            s["demo_run"]["speed"] = speed
        elif action == "demo_finish":
            if not s["demo"] or s["scene"] not in MODULES:
                raise ValueError("Выберите сцену в режиме демонстрации.")
            if s["phase"] == "reveal": raise ValueError("Результаты уже раскрыты.")
            s.update(phase="running", paused=False)
            self.advance_demo(finish=True)
        elif action == "clear_demo":
            if not s["demo"]: return
            return_to = s["demo_run"]["return_to"]
            s["players"] = {k:p for k,p in s["players"].items() if not p["demo"]}
            s.update(demo=False,phase="intro",paused=False,epoch=secrets.token_hex(8))
            if return_to and return_to["scene"] in ["lobby", "finish"] + s["config"]["enabled"]:
                s.update(return_to)
                if s["phase"] == "running": s["paused"] = True
                if s["house_view"] == "simulation" and not s["house_sim"]: s["house_view"] = "audience"
            s["demo_run"]["recent"] = []
            s["demo_run"]["return_to"] = None
            self.log("Возврат к аудитории. Ответы сохранены")
        else: raise ValueError("Неизвестная команда ведущего.")

def simulate_house(seed=None, rounds=100_000):
    rng = random.Random(seed)
    net, points = 0, [{"x":0,"y":0}]
    for i in range(1,rounds+1):
        net += -9 if rng.random()<.5 else 10
        if i % max(1,rounds//100)==0: points.append({"x":i,"y":net})
    return {"rounds":rounds,"turnover":rounds*10,"net":net,"expected":rounds*.5,"points":points}

def simulate_strategies(seed=None, sessions=2000, max_rounds=100):
    rng = random.Random(seed)
    streams = [[rng.random()<.5 for _ in range(max_rounds)] for _ in range(sessions)]
    rows = []
    for strategy in STRATEGIES:
        profits, turns, bets, broke = [], [], [], 0
        for stream in streams:
            bank, stake, turnover, played, previous = 200.0,10,0,0,True
            for outcome in stream:
                if bank<10 or (strategy["id"]=="stop" and bank>=230): break
                wager = min(stake,80,bank)
                choice = not previous if strategy["id"]=="history" else True
                won = choice==outcome
                bank = round(bank + (.9*wager if won else -wager),8)
                turnover += wager; played += 1; previous = outcome
                stake = min(80,stake*2) if strategy["id"]=="double" and not won else 10
            profits.append(bank-200); turns.append(played); bets.append(turnover); broke += bank<10
        ordered = sorted(profits)
        rows.append({**strategy,"positive":round(100*sum(x>0 for x in profits)/sessions,1),"mean":round(statistics.mean(profits),2),"broke":round(100*broke/sessions,1),"turnover":round(statistics.mean(bets),1),"rounds":round(statistics.mean(turns),1),"expected":round(-.05*statistics.mean(bets),2),"p10":round(ordered[int(sessions*.1)],1),"p90":round(ordered[int(sessions*.9)],1)})
    return {"sessions":sessions,"max_rounds":max_rounds,"initial":200,"min_bet":10,"max_bet":80,"rows":rows}
