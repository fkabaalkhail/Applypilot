"""Tests for high-match job alert emails and the notifier's gating logic."""

import datetime
import types

import pytest

from backend.db.models import JobMatchNotification, ResumeProfileDB, ScrapedJob, User
from backend.services import match_notifier
from backend.services.email_service import EmailService


# ─── Email HTML builder ──────────────────────────────────────────────────────

def _sample_jobs():
    return [
        {
            "title": "Junior Algorithms Developer - C++",
            "company": "Kinaxis",
            "match_score": 88,
            "location": "Ottawa, ON, CA",
            "salary": "$140K/yr - $180K/yr",
            "posted": "8 minutes ago",
            "apply_url": "https://app.tailrd.com/app?job=42",
        },
        {
            "title": "Data & Platform Engineering Intern",
            "company": "Bombardier",
            "match_score": 83,
            "location": "Dorval, Quebec, Canada",
            "salary": "",
            "posted": "26 minutes ago",
            "apply_url": "https://app.tailrd.com/app?job=43",
        },
    ]


def test_alert_html_contains_jobs_and_scores():
    svc = EmailService()
    html = svc._build_job_alert_html(_sample_jobs(), recipient_name="Sam")

    assert "Hi Sam," in html
    assert "Kinaxis" in html
    assert "88% match" in html
    assert "Junior Algorithms Developer" in html
    assert "$140K/yr - $180K/yr" in html
    assert "https://app.tailrd.com/app?job=42" in html
    # Both jobs render.
    assert "Bombardier" in html
    assert "83% match" in html
    # Stripe indigo CTA is used.
    assert "#533afd" in html


def test_alert_html_escapes_untrusted_fields():
    jobs = [
        {
            "title": "<script>alert(1)</script>",
            "company": "Acme & Co",
            "match_score": 90,
            "apply_url": "https://app.tailrd.com/app?job=1",
        }
    ]
    html = EmailService()._build_job_alert_html(jobs)
    assert "<script>alert(1)</script>" not in html
    assert "&lt;script&gt;" in html
    assert "Acme &amp; Co" in html


def test_alert_html_handles_missing_optional_fields():
    jobs = [{"title": "Engineer", "company": "Globex", "match_score": 81,
             "apply_url": "#"}]
    # No location/salary/posted should not raise and not emit stray separators.
    html = EmailService()._build_job_alert_html(jobs)
    assert "Engineer" in html
    assert " · " not in html  # no empty meta separator


def test_alert_card_renders_logo_image_when_present():
    jobs = [{
        "title": "Engineer", "company": "Kinaxis", "match_score": 88,
        "apply_url": "#",
        "logo_url": "https://www.google.com/s2/favicons?domain=kinaxis.com&sz=128",
    }]
    html = EmailService()._build_job_alert_html(jobs)
    assert '<img src="https://www.google.com/s2/favicons?domain=kinaxis.com' in html


def test_alert_card_falls_back_to_letter_avatar_without_logo():
    jobs = [{"title": "Engineer", "company": "Zeta", "match_score": 81, "apply_url": "#"}]
    html = EmailService()._build_job_alert_html(jobs)
    # No <img>, but a letter-avatar tile showing the first initial.
    assert "<img" not in html
    assert ">Z</div>" in html


def test_resolve_logo_url_prefers_real_stored_logo(db_session):
    job = _make_job(db_session)
    job.company_logo = "https://cdn.jobright.ai/logos/initech.png"
    db_session.commit()
    assert match_notifier._resolve_logo_url(job) == "https://cdn.jobright.ai/logos/initech.png"


def test_resolve_logo_url_skips_generated_logo_and_uses_domain(db_session):
    job = _make_job(db_session, company="Kinaxis")
    job.company_logo = "https://logo.clearbit.com/old.com"  # generated → ignored
    job.company_domain = "kinaxis.com"
    db_session.commit()
    url = match_notifier._resolve_logo_url(job)
    assert "kinaxis.com" in url
    assert "clearbit" not in url


def test_send_job_match_alert_skips_when_not_configured(monkeypatch):
    svc = EmailService()
    svc.api_key = None
    svc.from_email = None
    assert svc.send_job_match_alert("u@example.com", _sample_jobs()) is False


def test_send_job_match_alert_skips_empty_jobs():
    svc = EmailService()
    svc.api_key = "re_test"
    svc.from_email = "alerts@tailrd.com"
    assert svc.send_job_match_alert("u@example.com", []) is False


def test_send_job_match_alert_subject_from_top_job(monkeypatch):
    svc = EmailService()
    svc.api_key = "re_test"
    svc.from_email = "alerts@tailrd.com"

    captured = {}

    def fake_send(payload):
        captured.update(payload)
        return {"id": "email_1"}

    import backend.services.email_service as es
    monkeypatch.setattr(es.resend.Emails, "send", staticmethod(fake_send))

    assert svc.send_job_match_alert("u@example.com", _sample_jobs()) is True
    assert captured["to"] == ["u@example.com"]
    assert "Kinaxis just posted a 88% match" in captured["subject"]


# ─── notify_high_matches gating ──────────────────────────────────────────────

@pytest.fixture
def verified_user(db_session):
    user = User(
        email="match@example.com",
        first_name="Sam",
        email_verified=True,
        auth_provider="local",
    )
    db_session.add(user)
    db_session.commit()
    db_session.refresh(user)
    return user


def _make_job(db_session, title="Engineer", company="Globex"):
    job = ScrapedJob(
        title=title,
        company=company,
        url=f"https://jobs.example.com/{title}-{company}".replace(" ", "-"),
        description="x" * 200,
        posted_date=datetime.datetime.utcnow(),
    )
    db_session.add(job)
    db_session.commit()
    db_session.refresh(job)
    return job


@pytest.fixture
def capture_email(monkeypatch):
    """Stub the email send so notifier tests never hit the network."""
    sent = []

    def fake_send(to_email, jobs, recipient_name=None):
        sent.append({"to": to_email, "jobs": jobs, "name": recipient_name})
        return True

    monkeypatch.setattr(
        match_notifier.email_service, "send_job_match_alert", fake_send
    )
    return sent


def test_notify_sends_only_high_matches(db_session, verified_user, capture_email):
    strong = _make_job(db_session, "Strong Role")
    weak = _make_job(db_session, "Weak Role")

    count = match_notifier.notify_high_matches(
        db_session, verified_user.id, [(strong, 88), (weak, 55)]
    )

    assert count == 1
    assert len(capture_email) == 1
    titles = [j["title"] for j in capture_email[0]["jobs"]]
    assert titles == ["Strong Role"]
    # A dedup row was recorded for the notified job only.
    rows = db_session.query(JobMatchNotification).all()
    assert {r.job_id for r in rows} == {strong.id}


def test_notify_skips_unverified_user(db_session, capture_email):
    user = User(email="nope@example.com", email_verified=False, auth_provider="local")
    db_session.add(user)
    db_session.commit()
    db_session.refresh(user)
    job = _make_job(db_session)

    count = match_notifier.notify_high_matches(db_session, user.id, [(job, 95)])

    assert count == 0
    assert capture_email == []
    assert db_session.query(JobMatchNotification).count() == 0


def test_notify_dedupes_already_notified_jobs(db_session, verified_user, capture_email):
    job = _make_job(db_session)
    db_session.add(
        JobMatchNotification(user_id=verified_user.id, job_id=job.id, match_score=90)
    )
    db_session.commit()

    count = match_notifier.notify_high_matches(db_session, verified_user.id, [(job, 92)])

    assert count == 0
    assert capture_email == []
    # Still just the one pre-existing row.
    assert db_session.query(JobMatchNotification).count() == 1


def test_notify_threshold_is_env_overridable(db_session, verified_user, capture_email, monkeypatch):
    monkeypatch.setenv("MATCH_NOTIFY_THRESHOLD", "70")
    job = _make_job(db_session)

    count = match_notifier.notify_high_matches(db_session, verified_user.id, [(job, 72)])

    assert count == 1
    assert len(capture_email) == 1


def test_notify_not_recorded_when_send_fails(db_session, verified_user, monkeypatch):
    monkeypatch.setattr(
        match_notifier.email_service,
        "send_job_match_alert",
        lambda *a, **k: False,
    )
    job = _make_job(db_session)

    count = match_notifier.notify_high_matches(db_session, verified_user.id, [(job, 99)])

    assert count == 0
    # Nothing recorded, so a later run can retry.
    assert db_session.query(JobMatchNotification).count() == 0


def test_notify_respects_user_cooldown(db_session, verified_user, capture_email):
    # The user was alerted about a different job a moment ago.
    old_job = _make_job(db_session, "Old Role")
    db_session.add(
        JobMatchNotification(user_id=verified_user.id, job_id=old_job.id, match_score=90)
    )
    db_session.commit()

    new_job = _make_job(db_session, "New Role")
    count = match_notifier.notify_high_matches(db_session, verified_user.id, [(new_job, 95)])

    assert count == 0
    assert capture_email == []
    # New job NOT recorded — it rolls into the next eligible run.
    assert db_session.query(JobMatchNotification).filter_by(job_id=new_job.id).count() == 0


def test_notify_cooldown_disabled_allows_send(db_session, verified_user, capture_email, monkeypatch):
    monkeypatch.setenv("MATCH_NOTIFY_COOLDOWN_HOURS", "0")
    old_job = _make_job(db_session, "Old Role")
    db_session.add(
        JobMatchNotification(user_id=verified_user.id, job_id=old_job.id, match_score=90)
    )
    db_session.commit()

    new_job = _make_job(db_session, "New Role")
    count = match_notifier.notify_high_matches(db_session, verified_user.id, [(new_job, 95)])

    assert count == 1
    assert len(capture_email) == 1


def test_notify_respects_daily_budget(db_session, verified_user, capture_email, monkeypatch):
    monkeypatch.setenv("MATCH_NOTIFY_COOLDOWN_HOURS", "0")
    monkeypatch.setenv("MATCH_NOTIFY_DAILY_BUDGET", "0")
    job = _make_job(db_session)

    count = match_notifier.notify_high_matches(db_session, verified_user.id, [(job, 99)])

    assert count == 0
    assert capture_email == []
    assert db_session.query(JobMatchNotification).count() == 0


# ─── Cron endpoint ───────────────────────────────────────────────────────────

def test_cron_match_alerts_endpoint(client, db_session, monkeypatch):
    user = User(
        email="cron@example.com", first_name="Cron", email_verified=True,
        auth_provider="local",
    )
    db_session.add(user)
    db_session.commit()
    db_session.refresh(user)

    db_session.add(ResumeProfileDB(user_id=user.id, raw_text="resume body text"))
    job = _make_job(db_session, "Cron Role", "Initech")
    db_session.commit()

    async def fake_breakdown(self, resume_text, job_description):
        return types.SimpleNamespace(overall_score=91)

    monkeypatch.setattr(
        "backend.routers.ai.MatchEngine.compute_breakdown", fake_breakdown
    )

    sent = []
    monkeypatch.setattr(
        match_notifier.email_service,
        "send_job_match_alert",
        lambda to, jobs, name=None: (sent.append((to, jobs)) or True),
    )

    resp = client.post("/ai/cron-match-alerts")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "completed"
    assert body["users_notified"] == 1
    assert body["jobs_notified"] == 1
    assert len(sent) == 1
    # Dedup row persisted.
    assert db_session.query(JobMatchNotification).filter_by(
        user_id=user.id, job_id=job.id
    ).count() == 1
