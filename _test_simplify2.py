import httpx, asyncio, re

async def main():
    async with httpx.AsyncClient(timeout=15) as client:
        headers = {"Accept": "application/vnd.github.v3.raw"}
        
        # SimplifyJobs uses a different structure - check for .json or data files
        r = await client.get(
            "https://api.github.com/repos/SimplifyJobs/New-Grad-Positions/contents/",
        )
        files = r.json()
        print("SimplifyJobs/New-Grad-Positions files:")
        for f in files:
            print(f"  {f['name']} ({f['type']})")
        
        # Get the full README to find the table
        r2 = await client.get(
            "https://api.github.com/repos/SimplifyJobs/New-Grad-Positions/contents/README.md",
            headers=headers
        )
        text = r2.text
        
        # Find Software Engineering section
        se_start = text.find("Software Engineering")
        if se_start > 0:
            section = text[se_start:se_start+3000]
            # Find the table in this section
            table_start = section.find("| Company")
            if table_start > 0:
                print("\nSimplifyJobs table format:")
                print(section[table_start:table_start+1500])
            else:
                # Maybe it uses a different format
                print("\nSection content:")
                print(section[:1500])

        # Also check Summer2026-Internships
        print("\n\n=== SimplifyJobs/Summer2026-Internships ===")
        r3 = await client.get(
            "https://api.github.com/repos/SimplifyJobs/Summer2026-Internships/contents/README.md",
            headers=headers
        )
        text3 = r3.text
        table_start3 = text3.find("| Company")
        if table_start3 > 0:
            print(text3[table_start3:table_start3+1500])
        else:
            print(text3[2000:4000])

asyncio.run(main())
