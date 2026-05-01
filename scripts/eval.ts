import "dotenv/config";
import { AnthropicLlmClient, ClinicalExtractor, GeminiClinicalExtractor, GroqClinicalExtractor } from "@test-evals/llm";
import { env } from "@test-evals/env/server";
import type { PromptStrategyName } from "@test-evals/shared";
import { DrizzleEvalRepository } from "../apps/server/src/services/repository";
import { RunnerService } from "../apps/server/src/services/runner.service";

function arg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

const strategy = (arg("strategy") ?? "zero_shot") as PromptStrategyName;
const model = arg("model") ?? defaultModel();
const limit = Number(arg("limit") ?? "0");

if (env.LLM_PROVIDER === "anthropic" && (!env.ANTHROPIC_API_KEY || env.ANTHROPIC_API_KEY.includes("your-real-key") || env.ANTHROPIC_API_KEY.includes("your-key"))) {
  throw new Error("ANTHROPIC_API_KEY is required for live evals. Put a real sk-ant key in apps/server/.env.");
}
if (env.LLM_PROVIDER === "gemini" && (!env.GEMINI_API_KEY || env.GEMINI_API_KEY.includes("your-gemini-key"))) {
  throw new Error("GEMINI_API_KEY is required when LLM_PROVIDER=gemini. Put a real Gemini key in apps/server/.env.");
}
if (env.LLM_PROVIDER === "groq" && (!env.GROQ_API_KEY || env.GROQ_API_KEY.includes("your-groq-key"))) {
  throw new Error("GROQ_API_KEY is required when LLM_PROVIDER=groq. Put a real Groq key in apps/server/.env.");
}

const extractor =
  env.LLM_PROVIDER === "gemini"
    ? new GeminiClinicalExtractor(env.GEMINI_API_KEY)
    : env.LLM_PROVIDER === "groq"
      ? new GroqClinicalExtractor(env.GROQ_API_KEY)
    : new ClinicalExtractor(new AnthropicLlmClient(env.ANTHROPIC_API_KEY));
const runner = new RunnerService(
  new DrizzleEvalRepository(),
  extractor,
  undefined,
  env.LLM_PROVIDER === "gemini"
    ? { concurrency: 1, minRequestIntervalMs: 13_000 }
    : env.LLM_PROVIDER === "groq"
      ? { concurrency: 1, minRequestIntervalMs: 11_000 }
      : undefined,
);
const datasetFilter = limit > 0 ? Array.from({ length: limit }, (_, index) => `case_${String(index + 1).padStart(3, "0")}`) : undefined;
const detail = await runner.runCli({ strategy, model, datasetFilter });

console.log(`\nHEALOSBENCH ${detail.runId}`);
console.table([
  {
    strategy: detail.strategy,
    model: detail.model,
    promptHash: detail.promptHash,
    status: detail.status,
    cases: detail.cases.length,
    aggregateF1: detail.aggregateF1.toFixed(3),
    hallucinations: detail.hallucinationCount,
    schemaFailures: detail.schemaFailureCount,
    cacheRead: detail.tokens.cacheRead,
    costUsd: detail.costUsd.toFixed(4),
    durationSec: (detail.durationMs / 1000).toFixed(1),
    error: detail.error ?? "",
  },
]);
console.table(
  Object.entries(detail.fieldAggregates).map(([field, score]) => ({
    field,
    score: score.toFixed(3),
  })),
);

function defaultModel(): string {
  if (env.LLM_PROVIDER === "gemini") return "gemini-2.5-flash";
  if (env.LLM_PROVIDER === "groq") return "llama-3.1-8b-instant";
  return "claude-haiku-4-5-20251001";
}
