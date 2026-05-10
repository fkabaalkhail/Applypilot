"""Seed the database with sample jobs for testing the dashboard."""
from backend.db.database import engine, SessionLocal, Base
from backend.db.models import ScrapedJob, UserSettings, ResumeProfileDB
import datetime

Base.metadata.create_all(bind=engine)
db = SessionLocal()

# Add sample jobs
jobs_data = [
    {
        "title": "Senior Software Engineer",
        "company": "Google",
        "location": "Mountain View, CA",
        "url": "https://careers.google.com/jobs/1",
        "description": "Build scalable distributed systems. 5+ years Python/Go experience required.",
        "match_score": 92,
        "experience_score": 90,
        "skill_score": 95,
        "industry_score": 88,
        "match_label": "STRONG MATCH",
        "source_platform": "linkedin",
        "salary_range": "$180k-$250k",
    },
    {
        "title": "Backend Engineer",
        "company": "Stripe",
        "location": "San Francisco, CA",
        "url": "https://stripe.com/jobs/2",
        "description": "Design and build payment APIs. Experience with Ruby or Python.",
        "match_score": 85,
        "experience_score": 80,
        "skill_score": 90,
        "industry_score": 82,
        "match_label": "STRONG MATCH",
        "source_platform": "github",
        "salary_range": "$170k-$220k",
    },
    {
        "title": "Full Stack Developer",
        "company": "Shopify",
        "location": "Remote",
        "url": "https://shopify.com/jobs/3",
        "description": "Build merchant-facing tools with React and Rails.",
        "match_score": 78,
        "experience_score": 75,
        "skill_score": 80,
        "industry_score": 72,
        "match_label": "GOOD MATCH",
        "source_platform": "linkedin",
        "salary_range": "$150k-$190k",
    },
    {
        "title": "Platform Engineer",
        "company": "Netflix",
        "location": "Los Gatos, CA",
        "url": "https://netflix.com/jobs/4",
        "description": "Build and maintain cloud infrastructure on AWS.",
        "match_score": 72,
        "experience_score": 70,
        "skill_score": 75,
        "industry_score": 68,
        "match_label": "GOOD MATCH",
        "source_platform": "linkedin",
        "salary_range": "$200k-$300k",
    },
    {
        "title": "Software Engineer II",
        "company": "Amazon",
        "location": "Seattle, WA",
        "url": "https://amazon.jobs/5",
        "description": "Work on AWS Lambda. Java/Python required.",
        "match_score": 68,
        "experience_score": 65,
        "skill_score": 72,
        "industry_score": 64,
        "match_label": "GOOD MATCH",
        "source_platform": "github",
        "salary_range": "$160k-$210k",
    },
    {
        "title": "DevOps Engineer",
        "company": "Datadog",
        "location": "NYC",
        "url": "https://datadog.com/jobs/6",
        "description": "Kubernetes, Terraform, CI/CD pipelines.",
        "match_score": 55,
        "experience_score": 50,
        "skill_score": 60,
        "industry_score": 52,
        "match_label": "FAIR MATCH",
        "source_platform": "linkedin",
        "salary_range": "$140k-$180k",
    },
    {
        "title": "ML Engineer",
        "company": "OpenAI",
        "location": "San Francisco, CA",
        "url": "https://openai.com/jobs/7",
        "description": "Train and deploy large language models. PhD preferred.",
        "match_score": 45,
        "experience_score": 30,
        "skill_score": 55,
        "industry_score": 40,
        "match_label": "FAIR MATCH",
        "source_platform": "linkedin",
        "salary_range": "$250k-$400k",
    },
    {
        "title": "React Developer",
        "company": "Vercel",
        "location": "Remote",
        "url": "https://vercel.com/jobs/8",
        "description": "Build Next.js tooling and dashboard UI.",
        "match_score": 74,
        "experience_score": 70,
        "skill_score": 78,
        "industry_score": 72,
        "match_label": "GOOD MATCH",
        "source_platform": "github",
        "salary_range": "$140k-$180k",
    },
]

for j in jobs_data:
    job = ScrapedJob(**j)
    db.add(job)

# Add user settings
settings = UserSettings(
    first_name="Fahad",
    last_name="Aba-Alkhail",
    email="fahadabraar@gmail.com",
    phone="6133168025",
    city="Ottawa, ON",
    linkedin_url="https://linkedin.com/in/fahadabraar",
    website="",
)
db.add(settings)

# Add resume profile
profile = ResumeProfileDB(
    profile_name="Fahad Aba-Alkhail",
    email="fahadabraar@gmail.com",
    phone="6133168025",
    location="Ottawa, ON",
    linkedin_url="https://linkedin.com/in/fahadabraar",
    skills=["Python", "FastAPI", "React", "TypeScript", "PostgreSQL", "Docker", "AWS"],
    experience=[{"company": "Previous Corp", "role": "Software Engineer", "years": 3}],
    education=[{"school": "University of Ottawa", "degree": "BSc Computer Science"}],
    raw_text="Experienced software engineer with 5 years of Python, FastAPI, React, and cloud infrastructure experience.",
)
db.add(profile)

db.commit()
print(f"Seeded {len(jobs_data)} jobs, 1 user settings, 1 resume profile")
db.close()
