/**
 * Identifier / reference / LOINC format checks.
 */

import type { CheckIssue } from '../types';
import { issue, resourceLocation } from './helpers';

const LOINC_RE = /^\d{1,5}-\d$/;
const FHIR_ID_RE = /^[A-Za-z0-9\-\.]{1,64}$/;
const REF_RE = /^(https?:\/\/\S+|urn:\S+|[A-Za-z]+\/[A-Za-z0-9\-\.]{1,64})$/;

function codingArray(concept: unknown): Array<{ system?: string; code?: string; display?: string }> {
  if (!concept || typeof concept !== 'object') return [];
  const coding = (concept as { coding?: unknown }).coding;
  return Array.isArray(coding) ? coding : [];
}

export function runIdentifierFormatChecks(
  resources: Array<Record<string, unknown>>,
  resourceType: string
): CheckIssue[] {
  const issues: CheckIssue[] = [];

  resources.forEach((resource, index) => {
    const id = typeof resource['id'] === 'string' ? resource['id'] : undefined;
    const location = resourceLocation(resource, resourceType, index);

    if (id && !FHIR_ID_RE.test(id)) {
      issues.push(
        issue({
          severity: 'error',
          label: 'Invalid resource id format',
          detail: `id="${id}" does not match FHIR id pattern.`,
          location,
          category: 'identifier',
          code: 'INVALID_ID_FORMAT',
          field: 'id',
          rawValue: id
        })
      );
    }

    codingArray(resource['code']).forEach((coding, ci) => {
      if (coding.system === 'http://loinc.org' && coding.code && !LOINC_RE.test(coding.code)) {
        issues.push(
          issue({
            severity: 'error',
            label: 'Invalid LOINC code format',
            detail: `LOINC code="${coding.code}" should match NNNNN-N.`,
            location: `${location} · code.coding[${ci}]`,
            category: 'identifier',
            code: 'INVALID_LOINC_FORMAT',
            field: 'code',
            rawValue: coding.code
          })
        );
      }
      if (coding.system === 'http://loinc.org' && coding.code && !coding.display) {
        issues.push(
          issue({
            severity: 'warn',
            label: 'LOINC display missing',
            detail: 'LOINC coding should include display text.',
            location: `${location} · code.coding[${ci}]`,
            category: 'identifier',
            code: 'LOINC_DISPLAY_MISSING',
            field: 'code.display',
            rawValue: coding.code
          })
        );
      }
    });

    const refFields: Array<{ field: string; value: unknown }> = [
      { field: 'subject', value: (resource['subject'] as { reference?: string } | undefined)?.reference },
      { field: 'specimen', value: (resource['specimen'] as { reference?: string } | undefined)?.reference },
      { field: 'device', value: (resource['device'] as { reference?: string } | undefined)?.reference }
    ];

    const performers = Array.isArray(resource['performer']) ? resource['performer'] : [];
    performers.forEach((p: any, pi: number) => {
      refFields.push({ field: `performer[${pi}]`, value: p?.reference });
    });

    refFields.forEach(({ field, value }) => {
      if (value === undefined || value === null || value === '') return;
      if (typeof value !== 'string' || !REF_RE.test(value)) {
        issues.push(
          issue({
            severity: 'error',
            label: 'Invalid reference format',
            detail: `${field} reference "${String(value)}" is not a valid FHIR reference string.`,
            location,
            category: 'identifier',
            code: 'INVALID_REFERENCE_FORMAT',
            field,
            rawValue: String(value)
          })
        );
      }
    });
  });

  return issues;
}
