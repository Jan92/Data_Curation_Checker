#!/usr/bin/env node
/**
 * Validate a DCC validation configuration (JSON / YAML / CSV) before dataset runs.
 *
 * Examples:
 *   npm run check:config -- --config ./configs/fhir-lab-v1.json
 *   npm run check:config -- --config ./configs/fhir-lab-v1.yaml
 *   npm run check:config -- --config ./configs/fhir-lab-v1.fields.csv
 *   npm run check:config
 */

import {
  validateValidationConfig,
  hashConfig,
  resolveEffectiveConfig,
  DEFAULT_FHIR_LAB_CONFIG,
  BUILTIN_PLUGINS
} from '../src/app/checks/fhir-observation-checks';
import { argValue, hasFlag, loadConfigFromPath } from './lib/cli-utils';

function printHelp(): void {
  console.log(`Usage: check:config [--config <path>] [--list-plugins]

  --config <path>   JSON, YAML, or CSV validation schema (default: built-in).
  --list-plugins    Print built-in plugin ids and exit.
  --help, -h        Show this help.

Rejects invalid configs with a configuration validation report (exit 1).`);
}

function main(): void {
  const args = process.argv.slice(2);
  if (hasFlag(args, '--help') || hasFlag(args, '-h')) {
    printHelp();
    process.exit(0);
  }
  if (hasFlag(args, '--list-plugins')) {
    console.log(JSON.stringify(BUILTIN_PLUGINS, null, 2));
    process.exit(0);
  }

  const configPath = argValue(args, '--config');
  let config;
  try {
    config = loadConfigFromPath(configPath);
  } catch (err) {
    console.log(
      JSON.stringify(
        {
          ok: false,
          issues: [
            {
              severity: 'error',
              path: configPath ?? '(default)',
              message: err instanceof Error ? err.message : String(err)
            }
          ]
        },
        null,
        2
      )
    );
    process.exit(1);
  }

  const report = validateValidationConfig(config);
  if (report.ok) {
    const effective = resolveEffectiveConfig(config);
    console.log(
      JSON.stringify(
        {
          ok: true,
          id: effective.id,
          version: effective.version,
          hash: effective.hash,
          plugins: effective.snapshot.plugins,
          entities: effective.snapshot.entities.map((e) => e.name),
          formats: effective.snapshot.formats,
          metadataRequirements: effective.snapshot.metadataRequirements,
          issues: report.issues
        },
        null,
        2
      )
    );
    process.exit(0);
  }

  console.log(
    JSON.stringify(
      {
        ok: false,
        hash: hashConfig(config ?? DEFAULT_FHIR_LAB_CONFIG),
        issues: report.issues
      },
      null,
      2
    )
  );
  process.exit(1);
}

main();
