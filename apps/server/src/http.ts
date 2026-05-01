import { ClinicalExtractor, AnthropicLlmClient, GeminiClinicalExtractor, GroqClinicalExtractor } from "@test-evals/llm";
import { env } from "@test-evals/env/server";
import { Hono } from "hono";
import { DrizzleEvalRepository } from "./services/repository";
import { RunnerService } from "./services/runner.service";

export function createRunnerService(): RunnerService {
  if (env.LLM_PROVIDER === "gemini") {
    if (!env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is required when LLM_PROVIDER=gemini");
    return new RunnerService(new DrizzleEvalRepository(), new GeminiClinicalExtractor(env.GEMINI_API_KEY), undefined, {
      concurrency: 1,
      minRequestIntervalMs: 13_000,
    });
  }
  if (env.LLM_PROVIDER === "groq") {
    if (!env.GROQ_API_KEY) throw new Error("GROQ_API_KEY is required when LLM_PROVIDER=groq");
    return new RunnerService(new DrizzleEvalRepository(), new GroqClinicalExtractor(env.GROQ_API_KEY), undefined, {
      concurrency: 1,
      minRequestIntervalMs: 11_000,
    });
  }
  if (!env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is required when LLM_PROVIDER=anthropic");
  return new RunnerService(new DrizzleEvalRepository(), new ClinicalExtractor(new AnthropicLlmClient(env.ANTHROPIC_API_KEY)));
}

export function createEvalRoutes(initialRunner?: RunnerService): Hono {
  const routes = new Hono();
  let runner = initialRunner;
  const getRunner = () => {
    runner ??= createRunnerService();
    return runner;
  };

  routes.get("/runs", async (c) => c.json(await getRunner().listRuns()));

  routes.post("/runs", async (c) => {
    const body = await c.req.json();
    const runId = await getRunner().startRun({
      strategy: body.strategy ?? "zero_shot",
      model: body.model ?? defaultModel(),
      datasetFilter: body.dataset_filter,
      force: body.force === true,
    });
    return c.json({ runId }, 202);
  });

  routes.post("/runs/:id/resume", async (c) => {
    await getRunner().resumeRun(c.req.param("id"));
    return c.json({ ok: true });
  });

  routes.get("/runs/:id", async (c) => {
    const detail = await getRunner().getRunDetail(c.req.param("id"));
    return detail ? c.json(detail) : c.json({ error: "not found" }, 404);
  });

  routes.get("/runs/:id/events", (c) => {
    const runId = c.req.param("id");
    const activeRunner = getRunner();
    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        const unsubscribe = activeRunner.eventBus.subscribe(runId, (event) => {
          controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event.payload)}\n\n`));
        });
        c.req.raw.signal.addEventListener("abort", unsubscribe);
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  });

  routes.get("/compare", async (c) => {
    const leftId = c.req.query("left");
    const rightId = c.req.query("right");
    if (!leftId || !rightId) return c.json({ error: "left and right query params are required" }, 400);
    const left = await getRunner().getRunDetail(leftId);
    const right = await getRunner().getRunDetail(rightId);
    if (!left || !right) return c.json({ error: "run not found" }, 404);
    const fields = ["chief_complaint", "vitals", "medications", "diagnoses", "plan", "follow_up", "aggregate"] as const;
    return c.json({
      left,
      right,
      deltas: fields.map((field) => {
        const delta = right.fieldAggregates[field] - left.fieldAggregates[field];
        return { field, delta, winner: delta > 0 ? "right" : delta < 0 ? "left" : "tie" };
      }),
    });
  });

  return routes;
}

function defaultModel(): string {
  if (env.LLM_PROVIDER === "gemini") return "gemini-2.5-flash";
  if (env.LLM_PROVIDER === "groq") return "llama-3.1-8b-instant";
  return "claude-haiku-4-5-20251001";
}
