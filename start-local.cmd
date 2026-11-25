@echo off
setlocal
cd /d "%~dp0"
echo Starting Ludiki from the image already on this laptop...
docker compose up -d --no-build --pull never --wait
if errorlevel 1 (
  echo.
  echo Start Docker Desktop first. Before the event, build the image online:
  echo docker compose up --build -d --wait
  pause
  exit /b 1
)
echo.
echo Local host password:
docker compose exec -T ludiki cat /app/data/admin-key.txt
echo.
echo Keep this window private. Open the projector on the second display.
start "" http://localhost:8000/admin
start "" http://localhost:8000/screen
pause
