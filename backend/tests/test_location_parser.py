"""Location parser tests seeded with real prod formats (sampled 2026-07-15)."""

import pytest

from backend.services.location_parser import (
    fold,
    location_display,
    location_fields,
    location_search_blob,
    location_tag_tokens,
    parse_location_slug,
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


# --- Real prod strings that misparsed on 2026-07-16 --------------------------

def test_lowercase_or_is_a_separator_not_oregon():
    locs = parse_locations("Ottawa or Calgary ON")
    cities = {l.city for l in locs}
    assert "Ottawa" in cities
    assert "Calgary" in cities
    assert all(l.region != "OR" for l in locs), "lowercase 'or' must never be Oregon"


def test_city_token_with_trailing_country_word():
    loc = first("Toronto Canada, San Francisco, Remote in US, Remote in Canada")
    assert loc.city == "Toronto"
    assert loc.country == "Canada"


def test_comma_separated_city_list_yields_multiple_cities():
    locs = parse_locations("Toronto Canada, San Francisco, Remote in US, Remote in Canada")
    cities = {l.city for l in locs}
    assert "Toronto" in cities
    assert "San Francisco" in cities
    # "San Francisco" must NOT be swallowed as a country.
    assert all(l.country != "San Francisco" for l in locs)


def test_remote_colon_country():
    loc = first("Remote: United States")
    assert loc.city == "Remote"
    assert loc.country == "United States"


def test_street_address_junk_stripped():
    loc = first("Calgary   8th Ave SW (4 Locations)")
    assert loc.city == "Calgary"


def test_slash_separated_countries():
    locs = parse_locations("US / Canada")
    countries = {l.country for l in locs}
    assert countries == {"United States", "Canada"}
    assert all(not l.city or l.city == "Remote" for l in locs)


def test_word_path_recognizes_full_state_names():
    loc = first("Remote   Michigan United States (4 Locations)")
    assert loc.city == "Remote"
    assert loc.region == "MI"
    assert loc.country == "United States"


def test_word_path_city_before_state_name():
    loc = first("Holland Michigan United States (4 Locations)")
    assert loc.city == "Holland"
    assert loc.region == "MI"


def test_uppercase_or_with_comma_still_oregon():
    loc = first("Portland, OR")
    assert (loc.city, loc.region) == ("Portland", "OR")


def test_taleo_hyphen_hierarchy():
    # Taleo careersection format: Region-District-Site, no spaces around dashes.
    locs = parse_locations("Ontario-Cochrane-Detour Lake")
    cities = {l.city for l in locs}
    assert "Cochrane" in cities
    assert "Detour Lake" in cities
    assert all(l.region == "ON" for l in locs)


def test_hyphenated_city_names_survive():
    loc = first("Winston-Salem, NC")
    assert (loc.city, loc.region) == ("Winston-Salem", "NC")


def test_workday_location_count_is_not_a_city():
    # Workday lists a multi-location posting as "15 Locations"; parsed
    # word-wise it became the city "15", which the card would show as the place.
    for raw in ("15 Locations", "2 locations", "1 Location"):
        assert parse_locations(raw) == []
        assert location_fields(raw)["city"] == ""
    # Only a whole segment: a real place beside it still parses.
    assert first("Toronto, ON; 3 Locations").city == "Toronto"


def _matches(tag, raw):
    blob = location_fields(raw)["location_search"]
    return all(f"|{token}|" in blob for token in location_tag_tokens(tag))


def test_pipe_separates_locations_like_a_semicolon():
    # Real prod strings (Anthropic, Greenhouse; 2026-09). Read as one
    # comma list they became "San Francisco, DC": the New York City and
    # Seattle postings never matched those cities' filters.
    raw = "San Francisco, CA | New York City, NY | Seattle, WA"
    locs = parse_locations(raw)
    assert [(l.city, l.region) for l in locs] == [
        ("San Francisco", "CA"), ("New York City", "NY"), ("Seattle", "WA")]
    for tag in ("San Francisco", "New York", "Seattle"):
        assert _matches(tag, raw), tag
    assert _matches("New York", "San Francisco, CA | New York City, NY | Washington, DC")
    both = "Remote-Friendly, United States; San Francisco, CA | New York City, NY"
    assert _matches("San Francisco", both) and _matches("New York", both)
    assert [l.city for l in parse_locations("Toronto, ON | Austin, TX")] == ["Toronto", "Austin"]


def test_pipe_inside_parentheses_is_not_a_separator():
    # 1Password's "Remote (United States | Canada)": the alternatives are
    # the parenthetical, which the segment parse drops.
    assert [(l.city, l.country) for l in parse_locations("Remote (United States | Canada)")] == [
        ("Remote", "")]
    assert [(l.city, l.country) for l in parse_locations(
        "Remote-Friendly (Travel-Required) | San Francisco, CA")] == [
        ("Remote-Friendly", ""), ("San Francisco", "United States")]


def test_bare_multiword_country_is_a_country_not_a_city():
    assert [(l.city, l.country) for l in parse_locations("United States | Canada")] == [
        ("", "United States"), ("", "Canada")]


def _places(raw, country=""):
    return [(l.city, l.region, l.country) for l in parse_locations(raw, country)]


@pytest.mark.parametrize("raw, country, places", [
    # PwC's state-city form, on a US board.
    ("CA-San Francisco", "US", [("San Francisco", "CA", "United States")]),
    ("NY-New York", "US", [("New York", "NY", "United States")]),
    ("DC-Washington", "US", [("Washington", "DC", "United States")]),
    ("MO-St. Louis", "US", [("St. Louis", "MO", "United States")]),
    ("NC-Winston-Salem", "US", [("Winston-Salem", "NC", "United States")]),
    # A leading "CA" is Canada when the evidence says Canada.
    ("CA-Toronto", "CA", [("Toronto", "", "Canada")]),
    ("CA-ON - Ontario - Toronto", "CA", [("Toronto", "ON", "Canada")]),
    ("CA-Ontario-Windsor", "CA", [("Windsor", "ON", "Canada")]),
    # Country-prefixed forms (Snowflake, Stripe, CIBC).
    ("US-NY-New York", "US", [("New York", "NY", "United States")]),
    ("US-Alabama-Ozark", "US", [("Ozark", "AL", "United States")]),
    ("US-IL-Chicago-MSO", "US", [("Chicago", "IL", "United States")]),
    ("WI-Milwaukee, 411 E Wisconsin Ave Ste 1850", "US",
     [("Milwaukee", "WI", "United States")]),
    ("US-Chicago, US-New York; Canada-Toronto", "US", [
        ("Chicago", "", "United States"), ("New York", "", "United States"),
        ("Toronto", "", "Canada")]),
    # SoFi: a prefix starts the next place even before a city we don't know.
    ("NY-New York, FL-Jacksonville, UT-Cottonwood Heights", "US", [
        ("New York", "NY", "United States"), ("Jacksonville", "FL", "United States"),
        ("Cottonwood Heights", "UT", "United States")]),
    ("QC-1155 Bl. Rene Levesque-Virtual", "CA", [("", "QC", "Canada")]),  # an address
])
def test_code_prefixed_place(raw, country, places):
    assert _places(raw, country) == places


def test_code_prefix_is_read_only_with_positive_evidence():
    # Without a country (every caller but the crawl's), nothing changes:
    # "IN-Bengaluru" is India, "DE-Berlin" Germany, not Indiana or Delaware.
    assert _places("CA-San Francisco") == [("CA-San Francisco", "", "")]
    assert _places("IN-Bengaluru") == [("IN-Bengaluru", "", "")]
    # "New York, New York" keeps its city: a repeated region name is only
    # skipped when it is not also a city.
    assert _places("New York, New York") == [("New York", "NY", "United States")]
    assert _places("Quebec, Quebec, Canada") == [("Quebec", "QC", "Canada")]


@pytest.mark.parametrize("slug, country, place", [
    ("Toronto-ON", "CA", ("Toronto", "ON")),
    ("Toronto-Ontario-Canada", "CA", ("Toronto", "ON")),
    ("MONTRAL-Quebec-Canada", "CA", ("Montreal", "QC")),  # "Montréal", accent dropped
    ("REMOTETELETRAVAIL-ON-CAN", "CA", ("Remote", "ON")),
    ("AMER---Canada---Ontario---Toronto---University-Ave", "CA", ("Toronto", "ON")),
    ("Toronto---100-Adelaide-St-W", "CA", ("Toronto", "")),
    ("Mountain-View-CA-USA", "US", ("Mountain View", "CA")),
    ("USA---Hazelwood-MO", "US", ("Hazelwood", "MO")),
    ("IL-Rosemont", "US", ("Rosemont", "IL")),
    ("USA-NY-New-York-City", "US", ("New York City", "NY")),
    ("New-York-City-New-York", "US", ("New York City", "NY")),
    ("New-York-NY---225-Liberty-Street", "US", ("New York", "NY")),
    ("Washington-DC", "US", ("Washington", "DC")),
    ("Maryland---Washington-DC-Metro---Remote", "US", ("Washington", "DC")),
    ("California---San-Francisco", "US", ("San Francisco", "CA")),
    ("St-Louis-MO", "US", ("St. Louis", "MO")),
    ("3572-Macon-GA-Home-Office", "US", ("Macon", "GA")),
    ("Texas-Remote", "US", ("Remote", "TX")),
    ("USA---Remote", "US", ("Remote", "")),
    ("Los-Angeles", "US", ("Los Angeles", "")),
    ("New-York", "US", ("", "NY")),
    # BDO Canada's bare "London" is London, Ontario, though it reads foreign.
    ("London", "CA", ("London", "")),
])
def test_workday_slug_names_the_primary_location(slug, country, place):
    loc = parse_location_slug(slug, country)
    assert loc is not None and (loc.city, loc.region) == place


@pytest.mark.parametrize("slug, country", [
    ("TELUS-CAN-BC-510-W-Georgia-St", "CA"),  # a company and an address
    ("Hawkesbury", "CA"),                     # no region, not a city we know
    ("Bangalore", ""),                        # no North American evidence
    # A foreign place is not read with a one-country board's country.
    ("IN-Bengaluru", "US"),                   # not Bengaluru, Indiana
    ("PRAGUE-DC", "US"),                      # P&G: not Prague, DC
    ("IE-Dublin-CA", "US"),                   # the code prefix names Ireland
    ("San-Pedro-Garza-Garcia-NL-MX", "CA"),   # Mexico's Nuevo Leon, not Newfoundland
    ("London---United-Kingdom", "CA"),        # the known city is not the evidence
    ("London-UK", "CA"),
    ("United-Kingdom---Remote", "US"),
])
def test_workday_slug_it_cannot_trust(slug, country):
    assert parse_location_slug(slug, country) is None


@pytest.mark.parametrize("slug, country, place", [
    # Real hint gaps (2026-09 crawl dump).
    ("VILLE-DE-QUEBEC-QC-CAN", "CA", ("Quebec City", "QC")),  # BMO, in French
    ("VILLE-DE-QUBEC-QC-CAN", "CA", ("Quebec City", "QC")),   # accent dropped
    ("Virtual-IL-USA", "US", ("Remote", "IL")),               # BMO
    ("Virtual-USA", "US", ("Remote", "")),
    # Lumentum's sites after a city we know, once the country and region
    # have come first.
    ("USA---CA---San-Jose-Ridder", "US", ("San Jose", "CA")),
    ("USA---CA---San-Jose-Rose", "US", ("San Jose", "CA")),
    ("Canada---Ottawa-Bill-Leathem", "CA", ("Ottawa", "")),
    # A word that goes on naming the place keeps the whole name.
    ("USA---IL---Chicago-Heights", "US", ("Chicago Heights", "IL")),
    ("USA---IL---Arlington-Heights", "US", ("Arlington Heights", "IL")),
    ("Arlington-Heights-IL", "US", ("Arlington Heights", "IL")),
    ("USA---FL---Miami-Beach", "US", ("Miami Beach", "FL")),
    # Without the country or region first, a city is never cut short.
    ("San-Jose-Ridder-CA", "US", ("San Jose Ridder", "CA")),
])
def test_workday_slug_hint_gaps(slug, country, place):
    loc = parse_location_slug(slug, country)
    assert loc is not None and (loc.city, loc.region) == place


def test_hint_gap_slugs_are_found_by_their_city_filters():
    from backend.services.location_parser import hint_location_fields

    blob = hint_location_fields("VILLE-DE-QUEBEC-QC-CAN", "CA")["location_search"]
    assert all(f"|{token}|" in blob for token in location_tag_tokens("Quebec City, QC"))
    blob = hint_location_fields("USA---CA---San-Jose-Ridder", "US")["location_search"]
    assert all(f"|{token}|" in blob for token in location_tag_tokens("San Jose, CA"))
