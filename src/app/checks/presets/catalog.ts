/**
 * Built-in validation presets available in the web UI and on GitHub Pages.
 *
 * Paths are resolved relative to `<base href>` so they work both on
 * `http://localhost:4200/` and `https://…/Data_Curation_Checker/`.
 *
 * - FHIR presets use the in-memory default config (no network required).
 * - SHIELD presets load dictionary JSON from `/configs/…` assets.
 */

export type PresetKind = 'fhir' | 'shield';

export interface DccPreset {
  /** Stable preset id used by the UI select control. */
  id: string;
  /** Short label shown in the dropdown. */
  label: string;
  /** One-line description for operators. */
  description: string;
  kind: PresetKind;
  /**
   * Asset path to the validation config JSON.
   * Omit for the built-in FHIR default (uses DEFAULT_FHIR_LAB_CONFIG).
   */
  configPath?: string;
  /** Optional sample dataset asset path (JSON / multi-CSV package). */
  samplePath?: string;
  /** Suggested run-context defaults when the preset is applied. */
  defaults?: {
    studyId?: string;
    dictionaryRef?: string;
    datasetId?: string;
    sourceSite?: string;
    license?: string;
    provenance?: string;
  };
}

/** Ordered catalog of presets exposed in the website UI. */
export const DCC_PRESETS: DccPreset[] = [
  {
    id: 'fhir-lab-v1',
    label: 'FHIR Laboratory v1 (built-in)',
    description: 'Observation & DiagnosticReport syntactic / laboratory checks.',
    kind: 'fhir',
    samplePath: undefined,
    defaults: {
      datasetId: 'fhir-lab-demo',
      sourceSite: 'local-lab',
      license: 'internal',
      provenance: 'ui-demo'
    }
  },
  {
    id: 'shield-cc-2025-v2',
    label: 'SHIELD-CC-2025 · dictionary V2',
    description: 'Cervical cancer study package — Appendix 10 V2.',
    kind: 'shield',
    configPath: 'configs/shield-cc-2025-v2.json',
    samplePath: 'configs/samples/shield-cc-2025-v2-package.json',
    defaults: {
      studyId: 'SHIELD-CC-2025',
      dictionaryRef: 'Appendix 10 — SHIELD-CC-2025 data dictionary V2',
      datasetId: 'SHIELD-CC-2025-refresh-demo',
      sourceSite: 'local-lab',
      license: 'internal',
      provenance: 'ui-demo'
    }
  },
  {
    id: 'shield-cc-2025-v3',
    label: 'SHIELD-CC-2025 · dictionary V3',
    description: 'Cervical cancer study package — Appendix 10 V3 (+ biospecimen).',
    kind: 'shield',
    configPath: 'configs/shield-cc-2025-v3.json',
    samplePath: 'configs/samples/shield-cc-2025-v3-package.json',
    defaults: {
      studyId: 'SHIELD-CC-2025',
      dictionaryRef: 'Appendix 10 — SHIELD-CC-2025 data dictionary V3',
      datasetId: 'SHIELD-CC-2025-refresh-demo-v3',
      sourceSite: 'local-lab',
      license: 'internal',
      provenance: 'ui-demo'
    }
  },
  {
    id: 'shield-oc-2025-v2',
    label: 'SHIELD-OC-2025 · dictionary V2',
    description: 'Ovarian cancer study package — Appendix 11 V2.',
    kind: 'shield',
    configPath: 'configs/shield-oc-2025-v2.json',
    samplePath: 'configs/samples/shield-oc-2025-v2-package.json',
    defaults: {
      studyId: 'SHIELD-OC-2025',
      dictionaryRef: 'Appendix 11 — SHIELD-OC-2025 data dictionary V2',
      datasetId: 'SHIELD-OC-2025-refresh-demo',
      sourceSite: 'local-lab',
      license: 'internal',
      provenance: 'ui-demo'
    }
  },
  {
    id: 'shield-oc-2025-v3',
    label: 'SHIELD-OC-2025 · dictionary V3',
    description: 'Ovarian cancer study package — Appendix 11 V3 (+ biospecimen).',
    kind: 'shield',
    configPath: 'configs/shield-oc-2025-v3.json',
    samplePath: 'configs/samples/shield-oc-2025-v3-package.json',
    defaults: {
      studyId: 'SHIELD-OC-2025',
      dictionaryRef: 'Appendix 11 — SHIELD-OC-2025 data dictionary V3',
      datasetId: 'SHIELD-OC-2025-refresh-demo-v3',
      sourceSite: 'local-lab',
      license: 'internal',
      provenance: 'ui-demo'
    }
  }
];

export function findPreset(id: string): DccPreset | undefined {
  return DCC_PRESETS.find((p) => p.id === id);
}
