import { parentPort, workerData } from "node:worker_threads";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
async function extract() {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const data = new Uint8Array(await readFile(workerData.path));
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
    const metadata = await pdf.getMetadata();
    const page = await pdf.getPage(1);
    const content = await page.getTextContent();
    const items = content.items.filter(
      (i: any) => typeof i.str === "string",
    ) as any[];
    const text = items.map((i) => i.str).join(" ");
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
    const dois = [
      ...new Set(
        (text.match(/10\.\d{4,9}\/[^\s<>"{}]+/gi) || []).map((d) =>
          d.replace(/[.,;)]+$/, ""),
        ),
      ),
    ].slice(0, 5);
    parentPort!.postMessage({
      title: title.slice(0, 1000),
      authors: typeof info.Author === "string" ? info.Author : "",
      dois,
      pages: pdf.numPages,
      text: text.slice(0, 18000),
      status: text.trim() ? "extracted" : "스캔 또는 텍스트 없음",
    });
  } finally {
    await loading.destroy();
  }
}
extract().catch(() =>
  parentPort!.postMessage({
    title: "",
    authors: "",
    dois: [],
    pages: null,
    text: "",
    status: "암호화·손상 또는 텍스트 추출 실패",
  }),
);
