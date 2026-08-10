"""Representative payload for scripts/llm_cost_report.py.

A median new-grad user: a two-internship CS résumé and a real-length new-grad
job posting. Deliberately not a best case, these numbers get multiplied by a
user count, so an unrealistically small résumé would understate COGS.
"""

import json

RESUME_TEXT = ("""WISSAM ELMASRY
Toronto, ON | wissam@example.com | (416) 555-0142 | linkedin.com/in/example | github.com/example

EDUCATION
University of Toronto - BSc Computer Science, Minor in Statistics
Expected May 2026 | GPA 3.7/4.0
Relevant coursework: Data Structures, Algorithms, Operating Systems, Databases,
Machine Learning, Software Design, Computer Networks, Distributed Systems

EXPERIENCE
Software Engineering Intern - Shopify, Toronto ON (May 2025 - Aug 2025)
- Built an internal service in Go that reconciled merchant payout records across three
  upstream systems, cutting manual reconciliation work for the finance team
- Added structured logging and Grafana dashboards covering the payout pipeline, reducing
  mean time to detection for failed batches from hours to minutes
- Wrote integration tests covering the retry and idempotency paths; shipped to production
  behind a feature flag and ramped to 100% over two weeks

Backend Developer Intern - Wealthsimple, Toronto ON (Sep 2024 - Dec 2024)
- Migrated a legacy Rails endpoint to a new Python FastAPI service, keeping response
  contracts backward compatible for four downstream consumers
- Reduced p95 latency on the account summary endpoint by adding a Redis read-through cache
- Participated in on-call rotation shadowing; wrote two runbooks still in use

Undergraduate Research Assistant - UofT Systems Lab (Jan 2024 - Aug 2024)
- Implemented benchmarking harness in Python for a distributed key-value store
- Co-authored a workshop paper on tail latency under mixed read/write workloads

PROJECTS
Tailrd - Job application automation platform (2025 - present)
- Full-stack app: FastAPI backend, React frontend, Chrome extension with a content-script
  autofill engine covering 69 applicant tracking systems
- Postgres on Neon, deployed on Vercel; OpenAI for resume tailoring and form answering

Campus Transit Tracker (2024)
- React Native app showing live shuttle positions; used by roughly 400 students
- Node.js backend polling the transit GTFS-RT feed every 15 seconds

SKILLS
Languages: Python, TypeScript, JavaScript, Go, Java, SQL, C
Frameworks: FastAPI, React, Next.js, Node.js, Django, Rails
Tools: PostgreSQL, Redis, Docker, Git, AWS, Vercel, Grafana, pytest

CERTIFICATIONS
AWS Certified Cloud Practitioner (2025)
""").strip()

JOB_DESCRIPTION = ("""Software Engineer, New Grad - Platform Infrastructure

About the role
We are looking for a new graduate software engineer to join our Platform Infrastructure
team. You will work on the systems that every product team at the company builds on top
of: service scaffolding, deployment tooling, observability, and the internal API gateway.
This is a high-impact role with a lot of surface area and a strong mentorship culture.

What you will do
- Design, build, and operate backend services that other engineers depend on daily
- Improve the reliability and performance of our core request path, which handles
  several hundred thousand requests per second at peak
- Contribute to our observability stack: metrics, distributed tracing, structured logging
- Participate in an on-call rotation after a structured ramp-up period
- Write design documents and drive them through review with senior engineers
- Mentor incoming interns during the summer program

What we are looking for
- Bachelor's degree in Computer Science or a related field, graduating in 2026
- Strong fundamentals in data structures, algorithms, and operating systems
- Experience with at least one of Go, Python, Java, or Rust
- Familiarity with containerization (Docker, Kubernetes) is a plus
- Exposure to distributed systems concepts: consistency, partitioning, replication
- Experience with relational databases and query optimization
- Excellent written communication; we are a documentation-heavy engineering culture
- Prior internship experience in a software engineering role strongly preferred

Nice to have
- Contributions to open source infrastructure projects
- Experience with Terraform, AWS, or GCP
- Experience running services in production and participating in incident response
- Familiarity with gRPC, Protocol Buffers, or similar RPC frameworks

Compensation and benefits
Base salary range of $120,000 - $145,000 CAD plus equity and an annual bonus. Extended
health and dental from day one, a $2,000 annual learning budget, four weeks of vacation,
and a hybrid schedule of three days per week in our downtown Toronto office.

Our interview process
Recruiter screen, one technical phone screen, then a virtual onsite consisting of two
coding interviews, one system design interview, and a behavioural interview. We aim to
move from first contact to offer within three weeks.

We are an equal opportunity employer and welcome applicants from all backgrounds.
""").strip()

# The résumé as a real ResumeDocument. This is what the structured rewrite
# actually sends, and it is materially bigger than the flat text above.
RESUME_JSON = json.dumps({'header': {'name': 'Wissam Elmasry', 'email': 'wissam@example.com', 'phone': '(416) 555-0142', 'location': 'Toronto, ON', 'linkedin_url': 'linkedin.com/in/example', 'github_url': 'github.com/example'}, 'sections': [{'id': 's0', 'type': 'education', 'title': 'EDUCATION', 'items': [{'id': 'i00', 'title': 'BSc Computer Science, Minor in Statistics', 'subtitle': 'University of Toronto', 'location': 'Toronto, ON', 'start_date': '2022-09', 'end_date': '2026-05 (expected)', 'detail': 'GPA 3.7/4.0', 'bullets': ['Relevant coursework: Data Structures, Algorithms, Operating Systems, Databases, Machine Learning, Software Design, Computer Networks, Distributed Systems']}]}, {'id': 's1', 'type': 'experience', 'title': 'EXPERIENCE', 'items': [{'id': 'i10', 'title': 'Software Engineering Intern', 'subtitle': 'Shopify', 'location': 'Toronto, ON', 'start_date': '2025-05', 'end_date': '2025-08', 'bullets': ['Built an internal service in Go that reconciled merchant payout records across three upstream systems, cutting manual reconciliation work for the finance team', 'Added structured logging and Grafana dashboards covering the payout pipeline, reducing mean time to detection for failed batches from hours to minutes', 'Wrote integration tests covering the retry and idempotency paths; shipped to production behind a feature flag and ramped to 100% over two weeks']}, {'id': 'i11', 'title': 'Backend Developer Intern', 'subtitle': 'Wealthsimple', 'location': 'Toronto, ON', 'start_date': '2024-09', 'end_date': '2024-12', 'bullets': ['Migrated a legacy Rails endpoint to a new Python FastAPI service, keeping response contracts backward compatible for four downstream consumers', 'Reduced p95 latency on the account summary endpoint by adding a Redis read-through cache', 'Participated in on-call rotation shadowing; wrote two runbooks still in use']}, {'id': 'i12', 'title': 'Undergraduate Research Assistant', 'subtitle': 'UofT Systems Lab', 'location': 'Toronto, ON', 'start_date': '2024-01', 'end_date': '2024-08', 'bullets': ['Implemented a benchmarking harness in Python for a distributed key-value store', 'Co-authored a workshop paper on tail latency under mixed read/write workloads']}]}, {'id': 's2', 'type': 'projects', 'title': 'PROJECTS', 'items': [{'id': 'i20', 'title': 'Tailrd: job application automation platform', 'start_date': '2025-01', 'end_date': 'Present', 'bullets': ['Full-stack app: FastAPI backend, React frontend, Chrome extension with a content-script autofill engine covering 69 applicant tracking systems', 'Postgres on Neon, deployed on Vercel; OpenAI for resume tailoring and form answering']}, {'id': 'i21', 'title': 'Campus Transit Tracker', 'start_date': '2024-02', 'end_date': '2024-06', 'bullets': ['React Native app showing live shuttle positions; used by roughly 400 students', 'Node.js backend polling the transit GTFS-RT feed every 15 seconds']}]}, {'id': 's3', 'type': 'skills', 'title': 'SKILLS', 'skills': ['Python', 'TypeScript', 'JavaScript', 'Go', 'Java', 'SQL', 'C', 'FastAPI', 'React', 'Next.js', 'Node.js', 'Django', 'Rails', 'PostgreSQL', 'Redis', 'Docker', 'Git', 'AWS', 'Vercel', 'Grafana', 'pytest']}, {'id': 's4', 'type': 'certifications', 'title': 'CERTIFICATIONS', 'items': [{'id': 'i40', 'title': 'AWS Certified Cloud Practitioner', 'subtitle': 'Amazon Web Services', 'start_date': '2025-03', 'end_date': ''}]}]}, separators=(",", ":"))

PROFILE_CONTEXT = """Name: Wissam Elmasry
Email: wissam@example.com
Phone: (416) 555-0142
Location: Toronto, ON, M5S 1A1, Canada
Current role: Software Engineering Intern at Shopify
Work authorization: Canadian citizen
Requires visa sponsorship: No
Salary expectation: 110000
Willing to relocate: Yes
Work preference: Hybrid
Notice period: 2 weeks
Earliest start date: 2026-06-01
Years of experience: 2
Driver's licence: Yes
Languages: English, French, Arabic
linkedin.com/in/example
github.com/example
Skills: Python, TypeScript, JavaScript, Go, Java, SQL, C, FastAPI, React, Next.js, Node.js, Django, Rails, PostgreSQL, Redis, Docker, Git, AWS, Vercel, Grafana, pytest
Experience:
- Software Engineering Intern at Shopify (May 2025 - Aug 2025)
- Backend Developer Intern at Wealthsimple (Sep 2024 - Dec 2024)
- Undergraduate Research Assistant at UofT Systems Lab (Jan 2024 - Aug 2024)
Education:
- BSc Computer Science, University of Toronto, Expected May 2026"""

# A typical mid-size form's AI pass: the fields pass 1 (derived facts + rules)
# did not already settle. Rendered the way fill.py:_render_question does.
SHORT_FIELDS = [
    'Are you legally authorized to work in Canada?\nField type: select\nOptions: Yes, No',
    'Will you now or in the future require sponsorship?\nField type: select\nOptions: Yes, No',
    'Years of Python experience\nField type: number',
    'Earliest start date\nField type: date',
    'Expected salary (CAD)\nField type: number',
    'Are you 18 years of age or older?\nField type: select\nOptions: Yes, No',
    "Highest level of education completed\nField type: select\nOptions: High School, Bachelor's, Master's, PhD",
    'Are you willing to work a hybrid schedule in Toronto?\nField type: select\nOptions: Yes, No',
    'How many years of professional software engineering experience do you have?\nField type: select\nOptions: 0-1, 2-3, 4-5, 6+',
    'Do you have experience with Kubernetes?\nField type: select\nOptions: Yes, No',
    'LinkedIn profile URL\nField type: url',
    'Notice period\nField type: text',
]

ESSAY_FIELDS = [
    'Why are you interested in working at Acme Corp?\nField type: textarea',
]
