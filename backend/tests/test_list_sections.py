"""
Mega-list sections (SimplifyJobs/Summer2027-Internships layout): every '## '
header ends the section above it, known category or not.
"""

from backend.services.markdown_parser import MarkdownParser


def _table(company, title, url):
    return (
        "<table><thead><tr><th>Company</th><th>Role</th><th>Location</th>"
        "<th>Application</th><th>Age</th></tr></thead><tbody>"
        f"<tr><td><strong><a href=\"https://simplify.jobs/c/{company}\">{company}</a></strong></td>"
        f"<td>{title}</td><td>Austin, TX</td>"
        f"<td><a href=\"{url}?utm_source=Simplify&ref=Simplify\"><img alt=\"Apply\"></a> "
        "<a href=\"https://simplify.jobs/p/x\"><img alt=\"Simplify\"></a></td><td>0d</td></tr>"
        "</tbody></table>\n"
    )


SIMPLIFY = (
    "# Summer 2027 Tech Internships\n"
    "## 💻 Software Engineering Internship Roles\n" + _table("Cloudflare", "Software Engineer Intern", "https://boards.greenhouse.io/cloudflare/jobs/1")
    + "## 📱 Product Management Internship Roles\n" + _table("Ramp", "Product Manager Intern", "https://jobs.ashbyhq.com/ramp/1")
    + "## 🤖 Data Science, AI & Machine Learning Internship Roles\n" + _table("Roblox", "Data Science Intern", "https://careers.roblox.com/jobs/1")
    + "## 🔧 Hardware Engineering Internship Roles\n" + _table("AMD", "ASIC Design Intern", "https://careers.amd.com/1")
)


def test_unknown_headers_end_the_section_above():
    jobs = MarkdownParser().parse(SIMPLIFY, is_mega_repo=True)
    assert [(j.company, j.section_category) for j in jobs] == [
        ("Cloudflare", "Software Engineering"),
        ("Ramp", "Product Management"),
        ("Roblox", None),  # classified by title downstream
        ("AMD", None),
    ]
    # The employer's link, never the Simplify button.
    assert all("simplify.jobs" not in j.url for j in jobs)


def test_short_header_is_not_a_category_it_is_part_of():
    parser = MarkdownParser()
    assert parser._match_section_category("AI") is None  # 'ai' is in 'education and training'
    assert parser._match_section_category("💻 Software Engineering Internship Roles") == "Software Engineering"
