/** Text of a PDF, page by page, stopping at the page and character limits. */
export interface PdfText {
  pages: string[];
  /** The file has more pages, or more text, than the limits allow. */
  truncated: "pages" | "chars" | null;
}

export async function readPdfText(
  bytes: Uint8Array,
  limits: { maxPages: number; maxChars: number },
): Promise<PdfText> {
  const { getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const pages: string[] = [];
  let chars = 0;
  for (let i = 1; i <= pdf.numPages; i++) {
    if (i > limits.maxPages) return { pages, truncated: "pages" };
    const content = await (await pdf.getPage(i)).getTextContent();
    const text = content.items
      .map((item) => ("str" in item ? item.str + (item.hasEOL ? "\n" : "") : ""))
      .join("");
    chars += text.length;
    if (chars > limits.maxChars) return { pages, truncated: "chars" };
    pages.push(text);
  }
  return { pages, truncated: null };
}
