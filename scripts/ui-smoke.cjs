/**
 * UI smoke verification against local Angular dev server.
 * Run: node scripts/ui-smoke.cjs
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = process.env.DCC_URL || 'http://127.0.0.1:4200/';
const OUT = path.join(__dirname, '..', '.ui-smoke');

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  page.setDefaultTimeout(10000);
  const failures = [];

  const assert = (cond, label) => {
    if (!cond) failures.push(label);
    console.log(cond ? `PASS  ${label}` : `FAIL  ${label}`);
  };

  // --- Screen 1: empty / initial ---
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('h1');
  await page.waitForSelector('button.primary');
  await page.screenshot({ path: path.join(OUT, '01-empty.png'), fullPage: true });
  assert((await page.locator('h1').innerText()).trim() === 'Data Curation Checker', 'Empty: title');
  assert((await page.locator('.status').innerText()).includes('Add a file or paste FHIR data'), 'Empty: status hint');
  assert(await page.locator('button.primary').isDisabled(), 'Empty: run disabled');
  assert((await page.getByText('Active validation config').count()) > 0, 'Empty: config card');
  assert((await page.getByText('3. DCC quality gate').count()) > 0, 'Empty: workflow strip');

  // --- Screen 2: load example + run ---
  await page.locator('button.demo-button').click();
  await page.waitForTimeout(250);
  assert(await page.locator('button.primary').isEnabled(), 'Example: run enabled');
  await page.locator('input[placeholder="e.g. CAD-001"]').fill('CAD-SMOKE-001');
  await page.locator('input[placeholder="e.g. local-lab / site-01"]').fill('local-lab');
  await page.screenshot({ path: path.join(OUT, '02-example-loaded.png'), fullPage: true });

  await page.locator('button.primary').click();
  await page.waitForSelector('.gate-banner', { timeout: 20000 });
  await page.screenshot({ path: path.join(OUT, '03-after-run.png'), fullPage: true });

  const gateText = (await page.locator('.gate-value').innerText()).trim();
  assert(gateText === 'PASS' || gateText === 'FAIL', `Gate shows ${gateText}`);
  assert((await page.locator('.result-tabs .tab').count()) === 4, 'Tabs: four result tabs');
  assert((await page.locator('.metrics-grid .metric').count()) >= 5, 'Summary: metrics visible');

  // --- Screen 3: Checks tab ---
  await page.locator('.result-tabs .tab', { hasText: 'Checks' }).click();
  await page.waitForSelector('.results .result');
  await page.screenshot({ path: path.join(OUT, '04-checks-tab.png'), fullPage: true });
  assert((await page.locator('.results .result').count()) > 0, 'Checks: result rows');

  // --- Screen 4: Issues tab + filters ---
  await page.locator('.result-tabs .tab', { hasText: 'Issues' }).click();
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(OUT, '05-issues-tab.png'), fullPage: true });
  const hasFilters = (await page.locator('.filter-row .chip').count()) > 0;
  const noIssues = (await page.getByText(/No issues detected/i).count()) > 0;
  assert(hasFilters || noIssues, 'Issues: list or empty success');
  if (hasFilters) {
    await page.locator('.chip', { hasText: 'Errors' }).click();
    await page.waitForTimeout(120);
    await page.screenshot({ path: path.join(OUT, '06-issues-errors-filter.png'), fullPage: true });
    await page.locator('.chip', { hasText: 'Warnings' }).click();
    await page.waitForTimeout(120);
    await page.screenshot({ path: path.join(OUT, '07-issues-warn-filter.png'), fullPage: true });
  }

  // --- Screen 5: Records tab ---
  await page.locator('.result-tabs .tab', { hasText: 'Records' }).click();
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(OUT, '08-records-tab.png'), fullPage: true });
  assert(
    (await page.locator('.record-list .record').count()) > 0 ||
      (await page.getByText(/No record-level findings/i).count()) > 0,
    'Records: findings or empty'
  );

  // --- Screen 6: exports ---
  assert((await page.locator('button.secondary', { hasText: 'Export JSON' }).count()) > 0, 'Export JSON');
  assert((await page.locator('button.secondary', { hasText: 'Export Markdown' }).count()) > 0, 'Export Markdown');
  assert((await page.locator('button.secondary', { hasText: 'Export HTML' }).count()) > 0, 'Export HTML');
  assert((await page.locator('button.secondary', { hasText: 'Print / PDF' }).count()) > 0, 'Print/PDF');

  // --- Screen 7: invalid input → FAIL ---
  await page.locator('textarea').fill('{ not-json');
  await page.locator('button.primary').click();
  await page.waitForSelector('.gate-banner.gate-fail, .error-banner, .badge.error', { timeout: 20000 });
  await page.screenshot({ path: path.join(OUT, '09-invalid-input.png'), fullPage: true });
  assert(
    (await page.locator('.gate-fail, .error-banner, .badge.error').count()) > 0,
    'Invalid input: FAIL or error shown'
  );

  // --- Screen 8: config upload ---
  const configPath = path.join(__dirname, '..', 'configs', 'fhir-lab-v1.json');
  await page.setInputFiles('input[aria-label="Upload validation configuration JSON"]', configPath);
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, '10-config-loaded.png'), fullPage: true });
  assert((await page.getByText(/fhir-lab-v1\.json/i).count()) > 0, 'Config: uploaded filename shown');

  // --- Screen 9: download sample ---
  assert(await page.locator('button.link', { hasText: 'Download Sample file' }).isEnabled(), 'Download sample enabled');

  // --- Screen 10: reset config ---
  await page.locator('button.link', { hasText: 'Reset to built-in' }).click();
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(OUT, '11-config-reset.png'), fullPage: true });
  assert((await page.getByText('Built-in fhir-lab-v1').count()) > 0, 'Config: reset to built-in');

  await browser.close();

  console.log('\n---');
  if (failures.length) {
    console.error(`${failures.length} failure(s):`);
    failures.forEach((f) => console.error(' - ' + f));
    process.exit(1);
  }
  console.log('All UI smoke checks passed. Screenshots in .ui-smoke/');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
