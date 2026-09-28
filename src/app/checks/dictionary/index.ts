/**
 * Excel data-dictionary support for the Data Curation Checker.
 *
 * Public entry points:
 *
 * - {@link parseDataDictionary} — workbook bytes to a field catalogue
 * - {@link auditDataDictionary} — syntactic findings on that catalogue
 * - {@link compileDataDictionary} — catalogue to a CSV validation config
 * - {@link runDictionaryWorkbookCheck} — full quality-gate report
 */

export type {
  DataDictionaryDocument,
  DictionaryField,
  DictionarySheetInfo,
  DictionaryScalarType,
  DictionaryValueSpec
} from './types';
export { dictionaryRecordKey } from './types';
export { isExcelWorkbookName, isXlsxBytes, readXlsxWorkbook } from './xlsx-reader';
export { parseDataDictionary } from './parse-dictionary';
export { auditDataDictionary } from './audit-dictionary';
export { compileDataDictionary } from './compile-config';
export { compileDictionaryWorkbook, runDictionaryWorkbookCheck } from './run-dictionary-check';
