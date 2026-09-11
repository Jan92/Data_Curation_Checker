/**
 * Date/time format and chronological consistency checks.
 */

import type { CheckIssue } from '../types';
import { issue, resourceLocation } from './helpers';

const ISO_DATE =
  /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?)?$/;

function checkInstant(
  value: unknown,
  field: string,
  location: string,
  issues: CheckIssue[]
): Date | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') {
    issues.push(
      issue({
        severity: 'error',
        label: 'Invalid date type',
        detail: `${field} must be a string date/time.`,
        location,
        category: 'datetime',
        code: 'DATETIME_TYPE',
        field,
        rawValue: String(value)
      })
    );
    return null;
  }
  if (!ISO_DATE.test(value)) {
    issues.push(
      issue({
        severity: 'error',
        label: 'Invalid date format',
        detail: `${field}="${value}" is not a valid FHIR dateTime/instant.`,
        location,
        category: 'datetime',
        code: 'DATETIME_FORMAT',
        field,
        rawValue: value
      })
    );
    return null;
  }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    issues.push(
      issue({
        severity: 'error',
        label: 'Unparseable date',
        detail: `${field}="${value}" could not be parsed.`,
        location,
        category: 'datetime',
        code: 'DATETIME_UNPARSEABLE',
        field,
        rawValue: value
      })
    );
    return null;
  }
  if (d.getTime() > Date.now() + 24 * 60 * 60 * 1000) {
    issues.push(
      issue({
        severity: 'warn',
        label: 'Future date',
        detail: `${field} is more than 1 day in the future.`,
        location,
        category: 'datetime',
        code: 'DATETIME_FUTURE',
        field,
        rawValue: value
      })
    );
  }
  if (d.getUTCFullYear() < 1900) {
    issues.push(
      issue({
        severity: 'warn',
        label: 'Implausible historical date',
        detail: `${field} year ${d.getUTCFullYear()} looks implausible for lab CAD data.`,
        location,
        category: 'datetime',
        code: 'DATETIME_HISTORICAL',
        field,
        rawValue: value
      })
    );
  }
  return d;
}

export function runDateTimeChecks(resources: Array<Record<string, unknown>>, resourceType: string): CheckIssue[] {
  const issues: CheckIssue[] = [];

  resources.forEach((resource, index) => {
    const location = resourceLocation(resource, resourceType, index);

    const effective = checkInstant(resource['effectiveDateTime'], 'effectiveDateTime', location, issues);
    const issued = checkInstant(resource['issued'], 'issued', location, issues);

    const period = resource['effectivePeriod'] as { start?: string; end?: string } | undefined;
    if (period) {
      const start = checkInstant(period.start, 'effectivePeriod.start', location, issues);
      const end = checkInstant(period.end, 'effectivePeriod.end', location, issues);
      if (start && end && end.getTime() < start.getTime()) {
        issues.push(
          issue({
            severity: 'error',
            label: 'Period end before start',
            detail: 'effectivePeriod.end is earlier than effectivePeriod.start.',
            location,
            category: 'datetime',
            code: 'PERIOD_ORDER',
            field: 'effectivePeriod'
          })
        );
      }
    }

    if (effective && issued && issued.getTime() < effective.getTime() - 60_000) {
      issues.push(
        issue({
          severity: 'warn',
          label: 'Issued before effective',
          detail: 'issued is earlier than effectiveDateTime by more than 1 minute.',
          location,
          category: 'datetime',
          code: 'ISSUED_BEFORE_EFFECTIVE',
          field: 'issued'
        })
      );
    }
  });

  return issues;
}
