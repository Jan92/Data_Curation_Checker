/**
 * Recommended-field completeness for laboratory CAD datasets.
 */

import type { CheckIssue } from '../types';
import { issue } from './helpers';

const OBS_RECOMMENDED = [
  'subject',
  'effectiveDateTime',
  'issued',
  'performer',
  'category',
  'specimen'
] as const;

const DR_RECOMMENDED = [
  'subject',
  'effectiveDateTime',
  'issued',
  'performer',
  'category',
  'result'
] as const;

function present(resource: Record<string, unknown>, field: string): boolean {
  const value = resource[field];
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value as object).length > 0;
  return true;
}

export function runCompletenessChecks(
  resources: Array<Record<string, unknown>>,
  resourceType: 'Observation' | 'DiagnosticReport'
): CheckIssue[] {
  const issues: CheckIssue[] = [];
  const recommended: string[] =
    resourceType === 'Observation' ? [...OBS_RECOMMENDED] : [...DR_RECOMMENDED];

  if (!resources.length) return issues;

  let missingTotal = 0;
  const missingByField: Record<string, number> = {};

  resources.forEach((resource, index) => {
    const id = typeof resource['id'] === 'string' ? resource['id'] : String(index + 1);
    const location = `${resourceType}/${id}`;
    const missing = recommended.filter((f: string) => !present(resource, f));
    missing.forEach((f) => {
      missingByField[f] = (missingByField[f] ?? 0) + 1;
      missingTotal += 1;
      issues.push(
        issue({
          severity: 'warn',
          label: 'Recommended field missing',
          detail: `${resourceType}.${f} is recommended for curated laboratory datasets.`,
          location,
          category: 'completeness',
          code: 'RECOMMENDED_FIELD_MISSING',
          field: f
        })
      );
    });

    // value vs dataAbsentReason completeness for Observation
    if (resourceType === 'Observation') {
      const valueKeys = [
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
      ];
      const hasValue = valueKeys.some((k) => present(resource, k));
      const hasDar = present(resource, 'dataAbsentReason');
      const organizer = resource['organizer'] === true;
      if (!organizer && !hasValue && !hasDar) {
        issues.push(
          issue({
            severity: 'error',
            label: 'No value or dataAbsentReason',
            detail: 'Observation should carry value[x] or dataAbsentReason (unless organizer/panel).',
            location,
            category: 'completeness',
            code: 'VALUE_OR_DAR_REQUIRED'
          })
        );
      }
    }
  });

  const slots = resources.length * recommended.length;
  const coverage = slots === 0 ? 100 : Math.round(((slots - missingTotal) / slots) * 100);
  if (coverage < 60) {
    issues.push(
      issue({
        severity: 'warn',
        label: 'Low completeness score',
        detail: `${resourceType} recommended-field coverage is ${coverage}% (missing: ${Object.entries(missingByField)
          .map(([k, v]) => `${k}=${v}`)
          .join(', ') || 'n/a'}).`,
        location: 'Dataset',
        category: 'completeness',
        code: 'LOW_COMPLETENESS',
        rawValue: String(coverage)
      })
    );
  }

  return issues;
}
