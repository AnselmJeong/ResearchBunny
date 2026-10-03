import { existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { native } from "./native";
import { AppError } from "../shared/types";
const keysSchema = z.object({
  openalex: z.string().optional(),
  openai: z.string().optional(),
  ollama: z.string().optional(),
  pubmed: z.string().optional(),
  tinyfish: z.string().optional(),
});
export type Secrets = z.infer<typeof keysSchema> & {
  secureStorage?: boolean;
  credentialMigrationRequired?: boolean;
};
export class Credentials {
  secrets: Secrets = {};
  private account: string;
  constructor(private root: string) {
    this.account = createHash("sha256").update(root).digest("hex");
  }
  async load() {
    // Test instances never access the user's Keychain.
    if (process.env.RESEARCHBUNNY_TEST === "1") return;
    try {
      const result = z
        .object({ value: z.string().nullable() })
        .parse(await native({ operation: "read", account: this.account }));
      this.secrets = {
        ...(result.value ? keysSchema.parse(JSON.parse(result.value)) : {}),
        secureStorage: true,
        credentialMigrationRequired:
          !result.value && existsSync(join(this.root, "credentials.json")),
      };
    } catch {
      this.secrets = { secureStorage: false };
    }
  }
  async save(input: { openalexKey?: string; openaiKey?: string; ollamaKey?: string; pubmedKey?: string; tinyfishKey?: string }) {
    if ([input.openalexKey, input.openaiKey, input.ollamaKey, input.pubmedKey, input.tinyfishKey].every(key => key === undefined))
      return;
    if (process.env.RESEARCHBUNNY_TEST === "1")
      throw new AppError(
        "SECURE_STORAGE",
        "테스트 실행에서는 API 키를 저장하지 않습니다.",
      );
    const next = keysSchema.parse(this.secrets);
    if (input.openalexKey !== undefined)
      next.openalex = input.openalexKey.trim() || undefined;
    if (input.openaiKey !== undefined)
      next.openai = input.openaiKey.trim() || undefined;
    if (input.ollamaKey !== undefined) next.ollama = input.ollamaKey.trim() || undefined;
    if (input.pubmedKey !== undefined) next.pubmed = input.pubmedKey.trim() || undefined;
    if (input.tinyfishKey !== undefined) next.tinyfish = input.tinyfishKey.trim() || undefined;
    await native({
      operation: "write",
      account: this.account,
      value: JSON.stringify(next),
    });
    this.secrets = {
      ...next,
      secureStorage: true,
      credentialMigrationRequired: false,
    };
  }
}
