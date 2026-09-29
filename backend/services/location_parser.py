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

from backend.services.na_location import CA_CITIES as NA_CA_CITIES
from backend.services.na_location import FOREIGN, FOREIGN_CODES, region_of
from backend.services.na_location import US_CITIES as NA_US_CITIES

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
# Every city name we know: the parser's and the NA filter's.
_NAMED_CITIES = KNOWN_CITIES | set(NA_US_CITIES) | set(NA_CA_CITIES)

_CA_POSTAL = re.compile(r"^[A-Za-z]\d[A-Za-z]\s?\d[A-Za-z]\d$")
_US_ZIP = re.compile(r"^\d{5}(-\d{4})?$")
_PLUS_MORE = re.compile(r"\(\s*\+?\d+\s*more\s*\)", re.IGNORECASE)
# Workday's list payload says "15 Locations" for a multi-location posting. It
# names no place: parsed word-wise it became the city "15", and the feed card
# (labelled from the parsed locations) would show "15" as the job's place. No
# location instead, so the card falls back to the raw "15 Locations" text.
_LOCATION_COUNT = re.compile(r"^\d+\s+locations?$", re.IGNORECASE)
_PARENTHETICAL = re.compile(r"\([^)]*\)")
# "CA-San Francisco", "US-NY-New York", "Canada-Toronto": a country or region
# code joined to the place by a dash (_peel_code_prefix). The short country
# codes count only in capitals.
_CODE_PREFIX = re.compile(r"^([A-Za-z]{2,6})\s*-\s*(?=\S)")
_PREFIX_COUNTRIES = {"US": "US", "USA": "US", "CAN": "CA", "canada": "CA"}
_COUNTRY_NAMES = {"US": "United States", "CA": "Canada"}
_METRO = re.compile(
    r"^(?:greater\s+)?(.+?)\s+(?:metropolitan\s+area|metro\s+area|area)$",
    re.IGNORECASE,
)
# "Calgary   8th Ave SW", a numbered street after the city is address junk.
# The number requirement keeps "St. Louis" (no digits) intact.
_STREET_SUFFIX = re.compile(
    r"\s+\d+\w*\s+(?:ave|avenue|street|st|blvd|boulevard|rd|road|dr|drive|way|hwy|highway)\b.*$",
    re.IGNORECASE,
)
_NOISE_TOKENS = {
    "downtown", "hybrid", "onsite", "on-site", "flexible", "multiple locations",
    "various", "n/a", "tbd", "hq", "headquarters", "office", "locations",
}
# Countries with multi-word names that legitimately trail a "City, Country"
# token; anything else multi-word ("San Francisco") is a city, not a country.
_MULTIWORD_COUNTRIES = {
    "czech republic", "united kingdom", "new zealand", "south korea",
    "south africa", "costa rica", "puerto rico", "hong kong", "saudi arabia",
    "united arab emirates",
}
# Multi-word country aliases, longest first, for stripping segment tails.
_ALIAS_TAILS = sorted(
    (alias.split(" ") for alias in _COUNTRY_ALIASES if " " in alias),
    key=len,
    reverse=True,
)


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
    if (folded in _REGION_BY_NAME and _REGION_BY_NAME[folded] == loc.region
            and folded not in _NAMED_CITIES):
        # "CA-ON - Ontario - Toronto": the region again, not a city ("New
        # York, New York" and "Quebec, Quebec" name one).
        return

    folded_words = folded.split(" ")
    if "remote" in folded_words:
        # "Remote", "Remote in US", "Remote in Canada"
        if not loc.city:
            loc.city = "Remote"
        for extra in folded_words:
            if extra in _COUNTRY_ALIASES and not loc.country:
                loc.country = _COUNTRY_ALIASES[extra]
        return

    if loc.city and folded == fold(loc.city):
        return  # "Kraków, Kraków, Poland", duplicated city token

    if not loc.city:
        # "Toronto Canada" as ONE comma token: peel a trailing country word.
        words = stripped.split(" ")
        if len(words) >= 2 and fold(words[-1]) in _COUNTRY_ALIASES:
            loc.city = _titleize(" ".join(words[:-1]))
            if not loc.country:
                loc.country = _COUNTRY_ALIASES[fold(words[-1])]
            return
        loc.city = _titleize(stripped)
    elif not loc.country and not is_region_code and len(stripped) > 3:
        # Trailing-token country guess ("Kraków, Kraków, Poland"). Only a
        # single proper word or a known multi-word country qualifies,
        # "San Francisco" in a comma city-list must not become a country.
        if (" " not in stripped and folded not in KNOWN_CITIES) or folded in _MULTIWORD_COUNTRIES:
            loc.country = _titleize(stripped)


def _finish(loc: ParsedLocation) -> ParsedLocation:
    if not loc.country and loc.region:
        loc.country = "Canada" if loc.region in CA_PROVINCES else "United States"
    return loc


def _peel_code_prefix(segment: str, country: str) -> tuple[ParsedLocation | None, str]:
    """Split a code-prefixed place ("CA-San Francisco", PwC's state-city
    form; "US-NY-New York"; "Canada-Toronto") into its prefix, as a seed
    ParsedLocation, and the rest. ``country`` ("US"/"CA") is what positive
    evidence says the place is in, and decides whether a leading "CA" is
    California or Canada ("IN" alone could be Indiana or India, so nothing
    is peeled without it). (None, segment) when there is no prefix."""
    seed = ParsedLocation()
    rest = segment
    while True:
        m = _CODE_PREFIX.match(rest)
        if not m:
            break
        word = m.group(1)
        named = _PREFIX_COUNTRIES.get(word) or _PREFIX_COUNTRIES.get(word.lower())
        if word == "CA" and country == "CA":
            named = "CA"
        codes = US_STATES if country == "US" else CA_PROVINCES if country == "CA" else {}
        if named and seed.country in ("", _COUNTRY_NAMES[named]):
            country, seed.country = named, _COUNTRY_NAMES[named]  # "US-USA-Remote"
        elif word.isupper() and word in codes and not seed.region:
            seed.region, seed.region_name = word, codes[word]
        else:
            break
        rest = rest[m.end():]
    if rest == segment:
        return None, segment
    return seed, rest


def _fill_from(loc: ParsedLocation, seed: ParsedLocation) -> None:
    """Give ``loc`` the region and country a code prefix named, where empty."""
    if not loc.region and seed.region:
        loc.region, loc.region_name = seed.region, seed.region_name
    loc.country = loc.country or seed.country


def _classify_prefixed(rest: str, loc: ParsedLocation) -> None:
    """The place after a code prefix: a city even when it shares a state's
    name ("US-New York", "DC-Washington"); an address ("ON-81 Bay Street")
    is not one."""
    place = rest.strip(" .")
    if place[:1].isdigit():
        return
    if not loc.city and fold(place) in KNOWN_CITIES:
        loc.city = _titleize(place)
        return
    _classify_token(rest, loc)


def _parse_segment(segment: str, country: str = "") -> list[ParsedLocation]:
    segment = _PLUS_MORE.sub(" ", segment)
    segment = _PARENTHETICAL.sub(" ", segment)
    segment = _STREET_SUFFIX.sub(" ", segment)
    # A colon after a mode word is a separator: "Remote: United States".
    segment = segment.replace(":", ", ")
    segment = segment.replace(" - ", ", ").replace(" – ", ", ")
    segment = re.sub(r"\s+", " ", segment).strip(" ,;-")
    if not segment or _LOCATION_COUNT.match(segment):
        return []

    if country and "," not in segment:
        seed, rest = _peel_code_prefix(segment, country)
        if seed is not None:
            head = rest.split("-", 1)[0].strip()
            if fold(head) in KNOWN_CITIES:
                rest = head  # "US-IL-Chicago-MSO": the office after the city
            if "-" in rest and not rest[:1].isdigit():
                # "US-Alabama-Ozark": the usual parse of "Alabama-Ozark",
                # the prefix filling what it left empty.
                locs = _parse_segment(rest) or [ParsedLocation()]
                _fill_from(locs[0], seed)
                locs[0] = _finish(locs[0])
                return locs if (locs[0].city or locs[0].region or locs[0].country) else []
            # The rest is the place itself, read with the prefix's region
            # already set, so "DC-Washington" is a city, not a state.
            _classify_prefixed(rest, seed)
            return [_finish(seed)]

    metro = _METRO.match(segment)
    if metro:
        return [_finish(ParsedLocation(city=_titleize(metro.group(1))))]

    # Taleo hierarchy format "Ontario-Cochrane-Detour Lake" (Region-District-
    # Site, no spaces around dashes). Only when the FIRST dash part is a known
    # region, hyphenated city names (Winston-Salem) must survive.
    if "," not in segment and "-" in segment and " - " not in segment:
        dash_parts = [p.strip() for p in segment.split("-") if p.strip()]
        if len(dash_parts) >= 2 and fold(dash_parts[0]) in _REGION_BY_NAME:
            code = _REGION_BY_NAME[fold(dash_parts[0])]
            region_name = CA_PROVINCES.get(code) or US_STATES.get(code, "")
            return [
                _finish(ParsedLocation(
                    city=_titleize(part), region=code, region_name=region_name,
                ))
                for part in dash_parts[1:]
            ]

    if "," in segment:
        # Usually "City, Region, Country", but aggregators also emit comma
        # city-LISTS ("Toronto Canada, San Francisco, …"): a known city token
        # arriving after the city slot is filled starts a new location.
        # So does a code-prefixed token ("US-Chicago, US-Atlanta").
        locs: list[ParsedLocation] = []
        current = ParsedLocation()
        for token in segment.split(","):
            seed, token = _peel_code_prefix(token.strip(), country) if country else (None, token)
            folded_tok = fold(token.strip(" ."))
            if current.city and (seed is not None or (
                    folded_tok in KNOWN_CITIES and folded_tok != fold(current.city))):
                locs.append(_finish(current))
                current = ParsedLocation()
            if seed is not None:
                _fill_from(current, seed)
                _classify_prefixed(token, current)
            else:
                _classify_token(token, current)
        if current.city or current.region or current.country:
            locs.append(_finish(current))
        return locs

    words = [w for w in segment.split(" ") if w.strip()]

    # Peel a trailing multi-word country name ("… United States") so the
    # word-wise pass doesn't scatter it ("United" city, "States" dropped),
    # or file a bare "United States" (one alternative of "United States |
    # Canada") as a city.
    tail_country = ""
    for alias_words in _ALIAS_TAILS:
        n = len(alias_words)
        if len(words) >= n and [fold(w) for w in words[-n:]] == alias_words:
            tail_country = _COUNTRY_ALIASES[" ".join(alias_words)]
            words = words[:-n]
            break

    if len(words) > 4:
        # Likely contaminated (a title leaked into the field). Rescue a
        # known city + any region code; drop the rest.
        loc = ParsedLocation(country=tail_country)
        folded_seg = fold(" ".join(words))
        for city in sorted(KNOWN_CITIES, key=len, reverse=True):
            if re.search(rf"(?:^|[^a-z]){re.escape(city)}(?:[^a-z]|$)", folded_seg):
                loc.city = _titleize(city)
                break
        for word in words:
            cleaned = word.strip(" .")
            if (cleaned.isupper() and not loc.region
                    and (cleaned in CA_PROVINCES or cleaned in US_STATES)):
                loc.region = cleaned
                loc.region_name = CA_PROVINCES.get(cleaned) or US_STATES.get(cleaned, "")
        if not loc.city and not loc.region:
            return []
        return [_finish(loc)]

    # Short comma-less segment ("CA ON Ottawa", "New York", "Remote"):
    # classify word-wise. Two-letter region codes must be UPPERCASE in the
    # source, lowercase "or"/"on"/"in" are English words, not Oregon/Ontario/
    # Indiana. A bare "CA" with a real province elsewhere is Canada.
    loc = ParsedLocation(country=tail_country)
    rest: list[str] = []
    for word in words:
        cleaned = word.strip(" .")
        folded_word = fold(cleaned)
        if folded_word in _NOISE_TOKENS or _CA_POSTAL.match(cleaned) or _US_ZIP.match(cleaned):
            continue
        if cleaned == "CA" and any(
            w.strip(" .").upper() in CA_PROVINCES and w.strip(" .").isupper()
            for w in words if w is not word
        ):
            loc.country = loc.country or "Canada"
        elif (cleaned.isupper() and not loc.region
                and (cleaned in CA_PROVINCES or cleaned in US_STATES)):
            loc.region = cleaned
            loc.region_name = CA_PROVINCES.get(cleaned) or US_STATES.get(cleaned, "")
        elif folded_word in _REGION_BY_NAME and not loc.region:
            code = _REGION_BY_NAME[folded_word]
            loc.region = code
            loc.region_name = CA_PROVINCES.get(code) or US_STATES.get(code, "")
        elif folded_word in _COUNTRY_ALIASES and not loc.country:
            loc.country = _COUNTRY_ALIASES[folded_word]
        elif folded_word == "remote" and not rest:
            loc.city = "Remote"
        else:
            rest.append(word)
    if rest:
        loc.city = _titleize(" ".join(rest))
    if not loc.city and not loc.region and not loc.country:
        return []
    return [_finish(loc)]


def parse_locations(raw: str, country: str = "") -> list[ParsedLocation]:
    """Parse a raw scraped location string into structured locations.
    ``country`` ("US"/"CA", only from positive evidence: a one-country
    board, na_location's reading) lets a code-prefixed place read as its
    region and city ("CA-San Francisco" is California on a US row)."""
    if not raw or not raw.strip():
        return []
    # " / " and lowercase " or " separate alternatives ("US / Canada",
    # "Ottawa or Calgary ON"). Lowercase-only: uppercase "OR" is Oregon.
    # (Yes, this would split "Truth or Consequences, NM"; the catalogue is
    # intern/new-grad tech jobs, the trade is worth it.) "|" joins a board's
    # multi-location list ("San Francisco, CA | New York City, NY") like ";"
    # does, except inside parentheses: "Remote (United States | Canada)"
    # keeps its pipe, and the segment parse drops the parenthetical whole.
    segments = re.split(r"[;\n•]+|\|(?![^()]*\))|\s+/\s+|\s+or\s+", raw)
    out: list[ParsedLocation] = []
    seen: set[tuple[str, str, str]] = set()
    for segment in segments:
        for loc in _parse_segment(segment, country):
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


def is_location_count(raw: str) -> bool:
    """Whether a location is only Workday's count of places ("10 Locations")."""
    return bool(_LOCATION_COUNT.match((raw or "").strip()))


def location_fields(raw: str, country: str = "") -> dict:
    """Column values for ScrapedJob(**fields), shared by every ingest path.
    ``country`` as for parse_locations."""
    locs = parse_locations(raw or "", country)
    if not locs:
        return {"city": "", "region": "", "locations_json": [], "location_search": ""}
    return {
        "city": fold(locs[0].city),
        "region": locs[0].region,
        "locations_json": [asdict(l) for l in locs],
        "location_search": location_search_blob(locs),
    }


# ─── Workday path slugs ──────────────────────────────────────────────────────
# A Workday posting listed as "3 Locations" names its primary location only
# in its path, every space and separator turned into a dash: "Toronto-ON",
# "Mountain-View-CA-USA", "USA---Hazelwood-MO", "IL-Rosemont",
# "New-York-NY---225-Liberty-Street". A run of dashes starts a new part; a
# single dash is a space inside a name or a separator, told apart by the
# region codes and names around it.

_SLUG_PARTS = re.compile(r"-{2,}")
# A whole part that is only a sales region: "AMER---Canada---Ontario---...".
_SLUG_AREA_PARTS = {"amer", "americas", "emea", "apac", "latam", "noram"}
# Trailing words naming a site, not the city: "Chicago-Metro", "DALLAS-OFFICE",
# Autodesk's "Colorado---OffsiteHome".
_SLUG_SITE_WORDS = {"metro", "area", "office", "campus", "hq", "plant", "site", "offsitehome"}
# Workday drops non-ASCII letters: "Montréal" -> "Montral".
_SLUG_FIXUPS = {"montral": "Montreal", "qubec": "Quebec"}
# Names spelled out in another form: BMO's "VILLE-DE-QUEBEC-QC-CAN".
_SLUG_PHRASES = {("ville", "de", "quebec"): ("Quebec", "City")}
# A word that goes on naming the place after a city we know ("Chicago-
# Heights", "Miami-Beach"), where any other word names a site in it:
# Lumentum's "USA---CA---San-Jose-Ridder" is its Ridder Park site in San Jose.
_PLACE_NAME_WORDS = {
    "bay", "beach", "center", "centre", "city", "court", "creek", "crossing",
    "estates", "falls", "gardens", "grove", "hall", "harbor", "harbour",
    "heights", "hill", "hills", "island", "junction", "lake", "lakes",
    "locks", "mill", "mills", "park", "ridge", "shores", "springs",
    "station", "township", "twp", "valley", "village",
}
# ((folded words), value) entries, longest first.
_SLUG_COUNTRY_WORDS = {
    "US": ((("united", "states", "of", "america"), "US"), (("united", "states"), "US"),
           (("usa",), "US"), (("us",), "US")),
    "CA": ((("canada",), "CA"), (("can",), "CA"), (("ca",), "CA")),
}
_SLUG_REGION_NAMES = {
    country: sorted(((tuple(name.lower().split()), code) for code, name in codes.items()),
                    key=lambda entry: len(entry[0]), reverse=True)
    for country, codes in (("US", US_STATES), ("CA", CA_PROVINCES))
}
# Cities a slug may name with no region ("Los-Angeles", "Ottawa-Canada").
_SLUG_KNOWN_CITIES = _NAMED_CITIES | {"remote"}


def _slug_match(words: list[str], at: int, entries) -> tuple[int, str]:
    """(length, value) of the longest entry starting at ``words[at]``,
    (0, "") for none."""
    for entry, value in entries:
        if tuple(w.lower() for w in words[at:at + len(entry)]) == entry:
            return len(entry), value
    return 0, ""


def _slug_country_run(words: list[str], at: int, countries) -> int:
    """Where the run of country words starting at ``at`` ends."""
    while at < len(words):
        k, _ = _slug_match(words, at, countries)
        if not k:
            break
        at += k
    return at


def _scan_slug_part(words: list[str], country: str, first: bool) -> tuple[list[str], str]:
    """(city words, region code) of one part of a slug."""
    codes = US_STATES if country == "US" else CA_PROVINCES
    countries = _SLUG_COUNTRY_WORDS[country]
    names = _SLUG_REGION_NAMES[country]

    def is_code(word: str) -> bool:
        return word in codes and word.isupper()

    i, region = 0, ""
    # Leading country words and region codes ("USA-IL-Chicago", "IL-Rosemont"),
    # and a site number at the very start ("3572-Macon-GA").
    while i < len(words):
        k, _ = _slug_match(words, i, countries)
        if k:
            i += k
        elif is_code(words[i]) and not region:
            region, i = words[i], i + 1
        elif first and i == 0 and words[i].isdigit():
            i += 1
        else:
            break
    # A region name, then nothing but country words ("California---San-
    # Francisco") or a remote marker ("Texas-Remote").
    k, code = _slug_match(words, i, names)
    if k:
        rest = words[_slug_country_run(words, i + k, countries):]
        if not rest:
            return [], region or code
        if len(rest) == 1 and rest[0].lower().startswith("remote"):
            return ["Remote"], region or code
    city: list[str] = []
    while i < len(words) and not words[i][:1].isdigit():
        if city:
            if is_code(words[i]):
                return city, region or words[i]
            k, code = _slug_match(words, i, names)
            if k:
                return city, region or code
            if _slug_match(words, i, countries)[0]:
                break
        city.append(words[i])
        i += 1
    return city, region


def _slug_words(part: str) -> list[str]:
    """The words of one slug part, with Workday's spellings fixed up."""
    words = [_SLUG_FIXUPS.get(w.lower(), w) for w in part.split("-") if w]
    out: list[str] = []
    i = 0
    while i < len(words):
        for phrase, name in _SLUG_PHRASES.items():
            if tuple(w.lower() for w in words[i:i + len(phrase)]) == phrase:
                out.extend(name)
                i += len(phrase)
                break
        else:
            out.append(words[i])
            i += 1
    return out


def _known_city_head(city: list[str]) -> list[str]:
    """A city we know at the head of ``city`` when the words after it name a
    site, not more of the place ("San Jose Ridder" is San Jose; "Chicago
    Heights" stays whole). ``city`` itself when there is none."""
    for k in range(len(city) - 1, 0, -1):
        if (fold(" ".join(city[:k])) in _NAMED_CITIES
                and city[k].lower() not in _PLACE_NAME_WORDS):
            return city[:k]
    return city


def _slug_names_foreign_place(slug: str, city: str) -> bool:
    """Whether a slug names a place outside the US and Canada, read as
    na_location.hint_region reads one: foreign as written or with dashes as
    spaces, or ending in a foreign code. A city we know here is set aside
    first, so BDO Canada's bare "London" is London, Ontario, while
    "London-UK" and "London---United-Kingdom" stay foreign."""
    rest = slug or ""
    if fold(city) in _SLUG_KNOWN_CITIES:
        words = r"[-\s]+".join(re.escape(word) for word in fold(city).split())
        rest = re.sub(rf"(?<![A-Za-z]){words}(?![A-Za-z])", "-", rest, count=1,
                      flags=re.IGNORECASE)
    spaced = rest.replace("-", " ")
    tokens = spaced.split()
    if tokens and tokens[-1] in FOREIGN_CODES:
        return True
    return FOREIGN in (region_of(rest), region_of(spaced))


def parse_location_slug(slug: str, country: str) -> ParsedLocation | None:
    """The primary location a Workday path slug names, or None when it names
    none we can trust. ``country`` ("US"/"CA", from positive evidence: the
    slug's own na_location reading, a one-country board) decides which
    region codes and names count ("CA" is California on a US slug, Canada
    on a Canadian one); the caller has none for a slug that names no North
    American place ("Sailauf-DE"), so that one is never read as Delaware.
    Nor is a slug that names a foreign place read with a one-country
    board's registry country: "IN-Bengaluru" on a US board is not Indiana,
    "PRAGUE-DC" not Washington. A city with no region must be one we know
    ("Los-Angeles", "Remote-USA"), so a company or site name
    ("TELUS-CAN-BC-510-...") never becomes one."""
    if country not in _SLUG_COUNTRY_WORDS:
        return None
    city: list[str] = []
    region = ""
    placed = False           # a part before this one named the country or region
    site_may_follow = False  # the city's part came after such a part
    for index, part in enumerate(_SLUG_PARTS.split(slug or "")):
        words = _slug_words(part)
        if not words or (not city and len(words) == 1 and words[0].lower() in _SLUG_AREA_PARTS):
            continue
        if index and words[0][:1].isdigit():
            break  # "Toronto---100-Adelaide-St-W": the address
        part_city, part_region = _scan_slug_part(words, country, first=index == 0)
        if city and part_city:
            break  # a site after the city: "Toronto---Bay-St"
        if part_city:
            # The city's own region beats an earlier part's:
            # "Maryland---Washington-DC-Metro" is Washington, DC.
            city, region = part_city, part_region or region
            site_may_follow = placed
        else:
            region = region or part_region
            placed = True
    while city and city[-1].lower() in _SLUG_SITE_WORDS:
        city.pop()
    if site_may_follow and fold(" ".join(city)) not in _SLUG_KNOWN_CITIES:
        # "USA---CA---San-Jose-Ridder", "Canada---Ottawa-Bill-Leathem": the
        # country and region come first, then the city and its site.
        city = _known_city_head(city)
    if len(city) == 1 and (city[0].lower().startswith("remote") or city[0].lower() == "virtual"):
        city = ["Remote"]  # "REMOTETELETRAVAIL-ON-CAN", BMO's "Virtual-IL-USA"
    if city and city[0] == "St":
        city[0] = "St."  # "St-Louis-MO", as "St. Louis, MO" parses
    name = _titleize(" ".join(city))
    if name and not region and fold(name) not in _SLUG_KNOWN_CITIES:
        return None
    if not name and not region:
        return None
    if _slug_names_foreign_place(slug, name):
        return None  # a board's country is no reason to read it as one of ours
    loc = ParsedLocation(city=name, region=region,
                         region_name=US_STATES.get(region) or CA_PROVINCES.get(region, ""))
    if not region:
        loc.country = _COUNTRY_NAMES[country]
    return _finish(loc)


def hint_location_fields(slug: str, country: str) -> dict:
    """city/region/location_search from a Workday path slug, for a row whose
    own location names no place ("3 Locations"), so the city filter can find
    it; {} when the slug names none we can trust (parse_location_slug). No
    locations_json: the card keeps its "3 Locations" text rather than pass
    the primary location off as the only one."""
    loc = parse_location_slug(slug, country)
    if loc is None:
        return {}
    return {"city": fold(loc.city), "region": loc.region,
            "location_search": location_search_blob([loc])}
