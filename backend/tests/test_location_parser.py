"""Location parser tests seeded with real prod formats (sampled 2026-07-15)."""

from backend.services.location_parser import (
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
