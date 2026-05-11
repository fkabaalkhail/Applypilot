import httpx

r = httpx.get("https://logo.clearbit.com/google.com", follow_redirects=True)
print(f"Google: status={r.status_code}, type={r.headers.get('content-type', 'none')}")

r2 = httpx.get("https://logo.clearbit.com/waymo.com", follow_redirects=True)
print(f"Waymo: status={r2.status_code}, type={r2.headers.get('content-type', 'none')}")

r3 = httpx.get("https://logo.clearbit.com/tiktok.com", follow_redirects=True)
print(f"TikTok: status={r3.status_code}, type={r3.headers.get('content-type', 'none')}")

r4 = httpx.get("https://logo.clearbit.com/agriwastetechnologyinc.com", follow_redirects=True)
print(f"AgriWaste: status={r4.status_code}")
