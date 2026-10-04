# e2e review tools

Small scripts for the live-page loop: run real postings through the packaged
extension (`test/e2e/run.mjs`), read every write, fix what is wrong, pin what
is right, and check nothing else moved. Run them from `chrome-extension/`.
Results land in `test/e2e/results/` (git-ignored, kept on this machine).

| script | what it does |
| --- | --- |
| `review.cjs <run.json> [id]` | Every field the extension touched, as the extension saw it: category, label, outcome, value, options. Start here. |
| `fails.cjs <run.json> [id]` | Full keys of every failing check and unexpected write, for fixing or pinning. |
| `rundiff.cjs <old.json> <new.json> [id]` | Per page, the fields whose value changed between two runs. |
| `rescore.mjs <run.json> [id]` | Re-score a saved run against the CURRENT pins, no browser. Use after editing pins. |
| `pins-from-run.cjs <run.json> ... > pins.json` | Draft pins from a reviewed run: changed values, plus questions that must stay blank. Review before writing. |
| `write-pins.cjs <cases.mjs> <pins.json> [notes.json]` | Write drafted pins into a case file (cases with no `expect:` yet). |
| `regress.mjs [--only id] [--size 13]` | The whole pinned suite in batches (about 2.5 h headful), then the failing cases. |

`run.mjs --filter` takes substrings of case ids, ATS names, or `=<id>` for one
exact case.
