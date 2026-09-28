"""
Retired: use backend/scripts/backfill_logos_v2.py.

The v1 script harvested per guessed company_domain and wrote Google's sz=256
favicon URL onto every row it could not improve, which is exactly the
letter-avatar/wrong-logo state the self-hosted logo store replaces. This
entry point now forwards to the v2 backfill (a dry run unless --apply is
given); --sentinels maps to --retry-misses.

Usage:
    DATABASE_URL=postgres://... python backend/scripts/harvest_logos.py [--limit N] [--apply]
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

if __name__ == "__main__":
    if not os.environ.get("DATABASE_URL"):
        sys.exit("DATABASE_URL is required (set it for this command only)")
    from backend.scripts import backfill_logos_v2

    argv = ["--retry-misses" if a == "--sentinels" else a for a in sys.argv[1:]]
    print("harvest_logos.py is retired; running backfill_logos_v2.py " + " ".join(argv))
    sys.exit(backfill_logos_v2.main(argv))
