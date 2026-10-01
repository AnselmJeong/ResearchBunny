import { constants } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { z } from "zod";
import type { schemas } from "../../shared/contracts";
import type { Library } from "../db/database";
import {
  AppError,
  type Attachment,
  type PdfExportPreview,
  type PdfExportResult,
  type PdfExportTarget,
  type Work,
} from "../../shared/types";
import { hashFile, verifyPdf } from "./pdf";

type Selection = z.output<typeof schemas.pdfExportPreview>;
type Entry = {
  project: string;
  folder: string;
  work: Work;
  attachments: Attachment[];
};
type Plan = {
  name: string;
  targets: PdfExportTarget[];
  folders: string[];
  entries: Entry[];
};

function component(value: string, fallback: string) {
  const clean =
    value
      .normalize("NFC")
      .replace(/[\\/:<>"?*|]|\p{Cc}/gu, " - ")
      .replace(/\s+/g, " ")
      .replace(/^[. ]+|[. ]+$/g, "") || fallback;
  let result = "";
  for (const character of clean) {
    if (Buffer.byteLength(result + character) > 170) break;
    result += character;
  }
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(result)
    ? "_" + result
    : result;
}
function names() {
  const used = new Set<string>();
  return (name: string, extension = "") => {
    for (let n = 1; ; n++) {
      const candidate = `${name}${n === 1 ? "" : ` (${n})`}${extension}`;
      const key = candidate.normalize("NFKC").toLocaleLowerCase();
      if (!used.has(key)) {
        used.add(key);
        return candidate;
      }
    }
  };
}
export function pdfExportTargets(
  db: Library,
  selection: Selection,
): PdfExportTarget[] {
  db.project(selection.projectId);
  const projects =
    selection.scope === "all"
      ? db.projects()
      : [db.project(selection.projectId)];
  let selected: Set<string> | undefined;
  if (selection.scope === "selected") selected = new Set(selection.ids);
  if (selection.scope === "collection") {
    if (
      !selection.collectionId ||
      !db
        .collections(selection.projectId)
        .some((c) => c.id === selection.collectionId)
    )
      throw new AppError("INVALID", "컬렉션을 찾을 수 없습니다.");
    selected = new Set(
      (
        db.db
          .prepare("SELECT work_id FROM collection_works WHERE collection_id=?")
          .all(selection.collectionId) as { work_id: string }[]
      ).map((r) => r.work_id),
    );
  }
  return projects
    .map((project) => ({
      projectId: project.id,
      ids: (
        db.db
          .prepare(
            "SELECT work_id FROM project_works WHERE project_id=? AND json_extract(state,'$.screening')='included' ORDER BY work_id",
          )
          .all(project.id) as { work_id: string }[]
      )
        .map((r) => r.work_id)
        .filter((id) => !selected || selected.has(id)),
    }))
    .filter((target) => target.ids.length);
}
export function planPdfExport(db: Library, targets: PdfExportTarget[]): Plan {
  const folders: string[] = [],
    entries: Entry[] = [],
    projectName = names();
  const multiple = targets.length > 1;
  const seen = new Set<string>();
  for (const target of targets) {
    if (seen.has(target.projectId))
      throw new AppError("INVALID", "중복된 내보내기 프로젝트입니다.");
    seen.add(target.projectId);
    const project = db.project(target.projectId);
    const prefix = multiple
      ? projectName(component(project.name, "프로젝트"))
      : "";
    const topicName = names();
    const topics = db.db
      .prepare(
        "SELECT id,name FROM archive_topics WHERE project_id=? ORDER BY position,id",
      )
      .all(project.id) as { id: string; name: string }[];
    const topicPaths = new Map(
      topics.map((topic) => [
        topic.id,
        join(prefix, topicName(component(topic.name, "소주제"))),
      ]),
    );
    const unclassified = topicName("미분류");
    folders.push(...topicPaths.values());
    const membership = new Map(
      (
        db.db
          .prepare(
            "SELECT work_id,topic_id FROM archive_topic_works WHERE project_id=?",
          )
          .all(project.id) as { work_id: string; topic_id: string }[]
      ).map((r) => [r.work_id, r.topic_id]),
    );
    for (const id of new Set(target.ids)) {
      const state = db.db
        .prepare(
          "SELECT state FROM project_works WHERE project_id=? AND work_id=?",
        )
        .get(project.id, id) as { state: string } | undefined;
      if (!state || JSON.parse(state.state).screening !== "included")
        throw new AppError(
          "EXPORT_TARGET",
          "아카이브에서 제거되었거나 다른 프로젝트의 문헌입니다. 내보내기 범위를 다시 확인하세요.",
        );
      const folder =
        topicPaths.get(membership.get(id) || "") || join(prefix, unclassified);
      if (!folders.includes(folder)) folders.push(folder);
      const attachments = [
        ...new Map(db.attachments(id).map((a) => [a.hash, a])).values(),
      ];
      entries.push({
        project: project.name,
        folder,
        work: db.get(id),
        attachments,
      });
    }
  }
  return {
    name: multiple
      ? "ResearchBunny PDFs"
      : component(
          targets.length
            ? db.project(targets[0].projectId).name + " PDFs"
            : "PDFs",
          "PDFs",
        ),
    targets,
    folders,
    entries,
  };
}
export async function previewPdfExport(plan: Plan): Promise<PdfExportPreview> {
  let pdfCount = 0,
    withoutPdf = 0,
    unavailable = 0;
  const counts = new Map(plan.folders.map((path) => [path, 0]));
  for (const entry of plan.entries) {
    let available = 0;
    for (const attachment of entry.attachments) {
      try {
        await verifyPdf(attachment.path);
        available++;
      } catch {
        unavailable++;
      }
    }
    if (!available) withoutPdf++;
    pdfCount += available;
    counts.set(entry.folder, counts.get(entry.folder)! + available);
  }
  return {
    targets: plan.targets,
    workCount: plan.entries.length,
    pdfCount,
    withoutPdf,
    unavailable,
    folders: [...counts].map(([path, count]) => ({ path, pdfCount: count })),
  };
}
const csvCell = (value: string) =>
  `"${(/^[=+\-@\t\r]/.test(value) ? "'" + value : value).replace(/"/g, '""')}"`;
export async function exportPdfFolders(
  plan: Plan,
  parent: string,
): Promise<PdfExportResult> {
  if (!plan.entries.length)
    throw new AppError("EMPTY_EXPORT", "내보낼 아카이브 문헌이 없습니다.");
  if (
    typeof parent !== "string" ||
    !isAbsolute(parent) ||
    !(await stat(parent)).isDirectory()
  )
    throw new AppError("EXPORT_DIRECTORY", "내보낼 폴더 위치를 확인하세요.");
  const staging = await mkdtemp(join(parent, ".researchbunny-export-"));
  let destination: string | undefined;
  let pdfCount = 0,
    withoutPdf = 0,
    unavailable = 0;
  const report = [
    [
      "프로젝트",
      "소주제 폴더",
      "문헌 ID",
      "제목",
      "DOI",
      "PDF 파일",
      "결과",
      "사유",
    ],
  ];
  try {
    for (const folder of plan.folders)
      await mkdir(join(staging, folder), { recursive: true });
    const fileNames = new Map(plan.folders.map((folder) => [folder, names()]));
    for (const entry of plan.entries) {
      let copied = 0;
      const row = (file: string, status: string, reason: string) =>
        report.push([
          entry.project,
          entry.folder,
          entry.work.id,
          entry.work.title,
          entry.work.doi || "",
          file,
          status,
          reason,
        ]);
      if (!entry.attachments.length)
        row("", "PDF 없음", "첨부된 PDF가 없습니다.");
      for (const attachment of entry.attachments) {
        try {
          await verifyPdf(attachment.path);
        } catch {
          unavailable++;
          row("", "제외", "원본 PDF가 없거나 읽을 수 없습니다.");
          continue;
        }
        const title =
          attachment.name.replace(/\.pdf$/i, "") || entry.work.title;
        const file = join(
          entry.folder,
          fileNames.get(entry.folder)!(
            component(
              `${entry.work.year ? entry.work.year + " - " : ""}${title}`,
              "문헌",
            ),
            ".pdf",
          ),
        );
        const output = join(staging, file);
        try {
          await copyFile(attachment.path, output, constants.COPYFILE_EXCL);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            unavailable++;
            row("", "제외", "복사 중 원본 PDF가 사라졌습니다.");
            continue;
          }
          throw new AppError(
            "EXPORT_WRITE",
            "PDF를 내보내지 못했습니다. 저장 위치의 권한과 남은 공간을 확인하세요.",
          );
        }
        if ((await hashFile(output)) !== attachment.hash) {
          await rm(output);
          unavailable++;
          row(
            "",
            "제외",
            "원본 PDF의 내용이 등록된 첨부와 달라 복사본을 제외했습니다.",
          );
          continue;
        }
        copied++;
        pdfCount++;
        row(file, "복사 완료", "");
      }
      if (!copied) withoutPdf++;
    }
    await writeFile(
      join(staging, "내보내기 결과.csv"),
      "\uFEFF" +
        report.map((row) => row.map(csvCell).join(",")).join("\n") +
        "\n",
      { flag: "wx" },
    );
    // Reserve a new empty directory; never replace an existing export or user file.
    for (let n = 1; ; n++) {
      const candidate = join(parent, plan.name + (n === 1 ? "" : ` (${n})`));
      try {
        await mkdir(candidate);
        destination = candidate;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    await rename(staging, destination);
    return {
      path: destination,
      reportPath: join(destination, "내보내기 결과.csv"),
      workCount: plan.entries.length,
      pdfCount,
      withoutPdf,
      unavailable,
    };
  } finally {
    await rm(staging, { recursive: true, force: true });
    // If publishing failed, remove only our empty reservation, never its contents.
    if (destination) await rmdir(destination).catch(() => {});
  }
}
