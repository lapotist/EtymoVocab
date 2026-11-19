import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitZoom, mapGeometry, zoomScroll } from '../../src/EtymoVocab.Web/wwwroot/map-viewport.js';

test('the scroll area includes the complete scaled tree in both directions', () => {
  const viewport = { width: 800, height: 500 };
  for (const zoom of [.12, .5, 1, 1.8]) {
    const layout = { width: 2400, height: 1800 };
    const bounds = mapGeometry(layout, viewport, zoom);
    assert(bounds.width >= layout.width * zoom);
    assert(bounds.height >= layout.height * zoom);
    assert(bounds.width >= viewport.width);
    assert(bounds.height >= viewport.height);
  }
});

test('small trees are centered without negative scroll positions', () => {
  assert.deepEqual(mapGeometry({ width: 400, height: 200 }, { width: 800, height: 500 }, 1), {
    width: 800, height: 500, offsetX: 200, offsetY: 150,
  });
});

test('fit shows a large tree in a phone viewport and leaves small trees at full size', () => {
  const viewport = { width: 360, height: 460 };
  assert.equal(fitZoom({ width: 4000, height: 1000 }, viewport), 328 / 4000);
  assert.equal(fitZoom({ width: 1000, height: 6000 }, viewport), 428 / 6000);
  assert.equal(fitZoom({ width: 200, height: 300 }, viewport), 1);
});

test('zoom preserves the visible center while the tree overflows', () => {
  const layout = { width: 3000, height: 2000 };
  const viewport = { width: 800, height: 500 };
  const scroll = { x: 500, y: 600 };
  const zoomed = zoomScroll(layout, viewport, scroll, 1, 1.5);
  assert.equal((scroll.x + 400) / 1, (zoomed.x + 400) / 1.5);
  assert.equal((scroll.y + 250) / 1, (zoomed.y + 250) / 1.5);
  assert.deepEqual(zoomScroll(layout, viewport, zoomed, 1.5, 1), scroll);
});

test('a moving pinch keeps the same tree point between the fingers', () => {
  const layout = { width: 1200, height: 1600 };
  const viewport = { width: 360, height: 480 };
  const scroll = { x: 90, y: 210 };
  const start = { x: 50, y: 75 };
  const end = { x: 80, y: 55 };
  const zoomed = zoomScroll(layout, viewport, scroll, 1, 1.5, start, end);
  assert.deepEqual(zoomed, { x: 130, y: 372.5 });
  assert.deepEqual(zoomScroll(layout, viewport, zoomed, 1.5, 1, end, start), scroll);
});

test('a pinch crossing from a centered tree to overflow accounts for its previous offset', () => {
  const layout = { width: 600, height: 800 };
  const viewport = { width: 360, height: 480 };
  const point = { x: 60, y: 120 };
  assert.deepEqual(zoomScroll(layout, viewport, { x: 0, y: 0 }, .5, 1, point), { x: 0, y: 40 });
});

test('zooming to fit clamps scroll and zooming back keeps the tree centered', () => {
  const layout = { width: 1200, height: 800 };
  const viewport = { width: 800, height: 500 };
  assert.deepEqual(zoomScroll(layout, viewport, { x: 400, y: 300 }, 1, .25), { x: 0, y: 0 });
  assert.deepEqual(zoomScroll(layout, viewport, { x: 0, y: 0 }, .25, 1), { x: 200, y: 150 });
});
