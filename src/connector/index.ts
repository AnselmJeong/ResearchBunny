// researchbunny-connector: an MCP server on stdio that reads the ResearchBunny
// library and passage index without the app. ScholarPen starts it as a child
// process; Claude Code and Codex can register it as an MCP server.
//
//   researchbunny-connector [--data <library folder>] [--project <id or name>] [--log <file>|--no-log]
//
// The project defaults to the linked ScholarPen folder the connector runs in.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { version } from "../../package.json";
import { ConnectorLibrary } from "./library";
import { McpServer, callLog } from "./mcp";

const arg = (name: string) => {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 ? process.argv[at + 1] : undefined;
};
const appData = process.env.RESEARCHBUNNY_DATA_DIR || join(homedir(), "Library", "Application Support", "ResearchBunny");
/** Where the app keeps the library: its default folder, or wherever a restore moved it. */
function libraryFolder() {
  try {
    const saved = JSON.parse(readFileSync(join(appData, "library-location.json"), "utf8")) as { path?: unknown };
    if (typeof saved.path === "string" && saved.path) return saved.path;
  } catch {
    /* The default location. */
  }
  return join(appData, "library");
}
const data = resolve(arg("data") || process.env.RESEARCHBUNNY_LIBRARY || libraryFolder());
const logPath = process.argv.includes("--no-log") ? null : resolve(arg("log") || join(appData, "logs", "connector-calls.jsonl"));

let lib: ConnectorLibrary;
try {
  lib = new ConnectorLibrary(data, { project: arg("project"), cwd: process.cwd() });
} catch (error) {
  // Nothing may go to stdout but protocol messages.
  process.stderr.write(`researchbunny-connector: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
const server = new McpServer(lib, version, callLog(logPath));
await server.serve();
lib.close();
