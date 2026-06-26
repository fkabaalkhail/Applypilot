import os
from sqlalchemy import create_engine, text

if not os.environ.get('DATABASE_URL'):
    raise SystemExit("Set the DATABASE_URL environment variable before running this script.")
engine = create_engine(os.environ['DATABASE_URL'])

with engine.connect() as conn:
    result = conn.execute(text("SELECT id, company, company_logo FROM scraped_jobs WHERE company ILIKE '%pwc%' ORDER BY id DESC LIMIT 5"))
    for row in result:
        print(f"ID: {row[0]}, Company: {row[1]}, Logo: {row[2] or 'NONE'}")
    
    # Fix: set logo for PwC jobs that don't have one
    conn.execute(text("""
        UPDATE scraped_jobs 
        SET company_logo = 'https://logos-api.apistemic.com/domain:pwc.com?fallback=404'
        WHERE company ILIKE '%pwc%' AND (company_logo IS NULL OR company_logo = '')
    """))
    conn.commit()
    print("Fixed PwC logos")
