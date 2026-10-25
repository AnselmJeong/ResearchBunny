import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access, chmod, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** ResearchBunny's own Claude sign-in, kept apart from the user's Claude Code login and out of library backups. */
export const CLAUDE_HOME_DIR = join(
  process.env.RESEARCHBUNNY_DATA_DIR ??
    join(homedir(), "Library", "Application Support", "ResearchBunny"),
  "claude",
);

export async function findClaudeCommand(
  candidates: string[] = [
    join(homedir(), ".local/bin/claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
    ...[join(homedir(), ".bun/bin"), ...(process.env.PATH ?? "").split(":").filter(Boolean)].map((dir) => join(dir, "claude")),
  ],
): Promise<string[]> {
  for (const path of new Set(candidates)) {
    try {
      await access(path, constants.X_OK);
      return [path];
    } catch {
      // Next installed location.
    }
  }
  throw new Error("Claude Code CLI를 찾을 수 없습니다. 설치한 뒤 연결을 새로고침해 주세요.");
}

/** Never inherit API keys, bearer tokens, alternate endpoints or provider configuration. */
export function claudeEnvironment(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "SSL_CERT_FILE"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  env.PATH = [join(homedir(), ".local/bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", process.env.PATH ?? ""].join(":");
  env.CLAUDE_CONFIG_DIR = home;
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  return env;
}

/** Ignore user and project settings; no hooks or memory reach a request. */
export const CLAUDE_CONFIG = [
  "--setting-sources", "",
  "--settings", JSON.stringify({ disableAllHooks: true, autoMemoryEnabled: false }),
];

export async function prepareClaude(home: string, command?: string[]) {
  const resolved = command ?? (await findClaudeCommand());
  const cwd = join(home, "workspace");
  await mkdir(cwd, { recursive: true, mode: 0o700 });
  await chmod(home, 0o700);
  await chmod(cwd, 0o700);
  return { command: resolved, home, cwd };
}

export type ClaudeRuntime = Awaited<ReturnType<typeof prepareClaude>>;

/** Bounded stdout queue; cancellation also works while the process is silent. */
export class ClaudeProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly done: Promise<void>;
  private queue: string[] = [];
  private queuedBytes = 0;
  private ended = false;
  private failure?: Error;
  private wake?: () => void;
  private forceKill?: ReturnType<typeof setTimeout>;

  constructor(runtime: ClaudeRuntime, args: string[], timeoutMs: number, signal?: AbortSignal, allowNonZero = false) {
    signal?.throwIfAborted();
    this.child = spawn(runtime.command[0], [...runtime.command.slice(1), ...args], {
      cwd: runtime.cwd,
      env: claudeEnvironment(runtime.home),
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      this.queuedBytes += Buffer.byteLength(chunk);
      if (this.queuedBytes > 32 * 1024 * 1024) return this.stop(new Error("Claude 응답이 너무 큽니다."));
      this.queue.push(chunk);
      this.wake?.();
    });
    // Never log article text, credentials or sign-in URLs.
    this.child.stderr.resume();
    this.child.stdin.on("error", () => this.stop(new Error("Claude 입력 연결이 끊어졌습니다.")));
    const abort = () => this.stop(new DOMException("Claude request cancelled", "AbortError"));
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => this.stop(new Error("Claude 응답 시간이 초과되었습니다. 다시 시도해 주세요.")), timeoutMs);
    this.done = new Promise((resolve) => {
      const finish = (error?: Error) => {
        if (this.ended) return;
        this.failure ??= error;
        this.ended = true;
        clearTimeout(timer);
        clearTimeout(this.forceKill);
        signal?.removeEventListener("abort", abort);
        this.wake?.();
        resolve();
      };
      this.child.on("error", () => finish(new Error("Claude Code를 실행할 수 없습니다.")));
      this.child.on("close", (code) =>
        finish(code === 0 || allowNonZero ? undefined : new Error("Claude Code가 요청을 완료하지 못했습니다. 로그인과 사용 한도를 확인해 주세요. 유료 API로 전환하지 않았습니다.")),
      );
    });
    if (signal?.aborted) abort();
  }

  stop(error?: Error): void {
    this.failure ??= error;
    if (!this.ended && !this.forceKill) {
      this.child.kill("SIGTERM");
      this.forceKill = setTimeout(() => this.child.kill("SIGKILL"), 1_000);
      this.forceKill.unref();
    }
    this.wake?.();
  }

  async *chunks(): AsyncGenerator<string> {
    while (true) {
      if (this.failure && (!this.ended || !this.queue.length)) throw this.failure;
      const chunk = this.queue.shift();
      if (chunk !== undefined) {
        this.queuedBytes -= Buffer.byteLength(chunk);
        yield chunk;
        continue;
      }
      if (this.ended) break;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }

  async collect(): Promise<string> {
    let result = "";
    for await (const chunk of this.chunks()) {
      result += chunk;
      if (result.length > 1_000_000) {
        this.stop();
        throw new Error("Claude 상태 응답이 너무 큽니다.");
      }
    }
    return result;
  }
}
