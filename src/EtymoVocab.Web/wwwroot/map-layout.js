// A deterministic, variable-height horizontal tree. Coordinates stay independent of zoom/pan.
export function layoutTree(root, sizeOf, { width = 248, columnGap = 72, rowGap = 24, padding = 40 } = {}) {
  const nodes = [];
  const edges = [];
  function measure(node, depth, ancestors) {
    const height = sizeOf(node);
    const next = new Set(ancestors).add(node.key);
    const children = node.collapsed ? [] : node.children
      .filter(child => !next.has(child.key))
      .map(child => measure(child, depth + 1, next));
    const span = Math.max(height, children.reduce((sum, child) => sum + child.span, 0) + Math.max(0, children.length - 1) * rowGap);
    return { node, depth, height, span, children };
  }
  function place(item, top, parent) {
    const point = { node: item.node, x: padding + item.depth * (width + columnGap), y: top + (item.span - item.height) / 2, width, height: item.height };
    nodes.push(point);
    if (parent) edges.push({ from: parent, to: point });
    let childTop = top + (item.span - (item.children.reduce((sum, child) => sum + child.span, 0) + Math.max(0, item.children.length - 1) * rowGap)) / 2;
    for (const child of item.children) {
      place(child, childTop, point);
      childTop += child.span + rowGap;
    }
  }
  const measured = measure(root, 0, new Set());
  place(measured, padding, null);
  return {
    nodes, edges,
    width: Math.max(...nodes.map(n => n.x + n.width)) + padding,
    height: measured.span + padding * 2,
  };
}

export function edgePath({ from, to }) {
  const x1 = from.x + from.width;
  const y1 = from.y + from.height / 2;
  const x2 = to.x;
  const y2 = to.y + to.height / 2;
  const middle = (x1 + x2) / 2;
  return `M ${x1} ${y1} C ${middle} ${y1}, ${middle} ${y2}, ${x2} ${y2}`;
}
