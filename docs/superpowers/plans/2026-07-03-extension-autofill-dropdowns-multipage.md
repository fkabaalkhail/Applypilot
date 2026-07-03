# Extension Autofill: Dropdowns, Demographics, Profile-as-source, Multi-page — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make AI-assisted autofill pick only from a dropdown's real options (harvested up front), fill demographic dropdowns to the closest option on-device, ground AI answers in the user's saved Autofill Information, and auto-advance multi-page (Workday) applications while pausing on issues.

**Architecture:** Keep DOM/network orchestration thin in `contentScript.ts`; put all decision logic in pure, unit-tested helpers (`aiFillPlanner`, new `demographicMatch`, new `applicantProfile`, `flowController`). Backend `fill.py` gains an optional structured profile it uses as the primary AI context. No new dependencies.

**Tech Stack:** TypeScript (chrome-extension, vitest), Python/FastAPI (backend, pytest), a plain-text prompt file.

## Global Constraints

- **Demographic/EEO data never leaves the device.** EEO is excluded from every backend request; demographic closest-match runs only in the content script.
- **The flow never clicks a terminal/Submit button.** Auto-advance stops at submit-ready.
- Preserve flow runaway guards: `MAX_STEPS`, `FLOW_TTL_MS`, same-signature loop check.
- Option-harvest is scoped to fields whose options are unknown (custom/lazy widgets); native `<select>`/radio are untouched.
- Extension tests: run vitest directly (`npx vitest run <file>`), not `npm test` (known stdio quirk that exits 1 with no output).
- Backend tests must not call the live LLM — assert on pure helpers / rule-based passes only.

---

## Task A1: Strengthen the answer prompt (closest option, never off-list)

**Files:**
- Modify: `prompts/answer_question.txt` (rule 2)
- Test: `backend/tests/test_fill_prompt.py` (create)

**Interfaces:**
- Produces: a prompt file that instructs the model to return the closest listed option and never an off-list value. Guarded by a content-regression test.

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_fill_prompt.py
from pathlib import Path

PROMPT = Path(__file__).resolve().parent.parent.parent / "prompts" / "answer_question.txt"

def test_prompt_forces_closest_listed_option():
    text = PROMPT.read_text(encoding="utf-8").lower()
    assert "closest" in text
    assert "not in the list" in text
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest backend/tests/test_fill_prompt.py -q`
Expected: FAIL (assert "closest" — current rule 2 has neither phrase).

- [ ] **Step 3: Replace rule 2 in `prompts/answer_question.txt`**

```
2. MULTIPLE CHOICE / DROPDOWN:
   - If options are listed, you MUST respond with EXACTLY one of them, word for word — do not paraphrase or modify the option text.
   - If none of the options is a perfect fit for the applicant, choose the CLOSEST option. Never return a value that is not in the list.
   - If truly nothing applies and a "Prefer not to say" / "Decline to answer" option exists, use that option.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest backend/tests/test_fill_prompt.py -q`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add prompts/answer_question.txt backend/tests/test_fill_prompt.py
git commit -m "feat(fill): prompt must pick the closest listed option, never off-list"
```

---

## Task A2: Backend accepts a structured profile and uses it as primary AI context

**Files:**
- Modify: `backend/routers/fill.py` (`FormField`/`FillRequest` area, `_rule_based_answer`, `fill_form` context building)
- Test: `backend/tests/test_fill_profile.py` (create)

**Interfaces:**
- Produces:
  - `class ApplicantProfile(BaseModel)` — non-sensitive fields (see code).
  - `FillRequest.profile: Optional[ApplicantProfile] = None`.
  - `_profile_context(profile: ApplicantProfile) -> str` — pure, newline-joined context.
  - `_rule_based_answer(label, options, settings, profile=None)` — prefers `profile` over `settings`.

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_fill_profile.py
from backend.routers.fill import ApplicantProfile, _profile_context, _rule_based_answer

def test_profile_context_includes_work_auth_and_salary_excludes_eeo():
    p = ApplicantProfile(
        firstName="Ada", lastName="Lovelace", email="ada@x.io",
        workAuthorization="Canadian citizen", requiresSponsorship="No",
        salaryExpectation="120000", skills=["Python", "SQL"],
    )
    ctx = _profile_context(p)
    assert "Ada Lovelace" in ctx
    assert "Canadian citizen" in ctx
    assert "120000" in ctx
    assert "Python" in ctx
    # EEO is never a field on ApplicantProfile — nothing demographic leaks in.
    assert "race" not in ctx.lower()

def test_rule_based_prefers_profile_over_settings():
    p = ApplicantProfile(firstName="Ada")
    assert _rule_based_answer("First name", [], settings=None, profile=p) == "Ada"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest backend/tests/test_fill_profile.py -q`
Expected: FAIL (ImportError: cannot import name 'ApplicantProfile').

- [ ] **Step 3: Implement in `backend/routers/fill.py`**

Add the model (after `FormField`):

```python
class ApplicantProfile(BaseModel):
    """Non-sensitive slice of the extension's autofill profile. No EEO."""
    firstName: str = ""
    lastName: str = ""
    email: str = ""
    phone: str = ""
    location: str = ""
    addressStreet: str = ""
    addressCity: str = ""
    addressState: str = ""
    postalCode: str = ""
    country: str = ""
    linkedin: str = ""
    github: str = ""
    portfolio: str = ""
    currentCompany: str = ""
    currentTitle: str = ""
    workAuthorization: str = ""
    requiresSponsorship: str = ""
    salaryExpectation: str = ""
    skills: list[str] = []
    experience: list[str] = []   # pre-flattened "Title at Company (dates)" lines
    education: list[str] = []     # pre-flattened "Degree, School (year)" lines
```

Add `profile` to the request:

```python
class FillRequest(BaseModel):
    """Request body for /api/fill."""
    fields: list[FormField]
    resumeText: str = ""
    jobDescription: str = ""
    jobTitle: str = ""
    company: str = ""
    profile: Optional[ApplicantProfile] = None
```

Add the pure context builder (near `_rule_based_answer`):

```python
def _profile_context(p: ApplicantProfile) -> str:
    """Human-readable applicant context from the structured profile."""
    lines: list[str] = []
    name = f"{p.firstName} {p.lastName}".strip()
    if name:
        lines.append(f"Name: {name}")
    if p.email:
        lines.append(f"Email: {p.email}")
    if p.phone:
        lines.append(f"Phone: {p.phone}")
    loc = ", ".join(x for x in [p.addressCity or p.location, p.addressState, p.postalCode, p.country] if x)
    if loc:
        lines.append(f"Location: {loc}")
    role = f"{p.currentTitle} at {p.currentCompany}".strip(" at ").strip()
    if p.currentTitle or p.currentCompany:
        lines.append(f"Current role: {role}")
    if p.workAuthorization:
        lines.append(f"Work authorization: {p.workAuthorization}")
    if p.requiresSponsorship:
        lines.append(f"Requires visa sponsorship: {p.requiresSponsorship}")
    if p.salaryExpectation:
        lines.append(f"Salary expectation: {p.salaryExpectation}")
    for link in (p.linkedin, p.github, p.portfolio):
        if link:
            lines.append(link)
    if p.skills:
        lines.append("Skills: " + ", ".join(p.skills[:30]))
    if p.experience:
        lines.append("Experience:\n" + "\n".join(f"- {e}" for e in p.experience[:8]))
    if p.education:
        lines.append("Education:\n" + "\n".join(f"- {e}" for e in p.education[:5]))
    return "\n".join(lines)
```

Make `_rule_based_answer` prefer the profile (change signature + the profile block):

```python
def _rule_based_answer(label: str, options: list[str], settings, profile=None) -> str | None:
    q = label.lower().strip()
    yes_no = None
    opt_lower = [o.lower().strip() for o in options]
    if "yes" in opt_lower and "no" in opt_lower:
        yes_no = True
    if any(kw in q for kw in ["sponsorship", "sponsor", "require employment"]):
        return "No" if yes_no else "no"
    if any(kw in q for kw in ["legally authorized", "authorized to work", "eligible to work"]):
        return "Yes" if yes_no else "yes"
    if any(kw in q for kw in ["18 years", "18 or older"]):
        return "Yes" if yes_no else "yes"
    if "relocat" in q:
        return "Yes" if yes_no else "yes"
    if "driver" in q and "licen" in q:
        return "Yes" if yes_no else "yes"
    if "background check" in q or "drug test" in q:
        return "Yes" if yes_no else "yes"

    # Prefer the request profile, fall back to stored settings.
    first = (profile.firstName if profile else "") or (settings.first_name if settings else "")
    last = (profile.lastName if profile else "") or (settings.last_name if settings else "")
    email = (profile.email if profile else "") or (settings.email if settings else "")
    phone = (profile.phone if profile else "") or (settings.phone if settings else "")
    city = (profile.addressCity or profile.location if profile else "") or (settings.city if settings else "")
    linkedin = (profile.linkedin if profile else "") or (settings.linkedin_url if settings else "")
    if any(kw in q for kw in ["first name", "given name"]):
        return first or None
    if any(kw in q for kw in ["last name", "surname", "family name"]):
        return last or None
    if "email" in q:
        return email or None
    if "phone" in q:
        return phone or None
    if "city" in q or "location" in q:
        return city or None
    if "linkedin" in q:
        return linkedin or None
    return None
```

In `fill_form`: pass `profile` into the rule pass and build the AI context from it. Change the Pass-1 call:

```python
    for field in request.fields:
        rule_answer = _rule_based_answer(field.label, field.options, settings, request.profile)
```

Replace the Pass-3 `context_parts` applicant block (currently the hardcoded `Country: Canada`):

```python
            context_parts = []
            if request.profile is not None:
                context_parts.append("APPLICANT:\n" + _profile_context(request.profile))
            elif settings:
                context_parts.append(
                    f"APPLICANT: {settings.first_name or ''} {settings.last_name or ''}, "
                    f"Email: {settings.email or ''}, Phone: {settings.phone or ''}, "
                    f"City: {settings.city or ''}, Country: Canada"
                )
            if resume_text:
                context_parts.append(f"RESUME:\n{resume_text[:3000]}")
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest backend/tests/test_fill_profile.py -q`
Expected: PASS (2 passed)

- [ ] **Step 5: Commit**

```bash
git add backend/routers/fill.py backend/tests/test_fill_profile.py
git commit -m "feat(fill): accept structured applicant profile as primary AI context"
```

---

## Task B1: `toApplicantProfile` — build the non-sensitive profile slice (extension)

**Files:**
- Create: `chrome-extension/src/content/applicantProfile.ts`
- Test: `chrome-extension/test/applicantProfile.test.ts` (create)

**Interfaces:**
- Produces:
  - `interface ApplicantProfile` (mirrors backend `ApplicantProfile`; experience/education are flattened `string[]`).
  - `toApplicantProfile(p: UserApplicationProfile): ApplicantProfile` — copies non-sensitive fields, flattens experience/education, **omits `eeo`**.

- [ ] **Step 1: Write the failing test**

```ts
// chrome-extension/test/applicantProfile.test.ts
import { describe, it, expect } from "vitest";
import { toApplicantProfile } from "../src/content/applicantProfile";
import type { UserApplicationProfile } from "../src/shared/types";

const base: UserApplicationProfile = {
  firstName: "Ada", lastName: "Lovelace", email: "ada@x.io", phone: "555",
  location: "Toronto", addressStreet: "1 St", addressCity: "Toronto",
  addressState: "ON", postalCode: "M1", country: "Canada",
  linkedin: "li", github: "gh", portfolio: "pf",
  currentCompany: "Acme", currentTitle: "Eng",
  workAuthorization: "Citizen", requiresSponsorship: "No",
  education: [{ school: "UofT", degree: "BSc", graduationYear: "2020" }],
  experience: [{ company: "Acme", title: "Eng", startDate: "2020", endDate: "2024", description: "x" }],
  skills: ["Python"], coverLetter: "", salaryExpectation: "120000",
  eeo: { race: "Arab", gender: "Woman" },
};

describe("toApplicantProfile", () => {
  it("copies non-sensitive fields and flattens experience/education", () => {
    const a = toApplicantProfile(base);
    expect(a.workAuthorization).toBe("Citizen");
    expect(a.salaryExpectation).toBe("120000");
    expect(a.experience[0]).toContain("Eng");
    expect(a.experience[0]).toContain("Acme");
    expect(a.education[0]).toContain("BSc");
  });

  it("never includes EEO/demographic data", () => {
    const a = toApplicantProfile(base) as Record<string, unknown>;
    expect(JSON.stringify(a).toLowerCase()).not.toContain("arab");
    expect("eeo" in a).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run chrome-extension/test/applicantProfile.test.ts`
Expected: FAIL (cannot find module applicantProfile).

- [ ] **Step 3: Implement `chrome-extension/src/content/applicantProfile.ts`**

```ts
/**
 * Builds the non-sensitive applicant profile the backend AI uses as context.
 * Mirrors backend ApplicantProfile (backend/routers/fill.py). EEO/demographic
 * data is deliberately dropped here — it must never reach any server.
 */
import type { UserApplicationProfile } from "../shared/types";

export interface ApplicantProfile {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  location: string;
  addressStreet: string;
  addressCity: string;
  addressState: string;
  postalCode: string;
  country: string;
  linkedin: string;
  github: string;
  portfolio: string;
  currentCompany: string;
  currentTitle: string;
  workAuthorization: string;
  requiresSponsorship: string;
  salaryExpectation: string;
  skills: string[];
  experience: string[];
  education: string[];
}

export function toApplicantProfile(p: UserApplicationProfile): ApplicantProfile {
  return {
    firstName: p.firstName ?? "",
    lastName: p.lastName ?? "",
    email: p.email ?? "",
    phone: p.phone ?? "",
    location: p.location ?? "",
    addressStreet: p.addressStreet ?? "",
    addressCity: p.addressCity ?? "",
    addressState: p.addressState ?? "",
    postalCode: p.postalCode ?? "",
    country: p.country ?? "",
    linkedin: p.linkedin ?? "",
    github: p.github ?? "",
    portfolio: p.portfolio ?? "",
    currentCompany: p.currentCompany ?? "",
    currentTitle: p.currentTitle ?? "",
    workAuthorization: p.workAuthorization ?? "",
    requiresSponsorship: p.requiresSponsorship ?? "",
    salaryExpectation: p.salaryExpectation ?? "",
    skills: (p.skills ?? []).slice(0, 30),
    experience: (p.experience ?? [])
      .slice(0, 8)
      .map((e) => {
        const dates = [e.startDate, e.endDate].filter(Boolean).join("–");
        return [`${e.title} at ${e.company}`.trim(), dates ? `(${dates})` : ""].filter(Boolean).join(" ");
      }),
    education: (p.education ?? [])
      .slice(0, 5)
      .map((e) => [`${e.degree}, ${e.school}`.replace(/^, |, $/g, ""), e.graduationYear ? `(${e.graduationYear})` : ""].filter(Boolean).join(" ")),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run chrome-extension/test/applicantProfile.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add chrome-extension/src/content/applicantProfile.ts chrome-extension/test/applicantProfile.test.ts
git commit -m "feat(extension): build non-sensitive ApplicantProfile for AI context"
```

---

## Task B2: `needsOptionHarvest` predicate (extension)

**Files:**
- Modify: `chrome-extension/src/content/aiFillPlanner.ts`
- Test: `chrome-extension/test/aiFillPlanner.test.ts` (create if absent; else append)

**Interfaces:**
- Consumes: `DetectedField`; a minimal `{ controlType, driver }` control view.
- Produces: `needsOptionHarvest(field: DetectedField, hasDriver: boolean): boolean` — true when a choice field's real options are unknown and must be harvested.

- [ ] **Step 1: Write the failing test**

```ts
// chrome-extension/test/aiFillPlanner.test.ts  (append if file exists)
import { describe, it, expect } from "vitest";
import { needsOptionHarvest } from "../src/content/aiFillPlanner";
import type { DetectedField } from "../src/shared/types";

const f = (over: Partial<DetectedField>): DetectedField => ({
  id: "1", category: "unknown", confidence: 1, label: "Country", controlType: "combobox",
  required: true, proposedValue: null, fillable: true, sensitive: false, ...over,
});

describe("needsOptionHarvest", () => {
  it("harvests a combobox with no known options", () => {
    expect(needsOptionHarvest(f({ controlType: "combobox", options: [] }), false)).toBe(true);
  });
  it("harvests a driver-backed field with no options", () => {
    expect(needsOptionHarvest(f({ controlType: "customDropdown", options: [] }), true)).toBe(true);
  });
  it("skips when options are already known", () => {
    expect(needsOptionHarvest(f({ controlType: "combobox", options: ["A", "B"] }), false)).toBe(false);
  });
  it("skips a native select with options / a plain text field", () => {
    expect(needsOptionHarvest(f({ controlType: "select", options: ["A"] }), false)).toBe(false);
    expect(needsOptionHarvest(f({ controlType: "text", options: [] }), false)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run chrome-extension/test/aiFillPlanner.test.ts`
Expected: FAIL (needsOptionHarvest not exported).

- [ ] **Step 3: Implement in `aiFillPlanner.ts`**

```ts
/**
 * True when a choice field's REAL options aren't known yet and must be harvested
 * from the live widget before the AI answers it. Custom/lazy dropdowns
 * (react-select, Workday button-listboxes) mount their list only when opened, so
 * they scan with empty options; native <select>/radio already expose theirs.
 */
export function needsOptionHarvest(field: DetectedField, hasDriver: boolean): boolean {
  if ((field.options?.length ?? 0) > 0) return false;
  if (field.controlType === "combobox" || field.controlType === "customDropdown") return true;
  return hasDriver;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run chrome-extension/test/aiFillPlanner.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add chrome-extension/src/content/aiFillPlanner.ts chrome-extension/test/aiFillPlanner.test.ts
git commit -m "feat(extension): needsOptionHarvest predicate for lazy dropdowns"
```

---

## Task B3: `demographicMatch` — on-device closest-option matcher (extension)

**Files:**
- Create: `chrome-extension/src/content/demographicMatch.ts`
- Test: `chrome-extension/test/demographicMatch.test.ts` (create)

**Interfaces:**
- Produces: `closestDemographicOption(category: FieldCategory, value: string, options: string[]): string | null`.

- [ ] **Step 1: Write the failing test**

```ts
// chrome-extension/test/demographicMatch.test.ts
import { describe, it, expect } from "vitest";
import { closestDemographicOption } from "../src/content/demographicMatch";

const RACE = ["White", "Black or African American", "Asian", "Hispanic or Latino", "Two or More Races", "Prefer Not to Say"];

describe("closestDemographicOption", () => {
  it("maps Arab to a MENA option when offered", () => {
    const opts = [...RACE, "Middle Eastern or North African"];
    expect(closestDemographicOption("eeoRace", "Arab", opts)).toBe("Middle Eastern or North African");
  });
  it("maps Arab to White when no MENA option exists", () => {
    expect(closestDemographicOption("eeoRace", "Arab", RACE)).toBe("White");
  });
  it("falls back to a decline option when nothing matches", () => {
    expect(closestDemographicOption("eeoRace", "Klingon", RACE)).toBe("Prefer Not to Say");
  });
  it("returns null when there is no match and no decline option", () => {
    expect(closestDemographicOption("eeoRace", "Klingon", ["White", "Asian"])).toBeNull();
  });
  it("maps Woman to Female", () => {
    expect(closestDemographicOption("eeoGender", "Woman", ["Male", "Female", "Non-binary"])).toBe("Female");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run chrome-extension/test/demographicMatch.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `chrome-extension/src/content/demographicMatch.ts`**

```ts
/**
 * On-device closest-option matcher for EEO / demographic dropdowns. Given the
 * user's profile value and the widget's REAL options, returns the nearest
 * available option — so "Arab" fills a US-Census race dropdown as "White" or a
 * MENA option when offered. Never sent to any server; demographic answers stay
 * on the device by policy.
 */
import type { FieldCategory } from "../shared/types";

const DECLINE_PATTERNS = ["prefer not", "decline", "do not wish", "not to disclose", "not disclosed", "choose not"];

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Priority-ordered option substrings for a normalized profile value. */
const RACE: Record<string, string[]> = {
  "arab": ["middle eastern", "north african", "mena", "white"],
  "middle eastern": ["middle eastern", "north african", "mena", "white"],
  "north african": ["north african", "middle eastern", "mena", "white"],
  "persian": ["middle eastern", "mena", "white", "asian"],
  "hispanic": ["hispanic", "latino", "latinx"],
  "latino": ["hispanic", "latino", "latinx"],
  "south asian": ["asian", "south asian"],
  "east asian": ["asian", "east asian"],
  "desi": ["asian", "south asian"],
  "caucasian": ["white", "caucasian"],
  "black": ["black", "african american", "african"],
  "african american": ["black", "african american", "african"],
  "indigenous": ["native", "indigenous", "aboriginal", "first nations"],
  "native american": ["native", "indigenous", "american indian"],
  "mixed": ["two or more", "multiracial", "mixed"],
  "biracial": ["two or more", "multiracial", "mixed"],
};

const GENDER: Record<string, string[]> = {
  "man": ["male", "man"],
  "male": ["male", "man"],
  "woman": ["female", "woman"],
  "female": ["female", "woman"],
  "non binary": ["non binary", "nonbinary", "genderqueer"],
};

const VETERAN: Record<string, string[]> = {
  "no": ["not a protected veteran", "not a veteran", "no"],
  "not a veteran": ["not a protected veteran", "not a veteran", "no"],
  "yes": ["identify as one or more", "protected veteran", "yes"],
  "protected veteran": ["identify as one or more", "protected veteran", "yes"],
  "veteran": ["protected veteran", "veteran", "yes"],
};

const DISABILITY: Record<string, string[]> = {
  "no": ["no i do not", "do not have", "no"],
  "yes": ["yes i have", "have a disability", "yes"],
};

function tableFor(category: FieldCategory): Record<string, string[]> | null {
  switch (category) {
    case "eeoRace":
    case "eeoHispanic":
      return RACE;
    case "eeoGender":
      return GENDER;
    case "eeoVeteran":
      return VETERAN;
    case "eeoDisability":
      return DISABILITY;
    default:
      return null;
  }
}

export function closestDemographicOption(
  category: FieldCategory,
  value: string,
  options: string[]
): string | null {
  const opts = options.map((o) => ({ raw: o, n: norm(o) })).filter((o) => o.n.length > 0);
  const v = norm(value);
  if (opts.length === 0 || !v) return null;

  // 1. Direct containment either direction.
  const direct = opts.find((o) => o.n === v || o.n.includes(v) || v.includes(o.n));
  if (direct) return direct.raw;

  // 2. Synonym / nearest-neighbour candidates, in priority order.
  for (const cand of tableFor(category)?.[v] ?? []) {
    const hit = opts.find((o) => o.n.includes(cand));
    if (hit) return hit.raw;
  }

  // 3. Decline / prefer-not-to-say fallback.
  const decline = opts.find((o) => DECLINE_PATTERNS.some((d) => o.n.includes(d)));
  return decline ? decline.raw : null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run chrome-extension/test/demographicMatch.test.ts`
Expected: PASS (5 passed)

- [ ] **Step 5: Commit**

```bash
git add chrome-extension/src/content/demographicMatch.ts chrome-extension/test/demographicMatch.test.ts
git commit -m "feat(extension): on-device closest-option matcher for demographics"
```

---

## Task B4: Combobox commit verification — tolerate slow/dependent commits

**Files:**
- Modify: `chrome-extension/src/content/comboboxEngine.ts` (`DEFAULTS.commitWaitMs`, post-commit re-read)
- Test: `chrome-extension/test/comboboxEngine.test.ts` (append)

**Interfaces:**
- Consumes/Produces: no signature change; `fillAriaCombobox` waits longer for the committed value to appear before reporting "Selection didn't stick".

- [ ] **Step 1: Write the failing test** (a widget that paints its committed value after a delay)

```ts
// chrome-extension/test/comboboxEngine.test.ts  (append)
import { describe, it, expect } from "vitest";
import { fillAriaCombobox } from "../src/content/comboboxEngine";

describe("fillAriaCombobox slow commit", () => {
  it("accepts a value that only appears after a delayed re-render", async () => {
    document.body.innerHTML = `
      <div class="select">
        <div role="combobox" aria-expanded="false" aria-controls="lb" tabindex="0"></div>
        <ul id="lb" role="listbox" style="display:none">
          <li role="option">Canada</li><li role="option">United States</li>
        </ul>
        <div class="select__single-value"></div>
      </div>`;
    const trigger = document.querySelector('[role="combobox"]') as HTMLElement;
    const listbox = document.getElementById("lb") as HTMLElement;
    const single = document.querySelector(".select__single-value") as HTMLElement;
    trigger.addEventListener("click", () => { listbox.style.display = "block"; trigger.setAttribute("aria-expanded", "true"); });
    listbox.addEventListener("click", (e) => {
      const opt = (e.target as HTMLElement).closest('[role="option"]');
      if (!opt) return;
      // Value paints 700ms later — longer than the old 1000ms only in aggregate.
      setTimeout(() => { single.textContent = opt.textContent; }, 700);
    });
    const res = await fillAriaCombobox(trigger, "Canada", { openWaitMs: 200, pollMs: 20 });
    expect(res.filled).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails or is flaky**

Run: `npx vitest run chrome-extension/test/comboboxEngine.test.ts -t "slow commit"`
Expected: FAIL if `commitWaitMs` is too tight for the 700ms paint under jsdom timing.

- [ ] **Step 3: Implement — raise the commit budget and re-read once more**

In `comboboxEngine.ts` change the default:

```ts
const DEFAULTS = { openWaitMs: 1000, commitWaitMs: 2500, pollMs: 50 };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run chrome-extension/test/comboboxEngine.test.ts`
Expected: PASS (whole file stays green)

- [ ] **Step 5: Commit**

```bash
git add chrome-extension/src/content/comboboxEngine.ts chrome-extension/test/comboboxEngine.test.ts
git commit -m "fix(extension): give combobox commits longer to paint before failing"
```

---

## Task C1: Thread `ApplicantProfile` through the AI_FILL request

**Files:**
- Modify: `chrome-extension/src/shared/types.ts` (`AI_FILL` message), `chrome-extension/src/api/aiFill.ts`, `chrome-extension/src/background/serviceWorker.ts`
- Test: `chrome-extension/test/aiFill.test.ts` (create)

**Interfaces:**
- Consumes: `ApplicantProfile` (Task B1).
- Produces: `AI_FILL` carries `profile?: ApplicantProfile`; `buildFillRequestBody(fields, jobContext, profile?)` includes it; `aiFillFields(fields, jobContext, profile?)`.

- [ ] **Step 1: Write the failing test**

```ts
// chrome-extension/test/aiFill.test.ts
import { describe, it, expect } from "vitest";
import { buildFillRequestBody } from "../src/api/aiFill";
import type { JobContext } from "../src/shared/types";

const ctx: JobContext = { jobDescription: "d", jobTitle: "t", company: "c" };

describe("buildFillRequestBody", () => {
  it("includes the applicant profile when provided", () => {
    const body = buildFillRequestBody([], ctx, { firstName: "Ada" } as any);
    expect(body.profile).toEqual({ firstName: "Ada" });
  });
  it("omits profile when not provided", () => {
    const body = buildFillRequestBody([], ctx);
    expect(body.profile).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run chrome-extension/test/aiFill.test.ts`
Expected: FAIL (buildFillRequestBody has no profile param).

- [ ] **Step 3: Implement**

`types.ts` — import and extend the `AI_FILL` message (top of file add `import type { ApplicantProfile } from "../content/applicantProfile";`) and change the union member:

```ts
  | { type: "AI_FILL"; fields: AiFillField[]; jobContext: JobContext; profile?: ApplicantProfile }
```

`api/aiFill.ts` — extend both functions:

```ts
import type { AiFillAnswer, AiFillField, JobContext } from "../shared/types";
import type { ApplicantProfile } from "../content/applicantProfile";
import { authedRequest } from "./client";

interface FillApiResponse {
  answers: AiFillAnswer[];
  errors: string[];
}

export function buildFillRequestBody(
  fields: AiFillField[],
  jobContext: JobContext,
  profile?: ApplicantProfile
): {
  fields: AiFillField[];
  resumeText: string;
  jobDescription: string;
  jobTitle: string;
  company: string;
  profile?: ApplicantProfile;
} {
  return {
    fields,
    resumeText: "",
    jobDescription: jobContext.jobDescription,
    jobTitle: jobContext.jobTitle,
    company: jobContext.company,
    ...(profile ? { profile } : {}),
  };
}

export async function aiFillFields(
  fields: AiFillField[],
  jobContext: JobContext,
  profile?: ApplicantProfile
): Promise<FillApiResponse> {
  return authedRequest<FillApiResponse>("/api/fill", {
    method: "POST",
    body: JSON.stringify(buildFillRequestBody(fields, jobContext, profile)),
  });
}
```

`serviceWorker.ts` — pass the profile through in the `AI_FILL` case:

```ts
        const { answers, errors } = await aiFillFields(message.fields, message.jobContext, message.profile);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run chrome-extension/test/aiFill.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add chrome-extension/src/shared/types.ts chrome-extension/src/api/aiFill.ts chrome-extension/src/background/serviceWorker.ts chrome-extension/test/aiFill.test.ts
git commit -m "feat(extension): send ApplicantProfile with AI_FILL requests"
```

---

## Task C2: Wire harvest-first, profile, and demographic match into `fillOnce`

**Files:**
- Modify: `chrome-extension/src/content/contentScript.ts` (`fillOnce`, imports)
- Verify: typecheck + existing browser probe (no unit test — `fillOnce` is DOM/chrome orchestration)

**Interfaces:**
- Consumes: `needsOptionHarvest` (B2), `harvestComboboxOptions` (existing), `closestDemographicOption` (B3), `toApplicantProfile` (B1).

- [ ] **Step 1: Add imports (top of `contentScript.ts`)**

```ts
import { aiFillCandidates, needsOptionHarvest, planAiFill, planFillRoute, planReaskFields, tallyOutcomes, toAiFillField, type PlannedAnswer, type ReaskCandidate } from "./aiFillPlanner";
import { closestDemographicOption } from "./demographicMatch";
import { toApplicantProfile } from "./applicantProfile";
```

- [ ] **Step 2: Pre-AI harvest pass** — in `fillOnce`, inside `if (backendFields.length > 0 && !signal?.aborted)`, immediately after `const { hits, misses } = splitByCache(backendFields);` add:

```ts
        // Harvest real options for lazy dropdowns BEFORE asking the AI, so its
        // first answer is constrained to what the widget actually offers.
        for (const f of misses) {
          if (signal?.aborted) break;
          const control = registry.get(f.id);
          if (!needsOptionHarvest(f, Boolean(control?.driver)) || !control?.el) continue;
          const harvested = await harvestComboboxOptions(control.el).catch(() => undefined);
          if (harvested && harvested.length > 0) f.options = harvested;
        }
```

- [ ] **Step 3: Send the profile with both AI_FILL calls** — replace the two `sendToBackground<AiFillResponse>({ type: "AI_FILL", ... })` bodies so each includes:

```ts
              type: "AI_FILL",
              fields: misses.map(toAiFillField),
              jobContext: extractJobContext(),
              profile: lastProfile ? toApplicantProfile(lastProfile) : undefined,
```

and for the re-ask call:

```ts
              type: "AI_FILL",
              fields: reaskFields,
              jobContext: extractJobContext(),
              profile: lastProfile ? toApplicantProfile(lastProfile) : undefined,
```

- [ ] **Step 4: Demographic local re-fill** — replace the re-ask block's candidate handling. After `const reaskCandidates = [...localFill.reask, ...aiFill.reask, ...fallbackFill.reask];` insert the split + local demographic fill, and make the backend re-ask use only the non-sensitive candidates:

```ts
      // Sensitive (EEO) fields never go to the backend. Pick their closest
      // option on-device from the harvested list instead.
      const sensitiveReask = reaskCandidates.filter((c) => lastFields.find((f) => f.id === c.fieldId)?.sensitive);
      const openReask = reaskCandidates.filter((c) => !lastFields.find((f) => f.id === c.fieldId)?.sensitive);
      let demoFill: { reports: FieldReport[]; outcomes: { fieldId: string; ok: boolean }[]; reask: ReaskCandidate[] } =
        { reports: [], outcomes: [], reask: [] };
      if (sensitiveReask.length > 0 && !signal?.aborted) {
        const demoTargets: { fieldId: string; value: string }[] = [];
        for (const c of sensitiveReask) {
          const f = lastFields.find((x) => x.id === c.fieldId);
          if (!f) continue;
          const choice = closestDemographicOption(f.category, f.proposedValue ?? "", c.options);
          if (choice) demoTargets.push({ fieldId: c.fieldId, value: choice });
        }
        if (demoTargets.length > 0) demoFill = await fillItems(demoTargets, true, signal);
      }
```

Then change the existing backend re-ask to iterate `openReask` instead of `reaskCandidates` (the `if (reaskCandidates.length > 0 ...)` guard and the `for (const c of reaskCandidates)` / `planReaskFields(lastFields, reaskCandidates)` references all become `openReask`).

- [ ] **Step 5: Fold `demoFill` into the tally + telemetry** — add `demoFill.reports` / `demoFill.outcomes` everywhere `reaskFill.reports` / `reaskFill.outcomes` are aggregated (the `tallyOutcomes(...)` call, the `allReports` array, and the `allOutcomes` array).

- [ ] **Step 6: Typecheck + build**

Run: `cd chrome-extension && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Full extension test suite stays green**

Run: `cd chrome-extension && npx vitest run`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add chrome-extension/src/content/contentScript.ts
git commit -m "feat(extension): harvest options first, send profile, closest-match demographics"
```

---

## Task D1: Add the `unfilled-required` pause reason + overlay copy

**Files:**
- Modify: `chrome-extension/src/shared/types.ts` (`FlowPauseReason`), `chrome-extension/src/content/overlay.ts` (`PAUSE_TEXT`, `updateFlowProgress`)
- Test: `chrome-extension/test/overlay.test.ts` (append; `formatFlowProgress` is pure)

**Interfaces:**
- Produces: `FlowPauseReason` includes `"unfilled-required"`; the Next-page button shows for that pause (manual override).

- [ ] **Step 1: Write the failing test**

```ts
// chrome-extension/test/overlay.test.ts  (append)
import { describe, it, expect } from "vitest";
import { formatFlowProgress } from "../src/content/overlay";

describe("formatFlowProgress unfilled-required", () => {
  it("describes the unfilled-required pause", () => {
    const line = formatFlowProgress({ phase: "paused", step: 1, filledOk: 3, filledFail: 0, pauseReason: "unfilled-required" });
    expect(line.toLowerCase()).toContain("required");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run chrome-extension/test/overlay.test.ts -t "unfilled-required"`
Expected: FAIL (TS: "unfilled-required" not assignable to FlowPauseReason).

- [ ] **Step 3: Implement**

`types.ts`:

```ts
export type FlowPauseReason =
  | "captcha"
  | "resume-upload"
  | "validation"
  | "account"
  | "verification"
  | "unfilled-required";
```

`overlay.ts` — add the copy and show the button for this pause:

```ts
const PAUSE_TEXT: Record<FlowPauseReason, string> = {
  captcha: "solve the captcha to continue",
  "resume-upload": "attach your résumé to continue",
  validation: "fix the highlighted errors to continue",
  account: "sign in to continue",
  verification: "enter the emailed code to continue",
  "unfilled-required": "fill the required fields, or Next page to continue",
};
```

In `updateFlowProgress`, change the Next-page visibility line to also show it on an `unfilled-required` pause:

```ts
  refs.flowNext.style.display =
    p.phase === "ready" || (p.phase === "paused" && p.pauseReason === "unfilled-required") ? "flex" : "none";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run chrome-extension/test/overlay.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add chrome-extension/src/shared/types.ts chrome-extension/src/content/overlay.ts chrome-extension/test/overlay.test.ts
git commit -m "feat(extension): add unfilled-required flow pause + manual override button"
```

---

## Task D2: FlowController — auto-advance clean pages, pause on unfilled-required

**Files:**
- Modify: `chrome-extension/src/content/flowController.ts` (`FlowDeps`, `run`)
- Test: `chrome-extension/test/flowController.test.ts` (append)

**Interfaces:**
- Produces: `FlowDeps.hasUnfilledRequired(snap: FlowSnapshot): boolean`; `run` auto-advances when clean, emits `paused`/`unfilled-required` and waits for the manual override otherwise.

- [ ] **Step 1: Write the failing test** (clean page auto-advances without a manual Next-page call)

```ts
// chrome-extension/test/flowController.test.ts  (append)
import { describe, it, expect } from "vitest";
import { FlowController, type FlowDeps } from "../src/content/flowController";

function deps(over: Partial<FlowDeps>): FlowDeps {
  return {
    fillStep: async () => ({ ok: 1, fail: 0, total: 1 }),
    snapshot: () => ({ fields: [], scopeEl: document.body }),
    rescan: () => {},
    findAdvance: () => ({ kind: "advance", el: document.createElement("button") }),
    clickAdvance: () => {},
    accountStep: async () => ({}),
    pauseReason: async () => null,
    needsResume: () => false,
    attachResume: async () => true,
    hasUnfilledRequired: () => false,
    setState: async () => {},
    onProgress: () => {},
    sleep: async () => {},
    now: () => 0,
    ...over,
  };
}

describe("FlowController auto-advance", () => {
  it("advances a clean page without waiting for a manual Next-page click", async () => {
    let clicked = 0;
    let scans = 0;
    const d = deps({
      clickAdvance: () => { clicked++; },
      // Change the signature after the first advance so waitForChange resolves,
      // then report no advance button so the flow finishes.
      snapshot: () => ({ fields: scans++ > 1 ? [{ id: "x", category: "unknown", confidence: 1, label: "L", controlType: "text", required: false, proposedValue: null, fillable: true, sensitive: false }] : [], scopeEl: document.body }),
      findAdvance: () => (clicked === 0 ? { kind: "advance", el: document.createElement("button") } : null),
    });
    const c = new FlowController(d);
    await c.run({ active: true, step: 0, startedAt: 0, lastSignature: "" }, { ok: 1, fail: 0, total: 1 });
    expect(clicked).toBe(1);
  });

  it("pauses on unfilled-required and does not auto-advance", async () => {
    const phases: string[] = [];
    let clicked = 0;
    const c = new FlowController(deps({
      hasUnfilledRequired: () => true,
      onProgress: (p) => phases.push(`${p.phase}:${p.pauseReason ?? ""}`),
      clickAdvance: () => { clicked++; },
    }));
    const run = c.run({ active: true, step: 0, startedAt: 0, lastSignature: "" }, { ok: 1, fail: 0, total: 1 });
    await Promise.resolve();
    c.stop(); // unblock the manual gate
    await run;
    expect(phases.some((p) => p.startsWith("paused:unfilled-required"))).toBe(true);
    expect(clicked).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run chrome-extension/test/flowController.test.ts`
Expected: FAIL (hasUnfilledRequired missing; old code emits "ready" and blocks on a manual click).

- [ ] **Step 3: Implement**

Add to `FlowDeps` (after `needsResume`):

```ts
  /** True when a required field on this page is still empty (pause on issues). */
  hasUnfilledRequired(snap: FlowSnapshot): boolean;
```

In `run`, replace the ready-gate block:

```ts
      // Page filled — hand control back to the user. The flow parks here until
      // the panel's "Next page" button calls notifyAdvanceRequested() (or Stop).
      // A blocking condition (e.g. a captcha) may have re-appeared while the
      // user reviewed, so re-check it once before clicking advance.
      this.emit("ready");
      if (!(await this.waitForAdvanceRequest())) return this.finishStopped();
      if (!(await this.waitWhileBlocked())) return this.finishStopped();
```

with:

```ts
      // Auto-advance when the page is clean; pause for the user only on an issue.
      // Unfilled required fields would fail the site's own validation, so we stop
      // and let the user fill them (or force-advance via the Next page button).
      if (this.deps.hasUnfilledRequired(snap)) {
        this.emit("paused", { pauseReason: "unfilled-required" });
        if (!(await this.waitForAdvanceRequest())) return this.finishStopped();
      }
      if (!(await this.waitWhileBlocked())) return this.finishStopped();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run chrome-extension/test/flowController.test.ts`
Expected: PASS (existing flowController tests updated for the new dep — add `hasUnfilledRequired: () => false` to their fake deps if they construct `FlowDeps` inline).

- [ ] **Step 5: Commit**

```bash
git add chrome-extension/src/content/flowController.ts chrome-extension/test/flowController.test.ts
git commit -m "feat(extension): auto-advance clean pages, pause on unfilled required fields"
```

---

## Task D3: Provide `hasUnfilledRequired` from contentScript

**Files:**
- Modify: `chrome-extension/src/content/contentScript.ts` (`makeFlowDeps`)
- Verify: typecheck (wiring; behavior covered by D2's unit tests)

**Interfaces:**
- Consumes: existing `controlIsEmpty(id)` closure.

- [ ] **Step 1: Add the dep** — inside `makeFlowDeps()` return object, alongside `needsResume`:

```ts
      hasUnfilledRequired: (snap) =>
        snap.fields.some(
          (f) => f.required && f.fillable && f.controlType !== "file" && controlIsEmpty(f.id)
        ),
```

- [ ] **Step 2: Typecheck**

Run: `cd chrome-extension && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add chrome-extension/src/content/contentScript.ts
git commit -m "feat(extension): report unfilled required fields to the flow controller"
```

---

## Task E1: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Backend suite**

Run: `python -m pytest backend/tests/test_fill_prompt.py backend/tests/test_fill_profile.py -q`
Expected: all pass.

- [ ] **Step 2: Extension typecheck + full vitest**

Run: `cd chrome-extension && npx tsc --noEmit && npx vitest run`
Expected: no type errors; all tests pass.

- [ ] **Step 3: Build the extension**

Run: `cd chrome-extension && npm run build`
Expected: build succeeds (load `dist/` unpacked for manual checks).

- [ ] **Step 4: Live replay (manual, load unpacked build)**
  - Greenhouse `job-boards.greenhouse.io` posting: confirm `Country`, `Location (City)`, `Veteran Status`, `Disability` now fill (Veteran/Disability via on-device closest-match; Country/City via harvested options). No blank-reason combobox misses.
  - `td.wd3.myworkdayjobs.com` Workday flow: confirm `Country Phone Code` and `How Did You Hear About Us?` fill, and that after a clean page the flow advances automatically and pauses when a required field is empty.

- [ ] **Step 5: Re-check telemetry (after a session)**

```sql
-- via Neon MCP, project divine-base-11638078
SELECT ats_type, sum(failed) AS failed, sum(filled) AS filled
FROM autofill_reports
WHERE created_at > now() - interval '1 day'
GROUP BY ats_type ORDER BY failed DESC;
```
Expected: combobox blank-reason failures on Greenhouse/Workday drop versus the 2026-07-03 baseline.

---

## Self-Review

**Spec coverage:**
- WS1 harvest-first → B2 (`needsOptionHarvest`) + C2 step 2; prompt → A1; combobox commit → B4. ✓
- WS2 demographic closest-match → B3 + C2 step 4 (sensitive local re-fill). ✓
- WS3 profile → AI → A2 (backend) + B1 (`toApplicantProfile`) + C1 (transport) + C2 step 3. ✓
- WS4 multi-page auto-advance/pause → D1 (pause reason + copy) + D2 (controller) + D3 (dep). ✓
- Verification → E1 (unit + live replay + telemetry). ✓

**Placeholder scan:** none — every code step carries real code.

**Type consistency:** `ApplicantProfile` defined in B1, imported by C1/C2 and mirrored (by value) in A2. `needsOptionHarvest(field, hasDriver)` used consistently in B2/C2. `closestDemographicOption(category, value, options)` used in B3/C2. `hasUnfilledRequired(snap)` defined in D2, implemented in D3. `FlowPauseReason` "unfilled-required" added in D1, used in D2. ✓

**Note (Country "Value did not stick", `reconciler.ts:330`):** expected to resolve once WS1 makes the AI answer the exact option text ("Canada", not "Canadian"). If E1 step 4 still shows it, add a follow-up task to widen the reconciler's post-write verify window for dependent dropdowns. Out of scope now to avoid a risky reconciler change. The Workday "Ambiguous checkbox value" (single checkbox, `writeEngine.ts:94`) is out of scope — not a dropdown.
