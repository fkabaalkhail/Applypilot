/**
 * Faithful Easy-tier ATS field markup (Greenhouse, Lever, BambooHR, Breezy HR):
 * standard, well-labelled HTML — label/for inputs, native selects, plain
 * textareas, native radio groups. Mounted in-document. Reconstructed from known
 * patterns as of 2026-06-30, not copied markup.
 */

function mount(doc: Document, nodes: HTMLElement[]): void {
  doc.body.innerHTML = "";
  const form = doc.createElement("form");
  form.append(...nodes);
  doc.body.appendChild(form);
}

function labeledInput(doc: Document, opts: { id: string; label: string; type?: string }): HTMLElement {
  const wrap = doc.createElement("div");
  const label = doc.createElement("label");
  label.setAttribute("for", opts.id);
  label.textContent = opts.label;
  const input = doc.createElement("input");
  input.type = opts.type ?? "text";
  input.id = opts.id;
  wrap.append(label, input);
  return wrap;
}

function labeledTextarea(doc: Document, opts: { id: string; label: string }): HTMLElement {
  const wrap = doc.createElement("div");
  const label = doc.createElement("label");
  label.setAttribute("for", opts.id);
  label.textContent = opts.label;
  const ta = doc.createElement("textarea");
  ta.id = opts.id;
  wrap.append(label, ta);
  return wrap;
}

function nativeSelect(doc: Document, opts: { id: string; label: string; options: string[] }): HTMLElement {
  const wrap = doc.createElement("div");
  const label = doc.createElement("label");
  label.setAttribute("for", opts.id);
  label.textContent = opts.label;
  const sel = doc.createElement("select");
  sel.id = opts.id;
  const ph = doc.createElement("option");
  ph.value = "";
  ph.textContent = "Select…";
  sel.append(ph);
  for (const o of opts.options) {
    const opt = doc.createElement("option");
    opt.value = o;
    opt.textContent = o;
    sel.append(opt);
  }
  wrap.append(label, sel);
  return wrap;
}

function fileField(doc: Document, opts: { id: string; label: string }): HTMLElement {
  const wrap = doc.createElement("div");
  const label = doc.createElement("label");
  label.setAttribute("for", opts.id);
  label.textContent = opts.label;
  const input = doc.createElement("input");
  input.type = "file";
  input.id = opts.id;
  wrap.append(label, input);
  return wrap;
}

function nativeRadioGroup(doc: Document, opts: { name: string; legend: string; options: string[] }): HTMLElement {
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
  return fs;
}

const COUNTRIES = ["United States", "Canada", "Mexico"];
const GENDERS = ["Male", "Female", "Decline to self-identify"];

export function mountGreenhouseForm(doc: Document): void {
  mount(doc, [
    labeledInput(doc, { id: "gh-firstname", label: "First Name" }),
    labeledInput(doc, { id: "gh-lastname", label: "Last Name" }),
    labeledInput(doc, { id: "gh-email", label: "Email", type: "email" }),
    labeledInput(doc, { id: "gh-phone", label: "Phone", type: "tel" }),
    nativeSelect(doc, { id: "gh-country", label: "Country", options: COUNTRIES }),
    labeledInput(doc, { id: "gh-linkedin", label: "LinkedIn Profile", type: "url" }),
    fileField(doc, { id: "gh-resume", label: "Resume/CV" }),
    labeledTextarea(doc, { id: "gh-cover", label: "Cover Letter" }),
    nativeRadioGroup(doc, { name: "gh-sponsor", legend: "Will you now or in the future require sponsorship?", options: ["Yes", "No"] }),
    nativeSelect(doc, { id: "gh-gender", label: "Gender", options: GENDERS }),
  ]);
}

export function mountLeverForm(doc: Document): void {
  mount(doc, [
    labeledInput(doc, { id: "lever-firstname", label: "First Name" }),
    labeledInput(doc, { id: "lever-lastname", label: "Last Name" }),
    labeledInput(doc, { id: "lever-email", label: "Email", type: "email" }),
    labeledInput(doc, { id: "lever-phone", label: "Phone", type: "tel" }),
    nativeSelect(doc, { id: "lever-country", label: "Country", options: COUNTRIES }),
    labeledTextarea(doc, { id: "lever-cover", label: "Cover Letter" }),
  ]);
}

export function mountBambooHrForm(doc: Document): void {
  mount(doc, [
    labeledInput(doc, { id: "bamboo-firstname", label: "First Name" }),
    labeledInput(doc, { id: "bamboo-lastname", label: "Last Name" }),
    labeledInput(doc, { id: "bamboo-email", label: "Email", type: "email" }),
    labeledInput(doc, { id: "bamboo-phone", label: "Phone", type: "tel" }),
  ]);
}

export function mountBreezyForm(doc: Document): void {
  mount(doc, [
    labeledInput(doc, { id: "breezy-firstname", label: "First Name" }),
    labeledInput(doc, { id: "breezy-lastname", label: "Last Name" }),
    labeledInput(doc, { id: "breezy-email", label: "Email", type: "email" }),
    labeledInput(doc, { id: "breezy-phone", label: "Phone", type: "tel" }),
    nativeSelect(doc, { id: "breezy-country", label: "Country", options: COUNTRIES }),
  ]);
}
