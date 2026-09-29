"""ci.yml guard rails. Each of these was quietly false for months while CI
stayed red and nobody could tell a real failure from the usual noise:

- the Node jobs "installed" with `npm ci || npm install`, so a lockfile npm
  10 rejected fell back to an unlocked install on every run;
- the backend job deselected 8 tests as "flaky", and one of them was hiding
  a 401 behind a UNIQUE-constraint error;
- every job floated on ubuntu-latest, which moves to Ubuntu 26.04 from
  2026-10-19.
"""

import re
from pathlib import Path

import yaml

WORKFLOW = Path(__file__).resolve().parents[2] / ".github" / "workflows" / "ci.yml"


def _jobs():
    return yaml.safe_load(WORKFLOW.read_text(encoding="utf-8"))["jobs"]


def _runs(job):
    return [step.get("run", "") for step in job["steps"]]


def test_runner_images_are_pinned():
    for name, job in _jobs().items():
        assert re.fullmatch(r"ubuntu-\d\d\.\d\d", job["runs-on"]), (name, job["runs-on"])


def test_node_jobs_install_strictly_from_their_lockfiles():
    for name in ("extension", "frontend"):
        job = _jobs()[name]
        setup = [s for s in job["steps"] if str(s.get("uses", "")).startswith("actions/setup-node@")]
        assert len(setup) == 1, name
        # npm 11 (Node 24+) wrote both lockfiles; npm 10 refuses them.
        assert int(str(setup[0]["with"]["node-version"])) >= 24, name
        installs = [r.strip() for r in _runs(job) if re.search(r"\bnpm (ci|install|i)\b", r)]
        assert installs == ["npm ci"], (name, installs)


def test_backend_runs_the_whole_suite():
    runs = [r for r in _runs(_jobs()["backend"]) if "-m pytest" in r]
    assert len(runs) == 1
    assert "backend/tests" in runs[0]
    # A test that cannot pass gets fixed (or deleted in the open), not hidden.
    for hider in ("--deselect", " -k ", "--ignore"):
        assert hider not in runs[0], hider
