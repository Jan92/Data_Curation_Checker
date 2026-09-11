import type { ValidationConfig } from './types';
import { DEFAULT_OPTIONAL_PLUGIN_IDS } from '../plugins/registry';

/** Default FHIR lab validation config (demonstrator scope). */
export const DEFAULT_FHIR_LAB_CONFIG: ValidationConfig = {
  id: 'fhir-lab-v1',
  version: '1.0.0',
  name: 'FHIR Laboratory Observation & DiagnosticReport',
  description:
    'Syntactic and structural validation for FHIR R4 Observation and DiagnosticReport resources in laboratory medicine.',
  formats: ['json', 'ndjson', 'fhir-bundle', 'fhir-array', 'fhir-resource'],
  entities: [
    {
      name: 'Observation',
      description: 'FHIR R4 Observation (laboratory)',
      requiredFields: ['resourceType', 'status', 'code'],
      optionalFields: [
        'subject',
        'effectiveDateTime',
        'issued',
        'performer',
        'valueQuantity',
        'referenceRange',
        'specimen',
        'category'
      ],
      fields: [
        {
          name: 'status',
          required: true,
          allowableValues: [
            'registered',
            'preliminary',
            'final',
            'amended',
            'corrected',
            'cancelled',
            'entered-in-error',
            'unknown'
          ],
          severity: 'error'
        },
        { name: 'code', required: true, severity: 'error' },
        { name: 'performer', required: false, severity: 'warn' }
      ],
      primaryKeys: ['id']
    },
    {
      name: 'DiagnosticReport',
      description: 'FHIR R4/R5 DiagnosticReport',
      requiredFields: ['resourceType', 'status', 'code'],
      optionalFields: [
        'category',
        'subject',
        'effectiveDateTime',
        'issued',
        'performer',
        'result',
        'specimen'
      ],
      fields: [
        {
          name: 'status',
          required: true,
          allowableValues: [
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
          ],
          severity: 'error'
        },
        { name: 'code', required: true, severity: 'error' },
        { name: 'category', required: false, severity: 'warn' },
        { name: 'performer', required: false, severity: 'warn' },
        { name: 'result', required: false, severity: 'warn' }
      ],
      primaryKeys: ['id']
    }
  ],
  metadataRequirements: [
    'datasetId',
    'sourceSite',
    'schemaVersion',
    'toolVersion',
    'license',
    'provenance'
  ],
  plugins: [...DEFAULT_OPTIONAL_PLUGIN_IDS],
  aliases: [
    { from: 'codeableConcept', to: 'code', severity: 'warn' },
    { from: 'effective', to: 'effectiveDateTime', severity: 'info' }
  ],
  failOnError: true,
  failOnWarn: false
};
