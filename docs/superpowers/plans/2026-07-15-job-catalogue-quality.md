# Job Catalogue Quality Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reliable job descriptions at ingest, accurate token-based city filtering over structured locations, crisp logos via a guarded provider cascade, and a Jobright-style detail view with resume-matched qualification tags.

**Architecture:** A new pure `location_parser` service feeds structured location columns written by every ingest path and consumed by a rewritten `/jobs` filter. The ATS scraper captures descriptions from the board APIs it already calls; a bounded cron backfill drains the backlog. The detail view upgrades its instant client parse with a cached `gpt-4o-mini` structured parse and matches skill tags against the user's primary resume deterministically.

**Tech Stack:** FastAPI + SQLAlchemy (Postgres prod / SQLite tests), React + TypeScript + Vitest, httpx, OpenAI (`gpt-4o-mini`, `json_mode`).

**Spec:** `docs/superpowers/specs/2026-07-15-job-catalogue-quality-design.md`

## Global Constraints

- Never touch the match-score sweep / `match_notifier` (cost-sensitive).
- New AI usage only: `structure-description` on `gpt-4o-mini` + `json_mode`, cached per job in `description_sections`.
- All SQL predicates must work on BOTH SQLite (tests) and Postgres (prod) — token matching uses plain `LIKE` on a pipe-delimited folded text column, never JSON operators.
- Migrations are idempotent startup migrations following `backend/migrations/add_resume_content_updated.py`'s pattern.
- Backend tests enter the app lifespan and migrate the real dev Neon DB — that is expected (memory: pytest-runs-real-neon-migrations). Run pytest from an isolated CWD with `.env` copied if the checkout is shared.
- Pre-existing failing tests (do NOT count as regressions, verify baseline in Task 0): backend `test_match_notifier`/save_batch area, `test_apply_flow_resume_version_selection` (flaky); frontend `JobDetailView`, `job-detail-inline-panel`, `resume.property`.
- Commit after every task, by explicit path (shared checkout rules).
- `MAX_DESC_LEN` becomes 10000.
- Filter tags travel frontend→backend joined by `";"`; backend splits on `";"` when present, else `","` (legacy).

---

### Task 0: Record test baselines

**Files:** none (read-only)

- [ ] **Step 0.1:** Run backend suite, save output:
  `cd C:\Users\elmas\Desktop\Tailrd && python -m pytest backend/tests -x -q --ignore=backend/tests/test_apply_properties.py 2>&1 | tail -30`
  (If collection is slow, run at least: `python -m pytest backend/tests/test_job_filters.py backend/tests/test_city_filter_properties.py backend/tests/test_jobs_properties.py -q`.)
  Record failures as baseline.
- [ ] **Step 0.2:** Run frontend suite:
  `cd frontend && node node_modules/vitest/vitest.mjs run 2>&1 | tail -20`
  Record failures as baseline (JobDetailView / inline-panel / resume.property expected).

---

### Task 1: `location_parser` service

**Files:**
- Create: `backend/services/location_parser.py`
- Test: `backend/tests/test_location_parser.py`

**Interfaces (Produces):**
- `@dataclass ParsedLocation(city: str = "", region: str = "", region_name: str = "", country: str = "")`
- `fold(value: str) -> str` — NFKD diacritic-fold, lowercase, collapse whitespace.
- `parse_locations(raw: str) -> list[ParsedLocation]`
- `location_display(locations: list[ParsedLocation]) -> str` — `"Ottawa, ON, Canada"` / `"Ottawa, ON, Canada · +2 more"`.
- `location_search_blob(locations: list[ParsedLocation]) -> str` — `"|ottawa|on|ontario|canada||krakow|poland|"`.
- `location_tag_tokens(tag: str) -> list[str]` — tokens a filter tag must ALL match.
- `location_fields(raw: str) -> dict` — `{"city","region","locations_json","location_search"}` ready for `ScrapedJob(**…)`.

- [ ] **Step 1.1: Write the failing tests** — `backend/tests/test_location_parser.py`:

```python
"""Location parser tests seeded with real prod formats (sampled 2026-07-15)."""

from backend.services.location_parser import (
    ParsedLocation,
    fold,
    location_display,
    location_fields,
    location_search_blob,
    location_tag_tokens,
    parse_locations,
)


def first(raw):
    locs = parse_locations(raw)
    assert locs, f"expected at least one location for {raw!r}"
    return locs[0]


def test_fold_strips_diacritics_and_case():
    assert fold("Kraków") == "krakow"
    assert fold("  Montréal ") == "montreal"
    assert fold("OTTAWA") == "ottawa"


def test_city_region_country_triple():
    loc = first("Ottawa, Ontario, Canada")
    assert (loc.city, loc.region, loc.country) == ("Ottawa", "ON", "Canada")
    assert loc.region_name == "Ontario"


def test_city_code_country_code():
    loc = first("Ottawa, ON, CA")
    assert (loc.city, loc.region, loc.country) == ("Ottawa", "ON", "Canada")


def test_city_code_can():
    loc = first("Ottawa, ON, CAN")
    assert loc.country == "Canada"


def test_us_city_state():
    loc = first("Hawthorne, CA")
    assert (loc.city, loc.region, loc.country) == ("Hawthorne", "CA", "United States")


def test_postal_code_dropped():
    loc = first("Dorval, QC, CAN, H4S 1Y9")
    assert (loc.city, loc.region, loc.country) == ("Dorval", "QC", "Canada")


def test_no_comma_space_run():
    loc = first("CA   ON Ottawa")
    assert loc.city == "Ottawa"
    assert loc.region == "ON"
    assert loc.country == "Canada"


def test_parenthetical_noise_dropped():
    assert first("Ottawa (Downtown) ON").city == "Ottawa"
    assert first("Canada - Ottawa (Bill Leathem)").city == "Ottawa"
    assert first("Ottawa (2 Locations)").city == "Ottawa"


def test_plus_more_suffix_dropped():
    loc = first("Ottawa, ON, Canada (+2 more)")
    assert loc.city == "Ottawa"


def test_metro_area():
    assert first("Greater Ottawa Metropolitan Area").city == "Ottawa"
    assert first("Greater Toronto Area").city == "Toronto"


def test_multi_location_semicolons():
    locs = parse_locations("Ottawa,Ontario,Canada; Kraków,Kraków,Poland; Łódź,Łódź,Poland")
    assert [l.city for l in locs] == ["Ottawa", "Kraków", "Łódź"]
    assert locs[0].country == "Canada"
    assert locs[1].country == "Poland"


def test_junk_title_contamination_keeps_known_city():
    loc = first("Ottawa (Downtown) Platform DevOps Analyst (Cloud Databases) Recent Graduate ON")
    assert loc.city == "Ottawa"
    assert loc.region == "ON"


def test_remote_us():
    loc = first("Remote - US")
    assert loc.city == "Remote"
    assert loc.country == "United States"


def test_country_only():
    loc = first("Canada")
    assert loc.city == ""
    assert loc.country == "Canada"


def test_display_single_and_multi():
    single = parse_locations("Ottawa, Ontario, Canada")
    assert location_display(single) == "Ottawa, ON, Canada"
    multi = parse_locations("Ottawa,Ontario,Canada; Kraków,Kraków,Poland; Łódź,Łódź,Poland")
    assert location_display(multi) == "Ottawa, ON, Canada · +2 more"
    assert location_display([]) == ""


def test_search_blob_token_boundaries():
    blob = location_search_blob(parse_locations("Ottawa, Ontario, Canada"))
    assert "|ottawa|" in blob
    assert "|on|" in blob
    assert "|ontario|" in blob
    assert "|canada|" in blob
    # Toronto must NOT be findable in an Ottawa blob, even as a substring.
    assert "|toronto|" not in blob


def test_search_blob_folds_diacritics():
    blob = location_search_blob(parse_locations("Kraków, Poland"))
    assert "|krakow|" in blob


def test_tag_tokens_plain_city():
    assert location_tag_tokens("Ottawa") == ["ottawa"]


def test_tag_tokens_city_with_region():
    assert location_tag_tokens("Ottawa, ON") == ["ottawa", "on"]
    assert location_tag_tokens("Ottawa, Ontario") == ["ottawa", "on"]


def test_tag_tokens_unparseable_falls_back_to_fold():
    assert location_tag_tokens("kanata") == ["kanata"]


def test_location_fields_shape():
    fields = location_fields("Ottawa, ON, CA")
    assert fields["city"] == "ottawa"
    assert fields["region"] == "ON"
    assert fields["locations_json"][0]["city"] == "Ottawa"
    assert "|ottawa|" in fields["location_search"]


def test_location_fields_empty():
    fields = location_fields("")
    assert fields == {"city": "", "region": "", "locations_json": [], "location_search": ""}
```

- [ ] **Step 1.2:** Run: `python -m pytest backend/tests/test_location_parser.py -q` → FAIL (module missing).

- [ ] **Step 1.3: Implement** `backend/services/location_parser.py`:

```python
"""
Structured parsing of scraped job location strings.

Prod locations are free text in wildly inconsistent formats ("Ottawa, ON, CA",
"CA   ON Ottawa", "Canada - Ottawa (Bill Leathem)", semicolon-joined
multi-city blobs, "(+2 more)" suffixes, even leaked job titles). These pure
functions normalize them into ParsedLocation records that power exact
token-boundary city filtering (location_search) and clean display strings.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import asdict, dataclass

CA_PROVINCES: dict[str, str] = {
    "ON": "Ontario", "QC": "Quebec", "BC": "British Columbia", "AB": "Alberta",
    "MB": "Manitoba", "SK": "Saskatchewan", "NS": "Nova Scotia",
    "NB": "New Brunswick", "NL": "Newfoundland and Labrador",
    "PE": "Prince Edward Island", "NT": "Northwest Territories",
    "YT": "Yukon", "NU": "Nunavut",
}

US_STATES: dict[str, str] = {
    "AL": "Alabama", "AK": "Alaska", "AZ": "Arizona", "AR": "Arkansas",
    "CA": "California", "CO": "Colorado", "CT": "Connecticut", "DE": "Delaware",
    "FL": "Florida", "GA": "Georgia", "HI": "Hawaii", "ID": "Idaho",
    "IL": "Illinois", "IN": "Indiana", "IA": "Iowa", "KS": "Kansas",
    "KY": "Kentucky", "LA": "Louisiana", "ME": "Maine", "MD": "Maryland",
    "MA": "Massachusetts", "MI": "Michigan", "MN": "Minnesota",
    "MS": "Mississippi", "MO": "Missouri", "MT": "Montana", "NE": "Nebraska",
    "NV": "Nevada", "NH": "New Hampshire", "NJ": "New Jersey",
    "NM": "New Mexico", "NY": "New York", "NC": "North Carolina",
    "ND": "North Dakota", "OH": "Ohio", "OK": "Oklahoma", "OR": "Oregon",
    "PA": "Pennsylvania", "RI": "Rhode Island", "SC": "South Carolina",
    "SD": "South Dakota", "TN": "Tennessee", "TX": "Texas", "UT": "Utah",
    "VT": "Vermont", "VA": "Virginia", "WA": "Washington",
    "WV": "West Virginia", "WI": "Wisconsin", "WY": "Wyoming",
    "DC": "District of Columbia",
}

_REGION_BY_NAME = {name.lower(): code for code, name in CA_PROVINCES.items()}
_REGION_BY_NAME.update({name.lower(): code for code, name in US_STATES.items()})

_COUNTRY_ALIASES = {
    "canada": "Canada", "can": "Canada",
    "united states": "United States", "usa": "United States",
    "us": "United States", "u.s.": "United States", "u.s.a.": "United States",
    "united states of america": "United States",
}

# Cities we can rescue from comma-less contaminated strings (titles leaked
# into the location field). Mirrors the scraper's NA city vocabulary.
KNOWN_CITIES = {
    "toronto", "vancouver", "montreal", "ottawa", "calgary", "edmonton",
    "winnipeg", "quebec city", "hamilton", "kitchener", "waterloo",
    "mississauga", "brampton", "markham", "london", "victoria", "halifax",
    "burnaby", "richmond", "gatineau", "kanata", "scarborough", "north york",
    "etobicoke", "vaughan", "richmond hill", "oakville", "burlington",
    "guelph", "saskatoon", "regina", "fredericton", "moncton", "kelowna",
    "windsor", "laval", "longueuil", "sherbrooke", "barrie",
    "new york", "san francisco", "los angeles", "chicago", "seattle",
    "austin", "boston", "denver", "atlanta", "dallas", "houston", "miami",
    "philadelphia", "phoenix", "san diego", "san jose", "portland",
    "minneapolis", "detroit", "pittsburgh", "raleigh", "charlotte",
    "nashville", "salt lake city", "washington", "mountain view",
    "palo alto", "sunnyvale", "cupertino", "menlo park", "redmond",
    "bellevue", "irvine", "santa monica", "brooklyn", "manhattan",
}

_CA_POSTAL = re.compile(r"^[A-Za-z]\d[A-Za-z]\s?\d[A-Za-z]\d$")
_US_ZIP = re.compile(r"^\d{5}(-\d{4})?$")
_PLUS_MORE = re.compile(r"\(\s*\+?\d+\s*more\s*\)", re.IGNORECASE)
_PARENTHETICAL = re.compile(r"\([^)]*\)")
_METRO = re.compile(
    r"^(?:greater\s+)?(.+?)\s+(?:metropolitan\s+area|metro\s+area|area)$",
    re.IGNORECASE,
)
_NOISE_TOKENS = {
    "downtown", "hybrid", "onsite", "on-site", "flexible", "multiple locations",
    "various", "n/a", "tbd", "hq", "headquarters", "office", "locations",
}


@dataclass
class ParsedLocation:
    city: str = ""
    region: str = ""        # 2-letter code when known (ON, CA, NY, …)
    region_name: str = ""   # full name when known (Ontario, California, …)
    country: str = ""       # "Canada" / "United States" / other proper name


def fold(value: str) -> str:
    """Diacritic-fold + lowercase + collapse whitespace, for matching."""
    if not value:
        return ""
    decomposed = unicodedata.normalize("NFKD", value)
    ascii_ish = "".join(ch for ch in decomposed if not unicodedata.combining(ch))
    # Polish ł does not decompose to l via NFKD; map the stragglers manually.
    ascii_ish = ascii_ish.replace("ł", "l").replace("Ł", "L")
    ascii_ish = ascii_ish.replace("ø", "o").replace("Ø", "O")
    ascii_ish = ascii_ish.replace("æ", "ae").replace("Æ", "AE")
    ascii_ish = ascii_ish.replace("ß", "ss").replace("đ", "d").replace("Đ", "D")
    return re.sub(r"\s+", " ", ascii_ish).strip().lower()


def _titleize(value: str) -> str:
    """Display-case a folded/raw city token, preserving already-cased input."""
    value = value.strip()
    if not value:
        return ""
    if value != value.lower() and value != value.upper():
        return value  # already mixed case, keep as-is (e.g. "Kraków")
    return " ".join(w.capitalize() for w in value.split(" "))


def _classify_token(token: str, loc: ParsedLocation) -> None:
    """Assign one comma-separated token to city/region/country on a ParsedLocation."""
    stripped = token.strip(" .")
    if not stripped:
        return
    folded = fold(stripped)
    if folded in _NOISE_TOKENS or _CA_POSTAL.match(stripped) or _US_ZIP.match(stripped):
        return

    upper = stripped.upper()
    is_region_code = upper in CA_PROVINCES or upper in US_STATES

    # Country aliases. Note _COUNTRY_ALIASES deliberately has no bare "ca"
    # key: "CA" is claimed by the region branch (California) and a trailing
    # "…, ON, CA" still lands on Canada via _finish()'s region inference.
    if folded in _COUNTRY_ALIASES:
        if not loc.country:
            loc.country = _COUNTRY_ALIASES[folded]
        return

    if is_region_code and not loc.region:
        loc.region = upper
        loc.region_name = CA_PROVINCES.get(upper) or US_STATES.get(upper, "")
        return

    if folded in _REGION_BY_NAME and not loc.region:
        code = _REGION_BY_NAME[folded]
        loc.region = code
        loc.region_name = CA_PROVINCES.get(code) or US_STATES.get(code, "")
        return

    if folded == "remote":
        if not loc.city:
            loc.city = "Remote"
        return

    if loc.city and folded == fold(loc.city):
        return  # "Kraków, Kraków, Poland" — duplicated city token

    if not loc.city:
        loc.city = _titleize(stripped)
    elif not loc.country and not is_region_code and len(stripped) > 3:
        # An unclassified trailing word after city+region is usually a country
        # ("Kraków, Kraków, Poland" leaves "Poland" here).
        loc.country = _titleize(stripped)


def _finish(loc: ParsedLocation) -> ParsedLocation:
    if not loc.country and loc.region:
        loc.country = "Canada" if loc.region in CA_PROVINCES else "United States"
    # Same-name duplication ("Kraków, Kraków, Poland") — region slot may have
    # swallowed the duplicate city name; nothing to fix, region stays empty
    # for non-NA locations.
    return loc


def _parse_segment(segment: str) -> ParsedLocation | None:
    segment = _PLUS_MORE.sub(" ", segment)
    segment = _PARENTHETICAL.sub(" ", segment)
    segment = segment.replace(" - ", ", ").replace(" – ", ", ")
    segment = re.sub(r"\s+", " ", segment).strip(" ,;-")
    if not segment:
        return None

    metro = _METRO.match(segment)
    if metro:
        loc = ParsedLocation(city=_titleize(metro.group(1)))
        return _finish(loc)

    if "," in segment:
        loc = ParsedLocation()
        for token in segment.split(","):
            _classify_token(token, loc)
        if not loc.city and not loc.region and not loc.country:
            return None
        return _finish(loc)

    words = [w for w in segment.split(" ") if w.strip()]
    if len(words) > 4:
        # Likely contaminated (a title leaked into the field). Rescue a
        # known city + any region code; drop the rest.
        loc = ParsedLocation()
        folded_seg = fold(segment)
        for city in sorted(KNOWN_CITIES, key=len, reverse=True):
            if re.search(rf"(?:^|[^a-z]){re.escape(city)}(?:[^a-z]|$)", folded_seg):
                loc.city = _titleize(city)
                break
        for word in words:
            upper = word.strip(" .").upper()
            if (upper in CA_PROVINCES or upper in US_STATES) and not loc.region:
                loc.region = upper
                loc.region_name = CA_PROVINCES.get(upper) or US_STATES.get(upper, "")
        if not loc.city and not loc.region:
            return None
        return _finish(loc)

    # Short comma-less segment ("CA ON Ottawa", "New York", "Remote"):
    # classify word-wise. A bare "CA" with a real province elsewhere in the
    # segment is the country (Canada), not California.
    loc = ParsedLocation()
    rest: list[str] = []
    for word in words:
        upper = word.strip(" .").upper()
        folded_word = fold(word)
        if folded_word in _NOISE_TOKENS or _CA_POSTAL.match(word) or _US_ZIP.match(word):
            continue
        if upper == "CA" and any(
            w.strip(" .").upper() in CA_PROVINCES for w in words if w is not word
        ):
            loc.country = "Canada"
        elif (upper in CA_PROVINCES or upper in US_STATES) and not loc.region:
            loc.region = upper
            loc.region_name = CA_PROVINCES.get(upper) or US_STATES.get(upper, "")
        elif folded_word in _COUNTRY_ALIASES and not loc.country:
            loc.country = _COUNTRY_ALIASES[folded_word]
        elif folded_word == "remote" and not rest:
            loc.city = "Remote"
        else:
            rest.append(word)
    if rest:
        loc.city = _titleize(" ".join(rest))
    if not loc.city and not loc.region and not loc.country:
        return None
    return _finish(loc)


def parse_locations(raw: str) -> list[ParsedLocation]:
    """Parse a raw scraped location string into structured locations."""
    if not raw or not raw.strip():
        return []
    segments = re.split(r"[;\n•]+", raw)
    out: list[ParsedLocation] = []
    seen: set[tuple[str, str, str]] = set()
    for segment in segments:
        loc = _parse_segment(segment)
        if not loc:
            continue
        key = (fold(loc.city), loc.region, fold(loc.country))
        if key in seen:
            continue
        seen.add(key)
        out.append(loc)
    return out


def location_display(locations: list[ParsedLocation]) -> str:
    """Human display: 'Ottawa, ON, Canada' or 'Ottawa, ON, Canada · +2 more'."""
    if not locations:
        return ""
    head = locations[0]
    parts = [p for p in (head.city, head.region or head.region_name, head.country) if p]
    label = ", ".join(parts)
    extra = len(locations) - 1
    return f"{label} · +{extra} more" if extra > 0 else label


def location_search_blob(locations: list[ParsedLocation]) -> str:
    """Pipe-delimited folded tokens for exact token-boundary LIKE matching."""
    chunks: list[str] = []
    for loc in locations:
        tokens: list[str] = []
        for value in (loc.city, loc.region, loc.region_name, loc.country):
            folded = fold(value)
            if folded and folded not in tokens:
                tokens.append(folded)
        if tokens:
            chunks.append("|" + "|".join(tokens) + "|")
    return "".join(chunks)


def location_tag_tokens(tag: str) -> list[str]:
    """Tokens a user filter tag must ALL match ('Ottawa, ON' → city + region)."""
    tag = (tag or "").strip()
    if not tag:
        return []
    locs = parse_locations(tag)
    if not locs or not locs[0].city:
        folded = fold(tag)
        return [folded] if folded else []
    tokens = [fold(locs[0].city)]
    if locs[0].region:
        tokens.append(fold(locs[0].region))
    return [t for t in tokens if t]


def location_fields(raw: str) -> dict:
    """Column values for ScrapedJob(**fields) — shared by every ingest path."""
    locs = parse_locations(raw or "")
    if not locs:
        return {"city": "", "region": "", "locations_json": [], "location_search": ""}
    return {
        "city": fold(locs[0].city),
        "region": locs[0].region,
        "locations_json": [asdict(l) for l in locs],
        "location_search": location_search_blob(locs),
    }
```

- [ ] **Step 1.4:** Run: `python -m pytest backend/tests/test_location_parser.py -q` → ALL PASS. Iterate on the parser (not the tests) until green — the tests encode real prod strings.
- [ ] **Step 1.5:** Commit:
  `git add backend/services/location_parser.py backend/tests/test_location_parser.py && git commit -m "feat(jobs): location parser for structured city/region/country"`

---

### Task 2: Schema — new columns + migration + API schema

**Files:**
- Create: `backend/migrations/add_job_catalogue_fields.py`
- Modify: `backend/db/models.py` (ScrapedJob, after the `company_url` column)
- Modify: `backend/main.py` (import + call the migration where the others run)
- Modify: `backend/schemas/jobs.py` (ScrapedJobOut)
- Test: `backend/tests/test_job_catalogue_migration.py`

**Interfaces (Produces):** columns `scraped_jobs.city TEXT ''`, `region TEXT ''`, `locations_json JSON`, `location_search TEXT ''`, `desc_fetch_attempts INTEGER 0`, `description_sections JSON NULL`; `ScrapedJobOut.locations_json: list = []`, `ScrapedJobOut.city: str = ""`, `ScrapedJobOut.region: str = ""`.

- [ ] **Step 2.1: Failing test** — `backend/tests/test_job_catalogue_migration.py`:

```python
from sqlalchemy import inspect

from backend.db.database import engine
from backend.migrations.add_job_catalogue_fields import run_migration


def test_migration_adds_columns_idempotently():
    run_migration()
    run_migration()  # second run must be a no-op
    cols = {c["name"] for c in inspect(engine).get_columns("scraped_jobs")}
    assert {"city", "region", "locations_json", "location_search",
            "desc_fetch_attempts", "description_sections"} <= cols
```

- [ ] **Step 2.2:** Run: `python -m pytest backend/tests/test_job_catalogue_migration.py -q` → FAIL (module missing).
- [ ] **Step 2.3: Implement migration** `backend/migrations/add_job_catalogue_fields.py`:

```python
"""
Migration: structured location + description-pipeline columns on scraped_jobs.

city/region/locations_json/location_search power exact token-boundary city
filtering (see services/location_parser.py). desc_fetch_attempts caps the
backfill cron's retries per job. description_sections caches the structured
(gpt-4o-mini) parse of the description for the detail view.

Idempotent: skips columns that already exist. Runs on app startup.
"""

import logging

from sqlalchemy import inspect, text

from backend.db.database import engine

logger = logging.getLogger(__name__)

_COLUMNS = {
    "city": "VARCHAR DEFAULT ''",
    "region": "VARCHAR DEFAULT ''",
    "locations_json": "JSON",
    "location_search": "TEXT DEFAULT ''",
    "desc_fetch_attempts": "INTEGER DEFAULT 0",
    "description_sections": "JSON",
}


def run_migration() -> None:
    inspector = inspect(engine)
    if "scraped_jobs" not in inspector.get_table_names():
        logger.info("Job catalogue migration skipped: scraped_jobs missing.")
        return
    existing = {col["name"] for col in inspector.get_columns("scraped_jobs")}
    with engine.begin() as conn:
        for name, ddl in _COLUMNS.items():
            if name in existing:
                continue
            conn.execute(text(f"ALTER TABLE scraped_jobs ADD COLUMN {name} {ddl}"))
            logger.info("Added scraped_jobs.%s", name)
```

- [ ] **Step 2.4: Model columns** — in `backend/db/models.py`, directly after `company_url = Column(...)` in ScrapedJob add:

```python
    # Structured location (services/location_parser.py) + description pipeline
    city = Column(String, default="")            # folded primary city ("ottawa")
    region = Column(String, default="")          # 2-letter code ("ON")
    locations_json = Column(JSON, default=list)  # [{city,region,region_name,country}]
    location_search = Column(Text, default="")   # "|ottawa|on|ontario|canada|"
    desc_fetch_attempts = Column(Integer, default=0)
    description_sections = Column(JSON, nullable=True)
```

(Confirm `Text` is already imported in models.py; add to the import if not.)

- [ ] **Step 2.5: Wire migration into startup** — `backend/main.py`: add
  `from backend.migrations.add_job_catalogue_fields import run_migration as run_job_catalogue_migration`
  next to the other imports, and call `run_job_catalogue_migration()` where the other `run_*_migration()` calls run (same order block).
- [ ] **Step 2.6: API schema** — `backend/schemas/jobs.py` ScrapedJobOut, after `company_url`:

```python
    city: str = ""
    region: str = ""
    locations_json: list = []
```

  (Do NOT expose `description_sections`/`location_search`/`desc_fetch_attempts` in list payloads.)
- [ ] **Step 2.7:** Run: `python -m pytest backend/tests/test_job_catalogue_migration.py backend/tests/test_jobs_properties.py -q` → PASS.
- [ ] **Step 2.8:** Commit:
  `git add backend/migrations/add_job_catalogue_fields.py backend/db/models.py backend/main.py backend/schemas/jobs.py backend/tests/test_job_catalogue_migration.py && git commit -m "feat(jobs): structured location + description pipeline columns"`

---

### Task 3: Ingest paths write location fields; kill icon.horse guesses

**Files:**
- Modify: `backend/routers/jobs.py` (`create_job` ~line 190, `ingest_batch` ~line 260, `fix_empty_companies` ~line 825)
- Modify: `backend/routers/github_sources.py` (`cron_ats` ~line 216, and the `icon.horse` write at ~line 334)
- Modify: `backend/services/aggregator.py` (`_classify_and_store` ~line 530)
- Test: `backend/tests/test_job_ingest_locations.py`

**Interfaces (Consumes):** `location_fields(raw) -> dict` from Task 1; `resolve_logo(company, company_url=None) -> (logo_url, domain)` (existing).

- [ ] **Step 3.1: Failing test** — `backend/tests/test_job_ingest_locations.py`. Follow the existing client/db fixture pattern from `backend/tests/test_jobs_properties.py` (TestClient + cron-secret headers used by `ingest-batch` tests — copy its fixture usage exactly):

```python
"""Ingest paths must populate structured location fields and never guess
icon.horse domains."""

import os

from fastapi.testclient import TestClient


def test_ingest_batch_populates_location_fields(client: TestClient, db_session):
    payload = {"jobs": [{
        "title": "Software Intern",
        "company": "Kinaxis",
        "location": "Ottawa, ON, CA",
        "url": "https://example.com/jobs/ottawa-1",
        "source_platform": "linkedin",
        "work_type": "onsite",
        "country": "CA",
        "experience_level": "internship",
    }]}
    res = client.post(
        "/jobs/ingest-batch",
        json=payload,
        headers={"x-cron-secret": os.environ.get("CRON_SECRET", "test-cron-secret")},
    )
    assert res.status_code == 200
    from backend.db.models import ScrapedJob
    row = db_session.query(ScrapedJob).filter(ScrapedJob.url == "https://example.com/jobs/ottawa-1").one()
    assert row.city == "ottawa"
    assert row.region == "ON"
    assert "|ottawa|" in row.location_search
    assert "icon.horse" not in (row.company_logo or "")
```

  (Adapt fixture names/secret to whatever `test_jobs_properties.py` actually uses — read it first; if it defines a helper for the cron secret, reuse it.)
- [ ] **Step 3.2:** Run → FAIL (city column empty / icon.horse present).
- [ ] **Step 3.3: Implement.**
  - Top of `backend/routers/jobs.py`: `from backend.services.location_parser import location_fields` and `from backend.services.logo_resolver import resolve_logo`.
  - `ingest_batch`: replace the `cleaned_company = ...` + `company_logo=f"https://icon.horse/..."` pair with:

```python
        resolved_logo, resolved_domain = resolve_logo(job.company)
        to_insert.append(
            ScrapedJob(
                title=job.title,
                company=job.company,
                location=job.location,
                url=url,
                description="",
                source_platform=job.source_platform,
                posted_date=posted_date,
                easy_apply=0,
                work_type=job.work_type,
                role_category=classify_role(job.title),
                country=job.country,
                experience_level=job.experience_level,
                company_logo=resolved_logo,
                company_domain=resolved_domain,
                **location_fields(job.location),
            )
        )
```

  - `create_job`: same replacement (`resolve_logo(company)` + `**location_fields(location)`), drop the local `import re` + `cleaned_company` lines.
  - `fix_empty_companies` (~line 825): replace the icon.horse write with `job.company_logo, job.company_domain = resolve_logo(company_name)`.
  - `github_sources.py` `cron_ats` (~line 216): add `**location_fields(job.location)` to the `ScrapedJob(...)` constructor. Fix the other `icon.horse` write around line 334 the same way as above (use `resolve_logo`).
  - `aggregator.py` `_classify_and_store` (~line 530): add `**location_fields(job.location)` to its `ScrapedJob(...)` constructor (import at top: `from backend.services.location_parser import location_fields`).
- [ ] **Step 3.4:** Run: `python -m pytest backend/tests/test_job_ingest_locations.py backend/tests/test_jobs_properties.py backend/tests/test_aggregator_properties.py backend/tests/test_cron_ats_sharding.py -q` → PASS.
- [ ] **Step 3.5:** Commit:
  `git add backend/routers/jobs.py backend/routers/github_sources.py backend/services/aggregator.py backend/tests/test_job_ingest_locations.py && git commit -m "feat(jobs): every ingest path writes structured locations; drop icon.horse domain guesses"`

---

### Task 4: Descriptions captured at ATS scrape time

**Files:**
- Modify: `backend/services/ats_scraper.py`
- Modify: `backend/services/description_extractor.py` (`MAX_DESC_LEN`, public SR helper, public `clean_html`)
- Modify: `backend/routers/github_sources.py` (`cron_ats` stores descriptions; SR detail fetch for new jobs)
- Test: `backend/tests/test_ats_scraper_descriptions.py`

**Interfaces:**
- Produces: `ATSJob.description: str = ""`; `description_extractor.clean_html(html: str) -> str`; `description_extractor.extract_smartrecruiters_from_url(client, url) -> str`.
- Consumes: `sanitize_description(text)` (existing), `location_fields` (Task 1).

- [ ] **Step 4.1: Failing tests** — `backend/tests/test_ats_scraper_descriptions.py`:

```python
"""ATS scrapers must surface descriptions from the board APIs they already call."""

import httpx
import pytest

from backend.services.ats_scraper import ATSScraper


class MockTransport(httpx.AsyncBaseTransport):
    def __init__(self, responses: dict):
        self.responses = responses
        self.requests: list[httpx.Request] = []

    async def handle_async_request(self, request):
        self.requests.append(request)
        for fragment, payload in self.responses.items():
            if fragment in str(request.url):
                return httpx.Response(200, json=payload)
        return httpx.Response(404, json={})


@pytest.mark.asyncio
async def test_greenhouse_requests_content_and_captures_description():
    transport = MockTransport({
        "boards-api.greenhouse.io": {"jobs": [{
            "title": "Software Engineer Intern",
            "location": {"name": "Ottawa, Ontario, Canada"},
            "absolute_url": "https://boards.greenhouse.io/acme/jobs/123",
            "updated_at": "2026-07-01T00:00:00Z",
            "departments": [{"name": "Engineering"}],
            "content": "&lt;p&gt;Build &lt;b&gt;great&lt;/b&gt; things all day, every day, with modern tools.&lt;/p&gt;",
        }]},
    })
    scraper = ATSScraper(filter_entry_level=False, filter_north_america=False)
    async with httpx.AsyncClient(transport=transport) as client:
        jobs = await scraper._scrape_greenhouse(client, "acme", "Acme")
    assert jobs[0].description.startswith("Build great things")
    assert any("content=true" in str(r.url) for r in transport.requests)


@pytest.mark.asyncio
async def test_lever_captures_description_plain_and_lists():
    transport = MockTransport({
        "api.lever.co": [{
            "text": "New Grad Engineer",
            "categories": {"location": "Toronto, Ontario, Canada"},
            "hostedUrl": "https://jobs.lever.co/acme/abc-123",
            "createdAt": 1750000000000,
            "descriptionPlain": "Do interesting work with a great team every single day.",
            "lists": [{"text": "Requirements", "content": "<li>Python</li><li>SQL</li>"}],
        }],
    })
    scraper = ATSScraper(filter_entry_level=False, filter_north_america=False)
    async with httpx.AsyncClient(transport=transport) as client:
        jobs = await scraper._scrape_lever(client, "acme", "Acme")
    assert "Do interesting work" in jobs[0].description
    assert "Requirements" in jobs[0].description
    assert "Python" in jobs[0].description


@pytest.mark.asyncio
async def test_ashby_captures_description_html():
    transport = MockTransport({
        "api.ashbyhq.com": {"jobs": [{
            "title": "Engineering Intern",
            "location": "Vancouver, British Columbia, Canada",
            "jobUrl": "https://jobs.ashbyhq.com/acme/xyz",
            "publishedAt": "2026-07-01T00:00:00Z",
            "departmentName": "Eng",
            "descriptionHtml": "<p>Ship product with senior mentorship and real ownership.</p>",
        }]},
    })
    scraper = ATSScraper(filter_entry_level=False, filter_north_america=False)
    async with httpx.AsyncClient(transport=transport) as client:
        jobs = await scraper._scrape_ashby(client, "acme", "Acme")
    assert "Ship product" in jobs[0].description
```

  (Check whether `pytest.ini`/`pyproject.toml` already enables `asyncio_mode = auto` or uses `pytest.mark.asyncio` — mirror whatever `test_apply_integration.py`/other async tests do.)
- [ ] **Step 4.2:** Run → FAIL (`ATSJob` has no `description`).
- [ ] **Step 4.3: Implement.**
  - `description_extractor.py`: `MAX_DESC_LEN = 10000`; add at module level:

```python
def clean_html(html: str) -> str:
    """Public HTML→text cleaner (entity-unescape + tag strip + cap)."""
    return _cap(_clean_html(html))


async def extract_smartrecruiters_from_url(client: httpx.AsyncClient, url: str) -> str:
    """Fetch a SmartRecruiters posting's ad content given any SR job URL."""
    return await _extract_smartrecruiters(client, url)
```

  - `ats_scraper.py`: add `description: str = ""` to `ATSJob`; import `from backend.services.description_extractor import clean_html`.
    - Greenhouse: `params = {"content": "true"}`; in the job loop add `description=clean_html(job_data.get("content", "") or "")` to the `ATSJob(...)`. Note Greenhouse double-escapes entities; `clean_html`'s unescape handles one level and `_clean_html` strips tags after — verify with the test fixture above (it uses the escaped form GH actually returns).
    - Lever: build `description`:

```python
            description = posting.get("descriptionPlain") or ""
            for lst in posting.get("lists", []) or []:
                content = clean_html(lst.get("content", ""))
                if content:
                    description += f"\n\n{lst.get('text', '')}\n{content}"
            description = description.strip()
```

      and pass `description=description[:10000]` into `ATSJob(...)`.
    - Ashby: `description=clean_html(job_data.get("descriptionHtml") or job_data.get("descriptionPlain") or "")`.
    - SmartRecruiters: leave `description=""` (list API has no content).
  - `github_sources.py` `cron_ats`: after the dedup check and before constructing `ScrapedJob`, resolve the description:

```python
            description = (job.description or "").strip()
            if not description and "smartrecruiters" in (job.url or ""):
                try:
                    description = await extract_smartrecruiters_from_url(sr_client, job.url)
                except Exception:
                    description = ""
            description = sanitize_description(description) if description else ""
```

    with imports `from backend.services.description_extractor import extract_smartrecruiters_from_url, sanitize_description` and one shared client wrapping the loop:
    `async with httpx.AsyncClient(timeout=15) as sr_client:` (wrap the whole for-loop; `import httpx` at top of function if missing). Pass `description=description` into `ScrapedJob(...)` instead of `""`.
- [ ] **Step 4.4:** Run: `python -m pytest backend/tests/test_ats_scraper_descriptions.py backend/tests/test_description_extractor.py backend/tests/test_cron_ats_sharding.py -q` → PASS.
- [ ] **Step 4.5:** Commit:
  `git add backend/services/ats_scraper.py backend/services/description_extractor.py backend/routers/github_sources.py backend/tests/test_ats_scraper_descriptions.py && git commit -m "feat(scrape): capture descriptions from ATS board APIs at ingest"`

---

### Task 5: Token-based location filter + `/jobs/cities`

**Files:**
- Modify: `backend/routers/jobs.py` (`list_jobs` location block, lines ~122-128; new `/cities` route ABOVE `get_job`)
- Modify: `backend/tests/test_city_filter_properties.py` (update to new semantics — read it first; keep its property style)
- Test: `backend/tests/test_location_filtering.py`

**Interfaces (Consumes):** `fold`, `location_tag_tokens` (Task 1). **Produces:** `GET /jobs/cities?country=CA&q=ot&limit=12 → [{"city": "Ottawa", "count": 781}, …]`.

- [ ] **Step 5.1: Failing tests** — `backend/tests/test_location_filtering.py` (reuse the client/db fixtures used by `backend/tests/test_job_filters.py` — read that file and mirror its setup helper for inserting ScrapedJob rows):

```python
"""Token-boundary location filtering: Ottawa means Ottawa, not Ontario."""


def _mk(db_session, url, location, country="CA", work_type="onsite"):
    from backend.db.models import ScrapedJob
    from backend.services.location_parser import location_fields
    row = ScrapedJob(
        title="Engineer", company="Acme", url=url, location=location,
        description="", country=country, work_type=work_type,
        source_platform="ats", experience_level="new_grad", easy_apply=0,
        match_score=0, **location_fields(location),
    )
    db_session.add(row)
    db_session.commit()
    return row


def test_ottawa_excludes_toronto_and_london(client, db_session):
    _mk(db_session, "https://x.test/1", "Ottawa, Ontario, Canada")
    _mk(db_session, "https://x.test/2", "Toronto, Ontario, Canada")
    _mk(db_session, "https://x.test/3", "London, Ontario, Canada")
    res = client.get("/jobs", params={"location": "Ottawa"})
    urls = [j["url"] for j in res.json()]
    assert "https://x.test/1" in urls
    assert "https://x.test/2" not in urls
    assert "https://x.test/3" not in urls


def test_city_with_region_tag_equals_city(client, db_session):
    _mk(db_session, "https://x.test/4", "Ottawa, ON, CA")
    res = client.get("/jobs", params={"location": "Ottawa, ON"})
    assert any(j["url"] == "https://x.test/4" for j in res.json())
    res2 = client.get("/jobs", params={"location": "Ottawa"})
    assert any(j["url"] == "https://x.test/4" for j in res2.json())


def test_multi_tag_semicolon_or(client, db_session):
    _mk(db_session, "https://x.test/5", "Ottawa, ON, CA")
    _mk(db_session, "https://x.test/6", "Calgary, AB, CA")
    _mk(db_session, "https://x.test/7", "Toronto, ON, CA")
    res = client.get("/jobs", params={"location": "Ottawa;Calgary"})
    urls = [j["url"] for j in res.json()]
    assert "https://x.test/5" in urls and "https://x.test/6" in urls
    assert "https://x.test/7" not in urls


def test_multi_city_blob_matches_each_city(client, db_session):
    _mk(db_session, "https://x.test/8",
        "Ottawa,Ontario,Canada; Kraków,Kraków,Poland; Łódź,Łódź,Poland")
    res = client.get("/jobs", params={"location": "Ottawa"})
    assert any(j["url"] == "https://x.test/8" for j in res.json())


def test_legacy_rows_fall_back_to_substring(client, db_session):
    from backend.db.models import ScrapedJob
    row = ScrapedJob(
        title="Engineer", company="Acme", url="https://x.test/9",
        location="Ottawa, Ontario, Canada", description="", country="CA",
        work_type="onsite", source_platform="ats", experience_level="new_grad",
        easy_apply=0, match_score=0, location_search="",
    )
    db_session.add(row)
    db_session.commit()
    res = client.get("/jobs", params={"location": "Ottawa"})
    assert any(j["url"] == "https://x.test/9" for j in res.json())


def test_remote_tag_matches_work_type(client, db_session):
    _mk(db_session, "https://x.test/10", "Toronto, ON, CA", work_type="remote")
    res = client.get("/jobs", params={"location": "Remote"})
    assert any(j["url"] == "https://x.test/10" for j in res.json())


def test_cities_endpoint_lists_parsed_cities(client, db_session):
    _mk(db_session, "https://x.test/11", "Ottawa, ON, CA")
    _mk(db_session, "https://x.test/12", "Ottawa, Ontario, Canada")
    _mk(db_session, "https://x.test/13", "Toronto, ON, CA")
    res = client.get("/jobs/cities", params={"country": "CA", "q": "ot"})
    assert res.status_code == 200
    entries = {e["city"]: e["count"] for e in res.json()}
    assert entries.get("Ottawa", 0) >= 2
    assert "Toronto" not in entries
```

- [ ] **Step 5.2:** Run → FAIL.
- [ ] **Step 5.3: Implement in `backend/routers/jobs.py`.** Replace the location block in `list_jobs` (currently lines 122-128) with:

```python
    if location:
        from backend.services.location_parser import fold, location_tag_tokens

        tags = location.split(";") if ";" in location else location.split(",")
        tag_conditions = []
        for tag in tags:
            tag = tag.strip()
            if not tag:
                continue
            if fold(tag) == "remote":
                tag_conditions.append(
                    or_(
                        ScrapedJob.work_type == "remote",
                        ScrapedJob.location_search.like("%|remote|%"),
                        ScrapedJob.location.ilike("%remote%"),
                    )
                )
                continue
            tokens = location_tag_tokens(tag)
            if not tokens:
                continue
            token_match = and_(
                *[ScrapedJob.location_search.like(f"%|{t}|%") for t in tokens]
            )
            legacy_fallback = and_(
                or_(
                    ScrapedJob.location_search.is_(None),
                    ScrapedJob.location_search == "",
                ),
                ScrapedJob.location.ilike(f"%{_escape_like(tokens[0])}%"),
            )
            tag_conditions.append(or_(token_match, legacy_fallback))
        if tag_conditions:
            q = q.filter(or_(*tag_conditions))
```

  Add `and_` to the existing `from sqlalchemy import func, or_` import. Add the cities route ABOVE `@router.get("/{job_id}")` (FastAPI would otherwise 422 "/cities" against the int converter):

```python
@router.get("/cities")
def list_cities(
    country: Optional[str] = None,
    q: Optional[str] = None,
    limit: int = Query(12, ge=1, le=50),
    db: Session = Depends(get_db),
):
    """Distinct parsed cities (with counts) for filter autocomplete."""
    from backend.services.location_parser import fold

    query = (
        db.query(ScrapedJob.city, func.count(ScrapedJob.id))
        .filter(ScrapedJob.city.isnot(None), ScrapedJob.city != "")
    )
    if country:
        query = query.filter(ScrapedJob.country == country.strip().upper())
    if q and q.strip():
        query = query.filter(ScrapedJob.city.like(f"{fold(q)}%"))
    rows = (
        query.group_by(ScrapedJob.city)
        .order_by(func.count(ScrapedJob.id).desc())
        .limit(limit)
        .all()
    )
    return [
        {"city": " ".join(w.capitalize() for w in city.split(" ")), "count": count}
        for city, count in rows
    ]
```

- [ ] **Step 5.4: Update `backend/tests/test_city_filter_properties.py`** to the new semantics: any property asserting comma-split substring behavior ("Ottawa, ON" matching Ontario-wide, or `%ON%` substring hits) must now assert token behavior. Read the file; keep its Hypothesis structure; where it generated raw substrings expect the fallback path only for rows with empty `location_search`.
- [ ] **Step 5.5:** Run: `python -m pytest backend/tests/test_location_filtering.py backend/tests/test_city_filter_properties.py backend/tests/test_job_filters.py backend/tests/test_api_filter_properties.py -q` → PASS.
- [ ] **Step 5.6:** Commit:
  `git add backend/routers/jobs.py backend/tests/test_location_filtering.py backend/tests/test_city_filter_properties.py && git commit -m "feat(jobs): exact token-boundary city filtering + /jobs/cities autocomplete"`

---

### Task 6: `cron-backfill` endpoint + workflow step

**Files:**
- Modify: `backend/routers/jobs.py` (new route; also increment attempts in `fetch_job_details` and clear `description_sections` on description writes there and in `batch_fix_descriptions`)
- Modify: `.github/workflows/scrape-jobs.yml`
- Test: `backend/tests/test_cron_backfill.py`

**Interfaces (Produces):** `POST /jobs/cron-backfill?batch_size=40` (cron-secret) → `{"processed": n, "descriptions_fixed": n, "locations_fixed": n, "domains_fixed": n, "remaining": n}`.

- [ ] **Step 6.1: Failing tests** — `backend/tests/test_cron_backfill.py`:

```python
"""Backfill cron: bounded description retries + location/domain repair."""

import os


def _cron_headers():
    return {"x-cron-secret": os.environ.get("CRON_SECRET", "test-cron-secret")}


def _mk(db_session, url, description="", attempts=0, location="Ottawa, ON, CA",
        location_search="", company="Kinaxis"):
    from backend.db.models import ScrapedJob
    row = ScrapedJob(
        title="Engineer", company=company, url=url, location=location,
        description=description, country="CA", work_type="onsite",
        source_platform="ats", experience_level="new_grad", easy_apply=0,
        match_score=0, desc_fetch_attempts=attempts,
        location_search=location_search,
    )
    db_session.add(row)
    db_session.commit()
    return row


def test_backfill_fetches_description_and_repairs_row(client, db_session, monkeypatch):
    row = _mk(db_session, "https://x.test/backfill-1")

    async def fake_extract(client_, url):
        return "A long and detailed description of the role " * 5

    monkeypatch.setattr(
        "backend.routers.jobs.extract_description_from_url", fake_extract
    )
    res = client.post("/jobs/cron-backfill", headers=_cron_headers())
    assert res.status_code == 200
    db_session.refresh(row)
    assert len(row.description) > 100
    assert row.desc_fetch_attempts == 1
    assert "|ottawa|" in row.location_search
    assert row.company_domain == "kinaxis.com"


def test_backfill_skips_rows_at_attempt_cap(client, db_session, monkeypatch):
    row = _mk(db_session, "https://x.test/backfill-2", attempts=3)
    called = {"n": 0}

    async def fake_extract(client_, url):
        called["n"] += 1
        return ""

    monkeypatch.setattr(
        "backend.routers.jobs.extract_description_from_url", fake_extract
    )
    client.post("/jobs/cron-backfill", headers=_cron_headers())
    db_session.refresh(row)
    assert row.desc_fetch_attempts == 3
    assert called["n"] == 0


def test_backfill_increments_attempts_on_failure(client, db_session, monkeypatch):
    row = _mk(db_session, "https://x.test/backfill-3")

    async def fake_extract(client_, url):
        return ""

    monkeypatch.setattr(
        "backend.routers.jobs.extract_description_from_url", fake_extract
    )
    client.post("/jobs/cron-backfill", headers=_cron_headers())
    db_session.refresh(row)
    assert row.desc_fetch_attempts == 1
    assert (row.description or "") == ""
```

- [ ] **Step 6.2:** Run → FAIL (404).
- [ ] **Step 6.3: Implement** in `backend/routers/jobs.py` (place next to `ingest_batch`; note `extract_description_from_url` is already imported at module top — the monkeypatch target relies on that):

```python
@router.post("/cron-backfill")
async def cron_backfill(
    batch_size: int = Query(40, ge=1, le=80),
    _cron: None = Depends(verify_cron_secret),
    db: Session = Depends(get_db),
):
    """Bounded repair pass: fetch missing descriptions (≤3 attempts/job),
    and fill structured location + company_domain for the rows it visits."""
    import httpx
    from backend.services.location_parser import location_fields
    from backend.services.logo_resolver import resolve_logo

    needs_description = or_(
        ScrapedJob.description.is_(None),
        func.length(func.trim(ScrapedJob.description)) < 50,
    )
    jobs = (
        db.query(ScrapedJob)
        .filter(needs_description, func.coalesce(ScrapedJob.desc_fetch_attempts, 0) < 3)
        .order_by(ScrapedJob.id.desc())
        .limit(batch_size)
        .all()
    )

    descriptions_fixed = locations_fixed = domains_fixed = 0
    async with httpx.AsyncClient(
        follow_redirects=True, timeout=12, headers=BROWSER_HEADERS
    ) as client:
        for job in jobs:
            job.desc_fetch_attempts = (job.desc_fetch_attempts or 0) + 1
            if job.url:
                try:
                    text = await extract_description_from_url(client, job.url)
                except Exception:
                    text = ""
                if text:
                    job.description = _sanitize_description(text)
                    job.description_sections = None
                    descriptions_fixed += 1
            if not (job.location_search or "") and (job.location or ""):
                for key, value in location_fields(job.location).items():
                    setattr(job, key, value)
                locations_fixed += 1
            if not (job.company_domain or ""):
                logo, domain = resolve_logo(job.company, job.company_url)
                if domain:
                    job.company_domain = domain
                    if not (job.company_logo or "") or "icon.horse" in (job.company_logo or ""):
                        job.company_logo = logo
                    domains_fixed += 1
            db.commit()

    remaining = (
        db.query(ScrapedJob)
        .filter(needs_description, func.coalesce(ScrapedJob.desc_fetch_attempts, 0) < 3)
        .count()
    )
    return {
        "processed": len(jobs),
        "descriptions_fixed": descriptions_fixed,
        "locations_fixed": locations_fixed,
        "domains_fixed": domains_fixed,
        "remaining": remaining,
    }
```

  Also in `fetch_job_details`: after `job.description = _sanitize_description(description)` add `job.description_sections = None` and `job.desc_fetch_attempts = (job.desc_fetch_attempts or 0) + 1` (place the attempt increment right after loading the job, before the fetch). Same `description_sections = None` after the description write in `batch_fix_descriptions`.
- [ ] **Step 6.4: Workflow step** — `.github/workflows/scrape-jobs.yml`, after the "Trigger GitHub aggregator" step:

```yaml
      - name: Backfill descriptions + locations
        run: |
          curl -X POST "https://www.tailrd.ca/jobs/cron-backfill" \
            -H "Content-Type: application/json" \
            -H "x-cron-secret: ${{ secrets.CRON_SECRET }}" \
            --max-time 300 || true
```

- [ ] **Step 6.5:** Run: `python -m pytest backend/tests/test_cron_backfill.py -q` → PASS.
- [ ] **Step 6.6:** Commit:
  `git add backend/routers/jobs.py .github/workflows/scrape-jobs.yml backend/tests/test_cron_backfill.py && git commit -m "feat(jobs): hourly bounded backfill of descriptions, locations, domains"`

---

### Task 7: `structure-description` — mini model, `description_sections` cache

**Files:**
- Modify: `backend/routers/jobs.py` (`structure_description`, lines ~614-695)
- Test: `backend/tests/test_structure_description.py`

**Interfaces (Produces):** response `{"sections": [...], "skills": [...], "experience_years": str?, "education": str?}`; cache column `ScrapedJob.description_sections` (dict); LLM called with `model="gpt-4o-mini"`, `json_mode=True`.

- [ ] **Step 7.1: Failing tests** — `backend/tests/test_structure_description.py` (mirror auth fixture usage from an existing verified-user test, e.g. `test_cover_letter_api.py`; a `client` + logged-in user helper exists — reuse it):

```python
"""structure-description: mini-model routing + description_sections caching."""

import json


def _mk_job(db_session, url="https://x.test/sd-1", description=None):
    from backend.db.models import ScrapedJob
    row = ScrapedJob(
        title="EPM Consultant", company="Acme", url=url,
        location="Ottawa, ON, CA", country="CA", work_type="onsite",
        source_platform="ats", experience_level="new_grad", easy_apply=0,
        match_score=0,
        description=description or (
            "Responsibilities:\n- Support EPM applications\n- Build planning models\n"
            "Requirements:\n- 3-5 years experience\n- Excel proficiency\n"
        ),
    )
    db_session.add(row)
    db_session.commit()
    return row


STRUCT = {
    "sections": [{"title": "Responsibilities", "icon": "clipboard-list",
                  "items": ["Support EPM applications"]}],
    "skills": ["Excel", "EPM"],
    "experience_years": "3-5",
    "education": "",
}


def test_structure_calls_mini_model_json_mode_and_caches(auth_client, db_session, monkeypatch):
    job = _mk_job(db_session)
    seen = {}

    async def fake_generate(self, prompt, model=None, json_mode=False, **kwargs):
        seen["model"] = model
        seen["json_mode"] = json_mode
        return json.dumps(STRUCT)

    monkeypatch.setattr(
        "backend.services.openai_service.OpenAIService._generate", fake_generate
    )
    res = auth_client.post(f"/jobs/{job.id}/structure-description")
    assert res.status_code == 200
    assert seen == {"model": "gpt-4o-mini", "json_mode": True}
    assert res.json()["skills"] == ["Excel", "EPM"]
    db_session.refresh(job)
    assert job.description_sections["skills"] == ["Excel", "EPM"]


def test_structure_served_from_cache_without_llm(auth_client, db_session, monkeypatch):
    job = _mk_job(db_session, url="https://x.test/sd-2")
    job.description_sections = STRUCT
    db_session.commit()

    async def boom(self, *args, **kwargs):
        raise AssertionError("LLM must not be called on cache hit")

    monkeypatch.setattr(
        "backend.services.openai_service.OpenAIService._generate", boom
    )
    res = auth_client.post(f"/jobs/{job.id}/structure-description")
    assert res.status_code == 200
    assert res.json()["sections"][0]["title"] == "Responsibilities"


def test_structure_migrates_legacy_company_description_cache(auth_client, db_session, monkeypatch):
    job = _mk_job(db_session, url="https://x.test/sd-3")
    job.company_description = json.dumps(STRUCT)
    db_session.commit()

    async def boom(self, *args, **kwargs):
        raise AssertionError("LLM must not be called on legacy cache hit")

    monkeypatch.setattr(
        "backend.services.openai_service.OpenAIService._generate", boom
    )
    res = auth_client.post(f"/jobs/{job.id}/structure-description")
    assert res.status_code == 200
    db_session.refresh(job)
    assert job.description_sections["skills"] == ["Excel", "EPM"]
```

  (If there is no shared `auth_client` fixture, create the verified user the same way `test_cover_letter_api.py` does and name the local fixture `auth_client`.)
- [ ] **Step 7.2:** Run → FAIL.
- [ ] **Step 7.3: Implement** — rewrite `structure_description` body:

```python
    job = db.query(ScrapedJob).filter(ScrapedJob.id == job_id).first()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found.")

    if not job.description or len(job.description) < 50:
        return {"sections": [], "skills": [], "error": "No description available"}

    # Cache: proper column first, then the legacy company_description JSON hack.
    if isinstance(job.description_sections, dict) and job.description_sections.get("sections"):
        return job.description_sections
    if job.company_description and job.company_description.startswith("{"):
        try:
            cached = json.loads(job.company_description)
            if cached.get("sections"):
                job.description_sections = cached
                db.commit()
                return cached
        except (json.JSONDecodeError, TypeError):
            pass

    llm = get_llm_service()
    prompt = f"""Parse this job description into structured JSON sections. Return ONLY a JSON object:
{{
  "sections": [
    {{"title": "Responsibilities", "icon": "clipboard-list", "items": ["..."]}},
    {{"title": "Qualifications", "icon": "graduation-cap", "subsections": [
      {{"title": "Required", "items": ["..."]}},
      {{"title": "Preferred", "items": ["..."]}}
    ]}},
    {{"title": "Benefits", "icon": "gift", "items": ["..."]}},
    {{"title": "About the Company", "icon": "building", "items": ["..."]}}
  ],
  "skills": ["Python", "SQL", "Stakeholder engagement"],
  "experience_years": "2-4",
  "education": "BS in Computer Science"
}}

Rules:
- Preserve every bullet from the posting in the matching section; do not invent content.
- Qualifications MUST use Required/Preferred subsections when the posting distinguishes them; otherwise put everything under Required.
- "skills" are 5-18 concrete skill tags from the posting: technologies, tools, languages, certifications, and named competencies (e.g. "Bilingualism English/French").
- Omit sections the posting does not contain. Keep items to one sentence.

Job Description:
{job.description[:6000]}"""

    try:
        response = await llm._generate(prompt, model="gpt-4o-mini", json_mode=True)
        data = json.loads(response)
        if data.get("sections"):
            job.description_sections = data
            db.commit()
        return data
    except Exception as e:
        return {"sections": [], "skills": [], "error": str(e)}
```

  (Delete the old ```-fence scraping block — `json_mode` guarantees bare JSON.)
- [ ] **Step 7.4:** Run: `python -m pytest backend/tests/test_structure_description.py -q` → PASS.
- [ ] **Step 7.5:** Commit:
  `git add backend/routers/jobs.py backend/tests/test_structure_description.py && git commit -m "feat(jobs): structure-description on gpt-4o-mini json_mode with proper cache column"`

---

### Task 8: Frontend `CompanyLogo` with guarded provider cascade

**Files:**
- Create: `frontend/src/components/CompanyLogo.tsx`
- Modify: `frontend/src/lib/companyLogo.ts` (add `logoProviderChain`)
- Modify: `frontend/src/pages/Jobs.tsx` (card logo block, lines ~390-409)
- Modify: `frontend/src/components/JobDetailView.tsx` (header logo block, lines ~365-389)
- Modify: `frontend/src/index.css` (avatar/img classes)
- Test: `frontend/src/__tests__/company-logo.test.tsx`

**Interfaces (Produces):**
- `logoProviderChain(job: JobLike): string[]` in `lib/companyLogo.ts`.
- `<CompanyLogo company company_logo? company_domain? company_url? size? className? />`.

- [ ] **Step 8.1: Failing test** — `frontend/src/__tests__/company-logo.test.tsx` (mirror render/setup style of `frontend/src/__tests__/applyTracking.test.tsx` — testing-library + vitest):

```tsx
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import CompanyLogo from "../components/CompanyLogo";
import { logoProviderChain } from "../lib/companyLogo";

describe("logoProviderChain", () => {
  it("prefers a stored real CDN logo, then clearbit, then google favicon", () => {
    const chain = logoProviderChain({
      company: "Kinaxis",
      company_logo: "https://cdn.jobright.ai/logos/kinaxis.png",
      company_domain: "kinaxis.com",
    });
    expect(chain[0]).toBe("https://cdn.jobright.ai/logos/kinaxis.png");
    expect(chain[1]).toContain("logo.clearbit.com/kinaxis.com");
    expect(chain[2]).toContain("google.com/s2/favicons");
    expect(chain[2]).toContain("sz=256");
  });

  it("skips generated logo urls and derives the domain from the name", () => {
    const chain = logoProviderChain({
      company: "Shopify",
      company_logo: "https://icon.horse/icon/shopify.com",
    });
    expect(chain[0]).toContain("logo.clearbit.com/shopify.com");
  });
});

describe("CompanyLogo", () => {
  it("advances to the next provider on error and lands on the letter avatar", () => {
    render(<CompanyLogo company="Acme Widgets" company_domain="acmewidgets.example" size={40} />);
    let img = screen.getByRole("img");
    fireEvent.error(img); // clearbit 404
    img = screen.getByRole("img");
    fireEvent.error(img); // google favicon error
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByLabelText("Acme Widgets logo").textContent).toBe("A");
  });

  it("treats a tiny favicon as a miss", () => {
    render(<CompanyLogo company="Acme" company_domain="acme.example" size={40} />);
    fireEvent.error(screen.getByRole("img")); // clearbit fails → google favicon
    const img = screen.getByRole("img") as HTMLImageElement;
    Object.defineProperty(img, "naturalWidth", { value: 16, configurable: true });
    fireEvent.load(img);
    expect(screen.queryByRole("img")).toBeNull(); // fell through to avatar
  });
});
```

- [ ] **Step 8.2:** Run: `cd frontend && node node_modules/vitest/vitest.mjs run src/__tests__/company-logo.test.tsx` → FAIL.
- [ ] **Step 8.3: Implement.**
  - `lib/companyLogo.ts` — add (after `resolveLogoUrl`):

```ts
/** Ordered logo-source candidates; the component walks them on error/low-res. */
export function logoProviderChain(job: JobLike): string[] {
  const chain: string[] = [];
  const stored = job.company_logo || "";
  const isGenerated =
    stored.includes("clearbit") ||
    stored.includes("icon.horse") ||
    stored.includes("google.com/s2") ||
    stored.includes("apistemic") ||
    stored.includes("hunter.io");
  if (stored.startsWith("http") && !isGenerated) chain.push(stored);

  let domain = (job.company_domain || "").trim();
  if (!domain) domain = domainFromUrl(job.company_url) || "";
  if (!domain) domain = domainFromName(job.company) || "";
  if (domain) {
    chain.push(`https://logo.clearbit.com/${domain}`);
    chain.push(`https://www.google.com/s2/favicons?domain=${domain}&sz=256`);
  }
  return chain;
}
```

  - `components/CompanyLogo.tsx`:

```tsx
import { useEffect, useMemo, useState } from "react";
import { avatarColor, avatarLetter, logoProviderChain, type JobLike } from "../lib/companyLogo";

interface Props extends JobLike {
  size?: number;
  className?: string;
}

// Favicon endpoints return tiny placeholders instead of 404ing; anything this
// small would render as an upscaled blur, so treat it as a miss.
const MIN_NATURAL_WIDTH = 64;

export default function CompanyLogo({ size = 40, className = "", ...job }: Props) {
  const chain = useMemo(
    () => logoProviderChain(job),
    [job.company, job.company_logo, job.company_domain, job.company_url],
  );
  const [index, setIndex] = useState(0);
  useEffect(() => setIndex(0), [chain.join("~")]);

  const src = index < chain.length ? chain[index] : null;
  if (!src) {
    return (
      <div
        className={`company-logo-avatar ${className}`}
        style={{ width: size, height: size, backgroundColor: avatarColor(job.company) }}
        aria-label={`${job.company} logo`}
      >
        {avatarLetter(job.company)}
      </div>
    );
  }
  return (
    <img
      src={src}
      alt={`${job.company} logo`}
      className={`company-logo-cascade ${className}`}
      style={{ width: size, height: size }}
      loading="lazy"
      onError={() => setIndex((i) => i + 1)}
      onLoad={(e) => {
        const img = e.currentTarget;
        const isFavicon = src.includes("google.com/s2");
        if (isFavicon && img.naturalWidth > 0 && img.naturalWidth < MIN_NATURAL_WIDTH) {
          setIndex((i) => i + 1);
        }
      }}
    />
  );
}
```

  - `index.css` — add near the existing `.company-logo` rules:

```css
.company-logo-avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 10px;
  color: #fff;
  font-weight: 600;
  font-size: 18px;
  flex-shrink: 0;
}
.company-logo-cascade {
  border-radius: 10px;
  object-fit: contain;
  background: #fff;
  border: 1px solid #eef1f5;
  flex-shrink: 0;
}
```

  - `Jobs.tsx`: replace the `company-logo-wrapper` block (~390-409) with:

```tsx
                  <CompanyLogo
                    company={job.company}
                    company_logo={job.company_logo}
                    company_domain={job.company_domain}
                    company_url={job.company_url}
                    size={44}
                  />
```

    Import `CompanyLogo` and delete the now-unused `resolveLogoUrl` import + `getLogoColor`/`handleLogoError` helpers if nothing else uses them.
  - `JobDetailView.tsx`: replace the header logo IIFE + placeholder div (~365-389) with `<CompanyLogo company={job.company} company_logo={companyLogo || job.company_logo} company_domain={job.company_domain} company_url={job.company_url} size={52} />` and drop the unused `resolveLogoUrl` import.
- [ ] **Step 8.4:** Run: `node node_modules/vitest/vitest.mjs run src/__tests__/company-logo.test.tsx` → PASS. Also `node node_modules/vitest/vitest.mjs run src/__tests__/jobs.property.test.tsx` (must stay at baseline).
- [ ] **Step 8.5:** During live verification (Task 12), probe `https://logo.clearbit.com/shopify.com` — if Clearbit is dead (non-200), delete it from `logoProviderChain` and its test expectation, leaving stored→favicon→avatar.
- [ ] **Step 8.6:** Commit:
  `git add frontend/src/components/CompanyLogo.tsx frontend/src/lib/companyLogo.ts frontend/src/pages/Jobs.tsx frontend/src/components/JobDetailView.tsx frontend/src/index.css frontend/src/__tests__/company-logo.test.tsx && git commit -m "feat(ui): guarded company-logo cascade — no more blurry favicons"`

---

### Task 9: Frontend location display + filter suggestions

**Files:**
- Create: `frontend/src/lib/jobLocation.ts`
- Modify: `frontend/src/pages/Jobs.tsx` (card location line ~435; `fetchJobs` join ~232)
- Modify: `frontend/src/components/JobDetailView.tsx` (location tag ~400-404)
- Modify: `frontend/src/components/JobFilterBar.tsx` (city suggestions under the input)
- Test: `frontend/src/__tests__/job-location.test.ts`

**Interfaces:**
- Produces: `displayLocation(job: { location?: string | null; locations_json?: JobLocationEntry[] | null }): string`.
- Consumes: `GET /jobs/cities?country=&q=` (Task 5); tags joined with `";"`.

- [ ] **Step 9.1: Failing test** — `frontend/src/__tests__/job-location.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { displayLocation } from "../lib/jobLocation";

describe("displayLocation", () => {
  it("renders city, region, country from locations_json", () => {
    expect(
      displayLocation({
        location: "Ottawa,Ontario,Canada",
        locations_json: [{ city: "Ottawa", region: "ON", region_name: "Ontario", country: "Canada" }],
      }),
    ).toBe("Ottawa, ON, Canada");
  });

  it("summarizes multi-location jobs", () => {
    expect(
      displayLocation({
        location: "Ottawa,Ontario,Canada; Kraków,Kraków,Poland; Łódź,Łódź,Poland",
        locations_json: [
          { city: "Ottawa", region: "ON", region_name: "Ontario", country: "Canada" },
          { city: "Kraków", region: "", region_name: "", country: "Poland" },
          { city: "Łódź", region: "", region_name: "", country: "Poland" },
        ],
      }),
    ).toBe("Ottawa, ON, Canada · +2 more");
  });

  it("falls back to the first raw segment for legacy rows", () => {
    expect(
      displayLocation({ location: "Ottawa, Ontario, Canada; Kraków, Poland", locations_json: [] }),
    ).toBe("Ottawa, Ontario, Canada");
    expect(displayLocation({ location: "", locations_json: [] })).toBe("");
  });
});
```

- [ ] **Step 9.2:** Run → FAIL.
- [ ] **Step 9.3: Implement** `frontend/src/lib/jobLocation.ts`:

```ts
/** Mirror of backend location_display for jobs carrying locations_json. */

export interface JobLocationEntry {
  city?: string;
  region?: string;
  region_name?: string;
  country?: string;
}

export function displayLocation(job: {
  location?: string | null;
  locations_json?: JobLocationEntry[] | null;
}): string {
  const locs = job.locations_json || [];
  if (locs.length === 0) {
    return (job.location || "").split(";")[0].trim();
  }
  const head = locs[0];
  const parts = [head.city, head.region || head.region_name, head.country].filter(Boolean);
  const label = parts.join(", ");
  return locs.length > 1 ? `${label} · +${locs.length - 1} more` : label;
}
```

  - `Jobs.tsx`: add `locations_json?: { city?: string; region?: string; region_name?: string; country?: string }[]` to the `Job` interface; card location becomes `<span>{displayLocation(job) || "Remote"}</span>`; `fetchJobs` join becomes `.join(";")`.
  - `JobDetailView.tsx`: add the same field to its `Job` interface; the MapPin tag renders `{displayLocation(job)}`; when `job.locations_json && job.locations_json.length > 1`, set `title={job.location}` on the tag so hover reveals every location.
  - `JobFilterBar.tsx`: city suggestions —

```tsx
  const [citySuggestions, setCitySuggestions] = useState<{ city: string; count: number }[]>([]);
  useEffect(() => {
    if (!locationInput.trim() || locationInput.trim().length < 2) {
      setCitySuggestions([]);
      return;
    }
    const handle = setTimeout(async () => {
      try {
        const { data } = await api.get("/jobs/cities", {
          params: { q: locationInput.trim(), country: tempCountry || undefined },
        });
        setCitySuggestions(data);
      } catch {
        setCitySuggestions([]);
      }
    }, 200);
    return () => clearTimeout(handle);
  }, [locationInput, tempCountry]);
```

    (import `useState/useEffect` already present; add `import api from "../auth/api";`). Render under the tag input:

```tsx
            {citySuggestions.length > 0 && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", marginTop: "8px" }}>
                {citySuggestions.map((s) => (
                  <button
                    key={s.city}
                    type="button"
                    style={{ ...styles.pillButton, padding: "4px 10px", fontSize: "12px" }}
                    onClick={() => { addCityTag(s.city); setCitySuggestions([]); }}
                  >
                    {s.city} <span style={{ color: "#64748d" }}>({s.count})</span>
                  </button>
                ))}
              </div>
            )}
```

- [ ] **Step 9.4:** Run: `node node_modules/vitest/vitest.mjs run src/__tests__/job-location.test.ts src/__tests__/cityTagFilter.property.test.tsx src/__tests__/jobFilters.property.test.tsx` → job-location PASS, others at baseline (update `cityTagFilter.property.test.tsx` if it asserts the old `.join(",")`).
- [ ] **Step 9.5:** Commit:
  `git add frontend/src/lib/jobLocation.ts frontend/src/pages/Jobs.tsx frontend/src/components/JobDetailView.tsx frontend/src/components/JobFilterBar.tsx frontend/src/__tests__/job-location.test.ts && git commit -m "feat(ui): clean location display + canonical city suggestions"`

---

### Task 10: JobDetailView — structured sections + resume-matched qualification tags

**Files:**
- Create: `frontend/src/lib/resumeCoverage.ts`
- Modify: `frontend/src/components/JobDetailView.tsx`
- Modify: `frontend/src/index.css` (qualification tag styles)
- Modify/Test: `frontend/src/__tests__/JobDetailView.test.tsx` (extend; note pre-existing baseline failures — fix the ones the redesign touches, do not chase unrelated ones)
- Test: `frontend/src/__tests__/resume-coverage.test.ts`

**Interfaces:**
- Produces: `getPrimaryResumeText(): Promise<string>` (session-cached), `skillCovered(resumeText: string, skill: string): boolean`.
- Consumes: `POST /jobs/{id}/structure-description` (Task 7 shape), `GET /resumes` → `[{id, is_primary, …}]`, `GET /resumes/{id}` → detail with document (verify exact field names in `backend/schemas/resume_document.py` / `_record_to_detail` before wiring; `documentToText` lives in `frontend/src/lib/resumeDocument.ts`).

- [ ] **Step 10.1: Failing test** — `frontend/src/__tests__/resume-coverage.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { skillCovered } from "../lib/resumeCoverage";

const RESUME = "Built ETL pipelines in Python and SQL; led stakeholder engagement for finance teams using Microsoft Excel.";

describe("skillCovered", () => {
  it("whole-word match", () => {
    expect(skillCovered(RESUME, "Python")).toBe(true);
    expect(skillCovered(RESUME, "SQL")).toBe(true);
  });
  it("multi-word phrases match when all words present", () => {
    expect(skillCovered(RESUME, "Stakeholder engagement")).toBe(true);
    expect(skillCovered(RESUME, "Microsoft Excel")).toBe(true);
  });
  it("misses honestly", () => {
    expect(skillCovered(RESUME, "Hyperion Planning")).toBe(false);
    expect(skillCovered(RESUME, "CPA certification")).toBe(false);
  });
  it("does not substring-match short tokens", () => {
    expect(skillCovered("we use rust daily", "R")).toBe(false);
  });
});
```

- [ ] **Step 10.2:** Run → FAIL.
- [ ] **Step 10.3: Implement** `frontend/src/lib/resumeCoverage.ts`:

```ts
// Deterministic skill-tag coverage against the user's primary resume.
// Same whole-word semantics as lib/keywordMatch, but over plain text and
// cached per session so the Jobs detail panel costs zero AI calls.

import api from "../auth/api";
import { documentToText } from "./resumeDocument";

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function wholeWord(text: string, word: string): boolean {
  if (!word) return false;
  return new RegExp(`(?:^|[^a-z0-9])${escapeRe(word)}(?:[^a-z0-9]|$)`, "i").test(text);
}

export function skillCovered(resumeText: string, skill: string): boolean {
  const text = (resumeText || "").toLowerCase();
  const k = (skill || "").toLowerCase().trim();
  if (!text || !k) return false;
  const words = k.split(/\s+/).filter((w) => w.length > 1 || /^[a-z0-9]$/.test(w) === false);
  if (words.length === 0) return false;
  if (words.length > 1) {
    if (text.includes(k)) return true;
    return words.every((w) => wholeWord(text, w));
  }
  return wholeWord(text, k);
}

let cached: Promise<string> | null = null;

/** Primary resume as plain text, fetched once per session ("" when none). */
export function getPrimaryResumeText(): Promise<string> {
  if (!cached) {
    cached = (async () => {
      try {
        const { data: list } = await api.get("/resumes");
        if (!Array.isArray(list) || list.length === 0) return "";
        const primary = list.find((r: { is_primary?: boolean }) => r.is_primary) || list[0];
        const { data: detail } = await api.get(`/resumes/${primary.id}`);
        if (detail?.document) return documentToText(detail.document);
        return detail?.raw_text || detail?.parsed_text || "";
      } catch {
        return "";
      }
    })();
  }
  return cached;
}
```

  (Adjust the `detail?.document / raw_text / parsed_text` fallbacks to the REAL `ResumeDetailResponse` field names after reading `backend/routers/resumes.py::_record_to_detail` — keep `documentToText(document)` as the primary path.)
- [ ] **Step 10.4: Rework `JobDetailView.tsx`.**
  1. New state: `const [resumeText, setResumeText] = useState("");` — on mount: `getPrimaryResumeText().then(setResumeText)`.
  2. After a description is available (in the existing effect), call the server parse and prefer it over the client parse:

```tsx
  async function fetchStructured(effectiveDescription: string) {
    if (effectiveDescription.length <= 50) return;
    try {
      const { data } = await api.post(`/jobs/${job.id}/structure-description`);
      if (data && Array.isArray(data.sections) && data.sections.length > 0) {
        setStructured(data);
      }
    } catch {
      // keep the client-side parse
    }
  }
```

     Invoke `fetchStructured(effectiveDescription)` right after the existing `parseDescriptionClientSide` upgrade inside the `(async () => { … })()` block.
  3. Qualification tags: replace the flat `skill-tags` block with a dedicated Qualification treatment — render skills ABOVE the Qualifications section (matching the reference), each pill:

```tsx
{structured.skills && structured.skills.length > 0 && (
  <div className="qual-tags-block">
    <div className="qual-tags-caption">
      Skill tags from this posting — green means your resume covers it.
    </div>
    <div className="skill-tags">
      {structured.skills.map((skill: string, i: number) => {
        const matched = resumeText ? skillCovered(resumeText, skill) : false;
        return (
          <span key={i} className={`skill-tag${matched ? " skill-tag-matched" : ""}`}>
            {matched && <ThumbsUp size={12} weight="fill" />} {skill}
          </span>
        );
      })}
    </div>
  </div>
)}
```

     (import `ThumbsUp` from `@phosphor-icons/react`, `skillCovered`/`getPrimaryResumeText` from `../lib/resumeCoverage`).
  4. Keep the existing sections/subsections renderer (it already handles `subsections` for Required/Preferred).
  5. Empty state: in the final "No description available" branch, add under the subtitle:

```tsx
                <a href={applyUrl} target="_blank" rel="noopener noreferrer" className="btn-outline-detail" style={{ marginTop: 12 }}>
                  <ArrowSquareOut size={16} weight="bold" /> View Original Post
                </a>
```

  6. `index.css` additions:

```css
.qual-tags-caption {
  font-size: 12px;
  color: #64748d;
  margin-bottom: 8px;
}
.skill-tag-matched {
  background: #e7f8ef;
  border-color: #34d399;
  color: #047857;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
```

     (Check the existing `.skill-tag` rule in index.css and match its shape — padding/border-radius stay identical.)
- [ ] **Step 10.5: Extend `JobDetailView.test.tsx`**: add a test that renders the component with a mocked `api.post` returning the Task 7 STRUCT shape plus a mocked resume ("Python resume text") and asserts a matched pill gets `skill-tag-matched` while an unmatched one does not (mock module `../lib/resumeCoverage` with `getPrimaryResumeText: () => Promise.resolve("python and sql daily")`). Follow the file's existing mock pattern for `../auth/api`. Fix any of its baseline failures only where the redesign touched the render path.
- [ ] **Step 10.6:** Run: `node node_modules/vitest/vitest.mjs run src/__tests__/resume-coverage.test.ts src/__tests__/JobDetailView.test.tsx` → new tests PASS; file no worse than baseline.
- [ ] **Step 10.7:** Commit:
  `git add frontend/src/lib/resumeCoverage.ts frontend/src/components/JobDetailView.tsx frontend/src/index.css frontend/src/__tests__/resume-coverage.test.ts frontend/src/__tests__/JobDetailView.test.tsx && git commit -m "feat(ui): Jobright-style detail sections with resume-matched qualification tags"`

---

### Task 11: One-time backfill script → dev Neon → prod Neon

**Files:**
- Create: `backend/scripts/backfill_locations.py`

**Interfaces (Consumes):** `location_fields` (Task 1), `resolve_logo` (existing). Targets Postgres only (Neon); casts JSON params with `CAST(:lj AS json)`.

- [ ] **Step 11.1: Implement** `backend/scripts/backfill_locations.py`:

```python
"""
One-time backfill of structured location columns (+company_domain repair)
for every scraped_jobs row. Idempotent: only touches rows where
location_search is NULL/''. Targets Postgres (Neon).

Usage:
    DATABASE_URL=postgres://... python backend/scripts/backfill_locations.py [--dry-run]
"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from sqlalchemy import create_engine, text

from backend.services.location_parser import location_fields
from backend.services.logo_resolver import resolve_logo

BATCH = 500


def main(database_url: str, dry_run: bool = False) -> None:
    engine = create_engine(database_url)
    updated = scanned = 0
    with engine.connect() as conn:
        while True:
            rows = conn.execute(text(
                "SELECT id, location, company, company_url, company_domain, company_logo "
                "FROM scraped_jobs "
                "WHERE location_search IS NULL OR location_search = '' "
                "ORDER BY id LIMIT :batch"
            ), {"batch": BATCH}).fetchall()
            if not rows:
                break
            scanned += len(rows)
            params = []
            for row in rows:
                fields = location_fields(row.location or "")
                domain = (row.company_domain or "").strip()
                logo = row.company_logo or ""
                if not domain:
                    resolved_logo, resolved_domain = resolve_logo(row.company, row.company_url)
                    if resolved_domain:
                        domain = resolved_domain
                        if not logo or "icon.horse" in logo:
                            logo = resolved_logo
                params.append({
                    "id": row.id,
                    "city": fields["city"],
                    "region": fields["region"],
                    "lj": json.dumps(fields["locations_json"]),
                    # '\x01' sentinel keeps genuinely-unparseable rows out of
                    # the WHERE loop (they'd otherwise be reselected forever).
                    "ls": fields["location_search"] or "\x01",
                    "domain": domain,
                    "logo": logo,
                })
            if dry_run:
                print(f"[dry-run] would update {len(params)} rows (through id {rows[-1].id})")
                if scanned >= BATCH:  # one batch is enough to inspect
                    break
                continue
            conn.execute(text(
                "UPDATE scraped_jobs SET "
                "city = :city, region = :region, "
                "locations_json = CAST(:lj AS json), location_search = :ls, "
                "company_domain = :domain, company_logo = :logo "
                "WHERE id = :id"
            ), params)
            conn.commit()
            updated += len(params)
            print(f"updated {updated} rows (through id {rows[-1].id})")
    print(f"done: scanned {scanned}, updated {updated}")


if __name__ == "__main__":
    url = os.environ.get("DATABASE_URL", "")
    if not url:
        sys.exit("DATABASE_URL is required")
    main(url, dry_run="--dry-run" in sys.argv)
```

- [ ] **Step 11.2: Dev run.** Get the dev-branch connection string via the Neon MCP (`get_connection_string`, project `divine-base-11638078`, Development branch). Run with `--dry-run`, inspect, then run for real.
- [ ] **Step 11.3: Verify on dev** (SQL): `SELECT count(*) FROM scraped_jobs WHERE location_search = '' OR location_search IS NULL` → ~0; spot-check `SELECT location, city, region, location_search FROM scraped_jobs WHERE location ILIKE '%ottawa%' LIMIT 10`.
- [ ] **Step 11.4: Prod run** (main branch connection string), then the same verification queries against prod, including:
  `SELECT count(*) FROM scraped_jobs WHERE location_search LIKE '%|ottawa|%'` (expect ≈1,060 = the Ottawa variants sampled in the spec).
- [ ] **Step 11.5:** Commit:
  `git add backend/scripts/backfill_locations.py && git commit -m "feat(jobs): one-time structured-location + domain backfill script"`

---

### Task 12: Full verification + ship

**Files:** none new (fixes only)

- [ ] **Step 12.1:** Backend: `python -m pytest backend/tests -q` — compare against Task 0 baseline; no new failures.
- [ ] **Step 12.2:** Frontend: `cd frontend && node node_modules/vitest/vitest.mjs run` — no regressions vs baseline; `npm run build` succeeds.
- [ ] **Step 12.3:** Probe Clearbit liveness (Task 8 Step 8.5): `curl -sI https://logo.clearbit.com/shopify.com | head -1` → keep or drop the provider.
- [ ] **Step 12.4:** Push `main` (includes the pre-existing unpushed docs commit). Wait for the Vercel deploy to go READY (vercel MCP `list_deployments` / `get_deployment`).
- [ ] **Step 12.5:** Post-deploy prod probes:
  - `GET https://www.tailrd.ca/jobs?location=Ottawa&page_size=5` → every row's `locations_json` contains an Ottawa entry; none are Toronto/London-only.
  - `GET https://www.tailrd.ca/jobs/cities?country=CA&q=ot` → Ottawa with a real count.
  - Trigger one manual `workflow_dispatch` of Scrape Jobs (or `curl` cron-ats + cron-backfill with the secret if available) and confirm `descriptions_fixed > 0`.
  - SQL: fresh `ats` rows (`ORDER BY id DESC LIMIT 20`) have `length(description) > 500` for ≥95%.
- [ ] **Step 12.6:** Update memory files (`MEMORY.md` + a new memory) with what shipped and any follow-ups (Clearbit decision, backfill drain rate).
