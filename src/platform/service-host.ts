import { fork, type ChildProcess } from "node:child_process";
import { AppError, type AppEvent, type Result } from "../shared/types";
import type { Secrets } from "./credentials";

export class ServiceHost {
  private child: ChildProcess | null = null;
  private nextId = 0;
  private stopping = false;
  private ready = false;
  private secrets: Secrets = {};
  private restartTimer?: ReturnType<typeof setTimeout>;
  private pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  constructor(
    private entry: string,
    private pdfWorker: string,
    private emit: (event: AppEvent) => void,
  ) {}
  get pid() {
    return this.child?.pid;
  }
  async start(root: string, secrets: Secrets) {
    this.stopping = false;
    this.ready = false;
    this.secrets = secrets;
    const child = fork(this.entry, [root, this.pdfWorker], {
      execPath: process.execPath,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      serialization: "json",
    });
    this.child = child;
    child.stdout?.resume();
    child.stderr?.resume();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new AppError("SERVICE_START", "자료 서비스를 시작하지 못했습니다."),
        );
        child.kill();
      }, 20000);
      child.on(
        "message",
        (message: {
          ready?: boolean;
          event?: AppEvent;
          id?: number;
          result?: Result<unknown>;
        }) => {
          if (message.ready) {
            clearTimeout(timer);
            resolve();
            return;
          }
          if (message.event) {
            this.emit(message.event);
            return;
          }
          const pending = this.pending.get(message.id!);
          if (!pending || !message.result) return;
          clearTimeout(pending.timer);
          this.pending.delete(message.id!);
          if (message.result.ok) pending.resolve(message.result.data);
          else
            pending.reject(
              new AppError(
                message.result.error.code,
                message.result.error.message,
                message.result.error.retryable,
              ),
            );
        },
      );
      child.once("error", () => {
        clearTimeout(timer);
        reject(
          new AppError("SERVICE_START", "자료 서비스를 시작하지 못했습니다."),
        );
      });
      child.once("exit", () => {
        clearTimeout(timer);
        if (this.child !== child) return;
        this.child = null;
        this.ready = false;
        const error = new AppError(
          "SERVICE_DOWN",
          "자료 서비스가 중단되었습니다. 저장된 자료를 다시 불러옵니다.",
          true,
        );
        for (const pending of this.pending.values()) {
          clearTimeout(pending.timer);
          pending.reject(error);
        }
        this.pending.clear();
        reject(error);
        if (!this.stopping) {
          this.emit({ type: "service-error", message: error.message });
          this.restartTimer = setTimeout(() => {
            void this.start(root, this.secrets).catch(() =>
              this.emit({
                type: "service-error",
                message:
                  "자료 서비스를 시작하지 못했습니다. 앱을 다시 실행하세요.",
              }),
            );
          }, 1000);
        }
      });
    });
    await this.call("init", secrets);
    this.ready = true;
    this.emit({ type: "changed" });
  }
  call<T = unknown>(command: string, args: unknown = {}): Promise<T> {
    if (command === "init") this.secrets = args as Secrets;
    const child = this.child;
    if (!child?.connected || (!this.ready && command !== "init"))
      return Promise.reject(
        new AppError("SERVICE_DOWN", "자료 서비스가 다시 시작 중입니다.", true),
      );
    return new Promise<T>((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new AppError(
            "TIMEOUT",
            "작업 응답을 기다리는 시간이 초과되었습니다.",
            true,
          ),
        );
      }, 300000);
      // The internal caller owns the response type; only validated public commands reach this process.
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      child.send({ id, command, args });
    });
  }
  async stop() {
    this.stopping = true;
    clearTimeout(this.restartTimer);
    const child = this.child;
    if (!child) return;
    try {
      await Promise.race([
        this.call("shutdown"),
        new Promise((resolve) => setTimeout(resolve, 4000)),
      ]);
    } catch {
      /* Process may already have exited. */
    }
    this.child = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new AppError("SERVICE_DOWN", "자료 서비스를 종료합니다."));
    }
    this.pending.clear();
    child.kill();
  }
}
