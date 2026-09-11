/** Built-in syntactic validator plugins / check suites. */

export interface BuiltinPlugin {
  id: string;
  description: string;
  category:
    | 'ingest'
    | 'dataset'
    | 'structure'
    | 'laboratory'
    | 'reference'
    | 'config'
    | 'metadata'
    | 'vocabulary'
    | 'completeness'
    | 'datetime'
    | 'identifier'
    | 'reproducibility'
    | 'policy';
  /** Always executed unless skipCoreSuites is set. */
  core?: boolean;
}

export const BUILTIN_PLUGINS: BuiltinPlugin[] = [
  {
    id: 'ingest',
    description: 'Parse input, detect format, reject empty/corrupt payloads',
    category: 'ingest',
    core: true
  },
  {
    id: 'dataset-integrity',
    description: 'Dataset-level integrity: emptiness, duplicate IDs, resource mix',
    category: 'dataset',
    core: true
  },
  {
    id: 'fhir-observation',
    description: 'FHIR Observation structural checks',
    category: 'structure'
  },
  {
    id: 'fhir-diagnostic-report',
    description: 'FHIR DiagnosticReport structural checks',
    category: 'structure'
  },
  {
    id: 'laboratory-loinc',
    description: 'LOINC / UCUM / reference-range / lab workflow checks',
    category: 'laboratory'
  },
  {
    id: 'cross-references',
    description: 'Cross-resource references (result, hasMember, basedOn, specimen)',
    category: 'reference'
  },
  {
    id: 'primary-keys',
    description: 'Primary-key uniqueness within configured entities',
    category: 'identifier'
  },
  {
    id: 'datetime-formats',
    description: 'Date/time format and chronological consistency',
    category: 'datetime'
  },
  {
    id: 'vocabulary',
    description: 'Controlled vocabularies for status, category, interpretation',
    category: 'vocabulary'
  },
  {
    id: 'completeness',
    description: 'Recommended-field completeness for laboratory CAD datasets',
    category: 'completeness'
  },
  {
    id: 'identifier-format',
    description: 'Resource id / LOINC / reference string format checks',
    category: 'identifier'
  },
  {
    id: 'config-entity-rules',
    description: 'Config-driven required fields, allowable values, regex, aliases',
    category: 'config'
  },
  {
    id: 'metadata-requirements',
    description: 'Dataset/run metadata completeness checks',
    category: 'metadata'
  },
  {
    id: 'expected-files',
    description: 'Expected input file set vs provided files',
    category: 'dataset'
  },
  {
    id: 'tabular-dictionary',
    description: 'Dictionary-driven tabular/CSV validation (study datasets)',
    category: 'structure'
  },
  {
    id: 'reproducibility',
    description: 'Config hash, tool version, deterministic run metadata',
    category: 'reproducibility'
  }
];

export const BUILTIN_PLUGIN_IDS = new Set(BUILTIN_PLUGINS.map((p) => p.id));

/** Suites enabled by default for FHIR / CSV-imported configs (non-core). */
export const DEFAULT_OPTIONAL_PLUGIN_IDS = [
  'fhir-observation',
  'fhir-diagnostic-report',
  'laboratory-loinc',
  'cross-references',
  'primary-keys',
  'datetime-formats',
  'vocabulary',
  'completeness',
  'identifier-format',
  'config-entity-rules',
  'metadata-requirements',
  'expected-files',
  'reproducibility'
] as const;

export function isCorePlugin(id: string): boolean {
  return BUILTIN_PLUGINS.some((p) => p.id === id && p.core);
}
