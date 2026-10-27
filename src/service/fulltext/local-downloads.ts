import { copyFile, lstat, readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { hashFile, extractPdf } from "../interchange/pdf";
import { AppError, type Work } from "../../shared/types";
import { matchesDownloadedPdf } from "../interchange/pdf-identity";
export { matchesDownloadedPdf, isAuxiliaryPdf } from "../interchange/pdf-identity";

/** The person's own download folders, where PDFs they save themselves land: ~/Downloads and their Chrome's chosen folder. */
export async function downloadDirectories(home = homedir()) {
  const root = join(home, 'Library/Application Support/Google/Chrome');
  const directories = new Set([join(home, 'Downloads')]);
  try {
    const state = JSON.parse(await readFile(join(root, 'Local State'), 'utf8'));
    for (const profile of Object.keys(state.profile?.info_cache || {})) {
      if (!/^(Default|Profile \d+)$/.test(profile)) continue;
      try {
        const prefs = JSON.parse(await readFile(join(root, profile, 'Preferences'), 'utf8'));
        if (typeof prefs.download?.default_directory === 'string' && prefs.download.default_directory.startsWith('/')) directories.add(prefs.download.default_directory);
      } catch (error) {
        if (['EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code || '')) throw error;
        // A profile may have been removed.
      }
    }
  } catch (error) {
    if (['EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code || ''))
      throw new AppError('DOWNLOAD_DIRECTORY', 'Chrome 저장 폴더를 자동 감지할 권한이 없습니다. 원문 찾기에서 직접 받은 PDF가 저장되는 다운로드 폴더를 한 번 선택하세요. 이후 자동으로 기억합니다.');
    if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code || ''))
      throw new AppError('DOWNLOAD_DIRECTORY', 'Chrome 저장 폴더 설정을 읽지 못했습니다. 원문 찾기에서 직접 받은 PDF가 저장되는 다운로드 폴더를 한 번 선택하세요. 이후 자동으로 기억합니다.');
  }
  return [...directories];
}
type FileStamp = { size: number; mtime: number };
export async function downloadedPdfs(directories: string[]) {
  const files = new Map<string, FileStamp>();
  let readable = false;
  for (const directory of directories) {
    const names = await readdir(directory).catch(() => null);
    if (!names) continue;
    readable = true;
    for (const name of names) {
      if (!name.toLowerCase().endsWith('.pdf')) continue;
      const path = join(directory, name), info = await lstat(path).catch(() => null);
      if (info?.isFile() && info.size > 0 && info.size <= 150 * 1024 * 1024) files.set(path, {size:info.size, mtime:info.mtimeMs});
    }
  }
  if (!readable) throw new AppError('DOWNLOAD_DIRECTORY', '다운로드 폴더에 접근하지 못했습니다. 원문 찾기의 폴더 선택에서 직접 받은 PDF가 저장되는 폴더를 지정하세요.');
  return files;
}
type Document = Awaited<ReturnType<typeof extractPdf>>;
type LocalPdf = { path: string; hash: string; size: number; mtime: number; document: Document };
export class LocalDownloads {
  private files = new Map<string, LocalPdf>();
  constructor(private worker: string) {}
  /** `complete` folders hold finished files only (browser downloads Chrome reported done), so fresh ones count too. */
  async scan(directories: string[], signal: AbortSignal, complete: string[] = []) {
    const files = await downloadedPdfs(directories);
    for (const path of this.files.keys()) if (!files.has(path)) this.files.delete(path);
    const byHash = new Map([...this.files.values()].map(file => [file.hash, file.document]));
    for (const [path, stamp] of files) {
      signal.throwIfAborted();
      const cached = this.files.get(path);
      if (cached?.size === stamp.size && cached.mtime === stamp.mtime) continue;
      this.files.delete(path);
      if (Date.now() - stamp.mtime < 1000 && !complete.some(folder => path.startsWith(folder + '/'))) continue;
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
