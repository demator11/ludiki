"""Local launch without Docker. Dependencies must be installed before the event."""
import os
from pathlib import Path
import sys
import threading
import time
from urllib.request import urlopen
import webbrowser

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
try:
    import uvicorn
    from main import app, KEY_FILE
except ModuleNotFoundError:
    print('Install dependencies before the event: python -m pip install -r requirements.txt')
    raise SystemExit(1)

port = int(os.environ.get('PORT', '8000'))
base = f'http://localhost:{port}'

def open_when_ready():
    for _ in range(50):
        try:
            with urlopen(base + '/api/health', timeout=.3) as response:
                if response.status == 200: break
        except OSError:
            time.sleep(.2)
    else: return
    webbrowser.open(base + '/admin')
    webbrowser.open(base + '/screen')

if __name__ == '__main__':
    print('Ludiki:', base)
    print('Host password file:', KEY_FILE)
    print('Keep this terminal open during the presentation. Stop with Ctrl+C.')
    if '--no-browser' not in sys.argv:
        threading.Thread(target=open_when_ready, daemon=True).start()
    uvicorn.run(app, host='127.0.0.1', port=port)
