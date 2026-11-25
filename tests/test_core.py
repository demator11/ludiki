import copy
import random
import unittest
from core import Room, PAYOUTS, simulate_house, simulate_strategies


class RoomTests(unittest.TestCase):
    def setUp(self):
        self.room = Room(rng=random.Random(123))
        self.player = self.room.join(None, "Tester")

    def start(self, scene):
        self.room.admin_action({"action":"scene","scene":scene})
        self.room.admin_action({"action":"start"})

    def act(self, action, **kwargs):
        self.room.participant_action(self.player, {"action":action,"epoch":self.room.state["epoch"],"nonce":str(random.random()),**kwargs})

    def test_house_accounting_round_limit_and_deduplication(self):
        self.start("house")
        data={"action":"play","choice":"heads","epoch":self.room.state["epoch"],"nonce":"same"}
        self.room.participant_action(self.player,data)
        self.room.participant_action(self.player,data)
        self.assertEqual(len(self.room.state["players"][self.player]["house"]),1)
        for _ in range(7): self.act("play",choice="tails")
        with self.assertRaises(ValueError): self.act("play",choice="heads")
        stats=self.room.stats()["house"]
        self.assertEqual(stats["turnover"],80)
        self.assertEqual(stats["house_net"],80-stats["payout"])
        self.assertEqual(stats["expected"],4)

    def test_pause_and_stale_scene(self):
        self.start("house")
        epoch=self.room.state["epoch"]
        self.room.admin_action({"action":"pause"})
        with self.assertRaises(ValueError): self.act("play",choice="heads")
        self.room.admin_action({"action":"reset_module"})
        self.room.admin_action({"action":"start"})
        with self.assertRaises(ValueError):
            self.room.participant_action(self.player,{"action":"play","choice":"heads","epoch":epoch,"nonce":"old"})

    def test_pairs_counterbalance_and_paired_mean(self):
        second=self.room.join(None,"Second")
        self.start("near")
        self.assertEqual(self.room.snapshot(token=self.player)["me"]["near_order"],["miss","near"])
        self.assertEqual(self.room.snapshot(token=second)["me"]["near_order"],["near","miss"])
        with self.assertRaises(ValueError): self.act("near_answer",kind="near",rating=5)
        self.act("near_spin",kind="miss")
        self.act("near_answer",kind="miss",rating=3)
        self.assertEqual(self.room.stats()["near"]["n"],0)
        self.act("near_spin",kind="near")
        self.act("near_answer",kind="near",rating=8)
        self.assertEqual(self.room.stats()["near"],{"miss":3,"near":8,"n":1})

    def test_near_exposure_order_dedup_and_public_privacy(self):
        self.start("near")
        with self.assertRaises(ValueError): self.act("near_answer",kind="miss",rating=4)
        with self.assertRaises(ValueError): self.act("near_spin",kind="near")
        data={"action":"near_spin","kind":"miss","epoch":self.room.state["epoch"],"nonce":"spin-once"}
        self.room.participant_action(self.player,data)
        self.room.participant_action(self.player,data)
        own=self.room.snapshot(token=self.player)["me"]
        event=copy.deepcopy(own["near_spins"]["miss"])
        self.assertTrue(event["id"])
        self.assertGreater(event["at"],0)
        with self.assertRaises(ValueError): self.act("near_spin",kind="miss")
        restored=Room(copy.deepcopy(self.room.state))
        self.assertEqual(restored.snapshot(token=self.player)["me"]["near_spins"]["miss"],event)
        self.assertTrue(self.room.snapshot("screen")["live_board"]["seats"][0]["viewing"])
        self.act("near_answer",kind="miss",rating=10)
        public=self.room.snapshot("screen")["live_board"]
        self.assertEqual((public["first"],public["second"],public["done"]),(1,0,1))
        self.assertFalse(public["seats"][0]["viewing"])
        import json
        for secret in [self.player,'Tester','"rating"','"group"','"miss"','"near_spins"']:
            self.assertNotIn(secret,json.dumps(public))
        self.room.admin_action({"action":"reset_module"})
        self.assertEqual(self.room.snapshot(token=self.player)["me"]["near_spins"],{})
        self.assertEqual(self.room.snapshot("screen")["live_board"]["recent"],[])

    def test_legacy_program_migration_keeps_answers_and_custom_text(self):
        old=copy.deepcopy(self.room.state)
        old["version"]=2
        old["config"]["enabled"]=["house","framing","near","strategies"]
        old["scene"]="strategies"
        old["config"]["modules"]["house"]["note"]="Custom host note"
        old["players"][self.player]["framing_answer"]={"wins":2,"balance":"negative"}
        old["players"][self.player]["near"]={"miss":7}
        old["players"][self.player].pop("near_spins")
        restored=Room(old)
        self.assertEqual(restored.state["config"]["enabled"],["house","near"])
        self.assertEqual(restored.state["scene"],"lobby")
        self.assertEqual(restored.state["players"][self.player]["near"],{"miss":7})
        self.assertEqual(restored.state["players"][self.player]["framing_answer"]["wins"],2)
        self.assertEqual(restored.state["config"]["modules"]["house"]["note"],"Custom host note")
        self.assertEqual(set(restored.snapshot("admin")["config"]["modules"]),{"house","near"})

    def test_public_state_does_not_leak_notes_results_or_tokens(self):
        self.start("house"); self.act("play",choice="heads")
        public=self.room.snapshot("screen")
        self.assertIsNone(public["stats"])
        self.assertNotIn("config",public)
        self.assertNotIn("people",public)
        self.assertNotIn("note",public["modules"]["house"])
        self.assertIsNone(public["me"])

    def test_demo_data_is_separate_and_restorable(self):
        self.start("house"); self.act("play",choice="heads")
        before=self.room.stats()
        self.room.admin_action({"action":"demo"})
        self.assertEqual(len(self.room.players()),20)
        self.assertEqual(self.room.stats()["house"]["rounds"],0)
        self.room.admin_action({"action":"start"})
        self.room.advance_demo()
        self.assertEqual(self.room.stats()["house"]["rounds"],4)
        self.room.admin_action({"action":"pause"})
        self.assertFalse(self.room.advance_demo())
        self.assertEqual(self.room.stats()["house"]["rounds"],4)
        self.room.admin_action({"action":"demo_finish"})
        self.assertEqual(self.room.stats()["house"]["rounds"],160)
        self.room.admin_action({"action":"reset_module"})
        self.assertEqual(len(self.room.state["players"][self.player]["house"]),1)
        with self.assertRaises(ValueError): self.act("play",choice="heads")
        self.room.admin_action({"action":"clear_demo"})
        self.assertEqual(self.room.stats(),before)
        self.assertTrue(self.room.state["paused"])
        self.assertEqual(self.room.state["scene"],"house")

    def test_demo_all_scenes_replay_speed_and_reveal(self):
        self.room.admin_action({"action":"demo"})
        for scene in ["house", "near"]:
            self.start(scene)
            self.room.admin_action({"action":"demo_speed", "speed":4})
            self.room.advance_demo()
            self.assertEqual(self.room.demo_board()["done"],16)
            self.room.admin_action({"action":"demo_finish"})
            board=self.room.snapshot("screen")["demo_board"]
            self.assertEqual(board["done"],board["total"])
            self.assertEqual(self.room.snapshot("screen")["progress"][scene],20)
            answers=copy.deepcopy(self.room.players())
            self.room.admin_action({"action":"reveal"})
            self.assertFalse(self.room.advance_demo())
            self.room.admin_action({"action":"reset_module"})
            self.assertEqual(self.room.demo_board()["done"],0)
            self.room.admin_action({"action":"demo_finish"})
            self.assertEqual(self.room.players(), answers)
        with self.assertRaises(ValueError): self.room.admin_action({"action":"demo_speed", "speed":True})
        with self.assertRaises(ValueError): self.room.admin_action({"action":"demo_speed", "speed":99})

    def test_demo_real_answers_survive_scene_changes_and_restart(self):
        self.start("near")
        self.act("near_spin",kind="miss")
        self.act("near_answer",kind="miss",rating=2)
        before=copy.deepcopy(self.room.state["players"][self.player])
        self.room.admin_action({"action":"demo"})
        self.start("house")
        self.room.advance_demo()
        restored=Room(copy.deepcopy(self.room.state))
        self.assertEqual(restored.demo_board()["done"],4)
        restored.admin_action({"action":"clear_demo"})
        self.assertEqual(restored.state["scene"],"near")
        self.assertEqual(restored.state["players"][self.player],before)
        self.assertFalse(any(p["demo"] for p in restored.state["players"].values()))

    def test_start_replays_completed_demo_but_keeps_real_answers(self):
        self.start("house")
        self.act("play", choice="heads")
        before=copy.deepcopy(self.room.state["players"][self.player])
        self.room.admin_action({"action":"demo"})
        self.room.admin_action({"action":"demo_finish"})
        self.room.admin_action({"action":"scene", "scene":"house"})
        self.room.admin_action({"action":"start"})
        self.assertEqual(self.room.demo_board()["done"],0)
        self.assertEqual(self.room.state["phase"],"running")
        self.assertEqual(self.room.state["players"][self.player],before)

    def test_config_disables_scene_and_validation_is_atomic(self):
        self.start("house")
        config=copy.deepcopy(self.room.state["config"])
        config["enabled"]=["near"]
        self.room.admin_action({"action":"config","config":config})
        self.assertEqual(self.room.state["scene"],"lobby")
        config=copy.deepcopy(self.room.state["config"])
        bad=copy.deepcopy(config); bad["public_url"]="javascript:alert(1)"
        with self.assertRaises(ValueError): self.room.admin_action({"action":"config","config":bad})
        self.assertEqual(self.room.state["config"],config)

    def test_simulation_math_and_nonnegative_bank(self):
        sim=simulate_house(seed=42)
        self.assertEqual(sim["expected"],50_000)
        self.assertEqual(sim["turnover"],1_000_000)
        self.assertEqual(sim["net"],sim["points"][-1]["y"])
        self.assertLess(abs(sim["net"]-sim["expected"]),10_000)
        result=simulate_strategies(seed=42,sessions=2000)
        for row in result["rows"]:
            self.assertGreaterEqual(row["p10"],-200)
            self.assertLess(row["mean"],0)
            self.assertAlmostEqual(row["expected"],-.05*row["turnover"],delta=.02)
            self.assertLessEqual(abs(row["mean"]-row["expected"]),12)

    def test_simulation_reveals_its_results_and_keeps_classroom_data(self):
        self.start("house")
        self.act("play",choice="heads")
        classroom=copy.deepcopy(self.room.stats()["house"])
        self.room.admin_action({"action":"pause"})
        result=simulate_house(seed=42)
        self.room.show_house_simulation(result)
        screen=self.room.snapshot("screen")
        self.assertEqual(screen["phase"],"reveal")
        self.assertFalse(screen["paused"])
        self.assertEqual(screen["house_view"],"simulation")
        self.assertEqual(screen["house_sim"]["turnover"],1_000_000)
        self.assertEqual(screen["stats"]["house"],classroom)
        self.room.admin_action({"action":"house_view","view":"audience"})
        self.assertEqual(self.room.snapshot("screen")["house_view"],"audience")
        self.assertEqual(self.room.stats()["house"],classroom)
        self.room.admin_action({"action":"house_view","view":"simulation"})
        self.assertEqual(self.room.snapshot("screen")["house_sim"],result)
        self.room.admin_action({"action":"start"})
        self.room.admin_action({"action":"reveal"})
        self.assertEqual(self.room.snapshot("screen")["house_view"],"audience")
        self.room.admin_action({"action":"house_view","view":"simulation"})
        self.room.admin_action({"action":"scene","scene":"house"})
        self.assertEqual(self.room.state["house_view"],"audience")
        self.room.admin_action({"action":"reset_module"})
        self.assertEqual(self.room.state["house_view"],"audience")
        self.assertIsNone(self.room.state["house_sim"])

    def test_legacy_session_and_simulation_requires_correct_scene(self):
        legacy=copy.deepcopy(self.room.state)
        legacy.pop("house_view")
        restored=Room(legacy)
        self.assertEqual(restored.snapshot()["house_view"],"audience")
        with self.assertRaises(ValueError): restored.show_house_simulation(simulate_house(seed=1,rounds=100))
        self.start("house")
        self.room.admin_action({"action":"reveal"})
        with self.assertRaises(ValueError): self.room.admin_action({"action":"house_view","view":"simulation"})

if __name__=="__main__": unittest.main()
