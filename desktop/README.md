# Auto Apply Bot — Desktop App

Electron wrapper that bundles the React frontend, FastAPI backend, Redis, and Celery worker into a single installable application.

## Prerequisites

- Node.js 18+
- Python 3.10+ with `pip` (backend dependencies)
- Redis (`brew install redis` on macOS, or bundled portable binary)
- Ollama running locally (for AI features)

## Development

```bash
# 1. Install desktop dependencies
cd desktop && npm install

# 2. Start backend services externally (docker-compose or manual)
cd .. && make dev

# 3. Run Electron in dev mode (connects to running services)
cd desktop && npm run dev
```

## Building for Distribution

```bash
# 1. Build the React frontend
npm run build:frontend

# 2. Package for current platform
npm run dist

# Platform-specific:
npm run dist:mac
npm run dist:win
npm run dist:linux
```

Installers are written to `desktop/release/`.

## Architecture

```
desktop/
├── main.js          # Electron main process — window, lifecycle, auto-update
├── preload.js       # Secure bridge between renderer and main process
├── services.js      # Spawns FastAPI, Redis, Celery as child processes
├── tray.js          # System tray icon with context menu
├── package.json     # Electron deps + electron-builder config
└── entitlements.mac.plist  # macOS code-signing entitlements
```

On launch (production mode), `services.js` starts:
1. `redis-server` on port 6379
2. `uvicorn backend.main:app` on port 8000
3. `celery -A backend.services.task_runner.celery_app worker`

The BrowserWindow loads the built React frontend from `extraResources/frontend/index.html`.

## System Tray

The app minimizes to the system tray instead of quitting. Right-click the tray icon for:
- Open Dashboard
- Status indicator
- Quit

## Auto-Updates

Configured via `electron-updater` with GitHub Releases as the update provider. Set the `publish` config in `package.json` to your repo.
