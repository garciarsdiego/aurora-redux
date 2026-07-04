export interface TokenBudget {
  maxTokens: number;
  reserveForOutput: number;
}

export interface ContextEngineInfo {
  id: string;
  name: string;
  ownsCompaction?: boolean;
}

export type AgentMessage = {
  id?: string;
  role: 'system' | 'user' | 'assistant';
  content: string;
};

export type AssembleResult = {
  messages: AgentMessage[];
  estimatedTokens: number;
};

export type CompactResult = {
  ok: boolean;
  compacted: boolean;
  reason?: string;
  result?: {
    summary?: string;
    firstKeptEntryId?: string;
    tokensBefore: number;
    tokensAfter?: number;
  };
};

export interface ContextEngine {
  readonly info: ContextEngineInfo;
  assemble(params: {
    messages: AgentMessage[];
    tokenBudget?: number;
    model?: string;
  }): Promise<AssembleResult>;
  compact(params: {
    messages: AgentMessage[];
    force?: boolean;
    compactionTarget?: 'budget' | 'threshold';
    currentTokenCount?: number;
    model?: string;
  }): Promise<CompactResult>;
  ingest?(params: { message: AgentMessage }): Promise<{ accepted: boolean }>;
}
