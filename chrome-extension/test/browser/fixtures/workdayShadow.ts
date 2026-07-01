/**
 * Browser-only fixture: a Workday-style "My Information" step whose fields live
 * INSIDE an open shadow root, and whose dropdowns portal their listbox into that
 * SAME shadow root (not document.body).
 *
 * This is the case jsdom can approximate but a real browser actually proves:
 *  - the scanner's candidate sweep must pierce the shadow boundary (deepQueryAll)
 *    to even see the controls;
 *  - the combobox engine's listbox lookup must fall back from document.getElementById
 *    (which does NOT cross shadow roots) to a shadow-piercing search to find the
 *    portaled listbox and click the option.
 *
 * Reconstructed from known Workday DOM patterns, not copied markup.
 */

export interface WorkdayShadowFixture {
  /** The custom-element host whose shadowRoot holds the whole form. */
  host: HTMLElement;
}

function textField(
  sr: ShadowRoot,
  doc: Document,
  opts: { automationId: string; label: string; id: string; type?: string }
): void {
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
  sr.append(wrap);
}

/** Workday button[aria-haspopup=listbox] that portals its listbox INTO the shadow
 *  root and commits the chosen label back into the button on option click. */
function buttonListbox(
  sr: ShadowRoot,
  doc: Document,
  opts: { automationId: string; label: string; id: string; options: string[] }
): void {
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
    // Portal into the SAME shadow root, not document.body — the boundary the
    // combobox engine must cross to find this listbox.
    sr.append(lb);
  });
  wrap.append(label, btn);
  sr.append(wrap);
}

function radioGroup(
  sr: ShadowRoot,
  doc: Document,
  opts: { name: string; legend: string; options: string[] }
): void {
  const fs = doc.createElement("fieldset");
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
  sr.append(fs);
}

export function mountWorkdayShadow(doc: Document): WorkdayShadowFixture {
  doc.body.innerHTML = "";
  const hostEl = doc.createElement("wd-application");
  const sr = hostEl.attachShadow({ mode: "open" });

  textField(sr, doc, { automationId: "legalNameSection_firstName", label: "First Name", id: "wds-first" });
  textField(sr, doc, { automationId: "legalNameSection_lastName", label: "Last Name", id: "wds-last" });
  textField(sr, doc, { automationId: "email", label: "Email", id: "wds-email", type: "email" });
  textField(sr, doc, { automationId: "phoneNumber", label: "Phone Number", id: "wds-phone", type: "tel" });
  textField(sr, doc, { automationId: "addressSection_city", label: "City", id: "wds-city" });
  textField(sr, doc, { automationId: "linkedinQuestion", label: "LinkedIn Profile", id: "wds-linkedin", type: "url" });
  buttonListbox(sr, doc, {
    automationId: "countryDropdown",
    label: "Country",
    id: "wds-country",
    options: ["United States", "Canada", "Mexico", "United Kingdom"],
  });
  buttonListbox(sr, doc, {
    automationId: "workAuthorization",
    label: "Are you legally authorized to work in this country?",
    id: "wds-workauth",
    options: ["Yes", "No"],
  });
  radioGroup(sr, doc, {
    name: "wds-sponsorship",
    legend: "Will you now or in the future require sponsorship for employment visa status?",
    options: ["Yes", "No"],
  });

  doc.body.append(hostEl);
  return { host: hostEl };
}
