"""
North America location classifier: is a job's location in the US or Canada,
and which one?

One function answers both questions so the ATS crawler's NA filter
(ats_scraper._is_north_america), the retire verdict board crawls act on
(ats_scraper.ATSScraper.rejection) and the ``country`` column every ingest
path stores (job_country) can never disagree. The aggregator's CountryFilter
(GitHub lists) still has its own rules.

Evidence is ranked, strongest first:

1. A country the source states: SmartRecruiters' trailing lowercase ISO code
   ("Madrid, MD, es", "Bangalore, in"), a country code where codes sit
   ("GB-London", "IN: Lilly Bengaluru", "Dublin, IE", "Toronto, ON, CAN",
   "US"), a country or region name ("United States", "Canada", "England",
   "EMEA").
2. A US state / Canadian province: a full name ("Ontario", "Michigan") or a
   2-letter code where a code sits (after a comma, "XX - City", "US-CA-City",
   closing a segment: "Mobile AL"). "Dublin OR London" is not Oregon. A code
   that is also a foreign ISO/region code yields to a city of that place:
   "Bangalore, IN" (India), "Amsterdam, NH" (Noord-Holland), "Meerane, DE"
   (Germany; DE beside neither a German nor a Delaware place says nothing).
   A segment that opens with a foreign country ("QAT - Al Udeid AB, Qatar")
   has no state or province codes.
3. A known North American city name ("Toronto", "San Francisco"), whole words.
4. A known foreign city name ("London", "Paris").
5. "Remote" with nothing else: North America.

A listing with strong NA evidence (1-2) stays even beside a foreign country:
"New York, NY; London, UK" is open in New York. A foreign country or region
beats a bare NA city ("Waterloo, London, England", "San Jose, Costa Rica",
"Poland - Remote"); a bare NA city beats a bare foreign city.

FOREIGN is a retire verdict (a board crawl hides a stored row on it), so it
needs positive evidence and yields to anything that could still mean North
America: a posting also open "Americas", "Global" or "Worldwide" is unknown,
never foreign. So is a 2-letter foreign code outside the places a country
code sits ("Calgary - 13th Ave SE", "Remote - PT"), unless a foreign city
backs it.
"""

from __future__ import annotations

import re
import unicodedata
from typing import NamedTuple, Optional

US = "US"
CA = "CA"

US_STATE_CODES = {
    "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA",
    "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD",
    "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ",
    "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC",
    "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY", "DC",
}
CA_PROVINCE_CODES = {
    "ON", "QC", "BC", "AB", "MB", "SK", "NS", "NB", "NL", "PE",
    "NT", "YT", "NU",
}

US_STATE_NAMES = (
    "alabama", "alaska", "arizona", "arkansas", "california", "colorado",
    "connecticut", "delaware", "florida", "georgia", "hawaii", "idaho",
    "illinois", "indiana", "iowa", "kansas", "kentucky", "louisiana", "maine",
    "maryland", "massachusetts", "michigan", "minnesota", "mississippi",
    "missouri", "montana", "nebraska", "nevada", "new hampshire", "new jersey",
    "new mexico", "new york", "north carolina", "north dakota", "ohio",
    "oklahoma", "oregon", "pennsylvania", "rhode island", "south carolina",
    "south dakota", "tennessee", "texas", "utah", "vermont", "virginia",
    "washington", "west virginia", "wisconsin", "wyoming",
    "district of columbia", "new england",
)
CA_PROVINCE_NAMES = (
    "ontario", "quebec", "british columbia", "alberta", "manitoba",
    "saskatchewan", "nova scotia", "new brunswick", "newfoundland",
    "prince edward island", "northwest territories", "yukon", "nunavut",
)

# Whole-word city names. Deliberately NOT here: "london" (London, UK on nearly
# every board; London, Ontario still passes as "London, ON" / "London,
# Ontario" / "..., Canada", or from a board whose registry entry says CA).
US_CITIES = (
    "new york", "nyc", "san francisco", "los angeles", "chicago", "seattle",
    "austin", "boston", "denver", "atlanta", "dallas", "houston",
    "miami", "philadelphia", "phoenix", "san diego", "san jose",
    "portland", "minneapolis", "detroit", "pittsburgh", "raleigh",
    "charlotte", "nashville", "salt lake city", "washington",
    "mountain view", "palo alto", "sunnyvale", "cupertino",
    "menlo park", "redmond", "bellevue", "irvine", "santa monica",
    "brooklyn", "manhattan",
    "los gatos", "burbank", "las vegas", "king of prussia",
)
CA_CITIES = (
    "toronto", "vancouver", "montreal", "ottawa", "calgary",
    "edmonton", "winnipeg", "quebec", "hamilton", "kitchener",
    "waterloo", "mississauga", "brampton", "markham",
    "victoria", "halifax", "burnaby", "richmond",
    "gatineau", "kanata", "scarborough", "north york", "etobicoke",
    "vaughan", "richmond hill", "oakville", "burlington", "guelph",
    "saskatoon", "regina", "fredericton", "moncton", "kelowna",
    "windsor", "laval", "longueuil", "sherbrooke", "barrie",
)
# Canadian cities that are also common US ones (Richmond VA, Burlington VT,
# Hamilton OH, Windsor CT, Victoria TX, Waterloo IA). Named alone they still
# place a posting in North America, but not in a country: job_country leaves
# a stored or client-sent country alone on them.
_US_NAMESAKE_CA_CITIES = frozenset({
    "richmond", "burlington", "hamilton", "windsor", "victoria", "waterloo",
})
# Canadian cities that make an ISO "CA" suffix mean Canada ("Toronto, CA").
# Not Richmond/Windsor/Hamilton/Burlington/Victoria: also California towns.
_ISO_CA_CITIES = (
    "toronto", "montreal", "ottawa", "calgary", "edmonton", "winnipeg",
    "mississauga", "waterloo", "kitchener", "markham", "brampton", "vancouver",
    "halifax", "quebec", "gatineau", "saskatoon", "regina", "burnaby",
)

# Foreign countries and regions: strong evidence. Left out on purpose because
# a location can name them alone as North American places: Georgia (the
# state), Jersey, Jamaica (Queens), Lebanon (IN/PA/NH), Jordan, Palestine
# (TX), Holland (MI), Puerto Rico (a US territory).
FOREIGN_NAMES = (
    "united kingdom", "great britain", "britain", "england", "scotland",
    "wales", "northern ireland", "ireland", "u.k.", "uk", "eu", "bermuda",
    "emea", "europe", "european union", "apac", "apj", "asia", "asia pacific",
    "latam", "latin america", "south america", "central america",
    "middle east", "mena", "africa", "oceania", "anz", "nordics", "dach",
    "benelux",
    "germany", "deutschland", "france", "spain", "espana", "portugal",
    "italy", "italia", "netherlands", "belgium", "luxembourg", "switzerland",
    "austria", "poland", "polska", "czech republic", "czechia", "slovakia",
    "hungary", "romania", "bulgaria", "greece", "cyprus", "malta", "sweden",
    "norway", "denmark", "finland", "iceland", "estonia", "latvia",
    "lithuania", "ukraine", "belarus", "russia", "serbia", "croatia",
    "slovenia", "bosnia", "montenegro", "albania", "north macedonia",
    "moldova", "armenia", "azerbaijan", "kazakhstan", "uzbekistan", "turkey",
    "turkiye", "israel", "egypt", "morocco", "tunisia", "nigeria", "kenya",
    "ghana", "south africa", "ethiopia", "rwanda", "uganda", "zambia", "uae",
    "united arab emirates", "saudi arabia", "ksa", "qatar", "bahrain",
    "kuwait", "oman", "pakistan", "india", "bangladesh", "sri lanka", "nepal",
    "china", "hong kong", "macau", "taiwan", "japan", "south korea", "korea",
    "singapore", "malaysia", "indonesia", "philippines", "vietnam",
    "viet nam", "thailand", "cambodia", "australia", "new zealand", "mexico",
    "brazil", "brasil", "argentina", "chile", "colombia", "peru", "ecuador",
    "uruguay", "paraguay", "bolivia", "venezuela", "costa rica", "panama",
    "guatemala", "honduras", "el salvador", "nicaragua", "dominican republic",
)

# Big foreign cities: weak evidence, decisive only against "Remote" or a bare
# NA city. Each is named alone far more often than any North American
# namesake (which would carry its state: "Dublin, OH", "Paris, TX").
FOREIGN_CITIES = (
    "london", "paris", "berlin", "munich", "hamburg", "frankfurt", "cologne",
    "stuttgart", "dusseldorf", "amsterdam", "rotterdam", "utrecht",
    "eindhoven", "the hague", "brussels", "antwerp", "madrid", "barcelona",
    "lisbon", "porto", "milan", "zurich", "geneva", "copenhagen", "stockholm",
    "oslo", "helsinki", "warsaw", "krakow", "wroclaw", "gdansk", "prague",
    "budapest", "bucharest", "cluj", "sofia", "tallinn", "riga", "vilnius",
    "kyiv", "kiev", "lviv", "belgrade", "zagreb", "ljubljana", "bratislava",
    "istanbul", "tel aviv", "herzliya", "haifa", "dubai", "abu dhabi",
    "riyadh", "doha", "bangalore", "bengaluru", "hyderabad", "pune",
    "mumbai", "chennai", "gurgaon", "gurugram", "noida", "new delhi",
    "kolkata", "ahmedabad", "tokyo", "osaka", "seoul", "shanghai", "beijing",
    "shenzhen", "hangzhou", "guangzhou", "taipei", "sydney", "brisbane",
    "auckland", "sao paulo", "rio de janeiro", "mexico city", "guadalajara",
    "monterrey", "bogota", "medellin", "buenos aires", "manila", "cebu",
    "ho chi minh", "hanoi", "kuala lumpur", "jakarta", "bangkok",
    "cape town", "johannesburg", "lagos", "nairobi", "edinburgh", "belfast",
    "cork", "galway", "limerick", "leeds", "glasgow", "dublin", "athens",
)

# 2-letter codes that are a US state / CA province AND a foreign country's ISO
# code or a foreign region's code. The code is foreign when its segment names
# a place there: "Bangalore, IN", "IL - Petah Tikva", "Amsterdam, NH"
# (Noord-Holland), "Eindhoven, NB" (Noord-Brabant), "Chennai, TN" (Tamil
# Nadu), "Barcelona, CT" (Catalonia), "Perth, WA" (Western Australia).
_FOREIGN_CODE_PLACES = {
    "IN": ("india", "bangalore", "bengaluru", "pune", "hyderabad", "chennai",
           "mumbai", "bombay", "delhi", "new delhi", "gurgaon", "gurugram",
           "noida", "kolkata", "ahmedabad", "jaipur", "chandigarh", "kochi",
           "coimbatore", "trivandrum", "thiruvananthapuram", "mysore",
           "mysuru", "vadodara", "nagpur", "indore", "maharashtra",
           "karnataka", "telangana", "telengana", "tamil nadu", "kerala",
           "gujarat", "haryana", "uttar pradesh", "sriperumbudur", "hosur", "chakan",
           "manesar", "aurangabad", "nashik", "visakhapatnam", "bhubaneswar",
           "lucknow", "goa", "mangalore", "surat"),
    "IL": ("israel", "tel aviv", "tel-aviv", "herzliya", "haifa", "jerusalem",
           "petah tikva", "petach tikva", "raanana", "ra'anana", "netanya",
           "yokneam", "beer sheva", "rehovot", "caesarea", "hod hasharon",
           "kfar saba", "ramat gan", "airport city", "modiin"),
    "CO": ("colombia", "bogota", "medellin", "cali", "barranquilla",
           "cartagena", "bucaramanga"),
    "AR": ("argentina", "buenos aires", "cordoba", "rosario", "mendoza"),
    "PE": ("peru", "lima", "arequipa", "cusco", "trujillo", "recife"),
    "MA": ("morocco", "casablanca", "rabat", "tanger", "tangier", "kenitra",
           "marrakech", "marrakesh", "fes", "fez", "agadir", "meknes",
           "oujda", "tetouan", "sao luis"),
    "NL": ("netherlands", "amsterdam", "rotterdam", "utrecht", "the hague",
           "den haag", "eindhoven", "delft", "leiden", "groningen", "haarlem",
           "nijmegen", "breda", "tilburg", "arnhem", "maastricht",
           "hoofddorp", "schiphol", "amstelveen", "almere", "veldhoven",
           "zwolle", "enschede", "venlo", "lgnh", "monterrey", "apodaca",
           "san nicolas de los garza", "escobedo"),
    "NH": ("amsterdam", "haarlem", "hoofddorp", "amstelveen", "zaandam",
           "alkmaar", "hilversum", "schiphol", "purmerend", "den helder"),
    "NB": ("eindhoven", "breda", "tilburg", "den bosch", "s-hertogenbosch",
           "helmond", "veldhoven", "oss", "roosendaal"),
    "UT": ("utrecht", "nieuwegein", "amersfoort", "zeist", "veenendaal"),
    "FL": ("almere", "lelystad"),
    "SK": ("slovakia", "bratislava", "kosice", "kechnec", "zilina", "nitra",
           "trnava", "presov", "trencin", "banska bystrica", "poprad"),
    "ID": ("indonesia", "jakarta", "surabaya", "bandung", "bali", "batam",
           "denpasar", "yogyakarta"),
    "MT": ("malta", "valletta", "sliema", "st julian", "msida", "birkirkara",
           "gzira", "mosta", "cuiaba"),
    "MD": ("moldova", "chisinau", "madrid", "alcobendas", "getafe", "leganes",
           "las rozas", "pozuelo", "tres cantos", "alcala de henares",
           "mostoles", "fuenlabrada"),
    "CT": ("barcelona", "sant cugat", "terrassa", "sabadell", "badalona",
           "hospitalet", "girona", "tarragona", "lleida", "martorell",
           "castellbisbal"),
    "ME": ("montenegro", "podgorica"),
    "AL": ("albania", "tirana", "maceio"),
    "AZ": ("azerbaijan", "baku"),
    "MN": ("mongolia", "ulaanbaatar"),
    "PA": ("panama", "belem"),
    "SC": ("joinville", "florianopolis", "blumenau", "pomerode",
           "jaragua do sul", "itajai"),
    "TN": ("chennai", "coimbatore", "gangaikondan", "sriperumbudur", "hosur",
           "madurai", "trichy", "tiruchirappalli", "rajapathi"),
    "WA": ("australia", "perth", "fremantle", "mandurah", "greenfields",
           "bunbury", "joondalup", "karratha", "port hedland", "kalgoorlie",
           "wedgefield"),
    "NT": ("darwin",),
    "GA": ("vigo", "a coruna", "santiago de compostela"),
    "BC": ("tijuana", "mexicali", "ensenada", "baja california"),
}
# "DE" is Delaware beside a Delaware place and Germany beside a German one
# (Magna and Pinterest write "Meerane, DE", "Hamburg, DE"). Beside neither
# ("Remote, DE", "Lincoln, DE") the location is unknown: not Germany, which
# would retire the row, and not a North American place either.
_DELAWARE_PLACES = (
    "delaware", "wilmington", "newark", "dover", "middletown", "new castle",
    "lewes", "georgetown", "smyrna", "milford", "seaford", "claymont",
    "hockessin", "bear", "rehoboth", "greenville", "christiana", "elsmere",
    "harrington", "laurel", "millsboro", "selbyville", "camden", "clayton",
    "delaware city", "newport", "townsend", "frederica", "felton",
    "ocean view", "bethany beach", "dagsboro", "delmar", "bridgeville",
    "milton", "cheswold", "magnolia", "glasgow", "pike creek", "talleyville",
)
# Every German place the boards wrote beside "DE"/"de" in the 2026-09 crawls
# and prod (Magna's and Bosch's plants, Pinterest, Snowflake), plus the big
# cities.
_GERMAN_PLACES = (
    "germany", "deutschland", "berlin", "munich", "muenchen", "munchen",
    "hamburg", "frankfurt", "cologne", "koeln", "koln", "stuttgart",
    "dusseldorf", "duesseldorf", "leipzig", "dresden", "hannover", "nuremberg",
    "nuernberg", "nurnberg", "bremen", "essen", "dortmund", "bonn", "mannheim",
    "karlsruhe", "wiesbaden", "mainz", "heidelberg", "ingolstadt", "wolfsburg",
    "regensburg", "augsburg", "wuppertal", "salzgitter", "assamstadt",
    "elsendorf", "heilbad heiligenstadt", "hoesbach", "kerpen", "markt schwaben",
    "meerane", "neuenstadt am kocher", "neuenstein", "sailauf", "schleiz",
    "schwaebisch gmuend", "schwabisch gmund", "soest", "untergruppenbach",
    "veitsbronn", "waldshut-tiengen", "troisdorf", "lohr am main", "homburg",
    "gunzenhausen", "grossmehring", "großmehring", "gerlingen", "feuerbach",
    "eschenburg", "chemnitz", "bochum",
)

# ISO country codes (2 and 3 letters) that are not a US state / CA province.
# Only read where a code sits ("Dublin, IE", "GB-London", "UK - Remote",
# "Singapore, SGP"), never mid-phrase.
FOREIGN_CODES = {
    "UK", "GB", "IE", "FR", "ES", "PT", "IT", "BE", "LU", "CH", "AT", "PL",
    "CZ", "HU", "RO", "BG", "GR", "SE", "NO", "DK", "FI", "EE", "LV", "LT",
    "UA", "RS", "HR", "SI", "TR", "AE", "SA", "QA", "EG", "ZA", "NG", "KE",
    "PK", "BD", "LK", "CN", "HK", "TW", "JP", "KR", "SG", "MY", "PH", "VN",
    "TH", "AU", "NZ", "MX", "BR", "CL", "UY", "CR", "GT", "EU",
    "GBR", "IRL", "DEU", "FRA", "ESP", "PRT", "ITA", "NLD", "BEL", "CHE",
    "AUT", "POL", "CZE", "HUN", "ROU", "SWE", "NOR", "DNK", "FIN", "ISR",
    "ARE", "IND", "CHN", "HKG", "TWN", "JPN", "KOR", "SGP", "MYS", "IDN",
    "PHL", "VNM", "THA", "AUS", "NZL", "MEX", "BRA", "ARG", "CHL", "COL",
    "PER", "CRI", "ZAF", "KWT", "QAT", "SAU", "UKR", "TUR", "BHR", "OMN",
    "EGY", "GRC", "BGR", "HRV", "SRB", "SVK", "SVN", "LTU", "LVA", "CYP",
    "PAK", "BGD", "LKA", "NGA", "KAZ", "URY", "GTM",
    "EMEA", "APAC", "LATAM",
}
_US_CODES = {"US", "USA"}
_CA_CODES = {"CAN"}

# ISO 3166-1 alpha-2, for SmartRecruiters' trailing lowercase country ("...,
# es"). Only a real country code is read as one: a lowercase province or state
# written by some other source ("Toronto, on", "Austin, tx") is not a country
# and falls through to the ordinary rules instead of reading as foreign.
_ISO_ALPHA2 = frozenset("""
ad ae af ag ai al am ao aq ar as at au aw ax az ba bb bd be bf bg bh bi bj bl
bm bn bo bq br bs bt bv bw by bz ca cc cd cf cg ch ci ck cl cm cn co cr cu cv
cw cx cy cz de dj dk dm do dz ec ee eg eh er es et fi fj fk fm fo fr ga gb gd
ge gf gg gh gi gl gm gn gp gq gr gs gt gu gw gy hk hm hn hr ht hu id ie il im
in io iq ir is it je jm jo jp ke kg kh ki km kn kp kr kw ky kz la lb lc li lk
lr ls lt lu lv ly ma mc md me mf mg mh mk ml mm mn mo mp mq mr ms mt mu mv mw
mx my mz na nc ne nf ng ni nl no np nr nu nz om pa pe pf pg ph pk pl pm pn pr
ps pt pw py qa re ro rs ru rw sa sb sc sd se sg sh si sj sk sl sm sn so sr ss
st sv sx sy sz tc td tf tg th tj tk tl tm tn to tr tt tv tw tz ua ug um us uy
uz va vc ve vg vi vn vu wf ws ye yt za zm zw
""".split())
# US territories: a trailing "pr"/"gu"/"vi" is not a foreign country either.
_ISO_US_TERRITORIES = frozenset({"pr", "gu", "vi", "as", "mp", "um"})

# A location segment that leaves North America open whatever else the text
# names: a posting "Home Based - Americas; Home based - EMEA" or "Remote -
# Global" may well be filled in Toronto. It never makes a location North
# American (the NA filter still wants evidence), but it stops a FOREIGN
# verdict, the one that retires. The whole segment must be the phrase (work
# mode words aside): "IE: Global Business Solutions - Cork" and "Ukraine
# Anywhere" stay foreign.
_OPEN_WORLD_SEGMENT = re.compile(
    r"(?:the )?(?:americas|global|globally|worldwide|world wide|anywhere)(?: in the world)?"
)
_MODE_WORDS = re.compile(
    r"(?<![a-z0-9])(?:remote|hybrid|home based|home-based|office based|work from home"
    r"|wfh|flexible|full[- ]time|part[- ]time)(?![a-z0-9])"
)


def _names_the_world(folded_segment: str) -> bool:
    residue = _MODE_WORDS.sub(" ", folded_segment)
    residue = re.sub(r"[^a-z]+", " ", residue).strip()
    return bool(residue) and bool(_OPEN_WORLD_SEGMENT.fullmatch(residue))


def _fold(value: str) -> str:
    decomposed = unicodedata.normalize("NFKD", value or "")
    return "".join(ch for ch in decomposed if not unicodedata.combining(ch))


def _words_regex(words) -> re.Pattern:
    alternation = "|".join(sorted((re.escape(w) for w in words), key=len, reverse=True))
    return re.compile(rf"(?<![a-z0-9])(?:{alternation})(?![a-z0-9])")


_US_STATE_NAME_RE = _words_regex(US_STATE_NAMES + ("d.c.",))
_CA_PROVINCE_NAME_RE = _words_regex(CA_PROVINCE_NAMES)
_US_CITY_RE = _words_regex(US_CITIES)
_CA_CITY_RE = _words_regex(CA_CITIES)
_ISO_CA_CITY_RE = _words_regex(_ISO_CA_CITIES)
_FOREIGN_CITY_RE = _words_regex(FOREIGN_CITIES)
_DELAWARE_RE = _words_regex(_DELAWARE_PLACES)
_GERMAN_RE = _words_regex(_GERMAN_PLACES)
_FOREIGN_CODE_PLACE_RES = {code: _words_regex(names) for code, names in _FOREIGN_CODE_PLACES.items()}
# "New Mexico"/"New England"/"New South Wales" are not Mexico/England/Wales.
_FOREIGN_NAME_RE = re.compile(
    r"(?<![a-z0-9])(?<!new )(?<!new south )(?:"
    + "|".join(sorted((re.escape(w) for w in FOREIGN_NAMES), key=len, reverse=True))
    + r")(?![a-z0-9])"
)
# "USA1" (a pay zone) is still the US; "NAMER"/"NORAM" = North America.
_US_NAME_RE = re.compile(
    r"(?<![a-z0-9])(?:united states|u\.s\.a\.?|u\.s\.|usa\d?|north america|namer|noram)(?![a-z0-9])"
)
_CA_NAME_RE = re.compile(r"(?<![a-z0-9])canada(?![a-z0-9])")
# Tbilisi/Batumi name Georgia the country, not the state.
_GEORGIA_COUNTRY_RE = re.compile(r"(?<![a-z])(?:tbilisi|batumi|kutaisi)(?![a-z])")
# "San José" with the accent is Costa Rica's capital (P&G, Roche, Mastercard
# boards); San Jose, California is written without it.
_SAN_JOSE_CR_RE = re.compile("san josé", re.IGNORECASE)
# SmartRecruiters: "city, region, country" or "city, country" with the country
# a lowercase ISO code ("Madrid, MD, es", "Budapest, hu"). Every such string
# in the 2026-09 crawl (2,788 listings) came from SmartRecruiters, and the
# posting's own country field agreed with the code on all 2,786 that had one.
# Any source can write a state in lowercase, though, so a two-part "city, cc"
# whose cc is also a state or province code is no country by itself: "Boston,
# ma" is not Morocco. It is foreign only beside a place of that country
# ("coimbatore, in", "Casablanca, ma"), and never North American either:
# SmartRecruiters' "telengana, in" is not Indiana.
_SR_COUNTRY = re.compile(r"[a-z]{2}")
_NA_CODES_LOWER = frozenset(code.lower() for code in US_STATE_CODES | CA_PROVINCE_CODES)
_TRAILING_LOWER_CODE = re.compile(r",\s*([a-z]{2})\s*$")
_REMOTE = re.compile(r"\bremote\b|\bteletravail\b")

# Lowercase "or"/"and" separate alternatives; uppercase "OR" only before a
# capitalised word ("Dublin OR London"), never "Portland, OR 97201".
_SEGMENT_SPLIT = re.compile(r"[;\n|•]+|\s+/\s+|\s+(?:or|and)\s+|\s+OR\s+(?=[A-Z][a-z])")
_CODE = re.compile(r"(?<![A-Za-z0-9])([A-Z]{2,4})(?![A-Za-z0-9])")
_COUNTRY_PREFIX = re.compile(r"(?:^|[\s,(-])(?:US|USA|CA|CAN)\s*-?\s*$")
_SEPARATORS_BEFORE = ",(;/|:&"
_SEPARATORS_AFTER = ",);/|:&-("
# A segment that opens with a foreign country ("QAT - Al Udeid AB, Qatar",
# "IT - Milano, MI", "Germany - Holzdorf AB"): its own country is stated, so a
# state/province-like code further on is something else (an Air Base, an
# Italian province).
_PREFIX = re.compile(r"\s*([A-Za-z][A-Za-z .]*?)\s*(?:-|:)")
# Parsons' location bullets put the country first ("CA - ON, Oakville", "US -
# CA, Pasadena"), so its Canadian remote roles read "CA - Remote (Any
# Location)". California's remote roles are "Remote - CA" or "US - CA".
_CA_REMOTE_BULLET = re.compile(r"\s*CA\s+-\s+Remote\b(?:\s*\([^)]*\))?\s*")


def _sr_country(text: str) -> str:
    """SmartRecruiters' trailing lowercase ISO country ("es" in "Madrid, MD,
    es"), or "" when the text is not that shape."""
    if text.isupper():
        return ""
    parts = text.split(",")
    code = parts[-1].strip()
    if len(parts) < 2 or not _SR_COUNTRY.fullmatch(code) or code not in _ISO_ALPHA2:
        return ""
    if len(parts) >= 3 or code not in _NA_CODES_LOWER:
        return code
    return ""


def _lowercase_state_is_foreign(head: str, code: str) -> bool:
    """For "city, cc" with cc a lowercase state/province code: the country of
    that ISO code, when the city is one of its places ("coimbatore, in")."""
    places = _GERMAN_RE if code == "de" else _FOREIGN_CODE_PLACE_RES.get(code.upper())
    return places is not None and bool(places.search(head.lower()))


def _foreign_prefixed(segment: str) -> bool:
    prefix = _PREFIX.match(segment)
    if not prefix:
        return False
    word = prefix.group(1).strip()
    return word in FOREIGN_CODES or bool(_FOREIGN_NAME_RE.fullmatch(word.lower()))


def _strong_foreign_position(text: str, start: int, end: int) -> bool:
    """A 2-letter foreign code (read where codes sit) is a country only after a
    comma, closing its segment ("Dublin, IE", "Milano, IT (Hybrid)"), or as
    the segment's prefix ("GB-London", "IE: Cork", "UK - Remote"). Elsewhere
    it may be a street quadrant ("13th Ave SE"), a department ("Bank St
    (IT)") or part-time ("Remote - PT"), so it never retires a row alone."""
    b = text[:start].rstrip()
    a = text[end:].lstrip()
    if b.endswith(","):
        return not a or a[0] in ",;)(|/&-" or a[0].isdigit()
    if not b:
        return bool(a) and (a[0] in "-:" or text[end:].startswith("  "))
    return False


def _code_in_position(text: str, start: int, end: int) -> bool:
    """A 2-4 letter uppercase token reads as a code only where codes sit:
    after a comma/paren/semicolon, as a "XX-"/"XX - "/"XX:" prefix, after a
    "US-"/"CA-"/"US " country prefix, or closing a segment ("Mobile AL")."""
    before = text[:start]
    after = text[end:]
    b = before.rstrip()
    a = after.lstrip()
    # Workday strips dashes into runs of spaces: "Kamloops BC   Battle St".
    # A country code after it closes a code too: "Granby QC CAN", "CA USA".
    after_ok = ((not a) or a[0] in _SEPARATORS_AFTER or a[0].isdigit() or after.startswith("  ")
                or bool(re.match(r"(?:US|USA|CAN)(?![A-Za-z])", a)))
    next_word = re.match(r"([A-Z]{3,})(?![A-Za-z])", a)
    if next_word and next_word.group(1) not in ("USA", "CAN"):
        # "France, LA CHAPELLE SAINT AUBIN": a word of an all-caps name.
        return False
    if b and b[-1] in _SEPARATORS_BEFORE:
        return True
    if b and _COUNTRY_PREFIX.search(b):
        return True  # "US-CA-Menlo Park", "US WV Summit Point", "CA ON Ottawa"
    if not b:
        # "CA - San Francisco", "GB-London", "IN: Lilly Bengaluru", "US WV ..."
        return (after_ok or after.startswith("-") or a.startswith("- ")
                or bool(re.match(r"[A-Z]{2,3}(?![A-Za-z])", a)))
    if b.endswith("-"):
        return after_ok or after.startswith("-") or a.startswith("- ")  # "Remote - OR"
    last_word = re.search(r"([A-Za-z]+)$", b)
    if text[start:end] == "DC" and last_word and last_word.group(1).isupper():
        # "ATHENS DC", "PRAGUE DC (2 Locations)": P&G's distribution-centre
        # sites, not Washington. Only DC: after an all-caps city any other
        # code is still its state or province ("LONDON ON", "PORTLAND OR"),
        # and "WASHINGTON DC" keeps the state name.
        return False
    # "Indianapolis IN", "Mobile AL", "London ON (2 Locations)": a code
    # closing its segment. Not "Dublin OR London", "Seattle, WA OR New York".
    return after_ok and not (a and a[0] in "-:&")


def _segment_markers(segment: str, folded_segment: str):
    """Yield (strength, country) for one segment: strength > 0 is NA evidence
    (3 a stated country, 2 a state/province), -3 a foreign country/region,
    -1 a code that may or may not be foreign: a 2-letter foreign code away
    from where country codes sit ("13th Ave SE"), a "DE" beside neither a
    Delaware nor a German place."""
    foreign_prefixed = _foreign_prefixed(segment)
    for m in _CODE.finditer(segment):
        code = m.group(1)
        if code in _US_CODES:
            yield 3, US  # "US"/"USA" as an uppercase word is the country anywhere
            continue
        if code in _CA_CODES:
            yield 3, CA  # "REMOTETELETRAVAIL QC CAN (9 Locations)", "KOHO (CAN)"
            continue
        if not _code_in_position(segment, m.start(), m.end()):
            continue
        if code == "NA":
            yield 3, US  # "Remote - NA, APAC, EMEA": North America
        elif code in FOREIGN_CODES:
            strong = len(code) > 2 or _strong_foreign_position(segment, m.start(), m.end())
            yield (-3, None) if strong else (-1, None)
        elif len(code) == 2 and (code in US_STATE_CODES or code in CA_PROVINCE_CODES):
            if foreign_prefixed:
                continue  # "QAT - Al Udeid AB, Qatar": an Air Base, not Alberta
            if code == "DE":
                if _DELAWARE_RE.search(folded_segment):
                    yield 2, US
                else:
                    yield (-3, None) if _GERMAN_RE.search(folded_segment) else (-1, None)
                continue
            places = _FOREIGN_CODE_PLACE_RES.get(code)
            if places is not None and places.search(folded_segment):
                yield -3, None
            elif code in CA_PROVINCE_CODES:
                yield 2, CA
            elif code == "CA" and _CA_REMOTE_BULLET.fullmatch(segment):
                yield 2, CA  # Parsons: "CA - Remote (Any Location)"
            elif code == "CA" and (
                any(not _names_us_city(segment, folded_segment, p)
                    for p in _CA_PROVINCE_NAME_RE.finditer(folded_segment))
                or re.search(r"(?<![A-Za-z])(?:ON|QC|BC|AB|MB|SK|NS|NB|NL|PE|NT|YT|NU)(?![A-Za-z])", segment)
                or _ISO_CA_CITY_RE.search(folded_segment)
            ):
                yield 2, CA  # ISO "CA" = Canada: "Toronto, ON, CA", "CA-Ontario-Toronto"
            elif code == "CA":
                # California, most likely, but only weakly: JobSpy writes
                # Indeed's Canadian "Remote" as "Remote, CA" (ISO Canada).
                yield 1, US
            else:
                yield 2, US
    for _ in _US_NAME_RE.finditer(folded_segment):
        yield 3, US
    for _ in _CA_NAME_RE.finditer(folded_segment):
        yield 3, CA
    for _ in _FOREIGN_NAME_RE.finditer(folded_segment):
        yield -3, None
    for m in _US_STATE_NAME_RE.finditer(folded_segment):
        if m.group(0) == "georgia" and _GEORGIA_COUNTRY_RE.search(folded_segment):
            yield -3, None
        else:
            yield 2, US
    for m in _CA_PROVINCE_NAME_RE.finditer(folded_segment):
        yield (2, US) if _names_us_city(segment, folded_segment, m) else (2, CA)


def _names_us_city(segment: str, folded_segment: str, province: re.Match) -> bool:
    """"Ontario, CA" / "New Brunswick, NJ": a US city named after a province
    (the name opens the segment; "Milton, Ontario, CA" is the province)."""
    if folded_segment[:province.start()].strip(" -("):
        return False
    state = re.match(r"\s*,\s*([A-Z]{2})(?![A-Za-z])", segment[province.end():])
    return bool((state and state.group(1) in US_STATE_CODES)
                or _US_STATE_NAME_RE.match(folded_segment[province.end():].lstrip(" ,")))


FOREIGN = "foreign"


class _Reading(NamedTuple):
    verdict: Optional[str]  # region_of's answer
    named: frozenset        # NA countries a stated country/state/province names
    ambiguous: bool         # the only NA evidence is a bare "CA" code
    namesake: bool = False  # ...or a bare city both countries have ("Richmond")


def _read(location: str) -> _Reading:
    """region_of's answer, plus what job_country needs to leave a stored
    value alone: the North American countries the text names by a stated
    country, a state or a province, and whether the verdict rests only on a
    bare "CA" that could be California or ISO Canada ("Remote, CA") or on a
    bare city both countries have ("Waterloo"). One pass over the text."""
    if not location or not location.strip():
        return _Reading(None, frozenset(), False)
    if "🇺🇸" in location:
        return _Reading(US, frozenset({US}), False)
    if "🇨🇦" in location:
        return _Reading(CA, frozenset({CA}), False)
    text = _fold(location).strip()

    # A structured trailing country (SmartRecruiters) is authoritative.
    code = _sr_country(text)
    if code:
        if code in ("us", "ca"):
            return _Reading(code.upper(), frozenset({code.upper()}), False)
        return _Reading(None if code in _ISO_US_TERRITORIES else FOREIGN, frozenset(), False)
    foreign = False
    lowercase_state = _TRAILING_LOWER_CODE.search(text)
    if lowercase_state and lowercase_state.group(1) in _NA_CODES_LOWER:
        foreign = _lowercase_state_is_foreign(text[:lowercase_state.start()],
                                              lowercase_state.group(1))
        text = text[:lowercase_state.start()]
    folded = text.lower()

    na: set[str] = set()
    strong: set[str] = set()
    maybe_foreign = False
    open_world = False
    for segment in _SEGMENT_SPLIT.split(text):
        folded_segment = segment.lower()
        open_world = open_world or _names_the_world(folded_segment)
        for strength, country in _segment_markers(segment, folded_segment):
            if strength > 0:
                na.add(country)
                if strength > 1:
                    strong.add(country)
            elif strength < -1:
                foreign = True
            else:
                maybe_foreign = True
    named = frozenset(na)
    if na:
        # "Irvine, CA" is California by its city; "Remote, CA" says nothing.
        ambiguous = not strong and not _US_CITY_RE.search(folded)
        return _Reading(CA if CA in na else US, named, ambiguous)

    if foreign or _SAN_JOSE_CR_RE.search(location):
        return _Reading(None if open_world else FOREIGN, named, False)

    cities = [(m.start(), CA, m.group(0)) for m in _CA_CITY_RE.finditer(folded)]
    cities += [(m.start(), US, m.group(0)) for m in _US_CITY_RE.finditer(folded)]
    if cities:
        if maybe_foreign:
            # "Calgary - 13th Ave SE", "Victoria (AU)": unknown, never foreign.
            return _Reading(None, named, False)
        plain = [city for city in cities if city[2] not in _US_NAMESAKE_CA_CITIES]
        return _Reading(min(plain or cities)[1], named, False, namesake=not plain)
    if _FOREIGN_CITY_RE.search(folded):
        return _Reading(None if open_world else FOREIGN, named, False)
    if maybe_foreign:
        return _Reading(None, named, False)  # "Remote - PT", "Remote (NO)"
    if _REMOTE.search(folded):
        return _Reading(US, named, False)
    return _Reading(None, named, False)


def region_of(location: str) -> Optional[str]:
    """"US", "CA", FOREIGN (the text names a place outside both), or None
    when it says nothing either way ("", "2 Locations", "Hybrid").

    Reconciliation retires a stored row only on FOREIGN: an unknown location
    ("3 Locations" on a Workday posting that also lists Toronto) is not
    evidence that the job left North America."""
    return _read(location).verdict


def classify_north_america(location: str) -> Optional[str]:
    """"US" or "CA" when the location is in the US or Canada, else None.

    A listing open in both countries is "CA", as CountryFilter always had it."""
    region = region_of(location)
    return region if region in (US, CA) else None


def is_north_america(location: str) -> bool:
    return classify_north_america(location) is not None


def hint_region(hint: str) -> Optional[str]:
    """"US"/"CA" for a Workday URL slug ("Toronto-ON", "IL-Rosemont",
    "USA---Hill-AFB-UT", "San-Jose"), else None. Read as written first (a
    dash marks where a code sits) and then with dashes as spaces (city names).
    A slug that names a foreign place, read either way, or ends in a foreign
    country code vouches for nothing: "United-Kingdom---Remote" is not
    "Remote", "PRAGUE-DC" is not Washington and "San-Pedro-Garza-Garcia-NL-MX"
    is not Newfoundland.
    Never FOREIGN: a slug names one location of several, so it can only ever
    vouch for a posting, not retire one."""
    spaced = (hint or "").replace("-", " ")
    tokens = spaced.split()
    if (FOREIGN in (region_of(hint or ""), region_of(spaced))
            or (tokens and tokens[-1] in FOREIGN_CODES)):
        return None
    for text in (hint or "", spaced):
        region = classify_north_america(text)
        if region:
            return region
    return None


def job_country(location: str, board_country: str = "", *, hint: str = "",
                current: str = "", fallback: str = US) -> str:
    """The ``country`` column for a row, shared by every ingest path (cron-ats
    inserts, the crawl's refresh of known rows, /jobs/ingest-batch, and the
    cron-backfill repair) so they can never drift apart:

    1. the registry's country for a one-country board (BDO Canada's bare
       "London" is Ontario, its "Remote" is Canada);
    2. what the location says (region_of): "Toronto" is CA, "Calgary,
       Alberta, Canada" is CA even when a scraper sent "US";
    3. a Workday slug ``hint`` when the location is only "3 Locations";
    4. ``fallback``: "US" for a crawled row (it passed the NA filter), the
       client's value for an aggregator row.

    A location naming BOTH countries ("Remote (United States | Canada)")
    keeps a ``current`` US/CA value: either is right, and flipping it every
    pass would only churn. A new row gets "CA", as CountryFilter always did.
    So does one whose only evidence is a bare "CA": "Remote, CA" is
    California on a US board and Canada in JobSpy's Indeed rows, so a stored
    (or client-sent) value is not overruled on it; a new row gets "US". A
    bare city both countries have ("Richmond", "Waterloo") places the row in
    neither: the hint, then a ``current`` value, then ``fallback`` decides.
    """
    if board_country:
        return board_country
    reading = _read(location)
    if reading.verdict in (US, CA):
        if reading.namesake:
            return hint_region(hint) or (current if current in (US, CA) else fallback)
        if current in (US, CA) and (reading.ambiguous or reading.named >= {US, CA}):
            return current
        return reading.verdict
    return hint_region(hint) or fallback
