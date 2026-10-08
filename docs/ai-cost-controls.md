# AI cost controls

As of 2026-10-08, nothing in the app calls OpenAI unless a person clicks
something, with one small, capped exception (alert confirmations, below).

## What is free now

| Feature | Before | Now |
| --- | --- | --- |
| Match score for every job, every user (cron sweep) | 1 gpt-4o-mini call per (user, job), ~$5/user/month | Local scorer (`services/local_match.py`), $0 |
| Opening a job (match breakdown panel) | 1 call per open, and it used up the user's daily AI limit | Local, $0, no limit used |
| Opening a job (description sections) | 1 call per job, first open | Client-side parse, $0 (`JOB_STRUCTURE_AI=1` restores) |
| Résumé upload (score the newest jobs) | 10 calls per upload | Local, 300 newest jobs, $0 |
| Feed sort "best match", strong-match filter, sidebar | Used a dead global column (0 everywhere) | Per-user banked scores |

## The one automatic AI use: confirming alerts

Before a "strong match" email goes out, the sweep asks gpt-4o-mini to confirm
the best local candidates: at most `MATCH_AI_DAILY_PER_USER` calls per user per
UTC day (default **3**, about $0.0015/user/day, roughly $0.05/user/month), and
only for jobs whose local score is at least `MATCH_AI_CONFIRM_MIN` (default 70).
A confirmed score replaces the local one for that user and job.

If the OpenAI account refuses the call (no funds, bad key), the sweep stops
asking for the rest of the run and emails on local scores instead.

## Settings (Vercel env vars, all optional)

| Variable | Default | Effect |
| --- | --- | --- |
| `MATCH_SCORING` | `local` | `ai` restores the old per-job LLM scoring everywhere |
| `MATCH_AI_DAILY_PER_USER` | `3` | LLM confirmations per user per day; `0` = matching never calls the LLM |
| `MATCH_AI_CONFIRM_MIN` | `70` | Local score a job needs before it can be confirmed |
| `JOB_STRUCTURE_AI` | off | `1` re-enables the LLM description parse on job open |
| `CRON_MATCH_JOBS_PER_USER` | `2000` local / `15` ai | Newest jobs considered per user per run |

## Still AI, only on a click

Résumé parsing on upload (once per résumé), résumé analysis/improve, cover
letter ideas, "Suggest Edits", résumé tailoring, and the autofill fields that
rules and the profile can't answer (at most 2 batched calls per form).

## How good is the local score

Fitted against 5,211 banked gpt-4o-mini scores across 5 real résumés.
Leave-one-user-out correlation 0.53 (0.60 to 0.70 for tech résumés). It is a
ranking signal: for the tech résumés, its top-ranked jobs averaged about 75 on
the LLM's own scale against an overall mean of about 45. Weaker for non-tech
résumés, because the skill taxonomy is tech-heavy, which is why alert emails
get the capped LLM confirmation.

Per-job inputs are computed once and stored in `scraped_jobs.match_terms`
(about 500 bytes), so per-user scoring never re-reads job descriptions.
Change the model, bump `LOCAL_MODEL_VERSION`; change the terms, bump
`TERMS_VERSION`. Both are recomputed for free.
