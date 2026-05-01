# HEALOSBENCH Notes

## How to Run

1. `bun install`
2. Add `DATABASE_URL` and `ANTHROPIC_API_KEY` to `apps/server/.env`
3. `bun run db:push`
4. `bun run eval -- --strategy=zero_shot --model=claude-haiku-4-5-20251001`
5. `bun run dev` for the Hono API and Next dashboard

## Evaluation Method

The evaluator uses field-specific metrics: fuzzy token-set scoring for chief complaint, exact/numeric-tolerant scoring for vitals, set F1 for medications/diagnoses/plan, ICD-10 bonus credit for diagnoses, and mixed exact/fuzzy scoring for follow-up. Hallucinations are flagged when predicted values cannot be found as normalized substrings or close fuzzy matches in the transcript.

## LLM Plumbing

The extractor uses Anthropic tool use with the provided JSON schema shape, not free-form JSON parsing. It retries up to three times and feeds validation errors back to the model. System prompts and few-shot examples are marked with ephemeral prompt-cache controls, and cache read/write token counts are saved per attempt and aggregated per run.

Optional Gemini and Groq providers are also available for no-cost/local demo runs. Gemini uses structured JSON output; Groq uses OpenAI-compatible JSON object mode. Both use the same validation retry loop and evaluator. They are not replacements for the Anthropic-specific assignment requirements because they do not expose Anthropic prompt-cache fields like `cache_read_input_tokens`.

Concurrency is capped at five in-flight cases. If Anthropic returns a 429 or rate-limit-like error, the runner retries the case with exponential backoff before failing it.

Runs are resumable: `/api/v1/runs/:id/resume` reloads completed case rows for the run and only processes missing transcript IDs. Idempotency is implemented by looking up a completed case with the same strategy, model, prompt hash, and transcript ID before calling the LLM.

## Current Results

No live Anthropic run was executed in this workspace because no API key was available during implementation. The harness is wired to produce the results table through `bun run eval`. The following are 2-case Groq demo smoke-test runs using `llama-3.1-8b-instant`; they are useful for proving the harness flow, but they are not a substitute for the requested full Anthropic Haiku run.

| Strategy | Model | Cases | Aggregate F1 | Chief Complaint | Vitals | Medications | Diagnoses | Plan | Follow-up | Hallucinations | Schema Failures | Cost |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| zero_shot | llama-3.1-8b-instant | 2 | 0.545 | 0.406 | 1.000 | 0.500 | 1.000 | 0.367 | 0.000 | 0 | 0 | 0.0000 |
| few_shot | llama-3.1-8b-instant | 2 | 0.591 | 0.567 | 1.000 | 0.500 | 1.000 | 0.367 | 0.110 | 2 | 0 | 0.0030 |
| cot | llama-3.1-8b-instant | 2 | 0.591 | 0.567 | 1.000 | 0.500 | 1.000 | 0.367 | 0.110 | 2 | 0 | 0.0030 |

On this tiny sample, few-shot and CoT tie overall and beat zero-shot mainly on chief complaint and follow-up. Vitals and diagnoses are already perfect across strategies; plan and medications are the weakest fields. The hallucination count on few-shot/CoT should be inspected case-by-case before trusting the apparent score gain.

## What I Would Build Next

I would add prompt diffing between prompt hashes, a projected-cost guardrail before starting a run, and case-level disagreement ranking across strategies for active-learning review.
