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
