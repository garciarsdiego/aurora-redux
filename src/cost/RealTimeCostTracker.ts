import { EventEmitter } from 'events';
import { getCostDatabase } from './CostDatabase.js';
import type { BudgetAlert, CostStreamEvent } from './types.js';

export class RealTimeCostTracker extends EventEmitter {
  private costDatabase = getCostDatabase();
  private workflowCosts = new Map<string, number>();
  private taskCosts = new Map<string, number>();
  private budgetAlertsEmitted = new Set<string>();

  /**
   * Start tracking a new LLM call
   */
  startTracking(params: {
    model: string;
    workflow_id?: string;
    task_id?: string;
    task_type?: string;
  }): string {
    const trackingId = `${params.workflow_id || 'unknown'}-${params.task_id || 'unknown'}-${Date.now()}`;
    
    // Initialize tracking state
    this.updateWorkflowCost(params.workflow_id || 'unknown', 0);
    if (params.task_id) {
      this.updateTaskCost(params.task_id, 0);
    }
    
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
    // Parse tracking ID to get workflow_id
    const parts = trackingId.split('-');
    const workflowId = parts[0] || 'unknown';
    
    if (data.estimated_cost_usd !== undefined) {
      this.updateWorkflowCost(workflowId, data.estimated_cost_usd);
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
    // Parse tracking ID to get workflow_id
    const parts = trackingId.split('-');
    const workflowId = parts[0] || 'unknown';
    
    const totalCost = this.getWorkflowCost(workflowId);
    
    return {
      total_cost_usd: totalCost,
      workflow_id: workflowId,
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
      if (alert && !this.budgetAlertsEmitted.has(`${params.workflow_id}-${alert.severity}`)) {
        this.budgetAlertsEmitted.add(`${params.workflow_id}-${alert.severity}`);
        this.emit('budgetAlert', alert);
        params.onBudgetAlert?.(alert);
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
    this.budgetAlertsEmitted.delete(`${workflow_id}-warning`);
    this.budgetAlertsEmitted.delete(`${workflow_id}-critical`);
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