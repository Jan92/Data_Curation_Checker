# Data Curation Checker

**SEARCH Data Curation Checker (DCC)** — developed by [medicalvalues](https://www.medicalvalues.de) for the [SEARCH](https://www.ihi.europa.eu/) IHI JU platform (deliverable D1.6 §4.2.3).

On-premise **quality gate** for curated and annotated research datasets (CAD). The module verifies whether datasets comply with predefined **syntactic** standards, schemas and formatting rules **before** they are made available via the Platform Data Uploader. It does **not** perform clinical interpretation or semantic plausibility assessment.

---

## Role in SEARCH (meta-scenario 1.1)

1. Data curation (HYGEIA / T3.1 procedures)  
2. Data annotation  
3. **Data Curation Checker (this module)** → PASS / FAIL  
4. On PASS → Platform Data Uploader (metadata + local CAD storage)  
5. On FAIL → notify data provider with discrepancies  

The checker runs **locally** (on-premise). Validation outcomes can be recorded in metadata for downstream modules (e.g. Data Harmonization).

---

## Running the Web UI

- **Development:** `npm start` — serves at `http://localhost:4200/`
- **Production build:** `npm run build` — output in `dist/`
- **GitHub Pages:** deployed via GitHub Actions to **https://jan92.github.io/Data_Curation_Checker/**

The UI captures **dataset/run context** (dataset ID, source/site, timeframe, mode), shows the **active config version + hash**, presents a **PASS/FAIL quality gate**, and exports **JSON** or **Markdown** reports.

---

## Supported input formats

- FHIR JSON **Bundle** with Observation and/or DiagnosticReport  
- JSON **array** of resources  
- **NDJSON** (one resource per line)  
- Single **Observation** or **DiagnosticReport**

---

## What is validated

- **Observation:** Structure, required fields (`status`, `code`), `value[x]` vs `dataAbsentReason`, CodeableConcepts, references, dates, URLs  
- **DiagnosticReport:** Required `status`, `code`; recommended `category`, `subject`, `effective`/`issued`, `performer`, `result`  
- **Laboratory (LOINC):** UCUM units, reference ranges, critical values, workflow structure  
- **Config-driven gate:** Versioned validation config (`configs/fhir-lab-v1.json` / `.yaml`) with hash snapshot per run  

See [FHIR DiagnosticReport](https://build.fhir.org/diagnosticreport.html).

---

## Using checks without the UI

### Programmatic API

```ts
import { runDataCurationCheck, formatReportAsMarkdown } from './src/app/checks/fhir-observation-checks';

const report = runDataCurationCheck(content, {
  source: 'File',
  sourceDetail: 'path.json',
  runContext: {
    datasetId: 'CAD-001',
    sourceSite: 'HYGEIA',
    mode: 'local',
    inputFiles: ['path.json']
  }
});

console.log(report.gate); // 'PASS' | 'FAIL'
console.log(formatReportAsMarkdown(report));
```

Legacy helper (issues + checkResults only):

```ts
import { validateFhirObservations } from './src/app/checks/fhir-observation-checks';
```

### CLI

```bash
# Validate config (JSON or YAML)
npm run check:config -- --config ./configs/fhir-lab-v1.json
npm run check:config -- --config ./configs/fhir-lab-v1.yaml

# Run DCC on a dataset
npm run check:cli -- --file ./observations.json
npm run check:cli -- --file ./observations.json --config ./configs/fhir-lab-v1.json \
  --dataset-id CAD-001 --source-site HYGEIA --mode local --format md --out report.md

# Exit code 2 when gate is FAIL
npm run check:cli -- --file ./data.json --gate-exit
```

**`DccRunReport`** includes: `gate`, `toolVersion`, `config` (id, version, hash, snapshot), `runContext`, `summary`, `issues`, `checkResults`, `recordResults`.

Reports: **JSON**, **Markdown**, **HTML** (`--format html`; open/print to PDF from the browser).

---

## Project layout

- `configs/` — versioned validation schemas (JSON + YAML)  
- `src/app/checks/config/` — config types, default config, hash, config validator  
- `src/app/checks/report/` — DCC run report + Markdown formatter  
- `src/app/checks/fhir-observation-checks.ts` — FHIR validators + `runDataCurationCheck`  
- `scripts/run-checks-cli.ts` — headless dataset validation  
- `scripts/validate-config-cli.ts` — reject invalid validation configurations  

---

## Privacy

Syntactic/structural validation only. Designed for local processing, data minimisation, and auditability (config hash, timestamps, tool version) without unnecessary exposure of personal data.

---

## License

See repository for license information.
