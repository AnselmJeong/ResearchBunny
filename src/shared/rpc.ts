import type { RPCSchema } from "electrobun/bun";
import type { AppEvent, Result } from "./types";
export type BunnyRPC = {
  bun: RPCSchema<{
    requests: {
      command: {
        params: { name: string; input: unknown };
        response: Result<unknown>;
      };
    };
    messages: Record<never, never>;
  }>;
  webview: RPCSchema<{
    requests: Record<never, never>;
    messages: { event: AppEvent };
  }>;
};
