// Actual browser interactions against the source UI. Only engine.js is replaced with deterministic
// dictionary fixtures; these tests do not verify the .NET parser or live Wiktionary availability.
// Install Playwright/Chromium separately, or select them with PLAYWRIGHT_MODULE (package path)
// and CHROMIUM_EXECUTABLE_PATH. The dependency-free unit suite remains `npm test`.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright'));
} catch (error) {
  throw new Error('Install Playwright and its Chromium browser, or set PLAYWRIGHT_MODULE to an installed package path.', { cause: error });
}

const sourceRoot = resolve(fileURLToPath(new URL('../../src/EtymoVocab.Web/wwwroot/', import.meta.url)));
const errors = [];
const passed = [];
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    if (!pathname.startsWith('/EtymoVocab/')) throw new Error('Unknown base path');
    const file = resolve(sourceRoot, pathname.slice('/EtymoVocab/'.length) || 'index.html');
    if (!file.startsWith(sourceRoot + sep)) throw new Error('Invalid path');
    const body = await readFile(file);
    const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[extname(file)] || 'application/octet-stream';
    response.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    response.end(body);
  } catch {
    response.writeHead(404);
    response.end('Not found');
  }
});

const fixtureEngine = `
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function lookupRelated(word) {
  window.__discoveryCalls.push(word);
  window.__discoveryActive++;
  window.__discoveryPeak = Math.max(window.__discoveryPeak, window.__discoveryActive);
  const reply = window.__discoveryFixtures[word] || {};
  await pause(reply.delay || 0);
  window.__discoveryActive--;
  if (reply.status) throw Object.assign(new Error('Fixture failure: ' + word), { status: reply.status, retryAfter: reply.retryAfter });
  return reply.data || {
    word, lang: 'en', langName: 'English', complete: true, warnings: [],
    source: { revisionId: 42, revisionTimestamp: '2026-10-22T00:00:00Z', url: 'https://en.wiktionary.org/wiki/' + encodeURIComponent(word) + '#English', license: 'CC BY-SA 4.0' },
    etymologies: [{ number: 1, id: 'one', text: '', steps: [], morphology: [], roots: [], doublets: reply.doublets || [],
      partsOfSpeech: [{ pos: 'Adjective', senses: ['pleasant'], translations: [], relations: reply.empty ? [] : [
        { kind: 'synonym', sense: 'pleasant', terms: reply.syn || ['pleasant'] },
        { kind: 'antonym', sense: 'unpleasant', terms: reply.ant || ['nasty'] }
      ] }]
    }]
  };
}
export const lookupWord = lookupRelated;
export const lookupEntry = lookupRelated;
export const rootFamily = async () => ({ members: [] });
export const suggest = async () => [];
export const preload = async () => {};
`;

let browser;
try {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const base = `http://127.0.0.1:${server.address().port}/EtymoVocab/`;
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : {}),
  });

  async function session(fixtures, viewport = { width: 1280, height: 900 }) {
    const context = await browser.newContext({ viewport, timezoneId: 'Asia/Taipei' });
    context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
    await context.addInitScript(fixtures => {
      window.__discoveryFixtures = fixtures;
      window.__discoveryCalls = [];
      window.__discoveryActive = 0;
      window.__discoveryPeak = 0;
    }, fixtures);
    await context.route('**/engine.js', route => route.fulfill({ contentType: 'text/javascript', body: fixtureEngine }));
    const page = await context.newPage();
    await page.goto(base + '#/bulk');
    await page.locator('#bulk-words').waitFor();
    return { context, page };
  }
  async function start(page, text) {
    await page.locator('#bulk-words').fill(text);
    await page.getByRole('button', { name: '查詢這些單字', exact: true }).click();
  }
  const complete = page => page.waitForFunction(() => document.querySelector('.bulk-status')?.textContent.startsWith('已完成'));
  const rowOrder = page => page.locator('.bulk-result').evaluateAll(nodes => nodes.map(node => node.dataset.query));
  const calls = page => page.evaluate(() => window.__discoveryCalls);

  {
    const { context, page } = await session({
      nice: { delay: 120, syn: ['pleasant', 'kind'], ant: ['nasty'] },
      'ice cream': { delay: 10, syn: ['dessert'], ant: [] }, empty: { empty: true }, missing: { status: 404 },
    });
    await start(page, Array.from({ length: 21 }, (_, index) => 'word' + index).join('\n'));
    assert.match(await page.locator('.bulk-status').innerText(), /最多.*20/);
    assert.deepEqual(await calls(page), []);
    await start(page, ' nice \nice cream;NICE\nempty\nmissing');
    await page.locator('[data-query="ice cream"] .pick-word').waitFor();
    assert.deepEqual(await rowOrder(page), ['nice', 'ice cream', 'empty', 'missing']);
    await complete(page);
    assert.deepEqual(await calls(page), ['nice', 'ice cream', 'empty', 'missing']);
    assert.ok(await page.evaluate(() => window.__discoveryPeak <= 2));
    assert.match(await page.locator('[data-query="empty"]').innerText(), /未列出同義詞/);
    assert.match(await page.locator('[data-query="missing"]').innerText(), /Fixture failure/);
    await page.getByRole('searchbox', { name: '篩選結果中的單字' }).fill('plea');
    assert.deepEqual(await page.locator('.bulk-result .pick-word').allTextContents(), ['pleasant']);
    await page.getByRole('combobox', { name: '顯示關係' }).selectOption('antonym');
    assert.equal(await page.locator('.bulk-result .pick-word').count(), 0);
    await page.getByRole('searchbox', { name: '篩選結果中的單字' }).fill('');
    assert.deepEqual(await page.locator('.bulk-result .pick-word').allTextContents(), ['nasty']);
    await page.getByRole('combobox', { name: '顯示關係' }).selectOption('');
    await page.getByRole('button', { name: '收藏 pleasant', exact: true }).click();
    await page.locator('.site-nav a[href="#/saved"]').click();
    await page.locator('[data-saved-word="pleasant"]').waitFor();
    await page.getByText('回看收藏時的線索', { exact: true }).click();
    assert.match(await page.locator('[data-saved-word="pleasant"]').innerText(), /nice.*同義詞/s);
    await page.reload();
    await page.locator('[data-saved-word="pleasant"]').waitFor();
    await page.getByRole('button', { name: '移除收藏 pleasant', exact: true }).click();
    assert.equal(await page.locator('#saved-count').innerText(), '0');
    await context.close();
    passed.push('Bulk parsing, ordered streaming, empty/error isolation, filtering, and saved-word provenance/persistence/removal');
  }

  {
    const { context, page } = await session({
      first: { delay: 5, syn: ['steady'], ant: ['fragile'] },
      later: { delay: 350, syn: ['lately'], ant: ['early'] },
    });
    await start(page, 'first\nlater');
    const first = page.locator('[data-query="first"]');
    await first.locator('.pick-word').first().waitFor();
    const card = await first.elementHandle();
    const saved = await first.getByRole('button', { name: '收藏 steady', exact: true }).elementHandle();
    await saved.click();
    await complete(page);
    assert.equal(await card.evaluate(node => node.isConnected), true, 'later results must preserve completed cards');
    assert.equal(await saved.evaluate(node => node.isConnected && document.activeElement === node), true,
      'streaming and completion must retain the focused saved-word control');
    assert.equal(await saved.getAttribute('aria-pressed'), 'true');
    await page.getByRole('searchbox', { name: '篩選結果中的單字' }).fill('late');
    assert.deepEqual(await page.locator('.bulk-result .pick-word').allTextContents(), ['lately']);
    await page.getByRole('searchbox', { name: '篩選結果中的單字' }).fill('');
    await page.getByRole('combobox', { name: '顯示關係' }).selectOption('antonym');
    assert.deepEqual(await page.locator('.bulk-result .pick-word').allTextContents(), ['fragile', 'early']);
    await page.getByRole('combobox', { name: '顯示關係' }).selectOption('');
    assert.equal(await first.getByRole('button', { name: '取消收藏 steady', exact: true }).getAttribute('aria-pressed'), 'true');
    await context.close();
    passed.push('Streamed results retain completed cards and focused controls while filters and saved state still update');
  }

  {
    const { context, page } = await session({ oldone: { delay: 450 }, oldtwo: { delay: 450 }, oldthree: {}, fresh: { syn: ['newer'], ant: [] } });
    await start(page, 'oldone\noldtwo\noldthree');
    await page.waitForFunction(() => window.__discoveryCalls.length === 2);
    await page.getByRole('button', { name: '停止查詢', exact: true }).click();
    assert.equal(await page.locator('#bulk-words').isEnabled(), true);
    await start(page, 'fresh');
    await complete(page);
    await page.waitForTimeout(500);
    assert.deepEqual(await calls(page), ['oldone', 'oldtwo', 'fresh']);
    assert.deepEqual(await rowOrder(page), ['fresh']);
    assert.match(await page.locator('.bulk-results').innerText(), /newer/);
    assert.match(await page.locator('.bulk-status').innerText(), /已完成 1/);
    await context.close();
    passed.push('Immediate Stop and restart suppress late results and old pending requests');
  }

  {
    const { context, page } = await session({ ok: { delay: 5, syn: ['accepted'], ant: [] }, blocked: { delay: 30, status: 429, retryAfter: 1 }, pending: {} });
    await start(page, 'ok\nblocked\npending');
    await page.waitForFunction(() => document.querySelector('.bulk-status')?.textContent.includes('暫時限流'));
    const before = await calls(page);
    await page.getByRole('button', { name: '查詢這些單字', exact: true }).click();
    assert.match(await page.locator('.bulk-status').innerText(), /再等/);
    assert.deepEqual(await calls(page), before);
    assert.equal(await page.locator('[data-query="ok"] .pick-word').innerText(), 'accepted');
    await page.evaluate(() => { window.__discoveryFixtures.blocked = { syn: ['recovered'], ant: [] }; });
    await page.waitForTimeout(1100);
    await page.getByRole('button', { name: '重試未完成的查詢', exact: true }).click();
    await complete(page);
    assert.deepEqual(await rowOrder(page), ['ok', 'blocked', 'pending']);
    assert.equal((await calls(page)).filter(word => word === 'ok').length, 1);
    assert.equal(await page.locator('[data-query="blocked"] .pick-word').innerText(), 'recovered');
    await context.close();
    passed.push('All submissions respect Retry-After; retry retains successes and original row order');
  }

  {
    const { context, page } = await session({ blocked: { delay: 10, status: 429, retryAfter: 1 }, slow: { delay: 400 }, fresh: {} });
    await start(page, 'blocked\nslow');
    await page.locator('[data-query="blocked"] .notice').waitFor();
    await page.getByRole('button', { name: '停止查詢', exact: true }).click();
    await start(page, 'fresh');
    assert.match(await page.locator('.bulk-status').innerText(), /再等/);
    assert.deepEqual(await calls(page), ['blocked', 'slow']);
    await page.evaluate(() => {
      window.__discoveryFixtures.blocked = { syn: ['recovered'], ant: [] };
      window.__discoveryFixtures.slow = { syn: ['later'], ant: [] };
    });
    await page.waitForTimeout(1100);
    await page.getByRole('button', { name: '重試未完成的查詢', exact: true }).click();
    await complete(page);
    assert.deepEqual(await calls(page), ['blocked', 'slow', 'blocked', 'slow']);
    assert.deepEqual(await rowOrder(page), ['blocked', 'slow']);
    await context.close();
    passed.push('Stopping before an in-flight response settles retains immediate backoff and both retryable words');
  }

  {
    const { context, page } = await session({ inspect: {
      syn: ['examine'], ant: ['ignore'], doublets: [{ lang: 'en', term: 'espy', url: 'https://en.wiktionary.org/wiki/espy#English' }],
    } });
    await start(page, 'inspect');
    await complete(page);
    const popup = context.waitForEvent('page');
    await page.getByRole('link', { name: '另開詞源地圖 ↗', exact: true }).click();
    const map = await popup;
    await map.locator('.map-panel').waitFor();
    assert.equal(await map.locator('.map-node.kind-doublet').count(), 1);
    assert.match(await map.locator('.map-node.kind-doublet').innerText(), /espy/);
    assert.equal(await map.locator('.map-node.kind-related').count(), 0);
    assert.doesNotMatch(await map.locator('.map-panel').innerText(), /examine|ignore|同義詞|反義詞/);
    await context.close();
    passed.push('The actual graph displays an explicit doublet without importing synonym or antonym candidates');
  }

  assert.deepEqual(errors, [], 'Browser JavaScript errors');
  console.log(`Passed ${passed.length} browser scenarios (deterministic engine fixtures):\n${passed.map(item => '- ' + item).join('\n')}`);
} finally {
  await browser?.close();
  if (server.listening) await new Promise(resolve => server.close(resolve));
}
