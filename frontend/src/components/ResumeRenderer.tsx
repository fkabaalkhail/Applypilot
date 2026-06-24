import { createContext, forwardRef, useContext, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, RefObject } from "react";
import type { ResumeDocument, Section, SectionItem, Theme } from "../lib/resumeDocument";

// The ONE renderer. Everything visible — preview, PDF (printed from this exact
// node), and the on-screen editor surface — comes from here, so they cannot
// drift apart. All resume styling is inline (theme-driven) so the node is
// self-contained and prints faithfully without external CSS.

const PAGE_DIMS: Record<Theme["page_size"], { width: string; minHeight: string }> = {
  letter: { width: "8.5in", minHeight: "11in" },
  a4: { width: "210mm", minHeight: "297mm" },
};

const pt = (n: number) => `${n}pt`;

// ── Keyword heatmap (Phase 3) ───────────────────────────────────────────────
export type HighlightTerm = { term: string; color: "green" | "yellow" };

const HILITE_BG: Record<"green" | "yellow", string> = { green: "#bbf7d0", yellow: "#fde68a" };
const HighlightContext = createContext<HighlightTerm[]>([]);
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Wraps keyword occurrences in colored marks when a heatmap is active; renders
// plain text otherwise. Word-boundary matching avoids highlighting substrings.
function HiText({ children }: { children: string }) {
  const terms = useContext(HighlightContext);
  if (!terms.length || !children) return <>{children}</>;
  const sorted = [...terms].sort((a, b) => b.term.length - a.term.length);
  const colorByLower = new Map(sorted.map((t) => [t.term.toLowerCase(), t.color] as const));
  const pattern = sorted.map((t) => escapeRe(t.term)).join("|");
  if (!pattern) return <>{children}</>;
  const re = new RegExp(`(?<![a-zA-Z0-9])(${pattern})(?![a-zA-Z0-9])`, "gi");
  const parts = children.split(re);
  return (
    <>
      {parts.map((part, i) => {
        const color = colorByLower.get(part.toLowerCase());
        return color ? (
          <mark key={i} style={{ background: HILITE_BG[color], color: "inherit", borderRadius: "2px", padding: "0 1px" }}>
            {part}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        );
      })}
    </>
  );
}

function Header({ doc }: { doc: ResumeDocument }) {
  const { header: h, theme } = doc;
  const line = (parts: string[]) => parts.filter(Boolean).join("  •  ");
  const contact = line([h.location, h.email, h.phone]);
  const links = [h.linkedin_url, h.github_url, h.other_link].filter(Boolean);
  return (
    <div style={{ textAlign: "center", marginBottom: pt(theme.section_spacing_pt) }}>
      <div
        style={{
          fontSize: pt(theme.name_font_pt),
          fontWeight: 700,
          letterSpacing: "0.5px",
          color: theme.accent_color,
        }}
      >
        {h.name || "Your Name"}
      </div>
      {contact && (
        <div style={{ fontSize: pt(theme.base_font_pt * 0.95), marginTop: pt(2) }}>{contact}</div>
      )}
      {links.length > 0 && (
        <div style={{ fontSize: pt(theme.base_font_pt * 0.95), marginTop: pt(1) }}>
          {links.map((l, i) => (
            <span key={i}>
              {i > 0 && "  •  "}
              <span style={{ color: theme.accent_color }}>{l}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function SectionHeading({ title, theme }: { title: string; theme: Theme }) {
  return (
    <div
      style={{
        fontSize: pt(theme.heading_font_pt),
        fontWeight: 700,
        textTransform: "uppercase",
        letterSpacing: "0.6px",
        color: theme.accent_color,
        borderBottom: `1px solid ${theme.accent_color}`,
        paddingBottom: pt(2),
        marginBottom: pt(5),
        breakAfter: "avoid",
        breakInside: "avoid",
      }}
    >
      {title}
    </div>
  );
}

function Bullets({ bullets }: { bullets: string[] }) {
  const items = bullets.filter((b) => b.trim());
  if (!items.length) return null;
  return (
    <ul style={{ margin: `${pt(2)} 0 0`, paddingLeft: pt(15), listStyleType: "disc" }}>
      {items.map((b, i) => (
        <li key={i} style={{ marginBottom: pt(1.5) }}>
          <HiText>{b}</HiText>
        </li>
      ))}
    </ul>
  );
}

function EntryItem({ item, theme }: { item: SectionItem; theme: Theme }) {
  const dates = [item.start_date, item.end_date].filter(Boolean).join(" – ");
  const secondLine = [item.subtitle, item.location].filter(Boolean).join("  •  ");
  return (
    <div style={{ breakInside: "avoid", marginBottom: pt(6) }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: pt(12), alignItems: "baseline" }}>
        <span style={{ fontWeight: 700 }}><HiText>{item.title}</HiText></span>
        {dates && <span style={{ whiteSpace: "nowrap", color: "#4b5563" }}>{dates}</span>}
      </div>
      {(secondLine || item.link) && (
        <div style={{ fontStyle: "italic", color: "#374151" }}>
          <HiText>{secondLine}</HiText>
          {item.link && (
            <>
              {secondLine && "  •  "}
              <span style={{ color: theme.accent_color, fontStyle: "normal" }}>{item.link}</span>
            </>
          )}
        </div>
      )}
      {item.detail && <div style={{ color: "#374151" }}><HiText>{item.detail}</HiText></div>}
      <Bullets bullets={item.bullets} />
    </div>
  );
}

function SectionBlock({ section, theme }: { section: Section; theme: Theme }) {
  return (
    <div style={{ marginTop: pt(theme.section_spacing_pt) }}>
      <SectionHeading title={section.title || section.type} theme={theme} />

      {(section.type === "summary" || section.type === "custom") &&
        section.text.split("\n").map((p, i) =>
          p.trim() ? (
            <p key={i} style={{ margin: `0 0 ${pt(3)}` }}>
              <HiText>{p}</HiText>
            </p>
          ) : null
        )}

      {section.skills.filter((s) => s.trim()).length > 0 && (
        <div><HiText>{section.skills.filter((s) => s.trim()).join(", ")}</HiText></div>
      )}

      {Object.entries(section.groups || {}).map(([category, items]) => {
        const vals = items.filter((x) => x.trim());
        return vals.length ? (
          <div key={category} style={{ marginBottom: pt(2) }}>
            <span style={{ fontWeight: 700 }}>{category}: </span>
            <HiText>{vals.join(", ")}</HiText>
          </div>
        ) : null;
      })}

      {section.items.map((item) => (
        <EntryItem key={item.id} item={item} theme={theme} />
      ))}
    </div>
  );
}

interface ResumeRendererProps {
  document: ResumeDocument;
  /** Screen-only chrome (page shadow, centered, light bg). Off for print/export. */
  screen?: boolean;
  style?: CSSProperties;
  /** When set, keyword occurrences are highlighted (the ATS heatmap). */
  highlightTerms?: HighlightTerm[];
}

/** Renders a ResumeDocument as a paginated, print-ready page. */
const ResumeRenderer = forwardRef<HTMLDivElement, ResumeRendererProps>(
  ({ document: doc, screen = true, style, highlightTerms }, ref) => {
    const theme = doc.theme;
    const dims = PAGE_DIMS[theme.page_size] ?? PAGE_DIMS.letter;
    const pageStyle: CSSProperties = {
      width: dims.width,
      minHeight: dims.minHeight,
      boxSizing: "border-box",
      padding: "0.5in 0.6in",
      background: "#ffffff",
      color: theme.text_color,
      fontFamily: theme.font_family,
      fontSize: pt(theme.base_font_pt),
      lineHeight: theme.line_height,
      ...(screen ? { margin: "0 auto", boxShadow: "0 1px 8px rgba(0,0,0,0.15)" } : {}),
      ...style,
    };
    return (
      <HighlightContext.Provider value={highlightTerms ?? []}>
        <div ref={ref} style={pageStyle} data-resume-page>
          <Header doc={doc} />
          {doc.sections.map((section) => (
            <SectionBlock key={section.id} section={section} theme={theme} />
          ))}
        </div>
      </HighlightContext.Provider>
    );
  }
);

ResumeRenderer.displayName = "ResumeRenderer";

export default ResumeRenderer;

/**
 * Renders the resume page scaled to fit the available container width. The
 * unscaled page node (via `innerRef`) is what gets printed to PDF, so the export
 * stays exact. Shared by the dashboard modal preview and the visual editor.
 */
export function FittedResume({
  document: doc,
  innerRef,
  highlightTerms,
}: {
  document: ResumeDocument;
  innerRef?: RefObject<HTMLDivElement>;
  highlightTerms?: HighlightTerm[];
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const localRef = useRef<HTMLDivElement>(null);
  const pageRef = innerRef ?? localRef;
  const [scale, setScale] = useState(1);
  const [height, setHeight] = useState<number | undefined>(undefined);

  useLayoutEffect(() => {
    const compute = () => {
      const wrap = wrapRef.current;
      const page = pageRef.current;
      if (!wrap || !page) return;
      const pageW = page.offsetWidth || 816;
      const s = Math.min(1, wrap.clientWidth / pageW);
      setScale(s);
      setHeight(page.offsetHeight * s);
    };
    compute();
    const ro = new ResizeObserver(compute);
    if (wrapRef.current) ro.observe(wrapRef.current);
    if (pageRef.current) ro.observe(pageRef.current);
    return () => ro.disconnect();
  }, [doc, pageRef]);

  return (
    <div ref={wrapRef} style={{ overflow: "hidden" }}>
      <div style={{ height }}>
        <div style={{ transform: `scale(${scale})`, transformOrigin: "top left", display: "inline-block" }}>
          <ResumeRenderer
            ref={pageRef}
            document={doc}
            screen={false}
            highlightTerms={highlightTerms}
            style={{ boxShadow: "0 1px 8px rgba(30, 20, 70, 0.12)" }}
          />
        </div>
      </div>
    </div>
  );
}
