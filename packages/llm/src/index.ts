import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";
import {
  extractionJsonSchema,
  type ClinicalExtraction,
  type LlmAttempt,
  type PromptStrategyName,
  type TokenUsage,
  validateExtraction,
} from "@test-evals/shared";
import { promptHash } from "./hash";
import { strategies } from "./prompts";

type AnthropicContentBlock = { type: string; input?: unknown; text?: string };
type AnthropicResponse = {
  content: AnthropicContentBlock[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
};

export type ExtractRequest = {
  transcript: string;
  strategy: PromptStrategyName;
  model: string;
};

export type ExtractResult = {
  prediction: ClinicalExtraction | null;
  attempts: LlmAttempt[];
  promptHash: string;
  tokens: TokenUsage;
  schemaValid: boolean;
};

export interface LlmClient {
  createMessage(request: unknown): Promise<AnthropicResponse>;
}

export class AnthropicLlmClient implements LlmClient {
  private readonly client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async createMessage(request: unknown): Promise<AnthropicResponse> {
    return (await this.client.messages.create(request as never)) as AnthropicResponse;
  }
}

export class ClinicalExtractor {
  constructor(private readonly client: LlmClient) {}

  async extract(request: ExtractRequest): Promise<ExtractResult> {
    const strategy = strategies[request.strategy];
    const hash = promptHash(strategy);
    const attempts: LlmAttempt[] = [];
    const tokens: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    let feedback = "";

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const startedAt = new Date().toISOString();
      const llmRequest = this.buildRequest(request.transcript, request.model, strategy.name, feedback);
      const response = await this.client.createMessage(llmRequest);
      const validation = validateExtraction(this.extractToolInput(response));
      const usage = this.readUsage(response);
      tokens.input += usage.input;
      tokens.output += usage.output;
      tokens.cacheRead += usage.cacheRead;
      tokens.cacheWrite += usage.cacheWrite;
      attempts.push({
        attempt,
        request: llmRequest,
        response,
        validationErrors: validation.errors,
        tokenUsage: usage,
        startedAt,
        completedAt: new Date().toISOString(),
      });
      if (validation.ok) {
        return { prediction: validation.data, attempts, promptHash: hash, tokens, schemaValid: true };
      }
      feedback = `The previous tool input failed schema validation:\n${validation.errors.join("\n")}\nCall the tool again with corrected schema-conformant values.`;
    }

    return { prediction: null, attempts, promptHash: hash, tokens, schemaValid: false };
  }

  private buildRequest(transcript: string, model: string, strategyName: PromptStrategyName, feedback: string): unknown {
    const strategy = strategies[strategyName];
    const systemBlocks = [
      { type: "text", text: strategy.system, cache_control: { type: "ephemeral" } },
      ...strategy.examples.map((example) => ({ type: "text", text: example, cache_control: { type: "ephemeral" } })),
    ];
    return {
      model,
      max_tokens: 1200,
      temperature: 0,
      system: systemBlocks,
      tools: [
        {
          name: "record_clinical_extraction",
          description: "Record one schema-conformant clinical extraction.",
          input_schema: extractionJsonSchema,
        },
      ],
      tool_choice: { type: "tool", name: "record_clinical_extraction" },
      messages: [
        {
          role: "user",
          content: `${strategy.userInstruction}\n\nTranscript:\n${transcript}${feedback ? `\n\n${feedback}` : ""}`,
        },
      ],
    };
  }

  private extractToolInput(response: AnthropicResponse): unknown {
    return response.content.find((block) => block.type === "tool_use")?.input ?? null;
  }

  private readUsage(response: AnthropicResponse): TokenUsage {
    return {
      input: response.usage?.input_tokens ?? 0,
      output: response.usage?.output_tokens ?? 0,
      cacheRead: response.usage?.cache_read_input_tokens ?? 0,
      cacheWrite: response.usage?.cache_creation_input_tokens ?? 0,
    };
  }
}

export class GeminiClinicalExtractor {
  private readonly client: GoogleGenAI;

  constructor(apiKey: string) {
    this.client = new GoogleGenAI({ apiKey });
  }

  async extract(request: ExtractRequest): Promise<ExtractResult> {
    const strategy = strategies[request.strategy];
    const hash = promptHash(strategy);
    const attempts: LlmAttempt[] = [];
    const tokens: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    let feedback = "";

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const startedAt = new Date().toISOString();
      const prompt = [
        strategy.system,
        ...strategy.examples,
        strategy.userInstruction,
        `Transcript:\n${request.transcript}`,
        feedback,
      ]
        .filter(Boolean)
        .join("\n\n");
      const geminiRequest = {
        model: request.model,
        contents: prompt,
        config: {
          temperature: 0,
          responseMimeType: "application/json",
          responseJsonSchema: this.geminiSchema(),
        },
      };
      const response = await this.client.models.generateContent(geminiRequest);
      const parsed = this.safeJson(response.text ?? "");
      const validation = validateExtraction(parsed);
      const usage = this.readGeminiUsage(response);
      tokens.input += usage.input;
      tokens.output += usage.output;
      attempts.push({
        attempt,
        request: geminiRequest,
        response: { text: response.text, usageMetadata: response.usageMetadata },
        validationErrors: validation.errors,
        tokenUsage: usage,
        startedAt,
        completedAt: new Date().toISOString(),
      });
      if (validation.ok) {
        return { prediction: validation.data, attempts, promptHash: hash, tokens, schemaValid: true };
      }
      feedback = `The previous JSON failed validation:\n${validation.errors.join("\n")}\nReturn corrected JSON only.`;
    }

    return { prediction: null, attempts, promptHash: hash, tokens, schemaValid: false };
  }

  private safeJson(text: string): unknown {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  private readGeminiUsage(response: { usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number } }): TokenUsage {
    return {
      input: response.usageMetadata?.promptTokenCount ?? 0,
      output: response.usageMetadata?.candidatesTokenCount ?? 0,
      cacheRead: 0,
      cacheWrite: 0,
    };
  }

  private geminiSchema(): unknown {
    return {
      ...extractionJsonSchema,
      properties: {
        ...extractionJsonSchema.properties,
        vitals: {
          ...extractionJsonSchema.properties.vitals,
          properties: {
            bp: { type: ["string", "null"] },
            hr: { type: ["integer", "null"], minimum: 20, maximum: 250 },
            temp_f: { type: ["number", "null"], minimum: 90, maximum: 110 },
            spo2: { type: ["integer", "null"], minimum: 50, maximum: 100 },
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
              icd10: { type: "string" },
            },
          },
        },
      },
    };
  }
}

export class GroqClinicalExtractor {
  private readonly client: OpenAI;

  constructor(apiKey: string) {
    this.client = new OpenAI({
      apiKey,
      baseURL: "https://api.groq.com/openai/v1",
    });
  }

  async extract(request: ExtractRequest): Promise<ExtractResult> {
    const strategy = strategies[request.strategy];
    const hash = promptHash(strategy);
    const attempts: LlmAttempt[] = [];
    const tokens: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    let feedback = "";

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const startedAt = new Date().toISOString();
      const groqRequest = {
        model: request.model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system" as const,
            content: [
              this.groqSystem(strategy.name),
              ...strategy.examples,
            ].join("\n\n"),
          },
          {
            role: "user" as const,
            content: `${strategy.userInstruction}\n\nTranscript:\n${request.transcript}${feedback ? `\n\n${feedback}` : ""}`,
          },
        ],
      };
      const response = await this.client.chat.completions.create(groqRequest);
      const text = response.choices[0]?.message.content ?? "";
      const validation = validateExtraction(this.safeJson(text));
      const usage = this.readGroqUsage(response.usage);
      tokens.input += usage.input;
      tokens.output += usage.output;
      attempts.push({
        attempt,
        request: groqRequest,
        response,
        validationErrors: validation.errors,
        tokenUsage: usage,
        startedAt,
        completedAt: new Date().toISOString(),
      });
      if (validation.ok) {
        return { prediction: validation.data, attempts, promptHash: hash, tokens, schemaValid: true };
      }
      feedback = `The previous JSON failed validation:\n${validation.errors.join("\n")}\nReturn corrected JSON only.`;
    }

    return { prediction: null, attempts, promptHash: hash, tokens, schemaValid: false };
  }

  private safeJson(text: string): unknown {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  private readGroqUsage(usage: { prompt_tokens?: number; completion_tokens?: number } | null | undefined): TokenUsage {
    return {
      input: usage?.prompt_tokens ?? 0,
      output: usage?.completion_tokens ?? 0,
      cacheRead: 0,
      cacheWrite: 0,
    };
  }

  private groqSystem(strategyName: PromptStrategyName): string {
    const strategySpecific =
      strategyName === "few_shot"
        ? "Use the examples as style guidance, but extract only facts from the current transcript."
        : strategyName === "cot"
          ? "Before answering, internally check each field against the transcript evidence. Do not output reasoning."
          : "Extract only facts explicitly supported by the transcript.";

    return `${strategySpecific}
Return valid JSON only, with no markdown and no extra keys.
The JSON object must use exactly this shape:
{
  "chief_complaint": "string",
  "vitals": { "bp": "120/80 or null", "hr": 80, "temp_f": 98.6, "spo2": 98 },
  "medications": [{ "name": "string", "dose": "string or null", "frequency": "string or null", "route": "string or null" }],
  "diagnoses": [{ "description": "string", "icd10": "optional string" }],
  "plan": ["string"],
  "follow_up": { "interval_days": 7, "reason": "string or null" }
}
Rules:
- Use null for missing vitals, dose, frequency, route, follow_up interval_days, and follow_up reason.
- hr, spo2, and interval_days must be integers or null.
- temp_f must be a number or null.
- medications, diagnoses, and plan must be arrays.
- If there are no medications, diagnoses, or plan items, return an empty array.
- Do not invent unsupported values.`;
  }
}

export { promptHash, strategies };
