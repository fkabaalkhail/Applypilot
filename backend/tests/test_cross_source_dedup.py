"""Cross-source dedup: LinkedIn/Indeed twins collapse into direct ATS rows."""

from backend.db.models import ScrapedJob
from backend.services.cross_source_dedup import (
    absorb_new_aggregator_rows,
    canonical_url,
    dedup_sweep,
    has_direct_twin,
    mark_inferior_twins,
    normalize_title,
)
from backend.services.location_parser import location_fields


def _mk(db_session, url, *, source="linkedin", title="Software Engineer Intern",
        company="Kinaxis", domain="kinaxis.com", location="Ottawa, ON, CA",
        description="", applicant_count=None, salary_range=""):
    row = ScrapedJob(
        title=title, company=company, url=url, location=location,
        description=description, country="CA", work_type="onsite",
        source_platform=source, experience_level="internship", easy_apply=0,
        match_score=0, company_domain=domain, salary_range=salary_range,
        applicant_count=applicant_count, title_norm=normalize_title(title),
        **location_fields(location),
    )
    db_session.add(row)
    db_session.commit()
    return row


# --- normalize_title -------------------------------------------------------

def test_normalize_title_strips_season_year_and_parentheticals():
    assert normalize_title("Software Engineer Intern (Summer 2026)") == "software engineer intern"
    assert normalize_title("Software Engineer Intern - Summer 2026") == "software engineer intern"
    assert normalize_title("Software Engineer Intern") == "software engineer intern"


def test_normalize_title_keeps_role_level_words():
    assert normalize_title("Software Engineer Intern") != normalize_title("Software Engineer, New Grad")
    assert normalize_title("Software Engineer Intern, Infrastructure") != normalize_title(
        "Software Engineer Intern"
    )


# --- has_direct_twin (ingest-batch guard) ----------------------------------

def test_has_direct_twin_finds_ats_row(db_session):
    _mk(db_session, "https://boards.greenhouse.io/kinaxis/jobs/1", source="ats",
        description="Long real description " * 10)
    assert has_direct_twin(
        db_session, company="Kinaxis", company_domain="kinaxis.com",
        title="Software Engineer Intern (Summer 2026)", city="ottawa",
    )


def test_has_direct_twin_respects_city(db_session):
    _mk(db_session, "https://boards.greenhouse.io/kinaxis/jobs/2", source="ats",
        location="Toronto, ON, CA")
    assert not has_direct_twin(
        db_session, company="Kinaxis", company_domain="kinaxis.com",
        title="Software Engineer Intern", city="ottawa",
    )


def test_has_direct_twin_multi_city_ats_absorbs(db_session):
    _mk(db_session, "https://boards.greenhouse.io/kinaxis/jobs/3", source="ats",
        location="Ottawa,Ontario,Canada; Toronto,Ontario,Canada")
    assert has_direct_twin(
        db_session, company="Kinaxis", company_domain="kinaxis.com",
        title="Software Engineer Intern", city="toronto",
    )


def test_has_direct_twin_different_title_no_match(db_session):
    _mk(db_session, "https://boards.greenhouse.io/kinaxis/jobs/4", source="ats")
    assert not has_direct_twin(
        db_session, company="Kinaxis", company_domain="kinaxis.com",
        title="Data Analyst Intern", city="ottawa",
    )


# --- mark_inferior_twins (cron-ats / aggregator hook) -----------------------

def test_mark_inferior_twins_hides_linkedin_and_enriches_winner(db_session):
    twin = _mk(db_session, "https://linkedin.com/jobs/view/1", source="linkedin",
               applicant_count=57, salary_range="$40-50/hr")
    winner = _mk(db_session, "https://boards.greenhouse.io/kinaxis/jobs/5",
                 source="ats", description="Full description " * 20)
    marked = mark_inferior_twins(db_session, winner)
    assert marked == 1
    db_session.refresh(twin)
    db_session.refresh(winner)
    assert twin.duplicate_of == winner.id
    assert winner.applicant_count == 57
    assert winner.salary_range == "$40-50/hr"


def test_mark_inferior_twins_ignores_other_cities_and_titles(db_session):
    other_city = _mk(db_session, "https://linkedin.com/jobs/view/2",
                     source="linkedin", location="Calgary, AB, CA")
    other_title = _mk(db_session, "https://linkedin.com/jobs/view/3",
                      source="linkedin", title="Data Analyst Intern")
    winner = _mk(db_session, "https://boards.greenhouse.io/kinaxis/jobs/6",
                 source="ats")
    assert mark_inferior_twins(db_session, winner) == 0
    db_session.refresh(other_city)
    db_session.refresh(other_title)
    assert other_city.duplicate_of is None
    assert other_title.duplicate_of is None


# --- dedup_sweep (one-time script core) -------------------------------------

def test_sweep_collapses_pairs_and_copies_description(db_session):
    loser = _mk(db_session, "https://linkedin.com/jobs/view/4", source="linkedin",
                description="A LinkedIn description long enough to be real content " * 10,
                applicant_count=12)
    winner = _mk(db_session, "https://github.example/direct/1", source="github",
                 description="")
    stats = dedup_sweep(db_session)
    db_session.refresh(loser)
    db_session.refresh(winner)
    assert loser.duplicate_of == winner.id
    assert winner.duplicate_of is None
    assert len(winner.description or "") > 50  # copied from the loser
    assert winner.applicant_count == 12
    assert stats["marked"] == 1


def test_sweep_multi_city_ats_absorbs_two_city_twins(db_session):
    ott = _mk(db_session, "https://linkedin.com/jobs/view/5", source="linkedin",
              location="Ottawa, ON, CA")
    tor = _mk(db_session, "https://linkedin.com/jobs/view/6", source="linkedin",
              location="Toronto, ON, CA")
    winner = _mk(db_session, "https://boards.greenhouse.io/kinaxis/jobs/7",
                 source="ats", description="Real description " * 10,
                 location="Ottawa,Ontario,Canada; Toronto,Ontario,Canada")
    stats = dedup_sweep(db_session)
    db_session.refresh(ott)
    db_session.refresh(tor)
    assert ott.duplicate_of == winner.id
    assert tor.duplicate_of == winner.id
    assert stats["marked"] == 2


def test_sweep_never_merges_across_cities_or_titles(db_session):
    a = _mk(db_session, "https://linkedin.com/jobs/view/7", source="linkedin",
            location="Ottawa, ON, CA")
    b = _mk(db_session, "https://boards.greenhouse.io/kinaxis/jobs/8",
            source="ats", location="Calgary, AB, CA")
    c = _mk(db_session, "https://boards.greenhouse.io/kinaxis/jobs/9",
            source="ats", title="Data Analyst Intern")
    dedup_sweep(db_session)
    for row in (a, b, c):
        db_session.refresh(row)
        assert row.duplicate_of is None


def test_sweep_is_idempotent(db_session):
    _mk(db_session, "https://linkedin.com/jobs/view/8", source="linkedin")
    _mk(db_session, "https://boards.greenhouse.io/kinaxis/jobs/10", source="ats",
        description="Real description " * 10)
    first = dedup_sweep(db_session)
    second = dedup_sweep(db_session)
    assert first["marked"] == 1
    assert second["marked"] == 0


def test_sweep_falls_back_to_company_name_without_domains(db_session):
    loser = _mk(db_session, "https://linkedin.com/jobs/view/9", source="linkedin",
                company="Acme Widgets Inc.", domain="")
    winner = _mk(db_session, "https://boards.greenhouse.io/acme/jobs/1",
                 source="ats", company="Acme Widgets", domain="",
                 description="Real description " * 10)
    dedup_sweep(db_session)
    db_session.refresh(loser)
    assert loser.duplicate_of == winner.id


def test_sweep_never_merges_two_direct_rows(db_session):
    # Same employer, identical title, same city, DIFFERENT requisition ids:
    # distinct postings (per-team/per-country reqs). Both must survive.
    a = _mk(db_session, "https://boards.greenhouse.io/affirm/jobs/7724915003",
            source="ats", company="Affirm", domain="affirm.com",
            description="Req A " * 20)
    b = _mk(db_session, "https://boards.greenhouse.io/affirm/jobs/7724917003",
            source="ats", company="Affirm", domain="affirm.com",
            description="Req B " * 20)
    dedup_sweep(db_session)
    db_session.refresh(a)
    db_session.refresh(b)
    assert a.duplicate_of is None
    assert b.duplicate_of is None


def test_sweep_uses_url_not_label_for_rogue_rows(db_session):
    # Rogue-scraper rows are labeled source='ats' but carry LinkedIn URLs,
    # they are aggregator copies and must be absorbed by the real direct row.
    rogue = _mk(db_session, "https://www.linkedin.com/jobs/view/4414123646",
                source="ats", description="")
    winner = _mk(db_session, "https://boards.greenhouse.io/kinaxis/jobs/11",
                 source="ats", description="Real description " * 10)
    dedup_sweep(db_session)
    db_session.refresh(rogue)
    db_session.refresh(winner)
    assert rogue.duplicate_of == winner.id
    assert winner.duplicate_of is None


def test_sweep_linkedin_reposts_collapse_together(db_session):
    # The same posting spammed under many LinkedIn view ids collapses to one.
    first = _mk(db_session, "https://linkedin.com/jobs/view/201", source="linkedin",
                description="Snippet " * 60)
    second = _mk(db_session, "https://linkedin.com/jobs/view/202", source="linkedin",
                 description="")
    dedup_sweep(db_session)
    db_session.refresh(first)
    db_session.refresh(second)
    assert second.duplicate_of == first.id
    assert first.duplicate_of is None


def test_canonical_url_strips_only_tracking_params():
    assert canonical_url("https://www.workatastartup.com/jobs/86588?utm_source=vansh") == \
        "https://www.workatastartup.com/jobs/86588"
    assert canonical_url("https://x.test/jobs/1") == "https://x.test/jobs/1"
    # Functional query params survive.
    assert "gh_jid=123" in canonical_url("https://acme.com/careers?gh_jid=123&utm_source=list")
    assert "utm_source" not in canonical_url("https://acme.com/careers?gh_jid=123&utm_source=list")
    assert canonical_url("") == ""


def test_sweep_collapses_identical_canonical_urls_across_direct_rows(db_session):
    # Two GitHub-list rows for the SAME posting, differing only by utm junk.
    keeper = _mk(db_session, "https://www.tesla.com/careers/search/job/253464",
                 source="github", description="Real description " * 20)
    tracked = _mk(db_session,
                  "https://www.tesla.com/careers/search/job/253464?utm_source=vansh",
                  source="github", description="")
    stats = dedup_sweep(db_session)
    db_session.refresh(keeper)
    db_session.refresh(tracked)
    assert tracked.duplicate_of == keeper.id
    assert keeper.duplicate_of is None
    assert stats["url_twins_marked"] == 1


def test_sweep_different_requisitions_same_host_not_url_twins(db_session):
    a = _mk(db_session, "https://www.workatastartup.com/jobs/86588",
            source="github", title="Founding Engineer", description="A " * 60)
    b = _mk(db_session, "https://www.workatastartup.com/jobs/84154",
            source="github", title="Founding Engineer", description="B " * 60)
    dedup_sweep(db_session)
    db_session.refresh(a)
    db_session.refresh(b)
    assert a.duplicate_of is None
    assert b.duplicate_of is None


def test_absorb_new_indeed_row_into_described_linkedin_twin(db_session):
    # The Arcadis case: an Indeed row with no description arrives after the
    # sweep; a LinkedIn twin with a full description already exists.
    linkedin = _mk(db_session, "https://ca.linkedin.com/jobs/view/arc-1",
                   source="linkedin", company="Arcadis", domain="arcadis.com",
                   title="Disaster and Climate Resilience Co-op",
                   location="Vancouver, BC, CA",
                   description="Arcadis is the world leading company " * 20)
    indeed = _mk(db_session, "https://ca.indeed.com/viewjob?jk=arc1",
                 source="indeed", company="Arcadis", domain="arcadis.com",
                 title="Disaster and Climate Resilience Co-op",
                 location="Vancouver, BC, CA", description="")
    marked = absorb_new_aggregator_rows(db_session)
    assert marked == 1
    db_session.refresh(indeed)
    db_session.refresh(linkedin)
    assert indeed.duplicate_of == linkedin.id
    assert linkedin.duplicate_of is None


def test_absorb_never_marks_direct_rows_or_unrelated(db_session):
    direct = _mk(db_session, "https://boards.greenhouse.io/kinaxis/jobs/absorb-1",
                 source="ats", description="")
    other_city = _mk(db_session, "https://ca.indeed.com/viewjob?jk=absorb2",
                     source="indeed", location="Calgary, AB, CA", description="")
    _mk(db_session, "https://ca.linkedin.com/jobs/view/absorb-3",
        source="linkedin", location="Ottawa, ON, CA",
        description="Full description " * 30)
    absorb_new_aggregator_rows(db_session)
    db_session.refresh(direct)
    db_session.refresh(other_city)
    assert direct.duplicate_of is None
    assert other_city.duplicate_of is None


def test_absorb_flattens_chains(db_session):
    oldest = _mk(db_session, "https://ca.linkedin.com/jobs/view/chain-1",
                 source="linkedin", description="Desc " * 100)
    middle = _mk(db_session, "https://ca.linkedin.com/jobs/view/chain-2",
                 source="linkedin", description="Desc " * 100)
    newest = _mk(db_session, "https://ca.indeed.com/viewjob?jk=chain3",
                 source="indeed", description="")
    absorb_new_aggregator_rows(db_session)
    db_session.refresh(oldest)
    db_session.refresh(middle)
    db_session.refresh(newest)
    assert oldest.duplicate_of is None
    for row in (middle, newest):
        assert row.duplicate_of == oldest.id, "chains must be flattened"


def test_sweep_remote_rows_require_same_country(db_session):
    us = _mk(db_session, "https://linkedin.com/jobs/view/203", source="linkedin",
             location="Remote")
    ca_direct = _mk(db_session, "https://boards.greenhouse.io/kinaxis/jobs/12",
                    source="ats", location="Remote",
                    description="Real description " * 10)
    # Force differing countries with empty cities ("Remote" parses city=Remote,
    # so blank the parsed fields to simulate truly unlocated rows).
    us.city = ""
    us.location_search = ""
    us.country = "US"
    ca_direct.city = ""
    ca_direct.location_search = ""
    ca_direct.country = "CA"
    db_session.commit()
    dedup_sweep(db_session)
    db_session.refresh(us)
    assert us.duplicate_of is None


# --- fuzzy title fallback ----------------------------------------------------

def test_titles_fuzzy_match_accepts_punctuation_noise():
    from backend.services.cross_source_dedup import titles_fuzzy_match
    assert titles_fuzzy_match(
        "software engineer intern payments",
        "software engineer intern payments team",
    ) is False  # extra qualifier word = different posting, length gap guard
    assert titles_fuzzy_match(
        "software engineer intern paymentss",
        "software engineer intern payments",
    ) is True  # single-character noise


def test_titles_fuzzy_match_rejects_short_and_different():
    from backend.services.cross_source_dedup import titles_fuzzy_match
    assert titles_fuzzy_match("intern", "intern") is True
    assert titles_fuzzy_match("qa intern", "ml intern") is False
    assert titles_fuzzy_match(
        "software engineer intern", "data engineer intern",
    ) is False


def test_absorb_fuzzy_falls_back_to_near_identical_direct_title(db_session):
    winner = _mk(
        db_session, "https://boards.greenhouse.io/kinaxis/jobs/50", source="ats",
        title="Software Developer Intern, Analytics",
        description="Full description " * 20,
    )
    # Aggregator copy with one-character title noise -> different title_norm.
    loser = _mk(
        db_session, "https://linkedin.com/jobs/view/50", source="linkedin",
        title="Software Developer Intern, Analytic",
    )
    assert loser.title_norm != winner.title_norm

    absorbed = absorb_new_aggregator_rows(db_session)
    db_session.refresh(loser)
    assert absorbed == 1
    assert loser.duplicate_of == winner.id


def test_absorb_fuzzy_never_merges_actually_different_jobs(db_session):
    winner = _mk(
        db_session, "https://boards.greenhouse.io/kinaxis/jobs/51", source="ats",
        title="Software Engineer Intern, Infrastructure",
        description="Full description " * 20,
    )
    different = _mk(
        db_session, "https://linkedin.com/jobs/view/51", source="linkedin",
        title="Software Engineer Intern",
    )
    absorb_new_aggregator_rows(db_session)
    db_session.refresh(different)
    assert different.duplicate_of is None
