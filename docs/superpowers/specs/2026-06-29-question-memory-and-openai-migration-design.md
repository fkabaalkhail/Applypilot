# Question Memory (human-in-the-loop autofill) + single-provider OpenAI migration

**Date:** 2026-06-29
**Status:** Approved — implementing
**Branch:** `feat/question-memory-openai-migration`

## Summary

Two coupled pieces of work:

1. **Provider migration** — consolidate the backend from two AI vendors to **one OpenAI
   key**. Today every AI feature runs on Anthropic (Claude); semantic search needs OpenAI
   embeddings. Rather than carry two keys, move **all** generation to OpenAI (`gpt-4o`) and
   use `text-embedding-3-small` for embeddings — one `OPENAI_API_KEY` for everything.

2. **Question Memory** — a per-user, searchable bank of previously approved application
   answers with a human-in-the-loop approval gate. When autofill hits a field it cannot
   confidently answer from the profile, it first searches that bank by **meaning**
   (embeddings), reuses a high-confidence match, and otherwise asks `gpt-4o` for a
   *suggestion* that the user must **Accept / Edit / Skip** before anything is filled or
   remembered. Every approval improves the bank; the user stays in control.

## Decisions (locked)

| # | Decision | Choice |
|---|----------|--------|
| 1 | Semantic matching engine | **OpenAI `text-embedding-3-small`**; vectors stored as JSON, cosine similarity in Python (no pgvector — per-user banks are tiny). |
| 2 | Review behaviour for AI-generated answers | **Review before fill (strict)** — the field stays empty until the user Accepts/Edits; only then does it fill *and* save. |
| 3 | High-confidence memory match | **Generic categories fill silently; `company_specific` matches route to the review card pre-filled** so the user adapts before it fills. |
| 4 | Chat model (replaces `claude-sonnet-4-6`) | **`gpt-4o`** across all backend AI features. |
| 5 | API keys | **One** — `OPENAI_API_KEY`. Remove `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` everywhere (code, `.env`, Vercel). |

## Current state (what we build on)

- **Autofill** classifies each field (`chrome-extension/src/content/fieldMatcher.ts`) and
  resolves it from the profile. Fields it can't fill that "read like a question" go to
  `POST /api/fill`.
- **`POST /api/fill`** (`backend/routers/fill.py`) answers in two passes: hardcoded
  rule-based answers, then a fresh `gpt-4o` (was Claude) call per remaining field via
  `answer_question`. **Nothing is remembered between applications.**
- The overlay already has a long-form **draft review** concept we generalize.
- **Every** AI caller goes through `get_llm_service()` (8 sites) — no direct
  `AnthropicService()` use outside the factory — so the provider swap is one factory edit
  plus a new service class.
- New tables auto-create via `Base.metadata.create_all` in the app lifespan; column adds
  to existing tables use explicit `migrate_*.py` scripts. A brand-new table needs only a
  model.

## Part A — Provider migration (Anthropic → OpenAI)

- **New `backend/services/openai_service.py`** — `OpenAIService` with the **identical
  public method signatures** as the old `AnthropicService`
  (`_generate(prompt, system=None)`, `answer_question`, `analyze_resume`,
  `analyze_resume_quality`, `generate_cover_letter`, `suggest_job_titles`,
  `tailor_resume`, `tailor_resume_guided`, `tailor_resume_structured`, `edit_snippet`,
  `extract_experience_years`, `generate_connection_message`, `match_job`). Reuses the
  existing `prompts/*.txt` files and `_extract_json` helper verbatim. Transport is OpenAI
  `POST /v1/chat/completions` via `httpx` (no SDK dependency, matching house style):
  - `system` → a `{"role":"system"}` message; prompt → `{"role":"user"}`.
  - Env: `OPENAI_API_KEY` (required), `OPENAI_MODEL` (default `gpt-4o`),
    `OPENAI_TIMEOUT` (60), `OPENAI_MAX_TOKENS` (4096).
  - Keep the 429/5xx retry/backoff behaviour the Anthropic client had.
  - JSON-returning methods keep using `_extract_json` (robust to fences); we may pass
    `response_format={"type":"json_object"}` where every prompt already demands JSON.
- **`backend/services/llm.py`** → `get_llm_service()` returns `OpenAIService()`.
- **`backend/services/__init__.py`** → import `openai_service` instead of `anthropic_service`.
- **`backend/routers/health.py`** → `checks["openai"] = bool(os.getenv("OPENAI_API_KEY"))`.
- **Delete `backend/services/anthropic_service.py`.**
- **Tests** — `test_tailor_api.py` and `test_ai_web_flow.py` patch
  `OpenAIService._generate` and set `OPENAI_API_KEY` (was `AnthropicService` /
  `ANTHROPIC_API_KEY`). Add `test_openai_service.py` covering `_generate` payload shape
  (model, system/user messages), response parsing, and missing-key error.
- **`.env`** — rename `OPEN_API_KEY` → `OPENAI_API_KEY`; drop `ANTHROPIC_API_KEY` and
  `ANTHROPIC_MODEL`; add `OPENAI_MODEL=gpt-4o`.
- **Vercel prod env** — add `OPENAI_API_KEY` + `OPENAI_MODEL` (additive, safe) **before**
  deploy; remove `ANTHROPIC_*` **after** the new code is live (avoid breaking running
  prod, which still reads `ANTHROPIC_API_KEY` until the deploy).

## Part B — Question Memory: data model & matching

**New table `saved_answers`** (SQLAlchemy model → auto-created via `create_all`):

| column | type | purpose |
|--------|------|---------|
| `id` | Integer PK | |
| `user_id` | Integer FK→users.id, indexed | per-user bank |
| `question_raw` | Text | the question as it appeared on the form |
| `question_canonical` | Text | normalized, company/role-stripped form used for matching |
| `answer` | Text | the final, user-approved answer |
| `category` | String | `salary` · `work_authorization` · `availability` · `behavioral` · `company_specific` · `general` |
| `embedding` | JSON | `list[float]` from OpenAI, computed on the **canonical** question |
| `embedding_model` | String | e.g. `text-embedding-3-small` — lets us re-embed if it changes |
| `source` | String | `ai` or `user_edited` (both user-approved; analytics) |
| `times_reused` | Integer, default 0 | usage counter ("continuously improve") |
| `created_at` / `updated_at` | DateTime | |

**Embeddings** — new `backend/services/embeddings.py`, an `EmbeddingsService` mirroring the
OpenAI service's `httpx` style: `embed(text) -> list[float]` against
`text-embedding-3-small` (1536-dim), using the same `OPENAI_API_KEY`. A module-level
`cosine(a, b) -> float` helper. If the key is missing or the call fails, callers treat the
result as "no embedding available" and skip semantic search.

**Canonicalization — deterministic, no AI.** `/api/fill` already receives `company` and
`jobTitle`. Canonical form = strip known company/title tokens (→ `{company}` / `{role}`
placeholders), lowercase, collapse whitespace. The **same** function runs at save and at
search time so query and stored vectors are comparable. This is what makes "Why Acme?"
match "Why Globex?".

**Categorization — deterministic mapping.** Map the extension's existing field category +
a small keyword pass (e.g. "why … this company / why us / about us" → `company_specific`;
"tell us about a time / describe a situation" → `behavioral`; salary / availability /
work-auth from their existing categories) → the six-value enum, default `general`.

**Matching:** embed the incoming canonical question → cosine against the user's rows → best
match. Threshold **0.86** (constant, tunable). On save, **upsert/dedup**: if an existing
row has the same canonical text or cosine ≥ **0.97**, update its answer + bump
`updated_at`/`times_reused` instead of inserting a duplicate.

## Part C — Fill flow, review UX & APIs

**Evolve `POST /api/fill`** — insert a *memory pass* between the rule-based and AI passes.
For each field not answered by rule/profile:

1. Canonicalize → embed → cosine vs the user's `saved_answers`.
2. **Match ≥ 0.86 & generic category** → `source:"memory", needsReview:false` → fills
   silently; bump `times_reused`.
3. **Match ≥ 0.86 & `company_specific`** → `source:"memory", needsReview:true` → review
   card pre-filled with the past answer.
4. **No match** → `gpt-4o` generates → `source:"ai", needsReview:true` → review card,
   **not saved**.

`FieldAnswer` grows four fields: `source` (`rule`/`profile`/`memory`/`ai`), `needsReview`
(bool), `category`, `canonicalQuestion`. Rule/profile answers keep `needsReview:false`.
**Degradation:** no key / embed failure → skip steps 1–4, go straight to AI generation, so
autofill never breaks; it just stops learning until embeddings return.

**Answer CRUD** — new `backend/routers/answers.py`, mounted at `/api`:

- `POST /api/answers` — the **only** write path to memory. Body
  `{question, answer, company, jobTitle, fieldType}`; the server canonicalizes,
  categorizes, embeds, and upserts (dedup at cosine ≥ 0.97). Enforces "save only on
  approval" server-side. Returns the saved row.
- `GET /api/answers` — list the user's saved answers (newest first).
- `DELETE /api/answers/{id}` — remove one (user control over their bank).

**Extension:**

- **API clients** (`chrome-extension/src/api/`): extend `aiFill.ts`'s answer type with
  `source` / `needsReview` / `category` / `canonicalQuestion`; new `answers.ts` →
  `saveAnswer({question, answer, company, jobTitle, fieldType})`, `listAnswers()`,
  `deleteAnswer(id)` (all via `authedRequest`).
- **`aiFillPlanner.ts`**: split candidates by `needsReview` instead of long/short —
  `false` → fill inline (`writeEngine`); `true` → review queue (any length). `isLongform`
  still informs the review card's textarea sizing.
- **Review card** in the overlay (generalizes the existing long-form draft review): per
  `needsReview` answer — question, an **editable** answer field (pre-filled with the
  suggestion or past answer), a source badge (✨ *AI suggestion* / ↩ *From a previous
  application*), the category, and **Accept** (write to field via `writeEngine` +
  `POST /api/answers`), **Edit** (focus the textarea; Accept saves the edited text),
  **Skip** (leave empty, save nothing).

## Error handling & degradation

- No `OPENAI_API_KEY` / embed call fails → memory search skipped; field falls through to AI
  generation. Autofill still works.
- Save (`POST /api/answers`) failure → the field is still filled for accepted answers; a
  non-blocking toast notes it wasn't remembered.
- `embedding_model` is recorded per row so a future model swap can re-embed.

## Testing

- **Backend (pytest)** — mirror the existing `test_*_properties.py` + router-test style;
  mock `EmbeddingsService.embed` and `OpenAIService`:
  - canonicalization (company/title stripping), category mapping, cosine/threshold
    selection, upsert/dedup.
  - the four `/api/fill` routes: memory-hit-silent, company-specific-review, AI-fallback,
    and degraded (no embeddings).
  - `/api/answers` POST/GET/DELETE.
  - `test_openai_service.py` for the new transport.
  - Repoint existing tailor/web-flow tests onto `OpenAIService`.
- **Extension (vitest)** — `planAiFill` `needsReview` split; save-on-accept wiring. Run
  vitest **directly via node** (the `npm test` stdio quirk in this repo).

## Build order (phases)

1. **Provider migration** (Part A) — self-contained; verify all existing AI features still
   pass before moving on.
2. **Backend memory** (Part B + the `/api/fill` and `/api/answers` work in Part C).
3. **Extension review UX** (Part C client/planner/overlay).
4. *(Optional, later)* a "Saved answers" management view in web settings.

## Out of scope (YAGNI for v1)

- Editing a saved answer in place (`PUT`) — delete + re-save covers it.
- pgvector / a vector index — unnecessary at per-user scale.
- A settings management UI (phase 4, optional).
- Mixing models per task (one `gpt-4o` for all generation for now).
