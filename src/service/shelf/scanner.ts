import { lstat, readdir, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { createHash } from "node:crypto";

export interface WalkedFile {
  rel: string;
  folder: string;
  size: number;
  mtime: number;
}
export interface Walked {
  folders: string[];
  files: WalkedFile[];
}

export const folderId = (rootId: string, relPath: string) =>
  createHash("sha256").update(rootId + "/" + relPath).digest("hex").slice(0, 32);
export const parentRel = (relPath: string) =>
  relPath.includes("/") ? relPath.slice(0, relPath.lastIndexOf("/")) : relPath ? "" : null;

/** True only for an existing, readable directory; an unmounted share is offline. */
export async function rootOnline(path: string) {
  try {
    const info = await stat(path);
    if (!info.isDirectory()) return false;
    await readdir(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read-only walk: stat every PDF, never open or write anything. Hidden entries,
 * symbolic links and excluded folder names are skipped at every depth.
 */
export async function walk(root: string, exclude: string[], signal: AbortSignal): Promise<Walked> {
  const skip = new Set(exclude.map((name) => name.normalize("NFC")));
  const folders: string[] = [""];
  const pending: { rel: string; folder: string; path: string }[] = [];
  const visit = async (rel: string) => {
    signal.throwIfAborted();
    const entries = await readdir(rel ? join(root, rel) : root, { withFileTypes: true });
    for (const entry of entries) {
      // Keep on-disk names byte for byte; only the exclusion check is normalized.
      const name = entry.name;
      if (name.startsWith(".") || skip.has(name.normalize("NFC"))) continue;
      const child = rel ? `${rel}/${name}` : name;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        folders.push(child);
        await visit(child);
      } else if (entry.isFile() && extname(name).toLowerCase() === ".pdf")
        pending.push({ rel: child, folder: rel, path: join(root, child) });
    }
  };
  await visit("");
  const files: WalkedFile[] = [];
  // stat() round trips dominate on SMB; keep a few in flight.
  for (let i = 0; i < pending.length; i += 16) {
    signal.throwIfAborted();
    const batch = await Promise.all(
      pending.slice(i, i + 16).map(async (item) => {
        const info = await lstat(item.path).catch(() => null);
        return info?.isFile() ? { rel: item.rel, folder: item.folder, size: info.size, mtime: Math.trunc(info.mtimeMs) } : null;
      }),
    );
    for (const file of batch) if (file) files.push(file);
  }
  return { folders, files };
}

export interface KnownFile {
  id: string;
  rel_path: string;
  size: number;
  status: string;
}
export interface ScanPlan {
  moves: { id: string; to: WalkedFile }[];
  fresh: WalkedFile[];
  vanished: KnownFile[];
  seen: { id: string; file: WalkedFile }[];
  /** More than 20% of known files vanished: wait for the user's confirmation. */
  needsConfirm: boolean;
}

/**
 * Compare the walk with stored rows. A vanished row and a new file with the same
 * name and size are one move (intake.py keeps names); everything else waits for
 * hashing (renames) or becomes missing.
 */
export function planScan(known: KnownFile[], walked: Walked): ScanPlan {
  const byPath = new Map(known.map((row) => [row.rel_path, row]));
  const present = new Set(walked.files.map((file) => file.rel));
  const seen = walked.files.filter((file) => byPath.has(file.rel)).map((file) => ({ id: byPath.get(file.rel)!.id, file }));
  let fresh = walked.files.filter((file) => !byPath.has(file.rel));
  const vanished = known.filter((row) => !present.has(row.rel_path));
  const key = (name: string, size: number) => `${basename(name)}\u0000${size}`;
  const freshByKey = new Map<string, WalkedFile[]>();
  for (const file of fresh) freshByKey.set(key(file.rel, file.size), [...(freshByKey.get(key(file.rel, file.size)) || []), file]);
  const vanishedByKey = new Map<string, KnownFile[]>();
  for (const row of vanished) vanishedByKey.set(key(row.rel_path, row.size), [...(vanishedByKey.get(key(row.rel_path, row.size)) || []), row]);
  const moves: ScanPlan["moves"] = [];
  for (const [k, rows] of vanishedByKey) {
    const files = freshByKey.get(k);
    // Only an unambiguous pair is a move; duplicates fall back to hashing.
    if (rows.length === 1 && files?.length === 1) moves.push({ id: rows[0].id, to: files[0] });
  }
  const moved = new Set(moves.map((m) => m.id));
  const movedTo = new Set(moves.map((m) => m.to.rel));
  fresh = fresh.filter((file) => !movedTo.has(file.rel));
  const remaining = vanished.filter((row) => !moved.has(row.id));
  const active = known.filter((row) => row.status !== "missing").length;
  const newlyMissing = remaining.filter((row) => row.status !== "missing").length;
  return { moves, fresh, vanished: remaining, seen, needsConfirm: active >= 5 && newlyMissing > active * 0.2 };
}
