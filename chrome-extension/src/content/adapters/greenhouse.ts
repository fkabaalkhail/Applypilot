/**
 * Greenhouse (`*.greenhouse.io`). Greenhouse forms are well-labeled, so the
 * generic pipeline handles most fields; this adapter reinforces the few quirks:
 * custom social-URL questions (name="...urls[LinkedIn]...") whose visible label
 * is often just the network name, and exact EEO option casing.
 */
import type { FieldCategory } from "../../shared/types";
import { ADAPTERS } from "./registry";
import type { SiteAdapter } from "./types";

const NAME_RULES: Array<[RegExp, FieldCategory]> = [
  [/urls\[linked ?in\]|linked ?in_url/i, "linkedin"],
  [/urls\[git ?hub\]|git ?hub_url/i, "github"],
  [/urls\[(website|portfolio|other)\]/i, "portfolio"],
];

export const greenhouseAdapter: SiteAdapter = {
  id: "greenhouse",
  match: (host) => /(^|\.)greenhouse\.io$/i.test(host),

  classify(ctx) {
    const name = ctx.el.getAttribute("name") || ctx.el.id || "";
    for (const [re, category] of NAME_RULES) {
      if (re.test(name)) return { category, confidence: 0.95, sensitive: false };
    }
    return undefined;
  },

  resolveAnswer(ctx) {
    // Greenhouse EEO gender options are exact-cased ("Male"/"Female"/"Decline To
    // Self Identify"); map common profile values to a real option.
    if (ctx.category === "eeoGender") {
      if (!ctx.fillEEO) return undefined;
      const g = (ctx.profile.eeo?.gender || "").toLowerCase();
      if (!g) return undefined;
      if (g.startsWith("m")) return "Male";
      if (g.startsWith("f") || g.startsWith("w")) return "Female";
      return "Decline To Self Identify";
    }
    return undefined;
  },
};

ADAPTERS.push(greenhouseAdapter);
