/**
 * Per-persona tool permission map — Orchestra-style gate before invocation.
 *
 * Personas declare an allowlisted `tools` array plus optional `permissions`
 * that classify each tool as allow / ask / deny. The runner enforces deny and
 * emits `permission_ask` for ask (UI/HITL can subscribe later).
 */

export type PermissionAction = 'allow' | 'ask' | 'deny';

/** Tool name → action. Key `*` is the map-level default before falling back to `PersonaPermissions.defaultAction`. */
export type PermissionMap = Record<string, PermissionAction>;

export interface PersonaPermissions {
  tools?: PermissionMap;
  defaultAction: PermissionAction;
}

const REGEX_ESCAPE_RE = /[.+^${}()|[\]\\]/g;

function escapeRegex(s: string): string {
  return s.replace(REGEX_ESCAPE_RE, '\\$&');
}

/** Turn a simple glob (`*`, `?`) into a RegExp anchored to the full string. */
function globToRegex(pattern: string): RegExp | null {
  if (!pattern.includes('*') && !pattern.includes('?')) return null;
  let body = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') body += '.*';
    else if (c === '?') body += '.';
    else body += escapeRegex(c);
  }
  try {
    return new RegExp(`^${body}$`);
  } catch {
    return null;
  }
}

/**
 * Resolve the effective permission for a tool.
 *
 * Order: exact key match → glob patterns (non-literal `*`) → literal `*` key in map → defaultAction.
 */
export function resolveToolPermission(
  map: PermissionMap | undefined,
  tool: string,
  defaultAction: PermissionAction,
): PermissionAction {
  if (!map || Object.keys(map).length === 0) return defaultAction;

  const direct = map[tool];
  if (direct !== undefined) return direct;

  const globEntries: { pattern: string; action: PermissionAction }[] = [];
  let starDefault: PermissionAction | undefined;

  for (const [pattern, action] of Object.entries(map)) {
    if (pattern === '*') {
      starDefault = action;
      continue;
    }
    if (pattern.includes('*') || pattern.includes('?')) {
      globEntries.push({ pattern, action });
    }
  }

  globEntries.sort((a, b) => b.pattern.length - a.pattern.length);
  for (const { pattern, action } of globEntries) {
    const rx = globToRegex(pattern);
    if (rx?.test(tool)) return action;
  }

  if (starDefault !== undefined) return starDefault;
  return defaultAction;
}

export class PermissionDeniedError extends Error {
  readonly personaId: string;
  readonly tool: string;

  constructor(persona: string, tool: string) {
    super(`Permission denied: persona "${persona}" cannot use tool "${tool}"`);
    this.name = 'PermissionDeniedError';
    this.personaId = persona;
    this.tool = tool;
  }
}

/**
 * Build a stable ask_id from the workflow / task / persona / tool tuple.
 *
 * Wave 2.A: the dashboard's PermissionAskInbox uses this id to dedupe
 * redelivered SSE events and to POST the operator's decision back to
 * `/api/dashboard/permission/decide`. The 6-char nonce keeps two asks for
 * the same tuple distinguishable across retries.
 */
function makeAskId(
  personaId: string,
  tool: string,
  workflowId: string | undefined,
  taskId: string | undefined,
): string {
  const nonce = Math.random().toString(36).slice(2, 8);
  const wf = workflowId ?? '_';
  const tk = taskId ?? '_';
  return `${wf}:${tk}:${personaId}:${tool}:${nonce}`;
}

/**
 * Validates allowlisted tools against the persona permission map.
 * @throws PermissionDeniedError when any tool resolves to `deny`.
 * @returns the list of `ask_id`s emitted (one per `ask` tool resolution).
 *   Callers may persist these to record the audit trail.
 */
export function enforcePersonaToolPermissions(
  personaId: string,
  tools: readonly string[],
  permissions: PersonaPermissions | undefined,
  emit: (event: string, payload: Record<string, unknown>) => void,
  workflowMeta: { workflowId?: string; taskId?: string },
): string[] {
  const fallback = permissions?.defaultAction ?? 'allow';
  const askIds: string[] = [];
  for (const tool of tools) {
    const action = resolveToolPermission(permissions?.tools, tool, fallback);
    if (action === 'deny') {
      throw new PermissionDeniedError(personaId, tool);
    }
    if (action === 'ask') {
      const askId = makeAskId(personaId, tool, workflowMeta.workflowId, workflowMeta.taskId);
      askIds.push(askId);
      emit('permission_ask', {
        ask_id: askId,
        agent_id: personaId,
        tool,
        workflow_id: workflowMeta.workflowId,
        task_id: workflowMeta.taskId,
        asked_at: Date.now(),
      });
    }
  }
  return askIds;
}
