import { copyFile, lstat } from "node:fs/promises";
import { hashFile, extractPdf } from "../interchange/pdf";
import { normalizeDoi, titleSimilarity } from "../../shared/domain";
import { AppError, type Work } from "../../shared/types";
import { downloadedPdfs } from "./chrome";

type Document = Awaited<ReturnType<typeof extractPdf>>;
type LocalPdf = { path: string; hash: string; size: number; mtime: number; document: Document };
export function isAuxiliaryPdf(document: Pick<Document, "title" | "text">) {
  const auxiliary = /^(?:correction to\b|corrigendum\b|erratum\b|supplement(?:ary|al)?(?:\s+information|\s+material|\s+data)?\b|supporting information\b)/i;
  return auxiliary.test(document.title.trim()) || auxiliary.test(document.text.replace(/^\s*\d*\s*/, ""));
}
export function matchesDownloadedPdf(document: Document, work: Work) {
  if (!document.pages || isAuxiliaryPdf(document)) return false;
  const score = titleSimilarity(document.title, work.title);
  const doi = normalizeDoi(work.doi);
  const dois = document.dois.map(normalizeDoi).filter(Boolean);
  const doiMatch = !!doi && dois.includes(doi);
  return (doiMatch && score >= 0.5) || (score >= 0.9 && (!dois.length || doiMatch));
}
export class LocalDownloads {
  private files = new Map<string, LocalPdf>();
  constructor(private worker: string) {}
  async scan(directories: string[], signal: AbortSignal) {
    const files = await downloadedPdfs(directories);
    for (const path of this.files.keys()) if (!files.has(path)) this.files.delete(path);
    const byHash = new Map([...this.files.values()].map(file => [file.hash, file.document]));
    for (const [path, stamp] of files) {
      signal.throwIfAborted();
      const cached = this.files.get(path);
      if (cached?.size === stamp.size && cached.mtime === stamp.mtime) continue;
      this.files.delete(path);
      if (Date.now() - stamp.mtime < 1000) continue;
      try {
        const hash = await hashFile(path, signal);
        const document = byHash.get(hash) || await extractPdf(path, this.worker, signal);
        signal.throwIfAborted();
        const after = await lstat(path);
        if (!after.isFile() || after.size !== stamp.size || after.mtimeMs !== stamp.mtime) continue;
        this.files.set(path, {path, hash, ...stamp, document});
        byHash.set(hash, document);
      } catch { signal.throwIfAborted(); }
    }
  }
  async copyFor(work: Work, targets: Work[], destination: string, signal: AbortSignal) {
    const candidates = [...this.files.values()].filter(file => matchesDownloadedPdf(file.document, work) && targets.filter(other => matchesDownloadedPdf(file.document, other)).length === 1)
      .sort((a, b) => b.mtime - a.mtime);
    let copyError: AppError | undefined;
    for (const file of candidates) {
      signal.throwIfAborted();
      try {
        await copyFile(file.path, destination);
        if (await hashFile(destination, signal) !== file.hash) { this.files.delete(file.path); continue; }
        return file.path;
      } catch (error) {
        signal.throwIfAborted();
        copyError = new AppError('DOWNLOAD_COPY', `다운로드된 PDF를 저장소에 복사하지 못했습니다 (${(error as NodeJS.ErrnoException).code || '파일 접근 오류'}). 원본은 유지되며 자동으로 다시 시도합니다.`);
      }
    }
    if (copyError) throw copyError;
    return null;
  }
}
