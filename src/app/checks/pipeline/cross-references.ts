/**
 * Cross-resource reference checks (Observation ↔ DiagnosticReport and internal refs).
 */

import type { DiagnosticReport, Observation } from '../../models/fhir.types';
import type { CheckIssue } from '../types';
import { issue } from './helpers';

function refId(reference?: string): string | null {
  if (!reference || typeof reference !== 'string') return null;
  if (reference.startsWith('http://') || reference.startsWith('https://') || reference.startsWith('urn:')) {
    return null; // external — not resolved here
  }
  const parts = reference.split('/');
  return parts.length >= 2 ? parts[parts.length - 1] : reference;
}

function refType(reference?: string): string | null {
  if (!reference || typeof reference !== 'string') return null;
  if (reference.startsWith('http') || reference.startsWith('urn:')) return null;
  const parts = reference.split('/');
  return parts.length >= 2 ? parts[0] : null;
}

export function runCrossReferenceChecks(
  observations: Observation[],
  reports: DiagnosticReport[]
): CheckIssue[] {
  const issues: CheckIssue[] = [];
  const obsIds = new Set(observations.map((o) => o.id).filter(Boolean) as string[]);

  reports.forEach((dr, index) => {
    const location = `DiagnosticReport/${dr.id ?? index + 1}`;
    const results = Array.isArray(dr.result) ? dr.result : [];
    if (!results.length) {
      issues.push(
        issue({
          severity: 'warn',
          label: 'DiagnosticReport without result',
          detail: 'DiagnosticReport.result is empty; no Observation links to verify.',
          location,
          category: 'reference',
          code: 'DR_NO_RESULT',
          field: 'result'
        })
      );
      return;
    }

    results.forEach((ref, ri) => {
      const reference = ref?.reference;
      const type = refType(reference ?? undefined);
      const id = refId(reference ?? undefined);
      if (!reference) {
        issues.push(
          issue({
            severity: 'error',
            label: 'Empty result reference',
            detail: `DiagnosticReport.result[${ri}] has no reference.`,
            location: `${location} · result[${ri}]`,
            category: 'reference',
            code: 'EMPTY_RESULT_REF',
            field: 'result'
          })
        );
        return;
      }
      if (type && type !== 'Observation') {
        issues.push(
          issue({
            severity: 'warn',
            label: 'Unexpected result target',
            detail: `result[${ri}] references ${type}, expected Observation.`,
            location: `${location} · result[${ri}]`,
            category: 'reference',
            code: 'RESULT_NOT_OBSERVATION',
            field: 'result',
            rawValue: reference
          })
        );
      }
      if (id && obsIds.size && !obsIds.has(id) && type === 'Observation') {
        issues.push(
          issue({
            severity: 'error',
            label: 'Broken result reference',
            detail: `DiagnosticReport.result references Observation/${id}, which is not in this dataset.`,
            location: `${location} · result[${ri}]`,
            category: 'reference',
            code: 'BROKEN_RESULT_REF',
            field: 'result',
            rawValue: reference
          })
        );
      }
    });
  });

  observations.forEach((obs, index) => {
    const location = `Observation/${obs.id ?? index + 1}`;

    const members = Array.isArray((obs as { hasMember?: Array<{ reference?: string }> }).hasMember)
      ? ((obs as { hasMember: Array<{ reference?: string }> }).hasMember)
      : [];
    members.forEach((m, mi) => {
      const id = refId(m.reference);
      const type = refType(m.reference);
      if (id && type === 'Observation' && obsIds.size && !obsIds.has(id)) {
        issues.push(
          issue({
            severity: 'error',
            label: 'Broken hasMember reference',
            detail: `hasMember references Observation/${id}, which is not in this dataset.`,
            location: `${location} · hasMember[${mi}]`,
            category: 'reference',
            code: 'BROKEN_HASMEMBER',
            field: 'hasMember',
            rawValue: m.reference
          })
        );
      }
    });

    // subject consistency across resources (same patient id when present)
    // collected later
  });

  // Subject consistency: if multiple subjects, warn
  const subjects = new Set<string>();
  [...observations, ...reports].forEach((r) => {
    const sub = (r as { subject?: { reference?: string } }).subject?.reference;
    if (sub) subjects.add(sub);
  });
  if (subjects.size > 3) {
    issues.push(
      issue({
        severity: 'warn',
        label: 'Many distinct subjects',
        detail: `Dataset references ${subjects.size} distinct subject values. Confirm this is intentional for a single CAD package.`,
        location: 'Dataset',
        category: 'reference',
        code: 'MANY_SUBJECTS'
      })
    );
  }

  // Orphan observations not referenced by any DiagnosticReport.result
  if (reports.length && observations.length) {
    const referenced = new Set<string>();
    reports.forEach((dr) => {
      (dr.result ?? []).forEach((ref) => {
        const id = refId(ref.reference);
        if (id) referenced.add(id);
      });
    });
    observations.forEach((obs, index) => {
      if (obs.id && !referenced.has(obs.id) && !(obs as { hasMember?: unknown[] }).hasMember) {
        issues.push(
          issue({
            severity: 'warn',
            label: 'Orphan observation',
            detail: `Observation/${obs.id} is not referenced by any DiagnosticReport.result in this dataset.`,
            location: `Observation/${obs.id ?? index + 1}`,
            category: 'reference',
            code: 'ORPHAN_OBSERVATION'
          })
        );
      }
    });
  }

  return issues;
}
