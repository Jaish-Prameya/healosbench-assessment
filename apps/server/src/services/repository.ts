import { and, desc, eq } from "drizzle-orm";
import { db } from "@test-evals/db";
import { evalAttempts, evalCases, evalRuns } from "@test-evals/db/schema/evals";
import type { CaseEvaluation, ClinicalExtraction, FieldScores, LlmAttempt, RunStatus, TokenUsage } from "@test-evals/shared";

export type StoredRun = {
  id: string;
  strategy: string;
  model: string;
  promptHash: string;
  status: RunStatus;
  datasetFilter: string[] | null;
  aggregate: FieldScores | null;
  tokens: TokenUsage;
  costUsd: number;
  durationMs: number;
  hallucinationCount: number;
  schemaFailureCount: number;
  error: string | null;
  createdAt: Date;
};

export type StoredCase = {
  id: string;
  runId: string;
  transcriptId: string;
  transcript: string;
  gold: ClinicalExtraction;
  prediction: ClinicalExtraction | null;
  evaluation: CaseEvaluation | null;
  attempts: LlmAttempt[];
  tokens: TokenUsage;
  cached: boolean;
  status: "pending" | "completed" | "failed";
};

export interface EvalRepository {
  createRun(input: {
    id: string;
    strategy: string;
    model: string;
    promptHash: string;
    datasetFilter: string[] | null;
  }): Promise<void>;
  updateRun(id: string, patch: Partial<StoredRun> & { error?: string | null; completedAt?: Date | null; startedAt?: Date | null }): Promise<void>;
  listRuns(): Promise<StoredRun[]>;
  getRun(id: string): Promise<StoredRun | null>;
  listCases(runId: string): Promise<StoredCase[]>;
  findCachedCase(strategy: string, model: string, promptHash: string, transcriptId: string): Promise<StoredCase | null>;
  saveCase(input: Omit<StoredCase, "attempts"> & { strategy: string; model: string; promptHash: string }): Promise<void>;
  saveAttempts(caseId: string, attempts: LlmAttempt[]): Promise<void>;
}

export class DrizzleEvalRepository implements EvalRepository {
  async createRun(input: { id: string; strategy: string; model: string; promptHash: string; datasetFilter: string[] | null }): Promise<void> {
    await db.insert(evalRuns).values({
      id: input.id,
      strategy: input.strategy,
      model: input.model,
      promptHash: input.promptHash,
      status: "queued",
      datasetFilter: input.datasetFilter,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
  }

  async updateRun(id: string, patch: Partial<StoredRun> & { error?: string | null; completedAt?: Date | null; startedAt?: Date | null }): Promise<void> {
    await db.update(evalRuns).set(patch).where(eq(evalRuns.id, id));
  }

  async listRuns(): Promise<StoredRun[]> {
    const rows = await db.select().from(evalRuns).orderBy(desc(evalRuns.createdAt));
    return rows.map(this.runFromRow);
  }

  async getRun(id: string): Promise<StoredRun | null> {
    const row = await db.query.evalRuns.findFirst({ where: eq(evalRuns.id, id) });
    return row ? this.runFromRow(row) : null;
  }

  async listCases(runId: string): Promise<StoredCase[]> {
    const rows = await db.query.evalCases.findMany({
      where: eq(evalCases.runId, runId),
      with: { attempts: true },
    });
    return rows.map((row) => ({
      id: row.id,
      runId: row.runId,
      transcriptId: row.transcriptId,
      transcript: row.transcript,
      gold: row.gold as ClinicalExtraction,
      prediction: row.prediction as ClinicalExtraction | null,
      evaluation: row.evaluation as CaseEvaluation | null,
      attempts: row.attempts.map((attempt) => ({
        attempt: attempt.attempt,
        request: attempt.request,
        response: attempt.response,
        validationErrors: attempt.validationErrors as string[],
        tokenUsage: attempt.tokenUsage as TokenUsage,
        startedAt: attempt.startedAt.toISOString(),
        completedAt: attempt.completedAt.toISOString(),
      })),
      tokens: row.tokens as TokenUsage,
      cached: row.cached,
      status: row.status as StoredCase["status"],
    }));
  }

  async findCachedCase(strategy: string, model: string, promptHash: string, transcriptId: string): Promise<StoredCase | null> {
    const row = await db.query.evalCases.findFirst({
      where: and(
        eq(evalCases.strategy, strategy),
        eq(evalCases.model, model),
        eq(evalCases.promptHash, promptHash),
        eq(evalCases.transcriptId, transcriptId),
        eq(evalCases.status, "completed"),
      ),
      with: { attempts: true },
    });
    return row
      ? {
          id: row.id,
          runId: row.runId,
          transcriptId: row.transcriptId,
          transcript: row.transcript,
          gold: row.gold as ClinicalExtraction,
          prediction: row.prediction as ClinicalExtraction | null,
          evaluation: row.evaluation as CaseEvaluation | null,
          attempts: row.attempts.map((attempt) => ({
            attempt: attempt.attempt,
            request: attempt.request,
            response: attempt.response,
            validationErrors: attempt.validationErrors as string[],
            tokenUsage: attempt.tokenUsage as TokenUsage,
            startedAt: attempt.startedAt.toISOString(),
            completedAt: attempt.completedAt.toISOString(),
          })),
          tokens: row.tokens as TokenUsage,
          cached: row.cached,
          status: row.status as StoredCase["status"],
        }
      : null;
  }

  async saveCase(input: Omit<StoredCase, "attempts"> & { strategy: string; model: string; promptHash: string }): Promise<void> {
    await db.insert(evalCases).values({
      id: input.id,
      runId: input.runId,
      transcriptId: input.transcriptId,
      strategy: input.strategy,
      model: input.model,
      promptHash: input.promptHash,
      transcript: input.transcript,
      gold: input.gold,
      prediction: input.prediction,
      evaluation: input.evaluation,
      tokens: input.tokens,
      cached: input.cached,
      status: input.status,
      completedAt: input.status === "completed" ? new Date() : null,
    });
  }

  async saveAttempts(caseId: string, attempts: LlmAttempt[]): Promise<void> {
    if (attempts.length === 0) return;
    await db.insert(evalAttempts).values(
      attempts.map((attempt) => ({
        id: crypto.randomUUID(),
        caseId,
        attempt: attempt.attempt,
        request: attempt.request,
        response: attempt.response,
        validationErrors: attempt.validationErrors,
        tokenUsage: attempt.tokenUsage,
        startedAt: new Date(attempt.startedAt),
        completedAt: new Date(attempt.completedAt),
      })),
    );
  }

  private runFromRow(row: typeof evalRuns.$inferSelect): StoredRun {
    return {
      id: row.id,
      strategy: row.strategy,
      model: row.model,
      promptHash: row.promptHash,
      status: row.status as RunStatus,
      aggregate: row.aggregate as FieldScores | null,
      tokens: row.tokens as TokenUsage,
      costUsd: row.costUsd,
      durationMs: row.durationMs,
      hallucinationCount: row.hallucinationCount,
      schemaFailureCount: row.schemaFailureCount,
      error: row.error,
      datasetFilter: row.datasetFilter as string[] | null,
      createdAt: row.createdAt,
    };
  }
}
