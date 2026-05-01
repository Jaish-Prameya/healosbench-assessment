import type { EvalRepository, StoredCase, StoredRun } from "./repository";
import type { LlmAttempt } from "@test-evals/shared";

export class MemoryEvalRepository implements EvalRepository {
  runs = new Map<string, StoredRun>();
  cases = new Map<string, StoredCase>();

  async createRun(input: { id: string; strategy: string; model: string; promptHash: string; datasetFilter: string[] | null }): Promise<void> {
    void input.datasetFilter;
    this.runs.set(input.id, {
      id: input.id,
      strategy: input.strategy,
      model: input.model,
      promptHash: input.promptHash,
      status: "queued",
      datasetFilter: input.datasetFilter,
      aggregate: null,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      costUsd: 0,
      durationMs: 0,
      hallucinationCount: 0,
      schemaFailureCount: 0,
      error: null,
      createdAt: new Date(),
    });
  }

  async updateRun(id: string, patch: Partial<StoredRun>): Promise<void> {
    const run = this.runs.get(id);
    if (run) this.runs.set(id, { ...run, ...patch });
  }

  async listRuns(): Promise<StoredRun[]> {
    return [...this.runs.values()];
  }

  async getRun(id: string): Promise<StoredRun | null> {
    return this.runs.get(id) ?? null;
  }

  async listCases(runId: string): Promise<StoredCase[]> {
    return [...this.cases.values()].filter((item) => item.runId === runId);
  }

  async findCachedCase(strategy: string, model: string, promptHash: string, transcriptId: string): Promise<StoredCase | null> {
    return (
      [...this.cases.values()].find(
        (item) =>
          item.status === "completed" &&
          item.transcriptId === transcriptId &&
          this.runs.get(item.runId)?.strategy === strategy &&
          this.runs.get(item.runId)?.model === model &&
          this.runs.get(item.runId)?.promptHash === promptHash,
      ) ?? null
    );
  }

  async saveCase(input: Omit<StoredCase, "attempts">): Promise<void> {
    this.cases.set(input.id, { ...input, attempts: [] });
  }

  async saveAttempts(caseId: string, attempts: LlmAttempt[]): Promise<void> {
    const item = this.cases.get(caseId);
    if (item) this.cases.set(caseId, { ...item, attempts });
  }
}
