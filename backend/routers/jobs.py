"""
Job listing endpoints (data only — no bot automation).

GET  /jobs          — list scraped jobs with filters
GET  /jobs/{id}     — get a single job
GET  /jobs/stats    — aggregate stats
POST /jobs/{id}/save   — save a job
POST /jobs/{id}/unsave — unsave a job
"""

import logging
import re
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session
from sqlalchemy import func, or_

from backend.db.database import get_db
from backend.db.models import ScrapedJob, JobStatus, ApplicationRecord, UserSavedJob
from backend.auth.dependencies import get_verified_user_id, get_optional_user_id, get_admin_user_id
from backend.schemas.jobs import ScrapedJobOut
from backend.services.description_extractor import (
    BROWSER_HEADERS,
    extract_description_from_html,
    extract_description_from_url,
)

logger = logging.getLogger(__name__)
router = APIRouter()


def _escape_like(term: str) -> str:
    """Escape SQL LIKE wildcards to prevent DoS via expensive patterns."""
    return re.sub(r'([%_])', r'\\\1', term)


def _sanitize_description(text: str) -> str:
    """Sanitize HTML from job descriptions to prevent stored XSS."""
    import nh3
    # Strip all HTML tags, keeping only safe text content
    return nh3.clean(text, tags=set())


@router.get("", response_model=list[ScrapedJobOut])
def list_jobs(
    status: Optional[JobStatus] = None,
    min_score: int = Query(0, ge=0),
    source: Optional[str] = None,
    saved: Optional[int] = None,
    search: Optional[str] = None,
    location: Optional[str] = None,
    country: Optional[str] = None,
    work_type: Optional[str] = None,
    role_category: Optional[str] = None,
    experience_level: Optional[str] = None,
    date_posted: Optional[str] = None,
    sort: Optional[str] = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    db: Session = Depends(get_db),
):
    """List scraped jobs, optionally filtered by status, match score, source, country, work_type, etc."""
    from backend.services.job_filters import (
        date_posted_cutoff,
        expand_experience_filter_values,
    )

    q = db.query(ScrapedJob).filter(ScrapedJob.match_score >= min_score)
    q = q.filter(
        ScrapedJob.company.isnot(None),
        func.trim(ScrapedJob.company) != "",
        ScrapedJob.company != "Unknown",
    )

    if status:
        q = q.filter(ScrapedJob.status == status)
    if source:
        q = q.filter(ScrapedJob.source_platform == source)
    if saved is not None:
        q = q.filter(ScrapedJob.saved == saved)
    if search:
        search_term = _escape_like(search.strip())
        if search_term:
            q = q.filter(
                or_(
                    ScrapedJob.title.ilike(f"%{search_term}%"),
                    ScrapedJob.company.ilike(f"%{search_term}%"),
                )
            )
    if location:
        city_values = [c.strip() for c in location.split(",") if c.strip()]
        if city_values:
            location_conditions = [
                ScrapedJob.location.ilike(f"%{city}%") for city in city_values
            ]
            q = q.filter(or_(*location_conditions))

    if country:
        country_values = [c.strip().upper() for c in country.split(",") if c.strip()]
        if country_values:
            q = q.filter(ScrapedJob.country.in_(country_values))
    if work_type:
        work_type_values = [w.strip().lower() for w in work_type.split(",") if w.strip()]
        if work_type_values:
            q = q.filter(ScrapedJob.work_type.in_(work_type_values))
    if role_category:
        category_values = [c.strip() for c in role_category.split(",") if c.strip()]
        if category_values:
            from backend.services.role_classifier import expand_filter_values
            q = q.filter(ScrapedJob.role_category.in_(expand_filter_values(category_values)))
    if experience_level:
        level_values = [l.strip() for l in experience_level.split(",") if l.strip()]
        if level_values:
            q = q.filter(
                ScrapedJob.experience_level.in_(expand_experience_filter_values(level_values))
            )

    effective_date = func.coalesce(ScrapedJob.posted_date, ScrapedJob.scraped_at)
    cutoff = date_posted_cutoff(date_posted or "")
    if cutoff is not None:
        q = q.filter(effective_date >= cutoff)

    if sort == "match":
        q = q.order_by(
            ScrapedJob.match_score.desc(),
            effective_date.desc().nullslast(),
        )
    else:
        q = q.order_by(effective_date.desc().nullslast())

    q = q.offset((page - 1) * page_size).limit(page_size)
    return q.all()


@router.post("/create")
def create_job(
    title: str,
    company: str,
    location: str,
    url: str,
    source_platform: str = "linkedin",
    experience_level: str = "new_grad",
    work_type: str = "onsite",
    country: str = "CA",
    _admin: int = Depends(get_admin_user_id),
    db: Session = Depends(get_db),
):
    """Create a new job listing (admin only — used by scrapers to push jobs)."""
    # Dedup by URL
    existing = db.query(ScrapedJob).filter(ScrapedJob.url == url).first()
    if existing:
        return {"status": "duplicate", "id": existing.id}

    import re
    cleaned_company = re.sub(r'[^a-z0-9]', '', company.lower())

    job = ScrapedJob(
        title=title,
        company=company,
        location=location,
        url=url,
        description="",
        source_platform=source_platform,
        easy_apply=0,
        work_type=work_type,
        role_category="",
        country=country,
        experience_level=experience_level,
        company_logo=f"https://icon.horse/icon/{cleaned_company}.com",
    )
    db.add(job)
    db.commit()
    db.refresh(job)
    return {"status": "created", "id": job.id}


@router.get("/stats")
def job_stats(db: Session = Depends(get_db)):
    """Return aggregate job stats with breakdowns by country, work_type, role_category, experience_level."""
    # Exclude blank-company jobs to match the listing query.
    _has_company = (
        ScrapedJob.company.isnot(None)
        & (func.trim(ScrapedJob.company) != "")
        & (ScrapedJob.company != "Unknown")
    )
    total = db.query(ScrapedJob).filter(_has_company).count()
    applied = db.query(ScrapedJob).filter(_has_company, ScrapedJob.status == JobStatus.APPLIED).count()
    new = db.query(ScrapedJob).filter(_has_company, ScrapedJob.status == JobStatus.NEW).count()
    saved_count = db.query(ScrapedJob).filter(_has_company, ScrapedJob.saved == 1).count()

    avg_score = db.query(func.avg(ScrapedJob.match_score)).scalar()
    avg_match_score = round(avg_score) if avg_score else 0

    # Breakdown by country
    by_country = {}
    country_counts = (
        db.query(ScrapedJob.country, func.count(ScrapedJob.id))
        .filter(ScrapedJob.country != "")
        .group_by(ScrapedJob.country)
        .all()
    )
    for country, count in country_counts:
        by_country[country] = count

    # Breakdown by work_type
    by_work_type = {}
    work_type_counts = (
        db.query(ScrapedJob.work_type, func.count(ScrapedJob.id))
        .filter(ScrapedJob.work_type != "")
        .group_by(ScrapedJob.work_type)
        .all()
    )
    for wt, count in work_type_counts:
        by_work_type[wt] = count

    # Breakdown by role_category
    by_role_category = {}
    category_counts = (
        db.query(ScrapedJob.role_category, func.count(ScrapedJob.id))
        .filter(ScrapedJob.role_category != "")
        .group_by(ScrapedJob.role_category)
        .all()
    )
    for cat, count in category_counts:
        by_role_category[cat] = count

    # Breakdown by experience_level
    by_experience_level = {}
    level_counts = (
        db.query(ScrapedJob.experience_level, func.count(ScrapedJob.id))
        .filter(ScrapedJob.experience_level != "")
        .group_by(ScrapedJob.experience_level)
        .all()
    )
    for level, count in level_counts:
        by_experience_level[level] = count

    return {
        "total": total,
        "applied": applied,
        "new": new,
        "saved_count": saved_count,
        "avg_match_score": avg_match_score,
        "by_country": by_country,
        "by_work_type": by_work_type,
        "by_role_category": by_role_category,
        "by_experience_level": by_experience_level,
    }


@router.get("/applications")
def list_applications(
    user_id: int = Depends(get_verified_user_id),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    db: Session = Depends(get_db),
):
    """List the current user's application records."""
    records = (
        db.query(ApplicationRecord)
        .filter(ApplicationRecord.user_id == user_id)
        .order_by(ApplicationRecord.applied_at.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )
    return records


@router.get("/{job_id}", response_model=ScrapedJobOut)
def get_job(job_id: int, db: Session = Depends(get_db)):
    """Get a single job by ID."""
    job = db.query(ScrapedJob).filter(ScrapedJob.id == job_id).first()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found.")
    return job


@router.post("/{job_id}/fetch-details")
async def fetch_job_details(
    job_id: int,
    user_id: int = Depends(get_verified_user_id),
    db: Session = Depends(get_db),
):
    """Fetch job description from the apply URL on-demand and cache it."""
    import json
    import httpx
    import ipaddress
    import socket
    from urllib.parse import urlparse

    def _ip_is_internal(ip_str: str) -> bool:
        try:
            ip = ipaddress.ip_address(ip_str)
        except ValueError:
            return True
        return (
            ip.is_private or ip.is_loopback or ip.is_link_local
            or ip.is_reserved or ip.is_multicast or ip.is_unspecified
        )

    def _is_url_allowed(url: str) -> bool:
        try:
            parsed = urlparse(url)
            if parsed.scheme not in ("http", "https"):
                return False
            host = parsed.hostname or ""
            if not host:
                return False
            try:
                ipaddress.ip_address(host)
                return not _ip_is_internal(host)
            except ValueError:
                pass
            try:
                infos = socket.getaddrinfo(host, None)
            except Exception:
                return False
            if not infos:
                return False
            return not any(_ip_is_internal(info[4][0]) for info in infos)
        except Exception:
            return False

    job = db.query(ScrapedJob).filter(ScrapedJob.id == job_id).first()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found.")

    if not job.url or not _is_url_allowed(job.url):
        return {
            "id": job.id,
            "description": job.description or "",
            "apply_url": job.url or "",
            "company_logo": job.company_logo or "",
        }

    if job.description and len(job.description) > 50:
        if "This button displays the currently selected search type" not in job.description:
            return {
                "id": job.id,
                "description": job.description,
                "apply_url": job.url,
                "company_logo": job.company_logo,
            }
        job.description = ""
        db.commit()

    try:
        async with httpx.AsyncClient(follow_redirects=True, timeout=15, headers=BROWSER_HEADERS) as client:
            response = await client.get(job.url)
            text = response.text
            final_url = str(response.url)

            description = await extract_description_from_html(client, job.url, text, final_url)
            apply_url = final_url if final_url != job.url else job.url

            linkedin_url = "linkedin.com/jobs" in job.url or "linkedin.com/jobs" in final_url
            if linkedin_url:
                if not job.company or job.company.strip() == "":
                    og_title_match = re.search(
                        r'<meta\s+property="og:title"\s+content="([^"]*)"',
                        text, re.IGNORECASE,
                    )
                    if og_title_match:
                        og_title = og_title_match.group(1)
                        at_match = re.search(r'\s+at\s+(.+?)(?:\s*\||\s*-|\s*$)', og_title)
                        hiring_match = re.search(r'^(.+?)\s+hiring\s+', og_title)
                        if at_match:
                            job.company = at_match.group(1).strip()
                        elif hiring_match:
                            job.company = hiring_match.group(1).strip()

                if not job.company_logo:
                    logo_match = re.search(
                        r'<img[^>]*class="[^"]*artdeco-entity-image[^"]*"[^>]*src="([^"]+)"',
                        text, re.IGNORECASE,
                    )
                    if not logo_match:
                        logo_match = re.search(
                            r'<meta\s+property="og:image"\s+content="([^"]*)"',
                            text, re.IGNORECASE,
                        )
                    if logo_match:
                        logo_url = logo_match.group(1)
                        if logo_url.startswith("http") and "linkedin" not in logo_url.lower():
                            job.company_logo = logo_url
                    if not job.company_logo and job.company:
                        cleaned = re.sub(r'[^a-z0-9]', '', job.company.lower())
                        if len(cleaned) >= 2:
                            job.company_logo = f"https://logos-api.apistemic.com/domain:{cleaned}.com?fallback=404"

            next_match = re.search(
                r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>',
                text, re.DOTALL,
            )
            if next_match:
                try:
                    next_data = json.loads(next_match.group(1))
                    job_result = (
                        next_data.get("props", {})
                        .get("pageProps", {})
                        .get("dataSource", {})
                        .get("jobResult", {})
                    ) or {}
                    if job_result:
                        logo = job_result.get("jdLogo", "")
                        if logo and isinstance(logo, str) and logo.startswith("http") and not job.company_logo:
                            job.company_logo = logo
                        salary = job_result.get("salaryDesc", "")
                        if salary and not job.salary_range:
                            job.salary_range = salary[:255]
                        applicants = job_result.get("applicantsCount")
                        if isinstance(applicants, int) and applicants >= 0 and job.applicant_count is None:
                            job.applicant_count = applicants
                        work_model = (job_result.get("workModel") or "").lower()
                        if work_model:
                            if "remote" in work_model:
                                job.work_type = "remote"
                            elif "hybrid" in work_model:
                                job.work_type = "hybrid"
                            elif "site" in work_model or "office" in work_model:
                                job.work_type = "onsite"
                except (json.JSONDecodeError, KeyError, TypeError):
                    pass

            if not job.company_logo:
                logo_match = re.search(
                    r'<meta\s+property="og:image"\s+content="([^"]*)"',
                    text, re.IGNORECASE,
                )
                if logo_match:
                    logo_url = logo_match.group(1)
                    if logo_url.startswith("http"):
                        job.company_logo = logo_url

            if description:
                job.description = _sanitize_description(description)

            db.commit()

            return {
                "id": job.id,
                "description": job.description or "",
                "apply_url": apply_url if not linkedin_url else job.url,
                "company_logo": job.company_logo or "",
                "company": job.company or "",
                "company_domain": job.company_domain or "",
                "salary_range": job.salary_range or "",
                "applicant_count": job.applicant_count,
                "work_type": job.work_type or "",
            }
    except Exception as e:
        logger.warning(f"Failed to fetch details for job {job_id}: {e}")
        return {
            "id": job.id,
            "description": job.description or "",
            "apply_url": job.url,
            "company_logo": job.company_logo or "",
        }


@router.post("/{job_id}/structure-description")
async def structure_description(
    job_id: int,
    user_id: int = Depends(get_verified_user_id),
    db: Session = Depends(get_db),
):
    """Parse a job description into structured sections using Claude AI. Cached in DB."""
    import json
    from backend.services.llm import get_llm_service

    job = db.query(ScrapedJob).filter(ScrapedJob.id == job_id).first()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found.")

    if not job.description or len(job.description) < 50:
        return {"sections": [], "skills": [], "error": "No description available"}

    # Check cache (stored in company_description field as JSON)
    if job.company_description and job.company_description.startswith("{"):
        try:
            cached = json.loads(job.company_description)
            if cached.get("sections"):
                return cached
        except (json.JSONDecodeError, TypeError):
            pass

    llm = get_llm_service()

    prompt = f"""Parse this job description into structured sections. Return a JSON object with:
{{
  "sections": [
    {{"title": "Responsibilities", "icon": "clipboard-list", "items": ["item 1", "item 2", ...]}},
    {{"title": "Qualifications", "icon": "graduation-cap", "subsections": [
      {{"title": "Required", "items": ["item 1", ...]}},
      {{"title": "Preferred", "items": ["item 1", ...]}}
    ]}},
    {{"title": "Benefits", "icon": "gift", "items": ["item 1", ...]}}
  ],
  "skills": ["Python", "Java", "AWS", "SQL", ...],
  "experience_years": "2-4",
  "education": "BS/MS in Computer Science"
}}

Rules:
- Extract ALL bullet points into the appropriate section
- Skills should be specific technologies, tools, languages, frameworks
- If a section doesn't exist in the description, omit it
- Keep items concise (one sentence each)
- Include 5-15 skills maximum

Job Description:
{job.description[:4000]}"""

    try:
        response = await llm._generate(prompt)
        # Parse JSON from response
        json_str = response.strip()
        if "```" in json_str:
            parts = json_str.split("```")
            for part in parts:
                part = part.strip()
                if part.startswith("json"):
                    part = part[4:].strip()
                if part.startswith("{"):
                    json_str = part
                    break
        if not json_str.startswith("{"):
            start = json_str.find("{")
            end = json_str.rfind("}")
            if start >= 0 and end > start:
                json_str = json_str[start:end + 1]

        data = json.loads(json_str)

        # Cache the result in DB
        if data.get("sections"):
            job.company_description = json.dumps(data)
            db.commit()

        return data
    except Exception as e:
        return {"sections": [], "skills": [], "error": str(e)}


@router.post("/{job_id}/save", response_model=ScrapedJobOut)
def save_job(
    job_id: int,
    user_id: int = Depends(get_verified_user_id),
    db: Session = Depends(get_db),
):
    """Save a job (bookmark it) for the current user."""
    job = db.query(ScrapedJob).filter(ScrapedJob.id == job_id).first()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found.")
    # Check if already saved
    existing = db.query(UserSavedJob).filter(
        UserSavedJob.user_id == user_id,
        UserSavedJob.job_id == job_id,
    ).first()
    if not existing:
        saved_entry = UserSavedJob(user_id=user_id, job_id=job_id)
        db.add(saved_entry)
        db.commit()
    db.refresh(job)
    return job


@router.post("/{job_id}/unsave", response_model=ScrapedJobOut)
def unsave_job(
    job_id: int,
    user_id: int = Depends(get_verified_user_id),
    db: Session = Depends(get_db),
):
    """Unsave a job (remove bookmark) for the current user."""
    job = db.query(ScrapedJob).filter(ScrapedJob.id == job_id).first()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found.")
    db.query(UserSavedJob).filter(
        UserSavedJob.user_id == user_id,
        UserSavedJob.job_id == job_id,
    ).delete()
    db.commit()
    db.refresh(job)
    return job


@router.post("/fix-empty-companies")
async def fix_empty_companies(
    _admin: int = Depends(get_admin_user_id),
    db: Session = Depends(get_db),
):
    """Fix jobs with empty company names by extracting from LinkedIn or other sources."""
    import re
    import httpx

    jobs_with_empty_company = (
        db.query(ScrapedJob)
        .filter(ScrapedJob.company == "")
        .limit(50)
        .all()
    )

    fixed = 0
    for job in jobs_with_empty_company:
        company_name = ""

        # Try to extract company from LinkedIn job URL
        if "linkedin.com/jobs/view" in (job.url or ""):
            try:
                async with httpx.AsyncClient(follow_redirects=True, timeout=10) as client:
                    resp = await client.get(job.url)
                    text = resp.text
                    # LinkedIn og:title format: "Company hiring Title in Location | LinkedIn"
                    og_match = re.search(r'property="og:title"[^>]*content="([^"]*)"', text)
                    if og_match:
                        og_title = og_match.group(1)
                        # Format: "Company hiring Job Title in Location | LinkedIn"
                        if " hiring " in og_title:
                            company_name = og_title.split(" hiring ")[0].strip()
                        elif " at " in og_title:
                            # Alternate format: "Job Title at Company | LinkedIn"
                            company_name = og_title.split(" at ")[1].split("|")[0].strip()
                    if not company_name:
                        # Try title tag: "Company hiring Title..."
                        title_match = re.search(r'<title>([^<]*)</title>', text)
                        if title_match:
                            title_text = title_match.group(1)
                            if " hiring " in title_text:
                                company_name = title_text.split(" hiring ")[0].strip()
            except Exception:
                pass

        if company_name:
            job.company = company_name
            # Also set company logo
            cleaned = company_name.lower().replace(" ", "").replace(".", "")
            job.company_logo = f"https://icon.horse/icon/{cleaned}.com"
            db.commit()
            fixed += 1

    return {"total_empty": len(jobs_with_empty_company), "fixed": fixed}


@router.post("/batch-fix-descriptions")
async def batch_fix_descriptions(
    batch_size: int = Query(20, ge=1, le=50),
    _admin: int = Depends(get_admin_user_id),
    db: Session = Depends(get_db),
):
    """Batch fix jobs with missing or garbage descriptions.

    Processes LinkedIn and Greenhouse/Lever jobs that have empty or garbage descriptions.
    Prioritizes LinkedIn jobs (most common source for missing descriptions).
    """
    import re
    import json
    import httpx

    GARBAGE_PATTERNS = [
        "This button displays the currently selected search type",
        "Sign in to view more",
        "Join now to see",
    ]

    # Find jobs needing description fixes
    jobs_to_fix = (
        db.query(ScrapedJob)
        .filter(
            or_(
                ScrapedJob.description == "",
                ScrapedJob.description == None,
                ScrapedJob.description.ilike("%This button displays%"),
            )
        )
        .limit(batch_size)
        .all()
    )

    fixed = 0
    failed = 0
    results = []

    async with httpx.AsyncClient(follow_redirects=True, timeout=15, headers=BROWSER_HEADERS) as client:
        for job in jobs_to_fix:
            try:
                description = await extract_description_from_url(client, job.url or "")
                if description:
                    job.description = _sanitize_description(description)
                    db.commit()
                    fixed += 1
                    results.append({"id": job.id, "company": job.company, "status": "fixed"})
                else:
                    failed += 1
                    results.append({"id": job.id, "company": job.company, "status": "no_description_found"})
            except Exception as e:
                failed += 1
                results.append({"id": job.id, "company": job.company, "status": f"error: {str(e)[:50]}"})

    return {
        "total_processed": len(jobs_to_fix),
        "fixed": fixed,
        "failed": failed,
        "remaining": db.query(ScrapedJob).filter(
            or_(
                ScrapedJob.description == "",
                ScrapedJob.description == None,
            )
        ).count(),
    }


@router.post("/batch-enrich-salaries")
async def batch_enrich_salaries(
    batch_size: int = Query(50, ge=1, le=200),
    _admin: int = Depends(get_admin_user_id),
    db: Session = Depends(get_db),
):
    """Enrich jobs with salary data from Levels.fyi and known company ranges.

    Uses a mapping of known intern/new-grad salary ranges for major tech companies.
    For companies not in the mapping, attempts to extract from job descriptions.
    """
    import re

    # Known intern/new-grad hourly rates (CAD/USD) from Levels.fyi and public data
    SALARY_MAP = {
        # Big Tech
        "google": "$45-55/hr",
        "amazon": "$40-50/hr",
        "microsoft": "$40-52/hr",
        "apple": "$40-55/hr",
        "meta": "$45-55/hr",
        # Mid-size Tech
        "shopify": "$35-45/hr CAD",
        "databricks": "$45-55/hr",
        "stripe": "$45-55/hr",
        "airbnb": "$45-55/hr",
        "uber": "$42-52/hr",
        "lyft": "$40-50/hr",
        "pinterest": "$40-50/hr",
        "reddit": "$40-50/hr",
        "discord": "$40-50/hr",
        "figma": "$45-55/hr",
        "roblox": "$45-55/hr",
        "robinhood": "$42-52/hr",
        "cloudflare": "$38-48/hr",
        "datadog": "$40-50/hr",
        "mongodb": "$35-45/hr",
        "elastic": "$35-45/hr",
        "twilio": "$38-48/hr",
        "okta": "$35-45/hr",
        "pagerduty": "$35-45/hr",
        "samsara": "$38-48/hr",
        "scale ai": "$45-55/hr",
        "spacex": "$30-38/hr",
        "palantir": "$45-55/hr",
        # Canadian companies
        "ciena": "$25-34/hr CAD",
        "nokia": "$28-38/hr CAD",
        "ericsson": "$28-38/hr CAD",
        "blackberry": "$25-35/hr CAD",
        "kinaxis": "$25-35/hr CAD",
        "ross video": "$22-30/hr CAD",
        "fullscript": "$25-35/hr CAD",
        "solace": "$28-38/hr CAD",
        "fortinet": "$30-40/hr CAD",
        # Finance
        "jane street": "$55-65/hr",
        "citadel": "$55-65/hr",
        "two sigma": "$50-60/hr",
        # Other
        "nvidia": "$42-55/hr",
        "intel": "$30-40/hr",
        "amd": "$30-40/hr",
        "qualcomm": "$32-42/hr",
        "broadcom": "$32-42/hr",
        "cisco": "$30-40/hr",
        "ibm": "$25-35/hr",
        "oracle": "$30-40/hr",
        "salesforce": "$40-50/hr",
        "adobe": "$38-48/hr",
        "vmware": "$35-45/hr",
        "splunk": "$38-48/hr",
        "atlassian": "$40-50/hr",
        "snap": "$42-52/hr",
        "doordash": "$40-50/hr",
        "instacart": "$38-48/hr",
        "coinbase": "$45-55/hr",
        "block": "$40-50/hr",
        "square": "$40-50/hr",
        "affirm": "$42-52/hr",
        "brex": "$40-50/hr",
        "chime": "$38-48/hr",
        "sofi": "$35-45/hr",
        "toast": "$35-45/hr",
        "gusto": "$38-48/hr",
        "vercel": "$35-45/hr",
        "netlify": "$35-45/hr",
        "webflow": "$35-45/hr",
        "duolingo": "$40-50/hr",
        "epic games": "$38-48/hr",
        "riot games": "$38-48/hr",
        "unity": "$35-45/hr",
        "waymo": "$45-55/hr",
        "nuro": "$42-52/hr",
        "zoox": "$42-52/hr",
        "lucid motors": "$35-45/hr",
        "roku": "$38-48/hr",
        "peloton": "$35-45/hr",
        "dropbox": "$40-50/hr",
        "asana": "$40-50/hr",
        "gitlab": "$35-45/hr",
        "new relic": "$35-45/hr",
        "cockroachdb": "$38-48/hr",
        "contentful": "$35-45/hr",
        "flexport": "$38-48/hr",
        "faire": "$38-48/hr",
        "squarespace": "$38-48/hr",
        "wattpad": "$25-35/hr CAD",
        "vanta": "$40-50/hr",
    }

    # Find jobs without salary data (newest first so recent jobs get enriched first)
    jobs_to_enrich = (
        db.query(ScrapedJob)
        .filter(
            or_(
                ScrapedJob.salary_range == "",
                ScrapedJob.salary_range == None,
            ),
            ScrapedJob.experience_level.in_(["internship", "new_grad"]),
        )
        .order_by(ScrapedJob.id.desc())
        .limit(batch_size)
        .all()
    )

    enriched = 0
    for job in jobs_to_enrich:
        company_lower = job.company.lower().strip()

        # Check direct match
        salary = SALARY_MAP.get(company_lower)

        # Check partial match (e.g., "Scale AI" matches "scale ai")
        if not salary:
            for key, val in SALARY_MAP.items():
                if key in company_lower or company_lower in key:
                    salary = val
                    break

        # Try to extract from description
        if not salary and job.description:
            # Look for patterns like "$XX/hr", "$XX-$YY/hr", "$XX,000-$YY,000"
            hr_match = re.search(r'\$(\d+(?:\.\d+)?)\s*[-–]\s*\$?(\d+(?:\.\d+)?)\s*/\s*(?:hr|hour)', job.description, re.IGNORECASE)
            if hr_match:
                salary = f"${hr_match.group(1)}-${hr_match.group(2)}/hr"
            else:
                annual_match = re.search(r'\$(\d{2,3}),?(\d{3})\s*[-–]\s*\$?(\d{2,3}),?(\d{3})', job.description)
                if annual_match:
                    low = int(annual_match.group(1) + annual_match.group(2))
                    high = int(annual_match.group(3) + annual_match.group(4))
                    if low > 10000 and high > 10000:
                        salary = f"${low:,}-${high:,}/yr"

        if salary:
            job.salary_range = salary
            db.commit()
            enriched += 1

    remaining = db.query(ScrapedJob).filter(
        or_(
            ScrapedJob.salary_range == "",
            ScrapedJob.salary_range == None,
        ),
        ScrapedJob.experience_level.in_(["internship", "new_grad"]),
    ).count()

    return {
        "total_processed": len(jobs_to_enrich),
        "enriched": enriched,
        "remaining_without_salary": remaining,
    }
