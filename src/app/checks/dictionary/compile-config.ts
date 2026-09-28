/**
 * Compiles a parsed data dictionary into a {@link ValidationConfig}.
 *
 * Categories become entities (one CSV table each). Field names keep the
 * trimmed dictionary spelling, because study extracts usually use those
 * headers. Numeric windows become `min` / `max`. Enumerated cells become
 * allowable values, including a leading code (`P2` from `P2 - Negative`) and
 * slash synonyms. Prose placeholders are not turned into a code list.
 *
 * An explicit empty `primaryKeys` array means "no key was declared". The
 * tabular checker must not invent one from the first required column, or a
 * repeated age would look like a duplicate patient.
 */

import type { AliasMapping, EntityFieldRule, EntityRule, ValidationConfig } from '../config/types';
import { declaredDatePattern } from './dates';
import type { DataDictionaryDocument, DictionaryField, DictionaryNumericRange } from './types';
import { isBlankMarker } from './value-spec';

export function compileDataDictionary(doc: DataDictionaryDocument): ValidationConfig {
  const named = doc.fields.filter((field) => field.name);
  if (!named.length) {
    throw new Error(
      `No dictionary fields could be compiled from "${doc.fileName}". The workbook needs a header row with field names.`
    );
  }

  const groups = new Map<string, DictionaryField[]>();
  for (const field of named) {
    const category = field.category.trim() || 'Uncategorized';
    const list = groups.get(category) ?? [];
    list.push(field);
    groups.set(category, list);
  }

  const usedSlugs = new Set<string>();
  const entities: EntityRule[] = [];
  const aliases: AliasMapping[] = [];

  for (const [category, fields] of groups) {
    const slug = uniqueSlug(slugify(category), usedSlugs);
    const entityName = slug;
    const rules: EntityFieldRule[] = [];
    const seenNames = new Set<string>();

    for (const field of fields) {
      if (seenNames.has(field.name.toLowerCase())) continue;
      seenNames.add(field.name.toLowerCase());
      rules.push(toFieldRule(field));
      if (field.rawName !== field.name) {
        aliases.push({
          from: field.rawName,
          to: field.name,
          entity: entityName,
          severity: 'warn'
        });
      }
    }

    entities.push({
      name: entityName,
      description: category,
      table: `${slug}.csv`,
      requiredFields: rules.filter((rule) => rule.required).map((rule) => rule.name),
      optionalFields: rules.filter((rule) => !rule.required).map((rule) => rule.name),
      fields: rules,
      primaryKeys: []
    });
  }

  const base = doc.fileName.replace(/\.[^.]+$/, '') || 'data-dictionary';
  const dictionarySheets = doc.sheets.filter((sheet) => sheet.role === 'dictionary').map((sheet) => sheet.name);

  return {
    id: slugify(base) || 'data-dictionary',
    version: versionFromFileName(doc.fileName),
    name: `Data dictionary (${base})`,
    description:
      `Validation rules compiled from Excel data dictionary "${doc.fileName}" ` +
      `(${named.length} fields, ${entities.length} categories). ` +
      'Column headers must match the trimmed dictionary field names. ' +
      'Supply one CSV per category, or a JSON map of table name to CSV text.',
    formats: ['csv', 'tabular', 'xlsx'],
    entities,
    expectedFiles: entities.map((entity) => entity.table!).filter(Boolean),
    aliases: aliases.length ? aliases : undefined,
    metadataRequirements: ['datasetId', 'sourceSite', 'schemaVersion', 'toolVersion'],
    plugins: [
      'tabular-dictionary',
      'primary-keys',
      'expected-files',
      'metadata-requirements',
      'reproducibility'
    ],
    dictionaryRef: dictionarySheets.length
      ? `Excel data dictionary · ${dictionarySheets.map((name) => `"${name}"`).join(', ')}`
      : `Excel data dictionary · ${doc.fileName}`,
    dictionarySource: {
      fileName: doc.fileName,
      sheets: doc.sheets.map((sheet) => sheet.name),
      fieldCount: named.length,
      categoryCount: entities.length
    },
    failOnError: true,
    failOnWarn: false
  };
}

function toFieldRule(field: DictionaryField): EntityFieldRule {
  const dataType = compiledDataType(field);
  const severity = field.required ? 'error' : 'warn';
  const rule: EntityFieldRule = {
    name: field.name,
    required: field.required === true,
    dataType,
    severity,
    description: field.description || undefined
  };

  const units = field.units.trim();
  if (units && !isBlankMarker(units)) rule.units = units;

  const length = /\b(?:var\s*char|char)\s*\(\s*(\d+)\s*\)/i.exec(field.format);
  if (length) rule.maxLength = Number(length[1]);

  if (dataType === 'date') {
    const declared = declaredDatePattern(field.format);
    if (declared) rule.dateTimePattern = declared.patternKey;
  }

  const range = effectiveRange(field);
  if (range && (dataType === 'integer' || dataType === 'number')) {
    if (range.min != null) {
      rule.min = range.min;
      rule.minInclusive = range.minInclusive;
    }
    if (range.max != null) {
      rule.max = range.max;
      rule.maxInclusive = range.maxInclusive;
    }
  }

  const allowable = allowableValues(field, dataType);
  if (allowable.length) rule.allowableValues = allowable;
  return rule;
}

function compiledDataType(field: DictionaryField): string {
  if (field.scalarType === 'boolean') return 'boolean';
  if (field.scalarType === 'date') return 'date';
  if (field.scalarType === 'text') return 'string';
  if (field.scalarType === 'integer') return 'integer';
  if (field.scalarType === 'number') return 'number';
  if (field.acceptable.range && (field.scalarType === 'code' || field.scalarType === 'unknown')) {
    return rangeIsInteger(field.acceptable.range) ? 'integer' : 'number';
  }
  if (field.scalarType === 'code') return 'code';
  return 'string';
}

function effectiveRange(field: DictionaryField): DictionaryNumericRange | undefined {
  return field.acceptable.range;
}

function allowableValues(field: DictionaryField, dataType: string): string[] {
  if (field.acceptable.kind === 'prose' || field.acceptable.kind === 'empty' || field.acceptable.kind === 'range') {
    if (dataType === 'boolean') return ['Yes', 'No'];
    return [];
  }
  const values: string[] = [];
  const seen = new Set<string>();
  for (const token of field.acceptable.tokens) {
    for (const form of token.forms) {
      const key = form.trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      values.push(form.trim());
    }
  }
  return values;
}

function rangeIsInteger(range: DictionaryNumericRange): boolean {
  return [range.min, range.max].every((n) => n == null || Number.isInteger(n));
}

function versionFromFileName(fileName: string): string {
  const match = /(?:^|[^a-z0-9])v(\d+)(?:\.(\d+))?(?:\.(\d+))?/i.exec(fileName);
  if (!match) return '1.0.0';
  return `${match[1]}.${match[2] ?? '0'}.${match[3] ?? '0'}`;
}

export function slugify(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function uniqueSlug(slug: string, used: Set<string>): string {
  const base = slug || 'category';
  let next = base;
  let n = 2;
  while (used.has(next)) {
    next = `${base}_${n}`;
    n++;
  }
  used.add(next);
  return next;
}
