import Database from "better-sqlite3";
import {
  mkdir,
  copyFile,
  writeFile,
  readFile,
  rename,
  rm,
  lstat,
  realpath,
} from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Library } from "../db/database";
import { AppError, type Attachment } from "../../shared/types";
import { hashFile, verifyPdf } from "./pdf";
const manifestSchema = z.object({
  format: z.literal("researchbunny-backup"),
  version: z.literal(1),
  createdAt: z.string(),
  databaseHash: z.string().regex(/^[a-f0-9]{64}$/),
  attachments: z
    .array(
      z.object({
        id: z.string().max(160),
        hash: z.string().regex(/^[a-f0-9]{64}$/),
        file: z
          .string()
          .regex(/^attachments\/[a-f0-9]{64}\.pdf$/)
          .nullable(),
        name: z.string().max(4000),
        reason: z.string().optional(),
      }),
    )
    .max(100000),
});
async function child(root: string, path: string) {
  const candidate = resolve(root, path);
  const real = await realpath(candidate);
  const base = await realpath(root);
  if (!real.startsWith(base + sep) || (await lstat(candidate)).isSymbolicLink())
    throw new AppError(
      "UNSAFE_BACKUP",
      "백업에 외부 경로나 심볼릭 링크가 있습니다.",
    );
  return real;
}
export async function createBackup(
  db: Library,
  target: string,
  includeAttachments: boolean,
  includeLinked: boolean,
) {
  try {
    await lstat(target);
    throw new AppError(
      "EXISTS",
      "같은 이름의 백업이 있습니다. 새 이름을 선택하세요.",
    );
  } catch (e) {
    if (e instanceof AppError) throw e;
  }
  const staging = target + "." + randomUUID() + ".staging";
  await mkdir(join(staging, "attachments"), { recursive: true });
  const missing: string[] = [];
  try {
    await db.db.backup(join(staging, "library.sqlite"));
    const manifest: z.infer<typeof manifestSchema> = {
      format: "researchbunny-backup",
      version: 1,
      createdAt: new Date().toISOString(),
      databaseHash: "",
      attachments: [],
    };
    const snapshot = new Database(join(staging, "library.sqlite"), {
      readonly: true,
    });
    let attachments: Attachment[];
    try {
      attachments = (
        snapshot.prepare("SELECT data FROM attachments").all() as {
          data: string;
        }[]
      ).map((r) => JSON.parse(r.data));
    } finally {
      snapshot.close();
    }
    for (const a of attachments) {
      const entry = {
        id: a.id,
        hash: a.hash,
        file: null as string | null,
        name: a.name,
        reason: "",
      };
      if (includeAttachments && (a.mode === "managed" || includeLinked)) {
        try {
          if ((await hashFile(a.path)) !== a.hash) throw new Error("hash");
          entry.file = `attachments/${a.hash}.pdf`;
          await copyFile(a.path, join(staging, entry.file));
          if ((await hashFile(join(staging, entry.file))) !== a.hash)
            throw new Error("copy hash");
        } catch {
          entry.file = null;
          entry.reason = "파일 없음 또는 해시 불일치";
          missing.push(a.name);
        }
      } else {
        entry.reason = "선택한 백업 범위에서 첨부 제외";
        missing.push(a.name);
      }
      manifest.attachments.push(entry);
    }
    manifest.databaseHash = await hashFile(join(staging, "library.sqlite"));
    await writeFile(
      join(staging, "manifest.json"),
      JSON.stringify(manifest, null, 2),
    );
    await rename(staging, target);
    return { path: target, missing };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}
export async function restoreBackup(source: string, destination: string) {
  const manifestPath = await child(source, "manifest.json");
  if ((await lstat(manifestPath)).size > 32 * 1024 * 1024)
    throw new AppError("BACKUP_SIZE", "백업 manifest가 너무 큽니다.");
  const manifest = manifestSchema.parse(
    JSON.parse(await readFile(manifestPath, "utf8")),
  );
  const database = await child(source, "library.sqlite");
  if ((await hashFile(database)) !== manifest.databaseHash)
    throw new AppError(
      "BACKUP_HASH",
      "백업 DB 해시가 일치하지 않습니다. 기존 자료는 유지됩니다.",
    );
  const staging = destination + ".staging";
  const missing: string[] = [];
  await mkdir(join(staging, "attachments"), { recursive: true });
  try {
    await copyFile(database, join(staging, "library.sqlite"));
    const db = new Database(join(staging, "library.sqlite"));
    try {
      if (
        db.pragma("user_version", { simple: true }) !== 1 ||
        db.pragma("quick_check", { simple: true }) !== "ok"
      )
        throw new AppError(
          "BACKUP_SCHEMA",
          "지원하지 않거나 손상된 백업 DB입니다.",
        );
      const rows = db.prepare("SELECT id,data FROM attachments").all() as {
        id: string;
        data: string;
      }[];
      const byId = new Map(manifest.attachments.map((a) => [a.id, a]));
      for (const row of rows) {
        const a = JSON.parse(row.data) as Attachment;
        const item = byId.get(row.id);
        if (!item || item.hash !== a.hash)
          throw new AppError(
            "BACKUP_MANIFEST",
            "첨부 manifest와 DB가 일치하지 않습니다.",
          );
        if (item.file) {
          const file = await child(source, item.file);
          await verifyPdf(file);
          if ((await hashFile(file)) !== item.hash)
            throw new AppError("BACKUP_HASH", `첨부 해시 불일치: ${item.name}`);
          await copyFile(file, join(staging, "attachments", a.hash + ".pdf"));
          a.path = join(destination, "attachments", a.hash + ".pdf");
          a.mode = "managed";
          a.exists = true;
          a.status = "백업에서 복원";
        } else {
          a.path = join(destination, "missing", a.id + ".pdf");
          a.exists = false;
          a.status = "백업에서 제외됨 · 재연결 필요";
          missing.push(a.name);
        }
        db.prepare("UPDATE attachments SET data=? WHERE id=?").run(
          JSON.stringify(a),
          a.id,
        );
      }
      db.prepare("DELETE FROM preferences WHERE key LIKE 'ui:%'").run();
      db.pragma("wal_checkpoint(TRUNCATE)");
    } finally {
      db.close();
    }
    await rename(staging, destination);
    return { path: destination, missing };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}
