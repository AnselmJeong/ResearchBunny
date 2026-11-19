import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { redact } from "../platform/log";
import { ConnectorError, type ConnectorLibrary } from "./library";
import { TOOLS, type ToolDefinition } from "./tools";

/** MCP over stdio: one JSON-RPC 2.0 message per line. https://modelcontextprotocol.io/specification */
const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

interface Request {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}
type Reply = { jsonrpc: "2.0"; id: string | number | null; result?: unknown; error?: { code: number; message: string } };

const INSTRUCTIONS = `ResearchBunny connector: read-only access to the researcher's ResearchBunny library — their screened project archives, the full text of their PDFs split into page-numbered passages, evidence tables and BibTeX. Every tool only reads.
Start with list_projects (or list_scopes when a project is already chosen). Look for support for a claim with find_support, read around a passage with get_passages, connect a manuscript's references with resolve_works, and take BibTeX with get_bibtex using the manuscript's own keys.
Passages come from the researcher's own PDFs: quote them exactly and cite the paper and page. A passage being returned does not mean it supports the claim; judge that from its text.`;

/** Appends one line per tool call (tool, arguments, time, outcome) to a small log beside the library. */
export function callLog(path: string | null) {
  return (entry: Record<string, unknown>) => {
    if (!path) return;
    try {
      mkdirSync(dirname(path), { recursive: true });
      try {
        if (statSync(path).size > 2 * 1024 * 1024) renameSync(path, path + ".1");
      } catch {
        /* No log yet. */
      }
      appendFileSync(path, redact(JSON.stringify({ at: new Date().toISOString(), ...entry })) + "\n", { mode: 0o600 });
    } catch {
      /* A log that cannot be written never stops a call. */
    }
  };
}

export class McpServer {
  private tools = new Map(TOOLS.map((t) => [t.name, t]));
  constructor(private lib: ConnectorLibrary, private version: string, private log: ReturnType<typeof callLog> = () => {}) {}

  listTools() {
    return TOOLS.map((t: ToolDefinition) => ({
      name: t.name,
      title: t.title,
      description: t.description,
      inputSchema: z.toJSONSchema(t.input, { target: "draft-7", io: "input" }),
      annotations: { title: t.title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }));
  }

  async callTool(name: string, args: unknown) {
    const definition = this.tools.get(name);
    if (!definition) return { isError: true, content: [{ type: "text", text: `Unknown tool ${name}.` }] };
    const started = Date.now();
    try {
      const parsed = definition.input.safeParse(args ?? {});
      if (!parsed.success) throw new ConnectorError(`Invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ")}`);
      const result = await definition.run(parsed.data, { lib: this.lib });
      this.log({ tool: name, args: summarize(args), ms: Date.now() - started, ok: true });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result as Record<string, unknown> };
    } catch (error) {
      const message = error instanceof ConnectorError ? error.message : `The tool failed: ${error instanceof Error ? error.message : String(error)}`;
      this.log({ tool: name, args: summarize(args), ms: Date.now() - started, ok: false, error: message });
      return { isError: true, content: [{ type: "text", text: message }] };
    }
  }

  /** One message in, at most one reply out (notifications get none). */
  async handle(message: Request): Promise<Reply | null> {
    const id = message.id ?? null;
    const notification = message.id === undefined;
    const ok = (result: unknown): Reply | null => (notification ? null : { jsonrpc: "2.0", id, result });
    const fail = (code: number, text: string): Reply | null => (notification ? null : { jsonrpc: "2.0", id, error: { code, message: text } });
    switch (message.method) {
      case "initialize": {
        const asked = String(message.params?.protocolVersion ?? "");
        return ok({
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "researchbunny", title: "ResearchBunny", version: this.version },
          instructions: INSTRUCTIONS,
        });
      }
      case "notifications/initialized":
      case "notifications/cancelled":
        return null;
      case "ping":
        return ok({});
      case "tools/list":
        return ok({ tools: this.listTools() });
      case "tools/call":
        return ok(await this.callTool(String(message.params?.name ?? ""), message.params?.arguments));
      case "resources/list":
        return ok({ resources: [] });
      case "prompts/list":
        return ok({ prompts: [] });
      default:
        return fail(-32601, `Method not found: ${message.method}`);
    }
  }

  /** Serves stdin until it closes. Messages are handled in order. */
  async serve(input: NodeJS.ReadableStream = process.stdin, write: (line: string) => void = (line) => process.stdout.write(line + "\n")) {
    let buffer = "";
    let queue = Promise.resolve();
    const dispatch = (line: string) => {
      queue = queue.then(async () => {
        let message: Request;
        try {
          message = JSON.parse(line) as Request;
        } catch {
          write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }));
          return;
        }
        const reply = await this.handle(message).catch((error: unknown) => ({ jsonrpc: "2.0" as const, id: message.id ?? null, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } }));
        if (reply) write(JSON.stringify(reply));
      });
    };
    await new Promise<void>((resolve) => {
      input.setEncoding?.("utf8");
      input.on("data", (chunk: string) => {
        buffer += chunk;
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line) dispatch(line);
        }
      });
      input.on("end", () => {
        if (buffer.trim()) dispatch(buffer.trim());
        resolve();
      });
    });
    await queue;
  }
}

/** Arguments for the call log: long text is cut, nothing personal beyond the query is kept. */
function summarize(args: unknown) {
  return JSON.parse(JSON.stringify(args ?? {}, (_key, value: unknown) => (typeof value === "string" && value.length > 200 ? value.slice(0, 200) + "…" : value)));
}
