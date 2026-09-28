/**
 * In-memory model of a study data-dictionary workbook.
 *
 * These workbooks (cervical / ovarian SEARCH dictionaries are the reference
 * shape, not a fixed schema) are field catalogues, not patient-level datasets.
 * A typical sheet has:
 *
 * - a category column, often merged down across a block of rows
 * - a blank index column (1, 2, 3, …) with no header
 * - the field name, definition, data type, and format
 * - an acceptable-value / range column and a separate "existing values" column
 * - units, default, required, and whether null is accepted
 *
 * Header wording differs slightly between versions (`Data Fields` vs
 * `Data Field`, `Data Fields Category` vs `Data Field Category`). Parsing is
 * driven by those header roles, not by a hardcoded field list.
 */

/** How a value cell was interpreted. */
export type DictionaryValueKind = 'empty' | 'enumerated' | 'range' | 'prose' | 'mixed';

/** Scalar type used when the dictionary is compiled into validation rules. */
export type DictionaryScalarType =
  | 'date'
  | 'integer'
  | 'number'
  | 'boolean'
  | 'code'
  | 'text'
  | 'unknown';

/** Inclusive or exclusive numeric window parsed from a range cell. */
export interface DictionaryNumericRange {
  min?: number;
  max?: number;
  minInclusive: boolean;
  maxInclusive: boolean;
  /** Original line, kept for messages. */
  raw: string;
}

/**
 * Year window written in a date field's acceptable-value cell,
 * for example `2015-2018` or `2015-Present`. This is not a numeric
 * min/max on the date string itself.
 */
export interface DictionaryYearSpan {
  from: number;
  to?: number;
  openEnded: boolean;
  raw: string;
}

/** One line from an acceptable-value or existing-value cell. */
export interface DictionaryValueToken {
  raw: string;
  /** Comparison key: trimmed, lowercased, underscores treated as spaces. */
  key: string;
  /**
   * Keys that should count as a match: the line itself, slash-separated
   * synonyms (`Neg / negative`), and a leading code (`P2` from `P2 - Negative`).
   */
  keys: string[];
  /**
   * Spellings that satisfy the line: the full line, a leading code, and
   * slash-separated synonyms. Original case is preserved for compiled configs.
   */
  forms: string[];
  /** Leading code when the line is `CODE - label`. */
  code?: string;
}

/** Parsed contents of one dictionary value cell. */
export interface DictionaryValueSpec {
  kind: DictionaryValueKind;
  tokens: DictionaryValueToken[];
  range?: DictionaryNumericRange;
  yearSpan?: DictionaryYearSpan;
}

/** One catalogue row after category fill-down and header mapping. */
export interface DictionaryField {
  sheet: string;
  /** 1-based worksheet row. */
  rowNumber: number;
  category: string;
  index?: number;
  /** Trimmed name. This becomes the canonical column header in a compiled config. */
  name: string;
  /** Original cell text, including padding the audit can flag. */
  rawName: string;
  description: string;
  dataType: string;
  format: string;
  units: string;
  defaultValue: string;
  required: boolean | null;
  requiredRaw: string;
  acceptsNull: boolean | null;
  acceptsNullRaw: string;
  scalarType: DictionaryScalarType;
  acceptable: DictionaryValueSpec;
  observed: DictionaryValueSpec;
  acceptableRaw: string;
  observedRaw: string;
}

/** What the parser decided a worksheet is for. */
export type DictionarySheetRole = 'dictionary' | 'value-list' | 'empty' | 'ignored';

export interface DictionarySheetInfo {
  name: string;
  role: DictionarySheetRole;
  detail: string;
  /** Unique cell values, only for `value-list` sheets. */
  values?: string[];
  /** Values that appeared more than once in a value-list sheet. */
  duplicateValues?: string[];
}

/** A workbook reduced to dictionary sheets plus any side value lists. */
export interface DataDictionaryDocument {
  fileName: string;
  fields: DictionaryField[];
  sheets: DictionarySheetInfo[];
}

/** Stable location used as the record id in audit reports. */
export function dictionaryRecordKey(field: Pick<DictionaryField, 'category' | 'rowNumber'>): string {
  const category = field.category.trim() || 'Uncategorized';
  return `${category}/row/${field.rowNumber}`;
}
