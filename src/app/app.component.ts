import { CommonModule } from '@angular/common';
import { Component, ElementRef, ViewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  runDataCurationCheck,
  formatReport,
  loadAndValidateConfigText,
  resolveEffectiveConfig,
  DEFAULT_FHIR_LAB_CONFIG,
  TOOL_VERSION,
  BUILTIN_PLUGINS,
  DCC_PRESETS,
  findPreset,
  fetchTextAsset,
  fetchBinaryAsset,
  runDictionaryWorkbookCheck,
  isExcelWorkbookName,
  type CheckResult,
  type CheckIssue,
  type CheckStatus,
  type DccRunReport,
  type GateStatus,
  type ValidationMode,
  type ValidationConfig,
  type DatasetRunContext,
  type RecordValidationResult,
  type EffectiveConfigRef,
  type DccPreset
} from './checks';
import {
  downloadTextFile,
  formatBytes,
  mimeTypeForFileName,
  readLocalFlag,
  readLocalJson,
  writeLocalFlag,
  writeLocalJson
} from './browser-utils';
import {
  createFhirSampleWithIssues,
  createRandomFhirExample,
  createValidFhirDemo
} from './demo/fhir-samples';

/** Result panel tabs. */
type ResultTab = 'summary' | 'checks' | 'issues' | 'records';

/** Issue list severity filter. */
type IssueFilter = 'all' | 'error' | 'warn';

interface PersistedRunContext {
  datasetId?: string;
  sourceSite?: string;
  timeframe?: string;
  studyId?: string;
  dictionaryRef?: string;
  runMode?: ValidationMode;
  licenseField?: string;
  provenance?: string;
}

const CONTEXT_STORAGE_KEY = 'dcc-run-context-v1';
const GUIDE_STORAGE_KEY = 'dcc-guide-open';
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const RESULT_TABS: ResultTab[] = ['summary', 'checks', 'issues', 'records'];
const DATASET_EXTENSIONS = ['.json', '.ndjson', '.txt', '.csv', '.xlsx'];
const SEVERITY_ORDER: Record<CheckStatus, number> = { error: 0, warn: 1, ok: 2 };

@Component({
  standalone: true,
  selector: 'app-root',
  imports: [CommonModule, FormsModule],
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.css']
})
/**
 * Browser UI for the Data Curation Checker.
 *
 * Runs entirely client-side. Operators pick a FHIR/SHIELD preset, upload a
 * dataset, run the same `runDataCurationCheck` engine as the CLI, and export
 * JSON / Markdown / HTML reports.
 */
export class AppComponent {
  @ViewChild('fileInput') fileInput?: ElementRef<HTMLInputElement>;
  @ViewChild('configInput') configInput?: ElementRef<HTMLInputElement>;

  readonly title = 'Data Curation Checker';
  readonly toolVersion = TOOL_VERSION;
  readonly builtinPluginCount = BUILTIN_PLUGINS.length;
  readonly presets: DccPreset[] = DCC_PRESETS;
  readonly fhirPresets = DCC_PRESETS.filter((p) => p.kind === 'fhir');
  readonly shieldPresets = DCC_PRESETS.filter((p) => p.kind === 'shield');
  readonly repoUrl = 'https://github.com/Jan92/Data_Curation_Checker';

  activeConfig: ValidationConfig = DEFAULT_FHIR_LAB_CONFIG;
  configSourceLabel = 'Built-in fhir-lab-v1';
  configLoadError: string | null = null;
  selectedPresetId = 'fhir-lab-v1';
  isLoadingPreset = false;
  private cachedEffectiveConfig: EffectiveConfigRef = resolveEffectiveConfig(DEFAULT_FHIR_LAB_CONFIG);

  inputText = '';
  selectedFile: File | null = null;
  selectedFileName = '';
  selectedFileSize = '';
  checkResults: CheckResult[] = [];
  issues: CheckIssue[] = [];
  lastParsedType = '';
  isLoading = false;
  validationError: string | null = null;

  datasetId = '';
  sourceSite = '';
  timeframe = '';
  studyId = '';
  dictionaryRef = '';
  runMode: ValidationMode = 'interactive';
  licenseField = '';
  provenance = '';

  gate: GateStatus | null = null;
  lastRunReport: DccRunReport | null = null;

  resultTab: ResultTab = 'summary';
  issueFilter: IssueFilter = 'all';
  private cachedSortedIssues: CheckIssue[] = [];
  private cachedFilteredIssues: CheckIssue[] = [];

  guideOpen = true;
  /** Compiled schema from the last Excel dictionary run or config upload. */
  dictionaryReady: ValidationConfig | null = null;
  /** True once that schema is the active validation config. */
  dictionaryAdopted = false;

  constructor() {
    this.restoreRunContext();
    const storedGuide = readLocalFlag(GUIDE_STORAGE_KEY);
    if (storedGuide !== null) {
      this.guideOpen = storedGuide;
    } else if (typeof window !== 'undefined' && window.matchMedia('(max-width: 1200px)').matches) {
      // Phone and tablet: keep the guide collapsed so the form and sticky Run control are in reach.
      this.guideOpen = false;
    }
  }

  toggleGuide(): void {
    this.guideOpen = !this.guideOpen;
    writeLocalFlag(GUIDE_STORAGE_KEY, this.guideOpen);
  }

  async downloadWebsiteAsset(relativePath: string): Promise<void> {
    this.validationError = null;
    try {
      const name = relativePath.split('/').pop() || 'download.txt';
      if (isExcelWorkbookName(name)) {
        const bytes = await fetchBinaryAsset(relativePath);
        const blob = new Blob([bytes], {
          type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = name;
        anchor.click();
        URL.revokeObjectURL(url);
        return;
      }
      const text = await fetchTextAsset(relativePath);
      downloadTextFile(text, name);
    } catch (error) {
      this.validationError = this.toErrorMessage(error, 'Could not download asset.');
    }
  }

  async downloadSelectedPresetConfig(): Promise<void> {
    const path = this.selectedPreset?.configPath;
    if (!path) {
      this.validationError =
        'Built-in FHIR config is embedded — use Reset / Export from a run, or download fhir-lab-v1.json below.';
      return;
    }
    await this.downloadWebsiteAsset(path);
  }

  async downloadSelectedPresetSample(): Promise<void> {
    const path = this.selectedPreset?.samplePath;
    if (!path) {
      this.downloadSampleFile();
      return;
    }
    await this.downloadWebsiteAsset(path);
  }

  get effectiveConfig(): EffectiveConfigRef {
    return this.cachedEffectiveConfig;
  }

  get hasInput(): boolean {
    return Boolean(this.selectedFile || this.inputText.trim());
  }

  get pastePlaceholder(): string {
    const tables = this.activeConfig.dictionarySource ? this.activeConfig.expectedFiles ?? [] : [];
    if (tables.length) {
      return `Paste one CSV, or a JSON map of ${tables.join(', ')} to CSV text. Headers must match the dictionary.`;
    }
    return 'Paste FHIR Bundle/array/resource/NDJSON, or a SHIELD multi-CSV package JSON…';
  }

  get dictionaryStatusText(): string {
    const tables = this.dictionaryReady?.expectedFiles?.join(', ') || 'the category tables';
    if (!this.dictionaryAdopted) {
      return `Dictionary compiled (${tables}). Use it as the validation config, then paste or upload the extract.`;
    }
    return `This dictionary is the active config. Next dataset: ${tables}, as CSV or a JSON map of those names to CSV text.`;
  }

  get isProcessing(): boolean {
    return this.isLoading || this.isLoadingPreset;
  }

  get selectedPreset(): DccPreset | undefined {
    return findPreset(this.selectedPresetId);
  }

  get recordResults(): RecordValidationResult[] {
    return this.lastRunReport?.recordResults ?? [];
  }

  get enabledSuiteCount(): number {
    return this.lastRunReport?.checkSuites?.filter((s) => s.enabled).length ?? 0;
  }

  get violationCodeEntries(): Array<[string, number]> {
    return Object.entries(this.lastRunReport?.summary.violationsByCode ?? {});
  }

  get violationFieldEntries(): Array<[string, number]> {
    return Object.entries(this.lastRunReport?.summary.violationsByField ?? {});
  }

  get hasViolationAggregates(): boolean {
    return this.violationCodeEntries.length > 0 || this.violationFieldEntries.length > 0;
  }

  get sortedIssues(): CheckIssue[] {
    return this.cachedSortedIssues;
  }

  get filteredIssues(): CheckIssue[] {
    return this.cachedFilteredIssues;
  }

  get errorCount(): number {
    return this.lastRunReport?.summary.errorCount ?? this.issues.filter((i) => i.severity === 'error').length;
  }

  get warnCount(): number {
    return this.lastRunReport?.summary.warnCount ?? this.issues.filter((i) => i.severity === 'warn').length;
  }

  async applySelectedPreset(options: { loadSample?: boolean; runAfter?: boolean } = {}): Promise<void> {
    const preset = this.selectedPreset;
    if (!preset) return;

    this.isLoadingPreset = true;
    this.configLoadError = null;
    this.validationError = null;

    try {
      if (preset.configPath) {
        const text = await fetchTextAsset(preset.configPath);
        const fileName = preset.configPath.split('/').pop() || 'config.json';
        this.setActiveConfig(loadAndValidateConfigText(text, fileName), preset.configPath);
      } else {
        this.setActiveConfig(DEFAULT_FHIR_LAB_CONFIG, 'Built-in fhir-lab-v1');
      }

      this.applyPresetDefaults(preset);
      this.dictionaryReady = null;
      this.dictionaryAdopted = false;

      if (options.loadSample) {
        await this.loadPresetSample(preset);
      } else {
        this.clearResults();
      }

      if (options.runAfter && this.hasInput) {
        await this.runCheck();
      }
    } catch (error) {
      this.configLoadError = this.toErrorMessage(error, 'Could not load preset from website assets.');
    } finally {
      this.isLoadingPreset = false;
    }
  }

  async runPresetDemo(): Promise<void> {
    await this.applySelectedPreset({ loadSample: true, runAfter: true });
  }

  async loadSelectedPresetSample(): Promise<void> {
    const preset = this.selectedPreset;
    if (!preset) return;
    this.isLoadingPreset = true;
    this.validationError = null;
    try {
      if (preset.kind === 'fhir' || !preset.samplePath) {
        this.loadValidFhirDemo();
      } else {
        await this.loadPresetSample(preset);
      }
    } catch (error) {
      this.validationError = this.toErrorMessage(error, 'Could not load sample dataset.');
    } finally {
      this.isLoadingPreset = false;
    }
  }

  handleFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0] ?? null;

    if (file) {
      if (file.size > MAX_UPLOAD_BYTES) {
        this.validationError = `File size (${formatBytes(file.size)}) exceeds maximum allowed size of ${formatBytes(MAX_UPLOAD_BYTES)}.`;
        input.value = '';
        return;
      }

      const fileName = file.name.toLowerCase();
      const hasValidExtension = DATASET_EXTENSIONS.some((ext) => fileName.endsWith(ext));
      const hasValidType =
        file.type.includes('json') ||
        file.type.includes('text') ||
        file.type.includes('csv') ||
        file.type.includes('spreadsheet') ||
        file.type.includes('excel');

      if (!hasValidExtension && !hasValidType) {
        this.validationError = `File type not supported. Please use ${DATASET_EXTENSIONS.join(', ')} files.`;
        input.value = '';
        return;
      }
    }

    this.selectedFile = file;
    this.selectedFileName = file?.name ?? '';
    this.selectedFileSize = file ? formatBytes(file.size) : '';
    this.validationError = null;
    this.clearResults();
  }

  clearFile(): void {
    const keepDictionary = this.dictionaryReady != null;
    this.selectedFile = null;
    this.selectedFileName = '';
    this.selectedFileSize = '';
    this.validationError = null;
    if (this.fileInput?.nativeElement) {
      this.fileInput.nativeElement.value = '';
    }
    if (!keepDictionary) this.clearResults();
  }

  clearResults(): void {
    if (this.isLoading) return;
    this.checkResults = [];
    this.issues = [];
    this.lastParsedType = '';
    this.gate = null;
    this.lastRunReport = null;
    this.resultTab = 'summary';
    this.issueFilter = 'all';
    this.refreshIssueViews();
  }

  async handleConfigSelected(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    this.configLoadError = null;
    try {
      if (isExcelWorkbookName(file.name)) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const report = runDictionaryWorkbookCheck(bytes, file.name, {
          source: 'File',
          sourceDetail: file.name,
          runContext: { ...this.buildRunContext(file.name), schemaVersion: undefined }
        });
        const snapshot = report.config.snapshot;
        if (snapshot.id !== 'unparsed-dictionary') {
          this.dictionaryReady = snapshot;
          this.dictionaryAdopted = true;
          this.setActiveConfig(snapshot, file.name);
          this.selectedPresetId = '';
          if (snapshot.dictionaryRef) this.dictionaryRef = snapshot.dictionaryRef;
        }
        this.publishReport(report);
        return;
      }
      this.dictionaryReady = null;
      this.dictionaryAdopted = false;
      const parsed = loadAndValidateConfigText(await file.text(), file.name);
      this.setActiveConfig(parsed, file.name);
      this.selectedPresetId = '';
      if (parsed.studyId) this.studyId = parsed.studyId;
      if (parsed.dictionaryRef) this.dictionaryRef = parsed.dictionaryRef;
      this.clearResults();
    } catch (error) {
      this.configLoadError = this.toErrorMessage(error, 'Could not load validation config.');
      input.value = '';
    }
  }

  resetConfig(): void {
    this.setActiveConfig(DEFAULT_FHIR_LAB_CONFIG, 'Built-in fhir-lab-v1');
    this.configLoadError = null;
    this.selectedPresetId = 'fhir-lab-v1';
    this.dictionaryReady = null;
    this.dictionaryAdopted = false;
    if (this.configInput?.nativeElement) {
      this.configInput.nativeElement.value = '';
    }
    this.clearResults();
  }

  setResultTab(tab: ResultTab): void {
    this.resultTab = tab;
  }

  onResultTabKeydown(event: KeyboardEvent): void {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    event.preventDefault();
    const index = RESULT_TABS.indexOf(this.resultTab);
    const delta = event.key === 'ArrowRight' ? 1 : -1;
    this.resultTab = RESULT_TABS[(index + delta + RESULT_TABS.length) % RESULT_TABS.length];
  }

  setIssueFilter(filter: IssueFilter): void {
    this.issueFilter = filter;
    this.refreshIssueViews();
  }

  loadExampleData(): void {
    this.clearFile();
    this.inputText = JSON.stringify(createRandomFhirExample(), null, 2);
    this.clearResults();
  }

  downloadSampleFile(): void {
    downloadTextFile(
      JSON.stringify(createFhirSampleWithIssues(), null, 2),
      'sample-fhir-observations-and-report.json',
      mimeTypeForFileName('sample.json')
    );
  }

  /** Load the built-in workbook that demonstrates dictionary findings, then run the gate. */
  async loadDictionaryDemo(): Promise<void> {
    this.validationError = null;
    this.isLoadingPreset = true;
    try {
      const bytes = await fetchBinaryAsset('configs/samples/search-dictionary-demo.xlsx');
      const file = new File([bytes], 'search-dictionary-demo.xlsx', {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      });
      this.inputText = '';
      this.selectedFile = file;
      this.selectedFileName = file.name;
      this.selectedFileSize = formatBytes(file.size);
      this.clearResults();
      await this.runCheck();
    } catch (error) {
      this.validationError = this.toErrorMessage(error, 'Could not load the sample dictionary.');
    } finally {
      this.isLoadingPreset = false;
    }
  }

  /** Use the compiled dictionary as the active config for a later CSV extract. */
  adoptDictionaryConfig(): void {
    if (!this.dictionaryReady) return;
    this.setActiveConfig(this.dictionaryReady, this.dictionaryReady.dictionarySource?.fileName ?? this.dictionaryReady.name);
    this.selectedPresetId = '';
    this.dictionaryAdopted = true;
    if (this.dictionaryReady.dictionaryRef) this.dictionaryRef = this.dictionaryReady.dictionaryRef;
    this.configLoadError = null;
    this.selectedFile = null;
    this.selectedFileName = '';
    this.selectedFileSize = '';
    if (this.fileInput?.nativeElement) this.fileInput.nativeElement.value = '';
  }

  downloadCompiledDictionary(): void {
    if (!this.dictionaryReady) return;
    downloadTextFile(
      JSON.stringify(this.dictionaryReady, null, 2),
      `${this.dictionaryReady.id}.json`
    );
  }

  async runCheck(): Promise<void> {
    if (!this.hasInput) {
      this.clearResults();
      return;
    }

    this.isLoading = true;
    this.validationError = null;
    this.checkResults = [];
    this.issues = [];
    this.gate = null;
    this.lastRunReport = null;
    this.refreshIssueViews();

    try {
      const source = this.selectedFile ? 'File' : 'Text';
      const workbook = Boolean(this.selectedFile && isExcelWorkbookName(this.selectedFileName));
      const runContext = this.buildRunContext(this.selectedFileName);
      if (workbook) runContext.schemaVersion = undefined;
      let report: DccRunReport;
      if (!workbook) {
        const content = this.selectedFile ? await this.selectedFile.text() : this.inputText;
        if (!content.trim()) throw new Error('Input is empty.');
        report = runDataCurationCheck(content, {
          source,
          sourceDetail: this.selectedFileName || undefined,
          config: this.activeConfig,
          runContext
        });
      } else {
        report = runDictionaryWorkbookCheck(
          new Uint8Array(await this.selectedFile!.arrayBuffer()),
          this.selectedFileName,
          {
            source,
            sourceDetail: this.selectedFileName,
            config: this.activeConfig,
            runContext
          }
        );
        this.dictionaryAdopted = false;
        this.dictionaryReady = report.parseResult.ok ? report.config.snapshot : null;
      }

      this.publishReport(report);
    } catch (error) {
      this.handleValidationError(error);
    } finally {
      this.isLoading = false;
    }
  }

  downloadJsonReport(): void {
    this.exportReport('json');
  }

  downloadMarkdownReport(): void {
    this.exportReport('md');
  }

  downloadHtmlReport(): void {
    this.exportReport('html');
  }

  openPrintableReport(): void {
    if (!this.lastRunReport) return;
    const html = formatReport(this.lastRunReport, 'html');
    const win = window.open('', '_blank');
    if (!win) {
      this.validationError = 'Could not open print window. Allow pop-ups, or use Export HTML report.';
      return;
    }
    win.document.open();
    win.document.write(html);
    win.document.close();
  }

  trackByIssue(index: number, issue: CheckIssue): string {
    return `${issue.severity}-${issue.code ?? issue.label}-${issue.location}-${index}`;
  }

  trackByRecord(index: number, record: RecordValidationResult): string {
    return `${record.recordId}-${index}`;
  }

  trackByPreset(_index: number, preset: DccPreset): string {
    return preset.id;
  }

  private async loadPresetSample(preset: DccPreset): Promise<void> {
    if (!preset.samplePath) {
      this.loadValidFhirDemo();
      return;
    }
    const text = await fetchTextAsset(preset.samplePath);
    this.clearFile();
    this.inputText = text;
    this.clearResults();
    this.applyPresetDefaults(preset);
  }

  private loadValidFhirDemo(): void {
    this.clearFile();
    this.inputText = JSON.stringify(createValidFhirDemo(), null, 2);
    this.clearResults();
  }

  private applyPresetDefaults(preset: DccPreset): void {
    const defaults = preset.defaults;
    if (!defaults) return;
    if (defaults.datasetId) this.datasetId = defaults.datasetId;
    if (defaults.sourceSite) this.sourceSite = defaults.sourceSite;
    if (defaults.studyId) this.studyId = defaults.studyId;
    if (defaults.dictionaryRef) this.dictionaryRef = defaults.dictionaryRef;
    if (defaults.license) this.licenseField = defaults.license;
    if (defaults.provenance) this.provenance = defaults.provenance;
  }

  private buildRunContext(fileName: string): DatasetRunContext {
    return {
      datasetId: this.datasetId.trim() || fileName || 'interactive-dataset',
      sourceSite: this.sourceSite.trim() || 'local',
      timeframe: this.timeframe.trim() || undefined,
      mode: this.runMode,
      inputFiles: fileName ? [fileName] : [],
      license: this.licenseField.trim() || undefined,
      provenance: this.provenance.trim() || undefined,
      studyId: this.studyId.trim() || this.activeConfig.studyId,
      dictionaryRef: this.dictionaryRef.trim() || this.activeConfig.dictionaryRef,
      schemaVersion: this.effectiveConfig.version
    };
  }

  private publishReport(report: DccRunReport): void {
    this.lastRunReport = report;
    this.gate = report.gate;
    this.lastParsedType = report.parseResult.type;
    this.issues = report.issues;
    this.checkResults = report.checkResults;
    this.resultTab = 'summary';
    this.issueFilter = 'all';
    this.refreshIssueViews();
    this.persistRunContext();
    queueMicrotask(() => {
      document.getElementById('gate-results')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  private setActiveConfig(config: ValidationConfig, sourceLabel: string): void {
    this.activeConfig = config;
    this.configSourceLabel = sourceLabel;
    this.cachedEffectiveConfig = resolveEffectiveConfig(config);
  }

  private exportReport(format: 'json' | 'md' | 'html'): void {
    if (!this.lastRunReport) return;
    const ext = format === 'md' ? 'md' : format;
    downloadTextFile(
      formatReport(this.lastRunReport, format),
      `dcc-report-${this.lastRunReport.runContext.datasetId || 'run'}.${ext}`
    );
  }

  private handleValidationError(error: unknown): void {
    const errorMessage = this.toErrorMessage(error, 'An unexpected error occurred during validation.');
    this.validationError = errorMessage;
    this.gate = 'FAIL';
    this.lastRunReport = null;
    this.resultTab = 'issues';
    this.issues = [
      {
        severity: 'error',
        label: 'Validation error',
        detail: errorMessage,
        location: 'System'
      }
    ];
    this.checkResults = [
      {
        label: 'Validation',
        status: 'error',
        statusLabel: 'Error',
        detail: errorMessage
      }
    ];
    this.refreshIssueViews();
  }

  private persistRunContext(): void {
    writeLocalJson(CONTEXT_STORAGE_KEY, {
      datasetId: this.datasetId,
      sourceSite: this.sourceSite,
      timeframe: this.timeframe,
      studyId: this.studyId,
      dictionaryRef: this.dictionaryRef,
      runMode: this.runMode,
      licenseField: this.licenseField,
      provenance: this.provenance
    } as PersistedRunContext);
  }

  private restoreRunContext(): void {
    const data = readLocalJson<PersistedRunContext>(CONTEXT_STORAGE_KEY);
    if (!data) return;
    this.datasetId = data.datasetId ?? '';
    this.sourceSite = data.sourceSite ?? '';
    this.timeframe = data.timeframe ?? '';
    this.studyId = data.studyId ?? '';
    this.dictionaryRef = data.dictionaryRef ?? '';
    this.runMode = data.runMode ?? 'interactive';
    this.licenseField = data.licenseField ?? '';
    this.provenance = data.provenance ?? '';
  }

  private refreshIssueViews(): void {
    this.cachedSortedIssues = [...this.issues].sort((a, b) => {
      return (SEVERITY_ORDER[a.severity] ?? 99) - (SEVERITY_ORDER[b.severity] ?? 99);
    });
    this.cachedFilteredIssues =
      this.issueFilter === 'all'
        ? this.cachedSortedIssues
        : this.cachedSortedIssues.filter((i) => i.severity === this.issueFilter);
  }

  private toErrorMessage(error: unknown, fallback: string): string {
    return error instanceof Error ? error.message : fallback;
  }
}
