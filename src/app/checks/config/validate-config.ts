import type { ConfigValidationIssue, ConfigValidationReport, ValidationConfig } from './types';
import { BUILTIN_PLUGIN_IDS } from '../plugins/registry';

/**
 * Validates a validation configuration before it is used for dataset checks.
 * Invalid configs are rejected with a separate configuration validation report.
 */
export function validateValidationConfig(config: unknown): ConfigValidationReport {
  const issues: ConfigValidationIssue[] = [];

  if (!config || typeof config !== 'object') {
    return {
      ok: false,
      issues: [{ severity: 'error', path: '', message: 'Config must be a JSON/YAML/CSV-derived object.' }]
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
      if (entity?.fields) {
        if (!Array.isArray(entity.fields)) {
          issues.push({
            severity: 'error',
            path: `entities[${i}].fields`,
            message: 'fields must be an array.'
          });
        } else {
          entity.fields.forEach((field, fi) => {
            if (!field?.name) {
              issues.push({
                severity: 'error',
                path: `entities[${i}].fields[${fi}].name`,
                message: 'Field name is required.'
              });
            }
            if (field?.regex) {
              try {
                // eslint-disable-next-line no-new
                new RegExp(field.regex);
              } catch {
                issues.push({
                  severity: 'error',
                  path: `entities[${i}].fields[${fi}].regex`,
                  message: `Invalid regex: ${field.regex}`
                });
              }
            }
          });
        }
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
  } else {
    c.plugins.forEach((plugin, i) => {
      if (!BUILTIN_PLUGIN_IDS.has(plugin)) {
        issues.push({
          severity: 'error',
          path: `plugins[${i}]`,
          message: `Unknown plugin "${plugin}". Supported: ${[...BUILTIN_PLUGIN_IDS].join(', ')}.`
        });
      }
    });
  }
  if (c.aliases) {
    if (!Array.isArray(c.aliases)) {
      issues.push({ severity: 'error', path: 'aliases', message: 'aliases must be an array.' });
    } else {
      c.aliases.forEach((alias, i) => {
        if (!alias?.from || !alias?.to) {
          issues.push({
            severity: 'error',
            path: `aliases[${i}]`,
            message: 'Each alias requires "from" and "to".'
          });
        }
      });
    }
  }
  if (c.expectedFiles && !Array.isArray(c.expectedFiles)) {
    issues.push({ severity: 'error', path: 'expectedFiles', message: 'expectedFiles must be an array of strings.' });
  }
  if (c.crossFileReferences) {
    if (!Array.isArray(c.crossFileReferences)) {
      issues.push({
        severity: 'error',
        path: 'crossFileReferences',
        message: 'crossFileReferences must be an array.'
      });
    } else {
      c.crossFileReferences.forEach((ref, i) => {
        if (!ref?.fromEntity || !ref?.fromField || !ref?.toEntity || !ref?.toField) {
          issues.push({
            severity: 'error',
            path: `crossFileReferences[${i}]`,
            message: 'Each cross-file reference requires fromEntity, fromField, toEntity, toField.'
          });
        }
      });
    }
  }

  const errorCount = issues.filter((x) => x.severity === 'error').length;
  return { ok: errorCount === 0, issues };
}
