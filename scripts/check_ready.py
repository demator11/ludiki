"""Read-only HTTP / WebSocket check, also usable against the public HTTPS URL."""
import argparse
import asyncio
import json
from urllib.request import urlopen
import websockets


async def check(base):
    base = base.rstrip('/')
    for path in ['/api/health', '/screen', '/play', '/admin', '/static/app.js', '/static/experience.js', '/static/copy.js', '/static/text-editor.js', '/static/text-catalog.json', '/static/style.css', '/api/qr']:
        with urlopen(base + path, timeout=15) as response:
            assert response.status == 200, path
            if path == '/api/health':
                health = json.load(response)
                assert health['ok'] and health['app'] == 'ludiki'
                print('Ludiki version:', health['version'])
        print('HTTP OK', path)
    ws_url = ('wss://' + base[8:] if base.startswith('https://') else 'ws://' + base[7:]) + '/ws?role=screen'
    async with websockets.connect(ws_url, origin=base, open_timeout=15) as ws:
        state = json.loads(await asyncio.wait_for(ws.recv(), 10))
        assert 'scene' in state and 'revision' in state
        assert 'config' not in state and 'people' not in state
        await ws.send('ping')
        for _ in range(20):
            message = json.loads(await asyncio.wait_for(ws.recv(), 10))
            if message.get('type') == 'pong': break
        else: raise AssertionError('No WebSocket pong')
    print('WebSocket OK; public state does not contain host notes or participant list')
    print('Server checks passed. Also open /play on an actual phone using mobile data.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('url', nargs='?', default='http://localhost:8000')
    args = parser.parse_args()
    if not args.url.startswith(('http://', 'https://')): parser.error('Use an HTTP(S) base URL')
    asyncio.run(check(args.url))
