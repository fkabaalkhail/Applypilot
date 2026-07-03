# ATS Coverage Tracker

Track which ATS systems have been tested and confirmed working with the Tailrd extension.

**Progress:** 15 / 15 tracked · 29 site adapters registered

Every tracked ATS now has a dedicated `SiteAdapter` (host recognition + attribute
classification over the generic pipeline), plus 14 more platforms Jobright ships,
for parity. Greenhouse and Workday keep hand-tuned modules
(`adapters/greenhouse.ts`, `adapters/workday.ts`); the rest are declared in the
data-driven table `adapters/common.ts`. Adapters are advisory: an unmatched host
or a declined hook falls back to byte-identical generic behavior.

- `[x]` = generic pipeline tested + confirmed working.
- **adapter** column = a registered `SiteAdapter` refines detection/classification.

---

## Easy

- [x] **Greenhouse** *(Greenhouse Software)*
  Standard HTML inputs with predictable field names. Well-labeled fields, rarely dynamic. A good baseline to test against. Widely used by mid-size tech companies.

- [x] **Lever** *(Lever Inc.)*
  Simple React-based forms with consistent field structure. Standard input/textarea elements, minimal shadow DOM. Cover letter is usually a plain textarea. Common in startups.

- [x] **BambooHR** *(BambooHR LLC)*
  Simple, clean forms with standard HTML. Short application forms, minimal AI fill needed. Used mostly by small-to-mid size companies. Easy win.

- [x] **Breezy HR** *(Breezy HR Inc.)*
  Clean HTML forms with good labeling. Short application forms are the norm. One of the easiest ATSs to support reliably. Popular with small businesses.

---

## Medium

- [x] **Ashby** *(Ashby HQ)*
  Modern React SPA that rebuilds the DOM constantly as the user progresses through form steps. MutationObserver and reconciler are especially important here. Custom dropdowns are common. Growing fast among tech companies.

- [x] **Workable** *(Workable Technology)*
  Standard form structure but uses custom dropdowns for things like country/location. Multi-step forms are common. Watch for dynamic field injection. Widely used by SMBs and European companies.

- [x] **SmartRecruiters** *(SmartRecruiters Inc.)*
  Multi-step React-based forms. Custom question sections are very common, making the AI fill phase important. Used by large global companies like Visa and Bosch.

- [x] **Jobvite** *(Jobvite Inc.)*
  React-based frontend with some non-standard field patterns, especially for EEO questions. Multi-step forms are the norm. Watch for custom radio group implementations.

- [x] **Rippling** *(Rippling Inc.)*
  Modern React SPA with dynamic form rendering. Field labels are generally clean and consistent. Growing fast — many startups and mid-size tech companies now use it.

- [x] **Bullhorn** *(Bullhorn Inc.)*
  Primarily used by staffing and recruiting agencies. Forms tend to be simpler but candidates are applying to agencies, not specific roles. Field structure is fairly standard.

---

## Hard

- [x] **Workday** *(Workday Inc.)*
  Most widely used enterprise ATS. Renders fields as custom web components inside shadow DOM — standard querySelector won't reach them. Aggressively re-renders on SPA navigation. The reconciler was specifically built for this. Very common in Fortune 500 companies.

- [x] **iCIMS** *(iCIMS Inc.)*
  Heavy use of nested iframes — each section of the form often lives in its own iframe. FRAME_TOKEN and iframe coordination logic is critical here. Commonly used by large enterprises and retailers.

- [x] **Taleo** *(Oracle)*
  Legacy Oracle product built on old Java-based web tech. Expect unusual form structures, non-standard inputs, and iframe-heavy layouts. Very common in government, healthcare, and large enterprises. Notoriously painful to autofill.

- [x] **ADP Recruiting Management** *(ADP Inc.)*
  Legacy tech, iframes, and inconsistent field naming. ADP's frontend varies between clients. Common in large US corporations, especially in finance and manufacturing.

- [x] **SAP SuccessFactors** *(SAP SE)*
  Complex multi-step forms built on SAP's own UI framework — not standard HTML. Heavy shadow DOM usage and custom components throughout. One of the hardest ATSs to reliably autofill. Common in European multinationals.

---

*Check off each system by replacing `[ ]` with `[x]` once tested and confirmed working.*

---

## Extended coverage (Jobright-parity adapters)

Registered via `adapters/common.ts` — recognized ATS beyond the 15 tracked above.
Detection + social-URL / name-attribute classification are wired; deeper per-site
fill operations can be layered onto any of them through the same adapter seams.

- [x] **Oracle Cloud Recruiting** — `*.oraclecloud.com`
- [x] **Dayforce (Ceridian)** — `*.dayforcehcm.com`, `*.dayforce.com`
- [x] **UKG / UltiPro** — `*.ultipro.com`, `*.ukg.com`
- [x] **JazzHR** — `*.applytojob.com`, `*.jazz.co` (namespaced `job_application[...]` fields)
- [x] **Paylocity** — `*.paylocity.com`
- [x] **Avature** — `*.avature.net`
- [x] **Phenom People** — `*.phenompeople.com`
- [x] **Teamtailor** — `*.teamtailor.com` (namespaced `candidate[...]` fields)
- [x] **Recruitee** — `*.recruitee.com`
- [x] **Personio** — `*.personio.{de,com,es,nl,fr}`
- [x] **Eightfold** — `*.eightfold.ai`
- [x] **ClearCompany** — `*.clearcompany.com`
- [x] **Paycom** — `*.paycomonline.net`
- [x] **BrassRing / Kenexa** — `*.brassring.com`, `*.kenexa.com`

**Adapter surface (per `adapters/types.ts`):** `match` (host), `classify` (correct a
field's category), `resolveAnswer` (site-specific value), `fillOperation` (own a
tricky widget), `advanceButton` (exact multi-step Next selector). Adding a new ATS
is a one-line entry in `COMMON_ATS`; deepening one is a hook on its object.
