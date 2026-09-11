/**
 * Controlled vocabulary checks (status, category, interpretation).
 */

import type { CheckIssue } from '../types';
import { issue, resourceLocation } from './helpers';

const OBS_STATUS = new Set([
  'registered',
  'specimen-in-process',
  'preliminary',
  'final',
  'amended',
  'corrected',
  'appended',
  'cancelled',
  'entered-in-error',
  'unknown',
  'cannot-be-obtained'
]);

const DR_STATUS = new Set([
  'registered',
  'partial',
  'preliminary',
  'modified',
  'final',
  'amended',
  'corrected',
  'appended',
  'cancelled',
  'entered-in-error',
  'unknown'
]);

const OBS_CATEGORY = new Set([
  'social-history',
  'vital-signs',
  'imaging',
  'laboratory',
  'procedure',
  'survey',
  'exam',
  'therapy',
  'activity'
]);

const INTERPRETATION = new Set([
  'A',
  'AA',
  'HH',
  'LL',
  'H',
  'HU',
  'L',
  'LU',
  'N',
  'R',
  'U',
  'D',
  'B',
  'W',
  'IND',
  'E',
  'EXP',
  'S',
  'MS',
  'VS',
  'POS',
  'NEG'
]);

export function runVocabularyChecks(
  resources: Array<Record<string, unknown>>,
  resourceType: 'Observation' | 'DiagnosticReport'
): CheckIssue[] {
  const issues: CheckIssue[] = [];
  const statusSet = resourceType === 'Observation' ? OBS_STATUS : DR_STATUS;

  resources.forEach((resource, index) => {
    const location = resourceLocation(resource, resourceType, index);
    const status = resource['status'];

    if (typeof status === 'string' && !statusSet.has(status)) {
      issues.push(
        issue({
          severity: 'error',
          label: 'Invalid status value',
          detail: `${resourceType}.status="${status}" is outside the allowed value set.`,
          location,
          category: 'vocabulary',
          code: 'INVALID_STATUS',
          field: 'status',
          rawValue: status
        })
      );
    }

    const categories = Array.isArray(resource['category']) ? resource['category'] : [];
    categories.forEach((cat: any, ci: number) => {
      const codings = Array.isArray(cat?.coding) ? cat.coding : [];
      codings.forEach((coding: any, ki: number) => {
        if (resourceType === 'Observation' && coding?.code && !OBS_CATEGORY.has(String(coding.code))) {
          issues.push(
            issue({
              severity: 'warn',
              label: 'Non-standard category code',
              detail: `category coding code="${coding.code}" is not in the Observation category value set.`,
              location: `${location} · category[${ci}].coding[${ki}]`,
              category: 'vocabulary',
              code: 'CATEGORY_CODE',
              field: 'category',
              rawValue: String(coding.code)
            })
          );
        }
        if (coding?.system && typeof coding.system === 'string' && !/^https?:\/\//.test(coding.system)) {
          issues.push(
            issue({
              severity: 'warn',
              label: 'Category system not a URL',
              detail: `coding.system should be an absolute URI.`,
              location: `${location} · category[${ci}].coding[${ki}]`,
              category: 'vocabulary',
              code: 'CATEGORY_SYSTEM',
              field: 'category.system',
              rawValue: coding.system
            })
          );
        }
      });
    });

    if (resourceType === 'Observation') {
      const interpretations = Array.isArray(resource['interpretation']) ? resource['interpretation'] : [];
      interpretations.forEach((interp: any, ii: number) => {
        const codings = Array.isArray(interp?.coding) ? interp.coding : [];
        codings.forEach((coding: any, ki: number) => {
          if (coding?.code && !INTERPRETATION.has(String(coding.code))) {
            issues.push(
              issue({
                severity: 'warn',
                label: 'Non-standard interpretation',
                detail: `interpretation code="${coding.code}" is not in the common ObservationInterpretation set.`,
                location: `${location} · interpretation[${ii}].coding[${ki}]`,
                category: 'vocabulary',
                code: 'INTERPRETATION_CODE',
                field: 'interpretation',
                rawValue: String(coding.code)
              })
            );
          }
        });
      });
    }
  });

  return issues;
}
