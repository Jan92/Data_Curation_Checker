/**
 * SEARCH Common Codification v2 quality gate (QC-01–QC-40).
 *
 * Runs on a curated tabular export: one CSV, or a JSON object of
 * `<dataset>_<table>_<YYYYMMDD>.csv` → CSV text. The catalogue (CDEs,
 * value sets, rule text) comes from the active validation config.
 */

import { applyMetadataRequirements } from '../config/apply-config-rules';
import type {
  DatasetRunContext,
  EffectiveConfigRef,
  SearchCde,
  SearchCodification,
  SearchQcRule
} from '../config/types';
import { parseCsvRows } from '../io/load-config';
import { issue, summarizeSuite, suiteToCheckResult } from '../pipeline/helpers';
import { runReproducibilityChecks } from '../pipeline/reproducibility';
import { buildDccRunReport, TOOL_VERSION, type DccRunReport } from '../report/build-report';
import type { CheckCategory, CheckIssue, CheckStatus, CheckSuiteResult, ParseResult } from '../types';

const EXPORT_TABLES = [
  'subject',
  'event',
  'lesion',
  'specimen',
  'treatment',
  'questionnaire',
  'annotation',
  'image'
];

const FILE_NAME = /^[A-Za-z0-9]+_(subject|event|lesion|specimen|treatment|questionnaire|annotation|image)_\d{8}\.csv$/;

const IDENTIFIER_COLUMN =
  /(^|_)(first_name|last_name|surname|given_name|patient_name|full_name|name|e_mail|email|phone|telephone|mobile|address|street|postcode|postal_code|zip_code|city|cpr|national_id|ssn|hospital_number|mrn|record_number|staff_initials|initials|date_of_birth|birth_date|dob|index_date)($|_)/i;

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const COMPARATORS = new Set(['<', '<=', '>', '>=', '=']);

const FIGO_OVARIAN = new Set([
  'I', 'IA', 'IB', 'IC', 'IC1', 'IC2', 'IC3', 'II', 'IIA', 'IIB', 'III', 'IIIA', 'IIIA1',
  'IIIA1(i)', 'IIIA1(ii)', 'IIIA2', 'IIIB', 'IIIC', 'IV', 'IVA', 'IVB'
]);
const FIGO_CERVICAL = new Set(['I', 'IA', 'IB', 'II', 'IIA', 'IIB', 'III', 'IIIA', 'IIIB', 'IIIC', 'IV', 'IVA', 'IVB']);
const FIGO_ENDOMETRIAL = new Set(['I', 'IA', 'IB', 'II', 'IIA', 'III', 'IIIA', 'IIIA1', 'IIIA2', 'IIIB', 'IIIC', 'IV', 'IVA', 'IVB']);

const INDEX_PAIRS: Array<[string, string]> = [
  ['lv_edv_ml', 'lv_edv_index_ml_m2'],
  ['lv_esv_ml', 'lv_esv_index_ml_m2'],
  ['lv_mass_g', 'lv_mass_index_g_m2'],
  ['lv_cardiac_output_l_min', 'lv_cardiac_index_l_min_m2'],
  ['rv_edv_ml', 'rv_edv_index_ml_m2'],
  ['rv_esv_ml', 'rv_esv_index_ml_m2'],
  ['rv_mass_g', 'rv_mass_index_g_m2'],
  ['rv_cardiac_output_l_min', 'rv_cardiac_index_l_min_m2']
];

const EF_PAIRS: Array<[string, string, string]> = [
  ['lv_ef_pct', 'lv_edv_ml', 'lv_esv_ml'],
  ['rv_ef_pct', 'rv_edv_ml', 'rv_esv_ml']
];

const GENE_PAIRS: Array<[string, string]> = [
  ['brca1_germline_status', 'brca1_somatic_status'],
  ['brca2_germline_status', 'brca2_somatic_status']
];

const POLYP_SIZES = ['polyp_size_cce_mm', 'polyp_size_oc_mm', 'polyp_size_path_mm'];
const GENOTYPE_COLUMNS = [/^hpv_aptima_gt_.+_result$/, /^hpv_onclarity_(?!hr_).+_result$/];

type HeaderKind = 'cde' | 'companion-dar' | 'companion-comparator' | 'forbidden' | 'unknown';

interface ResolvedHeader {
  header: string;
  kind: HeaderKind;
  cde?: SearchCde;
  base?: string;
}

interface ParsedFile {
  fileName: string;
  table: string | null;
  delimiter: ',' | ';';
  headers: ResolvedHeader[];
  rows: string[][];
  replacementChar: boolean;
}

const templateCache = new Map<string, RegExp>();

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function templateToRegExp(template: string): RegExp {
  const cached = templateCache.get(template);
  if (cached) return cached;
  let src = '';
  for (let i = 0; i < template.length; i++) {
    const ch = template[i];
    if (ch !== '{') {
      src += escapeRegExp(ch);
      continue;
    }
    const end = template.indexOf('}', i);
    if (end < 0) {
      src += escapeRegExp(ch);
      continue;
    }
    const token = template.slice(i + 1, end);
    const bounds = token.match(/^(\d+)-(\d+)$/);
    if (bounds) {
      const width = bounds[1].length;
      const parts: string[] = [];
      for (let n = Number(bounds[1]); n <= Number(bounds[2]); n++) {
        parts.push(String(n).padStart(width, '0'));
      }
      src += `(?:${parts.join('|')})`;
    } else if (token.includes('|')) {
      src += `(?:${token.split('|').map(escapeRegExp).join('|')})`;
    } else {
      src += '[a-z0-9_]+';
    }
    i = end;
  }
  const compiled = new RegExp(`^${src}$`);
  templateCache.set(template, compiled);
  return compiled;
}

function isLocalOnly(cde: SearchCde): boolean {
  return cde.table.toLowerCase().includes('local only') || cde.dataType.toLowerCase().includes('date');
}

function tableParts(cde: SearchCde): string[] {
  return cde.table
    .split(/[;,]/)
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
}

function cdeApplies(cde: SearchCde, table: string | null): boolean {
  if (isLocalOnly(cde)) return false;
  const parts = tableParts(cde);
  if (parts.includes('all')) return true;
  if (!table) return true;
  return parts.includes(table);
}

function categoryFor(type: string): CheckCategory {
  const name = type.toLowerCase();
  if (name.includes('identifier')) return 'identifier';
  if (name.includes('privacy') || name.includes('governance')) return 'policy';
  if (name.includes('value')) return 'vocabulary';
  if (name.includes('temporal')) return 'datetime';
  if (name.includes('complete')) return 'completeness';
  if (name.includes('consisten')) return 'reference';
  return 'structure';
}

function detectDelimiter(text: string): ',' | ';' {
  const line = text.split(/\r?\n/, 1)[0] ?? '';
  let commas = 0;
  let semis = 0;
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === ',') commas += 1;
    else if (!quoted && ch === ';') semis += 1;
  }
  return semis > commas ? ';' : ',';
}

function tableFromFileName(fileName: string): string | null {
  const base = (fileName.split(/[/\\]/).pop() ?? fileName).replace(/\.csv$/i, '').toLowerCase();
  const tokens = base.split(/[^a-z0-9]+/).filter(Boolean);
  const ordered = [...EXPORT_TABLES].sort((a, b) => b.length - a.length);
  for (const table of ordered) {
    if (tokens.includes(table) || tokens.includes(`${table}s`)) return table;
  }
  return null;
}

function numericBounds(range: string | undefined): { min?: number; max?: number } | null {
  if (!range || /pattern/i.test(range) || range.includes(':') || /^DS\d/i.test(range)) return null;
  const between = range.match(/(-?\d+(?:\.\d+)?)\s*(?:-|to)\s*(-?\d+(?:\.\d+)?)/i);
  if (between) return { min: Number(between[1]), max: Number(between[2]) };
  const atLeast = range.match(/>=\s*(-?\d+(?:\.\d+)?)/);
  if (atLeast) return { min: Number(atLeast[1]) };
  return null;
}

function patternFromRange(range: string | undefined): RegExp | null {
  if (!range) return null;
  const match = range.match(/Pattern\s+(\S+)/i);
  if (!match) return null;
  const token = match[1];
  if (token.startsWith('DSnn')) return /^DS\d{2}-[A-Z0-9]{8}$/;
  let src = '^';
  for (const ch of token) {
    if (ch === 'N') src += '\\d';
    else if (ch === '.') src += '\\.';
    else src += escapeRegExp(ch);
  }
  return new RegExp(`${src}$`);
}

function datasetCodeAllowed(value: string, range: string | undefined): boolean {
  const match = range?.match(/^DS(\d+)-DS(\d+)$/i);
  if (!match) return true;
  const code = value.match(/^DS(\d+)$/i);
  if (!code) return false;
  const n = Number(code[1]);
  return n >= Number(match[1]) && n <= Number(match[2]);
}

function parseNumber(value: string): number | null {
  if (!/^[+-]?\d+(?:\.\d+)?$/.test(value)) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function isDar(value: string, dar: Set<string>): boolean {
  return dar.has(value);
}

function isNotApplicable(value: string): boolean {
  return value === 'not-applicable' || value === 'not_applicable';
}

function looksLikePhone(value: string): boolean {
  const trimmed = value.trim();
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 15) return false;
  return /^[+()]/.test(trimmed) || /[\s().-]/.test(trimmed);
}

export function runSearchCodificationCheck(
  content: string,
  config: EffectiveConfigRef,
  runContext: DatasetRunContext,
  source: string
): DccRunReport {
  const catalog = config.snapshot.searchCodification;
  if (!catalog) {
    throw new Error('SEARCH codification catalogue is missing from the active config.');
  }
  return new SearchQcRunner(content, config, runContext, source, catalog).run();
}

class SearchQcRunner {
  private readonly byRule = new Map<string, CheckIssue[]>();
  private readonly applicable = new Set<string>();
  private readonly rules: Map<string, SearchQcRule>;
  private readonly dar: Set<string>;
  private readonly valueSets = new Map<string, Set<string>>();
  private readonly subjectPattern: RegExp;
  private files: ParsedFile[] = [];
  private parseIssues: CheckIssue[] = [];
  private parsedOk = false;

  constructor(
    private readonly content: string,
    private readonly config: EffectiveConfigRef,
    private readonly runContext: DatasetRunContext,
    private readonly source: string,
    private readonly catalog: SearchCodification
  ) {
    this.rules = new Map(catalog.rules.map((rule) => [rule.id, rule]));
    this.dar = new Set(catalog.darCodes);
    for (const [id, codes] of Object.entries(catalog.valueSets)) {
      this.valueSets.set(id, new Set(codes));
    }
    this.subjectPattern = new RegExp(catalog.subjectIdPattern);
  }

  run(): DccRunReport {
    this.parsePackage();
    if (this.parsedOk) {
      this.evaluate();
    }

    const qcSuites = this.catalog.rules.map((rule) => this.suiteFor(rule));
    const metaIssues = applyMetadataRequirements(this.config.snapshot, this.runContext);
    const reproIssues = runReproducibilityChecks({
      config: this.config,
      runContext: this.runContext,
      toolVersion: TOOL_VERSION
    });
    const qcIssues = qcSuites.flatMap((suite) => suite.issues);
    const suites = [
      summarizeSuite({
        id: 'ingest',
        label: 'Ingest & parse',
        description: 'Parse a SEARCH CSV export or multi-table package.',
        category: 'ingest',
        enabled: true,
        issues: this.parseIssues
      }),
      ...qcSuites,
      summarizeSuite({
        id: 'metadata-requirements',
        label: 'Run metadata',
        description: 'datasetId, source/site, license, provenance, schema/tool version.',
        category: 'metadata',
        enabled: true,
        issues: metaIssues
      }),
      summarizeSuite({
        id: 'reproducibility',
        label: 'Reproducibility',
        description: 'Config hash/version and tool version for audit evidence.',
        category: 'reproducibility',
        enabled: true,
        issues: reproIssues
      })
    ];

    const tableCounts: Record<string, number> = {};
    let rowCount = 0;
    for (const file of this.files) {
      const key = file.table ?? file.fileName;
      tableCounts[key] = (tableCounts[key] ?? 0) + file.rows.length;
      rowCount += file.rows.length;
    }

    const parseResult: ParseResult = {
      ok: this.parsedOk,
      type: 'search-package',
      resources: [],
      diagnosticReports: [],
      error: this.parsedOk ? undefined : this.parseIssues[0]?.detail
    };

    return buildDccRunReport({
      parseResult,
      issues: [...this.parseIssues, ...qcIssues, ...metaIssues, ...reproIssues],
      checkResults: suites.map(suiteToCheckResult),
      laboratoryCount: 0,
      config: this.config,
      runContext: this.runContext,
      checkSuites: suites,
      summaryExtras: {
        rowCount,
        tableCounts,
        missingFiles: [],
        unexpectedFiles: this.files.filter((file) => !file.table).map((file) => file.fileName),
        missingColumns: [],
        unexpectedColumns: qcIssues
          .filter((item) => item.code === 'QC-03' && item.field)
          .map((item) => item.field as string)
      }
    });
  }

  private suiteFor(rule: SearchQcRule): CheckSuiteResult {
    const category = categoryFor(rule.type);
    if (!this.parsedOk || !this.applicable.has(rule.id)) {
      const reason = this.parsedOk
        ? 'the columns this rule needs are not in this package.'
        : 'the export could not be parsed.';
      return {
        id: rule.id,
        label: `${rule.id} ${rule.type}`,
        description: rule.rule,
        category,
        enabled: true,
        status: 'ok',
        statusLabel: 'N/A',
        detail: `${rule.rule} Not applicable: ${reason}`,
        errorCount: 0,
        warnCount: 0,
        issueCount: 0,
        issues: []
      };
    }

    const suite = summarizeSuite({
      id: rule.id,
      label: `${rule.id} ${rule.type}`,
      description: rule.rule,
      category,
      enabled: true,
      issues: this.byRule.get(rule.id) ?? []
    });
    const outcome = suite.issueCount === 0 ? 'No findings.' : suite.detail;
    suite.detail = `${rule.rule} ${outcome}`;
    if (rule.severity === 'info' && suite.errorCount === 0 && suite.warnCount > 0) {
      suite.statusLabel = 'Info';
    }
    return suite;
  }

  private add(
    ruleId: string,
    severity: CheckStatus,
    label: string,
    detail: string,
    location: string,
    field?: string,
    rawValue?: string
  ): void {
    this.applicable.add(ruleId);
    const list = this.byRule.get(ruleId) ?? [];
    if (list.length >= 24) {
      if (list.length === 24) {
        list.push(
          issue({
            severity: 'warn',
            label: `${ruleId} further findings`,
            detail: 'Further findings for this rule were omitted from the report.',
            location: 'Dataset',
            code: ruleId,
            suiteId: ruleId,
            category: categoryFor(this.rules.get(ruleId)?.type ?? '')
          })
        );
      }
      this.byRule.set(ruleId, list);
      return;
    }
    list.push(
      issue({
        severity,
        label,
        detail,
        location,
        field,
        rawValue,
        code: ruleId,
        suiteId: ruleId,
        category: categoryFor(this.rules.get(ruleId)?.type ?? '')
      })
    );
    this.byRule.set(ruleId, list);
  }

  private mark(ruleId: string): void {
    this.applicable.add(ruleId);
  }

  private parsePackage(): void {
    const trimmed = this.content.trim().replace(/^\uFEFF/, '');
    if (!trimmed) {
      this.parseIssues.push(
        issue({
          severity: 'error',
          label: 'Empty input',
          detail: 'A SEARCH export needs at least one CSV table.',
          location: this.source,
          code: 'EMPTY_INPUT',
          category: 'ingest',
          suiteId: 'ingest'
        })
      );
      return;
    }

    let entries: Array<{ name: string; text: string }> = [];
    if (trimmed.startsWith('{')) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        this.parseIssues.push(
          issue({
            severity: 'error',
            label: 'Package parse failed',
            detail: 'The JSON package could not be parsed.',
            location: this.source,
            code: 'SEARCH_PARSE_FAILED',
            category: 'ingest',
            suiteId: 'ingest'
          })
        );
        return;
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        this.parseIssues.push(
          issue({
            severity: 'error',
            label: 'Package parse failed',
            detail: 'A SEARCH package is a JSON object of file name to CSV text.',
            location: this.source,
            code: 'SEARCH_PARSE_FAILED',
            category: 'ingest',
            suiteId: 'ingest'
          })
        );
        return;
      }
      for (const [name, value] of Object.entries(parsed)) {
        if (typeof value !== 'string') {
          this.parseIssues.push(
            issue({
              severity: 'error',
              label: 'Package parse failed',
              detail: `Entry "${name}" is not CSV text.`,
              location: name,
              code: 'SEARCH_PARSE_FAILED',
              category: 'ingest',
              suiteId: 'ingest'
            })
          );
          return;
        }
        entries.push({ name, text: value });
      }
    } else if (trimmed.startsWith('[') || trimmed.includes('"resourceType"')) {
      this.parseIssues.push(
        issue({
          severity: 'error',
          label: 'Wrong format',
          detail: 'This config checks a SEARCH CSV export. The input looks like FHIR JSON.',
          location: this.source,
          code: 'SEARCH_PARSE_FAILED',
          category: 'ingest',
          suiteId: 'ingest'
        })
      );
      return;
    } else {
      entries = [{ name: this.source || 'upload.csv', text: trimmed }];
    }

    if (!entries.length) {
      this.parseIssues.push(
        issue({
          severity: 'error',
          label: 'Empty package',
          detail: 'The SEARCH package has no files.',
          location: this.source,
          code: 'EMPTY_INPUT',
          category: 'ingest',
          suiteId: 'ingest'
        })
      );
      return;
    }

    this.files = entries.map((entry) => this.parseFile(entry.name, entry.text));
    this.parsedOk = true;
  }

  private parseFile(fileName: string, text: string): ParsedFile {
    const body = text.replace(/^\uFEFF/, '');
    const delimiter = detectDelimiter(body);
    const grid = parseCsvRows(body, delimiter).filter((row) => row.some((cell) => cell.trim()));
    const headerRow = grid[0] ?? [];
    const headers = headerRow.map((header) => header.trim());
    const table = tableFromFileName(fileName);
    return {
      fileName,
      table,
      delimiter,
      headers: headers.map((header) => this.resolveHeader(header, table)),
      rows: grid.slice(1).map((row) => headers.map((_, index) => (row[index] ?? '').trim())),
      replacementChar: body.includes('\uFFFD')
    };
  }

  private resolveHeader(header: string, table: string | null): ResolvedHeader {
    if (!header) return { header, kind: 'unknown' };
    if (this.matchesLocalOnly(header)) return { header, kind: 'forbidden' };
    const companion = header.endsWith('_dar')
      ? 'companion-dar'
      : header.endsWith('_comparator')
        ? 'companion-comparator'
        : null;
    if (companion) {
      const base = header.slice(0, header.length - (companion === 'companion-dar' ? 4 : 11));
      const cde = this.matchCde(base, table);
      if (cde) return { header, kind: companion, cde, base };
    }
    const cde = this.matchCde(header, table);
    if (cde) return { header, kind: 'cde', cde };
    return { header, kind: 'unknown' };
  }

  private matchesLocalOnly(header: string): boolean {
    return this.catalog.cdes.some((cde) => {
      if (!isLocalOnly(cde)) return false;
      if (cde.variable.includes('{')) return templateToRegExp(cde.variable).test(header);
      return cde.variable === header;
    });
  }

  private matchCde(header: string, table: string | null): SearchCde | undefined {
    const applicable = this.catalog.cdes.filter((cde) => cdeApplies(cde, table));
    const exact = applicable.find((cde) => cde.variable === header && !cde.variable.includes('{'));
    if (exact) return exact;
    return applicable
      .filter((cde) => cde.variable.includes('{') && templateToRegExp(cde.variable).test(header))
      .sort((a, b) => b.variable.length - a.variable.length)[0];
  }

  private filesNamed(table: string): ParsedFile[] {
    return this.files.filter((file) => file.table === table);
  }

  private hasHeader(name: string, table?: string): boolean {
    return this.files.some(
      (file) => (table === undefined || file.table === table) && file.headers.some((header) => header.header === name)
    );
  }

  private headersMatching(table: string, pattern: RegExp): string[] {
    const names: string[] = [];
    for (const file of this.filesNamed(table)) {
      for (const header of file.headers) {
        if (pattern.test(header.header) && !names.includes(header.header)) names.push(header.header);
      }
    }
    return names;
  }

  private cell(file: ParsedFile, row: string[], header: string): string {
    const index = file.headers.findIndex((item) => item.header === header);
    if (index < 0) return '';
    return row[index] ?? '';
  }

  private eachRow(table: string | null, fn: (file: ParsedFile, row: string[], rowNumber: number) => void): void {
    for (const file of this.files) {
      if (table !== null && file.table !== table) continue;
      file.rows.forEach((row, index) => fn(file, row, index + 2));
    }
  }

  private subjectRows(): Array<{ file: ParsedFile; row: string[]; rowNumber: number; id: string }> {
    const out: Array<{ file: ParsedFile; row: string[]; rowNumber: number; id: string }> = [];
    this.eachRow('subject', (file, row, rowNumber) => {
      out.push({ file, row, rowNumber, id: this.cell(file, row, 'subject_id') });
    });
    return out;
  }

  private firstSubjectValue(subjectId: string, header: string): string {
    for (const row of this.subjectRows()) {
      if (row.id === subjectId) return this.cell(row.file, row.row, header);
    }
    return '';
  }

  private evaluate(): void {
    const evaluators: Record<string, () => void> = {
      'QC-01': () => this.qc01(),
      'QC-02': () => this.qc02(),
      'QC-03': () => this.qc03(),
      'QC-04': () => this.qc04(),
      'QC-05': () => this.qc05(),
      'QC-06': () => this.qc06(),
      'QC-07': () => this.qc07(),
      'QC-08': () => this.qc08(),
      'QC-09': () => this.qc09(),
      'QC-10': () => this.qc10(),
      'QC-11': () => this.qc11(),
      'QC-12': () => this.qc12(),
      'QC-13': () => this.qc13(),
      'QC-14': () => this.qc14(),
      'QC-15': () => this.qc15(),
      'QC-16': () => this.qc16(),
      'QC-17': () => this.qc17(),
      'QC-18': () => this.qc18(),
      'QC-19': () => this.qc19(),
      'QC-20': () => this.qc20(),
      'QC-21': () => this.qc21(),
      'QC-22': () => this.qc22(),
      'QC-23': () => this.qc23(),
      'QC-24': () => this.qc24(),
      'QC-25': () => this.qc25(),
      'QC-26': () => this.qc26(),
      'QC-27': () => this.qc27(),
      'QC-28': () => this.qc28(),
      'QC-29': () => this.qc29(),
      'QC-30': () => this.qc30(),
      'QC-31': () => this.qc31('QC-31', 'cce_polyp_detected', 'cce_polyp_count'),
      'QC-32': () => this.qc31('QC-32', 'oc_polyp_detected', 'oc_polyp_count'),
      'QC-33': () => this.qc33(),
      'QC-34': () => this.qc34(),
      'QC-35': () => this.qc35(),
      'QC-36': () => this.qc36(),
      'QC-37': () => this.qc37(),
      'QC-38': () => this.qc38(),
      'QC-39': () => this.qc39(),
      'QC-40': () => this.qc40()
    };
    for (const rule of this.catalog.rules) {
      evaluators[rule.id]?.();
    }
  }

  private loc(file: ParsedFile, rowNumber?: number): string {
    return rowNumber === undefined ? file.fileName : `${file.fileName} row ${rowNumber}`;
  }

  private qc01(): void {
    this.mark('QC-01');
    const seen = new Map<string, string>();
    const subjectIds = new Set<string>();
    const subjectFiles = this.filesNamed('subject');
    if (!subjectFiles.length) {
      this.add(
        'QC-01',
        'warn',
        'Subject table missing',
        'Uniqueness of subject_id can only be checked when the subject table is in the package.',
        'Dataset'
      );
    }
    for (const file of this.files) {
      if (!file.headers.some((header) => header.header === 'subject_id')) {
        this.add(
          'QC-01',
          'error',
          'subject_id missing',
          'Every SEARCH table carries subject_id.',
          file.fileName,
          'subject_id'
        );
        continue;
      }
      file.rows.forEach((row, index) => {
        const value = this.cell(file, row, 'subject_id');
        const where = this.loc(file, index + 2);
        if (!value) {
          this.add('QC-01', 'error', 'subject_id empty', 'subject_id is required on every row.', where, 'subject_id');
          return;
        }
        if (!this.subjectPattern.test(value)) {
          this.add(
            'QC-01',
            'error',
            'subject_id pattern',
            `subject_id must match ${this.catalog.subjectIdPattern}.`,
            where,
            'subject_id',
            value
          );
        }
        if (file.table === 'subject') {
          subjectIds.add(value);
          const previous = seen.get(value);
          if (previous) {
            this.add(
              'QC-01',
              'error',
              'Duplicate subject_id',
              `subject_id ${value} is already used at ${previous}.`,
              where,
              'subject_id',
              value
            );
          } else {
            seen.set(value, where);
          }
        }
      });
    }
    if (subjectFiles.length) {
      for (const file of this.files) {
        if (file.table === 'subject' || !file.headers.some((header) => header.header === 'subject_id')) continue;
        file.rows.forEach((row, index) => {
          const value = this.cell(file, row, 'subject_id');
          if (value && this.subjectPattern.test(value) && !subjectIds.has(value)) {
            this.add(
              'QC-01',
              'error',
              'Unknown subject_id',
              'subject_id is not listed in the subject table.',
              this.loc(file, index + 2),
              'subject_id',
              value
            );
          }
        });
      }
    }
  }

  private qc02(): void {
    this.mark('QC-02');
    for (const file of this.files) {
      for (const header of file.headers) {
        const forbidden = header.kind === 'forbidden';
        const named = IDENTIFIER_COLUMN.test(header.header);
        if (!forbidden && !named) continue;
        this.add(
          'QC-02',
          'error',
          forbidden ? 'Local-only column exported' : 'Identifier column',
          forbidden
            ? `${header.header} is a local-only field (calendar dates are not exported).`
            : `${header.header} looks like a direct identifier and is not a SEARCH variable.`,
          file.fileName,
          header.header
        );
      }
      file.rows.forEach((row, index) => {
        file.headers.forEach((header, column) => {
          const value = row[column] ?? '';
          if (!value) return;
          if (header.kind === 'forbidden' || IDENTIFIER_COLUMN.test(header.header)) return;
          const where = this.loc(file, index + 2);
          if (EMAIL.test(value)) {
            this.add('QC-02', 'error', 'Email address', 'A cell contains an email address.', where, header.header, value);
          } else if (
            (header.cde?.dataType === 'text' || header.kind === 'unknown') &&
            looksLikePhone(value)
          ) {
            this.add('QC-02', 'error', 'Phone number', 'A free-text cell contains a phone number.', where, header.header, value);
          } else if (header.cde?.dataType === 'text' && ISO_DATE.test(value)) {
            this.add(
              'QC-02',
              'error',
              'Calendar date in text',
              'Calendar dates are not exported. Use a day offset.',
              where,
              header.header,
              value
            );
          }
        });
      });
    }
  }

  private qc03(): void {
    this.mark('QC-03');
    for (const file of this.files) {
      if (!file.table) {
        this.add(
          'QC-03',
          'error',
          'Unknown table',
          `The file is not one of the SEARCH tables (${EXPORT_TABLES.join(', ')}).`,
          file.fileName
        );
      }
      const seen = new Set<string>();
      for (const header of file.headers) {
        if (!header.header) {
          this.add('QC-03', 'error', 'Empty column name', 'A header cell is empty.', file.fileName);
          continue;
        }
        if (seen.has(header.header)) {
          this.add('QC-03', 'error', 'Duplicate column', `${header.header} is repeated.`, file.fileName, header.header);
        }
        seen.add(header.header);
        if (header.kind === 'unknown') {
          this.add(
            'QC-03',
            'error',
            'Unknown column',
            `${header.header} is not a SEARCH variable for ${file.table ?? 'this file'}, and it is not a _dar or _comparator companion.`,
            file.fileName,
            header.header
          );
        }
      }
    }
  }

  private qc04(): void {
    this.mark('QC-04');
    for (const file of this.files) {
      const base = file.fileName.split(/[/\\]/).pop() ?? file.fileName;
      if (!FILE_NAME.test(base)) {
        this.add(
          'QC-04',
          'warn',
          'File name',
          'Expected <dataset_id>_<table>_<YYYYMMDD>.csv.',
          file.fileName
        );
      }
      if (file.delimiter !== ',') {
        this.add(
          'QC-04',
          'error',
          'Delimiter',
          'The file is not comma-separated. SEARCH exports use a comma delimiter.',
          file.fileName
        );
      }
      if (file.replacementChar) {
        this.add(
          'QC-04',
          'error',
          'Encoding',
          'The file contains a Unicode replacement character. SEARCH exports are UTF-8.',
          file.fileName
        );
      }
      if (!file.headers.length) {
        this.add('QC-04', 'error', 'Missing header', 'The file has no header row.', file.fileName);
      }
      file.rows.forEach((row, index) => {
        file.headers.forEach((header, column) => {
          if (header.cde?.dataType !== 'time') return;
          const value = row[column] ?? '';
          if (!value || isDar(value, this.dar) || TIME.test(value)) return;
          this.add(
            'QC-04',
            'error',
            'Time format',
            'Time values use HH:MM.',
            this.loc(file, index + 2),
            header.header,
            value
          );
        });
      });
    }
  }

  private qc05(): void {
    let saw = false;
    for (const file of this.files) {
      file.rows.forEach((row, index) => {
        file.headers.forEach((header, column) => {
          const value = row[column] ?? '';
          if (!value || isDar(value, this.dar)) return;
          if (header.kind === 'companion-dar') {
            saw = true;
            this.add(
              'QC-05',
              'error',
              'DataAbsentReason',
              `${header.header} is not a FHIR DataAbsentReason code.`,
              this.loc(file, index + 2),
              header.header,
              value
            );
            return;
          }
          const cde = header.cde;
          if (!cde || cde.dataType === 'boolean') return;
          const coded = cde.dataType === 'code' || cde.dataType === 'standard_code';
          if (!coded && cde.variable !== 'dataset_id') return;
          saw = true;
          const tokens = cde.dataType === 'standard_code' ? value.split('|').map((token) => token.trim()).filter(Boolean) : [value];
          const codes = cde.valueSet ? this.valueSets.get(cde.valueSet) : undefined;
          const pattern = patternFromRange(cde.range);
          for (const token of tokens) {
            if (codes && !codes.has(token)) {
              this.add(
                'QC-05',
                'error',
                'Value not in set',
                `${header.header} must belong to ${cde.valueSet} or be a DataAbsentReason code.`,
                this.loc(file, index + 2),
                header.header,
                value
              );
            } else if (!codes && pattern && !pattern.test(token)) {
              this.add(
                'QC-05',
                'error',
                'Coded pattern',
                `${header.header} must match ${cde.range}.`,
                this.loc(file, index + 2),
                header.header,
                value
              );
            } else if (!codes && !pattern && cde.variable === 'dataset_id' && !datasetCodeAllowed(token, cde.range)) {
              this.add(
                'QC-05',
                'error',
                'dataset_id',
                `dataset_id must be in ${cde.range}.`,
                this.loc(file, index + 2),
                header.header,
                value
              );
            }
          }
        });
      });
    }
    if (saw || this.files.some((file) => file.headers.some((header) => header.cde?.valueSet || header.kind === 'companion-dar'))) {
      this.mark('QC-05');
    }
  }

  private qc06(): void {
    let saw = false;
    for (const file of this.files) {
      file.rows.forEach((row, index) => {
        file.headers.forEach((header, column) => {
          if (header.cde?.dataType !== 'boolean') return;
          saw = true;
          const value = row[column] ?? '';
          if (value === '' || value === '0' || value === '1') return;
          this.add(
            'QC-06',
            'error',
            'Boolean value',
            'Boolean cells are 1, 0, or empty.',
            this.loc(file, index + 2),
            header.header,
            value
          );
        });
      });
    }
    if (saw) this.mark('QC-06');
  }

  private qc07(): void {
    let saw = false;
    for (const file of this.files) {
      file.rows.forEach((row, index) => {
        file.headers.forEach((header, column) => {
          const value = row[column] ?? '';
          if (!value) return;
          const numeric =
            header.cde?.dataType === 'integer' ||
            header.cde?.dataType === 'decimal' ||
            header.cde?.dataType === 'duration';
          if (header.kind === 'companion-comparator') {
            saw = true;
            if (!COMPARATORS.has(value)) {
              this.add(
                'QC-07',
                'error',
                'Comparator',
                'A comparator cell is one of <, <=, >, >=, =.',
                this.loc(file, index + 2),
                header.header,
                value
              );
            }
            return;
          }
          if (!numeric) return;
          saw = true;
          if (parseNumber(value) !== null) return;
          const why = value.includes(',')
            ? 'Use a dot as the decimal separator, not a comma.'
            : /[<>]/.test(value)
              ? 'Put the comparator in the companion column and keep only the number here.'
              : 'Numeric cells contain only a number, with no unit or text.';
          this.add('QC-07', 'error', 'Numeric value', why, this.loc(file, index + 2), header.header, value);
        });
      });
    }
    if (saw) this.mark('QC-07');
  }

  private qc08(): void {
    let saw = false;
    for (const file of this.files) {
      file.rows.forEach((row, index) => {
        file.headers.forEach((header, column) => {
          if (header.cde?.dataType !== 'day_offset') return;
          const value = row[column] ?? '';
          if (!value) return;
          saw = true;
          const n = parseNumber(value);
          if (n === null || !Number.isInteger(n)) {
            this.add(
              'QC-08',
              'error',
              'Day offset',
              'A day offset is an integer count of days from the index date, not a calendar date.',
              this.loc(file, index + 2),
              header.header,
              value
            );
            return;
          }
          if (n < this.catalog.dayOffsetMin || n > this.catalog.dayOffsetMax) {
            this.add(
              'QC-08',
              'warn',
              'Day offset window',
              `Day offsets are expected between ${this.catalog.dayOffsetMin} and ${this.catalog.dayOffsetMax}.`,
              this.loc(file, index + 2),
              header.header,
              value
            );
          }
        });
      });
    }
    if (saw) this.mark('QC-08');
  }

  private qc09(): void {
    const names = new Set<string>();
    for (const cde of this.catalog.cdes) {
      if (cde.dataType === 'day_offset' && cde.variable.includes('follow')) names.add(cde.variable);
    }
    if (![...names].some((name) => this.hasHeader(name))) return;
    this.mark('QC-09');
    for (const file of this.files) {
      file.rows.forEach((row, index) => {
        for (const name of names) {
          const value = this.cell(file, row, name);
          const n = parseNumber(value);
          if (n === null) continue;
          if (n < 0) {
            this.add(
              'QC-09',
              'warn',
              'Follow-up day',
              'A follow-up day is on or after the index date.',
              this.loc(file, index + 2),
              name,
              value
            );
          }
        }
      });
    }
  }

  private qc10(): void {
    const needed = ['colonoscopy_day', 'colonoscopy_planned_day', 'colonoscopy_referral_day'];
    if (!needed.some((name) => this.hasHeader(name, 'event'))) return;
    this.mark('QC-10');
    this.eachRow('event', (file, row, rowNumber) => {
      const day = parseNumber(this.cell(file, row, 'colonoscopy_day'));
      const planned = parseNumber(this.cell(file, row, 'colonoscopy_planned_day'));
      const referral = parseNumber(this.cell(file, row, 'colonoscopy_referral_day'));
      if (day !== null && day < 0) {
        this.add('QC-10', 'warn', 'Colonoscopy day', 'colonoscopy_day is on or after the index date.', this.loc(file, rowNumber), 'colonoscopy_day', String(day));
      }
      if (planned !== null && referral !== null && planned < referral) {
        this.add(
          'QC-10',
          'warn',
          'Colonoscopy timing',
          'colonoscopy_planned_day is on or after colonoscopy_referral_day.',
          this.loc(file, rowNumber),
          'colonoscopy_planned_day',
          String(planned)
        );
      }
    });
  }

  private datasetOf(file: ParsedFile, row: string[], subjectId: string): string {
    const explicit = this.cell(file, row, 'dataset_id') || this.firstSubjectValue(subjectId, 'dataset_id');
    if (/^DS\d{2}/i.test(explicit)) return explicit.slice(0, 4).toUpperCase();
    return /^DS\d{2}/i.test(subjectId) ? subjectId.slice(0, 4).toUpperCase() : '';
  }

  private qc11(): void {
    if (!this.hasHeader('age_at_index_years', 'subject')) return;
    this.mark('QC-11');
    this.eachRow('subject', (file, row, rowNumber) => {
      const raw = this.cell(file, row, 'age_at_index_years');
      const age = parseNumber(raw);
      if (age === null) return;
      const dataset = this.datasetOf(file, row, this.cell(file, row, 'subject_id'));
      let min = 0;
      let max = 120;
      let label = '0–120';
      if (dataset === 'DS01') {
        min = 20;
        max = 76;
        label = 'DS01 20–76';
      } else if (dataset === 'DS02') {
        min = 18;
        label = 'DS02 ≥ 18 and ≤ 120';
      }
      if (age < min || age > max) {
        this.add('QC-11', 'warn', 'Age range', `Age is outside ${label}.`, this.loc(file, rowNumber), 'age_at_index_years', raw);
      }
    });
  }

  private qc12(): void {
    if (!this.hasHeader('body_height_cm', 'subject') && !this.hasHeader('body_weight_kg', 'subject')) return;
    this.mark('QC-12');
    this.eachRow('subject', (file, row, rowNumber) => {
      const height = parseNumber(this.cell(file, row, 'body_height_cm'));
      const weight = parseNumber(this.cell(file, row, 'body_weight_kg'));
      if (height !== null && (height < 100 || height > 250)) {
        this.add('QC-12', 'warn', 'Height', 'Height is outside 100–250 cm.', this.loc(file, rowNumber), 'body_height_cm', String(height));
      }
      if (weight !== null && (weight < 30 || weight > 250)) {
        this.add('QC-12', 'warn', 'Weight', 'Weight is outside 30–250 kg.', this.loc(file, rowNumber), 'body_weight_kg', String(weight));
      }
    });
  }

  private qc13(): void {
    if (!this.hasHeader('bmi_kg_m2', 'subject')) return;
    this.mark('QC-13');
    this.eachRow('subject', (file, row, rowNumber) => {
      const bmi = parseNumber(this.cell(file, row, 'bmi_kg_m2'));
      if (bmi === null) return;
      if (bmi < 12 || bmi > 70) {
        this.add('QC-13', 'warn', 'BMI range', 'BMI is outside 12–70.', this.loc(file, rowNumber), 'bmi_kg_m2', String(bmi));
      }
      const height = parseNumber(this.cell(file, row, 'body_height_cm'));
      const weight = parseNumber(this.cell(file, row, 'body_weight_kg'));
      if (height === null || weight === null || height <= 0) return;
      const expected = weight / (height / 100) ** 2;
      if (Math.abs(bmi - expected) > 1) {
        this.add(
          'QC-13',
          'warn',
          'BMI consistency',
          `BMI differs from weight/height² (${expected.toFixed(1)}) by more than 1.`,
          this.loc(file, rowNumber),
          'bmi_kg_m2',
          String(bmi)
        );
      }
    });
  }

  private qc14(): void {
    if (!this.hasHeader('body_surface_area_m2', 'event')) return;
    this.mark('QC-14');
    this.eachRow('event', (file, row, rowNumber) => {
      const bsa = parseNumber(this.cell(file, row, 'body_surface_area_m2'));
      if (bsa === null) return;
      if (bsa < 1 || bsa > 3) {
        this.add('QC-14', 'warn', 'BSA range', 'BSA is outside 1.0–3.0 m².', this.loc(file, rowNumber), 'body_surface_area_m2', String(bsa));
      }
      const subjectId = this.cell(file, row, 'subject_id');
      const height = parseNumber(this.firstSubjectValue(subjectId, 'body_height_cm'));
      const weight = parseNumber(this.firstSubjectValue(subjectId, 'body_weight_kg'));
      if (height === null || weight === null || height <= 0 || weight <= 0) return;
      const mosteller = Math.sqrt((height * weight) / 3600);
      if (Math.abs(bsa - mosteller) > 0.05) {
        this.add(
          'QC-14',
          'warn',
          'BSA formula',
          `BSA differs from the Mosteller formula (${mosteller.toFixed(2)} m²) by more than 0.05.`,
          this.loc(file, rowNumber),
          'body_surface_area_m2',
          String(bsa)
        );
      }
    });
  }

  private qc15(): void {
    const present = INDEX_PAIRS.some(([absolute, indexed]) => this.hasHeader(absolute, 'event') && this.hasHeader(indexed, 'event'));
    if (!present || !this.hasHeader('body_surface_area_m2', 'event')) return;
    this.mark('QC-15');
    this.eachRow('event', (file, row, rowNumber) => {
      const bsa = parseNumber(this.cell(file, row, 'body_surface_area_m2'));
      if (bsa === null || bsa === 0) return;
      for (const [absoluteName, indexedName] of INDEX_PAIRS) {
        const absolute = parseNumber(this.cell(file, row, absoluteName));
        const indexed = parseNumber(this.cell(file, row, indexedName));
        if (absolute === null || indexed === null) continue;
        const expected = absolute / bsa;
        const diff = Math.abs(indexed - expected);
        const relative = expected === 0 ? diff : diff / Math.abs(expected);
        if (diff > 1 && relative > 0.05) {
          this.add(
            'QC-15',
            'warn',
            'Indexed cardiac value',
            `${indexedName} is not absolute/BSA (${expected.toFixed(1)}) within 1 unit or 5%.`,
            this.loc(file, rowNumber),
            indexedName,
            String(indexed)
          );
        }
      }
    });
  }

  private qc16(): void {
    if (!EF_PAIRS.some(([ef, edv, esv]) => this.hasHeader(ef, 'event') && this.hasHeader(edv, 'event') && this.hasHeader(esv, 'event'))) {
      return;
    }
    this.mark('QC-16');
    this.eachRow('event', (file, row, rowNumber) => {
      for (const [efName, edvName, esvName] of EF_PAIRS) {
        const ef = parseNumber(this.cell(file, row, efName));
        if (ef === null) continue;
        if (ef < 5 || ef > 90) {
          this.add('QC-16', 'warn', 'Ejection fraction', 'Ejection fraction is outside 5–90.', this.loc(file, rowNumber), efName, String(ef));
        }
        const edv = parseNumber(this.cell(file, row, edvName));
        const esv = parseNumber(this.cell(file, row, esvName));
        if (edv === null || esv === null || edv === 0) continue;
        const expected = ((edv - esv) / edv) * 100;
        if (Math.abs(ef - expected) > 2) {
          this.add(
            'QC-16',
            'warn',
            'Ejection fraction consistency',
            `${efName} differs from (EDV−ESV)/EDV×100 (${expected.toFixed(1)}) by more than 2 points.`,
            this.loc(file, rowNumber),
            efName,
            String(ef)
          );
        }
      }
    });
  }

  private qc17(): void {
    const pairs: Array<[string, string]> = [
      ['lv_esv_ml', 'lv_edv_ml'],
      ['rv_esv_ml', 'rv_edv_ml']
    ];
    if (!pairs.some(([esv, edv]) => this.hasHeader(esv, 'event') && this.hasHeader(edv, 'event'))) return;
    this.mark('QC-17');
    this.eachRow('event', (file, row, rowNumber) => {
      for (const [esvName, edvName] of pairs) {
        const esv = parseNumber(this.cell(file, row, esvName));
        const edv = parseNumber(this.cell(file, row, edvName));
        if (esv === null || edv === null) continue;
        if (esv >= edv) {
          this.add('QC-17', 'error', 'ESV and EDV', 'ESV must be lower than EDV.', this.loc(file, rowNumber), esvName, String(esv));
        }
      }
    });
  }

  private qc18(): void {
    const labs = this.catalog.cdes.filter(
      (cde) =>
        cde.domain === 'LAB' &&
        (cde.dataType === 'integer' || cde.dataType === 'decimal') &&
        cde.variable !== 'haematocrit_fraction' &&
        numericBounds(cde.range)
    );
    if (!labs.some((cde) => this.hasHeader(cde.variable))) return;
    this.mark('QC-18');
    for (const cde of labs) {
      const bounds = numericBounds(cde.range);
      if (!bounds) continue;
      this.eachRow(null, (file, row, rowNumber) => {
        const raw = this.cell(file, row, cde.variable);
        const value = parseNumber(raw);
        if (value === null) return;
        const outside = (bounds.min !== undefined && value < bounds.min) || (bounds.max !== undefined && value > bounds.max);
        if (!outside && value !== 0) return;
        if (value === 0 && bounds.min !== undefined && bounds.min > 0) {
          this.add(
            'QC-18',
            'warn',
            'Lab value 0',
            `${cde.variable} is 0, outside ${cde.range}. Zero may be a missing-value code.`,
            this.loc(file, rowNumber),
            cde.variable,
            raw
          );
          return;
        }
        if (outside) {
          this.add(
            'QC-18',
            'warn',
            'Lab range',
            `${cde.variable} is outside ${cde.range}.`,
            this.loc(file, rowNumber),
            cde.variable,
            raw
          );
        }
      });
    }
  }

  private qc19(): void {
    if (!this.hasHeader('haematocrit_fraction')) return;
    this.mark('QC-19');
    this.eachRow(null, (file, row, rowNumber) => {
      const raw = this.cell(file, row, 'haematocrit_fraction');
      const value = parseNumber(raw);
      if (value === null) return;
      if (value >= 10 && value <= 70) {
        this.add(
          'QC-19',
          'warn',
          'Haematocrit percent',
          'Haematocrit looks like a percent. Divide by 100 so the fraction is 0.10–0.70.',
          this.loc(file, rowNumber),
          'haematocrit_fraction',
          raw
        );
        return;
      }
      if (value < 0.1 || value > 0.7) {
        this.add(
          'QC-19',
          'warn',
          'Haematocrit range',
          'Haematocrit is outside 0.10–0.70.',
          this.loc(file, rowNumber),
          'haematocrit_fraction',
          raw
        );
      }
    });
  }

  private qc20(): void {
    if (!this.hasHeader('egfr_ml_min_1_73m2')) return;
    this.mark('QC-20');
    if (!this.hasHeader('egfr_equation')) {
      this.add('QC-20', 'error', 'egfr_equation missing', 'egfr_equation is required when an eGFR value is exported.', 'Dataset', 'egfr_equation');
    }
    this.eachRow(null, (file, row, rowNumber) => {
      const egfr = this.cell(file, row, 'egfr_ml_min_1_73m2');
      if (!egfr || isDar(egfr, this.dar)) return;
      const equation = this.cell(file, row, 'egfr_equation');
      if (!equation) {
        this.add(
          'QC-20',
          'error',
          'egfr_equation empty',
          'When egfr_ml_min_1_73m2 is filled, egfr_equation is filled too.',
          this.loc(file, rowNumber),
          'egfr_equation',
          egfr
        );
      }
    });
  }

  private qc21(): void {
    if (!this.hasHeader('hpv_hr_dna_cobas_result', 'subject')) return;
    this.mark('QC-21');
    const genotypes = this.filesNamed('subject')
      .flatMap((file) => file.headers.map((header) => header.header))
      .filter((header, index, all) => GENOTYPE_COLUMNS.some((pattern) => pattern.test(header)) && all.indexOf(header) === index);
    this.eachRow('subject', (file, row, rowNumber) => {
      if (this.cell(file, row, 'hpv_hr_dna_cobas_result') !== 'pos') return;
      const addressed = genotypes.some((name) => {
        const value = this.cell(file, row, name);
        const dar = this.cell(file, row, `${name}_dar`);
        return Boolean(value || dar);
      });
      if (addressed) return;
      this.add(
        'QC-21',
        'warn',
        'HPV genotype',
        genotypes.length
          ? 'A positive cobas high-risk result expects a triage genotype, or a _dar companion.'
          : 'A positive cobas high-risk result expects triage genotype columns (or their _dar companions), and none are in this export.',
        this.loc(file, rowNumber),
        'hpv_hr_dna_cobas_result',
        'pos'
      );
    });
  }

  private qc22(): void {
    const result = 'cervical_cytology_result_followup';
    const day = 'cervical_cytology_day_followup';
    if (!this.hasHeader(result, 'subject') || !this.hasHeader(day, 'subject')) return;
    this.mark('QC-22');
    this.eachRow('subject', (file, row, rowNumber) => {
      const hasResult = Boolean(this.cell(file, row, result));
      const hasDay = Boolean(this.cell(file, row, day));
      if (hasResult === hasDay) return;
      this.add(
        'QC-22',
        'warn',
        'Cytology follow-up',
        'cervical_cytology_result_followup and cervical_cytology_day_followup are filled together.',
        this.loc(file, rowNumber),
        hasResult ? result : day
      );
    });
  }

  private qc23(): void {
    if (!this.hasHeader('figo_stage', 'subject')) return;
    this.mark('QC-23');
    this.eachRow('subject', (file, row, rowNumber) => {
      const stage = this.cell(file, row, 'figo_stage');
      if (!stage || isDar(stage, this.dar)) return;
      const system = this.cell(file, row, 'figo_staging_system');
      if (!system) {
        this.add('QC-23', 'error', 'FIGO system missing', 'figo_stage is only exported with figo_staging_system.', this.loc(file, rowNumber), 'figo_stage', stage);
        return;
      }
      const allowed =
        system === 'figo_2014_ovarian'
          ? FIGO_OVARIAN
          : system === 'figo_2018_cervical'
            ? FIGO_CERVICAL
            : system === 'figo_2009_endometrial' || system === 'figo_2023_endometrial'
              ? FIGO_ENDOMETRIAL
              : null;
      if (allowed && !allowed.has(stage)) {
        this.add(
          'QC-23',
          'error',
          'FIGO substage',
          `${stage} is not a substage of ${system}.`,
          this.loc(file, rowNumber),
          'figo_stage',
          stage
        );
      }
    });
  }

  private qc24(): void {
    if (!this.hasHeader('tumour_behaviour', 'subject') || !this.hasHeader('figo_stage', 'subject')) return;
    this.mark('QC-24');
    this.eachRow('subject', (file, row, rowNumber) => {
      if (this.cell(file, row, 'tumour_behaviour') !== '0') return;
      const stage = this.cell(file, row, 'figo_stage');
      if (!stage || isNotApplicable(stage)) return;
      this.add(
        'QC-24',
        'warn',
        'FIGO on benign tumour',
        "When tumour_behaviour is 0, figo_stage is empty or not-applicable.",
        this.loc(file, rowNumber),
        'figo_stage',
        stage
      );
    });
  }

  private qc25(): void {
    if (!this.hasHeader('chemo_response_score', 'subject')) return;
    this.mark('QC-25');
    this.eachRow('subject', (file, row, rowNumber) => {
      const score = this.cell(file, row, 'chemo_response_score');
      if (!score || isDar(score, this.dar)) return;
      if (this.cell(file, row, 'treatment_pathway') === 'nact_icrs') return;
      this.add(
        'QC-25',
        'warn',
        'Chemo response score',
        'chemo_response_score is only used when treatment_pathway is nact_icrs.',
        this.loc(file, rowNumber),
        'chemo_response_score',
        score
      );
    });
  }

  private qc26(): void {
    if (!this.hasHeader('neoadjuvant_chemo_cycles', 'treatment')) return;
    this.mark('QC-26');
    this.eachRow('treatment', (file, row, rowNumber) => {
      const raw = this.cell(file, row, 'neoadjuvant_chemo_cycles');
      const cycles = parseNumber(raw);
      if (raw === '' || cycles === 0) return;
      const pathway = this.firstSubjectValue(this.cell(file, row, 'subject_id'), 'treatment_pathway');
      if (pathway === 'nact_icrs') return;
      this.add(
        'QC-26',
        'warn',
        'Neoadjuvant cycles',
        'neoadjuvant_chemo_cycles is 0 or empty unless treatment_pathway is nact_icrs.',
        this.loc(file, rowNumber),
        'neoadjuvant_chemo_cycles',
        raw
      );
    });
  }

  private qc27(): void {
    if (!this.hasHeader('peritoneal_cancer_index_score', 'subject')) return;
    this.mark('QC-27');
    this.eachRow('subject', (file, row, rowNumber) => {
      const raw = this.cell(file, row, 'peritoneal_cancer_index_score');
      if (!raw || isDar(raw, this.dar)) return;
      const value = parseNumber(raw);
      if (value === null || !Number.isInteger(value) || value < 0 || value > 39) {
        this.add('QC-27', 'error', 'PCI', 'peritoneal_cancer_index_score is an integer from 0 to 39.', this.loc(file, rowNumber), 'peritoneal_cancer_index_score', raw);
      }
    });
  }

  private qc28(): void {
    if (!this.hasHeader('pfs_months', 'subject')) return;
    this.mark('QC-28');
    this.eachRow('subject', (file, row, rowNumber) => {
      const pfs = parseNumber(this.cell(file, row, 'pfs_months'));
      if (pfs === null) return;
      const os = parseNumber(this.cell(file, row, 'os_months'));
      if (os !== null && pfs > os) {
        this.add('QC-28', 'warn', 'PFS after OS', 'pfs_months is less than or equal to os_months.', this.loc(file, rowNumber), 'pfs_months', String(pfs));
      }
      if (!this.cell(file, row, 'pfs_event')) {
        this.add('QC-28', 'warn', 'PFS event missing', 'pfs_event is filled when pfs_months is filled.', this.loc(file, rowNumber), 'pfs_event');
      }
    });
  }

  private qc29(): void {
    if (!this.hasHeader('vital_status', 'subject')) return;
    this.mark('QC-29');
    this.eachRow('subject', (file, row, rowNumber) => {
      if (this.cell(file, row, 'vital_status') !== 'deceased') return;
      if (this.cell(file, row, 'os_months')) return;
      this.add('QC-29', 'warn', 'Overall survival', 'A deceased vital status has os_months.', this.loc(file, rowNumber), 'os_months');
    });
  }

  private qc30(): void {
    if (!GENE_PAIRS.some(([germline]) => this.hasHeader(germline, 'subject'))) return;
    this.mark('QC-30');
    this.eachRow('subject', (file, row, rowNumber) => {
      for (const [germline, somatic] of GENE_PAIRS) {
        if (this.cell(file, row, germline) === 'pv_detected' && this.cell(file, row, somatic) === 'no_pv_detected') {
          this.add(
            'QC-30',
            'warn',
            'Germline and somatic status',
            `Info: ${germline} is pathogenic while ${somatic} is no_pv_detected. Tumour testing usually detects a germline pathogenic variant.`,
            this.loc(file, rowNumber),
            somatic,
            'no_pv_detected'
          );
        }
      }
    });
  }

  private qc31(ruleId: string, detectedName: string, countName: string): void {
    if (!this.hasHeader(detectedName, 'event') && !this.hasHeader(countName, 'event')) return;
    this.mark(ruleId);
    const sums = new Map<string, number>();
    this.eachRow('event', (file, row, rowNumber) => {
      const subjectId = this.cell(file, row, 'subject_id');
      const detected = this.cell(file, row, detectedName);
      const countRaw = this.cell(file, row, countName);
      const count = parseNumber(countRaw);
      if (detected === '0' && countRaw && !isNotApplicable(countRaw) && count !== 0) {
        this.add(ruleId, 'warn', 'Polyp count', `When ${detectedName} is 0, ${countName} is 0 or not-applicable.`, this.loc(file, rowNumber), countName, countRaw);
      }
      if (detected === '1' && (count === null || count < 1)) {
        this.add(ruleId, 'warn', 'Polyp count', `When ${detectedName} is 1, ${countName} is at least 1.`, this.loc(file, rowNumber), countName, countRaw);
      }
      if (count !== null) sums.set(subjectId, (sums.get(subjectId) ?? 0) + count);
    });
    const lesions = new Map<string, number>();
    this.eachRow('lesion', (file, row) => {
      const subjectId = this.cell(file, row, 'subject_id');
      lesions.set(subjectId, (lesions.get(subjectId) ?? 0) + 1);
    });
    const subjects = new Set([...sums.keys(), ...lesions.keys()]);
    for (const subjectId of subjects) {
      if (!this.subjectHas(subjectId, detectedName) && !this.subjectHas(subjectId, countName)) continue;
      const count = sums.get(subjectId) ?? 0;
      const lesionCount = lesions.get(subjectId) ?? 0;
      if (count === lesionCount) continue;
      this.add(
        ruleId,
        'warn',
        'Polyp count and lesions',
        `${countName} sums to ${count} for ${subjectId}, but the lesion table has ${lesionCount} row(s).`,
        'Dataset',
        countName,
        String(count)
      );
    }
  }

  private subjectHas(subjectId: string, header: string): boolean {
    let found = false;
    this.eachRow('event', (file, row) => {
      if (this.cell(file, row, 'subject_id') === subjectId && this.cell(file, row, header) !== '') found = true;
    });
    return found;
  }

  private qc33(): void {
    if (!POLYP_SIZES.some((name) => this.hasHeader(name))) return;
    this.mark('QC-33');
    this.eachRow(null, (file, row, rowNumber) => {
      for (const name of POLYP_SIZES) {
        const raw = this.cell(file, row, name);
        const value = parseNumber(raw);
        if (value === null) continue;
        if (value < 0.5 || value > 150) {
          this.add('QC-33', 'warn', 'Polyp size', 'Polyp size is between 0.5 and 150 mm.', this.loc(file, rowNumber), name, raw);
        }
      }
    });
  }

  private qc34(): void {
    if (!this.hasHeader('polyp_dysplasia', 'specimen') && !this.hasHeader('polyp_histology', 'specimen')) return;
    this.mark('QC-34');
    this.eachRow('specimen', (file, row, rowNumber) => {
      const dysplasia = this.cell(file, row, 'polyp_dysplasia');
      const histology = this.cell(file, row, 'polyp_histology');
      const crc = ['crc_histological_type', 'crc_grade'].filter((name) => this.cell(file, row, name));
      if (dysplasia === 'invasive_carcinoma' && histology && histology !== 'carcinoma') {
        this.add('QC-34', 'warn', 'Dysplasia and histology', 'invasive_carcinoma agrees with polyp_histology carcinoma.', this.loc(file, rowNumber), 'polyp_histology', histology);
      }
      if (histology === 'carcinoma' && dysplasia && dysplasia !== 'invasive_carcinoma') {
        this.add('QC-34', 'warn', 'Histology and dysplasia', 'polyp_histology carcinoma agrees with dysplasia invasive_carcinoma.', this.loc(file, rowNumber), 'polyp_dysplasia', dysplasia);
      }
      if (crc.length && histology !== 'carcinoma') {
        this.add('QC-34', 'warn', 'CRC fields', `${crc.join(', ')} is filled only when polyp_histology is carcinoma.`, this.loc(file, rowNumber), crc[0], histology);
      }
    });
  }

  private qc35(): void {
    if (!this.hasHeader('passage_start_time_s', 'annotation') || !this.hasHeader('passage_end_time_s', 'annotation')) return;
    this.mark('QC-35');
    const recording = new Map<string, number>();
    this.eachRow('event', (file, row) => {
      const minutes = parseNumber(this.cell(file, row, 'cce_recording_length_min'));
      if (minutes === null) return;
      const subjectId = this.cell(file, row, 'subject_id');
      recording.set(subjectId, Math.max(recording.get(subjectId) ?? 0, minutes));
    });
    this.eachRow('annotation', (file, row, rowNumber) => {
      const start = parseNumber(this.cell(file, row, 'passage_start_time_s'));
      const end = parseNumber(this.cell(file, row, 'passage_end_time_s'));
      if (start !== null && end !== null && start >= end) {
        this.add('QC-35', 'warn', 'Passage times', 'passage_start_time_s is before passage_end_time_s.', this.loc(file, rowNumber), 'passage_start_time_s', String(start));
      }
      const limit = recording.get(this.cell(file, row, 'subject_id'));
      if (limit === undefined) return;
      const seconds = limit * 60;
      for (const [name, value] of [
        ['passage_start_time_s', start],
        ['passage_end_time_s', end]
      ] as Array<[string, number | null]>) {
        if (value !== null && value > seconds) {
          this.add('QC-35', 'warn', 'Passage beyond recording', `${name} is after the recording length (${seconds} s).`, this.loc(file, rowNumber), name, String(value));
        }
      }
    });
  }

  private qc36(): void {
    const columns = this.headersMatching('questionnaire', /_vas$/);
    const sliders = this.headersMatching('questionnaire', /slider/i);
    const papers = this.headersMatching('questionnaire', /paper/i);
    if (!columns.length && !sliders.length) return;
    this.mark('QC-36');
    this.eachRow('questionnaire', (file, row, rowNumber) => {
      for (const name of columns) {
        const raw = this.cell(file, row, name);
        const value = parseNumber(raw);
        if (value === null) continue;
        if (value < 0 || value > 100) {
          this.add('QC-36', 'warn', 'VAS', 'A VAS value is between 0 and 100.', this.loc(file, rowNumber), name, raw);
        }
      }
      for (const slider of sliders) {
        const stem = slider.replace(/slider/i, '');
        const paper = papers.find((name) => name.replace(/paper/i, '') === stem);
        if (!paper) continue;
        const paperValue = this.cell(file, row, paper);
        const sliderValue = this.cell(file, row, slider);
        if (paperValue && sliderValue) {
          this.add(
            'QC-36',
            'warn',
            'VAS slider and paper',
            `${slider} is the value that is used. Leave ${paper} empty.`,
            this.loc(file, rowNumber),
            paper,
            paperValue
          );
        }
      }
    });
  }

  private qc37(): void {
    const items = Array.from({ length: 10 }, (_, index) => `pss10_item_${String(index + 1).padStart(2, '0')}`);
    const present = items.filter((name) => this.hasHeader(name, 'questionnaire'));
    if (!present.length && !this.hasHeader('pss10_total_score', 'questionnaire')) return;
    this.mark('QC-37');
    this.eachRow('questionnaire', (file, row, rowNumber) => {
      const values = items.map((name) => this.cell(file, row, name));
      values.forEach((raw, index) => {
        if (!raw) return;
        const value = parseNumber(raw);
        if (value === null || !Number.isInteger(value) || value < 0 || value > 4) {
          this.add('QC-37', 'error', 'PSS-10 item', 'Each PSS-10 item is an integer from 0 to 4.', this.loc(file, rowNumber), items[index], raw);
        }
      });
      const totalRaw = this.cell(file, row, 'pss10_total_score');
      if (!totalRaw) return;
      const missing = items.filter((name) => !this.cell(file, row, name));
      if (missing.length) {
        this.add(
          'QC-37',
          'error',
          'PSS-10 total',
          `pss10_total_score is computed only when all 10 items are present. Missing: ${missing.join(', ')}.`,
          this.loc(file, rowNumber),
          'pss10_total_score',
          totalRaw
        );
        return;
      }
      const total = parseNumber(totalRaw);
      const sum = values.reduce((acc, raw) => acc + (parseNumber(raw) ?? 0), 0);
      if (total === null || total !== sum) {
        this.add('QC-37', 'error', 'PSS-10 total', `pss10_total_score should be the sum of the 10 items (${sum}).`, this.loc(file, rowNumber), 'pss10_total_score', totalRaw);
      }
    });
  }

  private qc38(): void {
    const dayColumns = this.headersMatching('questionnaire', /^work_absence_days_[a-z0-9_]+$/);
    if (!dayColumns.length) return;
    this.mark('QC-38');
    this.eachRow('questionnaire', (file, row, rowNumber) => {
      for (const days of dayColumns) {
        const value = this.cell(file, row, days);
        if (!value) continue;
        const flag = `work_absence_${days.slice('work_absence_days_'.length)}`;
        if (this.cell(file, row, flag) === '1') continue;
        this.add('QC-38', 'warn', 'Work absence days', `${days} is filled only when ${flag} is 1.`, this.loc(file, rowNumber), days, value);
      }
    });
  }

  private qc39(): void {
    if (!this.hasHeader('consent_given', 'subject')) return;
    this.mark('QC-39');
    this.eachRow('subject', (file, row, rowNumber) => {
      const value = this.cell(file, row, 'consent_given');
      if (value === '1') return;
      this.add('QC-39', 'error', 'Consent', 'Only records with consent_given = 1 are exported.', this.loc(file, rowNumber), 'consent_given', value);
    });
  }

  private qc40(): void {
    const quasi = ['age_at_index_years', 'sex', 'country_of_birth', 'tumour_histotype'].filter((name) =>
      this.hasHeader(name, 'subject')
    );
    const hasSite = this.hasHeader('site_code', 'event');
    if (quasi.length + (hasSite ? 1 : 0) < 2) return;
    this.mark('QC-40');
    const siteOf = new Map<string, string>();
    this.eachRow('event', (file, row) => {
      const subjectId = this.cell(file, row, 'subject_id');
      const site = this.cell(file, row, 'site_code');
      if (!subjectId || !site || siteOf.has(subjectId)) return;
      siteOf.set(subjectId, site);
    });
    const groups = new Map<string, string[]>();
    const seen = new Set<string>();
    for (const row of this.subjectRows()) {
      if (!row.id || seen.has(row.id)) continue;
      seen.add(row.id);
      const parts: string[] = [];
      const age = parseNumber(this.cell(row.file, row.row, 'age_at_index_years'));
      if (age !== null) {
        const start = Math.floor(age / 5) * 5;
        parts.push(`age ${start}–${start + 4}`);
      }
      const sex = this.cell(row.file, row.row, 'sex');
      if (sex) parts.push(`sex ${sex}`);
      const country = this.cell(row.file, row.row, 'country_of_birth');
      if (country) parts.push(`country ${country}`);
      const site = siteOf.get(row.id);
      if (site) parts.push(`site ${site}`);
      const histology = this.cell(row.file, row.row, 'tumour_histotype');
      if (histology) parts.push(`histotype ${histology}`);
      if (parts.length < 2) continue;
      const key = parts.join(', ');
      const members = groups.get(key) ?? [];
      members.push(row.id);
      groups.set(key, members);
    }
    for (const [key, members] of groups) {
      if (members.length >= 5) continue;
      this.add(
        'QC-40',
        'warn',
        'Small cell',
        `${members.length} person(s) share ${key}. Combinations of fewer than 5 persons are flagged for generalisation.`,
        'Dataset',
        'subject_id',
        members.join(', ')
      );
    }
  }
}
