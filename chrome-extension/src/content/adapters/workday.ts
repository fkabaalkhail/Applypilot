// chrome-extension/src/content/adapters/workday.ts
/**
 * Workday (`*.myworkdayjobs.com` etc.). Workday's visible labels are generic, but
 * its `data-automation-id`s are reliable — the adapter's main win. Also formats
 * the country prompt and owns the split (month/day/year) date widget the generic
 * writer can't drive as one value.
 *
 * Every automation-id lives in ./workdaySelectors — this file holds only logic.
 */
import { ADAPTERS } from "./registry";
import type { AdapterFillResult, FillContext, SiteAdapter } from "./types";
import {
  ADVANCE_BUTTON_SELECTOR,
  COVER_LETTER_SECTION_RE,
  DATE_FRAGMENTS,
  ENTRY_BUTTON_SELECTOR,
  FIELD_RULES,
  RESUME_SECTION_RE,
  WD_HOST,
  automationId,
  automationIdChain,
  dateContainerOf,
  datePartsIn,
  dateWidgetPartsOf,
} from "./workdaySelectors";

/** Workday's phone-device-type prompt lists Home / Mobile / Work / Pager / Fax.
 *  Applicants give a mobile number essentially always, and the field is
 *  required — answering it deterministically saves an AI round-trip per fill. */
const DEFAULT_PHONE_DEVICE_TYPE = "Mobile";

/** Parse the date shapes the profile and the page actually use: ISO
 *  (2025-05-14), year-month (2025-05 — how experience start/end dates are
 *  stored), US (5/14/2025), and a bare year (2026 — graduation). Missing parts
 *  come back as "" and are simply not written.
 *
 *  Fully anchored and range-checked on purpose: this parse is the only thing
 *  standing between an arbitrary answer and a set of date spinbuttons, and an
 *  unanchored match reads "2020-2024" as month 20 and "1234-5 King St" as the
 *  year 1234. */
function parseDate(v: string): { month: string; day: string; year: string } | null {
  const inRange = (n: number, max: number): boolean => n >= 1 && n <= max;
  const s = v.trim();

  const iso = s.match(/^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?$/);
  if (iso) {
    const month = Number(iso[2]);
    const day = iso[3] === undefined ? null : Number(iso[3]);
    if (!inRange(month, 12) || (day !== null && !inRange(day, 31))) return null;
    return { year: iso[1], month: String(month), day: day === null ? "" : String(day) };
  }
  const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (us) {
    const month = Number(us[1]);
    const day = Number(us[2]);
    if (!inRange(month, 12) || !inRange(day, 31)) return null;
    return { month: String(month), day: String(day), year: us[3] };
  }
  const bare = s.match(/^(\d{4})$/);
  if (bare) return { year: bare[1], month: "", day: "" };
  return null;
}

function setInput(el: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (setter) setter.call(el, value); else el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

export const workdayAdapter: SiteAdapter = {
  id: "workday",
  label: "Workday",
  match: (host) => WD_HOST.test(host),

  classify(ctx) {
    // Resume / cover-letter uploads: Workday tags the SECTION, not the input, so
    // scan the ancestor automation-id chain. Best-effort across Workday layouts
    // (resumeSection / quickApplyResume / fileUpload… under a resume section).
    const chain = automationIdChain(ctx.el);
    if (RESUME_SECTION_RE.test(chain)) {
      return { category: "resumeUpload", confidence: 0.9, sensitive: false };
    }
    if (COVER_LETTER_SECTION_RE.test(chain)) {
      return { category: "coverLetter", confidence: 0.9, sensitive: false };
    }
    const aid = automationId(ctx.el);
    if (!aid) return undefined;
    for (const [re, category] of FIELD_RULES) {
      if (re.test(aid)) return { category, confidence: 0.96, sensitive: false };
    }
    return undefined;
  },

  resolveAnswer(ctx) {
    // Workday country/region prompts expect just the country name. Prefer the
    // structured profile.country; fall back to the last comma segment of the
    // free-text location so older profiles (location only) still fill.
    // The dialing-code prompt takes the same answer: its options read
    // "Canada (+1)", which the option matcher resolves from "Canada".
    if (ctx.category === "country" || ctx.category === "phoneCountryCode") {
      if (ctx.category === "country" && !/country|region/.test(automationId(ctx.el))) return undefined;
      const derived = (ctx.profile.location || "").split(",").map((s) => s.trim()).filter(Boolean).pop();
      return ctx.profile.country || derived || undefined;
    }
    if (ctx.category === "phoneDeviceType") return DEFAULT_PHONE_DEVICE_TYPE;
    // A city field defers to the generic resolver (profile.addressCity || location).
    return undefined;
  },

  fillOperation(ctx: FillContext): Promise<AdapterFillResult> | undefined {
    const container = dateContainerOf(ctx.el);
    if (!container) return undefined;
    const parts = parseDate(ctx.value);
    if (!parts) return undefined;
    const inputs = datePartsIn(container);
    if (!inputs || !DATE_FRAGMENTS.some((f) => inputs[f])) return undefined;
    return (async () => {
      // Verify the container before trusting it. Resolving one is a heuristic
      // over ids that are only mostly reliable, and each time it has been wrong
      // the symptom was the same: some parts written, the rest left at 0, and a
      // success reported over the top. So ask the question that actually
      // matters — is there a part this value needs, that this widget HAS, that
      // the container did not give us? — and refuse the whole fill if so. An
      // unanticipated DOM shape then fails loudly here instead of silently on
      // the page, and the reason reaches autofill_reports.
      const widget = dateWidgetPartsOf(container);
      const unreachable = DATE_FRAGMENTS.filter((f) => parts[f] && !inputs[f] && widget[f]);
      if (unreachable.length) {
        return { filled: false, reason: `date parts outside the resolved widget: ${unreachable.join(", ")}` };
      }
      // A part the value doesn't carry (no day in "2025-05") is left alone
      // rather than zeroed — Workday reads 0 as empty and flags it invalid.
      let wrote = 0;
      for (const frag of DATE_FRAGMENTS) {
        const input = inputs[frag];
        if (!input || !parts[frag]) continue;
        setInput(input, parts[frag]);
        wrote++;
      }
      // Those guards can skip every part (a bare year against a month-only
      // widget). Claiming filled:true there banks a green panel tally and a
      // green autofill_reports row for a widget that is visibly still empty.
      return wrote > 0 ? { filled: true } : { filled: false, reason: "no date part matched the value" };
    })();
  },

  advanceButton(scope) {
    // Workday's step footer often sits OUTSIDE the fields' container — fall
    // back to the whole document when the scope doesn't hold it.
    return (
      (scope.querySelector(ADVANCE_BUTTON_SELECTOR) as HTMLElement | null) ??
      (scope.ownerDocument.querySelector(ADVANCE_BUTTON_SELECTOR) as HTMLElement | null)
    );
  },

  entryButton(doc) {
    for (const el of doc.querySelectorAll<HTMLElement>(ENTRY_BUTTON_SELECTOR)) {
      if (el.offsetParent !== null || el.getClientRects().length > 0) return el;
    }
    return null;
  },
};

ADAPTERS.push(workdayAdapter);
