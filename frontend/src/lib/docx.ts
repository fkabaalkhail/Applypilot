// Build and download a real .docx from plain text (resume / cover letter).
// Headers (short ALL-CAPS lines) become bold headings; "- " lines become bullets.
import { Document, Packer, Paragraph, TextRun } from "docx";

function isHeader(line: string): boolean {
  const t = line.trim();
  if (!t || t.length > 48) return false;
  // Mostly-uppercase line with letters and no sentence punctuation → section header.
  return /[A-Z]/.test(t) && t === t.toUpperCase() && !/[.!?]$/.test(t);
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename.toLowerCase().endsWith(".docx") ? filename : `${filename}.docx`;
  a.click();
  URL.revokeObjectURL(url);
}

export async function downloadDocx(filename: string, text: string, opts?: { title?: string }) {
  const lines = (text || "").replace(/\r\n/g, "\n").split("\n");
  const children: Paragraph[] = [];

  if (opts?.title) {
    children.push(
      new Paragraph({
        spacing: { after: 160 },
        children: [new TextRun({ text: opts.title, bold: true, size: 32 })],
      })
    );
  }

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      children.push(new Paragraph({ children: [] }));
      continue;
    }
    if (isHeader(trimmed)) {
      children.push(
        new Paragraph({
          spacing: { before: 220, after: 80 },
          children: [new TextRun({ text: trimmed, bold: true, size: 26 })],
        })
      );
    } else if (/^[-•*]\s+/.test(trimmed)) {
      children.push(
        new Paragraph({
          bullet: { level: 0 },
          children: [new TextRun({ text: trimmed.replace(/^[-•*]\s+/, ""), size: 22 })],
        })
      );
    } else {
      children.push(new Paragraph({ children: [new TextRun({ text: trimmed, size: 22 })] }));
    }
  }

  const doc = new Document({ sections: [{ children }] });
  const blob = await Packer.toBlob(doc);
  triggerDownload(blob, filename);
}
