#!/usr/bin/env node
/**
 * SEARCH Data Curation Checker CLI (D1.6 §4.2.3 — medicalvalues).
 *
 * Reads FHIR JSON/NDJSON from --file or stdin, applies a versioned validation
 * config, and prints a machine-readable DCC run report (JSON) and optionally Markdown.
 *
 * Examples:
 *   npm run check:cli -- --file ./data.json
 *   npm run check:cli -- --file ./data.json --config ./configs/fhir-lab-v1.json --format md
 *   npm run check:cli -- --file ./data.json --dataset-id CAD-001 --source-site HYGEIA --mode local
 */

import { readFileSync, writeFileSync } from 'fs';
import { resolve, basename } from 'path';
import {
  runDataCurationCheck,
  formatReportAsMarkdown,
  formatReportAsHtml,
  resolveEffectiveConfig,
  DEFAULT_FHIR_LAB_CONFIG
} from '../src/app/checks/fhir-observation-checks';
import type { ValidationConfig, ValidationMode } from '../src/app/checks/config/types';

function argValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : undefined;
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf-8');
}

function loadConfig(path?: string): ValidationConfig {
  if (!path) return DEFAULT_FHIR_LAB_CONFIG;
  const abs = resolve(path);
  const raw = readFileSync(abs, 'utf-8');
  if (abs.endsWith('.yaml') || abs.endsWith('.yml')) {
    // Lightweight YAML subset via JSON after stripping comments is not enough;
    // prefer companion .json, or parse with a minimal key: value loader for our configs.
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const yaml = require('js-yaml') as { load: (s: string) => unknown };
      return yaml.load(raw) as ValidationConfig;
    } catch {
      const jsonSibling = abs.replace(/\.ya?ml$/i, '.json');
      try {
        return JSON.parse(readFileSync(jsonSibling, 'utf-8')) as ValidationConfig;
      } catch {
        throw new Error(
          `Cannot parse YAML config at ${abs}. Install js-yaml or use the JSON config: ${jsonSibling}`
        );
      }
    }
  }
  return JSON.parse(raw) as ValidationConfig;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (hasFlag(args, '--help') || hasFlag(args, '-h')) {
    console.log(`Usage: check:cli [--file <path>] [--config <path>] [--format json|md|html]
  [--dataset-id <id>] [--source-site <site>] [--mode local|batch|interactive]
  [--timeframe <text>] [--out <path>] [--gate-exit]

Reads from --file or stdin. Prints DCC run report as JSON (default), Markdown, or HTML.`);
    process.exit(0);
  }

  const filePath = argValue(args, '--file');
  const configPath = argValue(args, '--config');
  const format = (argValue(args, '--format') ?? 'json').toLowerCase();
  const outPath = argValue(args, '--out');
  const datasetId = argValue(args, '--dataset-id');
  const sourceSite = argValue(args, '--source-site');
  const mode = (argValue(args, '--mode') as ValidationMode | undefined) ?? 'batch';
  const timeframe = argValue(args, '--timeframe');
  const gateExit = hasFlag(args, '--gate-exit');

  let content: string;
  let source = 'stdin';
  let sourceDetail: string | undefined;

  if (filePath) {
    content = readFileSync(resolve(filePath), 'utf-8');
    source = 'File';
    sourceDetail = filePath;
  } else {
    content = await readStdin();
  }

  const config = loadConfig(configPath);
  // Validate config early (throws on invalid)
  resolveEffectiveConfig(config);

  const report = runDataCurationCheck(content, {
    source,
    sourceDetail,
    config,
    runContext: {
      datasetId: datasetId ?? (filePath ? basename(filePath) : 'stdin-dataset'),
      sourceSite: sourceSite ?? 'local',
      mode,
      timeframe,
      inputFiles: filePath ? [filePath] : [],
      schemaVersion: config.version
    }
  });

  const output =
    format === 'md' || format === 'markdown'
      ? formatReportAsMarkdown(report)
      : format === 'html' || format === 'htm'
        ? formatReportAsHtml(report)
        : JSON.stringify(report, null, 2);

  if (outPath) {
    writeFileSync(resolve(outPath), output, 'utf-8');
    console.error(`Wrote report to ${outPath} (gate=${report.gate})`);
  } else {
    console.log(output);
  }

  if (gateExit && report.gate === 'FAIL') {
    process.exit(2);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
