/**
 * Shared helpers for differentiated check suites.
 */

import type { CheckCategory, CheckIssue, CheckStatus, CheckSuiteResult } from '../types';

/** FHIR Observation.value[x] choice types. */
export const OBSERVATION_VALUE_KEYS = [
  'valueQuantity',
  'valueCodeableConcept',
  'valueString',
  'valueBoolean',
  'valueInteger',
  'valueRange',
  'valueRatio',
  'valueSampledData',
  'valueTime',
  'valueDateTime',
  'valuePeriod',
  'valueAttachment'
] as const;

export function issueCodeFromLabel(label: string): string {
  return label.replace(/\s+/g, '_').toUpperCase();
}

export function issue(
  partial: Omit<CheckIssue, 'code'> & { code?: string }
): CheckIssue {
  return {
    ...partial,
    code: partial.code ?? issueCodeFromLabel(partial.label)
  };
}

export function fieldPresent(resource: Record<string, unknown>, field: string): boolean {
  const value = resource[field];
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value as object).length > 0;
  return true;
}

export function resourceLocation(
  resource: Record<string, unknown>,
  resourceType: string,
  index: number
): string {
  const id = typeof resource['id'] === 'string' ? resource['id'] : String(index + 1);
  return `${resourceType}/${id}`;
}

export function compileRegex(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern);
  } catch {
    return null;
  }
}

export function summarizeSuite(input: {
  id: string;
  label: string;
  description: string;
  category: CheckCategory;
  enabled: boolean;
  issues: CheckIssue[];
  skippedDetail?: string;
}): CheckSuiteResult {
  if (!input.enabled) {
    return {
      id: input.id,
      label: input.label,
      description: input.description,
      category: input.category,
      enabled: false,
      status: 'ok',
      statusLabel: 'Skipped',
      detail: input.skippedDetail ?? 'Suite disabled by config/plugins.',
      errorCount: 0,
      warnCount: 0,
      issueCount: 0,
      issues: []
    };
  }

  const tagged = input.issues.map((i) => ({
    ...i,
    suiteId: i.suiteId ?? input.id,
    category: i.category ?? input.category,
    code: i.code ?? issueCodeFromLabel(i.label)
  }));
  const errorCount = tagged.filter((i) => i.severity === 'error').length;
  const warnCount = tagged.filter((i) => i.severity === 'warn').length;
  const status: CheckStatus = errorCount ? 'error' : warnCount ? 'warn' : 'ok';

  return {
    id: input.id,
    label: input.label,
    description: input.description,
    category: input.category,
    enabled: true,
    status,
    statusLabel: status === 'ok' ? 'OK' : status === 'warn' ? 'Warn' : 'Error',
    detail:
      tagged.length === 0
        ? 'No findings.'
        : `${tagged.length} finding(s): ${errorCount} error(s), ${warnCount} warning(s).`,
    errorCount,
    warnCount,
    issueCount: tagged.length,
    issues: tagged
  };
}

export function suiteToCheckResult(suite: CheckSuiteResult) {
  return {
    label: suite.label,
    status: suite.status,
    statusLabel: suite.statusLabel,
    detail: suite.enabled ? suite.detail : `Skipped — ${suite.detail}`,
    suiteId: suite.id,
    category: suite.category,
    errorCount: suite.errorCount,
    warnCount: suite.warnCount
  };
}

/** Classify legacy FHIR checker issues into suites/categories. */
export function classifyBaseIssue(issue: CheckIssue): { suiteId: string; category: CheckCategory } {
  const label = issue.label.toLowerCase();
  const detail = issue.detail.toLowerCase();
  const location = issue.location.toLowerCase();

  if (
    label.includes('loinc') ||
    label.includes('ucum') ||
    label.includes('reference range') ||
    label.includes('critical') ||
    label.includes('laboratory') ||
    label.includes('specimen') ||
    label.includes('fasting') ||
    label.includes('panel') ||
    label.includes('reflex') ||
    label.includes('delta') ||
    detail.includes('laboratory') ||
    detail.includes('loinc')
  ) {
    return { suiteId: 'laboratory-loinc', category: 'laboratory' };
  }

  if (
    label.includes('reference') ||
    label.includes('hasmember') ||
    label.includes('derivedfrom') ||
    label.includes('triggeredby') ||
    label.includes('duplicate id') ||
    detail.includes('not in this dataset')
  ) {
    return { suiteId: 'cross-references', category: 'reference' };
  }

  if (
    label.includes('date') ||
    label.includes('time') ||
    label.includes('issued') ||
    label.includes('effective') ||
    label.includes('period')
  ) {
    return { suiteId: 'datetime-formats', category: 'datetime' };
  }

  if (
    label.includes('status') ||
    label.includes('category') ||
    label.includes('interpretation') ||
    label.includes('code system') ||
    label.includes('coding')
  ) {
    return { suiteId: 'vocabulary', category: 'vocabulary' };
  }

  if (location.startsWith('diagnosticreport')) {
    return { suiteId: 'fhir-diagnostic-report', category: 'structure' };
  }

  return { suiteId: 'fhir-observation', category: 'structure' };
}
