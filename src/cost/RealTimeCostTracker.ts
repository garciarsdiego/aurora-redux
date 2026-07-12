import { EventEmitter } from 'events';
import { getCostDatabase } from './CostDatabase.js';
import type { BudgetAlert, CostStreamEvent } from './types.js';

export class RealTimeCostTracker extends EventEmitter {
  private costDatabase = getCostDatabase();
  private workflowCosts = new Map<string, number>();
  private taskCosts = new Map<string, number>();
  // Per-workflow set of `${severity}:${recommended_action}` keys already
  // emitted — deduping on severity alone would let the 90% alert (critical /
  // downgrade_model) suppress the 100% alert (critical / early_terminate).
  private budgetAlertsEmitted = new Map<string, Set<string>>();
  // trackingId → ids of the call being tracked. Parsing the workflow_id back
  // out of the trackingId string is unsafe: workflow ids routinely contain
  // hyphens (UUIDs), so a split('-') would attribute costs to the wrong key.
  private activeTrackings = new Map<string, { workflow_id: string; task_id?: string }>();

  /**
   * Start tracking a new LLM call
   */
  startTracking(params: {
    model: string;
    workflow_id?: string;
    task_id?: string;
    task_type?: string;
  }): string {
    const workflowId = params.workflow_id || 'unknown';
    const trackingId = `${workflowId}-${params.task_id || 'unknown'}-${Date.now()}`;

    // Remember which workflow/task this call belongs to. Do NOT reset the
    // accumulated workflow cost here — a workflow spans many tracked calls.
    this.activeTrackings.set(trackingId, {
      workflow_id: workflowId,
      task_id: params.task_id,
    });

    return trackingId;
  }

  /**
   * Update tracking with actual usage data
   */
  updateTracking(trackingId: string, data: {
    input_tokens?: number;
    output_tokens?: number;
    estimated_cost_usd?: number;
  }): void {
    const tracking = this.activeTrackings.get(trackingId);
    const workflowId = tracking?.workflow_id ?? 'unknown';

    if (data.estimated_cost_usd !== undefined) {
      // Accumulate — mirrors recordStreamUsage; a per-call cost must add to
      // the workflow total, not overwrite it.
      this.updateWorkflowCost(workflowId, this.getWorkflowCost(workflowId) + data.estimated_cost_usd);
      if (tracking?.task_id) {
        this.updateTaskCost(tracking.task_id, this.getTaskCost(tracking.task_id) + data.estimated_cost_usd);
      }
    }

    // Emit cost update event
    this.emit('costUpdate', {
      trackingId,
      ...data,
      timestamp: Date.now()
    });
  }

  /**
   * End tracking and return final data
   */
  endTracking(trackingId: string): {
    total_cost_usd: number;
    workflow_id: string;
    timestamp: number;
  } | null {
    const tracking = this.activeTrackings.get(trackingId);
    if (!tracking) {
      return null;
    }
    this.activeTrackings.delete(trackingId);

    return {
      total_cost_usd: this.getWorkflowCost(tracking.workflow_id),
      workflow_id: tracking.workflow_id,
      timestamp: Date.now()
    };
  }

  /**
   * Record an observed token-usage delta from a REAL LLM stream.
   *
   * De-mock (OPS-05): the previous trackTokenStream() generated pseudo-random
   * tokens on a setInterval and emitted fabricated `cost` events. It had no
   * callers (dead path) and is removed. Callers wired to an actual provider
   * stream should report measured token usage here instead — this updates the
   * in-memory workflow/task tallies, emits a real CostStreamEvent, and runs
   * the same budget-alert path the fake generator used to drive.
   */
  recordStreamUsage(params: {
    workflow_id: string;
    task_id: string;
    model: string;
    tokens_in: number;
    tokens_out: number;
    budget?: number;
    onBudgetAlert?: (alert: BudgetAlert) => void;
  }): CostStreamEvent {
    const cost = this.costDatabase.calculateCost(
      params.model,
      params.tokens_in,
      params.tokens_out
    );

    const prevWorkflowCost = this.getWorkflowCost(params.workflow_id);
    const prevTaskCost = this.getTaskCost(params.task_id);
    this.updateWorkflowCost(params.workflow_id, prevWorkflowCost + cost);
    this.updateTaskCost(params.task_id, prevTaskCost + cost);

    const event: CostStreamEvent = {
      workflow_id: params.workflow_id,
      task_id: params.task_id,
      model: params.model,
      tokens_in: params.tokens_in,
      tokens_out: params.tokens_out,
      cost_usd: cost,
      timestamp: Date.now(),
    };
    this.emit('cost', event);

    if (params.budget) {
      const alert = this.checkBudget(params.workflow_id, params.budget);
      if (alert) {
        // Dedup per (severity, recommended_action): both the 90% and 100%
        // thresholds are 'critical', but early_terminate must still fire
        // after downgrade_model has already been emitted.
        const alertKey = `${alert.severity}:${alert.recommended_action ?? ''}`;
        let emitted = this.budgetAlertsEmitted.get(params.workflow_id);
        if (!emitted) {
          emitted = new Set<string>();
          this.budgetAlertsEmitted.set(params.workflow_id, emitted);
        }
        if (!emitted.has(alertKey)) {
          emitted.add(alertKey);
          this.emit('budgetAlert', alert);
          params.onBudgetAlert?.(alert);
        }
      }
    }

    return event;
  }

  /**
   * Get total cost for a workflow
   */
  getWorkflowCost(workflow_id: string): number {
    return this.workflowCosts.get(workflow_id) || 0;
  }

  /**
   * Get total cost for a task
   */
  getTaskCost(task_id: string): number {
    return this.taskCosts.get(task_id) || 0;
  }

  /**
   * Check if workflow is within budget
   */
  checkBudget(workflow_id: string, budget: number): BudgetAlert | null {
    const currentCost = this.getWorkflowCost(workflow_id);
    const percentage = (currentCost / budget) * 100;
    
    if (percentage >= 100) {
      return {
        workflow_id,
        current_cost: currentCost,
        budget,
        percentage,
        severity: 'critical',
        recommended_action: 'early_terminate'
      };
    } else if (percentage >= 90) {
      return {
        workflow_id,
        current_cost: currentCost,
        budget,
        percentage,
        severity: 'critical',
        recommended_action: 'downgrade_model'
      };
    } else if (percentage >= 75) {
      return {
        workflow_id,
        current_cost: currentCost,
        budget,
        percentage,
        severity: 'warning',
        recommended_action: 'continue'
      };
    }
    
    return null;
  }

  /**
   * Update workflow cost
   */
  private updateWorkflowCost(workflow_id: string, cost: number): void {
    this.workflowCosts.set(workflow_id, cost);
  }

  /**
   * Update task cost
   */
  private updateTaskCost(task_id: string, cost: number): void {
    this.taskCosts.set(task_id, cost);
  }

  /**
   * Reset tracking for a workflow
   */
  resetWorkflow(workflow_id: string): void {
    this.workflowCosts.delete(workflow_id);
    this.budgetAlertsEmitted.delete(workflow_id);
  }

  /**
   * Get all workflow costs
   */
  getAllWorkflowCosts(): Map<string, number> {
    return new Map(this.workflowCosts);
  }

  /**
   * Estimate remaining budget for a workflow
   */
  estimateRemainingBudget(workflow_id: string, budget: number): number {
    const currentCost = this.getWorkflowCost(workflow_id);
    return Math.max(0, budget - currentCost);
  }
}

// Singleton instance for use across the application
let trackerInstance: RealTimeCostTracker | null = null;

export function getRealTimeCostTracker(): RealTimeCostTracker {
  if (!trackerInstance) {
    trackerInstance = new RealTimeCostTracker();
  }
  return trackerInstance;
}