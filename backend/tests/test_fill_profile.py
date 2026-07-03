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
