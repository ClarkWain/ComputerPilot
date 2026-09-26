import type { Stats } from 'node:fs';

export type WorkflowConfig = {
  schemaVersion: 1;
  name: string;
  inputDirectory: string;
  /** Version 1 writes artifacts inside the new run directory. Only `artifacts` is accepted. */
  outputDirectory?: string;
  adapter: 'aseprite-png';
  executable: string;
  maxItems?: number;
  timeoutMs?: number;
  onError: 'stop' | 'continue';
  /** Informational only. Runtime authoring is injected as a trusted hook. */
  script?: string;
};

export type WorkflowSource = {
  relativePath: string;
  absolutePath: string;
  size: number;
  sha256: string;
};

export type ProbeResult =
  | { status: 'supported'; expected: Record<string, unknown> }
  | { status: 'unsupported'; code: string; message: string }
  | { status: 'failed'; code: string; message: string };

export type ExecuteReceipt =
  | { status: 'completed'; details?: Record<string, unknown> }
  | { status: 'failed'; dispatch: 'not_started' | 'completed'; code: string; message: string;
      details?: Record<string, unknown> }
  | { status: 'unknown'; dispatch: 'possibly_partial' | 'unknown'; code: string; message: string;
      details?: Record<string, unknown> };

export type VerificationEvidence = {
  status: 'verified' | 'failed';
  verifier: string;
  expected: Record<string, unknown>;
  actual?: Record<string, unknown>;
  message?: string;
};

/** execute must settle only after its child process can no longer write the destination. */
export interface WorkflowAdapter {
  readonly id: WorkflowConfig['adapter'];
  readonly version: string;
  probe(source: WorkflowSource): Promise<ProbeResult>;
  execute(sourcePath: string, destinationPath: string, signal?: AbortSignal): Promise<ExecuteReceipt>;
  verify(destinationPath: string, expected: Record<string, unknown>): Promise<VerificationEvidence>;
}

export type WorkflowItemDecision = { decision: 'export' | 'skip'; reason?: string };
export type TrustedWorkflowScript = {
  /** SHA-256 of the exact trusted script and locked dependency package used for this run. */
  hash: string;
  decideItem(source: WorkflowSource, probe: ProbeResult): Promise<WorkflowItemDecision>;
};

export type WorkflowPlanItem = {
  id: string;
  source: WorkflowSource;
  destinationRelativePath: string;
};
export type WorkflowPlan = {
  schemaVersion: 1;
  workflow: WorkflowConfig;
  scriptHash?: string;
  executableSha256: string;
  adapterVersion: string;
  createdAt: string;
  items: WorkflowPlanItem[];
  planHash: string;
};

export type WorkflowItemStatus = 'not_started' | 'in_progress' | 'completed' | 'failed' | 'skipped' |
  'unsupported' | 'conflict' | 'needs_reconciliation';
export type WorkflowRunStatus = 'created' | 'running' | 'paused' | 'cancelled' |
  'needs_reconciliation' | 'completed' | 'completed_with_errors' | 'failed';
export type WorkflowCounts = Record<WorkflowItemStatus, number> & { total: number };
export type WorkflowReportItem = {
  itemId: string;
  sourceRelativePath: string;
  destinationRelativePath: string;
  status: WorkflowItemStatus;
  sourceSha256: string;
  artifactSha256?: string;
  expected?: Record<string, unknown>;
  evidence?: VerificationEvidence;
  message?: string;
};
export type WorkflowReport = {
  schemaVersion: 1;
  runId: string;
  name: string;
  status: WorkflowRunStatus;
  planHash: string;
  createdAt: string;
  updatedAt: string;
  counts: WorkflowCounts;
  items: WorkflowReportItem[];
  message?: string;
};

export type WorkflowControl = {
  /** Read an atomically replaced control.json; a request is consumed at an item boundary. */
  getRequest(): Promise<'pause' | 'cancel' | undefined>;
};
export type WorkflowRunOptions = {
  trustedScript?: TrustedWorkflowScript;
  control?: WorkflowControl;
  signal?: AbortSignal;
  onProgress?: (report: WorkflowReport) => void | Promise<void>;
};

export type WorkflowReconcileRequest = {
  action: 'accept' | 'skip';
  reason: string;
  /** Required for skip so an uncertain side effect is never silently discarded. */
  acknowledged?: boolean;
};

export type WorkflowFsIdentity = Pick<Stats, 'dev' | 'ino' | 'size' | 'mtimeMs'>;
