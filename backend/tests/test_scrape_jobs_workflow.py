"""scrape-jobs.yml guard rails: a read-only token, no automated re-enable of
the schedule, pinned third-party code, and a check that turns the run red
before GitHub's 60-day inactivity rule silently switches the schedule off.

The inactivity check and the final outcome check are real shell. They run
here under bash with a stub `gh` first on PATH: no network, no token."""

import datetime
import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest
import yaml

WORKFLOW = (
    Path(__file__).resolve().parents[2] / ".github" / "workflows" / "scrape-jobs.yml"
)
REPO = "owner/repo"

# Every ${{ }} expression the tested steps may use, rendered the way the
# runner would. An expression missing here fails the test on purpose.
EXPRESSIONS = {
    "github.token": "stub-token",
    "github.repository": REPO,
}

# Stub GitHub CLI. It answers the two reads the inactivity check makes and
# exits non-zero on anything else, and logs every call so the test can show
# the step never writes.
STUB_GH = """#!/usr/bin/env bash
echo "$*" >> "$STUB_LOG"
if [ -n "$STUB_FAIL" ]; then echo "HTTP 502: Bad Gateway" >&2; exit 1; fi
[ "$1" = api ] || { echo "unexpected: $*" >&2; exit 2; }
case "$2" in
  "repos/$STUB_REPO") echo "$STUB_BRANCH" ;;
  "repos/$STUB_REPO/commits/$STUB_BRANCH") echo "$STUB_DATE" ;;
  *) echo "unexpected: $*" >&2; exit 2 ;;
esac
"""


def _workflow():
    return yaml.safe_load(WORKFLOW.read_text(encoding="utf-8"))


def _steps():
    return _workflow()["jobs"]["scrape"]["steps"]


def _step(step_id):
    for step in _steps():
        if step.get("id") == step_id:
            return step
    raise AssertionError(f"scrape-jobs.yml has no step with id {step_id!r}")


def _render(value, extra=None):
    table = {**EXPRESSIONS, **(extra or {})}
    return re.sub(
        r"\$\{\{\s*(.+?)\s*\}\}", lambda m: table[m.group(1)], str(value)
    )


# --- static shape --------------------------------------------------------


def test_token_is_read_only():
    wf = _workflow()
    assert wf["permissions"] == {"contents": "read"}
    for name, job in wf["jobs"].items():
        perms = job.get("permissions", {})
        assert isinstance(perms, dict), name
        assert set(perms.values()) <= {"read", "none"}, (name, perms)


def test_no_step_re_enables_the_workflow():
    for step in _steps():
        run = step.get("run", "")
        assert "/enable" not in run, step.get("name")
        assert "actions/workflows" not in run, step.get("name")


def test_checkout_does_not_leave_the_token_on_disk():
    checkouts = [
        s for s in _steps() if str(s.get("uses", "")).startswith("actions/checkout@")
    ]
    assert checkouts
    for step in checkouts:
        assert (step.get("with") or {}).get("persist-credentials") is False


def test_every_gitlink_has_a_gitmodules_entry():
    # persist-credentials: false (above) makes checkout run `git submodule
    # foreach` inside its main step, and git dies on any gitlink .gitmodules
    # doesn't map ("No url found for submodule path", exit 128): checkout
    # fails and both scrapers are skipped. Two orphaned gitlinks did exactly
    # that to every scheduled run after f26fa4c.
    root = WORKFLOW.parents[2]
    if shutil.which("git") is None or not (root / ".git").exists():
        pytest.skip("needs a git checkout")
    # -z on both: raw NUL-separated paths, never C-quoted, so a mapped path
    # with non-ASCII characters still compares equal.
    staged = subprocess.run(
        ["git", "ls-files", "--stage", "-z"],
        cwd=root, capture_output=True, check=True,
    ).stdout.decode("utf-8")
    gitlinks = {
        entry.split("\t", 1)[1]
        for entry in staged.split("\0")
        if entry.startswith("160000 ")
    }
    mapped = subprocess.run(
        ["git", "config", "--file", ".gitmodules", "-z",
         "--get-regexp", r"^submodule\..*\.path$"],
        cwd=root, capture_output=True,
    ).stdout.decode("utf-8")
    paths = {entry.split("\n", 1)[1] for entry in mapped.split("\0") if entry}
    assert gitlinks <= paths, sorted(gitlinks - paths)


def test_pip_installs_are_pinned():
    installs = [
        m.group(1).split()
        for step in _steps()
        for line in step.get("run", "").splitlines()
        if (m := re.search(r"\bpip install\b(.*)", line))
    ]
    assert installs
    for args in installs:
        packages = [a for a in args if not a.startswith("-")]
        assert packages
        for pkg in packages:
            assert re.fullmatch(r"[A-Za-z0-9._\[\],-]+==[A-Za-z0-9.]+", pkg), pkg


def test_inactivity_check_feeds_the_final_outcome_check():
    step = _step("inactivity")
    assert step.get("continue-on-error") is True
    assert "${{" not in step["run"], "pass expressions through env, not the script"
    final = _steps()[-1]
    assert "steps.inactivity.outcome" in final["env"]["OUTCOMES"]


# --- the shell itself ----------------------------------------------------


def _bash_candidates():
    found = shutil.which("bash")
    if found:
        yield found
    # On Windows PATH often finds WSL's launcher first, which can't see a
    # Windows PATH; Git for Windows ships a bash that can.
    git = shutil.which("git") if os.name == "nt" else None
    if git:
        root = Path(git).resolve().parents[1]
        for exe in (root / "bin" / "bash.exe", root / "usr" / "bin" / "bash.exe"):
            if exe.is_file():
                yield str(exe)


@pytest.fixture
def bash(tmp_path):
    """Run a step's script the way the runner does (bash -eo pipefail) with
    the stub `gh` first on PATH. Skips only where no bash can run the stub."""
    stub_dir = tmp_path / "bin"
    stub_dir.mkdir()
    stub = stub_dir / "gh"
    stub.write_bytes(STUB_GH.encode())
    stub.chmod(0o755)
    log = tmp_path / "gh.log"
    base_env = {
        **os.environ,
        "PATH": str(stub_dir) + os.pathsep + os.environ.get("PATH", ""),
        "STUB_LOG": log.as_posix(),
        "STUB_REPO": REPO,
        "STUB_BRANCH": "main",
    }
    base_env.pop("STUB_FAIL", None)

    def runner(exe):
        def run(script, env=None):
            path = tmp_path / "step.sh"
            path.write_bytes(script.encode())
            return subprocess.run(
                [exe, "--noprofile", "--norc", "-eo", "pipefail", path.as_posix()],
                env={**base_env, **(env or {})},
                capture_output=True,
                text=True,
                timeout=60,
            )

        run.log = log
        return run

    for exe in _bash_candidates():
        run = runner(exe)
        probe = run("gh api repos/owner/repo")
        log.unlink(missing_ok=True)
        if probe.returncode == 0 and probe.stdout.strip() == "main":
            return run
    pytest.skip("no bash on this machine can run the stub gh")


def _run_inactivity(bash, days_old=None, **stub):
    step = _step("inactivity")
    env = {k: _render(v) for k, v in step.get("env", {}).items()}
    if days_old is not None:
        when = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(
            days=days_old, hours=1
        )
        stub.setdefault("STUB_DATE", when.strftime("%Y-%m-%dT%H:%M:%SZ"))
    return bash(step["run"], {**env, **stub})


def test_inactivity_check_passes_on_a_recent_commit(bash):
    result = _run_inactivity(bash, days_old=10)
    assert result.returncode == 0, result.stdout + result.stderr
    assert "10 days" in result.stdout
    assert "::error" not in result.stdout


def test_inactivity_check_passes_one_day_under_the_threshold(bash):
    result = _run_inactivity(bash, days_old=49)
    assert result.returncode == 0, result.stdout + result.stderr


def test_inactivity_check_fails_the_step_at_50_days(bash):
    result = _run_inactivity(bash, days_old=50)
    assert result.returncode == 1, result.stdout + result.stderr
    assert "::error::" in result.stdout
    assert "50 days" in result.stdout
    assert "Push any commit" in result.stdout
    assert "external cron" in result.stdout


def test_inactivity_check_only_reads(bash):
    _run_inactivity(bash, days_old=55)
    calls = bash.log.read_text().splitlines()
    assert calls == [
        f"api repos/{REPO} --jq .default_branch",
        f"api repos/{REPO}/commits/main --jq .commit.committer.date",
    ]


def test_inactivity_check_fails_loudly_when_github_is_unreadable(bash):
    result = _run_inactivity(bash, days_old=1, STUB_FAIL="1")
    assert result.returncode == 1
    assert "::error::" in result.stdout


def test_inactivity_check_does_not_pass_on_an_empty_date(bash):
    result = _run_inactivity(bash, STUB_DATE="")
    assert result.returncode == 1
    assert "::error::" in result.stdout


def _run_final(bash, failed=()):
    final = _steps()[-1]
    step_ids = re.findall(r"steps\.(\w+)\.outcome", final["env"]["OUTCOMES"])
    outcomes = {
        f"steps.{sid}.outcome": ("failure" if sid in failed else "success")
        for sid in step_ids
    }
    env = {"OUTCOMES": _render(final["env"]["OUTCOMES"], outcomes)}
    return bash(final["run"], env)


def test_final_step_is_green_when_everything_succeeded(bash):
    result = _run_final(bash)
    assert result.returncode == 0, result.stdout + result.stderr


def test_final_step_turns_the_run_red_on_an_inactivity_failure(bash):
    result = _run_final(bash, failed={"inactivity"})
    assert result.returncode == 1
    assert "inactivity=failure" in result.stdout


# --- cron-poll: an AI account outage is a warning, not a red run ---------

# Stub curl: writes $STUB_BODY to the -o file and prints "$STUB_CODE <time>"
# for -w, the two things the endpoint steps read.
STUB_CURL = """#!/usr/bin/env bash
out=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    *) shift ;;
  esac
done
[ -n "$out" ] && printf '%s' "$STUB_BODY" > "$out"
printf '%s 1.23s' "${STUB_CODE:-200}"
"""

OUTAGE_BODY = (
    '{"status":"completed","sources_polled":5,"new_jobs":3,'
    '"match_alerts":{"status":"llm_unavailable","threshold":80,"users_scanned":5,'
    '"users_notified":0,"jobs_notified":0,"jobs_scored":0,"scoring_errors":0,'
    '"scoring_budget_spent":false,'
    '"error":"OpenAI rejected the request (billing_not_active). This is an account '
    'billing/quota problem, not a transient rate limit."}}'
)
HEALTHY_BODY = (
    '{"status":"completed","match_alerts":{"status":"completed","threshold":80,'
    '"users_scanned":5,"jobs_scored":12,"scoring_errors":0}}'
)


def _run_cron_poll(bash, tmp_path, body, code="200"):
    step = _step("cron_poll")
    stub_dir = tmp_path / "curlbin"
    stub_dir.mkdir(exist_ok=True)
    curl = stub_dir / "curl"
    curl.write_bytes(STUB_CURL.encode())
    curl.chmod(0o755)
    env = {k: _render(v, {"secrets.CRON_SECRET": "stub-secret"})
           for k, v in step.get("env", {}).items()}
    env.update({
        "API_BASE": "https://example.invalid",
        "PATH": str(stub_dir) + os.pathsep + os.environ.get("PATH", ""),
        "STUB_BODY": body,
        "STUB_CODE": code,
    })
    # The step writes response.json into its working directory.
    return bash(f'cd "{tmp_path.as_posix()}"\n' + step["run"], env)


def test_cron_poll_warns_but_stays_green_when_openai_refuses_the_account(bash, tmp_path):
    result = _run_cron_poll(bash, tmp_path, OUTAGE_BODY)

    assert result.returncode == 0, result.stdout + result.stderr
    warnings = [l for l in result.stdout.splitlines() if l.startswith("::warning")]
    assert len(warnings) == 1, result.stdout
    assert warnings[0].startswith("::warning title=Match alerts paused::")
    # The annotation names the cause itself, not just the body dump above it.
    assert "billing_not_active" in warnings[0]
    assert "::error" not in result.stdout


def test_cron_poll_says_nothing_extra_when_scoring_works(bash, tmp_path):
    result = _run_cron_poll(bash, tmp_path, HEALTHY_BODY)

    assert result.returncode == 0, result.stdout + result.stderr
    assert "::warning" not in result.stdout


def test_cron_poll_still_fails_the_step_on_an_http_error(bash, tmp_path):
    result = _run_cron_poll(bash, tmp_path, '{"detail":"Internal server error"}', code="500")

    assert result.returncode == 1
    assert "HTTP 500" in result.stdout
