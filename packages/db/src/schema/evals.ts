import { relations } from "drizzle-orm";
import { boolean, doublePrecision, index, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const evalRuns = pgTable(
  "eval_runs",
  {
    id: text("id").primaryKey(),
    strategy: text("strategy").notNull(),
    model: text("model").notNull(),
    promptHash: text("prompt_hash").notNull(),
    status: text("status").notNull(),
    datasetFilter: jsonb("dataset_filter"),
    aggregate: jsonb("aggregate"),
    tokens: jsonb("tokens").notNull(),
    costUsd: doublePrecision("cost_usd").default(0).notNull(),
    durationMs: integer("duration_ms").default(0).notNull(),
    hallucinationCount: integer("hallucination_count").default(0).notNull(),
    schemaFailureCount: integer("schema_failure_count").default(0).notNull(),
    error: text("error"),
    startedAt: timestamp("started_at"),
    completedAt: timestamp("completed_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [index("eval_runs_status_idx").on(table.status)],
);

export const evalCases = pgTable(
  "eval_cases",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => evalRuns.id, { onDelete: "cascade" }),
    transcriptId: text("transcript_id").notNull(),
    strategy: text("strategy").notNull(),
    model: text("model").notNull(),
    promptHash: text("prompt_hash").notNull(),
    transcript: text("transcript").notNull(),
    gold: jsonb("gold").notNull(),
    prediction: jsonb("prediction"),
    evaluation: jsonb("evaluation"),
    tokens: jsonb("tokens").notNull(),
    cached: boolean("cached").default(false).notNull(),
    status: text("status").notNull(),
    error: text("error"),
    completedAt: timestamp("completed_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("eval_cases_run_idx").on(table.runId),
    index("eval_cases_cache_idx").on(table.strategy, table.model, table.promptHash, table.transcriptId),
  ],
);

export const evalAttempts = pgTable(
  "eval_attempts",
  {
    id: text("id").primaryKey(),
    caseId: text("case_id")
      .notNull()
      .references(() => evalCases.id, { onDelete: "cascade" }),
    attempt: integer("attempt").notNull(),
    request: jsonb("request").notNull(),
    response: jsonb("response").notNull(),
    validationErrors: jsonb("validation_errors").notNull(),
    tokenUsage: jsonb("token_usage").notNull(),
    startedAt: timestamp("started_at").notNull(),
    completedAt: timestamp("completed_at").notNull(),
  },
  (table) => [index("eval_attempts_case_idx").on(table.caseId)],
);

export const evalRunRelations = relations(evalRuns, ({ many }) => ({
  cases: many(evalCases),
}));

export const evalCaseRelations = relations(evalCases, ({ one, many }) => ({
  run: one(evalRuns, { fields: [evalCases.runId], references: [evalRuns.id] }),
  attempts: many(evalAttempts),
}));

export const evalAttemptRelations = relations(evalAttempts, ({ one }) => ({
  case: one(evalCases, { fields: [evalAttempts.caseId], references: [evalCases.id] }),
}));
