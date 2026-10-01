import Electrobun, {
  BrowserWindow,
  BrowserView,
  ApplicationMenu,
  Utils,
} from "electrobun/bun";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { schemas, type Command } from "../shared/contracts";
import { AppError, type Result, type AppEvent, type PdfExportResult } from "../shared/types";
import type { BunnyRPC } from "../shared/rpc";
import { dialog, resources } from "../platform/native";
import { Credentials } from "../platform/credentials";
import { ServiceHost } from "../platform/service-host";
import { acquireInstance } from "../platform/instance";
const root = () =>
  resolve(
    process.env.RESEARCHBUNNY_DATA_DIR ??
      join(homedir(), "Library", "Application Support", "ResearchBunny"),
  );
mkdirSync(root(), { recursive: true });
const credentials = new Credentials(root());
let libraryRoot = join(root(), "library");
let window: BrowserWindow | null = null;
const emit = (event: AppEvent) => {
  if (window) hostRpc.send.event(event);
};
const service = new ServiceHost(
  join(resources, "runtime", "service.js"),
  join(resources, "runtime", "pdf-worker.cjs"),
  emit,
);
const rpc = service.call.bind(service);
async function startService() {
  await service.start(libraryRoot, credentials.secrets);
}
function atomicJson(path: string, value: unknown) {
  const temp = path + ".staging";
  writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
  renameSync(temp, path);
}
async function command(name: Command, input: any): Promise<any> {
  const args = (schemas[name] as any).parse(input);
  switch (name) {
    case "choosePdfMatch": {
      const result = await dialog.showOpenDialog(window!, {
        title: "기존 아카이브에 연결할 PDF 폴더 선택",
        properties: ["openDirectory"],
      });
      return result.canceled ? null : rpc("pdfMatch", { projectId: args.projectId, paths: result.filePaths });
    }
    case "chooseDownloadDirectory": {
      const result = await dialog.showOpenDialog(window!, {
        title: "Chrome이 PDF를 저장하는 다운로드 폴더 선택",
        properties: ["openDirectory"],
      });
      if (result.canceled) return null;
      await rpc("rememberDownloadDirectory", {directory:result.filePaths[0]});
      return result.filePaths[0];
    }
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
          ? ["openDirectory", "multiSelections"]
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
        const path = await rpc<string>("attachmentPath", args);
        if (args.action === "reveal") Utils.showItemInFolder(path);
        else {
          const opened = Utils.openPath(path);
          if (!opened)
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
    case "exportPdfs": {
      const result = await dialog.showOpenDialog(window!, {
        title: "PDF 분류 폴더를 내보낼 위치 선택",
        properties: ["openDirectory"],
      });
      if (result.canceled) return null;
      const exported = await rpc<PdfExportResult>("performPdfExport", { ...args, parent: result.filePaths[0] });
      Utils.showItemInFolder(exported.path);
      return exported;
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
      const restored = await rpc<{ path: string; missing: string[] }>(
        "restore",
        {
          path: result.filePaths[0],
          destination: join(root(), "libraries", "restored-" + randomUUID()),
        },
      );
      await service.stop();
      libraryRoot = restored.path;
      atomicJson(join(root(), "library-location.json"), { path: libraryRoot });
      await startService();
      return restored;
    }
    case "codexLogin": {
      const url = await rpc<string>("codexLogin", {});
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== "https:" || !["auth.openai.com", "chatgpt.com"].includes(parsed.hostname) || parsed.username || parsed.password)
          throw new AppError("CODEX_LOGIN", "올바르지 않은 로그인 주소입니다.");
        await Utils.openExternal(parsed.toString());
      } catch (error) { await rpc("codexCancelLogin", {}).catch(() => {}); throw error; }
      return;
    }
    case "saveSettings":
      await credentials.save(args);
      await rpc("init", credentials.secrets);
      {
        const { openalexKey: _oa, openaiKey: _ai, ...settings } = args;
        const result = await rpc(name, settings);
        return result;
      }
    case "openExternal": {
      if (args.kind === "data-folder") {
        await Utils.openPath(libraryRoot);
        return;
      }
      const url =
        args.kind === "openalex-settings"
          ? "https://openalex.org/settings/api"
          : args.kind === "openai-settings"
            ? "https://platform.openai.com/api-keys"
            : args.workId
              ? await rpc<string>("externalUrl", args)
              : null;
      if (!url) throw new AppError("NO_URL", "이 문헌의 링크가 없습니다.");
      await Utils.openExternal(url);
      return;
    }
    default:
      return rpc(name, args);
  }
}

const hostRpc = BrowserView.defineRPC<BunnyRPC>({
  maxRequestTime: 300000,
  handlers: {
    messages: {},
    requests: {
      command: async ({ name, input }): Promise<Result<unknown>> => {
        try {
          if (!Object.hasOwn(schemas, name))
            throw new AppError("FORBIDDEN", "허용되지 않은 명령입니다.");
          if (process.env.RESEARCHBUNNY_TEST === "1")
            writeFileSync(join(root(), "commands.log"), `${name}:start\n`, {
              flag: "a",
            });
          const data: unknown = await command(name as Command, input);
          if (process.env.RESEARCHBUNNY_TEST === "1")
            writeFileSync(join(root(), "commands.log"), `${name}:done\n`, {
              flag: "a",
            });
          if (
            ![
              "snapshot",
              "list",
              "inspect",
              "attachments",
              "saveUi",
              "duplicates",
              "exportPreview",
              "pdfExportPreview",
              "pdfDownloadPreview",
            ].includes(name)
          )
            emit({ type: "changed" });
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
    },
  },
});
let shuttingDown = false;
Electrobun.events.on("before-quit", (event) => {
  if (shuttingDown) return;
  event.response = { allow: false };
  shuttingDown = true;
  void service.stop().finally(() => Utils.quit());
});
async function main() {
  if (!(await acquireInstance(root(), () => window?.show()))) {
    Utils.quit();
    return;
  }
  const location = join(root(), "library-location.json");
  if (existsSync(location)) {
    const saved: unknown = JSON.parse(readFileSync(location, "utf8"));
    if (
      saved &&
      typeof saved === "object" &&
      "path" in saved &&
      typeof saved.path === "string"
    ) {
      if (!existsSync(saved.path))
        throw new AppError(
          "LIBRARY_MISSING",
          "기존 라이브러리 경로에 접근할 수 없습니다. 외장 디스크 연결을 확인하세요.",
        );
      libraryRoot = saved.path;
    }
  }
  await credentials.load();
  await startService();
  ApplicationMenu.setApplicationMenu([
    {
      label: "ResearchBunny",
      submenu: [
        { role: "about" },
        { type: "divider" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "showAll" },
        { type: "divider" },
        { label: "종료", action: "quit", accelerator: "CmdOrCtrl+Q" },
      ],
    },
    {
      label: "편집",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "divider" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "창",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        { role: "toggleFullScreen" },
        { role: "bringAllToFront" },
      ],
    },
  ]);
  ApplicationMenu.on("application-menu-clicked", () => Utils.quit());
  const url = "views://main/index.html";
  window = new BrowserWindow({
    title: "ResearchBunny",
    url,
    renderer: "native",
    rpc: hostRpc,
    titleBarStyle: "hiddenInset",
    trafficLightOffset: { x: 20, y: 22 },
    frame: { x: 80, y: 60, width: 1510, height: 960 },
    navigationRules: JSON.stringify(["^*", url]),
  });
  window.webview.setNavigationRules(["^*", url]);
}
main().catch(async (error: unknown) => {
  await Utils.showMessageBox({
    type: "error",
    title: "ResearchBunny",
    message:
      error instanceof AppError
        ? error.message
        : "로컬 자료 서비스를 시작하지 못했습니다. 기존 데이터는 유지됩니다.",
  });
  Utils.quit();
});
