/**
 * Reproduces Taleo's legacy table-layout field markup as the owning-frame
 * content-script instance sees it: labels are bare text in a sibling <td> (no
 * `for=`), so classification rides on domUtils nearbyText. The iframe wrapper is a
 * cross-realm coordination concern verified via crossFrame unit tests + a live
 * spot-check (see docs/superpowers/specs/2026-06-30-icims-autofill-hardening-design.md
 * §1.1). Reconstructed from known Taleo patterns as of 2026-06-30, not copied markup.
 */

function row(doc: Document, labelText: string, control: HTMLElement): HTMLElement {
  const tr = doc.createElement("tr");
  const tdLabel = doc.createElement("td");
  tdLabel.textContent = labelText;
  const tdControl = doc.createElement("td");
  tdControl.appendChild(control);
  tr.append(tdLabel, tdControl);
  return tr;
}

function textInput(doc: Document, id: string, name: string, type = "text"): HTMLInputElement {
  const input = doc.createElement("input");
  input.type = type;
  input.id = id;
  input.setAttribute("name", name);
  return input;
}

function selectInput(doc: Document, id: string, name: string, options: string[]): HTMLSelectElement {
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

export function mountTaleoForm(doc: Document): void {
  doc.body.innerHTML = "";
  const table = doc.createElement("table");
  const tbody = doc.createElement("tbody");

  tbody.append(row(doc, "First Name", textInput(doc, "taleo-firstname", "p_firstname")));
  tbody.append(row(doc, "Last Name", textInput(doc, "taleo-lastname", "p_lastname")));
  tbody.append(row(doc, "Email", textInput(doc, "taleo-email", "p_email")));
  tbody.append(row(doc, "Phone", textInput(doc, "taleo-phone", "p_phone")));
  tbody.append(row(doc, "City", textInput(doc, "taleo-city", "p_city")));
  tbody.append(row(doc, "Country", selectInput(doc, "taleo-country", "p_country", ["United States", "Canada", "Mexico"])));

  const resume = textInput(doc, "taleo-resume", "p_resume", "file");
  tbody.append(row(doc, "Resume", resume));

  tbody.append(row(doc, "Gender", selectInput(doc, "taleo-gender", "p_gender", ["Male", "Female", "Decline to self-identify"])));
  tbody.append(row(doc, "Race/Ethnicity", selectInput(doc, "taleo-ethnicity", "p_ethnicity", ["Asian", "White", "Decline to self-identify"])));
  tbody.append(row(doc, "Veteran Status", selectInput(doc, "taleo-veteran", "p_veteran", ["I am not a veteran", "I am a veteran"])));

  table.appendChild(tbody);
  doc.body.appendChild(table);
}
