"""Send a real job-match alert email via Resend (manual smoke test).

Usage (PowerShell):
    $env:RESEND_API_KEY="re_xxx"
    $env:RESEND_FROM_EMAIL="alerts@yourdomain.com"   # must be a verified Resend sender
    $env:FRONTEND_URL="https://your-deployed-site"   # so the brand logo loads
    python backend/scripts/send_test_alert.py fk.abaalkhail@gmail.com

Notes:
    - On the Resend free tier with NO verified domain you can only send from
      onboarding@resend.dev and only TO the email you signed up with.
    - This exercises the real Resend delivery path (not the LLM scoring).
"""

import sys

from backend.services.email_service import email_service
from backend.services.logo_resolver import logo_url_for_domain as L


SAMPLE_JOBS = [
    {
        "title": "Junior Algorithms Developer - C++",
        "company": "Kinaxis",
        "match_score": 88,
        "location": "Ottawa, ON, CA",
        "salary": "$140K/yr - $180K/yr",
        "posted": "8 minutes ago",
        "apply_url": "https://example.com/apply/kinaxis",
        "logo_url": L("kinaxis.com"),
    },
    {
        "title": "Intern, Data & Platform Engineering (Fall 2026)",
        "company": "Bombardier",
        "match_score": 83,
        "location": "Dorval, Quebec, Canada",
        "salary": "",
        "posted": "26 minutes ago",
        "apply_url": "https://example.com/apply/bombardier",
        "logo_url": L("bombardier.com"),
    },
    {
        "title": "Full-Stack Developer (Go, Node & Kubernetes)",
        "company": "Fortinet",
        "match_score": 87,
        "location": "Ottawa, ON, Canada",
        "salary": "$97K/yr - $118K/yr",
        "posted": "13 hours ago",
        "apply_url": "https://example.com/apply/fortinet",
        "logo_url": L("fortinet.com"),
    },
]


def main() -> int:
    recipient = sys.argv[1] if len(sys.argv) > 1 else "fk.abaalkhail@gmail.com"

    if not email_service.is_configured:
        print(
            "ERROR: RESEND_API_KEY and RESEND_FROM_EMAIL must be set in the "
            "environment before running this script."
        )
        return 1

    print(f"From:      {email_service.from_email}")
    print(f"To:        {recipient}")
    print(f"Logo base: {email_service.frontend_url or '(none — text fallback)'}")
    print("Sending...")

    ok = email_service.send_job_match_alert(
        recipient, SAMPLE_JOBS, recipient_name="Fahad"
    )
    if ok:
        print("OK: Resend accepted the email. Check the inbox (and spam).")
        return 0
    print("FAILED: send returned False — see the logged Resend error above.")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
