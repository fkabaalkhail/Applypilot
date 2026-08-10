"""
Deterministic resolvers: facts computed from the profile, not recalled.

The boundary cases are the point. An age gate is right or wrong by one day, and
the failure this replaces was an answer that came from a vector index with no
idea what it was answering.
"""

from datetime import date

import pytest

from backend.routers.fill import ApplicantProfile, EducationRecord, WorkPeriod
from backend.services.derived_facts import (
    age_bounds,
    parse_date_span,
    resolve_derived_fact,
    total_experience_years,
)

TODAY = date(2026, 8, 9)
YES_NO = ["Yes", "No"]


def profile(**kwargs) -> ApplicantProfile:
    return ApplicantProfile(**kwargs)


def answer(label, options=YES_NO, prof=None, company="", help_text=""):
    found = resolve_derived_fact(
        label=label, options=options, profile=prof, today=TODAY,
        company=company, help_text=help_text,
    )
    return found.value if found else None


# ── Age gates ────────────────────────────────────────────────────────────────

def test_dob_one_day_before_18th_birthday_answers_no():
    p = profile(dateOfBirth="2008-08-10")  # turns 18 tomorrow
    assert answer("Are you 18 years of age or older?", prof=p) == "No"


def test_dob_one_day_after_18th_birthday_answers_yes():
    p = profile(dateOfBirth="2008-08-08")  # turned 18 yesterday
    assert answer("Are you 18 years of age or older?", prof=p) == "Yes"


def test_dob_exactly_on_18th_birthday_answers_yes():
    p = profile(dateOfBirth="2008-08-09")
    assert answer("Are you 18 years of age or older?", prof=p) == "Yes"


def test_missing_dob_abstains():
    assert answer("Are you 18 or older?", prof=profile()) is None
    assert answer("Are you 18 or older?", prof=None) is None


def test_unparseable_dob_abstains():
    # Ambiguous day/month ordering is refused rather than guessed.
    assert answer("Are you 18 or older?", prof=profile(dateOfBirth="03/04/1998")) is None


def test_birth_year_only_answers_when_the_whole_year_agrees():
    assert answer("Are you 18 or older?", prof=profile(dateOfBirth="1998")) == "Yes"
    assert answer("Are you 18 or older?", prof=profile(dateOfBirth="2015")) == "No"
    # A year that straddles the 18th birthday is genuinely unknown.
    assert answer("Are you 18 or older?", prof=profile(dateOfBirth="2008")) is None


def test_age_question_as_dropdown_with_non_obvious_options():
    p = profile(dateOfBirth="2000-01-15")
    options = ["I am 18 years of age or older", "I am under 18 years of age"]
    assert answer("Please confirm your age", options=options, prof=p) is None  # no threshold named
    assert (
        answer("Are you at least 18 years of age?", options=options, prof=p)
        == "I am 18 years of age or older"
    )
    minor = profile(dateOfBirth="2012-01-15")
    assert (
        answer("Are you at least 18 years of age?", options=options, prof=minor)
        == "I am under 18 years of age"
    )


def test_non_yes_no_thresholds_and_phrasings():
    p = profile(dateOfBirth="2004-06-01")  # 22 today
    assert answer("Are you over the age of 18?", prof=p) == "Yes"
    assert answer("Are you 18+?", prof=p) == "Yes"
    assert answer("Minimum age of 21, do you meet it?", prof=p) == "Yes"
    assert answer("Are you at least 25 years of age?", prof=p) == "No"


def test_under_phrasing_is_inverted_not_ignored():
    adult = profile(dateOfBirth="2000-01-01")
    assert answer("Are you under 18 years of age?", prof=adult) == "No"
    minor = profile(dateOfBirth="2012-01-01")
    assert answer("Are you under 18 years of age?", prof=minor) == "Yes"


def test_age_mentioned_without_a_question_is_not_a_gate():
    p = profile(dateOfBirth="2000-01-01")
    # A statement on a text field, no yes/no control: nothing to answer.
    assert answer("Applicants must be 18 years of age", options=[], prof=p) is None


def test_a_count_that_is_not_an_age_is_not_a_gate():
    p = profile(dateOfBirth="2000-01-01")
    assert answer("Do you have at least 3 years of leadership?", prof=p) is None


def test_exact_age_value_question():
    p = profile(dateOfBirth="2000-08-10")  # 25 (birthday tomorrow)
    assert answer("What is your age?", options=[], prof=p) == "25"
    # A birth year alone cannot give an exact age.
    assert answer("What is your age?", options=[], prof=profile(dateOfBirth="2000")) is None


def test_age_bounds_helpers():
    assert age_bounds("2000-08-09", TODAY) == (26, 26)
    assert age_bounds("2000", TODAY) == (25, 26)
    assert age_bounds("", TODAY) is None
    assert age_bounds("1700-01-01", TODAY) is None  # absurd, refused


def test_parse_date_span_precision():
    assert parse_date_span("1998-04-23").exact is True
    assert parse_date_span("1998-04") == parse_date_span("04/1998")
    assert parse_date_span("Jan 2020") == parse_date_span("2020-01")
    assert parse_date_span("nonsense") is None
    assert parse_date_span("1998-13") is None  # no thirteenth month


# ── Years of experience ──────────────────────────────────────────────────────

def test_total_experience_counts_overlapping_roles_once():
    p = profile(workHistory=[
        WorkPeriod(startDate="2020-01", endDate="2024-01"),
        WorkPeriod(startDate="2022-01", endDate="2023-01"),  # concurrent
    ])
    assert total_experience_years(p, TODAY) == 4
    assert answer("How many years of professional experience do you have?", options=[], prof=p) == "4"


def test_total_experience_reads_present_as_today():
    p = profile(workHistory=[WorkPeriod(startDate="2023-08", endDate="Present")])
    assert total_experience_years(p, TODAY) == 3


def test_total_experience_abstains_without_datable_history():
    assert answer("Years of experience?", options=[], prof=profile()) is None
    assert answer(
        "Years of experience?", options=[],
        prof=profile(workHistory=[WorkPeriod(startDate="a while ago", endDate="")]),
    ) is None


def test_total_experience_does_not_answer_a_skill_specific_question():
    p = profile(workHistory=[WorkPeriod(startDate="2016-01", endDate="Present")])
    assert answer("Years of experience with Kubernetes?", options=[], prof=p) is None
    assert answer("How many years of experience in accounting?", options=[], prof=p) is None


def test_total_experience_snaps_to_a_bucketed_dropdown():
    p = profile(workHistory=[WorkPeriod(startDate="2020-01", endDate="2024-01")])
    buckets = ["Under 1 year", "1-2 years", "3-5 years", "6+ years"]
    assert answer("Total years of work experience", options=buckets, prof=p) == "3-5 years"


# ── Education ────────────────────────────────────────────────────────────────

def test_graduation_year_is_the_most_recent():
    p = profile(educationHistory=[
        EducationRecord(degree="BSc", school="uOttawa", graduationYear="2023"),
        EducationRecord(degree="MSc", school="uOttawa", graduationYear="May 2025"),
    ])
    assert answer("What is your graduation year?", options=[], prof=p) == "2025"


def test_graduation_year_abstains_when_unknown():
    p = profile(educationHistory=[EducationRecord(degree="BSc", school="uOttawa")])
    assert answer("Graduation year", options=[], prof=p) is None


def test_highest_degree_maps_onto_the_widget_tier():
    p = profile(educationHistory=[
        EducationRecord(degree="Bachelor of Science in Computer Science", graduationYear="2023"),
        EducationRecord(degree="High School Diploma", graduationYear="2019"),
    ])
    options = ["High School", "Associate Degree", "Bachelor's Degree", "Master's Degree", "Doctorate"]
    assert answer("Highest level of education completed", options=options, prof=p) == "Bachelor's Degree"
    assert answer("Highest level of education completed", options=[], prof=p) == "Bachelor's Degree"


def test_highest_degree_abstains_when_the_tier_is_not_offered():
    p = profile(educationHistory=[EducationRecord(degree="PhD in Physics")])
    assert answer("Highest level of education", options=["Bachelor's Degree", "Master's Degree"], prof=p) is None


# ── Current employer ─────────────────────────────────────────────────────────

def test_current_employer_question():
    p = profile(currentCompany="Acme Corp")
    assert answer("Do you currently work at Acme?", prof=p, company="Acme") == "Yes"
    assert answer("Do you currently work at Globex?", prof=p, company="Globex") == "No"


def test_current_employer_abstains_without_a_current_company():
    assert answer("Are you currently an employee?", prof=profile(), company="Acme") is None


def test_current_employer_does_not_hijack_the_ever_worked_here_question():
    p = profile(currentCompany="Acme Corp")
    assert answer("Have you ever worked for us before?", prof=p, company="Acme") is None


@pytest.mark.parametrize("dob", ["", "   ", "not-a-date", "0000-00-00"])
def test_every_resolver_abstains_on_junk_dob(dob):
    assert answer("Are you 18 or older?", prof=profile(dateOfBirth=dob)) is None
