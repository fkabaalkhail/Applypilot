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
  DATE_PART_FRAGMENTS,
  ENTRY_BUTTON_SELECTOR,
  FIELD_RULES,
  RESUME_SECTION_RE,
  WD_HOST,
  automationId,
  automationIdChain,
  dateContainerOf,
} from "./workdaySelectors";

/** Workday's phone-device-type prompt lists Home / Mobile / Work / Pager / Fax.
 *  Applicants give a mobile number essentially always, and the field is
 *  required — answering it deterministically saves an AI round-trip per fill. */
const DEFAULT_PHONE_DEVICE_TYPE = "Mobile";

/** Parse the date shapes the profile and the page actually use: ISO
 *  (2025-05-14), year-month (2025-05 — how experience start/end dates are
 *  stored), US (5/14/2025), and a bare year (2026 — graduation). Missing parts
 *  come back as "" and are simply not written. */
function parseDate(v: string): { month: string; day: string; year: string } | null {
  const iso = v.match(/^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?/);
  if (iso) {
    return { year: iso[1], month: String(Number(iso[2])), day: iso[3] ? String(Number(iso[3])) : "" };
  }
  const us = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (us) return { month: String(Number(us[1])), day: String(Number(us[2])), year: us[3] };
  const bare = v.match(/^(\d{4})$/);
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
    const q = (frag: string) =>
      container.querySelector<HTMLInputElement>(`input[data-automation-id*="${frag}" i]`);
    const month = q(DATE_PART_FRAGMENTS.month);
    const day = q(DATE_PART_FRAGMENTS.day);
    const year = q(DATE_PART_FRAGMENTS.year);
    const parts = parseDate(ctx.value);
    if (!parts || (!month && !day && !year)) return undefined;
    return (async () => {
      // A part the value doesn't carry (no day in "2025-05") is left alone
      // rather than zeroed — Workday reads 0 as empty and flags it invalid.
      if (month && parts.month) setInput(month, parts.month);
      if (day && parts.day) setInput(day, parts.day);
      if (year && parts.year) setInput(year, parts.year);
      return { filled: true };
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
