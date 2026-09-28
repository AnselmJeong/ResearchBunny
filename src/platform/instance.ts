import { createServer, createConnection } from "node:net";
import {
  existsSync,
  readlinkSync,
  unlinkSync,
  openSync,
  closeSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { dlopen, FFIType } from "bun:ffi";
import { AppError } from "../shared/types";

const libc = dlopen("/usr/lib/libSystem.B.dylib", {
  flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
});
let lockFd: number | undefined;
export async function acquireInstance(
  root: string,
  activate: () => void,
): Promise<boolean> {
  const oldLock = join(root, "SingletonLock");
  try {
    const pid = Number(readlinkSync(oldLock).split("-").at(-1));
    if (pid > 0) {
      try {
        process.kill(pid, 0);
        throw new AppError(
          "ALREADY_RUNNING",
          "기존 ResearchBunny를 종료한 뒤 다시 실행하세요.",
        );
      } catch (error) {
        if (
          error instanceof AppError ||
          (error as NodeJS.ErrnoException).code !== "ESRCH"
        )
          throw error;
      }
    }
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code !== "ENOENT" &&
      (error as NodeJS.ErrnoException).code !== "EINVAL"
    )
      throw error;
  }
  const path = join(
    tmpdir(),
    `researchbunny-${createHash("sha256").update(root).digest("hex").slice(0, 24)}.sock`,
  );
  lockFd = openSync(join(root, ".electrobun.lock"), "a", 0o600);
  if (libc.symbols.flock(lockFd, 2 | 4) !== 0) {
    closeSync(lockFd);
    lockFd = undefined;
    const client = createConnection(path);
    client.once("connect", () => client.end());
    client.once("error", () => client.destroy());
    client.setTimeout(500, () => client.destroy());
    return false;
  }
  process.once("exit", () => {
    if (lockFd !== undefined) closeSync(lockFd);
  });
  if (existsSync(path)) {
    try {
      unlinkSync(path);
    } catch {
      /* Another instance may have removed a stale socket. */
    }
  }
  const server = createServer((socket) => {
    activate();
    socket.end();
  });
  return await new Promise<boolean>((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) =>
      error.code === "EADDRINUSE" ? resolve(false) : reject(error),
    );
    server.listen(path, () => {
      process.once("exit", () => {
        try {
          unlinkSync(path);
        } catch {
          /* Already removed. */
        }
      });
      resolve(true);
    });
  });
}
