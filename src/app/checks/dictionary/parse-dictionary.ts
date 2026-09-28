/**
 * Turns a workbook into a {@link DataDictionaryDocument}.
 *
 * Header cells are matched by role (`field name`, `data type`, `required`, …),
 * so small wording differences between dictionary versions still parse.
 * The column between category and field name is treated as the row index when
 * its header is blank and its body is numeric — that is how these workbooks
 * are laid out. Merged category cells are already expanded by the xlsx reader;
 * a blank category cell still inherits the previous category for sheets that
 * left the merge out.
 */

import type { DataDictionaryDocument, DictionaryField, DictionaryScalarType, DictionarySheetInfo } from './types';
import type { XlsxSheet } from './xlsx-reader';
import { readXlsxWorkbook, sheetCell } from './xlsx-reader';
import { isBlankMarker, parseValueSpec, type ValueSpecHint } from './value-spec';

type ColumnRole =
  | 'category'
  | 'index'
  | 'name'
  | 'description'
  | 'dataType'
  | 'format'
  | 'acceptable'
  | 'observed'
  | 'units'
  | 'defaultValue'
  | 'required'
  | 'acceptsNull';

const HEADER_SCAN_ROWS = 25;

/**
 * Parse an .xlsx data dictionary.
 * @throws Error when the bytes are not a readable workbook.
 *         An empty catalogue is returned (not thrown) when no sheet has a
 *         recognisable header; the audit reports that as a finding.
 */
export function parseDataDictionary(bytes: Uint8Array, fileName: string): DataDictionaryDocument {
  const workbook = readXlsxWorkbook(bytes);
  const sheets: DictionarySheetInfo[] = [];
  const fields: DictionaryField[] = [];

  for (const sheet of workbook.sheets) {
    const header = findHeader(sheet);
    if (header && header.score >= 3 && header.roles.name != null) {
      const parsed = parseDictionarySheet(sheet, header);
      fields.push(...parsed);
      sheets.push({
        name: sheet.name,
        role: 'dictionary',
        detail: `${parsed.length} field${parsed.length === 1 ? '' : 's'} from row ${header.rowNumber}.`
      });
      continue;
    }
    const values = columnValues(sheet);
    if (!values.length) {
      sheets.push({ name: sheet.name, role: 'empty', detail: 'Sheet has no cell values.' });
      continue;
    }
    if (isValueList(sheet, values)) {
      const { uniqueValues, duplicateValues } = splitDuplicates(values);
      sheets.push({
        name: sheet.name,
        role: 'value-list',
        detail: `${uniqueValues.length} values in a side list (not a second dictionary).`,
        values: uniqueValues,
        duplicateValues
      });
      continue;
    }
    sheets.push({
      name: sheet.name,
      role: 'ignored',
      detail: 'Sheet has no data-dictionary header and is not a single-column value list.'
    });
  }

  return { fileName, fields, sheets };
}

interface HeaderHit {
  rowNumber: number;
  score: number;
  roles: Partial<Record<ColumnRole, number>>;
}

function findHeader(sheet: XlsxSheet): HeaderHit | null {
  let best: HeaderHit | null = null;
  const last = Math.min(sheet.maxRow, HEADER_SCAN_ROWS);
  for (let row = 1; row <= last; row++) {
    const roles: Partial<Record<ColumnRole, number>> = {};
    for (let col = 1; col <= sheet.maxCol; col++) {
      const role = roleForHeader(normHeader(sheetCell(sheet, row, col)));
      if (role && roles[role] == null) roles[role] = col;
    }
    if (roles.name == null) continue;
    const score = Object.keys(roles).length;
    if (!best || score > best.score) best = { rowNumber: row, score, roles };
  }
  if (!best) return null;
  assignIndexColumn(sheet, best);
  return best;
}

/**
 * The index column is usually headerless. When it sits immediately left of
 * the field name and the rows under it are integers, map it as `index`.
 */
function assignIndexColumn(sheet: XlsxSheet, header: HeaderHit): void {
  if (header.roles.index != null || header.roles.name == null) return;
  const candidate = header.roles.name - 1;
  if (candidate < 1) return;
  const headerText = normHeader(sheetCell(sheet, header.rowNumber, candidate));
  if (headerText) return;
  let numeric = 0;
  let seen = 0;
  const last = Math.min(sheet.maxRow, header.rowNumber + 12);
  for (let row = header.rowNumber + 1; row <= last; row++) {
    const value = sheetCell(sheet, row, candidate).trim();
    if (!value) continue;
    seen++;
    if (/^\d+$/.test(value)) numeric++;
  }
  if (seen >= 2 && numeric >= seen - 1) header.roles.index = candidate;
}

function parseDictionarySheet(sheet: XlsxSheet, header: HeaderHit): DictionaryField[] {
  const fields: DictionaryField[] = [];
  let category = '';
  for (let row = header.rowNumber + 1; row <= sheet.maxRow; row++) {
    const read = (role: ColumnRole): string => {
      const col = header.roles[role];
      return col ? sheetCell(sheet, row, col) : '';
    };
    const categoryCell = read('category').trim();
    if (categoryCell) category = categoryCell;
    const rawName = read('name');
    const description = read('description').trim();
    const dataType = read('dataType').trim();
    const format = read('format').trim();
    const acceptableRaw = read('acceptable');
    const observedRaw = read('observed');
    const units = read('units').trim();
    const defaultValue = read('defaultValue').trim();
    const requiredRaw = read('required').trim();
    const acceptsNullRaw = read('acceptsNull').trim();
    const indexRaw = read('index').trim();

    const blankRow =
      !rawName.trim() &&
      !description &&
      !dataType &&
      !format &&
      !acceptableRaw.trim() &&
      !observedRaw.trim() &&
      !requiredRaw &&
      !indexRaw;
    if (blankRow) continue;

    const scalarType = classifyScalar(dataType, format);
    const hint = hintFor(scalarType);
    const required = parseFlag(requiredRaw);
    const acceptsNull = parseFlag(acceptsNullRaw);
    const index = /^\d+$/.test(indexRaw) ? Number(indexRaw) : undefined;

    fields.push({
      sheet: sheet.name,
      rowNumber: row,
      category: category || 'Uncategorized',
      index,
      name: rawName.trim().replace(/\s+/g, ' '),
      rawName,
      description,
      dataType,
      format,
      units,
      defaultValue,
      required,
      requiredRaw,
      acceptsNull,
      acceptsNullRaw,
      scalarType,
      acceptable: parseValueSpec(acceptableRaw, hint),
      observed: parseValueSpec(observedRaw, hint),
      acceptableRaw,
      observedRaw
    });
  }
  return fields;
}

function classifyScalar(dataType: string, format: string): DictionaryScalarType {
  const type = dataType.toLowerCase();
  const fmt = format.toLowerCase();
  if (/bool/.test(fmt) || /\bbool/.test(type)) return 'boolean';
  if (/date|time/.test(type) || /\bdate\b/.test(fmt)) return 'date';
  if (/free\s*text|\btext\b|narrative|string/.test(type)) return 'text';
  if (/float|decimal|double/.test(fmt)) return 'number';
  if (/int/.test(fmt)) return 'integer';
  if (/numeric|numerical|number/.test(type)) return /float|decimal/.test(fmt) ? 'number' : 'integer';
  if (/categor/.test(type) || /varchar|\bchar\s*\(/.test(fmt)) return 'code';
  return 'unknown';
}

function hintFor(scalar: DictionaryScalarType): ValueSpecHint {
  if (scalar === 'date') return 'date';
  if (scalar === 'integer' || scalar === 'number') return 'quantity';
  return 'category';
}

/** `Yes` / `No` and common aliases. Unrecognised text returns null. */
function parseFlag(raw: string): boolean | null {
  if (isBlankMarker(raw)) return null;
  const key = raw.trim().toLowerCase();
  if (['yes', 'y', 'true', '1'].includes(key)) return true;
  if (['no', 'n', 'false', '0'].includes(key)) return false;
  return null;
}

function isValueList(sheet: XlsxSheet, values: string[]): boolean {
  if (values.length < 3) return false;
  let wide = 0;
  for (let row = 1; row <= sheet.maxRow; row++) {
    let filled = 0;
    for (let col = 1; col <= sheet.maxCol; col++) {
      if (sheetCell(sheet, row, col).trim()) filled++;
    }
    if (filled > 1) wide++;
  }
  return wide <= 1;
}

function columnValues(sheet: XlsxSheet): string[] {
  const values: string[] = [];
  for (let row = 1; row <= sheet.maxRow; row++) {
    for (let col = 1; col <= sheet.maxCol; col++) {
      const value = sheetCell(sheet, row, col).trim();
      if (value) values.push(value);
    }
  }
  return values;
}

function splitDuplicates(values: string[]): { uniqueValues: string[]; duplicateValues: string[] } {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  const uniqueValues: string[] = [];
  for (const value of values) {
    const key = value.trim().toLowerCase();
    if (seen.has(key)) {
      dupes.add(value.trim());
      continue;
    }
    seen.add(key);
    uniqueValues.push(value.trim());
  }
  return { uniqueValues, duplicateValues: [...dupes] };
}

function normHeader(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function roleForHeader(header: string): ColumnRole | null {
  if (!header) return null;
  if (
    header === 'datafieldcategory' ||
    header === 'datafieldscategory' ||
    header === 'fieldcategory' ||
    header === 'category'
  ) {
    return 'category';
  }
  if (
    header === 'datafield' ||
    header === 'datafields' ||
    header === 'fieldname' ||
    header === 'variablename' ||
    header === 'variable' ||
    header === 'columnname' ||
    header === 'field'
  ) {
    return 'name';
  }
  if (header === 'descriptiondefinition' || header.includes('description') || header === 'definition') {
    return 'description';
  }
  if (header === 'datatype' || header === 'type') return 'dataType';
  if (header.includes('format') || header.includes('characterlength')) return 'format';
  if (header.includes('acceptable') || header.includes('valuerange') || header.includes('permissible')) {
    return 'acceptable';
  }
  if (header.includes('existingvalue') || header.includes('observedvalue') || header === 'observed') {
    return 'observed';
  }
  if (header.includes('unit')) return 'units';
  if (header.includes('default')) return 'defaultValue';
  if (header === 'required' || header.startsWith('required')) return 'required';
  if (header.includes('null')) return 'acceptsNull';
  if (header === 'no' || header === 'number' || header === 'index' || header === 'seq' || header === 'fieldno') {
    return 'index';
  }
  return null;
}
