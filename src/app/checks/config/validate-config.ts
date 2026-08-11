import type { ConfigValidationIssue, ConfigValidationReport, ValidationConfig } from './types';

/**
 * Validates a validation configuration before it is used for dataset checks (D1.6).
 * Invalid configs are rejected with a separate configuration validation report.
 */
export function validateValidationConfig(config: unknown): ConfigValidationReport {
  const issues: ConfigValidationIssue[] = [];

  if (!config || typeof config !== 'object') {
    return {
      ok: false,
      issues: [{ severity: 'error', path: '', message: 'Config must be a JSON/YAML object.' }]
    };
  }

  const c = config as Partial<ValidationConfig>;

  if (!c.id || typeof c.id !== 'string') {
    issues.push({ severity: 'error', path: 'id', message: 'Config id is required (string).' });
  }
  if (!c.version || typeof c.version !== 'string') {
    issues.push({ severity: 'error', path: 'version', message: 'Config version is required (string).' });
  }
  if (!c.name || typeof c.name !== 'string') {
    issues.push({ severity: 'error', path: 'name', message: 'Config name is required (string).' });
  }
  if (!Array.isArray(c.formats) || c.formats.length === 0) {
    issues.push({ severity: 'error', path: 'formats', message: 'At least one format is required.' });
  }
  if (!Array.isArray(c.entities) || c.entities.length === 0) {
    issues.push({ severity: 'error', path: 'entities', message: 'At least one entity rule is required.' });
  } else {
    c.entities.forEach((entity, i) => {
      if (!entity?.name) {
        issues.push({ severity: 'error', path: `entities[${i}].name`, message: 'Entity name is required.' });
      }
      if (entity?.requiredFields && !Array.isArray(entity.requiredFields)) {
        issues.push({
          severity: 'error',
          path: `entities[${i}].requiredFields`,
          message: 'requiredFields must be an array of strings.'
        });
      }
    });
  }
  if (!Array.isArray(c.metadataRequirements)) {
    issues.push({
      severity: 'warn',
      path: 'metadataRequirements',
      message: 'metadataRequirements should be an array (may be empty).'
    });
  }
  if (!Array.isArray(c.plugins)) {
    issues.push({ severity: 'warn', path: 'plugins', message: 'plugins should be an array (may be empty).' });
  }

  const errorCount = issues.filter((x) => x.severity === 'error').length;
  return { ok: errorCount === 0, issues };
}
