import { describe, expect, test } from "bun:test";
import { ClinicalExtractor, promptHash, strategies, type LlmClient } from "@test-evals/llm";
import type { ClinicalExtraction, LlmAttempt, PromptStrategyName, TokenUsage } from "@test-evals/shared";
import { detectHallucinations, setF1, scoreExtraction } from "@test-evals/shared/evaluate";
import { MemoryEvalRepository } from "../apps/server/src/services/memory-repository";
import { RateLimitError, withRateLimitBackoff } from "../apps/server/src/services/rate-limit";
import { RunnerService } from "../apps/server/src/services/runner.service";

const extraction: ClinicalExtraction = {
  chief_complaint: "sore throat",
  vitals: { bp: "122/78", hr: 88, temp_f: 100.4, spo2: 98 },
  medications: [{ name: "ibuprofen", dose: "400 mg", frequency: "every 6 hours", route: "PO" }],
  diagnoses: [{ description: "viral upper respiratory infection", icd10: "J06.9" }],
  plan: ["ibuprofen 400 mg every 6 hours", "fluids"],
  follow_up: { interval_days: null, reason: "if symptoms worsen" },
};

const tokens: TokenUsage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 20 };

function fakeAttempt(attempt = 1): LlmAttempt {
  return {
    attempt,
    request: {},
    response: {},
    validationErrors: [],
    tokenUsage: tokens,
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
  };
}

describe("evaluation metrics", () => {
  test("fuzzy medication matching normalizes BID and dose spacing", () => {
    const predicted = { ...extraction, medications: [{ name: "Ibuprofen", dose: "400mg", frequency: "q6h", route: "PO" }] };
    const gold = { ...extraction, medications: [{ name: "ibuprofen", dose: "400 mg", frequency: "every 6 hours", route: "PO" }] };
    expect(scoreExtraction(predicted, gold).medications).toBe(1);
  });

  test("set F1 handles a tiny synthetic case", () => {
    const score = setF1({
      predicted: ["a", "b"],
      gold: ["a", "c"],
      matches: (left, right) => left === right,
    });
    expect(score).toBe(0.5);
  });

  test("hallucination detector flags unsupported values", () => {
    const hallucinations = detectHallucinations("Patient has sore throat. BP 122/78.", {
      ...extraction,
      diagnoses: [{ description: "pneumonia" }],
    });
    expect(hallucinations.some((item) => item.value === "pneumonia")).toBe(true);
  });

  test("hallucination detector accepts grounded values", () => {
    const hallucinations = detectHallucinations("Patient has sore throat and viral upper respiratory infection. BP 122/78 HR 88 temp 100.4 SpO2 98.", extraction);
    expect(hallucinations.some((item) => item.value === "viral upper respiratory infection")).toBe(false);
  });
});

describe("llm plumbing", () => {
  test("schema-validation retry path sends feedback and succeeds", async () => {
    const calls: unknown[] = [];
    const client: LlmClient = {
      async createMessage(request: unknown) {
        calls.push(request);
        if (calls.length === 1) return { content: [{ type: "tool_use", input: { chief_complaint: "" } }], usage: { input_tokens: 1 } };
        return { content: [{ type: "tool_use", input: extraction }], usage: { input_tokens: 2, cache_read_input_tokens: 10 } };
      },
    };
    const result = await new ClinicalExtractor(client).extract({ transcript: "x", strategy: "zero_shot", model: "mock" });
    expect(result.schemaValid).toBe(true);
    expect(result.attempts).toHaveLength(2);
    expect(JSON.stringify(calls[1])).toContain("failed schema validation");
    expect(result.tokens.cacheRead).toBe(10);
  });

  test("prompt hash is stable and content sensitive", () => {
    expect(promptHash(strategies.zero_shot)).toBe(promptHash(strategies.zero_shot));
    expect(promptHash(strategies.zero_shot)).not.toBe(promptHash({ ...strategies.zero_shot, userInstruction: `${strategies.zero_shot.userInstruction}!` }));
  });

  test("rate-limit backoff retries 429-like errors", async () => {
    let calls = 0;
    const result = await withRateLimitBackoff(async () => {
      calls += 1;
      if (calls < 2) throw new RateLimitError();
      return "ok";
    });
    expect(result).toBe("ok");
    expect(calls).toBe(2);
  });
});

describe("runner behavior", () => {
  function extractorMock() {
    let calls = 0;
    return {
      get calls() {
        return calls;
      },
      async extract(_request: { transcript: string; strategy: PromptStrategyName; model: string }) {
        calls += 1;
        return { prediction: extraction, attempts: [fakeAttempt()], promptHash: promptHash(strategies.zero_shot), tokens, schemaValid: true };
      },
    };
  }

  test("idempotency reuses cached case without another LLM call", async () => {
    const repo = new MemoryEvalRepository();
    const llm = extractorMock();
    const runner = new RunnerService(repo, llm);
    await runner.runCli({ strategy: "zero_shot", model: "mock", datasetFilter: ["case_001"] });
    await runner.runCli({ strategy: "zero_shot", model: "mock", datasetFilter: ["case_001"] });
    expect(llm.calls).toBe(1);
  });

  test("resumability skips completed cases and continues pending ones", async () => {
    const repo = new MemoryEvalRepository();
    const llm = extractorMock();
    const runner = new RunnerService(repo, llm);
    const runId = crypto.randomUUID();
    const hash = promptHash(strategies.zero_shot);
    await repo.createRun({ id: runId, strategy: "zero_shot", model: "mock", promptHash: hash, datasetFilter: ["case_001", "case_002"] });
    await repo.saveCase({
      id: crypto.randomUUID(),
      runId,
      transcriptId: "case_001",
      transcript: "done",
      gold: extraction,
      prediction: extraction,
      evaluation: { transcriptId: "case_001", scores: scoreExtraction(extraction, extraction), hallucinations: [], schemaValid: true },
      tokens,
      cached: false,
      status: "completed",
      strategy: "zero_shot",
      model: "mock",
      promptHash: hash,
    });
    await runner.resumeRun(runId);
    expect(llm.calls).toBe(1);
    expect((await repo.listCases(runId))).toHaveLength(2);
  });
});
