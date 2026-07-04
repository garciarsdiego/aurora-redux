export type ContextChannelKind =
  | 'project'
  | 'run'
  | 'debug'
  | 'approvals'
  | 'artifacts'
  | 'agents'
  | 'custom';

export type ContextThreadKind =
  | 'run'
  | 'task'
  | 'artifact'
  | 'approval'
  | 'error'
  | 'decision'
  | 'advisor'
  | 'custom';

export type ContextThreadStatus = 'open' | 'resolved' | 'archived';

export type ContextSenderType =
  | 'human'
  | 'agent'
  | 'advisor'
  | 'reviewer'
  | 'system'
  | 'tool';

export type ContextMessageKind =
  | 'note'
  | 'event'
  | 'log'
  | 'handoff'
  | 'context_packet'
  | 'decision'
  | 'error'
  | 'advisor_review';

export type WorkItemKind =
  | 'project'
  | 'epic'
  | 'milestone'
  | 'batch'
  | 'task'
  | 'subtask'
  | 'atomic_task';

export type WorkItemStatus =
  | 'planned'
  | 'ready'
  | 'running'
  | 'blocked'
  | 'review'
  | 'done'
  | 'failed'
  | 'canceled';

export type TaskHandoffKind =
  | 'summary'
  | 'artifact'
  | 'diff'
  | 'decision'
  | 'error'
  | 'instruction'
  | 'mixed';

export type ContextDecisionKind =
  | 'approve'
  | 'reject'
  | 'retry'
  | 'cancel'
  | 'pause'
  | 'resume'
  | 'audit'
  | 'note';

export type ContextDecisionStatus = 'proposed' | 'recorded' | 'applied' | 'superseded';

export interface IncludedHandoffRef {
  handoffId: string;
  taskId: string;
  chars: number;
}

export interface ExcludedContextItem {
  kind: string;
  reason: string;
  ref?: string;
}

export interface ContextPacketInput {
  runId: string;
  taskId: string;
  attempt: number;
  threadId?: string | null;
  packet: Record<string, unknown>;
  renderedPrompt: string;
  includedHandoffs: IncludedHandoffRef[];
  excludedItems: ExcludedContextItem[];
  tokenEstimate: number;
  truncated: boolean;
}

export interface TaskHandoffInput {
  runId: string;
  taskId: string;
  attempt: number;
  threadId?: string | null;
  kind: TaskHandoffKind;
  title: string;
  body: string;
  artifacts: string[];
  filesTouched: string[];
  decisions: string[];
  safeContext: Record<string, unknown>;
  tokenEstimate: number;
  truncated: boolean;
}
