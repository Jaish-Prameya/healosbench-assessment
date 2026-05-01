import type { ExtractResult } from "@test-evals/llm";
import { promptHash, strategies } from "@test-evals/llm";
import type { CaseEvaluation, FieldScores, PromptStrategyName, RunDetailDto, RunSummary, TokenUsage } from "@test-evals/shared";
import { evaluateCase } from "./evaluate.service";
import type { DatasetCase } from "./dataset.service";
import { loadDataset } from "./dataset.service";
import { Semaphore, withRateLimitBackoff } from "./rate-limit";
import type { EvalRepository, StoredCase } from "./repository";

const ZERO_TOKENS: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const ZERO_FIELDS: FieldScores = {
  chief_complaint: 0,
  vitals: 0,
  medications: 0,
  diagnoses: 0,
  plan: 0,
  follow_up: 0,
  aggregate: 0,
};

type RunEvent = { runId: string; type: "case" | "completed" | "failed"; payload: unknown };
type ExtractorLike = {
  extract(request: { transcript: string; strategy: PromptStrategyName; model: string }): Promise<ExtractResult>;
};

export class RunnerEvents {
  private readonly listeners = new Map<string, Set<(event: RunEvent) => void>>();

  subscribe(runId: string, listener: (event: RunEvent) => void): () => void {
    const listeners = this.listeners.get(runId) ?? new Set<(event: RunEvent) => void>();
    listeners.add(listener);
    this.listeners.set(runId, listeners);
    return () => listeners.delete(listener);
  }

  emit(event: RunEvent): void {
    this.listeners.get(event.runId)?.forEach((listener) => listener(event));
  }
}

export type StartRunInput = {
  strategy: PromptStrategyName;
  model: string;
  datasetFilter?: string[];
  force?: boolean;
};

export class RunnerService {
  private readonly semaphore: Semaphore;
  private lastRequestAt = 0;

  constructor(
    private readonly repository: EvalRepository,
    private readonly extractor: ExtractorLike,
    private readonly events = new RunnerEvents(),
    private readonly options: { concurrency?: number; minRequestIntervalMs?: number } = {},
  ) {
    this.semaphore = new Semaphore(options.concurrency ?? 5);
  }

  get eventBus(): RunnerEvents {
    return this.events;
  }

  async startRun(input: StartRunInput): Promise<string> {
    const hash = promptHash(strategies[input.strategy]);
    const runId = crypto.randomUUID();
    await this.repository.createRun({
      id: runId,
      strategy: input.strategy,
      model: input.model,
      promptHash: hash,
      datasetFilter: input.datasetFilter ?? null,
    });
    void this.executeRun(runId, input, new Date());
    return runId;
  }

  async resumeRun(runId: string): Promise<void> {
    const run = await this.repository.getRun(runId);
    if (!run) throw new Error(`Run ${runId} not found`);
    await this.executeRun(runId, { strategy: run.strategy as PromptStrategyName, model: run.model, datasetFilter: run.datasetFilter ?? undefined }, new Date());
  }

  async runCli(input: StartRunInput): Promise<RunDetailDto> {
    const hash = promptHash(strategies[input.strategy]);
    const runId = crypto.randomUUID();
    await this.repository.createRun({ id: runId, strategy: input.strategy, model: input.model, promptHash: hash, datasetFilter: input.datasetFilter ?? null });
    await this.executeRun(runId, input, new Date());
    const detail = await this.getRunDetail(runId);
    if (!detail) throw new Error("Run disappeared after completion");
    return detail;
  }

  async getRunDetail(runId: string): Promise<RunDetailDto | null> {
    const run = await this.repository.getRun(runId);
    if (!run) return null;
    const cases = await this.repository.listCases(runId);
    return {
      runId: run.id,
      strategy: run.strategy as PromptStrategyName,
      model: run.model,
      promptHash: run.promptHash,
      status: run.status,
      aggregateF1: run.aggregate?.aggregate ?? 0,
      fieldAggregates: run.aggregate ?? ZERO_FIELDS,
      hallucinationCount: run.hallucinationCount,
      schemaFailureCount: run.schemaFailureCount,
      tokens: run.tokens,
      costUsd: run.costUsd,
      durationMs: run.durationMs,
      error: run.error,
      cases: cases.map((item) => ({
        id: item.id,
        runId: item.runId,
        transcriptId: item.transcriptId,
        transcript: item.transcript,
        gold: item.gold,
        prediction: item.prediction,
        evaluation: item.evaluation,
        attempts: item.attempts,
        cached: item.cached,
        status: item.status,
      })),
    };
  }

  async listRuns(): Promise<RunSummary[]> {
    const runs = await this.repository.listRuns();
    return runs.map((run) => ({
      runId: run.id,
      strategy: run.strategy as PromptStrategyName,
      model: run.model,
      promptHash: run.promptHash,
      status: run.status,
      aggregateF1: run.aggregate?.aggregate ?? 0,
      fieldAggregates: run.aggregate ?? ZERO_FIELDS,
      hallucinationCount: run.hallucinationCount,
      schemaFailureCount: run.schemaFailureCount,
      tokens: run.tokens,
      costUsd: run.costUsd,
      durationMs: run.durationMs,
      error: run.error,
    }));
  }

  private async executeRun(runId: string, input: StartRunInput, startedAt: Date): Promise<void> {
    try {
      await this.repository.updateRun(runId, { status: "running", startedAt });
      const dataset = await loadDataset(input.datasetFilter);
      const completed = new Set((await this.repository.listCases(runId)).filter((item) => item.status === "completed").map((item) => item.transcriptId));
      const pending = dataset.filter((item) => !completed.has(item.transcriptId));
      await Promise.all(pending.map((item) => this.semaphore.run(() => this.processCase(runId, input, item))));
      await this.finishRun(runId, startedAt);
      this.events.emit({ runId, type: "completed", payload: await this.getRunDetail(runId) });
    } catch (error) {
      await this.repository.updateRun(runId, { status: "failed", error: error instanceof Error ? error.message : String(error) });
      this.events.emit({ runId, type: "failed", payload: { message: error instanceof Error ? error.message : String(error) } });
    }
  }

  private async processCase(runId: string, input: StartRunInput, item: DatasetCase): Promise<void> {
    const hash = promptHash(strategies[input.strategy]);
    const cached = input.force ? null : await this.repository.findCachedCase(input.strategy, input.model, hash, item.transcriptId);
    if (cached?.prediction && cached.evaluation) {
      const copy = this.caseFromCached(runId, input, hash, item, cached);
      await this.repository.saveCase(copy);
      await this.repository.saveAttempts(copy.id, cached.attempts);
      this.events.emit({ runId, type: "case", payload: copy });
      return;
    }

    const extracted = await withRateLimitBackoff(() =>
      this.throttledExtract({ transcript: item.transcript, strategy: input.strategy, model: input.model }),
    );
    const evaluation = extracted.prediction ? evaluateCase(item.transcriptId, item.transcript, extracted.prediction, item.gold) : null;
    const caseId = crypto.randomUUID();
    const stored = this.caseFromExtraction(caseId, runId, input, hash, item, extracted, evaluation);
    await this.repository.saveCase(stored);
    await this.repository.saveAttempts(caseId, extracted.attempts);
    this.events.emit({ runId, type: "case", payload: stored });
  }

  private async throttledExtract(request: { transcript: string; strategy: PromptStrategyName; model: string }): Promise<ExtractResult> {
    const interval = this.options.minRequestIntervalMs ?? 0;
    if (interval > 0) {
      const waitMs = Math.max(0, this.lastRequestAt + interval - Date.now());
      if (waitMs > 0) await Bun.sleep(waitMs);
      this.lastRequestAt = Date.now();
    }
    return this.extractor.extract(request);
  }

  private caseFromCached(runId: string, input: StartRunInput, hash: string, item: DatasetCase, cached: StoredCase): Omit<StoredCase, "attempts"> & { strategy: string; model: string; promptHash: string } {
    return {
      id: crypto.randomUUID(),
      runId,
      transcriptId: item.transcriptId,
      transcript: item.transcript,
      gold: item.gold,
      prediction: cached.prediction,
      evaluation: cached.evaluation,
      tokens: ZERO_TOKENS,
      cached: true,
      status: "completed",
      strategy: input.strategy,
      model: input.model,
      promptHash: hash,
    };
  }

  private caseFromExtraction(
    caseId: string,
    runId: string,
    input: StartRunInput,
    hash: string,
    item: DatasetCase,
    extracted: ExtractResult,
    evaluation: CaseEvaluation | null,
  ): Omit<StoredCase, "attempts"> & { strategy: string; model: string; promptHash: string } {
    return {
      id: caseId,
      runId,
      transcriptId: item.transcriptId,
      transcript: item.transcript,
      gold: item.gold,
      prediction: extracted.prediction,
      evaluation,
      tokens: extracted.tokens,
      cached: false,
      status: extracted.prediction ? "completed" : "failed",
      strategy: input.strategy,
      model: input.model,
      promptHash: hash,
    };
  }

  private async finishRun(runId: string, startedAt: Date): Promise<void> {
    const cases = await this.repository.listCases(runId);
    const completed = cases.filter((item) => item.status === "completed" && item.evaluation);
    const aggregate = this.aggregateScores(completed.map((item) => item.evaluation?.scores).filter((item): item is FieldScores => Boolean(item)));
    const tokens = cases.reduce<TokenUsage>(
      (sum, item) => ({
        input: sum.input + item.tokens.input,
        output: sum.output + item.tokens.output,
        cacheRead: sum.cacheRead + item.tokens.cacheRead,
        cacheWrite: sum.cacheWrite + item.tokens.cacheWrite,
      }),
      { ...ZERO_TOKENS },
    );
    await this.repository.updateRun(runId, {
      status: "completed",
      aggregate,
      tokens,
      costUsd: this.estimateHaikuCost(tokens),
      durationMs: Date.now() - startedAt.getTime(),
      hallucinationCount: completed.reduce((sum, item) => sum + (item.evaluation?.hallucinations.length ?? 0), 0),
      schemaFailureCount: cases.filter((item) => item.status === "failed").length,
      completedAt: new Date(),
    });
  }

  private aggregateScores(scores: FieldScores[]): FieldScores {
    if (scores.length === 0) return ZERO_FIELDS;
    return scores.reduce(
      (sum, score) => ({
        chief_complaint: sum.chief_complaint + score.chief_complaint / scores.length,
        vitals: sum.vitals + score.vitals / scores.length,
        medications: sum.medications + score.medications / scores.length,
        diagnoses: sum.diagnoses + score.diagnoses / scores.length,
        plan: sum.plan + score.plan / scores.length,
        follow_up: sum.follow_up + score.follow_up / scores.length,
        aggregate: sum.aggregate + score.aggregate / scores.length,
      }),
      { ...ZERO_FIELDS },
    );
  }

  private estimateHaikuCost(tokens: TokenUsage): number {
    return Number((((tokens.input + tokens.cacheWrite) / 1_000_000) * 0.8 + (tokens.output / 1_000_000) * 4 + (tokens.cacheRead / 1_000_000) * 0.08).toFixed(6));
  }
}
