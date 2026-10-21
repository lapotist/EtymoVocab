import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layoutTree, edgePath } from '../../src/EtymoVocab.Web/wwwroot/map-layout.js';

const node = (key, height, children = []) => ({ key, height, children });

test('uneven branches have no overlapping cards and every source appears to the right of its word', () => {
  const tree = node('word', 140, [
    node('morphology', 70, [node('prefix', 150), node('stem', 230, [node('root', 160)])]),
    node('ancestor', 260, [node('older', 120)]),
  ]);
  const layout = layoutTree(tree, n => n.height);
  assert.equal(layout.nodes.length, 7);
  assert.equal(layout.edges.length, 6);
  for (const { from, to } of layout.edges) {
    assert.ok(to.x > from.x + from.width);
    assert.match(edgePath({ from, to }), /^M [\d.]+ [\d.]+ C /);
  }
  for (const first of layout.nodes) {
    for (const second of layout.nodes) {
      if (first !== second && first.x === second.x) {
        assert.ok(first.y + first.height <= second.y || second.y + second.height <= first.y);
      }
    }
    assert.ok(first.y >= 0 && first.y + first.height <= layout.height);
  }
});

test('collapse removes the entire branch, while expansion restores the same layout', () => {
  const branch = node('root', 150, [node('family1', 100), node('family2', 100)]);
  const tree = node('word', 100, [branch]);
  const initial = layoutTree(tree, n => n.height);
  branch.collapsed = true;
  assert.equal(layoutTree(tree, n => n.height).nodes.length, 2);
  branch.collapsed = false;
  assert.deepEqual(layoutTree(tree, n => n.height), initial);
});

test('repeated ancestry cannot create a cycle, while identical terms in separate branches remain visible', () => {
  const tree = node('word', 100, [node('a', 100, [node('word', 100)]), node('b', 100, [node('a', 100)])]);
  const layout = layoutTree(tree, n => n.height);
  assert.deepEqual(layout.nodes.map(n => n.node.key), ['word', 'a', 'b', 'a']);
  assert.ok(Number.isFinite(layout.height));
});
