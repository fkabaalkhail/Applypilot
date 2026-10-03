/**
 * A local stand-in for the Tailrd backend, for driving the REAL packaged
 * extension end to end without touching production.
 *
 * The extension is pointed at this server through its own settings
 * (`ap_config.apiBaseUrl`), so every request it makes, profile sync, the AI
 * fill call, telemetry, lands here and is recorded. Nothing is mocked inside
 * the extension: the bundle under test is byte-for-byte what ships.
 *
 * `aiMode` simulates the state production is in on 2026-10-03, the OpenAI
 * account has no credits:
 *   - "dead" (default): /api/fill answers 200 with no answers and an
 *     "AI unavailable" error, every field dropped as ai_error. This is what the
 *     real backend returns when its AI pass fails and pass 1 found nothing.
 *   - "down": /api/fill answers 503, the backend itself is unreachable.
 *
 * Diagnostic capture is switched ON, so each fill's telemetry carries the
 * extension's own per-field record (proposed value, observed value, options,
 * DOM), a second source of truth beside the harness's DOM dump.
 */
import http from "node:http";
import { readFileSync, existsSync } from "node:fs";

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}

/** An unsigned JWT the extension can read `exp` from (it never verifies). */
export function fakeJwt(ttlSeconds = 30 * 24 * 3600) {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  return { token: `${b64url({ alg: "none", typ: "JWT" })}.${b64url({ sub: "1", exp })}.sig`, exp };
}

function snapshotFor(state) {
  return {
    version: state.version,
    updatedAt: new Date().toISOString(),
    profile: state.profile,
    resumes: state.resumes,
    activeResumeId: state.resumes.find((r) => r.isPrimary)?.id ?? null,
    coverLetters: [],
    customResumes: [],
    settings: { jobTitle: "", prefilledAnswers: {} },
    subscription: { tier: "free", status: "active" },
    usage: { aiCreditsUsed: 0, aiCreditsLimit: null },
  };
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    return raw ? JSON.parse(raw) : null;
  } catch {
    return raw;
  }
}

export async function startFakeApi({ profile, resumes = [], resumeFilePath = null, aiMode = "dead" } = {}) {
  const state = {
    profile,
    version: 1,
    resumes,
    aiMode,
    telemetry: [],
    fillRequests: [],
    requests: [],
  };
  const waiters = new Set();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const path = url.pathname;
    const body = req.method === "GET" ? null : await readBody(req);
    state.requests.push({ method: req.method, path, at: Date.now() });
    const json = (status, payload) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
    };

    if (req.method === "GET" && path === "/auth/me") {
      return json(200, {
        id: 1,
        email: state.profile?.email || "harness@example.com",
        first_name: state.profile?.firstName ?? "",
        last_name: state.profile?.lastName ?? "",
        email_verified: true,
      });
    }
    if (req.method === "POST" && path === "/auth/refresh") {
      return json(200, { access_token: fakeJwt().token, refresh_token: "harness-refresh", token_type: "bearer" });
    }
    if (req.method === "GET" && path === "/api/extension/sync/version") {
      return json(200, { version: state.version });
    }
    if (req.method === "GET" && path === "/api/extension/sync") {
      return json(200, snapshotFor(state));
    }
    if (req.method === "POST" && path === "/api/fill") {
      state.fillRequests.push(body);
      if (state.aiMode === "down") return json(503, { detail: "Service unavailable" });
      const fields = Array.isArray(body?.fields) ? body.fields : [];
      return json(200, {
        answers: [],
        errors: ["AI unavailable: insufficient_quota"],
        dropped: fields.map((f) => ({ id: f.id, label: f.label, reason: "ai_error", source: "ai" })),
      });
    }
    if (req.method === "GET" && path === "/autofill/overrides") {
      return json(200, { version: "harness", rules: [] });
    }
    if (req.method === "GET" && path === "/autofill/diagnostic") {
      return json(200, { enabled: true });
    }
    if (req.method === "POST" && path === "/autofill/telemetry") {
      state.telemetry.push({ at: Date.now(), body });
      for (const w of [...waiters]) w();
      return json(200, { ok: true });
    }
    if (req.method === "POST" && path === "/apply/log") {
      return json(200, { id: 1, created: true });
    }
    if (req.method === "PUT" && path === "/api/user/application-profile") {
      return json(200, { ok: true });
    }
    const fileMatch = /^\/resumes\/(\d+)\/file$/.exec(path);
    if (req.method === "GET" && fileMatch && resumeFilePath && existsSync(resumeFilePath)) {
      const bytes = readFileSync(resumeFilePath);
      res.writeHead(200, {
        "Content-Type": "application/pdf",
        "Content-Disposition": 'attachment; filename="John_Doe_Resume.pdf"',
      });
      return res.end(bytes);
    }
    return json(404, { detail: `harness: no route for ${req.method} ${path}` });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;

  return {
    url,
    state,
    /** Swap the profile the extension syncs; bumping the version makes the
     *  extension's cheap staleness probe re-download it on the next page. */
    setProfile(next) {
      state.profile = next;
      state.version++;
    },
    setResumes(next) {
      state.resumes = next;
      state.version++;
    },
    /** Resolves once a telemetry report beyond `afterCount` arrives (or null on timeout). */
    waitForTelemetry(afterCount, timeoutMs) {
      if (state.telemetry.length > afterCount) return Promise.resolve(state.telemetry[afterCount]);
      return new Promise((resolve) => {
        const done = (v) => {
          waiters.delete(check);
          clearTimeout(timer);
          resolve(v);
        };
        const check = () => {
          if (state.telemetry.length > afterCount) done(state.telemetry[afterCount]);
        };
        const timer = setTimeout(() => done(null), timeoutMs);
        waiters.add(check);
      });
    },
    close() {
      return new Promise((resolve) => server.close(resolve));
    },
  };
}
