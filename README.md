# Data Curation Checker

A tool for validating FHIR R4 **Observation** and **DiagnosticReport** resources. It checks structure, terminology, references, and laboratory-specific rules. You can run it in the browser or use the validation logic **without the UI** (e.g. from Node, scripts, or CI).

---

## Running the Web UI

- **Development:** `npm start` — serves at `http://localhost:4200/`
- **Production build:** `npm run build` — output in `dist/`

---

## Supported input formats

- FHIR JSON **Bundle** (e.g. `type: "collection"` with `entry[]`) containing Observation and/or DiagnosticReport
- JSON **array** of Observation and/or DiagnosticReport resources
- **NDJSON** (one JSON resource per line)
- Single **Observation** or **DiagnosticReport** (JSON object)

---

## What is validated

- **Observation:** Structure, required fields (`status`, `code`), `value[x]` vs `dataAbsentReason`, organizer rules; CodeableConcepts, references, dates, URLs.
- **DiagnosticReport:** Required `status`, `code`; recommended `category`, `subject`, `effective`/`issued`, `performer`, `result` (Observation references); reference and CodeableConcept checks. See [FHIR DiagnosticReport](https://build.fhir.org/diagnosticreport.html).
- **Laboratory (Observation, LOINC-coded):** Parameter-specific rules for many common lab parameters (e.g. glucose, creatinine, HbA1c, CBC, liver, cardiac, thyroid, coagulation, tumor markers, urine, hormones, vitamins):
  - UCUM units and reference ranges, critical low/high
  - Specimen, method, timing, interpretation; panel/component, reflex, delta checks; status workflow, performer, device, dataAbsentReason
- **Structure:** Bundle format, resource relationships, reference integrity.

---

## Using the checks without the UI

The validation logic lives in a plain TypeScript module with **no Angular dependency**. You can:

- **Import and call it** from any Node or TypeScript project.
- **Run the CLI** to validate files or stdin and get a JSON report.

### Programmatic usage

Import and call:

```ts
import { validateFhirObservations } from './src/app/checks/fhir-observation-checks';

const report = validateFhirObservations(content, {
  source: 'File',           // optional: 'File' | 'Text' | 'stdin' | 'Input'
  sourceDetail: 'path.json' // optional: file path or other detail
});
```

**Signature:**

```ts
validateFhirObservations(
  content: string,
  options?: { source?: string; sourceDetail?: string }
): ValidationReport
```

**`ValidationReport`:**

```ts
{
  parseResult: {
    ok: boolean;
    type: string;              // e.g. 'JSON Object', 'NDJSON', 'JSON Array'
    resources: Observation[];
    diagnosticReports: DiagnosticReport[];
    error?: string;            // set when ok is false
  };
  issues: CheckIssue[];        // { severity, label, detail, location }
  checkResults: CheckResult[]; // { label, status, statusLabel, detail }
}
```

Types are exported from `./src/app/checks/fhir-observation-checks` and `./src/app/checks/types`.

### CLI (headless)

The CLI reads from a file or stdin and prints a `ValidationReport` as JSON.

**From a file:**

```bash
npm run check:cli -- --file ./observations.json
```

**From stdin:**

```bash
cat observations.json | npm run check:cli
```

**Requirements:** `ts-node` is used as a dev dependency. Run `npm install` first.

---

## Project layout

- `src/app/checks/` — Validation logic (framework-agnostic):
  - `fhir-observation-checks.ts` — `FhirObservationChecker`, `validateFhirObservations`
  - `types.ts` — `CheckStatus`, `CheckResult`, `CheckIssue`, `ParseResult`, `ValidationReport`, `ValidateOptions`
- `src/app/models/fhir.types.ts` — FHIR R4 type definitions used by the checks
- `scripts/run-checks-cli.ts` — CLI entry point
- `tsconfig.cli.json` — tsconfig for the CLI (Node, CommonJS)

---

## License

See repository for license information.
