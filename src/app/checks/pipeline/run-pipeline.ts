/**
 * Orchestrates differentiated DCC check suites for `runDataCurationCheck` (FHIR path).
 *
 * Suites are enabled from the validation config's `plugins` list plus a set of
 * core defaults. Each suite returns issues that are later aggregated into the
 * quality-gate report (PASS/FAIL) by `buildDccRunReport`.
 *
 * Tabular / SHIELD dictionary validation does not use this FHIR pipeline —
 * see `pipeline/tabular-dictionary.ts` instead.
 */

import type { Observation, DiagnosticReport } from '../../models/fhir.types';
import type {
  CheckIssue,
  CheckResult,
  CheckSuiteResult,
  ParseResult,
  ValidateOptions,
  ValidationReport
} from '../types';
import type { DatasetRunContext, EffectiveConfigRef, ValidationConfig } from '../config/types';
import {
  applyConfigEntityRules,
  applyExpectedFilesCheck,
  applyMetadataRequirements
} from '../config/apply-config-rules';
import { BUILTIN_PLUGINS, isCorePlugin } from '../plugins/registry';
import { TOOL_VERSION } from '../report/build-report';
import { classifyBaseIssue, summarizeSuite, suiteToCheckResult, issue } from './helpers';
import { runDatasetIntegrityChecks } from './dataset-integrity';
import { runCrossReferenceChecks } from './cross-references';
import { runPrimaryKeyChecks } from './primary-keys';
import { runDateTimeChecks } from './datetime-formats';
import { runVocabularyChecks } from './vocabulary';
import { runCompletenessChecks } from './completeness';
import { runIdentifierFormatChecks } from './identifier-format';
import { runReproducibilityChecks } from './reproducibility';

export interface PipelineInput {
  base: ValidationReport;
  config: EffectiveConfigRef;
  runContext: DatasetRunContext;
  options?: ValidateOptions;
  source: string;
  sourceDetail?: string;
}

function enabledSuites(config: ValidationConfig, options?: ValidateOptions): Set<string> {
  if (options?.suites?.length) {
    return new Set(options.suites);
  }
  const fromConfig = new Set(config.plugins ?? []);
  // Always include core suites unless explicitly skipped
  BUILTIN_PLUGINS.filter((p) => p.core).forEach((p) => fromConfig.add(p.id));
  // Ensure new differentiated suites run when using older configs that only list the original 3–5 plugins
  const defaults = [
    'cross-references',
    'primary-keys',
    'datetime-formats',
    'vocabulary',
    'completeness',
    'identifier-format',
    'reproducibility',
    'expected-files',
    'config-entity-rules',
    'metadata-requirements',
    'fhir-observation',
    'fhir-diagnostic-report',
    'laboratory-loinc'
  ];
  defaults.forEach((id) => {
    if (!options?.suites) fromConfig.add(id);
  });
  return fromConfig;
}

function isEnabled(id: string, enabled: Set<string>, options?: ValidateOptions): boolean {
  if (options?.skipCoreSuites && isCorePlugin(id)) return false;
  if (isCorePlugin(id) && !options?.skipCoreSuites) return true;
  return enabled.has(id);
}

function partitionBaseIssues(baseIssues: CheckIssue[]): Record<string, CheckIssue[]> {
  const buckets: Record<string, CheckIssue[]> = {
    'fhir-observation': [],
    'fhir-diagnostic-report': [],
    'laboratory-loinc': [],
    'cross-references': [],
    'datetime-formats': [],
    vocabulary: [],
    other: []
  };
  for (const raw of baseIssues) {
    const { suiteId, category } = classifyBaseIssue(raw);
    const tagged = { ...raw, suiteId, category, code: raw.code ?? raw.label.replace(/\s+/g, '_').toUpperCase() };
    if (!buckets[suiteId]) buckets[suiteId] = [];
    buckets[suiteId].push(tagged);
  }
  return buckets;
}

export function runCheckPipeline(input: PipelineInput): {
  suites: CheckSuiteResult[];
  issues: CheckIssue[];
  checkResults: CheckResult[];
} {
  const { base, config, runContext, options, source, sourceDetail } = input;
  const enabled = enabledSuites(config.snapshot, options);
  const observations = (base.parseResult.resources ?? []) as Observation[];
  const reports = (base.parseResult.diagnosticReports ?? []) as DiagnosticReport[];
  const obsRecords = observations as unknown as Array<Record<string, unknown>>;
  const drRecords = reports as unknown as Array<Record<string, unknown>>;
  const buckets = partitionBaseIssues(base.issues ?? []);

  const suites: CheckSuiteResult[] = [];

  // 1) Ingest
  {
    const on = isEnabled('ingest', enabled, options);
    const issues: CheckIssue[] = [];
    if (on) {
      if (!base.parseResult.ok) {
        issues.push(
          issue({
            severity: 'error',
            label: 'Parse failed',
            detail: base.parseResult.error ?? 'Unable to parse input.',
            location: source,
            category: 'ingest',
            code: 'PARSE_FAILED'
          })
        );
      } else {
        issues.push(
          issue({
            severity: 'ok',
            label: 'Input parsed',
            detail: `Detected ${base.parseResult.type}${sourceDetail ? ` from ${sourceDetail}` : ''}.`,
            location: source,
            category: 'ingest',
            code: 'PARSE_OK'
          })
        );
      }
      // Drop ok-severity from gate-affecting issues — keep only as suite signal
    }
    const gateIssues = issues.filter((i) => i.severity !== 'ok');
    const suite = summarizeSuite({
      id: 'ingest',
      label: 'Ingest & parse',
      description: 'Parse input and detect format (JSON / Bundle / NDJSON).',
      category: 'ingest',
      enabled: on,
      issues: gateIssues
    });
    if (on && base.parseResult.ok && gateIssues.length === 0) {
      suite.detail = `OK — ${base.parseResult.type}`;
      suite.status = 'ok';
      suite.statusLabel = 'OK';
    }
    suites.push(suite);
  }

  // 2) Dataset integrity
  suites.push(
    summarizeSuite({
      id: 'dataset-integrity',
      label: 'Dataset integrity',
      description: 'Emptiness, duplicate IDs, resource mix, size.',
      category: 'dataset',
      enabled: isEnabled('dataset-integrity', enabled, options),
      issues: base.parseResult.ok
        ? runDatasetIntegrityChecks(base.parseResult, source)
        : []
    })
  );

  // 3–5) Base FHIR / lab partitions
  suites.push(
    summarizeSuite({
      id: 'fhir-observation',
      label: 'FHIR Observation structure',
      description: 'Required Observation fields and structural constraints.',
      category: 'structure',
      enabled: isEnabled('fhir-observation', enabled, options),
      issues: buckets['fhir-observation'] ?? []
    })
  );
  suites.push(
    summarizeSuite({
      id: 'fhir-diagnostic-report',
      label: 'FHIR DiagnosticReport structure',
      description: 'Required DiagnosticReport fields and structural constraints.',
      category: 'structure',
      enabled: isEnabled('fhir-diagnostic-report', enabled, options),
      issues: buckets['fhir-diagnostic-report'] ?? []
    })
  );
  suites.push(
    summarizeSuite({
      id: 'laboratory-loinc',
      label: 'Laboratory / LOINC',
      description: 'LOINC, UCUM, ranges, critical values, lab workflow.',
      category: 'laboratory',
      enabled: isEnabled('laboratory-loinc', enabled, options),
      issues: buckets['laboratory-loinc'] ?? []
    })
  );

  // 6) Cross-references (new + partitioned)
  suites.push(
    summarizeSuite({
      id: 'cross-references',
      label: 'Cross-resource references',
      description: 'result / hasMember / orphan Observation linkage.',
      category: 'reference',
      enabled: isEnabled('cross-references', enabled, options),
      issues: base.parseResult.ok
        ? [...(buckets['cross-references'] ?? []), ...runCrossReferenceChecks(observations, reports)]
        : []
    })
  );

  // 7) Primary keys
  suites.push(
    summarizeSuite({
      id: 'primary-keys',
      label: 'Primary keys',
      description: 'Configured primary-key uniqueness per entity.',
      category: 'identifier',
      enabled: isEnabled('primary-keys', enabled, options),
      issues: base.parseResult.ok
        ? [
            ...runPrimaryKeyChecks(config.snapshot, obsRecords, 'Observation'),
            ...runPrimaryKeyChecks(config.snapshot, drRecords, 'DiagnosticReport')
          ]
        : []
    })
  );

  // 8) Date/time
  suites.push(
    summarizeSuite({
      id: 'datetime-formats',
      label: 'Date / time formats',
      description: 'FHIR dateTime formats and chronological consistency.',
      category: 'datetime',
      enabled: isEnabled('datetime-formats', enabled, options),
      issues: base.parseResult.ok
        ? [
            ...(buckets['datetime-formats'] ?? []),
            ...runDateTimeChecks(obsRecords, 'Observation'),
            ...runDateTimeChecks(drRecords, 'DiagnosticReport')
          ]
        : []
    })
  );

  // 9) Vocabulary
  suites.push(
    summarizeSuite({
      id: 'vocabulary',
      label: 'Controlled vocabularies',
      description: 'Status, category, interpretation value sets.',
      category: 'vocabulary',
      enabled: isEnabled('vocabulary', enabled, options),
      issues: base.parseResult.ok
        ? [
            ...(buckets['vocabulary'] ?? []),
            ...runVocabularyChecks(obsRecords, 'Observation'),
            ...runVocabularyChecks(drRecords, 'DiagnosticReport')
          ]
        : []
    })
  );

  // 10) Completeness
  suites.push(
    summarizeSuite({
      id: 'completeness',
      label: 'Completeness',
      description: 'Recommended fields and value/dataAbsentReason coverage.',
      category: 'completeness',
      enabled: isEnabled('completeness', enabled, options),
      issues: base.parseResult.ok
        ? [
            ...runCompletenessChecks(obsRecords, 'Observation'),
            ...runCompletenessChecks(drRecords, 'DiagnosticReport')
          ]
        : []
    })
  );

  // 11) Identifier formats
  suites.push(
    summarizeSuite({
      id: 'identifier-format',
      label: 'Identifier formats',
      description: 'Resource id, LOINC, and reference string formats.',
      category: 'identifier',
      enabled: isEnabled('identifier-format', enabled, options),
      issues: base.parseResult.ok
        ? [
            ...runIdentifierFormatChecks(obsRecords, 'Observation'),
            ...runIdentifierFormatChecks(drRecords, 'DiagnosticReport')
          ]
        : []
    })
  );

  // 12) Config entity rules
  suites.push(
    summarizeSuite({
      id: 'config-entity-rules',
      label: 'Config entity rules',
      description: 'Required fields, allowable values, regex, aliases from config.',
      category: 'config',
      enabled: isEnabled('config-entity-rules', enabled, options),
      issues: base.parseResult.ok
        ? [
            ...applyConfigEntityRules(config.snapshot, obsRecords, 'Observation'),
            ...applyConfigEntityRules(config.snapshot, drRecords, 'DiagnosticReport')
          ]
        : []
    })
  );

  // 13) Metadata
  suites.push(
    summarizeSuite({
      id: 'metadata-requirements',
      label: 'Run metadata',
      description: 'datasetId, source/site, license, provenance, schema/tool version.',
      category: 'metadata',
      enabled: isEnabled('metadata-requirements', enabled, options),
      issues: applyMetadataRequirements(config.snapshot, runContext)
    })
  );

  // 14) Expected files
  suites.push(
    summarizeSuite({
      id: 'expected-files',
      label: 'Expected files',
      description: 'Configured expectedFiles vs provided input file list.',
      category: 'dataset',
      enabled: isEnabled('expected-files', enabled, options),
      issues: applyExpectedFilesCheck(config.snapshot, runContext.inputFiles)
    })
  );

  // 15) Reproducibility
  suites.push(
    summarizeSuite({
      id: 'reproducibility',
      label: 'Reproducibility',
      description: 'Config hash/version, tool version, run mode audit fields.',
      category: 'reproducibility',
      enabled: isEnabled('reproducibility', enabled, options),
      issues: runReproducibilityChecks({
        config,
        runContext,
        toolVersion: TOOL_VERSION
      })
    })
  );

  const issues = suites.flatMap((s) => (s.enabled ? s.issues : []));
  // Deduplicate by severity+label+detail+location
  const seen = new Set<string>();
  const deduped: CheckIssue[] = [];
  for (const i of issues) {
    const key = `${i.severity}|${i.label}|${i.detail}|${i.location}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(i);
  }

  const overview: CheckResult[] = [
    {
      label: 'Source',
      status: 'ok',
      statusLabel: 'OK',
      detail: `${source} detected${sourceDetail ? `: ${sourceDetail}` : ''}.`,
      suiteId: 'ingest',
      category: 'ingest'
    },
    {
      label: 'Suites executed',
      status: 'ok',
      statusLabel: 'OK',
      detail: `${suites.filter((s) => s.enabled).length}/${suites.length} check suites enabled.`,
      category: 'policy'
    },
    ...suites.map(suiteToCheckResult)
  ];

  return { suites, issues: deduped, checkResults: overview };
}

// silence unused ParseResult import warning if any
export type { ParseResult };
