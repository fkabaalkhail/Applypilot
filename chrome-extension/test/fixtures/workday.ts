/**
 * Faithful reproduction of a Workday "My Information" application step, built as
 * INTERACTIVE DOM (dropdowns mount their listbox on click and commit on option
 * click) so the real combobox engine can drive it under jsdom.
 *
 * Structure mirrors the Workday candidate experience as of 2026-06-30 —
 * reconstructed from known Workday DOM patterns (data-automation-id anchors,
 * label/aria-labelledby associations, button[aria-haspopup=listbox] dropdowns with
 * a portaled role=listbox of role=option items). NOT copied markup.
 */

export interface WorkdayFixture {
  root: HTMLElement;
}

/** A labelled text input wrapped the way Workday wraps fields. */
function textField(
  doc: Document,
  opts: { automationId: string; label: string; id: string; type?: string }
): HTMLElement {
  const wrap = doc.createElement("div");
  wrap.setAttribute("data-automation-id", `formField-${opts.automationId}`);
  const label = doc.createElement("label");
  label.id = `${opts.id}-label`;
  label.setAttribute("for", opts.id);
  label.textContent = opts.label;
  const input = doc.createElement("input");
  input.type = opts.type ?? "text";
  input.id = opts.id;
  input.setAttribute("data-automation-id", opts.automationId);
  input.setAttribute("aria-labelledby", `${opts.id}-label`);
  wrap.append(label, input);
  return wrap;
}

/** A Workday button[aria-haspopup=listbox] dropdown: mounts a portaled listbox on
 *  click and writes the chosen label back into the button (Workday's pattern). */
function buttonListbox(
  doc: Document,
  opts: { automationId: string; label: string; id: string; options: string[] }
): HTMLElement {
  const wrap = doc.createElement("div");
  wrap.setAttribute("data-automation-id", `formField-${opts.automationId}`);
  const label = doc.createElement("label");
  label.id = `${opts.id}-label`;
  label.textContent = opts.label;
  const btn = doc.createElement("button");
  btn.id = opts.id;
  btn.type = "button";
  btn.setAttribute("aria-haspopup", "listbox");
  btn.setAttribute("aria-expanded", "false");
  btn.setAttribute("aria-labelledby", `${opts.id}-label`);
  btn.setAttribute("data-automation-id", opts.automationId);
  btn.textContent = "Select One";
  const lbId = `${opts.id}-listbox`;
  btn.setAttribute("aria-controls", lbId);
  btn.addEventListener("click", () => {
    if (btn.getAttribute("aria-expanded") === "true") return;
    btn.setAttribute("aria-expanded", "true");
    const lb = doc.createElement("div");
    lb.id = lbId;
    lb.setAttribute("role", "listbox");
    for (const optLabel of opts.options) {
      const o = doc.createElement("div");
      o.setAttribute("role", "option");
      o.setAttribute("data-automation-id", "promptOption");
      o.textContent = optLabel;
      o.addEventListener("click", () => {
        btn.textContent = optLabel;
        btn.setAttribute("aria-expanded", "false");
        lb.remove();
      });
      lb.append(o);
    }
    doc.body.append(lb); // Workday portals the menu to the body
  });
  wrap.append(label, btn);
  return wrap;
}

/** A Yes/No radio group (fieldset + legend), as Workday renders screening Qs. */
function radioGroup(
  doc: Document,
  opts: { name: string; legend: string; options: string[]; automationId: string }
): HTMLElement {
  const fs = doc.createElement("fieldset");
  fs.setAttribute("data-automation-id", opts.automationId);
  const legend = doc.createElement("legend");
  legend.textContent = opts.legend;
  fs.append(legend);
  for (const opt of opts.options) {
    const id = `${opts.name}-${opt}`.toLowerCase().replace(/\s+/g, "-");
    const label = doc.createElement("label");
    label.setAttribute("for", id);
    const radio = doc.createElement("input");
    radio.type = "radio";
    radio.id = id;
    radio.name = opts.name;
    radio.value = opt;
    label.append(radio, doc.createTextNode(opt));
    fs.append(label);
  }
  return fs;
}

/** A native <select> with a placeholder, as Workday uses for voluntary disclosures. */
function selectField(
  doc: Document,
  opts: { id: string; label: string; options: string[]; automationId: string }
): HTMLElement {
  const wrap = doc.createElement("div");
  const label = doc.createElement("label");
  label.id = `${opts.id}-label`;
  label.setAttribute("for", opts.id);
  label.textContent = opts.label;
  const sel = doc.createElement("select");
  sel.id = opts.id;
  sel.setAttribute("data-automation-id", opts.automationId);
  sel.setAttribute("aria-labelledby", `${opts.id}-label`);
  const placeholder = doc.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Select One";
  sel.append(placeholder);
  for (const opt of opts.options) {
    const o = doc.createElement("option");
    o.value = opt;
    o.textContent = opt;
    sel.append(o);
  }
  wrap.append(label, sel);
  return wrap;
}

export function mountWorkdayMyInfo(doc: Document): WorkdayFixture {
  doc.body.innerHTML = "";
  const form = doc.createElement("div");
  form.setAttribute("data-automation-id", "applyFlowPage");

  // Legal name
  form.append(textField(doc, { automationId: "legalNameSection_firstName", label: "First Name", id: "wd-first" }));
  form.append(textField(doc, { automationId: "legalNameSection_lastName", label: "Last Name", id: "wd-last" }));
  // Contact
  form.append(textField(doc, { automationId: "email", label: "Email", id: "wd-email", type: "email" }));
  form.append(textField(doc, { automationId: "phoneNumber", label: "Phone Number", id: "wd-phone", type: "tel" }));
  // Address (Country dropdown + City text — structured address is out of scope)
  form.append(
    buttonListbox(doc, {
      automationId: "countryDropdown",
      label: "Country",
      id: "wd-country",
      options: ["United States", "Canada", "Mexico", "United Kingdom"],
    })
  );
  form.append(textField(doc, { automationId: "addressSection_city", label: "City", id: "wd-city" }));
  // Source (no profile mapping — should stay `unknown`)
  form.append(
    buttonListbox(doc, {
      automationId: "source",
      label: "How Did You Hear About Us?",
      id: "wd-source",
      options: ["LinkedIn", "Referral", "Company Website"],
    })
  );
  // Links
  form.append(textField(doc, { automationId: "linkedinQuestion", label: "LinkedIn Profile", id: "wd-linkedin", type: "url" }));
  // Screening
  form.append(
    buttonListbox(doc, {
      automationId: "workAuthorization",
      label: "Are you legally authorized to work in this country?",
      id: "wd-workauth",
      options: ["Yes", "No"],
    })
  );
  form.append(
    radioGroup(doc, {
      name: "sponsorship",
      legend: "Will you now or in the future require sponsorship for employment visa status?",
      options: ["Yes", "No"],
      automationId: "sponsorshipQuestion",
    })
  );
  // Resume (labelled file input — detected, never scripted)
  const resumeWrap = doc.createElement("div");
  resumeWrap.setAttribute("data-automation-id", "resumeSection");
  const resumeLabel = doc.createElement("label");
  resumeLabel.id = "wd-resume-label";
  resumeLabel.setAttribute("for", "wd-resume");
  resumeLabel.textContent = "Resume/CV";
  const resume = doc.createElement("input");
  resume.type = "file";
  resume.id = "wd-resume";
  resume.setAttribute("data-automation-id", "file-upload-input-ref");
  resume.setAttribute("aria-labelledby", "wd-resume-label");
  resumeWrap.append(resumeLabel, resume);
  form.append(resumeWrap);
  // Voluntary disclosures (EEO)
  form.append(selectField(doc, { id: "wd-gender", label: "Gender", options: ["Male", "Female", "Decline to self-identify"], automationId: "gender" }));
  form.append(selectField(doc, { id: "wd-ethnicity", label: "Race/Ethnicity", options: ["Asian", "White", "Decline to self-identify"], automationId: "ethnicity" }));
  form.append(selectField(doc, { id: "wd-veteran", label: "Veteran Status", options: ["I am not a veteran", "I am a veteran"], automationId: "veteranStatus" }));

  doc.body.append(form);
  return { root: form };
}
