/**
 * Configuration and run-context types for the Data Curation Checker (DCC).
 * Supports FHIR lab demonstrator configs and dictionary-driven study datasets
 * (e.g. SHIELD-CC-2025 / SHIELD-OC-2025).
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
  /** Study identifier, e.g. SHIELD-CC-2025 / SHIELD-OC-2025. */
  studyId?: string;
  /** Dictionary / appendix reference used for this run. */
  dictionaryRef?: string;
}

export interface EntityFieldRule {
  name: string;
  required?: boolean;
  dataType?: string;
  allowableValues?: string[];
  regex?: string;
  /** Optional FHIR/ISO date-time pattern hint (alias of regex for documentation). */
  dateTimePattern?: string;
  severity?: FieldSeverity;
  description?: string;
}

export interface EntityRule {
  name: string;
  description?: string;
  /** Logical table / file name for study dictionaries (e.g. demographics.csv). */
  table?: string;
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
  /** Optional entity/table scope; when omitted, applies globally. */
  entity?: string;
  severity?: FieldSeverity;
}

/** Cross-file / cross-table reference rule (study dictionaries). */
export interface CrossFileReference {
  fromEntity: string;
  fromField: string;
  toEntity: string;
  toField: string;
  severity?: FieldSeverity;
  description?: string;
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
  /** Cross-file / cross-table referential integrity. */
  crossFileReferences?: CrossFileReference[];
  /** Study this config targets (SHIELD-CC-2025, SHIELD-OC-2025, …). */
  studyId?: string;
  /** Human-readable dictionary source (e.g. Appendix 10 V2). */
  dictionaryRef?: string;
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
  /** Total validated rows / resources. */
  rowCount: number;
  observationCount: number;
  diagnosticReportCount: number;
  laboratoryCount: number;
  /** Per-table / per-entity row counts. */
  tableCounts: Record<string, number>;
  errorCount: number;
  warnCount: number;
  passCount: number;
  failCount: number;
  warnRecordCount: number;
  violationCount: number;
  /** Aggregated violations for documented syntactic QA evidence. */
  violationsByField: Record<string, number>;
  violationsByCode: Record<string, number>;
  missingFiles: string[];
  unexpectedFiles: string[];
  missingColumns: string[];
  unexpectedColumns: string[];
  timestamp: string;
  toolVersion: string;
  configVersion: string;
  configHash: string;
  studyId?: string;
  dictionaryRef?: string;
}

export type GateStatus = 'PASS' | 'FAIL';
