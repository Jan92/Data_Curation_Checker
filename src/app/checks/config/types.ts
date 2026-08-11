/**
 * Configuration and run-context types for the Data Curation Checker (DCC).
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
  /** Primary key field names for duplicate detection within the entity set. */
  primaryKeys?: string[];
}

/** Map a legacy / alternate field or column name onto a canonical field. */
export interface AliasMapping {
  from: string;
  to: string;
  severity?: FieldSeverity;
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
  /** Optional expected input file names (informational / batch checks). */
  expectedFiles?: string[];
  /** Legacy name → canonical field mappings. */
  aliases?: AliasMapping[];
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
  warnRecordCount: number;
  violationCount: number;
  timestamp: string;
  toolVersion: string;
  configVersion: string;
  configHash: string;
}

export type GateStatus = 'PASS' | 'FAIL';
