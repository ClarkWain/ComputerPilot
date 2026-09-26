/** Public authoring types for trusted, item-level workflow decisions. */
import type { ProbeResult, WorkflowItemDecision, WorkflowSource } from './types.js';

export type { ProbeResult, WorkflowItemDecision, WorkflowSource } from './types.js';

/**
 * A trusted local module may choose whether a planned source is exported.
 * It cannot dispatch desktop/native actions through this interface.
 */
export type WorkflowDecisionContext = {
  decideItem(source: WorkflowSource, probe: ProbeResult): Promise<WorkflowItemDecision>;
};

export type WorkflowScriptModule = {
  default: ((source: WorkflowSource, probe: ProbeResult) => WorkflowItemDecision | Promise<WorkflowItemDecision>) |
    WorkflowDecisionContext;
};

export function defineWorkflow(
  decideItem: WorkflowDecisionContext['decideItem']
): WorkflowDecisionContext {
  return { decideItem };
}
