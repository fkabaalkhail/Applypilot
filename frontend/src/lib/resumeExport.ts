// Export a structured ResumeDocument to PDF and DOCX from the SAME schema +
// theme the renderer uses, so both downloads match the on-screen preview.
//
//  - PDF  : prints the exact rendered DOM node (passed in by the caller) into a
//           pop-up sized with @page. Real selectable text → ATS-friendly, and
//           pixel-identical to the preview because it IS the preview node.
//  - DOCX : built with docx.js from the document + theme tokens (fonts, sizes,
//           spacing, accent). An editable, faithful mirror of the template.

import {
  AlignmentType,
  BorderStyle,
  Document,
  Packer,
  Paragraph,
  TabStopType,
  TextRun,
} from "docx";
import type { ResumeDocument, Section, Theme } from "./resumeDocument";

const PT = 20; // twips per point
const HALF = (pt: number) => Math.round(pt * 2); // docx run size unit (half-points)
const hex = (c: string) => c.replace("#", "");
const firstFont = (family: string) => (family.split(",")[0] || "Calibri").replace(/['"]/g, "").trim();

const PAGE_TWIPS: Record<Theme["page_size"], { width: number; height: number }> = {
  letter: { width: 12240, height: 15840 },
  a4: { width: 11906, height: 16838 },
};
const MARGIN = { top: 720, bottom: 720, left: 864, right: 864 }; // 0.5in / 0.6in

function triggerDownload(blob: Blob, filename: string, ext: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename.toLowerCase().endsWith(ext) ? filename : `${filename}${ext}`;
  a.click();
  URL.revokeObjectURL(url);
}

// ── PDF (print the exact preview node) ──────────────────────────────────────

export function printResume(node: HTMLElement, pageSize: Theme["page_size"] = "letter") {
  const win = window.open("", "_blank", "width=900,height=1200");
  if (!win) {
    alert("Please allow pop-ups for this site to download the PDF.");
    return;
  }
  const html = node.outerHTML;
  win.document.write(
    `<!doctype html><html><head><meta charset="utf-8"><title>Resume</title>` +
      `<style>@page{size:${pageSize};margin:0;}html,body{margin:0;padding:0;background:#fff;}` +
      `[data-resume-page]{box-shadow:none !important;margin:0 auto !important;}` +
      // Strip the on-screen keyword heatmap so downloads never carry highlights.
      `mark{background:transparent !important;padding:0 !important;}</style>` +
      `</head><body>${html}</body></html>`
  );
  win.document.close();
  let done = false;
  const go = () => {
    if (done) return;
    done = true;
    win.focus();
    win.print();
  };
  win.onload = go;
  setTimeout(go, 400);
}

// ── DOCX (build from schema + theme) ────────────────────────────────────────

function sectionParagraphs(section: Section, theme: Theme, rightTab: number): Paragraph[] {
  const out: Paragraph[] = [];
  const accent = hex(theme.accent_color);

  out.push(
    new Paragraph({
      spacing: { before: theme.section_spacing_pt * PT, after: 3 * PT },
      border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: accent, space: 1 } },
      children: [
        new TextRun({
          text: (section.title || section.type).toUpperCase(),
          bold: true,
          size: HALF(theme.heading_font_pt),
          color: accent,
        }),
      ],
    })
  );

  if ((section.type === "summary" || section.type === "custom") && section.text) {
    for (const para of section.text.split("\n")) {
      if (para.trim()) out.push(new Paragraph({ children: [new TextRun(para.trim())] }));
    }
  }

  const skills = section.skills.filter((s) => s.trim());
  if (skills.length) {
    out.push(new Paragraph({ children: [new TextRun(skills.join(", "))] }));
  }

  for (const [category, items] of Object.entries(section.groups || {})) {
    const vals = items.filter((x) => x.trim());
    if (!vals.length) continue;
    out.push(
      new Paragraph({
        children: [
          new TextRun({ text: `${category}: `, bold: true }),
          new TextRun(vals.join(", ")),
        ],
      })
    );
  }

  for (const item of section.items) {
    const dates = [item.start_date, item.end_date].filter(Boolean).join(" – ");
    out.push(
      new Paragraph({
        tabStops: [{ type: TabStopType.RIGHT, position: rightTab }],
        spacing: { before: 4 * PT },
        children: [
          new TextRun({ text: item.title || "", bold: true }),
          ...(dates ? [new TextRun({ text: `\t${dates}`, color: "4b5563" })] : []),
        ],
      })
    );
    const second = [item.subtitle, item.location].filter(Boolean).join("  •  ");
    if (second || item.link) {
      const runs: TextRun[] = [];
      if (second) runs.push(new TextRun({ text: second, italics: true, color: "374151" }));
      if (item.link)
        runs.push(new TextRun({ text: `${second ? "  •  " : ""}${item.link}`, color: accent }));
      out.push(new Paragraph({ children: runs }));
    }
    if (item.detail) out.push(new Paragraph({ children: [new TextRun({ text: item.detail, color: "374151" })] }));
    for (const b of item.bullets) {
      if (b.trim()) out.push(new Paragraph({ bullet: { level: 0 }, children: [new TextRun(b.trim())] }));
    }
  }

  return out;
}

export async function downloadResumeDocx(doc: ResumeDocument, filename: string) {
  const theme = doc.theme;
  const page = PAGE_TWIPS[theme.page_size] ?? PAGE_TWIPS.letter;
  const rightTab = page.width - MARGIN.left - MARGIN.right;
  const h = doc.header;

  const children: Paragraph[] = [
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [
        new TextRun({
          text: h.name || "Your Name",
          bold: true,
          size: HALF(theme.name_font_pt),
          color: hex(theme.accent_color),
        }),
      ],
    }),
  ];
  const contact = [h.location, h.email, h.phone].filter(Boolean).join("  •  ");
  if (contact)
    children.push(new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun(contact)] }));
  const links = [h.linkedin_url, h.github_url, h.other_link].filter(Boolean).join("  •  ");
  if (links)
    children.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new TextRun({ text: links, color: hex(theme.accent_color) })],
      })
    );

  for (const section of doc.sections) children.push(...sectionParagraphs(section, theme, rightTab));

  const document = new Document({
    styles: {
      default: {
        document: {
          run: { font: firstFont(theme.font_family), size: HALF(theme.base_font_pt), color: hex(theme.text_color) },
          paragraph: { spacing: { line: Math.round(240 * theme.line_height), after: 0 } },
        },
      },
    },
    sections: [
      {
        properties: { page: { size: { width: page.width, height: page.height }, margin: MARGIN } },
        children,
      },
    ],
  });

  const blob = await Packer.toBlob(document);
  triggerDownload(blob, filename, ".docx");
}
