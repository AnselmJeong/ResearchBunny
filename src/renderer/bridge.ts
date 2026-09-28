import { Electroview } from "electrobun/view";
import { schemas, type API } from "../shared/contracts";
import type { AppEvent } from "../shared/types";
import type { BunnyRPC } from "../shared/rpc";
const listeners = new Set<(event: AppEvent) => void>();
const rpc = Electroview.defineRPC<BunnyRPC>({
  maxRequestTime: 300000,
  handlers: {
    requests: {},
    messages: {
      event: (event) => {
        for (const listener of listeners) listener(event);
      },
    },
  },
});
// Keep WKWebView on its native message bridge. The optional socket transport in
// Electrobun 1.18.1 can lose replies after its connection opens on this renderer.
class NativeElectroview extends Electroview<typeof rpc> {
  override initSocketToBun() {}
}
export const view = new NativeElectroview({ rpc });
const methods = Object.fromEntries(
  Object.keys(schemas).map((name) => [
    name,
    async (input: unknown) => {
      const result = await rpc.request.command({ name, input });
      if (!result.ok)
        throw Object.assign(new Error(result.error.message), result.error);
      return result.data;
    },
  ]),
);
// All method names are generated from the same command schema; the host validates every input.
window.bunny = {
  ...methods,
  onEvent(callback: (event: AppEvent) => void) {
    listeners.add(callback);
    return () => {
      listeners.delete(callback);
    };
  },
} as API;
