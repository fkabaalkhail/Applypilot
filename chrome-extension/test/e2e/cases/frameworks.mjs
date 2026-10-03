/**
 * Framework bindings: does a value the extension writes REGISTER with the
 * page's framework, or does it merely appear in the DOM and vanish on the next
 * render ("filled, then cleared on blur")?
 *
 * Each page is a real form built on the real library (vendored builds in
 * test/e2e/vendor/: React 18 controlled inputs, Vue 3 v-model incl. .lazy /
 * .trim / .number, AngularJS 1.8 ng-model incl. updateOn:'blur' and
 * ng-options). Each page renders its framework MODEL as JSON into a <pre>, and
 * forces a re-render after every blur, so the harness asserts two things per
 * field: the DOM value, and the framework state (`expectState`). A value only
 * the DOM holds fails the state check.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SPARSE_CANADIAN } from "../profiles.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const vendor = (f) => ({ body: readFileSync(path.join(here, "..", "vendor", f), "utf8"), contentType: "application/javascript; charset=utf-8" });

const P = SPARSE_CANADIAN;
const ORIGIN = "https://careers.framework-harness.test";
const page = (title, head, body) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>${head}
  <style>body{font:14px sans-serif;margin:24px;max-width:640px}.field{margin:10px 0}label{display:block}input,select,textarea{width:300px;padding:4px}input[type=radio],input[type=checkbox]{width:auto}.err{color:#b00}</style>
  </head><body><h1>Software Engineer Intern, ${title}</h1><p>Apply below. All fields are reviewed by the hiring team.</p>${body}</body></html>`;

// ---------------------------------------------------------------- React 18
const REACT = page(
  "React",
  `<script src="${ORIGIN}/vendor/react.js"></script><script src="${ORIGIN}/vendor/react-dom.js"></script>`,
  `<div id="root"></div><pre id="react-state"></pre>
<script>
const h = React.createElement;
function App() {
  const [s, set] = React.useState({ firstName: "", lastName: "", email: "", phone: "", city: "", country: "", authorized: "", agree: false, news: false, linkedin: "" });
  const [touched, setTouched] = React.useState({});
  const up = (k) => (e) => { const v = e.target.type === "checkbox" ? e.target.checked : e.target.value; set((p) => ({ ...p, [k]: v })); };
  // Re-render on every blur: a value React never registered is reset here.
  const blur = (k) => () => setTouched((t) => ({ ...t, [k]: (t[k] || 0) + 1 }));
  // Input mask, applied on change like a real masked phone field.
  const phone = (e) => {
    const d = e.target.value.replace(/\\D/g, "").replace(/^1(?=\\d{10})/, "").slice(0, 10);
    const f = d.length > 6 ? "(" + d.slice(0, 3) + ") " + d.slice(3, 6) + "-" + d.slice(6) : d.length > 3 ? "(" + d.slice(0, 3) + ") " + d.slice(3) : d;
    set((p) => ({ ...p, phone: f }));
  };
  React.useEffect(() => { document.getElementById("react-state").textContent = JSON.stringify(s); }, [s, touched]);
  const text = (id, label, extra = {}) => h("div", { className: "field" },
    h("label", { htmlFor: id }, label),
    h("input", { id, name: id, value: s[id], onChange: up(id), onBlur: blur(id), ...extra }),
    touched[id] && !s[id] ? h("span", { className: "err" }, " Required") : null);
  return h("form", { onSubmit: (e) => e.preventDefault() },
    text("firstName", "First name"),
    text("lastName", "Last name"),
    text("email", "Email", { type: "email" }),
    h("div", { className: "field" }, h("label", { htmlFor: "phone" }, "Phone"),
      h("input", { id: "phone", name: "phone", type: "tel", value: s.phone, onChange: phone, onBlur: blur("phone") })),
    text("city", "City"),
    h("div", { className: "field" }, h("label", { htmlFor: "country" }, "Country"),
      h("select", { id: "country", name: "country", value: s.country, onChange: up("country"), onBlur: blur("country") },
        h("option", { value: "" }, "Select..."), h("option", { value: "US" }, "United States"), h("option", { value: "CA" }, "Canada"), h("option", { value: "MX" }, "Mexico"))),
    h("fieldset", null, h("legend", null, "Are you legally authorized to work in Canada?"),
      ["Yes", "No"].map((v) => h("label", { key: v }, h("input", { type: "radio", name: "authorized", value: v, checked: s.authorized === v, onChange: up("authorized") }), " " + v))),
    text("linkedin", "LinkedIn profile URL", { type: "url" }),
    h("label", null, h("input", { type: "checkbox", id: "agree", checked: s.agree, onChange: up("agree") }), " I certify that the information in this application is accurate"),
    h("label", null, h("input", { type: "checkbox", id: "news", checked: s.news, onChange: up("news") }), " Send me news and updates about future openings")
  );
}
ReactDOM.createRoot(document.getElementById("root")).render(h(App));
</script>`
);

// ---------------------------------------------------------------- Vue 3
const VUE = page(
  "Vue",
  `<script src="${ORIGIN}/vendor/vue.js"></script>`,
  `<div id="app"><form @submit.prevent>
  <div class="field"><label for="firstName">First name</label><input id="firstName" v-model="s.firstName" @blur="n++"></div>
  <div class="field"><label for="lastName">Last name</label><input id="lastName" v-model.trim="s.lastName" @blur="n++"></div>
  <div class="field"><label for="email">Email</label><input id="email" type="email" v-model.lazy="s.email" @blur="n++"></div>
  <div class="field"><label for="city">City</label><input id="city" v-model.trim="s.city" @blur="n++"></div>
  <div class="field"><label for="province">Province</label><select id="province" v-model="s.province"><option value="">Select...</option><option v-for="p in provinces" :value="p">{{ p }}</option></select></div>
  <fieldset><legend>Are you legally authorized to work in Canada?</legend>
    <label><input type="radio" value="Yes" v-model="s.authorized"> Yes</label><label><input type="radio" value="No" v-model="s.authorized"> No</label></fieldset>
  <fieldset><legend>Do you live in the United States?</legend>
    <label><input type="radio" value="YES" v-model="s.liveUS"> YES</label><label><input type="radio" value="NO" v-model="s.liveUS"> NO</label></fieldset>
  <div class="field"><label for="years">How many years of professional software development experience do you have?</label><input id="years" type="number" v-model.number="s.years" @blur="n++"></div>
  <label><input type="checkbox" id="agree" v-model="s.agree"> I acknowledge the privacy policy</label>
</form><pre id="vue-state">{{ JSON.stringify(s) }}</pre><span hidden>{{ n }}</span></div>
<script>
Vue.createApp({ data: () => ({ n: 0, provinces: ["Alberta", "British Columbia", "Ontario", "Quebec"], s: { firstName: "", lastName: "", email: "", city: "", province: "", authorized: "", liveUS: "", years: "", agree: false } }) }).mount("#app");
</script>`
);

// ---------------------------------------------------------------- AngularJS 1.8
const ANGULAR = page(
  "AngularJS",
  `<script src="${ORIGIN}/vendor/angular.js"></script>`,
  `<div ng-app="apply" ng-controller="C as c"><form name="f" novalidate>
  <div class="field"><label for="firstName">First name</label><input id="firstName" name="firstName" ng-model="c.s.firstName" required></div>
  <div class="field"><label for="lastName">Last name</label><input id="lastName" name="lastName" ng-model="c.s.lastName" ng-model-options="{ updateOn: 'blur' }"></div>
  <div class="field"><label for="email">Email</label><input id="email" name="email" type="email" ng-model="c.s.email"></div>
  <div class="field"><label for="phone">Phone</label><input id="phone" name="phone" type="tel" ng-model="c.s.phone"></div>
  <div class="field"><label for="state">Province / State</label><select id="state" name="state" ng-model="c.s.state" ng-options="p for p in c.regions"><option value="">Select...</option></select></div>
  <fieldset><legend>Are you eligible to work in Canada without sponsorship?</legend>
    <label><input type="radio" name="elig" value="Yes" ng-model="c.s.eligible"> Yes</label><label><input type="radio" name="elig" value="No" ng-model="c.s.eligible"> No</label></fieldset>
  <div class="field"><label for="linkedin">LinkedIn</label><input id="linkedin" name="linkedin" type="url" ng-model="c.s.linkedin"></div>
</form><pre id="ng-state">{{ c.s | json }}</pre></div>
<script>
angular.module("apply", []).controller("C", function () {
  this.regions = ["Alberta", "British Columbia", "Ontario", "Quebec", "New York", "California"];
  this.s = { firstName: "", lastName: "", email: "", phone: "", state: null, eligible: "", linkedin: "" };
});
</script>`
);

const assets = {
  [`${ORIGIN}/vendor/react.js`]: vendor("react-18.3.1.min.js"),
  [`${ORIGIN}/vendor/react-dom.js`]: vendor("react-dom-18.3.1.min.js"),
  [`${ORIGIN}/vendor/vue.js`]: vendor("vue-3.5.13.global.prod.js"),
  [`${ORIGIN}/vendor/angular.js`]: vendor("angular-1.8.3.min.js"),
};

export default [
  {
    id: "framework-react18",
    ats: "framework",
    url: `${ORIGIN}/react/apply`,
    html: REACT,
    assets,
    profile: P,
    stateSelector: "#react-state",
    expect: {
      "#firstName": "Maya",
      "#lastName": "Tremblay",
      "#email": P.email,
      "#phone": "(416) 555-0142",
      "#city": "Toronto",
      "#country": "Canada",
      "radio=authorized": "Yes",
      "#linkedin": P.linkedin,
      // Attestation boxes are left for the applicant (decision, see NOTES.md).
      "#agree": null,
      "#news": null,
    },
    expectState: {
      firstName: "Maya",
      lastName: "Tremblay",
      email: P.email,
      phone: "(416) 555-0142",
      city: "Toronto",
      country: "CA",
      authorized: "Yes",
      linkedin: P.linkedin,
    },
  },
  {
    id: "framework-vue3",
    ats: "framework",
    url: `${ORIGIN}/vue/apply`,
    html: VUE,
    assets,
    profile: P,
    stateSelector: "#vue-state",
    expect: {
      "#firstName": "Maya",
      "#lastName": "Tremblay",
      "#email": P.email,
      "#city": "Toronto",
      "#province": "Ontario",
      "label:authorized to work in Canada": "Yes",
      "label:live in the United States": "NO",
      "#years": "1",
      // Attestation boxes are left for the applicant (decision, see NOTES.md).
      "#agree": null,
    },
    expectState: {
      firstName: "Maya",
      lastName: "Tremblay",
      email: P.email,
      city: "Toronto",
      province: "Ontario",
      authorized: "Yes",
      liveUS: "NO",
      years: { re: "^1$" },
    },
  },
  {
    id: "framework-angularjs",
    ats: "framework",
    url: `${ORIGIN}/angular/apply`,
    html: ANGULAR,
    assets,
    profile: P,
    stateSelector: "#ng-state",
    expect: {
      "#firstName": "Maya",
      "#lastName": "Tremblay",
      "#email": P.email,
      "#phone": { re: "416\\D*555\\D*0142" },
      "#state": "Ontario",
      "radio=elig": "Yes",
      "#linkedin": P.linkedin,
    },
    expectState: {
      firstName: "Maya",
      lastName: "Tremblay",
      email: P.email,
      phone: { re: "416\\D*555\\D*0142" },
      state: "Ontario",
      eligible: "Yes",
      linkedin: P.linkedin,
    },
  },
];
