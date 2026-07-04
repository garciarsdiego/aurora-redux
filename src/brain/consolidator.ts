import type { Task, Workflow } from '../types/index.js';
import { callOmniroute, callOmnirouteWithUsage } from '../utils/omniroute-call.js';
import { getConsolidatorModel, getUsePersonas } from '../utils/config.js';
import { runAgent, type AgentInvoker } from '../v2/agents/runner.js';
import type { AgentContext } from '../v2/agents/types.js';
import {
  CONSOLIDATOR_PERSONA,
  type ConsolidatorInput,
  type ConsolidatorOutput,
} from '../v2/agents/personas/consolidator.js';

const SYSTEM_PROMPT =
  'You are Omniforge\'s consolidator. Given a workflow objective and the outputs of its tasks, ' +
  'synthesize a single coherent final deliverable that addresses the objective. ' +
  'Do not enumerate the tasks verbatim — produce the actual deliverable. ' +
  'Be substantive, clear, and focused on what the user asked for.';

function buildUserPrompt(workflow: Workflow, tasks: Task[]): string {
  const sections = tasks
    .filter((t) => t.status === 'completed' && t.output_json)
    .map((t, i) => `### [${i + 1}] ${t.name}\n${t.output_json}`)
    .join('\n\n');

  return [
    `WORKFLOW OBJECTIVE: ${workflow.objective}`,
    '',
    'TASK OUTPUTS:',
    '',
    sections,
    '',
    'Synthesize the above into the final deliverable.',
  ].join('\n');
}

export interface ConsolidateOptions {
  /** Workspace root used by CONSOLIDATOR_PERSONA postHook file validation. */
  readonly workspaceDir?: string;
  /** Alias matching the persona input field name; workspaceDir wins when both are set. */
  readonly workspace_dir?: string;
}

const omnirouteInvoker: AgentInvoker = async (args) => {
  const result = await callOmnirouteWithUsage({
    systemPrompt: args.systemPrompt,
    userPrompt: args.userPrompt ?? 'Respond per the system contract above.',
    model: args.model,
  });
  return result.content;
};

function buildConsolidatorAgentContext(
  workflow: Workflow,
  options: ConsolidateOptions,
): AgentContext {
  const workspaceDir = options.workspaceDir ?? options.workspace_dir;
  return {
    workflowId: workflow.id,
    workspaceDir,
    retryCount: 0,
    emit(event, payload) {
      console.debug(`[consolidator:event] ${event}`, payload);
    },
    warn(message, payload) {
      console.warn(`[consolidator:warn] ${message}`, payload ?? '');
    },
    log(level, message, payload) {
      if (level === 'error' || level === 'warn') {
        console.warn(`[consolidator:${level}] ${message}`, payload ?? '');
      }
    },
  };
}

function parseTaskOutput(raw: string | null): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function extractFilesWritten(output: unknown): string[] | undefined {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return undefined;
  const value = (output as Record<string, unknown>)['files_written'];
  if (!Array.isArray(value)) return undefined;
  const files = value.filter((item): item is string => typeof item === 'string');
  return files.length > 0 ? files : undefined;
}

function mapTaskStatus(task: Task): ConsolidatorInput['parallel_outputs'][number]['status'] {
  if (task.status === 'completed') return 'success';
  if (task.status === 'failed' || task.status === 'skipped') return 'failed';
  return 'partial';
}

function buildConsolidatorInput(
  workflow: Workflow,
  tasks: Task[],
  options: ConsolidateOptions,
): ConsolidatorInput {
  return {
    workflow_id: workflow.id,
    workflow_objective: workflow.objective,
    parallel_outputs: tasks.map((task) => {
      const output = parseTaskOutput(task.output_json);
      return {
        task_id: task.id,
        task_name: task.name,
        output,
        status: mapTaskStatus(task),
        files_written: extractFilesWritten(output),
      };
    }),
    workspace_dir: options.workspaceDir ?? options.workspace_dir,
  };
}

async function consolidateViaPersona(
  workflow: Workflow,
  tasks: Task[],
  options: ConsolidateOptions,
): Promise<string> {
  const input = buildConsolidatorInput(workflow, tasks, options);
  const ctx = buildConsolidatorAgentContext(workflow, options);

  // Only override the persona's defaultModel when CONSOLIDATOR_MODEL is explicitly
  // set; getConsolidatorModel() returns a placeholder default when unset, which is
  // not a valid catalog id, so pass undefined to preserve persona.defaultModel.
  const envModel = process.env.CONSOLIDATOR_MODEL ? getConsolidatorModel() : undefined;

  const output: ConsolidatorOutput = await runAgent(CONSOLIDATOR_PERSONA,
    input,
    ctx,
    { invoke: omnirouteInvoker, parseJson: true, ...(envModel ? { modelOverride: envModel } : {}) },
  );

  return output.summary;
}

// Merges completed task outputs into a single deliverable. For single-task
// workflows, returns the task output unchanged (no LLM call).
export async function consolidateWorkflow(
  workflow: Workflow,
  tasks: Task[],
  options: ConsolidateOptions = {},
): Promise<string> {
  const completed = tasks.filter((t) => t.status === 'completed' && t.output_json);
  if (completed.length === 0) return '';
  if (completed.length === 1 && !getUsePersonas()) return completed[0].output_json ?? '';

  if (getUsePersonas()) {
    try {
      return await consolidateViaPersona(workflow, tasks, options);
    } catch (err) {
      console.warn('[consolidator-persona] Falling back to legacy consolidator path', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (completed.length === 1) return completed[0].output_json ?? '';

  return callOmniroute({
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: buildUserPrompt(workflow, tasks),
    model: getConsolidatorModel(),
  });
}
