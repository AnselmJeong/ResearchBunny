import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  safeStorage,
  shell,
  utilityProcess,
  nativeTheme,
  type UtilityProcess,
} from "electron";
import { join, extname, resolve } from "node:path";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { schemas, type Command } from "../shared/contracts";
import { AppError, type Result, type Settings } from "../shared/types";

app.setName("ResearchBunny");
if (process.env.RESEARCHBUNNY_DATA_DIR)
  app.setPath("userData", resolve(process.env.RESEARCHBUNNY_DATA_DIR));
if (!app.requestSingleInstanceLock()) {
  app.quit();
}
let window: BrowserWindow | null = null,
  worker: UtilityProcess | null = null,
  quitting = false;
let nextId = 0;
const pending = new Map<
  number,
  {
    resolve: (value: any) => void;
    reject: (error: unknown) => void;
    timer: ReturnType<typeof setTimeout>;
  }
>();
let libraryRoot = "";
const droppedFiles = new Map<string, string>();
const secrets: { openalex?: string; openai?: string; secureStorage?: boolean } =
  {};
const root = () => app.getPath("userData");
function atomicJson(path: string, value: unknown) {
  const temp = path + ".staging";
  writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
  renameSync(temp, path);
}
function loadSecrets() {
  const path = join(root(), "credentials.json");
  if (!existsSync(path)) return;
  let encrypted: Record<string, string>;
  try {
    const saved = JSON.parse(readFileSync(path, "utf8"));
    if (!saved || typeof saved !== "object") return;
    encrypted = saved;
  } catch {
    // An unreadable credential file must not prevent opening the local library.
    // The original file stays untouched until the user saves replacement keys.
    return;
  }
  if (!encrypted.openalex && !encrypted.openai) return;
  secrets.secureStorage = safeStorage.isEncryptionAvailable();
  if (!secrets.secureStorage) return;
  for (const key of ["openalex", "openai"] as const)
    if (encrypted[key])
      try {
        secrets[key] = safeStorage.decryptString(
          Buffer.from(encrypted[key], "base64"),
        );
      } catch {
        /* User can replace an inaccessible OS-protected key in settings. */
      }
}
function saveSecrets(input: { openalexKey?: string; openaiKey?: string }) {
  if (input.openalexKey === undefined && input.openaiKey === undefined) return;
  if (!safeStorage.isEncryptionAvailable())
    throw new AppError(
      "SECURE_STORAGE",
      "macOS 보안 저장소를 사용할 수 없어 키를 저장하지 않았습니다.",
    );
  secrets.secureStorage = true;
  const next = { ...secrets };
  if (input.openalexKey !== undefined)
    next.openalex = input.openalexKey.trim() || undefined;
  if (input.openaiKey !== undefined)
    next.openai = input.openaiKey.trim() || undefined;
  const encrypted = Object.fromEntries(
    (["openalex", "openai"] as const)
      .filter((k) => next[k])
      .map((k) => [k, safeStorage.encryptString(next[k]!).toString("base64")]),
  );
  atomicJson(join(root(), "credentials.json"), encrypted);
  Object.assign(secrets, next);
}
function rpc(command: string, args: unknown = {}): Promise<any> {
  if (!worker)
    return Promise.reject(
      new AppError(
        "SERVICE_DOWN",
        "자료 서비스가 다시 시작 중입니다. 잠시 후 재시도하세요.",
        true,
      ),
    );
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(
        new AppError(
          "TIMEOUT",
          "작업 응답을 기다리는 시간이 초과되었습니다. 현재 상태를 확인하세요.",
          true,
        ),
      );
    }, 300000);
    pending.set(id, { resolve, reject, timer });
    worker!.postMessage({ id, command, args });
  });
}
async function startService() {
  await new Promise<void>((ready, reject) => {
    const child = utilityProcess.fork(
      join(__dirname, "service.cjs"),
      [libraryRoot, join(__dirname, "pdf-worker.cjs")],
      {
        serviceName: "ResearchBunny Library",
        stdio: "pipe",
        cwd: root(),
      },
    );
    worker = child;
    const timer = setTimeout(
      () =>
        reject(
          new AppError("SERVICE_START", "자료 서비스를 시작하지 못했습니다."),
        ),
      20000,
    );
    child.on("message", (message) => {
      if (message.ready) {
        clearTimeout(timer);
        ready();
        return;
      }
      if (message.event) {
        window?.webContents.send("bunny:event", message.event);
        return;
      }
      const p = pending.get(message.id);
      if (p) {
        clearTimeout(p.timer);
        pending.delete(message.id);
        if (message.result.ok) p.resolve(message.result.data);
        else
          p.reject(
            new AppError(
              message.result.error.code,
              message.result.error.message,
              message.result.error.retryable,
            ),
          );
      }
    });
    child.on("exit", () => {
      clearTimeout(timer);
      if (worker !== child) return;
      worker = null;
      for (const p of pending.values()) {
        clearTimeout(p.timer);
        p.reject(
          new AppError(
            "SERVICE_DOWN",
            "자료 서비스가 중단되었습니다. 저장된 자료는 재시작 후 확인할 수 있습니다.",
            true,
          ),
        );
      }
      pending.clear();
      reject(new AppError("SERVICE_DOWN", "자료 서비스가 종료되었습니다."));
      if (!quitting) {
        window?.webContents.send("bunny:event", {
          type: "service-error",
          message: "자료 서비스가 중단되어 다시 시작합니다.",
        });
        setTimeout(
          () =>
            void startService().catch(() =>
              window?.webContents.send("bunny:event", {
                type: "service-error",
                message:
                  "자료 서비스를 시작하지 못했습니다. 앱을 다시 실행하세요.",
              }),
            ),
          1000,
        );
      }
    });
    child.stderr?.on("data", () => {
      /* Provider records and secrets never enter application logs. */
    });
  });
  await rpc("init", secrets);
  window?.webContents.send("bunny:event", { type: "changed" });
}
async function command(name: Command, input: any): Promise<any> {
  const args = (schemas[name] as any).parse(input);
  switch (name) {
    case "chooseBib": {
      const result = await dialog.showOpenDialog(window!, {
        properties: ["openFile"],
        filters: [{ name: "BibTeX", extensions: ["bib", "bibtex"] }],
      });
      return result.canceled
        ? null
        : rpc("previewBibFile", { path: result.filePaths[0] });
    }
    case "choosePdf": {
      const result = await dialog.showOpenDialog(window!, {
        properties: args.folder
          ? ["openDirectory"]
          : ["openFile", "multiSelections"],
        filters: [{ name: "PDF", extensions: ["pdf"] }],
      });
      return result.canceled
        ? null
        : rpc("pdfImport", {
            projectId: args.projectId,
            paths: result.filePaths,
            options: {
              mode: args.mode,
              collectionId: args.collectionId,
              mapFolders: args.mapFolders,
              workId: args.workId,
            },
          });
    }
    case "importDropped": {
      const approved = args.paths.map((token: string) =>
        droppedFiles.get(token),
      );
      if (approved.some((path: string | undefined) => !path))
        throw new AppError(
          "FORBIDDEN",
          "드롭한 파일만 가져올 수 있습니다. 파일을 다시 놓으세요.",
        );
      for (const token of args.paths) droppedFiles.delete(token);
      args.paths = approved;
      if (
        args.paths.some(
          (p: string) =>
            ![".pdf", ".bib", ".bibtex", ""].includes(extname(p).toLowerCase()),
        )
      )
        throw new AppError("FILE_TYPE", "PDF 또는 BibTeX 파일을 가져오세요.");
      if (args.paths.some((p: string) => /\.bib(?:tex)?$/i.test(p)))
        throw new AppError(
          "FILE_TYPE",
          "BibTeX 파일은 가져오기 창의 파일 선택을 사용하세요.",
        );
      return rpc("pdfImport", {
        projectId: args.projectId,
        paths: args.paths,
        options: { mode: args.mode },
      });
    }
    case "attachmentAction": {
      if (args.action === "relink") {
        const result = await dialog.showOpenDialog(window!, {
          properties: ["openFile"],
          filters: [{ name: "PDF", extensions: ["pdf"] }],
        });
        if (!result.canceled)
          await rpc("relink", {
            attachmentId: args.attachmentId,
            path: result.filePaths[0],
          });
      } else {
        const path = await rpc("attachmentPath", args);
        if (args.action === "reveal") shell.showItemInFolder(path);
        else {
          const error = await shell.openPath(path);
          if (error)
            throw new AppError(
              "OPEN_FILE",
              "PDF를 열지 못했습니다. 파일 연결을 확인하세요.",
            );
        }
      }
      return;
    }
    case "exportBib": {
      const result = await dialog.showSaveDialog(window!, {
        defaultPath: "ResearchBunny.bib",
        filters: [{ name: "BibTeX", extensions: ["bib"] }],
      });
      return result.canceled
        ? null
        : rpc("performExport", { ...args, path: result.filePath });
    }
    case "backup": {
      const result = await dialog.showSaveDialog(window!, {
        title: "새 백업 폴더 저장",
        defaultPath: `ResearchBunny-${new Date().toISOString().slice(0, 10)}.researchbunny`,
        buttonLabel: "백업 생성",
      });
      return result.canceled
        ? null
        : rpc("backup", { ...args, path: result.filePath });
    }
    case "restoreBackup": {
      const result = await dialog.showOpenDialog(window!, {
        title: "ResearchBunny 백업 폴더 선택",
        properties: ["openDirectory"],
      });
      if (result.canceled) return null;
      const restored = await rpc("restore", {
        path: result.filePaths[0],
        destination: join(root(), "libraries", "restored-" + randomUUID()),
      });
      await rpc("shutdown");
      const old = worker;
      worker = null;
      old?.kill();
      libraryRoot = restored.path;
      atomicJson(join(root(), "library-location.json"), { path: libraryRoot });
      await startService();
      return restored;
    }
    case "saveSettings":
      saveSecrets(args);
      await rpc("init", secrets);
      {
        const { openalexKey: _oa, openaiKey: _ai, ...settings } = args;
        const result = await rpc(name, settings);
        nativeTheme.themeSource = result.theme;
        return result;
      }
    case "openExternal": {
      if (args.kind === "data-folder") {
        await shell.openPath(libraryRoot);
        return;
      }
      const url =
        args.kind === "openalex-settings"
          ? "https://openalex.org/settings/api"
          : args.kind === "openai-settings"
            ? "https://platform.openai.com/api-keys"
            : args.workId
              ? await rpc("externalUrl", args)
              : null;
      if (!url) throw new AppError("NO_URL", "이 문헌의 링크가 없습니다.");
      await shell.openExternal(url);
      return;
    }
    default:
      return rpc(name, args);
  }
}
function createWindow() {
  window = new BrowserWindow({
    title: "ResearchBunny",
    width: 1510,
    height: 960,
    minWidth: 980,
    minHeight: 660,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 20, y: 22 },
    backgroundColor: "#f8f9f6",
    show: false,
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler(
    (_wc, _permission, callback) => callback(false),
  );
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.webContents.on("will-attach-webview", (event) =>
    event.preventDefault(),
  );
  window.once("ready-to-show", () => window?.show());
  window.on("closed", () => {
    window = null;
  });
  void window.loadFile(join(__dirname, "renderer", "index.html"));
}
ipcMain.on("bunny:register-drop", (event, paths: unknown) => {
  if (
    !window ||
    event.sender !== window.webContents ||
    event.senderFrame !== window.webContents.mainFrame ||
    !Array.isArray(paths) ||
    paths.length > 1000
  ) {
    event.returnValue = [];
    return;
  }
  if (droppedFiles.size > 2000) droppedFiles.clear();
  event.returnValue = paths
    .filter((p) => typeof p === "string" && p.length < 4000)
    .map((path) => {
      const token = randomUUID();
      droppedFiles.set(token, path);
      return token;
    });
});
ipcMain.handle(
  "bunny:command",
  async (event, name: unknown, input: unknown): Promise<Result<unknown>> => {
    try {
      const expected = pathToFileURL(
        join(__dirname, "renderer", "index.html"),
      ).href;
      if (
        !window ||
        event.sender !== window.webContents ||
        event.senderFrame !== window.webContents.mainFrame ||
        event.senderFrame.url.split("#")[0] !== expected
      )
        throw new AppError("FORBIDDEN", "허용되지 않은 요청입니다.");
      if (typeof name !== "string" || !Object.hasOwn(schemas, name))
        throw new AppError("FORBIDDEN", "허용되지 않은 명령입니다.");
      const data = await command(name as Command, input);
      if (
        ![
          "snapshot",
          "list",
          "inspect",
          "attachments",
          "saveUi",
          "duplicates",
        ].includes(name)
      )
        window?.webContents.send("bunny:event", { type: "changed" });
      return { ok: true, data };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: error instanceof AppError ? error.code : "INVALID_REQUEST",
          message:
            error instanceof AppError
              ? error.message
              : "입력 형식 또는 파일 접근을 확인하세요. 작업을 완료하지 못했습니다.",
          retryable: error instanceof AppError ? error.retryable : false,
        },
      };
    }
  },
);
app.on("second-instance", () => {
  if (window) {
    window.show();
    window.focus();
  } else createWindow();
});
app
  .whenReady()
  .then(async () => {
    mkdirSync(root(), { recursive: true });
    libraryRoot = join(root(), "library");
    const location = join(root(), "library-location.json");
    if (existsSync(location))
      try {
        const saved = JSON.parse(readFileSync(location, "utf8"));
        if (typeof saved.path === "string" && existsSync(saved.path))
          libraryRoot = saved.path;
      } catch {
        /* Use the original preserved library. */
      }
    loadSecrets();
    await startService();
    const snapshot = await rpc("snapshot", {});
    nativeTheme.themeSource = (snapshot.settings as Settings).theme;
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        {
          label: "ResearchBunny",
          submenu: [
            { role: "about" },
            { type: "separator" },
            { role: "hide" },
            { role: "hideOthers" },
            { role: "unhide" },
            { type: "separator" },
            { role: "quit" },
          ],
        },
        {
          label: "편집",
          submenu: [
            { role: "undo" },
            { role: "redo" },
            { type: "separator" },
            { role: "cut" },
            { role: "copy" },
            { role: "paste" },
            { role: "selectAll" },
          ],
        },
        {
          label: "보기",
          submenu: [
            { role: "reload" },
            { role: "togglefullscreen" },
            ...(!app.isPackaged ? [{ role: "toggleDevTools" as const }] : []),
          ],
        },
        {
          label: "창",
          submenu: [{ role: "minimize" }, { role: "zoom" }, { role: "front" }],
        },
      ]),
    );
    createWindow();
  })
  .catch(() => {
    dialog.showErrorBox(
      "ResearchBunny",
      "로컬 자료 서비스를 시작하지 못했습니다. 기존 데이터는 유지됩니다. 앱을 다시 실행하세요.",
    );
    app.quit();
  });
app.on("activate", () => {
  if (!window && worker) createWindow();
});
app.on("before-quit", () => {
  quitting = true;
  worker?.postMessage({ id: 0, command: "shutdown", args: {} });
});
app.on("will-quit", () => worker?.kill());
