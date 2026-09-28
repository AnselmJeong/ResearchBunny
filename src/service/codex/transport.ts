import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access, mkdir, chmod } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import packageJson from "../../../package.json";

export type JsonObject = Record<string, unknown>;
export const object = (value: unknown): JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
export const string = (value: unknown): string =>
  typeof value === "string" ? value : "";

export const CODEX_HOME_DIR = join(
  process.env.RESEARCHBUNNY_DATA_DIR ??
    join(homedir(), "Library", "Application Support", "ResearchBunny"),
  "codex",
);

export async function findCodexCommand(): Promise<string[]> {
  const candidates = [
    join(homedir(), ".local/bin/codex"),
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
    "/Applications/Codex.app/Contents/Resources/codex",
    "/Applications/ChatGPT.app/Contents/Resources/codex",
    ...(process.env.PATH ?? "")
      .split(":")
      .filter(Boolean)
      .map((dir) => join(dir, "codex")),
  ];
  for (const path of new Set(candidates)) {
    try {
      await access(path, constants.X_OK);
      return [path];
    } catch {
      /* Try next installed location. */
    }
  }
  throw new Error(
    "Codex CLI를 찾을 수 없습니다. Codex CLI를 설치한 뒤 연결 상태를 새로고침해 주세요.",
  );
}

/** No inherited API keys, access tokens, CODEX_HOME, or provider endpoints. */
export function codexEnvironment(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    "HOME",
    "USER",
    "LOGNAME",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "NO_PROXY",
    "SSL_CERT_FILE",
  ]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  env.PATH = [
    join(homedir(), ".local/bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    process.env.PATH ?? "",
  ].join(":");
  env.CODEX_HOME = home;
  return env;
}

export const CODEX_CONFIG = [
  'forced_login_method="chatgpt"',
  'model_provider="openai"',
  'cli_auth_credentials_store="file"',
  'approval_policy="never"',
  'sandbox_mode="read-only"',
  'web_search="disabled"',
  "features.shell_tool=false",
  "features.unified_exec=false",
  "features.multi_agent=false",
  "features.apps=false",
  "features.plugins=false",
  "features.hooks=false",
  "features.code_mode=false",
  "features.code_mode_host=false",
  "features.apply_patch_freeform=false",
  "project_doc_max_bytes=0",
  "mcp_servers={}",
  "analytics.enabled=false",
  "features.view_image=false",
  "features.request_permissions_tool=false",
  "features.image_generation=false",
  "features.imagegenext=false",
  "features.memory_tool=false",
  "features.search_tool=false",
  "features.tool_search=false",
  "features.js_repl=false",
  "features.tool_suggest=false",
  "tools.update_plan.enabled=false",
  "tools.experimental_request_user_input.enabled=false",
];

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
}

export class CodexTransport {
  private child: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 0;
  private generation = 0;
  private listeners = new Set<(method: string, params: JsonObject) => void>();
  private failures = new Set<(error: Error) => void>();
  readonly cwd: string;

  constructor(
    private readonly options: {
      command?: string[];
      home?: string;
      timeoutMs?: number;
    } = {},
  ) {
    this.cwd = join(options.home ?? CODEX_HOME_DIR, "workspace");
  }

  async start(): Promise<void> {
    const generation = ++this.generation;
    const command = this.options.command ?? (await findCodexCommand());
    const home = this.options.home ?? CODEX_HOME_DIR;
    await mkdir(home, { recursive: true, mode: 0o700 });
    await mkdir(this.cwd, { recursive: true, mode: 0o700 });
    await chmod(home, 0o700);
    await chmod(this.cwd, 0o700);
    if (generation !== this.generation)
      throw new Error("Codex 연결이 취소되었습니다.");
    const child = spawn(
      command[0],
      [
        ...command.slice(1),
        "app-server",
        ...CODEX_CONFIG.flatMap((value) => ["-c", value]),
      ],
      {
        cwd: this.cwd,
        env: codexEnvironment(home),
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    this.child = child;
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (this.child !== child) return;
      buffer += chunk;
      if (buffer.length > 16 * 1024 * 1024)
        return this.close(new Error("Codex 응답이 너무 큽니다."));
      let end: number;
      while ((end = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, end).trim();
        buffer = buffer.slice(end + 1);
        if (!line) continue;
        try {
          this.receive(object(JSON.parse(line)));
        } catch {
          this.close(
            new Error(
              "Codex 응답 형식을 읽을 수 없습니다. CLI를 업데이트해 주세요.",
            ),
          );
          return;
        }
      }
    });
    // Drain diagnostics without exposing authentication URLs/tokens or manuscript text.
    child.stderr.resume();
    const closeChild = (error: Error) => {
      if (this.child === child) this.close(error);
    };
    child.stdout.on("end", () =>
      closeChild(new Error("Codex 출력이 종료되었습니다.")),
    );
    child.stdin.on("error", () =>
      closeChild(new Error("Codex 연결이 끊어졌습니다.")),
    );
    child.on("error", () =>
      closeChild(
        new Error("Codex CLI를 실행할 수 없습니다. 설치 상태를 확인해 주세요."),
      ),
    );
    child.on("exit", () =>
      closeChild(
        new Error("Codex 프로세스가 종료되었습니다. 다시 시도해 주세요."),
      ),
    );
    try {
      await this.request("initialize", {
        clientInfo: {
          name: "researchbunny",
          title: "ResearchBunny",
          version: packageJson.version,
        },
        capabilities: { experimentalApi: true },
      });
      this.send({ method: "initialized" });
    } catch (error) {
      closeChild(new Error("Codex 초기화 실패"));
      throw error;
    }
  }

  private receive(message: JsonObject): void {
    if (typeof message.method === "string") {
      if (message.id !== undefined) {
        // This integration is text-only. Never approve tool execution or token handoff.
        this.send({
          id: message.id,
          error: {
            code: -32601,
            message: "ResearchBunny does not allow Codex tool requests.",
          },
        });
      } else {
        for (const listener of this.listeners)
          listener(message.method, object(message.params));
      }
      return;
    }
    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    pending.cleanup();
    if (message.error)
      pending.reject(
        new Error(
          string(object(message.error).message) || "Codex 요청이 실패했습니다.",
        ),
      );
    else pending.resolve(message.result);
  }

  private send(message: JsonObject): void {
    if (!this.child || this.child.stdin.destroyed)
      throw new Error("Codex에 연결되어 있지 않습니다.");
    const frame = `${JSON.stringify(message)}\n`;
    if (
      Buffer.byteLength(frame) > 2 * 1024 * 1024 ||
      this.child.stdin.writableLength > 2 * 1024 * 1024
    )
      throw new Error("Codex 요청이 너무 큽니다.");
    this.child.stdin.write(frame);
  }

  request(
    method: string,
    params: JsonObject = {},
    signal?: AbortSignal,
  ): Promise<unknown> {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const fail = (error: Error) => {
        this.pending.get(id)?.cleanup();
        this.pending.delete(id);
        reject(error);
      };
      const abort = () =>
        fail(new DOMException("Codex request cancelled", "AbortError"));
      const timer = setTimeout(
        () => fail(new Error(`Codex ${method} 응답 시간이 초과되었습니다.`)),
        this.options.timeoutMs ?? 20_000,
      );
      signal?.addEventListener("abort", abort, { once: true });
      this.pending.set(id, {
        resolve,
        reject,
        cleanup: () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
        },
      });
      try {
        this.send({ id, method, params });
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  subscribe(
    listener: (method: string, params: JsonObject) => void,
    onFailure: (error: Error) => void,
  ): () => void {
    this.listeners.add(listener);
    this.failures.add(onFailure);
    return () => {
      this.listeners.delete(listener);
      this.failures.delete(onFailure);
    };
  }

  close(error = new Error("Codex 연결을 종료했습니다.")): void {
    this.generation++;
    const child = this.child;
    this.child = null;
    if (!child) return;
    child.kill();
    const killTimer = setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }, 500);
    killTimer.unref();
    child.once("exit", () => clearTimeout(killTimer));
    for (const pending of this.pending.values()) {
      pending.cleanup();
      pending.reject(error);
    }
    this.pending.clear();
    for (const callback of this.failures) callback(error);
    this.listeners.clear();
    this.failures.clear();
  }
}
