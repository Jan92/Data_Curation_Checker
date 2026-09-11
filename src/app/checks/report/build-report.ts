/**
 * Human-readable and machine-readable DCC run reports.
 */

import type { CheckIssue, CheckResult, ParseResult } from '../types';
import type {
  DatasetRunContext,
  DatasetSummary,
  EffectiveConfigRef,
  GateStatus,
  RecordValidationResult
} from '../config/types';
import { issueCodeFromLabel } from '../pipeline/helpers';

export const TOOL_VERSION = '0.6.1';

export interface SummaryExtras {
  rowCount?: number;
  tableCounts?: Record<string, number>;
  missingFiles?: string[];
  unexpectedFiles?: string[];
  missingColumns?: string[];
  unexpectedColumns?: string[];
}

export interface DccRunReport {
  gate: GateStatus;
  toolVersion: string;
  config: EffectiveConfigRef;
  runContext: DatasetRunContext;
  summary: DatasetSummary;
  parseResult: ParseResult;
  issues: CheckIssue[];
  checkResults: CheckResult[];
  recordResults: RecordValidationResult[];
  /** Differentiated check suite results (pipeline stages). */
  checkSuites?: import('../types').CheckSuiteResult[];
}

export function decideGate(
  issues: CheckIssue[],
  options: { failOnError?: boolean; failOnWarn?: boolean } = {}
): GateStatus {
  const failOnError = options.failOnError !== false;
  const failOnWarn = options.failOnWarn === true;
  const hasError = issues.some((i) => i.severity === 'error');
  const hasWarn = issues.some((i) => i.severity === 'warn');
  if (failOnError && hasError) return 'FAIL';
  if (failOnWarn && hasWarn) return 'FAIL';
  return 'PASS';
}

function inferResourceType(location: string): string {
  if (location.startsWith('DiagnosticReport')) return 'DiagnosticReport';
  if (location.startsWith('Observation')) return 'Observation';
  if (location === 'RunContext' || location === 'Dataset' || location === 'System') return location;
  return 'Unknown';
}

/** Record-level findings: row/resource, status, violation code, field, raw value, severity. */
export function buildRecordResults(issues: CheckIssue[]): RecordValidationResult[] {
  return issues
    .filter((i) => i.severity === 'error' || i.severity === 'warn')
    .map((issueItem, index) => {
      const resourceType = inferResourceType(issueItem.location);
      const status =
        issueItem.severity === 'error' ? 'fail' : issueItem.severity === 'warn' ? 'warn' : 'pass';
      return {
        recordId: issueItem.location || `record#${index + 1}`,
        resourceType,
        status,
        violationCode:
          issueItem.code ?? issueCodeFromLabel(issueItem.label),
        field: issueItem.field ?? issueItem.label,
        rawValue: issueItem.rawValue,
        message: issueItem.detail,
        severity: issueItem.severity === 'ok' ? 'info' : issueItem.severity
      };
    });
}

function aggregateViolations(issues: CheckIssue[]): {
  violationsByField: Record<string, number>;
  violationsByCode: Record<string, number>;
} {
  const violationsByField: Record<string, number> = {};
  const violationsByCode: Record<string, number> = {};
  for (const i of issues) {
    if (i.severity !== 'error' && i.severity !== 'warn') continue;
    const field = i.field || i.label || 'unknown';
    const code = i.code || issueCodeFromLabel(i.label);
    violationsByField[field] = (violationsByField[field] ?? 0) + 1;
    violationsByCode[code] = (violationsByCode[code] ?? 0) + 1;
  }
  return { violationsByField, violationsByCode };
}

function matchRecordKey(location: string, known: Set<string>): string | undefined {
  if (known.has(location)) return location;
  const head = location.split(' · ')[0];
  if (known.has(head)) return head;
  const firstToken = location.split(' ')[0];
  if (known.has(firstToken)) return firstToken;
  return undefined;
}

function resourceKeysFromParse(parseResult: ParseResult): string[] {
  const keys: string[] = [];
  (parseResult.resources ?? []).forEach((r, i) => {
    const id = (r as { id?: string }).id ?? String(i + 1);
    keys.push(`Observation/${id}`);
  });
  (parseResult.diagnosticReports ?? []).forEach((r, i) => {
    const id = (r as { id?: string }).id ?? String(i + 1);
    keys.push(`DiagnosticReport/${id}`);
  });
  return keys;
}

function recordKeysFromIssues(issues: CheckIssue[]): string[] {
  const keys = new Set<string>();
  for (const i of issues) {
    if (!i.location) continue;
    if (i.location.includes('/row/')) keys.add(i.location.split(' · ')[0]);
    else if (i.location.startsWith('Observation') || i.location.startsWith('DiagnosticReport')) {
      keys.add(i.location.split(' · ')[0]);
    }
  }
  return [...keys];
}

export function buildSummary(
  parseResult: ParseResult,
  issues: CheckIssue[],
  laboratoryCount: number,
  toolVersion: string,
  config: EffectiveConfigRef,
  runContext?: DatasetRunContext,
  extras?: SummaryExtras
): DatasetSummary {
  const errorCount = issues.filter((i) => i.severity === 'error').length;
  const warnCount = issues.filter((i) => i.severity === 'warn').length;
  const observationCount = parseResult.resources?.length ?? 0;
  const diagnosticReportCount = parseResult.diagnosticReports?.length ?? 0;
  const resourceKeys = resourceKeysFromParse(parseResult);
  const tabularKeys = extras?.rowCount ? recordKeysFromIssues(issues) : [];
  const keys = resourceKeys.length ? resourceKeys : tabularKeys;

  let failCount = 0;
  let warnRecordCount = 0;
  let passCount = 0;
  if (keys.length) {
    const known = new Set(keys);
    const flags = new Map<string, { error: boolean; warn: boolean }>();
    for (const key of keys) flags.set(key, { error: false, warn: false });
    for (const item of issues) {
      if (item.severity !== 'error' && item.severity !== 'warn') continue;
      const key = matchRecordKey(item.location, known);
      if (!key) continue;
      const flag = flags.get(key)!;
      if (item.severity === 'error') flag.error = true;
      else flag.warn = true;
    }
    for (const key of keys) {
      const flag = flags.get(key)!;
      if (flag.error) failCount += 1;
      else if (flag.warn) warnRecordCount += 1;
      else passCount += 1;
    }
  }

  const fhirRowCount = observationCount + diagnosticReportCount;
  const rowCount = extras?.rowCount ?? fhirRowCount;

  if (!keys.length && rowCount > 0) {
    // Attribute at dataset grain when we only know totals
    failCount = errorCount > 0 ? Math.min(rowCount, errorCount) : 0;
    warnRecordCount = errorCount === 0 && warnCount > 0 ? Math.min(rowCount, warnCount) : 0;
    passCount = Math.max(0, rowCount - failCount - warnRecordCount);
  } else if (!keys.length) {
    failCount = errorCount > 0 ? 1 : 0;
    warnRecordCount = errorCount === 0 && warnCount > 0 ? 1 : 0;
    passCount = errorCount === 0 && warnCount === 0 ? 0 : passCount;
  }

  const { violationsByField, violationsByCode } = aggregateViolations(issues);

  return {
    rowCount,
    observationCount,
    diagnosticReportCount,
    laboratoryCount,
    tableCounts: extras?.tableCounts ?? {
      ...(observationCount ? { Observation: observationCount } : {}),
      ...(diagnosticReportCount ? { DiagnosticReport: diagnosticReportCount } : {})
    },
    errorCount,
    warnCount,
    passCount,
    failCount,
    warnRecordCount,
    violationCount: errorCount + warnCount,
    violationsByField,
    violationsByCode,
    missingFiles: extras?.missingFiles ?? [],
    unexpectedFiles: extras?.unexpectedFiles ?? [],
    missingColumns: extras?.missingColumns ?? [],
    unexpectedColumns: extras?.unexpectedColumns ?? [],
    timestamp: new Date().toISOString(),
    toolVersion,
    configVersion: config.version,
    configHash: config.hash,
    studyId: runContext?.studyId ?? config.snapshot.studyId,
    dictionaryRef: runContext?.dictionaryRef ?? config.snapshot.dictionaryRef
  };
}

export function buildDccRunReport(input: {
  parseResult: ParseResult;
  issues: CheckIssue[];
  checkResults: CheckResult[];
  laboratoryCount: number;
  config: EffectiveConfigRef;
  runContext: DatasetRunContext;
  toolVersion?: string;
  checkSuites?: import('../types').CheckSuiteResult[];
  summaryExtras?: SummaryExtras;
}): DccRunReport {
  const toolVersion = input.toolVersion ?? TOOL_VERSION;
  const gate = decideGate(input.issues, {
    failOnError: input.config.snapshot.failOnError,
    failOnWarn: input.config.snapshot.failOnWarn
  });
  return {
    gate,
    toolVersion,
    config: input.config,
    runContext: input.runContext,
    summary: buildSummary(
      input.parseResult,
      input.issues,
      input.laboratoryCount,
      toolVersion,
      input.config,
      input.runContext,
      input.summaryExtras
    ),
    parseResult: input.parseResult,
    issues: input.issues,
    checkResults: input.checkResults,
    recordResults: buildRecordResults(input.issues),
    checkSuites: input.checkSuites
  };
}

/** Human-readable Markdown report. */
export function formatReportAsMarkdown(report: DccRunReport): string {
  const lines: string[] = [];
  lines.push(`# Data Curation Checker — Validation Report`);
  lines.push('');
  lines.push(`**Quality gate:** ${report.gate}`);
  lines.push(`**Tool version:** ${report.toolVersion}`);
  lines.push(`**Timestamp:** ${report.summary.timestamp}`);
  lines.push('');
  lines.push(`## Run context`);
  lines.push(`- Dataset ID: \`${report.runContext.datasetId}\``);
  lines.push(`- Source / site: \`${report.runContext.sourceSite}\``);
  lines.push(`- Mode: \`${report.runContext.mode}\``);
  if (report.runContext.timeframe) lines.push(`- Timeframe: \`${report.runContext.timeframe}\``);
  if (report.runContext.inputFiles.length) {
    lines.push(`- Input files: ${report.runContext.inputFiles.map((f) => `\`${f}\``).join(', ')}`);
  }
  if (report.runContext.license) lines.push(`- License: ${report.runContext.license}`);
  if (report.runContext.provenance) lines.push(`- Provenance: ${report.runContext.provenance}`);
  if (report.summary.studyId) lines.push(`- Study: \`${report.summary.studyId}\``);
  if (report.summary.dictionaryRef) lines.push(`- Dictionary: ${report.summary.dictionaryRef}`);
  lines.push('');
  lines.push(`## Validation configuration`);
  lines.push(`- ID: \`${report.config.id}\``);
  lines.push(`- Version: \`${report.config.version}\``);
  lines.push(`- Hash: \`${report.config.hash}\``);
  lines.push(`- Name: ${report.config.snapshot.name}`);
  lines.push(`- Plugins: ${(report.config.snapshot.plugins ?? []).join(', ') || '—'}`);
  lines.push('');
  lines.push(`## Summary`);
  lines.push(`| Metric | Value |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Row / record count | ${report.summary.rowCount} |`);
  lines.push(`| Observations | ${report.summary.observationCount} |`);
  lines.push(`| DiagnosticReports | ${report.summary.diagnosticReportCount} |`);
  lines.push(`| Laboratory observations | ${report.summary.laboratoryCount} |`);
  lines.push(`| Pass records | ${report.summary.passCount} |`);
  lines.push(`| Fail records | ${report.summary.failCount} |`);
  lines.push(`| Warn records | ${report.summary.warnRecordCount} |`);
  lines.push(`| Errors | ${report.summary.errorCount} |`);
  lines.push(`| Warnings | ${report.summary.warnCount} |`);
  lines.push(`| Violations | ${report.summary.violationCount} |`);
  lines.push(`| Config version | ${report.summary.configVersion} |`);
  lines.push(`| Config hash | ${report.summary.configHash} |`);
  lines.push(`| Tool version | ${report.summary.toolVersion} |`);
  if (report.summary.missingFiles.length) {
    lines.push(`| Missing files | ${report.summary.missingFiles.join(', ')} |`);
  }
  if (report.summary.missingColumns.length) {
    lines.push(`| Missing columns | ${report.summary.missingColumns.join(', ')} |`);
  }
  lines.push('');
  if (Object.keys(report.summary.violationsByCode).length) {
    lines.push(`### Violations by code`);
    for (const [code, n] of Object.entries(report.summary.violationsByCode)) {
      lines.push(`- \`${code}\`: ${n}`);
    }
    lines.push('');
  }
  if (Object.keys(report.summary.violationsByField).length) {
    lines.push(`### Violations by field`);
    for (const [field, n] of Object.entries(report.summary.violationsByField)) {
      lines.push(`- \`${field}\`: ${n}`);
    }
    lines.push('');
  }
  if (report.checkSuites?.length) {
    lines.push(`## Check suites`);
    lines.push(`| Suite | Status | Errors | Warnings | Detail |`);
    lines.push(`|-------|--------|--------|----------|--------|`);
    for (const s of report.checkSuites) {
      lines.push(
        `| ${s.label}${s.enabled ? '' : ' (skipped)'} | ${s.statusLabel} | ${s.errorCount} | ${s.warnCount} | ${s.detail.replace(/\|/g, '/')} |`
      );
    }
    lines.push('');
  }
  lines.push(`## Issues`);
  if (!report.issues.length) {
    lines.push('_No issues detected._');
  } else {
    for (const issue of report.issues) {
      lines.push(
        `- **[${issue.severity.toUpperCase()}]** ${issue.label} — ${issue.detail} _(${issue.location})_`
      );
    }
  }
  lines.push('');
  lines.push(`## Record-level findings`);
  if (!report.recordResults.length) {
    lines.push('_No record-level findings._');
  } else {
    for (const r of report.recordResults) {
      lines.push(
        `- \`${r.recordId}\` [${r.status}] ${r.violationCode ?? ''} — ${r.message}`
      );
    }
  }
  lines.push('');
  lines.push(`---`);
  lines.push(
    `_Data Curation Checker. Syntactic/structural validation only; no clinical interpretation._`
  );
  lines.push('');
  return lines.join('\n');
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Printable HTML report (use browser Print → Save as PDF). */
export function formatReportAsHtml(report: DccRunReport): string {
  const gateColor = report.gate === 'PASS' ? '#065f46' : '#991b1b';
  const gateBg = report.gate === 'PASS' ? '#ecfdf5' : '#fef2f2';
  const issueRows = report.issues.length
    ? report.issues
        .map(
          (issue) => `<tr>
      <td><span class="sev sev-${escapeHtml(issue.severity)}">${escapeHtml(issue.severity.toUpperCase())}</span></td>
      <td>${escapeHtml(issue.label)}</td>
      <td>${escapeHtml(issue.detail)}</td>
      <td class="mono">${escapeHtml(issue.location)}</td>
    </tr>`
        )
        .join('\n')
    : `<tr><td colspan="4"><em>No issues detected.</em></td></tr>`;

  const recordRows = report.recordResults.length
    ? report.recordResults
        .map(
          (r) => `<tr>
      <td class="mono">${escapeHtml(r.recordId)}</td>
      <td>${escapeHtml(r.resourceType)}</td>
      <td>${escapeHtml(r.status)}</td>
      <td>${escapeHtml(r.message)}</td>
    </tr>`
        )
        .join('\n')
    : `<tr><td colspan="4"><em>No record-level findings.</em></td></tr>`;

  const suiteRows = report.checkSuites?.length
    ? report.checkSuites
        .map(
          (s) => `<tr>
      <td>${escapeHtml(s.label)}${s.enabled ? '' : ' (skipped)'}</td>
      <td>${escapeHtml(s.statusLabel)}</td>
      <td>${s.errorCount}</td>
      <td>${s.warnCount}</td>
      <td>${escapeHtml(s.detail)}</td>
    </tr>`
        )
        .join('\n')
    : '';

  const violationCodeList = Object.entries(report.summary.violationsByCode)
    .map(([code, n]) => `<li><code>${escapeHtml(code)}</code> — ${n}</li>`)
    .join('');
  const violationFieldList = Object.entries(report.summary.violationsByField)
    .map(([field, n]) => `<li><code>${escapeHtml(field)}</code> — ${n}</li>`)
    .join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>DCC Report — ${escapeHtml(report.runContext.datasetId)} — ${report.gate}</title>
  <style>
    :root { color-scheme: light; }
    body { font-family: "IBM Plex Sans", "Segoe UI", system-ui, sans-serif; margin: 0; padding: 32px; color: #0f172a; background: #fff; }
    h1 { margin: 0 0 8px; font-size: 28px; }
    h2 { margin: 28px 0 12px; font-size: 18px; border-bottom: 1px solid #e2e8f0; padding-bottom: 6px; }
    .meta { color: #64748b; font-size: 13px; margin-bottom: 20px; }
    .gate { display: inline-block; padding: 12px 18px; border-radius: 12px; background: ${gateBg}; color: ${gateColor}; font-weight: 700; letter-spacing: 0.04em; font-size: 22px; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #e2e8f0; vertical-align: top; }
    th { background: #f8fafc; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: #64748b; }
    .mono { font-family: "IBM Plex Mono", ui-monospace, monospace; font-size: 12px; }
    .sev { font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 999px; }
    .sev-error { background: #fee2e2; color: #991b1b; }
    .sev-warn { background: #fef3c7; color: #92400e; }
    .sev-ok, .sev-info { background: #e0f2fe; color: #075985; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; margin: 16px 0; }
    .card { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px; padding: 12px; }
    .card strong { display: block; font-size: 22px; }
    .card span { font-size: 12px; color: #64748b; }
    .card ul { margin: 8px 0 0; padding-left: 18px; font-size: 13px; }
    footer { margin-top: 32px; font-size: 12px; color: #64748b; }
    @media print { body { padding: 12px; } .gate { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
  </style>
</head>
<body>
  <p class="meta">Data Curation Checker · tool v${escapeHtml(report.toolVersion)} · config ${escapeHtml(report.config.id)}@${escapeHtml(report.config.version)} (${escapeHtml(report.config.hash)})</p>
  <h1>Validation report</h1>
  <p class="gate">${report.gate}</p>
  <div class="grid">
    <div class="card"><strong>${report.summary.observationCount}</strong><span>Observations</span></div>
    <div class="card"><strong>${report.summary.diagnosticReportCount}</strong><span>DiagnosticReports</span></div>
    <div class="card"><strong>${report.summary.laboratoryCount}</strong><span>Laboratory</span></div>
    <div class="card"><strong>${report.summary.passCount}</strong><span>Pass records</span></div>
    <div class="card"><strong>${report.summary.failCount}</strong><span>Fail records</span></div>
    <div class="card"><strong>${report.summary.errorCount}</strong><span>Errors</span></div>
    <div class="card"><strong>${report.summary.warnCount}</strong><span>Warnings</span></div>
  </div>
  <h2>Run context</h2>
  <table>
    <tr><th>Dataset ID</th><td class="mono">${escapeHtml(report.runContext.datasetId)}</td></tr>
    <tr><th>Source / site</th><td>${escapeHtml(report.runContext.sourceSite)}</td></tr>
    <tr><th>Mode</th><td>${escapeHtml(report.runContext.mode)}</td></tr>
    <tr><th>Timeframe</th><td>${escapeHtml(report.runContext.timeframe || '—')}</td></tr>
    <tr><th>Timestamp</th><td class="mono">${escapeHtml(report.summary.timestamp)}</td></tr>
  </table>
  <h2>Validation configuration</h2>
  <table>
    <tr><th>ID</th><td class="mono">${escapeHtml(report.config.id)}</td></tr>
    <tr><th>Version</th><td>${escapeHtml(report.config.version)}</td></tr>
    <tr><th>Hash</th><td class="mono">${escapeHtml(report.config.hash)}</td></tr>
    <tr><th>Name</th><td>${escapeHtml(report.config.snapshot.name)}</td></tr>
    <tr><th>Plugins</th><td>${escapeHtml((report.config.snapshot.plugins ?? []).join(', ') || '—')}</td></tr>
    ${report.summary.studyId ? `<tr><th>Study</th><td class="mono">${escapeHtml(report.summary.studyId)}</td></tr>` : ''}
    ${report.summary.dictionaryRef ? `<tr><th>Dictionary</th><td>${escapeHtml(report.summary.dictionaryRef)}</td></tr>` : ''}
  </table>
  ${
    suiteRows
      ? `<h2>Check suites</h2>
  <table>
    <thead><tr><th>Suite</th><th>Status</th><th>Errors</th><th>Warnings</th><th>Detail</th></tr></thead>
    <tbody>${suiteRows}</tbody>
  </table>`
      : ''
  }
  ${
    violationCodeList || violationFieldList
      ? `<h2>Violations</h2>
  <div class="grid">
    ${violationCodeList ? `<div class="card"><span>By code</span><ul>${violationCodeList}</ul></div>` : ''}
    ${violationFieldList ? `<div class="card"><span>By field</span><ul>${violationFieldList}</ul></div>` : ''}
  </div>`
      : ''
  }
  <h2>Issues</h2>
  <table>
    <thead><tr><th>Severity</th><th>Label</th><th>Detail</th><th>Location</th></tr></thead>
    <tbody>${issueRows}</tbody>
  </table>
  <h2>Record-level findings</h2>
  <table>
    <thead><tr><th>Record</th><th>Type</th><th>Status</th><th>Message</th></tr></thead>
    <tbody>${recordRows}</tbody>
  </table>
  <footer>Syntactic/structural validation only; no clinical interpretation. On FAIL, notify the data provider before upload.</footer>
</body>
</html>`;
}
