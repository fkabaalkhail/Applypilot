# Jobs Data

Aggregated job listings from multiple GitHub repositories, updated daily via GitHub Actions.

## Sources

| Source | Type | Links |
|--------|------|-------|
| vanshb03/New-Grad-2027 | Direct company links | Workday, Greenhouse, Lever |
| zapplyjobs/New-Grad-Jobs-2026 | Direct company links | All ATS platforms |
| zapplyjobs/New-Grad-Software-Engineering-Jobs-2026 | Direct company links | SWE roles |
| zapplyjobs/New-Grad-Data-Science-Jobs-2026 | Direct company links | DS/ML roles |
| zapplyjobs/Internships-2026 | Direct company links | Internships |
| jobright-ai/* (9 repos) | Jobright links | Broad coverage |

## Output

- `jobs.json` — All deduplicated jobs with direct apply URLs where available
- Updated daily at 00:00 UTC via GitHub Actions

## Schema

```json
{
  "title": "Software Engineer",
  "company": "Google",
  "location": "Mountain View, CA",
  "url": "https://careers.google.com/...",
  "posted_date": "2026-05-10",
  "work_type": "onsite",
  "role_category": "Software Engineering",
  "experience_level": "new_grad",
  "country": "US",
  "company_logo": "https://logo.clearbit.com/google.com",
  "source": "zapplyjobs"
}
```
