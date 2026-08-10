from backend.routers.fill import ApplicantProfile, _profile_context, _rule_based_answer


def test_profile_context_includes_work_auth_and_salary_excludes_eeo():
    p = ApplicantProfile(
        firstName="Ada", lastName="Lovelace", email="ada@x.io",
        workAuthorization="Canadian citizen", requiresSponsorship="No",
        salaryExpectation="120000", skills=["Python", "SQL"],
    )
    ctx = _profile_context(p)
    assert "Ada Lovelace" in ctx
    assert "Canadian citizen" in ctx
    assert "120000" in ctx
    assert "Python" in ctx
    # EEO is never a field on ApplicantProfile — nothing demographic leaks in.
    assert "race" not in ctx.lower()


def test_rule_based_prefers_profile_over_settings():
    p = ApplicantProfile(firstName="Ada")
    assert _rule_based_answer("First name", [], settings=None, profile=p) == "Ada"


def test_worked_here_uses_experience():
    p = ApplicantProfile(experience=["Engineer at Acme (2020-2024)"])
    # Applied at Acme → the applicant has worked here.
    assert _rule_based_answer("Have you worked here before?", ["Yes", "No"], None, p, "Acme") == "Yes"
    # Applied elsewhere → they have not.
    assert _rule_based_answer("Are you a current or former employee?", ["Yes", "No"], None, p, "Globex") == "No"


def test_yesno_keyword_rules_defer_when_options_are_not_yes_no():
    """A keyword like "relocate" must not force a "yes" onto a field whose
    options are a specific list (Lever's "What office(s)…? (Select all that
    apply)"). "yes" is never a valid option there, so the rule must defer to
    option-aware matching instead of returning an unmatchable answer."""
    offices = ["San Diego", "Washington, DC", "Remote"]
    assert (
        _rule_based_answer(
            "What office(s) would you be willing to relocate to? (Select all that apply)",
            offices,
            settings=None,
        )
        is None
    )
    # Same guard for the other keyword yes/no rules when options aren't yes/no.
    assert _rule_based_answer("Which visa sponsorship do you hold?", ["H-1B", "TN", "None"], settings=None) is None


def test_kept_universal_rules_still_answer():
    """Truly universal screening questions still auto-answer."""
    assert _rule_based_answer("Are you legally authorized to work?", ["Yes", "No"], settings=None) == "Yes"
    assert _rule_based_answer("Do you require sponsorship?", ["Yes", "No"], settings=None) == "No"
    assert _rule_based_answer("Are you at least 18 years old?", ["Yes", "No"], settings=None) == "Yes"


def test_assumption_rules_are_dropped():
    """Assumption-based questions no longer auto-fill a hardcoded Yes — they
    defer to the AI pass, which leaves them blank unless the profile supports it."""
    assert _rule_based_answer("Are you willing to relocate?", ["Yes", "No"], settings=None) is None
    assert _rule_based_answer("Do you have a valid driver's license?", ["Yes", "No"], settings=None) is None
    assert _rule_based_answer("Do you consent to a background check?", ["Yes", "No"], settings=None) is None
    assert _rule_based_answer("Are you willing to take a drug test?", ["Yes", "No"], settings=None) is None


# ── Stated screening answers (2026-08-09 profile-parity contract) ─────────────
#
# These are the same questions test_assumption_rules_are_dropped proves we must
# NOT guess at. The difference is not the question — it is that the applicant
# has now answered it once on their profile, so filling it is recall, not
# invention. Every rule below must abstain when the profile is silent.

SCREENED = dict(
    willingToRelocate="Yes",
    workPreference="Remote",
    noticePeriod="2 weeks",
    earliestStartDate="2026-09-01",
    yearsOfExperience="5",
    securityClearance="Active clearance",
    driversLicense="Yes",
    languages="English (Native), French (Professional)",
)


def test_profile_context_includes_the_screening_answers_when_set():
    ctx = _profile_context(ApplicantProfile(**SCREENED))
    assert "Willing to relocate: Yes" in ctx
    assert "Work preference: Remote" in ctx
    assert "Notice period: 2 weeks" in ctx
    assert "Earliest start date: 2026-09-01" in ctx
    assert "Years of experience: 5" in ctx
    assert "Security clearance: Active clearance" in ctx
    assert "Driver's licence: Yes" in ctx
    assert "Languages: English (Native), French (Professional)" in ctx
    # Still no demographics anywhere near the prompt.
    assert "race" not in ctx.lower()


def test_profile_context_omits_blank_screening_answers():
    """A blank must be absent, not rendered as "unknown" — an empty line is a
    fact the model would otherwise be invited to reason from."""
    ctx = _profile_context(ApplicantProfile(firstName="Ada", workPreference="Hybrid"))
    assert "Work preference: Hybrid" in ctx
    for label in ("Willing to relocate", "Notice period", "Earliest start date",
                  "Years of experience", "Security clearance", "Driver's licence",
                  "Languages"):
        assert label not in ctx


def test_stated_screening_answers_fill_without_ai():
    p = ApplicantProfile(**SCREENED)
    assert _rule_based_answer("Are you willing to relocate?", ["Yes", "No"], None, p) == "Yes"
    assert _rule_based_answer(
        "What is your work preference?", ["Remote", "Hybrid", "On-site", "No preference"], None, p
    ) == "Remote"
    assert _rule_based_answer("What is your notice period?", [], None, p) == "2 weeks"
    assert _rule_based_answer("Earliest start date", [], None, p) == "2026-09-01"
    assert _rule_based_answer("When can you start?", [], None, p) == "2026-09-01"
    assert _rule_based_answer("Total years of experience", [], None, p) == "5"
    assert _rule_based_answer(
        "Do you hold a security clearance?", ["None", "Active clearance", "Eligible / previously held"], None, p
    ) == "Active clearance"
    assert _rule_based_answer("Do you have a valid driver's license?", ["Yes", "No"], None, p) == "Yes"
    assert _rule_based_answer("What languages do you speak?", [], None, p) == SCREENED["languages"]


def test_screening_rules_abstain_when_the_profile_is_silent():
    """An empty profile field is "not answered", never "no"."""
    p = ApplicantProfile(firstName="Ada")
    for label in [
        "Are you willing to relocate?",
        "What is your work preference?",
        "What is your notice period?",
        "Earliest start date",
        "Total years of experience",
        "Do you hold a security clearance?",
        "Do you have a valid driver's license?",
        "What languages do you speak?",
    ]:
        assert _rule_based_answer(label, [], None, p) is None, label


def test_screening_rules_defer_when_the_options_cannot_take_the_value():
    """The file's standing guard: a specific-option field only accepts a
    shortcut that snaps to one of its options. A "Remote" preference cannot be
    forced into an on-site/hybrid-only list."""
    p = ApplicantProfile(**SCREENED)
    assert _rule_based_answer("Work arrangement", ["On-site", "Hybrid"], None, p) is None
    # A bucketed years-of-experience list the stated value fits still resolves…
    assert _rule_based_answer(
        "Years of experience", ["0-2 years", "3-5 years", "6+ years"], None, p
    ) == "3-5 years"
    # …and a start-date field offering quarters the ISO date cannot match defers.
    assert _rule_based_answer(
        "Earliest start date", ["Q1 2027", "Q2 2027"], None, p
    ) is None


def test_narrowed_experience_question_is_not_the_career_total():
    """"Years of experience WITH Kubernetes" asks about one skill. Answering it
    with the career total is a fabrication, so the rule must abstain."""
    p = ApplicantProfile(**SCREENED)
    assert _rule_based_answer("Years of experience with Kubernetes", [], None, p) is None
    assert _rule_based_answer("How many years of experience in Rust do you have?", [], None, p) is None


def test_programming_language_question_is_not_a_spoken_language_question():
    p = ApplicantProfile(**SCREENED)
    assert _rule_based_answer("Which programming languages do you know?", [], None, p) is None
    assert _rule_based_answer("List the coding languages you use", [], None, p) is None


def test_work_preference_wins_over_the_generic_location_rule():
    """"Preferred work location" carries the city rule's keyword. The stated
    preference is the better answer and must be checked first."""
    p = ApplicantProfile(**SCREENED, addressCity="Ottawa")
    assert _rule_based_answer(
        "Preferred work location", ["Remote", "Hybrid", "On-site"], None, p
    ) == "Remote"
    # A plain address field still gets the city.
    assert _rule_based_answer("City", [], None, p) == "Ottawa"
