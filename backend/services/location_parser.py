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

# No bare "ca" key on purpose: "CA" is claimed by the region branch
# (California) and a trailing "…, ON, CA" still lands on Canada via
# _finish()'s region inference.
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
        return _finish(ParsedLocation(city=_titleize(metro.group(1))))

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
