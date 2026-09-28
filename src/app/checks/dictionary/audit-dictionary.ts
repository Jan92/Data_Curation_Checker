/**
 * Syntactic audit of a parsed data dictionary.
 *
 * The checks come from defects that show up in real study catalogues:
 * required fields that also accept null, date order that contradicts the
 * samples in the "existing values" column, observed codes that were never
 * declared, unbounded `VARCHAR( )`, and side sheets that drift from the
 * acceptable list. Nothing here is clinical interpretation — a value is
 * only compared with what the workbook itself claims.
 *
 * Findings use these codes:
 *
 * - `DICT_NO_FIELDS` — no sheet looked like a dictionary
 * - `DICT_MISSING_NAME` — a body row has no field name
 * - `DICT_FIELD_WHITESPACE` — padding or repeated spaces in the name
 * - `DICT_DUPLICATE_FIELD` — same name twice in one category
 * - `DICT_FIELD_REUSED` — same name in two categories
 * - `DICT_MISSING_DESCRIPTION` / `DICT_MISSING_TYPE`
 * - `DICT_FLAG_UNREADABLE` — required / null cell is not yes or no
 * - `DICT_MISSING_REQUIRED_FLAG`
 * - `DICT_REQUIRED_ALLOWS_NULL` — required and nullable (blocking)
 * - `DICT_OPTIONAL_FORBIDS_NULL`
 * - `DICT_TYPE_FORMAT_MISMATCH`
 * - `DICT_BOOLEAN_AS_CATEGORICAL` — yes/no format labelled categorical
 * - `DICT_RANGE_AS_CATEGORICAL` — a numeric window labelled categorical
 * - `DICT_UNBOUNDED_TEXT` — one workbook-level warning for empty `VARCHAR( )`
 * - `DICT_UNCODED_DOMAIN` — categorical field whose domain is prose
 * - `DICT_DUPLICATE_TOKEN` — the same code listed twice
 * - `DICT_OBSERVED_NOT_IN_DOMAIN` — existing value outside the acceptable set
 * - `DICT_OBSERVED_OUTSIDE_RANGE` — existing numeric extent outside the window
 * - `DICT_DATE_ORDER_CONFLICT` — sample date cannot match the declared order
 * - `DICT_DATE_SEPARATOR` — sample uses `/` while the format uses `-`, or the reverse
 * - `DICT_DATE_INVALID` — a component is not a possible month or day
 * - `DICT_INDEX_DUPLICATE` / `DICT_INDEX_GAP`
 * - `DICT_COMPANION_DRIFT` / `DICT_COMPANION_DUPLICATE`
 * - `DICT_IGNORED_SHEET`
 */

import type { CheckIssue } from '../types';
import { dayPart, declaredDatePattern, monthPart, observedDateTokens, yearPart } from './dates';
import { dictionaryRecordKey, type DataDictionaryDocument, type DictionaryField } from './types';
import {
  isBlankMarker,
  isMissingnessKey,
  normKey,
  rangeContains,
  specCoversToken
} from './value-spec';

const EXAMPLE_LIMIT = 8;

export function auditDataDictionary(doc: DataDictionaryDocument): CheckIssue[] {
  const issues: CheckIssue[] = [];
  if (!doc.fields.length) {
    issues.push(
      finding({
        severity: 'error',
        code: 'DICT_NO_FIELDS',
        label: 'No data dictionary found',
        detail:
          'No worksheet has a header row with a field name plus type, description, or acceptable values. ' +
          'Expected columns such as "Data Field", "Data Type", and "Value Range/ Acceptable values".',
        location: 'Dataset'
      })
    );
  }

  issues.push(...auditStructure(doc));
  issues.push(...auditDomains(doc));
  issues.push(...auditSheets(doc));
  return issues;
}

function auditStructure(doc: DataDictionaryDocument): CheckIssue[] {
  const issues: CheckIssue[] = [];
  const seenInCategory = new Map<string, DictionaryField>();
  const seenGlobal = new Map<string, DictionaryField>();
  const unbounded: string[] = [];
  const indexes = new Map<string, number[]>();

  for (const field of doc.fields) {
    const location = dictionaryRecordKey(field);
    if (!field.name) {
      issues.push(
        finding({
          severity: 'error',
          code: 'DICT_MISSING_NAME',
          label: 'Missing field name',
          detail: `Row ${field.rowNumber} on "${field.sheet}" has dictionary content but no field name.`,
          location,
          field: '(blank)',
          rawValue: field.description || field.dataType
        })
      );
      continue;
    }

    if (field.rawName !== field.name) {
      issues.push(
        finding({
          severity: 'warn',
          code: 'DICT_FIELD_WHITESPACE',
          label: 'Field name has extra whitespace',
          detail: `Row ${field.rowNumber}: "${field.rawName}" will be matched as "${field.name}".`,
          location,
          field: field.name,
          rawValue: field.rawName
        })
      );
    }

    const localKey = `${normKey(field.category)}|${normKey(field.name)}`;
    const previous = seenInCategory.get(localKey);
    if (previous) {
      issues.push(
        finding({
          severity: 'error',
          code: 'DICT_DUPLICATE_FIELD',
          label: 'Duplicate field name',
          detail: `"${field.name}" appears again in ${field.category} (first at row ${previous.rowNumber}).`,
          location,
          field: field.name,
          rawValue: field.name
        })
      );
    } else {
      seenInCategory.set(localKey, field);
      const global = seenGlobal.get(normKey(field.name));
      if (global && normKey(global.category) !== normKey(field.category)) {
        issues.push(
          finding({
            severity: 'warn',
            code: 'DICT_FIELD_REUSED',
            label: 'Field name reused across categories',
            detail: `"${field.name}" is also defined under ${global.category}.`,
            location,
            field: field.name
          })
        );
      } else if (!global) {
        seenGlobal.set(normKey(field.name), field);
      }
    }

    if (!field.description) {
      issues.push(
        finding({
          severity: 'warn',
          code: 'DICT_MISSING_DESCRIPTION',
          label: 'Missing description',
          detail: `${field.name} has no definition.`,
          location,
          field: field.name
        })
      );
    }
    if (!field.dataType) {
      issues.push(
        finding({
          severity: 'warn',
          code: 'DICT_MISSING_TYPE',
          label: 'Missing data type',
          detail: `${field.name} has no data type.`,
          location,
          field: field.name
        })
      );
    }

    issues.push(...auditFlags(field, location));
    issues.push(...auditTypeFormat(field, location));

    if (/\b(?:var\s*char|char)\s*\(\s*\)/i.test(field.format)) {
      unbounded.push(field.name);
    }

    if (field.index != null) {
      const list = indexes.get(field.sheet) ?? [];
      list.push(field.index);
      indexes.set(field.sheet, list);
    }
  }

  if (unbounded.length) {
    issues.push(
      finding({
        severity: 'warn',
        code: 'DICT_UNBOUNDED_TEXT',
        label: 'Text length not specified',
        detail: `${unbounded.length} field(s) use VARCHAR/CHAR with an empty length, for example ${preview(
          unbounded
        )}. A maximum length is needed before a character check can be enforced.`,
        location: 'Dataset'
      })
    );
  }

  for (const [sheet, list] of indexes) {
    const sorted = [...list].sort((a, b) => a - b);
    const dupes = sorted.filter((n, i) => i > 0 && sorted[i - 1] === n);
    if (dupes.length) {
      issues.push(
        finding({
          severity: 'warn',
          code: 'DICT_INDEX_DUPLICATE',
          label: 'Duplicate field index',
          detail: `Sheet "${sheet}" repeats index ${preview(dupes.map(String))}.`,
          location: sheet
        })
      );
    }
    const missing: number[] = [];
    for (let n = sorted[0]; n <= sorted[sorted.length - 1]; n++) {
      if (!sorted.includes(n)) missing.push(n);
    }
    if (missing.length) {
      issues.push(
        finding({
          severity: 'warn',
          code: 'DICT_INDEX_GAP',
          label: 'Field index gap',
          detail: `Sheet "${sheet}" skips index ${preview(missing.map(String))}.`,
          location: sheet
        })
      );
    }
  }

  return issues;
}

function auditFlags(field: DictionaryField, location: string): CheckIssue[] {
  const issues: CheckIssue[] = [];
  if (!field.requiredRaw) {
    issues.push(
      finding({
        severity: 'warn',
        code: 'DICT_MISSING_REQUIRED_FLAG',
        label: 'Required flag missing',
        detail: `${field.name} does not say whether the field is required.`,
        location,
        field: field.name
      })
    );
  } else if (field.required === null && !isBlankMarker(field.requiredRaw)) {
    issues.push(
      finding({
        severity: 'error',
        code: 'DICT_FLAG_UNREADABLE',
        label: 'Required flag not yes/no',
        detail: `${field.name} required cell is "${field.requiredRaw}".`,
        location,
        field: field.name,
        rawValue: field.requiredRaw
      })
    );
  }
  if (field.acceptsNullRaw && field.acceptsNull === null && !isBlankMarker(field.acceptsNullRaw)) {
    issues.push(
      finding({
        severity: 'error',
        code: 'DICT_FLAG_UNREADABLE',
        label: 'Null flag not yes/no',
        detail: `${field.name} null cell is "${field.acceptsNullRaw}".`,
        location,
        field: field.name,
        rawValue: field.acceptsNullRaw
      })
    );
  }
  if (field.required === true && field.acceptsNull === true) {
    issues.push(
      finding({
        severity: 'error',
        code: 'DICT_REQUIRED_ALLOWS_NULL',
        label: 'Required field accepts null',
        detail: `${field.name} is required and also marked as accepting null.`,
        location,
        field: field.name,
        rawValue: 'Yes / Yes'
      })
    );
  }
  if (field.required === false && field.acceptsNull === false) {
    issues.push(
      finding({
        severity: 'warn',
        code: 'DICT_OPTIONAL_FORBIDS_NULL',
        label: 'Optional field forbids null',
        detail: `${field.name} is not required, but null is not accepted. Confirm that an empty cell is invalid.`,
        location,
        field: field.name
      })
    );
  }
  return issues;
}

function auditTypeFormat(field: DictionaryField, location: string): CheckIssue[] {
  const issues: CheckIssue[] = [];
  const format = field.format.toLowerCase();
  const dataType = field.dataType.toLowerCase();
  const typedBoolean = /bool/.test(format);
  const typedRange = field.acceptable.kind === 'range' || field.acceptable.kind === 'mixed';

  if (typedBoolean && field.scalarType === 'boolean' && dataType.includes('categor')) {
    issues.push(
      finding({
        severity: 'warn',
        code: 'DICT_BOOLEAN_AS_CATEGORICAL',
        label: 'Yes/no field labelled categorical',
        detail: `${field.name} uses a boolean format ("${field.format}") but the data type is ${field.dataType}. It will be compiled as boolean.`,
        location,
        field: field.name,
        rawValue: field.dataType
      })
    );
  }

  if (typedRange && field.scalarType === 'code' && field.acceptable.range) {
    issues.push(
      finding({
        severity: 'warn',
        code: 'DICT_RANGE_AS_CATEGORICAL',
        label: 'Numeric range labelled categorical',
        detail: `${field.name} lists a numeric window (${field.acceptable.range.raw}) but the data type is ${field.dataType}. It will be compiled as a number.`,
        location,
        field: field.name,
        rawValue: field.acceptable.range.raw
      })
    );
  }

  const quantity = field.scalarType === 'integer' || field.scalarType === 'number';
  if (quantity && /varchar|\bchar\s*\(/.test(format)) {
    issues.push(
      finding({
        severity: 'warn',
        code: 'DICT_TYPE_FORMAT_MISMATCH',
        label: 'Numeric field uses a text format',
        detail: `${field.name} is ${field.dataType} but the format is "${field.format}".`,
        location,
        field: field.name,
        rawValue: field.format
      })
    );
  }
  if (field.scalarType === 'date' && field.format && !declaredDatePattern(field.format)) {
    issues.push(
      finding({
        severity: 'warn',
        code: 'DICT_TYPE_FORMAT_MISMATCH',
        label: 'Date field has no recognised format',
        detail: `${field.name} is ${field.dataType} but "${field.format}" does not contain a pattern such as MM-DD-YYYY.`,
        location,
        field: field.name,
        rawValue: field.format
      })
    );
  }
  if (field.scalarType === 'code' && /integer|float|decimal/.test(format) && !typedRange) {
    issues.push(
      finding({
        severity: 'warn',
        code: 'DICT_TYPE_FORMAT_MISMATCH',
        label: 'Categorical field uses a numeric format',
        detail: `${field.name} is ${field.dataType} but the format is "${field.format}".`,
        location,
        field: field.name,
        rawValue: field.format
      })
    );
  }
  return issues;
}

function auditDomains(doc: DataDictionaryDocument): CheckIssue[] {
  const issues: CheckIssue[] = [];
  for (const field of doc.fields) {
    if (!field.name) continue;
    const location = dictionaryRecordKey(field);
    issues.push(...auditDomain(field, location));
    issues.push(...auditObserved(field, location));
    issues.push(...auditDates(field, location));
  }
  return issues;
}

function auditDomain(field: DictionaryField, location: string): CheckIssue[] {
  const issues: CheckIssue[] = [];
  const coded = field.scalarType === 'code' || field.scalarType === 'boolean';
  if (coded && (field.acceptable.kind === 'prose' || field.acceptable.kind === 'empty')) {
    issues.push(
      finding({
        severity: 'warn',
        code: 'DICT_UNCODED_DOMAIN',
        label: 'No enforceable value list',
        detail:
          field.acceptable.kind === 'empty'
            ? `${field.name} is ${field.dataType || 'categorical'} but the acceptable-value cell is empty.`
            : `${field.name} is ${field.dataType || 'categorical'} but the acceptable values are prose ("${clip(
                field.acceptableRaw
              )}"), so a code check cannot be compiled.`,
        location,
        field: field.name,
        rawValue: clip(field.acceptableRaw)
      })
    );
  }

  const keys = new Set<string>();
  const dupes: string[] = [];
  for (const token of field.acceptable.tokens) {
    if (keys.has(token.key)) dupes.push(token.raw);
    keys.add(token.key);
  }
  if (dupes.length) {
    issues.push(
      finding({
        severity: 'warn',
        code: 'DICT_DUPLICATE_TOKEN',
        label: 'Duplicate acceptable value',
        detail: `${field.name} lists ${preview(dupes)} more than once.`,
        location,
        field: field.name,
        rawValue: preview(dupes)
      })
    );
  }

  if (
    field.defaultValue &&
    !isBlankMarker(field.defaultValue) &&
    (field.acceptable.kind === 'enumerated' || field.acceptable.kind === 'mixed')
  ) {
    const token = {
      raw: field.defaultValue,
      key: normKey(field.defaultValue),
      keys: [normKey(field.defaultValue)],
      forms: [field.defaultValue]
    };
    if (!specCoversToken(field.acceptable, token)) {
      issues.push(
        finding({
          severity: 'warn',
          code: 'DICT_OBSERVED_NOT_IN_DOMAIN',
          label: 'Default outside acceptable values',
          detail: `${field.name} default "${field.defaultValue}" is not in the acceptable list.`,
          location,
          field: field.name,
          rawValue: field.defaultValue
        })
      );
    }
  }
  return issues;
}

function auditObserved(field: DictionaryField, location: string): CheckIssue[] {
  const issues: CheckIssue[] = [];
  const acceptable = field.acceptable;
  const observed = field.observed;

  if (acceptable.range && observed.range) {
    const low = observed.range.min;
    const high = observed.range.max;
    const outside: string[] = [];
    if (low != null && !rangeContains(acceptable.range, low)) outside.push(String(low));
    if (high != null && high !== low && !rangeContains(acceptable.range, high)) outside.push(String(high));
    if (outside.length) {
      issues.push(
        finding({
          severity: 'warn',
          code: 'DICT_OBSERVED_OUTSIDE_RANGE',
          label: 'Existing values outside declared range',
          detail: `${field.name} declares ${acceptable.range.raw} but existing values reach ${observed.range.raw}.`,
          location,
          field: field.name,
          rawValue: observed.range.raw
        })
      );
    }
  }

  if (acceptable.yearSpan && !acceptable.yearSpan.openEnded && acceptable.yearSpan.to != null) {
    const years = yearsIn(field);
    const outside = years.filter((year) => year < acceptable.yearSpan!.from || year > acceptable.yearSpan!.to!);
    if (outside.length) {
      issues.push(
        finding({
          severity: 'warn',
          code: 'DICT_OBSERVED_OUTSIDE_RANGE',
          label: 'Existing dates outside declared years',
          detail: `${field.name} declares ${acceptable.yearSpan.raw} but existing values include ${preview(
            outside.map(String)
          )}.`,
          location,
          field: field.name,
          rawValue: preview(outside.map(String))
        })
      );
    }
  }

  if (acceptable.kind === 'prose' || acceptable.kind === 'empty' || acceptable.kind === 'range') {
    const missingness = observed.tokens.filter((token) => isMissingnessKey(token.key));
    const unexpected = observed.tokens.filter(
      (token) => !isMissingnessKey(token.key) && !/^-?\d+(?:\.\d+)?$/.test(token.raw.trim())
    );
    if (missingness.length) {
      issues.push(
        finding({
          severity: 'warn',
          code: 'DICT_OBSERVED_NOT_IN_DOMAIN',
          label: 'Existing values include undeclared missingness',
          detail: `${field.name} existing values include ${preview(missingness.map((t) => t.raw))}, which is not in the acceptable set.`,
          location,
          field: field.name,
          rawValue: preview(missingness.map((t) => t.raw))
        })
      );
    }
    if (acceptable.kind === 'range' && unexpected.length) {
      issues.push(
        finding({
          severity: 'warn',
          code: 'DICT_OBSERVED_NOT_IN_DOMAIN',
          label: 'Existing values are not in the numeric range',
          detail: `${field.name} declares ${acceptable.range?.raw ?? 'a numeric range'} but existing values include ${preview(
            unexpected.map((t) => t.raw)
          )}.`,
          location,
          field: field.name,
          rawValue: preview(unexpected.map((t) => t.raw))
        })
      );
    }
    return issues;
  }

  const uncovered = observed.tokens.filter((token) => {
    if (acceptable.range && /^-?\d+(?:\.\d+)?$/.test(token.raw.trim())) {
      return !rangeContains(acceptable.range, Number(token.raw));
    }
    return !specCoversToken(acceptable, token);
  });
  if (uncovered.length) {
    const missingness = uncovered.filter((token) => isMissingnessKey(token.key));
    issues.push(
      finding({
        severity: 'warn',
        code: 'DICT_OBSERVED_NOT_IN_DOMAIN',
        label: 'Existing values outside acceptable set',
        detail: `${field.name} existing values not declared as acceptable: ${preview(uncovered.map((t) => t.raw))}${
          missingness.length ? ' (includes missingness markers)' : ''
        }.`,
        location,
        field: field.name,
        rawValue: preview(uncovered.map((t) => t.raw))
      })
    );
  }
  return issues;
}

function auditDates(field: DictionaryField, location: string): CheckIssue[] {
  if (field.scalarType !== 'date') return [];
  const declared = declaredDatePattern(field.format);
  if (!declared) return [];
  const tokens = observedDateTokens(field.observedRaw);
  if (!tokens.length) return [];

  const issues: CheckIssue[] = [];
  const orderConflicts: string[] = [];
  const invalid: string[] = [];
  const separators = new Set(tokens.map((token) => token.separator));

  for (const token of tokens) {
    if (token.yearFirst && declared.order !== 'YMD') {
      orderConflicts.push(token.raw);
      continue;
    }
    if (!token.yearFirst && declared.order === 'YMD') {
      orderConflicts.push(token.raw);
      continue;
    }
    const month = monthPart(token, declared.order);
    const day = dayPart(token, declared.order);
    if (month == null || day == null) continue;
    if (month > 12 && day <= 12) orderConflicts.push(token.raw);
    else if (month > 12 || day > 31 || month < 1 || day < 1) invalid.push(token.raw);
  }

  if (orderConflicts.length) {
    issues.push(
      finding({
        severity: 'error',
        code: 'DICT_DATE_ORDER_CONFLICT',
        label: 'Date sample contradicts declared order',
        detail: `${field.name} declares ${declared.patternKey} but existing values include ${preview(
          orderConflicts
        )}, which only fits the opposite day/month order.`,
        location,
        field: field.name,
        rawValue: preview(orderConflicts)
      })
    );
  }
  if (invalid.length) {
    issues.push(
      finding({
        severity: 'error',
        code: 'DICT_DATE_INVALID',
        label: 'Date sample is not a calendar date',
        detail: `${field.name} existing values include ${preview(invalid)}.`,
        location,
        field: field.name,
        rawValue: preview(invalid)
      })
    );
  }
  if ([...separators].some((sep) => sep !== declared.separator && sep !== '.')) {
    issues.push(
      finding({
        severity: 'warn',
        code: 'DICT_DATE_SEPARATOR',
        label: 'Date sample uses a different separator',
        detail: `${field.name} declares separator "${declared.separator}" but existing values use ${preview(
          [...separators]
        )}.`,
        location,
        field: field.name,
        rawValue: preview([...separators])
      })
    );
  }
  return issues;
}

function auditSheets(doc: DataDictionaryDocument): CheckIssue[] {
  const issues: CheckIssue[] = [];
  for (const sheet of doc.sheets) {
    if (sheet.role === 'ignored') {
      issues.push(
        finding({
          severity: 'warn',
          code: 'DICT_IGNORED_SHEET',
          label: 'Sheet is not a dictionary',
          detail: `"${sheet.name}" was skipped. ${sheet.detail}`,
          location: sheet.name
        })
      );
    }
    if (sheet.role === 'value-list' && sheet.duplicateValues?.length) {
      issues.push(
        finding({
          severity: 'warn',
          code: 'DICT_COMPANION_DUPLICATE',
          label: 'Value list repeats a code',
          detail: `Sheet "${sheet.name}" repeats ${preview(sheet.duplicateValues)}.`,
          location: sheet.name,
          rawValue: preview(sheet.duplicateValues)
        })
      );
    }
    if (sheet.role === 'value-list' && sheet.values?.length) {
      issues.push(...companionDrift(doc, sheet.name, sheet.values));
    }
  }
  return issues;
}

function companionDrift(doc: DataDictionaryDocument, sheetName: string, values: string[]): CheckIssue[] {
  let best: DictionaryField | null = null;
  let bestScore = 0;
  for (const field of doc.fields) {
    const known = new Set<string>();
    for (const token of [...field.acceptable.tokens, ...field.observed.tokens]) {
      for (const key of token.keys) known.add(key);
    }
    if (!known.size) continue;
    const score = values.filter((value) => known.has(normKey(value))).length / values.length;
    if (score > bestScore) {
      best = field;
      bestScore = score;
    }
  }
  if (!best || bestScore < 0.34) return [];
  const uncovered = values.filter((value) => {
    const token = { raw: value, key: normKey(value), keys: [normKey(value)], forms: [value] };
    if (best!.acceptable.range && /^-?\d+(?:\.\d+)?$/.test(value)) {
      return !rangeContains(best!.acceptable.range, Number(value));
    }
    if (best!.acceptable.kind === 'prose' || best!.acceptable.kind === 'empty') return false;
    return !specCoversToken(best!.acceptable, token);
  });
  if (!uncovered.length) return [];
  return [
    finding({
      severity: 'warn',
      code: 'DICT_COMPANION_DRIFT',
      label: 'Side list drifts from acceptable values',
      detail: `Sheet "${sheetName}" overlaps ${best.name}, but ${preview(
        uncovered
      )} is not in that field's acceptable set.`,
      location: sheetName,
      field: best.name,
      rawValue: preview(uncovered)
    })
  ];
}

function yearsIn(field: DictionaryField): number[] {
  const years = new Set<number>();
  const declared = declaredDatePattern(field.format);
  const order = declared?.order ?? 'MDY';
  for (const token of observedDateTokens(field.observedRaw)) {
    const year = yearPart(token, order);
    if (year != null) years.add(year);
  }
  if (field.observed.yearSpan) {
    years.add(field.observed.yearSpan.from);
    if (field.observed.yearSpan.to != null) years.add(field.observed.yearSpan.to);
  }
  return [...years];
}

function preview(values: string[]): string {
  const unique = [...new Set(values.map((v) => v.trim()).filter(Boolean))];
  const head = unique.slice(0, EXAMPLE_LIMIT);
  const extra = unique.length - head.length;
  return head.map((v) => `"${v}"`).join(', ') + (extra > 0 ? ` (+${extra} more)` : '');
}

function clip(value: string): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > 80 ? `${flat.slice(0, 77)}...` : flat;
}

function finding(input: {
  severity: 'error' | 'warn';
  code: string;
  label: string;
  detail: string;
  location: string;
  field?: string;
  rawValue?: string;
}): CheckIssue {
  return {
    severity: input.severity,
    code: input.code,
    label: input.label,
    detail: input.detail,
    location: input.location,
    field: input.field,
    rawValue: input.rawValue,
    category: categoryFor(input.code),
    suiteId: suiteFor(input.code)
  };
}

function suiteFor(code: string): string {
  if (
    code.startsWith('DICT_OBSERVED') ||
    code.startsWith('DICT_DATE') ||
    code.startsWith('DICT_COMPANION') ||
    code === 'DICT_UNCODED_DOMAIN' ||
    code === 'DICT_DUPLICATE_TOKEN'
  ) {
    return 'dictionary-domain';
  }
  return 'dictionary-structure';
}

function categoryFor(code: string): CheckIssue['category'] {
  if (code.startsWith('DICT_DATE')) return 'datetime';
  if (code.startsWith('DICT_OBSERVED') || code.startsWith('DICT_COMPANION') || code === 'DICT_DUPLICATE_TOKEN') {
    return 'vocabulary';
  }
  if (code === 'DICT_MISSING_DESCRIPTION' || code === 'DICT_UNBOUNDED_TEXT' || code === 'DICT_UNCODED_DOMAIN') {
    return 'completeness';
  }
  return 'structure';
}
