import { createHash } from "node:crypto";
import type { PromptStrategy } from "./prompts";

export function promptHash(strategy: PromptStrategy): string {
  return createHash("sha256")
    .update(JSON.stringify({ system: strategy.system, examples: strategy.examples, userInstruction: strategy.userInstruction }))
    .digest("hex")
    .slice(0, 16);
}
