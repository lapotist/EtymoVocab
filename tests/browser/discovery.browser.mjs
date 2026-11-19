// Actual browser interactions against the source UI. Only engine.js is replaced with deterministic
// dictionary fixtures; these tests do not verify the .NET parser or live Wiktionary availability.
// Install Playwright/Chromium separately, or select them with PLAYWRIGHT_MODULE (package path)
// and CHROMIUM_EXECUTABLE_PATH. The dependency-free unit suite remains `npm test`.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { indexShard, originBucketKey } from '../../src/EtymoVocab.Web/wwwroot/reverse-index.js';
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
let backoffUntil = 0;
export const getBackoffUntil = () => backoffUntil;
export function observeBackoff(error) {
  if (error.status === 429 || error.status === 503) backoffUntil = Math.max(backoffUntil, Date.now() + (error.retryAfter ?? 5) * 1000);
}
export async function lookupRelated(word) {
  window.__discoveryCalls.push(word);
  window.__discoveryActive++;
  window.__discoveryPeak = Math.max(window.__discoveryPeak, window.__discoveryActive);
  const reply = window.__discoveryFixtures[word] || {};
  await pause(reply.delay || 0);
  window.__discoveryActive--;
  if (reply.status) {
    observeBackoff(reply);
    throw Object.assign(new Error('Fixture failure: ' + word), { status: reply.status, retryAfter: reply.retryAfter });
  }
  return reply.data || {
    word, lang: 'en', langName: 'English', complete: true, warnings: [],
    source: { revisionId: 42, revisionTimestamp: '2026-10-22T00:00:00Z', url: 'https://en.wiktionary.org/wiki/' + encodeURIComponent(word) + '#English', license: 'CC BY-SA 4.0' },
    etymologies: [{ number: 1, id: 'one', text: '', steps: reply.steps || [], morphology: reply.morphology || [], roots: reply.roots || [], doublets: reply.doublets || [],
      etymologicalRelations: reply.etymologicalRelations || [],
      originAnchors: reply.originAnchors || [],
      partsOfSpeech: [{ pos: 'Adjective', senses: ['pleasant'], translations: [], relations: reply.empty ? [] : [
        { kind: 'synonym', sense: 'pleasant', terms: reply.syn || ['pleasant'] },
        { kind: 'antonym', sense: 'unpleasant', terms: reply.ant || ['nasty'] }
      ] }]
    }]
  };
}
export const lookupWord = lookupRelated;
export const lookupEntry = async (lang, term, id) => {
  (window.__entryLookups ??= []).push({lang, term, id});
  return lookupRelated(term);
};
async function family(kind, lang, term, id) {
  (window.__familyLookups ??= []).push({ kind, lang, term, id: id ?? null });
  const reply = window.__discoveryFixtures[kind + ':' + term] || { members: [] };
  await pause(reply.delay || 0);
  if (reply.status) throw Object.assign(new Error('Fixture family unavailable'), { status: reply.status });
  return { root: term, lang, members: [], ...reply };
}
export const rootFamily = (lang, term, id) => family('root', lang, term, id);
export const prefixFamily = (lang, term, id) => family('prefix', lang, term, id);
export const suggest = async () => [];
export const backgroundPaused = () => Date.now() < backoffUntil;
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

  // Keep the production JS engine/cache for predictive search; control only the WASM exports.
  {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/_framework/dotnet.js', route => route.fulfill({ contentType: 'text/javascript', body: `
      const ok = data => JSON.stringify({ ok: true, data });
      window.guesses = [];
      window.prefixes = [];
      const Engine = {
        async Suggest(prefix) {
          window.prefixes.push(prefix);
          if (prefix === 'old') await new Promise(resolve => { window.releaseSuggestion = resolve; });
          return ok([prefix === 'insp' ? 'inspect' : prefix, 'second-choice']);
        },
        async LookupRelated(word) {
          window.guesses.push(word);
          if (word === 'inspect') await new Promise(resolve => { window.releaseLookup = resolve; });
          if (word === 'throttle') return ok({ word, complete: false, warnings: [],
            upstreamError: { status: 429, retryAfter: 60 } });
          return ok({ word, complete: true, warnings: [], etymologies: [],
            source: { revisionId: 1, revisionTimestamp: '2026-01-01', url: '#' } });
        }
      };
      export const dotnet = { create: async () => ({ setModuleImports() {}, getConfig: () => ({}),
        getAssemblyExports: async () => ({ EtymoVocab: { Web: { Engine } } }), runMain() {} }) };
    ` }));
    await page.goto(base);
    const input = page.locator('#q');
    await input.fill('old');
    await page.waitForFunction(() => window.releaseSuggestion);
    await input.fill('insp');
    await page.waitForFunction(() => window.releaseLookup);
    await page.evaluate(() => window.releaseSuggestion());
    assert.equal(await page.locator('#suggestions option').first().getAttribute('value'), 'inspect');
    await input.fill('another');
    await page.waitForFunction(() => document.querySelector('#suggestions option')?.value === 'another');
    assert.deepEqual(await page.evaluate(() => window.guesses), ['inspect']);
    await input.fill('inspect');
    await input.press('Enter');
    await page.waitForURL('**/#/w/inspect');
    await page.evaluate(() => window.releaseLookup());
    await page.locator('.word-title').waitFor();
    assert.deepEqual(await page.evaluate(() => window.guesses), ['inspect']);
    assert.equal(await page.locator('.word-title').innerText(), 'inspect');
    await input.fill('throttle');
    await page.waitForFunction(() => window.guesses.includes('throttle'));
    await input.fill('cooldown');
    await page.waitForTimeout(450);
    assert.deepEqual(await page.evaluate(() => window.prefixes), ['old', 'insp', 'another', 'throttle']);
    assert.deepEqual(await page.evaluate(() => window.guesses), ['inspect', 'throttle']);
    const cooldownBatch = await page.evaluate(async () => {
      const engine = await import('./engine.js');
      const [cached, pending] = await engine.lookupRelatedBatch(['inspect', 'fresh']);
      return { cached: cached.data.word, status: pending.error.status, retryAfter: pending.error.retryAfter };
    });
    assert.equal(cooldownBatch.cached, 'inspect');
    assert.equal(cooldownBatch.status, 429);
    assert.ok(cooldownBatch.retryAfter > 0 && cooldownBatch.retryAfter <= 60);
    await context.close();
    passed.push('Typing warms only the latest top result, Enter shares its lookup, and throttling pauses background work');
  }

  const phone = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
  async function session(fixtures, options = {}) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, timezoneId: 'Asia/Taipei', ...options });
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
    const relatives = Array.from({ length: 8 }, (_, i) => ({ kind: 'derived', lang: 'en', term: 'relative' + i }));
    const steps = Array.from({ length: 12 }, (_, i) => ({ lang: 'la', langName: 'Latin', term: 'ancestor' + i, morphology: [] }));
    const { context, page } = await session({ sample: { etymologicalRelations: relatives, steps } }, phone);
    await page.goto(base + '#/explore/sample');
    const viewport = page.locator('.map-viewport');
    const card = page.locator('.map-node.kind-word');
    const initialWidth = (await card.boundingBox()).width;
    const zoom = page.locator('.zoom-label');
    await page.getByRole('button', { name: '放大地圖' }).tap();
    assert.equal(await zoom.innerText(), '120%');
    assert.ok(Math.abs((await card.boundingBox()).width / initialWidth - 1.2) < 0.01);
    await page.getByRole('button', { name: '縮小地圖' }).tap();
    assert.equal(await zoom.innerText(), '100%');
    await page.getByRole('button', { name: '顯示全圖' }).tap();
    const fits = await viewport.evaluate(map => {
      const stage = map.querySelector('.map-stage').getBoundingClientRect();
      return stage.width <= map.clientWidth && stage.height <= map.clientHeight;
    });
    assert.ok(fits, 'Fit shows the entire tree even when the phone needs less than 12% scale');
    const fittedWidth = (await card.boundingBox()).width;
    await page.getByRole('button', { name: '放大地圖' }).tap();
    assert.ok(Math.abs((await card.boundingBox()).width / fittedWidth - 1.2) < 0.01);
    await page.getByRole('button', { name: '回到單字' }).tap();
    assert.equal(await zoom.innerText(), '100%');

    await viewport.scrollIntoViewIfNeeded();
    await viewport.evaluate(map => map.scrollTo(160, 180));
    const box = await viewport.boundingBox();
    const x = Math.round(box.x + box.width * .38);
    const y = Math.round(box.y + box.height * .4);
    const treePoint = () => page.locator('.map-stage').evaluate((stage, [x, y]) => {
      const bounds = stage.getBoundingClientRect();
      const scale = bounds.width / stage.offsetWidth;
      return { x: (x - bounds.x) / scale, y: (y - bounds.y) / scale, scale };
    }, [x, y]);
    const start = await treePoint();
    const client = await context.newCDPSession(page);
    const touch = (type, touchPoints) => client.send('Input.dispatchTouchEvent', { type, touchPoints });
    const fingers = radius => [{ id: 1, x: x - radius, y }, { id: 2, x: x + radius, y }];
    await touch('touchStart', fingers(40));
    for (const radius of [48, 56, 64]) await touch('touchMove', fingers(radius));
    const enlarged = await treePoint();
    assert.ok(enlarged.scale > start.scale * 1.45, 'Spreading two fingers enlarges the tree');
    assert.ok(Math.hypot(enlarged.x - start.x, enlarged.y - start.y) < 3, 'The tree point between the fingers stays in place');
    for (const radius of [56, 48, 40]) await touch('touchMove', fingers(radius));
    await touch('touchEnd', []);
    const reduced = await treePoint();
    assert.ok(Math.abs(reduced.scale - start.scale) < 0.03, 'Bringing the fingers back together restores the scale');
    assert.ok(Math.hypot(reduced.x - start.x, reduced.y - start.y) < 3);
    assert.equal(await page.evaluate(() => visualViewport.scale), 1, 'Pinching the tree leaves the page scale alone');

    const beforePan = await viewport.evaluate(map => map.scrollLeft);
    await touch('touchStart', [{ id: 1, x, y }]);
    for (const delta of [20, 40, 60]) await touch('touchMove', [{ id: 1, x: x - delta, y }]);
    await touch('touchEnd', []);
    await page.waitForFunction(before => document.querySelector('.map-viewport').scrollLeft > before + 20, beforePan);
    await context.close();
    passed.push('A phone can fit a deep tree, zoom by button or pinch, and pan with one finger');
  }

  {
    const nice = JSON.parse(await readFile(new URL('../web/fixtures/story/nice.json', import.meta.url), 'utf8'));
    const { context, page } = await session({ nice: { data: nice } }, { ...phone, viewport: { width: 375, height: 667 } });
    await page.goto(base + '#/explore/nice');
    const viewport = page.locator('.map-viewport');
    await viewport.waitFor();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth),
      'Multi-etymology controls fit the phone width');
    await page.setViewportSize({ width: 667, height: 375 });
    await page.getByRole('button', { name: '切換全螢幕' }).tap();
    await page.locator('.map-panel:fullscreen, .map-panel.map-expanded').waitFor();
    assert.ok((await viewport.boundingBox()).height >= 120,
      'The open relatives list leaves room to see and pinch the tree in landscape fullscreen');
    await context.close();
    passed.push('Multi-etymology controls fit a phone and the fullscreen tree stays visible in landscape');
  }

  {
    const { context, page } = await session({
      nice: { delay: 120, syn: ['pleasant', 'kind'], ant: ['nasty'] },
      'ice cream': { delay: 10, syn: ['dessert'], ant: [] }, NICE: { empty: true }, empty: { empty: true }, missing: { status: 404 },
    });
    await start(page, Array.from({ length: 21 }, (_, index) => 'word' + index).join('\n'));
    assert.match(await page.locator('.bulk-status').innerText(), /最多.*20/);
    assert.deepEqual(await calls(page), []);
    await start(page, ' nice \nice cream;NICE\nempty\nmissing');
    await page.locator('[data-query="ice cream"] .pick-word').waitFor();
    assert.deepEqual(await rowOrder(page), ['nice', 'ice cream', 'NICE', 'empty', 'missing']);
    await complete(page);
    assert.deepEqual(await calls(page), ['nice', 'ice cream', 'NICE', 'empty', 'missing']);
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
    const { context, page } = await session({ inspect: { data: {
      word: 'inspect', complete: true, warnings: [], source: { revisionId: 42, url: 'https://en.wiktionary.org/wiki/inspect' },
      etymologies: [{ number: 1, partsOfSpeech: [{ pos: 'Verb', senses: ['examine'], translations: [],
        relations: [{ kind: 'synonym', sense: 'to examine carefully', terms: [], thesaurusTargets: ['examine'] }] }] }],
    } } });
    await start(page, 'inspect');
    await complete(page);
    for (const route of ['#/bulk', '#/w/inspect']) {
      await page.goto(base + route);
      const column = page.locator('.relation-column.synonym');
      const link = column.getByRole('link', { name: /Wiktionary 詞庫/ });
      assert.equal(await link.getAttribute('href'), 'https://en.wiktionary.org/wiki/Thesaurus:examine#English');
      assert.match(await column.innerText(), /to examine carefully/);
      assert.doesNotMatch(await column.innerText(), /未列出同義詞/);
      assert.equal(await column.locator('.pick-word').count(), 0);
      assert.equal(await page.locator('.relation-column.antonym a').count(), 0);
    }
    await context.close();
    passed.push('Thesaurus-only synonyms retain the cited sense and link in both views');
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

  {
    const sourceUrl = 'https://en.wiktionary.org/w/index.php?title=predict&oldid=93715976#English';
    const relatives = ['predictable', 'predictably', 'predictability', 'predictive', 'predictor', 'predictional', 'predictiveness', 'unpredictable', 'prediction'];
    const { context, page } = await session({ predict: {
      syn: ['foretell'], ant: ['ignore'],
      etymologicalRelations: relatives.map(term => ({ kind: 'related', lang: 'en', term, sourceUrl, sourceSection: 'Related terms' })),
      roots: [{ lang: 'ine-pro', langName: 'Proto-Indo-European', root: '*deyḱ-', url: sourceUrl }],
    }, 'root:*deyḱ-': { members: ['bit', 'toe', 'biter', 'digit', 'edict', 'index', 'judge', 'token', 'indicate'], total: 9, categoryUrl: sourceUrl } });
    await context.route('**/data/en-frequency.txt', route => route.fulfill({ contentType: 'text/plain',
      body: 'token\njudge\nindex\nedict\ndigit\nbiter\ntoe\nbit\nindicate\n' }));
    await page.goto(base + '#/explore/predict');
    await page.locator('.map-panel').waitFor();
    await page.waitForFunction(() => document.querySelectorAll('.map-node.kind-family').length === 8);
    assert.match(await page.locator('.map-node.kind-family').first().innerText(), /token/);
    assert.equal(await page.locator('.map-node.kind-related').count(), 8);
    assert.doesNotMatch(await page.locator('.map-panel').innerText(), /foretell|ignore/);
    await page.getByRole('searchbox', { name: '篩選詞源相關字' }).fill('prediction');
    await page.getByRole('button', { name: '加入同族詞 prediction', exact: true }).click();
    assert.equal(await page.locator('.map-node.kind-related').count(), 9);
    assert.equal(await page.locator('.map-node.kind-related').filter({ hasText: 'prediction' }).getByRole('link', { name: 'Wiktionary 記載此關係的來源', exact: true }).first().getAttribute('href'), sourceUrl);
    await page.getByRole('searchbox', { name: '篩選詞源相關字' }).fill('indicate');
    await page.getByRole('button', { name: '加入同根詞 indicate', exact: true }).click();
    assert.equal(await page.locator('.map-node.kind-family').count(), 9);
    await context.close();
    passed.push('All source relatives and root members remain searchable beyond the initial eight displayed words');
  }

  {
    const id = 'across, beyond';
    const { context, page } = await session({
      transport: { steps: [{ lang: 'fr', langName: 'French', term: 'modèle', relation: 'cal', transitive: false,
        morphology: [{ kind: 'af', lang: 'en', langName: 'English', parts: [{ lang: 'en', term: 'after-' }] }],
      }], morphology: [{ kind: 'surf', lang: 'en', langName: 'English', parts: [
        { lang: 'en', term: 'trans-', hint: id, gloss: 'across', url: 'https://en.wiktionary.org/wiki/trans-#English' },
        { lang: 'en', term: 'port', gloss: 'carry', url: 'https://en.wiktionary.org/wiki/port#English' },
        { lang: 'la', langName: 'Latin', term: 'trans-', url: 'https://en.wiktionary.org/wiki/trans-#Latin' },
      ] }] },
      'prefix:trans-': { langName: 'English', members: ['transfer', 'translate', 'transmit'], total: 3,
        categoryUrl: 'https://en.wiktionary.org/wiki/Category:English_terms_prefixed_with_trans-' },
    });
    await context.route('**/data/en-frequency.txt', route => route.fulfill({ contentType: 'text/plain',
      body: 'translate\ntransmit\ntransfer\n' }));
    await page.goto(base + '#/explore/transport');
    await page.getByRole('button', { name: '全部展開', exact: true }).click();
    for (const key of ['la:trans-', 'en:after-']) {
      const other = page.locator(`.map-node[data-key="${key}"]`);
      await other.waitFor();
      assert.equal(await other.getByRole('link', { name: '字族清單', exact: true }).count(), 0);
    }
    const prefix = page.locator('.map-node[data-key="en:trans-"]');
    await prefix.getByRole('button', { name: '找trans- 開頭的字', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.map-node.kind-family').length === 3);
    assert.match(await page.locator('.map-node.kind-family').first().innerText(), /translate/);
    const link = prefix.getByRole('link', { name: '字族清單', exact: true });
    assert.equal(await link.getAttribute('href'), '#/root/en/trans-?kind=prefix&id=across%2C+beyond');
    await page.getByRole('button', { name: '測驗：全部遮住', exact: true }).click();
    assert.equal(await page.locator('.story-card').isVisible(), false);
    await page.getByRole('button', { name: '結束測驗', exact: true }).click();
    assert.equal(await page.locator('.story-card').isVisible(), true);
    await link.click();
    await page.getByRole('heading', { name: 'trans-', exact: true }).waitFor();
    assert.deepEqual(await page.locator('.chips a').allTextContents(), ['translate', 'transmit', 'transfer']);
    assert.deepEqual(await page.evaluate(() => window.__familyLookups), Array(2).fill({ kind: 'prefix', lang: 'en', term: 'trans-', id }));
    await context.close();
    passed.push('The map and standalone prefix list request the same sense and honor the supplied frequency ranks');
  }

  {
    const { context, page } = await session({ happy: {
      morphology: [{ lang: 'en', langName: 'English', kind: 'af', parts: [
        { term: 'hap', url: 'https://en.wiktionary.org/wiki/hap#English' },
        { term: '-y', url: 'https://en.wiktionary.org/wiki/-y#English' },
      ] }],
    }, hap: { etymologicalRelations: [{ kind: 'derived', lang: 'en', term: 'hapless' }] } }, phone);
    await page.goto(base + '#/explore/happy');
    await page.locator('.map-panel').waitFor();
    await page.getByRole('button', { name: '全部展開', exact: true }).click();
    await page.locator('.map-node[data-key="en:hap"]').getByRole('button', { name: '展開來源', exact: true }).click();
    await page.locator('.map-node.kind-derived').waitFor();
    assert.match(await page.locator('.map-node.kind-derived').innerText(), /hapless/);
    assert.match(await page.locator('.map-related-options').innerText(), /hap · 派生詞/);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await context.close();
    passed.push('Expanding a component attaches its own documented relatives, even without further ancestry, on mobile');
  }

  {
    const { context, page } = await session({ sample: {
      roots: [{ lang: 'ine-pro', langName: 'Proto-Indo-European', root: '*sample-', url: 'https://en.wiktionary.org/' }],
    }, 'root:*sample-': { members: ['one', 'two'], delay: 700 } });
    await page.goto(base + '#/explore/sample');
    await page.locator('.map-panel').waitFor();
    await page.getByRole('button', { name: '全部收合', exact: true }).click();
    const filter = page.getByRole('searchbox', { name: '篩選詞源相關字' });
    await filter.fill('one');
    await page.getByRole('button', { name: '已加入同根詞 one', exact: true }).waitFor();
    assert.equal(await page.locator('.map-node.kind-family').count(), 0, 'Background completion preserves user collapse');
    assert.equal(await filter.evaluate(element => element === document.activeElement), true);
    await context.close();
    passed.push('Automatic family completion preserves a user collapse and filter focus');
  }

  {
    const emptyEtymology = { number: 1, id: null, text: '', steps: [], morphology: [], roots: [], doublets: [], partsOfSpeech: [] };
    const { context, page } = await session({ sample: {
      morphology: [{ lang: 'en', langName: 'English', kind: 'af', parts: [{ term: 'homonym', url: 'https://en.wiktionary.org/wiki/homonym#English' }] }],
    }, homonym: { data: { word: 'homonym', lang: 'en', langName: 'English', etymologies: [emptyEtymology,
      { ...emptyEtymology, number: 2, etymologicalRelations: [{ kind: 'derived', lang: 'en', term: 'fixture-relative' }] }],
    } } });
    await page.goto(base + '#/explore/sample');
    await page.locator('.map-panel').waitFor();
    await page.getByRole('button', { name: '全部展開', exact: true }).click();
    await page.locator('.map-node[data-key="en:homonym"]').getByRole('button', { name: '展開來源', exact: true }).click();
    await page.locator('.map-node.kind-derived').waitFor();
    assert.match(await page.locator('.map-related-options').innerText(), /同形詞 2 · 派生詞/);
    assert.doesNotMatch(await page.locator('.map-related-options').innerText(), /homonym · 派生詞/);
    await context.close();
    passed.push('A component with multiple etymologies keeps homograph grouping even if only one has relatives');
  }

  {
    const anchor = { key: '["en","hap",null]', lang: 'en', kind: 'component', title: 'hap', term: 'hap', url: 'https://en.wiktionary.org/wiki/hap#English' };
    const { context, page } = await session({ happy: { originAnchors: [anchor] },
      hapless: { originAnchors: [anchor] },
      unrelated: { originAnchors: [{ ...anchor, key: '["en","hap","other-sense"]' }] },
      'upstream-limited': { status: 503, retryAfter: 10 },
    });
    const key = originBucketKey(anchor);
    const body = JSON.stringify({ schemaVersion: 1, origins: { [key]: ['hapless', 'unrelated', 'upstream-limited'] } });
    const sha256 = createHash('sha256').update(body).digest('hex');
    const shard = indexShard(key);
    const file = `${shard}-${sha256}.json`;
    await context.route('**/data/etymology-index/**', route => route.fulfill({ contentType: 'application/json', body:
      route.request().url().endsWith('manifest.json') ? JSON.stringify({ schemaVersion: 1, buildId: 'fixture', entryCount: 3,
        source: { dumpDate: '2026-10-01', url: 'https://kaikki.org/dictionary/English/', license: 'CC BY-SA 4.0' },
        shards: { [shard]: { file, sha256 } } }) : body,
    }));
    await page.goto(base + '#/explore/happy');
    await page.locator('.map-panel').waitFor();
    await page.locator('.map-node.kind-verified-origin').waitFor();
    assert.match(await page.locator('.map-node.kind-verified-origin').innerText(), /hapless|共用構詞成分/);
    await page.locator('.reverse-discovery > summary').click();
    await page.getByRole('button', { name: '未確認 unrelated', exact: true }).waitFor();
    assert.equal(await page.locator('.map-node.kind-verified-origin').count(), 1);
    await page.waitForFunction(() => document.querySelector('.reverse-discovery [role="status"]')?.textContent.includes('限流'));
    const before = await calls(page);
    await page.getByRole('button', { name: '核對 upstream-limited', exact: true }).click();
    assert.deepEqual(await calls(page), before);
    await page.getByRole('button', { name: '測驗：全部遮住' }).click();
    assert.doesNotMatch(await page.locator('.map-node.kind-verified-origin').innerText(), /共用構詞成分：hap/);
    assert.doesNotMatch(await page.locator('.map-stage').innerText(), /共用構詞成分：hap/);
    assert.ok((await page.locator('.reverse-discovery button[title]').evaluateAll(buttons => buttons.map(b => b.title)))
      .every(title => !title.includes('候選來源：hap')));
    await page.getByRole('button', { name: '結束測驗' }).click();
    assert.match(await page.locator('.map-node.kind-verified-origin').innerText(), /共用構詞成分：hap/);
    await page.goto(base + '#/bulk');
    await start(page, 'after429');
    assert.match(await page.locator('.bulk-status').innerText(), /請再等/);
    assert.deepEqual(await calls(page), before);
    await context.close();
    passed.push('Reverse-index candidates require live identity verification, show shared-component evidence, and honor rate limits');
  }

  {
    const empty = { number: 1, partsOfSpeech: [], steps: [], roots: [], morphology: [], doublets: [] };
    const lexical = { kind: 'derived', lang: 'en', term: 'fixture-relative' };
    const step = { lang: 'la', langName: 'Latin', term: 'panis', etymonId: 'bread', morphology: [],
      relation: 'der', url: 'https://en.wiktionary.org/wiki/panis#Latin' };
    const tree = { ...empty, steps: [step], morphology: [{ lang: 'en', langName: 'English', kind: 'af',
      parts: [{ term: 'amor', lang: 'la', langName: 'Latin', hint: 'love', url: 'https://en.wiktionary.org/wiki/amor#Latin' }] }] };
    const { context, page } = await session({ sample: { data: { word: 'sample', lang: 'en', langName: 'English',
      complete: true, warnings: [], source: { revisionId: 42, url: 'https://en.wiktionary.org/wiki/sample' }, etymologies: [tree] } },
      amor: { data: { word: 'amor', lang: 'la', complete: false, warnings: ['retry fixture warning'],
        etymologies: [empty, { ...empty, number: 2, etymologicalRelations: [lexical] }] } },
    });
    await page.goto(base + '#/explore/sample');
    await page.getByRole('button', { name: '全部展開', exact: true }).click();
    const part = page.locator('[data-key="la:amor"]');
    assert.match(await part.innerText(), /Latin/);
    await part.getByRole('button', { name: '展開來源' }).click();
    await page.getByText(/retry fixture warning/).waitFor();
    await page.evaluate(() => {
      const result = window.__discoveryFixtures.amor.data;
      result.complete = true;
      result.warnings = [];
      result.etymologies[1].etymologicalRelations.push({ kind: 'derived', lang: 'en', term: 'after-retry' });
    });
    await part.getByRole('button', { name: '展開來源' }).click();
    await page.locator('.map-node.kind-derived').filter({ hasText: 'after-retry' }).waitFor();
    assert.equal(await page.locator('.map-node.kind-derived').count(), 2);
    assert.equal(await part.getByRole('button', { name: '展開來源' }).count(), 0);
    await page.locator('[data-key="la:panis"]').getByRole('button', { name: '展開來源' }).click();
    await page.waitForFunction(() => window.__entryLookups?.length === 3);
    assert.deepEqual(await page.evaluate(() => window.__entryLookups), [
      { lang: 'la', term: 'amor', id: 'love' }, { lang: 'la', term: 'amor', id: 'love' },
      { lang: 'la', term: 'panis', id: 'bread' },
    ]);
    await context.close();
    passed.push('Mixed-language and sense-qualified expansion retains identity, warns on partial results, and retries without duplicate branches');
  }

  {
    const { context, page } = await session({});
    await page.evaluate(() => {
      const version = 'archived-version';
      const attempt = { id: 'archived-attempt', timestamp: 0, version, lessonId: 'archived-lesson',
        conceptId: 'concept', questionId: 'question', sense: 'meaning', phase: 'immediate',
        priorKnowledge: 'known', answerId: null, confidence: null, correct: null, firstAttempt: true };
      localStorage.setItem('etymovocab.learning.v1', JSON.stringify({ schemaVersion: 1, version, attempts: [attempt] }));
    });
    await page.goto(base + '#/learn');
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: '匯出作答記錄' }).click();
    const file = await (await download).path();
    const exported = JSON.parse(await readFile(file, 'utf8'));
    assert.deepEqual(exported.attempts.map(row => row.id), ['archived-attempt']);
    await context.close();
    passed.push('An archived-only learning history can be exported before answering the new curriculum');
  }

  assert.deepEqual(errors, [], 'Browser JavaScript errors');
  console.log(`Passed ${passed.length} browser scenarios (deterministic engine fixtures):\n${passed.map(item => '- ' + item).join('\n')}`);
} finally {
  await browser?.close();
  if (server.listening) await new Promise(resolve => server.close(resolve));
}
