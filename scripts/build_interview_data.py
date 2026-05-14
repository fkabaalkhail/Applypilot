"""
Build interview questions JSON from leetcode-company-wise-problems-2022 repo.
Merges company CSVs with difficulty data and outputs to frontend JSON.
"""
import csv
import json
import os
from pathlib import Path

# Paths
REPO_DIR = Path("scripts/leetcode-data")
COMPANIES_DIR = REPO_DIR / "companies"
PROBLEMS_CSV = REPO_DIR / "data" / "leetcode_problems.csv"
OUTPUT_FILE = Path("frontend/src/data/interview-questions.json")

# Company config: name -> (csv_filename, domain, category)
COMPANY_CONFIG = {
    "Google": ("Google.csv", "google.com", "FAANG"),
    "Apple": ("Apple.csv", "apple.com", "FAANG"),
    "Meta": ("Facebook.csv", "meta.com", "FAANG"),
    "Netflix": ("Netflix.csv", "netflix.com", "FAANG"),
    "Amazon": ("Amazon.csv", "amazon.com", "FAANG"),
    "Microsoft": ("Microsoft.csv", "microsoft.com", "FAANG"),
    "OpenAI": (None, "openai.com", "AI"),
    "Anthropic": (None, "anthropic.com", "AI"),
    "NVIDIA": ("Nvidia.csv", "nvidia.com", "AI"),
    "Databricks": ("Databricks.csv", "databricks.com", "AI"),
    "Uber": ("Uber.csv", "uber.com", "High-Growth"),
    "Stripe": (None, "stripe.com", "High-Growth"),
    "Shopify": (None, "shopify.com", "Canadian"),
    "Coinbase": (None, "coinbase.com", "High-Growth"),
    "DoorDash": ("DoorDash.csv", "doordash.com", "High-Growth"),
    "Roblox": ("Roblox.csv", "roblox.com", "High-Growth"),
    "Snap": ("Snapchat.csv", "snap.com", "High-Growth"),
    "Discord": (None, "discord.com", "High-Growth"),
    "Airbnb": ("Airbnb.csv", "airbnb.com", "High-Growth"),
    "LinkedIn": ("LinkedIn.csv", "linkedin.com", "High-Growth"),
    "Twitter": ("Twitter.csv", "x.com", "High-Growth"),
    "Salesforce": ("Salesforce.csv", "salesforce.com", "High-Growth"),
    "Spotify": ("Spotify.csv", "spotify.com", "High-Growth"),
    "Tesla": ("Tesla.csv", "tesla.com", "High-Growth"),
    "Palantir": ("Palantir Technologies.csv", "palantir.com", "High-Growth"),
    "ByteDance": ("ByteDance.csv", "bytedance.com", "High-Growth"),
    "Bloomberg": ("Bloomberg.csv", "bloomberg.com", "High-Growth"),
    "Two Sigma": ("Two Sigma.csv", "twosigma.com", "High-Growth"),
    "Citadel": ("Citadel.csv", "citadel.com", "High-Growth"),
    "Goldman Sachs": ("Goldman Sachs.csv", "goldmansachs.com", "High-Growth"),
    "JP Morgan": ("JP Morgan.csv", "jpmorgan.com", "High-Growth"),
    "Adobe": ("Adobe.csv", "adobe.com", "High-Growth"),
    "Oracle": ("Oracle.csv", "oracle.com", "High-Growth"),
    "Atlassian": ("Atlassian.csv", "atlassian.com", "High-Growth"),
    "Pinterest": ("Pinterest.csv", "pinterest.com", "High-Growth"),
    "Robinhood": ("Robinhood.csv", "robinhood.com", "High-Growth"),
    "Square": ("Square.csv", "squareup.com", "High-Growth"),
    "Datadog": (None, "datadoghq.com", "High-Growth"),
    "Figma": (None, "figma.com", "High-Growth"),
    "Notion": (None, "notion.so", "High-Growth"),
    # Canadian companies
    "Kinaxis": (None, "kinaxis.com", "Canadian"),
    "Ericsson": (None, "ericsson.com", "Canadian"),
    "BlackBerry": (None, "blackberry.com", "Canadian"),
    "Nokia": (None, "nokia.com", "Canadian"),
    "Ciena": (None, "ciena.com", "Canadian"),
    "Wealthsimple": (None, "wealthsimple.com", "Canadian"),
    "Clio": (None, "clio.com", "Canadian"),
    "Solace": (None, "solace.com", "Canadian"),
    "Ross Video": (None, "rossvideo.com", "Canadian"),
    "Calian": (None, "calian.com", "Canadian"),
    "Trend Micro": (None, "trendmicro.com", "Canadian"),
    "Coveo": (None, "coveo.com", "Canadian"),
    "Mitel": (None, "mitel.com", "Canadian"),
    "Ribbon Communications": (None, "ribboncommunications.com", "Canadian"),
    "Magnet Forensics": (None, "magnetforensics.com", "Canadian"),
    "Fullscript": (None, "fullscript.com", "Canadian"),
    "Assent Compliance": (None, "assentcompliance.com", "Canadian"),
    "You.i TV": (None, "youi.tv", "Canadian"),
}

# Max questions per company from CSV
MAX_QUESTIONS_FROM_CSV = 50


def load_difficulty_map():
    """Load problem name -> difficulty from the main problems CSV."""
    difficulty_map = {}
    with open(PROBLEMS_CSV, "r", encoding="utf-8") as f:
        reader = csv.reader(f)
        for row in reader:
            if len(row) >= 3:
                name = row[0].strip()
                difficulty = row[2].strip()
                if difficulty in ("Easy", "Medium", "Hard"):
                    difficulty_map[name] = difficulty
    return difficulty_map


def load_company_csv(csv_file, difficulty_map):
    """Load questions from a company CSV, sorted by frequency."""
    questions = []
    filepath = COMPANIES_DIR / csv_file
    if not filepath.exists():
        return questions

    with open(filepath, "r", encoding="utf-8") as f:
        reader = csv.reader(f)
        header = next(reader, None)
        for row in reader:
            if len(row) >= 3:
                link = row[0].strip()
                name = row[1].strip()
                try:
                    freq = int(row[2].strip())
                except ValueError:
                    freq = 1
                difficulty = difficulty_map.get(name, "Medium")
                questions.append({
                    "title": name,
                    "url": link,
                    "difficulty": difficulty,
                    "frequency": freq,
                })

    # Sort by frequency descending, take top N
    questions.sort(key=lambda x: x["frequency"], reverse=True)
    return questions[:MAX_QUESTIONS_FROM_CSV]


def format_question(q, seniority_cycle, type_cycle, idx):
    """Format a question for the output JSON."""
    result = {
        "title": q["title"],
        "topic": "Coding",
        "subtopic": "Data Structures & Algorithms",
        "difficulty": q["difficulty"],
        "seniority": seniority_cycle[idx % len(seniority_cycle)],
        "type": type_cycle[idx % len(type_cycle)],
        "url": q.get("url", ""),
    }
    return result


def main():
    print("Loading difficulty map...")
    difficulty_map = load_difficulty_map()
    print(f"  Loaded {len(difficulty_map)} problems with difficulty data")

    # Load existing JSON to preserve non-CSV companies
    with open(OUTPUT_FILE, "r", encoding="utf-8") as f:
        existing_data = json.load(f)

    existing_companies = {c["name"]: c for c in existing_data["companies"]}

    seniority_cycle = ["New Grad", "New Grad", "Mid-Level", "Mid-Level", "Senior"]
    type_cycle = ["phone_screen", "onsite", "onsite", "onsite", "phone_screen"]

    output_companies = []

    for company_name, (csv_file, domain, category) in COMPANY_CONFIG.items():
        existing = existing_companies.get(company_name)

        if csv_file:
            # Load from CSV
            csv_questions = load_company_csv(csv_file, difficulty_map)
            if csv_questions:
                formatted = []
                for idx, q in enumerate(csv_questions):
                    formatted.append(format_question(q, seniority_cycle, type_cycle, idx))

                # Also keep behavioral/system design from existing if available
                behavioral_sd = []
                if existing:
                    for eq in existing["questions"]:
                        if eq["topic"] in ("Behavioral", "System Design"):
                            eq_copy = dict(eq)
                            if "url" not in eq_copy:
                                eq_copy["url"] = ""
                            behavioral_sd.append(eq_copy)

                # Combine: behavioral/SD first, then coding from CSV
                all_questions = behavioral_sd + formatted
                # Deduplicate by title
                seen = set()
                deduped = []
                for q in all_questions:
                    if q["title"] not in seen:
                        seen.add(q["title"])
                        deduped.append(q)

                company_entry = {
                    "name": company_name,
                    "domain": domain,
                    "category": category,
                    "totalQuestions": len(deduped),
                    "questions": deduped,
                }
                output_companies.append(company_entry)
                print(f"  {company_name}: {len(deduped)} questions ({len(csv_questions)} from CSV)")
            elif existing:
                # No CSV data, use existing
                for q in existing["questions"]:
                    if "url" not in q:
                        q["url"] = ""
                existing["totalQuestions"] = len(existing["questions"])
                output_companies.append(existing)
                print(f"  {company_name}: {len(existing['questions'])} questions (existing)")
            else:
                print(f"  {company_name}: SKIPPED (no CSV, no existing)")
        else:
            # No CSV file, use existing data
            if existing:
                for q in existing["questions"]:
                    if "url" not in q:
                        q["url"] = ""
                existing["totalQuestions"] = len(existing["questions"])
                output_companies.append(existing)
                print(f"  {company_name}: {len(existing['questions'])} questions (existing)")
            else:
                print(f"  {company_name}: SKIPPED (no data)")

    output = {"companies": output_companies}

    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        json.dump(output, f, indent=2)

    total_q = sum(c["totalQuestions"] for c in output_companies)
    print(f"\nDone! {len(output_companies)} companies, {total_q} total questions")
    print(f"Output: {OUTPUT_FILE}")


if __name__ == "__main__":
    main()
