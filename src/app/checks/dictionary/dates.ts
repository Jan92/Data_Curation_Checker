/**
 * Date-format helpers for dictionary cells.
 *
 * Dictionaries often declare `DATE, format: MM-DD-YYYY` while the
 * "existing values" cell shows a real extract sample such as `31/08/2015`.
 * A day greater than 12 in the month position means the declared order
 * cannot describe that sample. A slash vs dash difference is reported
 * separately and does not by itself fail the gate.
 */

export interface DeclaredDatePattern {
  order: 'MDY' | 'DMY' | 'YMD';
  separator: '-' | '/';
  /** Key stored on the compiled field as `dateTimePattern`, e.g. `MM-DD-YYYY`. */
  patternKey: string;
}

export interface ObservedDateToken {
  raw: string;
  /** Numeric pieces in the order they were written. */
  parts: [number, number, number];
  separator: '-' | '/' | '.';
  /** True when the token starts with a 4-digit year (`2020-01-31`). */
  yearFirst: boolean;
}

const DECLARED = /(YYYY|MM|DD)([/-])(YYYY|MM|DD)\2(YYYY|MM|DD)/;

/** Read `MM-DD-YYYY`, `DD/MM/YYYY`, `YYYY-MM-DD`, and the same with the other separator. */
export function declaredDatePattern(format: string): DeclaredDatePattern | null {
  const match = DECLARED.exec(format.toUpperCase());
  if (!match) return null;
  const order = orderOf(match[1], match[3], match[4]);
  if (!order) return null;
  const separator: '-' | '/' = match[2] === '/' ? '/' : '-';
  return {
    order,
    separator,
    patternKey: `${match[1]}${separator}${match[3]}${separator}${match[4]}`
  };
}

/** Every calendar-looking token in a cell, both `31/08/2015` and `2020-01-31`. */
export function observedDateTokens(raw: string): ObservedDateToken[] {
  const out: ObservedDateToken[] = [];
  const ymd = /\b(\d{4})([\/\-.])(\d{1,2})\2(\d{1,2})\b/g;
  const mdy = /\b(\d{1,2})([\/\-.])(\d{1,2})\2(\d{2,4})\b/g;
  collect(raw, ymd, true, out);
  collect(raw, mdy, false, out);
  return out;
}

export function monthPart(token: ObservedDateToken, order: DeclaredDatePattern['order']): number | null {
  if (token.yearFirst) return order === 'YMD' ? token.parts[1] : null;
  if (order === 'MDY') return token.parts[0];
  if (order === 'DMY') return token.parts[1];
  return null;
}

export function dayPart(token: ObservedDateToken, order: DeclaredDatePattern['order']): number | null {
  if (token.yearFirst) return order === 'YMD' ? token.parts[2] : null;
  if (order === 'MDY') return token.parts[1];
  if (order === 'DMY') return token.parts[0];
  return null;
}

/** Calendar year of a token once the declared order is known. */
export function yearPart(token: ObservedDateToken, order: DeclaredDatePattern['order']): number | null {
  if (token.yearFirst) return order === 'YMD' ? token.parts[0] : token.parts[0];
  if (order === 'YMD') return null;
  return expandYear(token.parts[2]);
}

function collect(
  raw: string,
  re: RegExp,
  yearFirst: boolean,
  out: ObservedDateToken[]
): void {
  let match: RegExpExecArray | null;
  while ((match = re.exec(raw))) {
    const separator = match[2] === '/' ? '/' : match[2] === '.' ? '.' : '-';
    out.push({
      raw: match[0],
      parts: [Number(match[1]), Number(match[3]), Number(match[4])],
      separator,
      yearFirst
    });
  }
}

function orderOf(a: string, b: string, c: string): DeclaredDatePattern['order'] | null {
  const signature = `${a}-${b}-${c}`;
  if (signature === 'MM-DD-YYYY') return 'MDY';
  if (signature === 'DD-MM-YYYY') return 'DMY';
  if (signature === 'YYYY-MM-DD') return 'YMD';
  return null;
}

function expandYear(year: number): number {
  if (year >= 100) return year;
  return year >= 70 ? 1900 + year : 2000 + year;
}
