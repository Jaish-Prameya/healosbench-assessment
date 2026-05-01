import { config } from "dotenv";
import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

config();
config({ path: "apps/server/.env", override: false });

export const env = createEnv({
  server: {
    DATABASE_URL: z.string().min(1).default("postgres://postgres:postgres@localhost:5432/healosbench"),
    LLM_PROVIDER: z.enum(["anthropic", "gemini", "groq"]).default("anthropic"),
    ANTHROPIC_API_KEY: z.string().min(1).optional(),
    GEMINI_API_KEY: z.string().min(1).optional(),
    GROQ_API_KEY: z.string().min(1).optional(),
    BETTER_AUTH_SECRET: z.string().min(32).default("dev-secret-dev-secret-dev-secret-dev-secret"),
    BETTER_AUTH_URL: z.url().default("http://localhost:8787"),
    CORS_ORIGIN: z.url().default("http://localhost:3001"),
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
});
