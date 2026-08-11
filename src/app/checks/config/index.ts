import { hashConfig } from './hash';
import { validateValidationConfig } from './validate-config';
import { DEFAULT_FHIR_LAB_CONFIG } from './default-config';
import type {
  DatasetRunContext,
  EffectiveConfigRef,
  ValidationConfig
} from './types';

export * from './types';
export { DEFAULT_FHIR_LAB_CONFIG } from './default-config';
export { hashConfig } from './hash';
export { validateValidationConfig } from './validate-config';
export {
  applyConfigEntityRules,
  applyMetadataRequirements,
  applyExpectedFilesCheck
} from './apply-config-rules';

export function resolveEffectiveConfig(config?: ValidationConfig): EffectiveConfigRef {
  const snapshot = config ?? DEFAULT_FHIR_LAB_CONFIG;
  const report = validateValidationConfig(snapshot);
  if (!report.ok) {
    const detail = report.issues.map((i) => `${i.path}: ${i.message}`).join('; ');
    throw new Error(`Invalid validation configuration: ${detail}`);
  }
  return {
    id: snapshot.id,
    version: snapshot.version,
    hash: hashConfig(snapshot),
    snapshot
  };
}

export function defaultRunContext(partial?: Partial<DatasetRunContext>): DatasetRunContext {
  return {
    datasetId: partial?.datasetId ?? 'local-dataset',
    sourceSite: partial?.sourceSite ?? 'local',
    timeframe: partial?.timeframe,
    mode: partial?.mode ?? 'interactive',
    inputFiles: partial?.inputFiles ?? [],
    license: partial?.license,
    provenance: partial?.provenance,
    schemaVersion: partial?.schemaVersion
  };
}
