/**
 * Differentiated dataset-level integrity checks.
 */

import type { CheckIssue, ParseResult } from '../types';
import { issue } from './helpers';

export function runDatasetIntegrityChecks(
  parseResult: ParseResult,
  source: string
): CheckIssue[] {
  const issues: CheckIssue[] = [];
  const observations = parseResult.resources ?? [];
  const reports = parseResult.diagnosticReports ?? [];
  const total = observations.length + reports.length;

  if (!parseResult.ok) {
    return issues;
  }

  if (total === 0) {
    issues.push(
      issue({
        severity: 'error',
        label: 'Empty dataset',
        detail: 'No Observation or DiagnosticReport resources were found in the input.',
        location: source,
        category: 'dataset',
        code: 'EMPTY_DATASET'
      })
    );
    return issues;
  }

  if (observations.length === 0 && reports.length > 0) {
    issues.push(
      issue({
        severity: 'warn',
        label: 'Observations missing',
        detail:
          'Dataset contains DiagnosticReport(s) only. Inline Observation.result targets cannot be validated.',
        location: source,
        category: 'dataset',
        code: 'NO_OBSERVATIONS'
      })
    );
  }

  if (observations.length > 0 && reports.length === 0) {
    issues.push(
      issue({
        severity: 'warn',
        label: 'DiagnosticReport missing',
        detail:
          'Dataset contains Observations without a DiagnosticReport. Panel/report linkage cannot be verified.',
        location: source,
        category: 'dataset',
        code: 'NO_DIAGNOSTIC_REPORT'
      })
    );
  }

  if (total > 5000) {
    issues.push(
      issue({
        severity: 'warn',
        label: 'Large dataset',
        detail: `Dataset contains ${total} resources. Consider batching for interactive review.`,
        location: source,
        category: 'dataset',
        code: 'LARGE_DATASET'
      })
    );
  }

  // Duplicate resource ids across the whole CAD payload
  const seen = new Map<string, string>();
  const pushDup = (type: string, id: string | undefined, location: string) => {
    if (!id) {
      issues.push(
        issue({
          severity: 'warn',
          label: 'Missing resource id',
          detail: `${type} has no id; duplicate detection and stable record keys are limited.`,
          location,
          category: 'dataset',
          code: 'MISSING_RESOURCE_ID',
          field: 'id'
        })
      );
      return;
    }
    const key = `${type}/${id}`;
    if (seen.has(key)) {
      issues.push(
        issue({
          severity: 'error',
          label: 'Duplicate resource id',
          detail: `Duplicate ${key} (also at ${seen.get(key)}).`,
          location,
          category: 'dataset',
          code: 'DUPLICATE_RESOURCE_ID',
          field: 'id',
          rawValue: id
        })
      );
    } else {
      seen.set(key, location);
    }
  };

  observations.forEach((obs, i) => pushDup('Observation', obs.id, `Observation/${obs.id ?? i + 1}`));
  reports.forEach((dr, i) => pushDup('DiagnosticReport', dr.id, `DiagnosticReport/${dr.id ?? i + 1}`));

  return issues;
}
