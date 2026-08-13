# Diagnostic capture: turning applications into regression tests

The loop this documents: **apply to a lot of jobs, then have an agent mine what
was captured and turn each distinct failure into a test.**

It exists because the previous loop ([diagnosing-autofill-from-prod-logs.md])
kept hitting the same wall. The telemetry could say *which* field failed, never
what the form looked like or what we tried to type, so every fix needed somebody
to go and open the live page. That works for a public job post. It does not work
for the forms that fail most: several steps into a flow, behind a login.

A capture is the missing half. It carries the markup, so the form can be rebuilt
as a fixture months later, from a page nobody can reach any more.

---

## Turning it on

Capture is **per account and off by default**. The extension asks the server
before it captures anything, so an account that never opted in does not build or
transmit answers or markup at all.

```sql
UPDATE user_settings SET diagnostic_capture = true WHERE user_id = 44;
```

The extension re-checks at most every 10 minutes, so give it that long (or
reload the extension).

To confirm it took, `GET /autofill/diagnostic` returns `{"enabled": true}`.

## The loop

1. Apply to a batch of jobs with the extension. Nothing else to do; every field
   of every fill is recorded, successes included.
2. `python scripts/autofill_captures.py rank --days 14`
3. For the biggest cluster: `... show <id>` to read the whole field.
4. `... fixture <id> > chrome-extension/test/fixtures/<name>.ts`
5. Write a test against that fixture that FAILS, fix the engine, watch it pass.
6. Re-run the full suite; commit fixture + test + fix together.

Step 5 is the one to be strict about. **A new test that passes on the first run
against unfixed code proves nothing** — it happened three times over 2026-08-12/13,
twice because the fixture did not reproduce the real widget and once because a
poll budget was smaller than the timeout being tested. Revert your fix, watch the
test fail, restore it. Every time.

## What a capture holds

One row per field per fill, in `autofill_field_captures`:

| column | why it is there |
|---|---|
| `label`, `help_text` | full, untruncated. `help_text` is the documented trap: the gate sees it, the old logs did not show it |
| `category`, `confidence` | what the classifier decided, and how sure it was |
| `control_type`, `input_type`, `required` | `combobox` vs `select` is the single most load-bearing property, and it used to be absent |
| `options` | what the widget **really** offered, read live. `DetectedField.options` is captured at scan time, which for a react-select is before its list exists |
| `proposed_value`, `observed_value` | what we tried to write, and what the page held afterwards |
| `redacted` | a secret was swapped for a marker, so a blank answer is never mistaken for a fill bug |
| `tier`, `pass`, `outcome`, `reason` | which layer produced it and what happened |
| `dom`, `selector` | the sanitised markup. This is the fixture |
| `group_index` | which repeating row, so a second job's fields are attributable |

Report-level, on `autofill_reports`: `extension_version` (a stale local build has
been mistaken for a code bug more than once) and `durations`
(`{scan_ms, local_ms, backend_ms, reask_ms, total_ms}`).

### Successes are captured too, on purpose

The bug class this codebase keeps hitting is *filled, but with the wrong value*.
On 2026-08-12 a Lyft application typed the applicant's employer name into a legal
certification box and reported it as `filled`. No failure counter moved. The only
signal was that the field's **category looked implausible for its label**.

So when mining, do not only read `outcome != 'filled'`. Also ask:

```sql
-- Filled fields whose category is suspicious for the label they matched.
SELECT id, host, label, category, proposed_value
FROM autofill_field_captures
WHERE outcome = 'filled'
  AND length(label) > 120           -- prose is not a data field
ORDER BY created_at DESC LIMIT 50;
```

```sql
-- The same answer landing in categories that should never share one.
SELECT proposed_value, count(DISTINCT category) AS cats,
       array_agg(DISTINCT category) AS which
FROM autofill_field_captures
WHERE outcome = 'filled' AND proposed_value <> ''
GROUP BY proposed_value HAVING count(DISTINCT category) > 2;
```

## Privacy

Two records, deliberately different:

- `autofill_reports.field_outcomes` — **everybody**. Labels, categories,
  provenance and booleans. Failure reasons have quoted answers stripped
  (`scrubAnswerFromReason`); the employer's `(saw: …)` option list is kept,
  since that is not the user's data.
- `autofill_field_captures` — **opted-in accounts only**. Answers and markup.

Two floors apply even with capture on:

- Passwords and values shaped like a national ID or payment card are replaced
  with a type marker, and flagged `redacted`.
- Markup is sanitised before it is sent: scripts, styles, SVG paths, images and
  inline styles removed, each attribute capped, whole snapshot capped (~4 KB
  client-side, 8 KB server-side). `outerHTML` does not serialise a control's
  live `.value`, so a snapshot of a filled input carries no typed text.

The server authorises capture from its **own** copy of the flag. A client that
posts captures for an account that did not opt in has them discarded, so nobody
can opt an account in by sending data at it.

## Cost

Roughly 1-2 KB per field after Postgres compresses `dom`; a 50-field application
is ~75 KB, so 1,000 applications is well under 100 MB. Capped at 150 fields per
report, and captures are ranked failures-first so a cap never silently drops the
interesting ones. Watch it anyway: this project has had a
[Neon egress incident] before.

```sql
SELECT pg_size_pretty(pg_total_relation_size('autofill_field_captures'));
```

Pruning, when it is wanted:

```sql
DELETE FROM autofill_field_captures
WHERE created_at < NOW() - INTERVAL '90 days' AND outcome = 'filled';
```

[diagnosing-autofill-from-prod-logs.md]: ./diagnosing-autofill-from-prod-logs.md
[Neon egress incident]: ./diagnosing-autofill-from-prod-logs.md
