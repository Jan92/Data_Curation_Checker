# Data Curation Checker

A tool for validating FHIR R4 Observation resources. It checks structure, terminology, references, and laboratory-specific rules. You can run it in the browser or use the validation logic **without the UI** (e.g. from Node, scripts, or CI).

---

## Running the Web UI

- **Development:** `npm start` — serves at `http://localhost:4200/`
- **Production build:** `npm run build` — output in `dist/`

---

## Supported input formats

- FHIR JSON **Bundle** (e.g. `type: "collection"` with `entry[]`)
- JSON **array** of resources
- **NDJSON** (one JSON resource per line)
- Single **Observation** (JSON object)

---

## What is validated

- **Structure:** Bundle format, resource shape, required fields (`status`, `code`), `value[x]` vs `dataAbsentReason`, organizer rules.
- **Terminology:** CodeableConcepts (coding, system, display), LOINC format, preferred systems (LOINC, SNOMED CT).
- **References:** `subject`, `specimen`, `performer`, `device`, `basedOn`, etc., and reference targets in the same set.
- **Dates:** `effective`, `issued` and consistency.
- **URLs:** `meta.implicitRules`, `meta.source`, and similar.
- **Laboratory (LOINC-coded):** Parameter-specific rules for 140+ common lab parameters (e.g. glucose, creatinine, HbA1c, CBC, liver, cardiac, thyroid, coagulation, tumor markers, urine, hormones, vitamins):
  - UCUM units and reference ranges  
  - Critical low/high  
  - Specimen, method, timing, interpretation  
  - Panel/component, reflex, delta checks  
  - Status workflow, performer, device, dataAbsentReason

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
    type: string;        // e.g. 'JSON Object', 'NDJSON', 'JSON Array'
    resources: Observation[];
    error?: string;      // set when ok is false
  };
  issues: CheckIssue[];   // { severity, label, detail, location }
  checkResults: CheckResult[];  // { label, status, statusLabel, detail }
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
