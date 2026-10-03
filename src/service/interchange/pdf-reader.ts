import { open, stat } from "node:fs/promises";
import type { Library } from "../db/database";
import { AppError } from "../../shared/types";
import type { ArticleContext } from "../../shared/chat";
import { extractPdf, hashFile, verifyPdf } from "./pdf";

const MAX_PDF_SIZE = 100 * 1024 * 1024;
export interface PdfTarget { projectId: string; workId: string; attachmentId: string }

export function bodyWithoutReferences(text: string) {
  // Require a complete heading on its own line, late enough to avoid the title/TOC.
  const heading = /^(?:\d{1,2}[.)]?\s+)?(?:references(?:\s+(?:and|&)\s+notes)?|bibliography|literature cited|참\s*고\s*문\s*헌)\s*[:.]?\s*$/gim;
  for (const match of text.matchAll(heading)) {
    const prefix = text.slice(0, match.index);
    if (prefix.trim().length < 200 || match.index! < text.length * 0.25) continue;
    return { text: prefix.trim(), referencesExcluded: true };
  }
  return { text: text.trim(), referencesExcluded: false };
}

export class PdfReader {
  constructor(private db: Library, private workerPath: string) {}
  attachment(target: PdfTarget) {
    this.db.project(target.projectId);
    this.db.get(target.workId);
    const member = this.db.db.prepare("SELECT 1 FROM project_works WHERE project_id=? AND work_id=?").get(target.projectId, target.workId);
    if (!member) throw new AppError("PDF_SCOPE", "현재 프로젝트에 속한 문헌이 아닙니다.");
    const attachment = this.db.attachment(target.attachmentId);
    if (attachment.workId !== target.workId) throw new AppError("PDF_SCOPE", "선택한 논문의 첨부 파일이 아닙니다.");
    return attachment;
  }
  async info(target: PdfTarget) {
    const a = this.attachment(target);
    const size = (await stat(a.path).catch(() => { throw new AppError("PDF_MISSING", "PDF 연결이 끊겼습니다. 문헌 상세의 노트에서 파일을 재연결하세요."); })).size;
    if (size > MAX_PDF_SIZE) throw new AppError("PDF_SIZE", "앱 안에서는 100MB 이하의 PDF를 열 수 있습니다. 외부 앱으로 열어 주세요.");
    await verifyPdf(a.path);
    if (await hashFile(a.path) !== a.hash) throw new AppError("PDF_CHANGED", "첨부 PDF의 내용이 변경되었습니다. 새 첨부로 등록하세요.");
    return { attachmentId: a.id, name: a.name, size, hash: a.hash };
  }
  async chunk(target: PdfTarget & { offset: number; length: number }) {
    const a = this.attachment(target);
    const file = await open(a.path, "r");
    try {
      const size = (await file.stat()).size;
      if (size > MAX_PDF_SIZE || target.offset >= size) throw new AppError("PDF_RANGE", "PDF 읽기 범위를 확인하세요.");
      const data = Buffer.alloc(Math.min(target.length, size - target.offset));
      const { bytesRead } = await file.read(data, 0, data.length, target.offset);
      return { base64: data.subarray(0, bytesRead).toString("base64"), bytesRead };
    } finally { await file.close(); }
  }
  async context(target: PdfTarget, signal: AbortSignal): Promise<ArticleContext> {
    const info = await this.info(target);
    signal.throwIfAborted();
    const a = this.attachment(target);
    const result = await extractPdf(a.path, this.workerPath, signal, "fulltext");
    signal.throwIfAborted();
    if (result.status !== "extracted" || !result.pages || !result.text.trim()) throw new AppError("PDF_TEXT", "PDF 본문을 추출할 수 없습니다. 스캔·암호화 파일 또는 추출 한도를 확인하세요. 초록 대화는 탐색 화면에서 이용할 수 있습니다.");
    if (await hashFile(a.path, signal) !== info.hash) throw new AppError("PDF_CHANGED", "추출 중 PDF가 변경되었습니다. 다시 열어 주세요.");
    const body = bodyWithoutReferences(result.text);
    const notice = [body.referencesExcluded ? "참고문헌 제목 이후를 AI 문맥에서 제외했습니다." : "참고문헌 경계를 확인하지 못해 추출된 텍스트 전체를 사용합니다.", result.emptyPages ? `텍스트가 없는 ${result.emptyPages}페이지는 AI가 읽지 못합니다.` : "", "표·그림의 시각 정보는 포함되지 않습니다."].filter(Boolean).join(" ");
    return { kind: "pdf-fulltext", workId: target.workId, title: this.db.get(target.workId).title, attachmentId: a.id, attachmentHash: info.hash, pageCount: result.pages, ...body, notice };
  }
}
