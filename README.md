# Data Curation Checker

On-premise **quality gate** for curated and annotated research datasets (CAD). The module verifies whether datasets comply with predefined **syntactic** standards, schemas and formatting rules **before** platform upload. It does **not** perform clinical interpretation or semantic plausibility assessment.

The same validation engine powers the **web UI** and the **CLI scripts**.

---

## Features

- Import validation schemas from **JSON**, **YAML**, and **CSV**
- Versioned configs with **hash + snapshot** per run
- Dataset/run context (dataset ID, source/site, timeframe, mode, files, license, provenance)
- **Differentiated check suites** via `runDataCurationCheck` (ingest, dataset integrity, FHIR Observation/DiagnosticReport, laboratory/LOINC, cross-references, primary keys, date/time, vocabularies, completeness, identifier formats, config rules, metadata, expected files, reproducibility)
- Dataset-level summary + **record-level** findings
- Quality gate **PASS / FAIL**
- Reports: **JSON**, **Markdown**, **HTML** (print → PDF)
- Built-in plugin registry (extensible ids)

---

## Web UI

```bash
npm start          # http://localhost:4200/
npm run build      # production → dist/
```

The UI uses `runDataCurationCheck`, `parseConfigFromText`, and `formatReport` from `src/app/checks`.

---

## Shared API (UI + scripts)

```ts
import {
  runDataCurationCheck,
  formatReport,
  parseConfigFromText,
  validateFhirObservations
} from './src/app/checks';

const report = runDataCurationCheck(content, {
  source: 'File',
  sourceDetail: 'path.json',
  runContext: {
    datasetId: 'CAD-001',
    sourceSite: 'local-lab',
    mode: 'local',
    inputFiles: ['path.json'],
    license: 'internal',
    provenance: 'curated-export'
  }
});

console.log(report.gate); // 'PASS' | 'FAIL'
console.log(formatReport(report, 'md'));
```

Legacy helper (issues + checkResults only):

```ts
import { validateFhirObservations } from './src/app/checks';
```

---

## CLI scripts

All CLIs call the same check library as the frontend.

### Validate a config

```bash
npm run check:config
npm run check:config -- --config ./configs/fhir-lab-v1.json
npm run check:config -- --config ./configs/fhir-lab-v1.yaml
npm run check:config -- --config ./configs/fhir-lab-v1.fields.csv
npm run check:config -- --list-plugins
```

### Run the quality gate

```bash
# Single file
npm run check:cli -- --file ./observations.json

# With context + Markdown report
npm run check:cli -- --file ./observations.json --config ./configs/fhir-lab-v1.json \
  --dataset-id CAD-001 --source-site local-lab --mode local \
  --license internal --provenance curated-export \
  --format md --out report.md

# HTML report (open in browser → Print → PDF)
npm run check:cli -- --file ./data.json --format html --out report.html

# Batch a directory
npm run check:cli -- --dir ./datasets --format json --out ./reports --gate-exit

# Multiple files
npm run check:cli -- --file ./a.json --file ./b.json --gate-exit

# Treat warnings as FAIL
npm run check:cli -- --file ./data.json --fail-on-warn --gate-exit
```

Exit codes: `0` success, `1` runtime/config error, `2` gate FAIL (with `--gate-exit`).

### UI smoke test (dev server must be running)

```bash
npm run check:ui
```

---

## Configs

| File | Format |
|------|--------|
| `configs/fhir-lab-v1.json` | Full JSON schema |
| `configs/fhir-lab-v1.yaml` | Same schema as YAML |
| `configs/fhir-lab-v1.fields.csv` | Field-level CSV (entity, field, required, …) |

CSV columns: `entity,field,required,dataType,allowableValues,severity,regex,aliasOf`

---

## Project layout

```
configs/                     # published validation schemas
scripts/
  run-checks-cli.ts          # dataset quality gate
  validate-config-cli.ts     # config validator
  lib/cli-utils.ts           # shared Node helpers
  ui-smoke.cjs               # Playwright UI smoke
src/app/checks/              # shared engine (UI + CLI)
  index.ts                   # public barrel
  fhir-observation-checks.ts # FHIR validators + runDataCurationCheck
  config/                    # types, default config, hash, rules
  io/                        # config loaders + report formatters
  report/                    # DccRunReport builders
  plugins/                   # built-in plugin registry
```

---

## Privacy

Syntactic/structural validation only. Designed for local processing, data minimisation, and auditability (config hash, timestamps, tool version) without unnecessary exposure of personal data.

---

## License

See repository for license information.
