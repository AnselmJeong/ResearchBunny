import { dlopen, FFIType, CString, ptr } from "bun:ffi";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { z } from "zod";
import { AppError } from "../shared/types";

// Resolved from the packaged entrypoint, never the launching shell's PATH/cwd.
export const resources =
  process.env.RESEARCHBUNNY_RESOURCES ?? join(import.meta.dir, "..");
export async function native(
  request: Record<string, unknown>,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      join(resources, "native", "researchbunny-platform"),
      [],
      {
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stdout.setEncoding("utf8").on("data", (data) => {
      output += data;
    });
    child.stderr.resume(); // Never log native responses or credentials.
    child.on("error", () =>
      reject(
        new AppError("NATIVE_HELPER", "macOS 기능을 시작하지 못했습니다."),
      ),
    );
    child.on("close", (code) => {
      if (code !== 0)
        return reject(
          new AppError(
            "NATIVE_HELPER",
            "macOS 대화상자 또는 키체인 접근을 확인하세요.",
          ),
        );
      try {
        resolve(JSON.parse(output));
      } catch {
        reject(new AppError("NATIVE_HELPER", "macOS 응답을 읽지 못했습니다."));
      }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(request));
  });
}
const loadDialogLibrary = () =>
  dlopen(join(resources, "native", "libResearchBunnyDialogs.dylib"), {
    researchbunny_dialog: { args: [FFIType.ptr], returns: FFIType.ptr },
    researchbunny_free: { args: [FFIType.ptr], returns: FFIType.void },
  });
let dialogLibrary: ReturnType<typeof loadDialogLibrary> | undefined;
function nativeDialog(request: Record<string, unknown>): unknown {
  const library = (dialogLibrary ??= loadDialogLibrary());
  const input = Buffer.from(JSON.stringify(request) + "\0");
  const output = library.symbols.researchbunny_dialog(ptr(input));
  try {
    if (!output)
      throw new AppError("DIALOG", "파일 선택 창을 열지 못했습니다.");
    return JSON.parse(new CString(output).toString());
  } finally {
    if (output) library.symbols.researchbunny_free(output);
    // Swift libraries register runtime metadata; keep the loaded image alive.
  }
}
const pathsResponse = z.object({ paths: z.array(z.string().min(1)) });
export const dialog = {
  async showOpenDialog(
    _window: unknown,
    options: {
      title?: string;
      properties: string[];
      filters?: { name?: string; extensions: string[] }[];
    },
  ) {
    const folders = options.properties.includes("openDirectory");
    const { paths } = pathsResponse.parse(
      nativeDialog({
        operation: "open",
        title: options.title,
        files: !folders,
        folders,
        multiple: options.properties.includes("multiSelections"),
        extensions: folders
          ? []
          : options.filters?.flatMap((filter) => filter.extensions),
      }),
    );
    return { canceled: paths.length === 0, filePaths: paths };
  },
  async showSaveDialog(
    _window: unknown,
    options: {
      title?: string;
      defaultPath: string;
      buttonLabel?: string;
      filters?: { name?: string; extensions: string[] }[];
    },
  ) {
    const { paths } = pathsResponse.parse(
      nativeDialog({
        operation: "save",
        title: options.title,
        name: options.defaultPath,
        extensions: options.filters?.flatMap((filter) => filter.extensions),
      }),
    );
    return { canceled: paths.length === 0, filePath: paths[0] };
  },
};
