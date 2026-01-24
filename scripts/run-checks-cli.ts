#!/usr/bin/env node
/**
 * CLI to run FHIR Observation checks without the UI.
 * Reads from --file <path> or stdin and prints a ValidationReport as JSON.
 *
 * Examples:
 *   npx ts-node scripts/run-checks-cli.ts --file ./observations.json
 *   cat observations.json | npm run check:cli
 */

import { readFileSync } from 'fs';
import { validateFhirObservations } from '../src/app/checks/fhir-observation-checks';

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf-8');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const fileIdx = args.indexOf('--file');
  let content: string;
  let source = 'stdin';
  let sourceDetail: string | undefined;

  if (fileIdx >= 0 && args[fileIdx + 1]) {
    const filePath = args[fileIdx + 1];
    content = readFileSync(filePath, 'utf-8');
    source = 'File';
    sourceDetail = filePath;
  } else {
    content = await readStdin();
  }

  const report = validateFhirObservations(content, { source, sourceDetail });
  console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
