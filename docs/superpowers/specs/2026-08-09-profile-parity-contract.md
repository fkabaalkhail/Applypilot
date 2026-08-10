# Profile parity contract — web ⇄ API ⇄ extension

Date: 2026-08-09. **This file is the single source of truth for Phase 2.** Backend, web
and extension are implemented by three workers in parallel; every name, label and option
string below is binding on all three. Do not invent variants.

Endpoints: `GET/PUT /api/user/application-profile` (`backend/routers/profile.py`) and
`GET /api/extension/sync`, which reuses `build_application_profile()`.

---

## A. Storage

New columns on `user_settings`, added by a new idempotent migration
`backend/migrations/add_profile_answer_columns.py`:

| column | why |
|---|---|
| `github_url` | `github` had no write path at all — web wrote it to the resume row, the extension kept it device-local, so it never round-tripped |
| `address_city` | `location` and `addressCity` both wrote `user_settings.city`; a PUT carrying both silently dropped one. Backfill `address_city` from `city` |
| `eeo_gender_identity` | declared in the extension's `EeoAnswers` type but implemented nowhere |
| `eeo_pronouns` | new |
| `eeo_sexual_orientation` | declared in the extension's `EeoAnswers` type but implemented nowhere |

The **screening answers** below need no schema change: they live in the existing
`user_settings.prefilled_answers` JSON, exactly like `workAuthorization`,
`requiresSponsorship`, `salaryExpectation` and `dateOfBirth` already do. Each has an exact
key, and — like `_DOB_KEY` — **is never substring-mined**. Add every new key to the
"explicitly saved beats mined" set, and to `_SETUP_KEYS`-style exclusion where relevant.

| API key | exact `prefilled_answers` key |
|---|---|
| `willingToRelocate` | `Willing to relocate` |
| `workPreference` | `Work preference` |
| `noticePeriod` | `Notice period` |
| `earliestStartDate` | `Earliest start date` |
| `yearsOfExperience` | `Years of experience` |
| `securityClearance` | `Security clearance` |
| `driversLicense` | `Driver's licence` |
| `languages` | `Languages` |

## B. API surface

`ApplicationProfileOut` gains: `willingToRelocate`, `workPreference`, `noticePeriod`,
`earliestStartDate`, `yearsOfExperience`, `securityClearance`, `driversLicense`,
`languages`; `EeoOut` gains `genderIdentity`, `pronouns`, `sexualOrientation`.

`ApplicationProfileIn` gains **all of the above plus `github`** (previously read-only).
`EeoIn` gains the same three.

`addressCity` now persists to `address_city`; `location` keeps `city`. Both are still
returned; `addressCity` falls back to `city` when `address_city` is blank, so existing
rows keep working.

## C. Exact labels — identical on both surfaces

Web (`frontend/src/pages/Profile.tsx`) and extension (`chrome-extension/src/content/overlay.ts`)
must render the SAME label text for the same key.

| key | label (both) | control |
|---|---|---|
| `firstName` | First Name | text |
| `lastName` | Last Name | text |
| `email` | Email Address | email |
| `phone` | Phone | tel |
| `location` | Location | text |
| `addressStreet` | Street Address | text |
| `addressCity` | City | text |
| `addressState` | Province / State | text |
| `postalCode` | Postal Code | text |
| `country` | Country | text |
| `linkedin` | LinkedIn | url — **always rendered, even when empty** |
| `github` | GitHub | url — **always rendered, even when empty** |
| `portfolio` | Portfolio | url — **always rendered, even when empty** |
| `currentTitle` | Current / Target Job Title | text |
| `dateOfBirth` | Date of Birth | date |
| `workAuthorization` | Work Authorization | text |
| `requiresSponsorship` | Requires Sponsorship | text |
| `salaryExpectation` | Salary Expectation | text |
| `willingToRelocate` | Willing to Relocate | select |
| `workPreference` | Work Preference | select |
| `noticePeriod` | Notice Period | text |
| `earliestStartDate` | Earliest Start Date | date |
| `yearsOfExperience` | Years of Experience | text |
| `securityClearance` | Security Clearance | select |
| `driversLicense` | Driver's Licence | select |
| `languages` | Languages | text |
| `eeo.gender` | Gender | select |
| `eeo.race` | Race / Ethnicity | select |
| `eeo.hispanicLatino` | Hispanic or Latino | select |
| `eeo.veteranStatus` | Veteran Status | select |
| `eeo.disabilityStatus` | Disability Status | select |
| `eeo.genderIdentity` | Gender Identity | select |
| `eeo.pronouns` | Pronouns | select |
| `eeo.sexualOrientation` | Sexual Orientation | select |

Placeholders: `languages` → `English (Native), French (Professional)`;
`noticePeriod` → `2 weeks`; `yearsOfExperience` → `5`.

## D. Exact option vocabularies — byte-identical on both surfaces

Blank (`""`) is always the first option, rendered as `Select…`, and means "not answered".

```
willingToRelocate:  Yes | No
workPreference:     Remote | Hybrid | On-site | No preference
securityClearance:  None | Active clearance | Eligible / previously held
driversLicense:     Yes | No
genderIdentity:     Cisgender | Transgender | Non-binary | Prefer not to say
pronouns:           He/Him | She/Her | They/Them | Prefer not to say
sexualOrientation:  Heterosexual | Gay or Lesbian | Bisexual | Prefer not to say
```

The existing five EEO lists are unchanged and stay byte-identical between
`frontend/src/lib/profileExtras.ts` (`EEO_OPTIONS`) and
`chrome-extension/src/content/overlay.ts` (`EEO_CHOICES`). Both files must carry a comment
naming the other as its twin, and each side gets a test that pins the exact arrays so a
future edit to one fails the other's suite.

## E. Section placement

- **Web** `Profile.tsx`: personal fields (incl. `github`) in Personal; `dateOfBirth` and
  all eight screening answers in the existing **Application Answers** section;
  the three new demographics in **Equal Employment**.
- **Extension** `overlay.ts`: `currentTitle` + `dateOfBirth` in **Personal**; the eight
  screening answers in **Preference**; the three new demographics in **Equal Employment**.
  All of them join `EditableProfileDraft` and `saveInfoEdits`'s diff so they actually sync.

## F. Extension: stop shadowing synced fields device-locally

`github` and the work-experience array currently live in `chrome.storage.local`
(`ap_autofill_extras`) and permanently shadow the server value. `github` moves to the
synced profile. Work-experience edits stay device-local for now (the profile API has no
write path for resume-derived sections) — but the extension must SAY so in the UI instead
of looking like it syncs.

## G. Fewer AI calls: categories that now resolve from the profile

New `FieldCategory` values (`chrome-extension/src/shared/types.ts`), detected in
`fieldMatcher.ts`, mapped in `profileCategories.ts`, and resolved by `resolveProfileValue`
so pass 1 fills them with no LLM call:

`willingToRelocate`, `workPreference`, `noticePeriod`, `startDate`, `yearsOfExperience`,
`securityClearance`, `driversLicense`, `languages`, `eeoPronouns` — plus the already
declared but unmapped `eeoGenderIdentity` and `eeoSexualOrientation`.

Backend equivalent: `ApplicantProfile` in `backend/routers/fill.py` gains the same eight
screening fields, `_profile_context()` emits them (so the prompt sees them), and
`_raw_rule_based_answer` answers the obvious ones directly.
