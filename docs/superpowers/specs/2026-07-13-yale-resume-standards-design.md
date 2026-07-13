# Yale resume standards in the AI rewrite pipeline

**Date:** 2026-07-13
**Status:** approved (user pre-approved; no review gate)

## Problem

Tailrd's resume AI has four prompts that each carry their own, partial idea of what a
good resume is:

| Prompt | Where it lives | What it does |
|---|---|---|
| `analyze_resume.txt` | file | transcribes an upload into the structured profile |
| `analyze_resume_quality.txt` | file | grades the resume, emits findings |
| `improve_resume.txt` | file | rewrites the resume from those findings (no target job) |
| `tailor_resume_structured` | **inline Python string** in `openai_service.py` | the main job-targeted rewrite, shared by web `/ai/custom-resume` and the extension |
| `tailor_resume_guided` | **inline Python string** | plain-text full rewrite |
| `tailor_resume.txt` | file | legacy plain-text summary |

Three problems follow from this:

1. **The standards drift.** "Strong action verbs" appears in four prompts, phrased four
   ways. The rules a rewrite is held to are not the rules the analyzer grades against.
2. **The most important prompt is the least maintainable.** The rewrite that actually
   ships to users is a Python string concat, so it cannot be reviewed, diffed, or tested
   like the other prompts.
3. **The rules themselves are thin and wrong for our users.** They say "use strong verbs"
   but not *which*; "fix tense" but not the rule; and the page-count rule
   (`≤1 page under 10 years`) is a professional-hire rule in a product whose job
   catalogue only ever contains internships and new-grad roles.

Yale OCS publishes a concrete, teachable standard covering exactly these gaps. Encoding it
makes every rewrite better from the first upload onward.

## Approach

Three moves, in dependency order.

### 1. One canonical standards block

A new `prompts/_standards.md` holds the Yale-derived rules once. `_load_prompt()` grows a
single include step: any `{{RESUME_STANDARDS}}` token in a prompt is replaced with that
file's contents. Every resume prompt includes it, so the analyzer grades against exactly
the rules the rewriter writes to.

The block covers what a model can act on — not the print-layout advice (fonts, margins,
colour), which is the PDF renderer's job, not the LLM's:

- **Bullets — the WHO method.** What did you do, How, with what Outcome. Quantify the
  outcome. 3–5 bullets per entry (3–4 ideal). 1–2 lines each.
- **Verbs.** Open with a strong action verb from the bank. Past roles → past tense;
  the current role → present *simple* ("create", never "creating").
- **Banned.** Pronouns, contractions, slang, passive voice, duty openers
  ("Responsible for", "Helped with"), narrative sentences, filler adjectives, and any
  personal data (photo, age, DOB, marital status, gender, nationality, religion).
- **Sections.** The canonical set and what belongs in each, including the interchangeable
  ones (Research / Volunteer / Leadership) and when a student should lead with Projects or
  Education rather than Work Experience.
- **Length by level.** Undergraduate 1 page; Master's 1–2; PhD/postdoc 2–3.
- **Selection.** Tailor to the target function: pick the relevant experiences and skills,
  do not list everything. Align verbs and skills with the job description's language.
- **ATS.** No tables/graphics/columns; bullets in work history; standard section names;
  one date format throughout.

### 2. The rewrite prompts become files

`tailor_resume_structured` and `tailor_resume_guided` move out of Python into
`prompts/tailor_resume_structured.txt` and `prompts/tailor_resume_guided.txt`, using the
existing `{{TOKEN}}` convention. `tailor_resume.txt` is rewritten to the same standard.
The Python keeps the parsing, merging, and fallback logic it already has — only the prompt
text moves. The wrapped `{resume, section_order, new_summary, gaps}` contract and the
`merge_rewrite` fact-locking are unchanged, so `test_tailor_structured.py` and
`test_resume_rewrite_regression.py` keep passing as-is.

### 3. The analyzer measures the new rules

`analyze_resume_quality.txt` is already handed a deterministic digest of MEASURED FACTS
(`resume_metrics.build_digest`) and told to treat it as ground truth. That is the right
seam: a rule the digest can measure is a rule the model cannot fudge, and it costs no extra
tokens at generation time. Yale adds eight measurable rules the digest does not yet cover:

| New fact | Yale rule it enforces |
|---|---|
| `level` (undergrad/masters/phd/professional) inferred from degrees | length + structure rules are level-dependent |
| `page_target` + over/under | 1 page undergrad, 1–2 Master's, 2–3 PhD |
| bullets per entry: entries with 0, `<3`, `>5` | 3–5 bullets per experience |
| present-continuous openers; tense mismatched to current/past role | past roles past tense; current role present simple |
| contractions | "avoid contractions" |
| personal data (photo, age, DOB, marital status, gender, nationality, religion) | never on a resume |
| entries out of reverse-chronological order | "use reverse chronological order" |
| opening verbs repeated ≥3× | "repeated verbs across bullets" |
| skills listed but never evidenced in a bullet | "are the technologies evidenced, or only listed?" |

These land in `build_digest` / `render_digest`, so they reach the analyzer automatically,
and the analyzer's findings then drive `improve_resume` — the whole chain gets smarter from
one change.

## Non-goals

- **No extra LLM calls.** No verify-then-repair second pass. OpenAI spend is already a live
  concern in this codebase; every rule here is either free (deterministic) or costs only the
  prompt tokens of the standards block.
- **No print-layout enforcement.** Fonts, margins, and colour belong to `resume_pdf.py`.
- **No frontend or schema change.** The digest is internal; findings already surface through
  the existing analysis report UI.
- **`analyze_resume.txt` is not touched.** It is a transcription prompt, and its "change
  nothing, drop nothing" contract is what protects upload fidelity. Standards belong to the
  prompts that *write*, never to the one that *reads*.

## Testing

- A unit test per new metric in `test_resume_metrics.py`, each with a fixture that trips the
  rule and one that does not.
- A test that every writing prompt resolves `{{RESUME_STANDARDS}}` — i.e. the loader
  inlines it and no `{{` token survives.
- A test that the extracted prompt files still carry their data tokens (extends the existing
  table in `test_resume_extraction.py`).
- The existing `test_tailor_structured.py`, `test_tailor_document.py`, and
  `test_resume_rewrite_regression.py` must stay green untouched — they are the contract that
  says the refactor changed the words, not the pipeline.
