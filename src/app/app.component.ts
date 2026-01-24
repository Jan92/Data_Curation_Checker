import { CommonModule } from '@angular/common';
import { Component, ElementRef, ViewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Observation } from './models/fhir.types';
import { validateFhirObservations, type CheckResult, type CheckIssue } from './checks/fhir-observation-checks';

@Component({
  standalone: true,
  selector: 'app-root',
  imports: [CommonModule, FormsModule],
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.css']
})
/**
 * Main application component for FHIR Observation validation
 */
export class AppComponent {
  @ViewChild('fileInput') fileInput?: ElementRef<HTMLInputElement>;

  // Component state
  readonly title = 'Data Curation Checker';
  inputText = '';
  selectedFile: File | null = null;
  selectedFileName = '';
  selectedFileSize = '';
  checkResults: CheckResult[] = [];
  issues: CheckIssue[] = [];
  lastParsedType = '';
  isLoading = false;
  validationError: string | null = null;

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
    }
  }

  /**
   * Loads example FHIR Observation data for demonstration
   */
  loadExampleData(): void {
    this.clearFile();
    const exampleData = this.generateExampleData();
    this.inputText = JSON.stringify(exampleData, null, 2);
    this.clearResults();
  }

  /**
   * Generates example FHIR Observation data with various validation scenarios
   */
  private generateExampleData(): Partial<Observation>[] {
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
      }
    ];
  }

  /**
   * Runs the validation check on the input data
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

    try {
      const source = this.selectedFile ? 'File' : 'Text';
      const content = this.selectedFile
        ? await this.selectedFile.text()
        : this.inputText;

      if (!content || !content.trim()) {
        throw new Error('Input is empty.');
      }

      const result = validateFhirObservations(content, {
        source,
        sourceDetail: this.selectedFileName || undefined
      });

      this.lastParsedType = result.parseResult.type;
      this.issues = result.issues;
      this.checkResults = result.checkResults;
    } catch (error) {
      this.handleValidationError(error);
    } finally {
      this.isLoading = false;
    }
  }

  /**
   * Handles validation errors
   */
  private handleValidationError(error: unknown): void {
    const errorMessage =
      error instanceof Error ? error.message : 'An unexpected error occurred during validation.';
    this.validationError = errorMessage;
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


  /**
   * TrackBy function for issue list rendering
   */
  trackByIssue(index: number, issue: CheckIssue): string {
    return `${issue.severity}-${issue.label}-${issue.location}-${index}`;
  }

  /**
   * Get error count
   */
  getErrorCount(): number {
    return this.issues.filter(i => i.severity === 'error').length;
  }

  /**
   * Get warning count
   */
  getWarnCount(): number {
    return this.issues.filter(i => i.severity === 'warn').length;
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
