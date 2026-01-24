const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '../src/app/app.component.ts'), 'utf8');
const lines = src.split('\n');

// 0-based line indices
const parseInput = lines.slice(847, 895).join('\n');
const extractResources = lines.slice(901, 933).join('\n');
let performValidation = lines.slice(670, 751).join('\n');
let generateValidationResults = lines.slice(755, 815).join('\n');
const rest = lines.slice(937, 3548).join('\n');

// performValidation: replace generateValidationResults call with return
performValidation = performValidation.replace(
  '    // Generate summary results\n    this.generateValidationResults(\n      issues,\n      observationCount,\n      laboratoryCount,\n      parseResult,\n      source\n    );\n  }',
  '    return { issues, observationCount, laboratoryCount };\n  }'
);

// generateValidationResults: add sourceDetail param, return CheckResult[], use sourceDetail, return array
generateValidationResults = generateValidationResults.replace(
  'source: string\n  ): void {',
  'source: string,\n    sourceDetail?: string\n  ): CheckResult[] {'
);
generateValidationResults = generateValidationResults.replace(
  'this.selectedFileName ? `: ${this.selectedFileName}` : \'\'',
  'sourceDetail ? `: ${sourceDetail}` : \'\''
);
generateValidationResults = generateValidationResults.replace(
  '    this.issues = issues;\n    this.checkResults = [',
  '    return ['
);

const out = `/**
 * FHIR Observation validation checks.
 * Pure TypeScript – no Angular. Use from UI, Node, or CLI.
 */

import { Observation, Bundle } from '../models/fhir.types';
import type { CheckResult, CheckIssue, CheckStatus, ParseResult, ValidationReport, ValidateOptions } from './types';

export type { CheckResult, CheckIssue, CheckStatus, ParseResult, ValidationReport, ValidateOptions };

export class FhirObservationChecker {
  validate(content: string, options?: ValidateOptions): ValidationReport {
    const source = options?.source ?? 'Input';
    const sourceDetail = options?.sourceDetail;
    const parseResult = this.parseInput(content);

    if (!parseResult.ok) {
      const { issues, checkResults } = this.buildParseErrorResult(parseResult, source, sourceDetail);
      return { parseResult, issues, checkResults };
    }

    const { issues, observationCount, laboratoryCount } = this.performValidation(parseResult, content, source);
    const checkResults = this.generateValidationResults(issues, observationCount, laboratoryCount, parseResult, source, sourceDetail);
    return { parseResult, issues, checkResults };
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
        { label: 'Source', status: 'ok', statusLabel: 'OK', detail: \`\${source} detected\${sourceDetail ? \`: \${sourceDetail}\` : ''}.\` },
        { label: 'Parsing', status: 'error', statusLabel: 'Error', detail: parseResult.error ?? 'Invalid JSON/NDJSON input.' }
      ]
    };
  }

${parseInput}

${extractResources}

${performValidation}

${generateValidationResults}

${rest}
}

export function validateFhirObservations(content: string, options?: ValidateOptions): ValidationReport {
  const checker = new FhirObservationChecker();
  return checker.validate(content, options);
}
`;

fs.writeFileSync(path.join(__dirname, '../src/app/checks/fhir-observation-checks.ts'), out);
console.log('Written fhir-observation-checks.ts');
