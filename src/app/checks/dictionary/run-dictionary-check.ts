/**
 * Quality-gate entry point for an Excel data dictionary.
 *
 * The workbook is audited on its own terms. The report's configuration is the
 * schema compiled from that workbook, so the same run both lists dictionary
 * defects and records the rules a later CSV extract would be checked against.
 */

import { resolveEffectiveConfig, defaultRunContext } from '../config';
import type { ValidationConfig } from '../config/types';
import { summarizeSuite, suiteToCheckResult } from '../pipeline/helpers';
import { buildDccRunReport, TOOL_VERSION, type DccRunReport } from '../report/build-report';
import type { CheckIssue, ValidateOptions } from '../types';
import { auditDataDictionary } from './audit-dictionary';
import { compileDataDictionary } from './compile-config';
import { parseDataDictionary } from './parse-dictionary';
import { dictionaryRecordKey, type DataDictionaryDocument } from './types';

const UNPARSED_CONFIG: ValidationConfig = {
  id: 'unparsed-dictionary',
  version: '0.0.0',
  name: 'Unparsed data dictionary',
  description: 'Placeholder used when a workbook could not be read.',
  formats: ['xlsx'],
  entities: [{ name: 'dictionary', fields: [{ name: 'field', dataType: 'string' }], primaryKeys: [] }],
  metadataRequirements: [],
  plugins: ['dictionary-workbook'],
  failOnError: true,
  failOnWarn: false
};

export function compileDictionaryWorkbook(
  bytes: Uint8Array,
  fileName: string
): { document: DataDictionaryDocument; config: ValidationConfig } {
  const document = parseDataDictionary(bytes, fileName);
  return { document, config: compileDataDictionary(document) };
}

/**
 * Audit a data-dictionary workbook and return the same report shape as
 * `runDataCurationCheck`.
 */
export function runDictionaryWorkbookCheck(
  bytes: Uint8Array,
  fileName: string,
  options?: ValidateOptions
): DccRunReport {
  const source = options?.source ?? 'File';
  let document: DataDictionaryDocument | null = null;
  let compiled: ValidationConfig = UNPARSED_CONFIG;
  const parseIssues: CheckIssue[] = [];

  try {
    document = parseDataDictionary(bytes, fileName);
    if (document.fields.length) {
      compiled = compileDataDictionary(document);
    }
  } catch (error) {
    parseIssues.push({
      severity: 'error',
      code: 'DICT_PARSE_FAILED',
      label: 'Dictionary workbook could not be read',
      detail: error instanceof Error ? error.message : 'Unable to read the workbook.',
      location: source,
      category: 'ingest',
      suiteId: 'dictionary-structure'
    });
  }

  if (options?.config?.failOnWarn) {
    compiled = { ...compiled, failOnWarn: true };
  }
  const config = resolveEffectiveConfig(compiled);
  const runContext = defaultRunContext({
    ...options?.runContext,
    schemaVersion: options?.runContext?.schemaVersion ?? config.version,
    studyId: options?.runContext?.studyId ?? config.snapshot.studyId,
    dictionaryRef: options?.runContext?.dictionaryRef ?? config.snapshot.dictionaryRef,
    inputFiles: options?.runContext?.inputFiles?.length
      ? options.runContext.inputFiles
      : [fileName]
  });

  const auditIssues = document ? auditDataDictionary(document) : [];
  const issues = [...parseIssues, ...auditIssues];
  const structureIssues = issues.filter((issue) => issue.suiteId !== 'dictionary-domain');
  const domainIssues = issues.filter((issue) => issue.suiteId === 'dictionary-domain');

  const fieldCount = document?.fields.length ?? 0;
  const categoryCount = new Set(document?.fields.map((field) => field.category) ?? []).size;
  const parseOk = parseIssues.length === 0 && fieldCount > 0;

  const suites = [
    summarizeSuite({
      id: 'dictionary-structure',
      label: 'Dictionary structure',
      description: 'Headers, field names, required/null flags, types, and sheet layout.',
      category: 'structure',
      enabled: true,
      issues: structureIssues
    }),
    summarizeSuite({
      id: 'dictionary-domain',
      label: 'Dictionary domains',
      description: 'Acceptable values against existing values, ranges, and date samples.',
      category: 'vocabulary',
      enabled: true,
      issues: domainIssues
    })
  ];

  const checkResults = [
    {
      label: 'Source',
      status: parseOk ? ('ok' as const) : ('error' as const),
      statusLabel: parseOk ? 'OK' : 'Error',
      detail: parseOk
        ? `${source}${fileName ? `: ${fileName}` : ''} — ${fieldCount} fields in ${categoryCount} categories.`
        : parseIssues[0]?.detail ?? 'No dictionary fields were found.',
      suiteId: 'dictionary-structure',
      category: 'ingest' as const
    },
    ...suites.map(suiteToCheckResult)
  ];

  return buildDccRunReport({
    parseResult: {
      ok: parseOk,
      type: 'Excel data dictionary',
      resources: [],
      diagnosticReports: [],
      error: parseOk ? undefined : parseIssues[0]?.detail ?? 'No dictionary fields were found.'
    },
    issues,
    checkResults,
    laboratoryCount: 0,
    config,
    runContext,
    checkSuites: suites,
    toolVersion: TOOL_VERSION,
    summaryExtras: {
      rowCount: fieldCount,
      tableCounts: countCategories(document),
      recordKeys: document?.fields.map((field) => dictionaryRecordKey(field)) ?? [],
      missingFiles: [],
      unexpectedFiles: document?.sheets.filter((sheet) => sheet.role === 'ignored').map((sheet) => sheet.name) ?? [],
      missingColumns: [],
      unexpectedColumns: []
    }
  });
}

function countCategories(document: DataDictionaryDocument | null): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const field of document?.fields ?? []) {
    const key = field.category || 'Uncategorized';
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}
