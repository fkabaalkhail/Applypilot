"""
The gate every pass's output goes through.

These are written source-blind on purpose: the gate takes an answer and a
question, so the same value must be refused whether a derived fact, a rule or
the model produced it. Which pass is responsible is telemetry, not policy.
"""

from datetime import date

from backend.routers.fill import ApplicantProfile, EducationRecord, WorkPeriod
from backend.services.answer_gate import validate_answer

TODAY = date(2026, 8, 9)
YES_NO = ["Yes", "No"]


def check(value, label, options=None, prof=None, company="", help_text=""):
    return validate_answer(
        value, label=label, options=options or [], profile=prof,
        today=TODAY, company=company, help_text=help_text,
    )


# ── The grounding sentinel, now owned by the gate ────────────────────────────

def test_no_answer_sentinel_is_dropped():
    assert check("__NO_ANSWER__", "Anything").value is None
    assert check("__NO_ANSWER__", "Anything").reason == "no_answer"
    assert check("   ", "Anything").reason == "no_answer"


# ── Profile contradictions, on every path ────────────────────────────────────

def test_an_unfounded_no_cannot_override_a_computed_yes():
    """The production failure, as a test.

    A Workday yes/no group whose label harvested as boilerplate was
    indistinguishable from every other yes/no group on the page, and the 18+
    question was answered from what that label had attracted. With a date of
    birth on file the gate refutes that answer no matter which pass carried it.
    """
    adult = ApplicantProfile(dateOfBirth="2000-04-23")
    verdict = check("No", "Are you 18 years of age or older?", YES_NO, adult)
    assert verdict.value is None
    assert verdict.reason == "contradicts_profile:age_gate"


def test_the_same_answer_survives_when_it_agrees():
    adult = ApplicantProfile(dateOfBirth="2000-04-23")
    assert check("Yes", "Are you 18 years of age or older?", YES_NO, adult).value == "Yes"


def test_a_minor_gets_the_opposite_verdict():
    minor = ApplicantProfile(dateOfBirth="2012-04-23")
    assert check("Yes", "Are you 18 or older?", YES_NO, minor).reason == "contradicts_profile:age_gate"
    assert check("No", "Are you 18 or older?", YES_NO, minor).value == "No"


def test_without_a_dob_the_profile_does_not_speak_and_nothing_is_dropped():
    blank = ApplicantProfile()
    assert check("No", "Are you 18 or older?", YES_NO, blank).value == "No"


def test_years_of_experience_contradiction():
    p = ApplicantProfile(workHistory=[WorkPeriod(startDate="2022-01", endDate="Present")])
    assert check("12", "Total years of experience", [], p).reason == "contradicts_profile:total_experience"
    assert check("4 years", "Total years of experience", [], p).value == "4 years"


def test_graduation_year_contradiction():
    p = ApplicantProfile(educationHistory=[EducationRecord(degree="BSc", graduationYear="2023")])
    assert check("2019", "Graduation year", [], p).reason == "contradicts_profile:graduation_year"


# ── Identity the profile owns outright ───────────────────────────────────────

def test_a_different_email_is_dropped():
    p = ApplicantProfile(email="ada@example.com")
    assert check("someone@else.com", "Email address", [], p).reason == "contradicts_profile:email"
    assert check("ADA@example.com", "Email address", [], p).value == "ADA@example.com"


def test_a_different_phone_is_dropped_but_a_country_code_is_not_a_difference():
    p = ApplicantProfile(phone="613-555-0199")
    assert check("+1 613 555 0199", "Phone number", [], p).value == "+1 613 555 0199"
    assert check("416-555-1234", "Phone number", [], p).reason == "contradicts_profile:phone"


def test_someone_elses_name_is_not_a_contradiction():
    p = ApplicantProfile(firstName="Ada", lastName="Lovelace")
    assert check("Charles", "First name", [], p).reason == "contradicts_profile:firstName"
    # A field that asks about a different person is left alone.
    assert check("Charles", "Emergency contact first name", [], p).value == "Charles"
    assert check("Charles", "Reference first name", [], p).value == "Charles"


# ── Screening answers the profile states ─────────────────────────────────────

def test_sponsorship_contradiction():
    p = ApplicantProfile(requiresSponsorship="No")
    v = check("Yes", "Do you require visa sponsorship?", YES_NO, p)
    assert v.reason == "contradicts_profile:requiresSponsorship"
    assert check("No", "Do you require visa sponsorship?", YES_NO, p).value == "No"


def test_a_negated_sponsorship_question_is_left_alone():
    """"…work without sponsorship?" inverts the expected polarity, and reading
    that off prose is guesswork — the gate declines rather than risk a drop."""
    p = ApplicantProfile(requiresSponsorship="No")
    assert check("Yes", "Are you able to work without sponsorship?", YES_NO, p).value == "Yes"


def test_work_authorization_contradiction():
    p = ApplicantProfile(workAuthorization="Yes, I am authorized")
    assert check("No", "Are you legally authorized to work?", YES_NO, p).reason == (
        "contradicts_profile:workAuthorization"
    )


# ── Constrained widgets ──────────────────────────────────────────────────────

def test_a_value_the_widget_does_not_offer_is_dropped():
    v = check("Ottawa, ON", "Have you previously been employed here in any capacity?", YES_NO)
    assert v.value is None
    assert v.reason == "not_an_offered_option"


def test_a_kept_value_is_normalized_to_the_widgets_own_text():
    assert check("canada", "Country", ["Canadian", "American"]).value == "Canadian"


def test_no_options_means_nothing_to_enforce():
    assert check("Anything at all", "Tell us about a project", []).value == "Anything at all"


def test_options_can_be_left_unenforced_for_a_partial_option_list():
    assert check("Something", "A lazily-mounted dropdown", ["Only", "Harvested"]).reason == (
        "not_an_offered_option"
    )
    unenforced = validate_answer(
        "Something", label="A lazily-mounted dropdown", options=["Only", "Harvested"],
        profile=None, today=TODAY, enforce_options=False,
    )
    assert unenforced.value == "Something"
