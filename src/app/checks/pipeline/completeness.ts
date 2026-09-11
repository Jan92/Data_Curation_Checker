/**
 * Recommended-field completeness for laboratory CAD datasets.
 */

import type { CheckIssue } from '../types';
import { fieldPresent, issue, OBSERVATION_VALUE_KEYS, resourceLocation } from './helpers';

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
    const location = resourceLocation(resource, resourceType, index);
    const missing = recommended.filter((f: string) => !fieldPresent(resource, f));
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

    if (resourceType === 'Observation') {
      const hasValue = OBSERVATION_VALUE_KEYS.some((k) => fieldPresent(resource, k));
      const hasDar = fieldPresent(resource, 'dataAbsentReason');
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
