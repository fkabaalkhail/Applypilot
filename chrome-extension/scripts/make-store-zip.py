#!/usr/bin/env python
"""Build the Chrome Web Store upload zip from dist/.

The Web Store uploader rejects manifests that carry a `key` (it is dev-only:
it pins the unpacked extension id) and descriptions over 132 characters.
dist/ keeps the dev affordances; this script writes
tailrd-extension-<version>.zip with the key stripped and every store
constraint validated, so a bad zip fails HERE instead of in the dashboard.

Run from chrome-extension/ after `node build.mjs`:

    python scripts/make-store-zip.py
"""

import json
import sys
import zipfile
from pathlib import Path

DIST = Path(__file__).resolve().parent.parent / "dist"


def main() -> int:
    manifest_path = DIST / "manifest.json"
    if not manifest_path.exists():
        print("dist/manifest.json missing. Run `node build.mjs` first", file=sys.stderr)
        return 1

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest.pop("key", None)  # store-assigned identity; the uploader rejects the field

    desc = manifest.get("description", "")
    if len(desc) > 132:
        print(f"manifest description is {len(desc)} chars (store max 132)", file=sys.stderr)
        return 1
    if "localhost" in json.dumps(manifest):
        print("dev URL (localhost) leaked into the manifest", file=sys.stderr)
        return 1

    out = DIST.parent / f"tailrd-extension-{manifest['version']}.zip"
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for path in sorted(DIST.rglob("*")):
            if path.is_dir():
                continue
            rel = path.relative_to(DIST).as_posix()
            if rel == "manifest.json":
                z.writestr("manifest.json", json.dumps(manifest, indent=2) + "\n")
            else:
                z.write(path, rel)

    print(
        f"wrote {out.name} ({out.stat().st_size // 1024} KB), "
        f"key stripped, description {len(desc)} chars"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
