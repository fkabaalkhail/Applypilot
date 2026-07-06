"""Rule-based fabricated-number guardrail.

``merge_rewrite`` already makes fabricated employers/dates/titles structurally
impossible, but bullets are reworded freely — the one place an invented metric
can slip in. This flags (never strips) any number in the rewritten text whose
numeric value is not present anywhere in the source resume, so the UI can ask
the user to verify it.
"""
import re

# A number, optionally $-prefixed, optionally followed by a unit/magnitude.
_FIGURE_RE = re.compile(
    r"\$?\d[\d,]*(?:\.\d+)?\s?(?:%|x|k|m|bn?|\+|years?|yrs?|months?|weeks?|days?|hours?|hrs?)?",
    re.IGNORECASE,
)


def _numeric_core(token: str) -> str:
    """The comparable numeric value of a token: '40%'->'40', '$2M'->'2', '1,200'->'1200'."""
    return re.sub(r"[^\d.]", "", token.replace(",", "")).strip(".")


def find_unsupported_figures(source_text: str, rewritten_texts: list[str]) -> list[str]:
    """Figure tokens in ``rewritten_texts`` whose numeric value is absent from source.

    De-duped, first-seen order preserved. Conservative by design: a false
    positive only asks the user to verify a real number, while flagging keeps an
    invented metric from silently reaching a recruiter.
    """
    source_values = {
        _numeric_core(m) for m in _FIGURE_RE.findall(source_text) if _numeric_core(m)
    }
    out: list[str] = []
    seen: set[str] = set()
    for text in rewritten_texts:
        for match in _FIGURE_RE.findall(text or ""):
            token = match.strip()
            core = _numeric_core(token)
            if not core or core in source_values:
                continue
            if token.lower() in seen:
                continue
            seen.add(token.lower())
            out.append(token)
    return out
