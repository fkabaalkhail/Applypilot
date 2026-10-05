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
| `freeze-probe.mjs <case id>` | A page that never finishes: streams the page's inputs and the extension's log, then pauses the frozen page in the debugger and prints the stack (`FREEZE_MS`, `PROFILE`, `LOCK`). |
| `qbank-workable.mjs <accounts> <out.json>` | A Workable question bank from its public GET form endpoint, for `test/qbank.test.ts` (with `QBANK_URL` on a Workable host). |
| `qbank-review.cjs <bank-out.json>` | One line per distinct bank question with every persona's answer. |

`run.mjs --filter` takes substrings of case ids, ATS names, or `=<id>` for one
exact case.

A case with `nextPages: N` goes on past page 1: after each fill the harness
presses the panel's Next page gate, as an applicant reading each page would,
up to N times, and keeps what every page held (`nextPages` in the saved run;
`review.cjs` shows each page under its own heading). Nothing more is risked:
the flow never clicks Submit and every non-GET request stays blocked, so a
Next that saves to the server leaves the page where it was. Pins still read
page 1.
