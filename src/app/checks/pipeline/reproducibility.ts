/**
 * Reproducibility / auditability checks for a DCC run.
 */

import type { CheckIssue } from '../types';
import type { DatasetRunContext, EffectiveConfigRef } from '../config/types';
import { issue } from './helpers';

export function runReproducibilityChecks(input: {
  config: EffectiveConfigRef;
  runContext: DatasetRunContext;
  toolVersion: string;
}): CheckIssue[] {
  const issues: CheckIssue[] = [];
  const { config, runContext, toolVersion } = input;

  if (!config.hash) {
    issues.push(
      issue({
        severity: 'error',
        label: 'Missing config hash',
        detail: 'Effective configuration hash is required for reproducible validation.',
        location: 'Config',
        category: 'reproducibility',
        code: 'MISSING_CONFIG_HASH'
      })
    );
  }

  if (!config.version) {
    issues.push(
      issue({
        severity: 'error',
        label: 'Missing config version',
        detail: 'Configuration version must be present on each run.',
        location: 'Config',
        category: 'reproducibility',
        code: 'MISSING_CONFIG_VERSION'
      })
    );
  }

  if (!toolVersion) {
    issues.push(
      issue({
        severity: 'error',
        label: 'Missing tool version',
        detail: 'Tool version must be recorded for auditability.',
        location: 'System',
        category: 'reproducibility',
        code: 'MISSING_TOOL_VERSION'
      })
    );
  }

  if (!runContext.mode) {
    issues.push(
      issue({
        severity: 'warn',
        label: 'Missing run mode',
        detail: 'Run mode (local|batch|interactive) should be set for audit trails.',
        location: 'RunContext',
        category: 'reproducibility',
        code: 'MISSING_MODE',
        field: 'mode'
      })
    );
  }

  if (runContext.mode === 'batch' && !(runContext.inputFiles?.length > 0)) {
    issues.push(
      issue({
        severity: 'warn',
        label: 'Batch run without input file list',
        detail: 'Batch mode should record inputFiles for reproducibility.',
        location: 'RunContext',
        category: 'reproducibility',
        code: 'BATCH_WITHOUT_FILES',
        field: 'inputFiles'
      })
    );
  }

  if (runContext.schemaVersion && runContext.schemaVersion !== config.version) {
    issues.push(
      issue({
        severity: 'warn',
        label: 'Schema version mismatch',
        detail: `RunContext.schemaVersion=${runContext.schemaVersion} differs from config.version=${config.version}.`,
        location: 'RunContext',
        category: 'reproducibility',
        code: 'SCHEMA_VERSION_MISMATCH',
        field: 'schemaVersion',
        rawValue: runContext.schemaVersion
      })
    );
  }

  return issues;
}
