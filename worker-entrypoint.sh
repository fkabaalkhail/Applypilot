#!/bin/bash
# Start Xvfb for headed Chrome (needed in Docker)
Xvfb :99 -screen 0 1280x800x24 -nolisten tcp &
export DISPLAY=:99
sleep 2

# Start VNC server for debugging (optional)
x11vnc -display :99 -forever -nopw -rfbport 5900 &
sleep 1

# Start noVNC websocket proxy
websockify --web /usr/share/novnc 6080 localhost:5900 &

# Start Celery worker
exec celery -A backend.worker worker --loglevel=info --pool=solo
