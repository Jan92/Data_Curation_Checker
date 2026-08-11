/**
 * Types for FHIR Observation and DiagnosticReport validation results.
 * Used by both the UI and the headless checks API.
 */

import type { Observation, DiagnosticReport } from '../models/fhir.types';
import type { DatasetRunContext, ValidationConfig } from './config/types';

export type CheckStatus = 'ok' | 'warn' | 'error';

export interface CheckResult {
  label: string;
  status: CheckStatus;
  statusLabel: string;
  detail: string;
}

export interface CheckIssue {
  severity: CheckStatus;
  label: string;
  detail: string;
  location: string;
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
  /** Dataset/run context for auditability (D1.6). */
  runContext?: Partial<DatasetRunContext>;
}
