/**
 * Model surface — builds the computer-use request for the Claude API and
 * normalizes responses into a small, executor-agnostic shape the loop consumes.
 *
 * The request shape (tool `type` strings, beta headers, `output_config.effort`,
 * server-side `fallbacks`) is fixed by the field-verified D4 surface. The
 * installed SDK build predates that surface, so the request is submitted through
 * one narrowly-typed boundary (`send`) rather than the SDK's own param types —
 * every field on the wire is still typed by `ModelRequestBody`.
 */

import { appendFileSync } from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import type { CUAction, Observation, ModelConfig } from '../src/types.ts';

// --- Wire beta identifiers and models (exact strings; pinned per D4) ---

export const COMPUTER_USE_BETA = 'computer-use-2025-11-24';
export const SERVER_SIDE_FALLBACK_BETA = 'server-side-fallback-2026-06-01';
export const FALLBACK_MODEL = 'claude-opus-4-8';

// --- Tool definitions the model may call ---

export interface ComputerToolDef {
  type: 'computer_20251124';
  name: 'computer';
  display_width_px: number;
  display_height_px: number;
  display_number: number;
}

export interface CustomToolDef {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
    additionalProperties: false;
  };
}

/** Fixed 1280x800 display, matching the sandbox viewport. */
export const COMPUTER_TOOL: ComputerToolDef = {
  type: 'computer_20251124',
  name: 'computer',
  display_width_px: 1280,
  display_height_px: 800,
  display_number: 1,
};

export const ESCALATE_TOOL: CustomToolDef = {
  name: 'escalate',
  description:
    'Decline to act and end the task. Call this when the request is ambiguous, ' +
    'impossible to fulfill from the available screens, unsafe, or should be left ' +
    'to a human. Provide a clear reason.',
  input_schema: {
    type: 'object',
    properties: {
      reason: { type: 'string', description: 'Why you are escalating instead of acting.' },
    },
    required: ['reason'],
    additionalProperties: false,
  },
};

export const DONE_TOOL: CustomToolDef = {
  name: 'done',
  description:
    'Signal that the task is complete. Call this only after the requested change ' +
    'has actually been committed in the application. Provide a short summary of ' +
    'what you did.',
  input_schema: {
    type: 'object',
    properties: {
      summary: { type: 'string', description: 'What was accomplished.' },
    },
    required: ['summary'],
    additionalProperties: false,
  },
};

export const DEFAULT_SYSTEM_PROMPT =
  'You operate a field-service dispatch booking application through a virtual ' +
  'display. Each turn you receive a screenshot of the current screen. Use the ' +
  '`computer` tool to move, click, type, and scroll. Work only within the ' +
  'application shown; do not attempt to navigate elsewhere.\n\n' +
  "Complete the dispatcher's request exactly as stated. When the requested " +
  'change has been committed in the application, call the `done` tool with a ' +
  'short summary of what you did. If the request is ambiguous, impossible to ' +
  'fulfill from the available screens, or would require an action you cannot ' +
  'justify, call the `escalate` tool with a clear reason instead of guessing. ' +
  'Never invent details that were not provided.';

// --- Message / content shapes (decoupled from the SDK's versioned param types) ---

export interface ImageBlockParam {
  type: 'image';
  source: { type: 'base64'; media_type: 'image/png'; data: string };
}

export type ToolResultContentBlock = { type: 'text'; text: string } | ImageBlockParam;

export type ContentBlockParam =
  | { type: 'text'; text: string }
  | ImageBlockParam
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | {
      type: 'tool_result';
      tool_use_id: string;
      content: ToolResultContentBlock[];
      is_error?: boolean;
    };

export interface MessageParam {
  role: 'user' | 'assistant';
  content: string | ContentBlockParam[];
}

// --- Request body (every wire field is typed here) ---

export type ApiEffort = 'low' | 'medium' | 'high' | 'max';

export interface ModelRequestBody {
  model: string;
  max_tokens: number;
  system: string;
  messages: MessageParam[];
  tools: Array<ComputerToolDef | CustomToolDef>;
  betas: string[];
  output_config: { effort: ApiEffort };
  /** Fable 5 only: server-side fallback to Opus 4.8 on a policy decline. */
  fallbacks?: Array<{ model: string }>;
}

/** `ModelConfig.effort` uses "xhigh"; the API spells the top tier "max". */
export function mapEffort(effort: ModelConfig['effort']): ApiEffort {
  switch (effort) {
    case 'low':
      return 'low';
    case 'medium':
      return 'medium';
    case 'high':
      return 'high';
    case 'xhigh':
      return 'max';
  }
}

/**
 * Build the exact request body. Pure and side-effect free, so the request shape
 * is unit-testable without any network call.
 *
 * Notes fixed by D4:
 *  - No temperature / top_p / top_k anywhere.
 *  - No `thinking`: it is omitted for Fable 5, and left off for all models here
 *    so the reconstructed assistant turn never has to preserve thinking blocks.
 *  - Effort is carried only via `output_config`.
 */
export function buildRequestBody(
  config: ModelConfig,
  system: string,
  messages: MessageParam[],
): ModelRequestBody {
  if (config.model === 'stub' || config.model === 'oracle') {
    throw new Error(`buildRequestBody: '${config.model}' is not an API model id`);
  }

  const betas = [COMPUTER_USE_BETA];
  const useFallback = config.model === 'claude-fable-5' && config.fallbackToOpus;
  if (useFallback) betas.push(SERVER_SIDE_FALLBACK_BETA);

  const body: ModelRequestBody = {
    model: config.model,
    max_tokens: config.maxTokensPerTurn,
    system,
    messages,
    tools: [COMPUTER_TOOL, ESCALATE_TOOL, DONE_TOOL],
    betas,
    output_config: { effort: mapEffort(config.effort) },
  };
  if (useFallback) body.fallbacks = [{ model: FALLBACK_MODEL }];
  return body;
}

// --- Response normalization ---

export interface RawContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
}

export interface RawModelResponse {
  content: RawContentBlock[];
  stop_reason: string | null;
  model?: string;
  stop_details?: { category?: string | null; explanation?: string } | null;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

export interface ModelToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface ModelTurn {
  stopReason: string | null;
  /** true when stop_reason is "refusal" — the loop treats this as a hard stop. */
  refused: boolean;
  refusalDetail?: string;
  text: string;
  toolCalls: ModelToolCall[];
  /** assistant content to echo back into the transcript on the next turn. */
  assistantContent: ContentBlockParam[];
}

/**
 * Normalize a raw API message into a ModelTurn. Only `text` and `tool_use`
 * blocks are echoed back — no thinking/fallback blocks are produced given the
 * request shape above, so reconstruction is lossless for the transcript.
 */
export function parseResponse(raw: RawModelResponse): ModelTurn {
  const toolCalls: ModelToolCall[] = [];
  const texts: string[] = [];
  const assistantContent: ContentBlockParam[] = [];

  for (const block of raw.content) {
    if (block.type === 'text' && typeof block.text === 'string') {
      texts.push(block.text);
      assistantContent.push({ type: 'text', text: block.text });
    } else if (
      block.type === 'tool_use' &&
      typeof block.id === 'string' &&
      typeof block.name === 'string'
    ) {
      toolCalls.push({ id: block.id, name: block.name, input: block.input });
      assistantContent.push({
        type: 'tool_use',
        id: block.id,
        name: block.name,
        input: block.input,
      });
    }
  }

  const refused = raw.stop_reason === 'refusal';
  const turn: ModelTurn = {
    stopReason: raw.stop_reason,
    refused,
    text: texts.join('\n'),
    toolCalls,
    assistantContent,
  };
  if (refused) {
    const detail = raw.stop_details?.explanation;
    if (typeof detail === 'string') turn.refusalDetail = detail;
  }
  return turn;
}

// --- Tool-result plumbing consumed by the loop ---

export interface ToolResultInput {
  toolUseId: string;
  /** base64 PNG of the observation after the action (the normal next input). */
  image?: string;
  /** short note, e.g. a sandbox block explanation, so the model can adapt. */
  text?: string;
  isError?: boolean;
}

export function imageBlock(base64: string): ImageBlockParam {
  return { type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64 } };
}

export function toToolResultBlock(r: ToolResultInput): ContentBlockParam {
  const content: ToolResultContentBlock[] =
    r.image !== undefined ? [imageBlock(r.image)] : [{ type: 'text', text: r.text ?? '' }];
  return r.isError === true
    ? { type: 'tool_result', tool_use_id: r.toolUseId, content, is_error: true }
    : { type: 'tool_result', tool_use_id: r.toolUseId, content };
}

// --- The interface the loop depends on ---

export interface AgentModel {
  /** First turn: the task instruction plus the initial screenshot. */
  begin(instruction: string, firstObs: Observation): Promise<ModelTurn>;
  /** Subsequent turns: the tool results produced by the previous turn. */
  next(results: ToolResultInput[]): Promise<ModelTurn>;
}

export interface AnthropicModelOptions {
  apiKey?: string;
  system?: string;
}

/**
 * Live model client. Holds the transcript, submits each turn, and returns the
 * normalized ModelTurn. Constructing it does not require an API key; only an
 * actual turn does. Fable 5 is selectable but unverified for computer use (D4):
 * the request is submitted as configured and any 400 surfaces to the caller
 * unmodified — support is not assumed.
 */
export class AnthropicModel implements AgentModel {
  private readonly config: ModelConfig;
  private readonly system: string;
  private readonly client: Anthropic;
  private readonly messages: MessageParam[] = [];

  constructor(config: ModelConfig, opts: AnthropicModelOptions = {}) {
    if (config.model === 'stub' || config.model === 'oracle') {
      throw new Error(`AnthropicModel cannot run model id '${config.model}' (use stub-policy)`);
    }
    this.config = config;
    this.system = opts.system ?? DEFAULT_SYSTEM_PROMPT;
    this.client = opts.apiKey ? new Anthropic({ apiKey: opts.apiKey }) : new Anthropic();
  }

  async begin(instruction: string, firstObs: Observation): Promise<ModelTurn> {
    this.messages.length = 0;
    this.messages.push({
      role: 'user',
      content: [{ type: 'text', text: instruction }, imageBlock(firstObs.screenshotB64)],
    });
    return this.send();
  }

  async next(results: ToolResultInput[]): Promise<ModelTurn> {
    this.messages.push({ role: 'user', content: results.map(toToolResultBlock) });
    return this.send();
  }

  private async send(): Promise<ModelTurn> {
    const body = buildRequestBody(this.config, this.system, this.messages);
    // Single typed boundary: the installed SDK build predates this request
    // surface, so the body (fully typed as ModelRequestBody) is submitted here.
    const api = this.client.beta.messages as unknown as {
      create(b: unknown): Promise<RawModelResponse>;
    };
    const raw = await api.create(applyCacheControl(body));
    // Optional per-request usage log (enables real $/verified-task accounting and
    // confirms cache reads). Gated on an env var so offline tests never touch fs.
    const usageLog = process.env.MAUDSLAY_USAGE_LOG;
    if (usageLog && raw.usage) {
      appendFileSync(usageLog, JSON.stringify({ model: raw.model ?? this.config.model, ...raw.usage }) + '\n');
    }
    const turn = parseResponse(raw);
    this.messages.push({ role: 'assistant', content: turn.assistantContent });
    return turn;
  }
}

/**
 * Add prompt-cache breakpoints at the wire boundary — a pure cost optimization
 * that does not change model outputs. The screenshot history grows every turn
 * and is never pruned, so without caching the input cost is quadratic in trial
 * length. Two ephemeral breakpoints cache the stable prefix: the system+tools
 * header, and the conversation up to the final block (each turn re-reads the
 * prior turns at ~0.1x instead of full price). Does not mutate stored messages,
 * so no marker accumulates across turns.
 */
export function applyCacheControl(body: ModelRequestBody): unknown {
  const eph = { type: 'ephemeral' } as const;
  const lastMsg = body.messages.length - 1;
  const messages = body.messages.map((m, i) => {
    if (i !== lastMsg || !Array.isArray(m.content) || m.content.length === 0) return m;
    const lastBlock = m.content.length - 1;
    const content = m.content.map((b, j) =>
      j === lastBlock ? { ...(b as object), cache_control: eph } : b,
    );
    return { role: m.role, content };
  });
  return {
    ...body,
    system: [{ type: 'text', text: body.system, cache_control: eph }],
    messages,
  };
}
