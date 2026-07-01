/**
 * Generates a small but VALID one-page PDF résumé (correct xref offsets) plus a
 * plaintext copy, used as sample upload data for the file-injection test. No deps.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));

const LINES = [
  "John Doe",
  "Software Engineer  |  john@example.com  |  +1 555 555 5555",
  "Ottawa, ON, Canada  |  linkedin.com/in/johndoe  |  github.com/johndoe",
  "",
  "EXPERIENCE",
  "Software Engineer Intern, Example Company (May 2025 - Aug 2025)",
  "  Built full-stack features using React, Node.js, and PostgreSQL.",
  "",
  "EDUCATION",
  "BSc Computer Science, University of Ottawa (2026)",
  "",
  "SKILLS",
  "JavaScript, TypeScript, React, Node.js, Python, PostgreSQL",
];

function pdfEscape(s) {
  return s.replace(/([()\\])/g, "\\$1");
}

function buildPdf(lines) {
  let text = "BT /F1 14 Tf 72 760 Td 18 TL\n";
  for (const line of lines) text += `(${pdfEscape(line)}) Tj T*\n`;
  text += "ET";

  const objects = [
    `<< /Type /Catalog /Pages 2 0 R >>`,
    `<< /Type /Pages /Kids [3 0 R] /Count 1 >>`,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>`,
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`,
  ];

  let pdf = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return Buffer.from(pdf, "latin1");
}

const pdf = buildPdf(LINES);
writeFileSync(path.join(here, "sample-resume.pdf"), pdf);
writeFileSync(path.join(here, "sample-resume.txt"), LINES.join("\n"), "utf8");
console.log(`Wrote sample-resume.pdf (${pdf.length} bytes) and sample-resume.txt`);
