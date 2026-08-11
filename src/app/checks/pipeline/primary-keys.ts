/**
 * Primary-key uniqueness from validation config entity rules.
 */

import type { CheckIssue } from '../types';
import type { ValidationConfig } from '../config/types';
import { issue } from './helpers';

export function runPrimaryKeyChecks(
  config: ValidationConfig,
  resources: Array<Record<string, unknown>>,
  resourceType: string
): CheckIssue[] {
  const entity = config.entities.find((e) => e.name === resourceType);
  const keys = entity?.primaryKeys?.length ? entity.primaryKeys : ['id'];
  const issues: CheckIssue[] = [];
  const seen = new Map<string, string>();

  resources.forEach((resource, index) => {
    const location = `${resourceType}/${typeof resource['id'] === 'string' ? resource['id'] : index + 1}`;
    const keyParts = keys.map((k) => {
      const v = resource[k];
      return v === undefined || v === null ? '' : String(v);
    });
    if (keyParts.some((p) => !p)) {
      issues.push(
        issue({
          severity: 'warn',
          label: 'Incomplete primary key',
          detail: `Primary key fields [${keys.join(', ')}] are incomplete for ${resourceType}.`,
          location,
          category: 'identifier',
          code: 'INCOMPLETE_PRIMARY_KEY',
          field: keys.join('+')
        })
      );
      return;
    }
    const composite = keyParts.join('|');
    if (seen.has(composite)) {
      issues.push(
        issue({
          severity: 'error',
          label: 'Duplicate primary key',
          detail: `Duplicate primary key (${keys.join('+')}=${composite}); also at ${seen.get(composite)}.`,
          location,
          category: 'identifier',
          code: 'DUPLICATE_PRIMARY_KEY',
          field: keys.join('+'),
          rawValue: composite
        })
      );
    } else {
      seen.set(composite, location);
    }
  });

  return issues;
}
