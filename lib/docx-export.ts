import { Document, HeadingLevel, Packer, Paragraph, TextRun } from "docx";

// Word export of a report. Covers the Markdown the models write: headings,
// bullets, numbered items, quotes, rules, code fences, tables (as text rows)
// and **bold** / `code` / links inline. Anything else stays plain text.

const HEADINGS = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
  HeadingLevel.HEADING_5,
  HeadingLevel.HEADING_6,
];

export function inlineRuns(text: string, base: { italics?: boolean; font?: string } = {}) {
  const plain = text
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, "$1 ($2)")
    .replace(/<(https?:[^>\s]+)>/g, "$1");
  const runs: TextRun[] = [];
  for (const part of plain.split(/(\*\*[^*]+\*\*|`[^`]+`)/g)) {
    if (!part) continue;
    if (/^\*\*[^*]+\*\*$/.test(part)) runs.push(new TextRun({ ...base, text: part.slice(2, -2), bold: true }));
    else if (/^`[^`]+`$/.test(part)) runs.push(new TextRun({ ...base, text: part.slice(1, -1), font: "Consolas" }));
    else runs.push(new TextRun({ ...base, text: part }));
  }
  return runs;
}

export function markdownParagraphs(markdown: string) {
  const out: Paragraph[] = [];
  let code = false;
  for (const raw of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    if (/^\s*```/.test(raw)) {
      code = !code;
      continue;
    }
    if (code) {
      out.push(new Paragraph({ children: [new TextRun({ text: raw, font: "Consolas", size: 18 })] }));
      continue;
    }
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      out.push(new Paragraph({ heading: HEADINGS[heading[1].length - 1], children: inlineRuns(heading[2]) }));
      continue;
    }
    if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) continue; // horizontal rule
    if (/^\s*\|?\s*:?-{3,}/.test(line) && /\|/.test(line)) continue; // table separator
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const cells = line.trim().slice(1, -1).split("|").map((c) => c.trim());
      out.push(new Paragraph({ children: inlineRuns(cells.join("  |  ")) }));
      continue;
    }
    const bullet = line.match(/^(\s*)[-*+]\s+(.*)$/);
    if (bullet) {
      const level = Math.min(Math.floor(bullet[1].replace(/\t/g, "  ").length / 2), 8);
      out.push(new Paragraph({ bullet: { level }, children: inlineRuns(bullet[2]) }));
      continue;
    }
    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) {
      out.push(new Paragraph({ indent: { left: 480 }, children: inlineRuns(quote[1], { italics: true }) }));
      continue;
    }
    // Numbered items keep their number as text, so references stay "1. … 2. …".
    out.push(new Paragraph({ children: inlineRuns(line.trim()) }));
  }
  return out;
}

export async function markdownToDocx(markdown: string, title: string) {
  const doc = new Document({
    title,
    creator: "우리의장난감",
    styles: { default: { document: { run: { font: "Malgun Gothic", size: 22 } } } },
    sections: [{ children: markdownParagraphs(markdown) }],
  });
  return Packer.toBuffer(doc);
}
