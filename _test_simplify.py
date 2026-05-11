"""Check SimplifyJobs and vanshb03 repos for direct job links."""
import httpx
import asyncio
import re

async def main():
    async with httpx.AsyncClient(timeout=15) as client:
        headers = {"Accept": "application/vnd.github.v3.raw"}

        # SimplifyJobs/New-Grad-Positions - get the table section
        print("=== SimplifyJobs/New-Grad-Positions ===")
        r = await client.get(
            "https://api.github.com/repos/SimplifyJobs/New-Grad-Positions/contents/README.md",
            headers=headers
        )
        text = r.text
        # Find the first table
        table_start = text.find("| Company")
        if table_start == -1:
            table_start = text.find("| ---")
        if table_start > 0:
            table_section = text[table_start:table_start+2000]
            print(table_section[:1500])
        
        # Check vanshb03/New-Grad-2027 (2319 stars)
        print("\n\n=== vanshb03/New-Grad-2027 ===")
        r2 = await client.get(
            "https://api.github.com/repos/vanshb03/New-Grad-2027/contents/README.md",
            headers=headers
        )
        text2 = r2.text
        table_start2 = text2.find("| Company")
        if table_start2 == -1:
            table_start2 = text2.find("| ---")
        if table_start2 > 0:
            print(text2[table_start2:table_start2+1500])
        else:
            print(text2[:1500])

        # Check zapplyjobs repos
        print("\n\n=== zapplyjobs/New-Grad-Jobs-2026 ===")
        try:
            r3 = await client.get(
                "https://api.github.com/repos/zapplyjobs/New-Grad-Jobs-2026/contents/README.md",
                headers=headers
            )
            text3 = r3.text
            table_start3 = text3.find("| Company")
            if table_start3 > 0:
                print(text3[table_start3:table_start3+1500])
            else:
                print(text3[:1500])
        except Exception as e:
            print(f"Error: {e}")

asyncio.run(main())
