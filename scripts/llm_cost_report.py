"""What one user action costs us in OpenAI spend.

Two modes:

    python scripts/llm_cost_report.py            # model the cost from the prompts
    python scripts/llm_cost_report.py --logs f   # total real spend from cost log lines

The modelling mode builds the ACTUAL prompts the app sends, same templates,
same truncation caps, same models, against a representative new-grad payload
and prices them with the same table the runtime bills against
(``backend.services.llm_cost.MODEL_PRICES``). That matters for pricing decisions:
edit a prompt and this number moves with it, so the unit economics can't quietly
drift away from what the app really does.

The logs mode reads ``llm_cost op=… usd=…`` lines (from ``vercel logs`` or a
saved file) and aggregates real spend per operation, ground truth, once traffic
exists.

Requires tiktoken for the modelling mode:  pip install tiktoken
"""

import argparse
import os
import re
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.environ.setdefault("OPENAI_API_KEY", "cost-report-only")

from backend.services.llm_cost import price_of  # noqa: E402
from backend.services.openai_service import (  # noqa: E402
    OpenAIService, _load_prompt, _field_model,
)
from backend.services.match_engine import JOB_ANALYSIS_PROMPT, _match_model  # noqa: E402

FLAGSHIP = os.getenv("OPENAI_MODEL", "gpt-4o")

# A representative applicant. Not the biggest possible résumé, not the smallest,
# the point is a number you can multiply by a user count, so it has to look like
# the median user rather than a best case.
SAMPLE = Path(__file__).resolve().parent / "fixtures" / "cost_sample.py"


def _sample():
    """Load the representative payload, kept beside this script so the numbers
    are reproducible run to run."""
    ns: dict = {}
    exec(SAMPLE.read_text(encoding="utf-8"), ns)  # noqa: S102 - local fixture
    return ns


def _tokens(text: str) -> int:
    import tiktoken
    return len(tiktoken.get_encoding("o200k_base").encode(text))


def model_costs() -> None:
    s = _sample()
    resume_text, jd = s["RESUME_TEXT"], s["JOB_DESCRIPTION"]
    resume_json, profile_ctx = s["RESUME_JSON"], s["PROFILE_CONTEXT"]
    short_fields, essay_fields = s["SHORT_FIELDS"], s["ESSAY_FIELDS"]

    rows: list[tuple[str, str, int, int, float]] = []

    def add(label: str, model: str, prompt: str, out: int, extra_in: int = 0) -> float:
        tin = _tokens(prompt) + extra_in
        usd = price_of(model, tin, out)
        rows.append((label, model, tin, out, usd))
        return usd

    # ---- résumé rewrite: tailor_document() = 2 scoring calls + 1 rewrite ----
    print("=" * 78)
    print("ONE RÉSUMÉ REWRITE  (/ai/custom-resume, /api/tailor-resume)")
    print("=" * 78)
    analysis = JOB_ANALYSIS_PROMPT.format(
        job_title="Software Engineer, New Grad", company="Acme Corp",
        resume_text=resume_text[:3000], job_description=jd[:3000],
    )
    tailor = (
        _load_prompt("tailor_resume_structured.txt")
        .replace("{{EMPHASIS}}", "## THIS REQUEST\n\n- Use the job's own words for: "
                                 "Kubernetes, Terraform, gRPC, distributed systems, observability.")
        .replace("{{JOB_DESCRIPTION}}", jd[:3500])
        .replace("{{RESUME_JSON}}", resume_json)
    )
    rewrite = 0.0
    rewrite += add("analyze_job (before score)", _match_model(), analysis, 500)
    rewrite += add("tailor_resume_structured", FLAGSHIP, tailor, _tokens(resume_json) + 250)
    rewrite += add("analyze_job (after score)", _match_model(), analysis, 500)
    _table(rows, rewrite)

    # ---- autofill: one batched call per group -----------------------------
    rows.clear()
    print()
    print("=" * 78)
    print(f"ONE APPLICATION AUTOFILL  (POST /fill), "
          f"{len(short_fields)} factual + {len(essay_fields)} essay")
    print("=" * 78)
    context = "\n\n".join([
        "TODAY'S DATE: 2026-08-10",
        "APPLICANT:\n" + profile_ctx,
        f"RESUME:\n{resume_text[:3000]}",
        f"JOB (Software Engineer, New Grad at Acme Corp):\n{jd[:2000]}",
    ])
    short_qs = {f"q{i}": q for i, q in enumerate(short_fields)}
    essay_qs = {f"e{i}": q for i, q in enumerate(essay_fields)}
    fill = 0.0
    if short_qs:
        fill += add(
            "answer_questions_batch", _field_model(),
            _load_prompt("answer_questions_batch.txt")
            .replace("{{CONTEXT}}", context)
            .replace("{{QUESTIONS}}", OpenAIService._render_questions(short_qs)),
            len(short_qs) * 20 + 40, extra_in=66,
        )
    if essay_qs:
        fill += add(
            "compose_answers_batch", FLAGSHIP,
            _load_prompt("compose_answers_batch.txt")
            .replace("{{CONTEXT}}", context)
            .replace("{{QUESTIONS}}", OpenAIService._render_questions(essay_qs)),
            len(essay_qs) * 200, extra_in=44,
        )
    _table(rows, fill)

    print()
    print("=" * 78)
    print("UNIT ECONOMICS")
    print("=" * 78)
    per_app = rewrite + fill
    print(f"  résumé rewrite ................ ${rewrite:.4f}")
    print(f"  autofill ...................... ${fill:.4f}")
    print(f"  ONE APPLICATION (both) ........ ${per_app:.4f}")
    print()
    print(f"  {'apps/user/month':>18s}  {'COGS/user':>10s}  {'break-even @ $9.99':>19s}")
    for n in (10, 25, 50, 100, 200):
        cogs = n * per_app
        print(f"  {n:>18d}  {'$%.2f' % cogs:>10s}  {'%.0f%% margin' % (100 * (1 - cogs / 9.99)):>19s}")
    print()
    print("  Model mix, change with OPENAI_MODEL / OPENAI_MATCH_MODEL / OPENAI_FIELD_MODEL:")
    print(f"    flagship (rewrite, essays) .. {FLAGSHIP}")
    print(f"    scoring ..................... {_match_model()}")
    print(f"    factual form fields ......... {_field_model()}")


def _table(rows, total: float) -> None:
    for label, model, tin, tout, usd in rows:
        print(f"  {label:32s} {model:14s} {tin:6,} in {tout:6,} out  ${usd:.4f}")
    print(f"  {'TOTAL':32s} {'':14s} {'':6s}    {'':6s}      ${total:.4f}")


LOG_RE = re.compile(
    r"llm_cost op=(?P<op>\S+) model=(?P<model>\S+) in=(?P<in>\d+) "
    r"cached=(?P<cached>\d+) out=(?P<out>\d+) usd=(?P<usd>[\d.]+) user=(?P<user>\S+)"
)


def report_logs(path: str) -> None:
    """Aggregate real spend from captured cost lines."""
    by_op: dict[str, list[float]] = defaultdict(list)
    by_user: dict[str, float] = defaultdict(float)
    tokens_in = tokens_cached = tokens_out = 0

    text = sys.stdin.read() if path == "-" else Path(path).read_text(encoding="utf-8", errors="replace")
    for m in LOG_RE.finditer(text):
        usd = float(m["usd"])
        by_op[m["op"]].append(usd)
        by_user[m["user"]] += usd
        tokens_in += int(m["in"]); tokens_cached += int(m["cached"]); tokens_out += int(m["out"])

    if not by_op:
        print("No llm_cost lines found. Capture them with:  vercel logs --since 24h > spend.log")
        return

    total = sum(sum(v) for v in by_op.values())
    print(f"{'operation':<32s} {'calls':>7s} {'total':>10s} {'avg/call':>10s}")
    for op, vals in sorted(by_op.items(), key=lambda kv: -sum(kv[1])):
        print(f"{op:<32s} {len(vals):>7d} {'$%.4f' % sum(vals):>10s} {'$%.5f' % (sum(vals)/len(vals)):>10s}")
    print(f"{'TOTAL':<32s} {sum(len(v) for v in by_op.values()):>7d} {'$%.4f' % total:>10s}")
    cache_rate = 100 * tokens_cached / tokens_in if tokens_in else 0
    print(f"\ntokens: {tokens_in:,} in ({cache_rate:.0f}% cached), {tokens_out:,} out")

    real_users = {u: v for u, v in by_user.items() if u != "-"}
    if real_users:
        print(f"\ntop spenders ({len(real_users)} users, ${total/len(real_users):.4f} avg):")
        for user, usd in sorted(real_users.items(), key=lambda kv: -kv[1])[:10]:
            print(f"  user {user:<10s} ${usd:.4f}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--logs", metavar="FILE", help="aggregate real spend from cost log lines ('-' for stdin)")
    args = ap.parse_args()
    if args.logs:
        report_logs(args.logs)
    else:
        model_costs()
