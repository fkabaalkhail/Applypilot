from backend.services.fabrication_check import find_unsupported_figures


def test_flags_number_absent_from_source():
    assert find_unsupported_figures("Cut latency for the team.", ["Cut latency by 40%."]) == ["40%"]


def test_allows_number_present_in_source():
    src = "Improved performance by 40% across 3 teams."
    assert find_unsupported_figures(src, ["Boosted performance 40% for 3 teams."]) == []


def test_allows_dates_and_ids_present_in_source():
    assert find_unsupported_figures("Founded in 2020.", ["Since 2020, led the platform."]) == []


def test_flags_dollar_amount_and_dedupes():
    out = find_unsupported_figures("Grew the business.", ["Added $2M ARR.", "Reached $2M."])
    assert out == ["$2M"]


def test_ignores_text_with_no_numbers():
    assert find_unsupported_figures("anything", ["Led cross-functional teams."]) == []
