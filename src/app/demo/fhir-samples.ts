/**
 * Built-in FHIR demo / sample payloads for the website UI.
 * Kept out of AppComponent so the page controller stays focused on orchestration.
 */

import type { DiagnosticReport, Observation } from '../models/fhir.types';

export type FhirDemoResource = Partial<Observation> | Partial<DiagnosticReport>;

const OBS_CAT = 'http://terminology.hl7.org/CodeSystem/observation-category';
const DR_CAT = 'http://terminology.hl7.org/CodeSystem/v2-0074';
const LOINC = 'http://loinc.org';
const UCUM = 'http://unitsofmeasure.org';
const DAR = 'http://terminology.hl7.org/CodeSystem/data-absent-reason';
const INTERP = 'http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation';

function labCategory(withDisplay = true) {
  return [
    {
      coding: [
        {
          system: OBS_CAT,
          code: 'laboratory' as const,
          ...(withDisplay ? { display: 'Laboratory' } : {})
        }
      ]
    }
  ];
}

function labReportCategory() {
  return [{ coding: [{ system: DR_CAT, code: 'LAB', display: 'Laboratory' }] }];
}

function loinc(code: string, display: string, text?: string) {
  return {
    coding: [{ system: LOINC, code, display }],
    ...(text !== undefined ? { text } : {})
  };
}

function qty(value: number, unit: string, withSystem = true) {
  return withSystem ? { value, unit, system: UCUM, code: unit } : { value, unit };
}

function range(low: number, high: number, unit: string, withSystem = true) {
  return [{ low: qty(low, unit, withSystem), high: qty(high, unit, withSystem) }];
}

function ref(reference: string) {
  return { reference };
}

function nowIso(): string {
  return new Date().toISOString();
}

function yesterdayIso(): string {
  return new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
}

/** Variant 1: all valid → 0 errors, 0 warnings (structural). */
export function createValidFhirDemo(): FhirDemoResource[] {
  const now = nowIso();
  const yesterday = yesterdayIso();
  return [
    {
      resourceType: 'Observation',
      id: 'obs-a',
      status: 'final',
      category: labCategory(),
      code: loinc('2339-0', 'Glucose [Mass/volume] in Blood', 'Glucose'),
      subject: ref('Patient/example'),
      effectiveDateTime: yesterday,
      issued: now,
      valueQuantity: qty(95, 'mg/dL'),
      referenceRange: range(70, 100, 'mg/dL'),
      performer: [ref('Organization/lab-example')],
      specimen: ref('Specimen/blood-example')
    },
    {
      resourceType: 'Observation',
      id: 'obs-b',
      status: 'final',
      category: labCategory(),
      code: loinc('2160-0', 'Creatinine [Mass/volume] in Serum or Plasma', 'Creatinine'),
      subject: ref('Patient/example'),
      effectiveDateTime: now,
      issued: now,
      valueQuantity: qty(1.0, 'mg/dL'),
      referenceRange: range(0.6, 1.2, 'mg/dL'),
      performer: [ref('Organization/lab-example')],
      specimen: ref('Specimen/blood-example')
    },
    {
      resourceType: 'DiagnosticReport',
      id: 'dr-1',
      status: 'final',
      category: labReportCategory(),
      code: loinc('58410-2', 'Short blood count panel'),
      subject: ref('Patient/example'),
      effectiveDateTime: now,
      issued: now,
      performer: [ref('Organization/lab-example')],
      result: [ref('Observation/obs-a'), ref('Observation/obs-b')]
    } as Partial<DiagnosticReport>
  ];
}

/** Variant 2: missing required status (error) + DR without performer (warn). */
export function createFhirDemoMissingStatus(): FhirDemoResource[] {
  const now = nowIso();
  return [
    {
      resourceType: 'Observation',
      id: 'obs-x',
      status: 'final',
      category: labCategory(),
      code: loinc('2339-0', 'Glucose [Mass/volume] in Blood', 'Glucose'),
      subject: ref('Patient/example'),
      effectiveDateTime: now,
      issued: now,
      valueQuantity: qty(102, 'mg/dL'),
      referenceRange: range(70, 100, 'mg/dL'),
      performer: [ref('Organization/lab-example')],
      specimen: ref('Specimen/blood-example')
    },
    {
      resourceType: 'Observation',
      id: 'obs-y',
      code: loinc('2160-0', 'Creatinine [Mass/volume] in Serum or Plasma', 'Creatinine'),
      subject: ref('Patient/example'),
      effectiveDateTime: now,
      valueQuantity: qty(1.1, 'mg/dL'),
      performer: [ref('Organization/lab-example')]
    },
    {
      resourceType: 'DiagnosticReport',
      id: 'dr-2',
      status: 'final',
      category: labReportCategory(),
      code: loinc('58410-2', 'Short blood count panel'),
      subject: ref('Patient/example'),
      effectiveDateTime: now,
      issued: now,
      result: [ref('Observation/obs-x'), ref('Observation/obs-y')]
    } as Partial<DiagnosticReport>
  ];
}

/** Variant 3: dataAbsentReason with value (error) + DR without category (warn). */
export function createFhirDemoAbsentReasonConflict(): FhirDemoResource[] {
  const now = nowIso();
  return [
    {
      resourceType: 'Observation',
      id: 'obs-p',
      status: 'final',
      category: labCategory(),
      code: loinc('2160-0', 'Creatinine [Mass/volume] in Serum or Plasma', 'Creatinine'),
      subject: ref('Patient/example'),
      effectiveDateTime: now,
      issued: now,
      valueQuantity: qty(1.0, 'mg/dL'),
      referenceRange: range(0.6, 1.2, 'mg/dL'),
      performer: [ref('Organization/lab-example')],
      specimen: ref('Specimen/blood-example')
    },
    {
      resourceType: 'Observation',
      id: 'obs-q',
      status: 'final',
      category: labCategory(),
      code: loinc('718-7', 'Hemoglobin [Mass/volume] in Blood', 'Hemoglobin'),
      subject: ref('Patient/example'),
      effectiveDateTime: now,
      issued: now,
      valueQuantity: qty(14.0, 'g/dL'),
      dataAbsentReason: { coding: [{ system: DAR, code: 'error' }] }
    },
    {
      resourceType: 'DiagnosticReport',
      id: 'dr-3',
      status: 'final',
      code: loinc('58410-2', 'Short blood count panel'),
      subject: ref('Patient/example'),
      effectiveDateTime: now,
      issued: now,
      performer: [ref('Organization/lab-example')],
      result: [ref('Observation/obs-p'), ref('Observation/obs-q')]
    } as Partial<DiagnosticReport>
  ];
}

/** Picks one of 3 example variants at random for "Load FHIR example". */
export function createRandomFhirExample(): FhirDemoResource[] {
  const variants = [createValidFhirDemo, createFhirDemoMissingStatus, createFhirDemoAbsentReasonConflict];
  return variants[Math.floor(Math.random() * variants.length)]();
}

/**
 * Downloadable FHIR sample with mixed valid / invalid resources
 * (deliberate issues for demos and provider-notification walkthroughs).
 */
export function createFhirSampleWithIssues(): FhirDemoResource[] {
  const now = nowIso();
  const yesterday = yesterdayIso();

  return [
    {
      resourceType: 'Observation',
      id: 'obs-1',
      status: 'final',
      category: labCategory(),
      code: loinc('2339-0', 'Glucose [Mass/volume] in Blood', 'Glucose'),
      subject: ref('Patient/example'),
      effectiveDateTime: yesterday,
      issued: now,
      valueQuantity: qty(95, 'mg/dL'),
      referenceRange: range(70, 100, 'mg/dL'),
      performer: [ref('Organization/lab-example')],
      specimen: ref('Specimen/blood-example')
    },
    {
      resourceType: 'Observation',
      id: 'obs-2',
      code: loinc('2160-0', 'Creatinine [Mass/volume] in Serum or Plasma'),
      valueQuantity: qty(1.1, 'mg/dL', false)
    },
    {
      resourceType: 'Observation',
      id: 'obs-3',
      status: 'final',
      category: labCategory(false),
      code: loinc('2823-3', 'Potassium [Moles/volume] in Serum or Plasma'),
      subject: ref('Patient/example'),
      effectiveDateTime: now,
      issued: now,
      valueQuantity: qty(2.3, 'mEq/L'),
      interpretation: [{ coding: [{ system: INTERP, code: 'L', display: 'Low' }] }],
      referenceRange: range(3.5, 5.0, 'mEq/L', false),
      performer: [ref('Organization/lab-example')]
    },
    {
      resourceType: 'Observation',
      id: 'obs-4',
      status: 'final',
      category: labCategory(false),
      code: loinc('718-7', 'Hemoglobin [Mass/volume] in Blood'),
      subject: ref('Patient/example'),
      effectiveDateTime: now,
      dataAbsentReason: {
        coding: [{ system: DAR, code: 'not-performed', display: 'Not Performed' }]
      },
      performer: [ref('Organization/lab-example')]
    },
    {
      resourceType: 'Observation',
      id: 'obs-5',
      status: 'final',
      category: labCategory(false),
      code: loinc('2093-3', 'Cholesterol [Mass/volume] in Serum or Plasma'),
      subject: ref('Patient/example'),
      effectiveDateTime: now,
      valueQuantity: qty(180, 'mg/dL'),
      referenceRange: [{}],
      performer: [ref('Organization/lab-example')]
    },
    {
      resourceType: 'Observation',
      id: 'obs-6',
      status: 'final',
      category: labCategory(false),
      code: loinc('24323-8', 'Comprehensive metabolic panel'),
      subject: ref('Patient/example'),
      effectiveDateTime: now,
      organizer: true,
      hasMember: [ref('Observation/obs-1'), ref('Observation/obs-3')],
      performer: [ref('Organization/lab-example')]
    },
    {
      resourceType: 'Observation',
      id: 'obs-7',
      status: 'final',
      category: labCategory(false),
      code: loinc('4548-4', 'Hemoglobin A1c/Hemoglobin.total in Blood'),
      subject: ref('Patient/example'),
      effectiveDateTime: now,
      valueQuantity: qty(8.5, '%'),
      referenceRange: range(4.0, 5.6, '%', false),
      performer: [ref('Organization/lab-example')]
    },
    {
      resourceType: 'Observation',
      id: 'obs-8',
      status: 'final',
      category: labCategory(false),
      code: loinc('3016-3', 'Thyrotropin [Units/volume] in Serum or Plasma'),
      subject: ref('Patient/example'),
      effectiveDateTime: now,
      valueQuantity: qty(2.5, 'mIU/L')
    },
    {
      resourceType: 'Observation',
      id: 'obs-9',
      status: 'unknown' as Observation['status'],
      category: labCategory(false),
      code: loinc(
        '1742-6',
        'Alanine aminotransferase [Enzymatic activity/volume] in Serum or Plasma'
      ),
      subject: ref('Patient/example'),
      valueQuantity: qty(45, 'U/L', false)
    },
    {
      resourceType: 'Observation',
      id: 'obs-10',
      status: 'final',
      category: labCategory(false),
      code: loinc('777-3', 'Platelets [#/volume] in Blood by Automated count'),
      subject: ref('Patient/example'),
      effectiveDateTime: now,
      valueQuantity: qty(250, '10*3/uL', false),
      dataAbsentReason: { coding: [{ system: DAR, code: 'error' }] }
    },
    {
      resourceType: 'DiagnosticReport',
      id: 'dr-1',
      status: 'final',
      category: labReportCategory(),
      code: loinc('58410-2', 'Short blood count panel'),
      subject: ref('Patient/example'),
      effectiveDateTime: now,
      issued: now,
      performer: [ref('Organization/lab-example')],
      result: [ref('Observation/obs-1'), ref('Observation/obs-3')]
    } as Partial<DiagnosticReport>
  ];
}
