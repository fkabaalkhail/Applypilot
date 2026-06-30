/**
 * Reproduces ADP's inconsistent-naming, div-layout field markup as the
 * owning-frame content-script instance sees it: non-semantic `name`s, labels drawn
 * from a mix of sibling <label>, <span> caption, placeholder, and aria-label. The
 * iframe wrapper is a cross-realm coordination concern verified via crossFrame unit
 * tests + a live spot-check (see
 * docs/superpowers/specs/2026-06-30-icims-autofill-hardening-design.md §1.1).
 * Reconstructed from known ADP patterns as of 2026-06-30, not copied markup.
 */

function div(doc: Document, ...children: Node[]): HTMLElement {
  const d = doc.createElement("div");
  d.append(...children);
  return d;
}

function capDiv(doc: Document, text: string): HTMLElement {
  const d = doc.createElement("div");
  d.textContent = text;
  return d;
}

function labelEl(doc: Document, text: string): HTMLElement {
  const l = doc.createElement("label");
  l.textContent = text;
  return l;
}

function spanEl(doc: Document, text: string): HTMLElement {
  const s = doc.createElement("span");
  s.textContent = text;
  return s;
}

function input(
  doc: Document,
  id: string,
  name: string,
  attrs: { type?: string; placeholder?: string; ariaLabel?: string } = {}
): HTMLInputElement {
  const el = doc.createElement("input");
  el.type = attrs.type ?? "text";
  el.id = id;
  el.setAttribute("name", name);
  if (attrs.placeholder) el.setAttribute("placeholder", attrs.placeholder);
  if (attrs.ariaLabel) el.setAttribute("aria-label", attrs.ariaLabel);
  return el;
}

function select(doc: Document, id: string, name: string, options: string[]): HTMLSelectElement {
  const sel = doc.createElement("select");
  sel.id = id;
  sel.setAttribute("name", name);
  const placeholder = doc.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Select…";
  sel.append(placeholder);
  for (const o of options) {
    const opt = doc.createElement("option");
    opt.value = o;
    opt.textContent = o;
    sel.append(opt);
  }
  return sel;
}

export function mountAdpForm(doc: Document): void {
  doc.body.innerHTML = "";
  const form = doc.createElement("form");
  form.id = "adp-apply";

  // sibling <label> (no for=) → nearbyText
  form.append(div(doc, labelEl(doc, "First Name"), input(doc, "adp-firstname", "DFEAAB01")));
  // <span> caption → nearbyText
  form.append(div(doc, spanEl(doc, "Last Name"), input(doc, "adp-lastname", "DFEAAB02")));
  // placeholder only
  form.append(div(doc, input(doc, "adp-email", "DFEAAB03", { placeholder: "Email Address" })));
  // aria-label only
  form.append(div(doc, input(doc, "adp-phone", "DFEAAB04", { ariaLabel: "Phone Number" })));
  // caption div above a nested input → nearbyText climbs
  form.append(div(doc, capDiv(doc, "Home City"), div(doc, input(doc, "adp-city", "DFEAAB05"))));
  // Country select with sibling label
  form.append(div(doc, labelEl(doc, "Country"), select(doc, "adp-country", "DFEAAB06", ["United States", "Canada", "Mexico"])));
  // Resume file with sibling label
  form.append(div(doc, labelEl(doc, "Resume"), input(doc, "adp-resume", "DFEAAB07", { type: "file" })));
  // EEO selects with sibling labels
  form.append(div(doc, labelEl(doc, "Gender"), select(doc, "adp-gender", "DFEAAB08", ["Male", "Female", "Decline to self-identify"])));
  form.append(div(doc, labelEl(doc, "Race/Ethnicity"), select(doc, "adp-ethnicity", "DFEAAB09", ["Asian", "White", "Decline to self-identify"])));
  form.append(div(doc, labelEl(doc, "Veteran Status"), select(doc, "adp-veteran", "DFEAAB10", ["I am not a veteran", "I am a veteran"])));

  doc.body.appendChild(form);
}
