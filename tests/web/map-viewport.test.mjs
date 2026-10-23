import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapGeometry, zoomScroll } from '../../src/EtymoVocab.Web/wwwroot/map-viewport.js';

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

test('zoom preserves the visible center while the tree overflows', () => {
  const layout = { width: 3000, height: 2000 };
  const viewport = { width: 800, height: 500 };
  const scroll = { x: 500, y: 600 };
  const zoomed = zoomScroll(layout, viewport, scroll, 1, 1.5);
  assert.equal((scroll.x + 400) / 1, (zoomed.x + 400) / 1.5);
  assert.equal((scroll.y + 250) / 1, (zoomed.y + 250) / 1.5);
  assert.deepEqual(zoomScroll(layout, viewport, zoomed, 1.5, 1), scroll);
});

test('zooming to fit clamps scroll and zooming back keeps the tree centered', () => {
  const layout = { width: 1200, height: 800 };
  const viewport = { width: 800, height: 500 };
  assert.deepEqual(zoomScroll(layout, viewport, { x: 400, y: 300 }, 1, .25), { x: 0, y: 0 });
  assert.deepEqual(zoomScroll(layout, viewport, { x: 0, y: 0 }, .25, 1), { x: 200, y: 150 });
});
