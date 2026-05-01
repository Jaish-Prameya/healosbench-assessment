import { z } from "zod";

export const extractionSchema = z.object({
  chief_complaint: z.string().min(1),
  vitals: z.object({
    bp: z.string().regex(/^[0-9]{2,3}\/[0-9]{2,3}$/).nullable(),
    hr: z.number().int().min(20).max(250).nullable(),
    temp_f: z.number().min(90).max(110).nullable(),
    spo2: z.number().int().min(50).max(100).nullable(),
  }),
  medications: z.array(
    z.object({
      name: z.string().min(1),
      dose: z.string().nullable(),
      frequency: z.string().nullable(),
      route: z.string().nullable(),
    }),
  ),
  diagnoses: z.array(
    z.object({
      description: z.string().min(1),
      icd10: z.string().regex(/^[A-Z][0-9]{2}(\.[0-9A-Z]{1,4})?$/).optional(),
    }),
  ),
  plan: z.array(z.string().min(1)),
  follow_up: z.object({
    interval_days: z.number().int().min(0).max(730).nullable(),
    reason: z.string().nullable(),
  }),
});

export type ClinicalExtraction = z.infer<typeof extractionSchema>;
export type PromptStrategyName = "zero_shot" | "few_shot" | "cot";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "paused";

export type TokenUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

export type LlmAttempt = {
  attempt: number;
  request: unknown;
  response: unknown;
  validationErrors: string[];
  tokenUsage: TokenUsage;
  startedAt: string;
  completedAt: string;
};

export type FieldScores = {
  chief_complaint: number;
  vitals: number;
  medications: number;
  diagnoses: number;
  plan: number;
  follow_up: number;
  aggregate: number;
};

export type Hallucination = {
  field: string;
  value: string;
  reason: string;
};

export type CaseEvaluation = {
  transcriptId: string;
  scores: FieldScores;
  hallucinations: Hallucination[];
  schemaValid: boolean;
};

export type RunSummary = {
  runId: string;
  strategy: PromptStrategyName;
  model: string;
  promptHash: string;
  status: RunStatus;
  aggregateF1: number;
  fieldAggregates: FieldScores;
  hallucinationCount: number;
  schemaFailureCount: number;
  tokens: TokenUsage;
  costUsd: number;
  durationMs: number;
  error?: string | null;
};

export type RunCaseDto = {
  id: string;
  runId: string;
  transcriptId: string;
  transcript: string;
  gold: ClinicalExtraction;
  prediction: ClinicalExtraction | null;
  evaluation: CaseEvaluation | null;
  attempts: LlmAttempt[];
  cached: boolean;
  status: "pending" | "completed" | "failed";
};

export type RunDetailDto = RunSummary & {
  cases: RunCaseDto[];
};

export function validateExtraction(value: unknown): {
  ok: boolean;
  data: ClinicalExtraction | null;
  errors: string[];
} {
  const result = extractionSchema.safeParse(value);
  if (result.success) {
    return { ok: true, data: result.data, errors: [] };
  }
  return {
    ok: false,
    data: null,
    errors: result.error.issues.map((issue) => {
      const path = issue.path.length ? issue.path.join(".") : "root";
      return `${path}: ${issue.message}`;
    }),
  };
}

export const extractionJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["chief_complaint", "vitals", "medications", "diagnoses", "plan", "follow_up"],
  properties: {
    chief_complaint: { type: "string", minLength: 1 },
    vitals: {
      type: "object",
      additionalProperties: false,
      required: ["bp", "hr", "temp_f", "spo2"],
      properties: {
        bp: { type: ["string", "null"], pattern: "^[0-9]{2,3}/[0-9]{2,3}$" },
        hr: { type: ["integer", "null"], minimum: 20, maximum: 250 },
        temp_f: { type: ["number", "null"], minimum: 90, maximum: 110 },
        spo2: { type: ["integer", "null"], minimum: 50, maximum: 100 },
      },
    },
    medications: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "dose", "frequency", "route"],
        properties: {
          name: { type: "string", minLength: 1 },
          dose: { type: ["string", "null"] },
          frequency: { type: ["string", "null"] },
          route: { type: ["string", "null"] },
        },
      },
    },
    diagnoses: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["description"],
        properties: {
          description: { type: "string", minLength: 1 },
          icd10: { type: "string", pattern: "^[A-Z][0-9]{2}(\\.[0-9A-Z]{1,4})?$" },
        },
      },
    },
    plan: { type: "array", items: { type: "string", minLength: 1 } },
    follow_up: {
      type: "object",
      additionalProperties: false,
      required: ["interval_days", "reason"],
      properties: {
        interval_days: { type: ["integer", "null"], minimum: 0, maximum: 730 },
        reason: { type: ["string", "null"] },
      },
    },
  },
};
