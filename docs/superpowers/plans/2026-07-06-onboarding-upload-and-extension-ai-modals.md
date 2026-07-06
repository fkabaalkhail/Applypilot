# Onboarding Required Upload + Extension AI Modal Parity — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make onboarding's resume upload identical to the in-app upload (real analyze pipeline + blob storage, required, no skip), and make the Chrome extension's résumé-rewrite and cover-letter surfaces the exact app modals ending in Attach-to-application OR Download.

**Architecture:** Part 1 extracts the in-app `UploadModal` state machine into a shared `useResumeUpload` hook that both `Resume.tsx` and the onboarding `ResumeStep` consume. Part 2 embeds the real React `CustomResumeModal`/`CoverLetterModal` inside the extension via same-origin `/embed/*` iframes; the modals are refactored to take their data source (analyze/generate fns), `jobId`, and an `onAttach` callback as props (web behaviour unchanged by defaults). Thin context-keyed backend endpoints (`/api/custom-resume-analysis`, `/api/custom-resume`) feed the embed since the extension has no DB `job_id`. Auth flows to the iframe over a `MessageChannel` port from the extension content script.

**Tech Stack:** React + Vite + react-router (frontend), FastAPI + SQLAlchemy + Pydantic v2 (backend), vanilla-TS Chrome extension (MV3), Vitest (frontend/extension), pytest (backend), axios (web), fetch (extension).

## Global Constraints

- Web app auth: Bearer from `localStorage.access_token` + HttpOnly refresh cookie (`frontend/src/auth/api.ts`). Extension auth: own token pair in extension storage (`chrome-extension/src/api/client.ts`), silent refresh on 401.
- FE + API are ONE Vercel deploy on `www.tailrd.ca` (`vercel.json`): `/api/*`,`/ai/*`,`/resumes*`,`/settings*` rewrite to the Python function; all else → `index.html`. Embed API calls are same-origin.
- `ResumeVersion.job_id` is `nullable=True` (`backend/db/models.py:450`) — no migration.
- Extension: run vitest DIRECTLY via node, NOT `npm test` (npm exits 1 with no output in the controller shell — not a failure). See memory `extension-vitest-npm-stdio-quirk`.
- Accepted parity gaps: embed cover-letter omits Save (`/ai/cover-letters` needs a DB job_id); embed VersionsPanel is empty (jobId null).
- Backend endpoints keyed on raw context reuse existing services (`MatchEngine.analyze_job`, `tailor_document`) — no new AI logic.
- Modal refactors MUST NOT change the web behaviour: default props reproduce the current `/ai/...${job.id}` calls exactly.

---

## File Structure

**Part 1 (onboarding)**
- Create `frontend/src/hooks/useResumeUpload.ts` — upload state machine (state, tips, validation, `POST /resumes/upload`).
- Modify `frontend/src/pages/Resume.tsx` — `UploadModal` consumes the hook.
- Modify `frontend/src/setup/steps/ResumeStep.tsx` — inline uploader using the hook.
- Modify `frontend/src/setup/SetupWizard.tsx` — track `uploadedResumeId`, remove skip, gate finish, drop `/settings/resume`.
- Test `frontend/src/setup/SetupWizard.test.tsx`.

**Part 2 (backend context endpoints)**
- Modify `backend/schemas/tailor.py` — add `CustomResumeAnalysisIn`, reuse `JobAnalysisOut`/`RewriteOut` from `schemas.ai`; add `CustomResumeIn`.
- Modify `backend/routers/tailor.py` — add `POST /custom-resume-analysis`, `POST /custom-resume`.
- Test `backend/tests/test_tailor_api.py` (additions).

**Part 3 (frontend modal refactor + embed)**
- Modify `frontend/src/components/CustomResumeModal.tsx` — data-source + `onAttach` + `jobId` props.
- Modify `frontend/src/components/CoverLetterModal.tsx` — same shape.
- Create `frontend/src/pages/embed/embedApi.ts` — port-token axios + MessageChannel client.
- Create `frontend/src/pages/embed/CustomResumeEmbed.tsx`, `frontend/src/pages/embed/CoverLetterEmbed.tsx`.
- Modify `frontend/src/main.tsx` — add `/embed/custom-resume`, `/embed/cover-letter` routes.
- Modify `vercel.json` — scoped `frame-ancestors` header on `/embed/(.*)`.
- Test `frontend/src/pages/embed/embedApi.test.ts`.

**Part 4 (extension)**
- Create `chrome-extension/src/content/aiModalBridge.ts` — iframe overlay + MessageChannel bridge (pure-ish, testable message handlers).
- Modify `chrome-extension/src/content/overlay.ts` — open embed iframe on rewrite/cover click; wire attach via existing file-attach helpers.
- Delete `chrome-extension/src/content/tailorCard.ts`, `chrome-extension/src/content/coverLetterCard.ts` (and their tests) once unreferenced.
- Test `chrome-extension/src/content/aiModalBridge.test.ts`.

---

## Task 1: Extract `useResumeUpload` hook and refactor in-app UploadModal

**Files:**
- Create: `frontend/src/hooks/useResumeUpload.ts`
- Modify: `frontend/src/pages/Resume.tsx:199-321`
- Test: `frontend/src/hooks/useResumeUpload.test.ts`

**Interfaces:**
- Produces:
  ```ts
  type UploadState = "upload" | "progress" | "success" | "error";
  interface UploadResult { id: number; profile: { name?: string; [k: string]: unknown } }
  interface UseResumeUpload {
    state: UploadState;
    tipIndex: number;              // index into TIPS
    fileError: string | null;      // client-side validation message
    apiError: string | null;       // server/network message
    result: UploadResult | null;
    upload: (file: File) => Promise<void>;
    reset: () => void;             // back to "upload"
  }
  export const RESUME_UPLOAD_TIPS: string[];
  export function isValidResumeFile(file: File): boolean;
  export function useResumeUpload(opts?: { onSuccess?: (r: UploadResult) => void }): UseResumeUpload;
  ```
- Consumes: `frontend/src/hooks/useAuthFetch` (the axios instance `api`) for `POST /resumes/upload` (FormData).

- [ ] **Step 1: Write the failing test**

```ts
// frontend/src/hooks/useResumeUpload.test.ts
import { renderHook, act, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { useResumeUpload, isValidResumeFile } from "./useResumeUpload";

vi.mock("./useAuthFetch", () => ({
  default: { post: vi.fn() },
}));
import api from "./useAuthFetch";

function pdf(name = "cv.pdf") {
  return new File(["x"], name, { type: "application/pdf" });
}

describe("useResumeUpload", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects non-pdf/docx before calling the API", async () => {
    const { result } = renderHook(() => useResumeUpload());
    await act(async () => { await result.current.upload(new File(["x"], "a.txt", { type: "text/plain" })); });
    expect(result.current.fileError).toBeTruthy();
    expect(result.current.state).toBe("upload");
    expect(api.post).not.toHaveBeenCalled();
  });

  it("posts to /resumes/upload and lands on success with the result", async () => {
    (api.post as any).mockResolvedValue({ data: { id: 7, profile: { name: "Jane" } } });
    const onSuccess = vi.fn();
    const { result } = renderHook(() => useResumeUpload({ onSuccess }));
    await act(async () => { await result.current.upload(pdf()); });
    await waitFor(() => expect(result.current.state).toBe("success"));
    expect(api.post).toHaveBeenCalledWith("/resumes/upload", expect.any(FormData));
    expect(result.current.result).toEqual({ id: 7, profile: { name: "Jane" } });
    expect(onSuccess).toHaveBeenCalledWith({ id: 7, profile: { name: "Jane" } });
  });

  it("surfaces server errors and resets back to upload", async () => {
    (api.post as any).mockRejectedValue({ response: { data: { detail: "boom" } } });
    const { result } = renderHook(() => useResumeUpload());
    await act(async () => { await result.current.upload(pdf()); });
    await waitFor(() => expect(result.current.state).toBe("error"));
    expect(result.current.apiError).toBe("boom");
    act(() => result.current.reset());
    expect(result.current.state).toBe("upload");
  });

  it("isValidResumeFile accepts .docx by extension", () => {
    expect(isValidResumeFile(new File(["x"], "r.docx", { type: "" }))).toBe(true);
    expect(isValidResumeFile(new File(["x"], "r.png", { type: "image/png" }))).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test — expect FAIL (module not found)**

Run: `cd frontend && npx vitest run src/hooks/useResumeUpload.test.ts`
Expected: FAIL (cannot resolve `./useResumeUpload`).

- [ ] **Step 3: Implement the hook**

```ts
// frontend/src/hooks/useResumeUpload.ts
import { useCallback, useEffect, useRef, useState } from "react";
import api from "./useAuthFetch";

export type UploadState = "upload" | "progress" | "success" | "error";

export interface UploadResult {
  id: number;
  profile: { name?: string; [k: string]: unknown };
}

export const RESUME_UPLOAD_TIPS = [
  "Extracting text from your resume...",
  "Identifying your skills and experience...",
  "Analyzing education and certifications...",
  "Building your structured profile...",
];

const ACCEPTED_TYPES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
];
const ACCEPTED_EXTENSIONS = [".pdf", ".docx"];

export function isValidResumeFile(file: File): boolean {
  if (ACCEPTED_TYPES.includes(file.type)) return true;
  const ext = file.name.toLowerCase().slice(file.name.lastIndexOf("."));
  return ACCEPTED_EXTENSIONS.includes(ext);
}

export function useResumeUpload(opts?: { onSuccess?: (r: UploadResult) => void }) {
  const [state, setState] = useState<UploadState>("upload");
  const [tipIndex, setTipIndex] = useState(0);
  const [fileError, setFileError] = useState<string | null>(null);
  const [apiError, setApiError] = useState<string | null>(null);
  const [result, setResult] = useState<UploadResult | null>(null);
  const tipTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const onSuccess = opts?.onSuccess;

  useEffect(() => {
    if (state === "progress") {
      tipTimer.current = setInterval(
        () => setTipIndex((p) => (p + 1) % RESUME_UPLOAD_TIPS.length),
        3000,
      );
    } else if (tipTimer.current) {
      clearInterval(tipTimer.current);
      tipTimer.current = null;
    }
    return () => { if (tipTimer.current) clearInterval(tipTimer.current); };
  }, [state]);

  const upload = useCallback(async (file: File) => {
    setFileError(null);
    setApiError(null);
    if (!isValidResumeFile(file)) {
      setFileError("Only PDF and DOCX files are accepted.");
      return;
    }
    setState("progress");
    setTipIndex(0);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await api.post("/resumes/upload", fd);
      const data = res.data as UploadResult;
      setResult(data);
      setState("success");
      onSuccess?.(data);
    } catch (err: any) {
      setApiError(err?.response?.data?.detail || err?.message || "Upload failed.");
      setState("error");
    }
  }, [onSuccess]);

  const reset = useCallback(() => {
    setApiError(null);
    setFileError(null);
    setState("upload");
  }, []);

  return { state, tipIndex, fileError, apiError, result, upload, reset };
}
```

- [ ] **Step 4: Run the test — expect PASS**

Run: `cd frontend && npx vitest run src/hooks/useResumeUpload.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Refactor `Resume.tsx`'s `UploadModal` to consume the hook**

In `frontend/src/pages/Resume.tsx`, remove the local `ROTATING_TIPS`, `ACCEPTED_*`, `isValidFileType`, and the `modalState`/`tipIndex`/`uploadResult`/`handleFile`/tip-interval effect from `UploadModal`. Replace with:

```tsx
import { useResumeUpload, RESUME_UPLOAD_TIPS } from "../hooks/useResumeUpload";
// ...inside UploadModal:
function UploadModal({ onClose, onUploadSuccess }: UploadModalProps) {
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const { state, tipIndex, fileError, apiError, result, upload, reset } =
    useResumeUpload({ onSuccess: () => onUploadSuccess() });
```

Then replace every `modalState` reference in the JSX with `state`, every `ROTATING_TIPS` with `RESUME_UPLOAD_TIPS`, `uploadResult?.id` with `result?.id`, `handleFile` with `upload`, the "Try Again" `onClick` from `() => { setModalState("upload"); setApiError(null); }` to `reset`, and `fileError`/`apiError` reads unchanged. Delete the now-unused module-level `ModalState` type, `ROTATING_TIPS`, `ACCEPTED_TYPES`, `ACCEPTED_EXTENSIONS`, `isValidFileType`, and `UploadResponse` interface (hook owns them).

- [ ] **Step 6: Typecheck + full frontend test run**

Run: `cd frontend && npx tsc --noEmit && npx vitest run`
Expected: no TS errors; all tests pass (Resume upload behaviour unchanged).

- [ ] **Step 7: Commit**

```bash
git add frontend/src/hooks/useResumeUpload.ts frontend/src/hooks/useResumeUpload.test.ts frontend/src/pages/Resume.tsx
git commit -m "refactor(resume): extract useResumeUpload hook shared by upload modal"
```

---

## Task 2: Onboarding — required inline upload, no skip

**Files:**
- Modify: `frontend/src/setup/steps/ResumeStep.tsx`
- Modify: `frontend/src/setup/SetupWizard.tsx`
- Test: `frontend/src/setup/SetupWizard.test.tsx`

**Interfaces:**
- Consumes: `useResumeUpload` (Task 1).
- `ResumeStep` new props:
  ```ts
  type Props = { uploadedResumeId: number | null; onUploaded: (id: number) => void };
  ```
- Produces: `SetupWizard` gates finish on `uploadedResumeId != null`; no `/settings/resume`; no skip button.

- [ ] **Step 1: Write the failing test**

```tsx
// frontend/src/setup/SetupWizard.test.tsx
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { MemoryRouter } from "react-router-dom";

const post = vi.fn();
const put = vi.fn();
vi.mock("../auth/api", () => ({ default: { post: (...a: any) => post(...a), put: (...a: any) => put(...a) } }));
const setSetupComplete = vi.fn().mockResolvedValue(undefined);
vi.mock("../auth/useAuth", () => ({ useAuth: () => ({ user: { first_name: "A", last_name: "B" }, setSetupComplete }) }));
const navigate = vi.fn();
vi.mock("react-router-dom", async (orig) => ({ ...(await orig() as object), useNavigate: () => navigate }));

import SetupWizard from "./SetupWizard";

function renderWizard() { return render(<MemoryRouter><SetupWizard /></MemoryRouter>); }
async function gotoResumeStep() {
  // Advance through all config steps by clicking Next until the resume uploader shows.
  // (Config steps have no required validation in the test's default answers.)
  for (let i = 0; i < 20; i++) {
    if (screen.queryByText(/Upload your resume/i)) return;
    const next = screen.queryByRole("button", { name: /^Next$/ });
    if (!next) return;
    fireEvent.click(next);
  }
}

describe("SetupWizard resume step", () => {
  beforeEach(() => { post.mockReset(); put.mockReset(); put.mockResolvedValue({}); navigate.mockReset(); });

  it("has no 'I'll do this later' skip button", async () => {
    renderWizard(); await gotoResumeStep();
    expect(screen.queryByText(/i'll do this later/i)).toBeNull();
  });

  it("disables Start Matching until a resume is uploaded", async () => {
    renderWizard(); await gotoResumeStep();
    const finish = screen.getByRole("button", { name: /Start Matching/i });
    expect(finish).toBeDisabled();
  });

  it("uploads via /resumes/upload (not /settings/resume) and enables finish", async () => {
    post.mockResolvedValue({ data: { id: 42, profile: { name: "Jane" } } });
    renderWizard(); await gotoResumeStep();
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(["x"], "cv.pdf", { type: "application/pdf" });
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => expect(post).toHaveBeenCalledWith("/resumes/upload", expect.any(FormData)));
    expect(post).not.toHaveBeenCalledWith("/settings/resume", expect.anything());
    await waitFor(() => expect(screen.getByRole("button", { name: /Start Matching/i })).not.toBeDisabled());
  });
});
```

- [ ] **Step 2: Run the test — expect FAIL**

Run: `cd frontend && npx vitest run src/setup/SetupWizard.test.tsx`
Expected: FAIL (skip button still present / finish enabled / `/settings/resume` used).

- [ ] **Step 3: Rewrite `ResumeStep.tsx` as an inline uploader**

```tsx
// frontend/src/setup/steps/ResumeStep.tsx
import { useRef } from "react";
import { FileArrowUp, CheckCircle, Spinner } from "@phosphor-icons/react";
import { useResumeUpload, RESUME_UPLOAD_TIPS } from "../../hooks/useResumeUpload";

type Props = { uploadedResumeId: number | null; onUploaded: (id: number) => void };

export function ResumeStep({ onUploaded }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const { state, tipIndex, fileError, apiError, upload, reset } = useResumeUpload({
    onSuccess: (r) => onUploaded(r.id),
  });

  return (
    <div className="setup-resume">
      {state === "progress" ? (
        <div className="setup-resume-card filled" aria-busy="true">
          <span className="setup-resume-icon"><Spinner size={26} weight="bold" className="spin" /></span>
          <span className="setup-resume-title">Analyzing your resume…</span>
          <span className="setup-resume-hint">{RESUME_UPLOAD_TIPS[tipIndex]}</span>
        </div>
      ) : state === "success" ? (
        <div className="setup-resume-card filled">
          <span className="setup-resume-filename"><CheckCircle size={18} weight="fill" /> Resume analyzed</span>
          <button type="button" className="setup-resume-change" onClick={reset}>Upload a different file</button>
        </div>
      ) : (
        <label className="setup-resume-card">
          <span className="setup-resume-icon"><FileArrowUp size={26} weight="bold" /></span>
          <span className="setup-resume-title">Upload your resume</span>
          <span className="setup-resume-hint">PDF or Word · up to 10MB</span>
          <input
            ref={inputRef}
            type="file"
            accept=".pdf,.docx"
            hidden
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); }}
          />
        </label>
      )}
      {(fileError || apiError) && <div className="setup-error" role="alert">{fileError || apiError}</div>}
      <p className="setup-resume-privacy">
        We use your resume only to match you with the right jobs and tailor your applications —
        it's never shared with third parties.
      </p>
    </div>
  );
}
```

(If `Spinner` isn't exported by `@phosphor-icons/react` in this version, use `CircleNotch` or reuse the existing `.spinner` div; keep the same class hooks.)

- [ ] **Step 4: Update `SetupWizard.tsx`**

Replace `resumeFile` state and its use:

```tsx
// state
const [uploadedResumeId, setUploadedResumeId] = useState<number | null>(null);

// remove the whole `if (resumeFile) { ... /settings/resume ... }` block from persist()

// render the resume step:
{step.id === "resume"
  ? <ResumeStep uploadedResumeId={uploadedResumeId} onUploaded={setUploadedResumeId} />
  : step.Component && <step.Component answers={answers} update={update} />}

// footer: delete the skip button entirely and gate finish
<div style={{ display: "flex", gap: 16, alignItems: "center" }}>
  <button
    className="setup-btn"
    onClick={handleNext}
    disabled={submitting || (isLast && uploadedResumeId === null)}
  >
    {isLast ? (submitting ? "Starting…" : "Start Matching") : "Next"}
  </button>
</div>
```

Remove the now-unused `resumeFile`/`setResumeFile` and the `file`/`onFile` props usage.

- [ ] **Step 5: Run the test — expect PASS**

Run: `cd frontend && npx vitest run src/setup/SetupWizard.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 6: Typecheck + full frontend suite**

Run: `cd frontend && npx tsc --noEmit && npx vitest run`
Expected: no TS errors; all pass.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/setup/steps/ResumeStep.tsx frontend/src/setup/SetupWizard.tsx frontend/src/setup/SetupWizard.test.tsx
git commit -m "feat(onboarding): required inline resume upload via real analyze pipeline"
```

---

## Task 3: Backend context-keyed AI endpoints

**Files:**
- Modify: `backend/schemas/tailor.py`
- Modify: `backend/routers/tailor.py`
- Test: `backend/tests/test_tailor_api.py`

**Interfaces:**
- Produces (mounted at `/api`):
  - `POST /api/custom-resume-analysis` body `{resume_id?, job_title, company, job_description}` → `JobAnalysisOut`.
  - `POST /api/custom-resume` body `{resume_id?, job_title, company, job_description, sections?, add_keywords?}` → `RewriteOut` (saves a `ResumeVersion` with `job_id=None`).
- Consumes: `MatchEngine.analyze_job`, `tailor_document`, `_resolve_resume`, `db_record_to_document`, `document_to_text` (from `backend.routers.ai`), `JobAnalysisOut`/`RewriteOut` (from `backend.schemas.ai`), `ResumeVersion` model.

- [ ] **Step 1: Add schemas**

Append to `backend/schemas/tailor.py`:

```python
class CustomResumeAnalysisIn(BaseModel):
    """Analyze a résumé against a scraped job (no job_id)."""
    resume_id: int | None = None
    job_title: str = ""
    company: str = ""
    job_description: str = ""


class CustomResumeIn(CustomResumeAnalysisIn):
    """Analysis inputs + the Align-step choices."""
    sections: list[str] | None = None
    add_keywords: list[str] | None = None
```

- [ ] **Step 2: Write the failing tests**

Append to `backend/tests/test_tailor_api.py` (mirror the existing auth/mock setup already in that file — reuse its fixtures/helpers for an authed client and a résumé on file; follow the patterns used by the `/api/tailor-resume` tests above in the same file):

```python
def test_custom_resume_analysis_returns_job_analysis(authed_client, resume_on_file, monkeypatch):
    async def fake_analyze(self, raw_text, title, company, description):
        from backend.schemas.ai import JobAnalysisOut
        return JobAnalysisOut(
            overall_score=72, ats_score=68, match_label="GOOD MATCH",
            keyword_coverage=60, matched_keywords=["python"],
            missing_keywords=["kubernetes"], strengths=["x"], weaknesses=["y"], suggestions=["z"],
        )
    monkeypatch.setattr("backend.services.match_engine.MatchEngine.analyze_job", fake_analyze)
    resp = authed_client.post("/api/custom-resume-analysis", json={
        "job_title": "SWE", "company": "Acme", "job_description": "Build things with python",
    })
    assert resp.status_code == 200
    body = resp.json()
    assert body["overall_score"] == 72
    assert body["missing_keywords"] == ["kubernetes"]


def test_custom_resume_returns_rewrite_and_saves_version(authed_client, resume_on_file, monkeypatch, db_session):
    from backend.services.resume_tailor import TailorResult  # adjust import to the real result type
    # Patch tailor_document where tailor.py imports it.
    async def fake_tailor(db, doc, title, company, desc, sections, add_keywords):
        return _make_fake_tailor_result(doc)  # helper in this test module; builds before/after + document
    monkeypatch.setattr("backend.routers.tailor.tailor_document", fake_tailor)
    resp = authed_client.post("/api/custom-resume", json={
        "job_title": "SWE", "company": "Acme", "job_description": "python",
        "sections": ["Skills"], "add_keywords": ["kubernetes"],
    })
    assert resp.status_code == 200
    body = resp.json()
    assert "document" in body and "original_document" in body
    assert body["version_id"] is not None
    from backend.db.models import ResumeVersion
    saved = db_session.query(ResumeVersion).filter_by(id=body["version_id"]).one()
    assert saved.job_id is None
    assert saved.source == "ai"


def test_custom_resume_analysis_requires_resume(authed_client_no_resume):
    resp = authed_client_no_resume.post("/api/custom-resume-analysis", json={
        "job_title": "SWE", "company": "Acme", "job_description": "python",
    })
    assert resp.status_code == 400
```

(If the file lacks `authed_client`/`resume_on_file`/`db_session` fixtures, add module-scoped fixtures modeled on the existing `/api/tailor-resume` test setup in the same file; `_make_fake_tailor_result` builds a result object matching what `tailor_document` returns — copy the shape from `backend/services/resume_tailor.py`.)

- [ ] **Step 3: Run tests — expect FAIL**

Run: `cd backend && python -m pytest tests/test_tailor_api.py -k "custom_resume" -v`
Expected: FAIL (404 — routes not defined).

- [ ] **Step 4: Implement the endpoints**

Add to `backend/routers/tailor.py` (imports at top, endpoints below the existing ones):

```python
from backend.routers.ai import LLM_503_DETAIL, _resolve_resume, document_to_text
from backend.schemas.ai import JobAnalysisOut, RewriteOut
from backend.schemas.tailor import (
    CustomResumeAnalysisIn, CustomResumeIn,
    RenderResumeIn, RenderResumeOut, TailorResumeIn, TailorResumeOut,
)
from backend.services.match_engine import MatchEngine
from backend.db.models import ResumeVersion


@router.post("/custom-resume-analysis", response_model=JobAnalysisOut)
async def custom_resume_analysis_endpoint(
    body: CustomResumeAnalysisIn,
    user_id: int = Depends(llm_guard),
    db: Session = Depends(get_db),
):
    """Step 1 'See Your Difference' for a scraped job (no job_id)."""
    resume = _resolve_resume(db, user_id, body.resume_id)  # 400 if none on file
    try:
        engine = MatchEngine(db)
        return await engine.analyze_job(
            resume.raw_text, body.job_title, body.company, body.job_description
        )
    except (ConnectionError, httpx.ConnectError):
        raise HTTPException(status_code=503, detail=LLM_503_DETAIL)


@router.post("/custom-resume", response_model=RewriteOut)
async def custom_resume_endpoint(
    body: CustomResumeIn,
    user_id: int = Depends(llm_guard),
    db: Session = Depends(get_db),
):
    """Step 3 'Review' for a scraped job: tailor + before/after + save a version."""
    resume = _resolve_resume(db, user_id, body.resume_id)
    original_document = db_record_to_document(resume)
    original_text = document_to_text(original_document)
    try:
        result = await tailor_document(
            db, original_document, body.job_title, body.company,
            body.job_description, body.sections, body.add_keywords,
        )
    except (ConnectionError, httpx.ConnectError):
        raise HTTPException(status_code=503, detail=LLM_503_DETAIL)

    version = ResumeVersion(
        user_id=user_id,
        resume_id=resume.id,
        job_id=None,
        label=f"AI · {body.job_title}"[:120] if body.job_title else "AI · Custom résumé",
        source="ai",
        document_json=result.document.model_dump(),
    )
    db.add(version)
    db.commit()
    db.refresh(version)

    return RewriteOut(
        document=result.document,
        original_document=original_document,
        tailored_text=result.tailored_text,
        original_text=original_text,
        diff_summary=result.diff_summary,
        original_overall_score=result.before.overall_score,
        new_overall_score=result.after.overall_score,
        new_ats_score=result.after.ats_score,
        new_keyword_coverage=result.after.keyword_coverage,
        version_id=version.id,
    )
```

(Verify the exact attribute names on the object `tailor_document` returns against `backend/services/resume_tailor.py` — `result.document`, `result.before`, `result.after`, `result.tailored_text`, `result.diff_summary` per the web `rewrite_resume`. Reuse `document_to_text`'s real import path; if it lives elsewhere than `backend.routers.ai`, import from there.)

- [ ] **Step 5: Run tests — expect PASS**

Run: `cd backend && python -m pytest tests/test_tailor_api.py -k "custom_resume" -v`
Expected: PASS.

- [ ] **Step 6: Full tailor + ai suite regression**

Run: `cd backend && python -m pytest tests/test_tailor_api.py tests/test_cover_letter_api.py -v`
Expected: PASS (pre-existing tests unaffected).

- [ ] **Step 7: Commit**

```bash
git add backend/schemas/tailor.py backend/routers/tailor.py backend/tests/test_tailor_api.py
git commit -m "feat(api): context-keyed custom-resume analysis + rewrite for the extension"
```

---

## Task 4: Refactor CustomResumeModal + CoverLetterModal to be data-source agnostic

**Files:**
- Modify: `frontend/src/components/CustomResumeModal.tsx`
- Modify: `frontend/src/components/CoverLetterModal.tsx`
- Test: `frontend/src/components/CustomResumeModal.test.tsx` (new, minimal)

**Interfaces:**
- `CustomResumeModal` props become:
  ```ts
  interface AIJob { id?: number; title: string; company: string; url: string }
  interface AttachFile { dataBase64: string; filename: string; contentType: string }
  interface CustomResumeModalProps {
    job: AIJob;
    onClose: () => void;
    analyze?: (resumeId: number | null) => Promise<Analysis>;        // default: POST /ai/custom-resume-analysis/${job.id}
    generate?: (resumeId: number | null, sections: string[], keywords: string[]) => Promise<RewriteResult>; // default: POST /ai/custom-resume/${job.id}
    jobId?: number | null;                                            // default: job.id ?? null (→ VersionsPanel/ResumeEditor)
    onAttach?: () => Promise<void>;                                   // when set, footer shows "Attach to application" instead of "Apply Now"
    renderPdfBlob?: () => Promise<AttachFile>;                        // used by embed's onAttach to get bytes (optional here)
  }
  ```
- `CoverLetterModal` props become:
  ```ts
  interface CoverLetterModalProps {
    job: AIJob;
    onClose: () => void;
    generate?: (resumeId: number | null, tone?: string, base?: string) => Promise<{ text: string }>; // default: POST /ai/cover-letter/${job.id}
    canSave?: boolean;             // default true; embed passes false to hide Save
    onAttach?: () => Promise<void>; // when set, footer shows "Attach to application"
  }
  ```
- Consumes: existing `api` (web default paths), `VersionsPanel`, `ResumeEditor`, `AtsPanel`.

- [ ] **Step 1: Write the failing test (web defaults + attach swap)**

```tsx
// frontend/src/components/CustomResumeModal.test.tsx
import { render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

const post = vi.fn();
const get = vi.fn();
vi.mock("../auth/api", () => ({ default: { post: (...a: any) => post(...a), get: (...a: any) => get(...a) } }));
// stub heavy children so the test stays about wiring
vi.mock("./ResumeRenderer", () => ({ FittedResume: () => <div /> }));
vi.mock("./ResumeEditor", () => ({ default: () => <div /> }));
vi.mock("./AtsPanel", () => ({ default: () => <div /> }));
vi.mock("./VersionsPanel", () => ({ default: () => <div /> }));

import CustomResumeModal from "./CustomResumeModal";

const analysis = {
  overall_score: 70, ats_score: 65, match_label: "GOOD MATCH", keyword_coverage: 50,
  matched_keywords: ["python"], missing_keywords: ["k8s"], strengths: [], weaknesses: [], suggestions: [],
};

describe("CustomResumeModal", () => {
  beforeEach(() => { post.mockReset(); get.mockReset(); });

  it("uses the default /ai/custom-resume-analysis/:id endpoint when no analyze prop", async () => {
    get.mockResolvedValue({ data: [{ id: 3, name: "CV", is_primary: true }] });
    post.mockResolvedValue({ data: analysis });
    render(<CustomResumeModal job={{ id: 9, title: "SWE", company: "Acme", url: "u" }} onClose={() => {}} />);
    await waitFor(() => expect(post).toHaveBeenCalledWith("/ai/custom-resume-analysis/9", { resume_id: 3 }));
  });

  it("calls a provided analyze() instead of the default endpoint", async () => {
    get.mockResolvedValue({ data: [{ id: 3, name: "CV", is_primary: true }] });
    const analyze = vi.fn().mockResolvedValue(analysis);
    render(<CustomResumeModal job={{ title: "SWE", company: "Acme", url: "u" }} onClose={() => {}} analyze={analyze} generate={vi.fn()} jobId={null} />);
    await waitFor(() => expect(analyze).toHaveBeenCalledWith(3));
    expect(post).not.toHaveBeenCalledWith(expect.stringContaining("/ai/custom-resume-analysis"), expect.anything());
  });

  it("shows 'Attach to application' when onAttach is provided", async () => {
    get.mockResolvedValue({ data: [{ id: 3, name: "CV", is_primary: true }] });
    const analyze = vi.fn().mockResolvedValue(analysis);
    render(<CustomResumeModal job={{ title: "SWE", company: "Acme", url: "u" }} onClose={() => {}} analyze={analyze} generate={vi.fn()} jobId={null} onAttach={vi.fn()} />);
    await waitFor(() => expect(screen.queryByRole("link", { name: /Apply Now/i })).toBeNull());
    expect(screen.getByRole("button", { name: /Attach to application/i })).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `cd frontend && npx vitest run src/components/CustomResumeModal.test.tsx`
Expected: FAIL (props not supported; default still hardcoded; no Attach button).

- [ ] **Step 3: Refactor `CustomResumeModal.tsx`**

- Change the signature and derive defaults:

```tsx
export default function CustomResumeModal({
  job, onClose, analyze, generate, jobId, onAttach,
}: CustomResumeModalProps) {
  const effJobId = jobId !== undefined ? jobId : (job.id ?? null);
  const doAnalyze = analyze ?? ((rid: number | null) =>
    api.post<Analysis>(`/ai/custom-resume-analysis/${job.id}`, { resume_id: rid }).then((r) => r.data));
  const doGenerate = generate ?? ((rid: number | null, sections: string[], keywords: string[]) =>
    api.post<RewriteResult>(`/ai/custom-resume/${job.id}`, { resume_id: rid, sections, add_keywords: keywords }).then((r) => r.data));
```

- In `loadForResume`, replace the `api.post(\`/ai/custom-resume-analysis/${job.id}\`, ...)` with `doAnalyze(rid)`; keep the `rid ? api.get(\`/resumes/${rid}\`) ...` detail call as-is.
- In `generate()`, replace `api.post(\`/ai/custom-resume/${job.id}\`, {...})` with `await doGenerate(resumeId, [...sections], [...keywords])`.
- Pass `jobId={effJobId}` to `<VersionsPanel .../>` and `<ResumeEditor .../>` (replace `job.id`).
- In `renderFooter()`, both the editing branch and the review branch: replace the `<a ... href={job.url}>Apply Now</a>` with:

```tsx
{onAttach
  ? <button className="ai-btn ai-btn-primary" onClick={() => void onAttach()} disabled={!rewrite}>Attach to application</button>
  : <a className="ai-btn ai-btn-primary" href={job.url} target="_blank" rel="noopener noreferrer">Apply Now</a>}
```

- Update the `AIJob` interface `id: number` → `id?: number` and export `AttachFile`. Guard the `logoColor(job.company)`/`slug` (already string-safe).

- [ ] **Step 4: Refactor `CoverLetterModal.tsx`**

- Signature:

```tsx
export default function CoverLetterModal({ job, onClose, generate, canSave = true, onAttach }: CoverLetterModalProps) {
  const doGenerate = generate ?? ((rid: number | null, tone?: string, base?: string) =>
    api.post<{ text: string }>(`/ai/cover-letter/${job.id}`, { resume_id: rid, tone: tone?.toLowerCase() ?? null, base_text: base ?? null }).then((r) => r.data));
```

- In the local `generate(rid, tone, base)` wrapper, call `const data = await doGenerate(rid, tone, base); setText(data.text); ...`.
- Wrap the Save button in `{canSave && (...)}`.
- Replace `<a href={job.url}>Apply Now</a>` with the same `onAttach ? <button…> : <a…>` pattern as Task 4 Step 3.

- [ ] **Step 5: Run modal test + typecheck**

Run: `cd frontend && npx vitest run src/components/CustomResumeModal.test.tsx && npx tsc --noEmit`
Expected: PASS; no TS errors. Also confirm existing callers of both modals (`Jobs.tsx`, `AIToolsSidebar.tsx`, `ApplyFlowModal.tsx`) still typecheck (they pass `job` with a numeric `id`, which satisfies `id?`).

- [ ] **Step 6: Full frontend suite**

Run: `cd frontend && npx vitest run`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/CustomResumeModal.tsx frontend/src/components/CoverLetterModal.tsx frontend/src/components/CustomResumeModal.test.tsx
git commit -m "refactor(ai-modals): accept data-source + onAttach props (web behaviour unchanged)"
```

---

## Task 5: Frontend embed routes + port-token API bridge

**Files:**
- Create: `frontend/src/pages/embed/embedApi.ts`
- Create: `frontend/src/pages/embed/CustomResumeEmbed.tsx`
- Create: `frontend/src/pages/embed/CoverLetterEmbed.tsx`
- Modify: `frontend/src/main.tsx`
- Modify: `vercel.json`
- Test: `frontend/src/pages/embed/embedApi.test.ts`

**Interfaces:**
- `embedApi.ts` produces:
  ```ts
  interface EmbedBridge {
    ready: Promise<{ token: string; job: { title: string; company: string; description: string; url: string } }>;
    getToken: () => string;                       // current token
    requestFreshToken: () => Promise<string>;     // posts need-token, resolves on reply
    attach: (kind: "resume" | "cover", file: { dataBase64: string; filename: string; contentType: string }) => void;
    close: () => void;
  }
  export function createEmbedBridge(parentOrigin?: string): EmbedBridge;
  // Message protocol (iframe ⇄ parent):
  //   iframe → parent (window.parent.postMessage): { type: "ready" }
  //   parent → iframe (MessagePort): { type: "init", token, job }
  //   iframe → parent (port): { type: "need-token" }; parent → iframe (port): { type: "token", token }
  //   iframe → parent (port): { type: "attach", kind, dataBase64, filename, contentType }
  //   iframe → parent (port): { type: "close" }
  export function createEmbedAxios(getToken: () => string, onUnauthorized: () => Promise<string>): AxiosInstance;
  ```

- [ ] **Step 1: Write the failing test for the bridge protocol**

```ts
// frontend/src/pages/embed/embedApi.test.ts
import { describe, it, expect, vi } from "vitest";
import { createEmbedBridge } from "./embedApi";

describe("createEmbedBridge", () => {
  it("posts {type:'ready'} to parent and resolves ready on init via the port", async () => {
    const channel = new MessageChannel();
    const postSpy = vi.spyOn(window.parent, "postMessage").mockImplementation((msg: any, _t: any, transfer: any) => {
      // Simulate the parent receiving 'ready' with a port, then sending 'init'.
      if (msg?.type === "ready" && transfer?.[0]) {
        const port: MessagePort = transfer[0];
        port.postMessage({ type: "init", token: "T1", job: { title: "SWE", company: "Acme", description: "d", url: "u" } });
      }
    });
    const bridge = createEmbedBridge("https://www.tailrd.ca");
    const { token, job } = await bridge.ready;
    expect(token).toBe("T1");
    expect(job.company).toBe("Acme");
    expect(bridge.getToken()).toBe("T1");
    postSpy.mockRestore();
    void channel;
  });
});
```

(The bridge creates its own `MessageChannel`, transfers `port2` to the parent via `window.parent.postMessage({type:"ready"}, targetOrigin, [port2])`, and listens on `port1`. The test stubs `window.parent.postMessage` to echo an `init` back through the transferred port.)

- [ ] **Step 2: Run — expect FAIL**

Run: `cd frontend && npx vitest run src/pages/embed/embedApi.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement `embedApi.ts`**

```ts
// frontend/src/pages/embed/embedApi.ts
import axios, { type AxiosInstance } from "axios";

export interface EmbedJob { title: string; company: string; description: string; url: string }
export interface AttachFile { dataBase64: string; filename: string; contentType: string }

export function createEmbedBridge(parentOrigin = "*") {
  const channel = new MessageChannel();
  const port = channel.port1;
  let token = "";
  let pendingToken: ((t: string) => void) | null = null;

  const ready = new Promise<{ token: string; job: EmbedJob }>((resolve) => {
    port.onmessage = (e: MessageEvent) => {
      const msg = e.data;
      if (msg?.type === "init") {
        token = msg.token;
        resolve({ token: msg.token, job: msg.job });
      } else if (msg?.type === "token") {
        token = msg.token;
        pendingToken?.(msg.token);
        pendingToken = null;
      }
    };
  });
  port.start?.();
  window.parent.postMessage({ type: "ready" }, parentOrigin, [channel.port2]);

  return {
    ready,
    getToken: () => token,
    requestFreshToken: () =>
      new Promise<string>((resolve) => { pendingToken = resolve; port.postMessage({ type: "need-token" }); }),
    attach: (kind: "resume" | "cover", file: AttachFile) =>
      port.postMessage({ type: "attach", kind, ...file }),
    close: () => port.postMessage({ type: "close" }),
  };
}

export function createEmbedAxios(getToken: () => string, onUnauthorized: () => Promise<string>): AxiosInstance {
  const inst = axios.create({ baseURL: "" }); // same-origin
  inst.interceptors.request.use((cfg) => {
    const t = getToken();
    if (t) cfg.headers.Authorization = `Bearer ${t}`;
    return cfg;
  });
  inst.interceptors.response.use(
    (r) => r,
    async (error) => {
      const orig = error.config;
      if (error.response?.status === 401 && !orig._retry) {
        orig._retry = true;
        const t = await onUnauthorized();
        orig.headers.Authorization = `Bearer ${t}`;
        return inst(orig);
      }
      return Promise.reject(error);
    },
  );
  return inst;
}
```

- [ ] **Step 4: Run — expect PASS**

Run: `cd frontend && npx vitest run src/pages/embed/embedApi.test.ts`
Expected: PASS.

- [ ] **Step 5: Implement the two embed pages**

```tsx
// frontend/src/pages/embed/CustomResumeEmbed.tsx
import { useEffect, useMemo, useState } from "react";
import CustomResumeModal, { type AIJob } from "../../components/CustomResumeModal";
import { createEmbedBridge, createEmbedAxios, type EmbedJob } from "./embedApi";

export default function CustomResumeEmbed() {
  const bridge = useMemo(() => createEmbedBridge(), []);
  const api = useMemo(() => createEmbedAxios(bridge.getToken, bridge.requestFreshToken), [bridge]);
  const [ctx, setCtx] = useState<EmbedJob | null>(null);
  const [lastRewriteDoc, setLastRewriteDoc] = useState<any>(null);

  useEffect(() => { bridge.ready.then(({ job }) => setCtx(job)); }, [bridge]);
  if (!ctx) return <div className="ai-loading"><div className="ai-spinner" /></div>;

  const job: AIJob = { title: ctx.title, company: ctx.company, url: ctx.url };

  const analyze = (rid: number | null) =>
    api.post("/api/custom-resume-analysis", {
      resume_id: rid, job_title: ctx.title, company: ctx.company, job_description: ctx.description,
    }).then((r) => r.data);

  const generate = (rid: number | null, sections: string[], keywords: string[]) =>
    api.post("/api/custom-resume", {
      resume_id: rid, job_title: ctx.title, company: ctx.company, job_description: ctx.description,
      sections, add_keywords: keywords,
    }).then((r) => { setLastRewriteDoc(r.data.document); return r.data; });

  const onAttach = async () => {
    const doc = lastRewriteDoc;
    if (!doc) return;
    const slug = ctx.company.toLowerCase().replace(/\s+/g, "-") || "company";
    const res = await api.post("/api/render-resume", { document: doc, filename: `resume-${slug}.pdf` });
    bridge.attach("resume", { dataBase64: res.data.data_base64, filename: res.data.name, contentType: res.data.content_type });
  };

  return <CustomResumeModal job={job} onClose={bridge.close} analyze={analyze} generate={generate} jobId={null} onAttach={onAttach} />;
}
```

```tsx
// frontend/src/pages/embed/CoverLetterEmbed.tsx
import { useEffect, useMemo, useState } from "react";
import CoverLetterModal from "../../components/CoverLetterModal";
import type { AIJob } from "../../components/CustomResumeModal";
import { createEmbedBridge, createEmbedAxios, type EmbedJob } from "./embedApi";

export default function CoverLetterEmbed() {
  const bridge = useMemo(() => createEmbedBridge(), []);
  const api = useMemo(() => createEmbedAxios(bridge.getToken, bridge.requestFreshToken), [bridge]);
  const [ctx, setCtx] = useState<EmbedJob | null>(null);
  const [lastText, setLastText] = useState("");

  useEffect(() => { bridge.ready.then(({ job }) => setCtx(job)); }, [bridge]);
  if (!ctx) return <div className="ai-loading"><div className="ai-spinner" /></div>;

  const job: AIJob = { title: ctx.title, company: ctx.company, url: ctx.url };

  const generate = (rid: number | null, tone?: string, base?: string) =>
    api.post("/api/cover-letter", {
      resume_id: rid, job_title: ctx.title, company: ctx.company, job_description: ctx.description,
      tone: tone?.toLowerCase() ?? null, base_text: base ?? null,
    }).then((r) => { setLastText(r.data.text); return { text: r.data.text as string }; });

  const onAttach = async () => {
    if (!lastText) return;
    const slug = ctx.company.toLowerCase().replace(/\s+/g, "-") || "company";
    const res = await api.post("/api/render-cover-letter", { text: lastText, filename: `cover-letter-${slug}.pdf` });
    bridge.attach("cover", { dataBase64: res.data.data_base64, filename: res.data.name, contentType: res.data.content_type });
  };

  return <CoverLetterModal job={job} onClose={bridge.close} generate={generate} canSave={false} onAttach={onAttach} />;
}
```

(Note: `CoverLetterModal`'s internal editor tracks its own `text`; `generate` mirrors it into `lastText` for attach. If the modal edits text without regenerating, attach uses the last generated text — acceptable for v1; a later refinement can expose the edited text via an `onTextChange` prop.)

- [ ] **Step 6: Add routes + vercel header**

`frontend/src/main.tsx` — add lazy imports + routes (outside `/app`, no `ProtectedRoute`):

```tsx
import CustomResumeEmbed from "./pages/embed/CustomResumeEmbed";
import CoverLetterEmbed from "./pages/embed/CoverLetterEmbed";
// ...inside <Routes>:
<Route path="/embed/custom-resume" element={<CustomResumeEmbed />} />
<Route path="/embed/cover-letter" element={<CoverLetterEmbed />} />
```

`vercel.json` — add to the `headers` array (before the catch-all rewrite handles `/embed/*` → index.html, which already exists):

```json
{
  "source": "/embed/(.*)",
  "headers": [
    { "key": "Content-Security-Policy", "value": "frame-ancestors https:" }
  ]
}
```

- [ ] **Step 7: Typecheck + build + full suite**

Run: `cd frontend && npx tsc --noEmit && npx vitest run && npm run build`
Expected: no TS errors; tests pass; build succeeds (embed pages compiled).

- [ ] **Step 8: Commit**

```bash
git add frontend/src/pages/embed frontend/src/main.tsx vercel.json
git commit -m "feat(embed): /embed/custom-resume + /embed/cover-letter with port-token bridge"
```

---

## Task 6: Extension — iframe overlay bridge replacing vanilla cards

**Files:**
- Create: `chrome-extension/src/content/aiModalBridge.ts`
- Modify: `chrome-extension/src/content/overlay.ts`
- Delete: `chrome-extension/src/content/tailorCard.ts`, `chrome-extension/src/content/coverLetterCard.ts` (+ their `.test.ts` if present) once unreferenced.
- Test: `chrome-extension/src/content/aiModalBridge.test.ts`

**Interfaces:**
- `aiModalBridge.ts` produces:
  ```ts
  interface OpenAiModalOpts {
    kind: "resume" | "cover";
    appOrigin: string;                         // e.g. https://www.tailrd.ca
    job: { title: string; company: string; description: string; url: string };
    getToken: () => Promise<string>;           // current access token (ensures freshness)
    refreshToken: () => Promise<string>;       // force refresh, returns new token
    onAttach: (kind: "resume" | "cover", file: { dataBase64: string; filename: string; contentType: string }) => Promise<void>;
    mount: HTMLElement;                        // shadow-root container to append the overlay to
  }
  export function openAiModal(opts: OpenAiModalOpts): { close: () => void };
  // Also export the pure message handler for unit testing:
  export function handleBridgeMessage(
    msg: any,
    ctx: { job: OpenAiModalOpts["job"]; token: string; refreshToken: () => Promise<string>;
           onAttach: OpenAiModalOpts["onAttach"]; postInit: (init: any) => void;
           postToken: (t: string) => void; close: () => void },
  ): Promise<void>;
  ```

- [ ] **Step 1: Write the failing test for the message handler**

```ts
// chrome-extension/src/content/aiModalBridge.test.ts
import { describe, it, expect, vi } from "vitest";
import { handleBridgeMessage } from "./aiModalBridge";

const baseCtx = () => ({
  job: { title: "SWE", company: "Acme", description: "d", url: "u" },
  token: "T1",
  refreshToken: vi.fn().mockResolvedValue("T2"),
  onAttach: vi.fn().mockResolvedValue(undefined),
  postInit: vi.fn(),
  postToken: vi.fn(),
  close: vi.fn(),
});

describe("handleBridgeMessage", () => {
  it("responds to ready-derived init request by posting init with token + job", async () => {
    const ctx = baseCtx();
    // The parent posts 'init' immediately after receiving the port; simulate the trigger.
    await handleBridgeMessage({ type: "port-open" }, ctx);
    expect(ctx.postInit).toHaveBeenCalledWith({ type: "init", token: "T1", job: ctx.job });
  });

  it("refreshes token on need-token", async () => {
    const ctx = baseCtx();
    await handleBridgeMessage({ type: "need-token" }, ctx);
    expect(ctx.refreshToken).toHaveBeenCalled();
    expect(ctx.postToken).toHaveBeenCalledWith("T2");
  });

  it("attaches on attach message", async () => {
    const ctx = baseCtx();
    await handleBridgeMessage(
      { type: "attach", kind: "resume", dataBase64: "AAAA", filename: "r.pdf", contentType: "application/pdf" },
      ctx,
    );
    expect(ctx.onAttach).toHaveBeenCalledWith("resume", { dataBase64: "AAAA", filename: "r.pdf", contentType: "application/pdf" });
  });

  it("closes on close message", async () => {
    const ctx = baseCtx();
    await handleBridgeMessage({ type: "close" }, ctx);
    expect(ctx.close).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run directly via node vitest — expect FAIL**

Run: `cd chrome-extension && node ./node_modules/vitest/vitest.mjs run src/content/aiModalBridge.test.ts`
Expected: FAIL (module missing). (Do NOT use `npm test` — see Global Constraints.)

- [ ] **Step 3: Implement `aiModalBridge.ts`**

```ts
// chrome-extension/src/content/aiModalBridge.ts
export interface AttachFile { dataBase64: string; filename: string; contentType: string }
export interface AiModalJob { title: string; company: string; description: string; url: string }

interface BridgeCtx {
  job: AiModalJob;
  token: string;
  refreshToken: () => Promise<string>;
  onAttach: (kind: "resume" | "cover", file: AttachFile) => Promise<void>;
  postInit: (init: { type: "init"; token: string; job: AiModalJob }) => void;
  postToken: (t: string) => void;
  close: () => void;
}

/** Pure-ish message router (unit-tested). `port-open` is our synthetic trigger
 * fired once the iframe's 'ready' has been received and the port is live. */
export async function handleBridgeMessage(msg: any, ctx: BridgeCtx): Promise<void> {
  switch (msg?.type) {
    case "port-open":
      ctx.postInit({ type: "init", token: ctx.token, job: ctx.job });
      return;
    case "need-token": {
      const t = await ctx.refreshToken();
      ctx.token = t;
      ctx.postToken(t);
      return;
    }
    case "attach":
      await ctx.onAttach(msg.kind, { dataBase64: msg.dataBase64, filename: msg.filename, contentType: msg.contentType });
      return;
    case "close":
      ctx.close();
      return;
  }
}

export interface OpenAiModalOpts {
  kind: "resume" | "cover";
  appOrigin: string;
  job: AiModalJob;
  getToken: () => Promise<string>;
  refreshToken: () => Promise<string>;
  onAttach: (kind: "resume" | "cover", file: AttachFile) => Promise<void>;
  mount: HTMLElement;
}

export function openAiModal(opts: OpenAiModalOpts): { close: () => void } {
  const path = opts.kind === "resume" ? "/embed/custom-resume" : "/embed/cover-letter";
  const wrap = document.createElement("div");
  wrap.className = "ap-ai-modal-wrap";
  const iframe = document.createElement("iframe");
  iframe.className = "ap-ai-modal-frame";
  iframe.src = `${opts.appOrigin}${path}`;
  iframe.allow = "clipboard-write";
  wrap.appendChild(iframe);
  opts.mount.appendChild(wrap);

  let port: MessagePort | null = null;
  const close = () => { port?.close(); wrap.remove(); window.removeEventListener("message", onReady); };

  const wireCtx = async (): Promise<BridgeCtx> => ({
    job: opts.job,
    token: await opts.getToken(),
    refreshToken: opts.refreshToken,
    onAttach: opts.onAttach,
    postInit: (m) => port?.postMessage(m),
    postToken: (t) => port?.postMessage({ type: "token", token: t }),
    close,
  });

  // The iframe posts {type:"ready"} with a transferred MessagePort.
  const onReady = async (e: MessageEvent) => {
    if (e.origin !== opts.appOrigin) return;
    if (e.data?.type !== "ready" || !e.ports?.[0]) return;
    port = e.ports[0];
    const ctx = await wireCtx();
    port.onmessage = (ev) => { void handleBridgeMessage(ev.data, ctx); };
    port.start?.();
    void handleBridgeMessage({ type: "port-open" }, ctx);
  };
  window.addEventListener("message", onReady);

  return { close };
}
```

- [ ] **Step 4: Run the test — expect PASS**

Run: `cd chrome-extension && node ./node_modules/vitest/vitest.mjs run src/content/aiModalBridge.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Wire into `overlay.ts`**

In `chrome-extension/src/content/overlay.ts`:
- Import `openAiModal` and the app origin (reuse the existing config source used for `apiBaseUrl`; the embed origin is the same host as the API for prod — read from the extension config).
- Replace the current résumé-rewrite button handler (`doTailor()` → `buildTailorCardHtml` path) with a call that opens the modal:

```ts
openAiModal({
  kind: "resume",
  appOrigin,                       // e.g. new URL(apiBaseUrl).origin
  job: { title, company, description, url: location.href },
  getToken: ensureAndGetAccessToken,   // wraps ensureFreshAccessToken + getAuth().accessToken
  refreshToken: forceRefreshAccessToken, // wraps refreshTokens + returns new token
  onAttach: async (_kind, file) => { await attachFileToApplication(file); }, // reuse existing onAttachTailored logic
  mount: panelShadowRoot,          // the existing shadow-root host used for the panel
});
```

- Replace the cover-letter button handler similarly with `kind: "cover"`.
- Reuse the **existing** file-attach routine that `onAttachTailored` used (converts base64 → File → sets it on the detected file input). Extract it to a small helper `attachFileToApplication(file)` if it's currently inline, so both the old and new paths agree.
- Provide `ensureAndGetAccessToken`/`forceRefreshAccessToken` helpers backed by `client.ts` (`ensureFreshAccessToken` + `getAuth`; and a `refreshTokens`-based force refresh — export a thin `forceRefresh(): Promise<string>` from `client.ts` if not already available).
- Remove the now-dead imports/usages of `buildTailorCardHtml`, `buildCoverLetterCardHtml`, `doTailor`, `doGenerateCoverLetter`, and the old `ap-pdf-modal` tailor/cover result path.

- [ ] **Step 6: Delete the retired card modules + their tests**

```bash
git rm chrome-extension/src/content/tailorCard.ts chrome-extension/src/content/coverLetterCard.ts
# also git rm their *.test.ts if they exist
```

Grep to confirm no remaining imports:

Run: `cd chrome-extension && npx tsc --noEmit`
Expected: no TS errors (all references removed).

- [ ] **Step 7: Extension build + full extension test run (direct node vitest)**

Run: `cd chrome-extension && node ./node_modules/vitest/vitest.mjs run && npm run build`
Expected: all tests pass; build produces the bundle.

- [ ] **Step 8: Commit**

```bash
git add chrome-extension/src/content/aiModalBridge.ts chrome-extension/src/content/aiModalBridge.test.ts chrome-extension/src/content/overlay.ts
git rm --cached chrome-extension/src/content/tailorCard.ts chrome-extension/src/content/coverLetterCard.ts 2>/dev/null || true
git commit -m "feat(extension): embed real app AI modals via iframe bridge; retire vanilla cards"
```

---

## Final verification

- [ ] **Backend:** `cd backend && python -m pytest tests/test_tailor_api.py tests/test_cover_letter_api.py -v` → PASS.
- [ ] **Frontend:** `cd frontend && npx tsc --noEmit && npx vitest run && npm run build` → clean.
- [ ] **Extension:** `cd chrome-extension && npx tsc --noEmit && node ./node_modules/vitest/vitest.mjs run && npm run build` → clean.
- [ ] **Manual smoke (documented, not automated):** onboarding blocks finish until a resume analyzes; extension résumé-rewrite opens the exact 3-step modal and "Attach to application" drops a PDF onto a live ATS file input; cover-letter modal attaches likewise.
- [ ] Do NOT push; leave for user review (per prior deploy hygiene).

## Self-review notes

- Spec coverage: Part 1 → Tasks 1–2; Part 2a → Task 3; Part 2b modal refactor → Task 4; embed routes + CSP + auth bridge (2b/2c) → Task 5; extension iframe (2d) → Task 6. Accepted gaps (cover Save, empty versions) encoded in Task 5 `canSave={false}`/`jobId={null}`.
- Type consistency: `AttachFile {dataBase64, filename, contentType}` identical across embedApi, aiModalBridge, and modal props. `analyze(rid)`/`generate(rid, sections, keywords)` signatures match between Task 4 defaults and Task 5 embed impls. `EmbedJob {title, company, description, url}` consistent.
- Placeholder scan: none — every code step is concrete. Implementation-time verifications (exact `tailor_document` result attrs, phosphor `Spinner` export, existing overlay attach helper name) are flagged inline with the fallback to use.
