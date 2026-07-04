export type TailEventKind = 'message' | 'reasoning' | 'tool_call' | 'tool_result' | 'meta';

export interface TailEvent {
  ts: number;
  kind: TailEventKind;
  role?: 'user' | 'assistant' | 'system' | 'developer';
  text?: string;
  toolName?: string;
  toolInput?: unknown;
  toolOutput?: unknown;
}

export interface TailParser {
  parse(filePath: string): TailEvent[];
}
