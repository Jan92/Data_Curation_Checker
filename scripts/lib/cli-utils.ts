/**
 * Shared helpers for Node CLI scripts (config loading, arg parsing, file discovery).
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { resolve, basename, extname, join } from 'path';
import {
  DEFAULT_FHIR_LAB_CONFIG,
  loadAndValidateConfigText,
  type ValidationConfig
} from '../../src/app/checks/fhir-observation-checks';

export function argValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : undefined;
}

export function argValues(args: string[], name: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name && args[i + 1]) {
      values.push(args[i + 1]);
      i++;
    }
  }
  return values;
}

export function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

export function loadConfigFromPath(path?: string): ValidationConfig {
  if (!path) return DEFAULT_FHIR_LAB_CONFIG;
  const abs = resolve(path);
  const raw = readFileSync(abs, 'utf-8');
  return loadAndValidateConfigText(raw, basename(abs));
}

export function collectInputFiles(fileArgs: string[], dirArg?: string): string[] {
  const files: string[] = [];
  for (const f of fileArgs) {
    files.push(resolve(f));
  }
  if (dirArg) {
    const dir = resolve(dirArg);
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (!statSync(full).isFile()) continue;
      const ext = extname(name).toLowerCase();
      if (['.json', '.ndjson', '.txt'].includes(ext)) {
        files.push(full);
      }
    }
  }
  return [...new Set(files)];
}

export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf-8');
}
