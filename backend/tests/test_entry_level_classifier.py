"""ATS entry-level classifier, pinned on real titles from the live registry
boards (crawls of 2026-09-28/29, 230-254 boards, 22,450 North American
listings) and the visible prod feed.

The old keyword filter let 1 of every 3 passes be frontline/hourly or mid-level
work ("Operations Associate, Dallas, #118", "Financial Analyst II", "Capacity
Analyst (L5)", "Campus Recruiter") and vetoed real tracks on a stray word
("Product Manager Intern", "Co-op - 8 months"). Every verdict here goes
through ATSScraper._is_entry_level or .rejection as well as entry_tier, so the
cases fail on the old classifier, not just on a missing import.
"""

import pytest

from backend.services.ats_scraper import (
    HARD_SENIOR,
    ATSJob,
    ATSScraper,
    entry_tier,
    experience_level_for,
)


def _job(title, department="", employment_type="", location="Toronto, ON"):
    return ATSJob(title=title, company="Acme", location=location,
                  url="https://example.com/j/1", department=department,
                  employment_type=employment_type)


def _entry(title, department="", employment_type=""):
    return ATSScraper()._is_entry_level(_job(title, department, employment_type))


@pytest.mark.parametrize("title", [
    "Software Engineer Intern (Summer 2027)",
    "Software Developer, Winter 2027 (Internship) - 4 months",
    "AI Engineer, Winter 2027 (Co-op/Internship) - 8 months",   # was vetoed by "8"
    "NPI Hardware Co-op (8 month - January 2027)",
    "Security Response Analyst Student - 8 Months",
    "Software Engineering Intern - 8 months/40hrs per week",
    "Winter 2027: Software Developer Co-op (4 or 8 months)",
    "Co-op - AI Software Engineering - 6-8 months",
    "AI Developer Co-op - Graduate Program - 9 Months",
    "Customer Sales Coordinator, 4 or 8 Months CO-OP Student",   # was "Coordinator, 4"
    "Product Manager (HR Technology) Intern",                  # was vetoed by "manager"
    "Relationship Manager Intern, Business Market",
    "Project Manager Analyst - Co-op/Intern",
    "Associate Product Manager, Intern",
    "Associate Product Manager",
    "Member of Technical Staff (New Grad)",                    # was vetoed by "staff"
    "Area Manager - New Grad",
    "Business Banking Relationship Manager Trainee",
    "Software Engineer, Early Careers focused on AI and UI",   # plural
    "Dec 2026 Grads: Sales Development Representative (AAE), Tampa",
    "Contract Student Worker - Data Scientist",
    "Développeur Logiciels (Stagiaire), Backend (l'été 2027 - Montreal)",
    "Stagiaire en ingénierie d'industrialisation (été 2027)",
    "Software Engineer, New Grad (2027 Start)",
    "New Graduate Engineer, Mechanical (Cape Canaveral)",
    "Technical Support Engineer - University Graduate 2026",
    "FPGA Associate (Winter 2027)",
    "HVAC Apprentice UA787",
    "Software Engineer II (New Grad)",                         # a track outranks II
])
def test_named_tracks_are_strong(title):
    assert entry_tier(title) == "strong"
    assert _entry(title)


@pytest.mark.parametrize("title", [
    # A named track is never read as frontline work.
    "Warehouse Operations Intern",
    "Retail Store Operations Co-op (Summer 2027)",
    "Part-Time Software Engineering Intern",
    "Seasonal Intern, Merchandising",
    "Security Associate Intern - Night Shift",
])
def test_frontline_words_never_veto_a_track(title):
    assert entry_tier(title) == "strong"
    assert _entry(title)


@pytest.mark.parametrize("title,department", [
    ("Software Engineer, Engine Infrastructure", "Early Career FT - Engineering"),
    ("Backend Engineer - Connectivity", "Software - Early Careers"),
    ("Data Scientist - Autonomy", "Zoox Internships"),
    ("Product Manager: New Grad Accelerator", "5112 General University"),
    ("Software Engineer", "University Recruiting"),
])
def test_track_departments_count(title, department):
    assert entry_tier(title, department) == "strong"
    assert _entry(title, department)


@pytest.mark.parametrize("title,department", [
    ("Head Coach", "12th + University"),                   # a store's street corner
    ("Compliance Operations Specialist", "Ops (Fraud, Compliance, Biz, Analyst)"),
    ("Emerging Fraud Researcher", "Fraud Analyst Team"),
])
def test_level_words_in_departments_do_not_count(title, department):
    assert entry_tier(title, department) is None
    assert not _entry(title, department)


@pytest.mark.parametrize("employment_type", ["Intern", "Internship", "Intern/Co-op", "Student"])
def test_source_commitment_intern_counts(employment_type):
    assert entry_tier("Cohort 0", employment_type=employment_type) == "strong"
    assert _entry("Cohort 0", employment_type=employment_type)


@pytest.mark.parametrize("title", [
    "Associate Software Engineer",
    "Associate, Data Scientist",
    "Junior Fullstack Developer (Python)",
    "Jr. Die Process & Development Engineer",
    "Software Engineer I",
    "Full Stack Software Engineer I",
    "Engineer I/II, Structures",
    "Customer Service Associate - Level 1 (Order Management)",
    "Financial Analyst",
    "Investment Banking Analyst",
    "Associate, Strategic Finance",
    "Entry-level Sales and Marketing Representative - Tampa, FL",
    "Junior Java Developer (1-3 years of experience)",        # a range's top is no veto
    "Building Automation Specialist I or II",
    "Associate Sourcing Specialist (R5490)",                  # procurement, not recruiting
])
def test_level_words_are_weak(title):
    assert entry_tier(title) == "weak"
    assert _entry(title)


@pytest.mark.parametrize("title,employment_type", [
    ("Associate, Client Service", "Part-time"),
    ("Junior Designer", "PartTime"),                         # Ashby's spelling
    ("Financial Analyst", "Part time"),                      # Workday timeType
])
def test_part_time_commitment_vetoes_the_weak_tier(title, employment_type):
    assert entry_tier(title) == "weak"
    assert entry_tier(title, employment_type=employment_type) is None
    assert not _entry(title, employment_type=employment_type)


@pytest.mark.parametrize("title", [
    # frontline / hourly (GoPuff, Carvana, Glossier, Bosch rows in the feed)
    "Operations Associate, Colorado Springs, #118",
    "Operations Associate, Starbucks Barista, Queens, #1025",
    "Retail Sales Associate, Bakersfield, #469",
    "Liquor Barn - Store Associate, Bardstown Road",
    "Entry-Level Automotive Detailer / Lot Attendant (2nd Shift)",
    "Security Associate - 3rd Shift",
    "Production Associate (2nd Shift - Mon-Thurs)",
    "Warehouse Associate (Starlink)",
    "Forklift Operations Associate, Cherry Hill",
    "(Seasonal Sales Associate, Part-Time) Editor, Soho",
    "Lot Driver I - Part Time",
    "Associate Cook, Weekend Shift",
    # mid-level / senior markers
    "Capacity Analyst (L5) - Fleet Planner",
    "Data Engineer (L5)",
    "Software Engineer (L5)",
    "Financial Analyst II, FP&A",
    "Revenue Operations Analyst II",
    "Business Intelligence Analyst 2",
    "Security Associate II",
    "Software Engineer II",
    "Technical Support Specialist, Level 3",
    "Mfg Technician 4",
    "Mid-Level Automotive Parts Associate",
    "Intermediate Security Analyst, Vulnerability Operations",
    "Associate General Counsel, Capital Markets",
    "Associate or Vice President Full Stack Engineer",
    "Vice-President, HSEQ",
    "SVP, Associate Software Engineering",
    "Associate Managing Consultant, Advisors & Consulting Services, Deploy",
    "Senior Software Engineer I",
    "Senior Staff Software Engineer, Frontend",
    "Site Leader I, Miami, #330",
    "Junior Operations Supervisor",
    "Associate Technical Supervisor (Performance)",
    "Associate Data Analyst (3-5 years)",
    "[ECA] Embedded Software Test Engineer (4+ years of experience)",
    # recruiters / program staff for early careers
    "Campus Recruiter, Technology",
    "University Recruiter - Technical Support Engineering",
    "Talent Partner, Campus",
    "Campus Recruitment Specialist",
    "Associate GTM Recruiter",
    "Head of Early Career Recruiting",
    "Senior Recruiter, Emerging Talent",
    "Early Careers & Interns Specialist",
    "Intern Program Manager",
    "Manager, Graduate Programs",
    "University Recruiting Manager",
    "Coordinator, Emerging Talent Recruiting",
    "Talent Sourcing Specialist",
    "Technical Sourcer, Engineering",
    # "university"/"campus"/"1"/"I"/"student" that are not a level or a track
    "Student Financial Aid Consultant, Higher Education & Nonprofit",
    "Customer Delivery Driver - University Park, IL",
    "Bastrop Campus Planning Manager",
    "Credit Collection Specialist (1 Year Contract)",
    "Shift Leader, Mechanical-1",
    "Rack Repair Specialist-1",
    "Account Executive I",
    "Dean of Students, Academy of Math and Programming (AMP)",
    "Assistant Manager, Quebec student loans (Bilingual)",
    # no entry signal at all (rows the pre-July unfiltered writer left behind)
    "Cleaner",
    "Vice President, Data Scientist",
    "Software Engineer - Defense Applications",
])
def test_not_entry(title):
    assert entry_tier(title) is None
    assert not _entry(title)
    assert ATSScraper().rejection(_job(title)) == "level"


@pytest.mark.parametrize("title,location,department", [
    # Real open entry-level postings the 2026-09-29 review saw fail, or at
    # risk of failing, the level filter (and so be retired).
    ("Global Sourcing Specialist (Winter  C0-Op 2027)", "San Mateo, CA", "Hardware Operations"),
    ("Jr. Designer (Design Engineering)", "Newmarket, Ontario, CA", ""),
    ("Systems Engineer, Jr. (Technical Documentation) - TS/SCI", "Chantilly, VA", ""),
    ("Contract Student Worker Automation & Behavioral Science Engineer", "Foster City, CA", ""),
    ("Software Developer Co-op (8 months)", "Toronto, ON", ""),
    ("Summer Student - Engineering", "Oakville, ON", ""),
    ("Product Manager Intern", "Austin, TX", ""),
    ("Construction Project Manager Intern (Summer 2027)", "Denver, CO", ""),
])
def test_review_titles_pass_the_filters(title, location, department):
    job = _job(title, department, location=location)
    assert ATSScraper().rejection(job) is None


def test_a_zero_for_an_o_is_still_a_co_op():
    title = "Global Sourcing Specialist (Winter  C0-Op 2027)"
    assert entry_tier(title) == "strong"
    assert experience_level_for(title) == "internship"
    assert entry_tier("C0-op Recruiting Assistant") == "strong"  # a student recruiting job


@pytest.mark.parametrize("title", [
    # Boeing's entry band is Associate: these are open to new grads.
    "Software Engineer (Associate or Experienced / Mid-Level)",
    "Systems Engineer (Associate or Mid-Level)",
    "DSP Comm Engineer (Associate or Mid-level)",
    "Mechanical Systems Design Engineer – Associate/Experienced",
    "Composite Technical Analyst (Associate, Experienced)",
    "Associate and Mid-Level Software Engineers",
    "Associate or Experienced Composites Engineer",
    "C++/Linux Software Engineer (Associate or Experienced Level)",
    "Product Repair and Modification Technician (Entry Level and Mid-Level)",
    # LinkedIn/Indeed rows the aggregator sweep would otherwise retire.
    "Junior/Intermediate Mechanical Design Engineer",
    "PySpark / Databricks Developer (Junior to Intermediate)",
])
def test_an_entry_band_or_a_mid_one_is_weak(title):
    assert not HARD_SENIOR.search(title)
    assert entry_tier(title) == "weak"
    assert _entry(title)


@pytest.mark.parametrize("title,employment_type", [
    # The range only lifts the mid-level veto; everything else still applies.
    ("Experienced Financial Analyst", ""),
    ("Intermediate Web Developer", ""),
    ("Senior Associate or Experienced Engineer", ""),
    ("Associate or Experienced Manufacturing Technician, 2nd Shift", ""),
    ("Junior/Intermediate Developer", "Part-time"),
    ("Associate or Experienced Engineering Manager", ""),
])
def test_a_band_range_is_still_subject_to_the_other_rules(title, employment_type):
    assert entry_tier(title, employment_type=employment_type) is None
    assert not _entry(title, employment_type=employment_type)


@pytest.mark.parametrize("title", [
    # A bank's retail business line is not a store floor (BMO, 2026-09-29).
    "Internal Sales Associate, Retail Distribution",
    "Associate, Distribution Support, Retail",
    "Analyst, Retail Banking Strategy",
])
def test_retail_banking_titles_are_not_frontline(title):
    assert entry_tier(title) == "weak"
    assert _entry(title)


@pytest.mark.parametrize("title", [
    # Store-floor retail stays frontline with or without a store number.
    "Retail Sales Associate, Albany",
    "Retail Sales Associate, Bakersfield, #469",
    "Sales Associate - Event Retail",
    "Retail Associate",
    "Retail Stock Associate",
])
def test_store_retail_is_still_frontline(title):
    assert entry_tier(title) is None
    assert not _entry(title)


@pytest.mark.parametrize("title", [
    "Recruiting Intern (Summer 2027)",
    "NEW GRAD - Recruiting Coordinator",
    "Program Coordinator Intern",
    "Marketing Coordinator Intern",
])
def test_student_recruiting_jobs_stay(title):
    assert entry_tier(title) is not None
    assert _entry(title)


@pytest.mark.parametrize("title,hard", [
    ("Senior HR Specialist", True),
    ("Director of Engineering", True),
    ("Lead Substation Protection and Control Engineer", False),  # soft: lead
    ("RESEARCH ENGINEER (II)", False),                           # soft: II
    ("Software Engineer II, Backend (Identity Decisioning)", False),
    ("Senior Java Full Stack Developer - Vice President", True),
    ("Member of Technical Staff 2 - DataHub", False),
    ("Software Engineer (L5)", True),
    ("Principal Product Manager", True),
    ("Software Engineering Intern - 8 months", False),
    ("Co-op Developer (4-8 months)", False),
    ("Customer Sales Coordinator, 4 or 8 Months CO-OP Student", False),
    ("Solutions Developer V (Swift)", True),
    ("Intermediate Full-Stack Software Developer", True),
    ("Software Developer (Mid-Level)", True),
    ("Junior/Intermediate Mechanical Design Engineer", False),   # offers the junior band
])
def test_hard_senior_is_the_aggregator_veto(title, hard):
    """LinkedIn/Indeed titles come from searches already scoped to entry
    level, so only HARD_SENIOR vetoes them (ingest-batch, cron-freshness)."""
    assert bool(HARD_SENIOR.search(title)) is hard


@pytest.mark.parametrize("title,department,employment_type,level", [
    ("Software Engineer Intern", "", "", "internship"),
    ("Engineering Co-op (Fall 2026)", "", "", "internship"),
    ("Coop Engineer", "", "", "internship"),
    ("Contract Student Worker - Data Analyst", "", "Contract", "internship"),
    ("Stagiaire en ingénierie (été 2027)", "", "", "internship"),
    ("RF Validation Associate", "Payload Internships", "", "internship"),
    ("Thermal Associate Engineer (Summer 2027)", "", "", "internship"),   # a work term
    ("Hardware Validation Associate", "", "Intern", "internship"),       # Lever commitment
    ("Cohort 0", "", "Intern", "internship"),
    ("Software Engineer, New Grad (Summer 2027)", "", "", "new_grad"),
    ("Investment Banking Analyst (Fall 2027 Start)", "", "", "new_grad"),
    ("Internal Audit Analyst", "", "", "new_grad"),            # was "internship"
    ("International Payroll Analyst", "", "", "new_grad"),     # was "internship"
    ("Internal Mobility Analyst (Recruiting)", "", "", "new_grad"),
    ("Operations Associate, Cooper, #559", "", "", "new_grad"),  # was "internship"
    ("Software Engineer, New Grad (Dec 2026)", "", "internship", "new_grad"),
    ("Software Engineer, New Grad", "Early Careers & Internships", "", "new_grad"),
    ("Associate Software Engineer", "", "Full-time", "new_grad"),
    ("New Grad Software Engineer", "", "", "new_grad"),
    ("Analyst I", "", "", "new_grad"),
])
def test_experience_level(title, department, employment_type, level):
    assert experience_level_for(title, department, employment_type) == level
