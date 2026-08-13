# Diagnosing the extension from production logs

The loop this documents: **apply to a real job, then read what the backend
logged about it.** It is the fastest way to find real autofill bugs, because it
uses a real ATS form with real DOM instead of a fixture someone wrote from
memory. Two of the three bugs found on 2026-08-11 were invisible to the test
suite and obvious in the logs within a minute.

Fixture tests tell you the engine still does what it did yesterday. This tells
you what it does on Workday *today*.

---

## The loop

1. Apply to a real job with the extension (autofill, and/or a résumé rewrite).
2. Pull the logs for the last few minutes (below).
3. Read three things: **what it cost**, **what got dropped**, **what errored**.
4. Reproduce anything suspicious locally against the real label/help text.
5. Fix, add a regression test naming the ATS and the date, ship.

Note the timestamp when you apply. It makes step 2 a narrow window instead of a search.

## Pulling the logs

The account is a Vercel team, so both of these need the team scope:

- **Project:** `resumate` — `prj_C4OAImyoRqumWzmH4VsLrqmIBJO6`
- **Team:** `team_RXATmgE7la84gJP2DPTIgwAc`

With the CLI (`npm i -g vercel` first — it is not installed by default here):

```bash
vercel logs --scope team_RXATmgE7la84gJP2DPTIgwAc > spend.log
python scripts/llm_cost_report.py --logs spend.log      # totals per operation + per user
```

Without the CLI, ask Claude — the Vercel MCP tools are wired up and
`get_runtime_logs` takes `query`, `since` (`"45m"`), and `environment`. Useful queries:

| query | answers |
|---|---|
| `llm_cost` | what every AI call cost, and to whom |
| `fill: dropped` | which fields the gate refused, and why |
| `llm_memo` | whether the analysis memo is hitting |
| `AI batch failed` | a whole batch of answers never came back |
| `/api/fill` | everything about one autofill request |

Your user id is what ties a line to you. Find it with:

```sql
SELECT id FROM users WHERE lower(email) = 'you@example.com';
```

Neon project `divine-base-11638078`, branch `main` = prod. Then filter on `user=<id>`.

## Reading a healthy autofill

```
### 02:02:43 POST /api/fill 200 [info/serverless]
    llm_cost op=fill.batch.short model=gpt-4o-mini in=2447 cached=0 out=14 usd=0.000375 user=44
```

**Exactly one `fill.batch.short` line, plus one `fill.batch.essay` only if the
form had open-ended fields.** That is the whole AI cost of an autofill.

If you see **one line per field**, the deployment is running pre-2026-08-10 code
where `/fill` looped per field. That is a ~20× cost regression and the single
most important thing this log can tell you.

`cached=` is OpenAI's prompt-cache hit on the input. First fill after a deploy
is `cached=0`; later ones should be high, because the static rules block sits
ahead of the applicant context on purpose. `cached=0` on *every* fill means
something moved variable content in front of the static prefix — see
`test_llm_cost.py::test_static_rules_precede_the_per_request_context`.

## Reading a drop

```
fill: dropped ai answer for 'Are you authorized to work...?Yes No', contradicts_profile:requiresSponsorship
```

A drop is not automatically a bug — the gate exists to stop wrong answers
reaching employers, and `no_answer` on a question about a government ID number
is it working. What makes a drop a bug:

- **The same field dropped from both `rule` and `ai`.** Both passes produced an
  answer and both were refused, so the field submitted **blank**. Always investigate.
- **The reason names a field that is not the one in the label** (the case above:
  an authorization question refused for contradicting *sponsorship*).
- **`not_an_offered_option` on a field with obvious options** — usually the
  options were harvested from the wrong listbox.

Drop reasons: `no_answer` (model declined — usually correct), `ai_error` (the
call failed — our bug), `not_an_offered_option`, `contradicts_profile:<field>`.

### `ai_error` on *every* AI field means the batch died, not the fields

If a report is mostly `ai_error`, stop reading the fields and go read the
request. On 2026-08-12 a Lyft application (report #167) came back 11 filled /
13 failed with `ai_error` on twelve of them, and the cause was four OpenAI 429s
in a row:

```
POST https://api.openai.com/v1/chat/completions "HTTP/1.1 429 Too Many Requests"
OpenAI rate limited (429), retrying in 3s (attempt 1/4)          … 6s … 12s … 24s
AI batch failed for factual fields: OpenAI API rate limited after retries.
```

**429 is two different failures.** `rate_limit_exceeded` clears by waiting;
`insufficient_quota` (spent credit / hard billing limit) never does. The log
line now prints the code, so `429 insufficient_quota` says "go look at the
OpenAI billing page" and `429 rate_limit_exceeded` says "a burst". Terminal
codes fail fast instead of burning 45s of a request the user is waiting on.

### `tier` tells you which layer failed

`field_outcomes` carries `tier` alongside the drop reason, and they can
disagree — that disagreement is the useful part:

| tier | expected | observed | what actually broke |
|---|---|---|---|
| `backend` | true | false | the AI answer was refused or never came |
| `profile` | true | false | the local fallback ran and **the write missed** |
| `""` | false | — | nothing was ever proposed: a *resolver* gap, not a fill gap |

The Lyft report showed `tier: "profile"` on Work Authorization, School and
Degree — so the AI failing was not the whole story; those three had a local
answer, wrote it into a react-select, and the write did not stick. A blank
`tier` on the employment dates meant the opposite: no value was ever computed,
which pointed at `detectGroupIndex` rather than at any fill engine.

### Greenhouse has no `<select>` elements

Worth knowing before reading any Greenhouse report: every dropdown on a
`job-boards.greenhouse.io` form is an `<input type="text" role="combobox">`
(react-select v5), so **`options` is empty at scan time for all of them** and
the option list only exists after the widget is opened. "Start date" is not a
date picker either — it is a month combobox plus a separate free-text year
input, with the row index as an id *suffix* (`start-date-month-0`). See
`test/fixtures/greenhouseLyftReal.ts` for the captured markup.

### The trap: the log line is not the whole input

`fill.py` logs `field.label[:80]`. The gate is given **label *and* helpText**, and
`helpText` is harvested from surrounding DOM — so it routinely carries the
neighbouring question's wording. A drop that looks impossible from the label
alone usually makes sense once you see the help text.

This is exactly how the 2026-08-11 bug hid: the label plainly said "authorized to
work", the reason said "requiresSponsorship", and the regex that picked
sponsorship matched the *help text* of the field next to it. See
[[field-label-is-a-memory-key]] — bad labels have bitten this codebase before.

When a drop makes no sense, get the real help text from `autofill_reports` (it
stores the exact URL and per-field reasons) and reproduce:

```python
from datetime import date
from backend.services.answer_gate import validate_answer
from backend.routers.fill import ApplicantProfile

v = validate_answer(
    "Yes",
    label="<paste the real label>",
    options=["Yes", "No"],
    profile=ApplicantProfile(firstName="Ada", requiresSponsorship="No"),
    today=date.today(), company="Acme",
    help_text="<paste the real help text — this is usually the culprit>",
)
print(v.value, v.reason)
```

Toggle `help_text` between `""` and the real value. If it only drops with the
help text, you have found a contamination bug.

## Costing a journey

One "apply to this job" is more than one request. Measured on prod 2026-08-11:

| endpoint | calls | cost |
|---|---|---|
| `/ai/match-breakdown/{id}` | `match.score` | $0.000287 |
| `/ai/custom-resume-analysis/{id}` | `match.analyze` | $0.000335 |
| `/ai/custom-resume/{id}` | analyze + rewrite + analyze | $0.027875 |
| `/api/fill` | `fill.batch.short` | $0.000375 |

The rewrite is ~96% of it, and within the rewrite `resume.tailor_structured` on
`gpt-4o` is ~97%. **Any future cost work belongs there** — squeezing the
`gpt-4o-mini` calls is rounding error.

Repeat `match.analyze` for the same (résumé, job) is now memoised for 10 minutes
(`MATCH_ANALYSIS_MEMO_TTL`), so a journey buys it once and logs `llm_memo
op=match.analyze hit=1` for the rest. If you see two `match.analyze` **API** calls
with identical inputs seconds apart, the memo is not working — most likely the
requests landed on different serverless instances, which is expected
occasionally and not worth chasing unless it is every time.

## Model routing

Three env vars, changeable in Vercel without a redeploy:

| var | default | used for |
|---|---|---|
| `OPENAI_MODEL` | `gpt-4o` | résumé rewrite, essay answers |
| `OPENAI_MATCH_MODEL` | `gpt-4o-mini` | match scoring + analysis |
| `OPENAI_FIELD_MODEL` | `gpt-4o-mini` | batched factual form fields |

The `model=` in every cost line tells you what actually ran, which is how you
confirm an env change took effect.

## Before you conclude "the extension is broken"

- **Check the deployment.** `dep=dpl_...` on each log line. If the fix you are
  looking for is not in that deployment, the log is telling you about old code.
- **Rebuild the extension.** Several "code bug" reports here turned out to be a
  stale local build — see [[autofill-modal-profile-bugs]].
- **A blank field is not always a fill failure.** The gate may have correctly
  refused; the post-fill re-scan offers it in the gap modal.

## Costing without applying

```bash
python scripts/llm_cost_probe.py           # real API calls, ~3¢, prints real billed cost
python scripts/llm_cost_probe.py --show    # also prints the answers, for quality checks
python scripts/llm_cost_report.py          # offline model from the current prompts, free
```

`--show` is the quick way to sanity-check answer quality after changing a model
or a prompt: it prints every generated answer next to its field.
