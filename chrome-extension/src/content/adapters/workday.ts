// chrome-extension/src/content/adapters/workday.ts
/**
 * Workday (`*.myworkdayjobs.com` etc.). Workday's visible labels are generic, but
 * its `data-automation-id`s are reliable — the adapter's main win. Also formats
 * the country prompt and owns the split (month/day/year) date widget the generic
 * writer can't drive as one value.
 */
import type { FieldCategory } from "../../shared/types";
import { ADAPTERS } from "./registry";
import type { AdapterFillResult, FillContext, SiteAdapter } from "./types";

const WD_HOST = /(^|\.)(myworkdayjobs|myworkday|myworkdayjobs-impl|myworkdaysite)\.com$/i;

const AUTOMATION_RULES: Array<[RegExp, FieldCategory]> = [
  [/firstname|givenname/i, "firstName"],
  [/lastname|familyname/i, "lastName"],
  [/email/i, "email"],
  [/phone.*number|^phone/i, "phone"],
  [/country|region/i, "country"],
  [/(address)?.*city/i, "addressCity"],
];

function automationId(el: HTMLElement): string {
  return (el.closest("[data-automation-id]")?.getAttribute("data-automation-id") || "").toLowerCase();
}

/** All data-automation-ids from the element up through its section wrappers,
 *  joined — Workday nests a file <input> under a `resume`/`cover` SECTION id
 *  while the input's own id is generic ("file-upload-input-ref"). */
function automationIdChain(el: HTMLElement): string {
  const ids: string[] = [];
  let node: HTMLElement | null = el;
  for (let i = 0; node && i < 6; i++, node = node.parentElement) {
    const id = node.getAttribute("data-automation-id");
    if (id) ids.push(id.toLowerCase());
  }
  return ids.join(" ");
}

function parseDate(v: string): { month: string; day: string; year: string } | null {
  const iso = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) return { year: iso[1], month: String(Number(iso[2])), day: String(Number(iso[3])) };
  const us = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (us) return { month: String(Number(us[1])), day: String(Number(us[2])), year: us[3] };
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
    if (/resume|curriculum.?vitae/i.test(chain)) {
      return { category: "resumeUpload", confidence: 0.9, sensitive: false };
    }
    if (/cover.?letter/i.test(chain)) {
      return { category: "coverLetter", confidence: 0.9, sensitive: false };
    }
    const aid = automationId(ctx.el);
    if (!aid) return undefined;
    for (const [re, category] of AUTOMATION_RULES) {
      if (re.test(aid)) return { category, confidence: 0.96, sensitive: false };
    }
    return undefined;
  },

  resolveAnswer(ctx) {
    // Workday country/region prompts expect just the country name. Prefer the
    // structured profile.country; fall back to the last comma segment of the
    // free-text location so older profiles (location only) still fill.
    if (ctx.category === "country" && /country|region/.test(automationId(ctx.el))) {
      const derived = (ctx.profile.location || "").split(",").map((s) => s.trim()).filter(Boolean).pop();
      return ctx.profile.country || derived || undefined;
    }
    // A city field defers to the generic resolver (profile.addressCity || location).
    return undefined;
  },

  fillOperation(ctx: FillContext): Promise<AdapterFillResult> | undefined {
    const container = ctx.el.closest("[data-automation-id]");
    if (!container || !/date/i.test(container.getAttribute("data-automation-id") || "")) return undefined;
    const q = (frag: string) =>
      container.querySelector<HTMLInputElement>(`input[data-automation-id*="${frag}" i]`);
    const month = q("month");
    const day = q("day");
    const year = q("year");
    const parts = parseDate(ctx.value);
    if (!parts || (!month && !day && !year)) return undefined;
    return (async () => {
      if (month) setInput(month, parts.month);
      if (day) setInput(day, parts.day);
      if (year) setInput(year, parts.year);
      return { filled: true };
    })();
  },

  advanceButton(scope) {
    // Workday's step footer often sits OUTSIDE the fields' container — fall
    // back to the whole document when the scope doesn't hold it. Two footer
    // generations: bottom-navigation (current) and pageFooter (older tenants).
    const sel =
      '[data-automation-id="bottom-navigation-next-button"], button[data-automation-id="pageFooterNextButton"]';
    return (
      (scope.querySelector(sel) as HTMLElement | null) ??
      (scope.ownerDocument.querySelector(sel) as HTMLElement | null)
    );
  },

  entryButton(doc) {
    // The job posting's Apply button ("adventureButton") or the resume-a-draft
    // "Continue Application" ("continueButton"). The chooser that follows
    // (Autofill with Resume / Apply Manually / Use My Last Application) has no
    // stable automation-ids — the generic text tiers pick "Apply Manually".
    for (const el of doc.querySelectorAll<HTMLElement>(
      '[data-automation-id="adventureButton"], [data-automation-id="continueButton"]'
    )) {
      if (el.offsetParent !== null || el.getClientRects().length > 0) return el;
    }
    return null;
  },
};

ADAPTERS.push(workdayAdapter);
