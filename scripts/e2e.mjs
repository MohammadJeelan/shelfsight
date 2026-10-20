// E2E: mocks the Gemini API (no real key/calls), runs a full audit, checks scoring, history, manual mode, error states.
import { chromium } from 'playwright-core';
import fs from 'fs';
const BASE = process.env.BASE || 'http://127.0.0.1:4174';
fs.mkdirSync('shots', { recursive: true });
const ANSWERS = [
  'For oily skin in India, dermatologists often suggest Cetaphil Oily Skin Cleanser, Minimalist 2% Salicylic Acid Face Wash, and CeraVe Foaming Cleanser (see nykaa.com reviews).',
  'Good value picks: The Derma Co 1% Salicylic face wash and Minimalist. Cetaphil is pricier.',
  'Most trusted: CeraVe and Cetaphil, both widely reviewed on amazon.in.',
  'Premium: CeraVe Foaming Cleanser is worth it. Cetaphil is a safe classic.',
];
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
const errors = []; page.on('pageerror', e => errors.push(e.message));
let n = 0, fail = false;
await page.route('https://generativelanguage.googleapis.com/**', async route => {
  const body = route.request().postDataJSON(); const p = body.contents[0].parts[0].text;
  if (route.request().headers()['x-goog-api-key'] !== 'TEST-KEY-not-real') return route.fulfill({ status: 400, json: { error: { message: 'API key not valid' } } });
  if (fail) return route.fulfill({ status: 429, json: { error: { message: 'Quota exceeded' } } });
  await new Promise(r => setTimeout(r, 150));
  if (p.startsWith('List 8')) return route.fulfill({ json: { candidates: [{ content: { parts: [{ text: 'What face wash is best for oily acne-prone skin?\nCheap face wash that actually controls oil\nWhich face wash do dermatologists trust?\nIs an expensive face wash worth it for oily skin?' }] } }] } });
  return route.fulfill({ json: { candidates: [{ content: { parts: [{ text: ANSWERS[n++ % 4] }] } }] } });
});
const ok = m => console.log('OK ', m);
await page.goto(BASE); await page.screenshot({ path: 'shots/01-home.png', fullPage: true });
await page.getByTestId('run').click();
await page.getByTestId('error').waitFor(); ok('validation: ' + await page.getByTestId('error').innerText());
await page.getByTestId('category').fill('face wash for oily skin');
await page.getByTestId('brand').fill('Minimalist | be minimalist');
await page.getByTestId('competitors').fill('Cetaphil\nCeraVe\nThe Derma Co | dermaco');
await page.getByTestId('suggest').click(); // no key -> built-in prompts
await page.locator('.prow').first().waitFor(); ok('built-in prompts: ' + await page.locator('.prow').count());
await page.getByTestId('run').click(); await page.locator('.panel').waitFor(); ok('missing key opens settings');
await page.getByTestId('api-key').fill('TEST-KEY-not-real'); await page.getByTestId('save-settings').click();
await page.getByTestId('suggest').click(); await page.waitForFunction(() => document.querySelectorAll('.prow').length === 4); ok('LLM-suggested prompts: 4');
await page.screenshot({ path: 'shots/02-setup.png', fullPage: true });
await page.getByTestId('run').click(); await page.getByTestId('running').waitFor();
await page.screenshot({ path: 'shots/03-running.png' });
await page.getByTestId('report').waitFor();
const inc = await page.getByTestId('inclusion').innerText();
if (inc !== '50%') throw new Error('inclusion expected 50%, got ' + inc); ok('inclusion 50% (2 of 4)');
if ((await page.locator('[data-testid=gaps] li').count()) !== 2) throw new Error('gaps'); ok('2 gap prompts listed');
await page.locator('.ahead').first().click();
await page.screenshot({ path: 'shots/04-report.png', fullPage: true });
const dl = page.waitForEvent('download'); await page.getByTestId('csv').click(); ok('CSV: ' + (await dl).suggestedFilename());
// second run -> trend; then a failing run -> error state
await page.goto(BASE + '/#/'); await page.getByTestId('category').fill('face wash for oily skin'); await page.getByTestId('brand').fill('Minimalist');
await page.getByTestId('competitors').fill('Cetaphil\nCeraVe'); await page.getByTestId('suggest').click(); await page.waitForFunction(() => document.querySelectorAll('.prow').length === 4);
await page.getByTestId('run').click(); await page.getByTestId('report').waitFor(); ok('trend has 2 runs: ' + (await page.locator('.spark circle').count()));
await page.goto(BASE + '/#/'); fail = true;
await page.getByTestId('category').fill('face wash'); await page.getByTestId('brand').fill('Minimalist'); await page.getByTestId('competitors').fill('Cetaphil');
await page.locator('.prompts button').first().click(); fail = true; await page.waitForTimeout(400);
await page.getByTestId('run').click(); await page.getByTestId('error').waitFor({ timeout: 10000 }); ok('API failure shown: ' + await page.getByTestId('error').innerText());
fail = false;
await page.goto(BASE + '/#/history'); await page.screenshot({ path: 'shots/05-ledger.png', fullPage: true }); ok('ledger rows: ' + await page.locator('.board tr').count());
// manual mode
await page.goto(BASE + '/#/'); await page.getByTestId('open-settings').click(); await page.locator('.seg label', { hasText: 'Paste answers' }).click(); await page.getByTestId('save-settings').click();
await page.getByTestId('category').fill('face wash'); await page.getByTestId('brand').fill('Minimalist'); await page.getByTestId('competitors').fill('Cetaphil');
await page.getByTestId('suggest').click(); await page.getByTestId('run').click();
await page.getByTestId('paste-0').fill('Minimalist and Cetaphil are good.'); await page.getByTestId('paste-1').fill('Cetaphil.');
await page.screenshot({ path: 'shots/06-manual.png', fullPage: true });
await page.getByTestId('score-manual').click(); await page.getByTestId('report').waitFor(); ok('manual inclusion: ' + await page.getByTestId('inclusion').innerText());
await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: 'shots/07-mobile-report.png', fullPage: true });
if (errors.length) throw new Error('page errors: ' + errors.join('; '));
ok('no console page errors'); await browser.close();
