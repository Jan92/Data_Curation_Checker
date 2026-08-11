/**
 * Load / parse validation configs from JSON, YAML, or CSV text.
 * Shared by CLI scripts and the Angular frontend.
 */

import * as yaml from 'js-yaml';
import type { AliasMapping, EntityFieldRule, EntityRule, ValidationConfig } from '../config/types';
import { DEFAULT_FHIR_LAB_CONFIG } from '../config/default-config';
import { validateValidationConfig } from '../config/validate-config';

export type ConfigSourceKind = 'json' | 'yaml' | 'csv';

export function detectConfigKind(fileName: string): ConfigSourceKind {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.yaml') || lower.endsWith('.yml')) return 'yaml';
  if (lower.endsWith('.csv')) return 'csv';
  return 'json';
}

/**
 * Parse a validation config from file contents.
 * Throws on parse errors; callers should also run validateValidationConfig.
 */
export function parseConfigFromText(text: string, fileName = 'config.json'): ValidationConfig {
  const kind = detectConfigKind(fileName);
  if (kind === 'yaml') {
    const loaded = yaml.load(text);
    if (!loaded || typeof loaded !== 'object') {
      throw new Error('YAML config did not produce an object.');
    }
    return loaded as ValidationConfig;
  }
  if (kind === 'csv') {
    return parseConfigCsv(text, fileName);
  }
  return JSON.parse(text) as ValidationConfig;
}

/** Parse + validate; throws if invalid. */
export function loadAndValidateConfigText(text: string, fileName = 'config.json'): ValidationConfig {
  const config = parseConfigFromText(text, fileName);
  const report = validateValidationConfig(config);
  if (!report.ok) {
    throw new Error(report.issues.map((i) => `${i.path}: ${i.message}`).join('; '));
  }
  return config;
}

/**
 * CSV schema columns:
 * entity,field,required,dataType,allowableValues,severity,regex,aliasOf
 *
 * allowableValues: pipe-separated list.
 * aliasOf: when set, creates an alias mapping from `field` → `aliasOf` (canonical).
 */
export function parseConfigCsv(csvText: string, fileName = 'schema.csv'): ValidationConfig {
  const rows = parseCsvRows(csvText);
  if (!rows.length) {
    throw new Error('CSV config is empty.');
  }
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const idx = (name: string) => header.indexOf(name);
  const requiredCols = ['entity', 'field'];
  for (const col of requiredCols) {
    if (idx(col) < 0) {
      throw new Error(`CSV config missing required column "${col}".`);
    }
  }

  const entityMap = new Map<string, EntityRule>();
  const aliases: AliasMapping[] = [];

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row.length || row.every((c) => !c.trim())) continue;
    const entityName = cell(row, idx('entity'));
    const fieldName = cell(row, idx('field'));
    if (!entityName || !fieldName) continue;

    const required = parseBool(cell(row, idx('required')));
    const dataType = cell(row, idx('datatype')) || undefined;
    const allowableRaw = cell(row, idx('allowablevalues'));
    const severityRaw = cell(row, idx('severity')) || (required ? 'error' : 'warn');
    const regex = cell(row, idx('regex')) || undefined;
    const aliasOf = cell(row, idx('aliasof')) || undefined;

    if (aliasOf) {
      aliases.push({
        from: fieldName,
        to: aliasOf,
        severity: severityRaw === 'error' || severityRaw === 'info' ? severityRaw : 'warn'
      });
      continue;
    }

    let entity = entityMap.get(entityName);
    if (!entity) {
      entity = {
        name: entityName,
        requiredFields: [],
        optionalFields: [],
        fields: []
      };
      entityMap.set(entityName, entity);
    }

    const fieldRule: EntityFieldRule = {
      name: fieldName,
      required,
      dataType,
      allowableValues: allowableRaw
        ? allowableRaw.split('|').map((v) => v.trim()).filter(Boolean)
        : undefined,
      regex,
      severity: severityRaw === 'error' || severityRaw === 'info' ? severityRaw : 'warn'
    };
    entity.fields = entity.fields ?? [];
    entity.fields.push(fieldRule);
    if (required) {
      entity.requiredFields = [...new Set([...(entity.requiredFields ?? []), fieldName])];
    } else {
      entity.optionalFields = [...new Set([...(entity.optionalFields ?? []), fieldName])];
    }
  }

  const baseName = fileName.replace(/\.[^.]+$/, '') || 'csv-schema';
  const config: ValidationConfig = {
    id: baseName,
    version: '1.0.0',
    name: `CSV schema (${baseName})`,
    description: 'Validation schema imported from CSV field definitions.',
    formats: ['json', 'ndjson', 'fhir-bundle', 'fhir-array', 'fhir-resource', 'csv'],
    entities: [...entityMap.values()],
    metadataRequirements: [...DEFAULT_FHIR_LAB_CONFIG.metadataRequirements],
    plugins: [
      'fhir-observation',
      'fhir-diagnostic-report',
      'laboratory-loinc',
      'cross-references',
      'primary-keys',
      'datetime-formats',
      'vocabulary',
      'completeness',
      'identifier-format',
      'config-entity-rules',
      'metadata-requirements',
      'expected-files',
      'reproducibility'
    ],
    aliases: aliases.length ? aliases : undefined,
    failOnError: true,
    failOnWarn: false
  };
  return config;
}

function cell(row: string[], index: number): string {
  if (index < 0 || index >= row.length) return '';
  return (row[index] ?? '').trim();
}

function parseBool(value: string): boolean {
  const v = value.toLowerCase();
  return v === 'true' || v === '1' || v === 'yes' || v === 'y';
}

/** Minimal RFC4180-ish CSV parser (quoted fields, commas, newlines). */
export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ',') {
      row.push(field);
      field = '';
      continue;
    }
    if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      continue;
    }
    if (ch === '\r') continue;
    field += ch;
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
