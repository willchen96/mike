export interface StructureNode {
  id: string;
  title: string;
  level: number;
  page_number: number | null;
  children: StructureNode[];
}

export async function extractStructureTree(
  content: ArrayBuffer | Buffer,
  fileType: string,
): Promise<StructureNode[] | null> {
  try {
    const ft = fileType.toLowerCase();
    if (ft === "pdf") {
      return await extractPdfOutline(content);
    } else if (ft === "docx" || ft === "doc") {
      return await extractDocxHeadings(content);
    }
    return null;
  } catch {
    return null;
  }
}

async function extractDocxHeadings(
  content: ArrayBuffer | Buffer,
): Promise<StructureNode[] | null> {
  try {
    const mammoth = await import("mammoth");
    const { value: html } = await mammoth.convertToHtml({
      buffer: Buffer.isBuffer(content) ? content : Buffer.from(content),
    });
    const headingRegex = /<(h[1-6])[^>]*>(.*?)<\/\1>/gi;
    const nodes: StructureNode[] = [];
    let match: RegExpExecArray | null;
    let idx = 0;
    while ((match = headingRegex.exec(html)) !== null) {
      const level = parseInt(match[1].slice(1), 10);
      const title = match[2].replace(/<[^>]+>/g, "").trim().slice(0, 120);
      if (!title) continue;
      nodes.push({
        id: `h${level}-${idx++}`,
        title,
        level,
        page_number: null,
        children: [],
      });
    }
    return nodes.length ? nodes : null;
  } catch {
    return null;
  }
}

async function extractPdfOutline(
  content: ArrayBuffer | Buffer,
): Promise<StructureNode[] | null> {
  try {
    const buf = Buffer.isBuffer(content)
      ? (content.buffer.slice(
          content.byteOffset,
          content.byteOffset + content.byteLength,
        ) as ArrayBuffer)
      : content;
    const pdfjsLib = await import(
      "pdfjs-dist/legacy/build/pdf.mjs" as string
    );
    const pdf = await (
      pdfjsLib as unknown as {
        getDocument: (opts: unknown) => {
          promise: Promise<{
            numPages: number;
            getOutline: () => Promise<{ title?: string }[]>;
          }>;
        };
      }
    ).getDocument({ data: new Uint8Array(buf) }).promise;
    if (pdf.numPages <= 5) return null;
    const outline = await pdf.getOutline();
    if (outline?.length) {
      return outline.map((item, i) => ({
        id: `h1-${i}`,
        title: item.title ?? `Item ${i + 1}`,
        level: 1,
        page_number: null,
        children: [],
      }));
    }
    return Array.from({ length: pdf.numPages }, (_, i) => ({
      id: `page-${i + 1}`,
      title: `Page ${i + 1}`,
      level: 1,
      page_number: i + 1,
      children: [],
    }));
  } catch {
    return null;
  }
}
