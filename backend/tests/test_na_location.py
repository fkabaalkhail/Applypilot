"""The US/Canada location classifier behind the ATS NA filter, the retire
verdict board crawls act on, and the country column every ingest path stores.

Every string below is a real location from a crawled board or a prod row
(2026-09-28 audit), with the country the board or its posting detail states.
"""

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from backend.services.ats_scraper import ATSScraper
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
    ("Bangalore", None),     # never foreign: a hint only vouches
    ("", None),
])
def test_hint_region(hint, country):
    assert hint_region(hint) == country


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


def test_job_country_falls_back_to_the_hint_then_the_caller():
    assert job_country("3 Locations", hint="Toronto-ON") == "CA"
    assert job_country("3 Locations") == "US"
    assert job_country("Hybrid", fallback="CA") == "CA"
    # A foreign location never picks a country; the caller's value stands.
    assert job_country("London, UK", fallback="CA") == "CA"
    # LinkedIn's Canadian cards whatever the client sent.
    assert job_country("Calgary, Alberta, Canada", fallback="US") == "CA"
