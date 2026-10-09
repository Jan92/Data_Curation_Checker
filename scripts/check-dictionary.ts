#!/usr/bin/env node
/**
 * Checks the synthetic Excel data-dictionary fixtures, then prints a short
 * summary for any extra workbook paths passed on the command line.
 *
 *   npm run check:dictionary
 *   npm run check:dictionary -- --file /path/to/dictionary.xlsx
 */

import { readFileSync } from 'fs';
import { basename, resolve } from 'path';
import {
  auditDataDictionary,
  compileDictionaryWorkbook,
  parseDataDictionary,
  runDataCurationCheck,
  runDictionaryWorkbookCheck,
  validateValidationConfig
} from '../src/app/checks/fhir-observation-checks';
import { compileDataDictionary } from '../src/app/checks/dictionary/compile-config';
import type { DataDictionaryDocument, DictionaryField, DictionaryValueToken } from '../src/app/checks/dictionary/types';
import { argValues } from './lib/cli-utils';

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

function load(relativePath: string): Uint8Array {
  return new Uint8Array(readFileSync(resolve(relativePath)));
}

function checkDemo(): void {
  const fileName = 'dictionary-demo.xlsx';
  const bytes = load('configs/samples/dictionary-demo.xlsx');
  const document = parseDataDictionary(bytes, fileName);
  assert(document.fields.length === 6, `demo field count ${document.fields.length}, expected 6`);
  assert(
    document.fields.some((field) => field.name === 'Enrolment date' && field.category === 'Screening'),
    'demo did not read the merged Screening category'
  );
  assert(document.sheets.some((sheet) => sheet.role === 'value-list'), 'demo side sheet was not classified as a value list');

  const report = runDictionaryWorkbookCheck(bytes, fileName, {
    runContext: { datasetId: 'demo', sourceSite: 'fixture', mode: 'batch', inputFiles: [fileName] }
  });
  assert(report.gate === 'FAIL', `demo gate ${report.gate}, expected FAIL`);
  const codes = new Set(report.issues.map((issue) => issue.code));
  for (const code of [
    'DICT_DATE_ORDER_CONFLICT',
    'DICT_DATE_SEPARATOR',
    'DICT_DUPLICATE_FIELD',
    'DICT_REQUIRED_ALLOWS_NULL',
    'DICT_OBSERVED_OUTSIDE_RANGE',
    'DICT_OBSERVED_NOT_IN_DOMAIN',
    'DICT_UNBOUNDED_TEXT',
    'DICT_FIELD_WHITESPACE',
    'DICT_BOOLEAN_AS_CATEGORICAL',
    'DICT_COMPANION_DRIFT'
  ]) {
    assert(codes.has(code), `demo is missing ${code}`);
  }
  assert(!report.issues.some((issue) => issue.severity === 'error' && issue.code === 'DICT_NO_FIELDS'), 'demo failed to parse');
}

function checkClean(): void {
  const fileName = 'dictionary-clean.xlsx';
  const bytes = load('configs/samples/dictionary-clean.xlsx');
  const report = runDictionaryWorkbookCheck(bytes, fileName, {
    runContext: { datasetId: 'clean', sourceSite: 'fixture', mode: 'batch', inputFiles: [fileName] }
  });
  assert(report.gate === 'PASS', `clean gate ${report.gate}, expected PASS`);
  assert(
    report.issues.some((issue) => issue.code === 'DICT_UNBOUNDED_TEXT'),
    'clean workbook should warn about empty VARCHAR( )'
  );
  assert(!report.issues.some((issue) => issue.severity === 'error'), 'clean workbook has a blocking finding');

  const { config, document } = compileDictionaryWorkbook(bytes, fileName);
  const validation = validateValidationConfig(config);
  assert(validation.ok, `compiled config invalid: ${validation.issues.map((i) => i.message).join('; ')}`);
  assert(document.fields.length === 3, `clean field count ${document.fields.length}`);
  const age = config.entities.flatMap((entity) => entity.fields ?? []).find((field) => field.name === 'Subject age');
  assert(age?.min === 0 && age.max === 120 && age.dataType === 'integer', 'Subject age range was not compiled');
  const visit = config.entities.flatMap((entity) => entity.fields ?? []).find((field) => field.name === 'Visit date');
  assert(visit?.dateTimePattern === 'MM-DD-YYYY', `Visit date pattern ${visit?.dateTimePattern}`);

  const good = runDataCurationCheck(
    JSON.stringify({
      'cohort.csv': 'Subject age,Site code\n30,A\n',
      'follow_up.csv': 'Visit date\n01-15-2020\n'
    }),
    {
      config,
      runContext: {
        datasetId: 'clean-extract',
        sourceSite: 'fixture',
        mode: 'batch',
        inputFiles: ['cohort.csv', 'follow_up.csv'],
        schemaVersion: config.version
      }
    }
  );
  assert(good.gate === 'PASS', `clean extract gate ${good.gate}: ${good.issues.filter((i) => i.severity === 'error').map((i) => i.detail).join(' | ')}`);

  const bad = runDataCurationCheck(
    JSON.stringify({
      'cohort.csv': 'Subject age,Site code\n200,A\n',
      'follow_up.csv': 'Visit date\n01-15-2020\n'
    }),
    {
      config,
      runContext: {
        datasetId: 'bad-extract',
        sourceSite: 'fixture',
        mode: 'batch',
        inputFiles: ['cohort.csv', 'follow_up.csv'],
        schemaVersion: config.version
      }
    }
  );
  assert(bad.gate === 'FAIL', 'age 200 should fail the compiled range');
  assert(bad.issues.some((issue) => issue.code === 'VALUE_OUTSIDE_RANGE'), 'missing VALUE_OUTSIDE_RANGE');
}

function token(raw: string): DictionaryValueToken {
  const key = raw.trim().toLowerCase();
  return { raw, key, keys: [key], forms: [raw] };
}

function field(overrides: Partial<DictionaryField>): DictionaryField {
  return {
    sheet: 'Data Dictionary',
    rowNumber: 2,
    category: 'Cohort',
    name: 'Field',
    rawName: 'Field',
    description: 'A field',
    dataType: 'Categorical',
    format: 'VARCHAR(20)',
    units: '',
    defaultValue: '',
    required: false,
    requiredRaw: 'No',
    acceptsNull: true,
    acceptsNullRaw: 'Yes',
    scalarType: 'code',
    acceptable: { kind: 'empty', tokens: [] },
    observed: { kind: 'empty', tokens: [] },
    acceptableRaw: '',
    observedRaw: '',
    ...overrides
  };
}

function checkCompiledPolicies(): void {
  const document: DataDictionaryDocument = {
    fileName: 'rules-v2.xlsx',
    sheets: [{ name: 'Data Dictionary', role: 'dictionary', detail: 'synthetic' }],
    fields: [
      field({
        name: 'Consent',
        rawName: 'Consent',
        dataType: 'Categorical',
        format: 'Boolean, Values: Yes/No',
        required: true,
        requiredRaw: 'Yes',
        acceptsNull: false,
        acceptsNullRaw: 'No',
        scalarType: 'boolean',
        acceptable: { kind: 'enumerated', tokens: [token('Yes'), token('No')] },
        acceptableRaw: 'Yes\nNo'
      }),
      field({
        rowNumber: 3,
        name: 'Site code',
        rawName: 'Site code',
        acceptsNull: false,
        acceptsNullRaw: 'No',
        acceptable: { kind: 'enumerated', tokens: [token('A')] },
        acceptableRaw: 'A',
        defaultValue: 'Z'
      }),
      field({
        rowNumber: 4,
        name: 'Visit date',
        rawName: 'Visit date',
        dataType: 'Date',
        format: 'MM-DD-YYYY',
        required: true,
        requiredRaw: 'Yes',
        acceptsNull: false,
        acceptsNullRaw: 'No',
        scalarType: 'date',
        acceptable: {
          kind: 'prose',
          tokens: [],
          yearSpan: { from: 2015, to: 2018, openEnded: false, raw: '2015-2018' }
        },
        acceptableRaw: '2015-2018'
      }),
      field({
        rowNumber: 5,
        name: 'Follow up date',
        rawName: 'Follow up date',
        dataType: 'Date',
        format: 'MM-DD-YYYY',
        scalarType: 'date',
        acceptable: {
          kind: 'prose',
          tokens: [],
          yearSpan: { from: 2015, openEnded: true, raw: '2015-Present' }
        },
        acceptableRaw: '2015-Present'
      })
    ]
  };

  const audited = auditDataDictionary(document);
  assert(
    audited.some((issue) => issue.code === 'DICT_DEFAULT_NOT_IN_DOMAIN' && issue.field === 'Site code'),
    'default outside the code list should use DICT_DEFAULT_NOT_IN_DOMAIN'
  );

  const config = compileDataDictionary(document);
  const rules = config.entities.flatMap((entity) => entity.fields ?? []);
  const site = rules.find((rule) => rule.name === 'Site code');
  const visit = rules.find((rule) => rule.name === 'Visit date');
  const follow = rules.find((rule) => rule.name === 'Follow up date');
  assert(site?.allowNull === false, 'Site code should forbid null');
  assert(visit?.yearFrom === 2015 && visit.yearTo === 2018 && visit.dateTimePattern === 'MM-DD-YYYY', 'visit year window was not compiled');
  assert(follow?.yearFrom === 2015 && follow.yearTo == null, 'open year window should not set yearTo');

  const run = (csv: string) =>
    runDataCurationCheck(JSON.stringify({ 'cohort.csv': csv }), {
      config,
      runContext: {
        datasetId: 'policy',
        sourceSite: 'fixture',
        mode: 'batch',
        inputFiles: ['cohort.csv'],
        schemaVersion: config.version
      }
    });

  const header = 'Consent,Site code,Visit date,Follow up date\n';
  const good = run(`${header}Y,A,01-15-2016,01-15-2030\n`);
  assert(good.gate === 'PASS', `boolean Y and open year failed: ${good.issues.map((i) => i.code).join(',')}`);
  assert(!good.issues.some((issue) => issue.code === 'VALUE_NOT_ALLOWED'), 'Y was rejected as not allowable');

  const synonym = run(`${header}true,A,01-15-2016,01-15-2016\n`);
  assert(synonym.gate === 'PASS', `boolean true failed: ${synonym.issues.map((i) => `${i.code} ${i.detail}`).join(' | ')}`);

  const empty = run(`${header}Y,,01-15-2016,01-15-2016\n`);
  assert(empty.gate === 'PASS', 'optional empty cell should warn, not fail the gate');
  assert(empty.issues.some((issue) => issue.code === 'NULL_NOT_ALLOWED'), 'missing NULL_NOT_ALLOWED');

  const early = run(`${header}Y,A,01-15-2014,01-15-2016\n`);
  assert(early.gate === 'FAIL', '2014 should fail the year window');
  assert(early.issues.some((issue) => issue.code === 'VALUE_OUTSIDE_RANGE' && issue.field === 'Visit date'), 'missing year VALUE_OUTSIDE_RANGE');

  const word = run(`${header}Maybe,A,01-15-2016,01-15-2016\n`);
  assert(word.issues.some((issue) => issue.code === 'DATATYPE_BOOLEAN'), 'Maybe should fail the boolean type');
}

function summarise(filePath: string): void {
  const bytes = new Uint8Array(readFileSync(filePath));
  const name = basename(filePath);
  const document = parseDataDictionary(bytes, name);
  const issues = auditDataDictionary(document);
  const categories = [...new Set(document.fields.map((field) => field.category))];
  const tally = new Map<string, number>();
  for (const issue of issues) {
    if (!issue.code || issue.severity === 'ok') continue;
    tally.set(issue.code, (tally.get(issue.code) ?? 0) + 1);
  }
  console.log(`\n${name}`);
  console.log(`  sheets: ${document.sheets.map((sheet) => `${sheet.name} [${sheet.role}]`).join(', ')}`);
  console.log(`  fields: ${document.fields.length}; categories: ${categories.join(', ') || '(none)'}`);
  console.log(
    `  findings: ${issues.filter((i) => i.severity === 'error').length} errors, ${
      issues.filter((i) => i.severity === 'warn').length
    } warnings`
  );
  for (const [code, count] of [...tally.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${count.toString().padStart(3)}  ${code}`);
  }
}

function main(): void {
  checkDemo();
  checkClean();
  checkCompiledPolicies();
  console.log('Dictionary fixtures passed.');
  const extras = argValues(process.argv.slice(2), '--file');
  for (const filePath of extras) summarise(resolve(filePath));
}

main();
