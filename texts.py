"""Plain-text overrides. No HTML, game state or arbitrary config is accepted here."""
import copy
import json
import re
from pathlib import Path

CATALOG = json.loads((Path(__file__).parent / 'static/text-catalog.json').read_text(encoding='utf-8'))
CATALOG_BY_ID = {entry['id']: entry for entry in CATALOG}

def validate_texts(values):
    if not isinstance(values, dict): raise ValueError('Некорректный набор надписей.')
    result = {}
    for key, value in values.items():
        entry = CATALOG_BY_ID.get(key)
        if entry is None: raise ValueError('Неизвестная надпись. Обновите страницу редактора.')
        if not isinstance(value, str) or not value.strip() or len(value) > entry['limit']:
            raise ValueError(f'Надпись должна содержать от 1 до {entry["limit"]} символов.')
        if any(ord(c)<32 and c not in '\n\t\r' for c in value): raise ValueError('В тексте есть недопустимые символы.')
        if sorted(re.findall(r'\{([a-z_]+)\}',value)) != sorted(entry['tokens']):
            raise ValueError('Сохраните все переменные в фигурных скобках: '+', '.join('{'+t+'}' for t in entry['tokens']))
        if value != entry['default']: result[key] = value
    if len(json.dumps(result, ensure_ascii=False).encode()) > 100_000:
        raise ValueError('Общий объём надписей слишком большой.')
    return result

def apply_text_edit(config, data, active_modules):
    if type(data.get('expected_version')) is not int or data['expected_version'] != config.get('text_version',0):
        raise ValueError('Тексты или настройки уже изменились в другом окне. Закройте и снова откройте редактор; ваш черновик можно скопировать.')
    values = validate_texts(data.get('texts'))
    fields = data.get('fields',{})
    if not isinstance(fields,dict): raise ValueError('Некорректные поля текста.')
    updated = copy.deepcopy(config)
    for path,value in fields.items():
        parts=path.split('.')
        limit=90 if path=='title' else None
        if len(parts)==3 and parts[0]=='modules' and parts[1] in active_modules:
            limit={'title':80,'subtitle':180,'minutes':40,'note':1200,'takeaway':240}.get(parts[2])
        if limit is None or not isinstance(value,str) or not value.strip() or len(value)>limit:
            raise ValueError('Проверьте текст поля '+path)
        if path=='title': updated['title']=value.strip()
        else: updated['modules'][parts[1]][parts[2]]=value.strip()
    updated['texts']=values
    updated['text_version']=config.get('text_version',0)+1
    return updated
