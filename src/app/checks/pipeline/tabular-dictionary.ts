/**
 * Tabular / dictionary-driven dataset parsing and validation.
 *
 * Used for study CAD packages (e.g. SHIELD-CC-2025, SHIELD-OC-2025) where the
 * validation config declares `entities` / field rules and the input is either:
 * - a single CSV matching one entity table, or
 * - a JSON object mapping table file names → CSV text (multi-file package).
 *
 * Checks cover: expected files/columns, required fields, value types & formats,
 * controlled vocabularies, primary keys, and cross-file references.
 */

import type { CheckIssue } from '../types';
import type {
  AliasMapping,
  CrossFileReference,
  EntityFieldRule,
  EntityRule,
  ValidationConfig
} from '../config/types';
import { parseCsvRows } from '../io/load-config';
import { compileRegex, issue } from './helpers';

export interface TabularTable {
  entity: string;
  table: string;
  headers: string[];
  /** Canonical header names after alias mapping. */
  canonicalHeaders: string[];
  rows: Array<Record<string, string>>;
  sourceLabel: string;
}

export interface TabularParseResult {
  ok: boolean;
  type: string;
  tables: TabularTable[];
  error?: string;
}

const DATE_PATTERNS: Record<string, RegExp> = {
  'YYYY-MM-DD': /^\d{4}-\d{2}-\d{2}$/,
  'YYYY-MM-DDTHH:mm:ss': /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/,
  'YYYY-MM-DDTHH:mm:ssZ': /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/,
  ISO8601: /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?)?$/
};

const patternCache = new Map<string, RegExp | null>();

function resolvePattern(pattern: string): RegExp | null {
  const known = DATE_PATTERNS[pattern];
  if (known) return known;
  if (patternCache.has(pattern)) return patternCache.get(pattern)!;
  const compiled = compileRegex(pattern);
  patternCache.set(pattern, compiled);
  return compiled;
}

function looksLikeCsv(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed || trimmed.startsWith('{') || trimmed.startsWith('[')) return false;
  const first = trimmed.split(/\r?\n/, 1)[0] ?? '';
  return first.includes(',') && !first.trim().startsWith('{');
}

function looksLikeMultiCsvJson(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed.startsWith('{')) return false;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    return Object.values(parsed).some(
      (v) => typeof v === 'string' && (v as string).includes(',') && (v as string).includes('\n')
    );
  } catch {
    return false;
  }
}

export function isTabularDatasetInput(content: string, config: ValidationConfig): boolean {
  const formats = new Set((config.formats ?? []).map((f) => f.toLowerCase()));
  const tabularPreferred =
    formats.has('csv') ||
    formats.has('tsv') ||
    formats.has('tabular') ||
    Boolean(config.studyId) ||
    (config.entities ?? []).some((e) => Boolean(e.table));
  if (!tabularPreferred) return false;
  return looksLikeCsv(content) || looksLikeMultiCsvJson(content);
}

function applyAliases(
  headers: string[],
  aliases: AliasMapping[] | undefined,
  entity?: string
): { canonical: string[]; issues: CheckIssue[]; renameMap: Record<string, string> } {
  const issues: CheckIssue[] = [];
  const renameMap: Record<string, string> = {};
  const scoped = (aliases ?? []).filter((a) => !a.entity || a.entity === entity);
  const canonical = headers.map((h) => {
    const alias = scoped.find((a) => a.from === h);
    if (alias) {
      renameMap[h] = alias.to;
      issues.push(
        issue({
          severity: alias.severity === 'error' ? 'error' : alias.severity === 'info' ? 'ok' : 'warn',
          label: 'Legacy column alias applied',
          detail: `Column "${h}" mapped to canonical "${alias.to}".`,
          location: entity ?? 'Dataset',
          category: 'config',
          code: 'ALIAS_APPLIED',
          field: alias.to,
          rawValue: h,
          suiteId: 'tabular-dictionary'
        })
      );
      return alias.to;
    }
    return h;
  });
  return { canonical, issues: issues.filter((i) => i.severity !== 'ok'), renameMap };
}

function rowsFromMatrix(headers: string[], matrix: string[][]): Array<Record<string, string>> {
  return matrix.map((cells) => {
    const row: Record<string, string> = {};
    headers.forEach((h, i) => {
      row[h] = (cells[i] ?? '').trim();
    });
    return row;
  });
}

function parseSingleCsvTable(
  csvText: string,
  entity: EntityRule,
  aliases: AliasMapping[] | undefined,
  sourceLabel: string
): { table?: TabularTable; issues: CheckIssue[] } {
  const matrix = parseCsvRows(csvText);
  if (!matrix.length) {
    return {
      issues: [
        issue({
          severity: 'error',
          label: 'Empty table',
          detail: `Table ${entity.table ?? entity.name} has no header row.`,
          location: entity.name,
          category: 'dataset',
          code: 'EMPTY_TABLE',
          suiteId: 'tabular-dictionary'
        })
      ]
    };
  }
  const rawHeaders = matrix[0].map((h) => h.trim());
  const { canonical, issues, renameMap } = applyAliases(rawHeaders, aliases, entity.name);
  const dataRows = rowsFromMatrix(canonical, matrix.slice(1)).map((row) => {
    // Also copy legacy keys if needed — rows already use canonical headers from matrix remap
    const out: Record<string, string> = { ...row };
    Object.entries(renameMap).forEach(([from, to]) => {
      if (out[to] === undefined && row[from] !== undefined) out[to] = row[from];
    });
    return out;
  });

  return {
    table: {
      entity: entity.name,
      table: entity.table ?? `${entity.name}.csv`,
      headers: rawHeaders,
      canonicalHeaders: canonical,
      rows: dataRows,
      sourceLabel
    },
    issues
  };
}

/**
 * Parse a study dataset:
 * - single CSV string (one table; entity inferred from config / filename)
 * - JSON object map of tableName → CSV string (multi-file package)
 */
export function parseTabularDataset(
  content: string,
  config: ValidationConfig,
  sourceDetail?: string
): { parse: TabularParseResult; issues: CheckIssue[] } {
  const issues: CheckIssue[] = [];
  const entities = config.entities ?? [];
  const tables: TabularTable[] = [];

  const trimmed = content.trim();
  if (looksLikeMultiCsvJson(trimmed)) {
    const parsed = JSON.parse(trimmed) as Record<string, string>;
    for (const entity of entities) {
      const tableName = entity.table ?? `${entity.name}.csv`;
      const csv =
        parsed[tableName] ??
        parsed[entity.name] ??
        parsed[tableName.replace(/\.csv$/i, '')];
      if (typeof csv !== 'string') {
        // missing table handled later via expected files / column checks
        continue;
      }
      const result = parseSingleCsvTable(csv, entity, config.aliases, tableName);
      issues.push(...result.issues);
      if (result.table) tables.push(result.table);
    }
    return {
      parse: { ok: true, type: 'Multi-CSV package (JSON map)', tables },
      issues
    };
  }

  if (looksLikeCsv(trimmed)) {
    const baseName = (sourceDetail ?? '').split(/[/\\]/).pop() ?? '';
    const entity =
      entities.find((e) => e.table && baseName && e.table.toLowerCase() === baseName.toLowerCase()) ??
      entities.find((e) => e.table && baseName && baseName.toLowerCase().includes(e.name.toLowerCase())) ??
      entities[0];
    if (!entity) {
      return {
        parse: {
          ok: false,
          type: 'CSV',
          tables: [],
          error: 'No entity/table defined in validation config for CSV input.'
        },
        issues
      };
    }
    const result = parseSingleCsvTable(trimmed, entity, config.aliases, entity.table ?? entity.name);
    issues.push(...result.issues);
    if (result.table) tables.push(result.table);
    return {
      parse: { ok: true, type: 'CSV', tables },
      issues
    };
  }

  return {
    parse: {
      ok: false,
      type: 'Unknown',
      tables: [],
      error: 'Input is not a CSV table or multi-CSV JSON package.'
    },
    issues
  };
}

function fieldRuleMap(entity: EntityRule): Map<string, EntityFieldRule> {
  const map = new Map<string, EntityFieldRule>();
  for (const f of entity.fields ?? []) map.set(f.name, f);
  return map;
}

function validateDataType(value: string, dataType: string | undefined, field: string, location: string): CheckIssue | null {
  if (!dataType || value === '') return null;
  const t = dataType.toLowerCase();
  if (t === 'integer' || t === 'int') {
    if (!/^-?\d+$/.test(value)) {
      return issue({
        severity: 'error',
        label: 'Invalid integer',
        detail: `${field}="${value}" is not an integer.`,
        location,
        category: 'structure',
        code: 'DATATYPE_INTEGER',
        field,
        rawValue: value,
        suiteId: 'tabular-dictionary'
      });
    }
  }
  if (t === 'number' || t === 'float' || t === 'decimal') {
    if (!/^-?\d+(\.\d+)?$/.test(value)) {
      return issue({
        severity: 'error',
        label: 'Invalid number',
        detail: `${field}="${value}" is not a number.`,
        location,
        category: 'structure',
        code: 'DATATYPE_NUMBER',
        field,
        rawValue: value,
        suiteId: 'tabular-dictionary'
      });
    }
  }
  if (t === 'boolean' || t === 'bool') {
    if (!/^(true|false|0|1|yes|no)$/i.test(value)) {
      return issue({
        severity: 'error',
        label: 'Invalid boolean',
        detail: `${field}="${value}" is not a boolean.`,
        location,
        category: 'structure',
        code: 'DATATYPE_BOOLEAN',
        field,
        rawValue: value,
        suiteId: 'tabular-dictionary'
      });
    }
  }
  if (t === 'date' || t === 'datetime' || t === 'dateTime') {
    const re = DATE_PATTERNS['ISO8601'];
    if (!re.test(value)) {
      return issue({
        severity: 'error',
        label: 'Invalid date/time',
        detail: `${field}="${value}" does not match ISO8601 date/dateTime.`,
        location,
        category: 'datetime',
        code: 'DATATYPE_DATETIME',
        field,
        rawValue: value,
        suiteId: 'tabular-dictionary'
      });
    }
  }
  return null;
}

export interface TabularValidationExtras {
  missingFiles: string[];
  unexpectedFiles: string[];
  missingColumns: string[];
  unexpectedColumns: string[];
  tableCounts: Record<string, number>;
  rowCount: number;
}

export function runTabularDictionaryChecks(
  config: ValidationConfig,
  tables: TabularTable[],
  inputFiles: string[]
): { issues: CheckIssue[]; extras: TabularValidationExtras } {
  const issues: CheckIssue[] = [];
  const missingFiles: string[] = [];
  const unexpectedFiles: string[] = [];
  const missingColumns: string[] = [];
  const unexpectedColumns: string[] = [];
  const tableCounts: Record<string, number> = {};

  const providedBases = new Set(
    [
      ...inputFiles.map((f) => f.split(/[/\\]/).pop() || f),
      ...tables.map((t) => t.table)
    ].filter(Boolean)
  );

  // Multi-CSV JSON packages are wrappers; don't treat the wrapper filename as an unexpected study file
  // when expectedFiles are satisfied by parsed tables.
  const expectedBases = (config.expectedFiles ?? []).map((e) => (e.split(/[/\\]/).pop() || e).toLowerCase());
  const tablesCoverExpected =
    expectedBases.length > 0 &&
    expectedBases.every((base) => tables.some((t) => t.table.toLowerCase() === base));

  for (const expected of config.expectedFiles ?? []) {
    const base = expected.split(/[/\\]/).pop() || expected;
    if (![...providedBases].some((p) => p === base || p.toLowerCase() === base.toLowerCase())) {
      missingFiles.push(expected);
      issues.push(
        issue({
          severity: 'error',
          label: 'Missing expected file',
          detail: `Expected file "${expected}" was not provided for this study dataset refresh.`,
          location: 'Dataset',
          category: 'dataset',
          code: 'MISSING_EXPECTED_FILE',
          field: expected,
          suiteId: 'expected-files'
        })
      );
    }
  }

  if ((config.expectedFiles ?? []).length && !tablesCoverExpected) {
    for (const provided of providedBases) {
      const ok = (config.expectedFiles ?? []).some((e) => {
        const base = e.split(/[/\\]/).pop() || e;
        return base.toLowerCase() === provided.toLowerCase();
      });
      if (!ok && provided) {
        unexpectedFiles.push(provided);
        issues.push(
          issue({
            severity: 'warn',
            label: 'Unexpected file',
            detail: `File "${provided}" is not listed in expectedFiles for this dictionary config.`,
            location: 'Dataset',
            category: 'dataset',
            code: 'UNEXPECTED_FILE',
            field: provided,
            suiteId: 'expected-files'
          })
        );
      }
    }
  } else if ((config.expectedFiles ?? []).length && tablesCoverExpected) {
    // still flag unexpected *table* names that are not in expectedFiles
    for (const table of tables) {
      const ok = expectedBases.includes(table.table.toLowerCase());
      if (!ok) {
        unexpectedFiles.push(table.table);
        issues.push(
          issue({
            severity: 'warn',
            label: 'Unexpected file',
            detail: `File "${table.table}" is not listed in expectedFiles for this dictionary config.`,
            location: 'Dataset',
            category: 'dataset',
            code: 'UNEXPECTED_FILE',
            field: table.table,
            suiteId: 'expected-files'
          })
        );
      }
    }
  }

  const tablesByEntity = new Map(tables.map((t) => [t.entity, t]));

  for (const entity of config.entities ?? []) {
    const table = tablesByEntity.get(entity.name);
    const tableLabel = entity.table ?? `${entity.name}.csv`;
    if (!table) {
      issues.push(
        issue({
          severity: 'error',
          label: 'Missing table',
          detail: `Dictionary entity "${entity.name}" (table ${tableLabel}) has no data in this package.`,
          location: entity.name,
          category: 'dataset',
          code: 'MISSING_TABLE',
          suiteId: 'tabular-dictionary'
        })
      );
      continue;
    }

    tableCounts[entity.name] = table.rows.length;
    const headerSet = new Set(table.canonicalHeaders);
    const required = entity.requiredFields ?? (entity.fields ?? []).filter((f) => f.required).map((f) => f.name);
    const optional = entity.optionalFields ?? (entity.fields ?? []).filter((f) => !f.required).map((f) => f.name);
    const declared = new Set([...required, ...optional, ...(entity.fields ?? []).map((f) => f.name)]);

    for (const col of required) {
      if (!headerSet.has(col)) {
        missingColumns.push(`${entity.name}.${col}`);
        issues.push(
          issue({
            severity: 'error',
            label: 'Missing required column',
            detail: `Table ${tableLabel} is missing required column "${col}".`,
            location: entity.name,
            category: 'dataset',
            code: 'MISSING_COLUMN',
            field: col,
            suiteId: 'tabular-dictionary'
          })
        );
      }
    }

    for (const col of table.canonicalHeaders) {
      if (declared.size && !declared.has(col)) {
        unexpectedColumns.push(`${entity.name}.${col}`);
        issues.push(
          issue({
            severity: 'warn',
            label: 'Unexpected column',
            detail: `Table ${tableLabel} contains undeclared column "${col}".`,
            location: entity.name,
            category: 'dataset',
            code: 'UNEXPECTED_COLUMN',
            field: col,
            suiteId: 'tabular-dictionary'
          })
        );
      }
    }

    const rules = fieldRuleMap(entity);
    const pkFields = entity.primaryKeys?.length ? entity.primaryKeys : required.slice(0, 1);
    const seenKeys = new Map<string, string>();

    table.rows.forEach((row, rowIndex) => {
      const rowId = pkFields.map((k) => row[k] ?? '').join('|') || String(rowIndex + 1);
      const location = `${entity.name}/row/${rowId}`;

      for (const col of required) {
        if (!(row[col] ?? '').trim()) {
          issues.push(
            issue({
              severity: 'error',
              label: 'Missing required value',
              detail: `Required field "${col}" is empty.`,
              location,
              category: 'completeness',
              code: 'MISSING_REQUIRED_VALUE',
              field: col,
              rawValue: '',
              suiteId: 'tabular-dictionary'
            })
          );
        }
      }

      for (const [field, value] of Object.entries(row)) {
        const rule = rules.get(field);
        if (!rule || value === '') continue;

        const dtIssue = validateDataType(value, rule.dataType, field, location);
        if (dtIssue) issues.push(dtIssue);

        if (rule.allowableValues?.length && !rule.allowableValues.includes(value)) {
          issues.push(
            issue({
              severity: rule.severity === 'warn' ? 'warn' : 'error',
              label: 'Value not allowed',
              detail: `${field}="${value}" is not in allowable values.`,
              location,
              category: 'vocabulary',
              code: 'VALUE_NOT_ALLOWED',
              field,
              rawValue: value,
              suiteId: 'tabular-dictionary'
            })
          );
        }

        const pattern = rule.regex || rule.dateTimePattern;
        if (pattern) {
          const re = resolvePattern(pattern);
          if (re && !re.test(value)) {
            issues.push(
              issue({
                severity: rule.severity === 'warn' ? 'warn' : 'error',
                label: 'Pattern mismatch',
                detail: `${field}="${value}" does not match pattern ${pattern}.`,
                location,
                category: 'structure',
                code: 'PATTERN_MISMATCH',
                field,
                rawValue: value,
                suiteId: 'tabular-dictionary'
              })
            );
          }
        }
      }

      if (pkFields.length) {
        const key = pkFields.map((k) => row[k] ?? '').join('|');
        if (key && seenKeys.has(key)) {
          issues.push(
            issue({
              severity: 'error',
              label: 'Duplicate primary key',
              detail: `Duplicate primary key (${pkFields.join('+')}=${key}); also at ${seenKeys.get(key)}.`,
              location,
              category: 'identifier',
              code: 'DUPLICATE_PRIMARY_KEY',
              field: pkFields.join('+'),
              rawValue: key,
              suiteId: 'primary-keys'
            })
          );
        } else if (key) {
          seenKeys.set(key, location);
        }
      }
    });
  }

  // Cross-file references
  for (const ref of config.crossFileReferences ?? []) {
    const from = tablesByEntity.get(ref.fromEntity);
    const to = tablesByEntity.get(ref.toEntity);
    if (!from || !to) continue;
    const targetKeys = new Set(to.rows.map((r) => (r[ref.toField] ?? '').trim()).filter(Boolean));
    from.rows.forEach((row, idx) => {
      const value = (row[ref.fromField] ?? '').trim();
      if (!value) return;
      if (!targetKeys.has(value)) {
        const rowId = row[from.canonicalHeaders[0]] ?? String(idx + 1);
        issues.push(
          issue({
            severity: ref.severity === 'warn' ? 'warn' : 'error',
            label: 'Broken cross-file reference',
            detail:
              ref.description ??
              `${ref.fromEntity}.${ref.fromField}="${value}" not found in ${ref.toEntity}.${ref.toField}.`,
            location: `${ref.fromEntity}/row/${rowId}`,
            category: 'reference',
            code: 'BROKEN_CROSS_FILE_REF',
            field: ref.fromField,
            rawValue: value,
            suiteId: 'cross-references'
          })
        );
      }
    });
  }

  const rowCount = Object.values(tableCounts).reduce((a, b) => a + b, 0);
  return {
    issues,
    extras: {
      missingFiles,
      unexpectedFiles,
      missingColumns,
      unexpectedColumns,
      tableCounts,
      rowCount
    }
  };
}

export type { CrossFileReference };
