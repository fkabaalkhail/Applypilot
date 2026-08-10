/**
 * Company logo + monogram resolver for the panel's job card. On-device only,
 * reads the page's own icons (apple-touch-icon, favicon, og:image); never calls
 * an external service. Always returns a monogram + deterministic color so the
 * card renders a clean colored initial when the page exposes no usable image
 * (or when the page CSP blocks the <img>, the caller falls back on error).
 */

export interface CompanyLogo {
  /** Best on-page logo URL (absolute), or null → render the monogram. */
  src: string | null;
  /** 1–2 uppercase initials from the company name (or "?"). */
  monogram: string;
  /** Deterministic accent color for the monogram background. */
  color: string;
}

const MONOGRAM_COLORS = [
  "#6366f1", "#0ea5e9", "#14b8a6", "#10b981", "#f59e0b",
  "#ef4444", "#ec4899", "#8b5cf6", "#f97316", "#0891b2",
];

/** djb2 hash → stable palette index, so a company always maps to one color. */
function pickColor(seed: string): string {
  let h = 5381;
  for (let i = 0; i < seed.length; i++) h = ((h << 5) + h + seed.charCodeAt(i)) | 0;
  return MONOGRAM_COLORS[Math.abs(h) % MONOGRAM_COLORS.length];
}

/** 1–2 initials: "Salesforce" → "S", "Acme Corp" → "AC". */
export function monogramOf(company: string): string {
  const words = company.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 1).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

/** Resolve a (possibly relative) href against the document base to an absolute URL. */
function absolute(doc: Document, href: string | null): string | null {
  if (!href) return null;
  try {
    return new URL(href, doc.baseURI || undefined).href;
  } catch {
    return null;
  }
}

/** The best declared icon link, apple-touch-icon (clean square) wins, else the
 *  largest favicon by declared size. Null when the page declares none. */
function iconFromLinks(doc: Document): string | null {
  const links = Array.from(
    doc.querySelectorAll<HTMLLinkElement>(
      'link[rel~="icon"], link[rel="apple-touch-icon"], link[rel="apple-touch-icon-precomposed"], link[rel="shortcut icon"]'
    )
  );
  if (links.length === 0) return null;
  const score = (l: HTMLLinkElement): number => {
    const rel = (l.getAttribute("rel") || "").toLowerCase();
    const apple = rel.includes("apple-touch-icon") ? 1000 : 0;
    const size = parseInt((l.getAttribute("sizes") || "").split("x")[0] || "", 10);
    return apple + (Number.isFinite(size) ? size : 0);
  };
  const best = links.slice().sort((a, b) => score(b) - score(a))[0];
  return absolute(doc, best.getAttribute("href"));
}

/** Resolve the job card's logo for `company` from the page in `doc`. */
export function resolveCompanyLogo(doc: Document, company: string): CompanyLogo {
  const monogram = monogramOf(company);
  const color = pickColor(company.trim().toLowerCase() || "?");
  let src: string | null = null;
  try {
    const og =
      doc.querySelector('meta[property="og:image"], meta[name="og:image"]')?.getAttribute("content") ?? null;
    src = iconFromLinks(doc) || absolute(doc, og);
  } catch {
    src = null;
  }
  return { src, monogram, color };
}
