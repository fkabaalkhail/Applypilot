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
  [/country|region/i, "location"],
  [/(address)?.*city/i, "location"],
];

function automationId(el: HTMLElement): string {
  return (el.closest("[data-automation-id]")?.getAttribute("data-automation-id") || "").toLowerCase();
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
  match: (host) => WD_HOST.test(host),

  classify(ctx) {
    const aid = automationId(ctx.el);
    if (!aid) return undefined;
    for (const [re, category] of AUTOMATION_RULES) {
      if (re.test(aid)) return { category, confidence: 0.96, sensitive: false };
    }
    return undefined;
  },

  resolveAnswer(ctx) {
    // Workday country/region prompts expect just the country name.
    if (ctx.category === "location" && /country|region/.test(automationId(ctx.el))) {
      const country = (ctx.profile.location || "").split(",").map((s) => s.trim()).filter(Boolean).pop();
      return country || undefined;
    }
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
};

ADAPTERS.push(workdayAdapter);
