#!/usr/bin/env node
/**
 * Validate a DCC validation configuration (YAML/JSON) before dataset runs (D1.6).
 *
 * Examples:
 *   npm run check:config -- --config ./configs/fhir-lab-v1.json
 *   npm run check:config -- --config ./configs/fhir-lab-v1.yaml
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  validateValidationConfig,
  hashConfig,
  resolveEffectiveConfig,
  DEFAULT_FHIR_LAB_CONFIG
} from '../src/app/checks/fhir-observation-checks';
import type { ValidationConfig } from '../src/app/checks/config/types';

function argValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : undefined;
}

function loadConfig(path?: string): ValidationConfig {
  if (!path) return DEFAULT_FHIR_LAB_CONFIG;
  const abs = resolve(path);
  const raw = readFileSync(abs, 'utf-8');
  if (abs.endsWith('.yaml') || abs.endsWith('.yml')) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const yaml = require('js-yaml') as { load: (s: string) => unknown };
      return yaml.load(raw) as ValidationConfig;
    } catch {
      const jsonSibling = abs.replace(/\.ya?ml$/i, '.json');
      return JSON.parse(readFileSync(jsonSibling, 'utf-8')) as ValidationConfig;
    }
  }
  return JSON.parse(raw) as ValidationConfig;
}

function main(): void {
  const args = process.argv.slice(2);
  const configPath = argValue(args, '--config');
  const config = loadConfig(configPath);
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
        hash: hashConfig(config),
        issues: report.issues
      },
      null,
      2
    )
  );
  process.exit(1);
}

main();
