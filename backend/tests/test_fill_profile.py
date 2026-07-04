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
