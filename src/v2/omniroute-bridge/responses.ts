import { createParser, type EventSourceMessage } from 'eventsource-parser';

import type { AgentMessage } from '../context-engine/types.js';

export interface ResponsesBridgeConfig {
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly maxTokens?: number;
}

export interface ResponsesContentPart {
  readonly type: 'input_text' | 'input_image';
  readonly text?: string;
  readonly image_url?: string;
}

export interface ResponsesInputItem {
  readonly role: 'user' | 'assistant';
  readonly content: ResponsesContentPart[];
}

export interface ResponsesBody {
  readonly model: string;
  readonly instructions: string;
  readonly input: ResponsesInputItem[];
  readonly stream: true;
  readonly max_output_tokens?: number;
}

export interface ResponsesStreamResult {
  readonly finishReason: string | null;
  readonly usage: Record<string, unknown> | null;
  readonly api: 'responses';
}

type RawContentPart = Record<string, unknown>;

type MessageContent = string | RawContentPart[] | null | undefined;

const DONE_SENTINEL = '[DONE]';

export function mapChatMessagesToResponsesBody(params: {
  model: string;
  messages?: AgentMessage[];
  maxTokens?: number;
}): ResponsesBody {
  const { model, messages = [], maxTokens } = params;
  const instructions = messages
    .filter((message) => message.role === 'system')
    .map((message) => messageContentToText(message.content))
    .filter(Boolean)
    .join('\n\n');

  const input = messages
    .filter((message) => message.role !== 'system')
    .map((message): ResponsesInputItem => ({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content: normalizeResponsesContent(message.content),
    }));

  return {
    model,
    instructions,
    input,
    stream: true,
    ...(typeof maxTokens === 'number' ? { max_output_tokens: maxTokens } : {}),
  };
}

export async function streamResponsesCompletion(params: {
  config: ResponsesBridgeConfig;
  model: string;
  messages: AgentMessage[];
  onToken: (token: string) => void;
}): Promise<ResponsesStreamResult> {
  const { config, model, messages, onToken } = params;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'text/event-stream',
  };
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;

  const response = await fetch(`${config.baseUrl}/responses`, {
    method: 'POST',
    headers,
    body: JSON.stringify(
      mapChatMessagesToResponsesBody({
        model,
        messages,
        maxTokens: config.maxTokens,
      }),
    ),
  });

  if (!response.ok || !response.body) {
    throw new Error(`responses ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let finishReason: string | null = null;
  let usage: Record<string, unknown> | null = null;
  let sawDone = false;

  const parser = createParser({
    onEvent(event: EventSourceMessage): void {
      const data = event.data;
      if (!data) return;
      if (data === DONE_SENTINEL) {
        sawDone = true;
        return;
      }

      try {
        const parsed = JSON.parse(data) as Record<string, unknown>;
        const token = extractResponsesDelta(parsed);
        if (token) onToken(token);

        if (finishReason === null && isCompletedResponse(parsed)) {
          finishReason = 'stop';
        }

        const nextUsage = extractUsage(parsed);
        if (nextUsage) usage = nextUsage;
      } catch {
        // Providers may emit comments or non-JSON keepalive frames.
      }
    },
  });

  try {
    while (!sawDone) {
      const { value, done } = await reader.read();
      if (done) break;
      parser.feed(decoder.decode(value, { stream: true }));
    }
    parser.feed(decoder.decode(new Uint8Array(0), { stream: false }));
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Stream may already be released on abrupt termination.
    }
  }

  return { finishReason, usage, api: 'responses' };
}

export function normalizeResponsesContent(content: MessageContent): ResponsesContentPart[] {
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (part.type === 'text') {
        return { type: 'input_text', text: typeof part.text === 'string' ? part.text : '' };
      }
      if (part.type === 'image_url') {
        const imageValue = part.image_url;
        return {
          type: 'input_image',
          image_url:
            typeof imageValue === 'string'
              ? imageValue
              : getRecordString(imageValue, 'url') ?? '',
        };
      }
      return { type: 'input_text', text: JSON.stringify(part) };
    });
  }

  return [{ type: 'input_text', text: String(content ?? '') }];
}

export function extractResponsesDelta(event: Record<string, unknown> = {}): string {
  if (event.type === 'response.output_text.delta') {
    return typeof event.delta === 'string' ? event.delta : '';
  }

  if (event.type === 'response.output_item.delta') {
    const delta = asRecord(event.delta);
    return typeof delta?.text === 'string' ? delta.text : '';
  }

  if (event.type === 'response.content_part.delta') {
    const delta = event.delta;
    if (typeof delta === 'string') return delta;
    const deltaRecord = asRecord(delta);
    return typeof deltaRecord?.text === 'string' ? deltaRecord.text : '';
  }

  const delta = asRecord(event.delta);
  if (typeof delta?.text === 'string') return delta.text;
  return typeof event.output_text_delta === 'string' ? event.output_text_delta : '';
}

function messageContentToText(content: MessageContent): string {
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part.text === 'string') return part.text;
        if (typeof part.image_url === 'string') return part.image_url;
        const imageUrl = getRecordString(part.image_url, 'url');
        if (imageUrl) return imageUrl;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }

  return String(content ?? '');
}

function isCompletedResponse(event: Record<string, unknown>): boolean {
  const response = asRecord(event.response);
  return response?.status === 'completed';
}

function extractUsage(event: Record<string, unknown>): Record<string, unknown> | null {
  const response = asRecord(event.response);
  const responseUsage = asRecord(response?.usage);
  if (responseUsage) return responseUsage;

  const usage = asRecord(event.usage);
  return usage ?? null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function getRecordString(value: unknown, key: string): string | null {
  const record = asRecord(value);
  if (!record) return null;
  return typeof record[key] === 'string' ? record[key] : null;
}
