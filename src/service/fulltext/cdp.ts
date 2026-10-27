import type { Readable, Writable } from "node:stream";
import { AppError } from "../../shared/types";

export type CdpEvent = { method: string; params: any; sessionId?: string };
type Pending = { resolve: (value: any) => void; reject: (error: Error) => void; cleanup: () => void };

export const chromeClosed = () => new AppError('CHROME_CLOSED', '앱 전용 Chrome이 닫혔습니다. 다음 문헌에서 다시 엽니다.', true);

/**
 * The Chrome DevTools Protocol over `--remote-debugging-pipe`: NUL-delimited JSON,
 * Chrome reading fd 3 and writing fd 4. Sessions are flat (`sessionId` on each message).
 */
export class CdpConnection {
  private nextId = 0;
  private pending = new Map<number, Pending>();
  private listeners = new Set<(event: CdpEvent) => void>();
  private buffer: Buffer = Buffer.alloc(0);
  closed = false;
  /** Settles once the pipe is gone, whether Chrome exited or `close()` was called. */
  readonly done: Promise<void>;
  private finish!: () => void;
  constructor(private input: Writable, output: Readable, private timeoutMs = 30_000) {
    this.done = new Promise(resolve => { this.finish = resolve; });
    output.on('data', (chunk: Buffer) => this.receive(chunk));
    output.once('close', () => this.close());
    output.once('error', () => this.close());
    input.on('error', () => this.close());
  }
  private receive(chunk: Buffer) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    let end: number;
    while ((end = this.buffer.indexOf(0)) >= 0) {
      const text = this.buffer.subarray(0, end).toString('utf8');
      this.buffer = this.buffer.subarray(end + 1);
      let message: any;
      try { message = JSON.parse(text); } catch { continue; }
      if (typeof message.id === 'number') {
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        this.pending.delete(message.id);
        pending.cleanup();
        if (message.error) pending.reject(new AppError('CHROME_PROTOCOL', `Chrome 명령이 실패했습니다: ${String(message.error.message || '').slice(0, 200)}`, true));
        else pending.resolve(message.result ?? {});
      } else if (typeof message.method === 'string') {
        for (const listener of this.listeners) listener({ method: message.method, params: message.params ?? {}, sessionId: message.sessionId });
      }
    }
  }
  send<T = any>(method: string, params: object = {}, sessionId?: string, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    if (this.closed) return Promise.reject(chromeClosed());
    return new Promise<T>((resolve, reject) => {
      const id = ++this.nextId;
      const fail = (error: unknown) => {
        this.pending.get(id)?.cleanup();
        this.pending.delete(id);
        reject(error);
      };
      const abort = () => fail(signal!.reason);
      const timer = setTimeout(() => fail(new AppError('CHROME_TIMEOUT', `앱 전용 Chrome이 응답하지 않습니다 (${method}).`, true)), this.timeoutMs);
      signal?.addEventListener('abort', abort, { once: true });
      this.pending.set(id, { resolve, reject, cleanup: () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); } });
      this.input.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
    });
  }
  on(listener: (event: CdpEvent) => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) { pending.cleanup(); pending.reject(chromeClosed()); }
    this.pending.clear();
    this.listeners.clear();
    this.input.destroy();
    this.finish();
  }
}
