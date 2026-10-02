# Data Curation Checker

On-premise **quality gate** for curated and annotated research datasets (CAD). The module verifies whether datasets comply with predefined **syntactic** standards, schemas and formatting rules **before** platform upload. It does **not** perform clinical interpretation or semantic plausibility assessment.

The same validation engine powers the **web UI** and the **CLI scripts**.

---

## Features

- Import validation schemas from **JSON**, **YAML**, **CSV**, and **Excel data dictionaries** (`.xlsx`)
- Audit a study data dictionary before it is used as a schema: required/null contradictions, date-order conflicts, values present in the extract but missing from the acceptable list, unbounded `VARCHAR( )`, companion value lists
- Compile that workbook into a CSV validation config (categories become tables, acceptable values and numeric ranges become field rules)
- Versioned configs with **hash + snapshot** per run
- Dataset/run context (dataset ID, study ID, dictionary ref, source/site, timeframe, mode, files, license, provenance)
- **SHIELD study dictionaries:** SHIELD-CC-2025 / SHIELD-OC-2025 (V2 & V3) as declarative configs for automated refresh QA
- Dictionary-driven **tabular/CSV** validation: expected files, tables/columns, data types, required/optional fields, allowable values, patterns, primary keys, cross-file references, aliases
- FHIR Observation / DiagnosticReport suites (lab demonstrator)
- Dataset-level summary (row counts, pass/fail, violations by field/code, missing/unexpected files & columns, config/tool versions, timestamps)
- Per-record results (record id, status, violation code, field, raw value, severity)
- Optional human-readable reports: **JSON**, **Markdown**, **HTML** (print → PDF)
- Built-in plugin registry (extensible ids)

---

## SHIELD study datasets (forthcoming reporting period)

The checker is intended for deterministic, configuration-driven validation of **SHIELD-CC-2025** and **SHIELD-OC-2025** study packages. Dictionary V2/V3 configs express curation/QA rules declaratively so each data refresh can be re-verified automatically and yield documented syntactic quality evidence before de-identification and transfer to UTH.

| Config | Study | Dictionary |
|--------|-------|------------|
| `configs/shield-cc-2025-v2.json` | SHIELD-CC-2025 | Appendix 10 V2 |
| `configs/shield-cc-2025-v3.json` | SHIELD-CC-2025 | Appendix 10 V3 |
| `configs/shield-oc-2025-v2.json` | SHIELD-OC-2025 | Appendix 11 V2 |
| `configs/shield-oc-2025-v3.json` | SHIELD-OC-2025 | Appendix 11 V3 |
| `configs/samples/shield-cc-2025-v2-package.json` | Sample multi-CSV package | — |

Example:

```bash
npm run check:cli -- \
  --file ./configs/samples/shield-cc-2025-v2-package.json \
  --config ./configs/shield-cc-2025-v2.json \
  --dataset-id SHIELD-CC-2025-refresh-01 \
  --study-id SHIELD-CC-2025 \
  --source-site local-lab \
  --license internal \
  --provenance curated-export \
  --format md --out shield-cc-report.md --gate-exit
```

Multi-table packages can be supplied as a JSON map of `tableName → CSV text`, or as individual CSV files validated against the matching entity `table` name.

---

## Excel data dictionaries

Study catalogues such as the SEARCH cervical and ovarian workbooks are field lists, not patient tables. The checker reads that shape without hardcoding either workbook:

| Column role | Typical header |
|-------------|----------------|
| Category | `Data Fields Category` or `Data Field Category` (often merged down) |
| Index | blank header, numeric body |
| Field | `Data Fields` or `Data Field` |
| Definition, type, format | `Description / Definition`, `Data Type`, `Format / Character length` |
| Domain | `Value Range/ Acceptable values` and `Existing values in dataset` |
| Flags | `Required?`, `Accepts null value?` |

Header wording can vary. A side sheet that is only a value list is compared with the closest field; it is not treated as a second dictionary.

Audit the workbook itself:

```bash
npm run check:cli -- \
  --file ./dictionary.xlsx \
  --dataset-id DICT-refresh-01 \
  --source-site local-lab \
  --format md --out dictionary-audit.md --gate-exit
```

Blocking findings (gate FAIL) include a required field that also accepts null, a duplicate field name, and a date sample that cannot match the declared order (`MM-DD-YYYY` vs `31/08/2015`). Warnings cover undeclared existing values, empty `VARCHAR( )`, and numeric windows labelled as categorical.

Compile the workbook into the CSV schema, or audit the synthetic clean catalogue (warnings only, gate PASS):

```bash
npm run check:config -- --config ./dictionary.xlsx
npm run check:dictionary
```

### On the website

1. **Audit** the workbook: upload the `.xlsx` as the dataset (or tap **Audit sample dictionary**) and run the gate.
2. **Adopt** it with **Use as validation config**. Categories become tables. Trimmed field names become column headers. **Download compiled config** saves that schema as JSON.
3. **Check the extract.** Paste or upload CSV, or a JSON map of table name to CSV text. Headers must match the dictionary. One category is one file (`follow_up.csv`, …).

On a phone or tablet the guide starts collapsed. **Show guide** opens the same three steps. The sample workbooks under `configs/samples/search-dictionary-*.xlsx` are synthetic. They follow the catalogue layout; they are not copies of a study dictionary.

Regenerate them with `python3 scripts/build-dictionary-fixtures.py` (needs `openpyxl`). `npm run check:dictionary` checks both fixtures and, when given extra paths, prints a summary of those workbooks.

### Audit codes

Errors fail the gate. Warnings stay in the report and fail the gate only with `--fail-on-warn`.

| Code | Meaning |
|------|---------|
| `DICT_REQUIRED_ALLOWS_NULL` | Required field also accepts null |
| `DICT_DUPLICATE_FIELD` | Same field name used twice |
| `DICT_DATE_ORDER_CONFLICT` | A sample date cannot match the declared order, for example `MM-DD-YYYY` vs `31/08/2015` |
| `DICT_DATE_SEPARATOR` | Sample dates use a different separator than the declared format |
| `DICT_OBSERVED_NOT_IN_DOMAIN` | An existing value is not in the acceptable list |
| `DICT_DEFAULT_NOT_IN_DOMAIN` | The default cell is not in the acceptable list |
| `DICT_OBSERVED_OUTSIDE_RANGE` | An existing value sits outside the numeric window |
| `DICT_UNBOUNDED_TEXT` | `VARCHAR( )` has no length (reported once) |
| `DICT_BOOLEAN_AS_CATEGORICAL` | Yes/no field labelled categorical |
| `DICT_RANGE_AS_CATEGORICAL` | A numeric window labelled categorical |
| `DICT_COMPANION_DRIFT` | A side-sheet value list does not match the field domain |
| `DICT_PARSE_FAILED` | The workbook could not be read |

The compiled config then checks an extract against those rules:

- A field with **Accepts null value? = No** warns on an empty cell (`NULL_NOT_ALLOWED`), including when the field is optional. A required empty cell remains a blocking missing value.
- A date window such as `2015-2018` or `2015-Present` is checked on the year, after the date matches `MM-DD-YYYY` or the other declared pattern.
- Boolean fields accept `Yes`/`No`, `Y`/`N`, `true`/`false`, and `0`/`1`.

Legacy `.xls` and formula cells are not evaluated. Merged category cells are filled down. A blank index column is ignored as a field.

---

## Web UI

```bash
npm start          # http://localhost:4200/
npm run build      # production → dist/
npm run check:ui   # Playwright smoke, including phone width
```

The page is the same engine as the CLI (`runDataCurationCheck`, `parseConfigFromText`, `formatReport`). Nothing is uploaded.

| Viewport | What you get |
|----------|----------------|
| Desktop, wider than 1200px | **Run quality gate** in the header. The guide is open on a first visit. Dataset and results sit side by side once the window is wider than 960px. |
| iPad and other tablets, up to 1200px | The header button is hidden. A full-width **Run quality gate** stays fixed at the bottom, including the home-indicator inset. Portrait (about 820px) stacks the form. Landscape (about 1180px) keeps two columns. The guide starts collapsed. |
| Phone, up to 720px | Same sticky control. Run context is one column. Export actions and the sample buttons are full width. Result tabs scroll sideways. The workflow steps stack. |

Open **Show guide** for the four setup steps, the Excel dictionary sequence, and the download cards. After a dictionary audit, **Use as validation config** and **Download compiled config** stay available. Adopting the workbook makes it the active config and clears it from the dataset slot, so the next run checks the CSV extract. Uploading the same workbook as a config audits it and adopts it in one step. Removing the dataset file keeps that compiled schema available.

Result tabs are **Summary**, **Checks**, **Issues**, and **Records**. Filter chips and long field names wrap instead of widening the page. Inputs use a 16px font so iOS does not zoom the page when a field is focused.

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
  dictionary/                # Excel data-dictionary reader, audit, compile
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
