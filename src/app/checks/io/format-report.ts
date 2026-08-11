/**
 * Unified report formatters shared by CLI and UI.
 */

import type { DccRunReport } from '../report/build-report';
import { formatReportAsHtml, formatReportAsMarkdown } from '../report/build-report';

export type ReportFormat = 'json' | 'md' | 'markdown' | 'html' | 'htm';

export function normalizeReportFormat(format: string | undefined): ReportFormat {
  const f = (format ?? 'json').toLowerCase();
  if (f === 'md' || f === 'markdown') return 'md';
  if (f === 'html' || f === 'htm') return 'html';
  return 'json';
}

export function formatReport(report: DccRunReport, format: string | undefined = 'json'): string {
  const kind = normalizeReportFormat(format);
  if (kind === 'md') return formatReportAsMarkdown(report);
  if (kind === 'html') return formatReportAsHtml(report);
  return JSON.stringify(report, null, 2);
}

export function reportFileExtension(format: string | undefined): string {
  const kind = normalizeReportFormat(format);
  if (kind === 'md') return 'md';
  if (kind === 'html') return 'html';
  return 'json';
}
