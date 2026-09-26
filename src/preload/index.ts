import { contextBridge, ipcRenderer, webUtils } from "electron";
import { schemas, type API } from "../shared/contracts";
import type { AppEvent, Result } from "../shared/types";
const methods = Object.fromEntries(
  Object.keys(schemas).map((command) => [
    command,
    async (input: unknown) => {
      const response: Result<unknown> = await ipcRenderer.invoke(
        "bunny:command",
        command,
        input,
      );
      if (!response.ok) {
        const error = new Error(response.error.message);
        Object.assign(error, {
          code: response.error.code,
          retryable: response.error.retryable,
        });
        throw error;
      }
      return response.data;
    },
  ]),
);
contextBridge.exposeInMainWorld("bunny", {
  ...methods,
  onEvent(callback: (event: AppEvent) => void) {
    const listener = (_event: Electron.IpcRendererEvent, data: AppEvent) =>
      callback(data);
    ipcRenderer.on("bunny:event", listener);
    return () => ipcRenderer.removeListener("bunny:event", listener);
  },
  droppedPaths(files: File[]) {
    const paths = files
      .map((file) => webUtils.getPathForFile(file))
      .filter(Boolean);
    return ipcRenderer.sendSync("bunny:register-drop", paths);
  },
} as unknown as API);
