#!/usr/bin/env node
/**
 * Data Curation Checker CLI — validate FHIR datasets with a versioned config.
 *
 * Examples:
 *   npm run check:cli -- --file ./data.json
 *   npm run check:cli -- --file ./a.json --file ./b.json --format md --out report.md
 *   npm run check:cli -- --dir ./datasets --config ./configs/fhir-lab-v1.yaml --gate-exit
 *   npm run check:cli -- --file ./data.json --dataset-id CAD-001 --source-site local-lab --mode local
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve, basename, dirname, join } from 'path';
import {
  runDataCurationCheck,
  formatReport,
  reportFileExtension,
  type ValidationMode,
  type DccRunReport
} from '../src/app/checks/fhir-observation-checks';
import {
  argValue,
  argValues,
  hasFlag,
  loadConfigFromPath,
  collectInputFiles,
  readStdin
} from './lib/cli-utils';

function printHelp(): void {
  console.log(`Usage: check:cli [options]

Input:
  --file <path>          Dataset file (.json / .ndjson / .txt). Repeatable.
  --dir <path>           Validate all .json/.ndjson/.txt files in a directory.
  (stdin)                Used when no --file/--dir is given.

Config / context:
  --config <path>        Validation config (.json / .yaml / .csv). Default: built-in fhir-lab-v1.
  --dataset-id <id>      Dataset identifier (default: file name or stdin-dataset).
  --source-site <site>   Source / site (default: local).
  --mode <mode>          local | batch | interactive (default: batch).
  --timeframe <text>     Optional timeframe label.
  --license <text>       Optional license metadata.
  --provenance <text>    Optional provenance metadata.
  --fail-on-warn         Treat warnings as gate FAIL for this run.

Output:
  --format <fmt>         json | md | html (default: json).
  --out <path>           Write report to path (for multi-file: used as directory prefix).
  --gate-exit            Exit code 2 when any run gate is FAIL.
  --help, -h             Show this help.

The same check engine is used by the web UI (runDataCurationCheck).`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (hasFlag(args, '--help') || hasFlag(args, '-h')) {
    printHelp();
    process.exit(0);
  }

  const fileArgs = argValues(args, '--file');
  const dirArg = argValue(args, '--dir');
  const configPath = argValue(args, '--config');
  const format = argValue(args, '--format') ?? 'json';
  const outPath = argValue(args, '--out');
  const datasetId = argValue(args, '--dataset-id');
  const sourceSite = argValue(args, '--source-site');
  const mode = (argValue(args, '--mode') as ValidationMode | undefined) ?? 'batch';
  const timeframe = argValue(args, '--timeframe');
  const license = argValue(args, '--license');
  const provenance = argValue(args, '--provenance');
  const gateExit = hasFlag(args, '--gate-exit');
  const failOnWarn = hasFlag(args, '--fail-on-warn');

  const config = loadConfigFromPath(configPath);
  if (failOnWarn) {
    config.failOnWarn = true;
  }

  const inputFiles = collectInputFiles(fileArgs, dirArg);
  const reports: DccRunReport[] = [];

  if (!inputFiles.length) {
    const content = await readStdin();
    const report = runDataCurationCheck(content, {
      source: 'stdin',
      config,
      runContext: {
        datasetId: datasetId ?? 'stdin-dataset',
        sourceSite: sourceSite ?? 'local',
        mode,
        timeframe,
        license,
        provenance,
        inputFiles: [],
        schemaVersion: config.version
      }
    });
    reports.push(report);
    emitReports(reports, format, outPath, gateExit);
    return;
  }

  for (const filePath of inputFiles) {
    const content = readFileSync(filePath, 'utf-8');
    const report = runDataCurationCheck(content, {
      source: 'File',
      sourceDetail: filePath,
      config,
      runContext: {
        datasetId: datasetId ?? basename(filePath),
        sourceSite: sourceSite ?? 'local',
        mode: inputFiles.length > 1 ? 'batch' : mode,
        timeframe,
        license,
        provenance,
        inputFiles: [filePath],
        schemaVersion: config.version
      }
    });
    reports.push(report);
  }

  emitReports(reports, format, outPath, gateExit);
}

function emitReports(
  reports: DccRunReport[],
  format: string,
  outPath: string | undefined,
  gateExit: boolean
): void {
  if (reports.length === 1) {
    const output = formatReport(reports[0], format);
    if (outPath) {
      writeFileSync(resolve(outPath), output, 'utf-8');
      console.error(`Wrote report to ${outPath} (gate=${reports[0].gate})`);
    } else {
      console.log(output);
    }
  } else {
    const summary = {
      runs: reports.length,
      pass: reports.filter((r) => r.gate === 'PASS').length,
      fail: reports.filter((r) => r.gate === 'FAIL').length,
      results: reports.map((r) => ({
        datasetId: r.runContext.datasetId,
        gate: r.gate,
        errors: r.summary.errorCount,
        warnings: r.summary.warnCount,
        inputFiles: r.runContext.inputFiles
      }))
    };

    if (outPath) {
      const outDir = resolve(outPath);
      mkdirSync(outDir, { recursive: true });
      writeFileSync(join(outDir, 'batch-summary.json'), JSON.stringify(summary, null, 2), 'utf-8');
      const ext = reportFileExtension(format);
      reports.forEach((r, i) => {
        const name = `${String(i + 1).padStart(3, '0')}-${r.runContext.datasetId}.${ext}`;
        writeFileSync(join(outDir, name), formatReport(r, format), 'utf-8');
      });
      console.error(`Wrote ${reports.length} reports + batch-summary.json to ${outDir}`);
    } else if (format === 'json') {
      console.log(JSON.stringify({ summary, reports }, null, 2));
    } else {
      console.log(reports.map((r) => formatReport(r, format)).join('\n\n---\n\n'));
    }
    console.error(
      `Batch: ${summary.pass} PASS, ${summary.fail} FAIL (of ${summary.runs})`
    );
  }

  if (gateExit && reports.some((r) => r.gate === 'FAIL')) {
    process.exit(2);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
