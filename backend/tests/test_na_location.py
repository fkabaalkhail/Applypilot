"""The US/Canada location classifier behind the ATS NA filter, the retire
verdict board crawls act on, and the country column every ingest path stores.

Every string below is a real location from a crawled board or a prod row
(2026-09-28 audit), with the country the board or its posting detail states.
"""

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from backend.services.ats_scraper import ATSJob, ATSScraper
from backend.services.na_location import (
    FOREIGN,
    FOREIGN_NAMES,
    classify_north_america,
    hint_region,
    job_country,
    region_of,
)


@pytest.mark.parametrize("location, country", [
    # State / province codes where codes sit
    ("San Francisco, CA", "US"),
    ("Indianapolis, IN", "US"),
    ("US, Indianapolis IN", "US"),
    ("Albion, IN, us", "US"),
    ("Denver, CO - Hybrid", "US"),
    ("Chicago, IL; Denver, CO; Westlake, TX", "US"),
    ("Boise, ID United States", "US"),
    ("Portland, OR 97201", "US"),
    ("Remote - OR", "US"),
    ("Wilmington, DE", "US"),
    ("DE - Greenville", "US"),
    ("US-CA-Menlo Park", "US"),
    ("US WV   Summit Point", "US"),
    ("CA - San Francisco; WA - Seattle; NY - New York City", "US"),
    ("Washington DC", "US"),
    ("Mountain View, CA USA", "US"),
    ("Toronto, ON", "CA"),
    ("Toronto, ON, CAN", "CA"),
    ("Toronto, ON, CA", "CA"),
    ("St. John's, NL", "CA"),
    ("CA ON Ottawa", "CA"),
    ("CA-Ontario-Toronto", "CA"),
    ("Granby QC CAN (2 Locations)", "CA"),
    ("REMOTETELETRAVAIL QC CAN (9 Locations)", "CA"),
    ("Kamloops BC   Battle St RHS   Respiratory therapy (2 Locations)", "CA"),
    ("Canada - Remote (ON, AB, BC, or NS Only)", "CA"),
    # London, Ontario keeps a province or country marker
    ("London, ON", "CA"),
    ("London, Ontario", "CA"),
    ("London, Ontario, Canada", "CA"),
    ("London ON (2 Locations)", "CA"),
    # Full state / province names (the old filter dropped all of these)
    ("Newaygo, Michigan, US", "US"),
    ("McLean, Virginia", "US"),
    ("Long Beach, California", "US"),
    ("Virginia - Herndon", "US"),
    ("New Mexico", "US"),
    ("Remote - New England", "US"),
    ("Manitoba", "CA"),
    ("Milton, Ontario, CA", "CA"),
    ("Ontario, CA", "US"),              # Ontario, California
    ("New Brunswick, NJ", "US"),
    # Stated countries
    ("United States", "US"),
    ("US", "US"),
    ("USA - Remote", "US"),
    ("*Job Posting Only: USA1", "US"),
    ("North America", "US"),
    ("NAMER", "US"),
    ("Remote - NA, APAC, EMEA", "US"),
    ("KOHO (CAN)", "CA"),
    ("US / Cananda", "US"),
    # Bare cities
    ("Toronto", "CA"),
    ("Kitchener-Waterloo, ON; Toronto, ON", "CA"),
    ("Los Gatos", "US"),
    ("San Francisco HQ", "US"),
    ("NYC (SoHo)", "US"),
    ("San Jose", "US"),
    # Remote with nothing else
    ("Remote", "US"),
    # Open in both countries: Canada, as CountryFilter always had it
    ("Remote (United States | Canada)", "CA"),
    ("New York, NY; Toronto, ON", "CA"),
    # A foreign place beside a US/CA one: the listing is open here
    ("New York, NY; London, UK", "US"),
    ("Seattle, WA OR New York, NY OR Remote North America", "US"),
])
def test_keeps_us_and_canada(location, country):
    assert classify_north_america(location) == country


@pytest.mark.parametrize("location", [
    # London, UK in every shape boards write it
    "London", "London Office", "London, UK", "London, England",
    "London, United Kingdom", "GB-London", "Hybrid - London", "London, GBR",
    "United Kingdom - London", "City of London Corporation, GBR",
    "Waterloo, London, England", "Hackney, London, England",
    "LONDON PLANT-W THURROCK", "EMEA - United Kingdom - London - Agar St",
    # Uppercase OR is not Oregon between two cities
    "Dublin OR London", "London OR Paris OR Germany ",
    "Poland - Remote OR Romania - Remote",
    # "Remote" beside a foreign country or region
    "Poland - Remote", "Remote - Colombia", "Mexico - Remote", "Remote - EMEA",
    "UK Remote", "Remote, Bangalore", "CRI - Remote",
    # ISO country codes read as US states / CA provinces
    "Bangalore, IN", "Bengaluru, IN", "Pune, IN", "IN - Bengaluru",
    "IN: Lilly Bengaluru", "IL - Petah Tikva", "Tel Aviv, IL",
    "Meerane, DE", "Hannover, DE", "DE-Berlin-Trion Building",
    "Amsterdam, NL", "NL: LGNH Utrecht", "Tanger, MA", "Kechnec, SK",
    "Buenos Aires, AR",
    # Foreign region codes read as US states
    "Amsterdam, NH", "Hilversum, NH", "Greenfields WA - Clinics & shops",
    # SmartRecruiters' trailing ISO country
    "Madrid, MD, es", "Joinville, SC, br", "Amsterdam, NH, nl",
    "Gangaikondan, TN, in", "San Francisco, Heredia, cr",
    # Site names, not states
    "ATHENS DC", "PRAGUE DC (2 Locations)", "AL Paris HO - Digital & IT",
    "France, LA CHAPELLE SAINT AUBIN",
    # A US/CA city name inside a foreign place
    "San Jose, Costa Rica", "San José", "Waterloo, Belgium",
    "Dublin, Ireland (Mountain View)", "Melbourne, Victoria, Australia",
    "Tbilisi, Georgia", "Hamilton, Bermuda",
    # Substring accidents of the old filter ("usa" in Busan / Lusaka)
    "South Korea - Busan", "Lusaka,Lusaka,Zambia; Kampala,Kampala,Uganda",
    "", "   ", "Multiple Locations",
])
def test_drops_everything_else(location):
    assert classify_north_america(location) is None


def test_scraper_filter_is_the_classifier():
    scraper = ATSScraper()
    assert scraper._is_north_america("Toronto")
    assert not scraper._is_north_america("Bangalore, IN")


@pytest.mark.parametrize("location, board_country, country", [
    ("Toronto", "", "CA"),        # a bare Canadian city is not "US"
    ("Montreal - 1000 Rue De La Gauchetiere Ouest", "", "CA"),
    ("London", "CA", "CA"),       # BDO Canada's bare "London" is Ontario
    ("Remote", "CA", "CA"),       # a one-country board wins over the default
    ("Austin, TX", "", "US"),
    ("Anywhere", "", "US"),       # only reached after the filter kept the row
])
def test_job_country(location, board_country, country):
    assert job_country(location, board_country) == country


# ─── Issue evidence: the filter's old leaks and drops ───────────────────────

@pytest.mark.parametrize("location, country", [
    ("Carmel, IN", "US"),
    ("Melbourne, FL", "US"),
    ("Manchester, NH", "US"),
    ("Remote - Indiana, USA", "US"),
    ("Remote - Indiana", "US"),       # "india" was a substring of Indiana
    ("Remote - Milwaukee", "US"),     # and "uk" of Milwaukee
    ("Beaverton, OR", "US"),
    ("O'Fallon, Missouri", "US"),
    ("El Segundo, California", "US"),
    ("Santa Clara, California, us", "US"),
    ("Ohio - Columbus", "US"),
    ("SF, NYC, SEA, CHI", "US"),
    ("US - CA, Pasadena", "US"),      # Parsons' location bullet
    ("CA - ON, Oakville", "CA"),
    ("CA   NT Yellowknife", "CA"),
    # An all-caps city keeps its state or province: only "DC" after one is
    # a P&G site name ("ATHENS DC").
    ("LONDON ON", "CA"),
    ("PORTLAND OR", "US"),
    ("WASHINGTON DC", "US"),
    ("TORONTO GO", "CA"),
])
def test_keeps_what_the_old_filter_dropped(location, country):
    assert classify_north_america(location) == country


@pytest.mark.parametrize("location", [
    "Jerusalem, Israel", "Waterloo, London, England", "Remote - Poland",
    "Remote Poland", "Remote - Estonia", "Denmark - Remote", "PRAGUE DC",
    "Hannover, DE", "NL: LGNH Utrecht", "Victoria, Australia",
    "Hamilton, New Zealand", "Remote - LATAM", "Remote - Philippines",
    "Windsor, UK", "Bangalore, in", "Budapest, hu",
])
def test_drops_what_the_old_filter_let_through(location):
    assert classify_north_america(location) is None
    assert region_of(location) == FOREIGN


# ─── region_of: FOREIGN is a retire verdict, so it needs positive evidence ──

@pytest.mark.parametrize("location", [
    "", "   ", "2 Locations", "Hybrid", "Multiple Locations", "Global",
    # A segment that leaves North America open stops a foreign verdict.
    "Home Based - Americas; Home based - EMEA",
    "Home based - Worldwide; Office Based - Taipei, Taiwan",
    "London, UK; Remote - Worldwide",
    # A lowercase code that is not an ISO country is no SmartRecruiters tail.
    "Toronto, on",
    # US territories are not foreign countries either.
    "San Juan, PR, pr",
])
def test_unknown_is_never_foreign(location):
    assert region_of(location) != FOREIGN


@pytest.mark.parametrize("location", [
    # "Global" inside a name is not a region the posting is open to.
    "IE: Global Business Solutions - Cork",
    "Ukraine Anywhere",
    "London, UK",
])
def test_open_world_words_must_be_the_whole_segment(location):
    assert region_of(location) == FOREIGN


@pytest.mark.parametrize("location", ["Toronto, on", "Vancouver, bc"])
def test_lowercase_province_is_not_read_as_a_country_code(location):
    assert region_of(location) == "CA"


_NA_WORDS = {"us", "usa", "canada"}
_foreign_name = st.sampled_from(sorted(n for n in FOREIGN_NAMES if n not in _NA_WORDS))
_place = st.from_regex(r"[A-Z][a-z]{3,9}", fullmatch=True).filter(
    lambda word: region_of(word) is None)


@settings(max_examples=150, deadline=None)
@given(place=_place, country=_foreign_name)
def test_a_foreign_country_without_na_evidence_is_foreign(place, country):
    """Any place named with a foreign country or region, and nothing North
    American beside it, is rejected by the filter and retirable."""
    for location in (f"{place}, {country.title()}", f"Remote - {country.title()}"):
        assert classify_north_america(location) is None, location
        assert region_of(location) == FOREIGN, location


# ─── Workday path hints ──────────────────────────────────────────────────────

@pytest.mark.parametrize("hint, country", [
    ("Toronto-ON", "CA"),
    ("IL-Rosemont", "US"),
    ("USA---Hill-AFB-UT", "US"),
    ("San-Jose", "US"),
    ("Mississauga-Ontario", "CA"),
    ("Dublin-OH", "US"),
    ("VILLE-DE-QUEBEC-QC-CAN", "CA"),
    ("Bangalore", None),     # never foreign: a hint only vouches
    ("", None),
])
def test_hint_region(hint, country):
    assert hint_region(hint) == country


# Live Workday slugs (autodesk, pg, magna) and their dashed kin: a foreign
# name split by dashes, a site code after a dash, a trailing country code.
_FOREIGN_SLUGS = [
    "United-Kingdom---Remote", "Hong-Kong---Remote", "New-Zealand-Remote",
    "Costa-Rica-Remote", "Saudi-Arabia---Remote", "Tel-Aviv-Remote",
    "Sao-Paulo-Remote", "Kuala-Lumpur-Remote", "PRAGUE-DC", "ATHENS-DC",
    "San-Pedro-Garza-Garcia-NL-MX",
]


@pytest.mark.parametrize("hint", _FOREIGN_SLUGS)
def test_a_foreign_slug_never_vouches(hint):
    assert hint_region(hint) is None
    job = ATSJob(title="Software Engineer Intern", company="Acme", location="3 Locations",
                 url="https://acme.wd1.myworkdayjobs.com/x", location_hint=hint)
    assert ATSScraper().rejection(job) == "unplaced"
    assert job_country("3 Locations", hint=hint) == "US"  # the caller's fallback, not the slug


# ─── A 2-letter foreign code away from where country codes sit ──────────────

@pytest.mark.parametrize("location", [
    "Medicine Hat - 13th Ave SE (RHS) - Respiratory therapy",  # Air Liquide, live
    "Calgary - 13th Ave SE",
    "Grand Rapids - 28th St SE",
    "Minneapolis, SE Main St",
    "Ottawa - Bank St (IT)",
    "Victoria (AU)",
    "Remote - PT",
    "Remote - SE",
    "Remote (NO)",
])
def test_a_code_out_of_place_is_unknown_never_foreign(location):
    assert region_of(location) is None
    job = ATSJob(title="Software Engineer Intern", company="Acme", location=location, url="u")
    assert ATSScraper().rejection(job) == "unplaced"


@pytest.mark.parametrize("location", [
    "Dublin, IE", "Zug, CH", "Milano, IT (Hybrid)", "GB-London", "IE: Cork",
    "SA - Riyadh", "Stockholm SE", "Lisbon (PT)", "Remote, GB",
])
def test_a_code_where_codes_sit_is_still_foreign(location):
    assert region_of(location) == FOREIGN


# ─── Boeing's overseas bases: "<ISO3> - <Base> AB, <Country>" ───────────────

@pytest.mark.parametrize("location", [
    "QAT - Al Udeid AB, Qatar", "KWT - Al-Mubarak AB, Kuwait",
    "DEU - Holzdorf AB, Germany", "ITA - Viterbo AB, Italy",
    "SAU - Riyadh", "UKR - Kyiv", "IT - Milano, MI",
])
def test_a_foreign_prefix_beats_a_province_like_code(location):
    assert region_of(location) == FOREIGN
    assert job_country(location, current="CA", fallback="US") == "US"  # no CA verdict


@pytest.mark.parametrize("location, country", [
    ("Edmonton, AB", "CA"), ("USA - Dover, DE", "US"), ("CA - ON, Oakville", "CA"),
])
def test_a_north_american_prefix_keeps_its_codes(location, country):
    assert region_of(location) == country


# ─── A lowercase state is not a SmartRecruiters country ─────────────────────

@pytest.mark.parametrize("location, verdict", [
    ("Boston, ma", "US"),            # not Morocco
    ("Chicago, il", "US"),           # not Israel
    ("Atlanta, ga", "US"),           # not Gabon
    ("Los Angeles, ca", "US"),       # not Canada
    ("Indianapolis, in", None),      # not India
    ("Toronto, ca", "CA"),
])
def test_a_two_part_lowercase_state_is_no_country(location, verdict):
    assert region_of(location) == verdict


@pytest.mark.parametrize("location", [
    # SmartRecruiters' own shapes still read their country.
    "Madrid, MD, es", "Budapest, hu", "Hemaraj Plant, Rayong, RAYONG, th",
    # A lowercase state code is foreign beside a place of that country.
    "coimbatore, in", "Petah Tikva, il", "Casablanca, ma", "Dresden, de",
    "telengana, in",  # SmartRecruiters' spelling: India, not Indiana
])
def test_smartrecruiters_countries_still_read(location):
    assert region_of(location) == FOREIGN


# ─── DE: Delaware or Germany, and only on evidence ──────────────────────────

@pytest.mark.parametrize("location", ["Remote, DE", "Lincoln, DE", "Frankford, DE", "DE"])
def test_de_without_a_place_is_unknown(location):
    assert region_of(location) is None


@pytest.mark.parametrize("location, verdict", [
    ("Meerane, DE", FOREIGN), ("Schwaebisch Gmuend, DE", FOREIGN),
    ("Markt Schwaben DE (2 Locations)", FOREIGN), ("Fins Only-DE-Munich-MSO", FOREIGN),
    ("Wilmington, DE", "US"), ("Newport, DE (MEDAL) - Manufacturing - Production", "US"),
])
def test_de_beside_a_place(location, verdict):
    assert region_of(location) == verdict


# ─── Parsons' country-first bullets ──────────────────────────────────────────

def test_parsons_canadian_remote_bullet_is_canada():
    assert region_of("CA - Remote (Any Location)") == "CA"
    assert job_country("CA - Remote (Any Location)", current="US") == "CA"
    assert region_of("US - Remote (Any Location)") == "US"
    # California's remote roles on other boards stay US, and a stored value
    # still stands on the bare "CA".
    assert job_country("Remote - CA") == "US"
    assert job_country("Remote - CA", current="CA") == "CA"


# ─── job_country: one answer for every ingest path ──────────────────────────

def test_job_country_keeps_a_current_value_when_both_countries_are_named():
    both = "Remote (United States | Canada)"
    assert job_country(both) == "CA"                    # a new row, as before
    assert job_country(both, current="US") == "US"      # no churn on a heal
    assert job_country("Toronto, ON", current="US") == "CA"  # one country: fixed


def test_job_country_keeps_a_current_value_on_a_bare_ca():
    """"Remote, CA" is California on a US board and ISO Canada in JobSpy's
    Indeed rows: region_of says US (the NA filter keeps it), but a stored or
    client-sent value is not overruled on it."""
    assert region_of("Remote, CA") == "US"
    assert job_country("Remote, CA") == "US"
    assert job_country("Remote, CA", current="CA") == "CA"
    assert job_country("Pleasanton, CA", current="CA") == "CA"
    # A known city settles it: "Irvine, CA" is California.
    assert job_country("Irvine, CA", current="CA") == "US"


@pytest.mark.parametrize("city", ["Richmond", "Burlington", "Hamilton", "Windsor",
                                  "Victoria", "Waterloo"])
def test_a_bare_us_namesake_city_never_flips_a_country(city):
    """Richmond VA, Burlington VT, Hamilton OH, Windsor CT, Victoria TX and
    Waterloo IA: named alone, the city is North American (the filter keeps
    it) but in no particular country."""
    assert region_of(city) == "CA"
    assert job_country(city, current="US") == "US"
    assert job_country(city, current="CA") == "CA"
    assert job_country(city, fallback="CA") == "CA"   # a client's value
    assert job_country(city) == "US"                  # a new crawled row's default
    assert job_country(city, "CA") == "CA"            # the registry's country
    assert job_country(city, hint="Toronto-ON", current="US") == "CA"
    # Beside anything that places it, the city is Canadian as before.
    assert job_country(f"{city}, ON", current="US") == "CA"
    assert job_country(f"{city}; Toronto", current="US") == "CA"


@pytest.mark.parametrize("location", ["Remote", "Remote - Worldwide", "Remote - North America",
                                      "NA - Remote", "Remote - NA, APAC, EMEA"])
def test_remote_or_north_america_never_flips_a_country(location):
    """Oscar's and Stripe's "Remote" (live 2026-09-29), "Remote - North
    America", "NA - Remote": North American (the filter keeps them) but in
    no particular country, so a stored or client-sent Canada stands."""
    assert region_of(location) == "US"
    assert job_country(location, current="CA") == "CA"
    assert job_country(location, fallback="CA") == "CA"   # a client's value
    assert job_country(location, current="US") == "US"
    assert job_country(location) == "US"                  # a new crawled row's default
    assert job_country(location, "CA") == "CA"            # the registry's country
    assert job_country(location, hint="Toronto", current="US") == "CA"


def test_a_country_or_city_beside_north_america_still_decides():
    assert job_country("Remote - US", current="CA") == "US"
    assert job_country("Remote (Canada)", current="US") == "CA"
    assert job_country("North America - Toronto", current="US") == "CA"
    assert job_country("North America - Seattle", current="CA") == "US"


def test_a_bare_london_never_flips_a_country():
    """London, Ontario or London, UK: a bare "London" reads foreign, which
    places the row in no North American country, so the stored or client
    value stands (the refresh, the repair and ingest-batch pass it as
    ``fallback``)."""
    for current in ("US", "CA"):
        assert job_country("London", current=current, fallback=current) == current
    # An Ashby/Lever posting also open in Toronto takes its country from there.
    assert job_country("London", hint="Toronto", current="US", fallback="US") == "CA"


def test_job_country_falls_back_to_the_hint_then_the_caller():
    assert job_country("3 Locations", hint="Toronto-ON") == "CA"
    assert job_country("3 Locations") == "US"
    assert job_country("Hybrid", fallback="CA") == "CA"
    # A foreign location never picks a country; the caller's value stands.
    assert job_country("London, UK", fallback="CA") == "CA"
    # LinkedIn's Canadian cards whatever the client sent.
    assert job_country("Calgary, Alberta, Canada", fallback="US") == "CA"
