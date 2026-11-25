import copy
import json
import unittest
from core import Room
from texts import CATALOG, validate_texts


class TextTests(unittest.TestCase):
    def setUp(self):
        self.room = Room()
        self.plain = next(r for r in CATALOG if r['default'] == 'Орёл')
        self.dynamic = next(r for r in CATALOG if r['tokens'])

    def edit(self, **changes):
        payload = dict(action='texts', expected_version=self.room.state['config']['text_version'], texts={self.plain['id']: 'Сторона A'}, fields={})
        payload.update(changes)
        self.room.admin_action(payload)

    def test_edit_during_game_preserves_every_game_field_and_restart(self):
        player = self.room.join(None, 'Tester')
        self.room.admin_action(dict(action='scene', scene='house'))
        self.room.admin_action(dict(action='start'))
        self.room.participant_action(player,dict(action='play',choice='heads',epoch=self.room.state['epoch'],nonce='first'))
        before=copy.deepcopy(self.room.state)
        self.edit(fields={'title':'Новое название','modules.house.minutes':'5 минут'})
        for key in before:
            if key not in ('config','events'): self.assertEqual(before[key],self.room.state[key],key)
        restored=Room(json.loads(json.dumps(self.room.state)))
        self.assertEqual(restored.state,self.room.state)
        for role in ['screen','participant','admin']:
            snap=restored.snapshot(role,player)
            self.assertEqual(snap['texts'],{self.plain['id']:'Сторона A'})
            self.assertEqual(snap['title'],'Новое название')
            if role!='admin': self.assertNotIn('note',snap['modules']['house'])

    def test_invalid_edits_are_atomic(self):
        bad=[dict(texts=[]),dict(texts={'unknown':'x'}),dict(texts={self.plain['id']:None}),dict(texts={self.plain['id']:''}),dict(texts={self.plain['id']:'a'*(self.plain['limit']+1)}),dict(texts={self.dynamic['id']:'Lost tokens'}),dict(fields={'public_url':'https://bad.example'}),dict(fields={'modules.house.title':''}),dict(fields={'title':'x'*91}),dict(expected_version=True),dict(expected_version=-1)]
        for change in bad:
            with self.subTest(change=change):
                before=copy.deepcopy(self.room.state)
                with self.assertRaises(ValueError): self.edit(**change)
                self.assertEqual(self.room.state,before)

    def test_dynamic_variables_and_plain_markup(self):
        valid='Новое: '+self.dynamic['default']
        self.assertEqual(validate_texts({self.dynamic['id']:valid}),{self.dynamic['id']:valid})
        with self.assertRaises(ValueError): validate_texts({self.dynamic['id']:valid+' {'+self.dynamic['tokens'][0]+'}'})
        literal='<img src=x onerror=alert(1)> & текст'
        self.assertEqual(validate_texts({self.plain['id']:literal}),{self.plain['id']:literal})
        self.assertEqual(validate_texts({self.plain['id']:self.plain['default']}),{})

    def test_conflicts_only_when_content_or_config_changes(self):
        self.edit()
        self.room.admin_action(dict(action='scene',scene='near'))
        self.edit(expected_version=1)
        with self.assertRaises(ValueError): self.edit(expected_version=1)
        config=copy.deepcopy(self.room.state['config'])
        self.room.admin_action(dict(action='config',config=config))
        with self.assertRaises(ValueError): self.edit(expected_version=2)
        before=copy.deepcopy(self.room.state)
        with self.assertRaises(ValueError):
            self.room.admin_action(dict(action='config',expected_version=2,config=config))
        self.assertEqual(before,self.room.state)

    def test_legacy_import_preserves_texts_and_program_roundtrip(self):
        self.edit(fields={'modules.near.minutes':'2 минуты'})
        config=copy.deepcopy(self.room.state['config']); config.pop('texts'); config.pop('text_version')
        self.room.admin_action(dict(action='config',config=config))
        self.assertEqual(self.room.state['config']['texts'],{self.plain['id']:'Сторона A'})
        config=copy.deepcopy(self.room.state['config'])
        other=Room(); other.admin_action(dict(action='config',config=json.loads(json.dumps(config))))
        self.assertEqual(other.state['config']['texts'],config['texts'])
        self.assertEqual(other.state['config']['modules']['near']['minutes'],'2 минуты')

    def test_catalog_ids_unique_and_templates_consistent(self):
        import re
        self.assertEqual(len(CATALOG),len({r['id'] for r in CATALOG}))
        for row in CATALOG:
            self.assertEqual(row['tokens'],re.findall(r'\{([a-z_]+)\}',row['default']))
            self.assertGreaterEqual(row['limit'],len(row['default']))
