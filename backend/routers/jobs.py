"""
Job listing endpoints (data only — no bot automation).

GET  /jobs          — list scraped jobs with filters
GET  /jobs/{id}     — get a single job
GET  /jobs/stats    — aggregate stats
POST /jobs/{id}/save   — save a job
POST /jobs/{id}/unsave — unsave a job
"""

import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session
from sqlalchemy import func

from backend.db.database import get_db
from backend.db.models import ScrapedJob, JobStatus, ApplicationRecord
from backend.auth.clerk import get_current_user_id, get_optional_user_id
from backend.schemas.jobs import ScrapedJobOut

logger = logging.getLogger(__name__)
router = APIRouter()


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
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    db: Session = Depends(get_db),
):
    """List scraped jobs, optionally filtered by status, match score, source, country, work_type, etc."""
    from sqlalchemy import or_

    q = db.query(ScrapedJob).filter(ScrapedJob.match_score >= min_score)
    if status:
        q = q.filter(ScrapedJob.status == status)
    if source:
        q = q.filter(ScrapedJob.source_platform == source)
    if saved is not None:
        q = q.filter(ScrapedJob.saved == saved)
    if search:
        search_term = search.strip()
        if search_term:
            q = q.filter(
                or_(
                    ScrapedJob.title.ilike(f"%{search_term}%"),
                    ScrapedJob.company.ilike(f"%{search_term}%"),
                )
            )
    if status:
        q = q.filter(ScrapedJob.status == status)
    if source:
        q = q.filter(ScrapedJob.source_platform == source)
    if saved is not None:
        q = q.filter(ScrapedJob.saved == saved)
    if location:
        city_values = [c.strip() for c in location.split(",") if c.strip()]
        if city_values:
            location_conditions = [
                ScrapedJob.location.ilike(f"%{city}%") for city in city_values
            ]
            q = q.filter(or_(*location_conditions))

    # Aggregator filters (AND logic across different filter types, OR within same filter)
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
            q = q.filter(ScrapedJob.role_category.in_(category_values))
    if experience_level:
        level_values = [l.strip().lower() for l in experience_level.split(",") if l.strip()]
        if level_values:
            q = q.filter(ScrapedJob.experience_level.in_(level_values))

    # Default sort: posted_date descending (newest first)
    q = q.order_by(ScrapedJob.posted_date.desc().nullslast())
    q = q.offset((page - 1) * page_size).limit(page_size)
    return q.all()


@router.get("/stats")
def job_stats(db: Session = Depends(get_db)):
    """Return aggregate job stats with breakdowns by country, work_type, role_category, experience_level."""
    total = db.query(ScrapedJob).count()
    applied = db.query(ScrapedJob).filter(ScrapedJob.status == JobStatus.APPLIED).count()
    new = db.query(ScrapedJob).filter(ScrapedJob.status == JobStatus.NEW).count()
    saved_count = db.query(ScrapedJob).filter(ScrapedJob.saved == 1).count()

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
    user_id: str = Depends(get_current_user_id),
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
async def fetch_job_details(job_id: int, db: Session = Depends(get_db)):
    """Fetch job description from the job page on-demand.

    Tries multiple extraction strategies:
    1. schema.org JSON-LD (JobPosting structured data)
    2. JSON-LD array format (some sites wrap in an array)
    3. __NEXT_DATA__ (Next.js sites like jobright.ai)
    4. Greenhouse/Lever API-style JSON embedded in page
    5. Generic HTML content extraction (meta description + main content)

    Caches the result in the database.
    """
    import re
    import json
    import httpx

    job = db.query(ScrapedJob).filter(ScrapedJob.id == job_id).first()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found.")

    # If we already have a good description, return cached data
    if job.description and len(job.description) > 50:
        # Reject known garbage descriptions (LinkedIn UI text)
        if "This button displays the currently selected search type" not in job.description:
            return {
                "id": job.id,
                "description": job.description,
                "apply_url": job.url,
                "company_logo": job.company_logo,
            }
        else:
            # Clear garbage description so we re-fetch
            job.description = ""
            db.commit()

    # Fetch the page and try multiple extraction strategies
    try:
        async with httpx.AsyncClient(follow_redirects=True, timeout=15) as client:
            response = await client.get(job.url)
            text = response.text
            final_url = str(response.url)

        description = ""
        apply_url = final_url if final_url != job.url else job.url

        # Strategy 0: LinkedIn job pages (special handling - must come first)
        if "linkedin.com/jobs" in job.url:
            # LinkedIn guest view has description in show-more-less-html__markup div
            li_match = re.search(
                r'show-more-less-html__markup[^>]*>(.*?)</div>',
                text, re.DOTALL
            )
            if li_match:
                desc_html = li_match.group(1)
                desc_text = re.sub(r'<[^>]+>', '\n', desc_html)
                desc_text = re.sub(r'\n{3,}', '\n\n', desc_text).strip()
                if len(desc_text) > 50:
                    description = desc_text
            # Fallback: og:description (truncated but better than nothing)
            if not description:
                og_match = re.search(
                    r'(?:og:description|name="description")[^>]*content="([^"]*)"',
                    text, re.IGNORECASE
                )
                if og_match:
                    og_desc = og_match.group(1).strip()
                    # Remove "Posted X. " prefix and "...See this and similar jobs" suffix
                    og_desc = re.sub(r'^Posted [^.]+\.\s*', '', og_desc)
                    og_desc = re.sub(r'…See this and similar jobs on LinkedIn\.$', '', og_desc)
                    if len(og_desc) > 30:
                        description = og_desc

            if description:
                job.description = description
                db.commit()
            return {
                "id": job.id,
                "description": job.description or "",
                "apply_url": job.url,
                "company_logo": job.company_logo or "",
            }

        # Strategy 1: Extract schema.org JSON-LD JobPosting
        schema_matches = re.findall(
            r'<script[^>]*type="application/ld\+json"[^>]*>(.*?)</script>',
            text, re.DOTALL
        )
        for schema_raw in schema_matches:
            try:
                schema_data = json.loads(schema_raw)
                # Handle array format: [{"@type": "JobPosting", ...}]
                if isinstance(schema_data, list):
                    for item in schema_data:
                        if isinstance(item, dict) and item.get("@type") == "JobPosting":
                            schema_data = item
                            break
                    else:
                        continue
                if isinstance(schema_data, dict) and schema_data.get("@type") == "JobPosting":
                    desc_html = schema_data.get("description", "")
                    desc_text = re.sub(r'<[^>]+>', '\n', desc_html)
                    desc_text = re.sub(r'\n{3,}', '\n\n', desc_text).strip()
                    if desc_text and len(desc_text) > 50:
                        description = desc_text
                        # Also try to get apply URL from structured data
                        if schema_data.get("directApply"):
                            apply_url = schema_data.get("url", apply_url)
                        break
            except (json.JSONDecodeError, KeyError, TypeError):
                continue

        # Strategy 2: __NEXT_DATA__ (jobright.ai and other Next.js sites)
        if not description:
            next_match = re.search(
                r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>',
                text, re.DOTALL
            )
            if next_match:
                try:
                    next_data = json.loads(next_match.group(1))
                    # jobright.ai structure
                    job_result = (next_data.get("props", {})
                                  .get("pageProps", {})
                                  .get("dataSource", {})
                                  .get("jobResult", {}))
                    if job_result:
                        desc_html = job_result.get("jdContent", "") or job_result.get("description", "")
                        if desc_html:
                            desc_text = re.sub(r'<[^>]+>', '\n', desc_html)
                            desc_text = re.sub(r'\n{3,}', '\n\n', desc_text).strip()
                            if len(desc_text) > 50:
                                description = desc_text
                        logo = job_result.get("jdLogo", "")
                        if logo and logo.startswith("http") and not job.company_logo:
                            job.company_logo = logo
                except (json.JSONDecodeError, KeyError, TypeError):
                    pass

        # Strategy 3: Greenhouse job board — use API for reliable description
        if not description and "greenhouse.io" in job.url:
            # Extract board slug and job ID from URL
            # Format: https://boards.greenhouse.io/{slug}/jobs/{id}
            gh_api_match = re.search(r'boards\.greenhouse\.io/([^/]+)/jobs/(\d+)', job.url)
            if gh_api_match:
                slug = gh_api_match.group(1)
                gh_job_id = gh_api_match.group(2)
                try:
                    async with httpx.AsyncClient(timeout=10) as api_client:
                        api_url = f"https://boards-api.greenhouse.io/v1/boards/{slug}/jobs/{gh_job_id}"
                        api_resp = await api_client.get(api_url)
                        if api_resp.status_code == 200:
                            gh_data = api_resp.json()
                            desc_html = gh_data.get("content", "")
                            if desc_html:
                                desc_text = re.sub(r'<[^>]+>', '\n', desc_html)
                                desc_text = re.sub(r'\n{3,}', '\n\n', desc_text).strip()
                                if len(desc_text) > 50:
                                    description = desc_text
                except Exception:
                    pass
            # Fallback: try HTML scraping if API didn't work
            if not description:
                gh_match = re.search(
                    r'<div\s+id="content"[^>]*>(.*?)</div>\s*</div>\s*</div>',
                    text, re.DOTALL
                )
                if not gh_match:
                    gh_match = re.search(
                        r'<div\s+class="[^"]*job-post[^"]*"[^>]*>(.*?)</div>\s*(?:</div>\s*)*</section>',
                        text, re.DOTALL
                    )
                if gh_match:
                    desc_text = re.sub(r'<[^>]+>', '\n', gh_match.group(1))
                    desc_text = re.sub(r'\n{3,}', '\n\n', desc_text).strip()
                    if len(desc_text) > 50:
                        description = desc_text

        # Strategy 4: Lever job page — use API for reliable description
        if not description and "lever.co" in job.url:
            # Extract company slug and job ID from URL
            # Format: https://jobs.lever.co/{slug}/{id}
            lever_match = re.search(r'jobs\.lever\.co/([^/]+)/([a-f0-9-]+)', job.url)
            if lever_match:
                slug = lever_match.group(1)
                lever_job_id = lever_match.group(2)
                try:
                    async with httpx.AsyncClient(timeout=10) as api_client:
                        api_url = f"https://api.lever.co/v0/postings/{slug}/{lever_job_id}"
                        api_resp = await api_client.get(api_url)
                        if api_resp.status_code == 200:
                            lever_data = api_resp.json()
                            desc_html = lever_data.get("descriptionPlain", "") or lever_data.get("description", "")
                            if desc_html:
                                desc_text = re.sub(r'<[^>]+>', '\n', desc_html)
                                desc_text = re.sub(r'\n{3,}', '\n\n', desc_text).strip()
                                if len(desc_text) > 50:
                                    description = desc_text
                            # Also get lists (requirements, responsibilities)
                            lists = lever_data.get("lists", [])
                            for lst in lists:
                                list_title = lst.get("text", "")
                                list_content = lst.get("content", "")
                                if list_content:
                                    list_text = re.sub(r'<[^>]+>', '\n', list_content).strip()
                                    if list_text:
                                        description += f"\n\n{list_title}\n{list_text}"
                except Exception:
                    pass
            # Fallback: HTML scraping
            if not description:
                lever_html_match = re.search(
                    r'<div\s+class="[^"]*posting-page[^"]*"[^>]*>(.*?)<div\s+class="[^"]*posting-apply',
                    text, re.DOTALL
                )
                if lever_html_match:
                    desc_text = re.sub(r'<[^>]+>', '\n', lever_html_match.group(1))
                    desc_text = re.sub(r'\n{3,}', '\n\n', desc_text).strip()
                    if len(desc_text) > 50:
                        description = desc_text

        # Strategy 5: Generic fallback — extract from meta tags and main content
        if not description:
            # Try meta description first
            meta_match = re.search(
                r'<meta\s+(?:name|property)="(?:description|og:description)"[^>]*content="([^"]*)"',
                text, re.IGNORECASE
            )
            # Try to find main content area
            main_match = re.search(
                r'<(?:main|article|div\s+(?:class|id)="[^"]*(?:content|description|job|detail)[^"]*")[^>]*>(.*?)</(?:main|article|div)>',
                text, re.DOTALL | re.IGNORECASE
            )
            if main_match:
                desc_text = re.sub(r'<script[^>]*>.*?</script>', '', main_match.group(1), flags=re.DOTALL)
                desc_text = re.sub(r'<style[^>]*>.*?</style>', '', desc_text, flags=re.DOTALL)
                desc_text = re.sub(r'<[^>]+>', '\n', desc_text)
                desc_text = re.sub(r'\n{3,}', '\n\n', desc_text).strip()
                if len(desc_text) > 100:
                    description = desc_text[:5000]  # Cap at 5000 chars
            elif meta_match:
                description = meta_match.group(1).strip()

        # Try to get company logo if we don't have one
        if not job.company_logo:
            # From __NEXT_DATA__ (already handled above)
            # From og:image or logo in page
            logo_match = re.search(
                r'<meta\s+property="og:image"\s+content="([^"]*)"',
                text, re.IGNORECASE
            )
            if logo_match:
                logo_url = logo_match.group(1)
                if logo_url.startswith("http"):
                    job.company_logo = logo_url

        # Save results
        if description:
            job.description = description
            db.commit()

        return {
            "id": job.id,
            "description": job.description or "",
            "apply_url": apply_url,
            "company_logo": job.company_logo or "",
        }
    except Exception as e:
        logger.warning(f"Failed to fetch details for job {job_id}: {e}")
        return {
            "id": job.id,
            "description": job.description or "",
            "apply_url": job.url,
            "company_logo": job.company_logo or "",
        }


@router.post("/{job_id}/save", response_model=ScrapedJobOut)
def save_job(
    job_id: int,
    user_id: str = Depends(get_current_user_id),
    db: Session = Depends(get_db),
):
    """Save a job (bookmark it)."""
    job = db.query(ScrapedJob).filter(ScrapedJob.id == job_id).first()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found.")
    job.saved = 1
    db.commit()
    db.refresh(job)
    return job


@router.post("/{job_id}/unsave", response_model=ScrapedJobOut)
def unsave_job(
    job_id: int,
    user_id: str = Depends(get_current_user_id),
    db: Session = Depends(get_db),
):
    """Unsave a job (remove bookmark)."""
    job = db.query(ScrapedJob).filter(ScrapedJob.id == job_id).first()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found.")
    job.saved = 0
    db.commit()
    db.refresh(job)
    return job


@router.post("/fix-empty-companies")
async def fix_empty_companies(db: Session = Depends(get_db)):
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
    from sqlalchemy import or_
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

    async with httpx.AsyncClient(follow_redirects=True, timeout=15) as client:
        for job in jobs_to_fix:
            description = ""
            try:
                # LinkedIn jobs
                if "linkedin.com/jobs" in (job.url or ""):
                    resp = await client.get(job.url)
                    text = resp.text
                    # Extract from show-more-less-html__markup div
                    li_match = re.search(
                        r'show-more-less-html__markup[^>]*>(.*?)</div>',
                        text, re.DOTALL
                    )
                    if li_match:
                        desc_html = li_match.group(1)
                        desc_text = re.sub(r'<[^>]+>', '\n', desc_html)
                        desc_text = re.sub(r'\n{3,}', '\n\n', desc_text).strip()
                        if len(desc_text) > 50:
                            description = desc_text

                # Greenhouse jobs
                elif "greenhouse.io" in (job.url or ""):
                    gh_match = re.search(r'boards\.greenhouse\.io/([^/]+)/jobs/(\d+)', job.url)
                    if gh_match:
                        slug, gh_job_id = gh_match.group(1), gh_match.group(2)
                        api_url = f"https://boards-api.greenhouse.io/v1/boards/{slug}/jobs/{gh_job_id}"
                        api_resp = await client.get(api_url)
                        if api_resp.status_code == 200:
                            gh_data = api_resp.json()
                            desc_html = gh_data.get("content", "")
                            if desc_html:
                                desc_text = re.sub(r'<[^>]+>', '\n', desc_html)
                                desc_text = re.sub(r'\n{3,}', '\n\n', desc_text).strip()
                                if len(desc_text) > 50:
                                    description = desc_text

                # Lever jobs
                elif "lever.co" in (job.url or ""):
                    lever_match = re.search(r'jobs\.lever\.co/([^/]+)/([a-f0-9-]+)', job.url)
                    if lever_match:
                        slug, lever_id = lever_match.group(1), lever_match.group(2)
                        api_url = f"https://api.lever.co/v0/postings/{slug}/{lever_id}"
                        api_resp = await client.get(api_url)
                        if api_resp.status_code == 200:
                            lever_data = api_resp.json()
                            desc_text = lever_data.get("descriptionPlain", "")
                            if not desc_text:
                                desc_html = lever_data.get("description", "")
                                desc_text = re.sub(r'<[^>]+>', '\n', desc_html)
                                desc_text = re.sub(r'\n{3,}', '\n\n', desc_text).strip()
                            if len(desc_text) > 50:
                                description = desc_text

                # Generic: try schema.org JSON-LD
                else:
                    resp = await client.get(job.url)
                    text = resp.text
                    schema_matches = re.findall(
                        r'<script[^>]*type="application/ld\+json"[^>]*>(.*?)</script>',
                        text, re.DOTALL
                    )
                    for schema_raw in schema_matches:
                        try:
                            schema_data = json.loads(schema_raw)
                            if isinstance(schema_data, list):
                                for item in schema_data:
                                    if isinstance(item, dict) and item.get("@type") == "JobPosting":
                                        schema_data = item
                                        break
                                else:
                                    continue
                            if isinstance(schema_data, dict) and schema_data.get("@type") == "JobPosting":
                                desc_html = schema_data.get("description", "")
                                desc_text = re.sub(r'<[^>]+>', '\n', desc_html)
                                desc_text = re.sub(r'\n{3,}', '\n\n', desc_text).strip()
                                if len(desc_text) > 50:
                                    description = desc_text
                                    break
                        except (json.JSONDecodeError, TypeError):
                            continue

                if description:
                    job.description = description
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

    # Find jobs without salary data
    from sqlalchemy import or_
    jobs_to_enrich = (
        db.query(ScrapedJob)
        .filter(
            or_(
                ScrapedJob.salary_range == "",
                ScrapedJob.salary_range == None,
            ),
            ScrapedJob.experience_level.in_(["internship", "new_grad"]),
        )
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
