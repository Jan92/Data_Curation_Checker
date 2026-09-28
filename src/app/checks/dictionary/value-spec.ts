/**
 * Interprets the free-text "acceptable values" and "existing values" cells
 * used in study data dictionaries.
 *
 * A cell is not always a code list. The same column also holds:
 *
 * - newline-separated codes, sometimes written `CODE - label`
 * - slash synonyms with spaces (`Not detected/ negative/Neg`)
 * - numeric windows (`18-90`, `>18`, `>=0`, `>-10`, `Positive Float`)
 * - year windows on date fields (`2015-2018`, `2015-Present`)
 * - prose placeholders (`Free text`, `Histology SNOMED Morphology codes`)
 * - a range plus missingness notes (`0-23` and `Not Applicable`)
 *
 * Comparison keys lowercase the text and treat underscores as spaces, so
 * `Not_Performed` and `Not Performed` match. Clinical phrases are not fuzzy-matched.
 */

import type {
  DictionaryNumericRange,
  DictionaryValueSpec,
  DictionaryValueToken,
  DictionaryYearSpan
} from './types';

/** Hint from the field's data type. Changes how `2015-2018` is read. */
export type ValueSpecHint = 'date' | 'quantity' | 'category';

const MISSINGNESS_KEYS = new Set([
  'blank',
  'blanks',
  'empty',
  'na',
  'n/a',
  'unknown',
  'not applicable',
  'not documented',
  'null',
  'missing'
]);

const PLACEHOLDER_KEYS = new Set([
  'categorical',
  'free text',
  'freetext',
  'text',
  'string',
  'varchar',
  'tbd',
  'todo',
  'see description'
]);

/**
 * Comparison key. Underscores become spaces; case and surrounding space do not matter.
 * Slashes and parentheses are kept so codes like `IIA1(i)` stay intact.
 */
export function normKey(value: string): string {
  return value
    .replace(/\u00a0/g, ' ')
    .replace(/_/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

export function isMissingnessKey(key: string): boolean {
  return MISSINGNESS_KEYS.has(key);
}

export function isBlankMarker(value: string): boolean {
  const key = normKey(value);
  return key === '' || key === 'na' || key === 'n/a' || key === 'none' || key === '-' || key === '—';
}

export function parseValueSpec(raw: string, hint: ValueSpecHint): DictionaryValueSpec {
  const lines = splitLines(raw);
  if (!lines.length) {
    return { kind: 'empty', tokens: [] };
  }

  const tokens: DictionaryValueToken[] = [];
  let range: DictionaryNumericRange | undefined;
  let yearSpan: DictionaryYearSpan | undefined;
  let prose = false;

  for (const line of lines) {
    const year = parseYearSpan(line);
    if (year && (hint === 'date' || looksLikeYearPair(year))) {
      yearSpan = year;
      continue;
    }
    const numeric = parseNumericRange(line);
    if (numeric) {
      range = numeric;
      continue;
    }
    if (isProseLine(line)) {
      prose = true;
      tokens.push(makeToken(line));
      continue;
    }
    tokens.push(makeToken(line));
  }

  if (yearSpan && !range && !tokens.length) {
    return { kind: 'prose', tokens: [], yearSpan };
  }
  if (prose && !range && tokens.length === lines.length) {
    return { kind: 'prose', tokens, yearSpan };
  }
  if (range && tokens.length) return { kind: 'mixed', tokens, range, yearSpan };
  if (range) return { kind: 'range', tokens, range, yearSpan };
  if (!tokens.length && yearSpan) return { kind: 'prose', tokens, yearSpan };
  return { kind: 'enumerated', tokens, yearSpan };
}

/** True when any acceptable key covers this observed token (synonym or leading code). */
export function specCoversToken(spec: DictionaryValueSpec, token: DictionaryValueToken): boolean {
  const accepted = new Set<string>();
  for (const item of spec.tokens) {
    for (const key of item.keys) accepted.add(key);
  }
  return token.keys.some((key) => accepted.has(key));
}

export function rangeContains(range: DictionaryNumericRange, value: number): boolean {
  if (range.min != null) {
    if (range.minInclusive ? value < range.min : value <= range.min) return false;
  }
  if (range.max != null) {
    if (range.maxInclusive ? value > range.max : value >= range.max) return false;
  }
  return true;
}

function splitLines(raw: string): string[] {
  return raw
    .split(/\n|;\s*/g)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function makeToken(line: string): DictionaryValueToken {
  const codeMatch = /^([A-Za-z0-9][A-Za-z0-9().]{0,14})\s+-\s+\S/.exec(line);
  const code = codeMatch ? codeMatch[1] : undefined;
  // A spaced slash marks synonyms (`Not detected/ negative/Neg`).
  // `HPV18/45` has no space and stays one token.
  const parts = code || !/\/\s|\s\//.test(line) ? [line] : line.split(/\s*\/\s*/).map((p) => p.trim()).filter(Boolean);
  const forms = [...new Set([line, ...parts, ...(code ? [code] : [])])];
  const keys = [...new Set(forms.map(normKey))].filter(Boolean);
  return { raw: line, key: normKey(line), keys, forms, code };
}

function isProseLine(line: string): boolean {
  const key = normKey(line);
  if (PLACEHOLDER_KEYS.has(key)) return true;
  if (/snomed|morpholog|free[- ]text/i.test(line)) return true;
  // A long sentence is an instruction, not a code. Short multi-word names
  // ("Cobas 6800, 8800 HPV Test High Risk") stay in the value list.
  const words = line.split(/\s+/);
  return words.length >= 12 && !/^[A-Za-z0-9().]+\s+-\s+/.test(line);
}

function parseYearSpan(line: string): DictionaryYearSpan | null {
  const match = /^((?:19|20)\d{2})\s*[-–—]\s*((?:19|20)\d{2}|present)$/i.exec(line.trim());
  if (!match) return null;
  const from = Number(match[1]);
  const openEnded = /present/i.test(match[2]);
  return {
    from,
    to: openEnded ? undefined : Number(match[2]),
    openEnded,
    raw: line.trim()
  };
}

function looksLikeYearPair(span: DictionaryYearSpan): boolean {
  return span.from >= 1900 && (span.openEnded || (span.to != null && span.to >= 1900));
}

/**
 * Numeric window. Leading filler dashes (` - 25 - 76`) are removed first.
 * `Positive Float` is `> 0`. `Positive Integer` is `>= 1`.
 */
export function parseNumericRange(line: string): DictionaryNumericRange | null {
  const trimmed = line.trim();
  if (/^positive\s+float$/i.test(trimmed)) {
    return { min: 0, minInclusive: false, maxInclusive: true, raw: trimmed };
  }
  if (/^positive\s+(integer|int)$/i.test(trimmed)) {
    return { min: 1, minInclusive: true, maxInclusive: true, raw: trimmed };
  }

  const bound = /^(>=|<=|>|<)\s*(-?\d+(?:\.\d+)?)$/.exec(trimmed);
  if (bound) {
    const op = bound[1];
    const n = Number(bound[2]);
    if (op === '>') return { min: n, minInclusive: false, maxInclusive: true, raw: trimmed };
    if (op === '>=') return { min: n, minInclusive: true, maxInclusive: true, raw: trimmed };
    if (op === '<') return { max: n, minInclusive: true, maxInclusive: false, raw: trimmed };
    return { max: n, minInclusive: true, maxInclusive: true, raw: trimmed };
  }

  const cleaned = trimmed.replace(/^[\s\-–—]+/, '');
  const span = /^(-?\d+(?:\.\d+)?)\s*[-–—]\s*(-?\d+(?:\.\d+)?)$/.exec(cleaned);
  if (!span) return null;
  const min = Number(span[1]);
  const max = Number(span[2]);
  if (min > max) return null;
  // Four-digit pairs are year windows, handled by parseYearSpan.
  if (min >= 1900 && max >= 1900 && Number.isInteger(min) && Number.isInteger(max)) return null;
  return { min, max, minInclusive: true, maxInclusive: true, raw: trimmed };
}
