# ATS Coverage Tracker

Track which ATS systems have been tested and confirmed working with the Tailrd extension.

**Progress:** 2 / 15 covered

---

## Easy

- [ ] **Greenhouse** *(Greenhouse Software)*
  Standard HTML inputs with predictable field names. Well-labeled fields, rarely dynamic. A good baseline to test against. Widely used by mid-size tech companies.

- [ ] **Lever** *(Lever Inc.)*
  Simple React-based forms with consistent field structure. Standard input/textarea elements, minimal shadow DOM. Cover letter is usually a plain textarea. Common in startups.

- [ ] **BambooHR** *(BambooHR LLC)*
  Simple, clean forms with standard HTML. Short application forms, minimal AI fill needed. Used mostly by small-to-mid size companies. Easy win.

- [ ] **Breezy HR** *(Breezy HR Inc.)*
  Clean HTML forms with good labeling. Short application forms are the norm. One of the easiest ATSs to support reliably. Popular with small businesses.

---

## Medium

- [ ] **Ashby** *(Ashby HQ)*
  Modern React SPA that rebuilds the DOM constantly as the user progresses through form steps. MutationObserver and reconciler are especially important here. Custom dropdowns are common. Growing fast among tech companies.

- [ ] **Workable** *(Workable Technology)*
  Standard form structure but uses custom dropdowns for things like country/location. Multi-step forms are common. Watch for dynamic field injection. Widely used by SMBs and European companies.

- [ ] **SmartRecruiters** *(SmartRecruiters Inc.)*
  Multi-step React-based forms. Custom question sections are very common, making the AI fill phase important. Used by large global companies like Visa and Bosch.

- [ ] **Jobvite** *(Jobvite Inc.)*
  React-based frontend with some non-standard field patterns, especially for EEO questions. Multi-step forms are the norm. Watch for custom radio group implementations.

- [ ] **Rippling** *(Rippling Inc.)*
  Modern React SPA with dynamic form rendering. Field labels are generally clean and consistent. Growing fast — many startups and mid-size tech companies now use it.

- [ ] **Bullhorn** *(Bullhorn Inc.)*
  Primarily used by staffing and recruiting agencies. Forms tend to be simpler but candidates are applying to agencies, not specific roles. Field structure is fairly standard.

---

## Hard

- [x] **Workday** *(Workday Inc.)*
  Most widely used enterprise ATS. Renders fields as custom web components inside shadow DOM — standard querySelector won't reach them. Aggressively re-renders on SPA navigation. The reconciler was specifically built for this. Very common in Fortune 500 companies.

- [x] **iCIMS** *(iCIMS Inc.)*
  Heavy use of nested iframes — each section of the form often lives in its own iframe. FRAME_TOKEN and iframe coordination logic is critical here. Commonly used by large enterprises and retailers.

- [ ] **Taleo** *(Oracle)*
  Legacy Oracle product built on old Java-based web tech. Expect unusual form structures, non-standard inputs, and iframe-heavy layouts. Very common in government, healthcare, and large enterprises. Notoriously painful to autofill.

- [ ] **ADP Recruiting Management** *(ADP Inc.)*
  Legacy tech, iframes, and inconsistent field naming. ADP's frontend varies between clients. Common in large US corporations, especially in finance and manufacturing.

- [ ] **SAP SuccessFactors** *(SAP SE)*
  Complex multi-step forms built on SAP's own UI framework — not standard HTML. Heavy shadow DOM usage and custom components throughout. One of the hardest ATSs to reliably autofill. Common in European multinationals.

---

*Check off each system by replacing `[ ]` with `[x]` once tested and confirmed working.*
