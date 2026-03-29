/**
 * Service Manager — spawns and manages backend processes (FastAPI, Redis, Celery).
 *
 * In production the bundled Python backend and a portable Redis binary are launched
 * as child processes.  In dev mode (`--dev` flag) we assume the services are already
 * running externally (docker-compose or manual).
 */

const { spawn } = require("child_process");
const path = require("path");
const log = require("electron-log");
const { app } = require("electron");

/** @type {import("child_process").ChildProcess[]} */
const children = [];

/**
 * Resolve a path inside the bundled `extraResources` directory (production)
 * or relative to the repo root (development).
 */
function resourcePath(...segments) {
  const isProd = app.isPackaged;
  if (isProd) {
    return path.join(process.resourcesPath, ...segments);
  }
  return path.join(__dirname, "..", ...segments);
}

/** Return the user-writable data directory. */
function dataDir() {
  const dir = path.join(app.getPath("userData"), "data");
  require("fs").mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Build a minimal environment block for child processes.
 * Inherits the parent env and overrides the variables the backend needs.
 */
function serviceEnv() {
  const data = dataDir();
  return {
    ...process.env,
    DATABASE_URL: `sqlite:///${path.join(data, "autoapply.db")}`,
    REDIS_URL: "redis://localhost:6379/0",
    OLLAMA_BASE_URL: process.env.OLLAMA_BASE_URL || "http://localhost:11434",
    CORS_ORIGINS: "http://localhost:5173,app://.",
    DATA_DIR: data,
  };
}

/** Spawn a child process, pipe its output to electron-log, and track it. */
function spawnService(label, command, args, cwd) {
  log.info(`[${label}] starting: ${command} ${args.join(" ")}`);
  const child = spawn(command, args, {
    cwd,
    env: serviceEnv(),
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
  });

  child.stdout?.on("data", (d) => log.info(`[${label}] ${d.toString().trim()}`));
  child.stderr?.on("data", (d) => log.warn(`[${label}] ${d.toString().trim()}`));
  child.on("error", (err) => log.error(`[${label}] spawn error:`, err.message));
  child.on("exit", (code) => log.info(`[${label}] exited with code ${code}`));

  children.push(child);
  return child;
}

/**
 * Start all backend services.
 *
 * 1. Redis (portable binary or system redis-server)
 * 2. FastAPI via uvicorn
 * 3. Celery worker
 */
function startAll() {
  const backendDir = resourcePath("backend");
  const python = process.platform === "win32" ? "python" : "python3";

  // --- Redis ---
  // Try system redis-server.  Users on macOS can `brew install redis`,
  // on Windows we bundle a portable redis-server or they install via WSL.
  spawnService("redis", "redis-server", ["--port", "6379", "--daemonize", "no"], undefined);

  // --- FastAPI (uvicorn) ---
  spawnService("backend", python, [
    "-m", "uvicorn",
    "backend.main:app",
    "--host", "0.0.0.0",
    "--port", "8000",
    "--log-level", "info",
  ], resourcePath());

  // --- Celery worker ---
  spawnService("worker", python, [
    "-m", "celery",
    "-A", "backend.services.task_runner.celery_app",
    "worker",
    "--loglevel=info",
    "--concurrency=2",
  ], resourcePath());
}

/** Gracefully kill all child processes. */
function stopAll() {
  for (const child of children) {
    if (!child.killed) {
      log.info(`Stopping PID ${child.pid}`);
      if (process.platform === "win32") {
        spawn("taskkill", ["/pid", String(child.pid), "/f", "/t"]);
      } else {
        child.kill("SIGTERM");
      }
    }
  }
  children.length = 0;
}

module.exports = { startAll, stopAll, dataDir, resourcePath };
