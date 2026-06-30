/**
 * Reproduces iCIMS application field markup as the owning-frame content-script
 * instance sees it (mounted in-document; the #icims_content_iframe wrapper is a
 * cross-realm coordination concern verified via crossFrame unit tests + a live
 * spot-check — see docs/superpowers/specs/2026-06-30-icims-autofill-hardening-design.md
 * §1.1). Reconstructed from known iCIMS patterns as of 2026-06-30, not copied markup.
 */

function labelled(doc: Document, control: HTMLElement, opts: { id: string; label: string }): HTMLElement {
  const wrap = doc.createElement("div");
  const label = doc.createElement("label");
  label.setAttribute("for", opts.id);
  label.textContent = opts.label;
  control.id = opts.id;
  wrap.append(label, control);
  return wrap;
}

function textInput(doc: Document, opts: { id: string; name: string; label: string; type?: string }): HTMLElement {
  const input = doc.createElement("input");
  input.type = opts.type ?? "text";
  input.setAttribute("name", opts.name);
  return labelled(doc, input, opts);
}

function selectInput(doc: Document, opts: { id: string; name: string; label: string; options: string[] }): HTMLElement {
  const sel = doc.createElement("select");
  sel.setAttribute("name", opts.name);
  const placeholder = doc.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Select…";
  sel.append(placeholder);
  for (const o of opts.options) {
    const opt = doc.createElement("option");
    opt.value = o;
    opt.textContent = o;
    sel.append(opt);
  }
  return labelled(doc, sel, opts);
}

export function mountIcimsForm(doc: Document): void {
  doc.body.innerHTML = "";
  const form = doc.createElement("form");
  form.id = "icims_apply_form";
  form.append(textInput(doc, { id: "icims-firstname", name: "fields[firstname]", label: "First Name" }));
  form.append(textInput(doc, { id: "icims-lastname", name: "fields[lastname]", label: "Last Name" }));
  form.append(textInput(doc, { id: "icims-email", name: "fields[email]", label: "Email", type: "email" }));
  form.append(textInput(doc, { id: "icims-phone", name: "fields[phone]", label: "Phone", type: "tel" }));
  form.append(textInput(doc, { id: "icims-city", name: "fields[city]", label: "City" }));
  form.append(
    selectInput(doc, { id: "icims-country", name: "fields[country]", label: "Country", options: ["United States", "Canada", "Mexico"] })
  );
  const resume = doc.createElement("input");
  resume.type = "file";
  resume.setAttribute("name", "fields[resume]");
  form.append(labelled(doc, resume, { id: "icims-resume", label: "Resume" }));
  form.append(selectInput(doc, { id: "icims-gender", name: "fields[gender]", label: "Gender", options: ["Male", "Female", "Decline to self-identify"] }));
  form.append(selectInput(doc, { id: "icims-ethnicity", name: "fields[ethnicity]", label: "Race/Ethnicity", options: ["Asian", "White", "Decline to self-identify"] }));
  form.append(selectInput(doc, { id: "icims-veteran", name: "fields[veteran]", label: "Veteran Status", options: ["I am not a veteran", "I am a veteran"] }));
  doc.body.appendChild(form);
}
