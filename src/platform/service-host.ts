import { fork, type ChildProcess } from "node:child_process";
import { AppError, type AppEvent, type Result } from "../shared/types";
import type { Secrets } from "./credentials";
import { createLog } from "./log";

/** Waits between restarts after the service dies; after the last one the app stops trying. */
const RESTART_DELAYS = [1000, 2000, 4000, 8000, 16000];
/** A service that stayed up this long had recovered; the next failure starts the count again. */
const STABLE_MS = 60000;

export class ServiceHost {
  private child: ChildProcess | null = null;
  private nextId = 0;
  private stopping = false;
  private ready = false;
  private secrets: Secrets = {};
  private restartTimer?: ReturnType<typeof setTimeout>;
  private restarts = 0;
  private readyAt = 0;
  private log: ReturnType<typeof createLog>;
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
    /** App-state folder (Claude, Codex, the app's Chrome); QA builds pass their own. */
    private dataRoot: string,
    /** Tests shorten the waits. */
    private restartDelays = RESTART_DELAYS,
  ) {
    this.log = createLog(dataRoot, "host");
  }
  /** Starts the service again after it died, waiting longer each time and giving up after the last delay. */
  private scheduleRestart(root: string) {
    if (this.stopping) return;
    const delay = this.restartDelays[this.restarts];
    if (delay === undefined) {
      this.log("error", `The service did not come back after ${this.restarts} restarts; not trying again`);
      this.emit({ type: "service-error", message: "자료 서비스를 다시 시작하지 못했습니다. 앱을 종료한 뒤 다시 실행하세요." });
      return;
    }
    this.restarts++;
    this.restartTimer = setTimeout(() => {
      void this.start(root, this.secrets).catch((error: unknown) => {
        if (this.stopping) return;
        // The same failure would repeat: say why and stop.
        if (error instanceof AppError && error.code !== "SERVICE_START" && error.code !== "SERVICE_DOWN" && error.code !== "TIMEOUT") {
          this.emit({ type: "service-error", message: error.message });
          return;
        }
        this.scheduleRestart(root);
      });
    }, delay);
  }
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
      // Build-time defines reach only the main bundle; the service learns the folder here.
      env: { ...process.env, RESEARCHBUNNY_DATA_DIR: this.dataRoot },
    });
    this.child = child;
    child.stdout?.resume();
    // The last of what the service wrote explains an exit nothing else reported.
    let tail = "";
    child.stderr?.on("data", (chunk: Buffer) => { tail = (tail + chunk.toString("utf8")).slice(-4000); });
    let fatal: AppError | undefined;
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
          fatal?: { code: string; message: string };
          event?: AppEvent;
          id?: number;
          result?: Result<unknown>;
        }) => {
          if (message.ready) {
            clearTimeout(timer);
            resolve();
            return;
          }
          if (message.fatal) {
            fatal = new AppError(message.fatal.code, message.fatal.message);
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
      child.once("exit", (code, signal) => {
        clearTimeout(timer);
        if (this.child !== child) return;
        const wasReady = this.ready;
        this.child = null;
        this.ready = false;
        this.log(this.stopping ? "info" : "error", `The service exited (code ${code}, signal ${signal})`, tail.trim() || undefined);
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
        reject(fatal ?? error);
        // Only a service that was running is restarted from here. One that never came up
        // reports to whoever started it: the first launch shows the reason, a restart counts the attempt.
        if (!this.stopping && wasReady) {
          if (Date.now() - this.readyAt > STABLE_MS) this.restarts = 0;
          this.emit({ type: "service-error", message: error.message });
          this.scheduleRestart(root);
        }
      });
    });
    await this.call("init", secrets);
    this.ready = true;
    this.readyAt = Date.now();
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
      try {
        child.send({ id, command, args });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new AppError("SERVICE_DOWN", "자료 서비스가 다시 시작 중입니다.", true));
        this.log("warn", `Command ${command} could not be sent`, error);
      }
    });
  }
  async stop() {
    this.stopping = true;
    clearTimeout(this.restartTimer);
    const child = this.child;
    if (!child) return;
    try {
      // Longer than the service's own budget: jobs unwinding (3 s) plus saving the app Chrome's session (2.5 s).
      await Promise.race([
        this.call("shutdown"),
        new Promise((resolve) => setTimeout(resolve, 7000)),
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
    // SIGTERM lets a service that is still closing finish; it is only killed if it does not leave.
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill();
      const left = await Promise.race([exited.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2500))]);
      if (!left) {
        this.log("warn", "The service did not leave on SIGTERM; killed");
        child.kill("SIGKILL");
      }
    }
  }
}
