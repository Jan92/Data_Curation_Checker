/**
 * FHIR Observation validation checks.
 * Pure TypeScript – no Angular. Use from UI, Node, or CLI.
 */

import {
  resolveEffectiveConfig,
  defaultRunContext,
  applyMetadataRequirements
} from './config';
import { buildDccRunReport, TOOL_VERSION, type DccRunReport } from './report/build-report';
import { runCheckPipeline } from './pipeline/run-pipeline';
import {
  isTabularDatasetInput,
  parseTabularDataset,
  runTabularDictionaryChecks
} from './pipeline/tabular-dictionary';
import { runReproducibilityChecks } from './pipeline/reproducibility';
import { summarizeSuite, suiteToCheckResult } from './pipeline/helpers';
import type {
  CheckResult,
  CheckIssue,
  CheckStatus,
  CheckCategory,
  CheckSuiteResult,
  ParseResult,
  ValidationReport,
  ValidateOptions
} from './types';
import { Observation, Bundle, DiagnosticReport } from '../models/fhir.types';

export type {
  CheckResult,
  CheckIssue,
  CheckStatus,
  CheckCategory,
  CheckSuiteResult,
  ParseResult,
  ValidationReport,
  ValidateOptions
};
export type { DccRunReport };
export { formatReportAsMarkdown, formatReportAsHtml, TOOL_VERSION } from './report/build-report';
export { formatReport, normalizeReportFormat, reportFileExtension } from './io/format-report';
export {
  parseConfigFromText,
  loadAndValidateConfigText,
  detectConfigKind,
  parseConfigCsv
} from './io/load-config';
export {
  DEFAULT_FHIR_LAB_CONFIG,
  resolveEffectiveConfig,
  defaultRunContext,
  validateValidationConfig,
  hashConfig,
  applyConfigEntityRules,
  applyMetadataRequirements,
  applyExpectedFilesCheck
} from './config';
export { BUILTIN_PLUGINS, BUILTIN_PLUGIN_IDS } from './plugins/registry';
export { runCheckPipeline } from './pipeline/run-pipeline';
export {
  isTabularDatasetInput,
  parseTabularDataset,
  runTabularDictionaryChecks
} from './pipeline/tabular-dictionary';
export { DCC_PRESETS, findPreset } from './presets/catalog';
export type { DccPreset, PresetKind } from './presets/catalog';
export { fetchTextAsset } from './presets/load-asset';
export type {
  DatasetRunContext,
  ValidationConfig,
  GateStatus,
  ValidationMode,
  EffectiveConfigRef,
  RecordValidationResult,
  AliasMapping,
  CrossFileReference
} from './config';

export class FhirObservationChecker {
  validate(content: string, options?: ValidateOptions): ValidationReport {
    const source = options?.source ?? 'Input';
    const sourceDetail = options?.sourceDetail;
    const parseResult = this.parseInput(content);

    if (!parseResult.ok) {
      const { issues, checkResults } = this.buildParseErrorResult(parseResult, source, sourceDetail);
      return { parseResult, issues, checkResults };
    }

    const { issues, observationCount, laboratoryCount, diagnosticReportCount } = this.performValidation(parseResult, content, source);
    const checkResults = this.generateValidationResults(issues, observationCount, laboratoryCount, diagnosticReportCount, parseResult, source, sourceDetail);
    return {
      parseResult,
      issues,
      checkResults,
      observationCount,
      laboratoryCount,
      diagnosticReportCount
    };
  }

  private buildParseErrorResult(parseResult: ParseResult, source: string, sourceDetail?: string): { issues: CheckIssue[]; checkResults: CheckResult[] } {
    return {
      issues: [{
        severity: 'error',
        label: 'Invalid input',
        detail: parseResult.error ?? 'Unable to parse input.',
        location: source
      }],
      checkResults: [
        { label: 'Source', status: 'ok', statusLabel: 'OK', detail: `${source} detected${sourceDetail ? `: ${sourceDetail}` : ''}.` },
        { label: 'Parsing', status: 'error', statusLabel: 'Error', detail: parseResult.error ?? 'Invalid JSON/NDJSON input.' }
      ]
    };
  }

  private parseInput(content: string): ParseResult {
    const trimmed = content.trim();
    if (!trimmed) {
      return {
        ok: false,
        type: 'Empty',
        resources: [],
        diagnosticReports: [],
        error: 'Input is empty.'
      };
    }

    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        const { observations, diagnosticReports } = this.extractObservationsAndDiagnosticReports(parsed);
        return {
          ok: true,
          type: Array.isArray(parsed) ? 'JSON Array' : 'JSON Object',
          resources: observations,
          diagnosticReports
        };
      } catch (error) {
        return {
          ok: false,
          type: 'JSON',
          resources: [],
          diagnosticReports: [],
          error: error instanceof Error ? error.message : 'Invalid JSON.'
        };
      }
    }

    const lines = trimmed.split(/\r?\n/).filter((line) => line.trim());
    const raw: unknown[] = [];
    for (let i = 0; i < lines.length; i += 1) {
      try {
        raw.push(JSON.parse(lines[i]));
      } catch (error) {
        return {
          ok: false,
          type: 'NDJSON',
          resources: [],
          diagnosticReports: [],
          error: `Invalid NDJSON on line ${i + 1}.`
        };
      }
    }

    const { observations, diagnosticReports } = this.extractObservationsAndDiagnosticReports(raw);
    return {
      ok: true,
      type: 'NDJSON',
      resources: observations,
      diagnosticReports
    };
  }

  private extractObservationsAndDiagnosticReports(parsed: unknown): { observations: Observation[]; diagnosticReports: DiagnosticReport[] } {
    const observations: Observation[] = [];
    const diagnosticReports: DiagnosticReport[] = [];

    if (Array.isArray(parsed)) {
      for (const entry of parsed) {
        const r = this.extractObservationsAndDiagnosticReports(entry);
        observations.push(...r.observations);
        diagnosticReports.push(...r.diagnosticReports);
      }
      return { observations, diagnosticReports };
    }

    if (
      parsed &&
      typeof parsed === 'object' &&
      'resourceType' in parsed &&
      (parsed as any).resourceType === 'Bundle' &&
      'entry' in parsed &&
      Array.isArray((parsed as any).entry)
    ) {
      const bundle = parsed as Bundle;
      for (const entry of bundle.entry ?? []) {
        const res = entry?.resource;
        if (res?.resourceType === 'Observation') observations.push(res as Observation);
        if (res?.resourceType === 'DiagnosticReport') diagnosticReports.push(res as DiagnosticReport);
      }
      return { observations, diagnosticReports };
    }

    if (parsed && typeof parsed === 'object' && 'resourceType' in parsed) {
      const rt = (parsed as any).resourceType;
      if (rt === 'Observation') return { observations: [parsed as Observation], diagnosticReports: [] };
      if (rt === 'DiagnosticReport') return { observations: [], diagnosticReports: [parsed as DiagnosticReport] };
    }

    return { observations, diagnosticReports };
  }

  private performValidation(
    parseResult: ParseResult,
    content: string,
    source: string
  ): { issues: CheckIssue[]; observationCount: number; laboratoryCount: number; diagnosticReportCount: number } {
    const resources = parseResult.resources;
    const diagnosticReports = parseResult.diagnosticReports ?? [];
    const issues: CheckIssue[] = [];
    let observationCount = 0;
    let laboratoryCount = 0;
    const diagnosticReportCount = diagnosticReports.length;

    // Validate overall structure
    if (resources.length === 0 && diagnosticReports.length === 0) {
      issues.push({
        severity: 'error',
        label: 'No resources found',
        detail: 'The input does not contain any valid FHIR resources (Observation or DiagnosticReport).',
        location: source
      });
    }

    // Validate Bundle structure if applicable
    if (parseResult.type.includes('Bundle') || parseResult.type.includes('JSON Object')) {
      issues.push(...this.validateBundleStructure(content, source));
    }

    // Process each Observation
    resources.forEach((resource, index) => {
      const location = `Observation ${index + 1}`;
      if (!resource || typeof resource !== 'object') {
        issues.push({
          severity: 'error',
          label: 'Invalid resource',
          detail: 'Resource is not a valid JSON object.',
          location
        });
        return;
      }

      issues.push(...this.validateResourceStructure(resource, location));

      if (resource.resourceType !== 'Observation') {
        issues.push({
          severity: 'error',
          label: 'Unsupported resource',
          detail: `Expected Observation, received "${resource.resourceType ?? 'Unknown'}".`,
          location
        });
        return;
      }

      observationCount += 1;
      if (this.isLaboratoryObservation(resource)) {
        laboratoryCount += 1;
      }
      issues.push(...this.validateObservation(resource, location));
    });

    // Process each DiagnosticReport
    diagnosticReports.forEach((dr, index) => {
      const location = `DiagnosticReport ${index + 1}`;
      if (!dr || typeof dr !== 'object') {
        issues.push({
          severity: 'error',
          label: 'Invalid resource',
          detail: 'Resource is not a valid JSON object.',
          location
        });
        return;
      }
      issues.push(...this.validateResourceStructure(dr, location));
      issues.push(...this.validateDiagnosticReport(dr, location));
    });

    // Validate resource relationships (Observations only for now)
    if (resources.length > 1) {
      issues.push(...this.validateResourceRelationships(resources));
    }

    if (observationCount === 0 && diagnosticReports.length === 0) {
      issues.push({
        severity: 'error',
        label: 'No observations found',
        detail: 'The dataset contains no Observation or DiagnosticReport resources.',
        location: source
      });
    } else if (observationCount === 0 && diagnosticReports.length > 0) {
      issues.push({
        severity: 'warn',
        label: 'No Observation resources',
        detail: 'Only DiagnosticReport(s) found. Observation.result references cannot be validated against inline resources.',
        location: source
      });
    }

    return { issues, observationCount, laboratoryCount, diagnosticReportCount };
  }

  private generateValidationResults(
    issues: CheckIssue[],
    observationCount: number,
    laboratoryCount: number,
    diagnosticReportCount: number,
    parseResult: ParseResult,
    source: string,
    sourceDetail?: string
  ): CheckResult[] {
    const errorCount = issues.filter((issue) => issue.severity === 'error').length;
    const warnCount = issues.filter((issue) => issue.severity === 'warn').length;
    const criticalCount = issues.filter((issue) => issue.label.includes('Critical')).length;

    return [
      {
        label: 'Source',
        status: 'ok',
        statusLabel: 'OK',
        detail: `${source} detected${sourceDetail ? `: ${sourceDetail}` : ''}.`
      },
      {
        label: 'Input format',
        status: parseResult.ok ? 'ok' : 'error',
        statusLabel: parseResult.ok ? 'OK' : 'Error',
        detail: parseResult.ok ? parseResult.type : 'Invalid JSON/NDJSON.'
      },
      {
        label: 'Observations',
        status: observationCount > 0 ? 'ok' : (diagnosticReportCount > 0 ? 'warn' : 'error'),
        statusLabel: observationCount > 0 ? 'OK' : (diagnosticReportCount > 0 ? 'Notice' : 'Error'),
        detail: `${observationCount} Observation resource(s) found.`
      },
      {
        label: 'Diagnostic reports',
        status: diagnosticReportCount > 0 ? 'ok' : 'ok',
        statusLabel: 'OK',
        detail: `${diagnosticReportCount} DiagnosticReport resource(s) found.`
      },
      {
        label: 'Laboratory observations',
        status: laboratoryCount > 0 ? 'ok' : 'warn',
        statusLabel: laboratoryCount > 0 ? 'OK' : 'Notice',
        detail: laboratoryCount > 0
          ? `${laboratoryCount} laboratory observation(s) detected with parameter-specific validation.`
          : 'No laboratory observations detected.'
      },
      {
        label: 'Errors',
        status: errorCount === 0 ? 'ok' : 'error',
        statusLabel: errorCount === 0 ? 'OK' : 'Error',
        detail: errorCount === 0 ? 'No errors found.' : `${errorCount} error(s) found.`
      },
      {
        label: 'Warnings',
        status: warnCount === 0 ? 'ok' : 'warn',
        statusLabel: warnCount === 0 ? 'OK' : 'Notice',
        detail: warnCount === 0 ? 'No warnings found.' : `${warnCount} warning(s) found.`
      },
      ...(criticalCount > 0
        ? [
            {
              label: 'Critical values',
              status: 'warn' as CheckStatus,
              statusLabel: 'Warning',
              detail: `${criticalCount} critical value(s) detected. Please review immediately.`
            }
          ]
        : [])
    ];
  }

  private validateObservation(observation: Observation, location: string): CheckIssue[] {
    const issues: CheckIssue[] = [];
    const valueKeys = [
      'valueQuantity',
      'valueCodeableConcept',
      'valueString',
      'valueBoolean',
      'valueInteger',
      'valueRange',
      'valueRatio',
      'valueSampledData',
      'valueTime',
      'valueDateTime',
      'valuePeriod',
      'valueAttachment'
    ];
    const hasValue = valueKeys.some((key) => (observation as any)[key] !== undefined);

    if (!observation.status) {
      issues.push({
        severity: 'error',
        label: 'Missing status',
        detail: 'Observation.status is required.',
        location
      });
    } else if (!this.isValidStatus(observation.status)) {
      issues.push({
        severity: 'error',
        label: 'Invalid status',
        detail: `Observation.status "${observation.status}" is not a valid value.`,
        location
      });
    }

    if (!this.hasCode(observation.code)) {
      issues.push({
        severity: 'error',
        label: 'Missing code',
        detail: 'Observation.code is required.',
        location
      });
    }

    if (observation.dataAbsentReason && hasValue) {
      issues.push({
        severity: 'error',
        label: 'dataAbsentReason with value',
        detail: 'dataAbsentReason must only be present when value[x] is missing.',
        location
      });
    }

    if (observation.organizer === true) {
      if (hasValue || observation.dataAbsentReason || (observation.component ?? []).length) {
        issues.push({
          severity: 'error',
          label: 'Organizer rule',
          detail: 'If organizer is true, value[x], dataAbsentReason, and component must be absent.',
          location
        });
      }
    }

    if (!Array.isArray(observation.performer) || observation.performer.length === 0) {
      issues.push({
        severity: 'warn',
        label: 'Missing performer',
        detail: 'Observation.performer is recommended.',
        location
      });
    } else {
      const validPerformerTypes = [
        'Practitioner',
        'PractitionerRole',
        'Organization',
        'CareTeam',
        'Patient',
        'RelatedPerson',
        'HealthcareService',
        'Group'
      ];
      observation.performer.forEach((performer: any, index: number) => {
        const performerLocation = `${location} · performer[${index}]`;
        if (!performer?.reference) {
          issues.push({
            severity: 'warn',
            label: 'Invalid performer reference',
            detail: 'performer should reference who is responsible for the observation.',
            location: performerLocation
          });
        } else {
          const ref = performer.reference;
          const isValidType = validPerformerTypes.some((type) => ref.includes(`${type}/`));
          if (!isValidType) {
            issues.push({
              severity: 'warn',
              label: 'Non-standard performer reference',
              detail: `performer should reference one of: ${validPerformerTypes.join(', ')}.`,
              location: performerLocation
            });
          }
        }
      });
    }

    if (Array.isArray(observation.referenceRange)) {
      observation.referenceRange.forEach((range: any, index: number) => {
        const rangeLocation = `${location} · referenceRange[${index}]`;
        const hasLow = range?.low !== undefined;
        const hasHigh = range?.high !== undefined;
        const hasText = range?.text !== undefined;
        if (!hasLow && !hasHigh && !hasText) {
          issues.push({
            severity: 'error',
            label: 'Invalid referenceRange',
            detail: 'referenceRange must have low, high, or text.',
            location: rangeLocation
          });
        }
        if (range?.low?.comparator && !['>=', '>'].includes(range.low.comparator)) {
          issues.push({
            severity: 'error',
            label: 'Invalid low comparator',
            detail: 'referenceRange.low.comparator must be ">=" or ">".',
            location: rangeLocation
          });
        }
        if (range?.high?.comparator && !['<=', '<'].includes(range.high.comparator)) {
          issues.push({
            severity: 'error',
            label: 'Invalid high comparator',
            detail: 'referenceRange.high.comparator must be "<=" or "<".',
            location: rangeLocation
          });
        }

        if (range?.age) {
          const age = range.age;
          if (age.low && age.high) {
            try {
              const lowValue = this.extractQuantityValue(age.low);
              const highValue = this.extractQuantityValue(age.high);
              if (lowValue !== null && highValue !== null && lowValue > highValue) {
                issues.push({
                  severity: 'error',
                  label: 'Invalid age range',
                  detail: 'referenceRange.age.low must be less than or equal to high.',
                  location: rangeLocation
                });
              }
            } catch {
              issues.push({
                severity: 'warn',
                label: 'Invalid age range format',
                detail: 'referenceRange.age should be a valid Range with Quantity values.',
                location: rangeLocation
              });
            }
          }
        }
      });
    }

    if (Array.isArray(observation.triggeredBy)) {
      observation.triggeredBy.forEach((trigger: any, index: number) => {
        const triggerLocation = `${location} · triggeredBy[${index}]`;
        if (!trigger?.observation) {
          issues.push({
            severity: 'error',
            label: 'Missing triggeredBy.observation',
            detail: 'triggeredBy.observation is required when triggeredBy is present.',
            location: triggerLocation
          });
        }
        if (!trigger?.type) {
          issues.push({
            severity: 'error',
            label: 'Missing triggeredBy.type',
            detail: 'triggeredBy.type is required when triggeredBy is present.',
            location: triggerLocation
          });
        } else if (!['reflex', 'repeat', 're-run'].includes(trigger.type)) {
          issues.push({
            severity: 'error',
            label: 'Invalid triggeredBy.type',
            detail: 'triggeredBy.type must be one of: reflex, repeat, re-run.',
            location: triggerLocation
          });
        }
      });
    }

    if (Array.isArray(observation.component) && observation.component.length) {
      const observationCodings = this.extractCodings(observation.code);
      if (hasValue && observationCodings.length) {
        const componentMatches = observation.component.some((component: any) =>
          this.extractCodings(component?.code).some((coding) => observationCodings.includes(coding))
        );
        if (componentMatches) {
          issues.push({
            severity: 'error',
            label: 'Component code conflict',
            detail: 'When component.code matches Observation.code, value[x] must be absent.',
            location
          });
        }
      }

      observation.component.forEach((component: any, index: number) => {
        const componentLocation = `${location} · component[${index}]`;
        if (!this.hasCode(component?.code)) {
          issues.push({
            severity: 'error',
            label: 'Missing component.code',
            detail: 'Component.code is required.',
            location: componentLocation
          });
        }

        const componentValueKeys = valueKeys.filter((key) => component?.[key] !== undefined);
        const hasComponentValue = componentValueKeys.length > 0;

        if (component?.dataAbsentReason && hasComponentValue) {
          issues.push({
            severity: 'error',
            label: 'Component dataAbsentReason with value',
            detail: 'Component.dataAbsentReason must only be present when component.value[x] is missing.',
            location: componentLocation
          });
        }
      });
    }

    if (!observation.subject) {
      issues.push({
        severity: 'warn',
        label: 'Missing subject',
        detail: 'Observation.subject is recommended to identify who/what the observation is about.',
        location
      });
    } else if (observation.subject.reference) {
      const validSubjectTypes = [
        'Patient',
        'Group',
        'Device',
        'Location',
        'Organization',
        'Procedure',
        'Practitioner',
        'Medication',
        'Substance',
        'BiologicallyDerivedProduct',
        'NutritionProduct'
      ];
      const ref = observation.subject.reference;
      const isValidType = validSubjectTypes.some((type) => ref.includes(`${type}/`));
      if (!isValidType) {
        issues.push({
          severity: 'warn',
          label: 'Non-standard subject reference',
          detail: `subject should reference one of: ${validSubjectTypes.join(', ')}.`,
          location
        });
      }
    }

    if (Array.isArray(observation.focus) && observation.focus.length > 0) {
      if (!observation.subject) {
        issues.push({
          severity: 'warn',
          label: 'Focus without subject',
          detail: 'When focus is present, subject should also be present to indicate whose record this observation belongs to.',
          location
        });
      }
      observation.focus.forEach((focus: any, index: number) => {
        const focusLocation = `${location} · focus[${index}]`;
        if (!focus?.reference) {
          issues.push({
            severity: 'warn',
            label: 'Invalid focus reference',
            detail: 'focus should reference the actual focus of the observation (when different from subject).',
            location: focusLocation
          });
        }
      });
    }

    if (!observation.effectiveDateTime && !observation.effectivePeriod && !observation.effectiveTiming && !observation.effectiveInstant) {
      issues.push({
        severity: 'warn',
        label: 'Missing effective time',
        detail: 'Observation.effective[x] is recommended for clinical relevance (physiologically relevant time).',
        location
      });
    }

    if (observation.code) {
      const codeSystem = this.getCodeSystem(observation.code);
      if (codeSystem && !this.isPreferredCodeSystem(codeSystem)) {
        issues.push({
          severity: 'warn',
          label: 'Non-preferred code system',
          detail: `Code system "${codeSystem}" is not preferred. LOINC or SNOMED CT are recommended.`,
          location
        });
      }
    }

    if (Array.isArray(observation.category)) {
      observation.category.forEach((category: any, index: number) => {
        const categoryLocation = `${location} · category[${index}]`;
        const categorySystem = this.getCodeSystem(category);
        if (categorySystem && categorySystem !== 'http://terminology.hl7.org/CodeSystem/observation-category') {
          issues.push({
            severity: 'warn',
            label: 'Non-standard category',
            detail: 'Category should use ObservationCategoryCodes value set.',
            location: categoryLocation
          });
        }
      });
    }

    if (Array.isArray(observation.interpretation)) {
      observation.interpretation.forEach((interpretation: any, index: number) => {
        const interpretationLocation = `${location} · interpretation[${index}]`;
        const interpretationSystem = this.getCodeSystem(interpretation);
        if (interpretationSystem && interpretationSystem !== 'http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation') {
          issues.push({
            severity: 'warn',
            label: 'Non-standard interpretation',
            detail: 'Interpretation should use ObservationInterpretationCodes value set.',
            location: interpretationLocation
          });
        }
      });
    }

    if (observation.bodySite) {
      issues.push({
        severity: 'warn',
        label: 'Deprecated bodySite',
        detail: 'Observation.bodySite should use SNOMED CT codes for anatomical location.',
        location
      });
    }

    if (observation.specimen?.reference) {
      const ref = observation.specimen.reference;
      if (ref.includes('Group/')) {
        issues.push({
          severity: 'warn',
          label: 'Specimen Group reference',
          detail: 'If specimen is a Group reference, all members must be Specimen resources.',
          location
        });
      } else if (!ref.includes('Specimen/')) {
        issues.push({
          severity: 'warn',
          label: 'Non-standard specimen reference',
          detail: 'specimen should reference a Specimen or Group resource.',
          location
        });
      }
    }

    if (hasValue) {
      const valueType = valueKeys.find((key) => (observation as any)[key] !== undefined);
      if (valueType === 'valueBoolean') {
        issues.push({
          severity: 'warn',
          label: 'Boolean value type',
          detail: 'Boolean values are rarely appropriate. Consider using CodeableConcept with yes/no codes instead.',
          location
        });
      }

      if (valueType === 'valueQuantity' && observation.valueQuantity) {
        const quantity = observation.valueQuantity;
        if (quantity.value === undefined || quantity.value === null) {
          issues.push({
            severity: 'error',
            label: 'Missing quantity value',
            detail: 'valueQuantity.value is required.',
            location
          });
        }
        if (quantity.unit && !quantity.code && !quantity.system) {
          issues.push({
            severity: 'warn',
            label: 'Quantity without code/system',
            detail: 'valueQuantity should include code and system (preferably UCUM) for interoperability.',
            location
          });
        }
        if (quantity.comparator && !['<', '<=', '>=', '>'].includes(quantity.comparator)) {
          issues.push({
            severity: 'error',
            label: 'Invalid quantity comparator',
            detail: 'valueQuantity.comparator must be one of: <, <=, >=, >.',
            location
          });
        }
      }
    }

    if (Array.isArray(observation.identifier)) {
      observation.identifier.forEach((identifier: any, index: number) => {
        const identifierLocation = `${location} · identifier[${index}]`;
        if (!identifier?.system && !identifier?.value) {
          issues.push({
            severity: 'warn',
            label: 'Incomplete identifier',
            detail: 'Identifier should have both system and value for proper identification.',
            location: identifierLocation
          });
        }
      });
    }

    if (observation.issued) {
      try {
        const issuedDate = new Date(observation.issued);
        if (isNaN(issuedDate.getTime())) {
          issues.push({
            severity: 'error',
            label: 'Invalid issued date',
            detail: 'Observation.issued must be a valid instant (ISO 8601 format).',
            location
          });
        }
      } catch {
        issues.push({
          severity: 'error',
          label: 'Invalid issued date',
          detail: 'Observation.issued must be a valid instant (ISO 8601 format).',
          location
        });
      }
    }

    if (observation.effectiveDateTime) {
      try {
        const effectiveDate = new Date(observation.effectiveDateTime);
        if (isNaN(effectiveDate.getTime())) {
          issues.push({
            severity: 'error',
            label: 'Invalid effectiveDateTime',
            detail: 'Observation.effectiveDateTime must be a valid dateTime (ISO 8601 format).',
            location
          });
        }
      } catch {
        issues.push({
          severity: 'error',
          label: 'Invalid effectiveDateTime',
          detail: 'Observation.effectiveDateTime must be a valid dateTime (ISO 8601 format).',
          location
        });
      }
    }

    if (observation.effectivePeriod) {
      const period = observation.effectivePeriod;
      if (period.start && period.end) {
        try {
          const startDate = new Date(period.start);
          const endDate = new Date(period.end);
          if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
            issues.push({
              severity: 'error',
              label: 'Invalid effectivePeriod dates',
              detail: 'effectivePeriod.start and end must be valid dates (ISO 8601 format).',
              location
            });
          } else if (startDate > endDate) {
            issues.push({
              severity: 'error',
              label: 'Invalid effectivePeriod range',
              detail: 'effectivePeriod.start must be before or equal to end.',
              location
            });
          }
        } catch {
          issues.push({
            severity: 'error',
            label: 'Invalid effectivePeriod',
            detail: 'effectivePeriod must have valid start and end dates (ISO 8601 format).',
            location
          });
        }
      }
    }

    if (Array.isArray(observation.hasMember)) {
      observation.hasMember.forEach((member: any, index: number) => {
        const memberLocation = `${location} · hasMember[${index}]`;
        if (!member?.reference) {
          issues.push({
            severity: 'error',
            label: 'Invalid hasMember reference',
            detail: 'hasMember must reference an Observation or QuestionnaireResponse resource.',
            location: memberLocation
          });
        } else {
          const ref = member.reference;
          if (!ref.includes('Observation/') && !ref.includes('QuestionnaireResponse/')) {
            issues.push({
              severity: 'warn',
              label: 'Non-standard hasMember reference',
              detail: 'hasMember should reference Observation or QuestionnaireResponse resources.',
              location: memberLocation
            });
          }
        }
      });
    }

    if (Array.isArray(observation.derivedFrom)) {
      observation.derivedFrom.forEach((derived: any, index: number) => {
        const derivedLocation = `${location} · derivedFrom[${index}]`;
        if (!derived?.reference) {
          issues.push({
            severity: 'warn',
            label: 'Missing derivedFrom reference',
            detail: 'derivedFrom should reference the source resource (DocumentReference, ImagingStudy, Observation, etc.).',
            location: derivedLocation
          });
        }
      });
    }

    if (Array.isArray(observation.partOf)) {
      const validPartOfTypes = [
        'MedicationAdministration',
        'MedicationDispense',
        'MedicationStatement',
        'Procedure',
        'Immunization',
        'ImagingStudy'
      ];
      observation.partOf.forEach((part: any, index: number) => {
        const partLocation = `${location} · partOf[${index}]`;
        if (!part?.reference) {
          issues.push({
            severity: 'warn',
            label: 'Missing partOf reference',
            detail: 'partOf should reference the larger event this observation is part of.',
            location: partLocation
          });
        } else {
          const ref = part.reference;
          const isValidType = validPartOfTypes.some((type) => ref.includes(`${type}/`));
          if (!isValidType) {
            issues.push({
              severity: 'warn',
              label: 'Non-standard partOf reference',
              detail: `partOf should reference one of: ${validPartOfTypes.join(', ')}.`,
              location: partLocation
            });
          }
        }
      });
    }

    if (observation.encounter) {
      if (!observation.encounter.reference) {
        issues.push({
          severity: 'warn',
          label: 'Invalid encounter reference',
          detail: 'encounter should reference an Encounter resource.',
          location
        });
      } else if (!observation.encounter.reference.includes('Encounter/')) {
        issues.push({
          severity: 'warn',
          label: 'Non-standard encounter reference',
          detail: 'encounter should reference an Encounter resource.',
          location
        });
      }
    }

    if (observation.device) {
      if (!observation.device.reference) {
        issues.push({
          severity: 'warn',
          label: 'Invalid device reference',
          detail: 'device should reference a Device or DeviceMetric resource.',
          location
        });
      } else if (!observation.device.reference.includes('Device/') && !observation.device.reference.includes('DeviceMetric/')) {
        issues.push({
          severity: 'warn',
          label: 'Non-standard device reference',
          detail: 'device should reference a Device or DeviceMetric resource.',
          location
        });
      }
    }

    if (Array.isArray(observation.note)) {
      observation.note.forEach((note: any, index: number) => {
        const noteLocation = `${location} · note[${index}]`;
        if (!note?.text) {
          issues.push({
            severity: 'warn',
            label: 'Empty note',
            detail: 'note.text should contain the comment text.',
            location: noteLocation
          });
        }
        if (note?.authorReference && !note.authorReference.reference) {
          issues.push({
            severity: 'warn',
            label: 'Invalid note author',
            detail: 'note.authorReference should reference a valid resource.',
            location: noteLocation
          });
        }
      });
    }

    if (observation.method) {
      if (!this.hasCode(observation.method)) {
        issues.push({
          severity: 'warn',
          label: 'Invalid method',
          detail: 'method should be a CodeableConcept describing how the observation was performed.',
          location
        });
      } else {
        const methodSystem = this.getCodeSystem(observation.method);
        if (methodSystem && !methodSystem.includes('snomed.info')) {
          issues.push({
            severity: 'warn',
            label: 'Non-standard method code system',
            detail: 'method should use SNOMED CT codes (Technique, Action, or Evaluation procedure).',
            location
          });
        }
      }
    }

    // bodyStructure is not part of FHIR R4 Observation - removed validation

    if (Array.isArray(observation.basedOn)) {
      const validBasedOnTypes = [
        'CarePlan',
        'DeviceRequest',
        'MedicationRequest',
        'NutritionOrder',
        'ServiceRequest'
      ];
      observation.basedOn.forEach((based: any, index: number) => {
        const basedLocation = `${location} · basedOn[${index}]`;
        if (!based?.reference) {
          issues.push({
            severity: 'warn',
            label: 'Missing basedOn reference',
            detail: 'basedOn should reference the plan, proposal, or order this observation fulfills.',
            location: basedLocation
          });
        } else {
          const ref = based.reference;
          const isValidType = validBasedOnTypes.some((type) => ref.includes(`${type}/`));
          if (!isValidType) {
            issues.push({
              severity: 'warn',
              label: 'Non-standard basedOn reference',
              detail: `basedOn should reference one of: ${validBasedOnTypes.join(', ')}.`,
              location: basedLocation
            });
          }
        }
      });
    }

    // interpretationContext is not part of FHIR R4 Observation - removed validation

    // Laboratory-specific validations
    const labIssues = this.validateLaboratoryObservation(observation, location);
    issues.push(...labIssues);

    // Additional structural validations
    issues.push(...this.validateCodeableConcepts(observation, location));
    issues.push(...this.validateReferences(observation, location));
    issues.push(...this.validateDates(observation, location));
    issues.push(...this.validateURLs(observation, location));

    return issues;
  }

  private validateDiagnosticReport(dr: DiagnosticReport, location: string): CheckIssue[] {
    const issues: CheckIssue[] = [];

    if (!dr.status) {
      issues.push({
        severity: 'error',
        label: 'Missing status',
        detail: 'DiagnosticReport.status is required.',
        location
      });
    } else if (!this.isValidDiagnosticReportStatus(dr.status)) {
      issues.push({
        severity: 'error',
        label: 'Invalid status',
        detail: `DiagnosticReport.status "${dr.status}" is not a valid value.`,
        location
      });
    }

    if (!this.hasCode(dr.code)) {
      issues.push({
        severity: 'error',
        label: 'Missing code',
        detail: 'DiagnosticReport.code is required.',
        location
      });
    } else {
      issues.push(...this.validateCodeableConcept(dr.code, location, 'code'));
    }

    if (Array.isArray(dr.category) && dr.category.length > 0) {
      dr.category.forEach((cat: any, i: number) => {
        issues.push(...this.validateCodeableConcept(cat, `${location} · category[${i}]`, 'category'));
      });
    } else {
      issues.push({
        severity: 'warn',
        label: 'Missing category',
        detail: 'DiagnosticReport.category is recommended for searching and display.',
        location
      });
    }

    if (!dr.subject) {
      issues.push({
        severity: 'warn',
        label: 'Missing subject',
        detail: 'DiagnosticReport.subject is recommended.',
        location
      });
    }
    if (dr.subject) {
      issues.push(...this.validateReference(dr.subject, location, 'subject'));
    }

    const hasEffective = !!(dr.effectiveDateTime || (dr.effectivePeriod && (dr.effectivePeriod.start || dr.effectivePeriod.end)) || dr.issued);
    if (!hasEffective) {
      issues.push({
        severity: 'warn',
        label: 'Missing effective or issued',
        detail: 'At least one of effectiveDateTime, effectivePeriod, or issued is recommended.',
        location
      });
    }
    if (dr.effectiveDateTime || dr.effectivePeriod || dr.issued) {
      issues.push(...this.validateDates(dr as any, location));
    }

    if (!Array.isArray(dr.performer) || dr.performer.length === 0) {
      issues.push({
        severity: 'warn',
        label: 'Missing performer',
        detail: 'DiagnosticReport.performer is recommended (responsible diagnostic service).',
        location
      });
    } else {
      dr.performer.forEach((p: any, i: number) => {
        issues.push(...this.validateReference(p, `${location} · performer[${i}]`, 'performer'));
      });
    }

    if (dr.encounter) {
      issues.push(...this.validateReference(dr.encounter, location, 'encounter'));
    }
    if (Array.isArray(dr.resultsInterpreter)) {
      dr.resultsInterpreter.forEach((r: any, i: number) => {
        issues.push(...this.validateReference(r, `${location} · resultsInterpreter[${i}]`, 'resultsInterpreter'));
      });
    }
    if (Array.isArray(dr.specimen)) {
      dr.specimen.forEach((s: any, i: number) => {
        issues.push(...this.validateReference(s, `${location} · specimen[${i}]`, 'specimen'));
      });
    }
    if (Array.isArray(dr.result)) {
      dr.result.forEach((r: any, i: number) => {
        issues.push(...this.validateReference(r, `${location} · result[${i}]`, 'result'));
      });
      if (dr.result.length === 0) {
        issues.push({
          severity: 'warn',
          label: 'Empty result',
          detail: 'DiagnosticReport.result is typically non-empty for lab and pathology reports.',
          location
        });
      }
    } else if (this.isLikelyLabReport(dr) && !Array.isArray(dr.result)) {
      issues.push({
        severity: 'warn',
        label: 'Missing result',
        detail: 'DiagnosticReport.result is recommended for laboratory and pathology reports.',
        location
      });
    }

    return issues;
  }

  private isValidDiagnosticReportStatus(s: string): boolean {
    const allowed: DiagnosticReport['status'][] = [
      'registered', 'partial', 'preliminary', 'modified', 'final', 'amended',
      'corrected', 'appended', 'cancelled', 'entered-in-error', 'unknown'
    ];
    return allowed.includes(s as any);
  }

  private isLikelyLabReport(dr: DiagnosticReport): boolean {
    const cat = dr.category;
    if (Array.isArray(cat)) {
      const lab = cat.some((c: any) =>
        (c?.coding || []).some((x: any) =>
          (String(x?.code || '')).toLowerCase() === 'laboratory' ||
          (String(x?.display || '')).toLowerCase().includes('lab')
        )
      );
      if (lab) return true;
    }
    const code = dr.code?.coding || [];
    return code.some((c: any) => (c?.system || '').includes('loinc'));
  }

  private extractCodings(codeable: any): string[] {
    if (!codeable || !Array.isArray(codeable.coding)) {
      return [];
    }
    return codeable.coding
      .map((coding: any) => {
        if (!coding?.code) {
          return '';
        }
        return `${coding.system ?? ''}|${coding.code}`;
      })
      .filter(Boolean);
  }

  private hasCode(codeable: any): boolean {
    if (!codeable || typeof codeable !== 'object') {
      return false;
    }
    if (Array.isArray(codeable.coding) && codeable.coding.length) {
      return true;
    }
    if (typeof codeable.text === 'string' && codeable.text.trim()) {
      return true;
    }
    return false;
  }

  private isValidStatus(status: string): boolean {
    const validStatuses = [
      'registered',
      'specimen-in-process',
      'preliminary',
      'final',
      'amended',
      'corrected',
      'appended',
      'cancelled',
      'entered-in-error',
      'unknown',
      'cannot-be-obtained'
    ];
    return validStatuses.includes(status);
  }

  private getCodeSystem(codeable: any): string | null {
    if (!codeable || !Array.isArray(codeable.coding) || codeable.coding.length === 0) {
      return null;
    }
    return codeable.coding[0]?.system ?? null;
  }

  private isPreferredCodeSystem(system: string): boolean {
    const preferredSystems = [
      'http://loinc.org',
      'http://snomed.info/sct',
      'https://loinc.org',
      'https://snomed.info/sct'
    ];
    return preferredSystems.some((pref) => system.startsWith(pref));
  }

  private extractQuantityValue(quantity: any): number | null {
    if (!quantity || typeof quantity.value !== 'number') {
      return null;
    }
    return quantity.value;
  }

  /**
   * Validates laboratory-specific aspects of an observation
   */
  private validateLaboratoryObservation(observation: Observation, location: string): CheckIssue[] {
    const issues: CheckIssue[] = [];
    const isLaboratory = this.isLaboratoryObservation(observation);

    if (!isLaboratory) {
      return issues;
    }

    // Check if category is set to laboratory
    const hasLabCategory = Array.isArray(observation.category) &&
      observation.category.some((cat: any) => {
        const codings = cat?.coding || [];
        return codings.some((coding: any) =>
          coding?.code === 'laboratory' ||
          coding?.system === 'http://terminology.hl7.org/CodeSystem/observation-category' &&
          coding?.code === 'laboratory'
        );
      });

    if (!hasLabCategory) {
      issues.push({
        severity: 'warn',
        label: 'Missing laboratory category',
        detail: 'Laboratory observations should have category set to "laboratory".',
        location
      });
    }

    // Extract LOINC code
    const loincCode = this.getLOINCCode(observation.code);
    if (!loincCode) {
      issues.push({
        severity: 'warn',
        label: 'Missing LOINC code',
        detail: 'Laboratory observations should use LOINC codes in Observation.code.',
        location
      });
      return issues;
    }

    // Validate specific laboratory parameters
    const labParam = this.getLaboratoryParameter(loincCode);
    if (labParam) {
      issues.push(...this.validateLaboratoryParameter(observation, labParam, location));
    }

    // Validate UCUM units for quantity values
    if (observation.valueQuantity) {
      issues.push(...this.validateUCUMUnit(observation.valueQuantity, location));
    }

    // Validate reference ranges for laboratory values
    if (Array.isArray(observation.referenceRange) && observation.referenceRange.length > 0) {
      issues.push(...this.validateLaboratoryReferenceRange(observation.referenceRange, labParam, location));
    }

    // Check for specimen (required for laboratory observations)
    if (!observation.specimen) {
      issues.push({
        severity: 'warn',
        label: 'Missing specimen',
        detail: 'Laboratory observations should reference a Specimen resource.',
        location
      });
    } else {
      issues.push(...this.validateLaboratorySpecimen(observation.specimen, loincCode, location));
    }

    // Validate laboratory panels/batteries
    if (observation.organizer === true || (observation.hasMember && observation.hasMember.length > 0)) {
      issues.push(...this.validateLaboratoryPanel(observation, location));
    }

    // Validate reflex tests
    if (Array.isArray(observation.triggeredBy) && observation.triggeredBy.length > 0) {
      issues.push(...this.validateReflexTest(observation, location));
    }

    // Validate delta checks
    if (Array.isArray(observation.derivedFrom) && observation.derivedFrom.length > 0) {
      issues.push(...this.validateDeltaCheck(observation, location));
    }

    // Validate laboratory method
    if (observation.method) {
      issues.push(...this.validateLaboratoryMethod(observation.method, loincCode, location));
    }

    // Validate timing (fasting, post-prandial, etc.)
    issues.push(...this.validateLaboratoryTiming(observation, loincCode, location));

    // Validate interpretation codes for laboratory
    if (Array.isArray(observation.interpretation) && observation.interpretation.length > 0) {
      issues.push(...this.validateLaboratoryInterpretation(observation.interpretation, observation.valueQuantity, labParam, location));
    }

    // Validate reference range populations
    if (Array.isArray(observation.referenceRange) && observation.referenceRange.length > 0) {
      issues.push(...this.validateReferenceRangePopulation(observation.referenceRange, location));
    }

    // Validate status workflow for laboratory
    issues.push(...this.validateLaboratoryStatusWorkflow(observation, location));

    // Validate issued vs effective time
    issues.push(...this.validateLaboratoryTimingRelationship(observation, location));

    // Validate performer for laboratory (should be Organization or PractitionerRole)
    if (Array.isArray(observation.performer) && observation.performer.length > 0) {
      issues.push(...this.validateLaboratoryPerformer(observation.performer, location));
    }

    // Validate device for laboratory equipment
    if (observation.device) {
      issues.push(...this.validateLaboratoryDevice(observation.device, location));
    }

    // Validate component observations in panels
    if (Array.isArray(observation.component) && observation.component.length > 0) {
      issues.push(...this.validateLaboratoryComponents(observation.component, loincCode, location));
    }

    // Validate LOINC code specificity
    issues.push(...this.validateLOINCCodeSpecificity(loincCode, observation.code, location));

    // Validate value type consistency
    if (observation.valueQuantity || observation.valueCodeableConcept || observation.valueString) {
      issues.push(...this.validateLaboratoryValueType(observation, loincCode, location));
    }

    // Validate data absent reason for laboratory
    if (observation.dataAbsentReason) {
      issues.push(...this.validateLaboratoryDataAbsentReason(observation.dataAbsentReason, location));
    }

    // Validate basedOn for laboratory orders
    if (Array.isArray(observation.basedOn) && observation.basedOn.length > 0) {
      issues.push(...this.validateLaboratoryOrder(observation.basedOn, location));
    }

    return issues;
  }

  /**
   * Determines if an observation is a laboratory observation
   */
  private isLaboratoryObservation(observation: Observation): boolean {
    // Check category
    if (Array.isArray(observation.category)) {
      const hasLabCategory = observation.category.some((cat: any) => {
        const codings = cat?.coding || [];
        return codings.some((coding: any) =>
          coding?.code === 'laboratory' ||
          (coding?.system === 'http://terminology.hl7.org/CodeSystem/observation-category' &&
            coding?.code === 'laboratory')
        );
      });
      if (hasLabCategory) {
        return true;
      }
    }

    // Check if code is a LOINC code (likely laboratory)
    const loincCode = this.getLOINCCode(observation.code);
    if (loincCode) {
      return true;
    }

    return false;
  }

  private getLOINCCode(codeable: any): string | null {
    if (!codeable || !Array.isArray(codeable.coding)) {
      return null;
    }
    const loincCoding = codeable.coding.find((coding: any) =>
      coding?.system === 'http://loinc.org' || coding?.system === 'https://loinc.org'
    );
    return loincCoding?.code || null;
  }

  private getLaboratoryParameter(loincCode: string): any {
    const labParameters: { [key: string]: any } = {
      // Glucose
      '2339-0': { name: 'Glucose', unit: 'mg/dL', typicalRange: { low: 70, high: 100 }, altUnit: 'mmol/L', altRange: { low: 3.9, high: 5.6 }, requiresFasting: false, specimenType: 'blood' },
      '2345-7': { name: 'Glucose', unit: 'mg/dL', typicalRange: { low: 70, high: 100 }, altUnit: 'mmol/L', altRange: { low: 3.9, high: 5.6 }, requiresFasting: false, specimenType: 'blood' },
      '33741-0': { name: 'Glucose', unit: 'mg/dL', typicalRange: { low: 70, high: 100 }, altUnit: 'mmol/L', altRange: { low: 3.9, high: 5.6 }, requiresFasting: false, specimenType: 'blood' },
      '1558-6': { name: 'Glucose Fasting', unit: 'mg/dL', typicalRange: { low: 70, high: 100 }, altUnit: 'mmol/L', altRange: { low: 3.9, high: 5.6 }, requiresFasting: true, specimenType: 'blood' },
      '33740-2': { name: 'Glucose 2h Post Meal', unit: 'mg/dL', typicalRange: { low: 70, high: 140 }, altUnit: 'mmol/L', altRange: { low: 3.9, high: 7.8 }, requiresFasting: false, specimenType: 'blood' },
      // HbA1c
      '4548-4': { name: 'HbA1c', unit: '%', typicalRange: { low: 4.0, high: 5.6 }, specimenType: 'blood' },
      '71875-9': { name: 'HbA1c', unit: '%', typicalRange: { low: 4.0, high: 5.6 }, specimenType: 'blood' },
      // Creatinine
      '2160-0': { name: 'Creatinine', unit: 'mg/dL', typicalRange: { low: 0.6, high: 1.2 }, altUnit: 'μmol/L', altRange: { low: 53, high: 106 }, specimenType: 'blood' },
      '38483-4': { name: 'Creatinine', unit: 'mg/dL', typicalRange: { low: 0.6, high: 1.2 }, altUnit: 'μmol/L', altRange: { low: 53, high: 106 }, specimenType: 'blood' },
      '2161-8': { name: 'Creatinine Urine', unit: 'mg/dL', typicalRange: { low: 20, high: 300 }, specimenType: 'urine' },
      // Hemoglobin
      '718-7': { name: 'Hemoglobin', unit: 'g/dL', typicalRange: { low: 12.0, high: 16.0 }, altUnit: 'g/L', altRange: { low: 120, high: 160 }, specimenType: 'blood' },
      '4544-3': { name: 'Hemoglobin', unit: 'g/dL', typicalRange: { low: 12.0, high: 16.0 }, altUnit: 'g/L', altRange: { low: 120, high: 160 }, specimenType: 'blood' },
      // Hematocrit
      '4545-0': { name: 'Hematocrit', unit: '%', typicalRange: { low: 36.0, high: 46.0 }, specimenType: 'blood' },
      '20570-8': { name: 'Hematocrit', unit: '%', typicalRange: { low: 36.0, high: 46.0 }, specimenType: 'blood' },
      // White Blood Cell Count
      '6690-2': { name: 'WBC', unit: '10*3/uL', typicalRange: { low: 4.0, high: 11.0 }, altUnit: '10*9/L', altRange: { low: 4.0, high: 11.0 }, specimenType: 'blood' },
      '804-5': { name: 'WBC', unit: '10*3/uL', typicalRange: { low: 4.0, high: 11.0 }, altUnit: '10*9/L', altRange: { low: 4.0, high: 11.0 }, specimenType: 'blood' },
      // Platelet Count
      '777-3': { name: 'Platelets', unit: '10*3/uL', typicalRange: { low: 150, high: 450 }, altUnit: '10*9/L', altRange: { low: 150, high: 450 }, specimenType: 'blood' },
      '26515-7': { name: 'Platelets', unit: '10*3/uL', typicalRange: { low: 150, high: 450 }, altUnit: '10*9/L', altRange: { low: 150, high: 450 }, specimenType: 'blood' },
      // Total Cholesterol
      '2093-3': { name: 'Total Cholesterol', unit: 'mg/dL', typicalRange: { low: 0, high: 200 }, altUnit: 'mmol/L', altRange: { low: 0, high: 5.2 }, requiresFasting: true, specimenType: 'blood' },
      // LDL Cholesterol
      '2089-1': { name: 'LDL Cholesterol', unit: 'mg/dL', typicalRange: { low: 0, high: 100 }, altUnit: 'mmol/L', altRange: { low: 0, high: 2.6 }, requiresFasting: true, specimenType: 'blood' },
      // HDL Cholesterol
      '2085-9': { name: 'HDL Cholesterol', unit: 'mg/dL', typicalRange: { low: 40, high: 60 }, altUnit: 'mmol/L', altRange: { low: 1.0, high: 1.6 }, requiresFasting: true, specimenType: 'blood' },
      // Triglycerides
      '2571-8': { name: 'Triglycerides', unit: 'mg/dL', typicalRange: { low: 0, high: 150 }, altUnit: 'mmol/L', altRange: { low: 0, high: 1.7 }, requiresFasting: true, specimenType: 'blood' },
      // ALT (Alanine Aminotransferase)
      '1742-6': { name: 'ALT', unit: 'U/L', typicalRange: { low: 7, high: 56 }, specimenType: 'blood' },
      '1743-4': { name: 'ALT', unit: 'U/L', typicalRange: { low: 7, high: 56 }, specimenType: 'blood' },
      // AST (Aspartate Aminotransferase)
      '1920-8': { name: 'AST', unit: 'U/L', typicalRange: { low: 10, high: 40 }, specimenType: 'blood' },
      '30239-8': { name: 'AST', unit: 'U/L', typicalRange: { low: 10, high: 40 }, specimenType: 'blood' },
      // TSH (Thyroid Stimulating Hormone)
      '3016-3': { name: 'TSH', unit: 'mIU/L', typicalRange: { low: 0.4, high: 4.0 }, specimenType: 'blood' },
      '11579-0': { name: 'TSH', unit: 'mIU/L', typicalRange: { low: 0.4, high: 4.0 }, specimenType: 'blood' },
      // Sodium
      '2951-2': { name: 'Sodium', unit: 'mEq/L', typicalRange: { low: 136, high: 145 }, altUnit: 'mmol/L', altRange: { low: 136, high: 145 }, specimenType: 'blood' },
      '2955-3': { name: 'Sodium', unit: 'mEq/L', typicalRange: { low: 136, high: 145 }, altUnit: 'mmol/L', altRange: { low: 136, high: 145 }, specimenType: 'blood' },
      // Potassium
      '2823-3': { name: 'Potassium', unit: 'mEq/L', typicalRange: { low: 3.5, high: 5.0 }, altUnit: 'mmol/L', altRange: { low: 3.5, high: 5.0 }, specimenType: 'blood' },
      '6298-4': { name: 'Potassium', unit: 'mEq/L', typicalRange: { low: 3.5, high: 5.0 }, altUnit: 'mmol/L', altRange: { low: 3.5, high: 5.0 }, specimenType: 'blood' },
      // BUN (Blood Urea Nitrogen)
      '3094-0': { name: 'BUN', unit: 'mg/dL', typicalRange: { low: 7, high: 20 }, altUnit: 'mmol/L', altRange: { low: 2.5, high: 7.1 }, specimenType: 'blood' },
      '3093-2': { name: 'BUN', unit: 'mg/dL', typicalRange: { low: 7, high: 20 }, altUnit: 'mmol/L', altRange: { low: 2.5, high: 7.1 }, specimenType: 'blood' },
      // eGFR
      '33914-3': { name: 'eGFR', unit: 'mL/min/1.73m2', typicalRange: { low: 60, high: 120 }, specimenType: 'calculated' },
      '62238-1': { name: 'eGFR', unit: 'mL/min/1.73m2', typicalRange: { low: 60, high: 120 }, specimenType: 'calculated' },
      // Additional common laboratory parameters
      '1751-7': { name: 'Albumin', unit: 'g/dL', typicalRange: { low: 3.5, high: 5.0 }, altUnit: 'g/L', altRange: { low: 35, high: 50 }, specimenType: 'blood' },
      '1975-2': { name: 'Bilirubin Total', unit: 'mg/dL', typicalRange: { low: 0.2, high: 1.2 }, altUnit: 'μmol/L', altRange: { low: 3.4, high: 20.5 }, specimenType: 'blood' },
      '1978-6': { name: 'Bilirubin Direct', unit: 'mg/dL', typicalRange: { low: 0.0, high: 0.3 }, altUnit: 'μmol/L', altRange: { low: 0, high: 5.1 }, specimenType: 'blood' },
      '2324-2': { name: 'GGT', unit: 'U/L', typicalRange: { low: 8, high: 61 }, specimenType: 'blood' },
      '2325-9': { name: 'LDH', unit: 'U/L', typicalRange: { low: 140, high: 280 }, specimenType: 'blood' },
      '2532-0': { name: 'Alkaline Phosphatase', unit: 'U/L', typicalRange: { low: 44, high: 147 }, specimenType: 'blood' },
      '26449-9': { name: 'Troponin I', unit: 'ng/mL', typicalRange: { low: 0, high: 0.04 }, specimenType: 'blood' },
      '6598-7': { name: 'Troponin T', unit: 'ng/mL', typicalRange: { low: 0, high: 0.01 }, specimenType: 'blood' },
      '33747-7': { name: 'BNP', unit: 'pg/mL', typicalRange: { low: 0, high: 100 }, specimenType: 'blood' },
      '33748-5': { name: 'NT-proBNP', unit: 'pg/mL', typicalRange: { low: 0, high: 125 }, specimenType: 'blood' },
      '26450-7': { name: 'CRP', unit: 'mg/L', typicalRange: { low: 0, high: 3.0 }, specimenType: 'blood' },
      '33914-6': { name: 'Procalcitonin', unit: 'ng/mL', typicalRange: { low: 0, high: 0.1 }, specimenType: 'blood' },
      '26499-4': { name: 'Ferritin', unit: 'ng/mL', typicalRange: { low: 15, high: 200 }, specimenType: 'blood' },
      '2500-7': { name: 'Iron', unit: 'μg/dL', typicalRange: { low: 65, high: 175 }, altUnit: 'μmol/L', altRange: { low: 11.6, high: 31.3 }, specimenType: 'blood' },
      '2501-5': { name: 'TIBC', unit: 'μg/dL', typicalRange: { low: 250, high: 450 }, altUnit: 'μmol/L', altRange: { low: 44.8, high: 80.6 }, specimenType: 'blood' },
      '3026-2': { name: 'Free T4', unit: 'ng/dL', typicalRange: { low: 0.8, high: 1.8 }, altUnit: 'pmol/L', altRange: { low: 10.3, high: 23.2 }, specimenType: 'blood' },
      '3018-9': { name: 'Free T3', unit: 'pg/mL', typicalRange: { low: 2.3, high: 4.2 }, altUnit: 'pmol/L', altRange: { low: 3.5, high: 6.5 }, specimenType: 'blood' },
      '1759-0': { name: 'Calcium', unit: 'mg/dL', typicalRange: { low: 8.5, high: 10.5 }, altUnit: 'mmol/L', altRange: { low: 2.1, high: 2.6 }, specimenType: 'blood' },
      '17861-6': { name: 'Calcium Ionized', unit: 'mg/dL', typicalRange: { low: 4.5, high: 5.3 }, altUnit: 'mmol/L', altRange: { low: 1.12, high: 1.32 }, specimenType: 'blood' },
      '2777-1': { name: 'Phosphorus', unit: 'mg/dL', typicalRange: { low: 2.5, high: 4.5 }, altUnit: 'mmol/L', altRange: { low: 0.81, high: 1.45 }, specimenType: 'blood' },
      '2594-1': { name: 'Magnesium', unit: 'mg/dL', typicalRange: { low: 1.7, high: 2.2 }, altUnit: 'mmol/L', altRange: { low: 0.7, high: 0.91 }, specimenType: 'blood' },
      '48642-3': { name: 'eGFR African American', unit: 'mL/min/1.73m2', typicalRange: { low: 60, high: 120 }, specimenType: 'calculated' },
      '48643-1': { name: 'eGFR Non-African American', unit: 'mL/min/1.73m2', typicalRange: { low: 60, high: 120 }, specimenType: 'calculated' },
      // Additional comprehensive laboratory parameters
      // Coagulation Panel
      '5902-5': { name: 'Prothrombin Time', unit: 'sec', typicalRange: { low: 11, high: 13.5 }, specimenType: 'blood' },
      '5902-3': { name: 'PT INR', unit: 'ratio', typicalRange: { low: 0.9, high: 1.1 }, specimenType: 'blood' },
      '3255-7': { name: 'Fibrinogen', unit: 'mg/dL', typicalRange: { low: 200, high: 400 }, altUnit: 'g/L', altRange: { low: 2.0, high: 4.0 }, specimenType: 'blood' },
      '3377-1': { name: 'APTT', unit: 'sec', typicalRange: { low: 25, high: 35 }, specimenType: 'blood' },
      '3173-2': { name: 'D-Dimer', unit: 'μg/mL', typicalRange: { low: 0, high: 0.5 }, altUnit: 'mg/L', altRange: { low: 0, high: 0.5 }, specimenType: 'blood' },
      // Complete Blood Count (CBC) Extended
      '789-8': { name: 'Erythrocytes', unit: '10*6/uL', typicalRange: { low: 4.2, high: 5.4 }, altUnit: '10*12/L', altRange: { low: 4.2, high: 5.4 }, specimenType: 'blood' },
      '785-6': { name: 'MCV', unit: 'fL', typicalRange: { low: 80, high: 100 }, specimenType: 'blood' },
      '786-4': { name: 'MCH', unit: 'pg', typicalRange: { low: 27, high: 31 }, specimenType: 'blood' },
      '787-2': { name: 'MCHC', unit: 'g/dL', typicalRange: { low: 33, high: 37 }, altUnit: 'g/L', altRange: { low: 330, high: 370 }, specimenType: 'blood' },
      '770-8': { name: 'RDW', unit: '%', typicalRange: { low: 11.5, high: 14.5 }, specimenType: 'blood' },
      '770-3': { name: 'MPV', unit: 'fL', typicalRange: { low: 7.5, high: 11.5 }, specimenType: 'blood' },
      // Differential White Blood Cell Count
      '770-4': { name: 'Neutrophils %', unit: '%', typicalRange: { low: 40, high: 60 }, specimenType: 'blood' },
      '770-5': { name: 'Lymphocytes %', unit: '%', typicalRange: { low: 20, high: 40 }, specimenType: 'blood' },
      '770-6': { name: 'Monocytes %', unit: '%', typicalRange: { low: 2, high: 8 }, specimenType: 'blood' },
      '770-7': { name: 'Eosinophils %', unit: '%', typicalRange: { low: 1, high: 4 }, specimenType: 'blood' },
      '704-8': { name: 'Basophils %', unit: '%', typicalRange: { low: 0, high: 1 }, specimenType: 'blood' },
      '751-8': { name: 'Neutrophils Absolute', unit: '10*3/uL', typicalRange: { low: 1.8, high: 7.7 }, altUnit: '10*9/L', altRange: { low: 1.8, high: 7.7 }, specimenType: 'blood' },
      '731-0': { name: 'Lymphocytes Absolute', unit: '10*3/uL', typicalRange: { low: 1.0, high: 4.8 }, altUnit: '10*9/L', altRange: { low: 1.0, high: 4.8 }, specimenType: 'blood' },
      '742-7': { name: 'Monocytes Absolute', unit: '10*3/uL', typicalRange: { low: 0.1, high: 0.8 }, altUnit: '10*9/L', altRange: { low: 0.1, high: 0.8 }, specimenType: 'blood' },
      '711-2': { name: 'Eosinophils Absolute', unit: '10*3/uL', typicalRange: { low: 0.0, high: 0.5 }, altUnit: '10*9/L', altRange: { low: 0.0, high: 0.5 }, specimenType: 'blood' },
      '704-7': { name: 'Basophils Absolute', unit: '10*3/uL', typicalRange: { low: 0.0, high: 0.2 }, altUnit: '10*9/L', altRange: { low: 0.0, high: 0.2 }, specimenType: 'blood' },
      // Liver Function Tests Extended (duplicates removed - already defined above)
      '2885-2': { name: 'Total Protein', unit: 'g/dL', typicalRange: { low: 6.0, high: 8.3 }, altUnit: 'g/L', altRange: { low: 60, high: 83 }, specimenType: 'blood' },
      '2085-7': { name: 'Globulin', unit: 'g/dL', typicalRange: { low: 2.0, high: 3.5 }, altUnit: 'g/L', altRange: { low: 20, high: 35 }, specimenType: 'blood' },
      '1757-7': { name: 'A/G Ratio', unit: 'ratio', typicalRange: { low: 1.0, high: 2.5 }, specimenType: 'blood' },
      // Cardiac Markers (duplicates removed - already defined above)
      '10839-9': { name: 'CK-MB', unit: 'ng/mL', typicalRange: { low: 0, high: 5 }, specimenType: 'blood' },
      '2157-6': { name: 'CK Total', unit: 'U/L', typicalRange: { low: 30, high: 200 }, specimenType: 'blood' },
      '2325-8': { name: 'Myoglobin', unit: 'ng/mL', typicalRange: { low: 25, high: 72 }, specimenType: 'blood' },
      // Inflammatory Markers (CRP and Procalcitonin already defined above)
      '30522-7': { name: 'CRP High Sensitivity', unit: 'mg/L', typicalRange: { low: 0, high: 3.0 }, specimenType: 'blood' },
      '7138-1': { name: 'ESR', unit: 'mm/hr', typicalRange: { low: 0, high: 20 }, specimenType: 'blood' },
      // Thyroid Function Extended (TSH, Free T4, Free T3 already defined above)
      '11580-8': { name: 'Total T4', unit: 'μg/dL', typicalRange: { low: 4.5, high: 11.2 }, altUnit: 'nmol/L', altRange: { low: 58, high: 144 }, specimenType: 'blood' },
      '11579-4': { name: 'Total T3', unit: 'ng/dL', typicalRange: { low: 70, high: 200 }, altUnit: 'nmol/L', altRange: { low: 1.1, high: 3.1 }, specimenType: 'blood' },
      '9317-9': { name: 'Reverse T3', unit: 'ng/dL', typicalRange: { low: 10, high: 24 }, altUnit: 'nmol/L', altRange: { low: 0.15, high: 0.37 }, specimenType: 'blood' },
      '14937-7': { name: 'Thyroglobulin', unit: 'ng/mL', typicalRange: { low: 1.4, high: 29.2 }, specimenType: 'blood' },
      '14936-9': { name: 'Anti-TPO', unit: 'IU/mL', typicalRange: { low: 0, high: 9 }, specimenType: 'blood' },
      '14935-1': { name: 'Anti-Tg', unit: 'IU/mL', typicalRange: { low: 0, high: 4 }, specimenType: 'blood' },
      // Iron Studies Extended (Iron, TIBC, and Ferritin already defined above)
      '2498-4': { name: 'Transferrin Saturation', unit: '%', typicalRange: { low: 20, high: 50 }, specimenType: 'blood' },
      '3034-6': { name: 'Transferrin', unit: 'mg/dL', typicalRange: { low: 200, high: 400 }, altUnit: 'g/L', altRange: { low: 2.0, high: 4.0 }, specimenType: 'blood' },
      // Vitamin Levels
      '14636-0': { name: 'Vitamin D 25-OH', unit: 'ng/mL', typicalRange: { low: 30, high: 100 }, altUnit: 'nmol/L', altRange: { low: 75, high: 250 }, specimenType: 'blood' },
      '14637-8': { name: 'Vitamin D 1,25-OH', unit: 'pg/mL', typicalRange: { low: 20, high: 60 }, altUnit: 'pmol/L', altRange: { low: 48, high: 144 }, specimenType: 'blood' },
      '14927-2': { name: 'Vitamin B12', unit: 'pg/mL', typicalRange: { low: 200, high: 900 }, altUnit: 'pmol/L', altRange: { low: 148, high: 664 }, specimenType: 'blood' },
      '2069-3': { name: 'Folate', unit: 'ng/mL', typicalRange: { low: 3.0, high: 17.0 }, altUnit: 'nmol/L', altRange: { low: 6.8, high: 38.5 }, specimenType: 'blood' },
      '2284-8': { name: 'Folic Acid', unit: 'ng/mL', typicalRange: { low: 3.0, high: 17.0 }, altUnit: 'nmol/L', altRange: { low: 6.8, high: 38.5 }, specimenType: 'blood' },
      // Hormones
      '1754-1': { name: 'Cortisol', unit: 'μg/dL', typicalRange: { low: 5, high: 25 }, altUnit: 'nmol/L', altRange: { low: 138, high: 690 }, specimenType: 'blood' },
      '1753-3': { name: 'Cortisol AM', unit: 'μg/dL', typicalRange: { low: 10, high: 20 }, altUnit: 'nmol/L', altRange: { low: 276, high: 552 }, specimenType: 'blood' },
      '1752-5': { name: 'Cortisol PM', unit: 'μg/dL', typicalRange: { low: 3, high: 13 }, altUnit: 'nmol/L', altRange: { low: 83, high: 359 }, specimenType: 'blood' },
      '32016-8': { name: 'ACTH', unit: 'pg/mL', typicalRange: { low: 10, high: 60 }, altUnit: 'pmol/L', altRange: { low: 2.2, high: 13.2 }, specimenType: 'blood' },
      '2986-8': { name: 'Testosterone', unit: 'ng/dL', typicalRange: { low: 300, high: 1000 }, altUnit: 'nmol/L', altRange: { low: 10.4, high: 34.7 }, specimenType: 'blood' },
      '2985-0': { name: 'Free Testosterone', unit: 'pg/mL', typicalRange: { low: 9.3, high: 26.5 }, altUnit: 'pmol/L', altRange: { low: 32.2, high: 92.0 }, specimenType: 'blood' },
      '2013-3': { name: 'Estradiol', unit: 'pg/mL', typicalRange: { low: 30, high: 400 }, altUnit: 'pmol/L', altRange: { low: 110, high: 1468 }, specimenType: 'blood' },
      '3374-8': { name: 'Progesterone', unit: 'ng/mL', typicalRange: { low: 0.1, high: 20 }, altUnit: 'nmol/L', altRange: { low: 0.3, high: 63.6 }, specimenType: 'blood' },
      '2276-4': { name: 'Prolactin', unit: 'ng/mL', typicalRange: { low: 2, high: 18 }, altUnit: 'μg/L', altRange: { low: 2, high: 18 }, specimenType: 'blood' },
      '2275-6': { name: 'FSH', unit: 'mIU/mL', typicalRange: { low: 1.5, high: 12.4 }, specimenType: 'blood' },
      '2274-9': { name: 'LH', unit: 'mIU/mL', typicalRange: { low: 1.7, high: 8.6 }, specimenType: 'blood' },
      '14927-0': { name: 'DHEA-S', unit: 'μg/dL', typicalRange: { low: 80, high: 560 }, altUnit: 'μmol/L', altRange: { low: 2.2, high: 15.2 }, specimenType: 'blood' },
      '14927-1': { name: 'IGF-1', unit: 'ng/mL', typicalRange: { low: 100, high: 300 }, altUnit: 'nmol/L', altRange: { low: 13, high: 39 }, specimenType: 'blood' },
      // Tumor Markers
      '2857-1': { name: 'PSA', unit: 'ng/mL', typicalRange: { low: 0, high: 4.0 }, specimenType: 'blood' },
      '2858-9': { name: 'Free PSA', unit: 'ng/mL', typicalRange: { low: 0, high: 1.0 }, specimenType: 'blood' },
      '1975-9': { name: 'CEA', unit: 'ng/mL', typicalRange: { low: 0, high: 3.0 }, specimenType: 'blood' },
      '1975-3': { name: 'CA 19-9', unit: 'U/mL', typicalRange: { low: 0, high: 37 }, specimenType: 'blood' },
      '1975-4': { name: 'CA 125', unit: 'U/mL', typicalRange: { low: 0, high: 35 }, specimenType: 'blood' },
      '1975-5': { name: 'CA 15-3', unit: 'U/mL', typicalRange: { low: 0, high: 30 }, specimenType: 'blood' },
      '1975-6': { name: 'AFP', unit: 'ng/mL', typicalRange: { low: 0, high: 10 }, specimenType: 'blood' },
      // Urine Tests (Creatinine Urine already defined above)
      '2888-6': { name: 'Protein Urine', unit: 'mg/dL', typicalRange: { low: 0, high: 8 }, specimenType: 'urine' },
      '1754-2': { name: 'Albumin Urine', unit: 'mg/dL', typicalRange: { low: 0, high: 30 }, specimenType: 'urine' },
      '14959-1': { name: 'Microalbumin Urine', unit: 'mg/L', typicalRange: { low: 0, high: 30 }, specimenType: 'urine' },
      '25428-4': { name: 'Glucose Urine', unit: 'mg/dL', typicalRange: { low: 0, high: 0 }, specimenType: 'urine' },
      '2514-8': { name: 'Ketones Urine', unit: 'mg/dL', typicalRange: { low: 0, high: 0 }, specimenType: 'urine' },
      '1975-7': { name: 'Bilirubin Urine', unit: 'mg/dL', typicalRange: { low: 0, high: 0 }, specimenType: 'urine' },
      '20405-6': { name: 'Urobilinogen Urine', unit: 'mg/dL', typicalRange: { low: 0.1, high: 1.0 }, specimenType: 'urine' },
      '5802-4': { name: 'Nitrite Urine', unit: 'neg/pos', typicalRange: { low: 0, high: 0 }, specimenType: 'urine' },
      '5799-2': { name: 'Leukocyte Esterase Urine', unit: 'neg/pos', typicalRange: { low: 0, high: 0 }, specimenType: 'urine' },
      '5794-3': { name: 'Blood Urine', unit: 'RBC/uL', typicalRange: { low: 0, high: 3 }, specimenType: 'urine' },
      '5803-2': { name: 'pH Urine', unit: 'pH', typicalRange: { low: 5.0, high: 8.0 }, specimenType: 'urine' },
      '5811-5': { name: 'Specific Gravity Urine', unit: 'ratio', typicalRange: { low: 1.005, high: 1.030 }, specimenType: 'urine' },
      // Additional Metabolic Tests
      '3084-1': { name: 'Uric Acid', unit: 'mg/dL', typicalRange: { low: 3.5, high: 7.2 }, altUnit: 'μmol/L', altRange: { low: 208, high: 428 }, specimenType: 'blood' },
      '2523-0': { name: 'Lactate', unit: 'mmol/L', typicalRange: { low: 0.5, high: 2.2 }, specimenType: 'blood' },
      '33914-4': { name: 'Ammonia', unit: 'μg/dL', typicalRange: { low: 15, high: 45 }, altUnit: 'μmol/L', altRange: { low: 11, high: 32 }, specimenType: 'blood' },
      '33914-5': { name: 'Osmolality', unit: 'mOsm/kg', typicalRange: { low: 275, high: 295 }, specimenType: 'blood' },
      // Lipid Panel Extended (Total Cholesterol, LDL, HDL, Triglycerides already defined above)
      '2089-2': { name: 'Non-HDL Cholesterol', unit: 'mg/dL', typicalRange: { low: 0, high: 130 }, altUnit: 'mmol/L', altRange: { low: 0, high: 3.4 }, requiresFasting: true, specimenType: 'blood' },
      '2089-3': { name: 'Cholesterol/HDL Ratio', unit: 'ratio', typicalRange: { low: 0, high: 5.0 }, requiresFasting: true, specimenType: 'blood' },
      // Additional Electrolytes (Sodium, Potassium, Calcium, Calcium Ionized, Phosphorus, Magnesium already defined above)
      '2075-0': { name: 'Chloride', unit: 'mEq/L', typicalRange: { low: 98, high: 107 }, altUnit: 'mmol/L', altRange: { low: 98, high: 107 }, specimenType: 'blood' },
      '2028-9': { name: 'CO2', unit: 'mEq/L', typicalRange: { low: 22, high: 28 }, altUnit: 'mmol/L', altRange: { low: 22, high: 28 }, specimenType: 'blood' },
      '2026-4': { name: 'Bicarbonate', unit: 'mEq/L', typicalRange: { low: 22, high: 28 }, altUnit: 'mmol/L', altRange: { low: 22, high: 28 }, specimenType: 'blood' },
      '33037-3': { name: 'Anion Gap', unit: 'mEq/L', typicalRange: { low: 8, high: 12 }, altUnit: 'mmol/L', altRange: { low: 8, high: 12 }, specimenType: 'calculated' }
    };

    return labParameters[loincCode] || null;
  }

  private validateLaboratoryParameter(observation: any, param: any, location: string): CheckIssue[] {
    const issues: CheckIssue[] = [];

    if (!observation.valueQuantity) {
      return issues;
    }

    const value = observation.valueQuantity.value;
    const unit = observation.valueQuantity.unit || observation.valueQuantity.code || '';

    // Check if value is within typical range
    const isInRange = this.isValueInRange(value, unit, param);
    if (!isInRange && value !== null && value !== undefined) {
      issues.push({
        severity: 'warn',
        label: `Unusual ${param.name} value`,
        detail: `Value ${value} ${unit} is outside typical range (${param.typicalRange.low}-${param.typicalRange.high} ${param.unit}). Verify clinical significance.`,
        location
      });
    }

    // Check for critical values
    if (this.isCriticalValue(value, param)) {
      issues.push({
        severity: 'error',
        label: `Critical ${param.name} value`,
        detail: `Value ${value} ${unit} is in critical range. Immediate clinical review required.`,
        location
      });
    }

    return issues;
  }

  private isValueInRange(value: number, unit: string, param: any): boolean {
    if (value === null || value === undefined) {
      return true;
    }

    let range = param.typicalRange;
    if (param.altUnit && unit.includes(param.altUnit)) {
      range = param.altRange;
    }

    return value >= range.low && value <= range.high;
  }

  private isCriticalValue(value: number, param: any): boolean {
    if (value === null || value === undefined) {
      return false;
    }

    // Define critical ranges for common parameters (life-threatening values requiring immediate attention)
    const criticalRanges: { [key: string]: { low?: number; high?: number } } = {
      // Metabolic/Cardiac Critical
      'Glucose': { low: 40, high: 400 },
      'Glucose Fasting': { low: 40, high: 400 },
      'Glucose 2h Post Meal': { low: 40, high: 500 },
      'Potassium': { low: 2.5, high: 6.5 },
      'Sodium': { low: 120, high: 160 },
      'Calcium': { low: 6.5, high: 13.0 },
      'Calcium Ionized': { low: 3.5, high: 6.5 },
      'Magnesium': { low: 1.0, high: 4.0 },
      'Phosphorus': { low: 1.0, high: 8.0 },
      'Chloride': { low: 80, high: 115 },
      'CO2': { low: 10, high: 40 },
      'Bicarbonate': { low: 10, high: 40 },
      // Renal Critical
      'Creatinine': { high: 5.0 },
      'BUN': { high: 100 },
      'eGFR': { low: 15 },
      // Hematology Critical
      'Hemoglobin': { low: 7.0 },
      'Hematocrit': { low: 21.0 },
      'Platelets': { low: 20 },
      'WBC': { low: 1.0, high: 50.0 },
      // Cardiac Markers Critical
      'Troponin I': { high: 0.5 },
      'Troponin T': { high: 0.1 },
      'BNP': { high: 1000 },
      'NT-proBNP': { high: 2000 },
      'CK-MB': { high: 25 },
      'Myoglobin': { high: 500 },
      // Liver Function Critical
      'Bilirubin Total': { high: 20.0 },
      'Bilirubin Direct': { high: 5.0 },
      'ALT': { high: 500 },
      'AST': { high: 500 },
      'LDH': { high: 1000 },
      'GGT': { high: 300 },
      'Alkaline Phosphatase': { high: 500 },
      'Albumin': { low: 2.0, high: 6.0 },
      'Total Protein': { low: 4.0, high: 10.0 },
      // Inflammatory Critical
      'CRP': { high: 100 },
      'Procalcitonin': { high: 2.0 },
      'ESR': { high: 100 },
      // Thyroid Critical
      'TSH': { low: 0.01, high: 50 },
      'Free T4': { low: 0.3, high: 4.0 },
      'Free T3': { low: 0.5, high: 10.0 },
      // Iron/Vitamin Critical
      'Iron': { low: 20, high: 300 },
      'Ferritin': { low: 5, high: 1000 },
      'Vitamin D 25-OH': { low: 10, high: 150 },
      'Vitamin B12': { low: 100, high: 2000 },
      // Hormone Critical
      'Cortisol': { low: 2, high: 50 },
      'Testosterone': { low: 100, high: 1500 },
      'ACTH': { low: 5, high: 200 },
      // Tumor Markers Critical
      'PSA': { high: 10 },
      'CEA': { high: 10 },
      'AFP': { high: 400 },
      // Metabolic Critical
      'Uric Acid': { high: 12 },
      'Lactate': { high: 5.0 },
      'Ammonia': { high: 100 },
      'Osmolality': { low: 250, high: 320 },
      // Coagulation Critical
      'PT INR': { high: 5.0 },
      'APTT': { high: 100 },
      'D-Dimer': { high: 5.0 },
      'Fibrinogen': { low: 100, high: 600 }
    };

    const critical = criticalRanges[param.name];
    if (!critical) {
      return false;
    }

    if (critical.low !== undefined && value < critical.low) {
      return true;
    }
    if (critical.high !== undefined && value > critical.high) {
      return true;
    }

    return false;
  }

  private validateUCUMUnit(quantity: any, location: string): CheckIssue[] {
    const issues: CheckIssue[] = [];

    if (!quantity.unit && !quantity.code) {
      issues.push({
        severity: 'warn',
        label: 'Missing unit',
        detail: 'Laboratory values should include units (preferably UCUM format).',
        location
      });
      return issues;
    }

    const unit = quantity.unit || quantity.code || '';
    const system = quantity.system || '';

    // Check if UCUM system is used
    if (system && !system.includes('unitsofmeasure.org')) {
      issues.push({
        severity: 'warn',
        label: 'Non-UCUM unit system',
        detail: 'Laboratory values should use UCUM units (http://unitsofmeasure.org) for interoperability.',
        location
      });
    }

    // Validate common UCUM unit formats
    const validUCUMPatterns = [
      /^g\/dL$/i,
      /^mg\/dL$/i,
      /^mmol\/L$/i,
      /^mEq\/L$/i,
      /^U\/L$/i,
      /^10\*3\/uL$/i,
      /^10\*9\/L$/i,
      /^%$/,
      /^mL\/min\/1\.73m2$/i
    ];

    if (unit && !validUCUMPatterns.some((pattern) => pattern.test(unit)) && !system.includes('unitsofmeasure.org')) {
      issues.push({
        severity: 'warn',
        label: 'Non-standard unit format',
        detail: `Unit "${unit}" may not be in standard UCUM format. Verify unit correctness.`,
        location
      });
    }

    return issues;
  }

  private validateLaboratoryReferenceRange(ranges: any[], param: any, location: string): CheckIssue[] {
    const issues: CheckIssue[] = [];

    if (!param || ranges.length === 0) {
      return issues;
    }

    ranges.forEach((range: any, index: number) => {
      const rangeLocation = `${location} · referenceRange[${index}]`;

      if (range.low && range.high) {
        const lowValue = this.extractQuantityValue(range.low);
        const highValue = this.extractQuantityValue(range.high);
        const unit = range.low.unit || range.low.code || '';

        if (lowValue !== null && highValue !== null) {
          // Check if reference range is reasonable for the parameter
          const expectedRange = param.altUnit && unit.includes(param.altUnit) ? param.altRange : param.typicalRange;
          const rangeDiff = highValue - lowValue;
          const expectedDiff = expectedRange.high - expectedRange.low;

          // Warn if range is significantly different from typical
          if (Math.abs(rangeDiff - expectedDiff) > expectedDiff * 0.5) {
            issues.push({
              severity: 'warn',
              label: 'Unusual reference range',
              detail: `Reference range (${lowValue}-${highValue} ${unit}) differs significantly from typical range for ${param.name}.`,
              location: rangeLocation
            });
          }

          // Check if range is inverted
          if (lowValue > highValue) {
            issues.push({
              severity: 'error',
              label: 'Inverted reference range',
              detail: 'Reference range low value is greater than high value.',
              location: rangeLocation
            });
          }
        }
      }
    });

    return issues;
  }

  private validateLaboratorySpecimen(specimen: any, loincCode: string | null, location: string): CheckIssue[] {
    const issues: CheckIssue[] = [];
    const param = loincCode ? this.getLaboratoryParameter(loincCode) : null;

    if (!specimen.reference && !specimen.concept) {
      issues.push({
        severity: 'warn',
        label: 'Incomplete specimen',
        detail: 'Specimen should have either reference or concept.',
        location
      });
      return issues;
    }

    if (param?.specimenType && specimen.concept) {
      const specimenCodings = specimen.concept?.coding || [];
      const hasMatchingType = specimenCodings.some((coding: any) => {
        const code = coding?.code?.toLowerCase() || '';
        const system = coding?.system || '';
        const expectedType = param.specimenType.toLowerCase();

        if (system.includes('snomed') || system.includes('loinc')) {
          return code.includes(expectedType) || 
                 (expectedType === 'blood' && (code.includes('serum') || code.includes('plasma') || code.includes('whole'))) ||
                 (expectedType === 'urine' && code.includes('urine'));
        }
        return false;
      });

      if (!hasMatchingType) {
        issues.push({
          severity: 'warn',
          label: 'Specimen type mismatch',
          detail: `Expected ${param.specimenType} specimen for ${param.name}, but different type may be specified.`,
          location
        });
      }
    }

    return issues;
  }

  private validateLaboratoryPanel(observation: any, location: string): CheckIssue[] {
    const issues: CheckIssue[] = [];

    if (observation.organizer === true) {
      if (!observation.hasMember || observation.hasMember.length === 0) {
        issues.push({
          severity: 'error',
          label: 'Panel without members',
          detail: 'Observation with organizer=true must have hasMember references to panel components.',
          location
        });
      }

      if (observation.valueQuantity || observation.valueCodeableConcept || observation.valueString) {
        issues.push({
          severity: 'error',
          label: 'Panel with value',
          detail: 'Panel observations (organizer=true) should not have value[x] - use hasMember for components.',
          location
        });
      }
    }

    if (observation.hasMember && observation.hasMember.length > 0) {
      const memberCount = observation.hasMember.length;
      if (memberCount < 2) {
        issues.push({
          severity: 'warn',
          label: 'Panel with single member',
          detail: 'Laboratory panels typically contain multiple test results. Consider using a single Observation if only one test.',
          location
        });
      }

      observation.hasMember.forEach((member: any, index: number) => {
        const memberLocation = `${location} · hasMember[${index}]`;
        if (!member?.reference) {
          issues.push({
            severity: 'error',
            label: 'Invalid panel member',
            detail: 'hasMember must reference an Observation resource for panel components.',
            location: memberLocation
          });
        } else if (!member.reference.includes('Observation/')) {
          issues.push({
            severity: 'error',
            label: 'Non-observation panel member',
            detail: 'Laboratory panel members must reference Observation resources.',
            location: memberLocation
          });
        }
      });
    }

    return issues;
  }

  private validateReflexTest(observation: any, location: string): CheckIssue[] {
    const issues: CheckIssue[] = [];

    observation.triggeredBy.forEach((trigger: any, index: number) => {
      const triggerLocation = `${location} · triggeredBy[${index}]`;
      
      if (trigger.type === 'reflex') {
        if (!trigger.observation?.reference) {
          issues.push({
            severity: 'error',
            label: 'Invalid reflex trigger',
            detail: 'Reflex tests must reference the triggering observation.',
            location: triggerLocation
          });
        }

        if (!trigger.reason) {
          issues.push({
            severity: 'warn',
            label: 'Missing reflex reason',
            detail: 'Reflex tests should include reason explaining why the test was triggered.',
            location: triggerLocation
          });
        }

        // Reflex tests should typically have status 'final' or 'preliminary'
        if (observation.status && !['final', 'preliminary', 'corrected', 'amended'].includes(observation.status)) {
          issues.push({
            severity: 'warn',
            label: 'Unusual reflex test status',
            detail: 'Reflex tests typically have status: final, preliminary, corrected, or amended.',
            location
          });
        }
      }
    });

    return issues;
  }

  private validateDeltaCheck(observation: any, location: string): CheckIssue[] {
    const issues: CheckIssue[] = [];

    if (observation.derivedFrom && observation.derivedFrom.length >= 2) {
      // Delta check - comparing two previous observations
      const allAreObservations = observation.derivedFrom.every((derived: any) => 
        derived?.reference?.includes('Observation/')
      );

      if (!allAreObservations) {
        issues.push({
          severity: 'warn',
          label: 'Delta check with non-observation',
          detail: 'Delta checks should reference previous Observation resources for comparison.',
          location
        });
      }

      if (observation.interpretation && observation.interpretation.length > 0) {
        const hasDeltaInterpretation = observation.interpretation.some((interp: any) => {
          const codings = interp?.coding || [];
          return codings.some((coding: any) => {
            const code = coding?.code?.toLowerCase() || '';
            return code.includes('increase') || code.includes('decrease') || 
                   code.includes('delta') || code.includes('change');
          });
        });

        if (!hasDeltaInterpretation) {
          issues.push({
            severity: 'warn',
            label: 'Delta check without interpretation',
            detail: 'Delta check observations should include interpretation indicating the change (increase/decrease).',
            location
          });
        }
      }
    }

    return issues;
  }

  private validateLaboratoryMethod(method: any, loincCode: string | null, location: string): CheckIssue[] {
    const issues: CheckIssue[] = [];

    if (!this.hasCode(method)) {
      issues.push({
        severity: 'warn',
        label: 'Invalid method code',
        detail: 'Laboratory method should be a CodeableConcept with coding.',
        location
      });
      return issues;
    }

    const methodSystem = this.getCodeSystem(method);
    if (methodSystem && !methodSystem.includes('snomed.info')) {
      issues.push({
        severity: 'warn',
        label: 'Non-SNOMED method',
        detail: 'Laboratory methods should use SNOMED CT codes (Technique, Action, or Evaluation procedure).',
        location
      });
    }

    return issues;
  }

  private validateLaboratoryTiming(observation: any, loincCode: string | null, location: string): CheckIssue[] {
    const issues: CheckIssue[] = [];
    const param = loincCode ? this.getLaboratoryParameter(loincCode) : null;

    if (!param) {
      return issues;
    }

    // Check for fasting requirements
    if (param.requiresFasting) {
      const codeText = observation.code?.text?.toLowerCase() || '';
      const codeDisplay = observation.code?.coding?.[0]?.display?.toLowerCase() || '';
      const noteText = Array.isArray(observation.note) 
        ? observation.note.map((n: any) => n?.text?.toLowerCase() || '').join(' ')
        : '';

      const hasFastingIndicator = codeText.includes('fasting') || 
                                   codeDisplay.includes('fasting') ||
                                   noteText.includes('fasting') ||
                                   loincCode === '1558-6'; // Fasting glucose LOINC

      if (!hasFastingIndicator) {
        issues.push({
          severity: 'warn',
          label: 'Missing fasting indicator',
          detail: `${param.name} typically requires fasting. Consider adding fasting status in code or note.`,
          location
        });
      }
    }

    // Check effective time for post-prandial tests
    if (loincCode === '33740-2' || (observation.code?.coding?.[0]?.display?.toLowerCase() || '').includes('post')) {
      if (!observation.effectiveDateTime && !observation.effectivePeriod) {
        issues.push({
          severity: 'warn',
          label: 'Missing post-prandial timing',
          detail: 'Post-prandial tests should include effective[x] indicating time after meal.',
          location
        });
      }
    }

    return issues;
  }

  private validateLaboratoryInterpretation(interpretations: any[], valueQuantity: any, param: any, location: string): CheckIssue[] {
    const issues: CheckIssue[] = [];

    interpretations.forEach((interp: any, index: number) => {
      const interpLocation = `${location} · interpretation[${index}]`;
      
      if (!this.hasCode(interp)) {
        issues.push({
          severity: 'warn',
          label: 'Invalid interpretation code',
          detail: 'Interpretation should be a CodeableConcept with coding.',
          location: interpLocation
        });
        return;
      }

      const interpSystem = this.getCodeSystem(interp);
      if (interpSystem && !interpSystem.includes('terminology.hl7.org') && !interpSystem.includes('v3-ObservationInterpretation')) {
        issues.push({
          severity: 'warn',
          label: 'Non-standard interpretation system',
          detail: 'Interpretation should use ObservationInterpretationCodes value set.',
          location: interpLocation
        });
      }

      // Validate interpretation against value
      if (valueQuantity && param) {
        const value = valueQuantity.value;
        const codings = interp.coding || [];
        const interpCodes = codings.map((c: any) => c?.code?.toLowerCase() || '').join(' ');

        const isHigh = interpCodes.includes('high') || interpCodes.includes('h') || interpCodes.includes('>');
        const isLow = interpCodes.includes('low') || interpCodes.includes('l') || interpCodes.includes('<');
        const isNormal = interpCodes.includes('normal') || interpCodes.includes('n') || interpCodes.includes('within');

        if (value !== null && value !== undefined) {
          const range = param.altUnit && (valueQuantity.unit || '').includes(param.altUnit) 
            ? param.altRange 
            : param.typicalRange;
          
          const actuallyHigh = value > range.high;
          const actuallyLow = value < range.low;
          const actuallyNormal = value >= range.low && value <= range.high;

          if ((isHigh && !actuallyHigh && !actuallyLow) || (isLow && !actuallyLow && !actuallyHigh) || 
              (isNormal && !actuallyNormal)) {
            issues.push({
              severity: 'warn',
              label: 'Interpretation mismatch',
              detail: `Interpretation "${interpCodes}" may not match value ${value} relative to typical range.`,
              location: interpLocation
            });
          }
        }
      }
    });

    return issues;
  }

  private validateReferenceRangePopulation(ranges: any[], location: string): CheckIssue[] {
    const issues: CheckIssue[] = [];

    ranges.forEach((range: any, index: number) => {
      const rangeLocation = `${location} · referenceRange[${index}]`;

      if (Array.isArray(range.appliesTo) && range.appliesTo.length > 0) {
        range.appliesTo.forEach((applies: any, appliesIndex: number) => {
          const appliesLocation = `${rangeLocation} · appliesTo[${appliesIndex}]`;
          
          if (!this.hasCode(applies)) {
            issues.push({
              severity: 'warn',
              label: 'Invalid appliesTo code',
              detail: 'appliesTo should be a CodeableConcept specifying the target population.',
              location: appliesLocation
            });
          }

          // Check for common population codes
          const codings = applies?.coding || [];
          const hasValidCode = codings.some((coding: any) => {
            const system = coding?.system || '';
            const code = coding?.code?.toLowerCase() || '';
            return system.includes('observation-referencerange-appliesto') ||
                   code.includes('male') || code.includes('female') ||
                   code.includes('pediatric') || code.includes('adult');
          });

          if (!hasValidCode && codings.length > 0) {
            issues.push({
              severity: 'warn',
              label: 'Non-standard appliesTo',
              detail: 'appliesTo should use ObservationReferenceRangeAppliesToCodes value set.',
              location: appliesLocation
            });
          }
        });
      }

      if (range.age) {
        const age = range.age;
        if (age.low && age.high) {
          const lowValue = this.extractQuantityValue(age.low);
          const highValue = this.extractQuantityValue(age.high);
          if (lowValue !== null && highValue !== null && lowValue > highValue) {
            issues.push({
              severity: 'error',
              label: 'Invalid age range',
              detail: 'Age range low must be less than or equal to high.',
              location: rangeLocation
            });
          }
        }
      }
    });

    return issues;
  }

  private validateLaboratoryStatusWorkflow(observation: any, location: string): CheckIssue[] {
    const issues: CheckIssue[] = [];

    // Laboratory observations should progress through status workflow
    const validStatuses = ['registered', 'specimen-in-process', 'preliminary', 'final', 'amended', 'corrected', 'cancelled', 'entered-in-error'];
    
    if (observation.status && !validStatuses.includes(observation.status)) {
      issues.push({
        severity: 'warn',
        label: 'Unusual laboratory status',
        detail: `Status "${observation.status}" is uncommon for laboratory observations. Typical workflow: registered → specimen-in-process → preliminary → final.`,
        location
      });
    }

    // If status is final, should have issued date
    if (observation.status === 'final' && !observation.issued) {
      issues.push({
        severity: 'warn',
        label: 'Final result without issued date',
        detail: 'Final laboratory results should include issued date indicating when results were made available.',
        location
      });
    }

    // If status is specimen-in-process, should have specimen
    if (observation.status === 'specimen-in-process' && !observation.specimen) {
      issues.push({
        severity: 'warn',
        label: 'Specimen-in-process without specimen',
        detail: 'Status "specimen-in-process" requires a specimen reference.',
        location
      });
    }

    return issues;
  }

  private validateLaboratoryTimingRelationship(observation: any, location: string): CheckIssue[] {
    const issues: CheckIssue[] = [];

    if (observation.issued && (observation.effectiveDateTime || observation.effectivePeriod?.start)) {
      try {
        const issuedDate = new Date(observation.issued);
        const effectiveDate = observation.effectiveDateTime 
          ? new Date(observation.effectiveDateTime)
          : new Date(observation.effectivePeriod.start);

        if (!isNaN(issuedDate.getTime()) && !isNaN(effectiveDate.getTime())) {
          // Issued should typically be after effective (collection time)
          if (issuedDate < effectiveDate) {
            issues.push({
              severity: 'warn',
              label: 'Issued before effective time',
              detail: 'Issued date (result availability) should typically be after effective time (specimen collection).',
              location
            });
          }

          // Large gap might indicate data quality issue
          const daysDiff = (issuedDate.getTime() - effectiveDate.getTime()) / (1000 * 60 * 60 * 24);
          if (daysDiff > 30) {
            issues.push({
              severity: 'warn',
              label: 'Large time gap',
              detail: `Large gap (${Math.round(daysDiff)} days) between collection and result availability. Verify dates.`,
              location
            });
          }
        }
      } catch {
        // Date parsing errors handled elsewhere
      }
    }

    return issues;
  }

  private validateLaboratoryPerformer(performers: any[], location: string): CheckIssue[] {
    const issues: CheckIssue[] = [];

    performers.forEach((performer: any, index: number) => {
      const performerLocation = `${location} · performer[${index}]`;
      
      if (performer.reference) {
        const ref = performer.reference;
        // Laboratory performers should typically be Organization or PractitionerRole
        const isLabPerformer = ref.includes('Organization/') || 
                               ref.includes('PractitionerRole/') ||
                               ref.includes('Practitioner/');

        if (!isLabPerformer) {
          issues.push({
            severity: 'warn',
            label: 'Unusual laboratory performer',
            detail: 'Laboratory observations are typically performed by Organizations or PractitionerRoles, not individual Patients or RelatedPersons.',
            location: performerLocation
          });
        }
      }
    });

    return issues;
  }

  private validateLaboratoryDevice(device: any, location: string): CheckIssue[] {
    const issues: CheckIssue[] = [];

    if (device.reference) {
      const ref = device.reference;
      if (!ref.includes('Device/') && !ref.includes('DeviceMetric/')) {
        issues.push({
          severity: 'warn',
          label: 'Invalid laboratory device',
          detail: 'Laboratory device should reference a Device or DeviceMetric resource representing the analyzer/equipment.',
          location
        });
      }
    } else {
      issues.push({
        severity: 'warn',
        label: 'Missing device reference',
        detail: 'Laboratory device should reference the equipment/analyzer used for testing.',
        location
      });
    }

    return issues;
  }

  private validateLaboratoryComponents(components: any[], loincCode: string | null, location: string): CheckIssue[] {
    const issues: CheckIssue[] = [];

    components.forEach((component: any, index: number) => {
      const componentLocation = `${location} · component[${index}]`;

      if (!component.code) {
        issues.push({
          severity: 'error',
          label: 'Missing component code',
          detail: 'Component observations must have a code.',
          location: componentLocation
        });
      } else {
        const componentLOINC = this.getLOINCCode(component.code);
        if (!componentLOINC) {
          issues.push({
            severity: 'warn',
            label: 'Component without LOINC code',
            detail: 'Laboratory component observations should use LOINC codes.',
            location: componentLocation
          });
        }
      }

      // Components should have values or dataAbsentReason
      const hasValue = ['valueQuantity', 'valueCodeableConcept', 'valueString', 'valueBoolean'].some(
        key => component[key] !== undefined
      );

      if (!hasValue && !component.dataAbsentReason) {
        issues.push({
          severity: 'warn',
          label: 'Component without value',
          detail: 'Component observations should have value[x] or dataAbsentReason.',
          location: componentLocation
        });
      }

      // Component should have same method, performer, device, time as parent
      // This is validated in the general component validation, but we can add lab-specific checks
    });

    return issues;
  }

  private validateLOINCCodeSpecificity(loincCode: string | null, code: any, location: string): CheckIssue[] {
    const issues: CheckIssue[] = [];

    if (!loincCode || !code) {
      return issues;
    }

    // Check if code has display text that matches LOINC
    const codings = code.coding || [];
    const loincCoding = codings.find((c: any) => 
      c?.system === 'http://loinc.org' || c?.system === 'https://loinc.org'
    );

    if (loincCoding && !loincCoding.display) {
      issues.push({
        severity: 'warn',
        label: 'Missing LOINC display',
        detail: 'LOINC codes should include display text for human readability.',
        location
      });
    }

    // Warn if multiple LOINC codes (should typically be one primary)
    const loincCount = codings.filter((c: any) => 
      c?.system === 'http://loinc.org' || c?.system === 'https://loinc.org'
    ).length;

    if (loincCount > 1) {
      issues.push({
        severity: 'warn',
        label: 'Multiple LOINC codes',
        detail: 'Observation.code typically has one primary LOINC code. Multiple codes may indicate mapping issues.',
        location
      });
    }

    return issues;
  }

  private validateLaboratoryValueType(observation: any, loincCode: string | null, location: string): CheckIssue[] {
    const issues: CheckIssue[] = [];

    // Most laboratory values should be Quantity
    if (observation.valueString && !observation.valueCodeableConcept) {
      const param = loincCode ? this.getLaboratoryParameter(loincCode) : null;
      if (param) {
        issues.push({
          severity: 'warn',
          label: 'String value for quantitative test',
          detail: `${param.name} is typically a quantitative value. Consider using valueQuantity instead of valueString.`,
          location
        });
      }
    }

    // Check if value type matches LOINC property
    // This is a simplified check - full LOINC property validation would require LOINC database
    if (loincCode && observation.valueQuantity) {
      // Most numeric lab values should have units
      if (!observation.valueQuantity.unit && !observation.valueQuantity.code) {
        issues.push({
          severity: 'error',
          label: 'Quantity without unit',
          detail: 'Laboratory quantity values must include units.',
          location
        });
      }
    }

    return issues;
  }

  private validateLaboratoryDataAbsentReason(dataAbsentReason: any, location: string): CheckIssue[] {
    const issues: CheckIssue[] = [];

    if (!this.hasCode(dataAbsentReason)) {
      issues.push({
        severity: 'warn',
        label: 'Invalid dataAbsentReason',
        detail: 'dataAbsentReason should be a CodeableConcept with coding from DataAbsentReason value set.',
        location
      });
      return issues;
    }

    const system = this.getCodeSystem(dataAbsentReason);
    if (system && !system.includes('data-absent-reason')) {
      issues.push({
        severity: 'warn',
        label: 'Non-standard dataAbsentReason',
        detail: 'dataAbsentReason should use DataAbsentReason value set.',
        location
      });
    }

    // Common laboratory-specific absent reasons
    const codings = dataAbsentReason.coding || [];
    const codes = codings.map((c: any) => c?.code?.toLowerCase() || '').join(' ');
    
    const validLabReasons = ['unsatisfactory', 'not-performed', 'error', 'not-asked', 'unknown', 'not-available'];
    const hasValidReason = validLabReasons.some(reason => codes.includes(reason));

    if (!hasValidReason && codings.length > 0) {
      issues.push({
        severity: 'warn',
        label: 'Unusual dataAbsentReason',
        detail: 'For laboratory observations, common absent reasons include: unsatisfactory, not-performed, error.',
        location
      });
    }

    return issues;
  }

  private validateLaboratoryOrder(basedOn: any[], location: string): CheckIssue[] {
    const issues: CheckIssue[] = [];

    basedOn.forEach((order: any, index: number) => {
      const orderLocation = `${location} · basedOn[${index}]`;

      if (!order.reference) {
        issues.push({
          severity: 'warn',
          label: 'Missing order reference',
          detail: 'Laboratory observations should reference the ServiceRequest (order) that triggered the test.',
          location: orderLocation
        });
        return;
      }

      const ref = order.reference;
      if (!ref.includes('ServiceRequest/')) {
        issues.push({
          severity: 'warn',
          label: 'Non-ServiceRequest order',
          detail: 'Laboratory observations are typically based on ServiceRequest resources (laboratory orders).',
          location: orderLocation
        });
      }
    });

    return issues;
  }

  private validateBundleStructure(content: string, location: string): CheckIssue[] {
    const issues: CheckIssue[] = [];

    try {
      const parsed = JSON.parse(content);
      
      if (parsed.resourceType === 'Bundle') {
        if (!parsed.type) {
          issues.push({
            severity: 'warn',
            label: 'Bundle without type',
            detail: 'FHIR Bundle should specify type (e.g., "collection", "searchset", "batch").',
            location
          });
        }

        if (!Array.isArray(parsed.entry)) {
          issues.push({
            severity: 'error',
            label: 'Invalid Bundle structure',
            detail: 'Bundle.entry must be an array.',
            location
          });
        } else {
          if (parsed.entry.length === 0) {
            issues.push({
              severity: 'warn',
              label: 'Empty Bundle',
              detail: 'Bundle contains no entries.',
              location
            });
          }

          parsed.entry.forEach((entry: any, index: number) => {
            if (!entry.resource && !entry.response) {
              issues.push({
                severity: 'warn',
                label: `Bundle entry ${index + 1} without resource`,
                detail: 'Bundle entries should contain resource or response.',
                location: `${location} · entry[${index}]`
              });
            }
          });
        }

        if (parsed.total !== undefined && parsed.entry && parsed.total !== parsed.entry.length) {
          issues.push({
            severity: 'warn',
            label: 'Bundle total mismatch',
            detail: `Bundle.total (${parsed.total}) does not match entry count (${parsed.entry.length}).`,
            location
          });
        }
      }
    } catch {
      // JSON parsing errors handled elsewhere
    }

    return issues;
  }

  private validateResourceStructure(resource: any, location: string): CheckIssue[] {
    const issues: CheckIssue[] = [];

    // Check for required FHIR resource fields
    if (!resource.resourceType) {
      issues.push({
        severity: 'error',
        label: 'Missing resourceType',
        detail: 'All FHIR resources must have a resourceType field.',
        location
      });
    }

    // Validate meta field if present
    if (resource.meta) {
      if (resource.meta.versionId && !resource.meta.lastUpdated) {
        issues.push({
          severity: 'warn',
          label: 'Meta versionId without lastUpdated',
          detail: 'If versionId is present, lastUpdated should also be present.',
          location
        });
      }

      if (Array.isArray(resource.meta.profile)) {
        resource.meta.profile.forEach((profile: string, index: number) => {
          if (!profile.startsWith('http://') && !profile.startsWith('https://')) {
            issues.push({
              severity: 'warn',
              label: 'Invalid profile URL',
              detail: `Profile URL "${profile}" should be a valid HTTP(S) URL.`,
              location: `${location} · meta.profile[${index}]`
            });
          }
        });
      }
    }

    // Validate text field if present
    if (resource.text) {
      if (resource.text.status && !['generated', 'extensions', 'additional', 'empty'].includes(resource.text.status)) {
        issues.push({
          severity: 'warn',
          label: 'Invalid text status',
          detail: 'text.status must be one of: generated, extensions, additional, empty.',
          location
        });
      }

      if (resource.text.div && !resource.text.div.includes('<')) {
        issues.push({
          severity: 'warn',
          label: 'Text div not HTML',
          detail: 'text.div should contain XHTML content.',
          location
        });
      }
    }

    // Validate identifier structure
    if (Array.isArray(resource.identifier)) {
      resource.identifier.forEach((identifier: any, index: number) => {
        const idLocation = `${location} · identifier[${index}]`;
        if (!identifier.system && !identifier.value) {
          issues.push({
            severity: 'warn',
            label: 'Incomplete identifier',
            detail: 'Identifier should have both system and value, or at least value.',
            location: idLocation
          });
        }

        if (identifier.use && !['usual', 'official', 'temp', 'secondary', 'old'].includes(identifier.use)) {
          issues.push({
            severity: 'warn',
            label: 'Invalid identifier use',
            detail: 'identifier.use must be one of: usual, official, temp, secondary, old.',
            location: idLocation
          });
        }
      });
    }

    // Validate extension structure
    if (Array.isArray(resource.extension)) {
      resource.extension.forEach((extension: any, index: number) => {
        const extLocation = `${location} · extension[${index}]`;
        if (!extension.url) {
          issues.push({
            severity: 'error',
            label: 'Extension without URL',
            detail: 'All extensions must have a url field.',
            location: extLocation
          });
        } else if (!extension.url.startsWith('http://') && !extension.url.startsWith('https://')) {
          issues.push({
            severity: 'warn',
            label: 'Invalid extension URL',
            detail: 'Extension URL should be a valid HTTP(S) URL.',
            location: extLocation
          });
        }
      });
    }

    return issues;
  }

  private validateCodeableConcepts(observation: any, location: string): CheckIssue[] {
    const issues: CheckIssue[] = [];
    const codeableFields = [
      { field: 'code', required: true },
      { field: 'category', required: false },
      { field: 'interpretation', required: false },
      { field: 'method', required: false },
      { field: 'dataAbsentReason', required: false }
    ];

    codeableFields.forEach(({ field, required }) => {
      const value = (observation as any)[field];
      if (!value && required) {
        return; // Already validated elsewhere
      }

      if (value) {
        if (Array.isArray(value)) {
          value.forEach((item: any, index: number) => {
            const itemLocation = `${location} · ${field}[${index}]`;
            issues.push(...this.validateCodeableConcept(item, itemLocation, field));
          });
        } else {
          issues.push(...this.validateCodeableConcept(value, location, field));
        }
      }
    });

    return issues;
  }

  private validateCodeableConcept(concept: any, location: string, fieldName: string): CheckIssue[] {
    const issues: CheckIssue[] = [];

    if (!concept || typeof concept !== 'object') {
      issues.push({
        severity: 'error',
        label: `Invalid ${fieldName}`,
        detail: `${fieldName} must be a CodeableConcept object.`,
        location
      });
      return issues;
    }

    // Check if has coding or text
    if (!Array.isArray(concept.coding) && !concept.text) {
      issues.push({
        severity: 'warn',
        label: `Incomplete ${fieldName}`,
        detail: `${fieldName} should have either coding or text.`,
        location
      });
    }

    // Validate codings
    if (Array.isArray(concept.coding)) {
      if (concept.coding.length === 0) {
        issues.push({
          severity: 'warn',
          label: `Empty coding array`,
          detail: `${fieldName}.coding should contain at least one coding.`,
          location
        });
      }

      concept.coding.forEach((coding: any, index: number) => {
        const codingLocation = `${location} · coding[${index}]`;
        if (!coding.code) {
          issues.push({
            severity: 'error',
            label: 'Coding without code',
            detail: 'All codings must have a code field.',
            location: codingLocation
          });
        }

        if (coding.system && !this.isValidURL(coding.system)) {
          issues.push({
            severity: 'warn',
            label: 'Invalid coding system URL',
            detail: `Coding system "${coding.system}" should be a valid URL.`,
            location: codingLocation
          });
        }

        if (coding.code && coding.system) {
          // Check for common code system patterns
          if (coding.system.includes('loinc.org') && !/^\d+-\d+$/.test(coding.code)) {
            issues.push({
              severity: 'warn',
              label: 'Invalid LOINC code format',
              detail: 'LOINC codes typically follow pattern: NNNNN-N (e.g., 2339-0).',
              location: codingLocation
            });
          }
        }
      });
    }

    return issues;
  }

  private validateReferences(observation: any, location: string): CheckIssue[] {
    const issues: CheckIssue[] = [];
    const referenceFields = [
      'subject', 'specimen', 'device', 'encounter', 'performer',
      'basedOn', 'partOf', 'hasMember', 'derivedFrom', 'focus'
    ];

    referenceFields.forEach((field) => {
      const value = (observation as any)[field];
      if (!value) {
        return;
      }

      if (Array.isArray(value)) {
        value.forEach((ref: any, index: number) => {
          const refLocation = `${location} · ${field}[${index}]`;
          issues.push(...this.validateReference(ref, refLocation, field));
        });
      } else {
        issues.push(...this.validateReference(value, location, field));
      }
    });

    return issues;
  }

  private validateReference(ref: any, location: string, fieldName: string): CheckIssue[] {
    const issues: CheckIssue[] = [];

    if (!ref || typeof ref !== 'object') {
      issues.push({
        severity: 'error',
        label: `Invalid ${fieldName} reference`,
        detail: `${fieldName} must be a Reference object.`,
        location
      });
      return issues;
    }

    if (!ref.reference && !ref.identifier && !ref.display) {
      issues.push({
        severity: 'error',
        label: `Empty ${fieldName} reference`,
        detail: `${fieldName} reference must have reference, identifier, or display.`,
        location
      });
    }

    if (ref.reference) {
      // Check reference format
      if (!ref.reference.includes('/') && !ref.reference.startsWith('#')) {
        issues.push({
          severity: 'warn',
          label: `Unusual ${fieldName} reference format`,
          detail: `Reference "${ref.reference}" should follow format "ResourceType/id" or be a contained reference "#id".`,
          location
        });
      }

      // Check for absolute URLs (should be valid)
      if (ref.reference.startsWith('http://') || ref.reference.startsWith('https://')) {
        if (!this.isValidURL(ref.reference)) {
          issues.push({
            severity: 'warn',
            label: `Invalid ${fieldName} URL`,
            detail: `Reference URL "${ref.reference}" may not be valid.`,
            location
          });
        }
      }
    }

    if (ref.type && !ref.type.startsWith('http://') && !ref.type.startsWith('https://')) {
      issues.push({
        severity: 'warn',
        label: `Invalid ${fieldName} type`,
        detail: `Reference type should be a URL to the resource definition.`,
        location
      });
    }

    return issues;
  }

  private validateDates(observation: any, location: string): CheckIssue[] {
    const issues: CheckIssue[] = [];
    const dateFields = [
      { field: 'issued', type: 'instant' },
      { field: 'effectiveDateTime', type: 'dateTime' },
      { field: 'effectivePeriod.start', type: 'dateTime' },
      { field: 'effectivePeriod.end', type: 'dateTime' }
    ];

    dateFields.forEach(({ field, type }) => {
      const value = this.getNestedValue(observation, field);
      if (!value) {
        return;
      }

      try {
        const date = new Date(value);
        if (isNaN(date.getTime())) {
          issues.push({
            severity: 'error',
            label: `Invalid ${field}`,
            detail: `${field} must be a valid ${type} in ISO 8601 format.`,
            location
          });
        } else {
          // Check if date is in the future (for most fields, this is unusual)
          if (field !== 'effectivePeriod.end' && date > new Date()) {
            issues.push({
              severity: 'warn',
              label: `Future ${field}`,
              detail: `${field} is in the future. Verify date is correct.`,
              location
            });
          }

          // Check if date is too far in the past (before 1900)
          if (date < new Date('1900-01-01')) {
            issues.push({
              severity: 'warn',
              label: `Very old ${field}`,
              detail: `${field} is before 1900. Verify date is correct.`,
              location
            });
          }
        }
      } catch {
        issues.push({
          severity: 'error',
          label: `Invalid ${field} format`,
          detail: `${field} must be a valid ${type} in ISO 8601 format.`,
          location
        });
      }
    });

    return issues;
  }

  private validateURLs(observation: any, location: string): CheckIssue[] {
    const issues: CheckIssue[] = [];

    // Check meta.profile URLs
    if (observation.meta?.profile) {
      observation.meta.profile.forEach((profile: string, index: number) => {
        if (!this.isValidURL(profile)) {
          issues.push({
            severity: 'warn',
            label: 'Invalid profile URL',
            detail: `Profile URL "${profile}" is not a valid URL.`,
            location: `${location} · meta.profile[${index}]`
          });
        }
      });
    }

    // Check meta.source URLs
    if (observation.meta?.source) {
      if (!this.isValidURL(observation.meta.source)) {
        issues.push({
          severity: 'warn',
          label: 'Invalid source URL',
          detail: `Source URL "${observation.meta.source}" is not a valid URL.`,
          location: `${location} · meta.source`
        });
      }
    }

    // Check implicitRules
    if (observation.implicitRules && !this.isValidURL(observation.implicitRules)) {
      issues.push({
        severity: 'warn',
        label: 'Invalid implicitRules URL',
        detail: `implicitRules "${observation.implicitRules}" is not a valid URL.`,
        location
      });
    }

    return issues;
  }

  private getNestedValue(obj: any, path: string): any {
    return path.split('.').reduce((current, prop) => current?.[prop], obj);
  }

  private isValidURL(url: string): boolean {
    try {
      new URL(url);
      return true;
    } catch {
      return false;
    }
  }

  private validateResourceRelationships(resources: any[]): CheckIssue[] {
    const issues: CheckIssue[] = [];
    const resourceIds = new Map<string, number>();

    // Collect all resource IDs
    resources.forEach((resource, index) => {
      if (resource.id) {
        const id = resource.id;
        if (resourceIds.has(id)) {
          issues.push({
            severity: 'error',
            label: 'Duplicate resource ID',
            detail: `Resource ID "${id}" appears multiple times (items ${resourceIds.get(id)! + 1} and ${index + 1}).`,
            location: `Item ${index + 1}`
          });
        } else {
          resourceIds.set(id, index);
        }
      }
    });

    // Validate references between resources
    resources.forEach((resource, index) => {
      const location = `Item ${index + 1}`;
      if (resource.resourceType === 'Observation') {
        // Check hasMember references
        if (Array.isArray(resource.hasMember)) {
          resource.hasMember.forEach((member: any, memberIndex: number) => {
            if (member.reference) {
              const refId = member.reference.replace('Observation/', '');
              if (!resourceIds.has(refId) && !member.reference.startsWith('http')) {
                issues.push({
                  severity: 'warn',
                  label: 'External hasMember reference',
                  detail: `hasMember references Observation "${refId}" which is not in this dataset.`,
                  location: `${location} · hasMember[${memberIndex}]`
                });
              }
            }
          });
        }

        // Check derivedFrom references
        if (Array.isArray(resource.derivedFrom)) {
          resource.derivedFrom.forEach((derived: any, derivedIndex: number) => {
            if (derived.reference && derived.reference.includes('Observation/')) {
              const refId = derived.reference.replace('Observation/', '');
              if (!resourceIds.has(refId) && !derived.reference.startsWith('http')) {
                issues.push({
                  severity: 'warn',
                  label: 'External derivedFrom reference',
                  detail: `derivedFrom references Observation "${refId}" which is not in this dataset.`,
                  location: `${location} · derivedFrom[${derivedIndex}]`
                });
              }
            }
          });
        }

        // Check triggeredBy references
        if (Array.isArray(resource.triggeredBy)) {
          resource.triggeredBy.forEach((trigger: any, triggerIndex: number) => {
            if (trigger.observation?.reference && trigger.observation.reference.includes('Observation/')) {
              const refId = trigger.observation.reference.replace('Observation/', '');
              if (!resourceIds.has(refId) && !trigger.observation.reference.startsWith('http')) {
                issues.push({
                  severity: 'warn',
                  label: 'External triggeredBy reference',
                  detail: `triggeredBy references Observation "${refId}" which is not in this dataset.`,
                  location: `${location} · triggeredBy[${triggerIndex}]`
                });
              }
            }
          });
        }
      }
    });

    return issues;
  }
}

export function validateFhirObservations(content: string, options?: ValidateOptions): ValidationReport {
  const checker = new FhirObservationChecker();
  return checker.validate(content, options);
}

/**
 * Full DCC quality-gate entry point (shared by Angular UI and Node CLI).
 *
 * Routing:
 * 1. If the active config looks study/CSV-oriented and the payload is CSV or a
 *    multi-CSV JSON package → tabular dictionary suites.
 * 2. Otherwise → FHIR Observation / DiagnosticReport parse + check pipeline.
 *
 * Always returns a `DccRunReport` with gate status, suite breakdown, and
 * record-level findings suitable for audit export (JSON / MD / HTML).
 */
export function runDataCurationCheck(content: string, options?: ValidateOptions): DccRunReport {
  const config = resolveEffectiveConfig(options?.config);
  const source = options?.source ?? 'Input';
  const sourceDetail = options?.sourceDetail;
  const runContext = defaultRunContext({
    ...options?.runContext,
    schemaVersion: options?.runContext?.schemaVersion ?? config.version,
    studyId: options?.runContext?.studyId ?? config.snapshot.studyId,
    dictionaryRef: options?.runContext?.dictionaryRef ?? config.snapshot.dictionaryRef,
    inputFiles:
      options?.runContext?.inputFiles?.length
        ? options.runContext.inputFiles
        : sourceDetail
          ? [sourceDetail]
          : []
  });

  // Dictionary-driven tabular / study dataset path
  if (isTabularDatasetInput(content, config.snapshot)) {
    const { parse, issues: parseIssues } = parseTabularDataset(
      content,
      config.snapshot,
      sourceDetail
    );
    const emptyParse: ParseResult = {
      ok: parse.ok,
      type: parse.type,
      resources: [],
      diagnosticReports: [],
      error: parse.error
    };

    if (!parse.ok) {
      const issues = [
        ...parseIssues,
        {
          severity: 'error' as const,
          label: 'Tabular parse failed',
          detail: parse.error ?? 'Unable to parse study dataset.',
          location: source,
          code: 'TABULAR_PARSE_FAILED',
          category: 'ingest' as const,
          suiteId: 'ingest'
        }
      ];
      return buildDccRunReport({
        parseResult: emptyParse,
        issues,
        checkResults: [
          {
            label: 'Ingest & parse',
            status: 'error',
            statusLabel: 'Error',
            detail: parse.error ?? 'Tabular parse failed.',
            suiteId: 'ingest',
            category: 'ingest'
          }
        ],
        laboratoryCount: 0,
        config,
        runContext,
        checkSuites: [],
        summaryExtras: {
          rowCount: 0,
          tableCounts: {},
          missingFiles: [],
          unexpectedFiles: [],
          missingColumns: [],
          unexpectedColumns: []
        }
      });
    }

    const tabular = runTabularDictionaryChecks(config.snapshot, parse.tables, runContext.inputFiles);
    const metaIssues = applyMetadataRequirements(config.snapshot, runContext);
    const reproIssues = runReproducibilityChecks({
      config,
      runContext,
      toolVersion: TOOL_VERSION
    });
    const allIssues = [...parseIssues, ...tabular.issues, ...metaIssues, ...reproIssues];

    const suites = [
      summarizeSuite({
        id: 'ingest',
        label: 'Ingest & parse',
        description: 'Parse CSV / multi-table study package.',
        category: 'ingest',
        enabled: true,
        issues: parseIssues
      }),
      summarizeSuite({
        id: 'tabular-dictionary',
        label: 'Dictionary / tabular rules',
        description: 'Tables, columns, types, required values, patterns, aliases.',
        category: 'structure',
        enabled: true,
        issues: tabular.issues.filter((i) => i.suiteId === 'tabular-dictionary' || !i.suiteId)
      }),
      summarizeSuite({
        id: 'primary-keys',
        label: 'Primary keys',
        description: 'Primary-key uniqueness within tables.',
        category: 'identifier',
        enabled: true,
        issues: tabular.issues.filter((i) => i.suiteId === 'primary-keys')
      }),
      summarizeSuite({
        id: 'cross-references',
        label: 'Cross-file references',
        description: 'Referential integrity across dictionary tables.',
        category: 'reference',
        enabled: true,
        issues: tabular.issues.filter((i) => i.suiteId === 'cross-references')
      }),
      summarizeSuite({
        id: 'expected-files',
        label: 'Expected files',
        description: 'Expected file set vs provided package.',
        category: 'dataset',
        enabled: true,
        issues: tabular.issues.filter((i) => i.suiteId === 'expected-files')
      }),
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

    const checkResults = [
      {
        label: 'Source',
        status: 'ok' as const,
        statusLabel: 'OK',
        detail: `${source} detected${sourceDetail ? `: ${sourceDetail}` : ''} (${parse.type}).`,
        suiteId: 'ingest',
        category: 'ingest' as const
      },
      {
        label: 'Study / dictionary',
        status: 'ok' as const,
        statusLabel: 'OK',
        detail: `${runContext.studyId ?? config.snapshot.studyId ?? 'n/a'} · ${
          runContext.dictionaryRef ?? config.snapshot.dictionaryRef ?? config.snapshot.name
        }`,
        category: 'policy' as const
      },
      ...suites.map(suiteToCheckResult)
    ];

    return buildDccRunReport({
      parseResult: emptyParse,
      issues: allIssues,
      checkResults,
      laboratoryCount: 0,
      config,
      runContext,
      checkSuites: suites,
      summaryExtras: tabular.extras
    });
  }

  // FHIR Observation / DiagnosticReport path
  const checker = new FhirObservationChecker();
  const base = checker.validate(content, options);

  const { suites, issues, checkResults } = runCheckPipeline({
    base,
    config,
    runContext,
    options,
    source,
    sourceDetail
  });

  return buildDccRunReport({
    parseResult: base.parseResult,
    issues,
    checkResults,
    laboratoryCount: base.laboratoryCount ?? 0,
    config,
    runContext,
    checkSuites: suites
  });
}
