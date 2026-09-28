/**
 * Minimal OOXML (.xlsx) reader for data-dictionary workbooks.
 *
 * The file is a ZIP of XML. This reader uses `fflate` to unzip and then
 * reads only the subset these catalogues need:
 *
 * - workbook sheet names and their worksheet parts
 * - shared strings, including rich-text runs (`<r><t>…</t></r>`)
 * - inline strings and numeric cached values
 * - merged cells (category labels are stored only on the top-left cell)
 *
 * Formulas are not evaluated. When Excel has stored a cached `<v>`, that
 * value is used. Password-protected workbooks and legacy `.xls` files are
 * rejected with an explicit error.
 */

import { strFromU8, unzipSync } from 'fflate';

export interface XlsxSheet {
  name: string;
  /** 1-based row → 1-based column → display text. */
  cells: Map<number, Map<number, string>>;
  maxRow: number;
  maxCol: number;
}

export interface XlsxWorkbook {
  sheets: XlsxSheet[];
}

/** True when `bytes` starts with the ZIP local-file signature used by .xlsx. */
export function isXlsxBytes(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b;
}

export function isExcelWorkbookName(fileName: string): boolean {
  return /\.xlsx$/i.test(fileName);
}

/**
 * Read every worksheet. Sheet order follows the workbook, not the ZIP order.
 * @throws Error when the package is not a readable xlsx workbook.
 */
export function readXlsxWorkbook(bytes: Uint8Array): XlsxWorkbook {
  if (!isXlsxBytes(bytes)) {
    throw new Error('Not an .xlsx workbook. Legacy .xls files are not supported.');
  }

  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch {
    throw new Error('Could not unzip the workbook. The file may be corrupt or password-protected.');
  }

  const workbookXml = zipText(files, 'xl/workbook.xml');
  if (!workbookXml) {
    throw new Error('Workbook is missing xl/workbook.xml.');
  }
  const relsXml = zipText(files, 'xl/_rels/workbook.xml.rels') ?? '';
  const shared = parseSharedStrings(zipText(files, 'xl/sharedStrings.xml') ?? '');
  const targets = parseRelationships(relsXml);

  const sheets: XlsxSheet[] = [];
  const sheetRe = /<sheet\b([^>]*)\/?>/g;
  let match: RegExpExecArray | null;
  while ((match = sheetRe.exec(workbookXml))) {
    const tag = match[1];
    const name = attr(tag, 'name') ?? `Sheet${sheets.length + 1}`;
    const relId = attr(tag, 'r:id') ?? attr(tag, 'id');
    const target = relId ? targets.get(relId) : undefined;
    if (!target) continue;
    const path = resolveWorkbookTarget(target);
    const sheetXml = zipText(files, path);
    if (!sheetXml) continue;
    sheets.push(parseWorksheet(name, sheetXml, shared));
  }

  if (!sheets.length) {
    throw new Error('Workbook does not contain a readable worksheet.');
  }
  return { sheets };
}

export function sheetCell(sheet: XlsxSheet, row: number, col: number): string {
  return sheet.cells.get(row)?.get(col) ?? '';
}

function zipText(files: Record<string, Uint8Array>, path: string): string | null {
  const want = path.replace(/^\/+/, '');
  const key = Object.keys(files).find((entry) => entry.replace(/^\/+/, '') === want);
  if (!key) return null;
  return strFromU8(files[key]);
}

function resolveWorkbookTarget(target: string): string {
  const cleaned = target.replace(/^\/+/, '');
  if (cleaned.startsWith('xl/')) return cleaned;
  return `xl/${cleaned}`;
}

function parseRelationships(xml: string): Map<string, string> {
  const map = new Map<string, string>();
  const re = /<Relationship\b([^>]*)\/?>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml))) {
    const id = attr(match[1], 'Id');
    const target = attr(match[1], 'Target');
    if (id && target) map.set(id, target);
  }
  return map;
}

/**
 * Shared-string table. Rich text is concatenated in document order so a
 * value list split across runs (`P0` + newline + `P1` …) stays one cell.
 */
function parseSharedStrings(xml: string): string[] {
  if (!xml) return [];
  const out: string[] = [];
  const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let match: RegExpExecArray | null;
  while ((match = siRe.exec(xml))) {
    const texts: string[] = [];
    const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
    let text: RegExpExecArray | null;
    while ((text = tRe.exec(match[1]))) {
      texts.push(decodeXml(text[1]));
    }
    out.push(texts.join(''));
  }
  return out;
}

function parseWorksheet(name: string, xml: string, shared: string[]): XlsxSheet {
  const cells = new Map<number, Map<number, string>>();
  let maxRow = 0;
  let maxCol = 0;

  const rowRe = /<row\b([^>]*)>([\s\S]*?)<\/row>/g;
  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowRe.exec(xml))) {
    const rowNumber = Number(attr(rowMatch[1], 'r') ?? '0');
    if (!rowNumber) continue;
    const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cellMatch: RegExpExecArray | null;
    while ((cellMatch = cellRe.exec(rowMatch[2]))) {
      const attrs = cellMatch[1];
      const inner = cellMatch[2] ?? '';
      const ref = attr(attrs, 'r');
      const parsedRef = ref ? parseCellRef(ref) : null;
      const col = parsedRef?.col;
      const row = parsedRef?.row ?? rowNumber;
      if (!col) continue;
      const value = cellValue(attrs, inner, shared);
      if (!value) continue;
      let rowMap = cells.get(row);
      if (!rowMap) {
        rowMap = new Map();
        cells.set(row, rowMap);
      }
      rowMap.set(col, value);
      if (row > maxRow) maxRow = row;
      if (col > maxCol) maxCol = col;
    }
  }

  applyMerges(xml, cells, (row, col) => {
    if (row > maxRow) maxRow = row;
    if (col > maxCol) maxCol = col;
  });

  return { name, cells, maxRow, maxCol };
}

/**
 * Category labels live in a merged range (`A2:A25`) but the value is stored
 * only on the first cell. Copy that value through the rectangle.
 */
function applyMerges(
  xml: string,
  cells: Map<number, Map<number, string>>,
  onExpand: (row: number, col: number) => void
): void {
  const re = /<mergeCell\b[^>]*ref="([A-Z]+)(\d+):([A-Z]+)(\d+)"/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml))) {
    const colStart = columnNumber(match[1]);
    const rowStart = Number(match[2]);
    const colEnd = columnNumber(match[3]);
    const rowEnd = Number(match[4]);
    const value = cells.get(rowStart)?.get(colStart) ?? '';
    if (!value) continue;
    for (let row = rowStart; row <= rowEnd; row++) {
      for (let col = colStart; col <= colEnd; col++) {
        let rowMap = cells.get(row);
        if (!rowMap) {
          rowMap = new Map();
          cells.set(row, rowMap);
        }
        if (!rowMap.has(col)) rowMap.set(col, value);
        onExpand(row, col);
      }
    }
  }
}

function cellValue(attrs: string, inner: string, shared: string[]): string {
  const type = attr(attrs, 't') ?? '';
  if (type === 'inlineStr') {
    const texts: string[] = [];
    const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
    let text: RegExpExecArray | null;
    while ((text = tRe.exec(inner))) texts.push(decodeXml(text[1]));
    return normalizeCell(texts.join(''));
  }
  const raw = inner.match(/<v\b[^>]*>([\s\S]*?)<\/v>/);
  if (!raw) return '';
  const decoded = decodeXml(raw[1]).trim();
  if (type === 's') {
    const index = Number(decoded);
    return normalizeCell(shared[index] ?? '');
  }
  return normalizeCell(decoded);
}

function normalizeCell(value: string): string {
  return value.replace(/\u00a0/g, ' ').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function parseCellRef(ref: string): { row: number; col: number } | null {
  const match = /^([A-Z]+)(\d+)$/i.exec(ref.trim());
  if (!match) return null;
  return { col: columnNumber(match[1]), row: Number(match[2]) };
}

function columnNumber(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) {
    n = n * 26 + (ch.charCodeAt(0) - 64);
  }
  return n;
}

function attr(tag: string, name: string): string | undefined {
  const re = new RegExp(`(?:^|\\s)${name.replace(':', '\\:')}="([^"]*)"`, 'i');
  const match = tag.match(re);
  return match ? decodeXml(match[1]) : undefined;
}

function decodeXml(value: string): string {
  return value
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}
