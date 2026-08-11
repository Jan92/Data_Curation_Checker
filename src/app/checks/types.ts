/**
 * Types for FHIR Observation and DiagnosticReport validation results.
 * Used by both the UI and the headless checks API.
 */

import type { Observation, DiagnosticReport } from '../models/fhir.types';
import type { DatasetRunContext, ValidationConfig } from './config/types';

export type CheckStatus = 'ok' | 'warn' | 'error';

/** High-level issue taxonomy for differentiated DCC reporting. */
export type CheckCategory =
  | 'ingest'
  | 'dataset'
  | 'structure'
  | 'laboratory'
  | 'reference'
  | 'config'
  | 'metadata'
  | 'vocabulary'
  | 'completeness'
  | 'datetime'
  | 'identifier'
  | 'reproducibility'
  | 'policy';

export interface CheckResult {
  label: string;
  status: CheckStatus;
  statusLabel: string;
  detail: string;
  /** Optional suite / plugin id for grouping in UI and reports. */
  suiteId?: string;
  category?: CheckCategory;
  errorCount?: number;
  warnCount?: number;
}

export interface CheckIssue {
  severity: CheckStatus;
  label: string;
  detail: string;
  location: string;
  /** Machine-oriented violation code. */
  code?: string;
  category?: CheckCategory;
  suiteId?: string;
  field?: string;
  rawValue?: string;
}

export interface CheckSuiteResult {
  id: string;
  label: string;
  description: string;
  category: CheckCategory;
  enabled: boolean;
  status: CheckStatus;
  statusLabel: string;
  detail: string;
  errorCount: number;
  warnCount: number;
  issueCount: number;
  issues: CheckIssue[];
}

export interface ParseResult {
  ok: boolean;
  type: string;
  resources: Observation[];
  diagnosticReports: DiagnosticReport[];
  error?: string;
}

export interface ValidationReport {
  parseResult: ParseResult;
  issues: CheckIssue[];
  checkResults: CheckResult[];
  observationCount?: number;
  laboratoryCount?: number;
  diagnosticReportCount?: number;
}

export interface ValidateOptions {
  source?: string;
  sourceDetail?: string;
  /** Optional validation config (defaults to fhir-lab-v1). */
  config?: ValidationConfig;
  /** Dataset/run context for auditability. */
  runContext?: Partial<DatasetRunContext>;
  /**
   * Optional allow-list of suite/plugin ids to run.
   * When omitted, suites follow config.plugins (+ always-on core suites).
   */
  suites?: string[];
  /** Skip always-on core suites (ingest/dataset) — mainly for tests. */
  skipCoreSuites?: boolean;
}
