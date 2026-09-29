"""cron-ats hands the Workday detail budget out per board.

A new Workday row needs one detail request for its description, and the run
caps those (WORKDAY_DETAIL_BUDGET). The cap went to boards in the order their
lists finished, so a big newly enabled board (PwC's 212 new postings on
2026-09-29) took all of it on every run and fresh postings on BMO, CIBC or
RBC's early-talent site waited days behind it. Each board now gets at most
WORKDAY_DETAIL_PER_BOARD a run; the rest are inserted on later passes.
"""

import collections

from backend.data import company_registry
from backend.db.models import ScrapedJob
from backend.routers import github_sources
from backend.services import ats_scraper
from backend.services.ats_scraper import ATSJob, ATSScraper, BoardSnapshot

SECRET = "test-cron-secret"


def _run(client, monkeypatch, new_per_board: dict[str, int]):
    import backend.auth.dependencies as auth_deps

    monkeypatch.setattr(auth_deps, "CRON_SECRET", SECRET)
    monkeypatch.setenv("CRON_ATS_SHARDS", "1")
    monkeypatch.setattr(company_registry, "load_companies",
                        lambda **kw: [("workday", slug, slug.title()) for slug in new_per_board])
    monkeypatch.setattr(company_registry, "load_board_countries", lambda: {})

    def listings(slug):
        return [ATSJob(title=f"Software Developer Intern {i}", company=slug.title(),
                       location="Toronto, ON",
                       url=f"https://{slug}.wd3.myworkdayjobs.com/External/job/Toronto-ON/Intern_R{i}",
                       detail_ref=f"/job/Toronto-ON/Intern_R{i}")
                for i in range(new_per_board[slug])]

    async def fake_scrape_board(self, client, platform, slug, company_name):
        jobs = listings(slug)
        return BoardSnapshot(platform=platform, slug=slug, company=company_name, jobs=jobs,
                             all_urls={job.url for job in jobs}, complete=True,
                             total_listed=len(jobs))

    details = collections.Counter()

    async def fake_detail(client, slug, detail_ref):
        details[slug] += 1
        return {"description": "Build and ship internal tools.", "employment_type": "Full time"}

    monkeypatch.setattr(ATSScraper, "scrape_board", fake_scrape_board)
    monkeypatch.setattr(ats_scraper, "fetch_workday_detail", fake_detail)
    res = client.post("/github-sources/cron-ats", headers={"x-cron-secret": SECRET})
    assert res.status_code == 200, res.text
    return res.json(), details


def test_a_big_new_board_cannot_take_the_whole_budget(client, db_session, monkeypatch):
    assert github_sources.WORKDAY_DETAIL_PER_BOARD == 10
    body, details = _run(client, monkeypatch, {"pwc": 212, "bmo": 4})

    assert details == {"pwc": 10, "bmo": 4}
    assert body["new_jobs"] == 14
    stored = collections.Counter(row.board_key for row in db_session.query(ScrapedJob).all())
    assert stored == {"workday:pwc": 10, "workday:bmo": 4}


def test_the_run_total_still_caps_every_board(client, db_session, monkeypatch):
    boards = {f"tenant{i}": 25 for i in range(6)}

    body, details = _run(client, monkeypatch, boards)

    assert sum(details.values()) == github_sources.WORKDAY_DETAIL_BUDGET == 40
    assert max(details.values()) <= 10
    assert body["new_jobs"] == 40


def test_the_rest_are_inserted_on_the_next_pass(client, db_session, monkeypatch):
    _run(client, monkeypatch, {"pwc": 25})
    body, details = _run(client, monkeypatch, {"pwc": 25})

    assert details == {"pwc": 10}
    assert body["new_jobs"] == 10
    assert db_session.query(ScrapedJob).count() == 20
