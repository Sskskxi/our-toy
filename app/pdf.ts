"use client";

export const PDF_MAX_BYTES = 20 * 1024 * 1024;
const PDF_MAX_PAGES = 300;

export type PdfText = {
  text: string;
  pages: number;
  readPages: number;
  truncated: boolean;
};

// Text is extracted in the browser; the server only ever receives plain text,
// exactly as with .txt attachments. pdf.js runs in a worker without XFA forms or
// scripting; v6 has no eval-based font path (the CVE-2024-4367 vector).
export async function extractPdfText(file: File, maxChars: number): Promise<PdfText> {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    "pdfjs-dist/build/pdf.worker.min.mjs",
    import.meta.url,
  ).toString();
  const task = pdfjs.getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
    enableXfa: false,
    disableFontFace: true,
    useSystemFonts: false,
    stopAtErrors: false,
  });
  let doc;
  try {
    doc = await task.promise;
  } catch (e) {
    const name = (e as { name?: string })?.name;
    throw new Error(
      name === "PasswordException"
        ? `${file.name}: 암호가 걸린 PDF는 읽을 수 없습니다.`
        : `${file.name}: PDF를 열지 못했습니다. 손상된 파일인지 확인하세요.`,
    );
  }
  try {
    const parts: string[] = [];
    let length = 0,
      readPages = 0,
      truncated = false;
    const last = Math.min(doc.numPages, PDF_MAX_PAGES);
    for (let n = 1; n <= last; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      const text = content.items
        .map((item) => ("str" in item ? item.str + (item.hasEOL ? "\n" : "") : ""))
        .join("")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      page.cleanup();
      readPages = n;
      if (!text) continue;
      const chunk = `\n\n[${n}쪽]\n${text}`;
      if (length + chunk.length > maxChars) {
        parts.push(chunk.slice(0, Math.max(0, maxChars - length)));
        truncated = true;
        break;
      }
      parts.push(chunk);
      length += chunk.length;
    }
    if (readPages < doc.numPages) truncated = true;
    const text = parts.join("").trim();
    if (text.replace(/\[\d+쪽\]/g, "").trim().length < 20)
      throw new Error(
        `${file.name}: 텍스트를 찾지 못했습니다. 스캔 이미지로 된 PDF는 지원하지 않으니 OCR 후 텍스트를 붙여넣어 주세요.`,
      );
    return { text, pages: doc.numPages, readPages, truncated };
  } finally {
    await task.destroy();
  }
}
