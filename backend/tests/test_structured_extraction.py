"""Structured extraction is deterministic, these tests pin its judgment calls."""

from backend.services.structured_extraction import (
    compute_raw_hash,
    detect_employment_type,
    detect_visa_sponsorship,
    extract_skills,
    looks_evergreen,
    parse_salary,
)


# ─── parse_salary ────────────────────────────────────────────────────────────

class TestParseSalary:
    def test_annual_range_with_commas(self):
        assert parse_salary("The pay range is $120,000 - $150,000 per year.") == (
            120000, 150000, "USD", "year",
        )

    def test_k_suffix_range(self):
        assert parse_salary("Comp: $120k–150k plus equity") == (120000, 150000, "USD", "year")

    def test_shared_k_suffix_applies_to_low_bound(self):
        lo, hi, cur, period = parse_salary("We pay $120-150k")
        assert (lo, hi) == (120000, 150000)

    def test_hourly_rate(self):
        assert parse_salary("This co-op pays CA$45/hr for the term") == (45, 45, "CAD", "hour")

    def test_hourly_range_inferred_from_magnitude(self):
        lo, hi, cur, period = parse_salary("Pay: $28 - $35 depending on experience")
        assert (lo, hi, period) == (28, 35, "hour")

    def test_currency_after_amounts(self):
        assert parse_salary("Salary: 90,000 - 110,000 CAD annually") == (
            90000, 110000, "CAD", "year",
        )

    def test_gbp(self):
        assert parse_salary("£30,000 per annum") == (30000, 30000, "GBP", "year")

    def test_single_figure(self):
        assert parse_salary("Base salary of $95,000 for this role") == (
            95000, 95000, "USD", "year",
        )

    def test_swapped_bounds_are_reordered(self):
        lo, hi, *_ = parse_salary("$150,000 to $120,000")
        assert lo <= hi

    def test_no_salary_returns_none(self):
        assert parse_salary("We ship fast and iterate often.") is None

    def test_year_number_not_mistaken_for_salary(self):
        assert parse_salary("Summer 2026 internship, 12 weeks, cohort of 40") is None

    def test_tiny_dollar_amount_rejected(self):
        assert parse_salary("Lunch stipend of $5 per day") is None

    def test_empty(self):
        assert parse_salary("") is None


# ─── detect_employment_type ──────────────────────────────────────────────────

class TestEmploymentType:
    def test_commitment_field_wins(self):
        assert detect_employment_type("Software Engineer", "", "Intern") == "internship"

    def test_intern_title(self):
        assert detect_employment_type("Software Engineer Intern", "") == "internship"

    def test_coop_title(self):
        assert detect_employment_type("Data Analyst Co-op", "") == "internship"

    def test_contract(self):
        assert detect_employment_type("DevOps Engineer (Contract)", "") == "contract"

    def test_full_time_from_description(self):
        assert detect_employment_type(
            "New Grad Engineer", "This is a full-time position based in Toronto.",
        ) == "full_time"

    def test_intern_title_beats_full_time_description(self):
        assert detect_employment_type(
            "Engineering Intern", "This is a full-time internship for the summer.",
        ) == "internship"

    def test_unknown_is_empty(self):
        assert detect_employment_type("Software Engineer", "") == ""


# ─── detect_visa_sponsorship ─────────────────────────────────────────────────

class TestVisaSponsorship:
    def test_explicit_yes(self):
        assert detect_visa_sponsorship("Visa sponsorship is available for this role.") == "yes"

    def test_will_sponsor(self):
        assert detect_visa_sponsorship("We will sponsor H-1B visas for qualified candidates.") == "yes"

    def test_unable_to_sponsor(self):
        assert detect_visa_sponsorship("We are unable to sponsor visas at this time.") == "no"

    def test_not_able_multiword(self):
        assert detect_visa_sponsorship(
            "Candidates must be authorized to work in the US without sponsorship.",
        ) == "no"

    def test_negative_beats_positive_wordshare(self):
        # Contains "sponsor" but the statement is negative.
        assert detect_visa_sponsorship("This position does not offer visa sponsorship.") == "no"

    def test_silence_is_unknown(self):
        assert detect_visa_sponsorship("Join our fast-moving team.") == "unknown"

    def test_citizenship_requirement_is_not_a_no(self):
        # Clearance/citizenship wording must not be inferred as "no".
        assert detect_visa_sponsorship("US citizenship required for clearance.") == "unknown"

    def test_empty(self):
        assert detect_visa_sponsorship("") == "unknown"


# ─── extract_skills ──────────────────────────────────────────────────────────

class TestExtractSkills:
    def test_basic_stack(self):
        skills = extract_skills(
            "Backend Engineer Intern",
            "You will build services in Python and Go, deploy on AWS with Docker and Kubernetes, and query PostgreSQL.",
        )
        assert "python" in skills
        assert "aws" in skills
        assert "docker" in skills
        assert "kubernetes" in skills
        assert "postgresql" in skills

    def test_symbol_edged_terms(self):
        skills = extract_skills("Engineer", "We use C++, C#, and .NET daily.")
        assert "c++" in skills
        assert "c#" in skills
        assert ".net" in skills

    def test_synonyms_canonicalize(self):
        skills = extract_skills("Engineer", "Experience with Golang, K8s, and Postgres required.")
        assert "go" in skills
        assert "kubernetes" in skills
        assert "postgresql" in skills

    def test_ambiguous_single_letters_need_title(self):
        # Prose "go over" / "a r" must not tag languages from description alone.
        skills = extract_skills("Marketing Intern", "We go over results weekly and read r/marketing.")
        assert "go" not in skills
        assert "r" not in skills

    def test_ambiguous_matches_in_title(self):
        assert "r" in extract_skills("R Programmer Intern", "")

    def test_word_boundaries(self):
        # "javascript" must not fire from "java"; "scala" not from "scalable".
        skills = extract_skills("Engineer", "Highly scalable javascript services.")
        assert "javascript" in skills
        assert "java" not in skills
        assert "scala" not in skills

    def test_cap(self):
        blob = " ".join(k for k in ("python java typescript react angular vue svelte django flask "
                                    "fastapi rails graphql aws azure gcp docker kubernetes terraform "
                                    "ansible jenkins git linux postgresql mysql mongodb redis kafka").split())
        assert len(extract_skills("Engineer", blob)) <= 20

    def test_empty(self):
        assert extract_skills("", "") == []


# ─── compute_raw_hash ────────────────────────────────────────────────────────

class TestRawHash:
    def test_stable(self):
        a = compute_raw_hash("Engineer", "Ottawa", "Build things", "$100k")
        b = compute_raw_hash("Engineer", "Ottawa", "Build things", "$100k")
        assert a == b

    def test_whitespace_insensitive(self):
        a = compute_raw_hash("Engineer", "Ottawa", "Build   things\n", "")
        b = compute_raw_hash("Engineer", "Ottawa", "Build things", "")
        assert a == b

    def test_content_sensitive(self):
        a = compute_raw_hash("Engineer", "Ottawa", "Build things", "$100k")
        b = compute_raw_hash("Engineer", "Ottawa", "Build things", "")
        assert a != b


# ─── looks_evergreen ─────────────────────────────────────────────────────────

class TestEvergreen:
    def test_always_accepting(self):
        assert looks_evergreen("We are always accepting applications for this role.")

    def test_talent_pool(self):
        assert looks_evergreen("Join our talent community to be considered for future openings.")

    def test_rolling_basis(self):
        assert looks_evergreen("Applications are accepted on an ongoing basis.")

    def test_normal_posting(self):
        assert not looks_evergreen("We are hiring one engineer to join the payments team in Q3.")

    def test_empty(self):
        assert not looks_evergreen("")
