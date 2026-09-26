import { Service } from "./service";
import { AppError } from "../shared/types";
const port = process.parentPort!;
const service = new Service(process.argv[2], process.argv[3], (event) =>
  port.postMessage({ event }),
);
port.on("message", async (event) => {
  const { id, command, args } = event.data;
  try {
    const data = await service.call(command, args);
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
