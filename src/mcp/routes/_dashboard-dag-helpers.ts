// Sprint 4 (D-H2.066): shared helpers between dashboard-workflow-ops and
// dashboard-triggers-http routers — both invoke runDashboardDag and
// runDashboardTriggerTarget for workflow execution paths.

import { runWorkflowTool } from '../tools/run_workflow.js';
import { validateDashboardDag, parseDashboardDag } from '../dashboard-dag-ops.js';
import { buildTriggerObjective } from '../dashboard-triggers.js';
import { scanForInjection } from '../../v2/injection-scan/index.js';

export async function runDashboardDag(params: {
  workspace: string;
  objective: string;
  dag: unknown;
  auto_approve?: boolean;
  cli_permission_mode?: 'safe' | 'autonomous';
  workflow_mode?: 'standard' | 'existing_code_feature';
  max_duration_seconds?: number | null;
}): Promise<Record<string, unknown>> {
  const dag = validateDashboardDag(params.dag);
  const text = await runWorkflowTool({
    workspace: params.workspace,
    objective: params.objective,
    auto_approve: params.auto_approve ?? false,
    precomputed_dag: JSON.stringify(dag),
    ...(params.cli_permission_mode ? { cli_permission_mode: params.cli_permission_mode } : {}),
    ...(params.workflow_mode ? { workflow_mode: params.workflow_mode } : {}),
    ...(params.max_duration_seconds !== undefined && params.max_duration_seconds !== null
      ? { max_duration_seconds: params.max_duration_seconds }
      : {}),
  });
  const parsed = JSON.parse(text) as Record<string, unknown>;
  if (parsed['error']) throw new Error(String(parsed['error']));
  return parsed;
}

export function dashboardCliPermissionMode(input: Record<string, unknown>): 'safe' | 'autonomous' | undefined {
  return input['cli_permission_mode'] === 'safe' || input['cli_permission_mode'] === 'autonomous'
    ? input['cli_permission_mode']
    : undefined;
}

export function dashboardWorkflowMode(input: Record<string, unknown>): 'standard' | 'existing_code_feature' | undefined {
  return input['workflow_mode'] === 'standard' || input['workflow_mode'] === 'existing_code_feature'
    ? input['workflow_mode']
    : undefined;
}

export function parseDashboardDagFromBody(input: Record<string, unknown>): ReturnType<typeof validateDashboardDag> {
  if (typeof input['source'] === 'string') return parseDashboardDag(input['source']);
  if (input['dag'] !== undefined) return validateDashboardDag(input['dag']);
  throw new Error('source or dag is required');
}

export async function runDashboardTriggerTarget(params: {
  workspace: string;
  target_kind: 'objective' | 'dag';
  target_ref: string;
  input_payload: unknown;
  live_payload?: string;
}): Promise<Record<string, unknown>> {
  const objective = buildTriggerObjective(params.target_ref, params.input_payload, params.live_payload);

  // Security: scan the assembled webhook/schedule objective for prompt-injection
  // before it reaches the decomposer. The objective combines operator-defined
  // targetRef with raw webhook body (up to 20 KB) — a vector for external callers
  // to inject instructions. INJECTION_SCAN_ENFORCE=true (default) blocks; false
  // allows pass-through with a warning logged to stderr for observability.
  const webhookScan = scanForInjection(objective);
  if (!webhookScan.safe) {
    const enforce = process.env['INJECTION_SCAN_ENFORCE'] !== 'false';
    if (enforce) {
      // webhook_injection_scan_blocked — observable via caller's markTriggerFireError
      // and the prefixed error message recorded in the trigger_fires table.
      process.stderr.write(
        `[webhook_injection_scan_blocked] objective blocked (score=${webhookScan.score.toFixed(2)}, flags: ${webhookScan.flags.map((f) => f.pattern).join(', ')})\n`,
      );
      throw new Error(
        `[webhook_injection_scan_blocked] Webhook objective rejected by injection scanner ` +
        `(score=${webhookScan.score.toFixed(2)}; flags: ${webhookScan.flags.map((f) => f.pattern).join(', ')})`,
      );
    }
    // webhook_injection_scan_warned — observability-only, workflow proceeds.
    process.stderr.write(
      `[webhook_injection_scan_warned] objective flagged but INJECTION_SCAN_ENFORCE=false — proceeding ` +
      `(score=${webhookScan.score.toFixed(2)}, flags: ${webhookScan.flags.map((f) => f.pattern).join(', ')})\n`,
    );
  }
  if (params.target_kind === 'dag') {
    return runDashboardDag({
      workspace: params.workspace,
      objective,
      dag: JSON.parse(params.target_ref) as unknown,
      auto_approve: false,
      cli_permission_mode: 'safe',
    });
  }
  const text = await runWorkflowTool({
    workspace: params.workspace,
    objective,
    auto_approve: false,
    cli_permission_mode: 'safe',
  });
  const parsed = JSON.parse(text) as Record<string, unknown>;
  if (parsed['error']) throw new Error(String(parsed['error']));
  return parsed;
}
