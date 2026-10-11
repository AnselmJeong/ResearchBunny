import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";

// Shared by the shelf tests: one-page PDFs with real text and a fake local Ollama.

export async function pdf(path: string, lines: string[]) {
  const stream = `BT /F1 11 Tf 40 760 Td ${lines.map((line, i) => `${i ? "0 -16 Td " : ""}(${line.replace(/[()\\]/g, "")}) Tj`).join("\n")} ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 1 /Kids [4 0 R] >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const [i, object] of objects.entries()) { offsets.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((n) => `${String(n).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  await mkdir(resolve(path, ".."), { recursive: true });
  await writeFile(path, out);
}
export const chunksOf = (text: string, size = 90) => text.match(new RegExp(`.{1,${size}}(\\s|$)`, "g"))!.map((s) => s.trim());

/** Deterministic bag-of-words embeddings so "similar" means shared words. */
export function fakeOllama() {
  let up = true;
  const stop = new Set(["title", "text", "none", "task", "search", "result", "query", "the", "and", "for", "with", "in", "of"]);
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      if (!up) return new Response("down", { status: 503 });
      const url = new URL(request.url);
      if (url.pathname === "/api/tags") return Response.json({ models: [{ name: "embeddinggemma-2:latest", digest: "969600645b5240cbf78f46456c819f38" }] });
      if (url.pathname === "/api/version") return Response.json({ version: "0.40.2" });
      if (url.pathname === "/api/embed") {
        const body = await request.json() as { input: string[] };
        return Response.json({
          embeddings: body.input.map((text) => {
            const v = new Array(64).fill(0);
            for (const t of text.toLowerCase().match(/[a-z]{3,}/g) || []) if (!stop.has(t)) v[parseInt(createHash("md5").update(t).digest("hex").slice(0, 6), 16) % 64] += 1;
            v[63] += 0.01;
            return v;
          }),
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, setUp: (value: boolean) => { up = value; }, stop: () => server.stop(true) };
}
