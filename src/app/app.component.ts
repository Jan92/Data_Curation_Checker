import { CommonModule } from '@angular/common';
import { Component, ElementRef, ViewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Observation, DiagnosticReport } from './models/fhir.types';
import {
  runDataCurationCheck,
  formatReportAsMarkdown,
  formatReportAsHtml,
  DEFAULT_FHIR_LAB_CONFIG,
  resolveEffectiveConfig,
  validateValidationConfig,
  TOOL_VERSION,
  type CheckResult,
  type CheckIssue,
  type CheckStatus,
  type DccRunReport,
  type GateStatus,
  type ValidationMode,
  type ValidationConfig,
  type RecordValidationResult,
  type EffectiveConfigRef
} from './checks/fhir-observation-checks';

type ResultTab = 'summary' | 'checks' | 'issues' | 'records';
type IssueFilter = 'all' | 'error' | 'warn';

const CONTEXT_STORAGE_KEY = 'dcc-run-context-v1';

@Component({
  standalone: true,
  selector: 'app-root',
  imports: [CommonModule, FormsModule],
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.css']
})
/**
 * SEARCH Data Curation Checker (DCC) — medicalvalues
 * On-premise quality gate for curated/annotated datasets (D1.6 §4.2.3).
 */
export class AppComponent {
  @ViewChild('fileInput') fileInput?: ElementRef<HTMLInputElement>;
  @ViewChild('configInput') configInput?: ElementRef<HTMLInputElement>;

  readonly title = 'Data Curation Checker';
  readonly toolVersion = TOOL_VERSION;

  /** Active validation config (default or user-uploaded). */
  activeConfig: ValidationConfig = DEFAULT_FHIR_LAB_CONFIG;
  configSourceLabel = 'Built-in fhir-lab-v1';
  configLoadError: string | null = null;

  inputText = '';
  selectedFile: File | null = null;
  selectedFileName = '';
  selectedFileSize = '';
  checkResults: CheckResult[] = [];
  issues: CheckIssue[] = [];
  lastParsedType = '';
  isLoading = false;
  validationError: string | null = null;

  /** Dataset / run context (D1.6) */
  datasetId = '';
  sourceSite = '';
  timeframe = '';
  runMode: ValidationMode = 'interactive';
  licenseField = '';
  provenance = '';

  gate: GateStatus | null = null;
  lastRunReport: DccRunReport | null = null;

  resultTab: ResultTab = 'summary';
  issueFilter: IssueFilter = 'all';

  constructor() {
    this.restoreRunContext();
  }

  get effectiveConfig(): EffectiveConfigRef {
    return resolveEffectiveConfig(this.activeConfig);
  }

  /**
   * Checks if there is any input available (file or text)
   */
  get hasInput(): boolean {
    return Boolean(this.selectedFile || this.inputText.trim());
  }

  /**
   * Checks if validation is currently running
   */
  get isProcessing(): boolean {
    return this.isLoading;
  }

  /**
   * Handles file selection from the file input
   */
  handleFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0] ?? null;
    
    if (file) {
      // Validate file size (max 10MB)
      const maxSize = 10 * 1024 * 1024; // 10MB
      if (file.size > maxSize) {
        this.validationError = `File size (${this.formatBytes(file.size)}) exceeds maximum allowed size of ${this.formatBytes(maxSize)}.`;
        input.value = '';
        return;
      }

      // Validate file type
      const validExtensions = ['.json', '.ndjson', '.txt'];
      const fileName = file.name.toLowerCase();
      const hasValidExtension = validExtensions.some(ext => fileName.endsWith(ext));
      
      if (!hasValidExtension && !file.type.includes('json') && !file.type.includes('text')) {
        this.validationError = `File type not supported. Please use ${validExtensions.join(', ')} files.`;
        input.value = '';
        return;
      }
    }

    this.selectedFile = file;
    this.selectedFileName = file?.name ?? '';
    this.selectedFileSize = file ? this.formatBytes(file.size) : '';
    this.validationError = null;
    this.clearResults();
  }

  /**
   * Clears the selected file and resets file-related state
   */
  clearFile(): void {
    this.selectedFile = null;
    this.selectedFileName = '';
    this.selectedFileSize = '';
    this.validationError = null;
    if (this.fileInput?.nativeElement) {
      this.fileInput.nativeElement.value = '';
    }
    this.clearResults();
  }

  /**
   * Clears validation results and issues
   */
  clearResults(): void {
    if (!this.isLoading) {
      this.checkResults = [];
      this.issues = [];
      this.lastParsedType = '';
      this.gate = null;
      this.lastRunReport = null;
      this.resultTab = 'summary';
      this.issueFilter = 'all';
    }
  }

  /**
   * Load a custom YAML/JSON validation config (D1.6 config-driven gate).
   */
  async handleConfigSelected(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    this.configLoadError = null;
    try {
      const text = await file.text();
      const parsed = this.parseConfigText(text, file.name);
      const report = validateValidationConfig(parsed);
      if (!report.ok) {
        throw new Error(report.issues.map((i) => `${i.path}: ${i.message}`).join('; '));
      }
      // Ensure hash resolves
      resolveEffectiveConfig(parsed);
      this.activeConfig = parsed;
      this.configSourceLabel = file.name;
      this.clearResults();
    } catch (error) {
      this.configLoadError =
        error instanceof Error ? error.message : 'Could not load validation config.';
      input.value = '';
    }
  }

  resetConfig(): void {
    this.activeConfig = DEFAULT_FHIR_LAB_CONFIG;
    this.configSourceLabel = 'Built-in fhir-lab-v1';
    this.configLoadError = null;
    if (this.configInput?.nativeElement) {
      this.configInput.nativeElement.value = '';
    }
    this.clearResults();
  }

  private parseConfigText(text: string, fileName: string): ValidationConfig {
    const lower = fileName.toLowerCase();
    if (lower.endsWith('.yaml') || lower.endsWith('.yml')) {
      throw new Error(
        'YAML configs are supported via CLI (npm run check:cli -- --config …). In the UI, upload the JSON config (e.g. configs/fhir-lab-v1.json).'
      );
    }
    return JSON.parse(text) as ValidationConfig;
  }

  setResultTab(tab: ResultTab): void {
    this.resultTab = tab;
  }

  setIssueFilter(filter: IssueFilter): void {
    this.issueFilter = filter;
  }

  /**
   * Loads a small, mostly-valid example into the textarea (fewer issues than the downloadable sample file)
   */
  loadExampleData(): void {
    this.clearFile();
    const exampleData = this.generateLoadExampleData();
    this.inputText = JSON.stringify(exampleData, null, 2);
    this.clearResults();
  }

  /**
   * Downloads a generated sample JSON file (Observations and DiagnosticReport) for upload and analysis
   */
  downloadSampleFile(): void {
    const data = this.generateExampleData();
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'sample-fhir-observations-and-report.json';
    a.click();
    URL.revokeObjectURL(url);
  }

  /**
   * Picks one of 3 example variants at random for "Load example data"
   */
  private generateLoadExampleData(): (Partial<Observation> | Partial<DiagnosticReport>)[] {
    const variants = [
      () => this.generateLoadExampleVariant1(),
      () => this.generateLoadExampleVariant2(),
      () => this.generateLoadExampleVariant3()
    ];
    return variants[Math.floor(Math.random() * 3)]();
  }

  /** Variant 1: All valid → 0 errors, 0 warnings */
  private generateLoadExampleVariant1(): (Partial<Observation> | Partial<DiagnosticReport>)[] {
    const now = new Date().toISOString();
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    return [
      {
        resourceType: 'Observation',
        id: 'obs-a',
        status: 'final',
        category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'laboratory', display: 'Laboratory' }] }],
        code: { coding: [{ system: 'http://loinc.org', code: '2339-0', display: 'Glucose [Mass/volume] in Blood' }], text: 'Glucose' },
        subject: { reference: 'Patient/example' },
        effectiveDateTime: yesterday,
        issued: now,
        valueQuantity: { value: 95, unit: 'mg/dL', system: 'http://unitsofmeasure.org', code: 'mg/dL' },
        referenceRange: [{ low: { value: 70, unit: 'mg/dL', system: 'http://unitsofmeasure.org', code: 'mg/dL' }, high: { value: 100, unit: 'mg/dL', system: 'http://unitsofmeasure.org', code: 'mg/dL' } }],
        performer: [{ reference: 'Organization/lab-example' }],
        specimen: { reference: 'Specimen/blood-example' }
      },
      {
        resourceType: 'Observation',
        id: 'obs-b',
        status: 'final',
        category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'laboratory', display: 'Laboratory' }] }],
        code: { coding: [{ system: 'http://loinc.org', code: '2160-0', display: 'Creatinine [Mass/volume] in Serum or Plasma' }], text: 'Creatinine' },
        subject: { reference: 'Patient/example' },
        effectiveDateTime: now,
        issued: now,
        valueQuantity: { value: 1.0, unit: 'mg/dL', system: 'http://unitsofmeasure.org', code: 'mg/dL' },
        referenceRange: [{ low: { value: 0.6, unit: 'mg/dL', system: 'http://unitsofmeasure.org', code: 'mg/dL' }, high: { value: 1.2, unit: 'mg/dL', system: 'http://unitsofmeasure.org', code: 'mg/dL' } }],
        performer: [{ reference: 'Organization/lab-example' }],
        specimen: { reference: 'Specimen/blood-example' }
      },
      {
        resourceType: 'DiagnosticReport',
        id: 'dr-1',
        status: 'final',
        category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0074', code: 'LAB', display: 'Laboratory' }] }],
        code: { coding: [{ system: 'http://loinc.org', code: '58410-2', display: 'Short blood count panel' }] },
        subject: { reference: 'Patient/example' },
        effectiveDateTime: now,
        issued: now,
        performer: [{ reference: 'Organization/lab-example' }],
        result: [{ reference: 'Observation/obs-a' }, { reference: 'Observation/obs-b' }]
      } as Partial<DiagnosticReport>
    ];
  }

  /** Variant 2: Missing required status (error) + DR without performer (warn) */
  private generateLoadExampleVariant2(): (Partial<Observation> | Partial<DiagnosticReport>)[] {
    const now = new Date().toISOString();
    return [
      {
        resourceType: 'Observation',
        id: 'obs-x',
        status: 'final',
        category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'laboratory', display: 'Laboratory' }] }],
        code: { coding: [{ system: 'http://loinc.org', code: '2339-0', display: 'Glucose [Mass/volume] in Blood' }], text: 'Glucose' },
        subject: { reference: 'Patient/example' },
        effectiveDateTime: now,
        issued: now,
        valueQuantity: { value: 102, unit: 'mg/dL', system: 'http://unitsofmeasure.org', code: 'mg/dL' },
        referenceRange: [{ low: { value: 70, unit: 'mg/dL', system: 'http://unitsofmeasure.org', code: 'mg/dL' }, high: { value: 100, unit: 'mg/dL', system: 'http://unitsofmeasure.org', code: 'mg/dL' } }],
        performer: [{ reference: 'Organization/lab-example' }],
        specimen: { reference: 'Specimen/blood-example' }
      },
      {
        resourceType: 'Observation',
        id: 'obs-y',
        // missing status → error
        code: { coding: [{ system: 'http://loinc.org', code: '2160-0', display: 'Creatinine [Mass/volume] in Serum or Plasma' }], text: 'Creatinine' },
        subject: { reference: 'Patient/example' },
        effectiveDateTime: now,
        valueQuantity: { value: 1.1, unit: 'mg/dL', system: 'http://unitsofmeasure.org', code: 'mg/dL' },
        performer: [{ reference: 'Organization/lab-example' }]
      },
      {
        resourceType: 'DiagnosticReport',
        id: 'dr-2',
        status: 'final',
        category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0074', code: 'LAB', display: 'Laboratory' }] }],
        code: { coding: [{ system: 'http://loinc.org', code: '58410-2', display: 'Short blood count panel' }] },
        subject: { reference: 'Patient/example' },
        effectiveDateTime: now,
        issued: now,
        // missing performer → warning
        result: [{ reference: 'Observation/obs-x' }, { reference: 'Observation/obs-y' }]
      } as Partial<DiagnosticReport>
    ];
  }

  /** Variant 3: dataAbsentReason with value (error) + DR without category (warn) */
  private generateLoadExampleVariant3(): (Partial<Observation> | Partial<DiagnosticReport>)[] {
    const now = new Date().toISOString();
    return [
      {
        resourceType: 'Observation',
        id: 'obs-p',
        status: 'final',
        category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'laboratory', display: 'Laboratory' }] }],
        code: { coding: [{ system: 'http://loinc.org', code: '2160-0', display: 'Creatinine [Mass/volume] in Serum or Plasma' }], text: 'Creatinine' },
        subject: { reference: 'Patient/example' },
        effectiveDateTime: now,
        issued: now,
        valueQuantity: { value: 1.0, unit: 'mg/dL', system: 'http://unitsofmeasure.org', code: 'mg/dL' },
        referenceRange: [{ low: { value: 0.6, unit: 'mg/dL', system: 'http://unitsofmeasure.org', code: 'mg/dL' }, high: { value: 1.2, unit: 'mg/dL', system: 'http://unitsofmeasure.org', code: 'mg/dL' } }],
        performer: [{ reference: 'Organization/lab-example' }],
        specimen: { reference: 'Specimen/blood-example' }
      },
      {
        resourceType: 'Observation',
        id: 'obs-q',
        status: 'final',
        category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'laboratory', display: 'Laboratory' }] }],
        code: { coding: [{ system: 'http://loinc.org', code: '718-7', display: 'Hemoglobin [Mass/volume] in Blood' }], text: 'Hemoglobin' },
        subject: { reference: 'Patient/example' },
        effectiveDateTime: now,
        issued: now,
        valueQuantity: { value: 14.0, unit: 'g/dL', system: 'http://unitsofmeasure.org', code: 'g/dL' },
        dataAbsentReason: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/data-absent-reason', code: 'error' }] }
        // dataAbsentReason + value → error
      },
      {
        resourceType: 'DiagnosticReport',
        id: 'dr-3',
        status: 'final',
        // missing category → warning
        code: { coding: [{ system: 'http://loinc.org', code: '58410-2', display: 'Short blood count panel' }] },
        subject: { reference: 'Patient/example' },
        effectiveDateTime: now,
        issued: now,
        performer: [{ reference: 'Organization/lab-example' }],
        result: [{ reference: 'Observation/obs-p' }, { reference: 'Observation/obs-q' }]
      } as Partial<DiagnosticReport>
    ];
  }

  /**
   * Generates example FHIR data (Observations and a DiagnosticReport) with various validation scenarios for the downloadable sample file
   */
  private generateExampleData(): (Partial<Observation> | Partial<DiagnosticReport>)[] {
    const now = new Date().toISOString();
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    return [
      // Example 1: Valid laboratory observation (Glucose)
      {
        resourceType: 'Observation',
        id: 'obs-1',
        status: 'final',
        category: [
          {
            coding: [
              {
                system: 'http://terminology.hl7.org/CodeSystem/observation-category',
                code: 'laboratory',
                display: 'Laboratory'
              }
            ]
          }
        ],
        code: {
          coding: [
            {
              system: 'http://loinc.org',
              code: '2339-0',
              display: 'Glucose [Mass/volume] in Blood'
            }
          ],
          text: 'Glucose'
        },
        subject: {
          reference: 'Patient/example'
        },
        effectiveDateTime: yesterday,
        issued: now,
        valueQuantity: {
          value: 95,
          unit: 'mg/dL',
          system: 'http://unitsofmeasure.org',
          code: 'mg/dL'
        },
        referenceRange: [
          {
            low: {
              value: 70,
              unit: 'mg/dL',
              system: 'http://unitsofmeasure.org',
              code: 'mg/dL'
            },
            high: {
              value: 100,
              unit: 'mg/dL',
              system: 'http://unitsofmeasure.org',
              code: 'mg/dL'
            }
          }
        ],
        performer: [
          {
            reference: 'Organization/lab-example'
          }
        ],
        specimen: {
          reference: 'Specimen/blood-example'
        }
      },
      // Example 2: Observation with missing required fields (will show errors)
      {
        resourceType: 'Observation',
        id: 'obs-2',
        // Missing status - will trigger error
        code: {
          coding: [
            {
              system: 'http://loinc.org',
              code: '2160-0',
              display: 'Creatinine [Mass/volume] in Serum or Plasma'
            }
          ]
        },
        valueQuantity: {
          value: 1.1,
          unit: 'mg/dL'
        }
      },
      // Example 3: Critical value (Potassium)
      {
        resourceType: 'Observation',
        id: 'obs-3',
        status: 'final',
        category: [
          {
            coding: [
              {
                system: 'http://terminology.hl7.org/CodeSystem/observation-category',
                code: 'laboratory'
              }
            ]
          }
        ],
        code: {
          coding: [
            {
              system: 'http://loinc.org',
              code: '2823-3',
              display: 'Potassium [Moles/volume] in Serum or Plasma'
            }
          ]
        },
        subject: {
          reference: 'Patient/example'
        },
        effectiveDateTime: now,
        issued: now,
        valueQuantity: {
          value: 2.3, // Critical low value
          unit: 'mEq/L',
          system: 'http://unitsofmeasure.org',
          code: 'mEq/L'
        },
        interpretation: [
          {
            coding: [
              {
                system: 'http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation',
                code: 'L',
                display: 'Low'
              }
            ]
          }
        ],
        referenceRange: [
          {
            low: {
              value: 3.5,
              unit: 'mEq/L'
            },
            high: {
              value: 5.0,
              unit: 'mEq/L'
            }
          }
        ],
        performer: [
          {
            reference: 'Organization/lab-example'
          }
        ]
      },
      // Example 4: Observation with dataAbsentReason (valid)
      {
        resourceType: 'Observation',
        id: 'obs-4',
        status: 'final',
        category: [
          {
            coding: [
              {
                system: 'http://terminology.hl7.org/CodeSystem/observation-category',
                code: 'laboratory'
              }
            ]
          }
        ],
        code: {
          coding: [
            {
              system: 'http://loinc.org',
              code: '718-7',
              display: 'Hemoglobin [Mass/volume] in Blood'
            }
          ]
        },
        subject: {
          reference: 'Patient/example'
        },
        effectiveDateTime: now,
        dataAbsentReason: {
          coding: [
            {
              system: 'http://terminology.hl7.org/CodeSystem/data-absent-reason',
              code: 'not-performed',
              display: 'Not Performed'
            }
          ]
        },
        performer: [
          {
            reference: 'Organization/lab-example'
          }
        ]
      },
      // Example 5: Observation with invalid referenceRange (will show error)
      {
        resourceType: 'Observation',
        id: 'obs-5',
        status: 'final',
        category: [
          {
            coding: [
              {
                system: 'http://terminology.hl7.org/CodeSystem/observation-category',
                code: 'laboratory'
              }
            ]
          }
        ],
        code: {
          coding: [
            {
              system: 'http://loinc.org',
              code: '2093-3',
              display: 'Cholesterol [Mass/volume] in Serum or Plasma'
            }
          ]
        },
        subject: {
          reference: 'Patient/example'
        },
        effectiveDateTime: now,
        valueQuantity: {
          value: 180,
          unit: 'mg/dL',
          system: 'http://unitsofmeasure.org',
          code: 'mg/dL'
        },
        referenceRange: [
          {
            // Missing low, high, and text - will trigger error
          }
        ],
        performer: [
          {
            reference: 'Organization/lab-example'
          }
        ]
      },
      // Example 6: Panel observation with hasMember
      {
        resourceType: 'Observation',
        id: 'obs-6',
        status: 'final',
        category: [
          {
            coding: [
              {
                system: 'http://terminology.hl7.org/CodeSystem/observation-category',
                code: 'laboratory'
              }
            ]
          }
        ],
        code: {
          coding: [
            {
              system: 'http://loinc.org',
              code: '24323-8',
              display: 'Comprehensive metabolic panel'
            }
          ]
        },
        subject: {
          reference: 'Patient/example'
        },
        effectiveDateTime: now,
        organizer: true,
        hasMember: [
          {
            reference: 'Observation/obs-1'
          },
          {
            reference: 'Observation/obs-3'
          }
        ],
        performer: [
          {
            reference: 'Organization/lab-example'
          }
        ]
      },
      // Example 7: Observation with unusual value (warning)
      {
        resourceType: 'Observation',
        id: 'obs-7',
        status: 'final',
        category: [
          {
            coding: [
              {
                system: 'http://terminology.hl7.org/CodeSystem/observation-category',
                code: 'laboratory'
              }
            ]
          }
        ],
        code: {
          coding: [
            {
              system: 'http://loinc.org',
              code: '4548-4',
              display: 'Hemoglobin A1c/Hemoglobin.total in Blood'
            }
          ]
        },
        subject: {
          reference: 'Patient/example'
        },
        effectiveDateTime: now,
        valueQuantity: {
          value: 8.5, // High HbA1c - outside typical range
          unit: '%',
          system: 'http://unitsofmeasure.org',
          code: '%'
        },
        referenceRange: [
          {
            low: {
              value: 4.0,
              unit: '%'
            },
            high: {
              value: 5.6,
              unit: '%'
            }
          }
        ],
        performer: [
          {
            reference: 'Organization/lab-example'
          }
        ]
      },
      // Example 8: Observation with missing performer (warning)
      {
        resourceType: 'Observation',
        id: 'obs-8',
        status: 'final',
        category: [
          {
            coding: [
              {
                system: 'http://terminology.hl7.org/CodeSystem/observation-category',
                code: 'laboratory'
              }
            ]
          }
        ],
        code: {
          coding: [
            {
              system: 'http://loinc.org',
              code: '3016-3',
              display: 'Thyrotropin [Units/volume] in Serum or Plasma'
            }
          ]
        },
        subject: {
          reference: 'Patient/example'
        },
        effectiveDateTime: now,
        valueQuantity: {
          value: 2.5,
          unit: 'mIU/L',
          system: 'http://unitsofmeasure.org',
          code: 'mIU/L'
        }
        // Missing performer - will trigger warning
      },
      // Example 9: Observation with invalid status
      {
        resourceType: 'Observation',
        id: 'obs-9',
        status: 'unknown' as any, // Invalid status - will trigger error
        category: [
          {
            coding: [
              {
                system: 'http://terminology.hl7.org/CodeSystem/observation-category',
                code: 'laboratory'
              }
            ]
          }
        ],
        code: {
          coding: [
            {
              system: 'http://loinc.org',
              code: '1742-6',
              display: 'Alanine aminotransferase [Enzymatic activity/volume] in Serum or Plasma'
            }
          ]
        },
        subject: {
          reference: 'Patient/example'
        },
        valueQuantity: {
          value: 45,
          unit: 'U/L'
        }
      },
      // Example 10: Observation with dataAbsentReason AND value (error)
      {
        resourceType: 'Observation',
        id: 'obs-10',
        status: 'final',
        category: [
          {
            coding: [
              {
                system: 'http://terminology.hl7.org/CodeSystem/observation-category',
                code: 'laboratory'
              }
            ]
          }
        ],
        code: {
          coding: [
            {
              system: 'http://loinc.org',
              code: '777-3',
              display: 'Platelets [#/volume] in Blood by Automated count'
            }
          ]
        },
        subject: {
          reference: 'Patient/example'
        },
        effectiveDateTime: now,
        valueQuantity: {
          value: 250,
          unit: '10*3/uL'
        },
        dataAbsentReason: {
          coding: [
            {
              system: 'http://terminology.hl7.org/CodeSystem/data-absent-reason',
              code: 'error'
            }
          ]
        }
        // dataAbsentReason with value - will trigger error
      },
      // Example 11: DiagnosticReport (lab report with result references)
      {
        resourceType: 'DiagnosticReport',
        id: 'dr-1',
        status: 'final',
        category: [
          {
            coding: [
              {
                system: 'http://terminology.hl7.org/CodeSystem/v2-0074',
                code: 'LAB',
                display: 'Laboratory'
              }
            ]
          }
        ],
        code: {
          coding: [
            {
              system: 'http://loinc.org',
              code: '58410-2',
              display: 'Short blood count panel'
            }
          ]
        },
        subject: { reference: 'Patient/example' },
        effectiveDateTime: now,
        issued: now,
        performer: [{ reference: 'Organization/lab-example' }],
        result: [
          { reference: 'Observation/obs-1' },
          { reference: 'Observation/obs-3' }
        ]
      } as Partial<DiagnosticReport>
    ];
  }

  /**
   * Runs the DCC quality-gate check on the input data
   */
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

    try {
      const source = this.selectedFile ? 'File' : 'Text';
      const content = this.selectedFile
        ? await this.selectedFile.text()
        : this.inputText;

      if (!content || !content.trim()) {
        throw new Error('Input is empty.');
      }

      const report = runDataCurationCheck(content, {
        source,
        sourceDetail: this.selectedFileName || undefined,
        config: this.activeConfig,
        runContext: {
          datasetId: this.datasetId.trim() || (this.selectedFileName || 'interactive-dataset'),
          sourceSite: this.sourceSite.trim() || 'local',
          timeframe: this.timeframe.trim() || undefined,
          mode: this.runMode,
          inputFiles: this.selectedFileName ? [this.selectedFileName] : [],
          license: this.licenseField.trim() || undefined,
          provenance: this.provenance.trim() || undefined,
          schemaVersion: this.effectiveConfig.version
        }
      });

      this.lastRunReport = report;
      this.gate = report.gate;
      this.lastParsedType = report.parseResult.type;
      this.issues = report.issues;
      this.checkResults = report.checkResults;
      this.resultTab = 'summary';
      this.issueFilter = 'all';
      this.persistRunContext();
    } catch (error) {
      this.handleValidationError(error);
    } finally {
      this.isLoading = false;
    }
  }

  /**
   * Download machine-readable JSON run report
   */
  downloadJsonReport(): void {
    if (!this.lastRunReport) return;
    this.downloadBlob(
      JSON.stringify(this.lastRunReport, null, 2),
      `dcc-report-${this.lastRunReport.runContext.datasetId || 'run'}.json`,
      'application/json'
    );
  }

  /**
   * Download human-readable Markdown run report
   */
  downloadMarkdownReport(): void {
    if (!this.lastRunReport) return;
    this.downloadBlob(
      formatReportAsMarkdown(this.lastRunReport),
      `dcc-report-${this.lastRunReport.runContext.datasetId || 'run'}.md`,
      'text/markdown'
    );
  }

  /**
   * Download printable HTML run report (D1.6 HTML; print to PDF from browser).
   */
  downloadHtmlReport(): void {
    if (!this.lastRunReport) return;
    this.downloadBlob(
      formatReportAsHtml(this.lastRunReport),
      `dcc-report-${this.lastRunReport.runContext.datasetId || 'run'}.html`,
      'text/html'
    );
  }

  /**
   * Open HTML report in a new window for print / Save as PDF.
   */
  openPrintableReport(): void {
    if (!this.lastRunReport) return;
    const html = formatReportAsHtml(this.lastRunReport);
    const win = window.open('', '_blank');
    if (!win) {
      this.validationError = 'Could not open print window. Allow pop-ups, or use Export HTML report.';
      return;
    }
    win.document.open();
    win.document.write(html);
    win.document.close();
  }

  /**
   * Handles validation errors
   */
  private handleValidationError(error: unknown): void {
    const errorMessage =
      error instanceof Error ? error.message : 'An unexpected error occurred during validation.';
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
  }

  private downloadBlob(content: string, filename: string, type: string): void {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  private persistRunContext(): void {
    try {
      localStorage.setItem(
        CONTEXT_STORAGE_KEY,
        JSON.stringify({
          datasetId: this.datasetId,
          sourceSite: this.sourceSite,
          timeframe: this.timeframe,
          runMode: this.runMode,
          licenseField: this.licenseField,
          provenance: this.provenance
        })
      );
    } catch {
      /* ignore quota / private mode */
    }
  }

  private restoreRunContext(): void {
    try {
      const raw = localStorage.getItem(CONTEXT_STORAGE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw) as Partial<{
        datasetId: string;
        sourceSite: string;
        timeframe: string;
        runMode: ValidationMode;
        licenseField: string;
        provenance: string;
      }>;
      this.datasetId = data.datasetId ?? '';
      this.sourceSite = data.sourceSite ?? '';
      this.timeframe = data.timeframe ?? '';
      this.runMode = data.runMode ?? 'interactive';
      this.licenseField = data.licenseField ?? '';
      this.provenance = data.provenance ?? '';
    } catch {
      /* ignore corrupt storage */
    }
  }

  /**
   * TrackBy function for issue list rendering
   */
  trackByIssue(index: number, issue: CheckIssue): string {
    return `${issue.severity}-${issue.label}-${issue.location}-${index}`;
  }

  trackByRecord(index: number, record: RecordValidationResult): string {
    return `${record.recordId}-${index}`;
  }

  /**
   * Get error count
   */
  getErrorCount(): number {
    return this.issues.filter((i) => i.severity === 'error').length;
  }

  /**
   * Get warning count
   */
  getWarnCount(): number {
    return this.issues.filter((i) => i.severity === 'warn').length;
  }

  /**
   * Get issues sorted by severity (errors first, then warnings, then ok)
   */
  get sortedIssues(): CheckIssue[] {
    const severityOrder: Record<CheckStatus, number> = { error: 0, warn: 1, ok: 2 };
    return [...this.issues].sort((a, b) => {
      const orderA = severityOrder[a.severity] ?? 99;
      const orderB = severityOrder[b.severity] ?? 99;
      return orderA - orderB;
    });
  }

  get filteredIssues(): CheckIssue[] {
    if (this.issueFilter === 'all') return this.sortedIssues;
    return this.sortedIssues.filter((i) => i.severity === this.issueFilter);
  }

  get recordResults(): RecordValidationResult[] {
    return this.lastRunReport?.recordResults ?? [];
  }

  /**
   * Formats bytes to human-readable string
   */
  formatBytes(bytes: number): string {
    if (!bytes) {
      return '0 B';
    }
    const units = ['B', 'KB', 'MB', 'GB'];
    const index = Math.floor(Math.log(bytes) / Math.log(1024));
    const value = bytes / Math.pow(1024, index);
    return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[index]}`;
  }
}
