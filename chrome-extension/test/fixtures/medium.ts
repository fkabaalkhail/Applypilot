/**
 * Faithful Medium-tier ATS field markup, mounted in-document (owning-frame view).
 * Shared builders cover the common Medium patterns: standard labelled inputs,
 * native selects, interactive react-select dropdowns, and interactive ARIA radio
 * groups. Reconstructed from known patterns as of 2026-06-30, not copied markup.
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

/** Interactive react-select: input[role=combobox] whose menu mounts on mousedown
 *  and commits the choice into .select__single-value on option mousedown. */
function reactSelect(doc: Document, opts: { id: string; label: string; options: string[] }): HTMLElement {
  const control = doc.createElement("div");
  control.id = opts.id;
  control.className = "select";
  const single = doc.createElement("div");
  single.className = "select__single-value";
  const input = doc.createElement("input");
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-haspopup", "listbox");
  input.setAttribute("aria-expanded", "false");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-label", opts.label);
  const lbId = `${opts.id}-lb`;
  input.setAttribute("aria-controls", lbId);
  control.append(single, input);
  const render = (): void => {
    if (input.getAttribute("aria-expanded") !== "true") return;
    if (doc.getElementById(lbId)) return;
    const lb = doc.createElement("div");
    lb.id = lbId;
    lb.setAttribute("role", "listbox");
    for (const label of opts.options) {
      const o = doc.createElement("div");
      o.setAttribute("role", "option");
      o.textContent = label;
      o.addEventListener("mousedown", () => {
        single.textContent = label;
        input.setAttribute("aria-expanded", "false");
        lb.remove();
      });
      lb.append(o);
    }
    control.append(lb);
  };
  input.addEventListener("mousedown", () => {
    input.setAttribute("aria-expanded", "true");
    render();
  });
  return control;
}

/** Interactive ARIA radio group: role=radio divs that set aria-checked on click. */
function ariaRadioGroup(doc: Document, opts: { label: string; options: string[] }): HTMLElement {
  const group = doc.createElement("div");
  group.setAttribute("role", "radiogroup");
  group.setAttribute("aria-label", opts.label);
  for (const opt of opts.options) {
    const radio = doc.createElement("div");
    radio.setAttribute("role", "radio");
    radio.setAttribute("aria-checked", "false");
    radio.setAttribute("data-value", opt);
    radio.textContent = opt;
    radio.addEventListener("click", () => {
      group.querySelectorAll('[role="radio"]').forEach((r) => r.setAttribute("aria-checked", "false"));
      radio.setAttribute("aria-checked", "true");
    });
    group.append(radio);
  }
  return group;
}

const COUNTRIES = ["United States", "Canada", "Mexico"];
const GENDERS = ["Male", "Female", "Decline to self-identify"];

export function mountAshbyForm(doc: Document): void {
  mount(doc, [
    labeledInput(doc, { id: "ashby-firstname", label: "First Name" }),
    labeledInput(doc, { id: "ashby-email", label: "Email", type: "email" }),
    reactSelect(doc, { id: "ashby-country", label: "Country", options: COUNTRIES }),
    fileField(doc, { id: "ashby-resume", label: "Resume" }),
    nativeSelect(doc, { id: "ashby-gender", label: "Gender", options: GENDERS }),
  ]);
}

export function mountWorkableForm(doc: Document): void {
  mount(doc, [
    labeledInput(doc, { id: "workable-firstname", label: "First Name" }),
    labeledInput(doc, { id: "workable-email", label: "Email", type: "email" }),
    labeledInput(doc, { id: "workable-phone", label: "Phone", type: "tel" }),
    reactSelect(doc, { id: "workable-country", label: "Country", options: COUNTRIES }),
  ]);
}

export function mountSmartRecruitersForm(doc: Document): void {
  mount(doc, [
    labeledInput(doc, { id: "sr-firstname", label: "First Name" }),
    labeledInput(doc, { id: "sr-lastname", label: "Last Name" }),
    labeledInput(doc, { id: "sr-email", label: "Email", type: "email" }),
    labeledTextarea(doc, { id: "sr-custom", label: "What excites you about this opportunity?" }),
  ]);
}

export function mountJobviteForm(doc: Document): void {
  mount(doc, [
    labeledInput(doc, { id: "jobvite-firstname", label: "First Name" }),
    labeledInput(doc, { id: "jobvite-email", label: "Email", type: "email" }),
    ariaRadioGroup(doc, {
      label: "Will you now or in the future require sponsorship for employment visa status?",
      options: ["Yes", "No"],
    }),
    nativeSelect(doc, { id: "jobvite-gender", label: "Gender", options: GENDERS }),
  ]);
}

export function mountRipplingForm(doc: Document): void {
  mount(doc, [
    labeledInput(doc, { id: "rippling-firstname", label: "First Name" }),
    labeledInput(doc, { id: "rippling-lastname", label: "Last Name" }),
    labeledInput(doc, { id: "rippling-email", label: "Email", type: "email" }),
    labeledInput(doc, { id: "rippling-phone", label: "Phone", type: "tel" }),
  ]);
}

export function mountBullhornForm(doc: Document): void {
  mount(doc, [
    labeledInput(doc, { id: "bullhorn-firstname", label: "First Name" }),
    labeledInput(doc, { id: "bullhorn-lastname", label: "Last Name" }),
    labeledInput(doc, { id: "bullhorn-email", label: "Email", type: "email" }),
    labeledInput(doc, { id: "bullhorn-phone", label: "Phone", type: "tel" }),
  ]);
}
