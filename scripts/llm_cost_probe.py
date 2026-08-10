"""Run the real flows against the real OpenAI API and report what they actually cost.

    python scripts/llm_cost_probe.py              # both flows
    python scripts/llm_cost_probe.py --rewrite    # résumé rewrite only
    python scripts/llm_cost_probe.py --fill       # application autofill only
    python scripts/llm_cost_probe.py --show       # also print what the model answered

This is the ground-truth counterpart to ``llm_cost_report.py``. That one models
cost by counting tokens offline; this one calls the API and reads the billed
``usage`` off the responses, so it catches everything an estimate cannot,
output length the model actually chose, cache hits, retries.

It SPENDS REAL MONEY (a few cents per run) and uses OPENAI_API_KEY from .env.
No database is touched and nothing is persisted.
"""

import argparse
import asyncio
import logging
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from dotenv import load_dotenv  # noqa: E402

load_dotenv(ROOT / ".env")

if not os.getenv("OPENAI_API_KEY"):
    sys.exit("OPENAI_API_KEY not set (looked in .env). Nothing to probe.")

# The endpoint's rate limiter would otherwise count these probe runs against the
# real per-user daily quota.
os.environ["RATE_LIMIT_ENABLED"] = "false"

LOG_RE = re.compile(
    r"llm_cost op=(?P<op>\S+) model=(?P<model>\S+) in=(?P<in>\d+) "
    r"cached=(?P<cached>\d+) out=(?P<out>\d+) usd=(?P<usd>[\d.]+)"
)


class CostCapture(logging.Handler):
    """Collect the cost lines the runtime emits, rather than re-deriving them.

    Reading the same log the deployed app writes is deliberate: if this probe
    computed its own numbers it could agree with itself while disagreeing with
    production."""

    def __init__(self):
        super().__init__(level=logging.INFO)
        self.calls: list[dict] = []

    def emit(self, record):
        m = LOG_RE.search(record.getMessage())
        if m:
            self.calls.append({
                "op": m["op"], "model": m["model"], "in": int(m["in"]),
                "cached": int(m["cached"]), "out": int(m["out"]), "usd": float(m["usd"]),
            })


def _sample():
    ns: dict = {}
    exec((ROOT / "scripts" / "fixtures" / "cost_sample.py").read_text(encoding="utf-8"), ns)  # noqa: S102
    return ns


class _NoRows:
    """Session stand-in. The probe supplies its own résumé and profile, so every
    lookup the endpoint makes should come back empty."""
    def query(self, *a): return self
    def filter(self, *a): return self
    def order_by(self, *a): return self
    def first(self): return None


def _report(title: str, calls: list[dict], show: bool, answers=None) -> float:
    print()
    print("=" * 78)
    print(title)
    print("=" * 78)
    if not calls:
        print("  no LLM calls recorded")
        return 0.0
    print(f"  {'operation':<28s} {'model':<14s} {'in':>7s} {'cached':>7s} {'out':>6s} {'USD':>9s}")
    total = 0.0
    for c in calls:
        total += c["usd"]
        print(f"  {c['op']:<28s} {c['model']:<14s} {c['in']:>7,} {c['cached']:>7,} "
              f"{c['out']:>6,} {'$%.5f' % c['usd']:>9s}")
    tin = sum(c["in"] for c in calls); tout = sum(c["out"] for c in calls)
    tcached = sum(c["cached"] for c in calls)
    print(f"  {'-' * 74}")
    print(f"  {len(calls)} call(s){'':<20s} {'':<14s} {tin:>7,} {tcached:>7,} {tout:>6,} "
          f"{'$%.5f' % total:>9s}")
    if show and answers:
        print()
        for label, value in answers:
            print(f"    {label}\n      -> {value}")
    return total


async def probe_rewrite(cap: CostCapture, show: bool) -> float:
    from backend.schemas.resume_document import ResumeDocument
    from backend.services.resume_tailor import tailor_document
    import json

    s = _sample()
    doc = ResumeDocument(**json.loads(s["RESUME_JSON"]))
    start = len(cap.calls)
    result = await tailor_document(
        db=None,
        original_document=doc,
        job_title="Software Engineer, New Grad",
        company="Acme Corp",
        job_description=s["JOB_DESCRIPTION"],
    )
    answers = [
        ("ATS score before → after",
         f"{result.before.ats_score} → {result.after.ats_score}"),
        ("match score before → after",
         f"{result.before.overall_score} → {result.after.overall_score}"),
        ("changes", f"{len(result.changes)} edits, {len(result.gaps)} honest gaps"),
    ]
    return _report("RÉSUMÉ REWRITE, real API call", cap.calls[start:], show, answers)


async def probe_fill(cap: CostCapture, show: bool) -> float:
    from backend.routers import fill

    s = _sample()

    def field(i: int, rendered: str) -> fill.FormField:
        """Undo _render_question so the fixture's rendered text becomes a field."""
        label, *rest = rendered.split("\n")
        f = fill.FormField(id=f"f{i}", label=label)
        for line in rest:
            if line.startswith("Field type: "):
                f.inputType = line.removeprefix("Field type: ")
            elif line.startswith("Options: "):
                f.options = [o.strip() for o in line.removeprefix("Options: ").split(",")]
            elif line.startswith("Help text: "):
                f.helpText = line.removeprefix("Help text: ")
        if f.inputType == "textarea":
            f.type = "textarea"
        return f

    fields = [field(i, q) for i, q in enumerate(s["SHORT_FIELDS"] + s["ESSAY_FIELDS"])]
    request = fill.FillRequest(
        fields=fields,
        resumeText=s["RESUME_TEXT"],
        jobDescription=s["JOB_DESCRIPTION"],
        jobTitle="Software Engineer, New Grad",
        company="Acme Corp",
        profile=fill.ApplicantProfile(
            firstName="Wissam", lastName="Elmasry", email="wissam@example.com",
            phone="(416) 555-0142", addressCity="Toronto", addressState="ON",
            postalCode="M5S 1A1", country="Canada",
            currentTitle="Software Engineering Intern", currentCompany="Shopify",
            workAuthorization="Canadian citizen", requiresSponsorship="No",
            salaryExpectation="110000", willingToRelocate="Yes",
            workPreference="Hybrid", noticePeriod="2 weeks",
            earliestStartDate="2026-06-01", yearsOfExperience="2",
            driversLicense="Yes", languages="English, French, Arabic",
            linkedin="linkedin.com/in/example", github="github.com/example",
            skills=["Python", "TypeScript", "Go", "FastAPI", "React", "PostgreSQL", "Docker", "AWS"],
            experience=["Software Engineering Intern at Shopify (May 2025 - Aug 2025)",
                        "Backend Developer Intern at Wealthsimple (Sep 2024 - Dec 2024)"],
            education=["BSc Computer Science, University of Toronto, Expected May 2026"],
        ),
    )

    start = len(cap.calls)
    resp = await fill.fill_form(request, user_id=0, db=_NoRows())
    answers = [(a.label, f"{a.answer}   [{a.fillPass}]") for a in resp.answers]
    answers += [(d.label, f"(blank: {d.reason})") for d in resp.dropped]

    total = _report(
        f"APPLICATION AUTOFILL, real API call "
        f"({len(s['SHORT_FIELDS'])} factual + {len(s['ESSAY_FIELDS'])} essay)",
        cap.calls[start:], show, answers,
    )
    ai = [a for a in resp.answers if a.fillPass == "ai"]
    pre = [a for a in resp.answers if a.fillPass != "ai"]
    # A field can be dropped by an early pass and still answered by a later one
    # (a rule answer the widget couldn't take, then picked correctly from the
    # options by the AI), so "blank" is the fields with no answer at all, not
    # the length of `dropped`, which counts refused candidates rather than fields.
    answered = {a.id for a in resp.answers}
    blank = [f for f in fields if f.id not in answered]
    print(f"\n  filled {len(answered)}/{len(fields)} fields "
          f"({len(pre)} free via rules/derived facts, {len(ai)} from the AI); "
          f"{len(blank)} left blank, {len(resp.dropped)} candidate(s) refused by the gate")
    if resp.errors:
        print(f"  errors: {resp.errors}")
    return total


async def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--rewrite", action="store_true", help="résumé rewrite only")
    ap.add_argument("--fill", action="store_true", help="application autofill only")
    ap.add_argument("--show", action="store_true", help="print the generated answers too")
    args = ap.parse_args()
    both = not (args.rewrite or args.fill)

    cap = CostCapture()
    logging.getLogger("backend.services.llm_cost").addHandler(cap)
    logging.getLogger("backend.services.llm_cost").setLevel(logging.INFO)

    print(f"model mix: OPENAI_MODEL={os.getenv('OPENAI_MODEL', 'gpt-4o')} "
          f"MATCH={os.getenv('OPENAI_MATCH_MODEL', 'gpt-4o-mini')} "
          f"FIELD={os.getenv('OPENAI_FIELD_MODEL', 'gpt-4o-mini')}")

    rewrite = await probe_rewrite(cap, args.show) if (both or args.rewrite) else 0.0
    autofill = await probe_fill(cap, args.show) if (both or args.fill) else 0.0

    if both:
        print()
        print("=" * 78)
        print("ONE APPLICATION")
        print("=" * 78)
        per_app = rewrite + autofill
        print(f"  résumé rewrite ....... ${rewrite:.5f}")
        print(f"  autofill ............. ${autofill:.5f}")
        print(f"  TOTAL ................ ${per_app:.5f}")
        print()
        print(f"  {'apps/user/mo':>14s}  {'COGS/user':>10s}")
        for n in (10, 25, 50, 100):
            print(f"  {n:>14d}  {'$%.2f' % (n * per_app):>10s}")


if __name__ == "__main__":
    asyncio.run(main())
