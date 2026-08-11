/**
 * Configuration and run-context types for the SEARCH Data Curation Checker (DCC).
 * Aligned with D1.6 §4.2.3 (medicalvalues).
 */

export type ValidationMode = 'local' | 'batch' | 'interactive';

export type FieldSeverity = 'error' | 'warn' | 'info';

export interface DatasetRunContext {
  datasetId: string;
  sourceSite: string;
  timeframe?: string;
  mode: ValidationMode;
  inputFiles: string[];
  license?: string;
  provenance?: string;
  schemaVersion?: string;
}

export interface EntityFieldRule {
  name: string;
  required?: boolean;
  dataType?: string;
  allowableValues?: string[];
  regex?: string;
  severity?: FieldSeverity;
}

export interface EntityRule {
  name: string;
  description?: string;
  requiredFields?: string[];
  optionalFields?: string[];
  fields?: EntityFieldRule[];
}

export interface ValidationConfig {
  id: string;
  version: string;
  name: string;
  description?: string;
  formats: string[];
  entities: EntityRule[];
  metadataRequirements: string[];
  plugins: string[];
  /** If true, any error fails the quality gate (default true). */
  failOnError?: boolean;
  /** If true, warnings also fail the gate (default false). */
  failOnWarn?: boolean;
}

export interface ConfigValidationIssue {
  severity: FieldSeverity;
  path: string;
  message: string;
}

export interface ConfigValidationReport {
  ok: boolean;
  issues: ConfigValidationIssue[];
}

export interface EffectiveConfigRef {
  id: string;
  version: string;
  hash: string;
  snapshot: ValidationConfig;
}

export interface RecordValidationResult {
  recordId: string;
  resourceType: string;
  status: 'pass' | 'fail' | 'warn';
  violationCode?: string;
  field?: string;
  rawValue?: string;
  message: string;
  severity: FieldSeverity;
}

export interface DatasetSummary {
  observationCount: number;
  diagnosticReportCount: number;
  laboratoryCount: number;
  errorCount: number;
  warnCount: number;
  passCount: number;
  failCount: number;
  timestamp: string;
  toolVersion: string;
}

export type GateStatus = 'PASS' | 'FAIL';
