
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { arxivDoisIn } from "../shared/domain";
async function extract() {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const data = new Uint8Array(await readFile(process.argv[2]));
  const loading = getDocument({
    data,
    useSystemFonts: false,
    disableFontFace: true,
    useWorkerFetch: false,
    standardFontDataUrl:
      join(
        dirname(require.resolve("pdfjs-dist/package.json")),
        "standard_fonts",
      ) + "/",
  });
  try {
    const pdf = await loading.promise;
    if (process.argv[3] === "passages") {
      // Lines with their position and size; the service finds paragraphs, headings and running heads.
      const limit = Math.min(pdf.numPages, 1000);
      const pages: { width: number; height: number; lines: { t: string; x: number; y: number; w: number; h: number }[] }[] = [];
      let length = 0;
      for (let n = 1; n <= limit && length < 4_000_000; n++) {
        const page = await pdf.getPage(n);
        const [x0, y0, x1, y1] = page.view;
        const content = await page.getTextContent();
        const lines: { t: string; x: number; y: number; w: number; h: number }[] = [];
        let line: { t: string; x: number; y: number; w: number; h: number } | null = null;
        for (const item of content.items) {
          if (!("str" in item)) continue;
          // Text turned more than 45° is a side stamp or watermark ("Downloaded from …"), not body text.
          if (Math.abs(item.transform[1]) > Math.abs(item.transform[0])) continue;
          const x = item.transform[4] - x0, y = item.transform[5] - y0;
          const h = Math.abs(item.height) || Math.hypot(item.transform[2], item.transform[3]);
          if (item.str) {
            const gap = line ? x - (line.x + line.w) : 0;
            // Superscripts sit within the line's height; a gap wider than 1.5 em is a column gutter or a table cell.
            if (line && Math.abs(y - line.y) <= Math.max(2, Math.max(h, line.h) * 0.6) && gap >= -Math.max(h, line.h) * 3 && gap <= Math.max(h, line.h) * 1.5) {
              line.t += (gap > Math.min(h, line.h) * 0.15 && !line.t.endsWith(" ") && !item.str.startsWith(" ") ? " " : "") + item.str;
              line.w = Math.max(line.w, x + item.width - line.x);
              line.h = Math.max(line.h, h);
            } else {
              if (line?.t.trim()) lines.push(line);
              line = { t: item.str, x, y, w: item.width, h };
            }
          }
          if (item.hasEOL && line) {
            if (line.t.trim()) lines.push(line);
            line = null;
          }
        }
        if (line?.t.trim()) lines.push(line);
        for (const l of lines) {
          // Unmapped glyphs come through as control characters (often NUL).
          l.t = l.t.replace(/\p{Cc}/gu, " ").replace(/\s+/g, " ").trim();
          l.x = Math.round(l.x * 10) / 10;
          l.y = Math.round(l.y * 10) / 10;
          l.w = Math.round(l.w * 10) / 10;
          l.h = Math.round(l.h * 10) / 10;
          length += l.t.length;
        }
        pages.push({ width: Math.round(x1 - x0), height: Math.round(y1 - y0), lines: lines.filter((l) => l.t) });
        page.cleanup();
      }
      process.send?.({ pages, total: pdf.numPages, status: "extracted" });
      return;
    }
    if (process.argv[3] === "fulltext") {
      if (pdf.numPages > 500) throw new Error("Full-text page limit");
      const pages: string[] = [];
      let length = 0, emptyPages = 0;
      for (let n = 1; n <= pdf.numPages; n++) {
        const page = await pdf.getPage(n);
        const content = await page.getTextContent();
        let text = "", lastY: number | undefined;
        for (const item of content.items) {
          if (!("str" in item)) continue;
          const y = item.transform[5];
          if (lastY !== undefined && Math.abs(y - lastY) > 2) text += "\n";
          text += item.str + (item.hasEOL ? "\n" : " ");
          lastY = item.hasEOL ? undefined : y;
        }
        if (!text.trim()) emptyPages++;
        length += text.length;
        if (length > 2_000_000) throw new Error("Full-text character limit");
        pages.push(text.trim());
        page.cleanup();
      }
      process.send?.({ title: "", authors: "", dois: [], pages: pdf.numPages, text: pages.join("\n\n"), emptyPages, status: "extracted" });
      return;
    }
    const metadata = await pdf.getMetadata();
    const page = await pdf.getPage(1);
    const content = await page.getTextContent();
    const items = content.items.filter(
      (i: any) => typeof i.str === "string",
    ) as any[];
    let text = items.map((i) => i.str).join(" ");
    if (process.argv[3] === "shelf" && pdf.numPages > 1) {
      // Shelf indexing reads two pages: many journals put the abstract or DOI on page 2.
      const second = await pdf.getPage(2);
      const more = await second.getTextContent();
      text += "\n" + (more.items as any[]).filter((i) => typeof i.str === "string").map((i) => i.str).join(" ");
      second.cleanup();
    }
    const info = metadata.info as Record<string, unknown>;
    const metadataTitle =
      typeof info.Title === "string" ? info.Title.trim() : "";
    const large = items
      .filter((i) => String(i.str).trim().length > 3 && Number(i.height) > 0)
      .sort((a, b) => b.height - a.height);
    const height = large[0]?.height || 0;
    const heading = items
      .filter(
        (i) => i.height >= height * 0.9 && String(i.str).trim().length > 2,
      )
      .slice(0, 8)
      .map((i) => i.str)
      .join(" ");
    const title =
      metadataTitle.length > 8 &&
      !/^(untitled|microsoft|word|doi:)/i.test(metadataTitle)
        ? metadataTitle
        : heading;
    // An arXiv stamp names the paper itself, so it goes ahead of DOIs that may be citations.
    const dois = [
      ...new Set([
        ...arxivDoisIn(text),
        ...(text.match(/10\.\d{4,9}\/[^\s<>"{}]+/gi) || []).map((d) =>
          d.replace(/[.,;)]+$/, ""),
        ),
      ]),
    ].slice(0, 5);
    process.send?.({
      title: title.slice(0, 1000),
      authors: typeof info.Author === "string" ? info.Author : "",
      dois,
      pages: pdf.numPages,
      text: text.slice(0, process.argv[3] === "shelf" ? 30000 : 18000),
      status: text.trim() ? "extracted" : "스캔 또는 텍스트 없음",
    });
  } finally {
    await loading.destroy();
  }
}
extract().catch(() =>
  process.send?.({
    title: "",
    authors: "",
    dois: [],
    pages: null,
    text: "",
    status: "암호화·손상 또는 텍스트 추출 실패",
  }),
);
