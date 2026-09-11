/**
 * Apply config-driven syntactic rules (required fields, allowable values, regex,
 * aliases, expected files, metadata) on top of FHIR structural checks.
 */

import type { CheckIssue, CheckStatus } from '../types';
import type {
  DatasetRunContext,
  EntityRule,
  FieldSeverity,
  ValidationConfig
} from './types';
import { TOOL_VERSION } from '../report/build-report';
import { compileRegex, fieldPresent } from '../pipeline/helpers';

function severityToStatus(severity: FieldSeverity | undefined, fallback: CheckStatus): CheckStatus {
  if (severity === 'error') return 'error';
  if (severity === 'warn') return 'warn';
  if (severity === 'info') return 'ok';
  return fallback;
}

const hasValue = fieldPresent;

function rawFieldValue(resource: Record<string, unknown>, field: string): string | undefined {
  const value = resource[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function getEntityRule(config: ValidationConfig, resourceType: string): EntityRule | undefined {
  return config.entities.find((e) => e.name === resourceType);
}

/**
 * Config-driven checks against already-parsed FHIR resources.
 */
export function applyConfigEntityRules(
  config: ValidationConfig,
  resources: Array<Record<string, unknown>>,
  resourceType: string
): CheckIssue[] {
  const entity = getEntityRule(config, resourceType);
  if (!entity) return [];

  const issues: CheckIssue[] = [];
  const compiledFields = (entity.fields ?? []).map((field) => ({
    field,
    regex: field.regex ? compileRegex(field.regex) : null
  }));

  resources.forEach((resource, index) => {
    const id = typeof resource['id'] === 'string' ? resource['id'] : String(index + 1);
    const location = `${resourceType}/${id}`;

    for (const fieldName of entity.requiredFields ?? []) {
      if (!hasValue(resource, fieldName)) {
        issues.push({
          severity: 'error',
          label: 'Missing required field',
          detail: `Config requires ${resourceType}.${fieldName}.`,
          location
        });
      }
    }

    for (const { field, regex } of compiledFields) {
      const present = hasValue(resource, field.name);
      const severity = severityToStatus(field.severity, field.required ? 'error' : 'warn');
      if (field.required && !present) {
        issues.push({
          severity,
          label: 'Missing required field',
          detail: `Config field rule requires ${resourceType}.${field.name}.`,
          location
        });
        continue;
      }
      if (!present) continue;

      const raw = rawFieldValue(resource, field.name);
      if (field.allowableValues?.length && typeof resource[field.name] === 'string') {
        const value = String(resource[field.name]);
        if (!field.allowableValues.includes(value)) {
          issues.push({
            severity,
            label: 'Value not allowed',
            detail: `${resourceType}.${field.name}="${value}" is not in allowable values [${field.allowableValues.join(', ')}].`,
            location
          });
        }
      }
      if (regex && raw && !regex.test(raw)) {
        issues.push({
          severity,
          label: 'Regex constraint failed',
          detail: `${resourceType}.${field.name} does not match /${field.regex}/.`,
          location
        });
      }
    }

    // Alias awareness: if only a legacy field is present, emit a configurable notice.
    for (const alias of config.aliases ?? []) {
      const hasCanonical = hasValue(resource, alias.to);
      const hasLegacy = hasValue(resource, alias.from);
      if (hasLegacy && !hasCanonical) {
        issues.push({
          severity: severityToStatus(alias.severity, 'warn'),
          label: 'Legacy field alias',
          detail: `Found legacy field "${alias.from}"; canonical field is "${alias.to}".`,
          location
        });
      }
    }
  });

  return issues;
}

/** Validate dataset/run metadata against config.metadataRequirements. */
export function applyMetadataRequirements(
  config: ValidationConfig,
  runContext: DatasetRunContext
): CheckIssue[] {
  if ((config.plugins?.length ?? 0) > 0 && !config.plugins.includes('metadata-requirements')) {
    return [];
  }

  const issues: CheckIssue[] = [];
  const requirements = config.metadataRequirements ?? [];
  const values: Record<string, string | undefined> = {
    datasetId: runContext.datasetId,
    sourceSite: runContext.sourceSite,
    timeframe: runContext.timeframe,
    mode: runContext.mode,
    schemaVersion: runContext.schemaVersion ?? config.version,
    toolVersion: TOOL_VERSION,
    license: runContext.license,
    provenance: runContext.provenance,
    inputFiles: runContext.inputFiles?.length ? runContext.inputFiles.join(',') : undefined
  };

  for (const key of requirements) {
    const value = values[key];
    if (!value || !String(value).trim()) {
      // license / provenance / timeframe are often optional in interactive demos —
      // treat as warn so gate still passes unless failOnWarn.
      const soft = key === 'license' || key === 'provenance' || key === 'timeframe';
      issues.push({
        severity: soft ? 'warn' : 'error',
        label: 'Missing metadata',
        detail: `Run context is missing required metadata field "${key}".`,
        location: 'RunContext'
      });
    }
  }
  return issues;
}

/** Check expectedFiles against the provided input file list. */
export function applyExpectedFilesCheck(
  config: ValidationConfig,
  inputFiles: string[]
): CheckIssue[] {
  const expected = config.expectedFiles ?? [];
  if (!expected.length) return [];

  const issues: CheckIssue[] = [];
  const provided = [...new Set(inputFiles.map((f) => f.split(/[/\\]/).pop() || f))];
  for (const name of expected) {
    const base = name.split(/[/\\]/).pop() || name;
    if (!provided.some((p) => p === base || p.endsWith(base))) {
      issues.push({
        severity: 'error',
        label: 'Missing expected file',
        detail: `Expected input file "${name}" was not provided in this run.`,
        location: 'Dataset'
      });
    }
  }
  return issues;
}
