/**
 * Page-side field dump: the harness's ground truth, read straight from the DOM
 * by the PAGE (not by the extension), so a fill the extension believes it made
 * is checked against what the form actually holds.
 *
 * `dumpFieldsInPage` is passed to `frame.evaluate`, so it must be fully
 * self-contained, no imports, no closures over module scope. It pierces open
 * shadow roots; iframes are dumped separately, one `frame.evaluate` per frame,
 * which also covers cross-origin frames the page itself could not read.
 */
export function dumpFieldsInPage() {
  const OVERLAY_ID = "applypilot-overlay-host";
  const clean = (t) => (t || "").replace(/\s+/g, " ").trim();
  const roots = [];
  const visit = (root) => {
    roots.push(root);
    root.querySelectorAll("*").forEach((el) => {
      if (el.id === OVERLAY_ID) return;
      if (el.shadowRoot) visit(el.shadowRoot);
    });
  };
  visit(document);

  const inOverlay = (el) => {
    let n = el;
    while (n) {
      if (n.id === OVERLAY_ID) return true;
      n = n.parentNode || n.host || null;
    }
    return false;
  };
  const visible = (el) => {
    const s = getComputedStyle(el);
    if (s.display === "none" || s.visibility === "hidden") return false;
    return Array.from(el.getClientRects()).some((r) => r.width > 1 && r.height > 1);
  };
  const textOfIds = (root, ids) =>
    clean(
      (ids || "")
        .split(/\s+/)
        .filter(Boolean)
        .map((id) => (root.getElementById ? root.getElementById(id) : document.getElementById(id))?.textContent || "")
        .join(" ")
    );
  const labelOf = (el) => {
    const root = el.getRootNode();
    if (el.labels && el.labels.length) return clean(Array.from(el.labels).map((l) => l.textContent).join(" "));
    const aria = clean(el.getAttribute("aria-label"));
    if (aria) return aria;
    const by = textOfIds(root, el.getAttribute("aria-labelledby"));
    if (by) return by;
    const ph = clean(el.getAttribute("placeholder"));
    if (ph) return ph;
    // Nearest preceding text within a few ancestors.
    let node = el;
    for (let d = 0; d < 4 && node; d++) {
      let sib = node.previousSibling;
      for (let h = 0; sib && h < 6; h++, sib = sib.previousSibling) {
        const t = clean(sib.textContent);
        if (t && t.length <= 200) return t;
      }
      node = node.parentElement;
    }
    return "";
  };
  const groupLabel = (el) => {
    const fs = el.closest("fieldset");
    const legend = fs && fs.querySelector("legend");
    if (legend) return clean(legend.textContent);
    const g = el.closest('[role="radiogroup"], [role="group"]');
    if (g) {
      const a = clean(g.getAttribute("aria-label")) || textOfIds(el.getRootNode(), g.getAttribute("aria-labelledby"));
      if (a) return a;
    }
    // The question usually sits right before the option list.
    let node = el.closest("label") || el;
    for (let d = 0; d < 5 && node; d++) {
      let sib = node.previousElementSibling;
      for (let h = 0; sib && h < 4; h++, sib = sib.previousElementSibling) {
        if (sib.querySelector && sib.querySelector('input[type="radio"], input[type="checkbox"]')) continue;
        const t = clean(sib.textContent);
        if (t && t.length <= 300) return t;
      }
      node = node.parentElement;
    }
    return "";
  };
  const optionLabel = (input) =>
    (input.labels && input.labels[0] && clean(input.labels[0].textContent)) || clean(input.getAttribute("aria-label")) || input.value || "";

  const idCounts = new Map();
  for (const r of roots) r.querySelectorAll("[id]").forEach((e) => idCounts.set(e.id, (idCounts.get(e.id) || 0) + 1));
  const nameCounts = new Map();
  const keyOf = (el, label) => {
    if (el.id && idCounts.get(el.id) === 1 && !/^[0-9]/.test(el.id)) return `#${el.id}`;
    const name = el.getAttribute("name");
    if (name) {
      const n = (nameCounts.get(name) || 0) + 1;
      nameCounts.set(name, n);
      return n === 1 ? `name=${name}` : `name=${name}#${n}`;
    }
    const auto = el.getAttribute("data-automation-id");
    if (auto) return `auto=${auto}`;
    return `label=${label.slice(0, 60)}`;
  };

  const comboValue = (el) => {
    if (el instanceof HTMLInputElement && el.value) return el.value;
    const ad = el.getAttribute("aria-activedescendant");
    let node = el.parentElement;
    for (let h = 0; node && h < 6; h++, node = node.parentElement) {
      if (node.querySelectorAll('[role="combobox"], [aria-haspopup="listbox"]').length > 1) break;
      const v = node.querySelector(
        '[class*="single-value" i], [class*="singleValue" i], [class*="multi-value__label" i], [class*="multiValue" i] [class*="label" i], [data-automation-id="selectedItem"], [class*="chip" i], [class*="pill" i]'
      );
      if (v && clean(v.textContent)) {
        const all = Array.from(
          node.querySelectorAll('[class*="single-value" i], [class*="singleValue" i], [class*="multi-value__label" i], [data-automation-id="selectedItem"]')
        )
          .map((x) => clean(x.textContent))
          .filter(Boolean);
        return all.length ? all.join(", ") : clean(v.textContent);
      }
    }
    if (el.tagName === "BUTTON" || el.getAttribute("aria-haspopup") === "listbox") {
      const t = clean(el.textContent);
      if (t && !/^(select( one)?|choose|please select|select\.\.\.|select…)$/i.test(t)) return t;
    }
    if (ad) {
      const o = document.getElementById(ad);
      if (o) return "";
    }
    return "";
  };

  const out = [];
  const seenRadioGroups = new Set();
  const SKIP_TYPES = new Set(["hidden", "submit", "button", "reset", "image"]);
  for (const root of roots) {
    const els = root.querySelectorAll(
      'input, select, textarea, [contenteditable="true"], [role="combobox"], [aria-haspopup="listbox"], [role="radiogroup"]'
    );
    for (const el of els) {
      if (inOverlay(el)) continue;
      const tag = el.tagName.toLowerCase();
      if (tag === "input" && SKIP_TYPES.has(el.type)) continue;
      const role = (el.getAttribute("role") || "").toLowerCase();
      const isCombo =
        role === "combobox" || (el.getAttribute("aria-haspopup") || "").toLowerCase() === "listbox";
      if (tag === "input" && el.type === "radio") {
        // Name-less radios (Vue v-model) group by their question container.
        let container = null;
        if (!el.name) {
          container = el.closest('fieldset, [role="radiogroup"]');
          if (!container || container.querySelectorAll('input[type="radio"]').length < 2) {
            container = null;
            let node = el.parentElement;
            for (let d = 0; d < 6 && node; d++, node = node.parentElement) {
              if (node.querySelectorAll('input[type="radio"]').length >= 2) {
                container = node;
                break;
              }
            }
          }
        }
        const groupKey = el.name
          ? `${el.form ? el.form.id || "f" : "nf"}::${el.name}`
          : container
            ? container
            : el;
        if (seenRadioGroups.has(groupKey)) continue;
        seenRadioGroups.add(groupKey);
        const members = el.name
          ? Array.from(root.querySelectorAll(`input[type="radio"][name="${CSS.escape(el.name)}"]`))
          : container
            ? Array.from(container.querySelectorAll('input[type="radio"]'))
            : [el];
        const checked = members.find((m) => m.checked);
        const label = groupLabel(el);
        out.push({
          key: el.name ? `radio=${el.name}` : keyOf(el, label),
          type: "radio",
          label,
          value: checked ? optionLabel(checked) : "",
          options: members.map(optionLabel).slice(0, 40),
          visible: members.some(visible) || members.some((m) => m.labels && m.labels[0] && visible(m.labels[0])),
          required: members.some((m) => m.required),
        });
        continue;
      }
      if (role === "radiogroup") {
        const radios = Array.from(el.querySelectorAll('[role="radio"]'));
        const checked = radios.find((r) => r.getAttribute("aria-checked") === "true");
        const label = clean(el.getAttribute("aria-label")) || textOfIds(el.getRootNode(), el.getAttribute("aria-labelledby")) || groupLabel(el);
        out.push({
          key: el.id ? `#${el.id}` : `ariaradio=${label.slice(0, 60)}`,
          type: "aria-radiogroup",
          label,
          value: checked ? clean(checked.getAttribute("aria-label")) || clean(checked.textContent) : "",
          options: radios.map((r) => clean(r.getAttribute("aria-label")) || clean(r.textContent)).slice(0, 40),
          visible: visible(el),
          required: el.getAttribute("aria-required") === "true",
        });
        continue;
      }
      const label = labelOf(el);
      let type;
      let value;
      let options;
      if (isCombo && !(el instanceof HTMLSelectElement)) {
        type = "combobox";
        value = comboValue(el);
      } else if (tag === "select") {
        type = el.multiple ? "select-multiple" : "select";
        const sel = Array.from(el.selectedOptions).filter((o) => o.value !== "");
        value = sel.map((o) => clean(o.textContent)).join(", ");
        options = Array.from(el.options).map((o) => clean(o.textContent)).filter(Boolean).slice(0, 80);
      } else if (tag === "textarea") {
        type = "textarea";
        value = el.value;
      } else if (tag === "input") {
        type = el.type || "text";
        if (el.type === "checkbox") value = el.checked ? "checked" : "";
        else if (el.type === "file") value = Array.from(el.files || []).map((f) => f.name).join(", ");
        else value = el.value;
      } else {
        type = "contenteditable";
        value = clean(el.textContent);
      }
      out.push({
        key: keyOf(el, label),
        type,
        label,
        value: value ?? "",
        ...(options ? { options } : {}),
        visible: visible(el) || ((type === "checkbox" || type === "file") && Boolean(el.labels && el.labels.length)),
        required: Boolean(el.required) || el.getAttribute("aria-required") === "true",
        disabled: Boolean(el.disabled),
        readOnly: Boolean(el.readOnly),
      });
    }
  }
  return out;
}

/** Dump every frame of a page, tagging each record with its frame URL. */
export async function dumpAllFrames(page) {
  const all = [];
  for (const frame of page.frames()) {
    try {
      const fields = await frame.evaluate(dumpFieldsInPage);
      const where = frame === page.mainFrame() ? "" : frame.url();
      for (const f of fields) all.push({ ...f, frame: where });
    } catch {
      // detached / navigating frame: nothing to read
    }
  }
  return all;
}
