import { Service } from "./service";
import { AppError } from "../shared/types";
import { createLog } from "../platform/log";
const port = { postMessage: (message: unknown) => process.send?.(message) };
const log = createLog(process.env.RESEARCHBUNNY_DATA_DIR, "service");
async function open() {
  try {
    return new Service(process.argv[2], process.argv[3], (event) =>
      port.postMessage({ event }),
    );
  } catch (error) {
    // The host shows this reason and does not start the service again: the same failure would repeat.
    log("error", "The library could not be opened", error);
    const fatal = {
      code: error instanceof AppError ? error.code : "SERVICE_START",
      message: error instanceof AppError ? error.message : "라이브러리를 열지 못했습니다. 저장 위치와 디스크 연결을 확인하세요.",
    };
    // Leave only once the message is on its way.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 500);
      if (process.send) process.send({ fatal }, () => resolve());
      else resolve();
    });
    process.exit(1);
  }
}
const service = await open();
// A stray rejection must not end the service, and with it every running job, without a trace.
process.on("unhandledRejection", (reason) => log("error", "Unhandled rejection", reason));
process.on("uncaughtException", (error) => {
  log("error", "Uncaught exception; the service stops and the app starts it again", error);
  process.exit(1);
});
let closing: Promise<void> | undefined;
/** Stops the jobs and closes the databases once, whichever of the host's request, a lost host or SIGTERM comes first. */
function shutdown() {
  return (closing ??= (async () => {
    try {
      await service.call("shutdown", {});
      const deadline = Date.now() + 3000;
      while ((service.busy() || service.shelf.active || service.passages.active) && Date.now() < deadline) await Bun.sleep(25);
    } catch (error) {
      log("error", "Shutdown did not finish cleanly", error);
    } finally {
      try { service.passageStore.close(); } catch (error) { log("warn", "The passage index did not close", error); }
      try { service.db.close(); } catch (error) { log("warn", "The library did not close", error); }
    }
  })());
}
process.on("message", async (message: unknown) => {
  const { id, command, args } = message as {
    id: number;
    command: string;
    args: unknown;
  };
  try {
    const data = command === "shutdown" ? await shutdown() : await service.call(command, args);
    port.postMessage({ id, result: { ok: true, data } });
  } catch (error) {
    const known = error instanceof AppError;
    if (!known) log("error", `Command ${command} failed`, error);
    port.postMessage({
      id,
      result: {
        ok: false,
        error: {
          code: known ? error.code : "SERVICE_ERROR",
          message: known
            ? error.message
            : "작업을 저장하지 못했습니다. 입력은 유지되며 다시 시도할 수 있습니다.",
          retryable: known ? error.retryable : true,
        },
      },
    });
  }
});
port.postMessage({ ready: true });

const leave = () => void shutdown().finally(() => process.exit(0));
process.once("disconnect", leave);
process.once("SIGTERM", leave);
process.once("SIGINT", leave);
