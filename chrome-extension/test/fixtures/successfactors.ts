/**
 * Reproduces SAP SuccessFactors / UI5 field markup: each field is a custom-element
 * host with an OPEN shadow root wrapping the real control, whose accessible name is
 * an aria-label (UI5's pattern). Open shadow roots are the same JS realm as the top
 * document, so the scanner reaches and classifies them. Reconstructed from known
 * UI5 patterns as of 2026-06-30, not copied markup.
 */

function host(doc: Document, tag: string, id: string, control: HTMLElement): HTMLElement {
  const h = doc.createElement(tag);
  h.id = id;
  const sr = h.attachShadow({ mode: "open" });
  sr.appendChild(control);
  return h;
}

function textControl(doc: Document, ariaLabel: string, type = "text"): HTMLInputElement {
  const i = doc.createElement("input");
  i.type = type;
  i.setAttribute("aria-label", ariaLabel);
  return i;
}

function selectControl(doc: Document, ariaLabel: string, options: string[]): HTMLSelectElement {
  const s = doc.createElement("select");
  s.setAttribute("aria-label", ariaLabel);
  const placeholder = doc.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Select…";
  s.append(placeholder);
  for (const o of options) {
    const opt = doc.createElement("option");
    opt.value = o;
    opt.textContent = o;
    s.append(opt);
  }
  return s;
}

export function mountSuccessFactorsForm(doc: Document): void {
  doc.body.innerHTML = "";
  const form = doc.createElement("form");
  form.id = "sf-apply";

  form.append(host(doc, "ui5-input", "sf-firstname-host", textControl(doc, "First Name")));
  form.append(host(doc, "ui5-input", "sf-lastname-host", textControl(doc, "Last Name")));
  form.append(host(doc, "ui5-input", "sf-email-host", textControl(doc, "Email", "email")));
  form.append(host(doc, "ui5-input", "sf-phone-host", textControl(doc, "Phone", "tel")));
  form.append(host(doc, "ui5-input", "sf-city-host", textControl(doc, "City")));
  form.append(host(doc, "ui5-select", "sf-country-host", selectControl(doc, "Country", ["United States", "Canada", "Mexico"])));
  form.append(host(doc, "ui5-fileuploader", "sf-resume-host", textControl(doc, "Resume/CV", "file")));
  form.append(host(doc, "ui5-select", "sf-gender-host", selectControl(doc, "Gender", ["Male", "Female", "Decline to self-identify"])));
  form.append(host(doc, "ui5-select", "sf-ethnicity-host", selectControl(doc, "Race/Ethnicity", ["Asian", "White", "Decline to self-identify"])));
  form.append(host(doc, "ui5-select", "sf-veteran-host", selectControl(doc, "Veteran Status", ["I am not a veteran", "I am a veteran"])));

  doc.body.appendChild(form);
}
