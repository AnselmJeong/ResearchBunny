import { Service } from "./service";
import { AppError } from "../shared/types";
const port = { postMessage: (message: unknown) => process.send?.(message) };
const service = new Service(process.argv[2], process.argv[3], (event) =>
  port.postMessage({ event }),
);
process.on("message", async (message: unknown) => {
  const { id, command, args } = message as {
    id: number;
    command: string;
    args: unknown;
  };
  try {
    const data = await service.call(command, args);
    if (command === "shutdown") {
      const deadline = Date.now() + 3000;
      while (service.busy() && Date.now() < deadline) await Bun.sleep(25);
      service.db.close();
    }
    port.postMessage({ id, result: { ok: true, data } });
  } catch (error) {
    const known = error instanceof AppError;
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

process.once("disconnect", async () => {
  try {
    await service.call("shutdown", {});
    const deadline = Date.now() + 3000;
    while (service.busy() && Date.now() < deadline) await Bun.sleep(25);
    service.db.close();
  } finally {
    process.exit(0);
  }
});
