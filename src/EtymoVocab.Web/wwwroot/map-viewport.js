// Match the scrollable canvas to the scaled tree, centering trees smaller than the viewport.
export function mapGeometry(layout, viewport, zoom) {
  const width = Math.ceil(layout.width * zoom);
  const height = Math.ceil(layout.height * zoom);
  return {
    width: Math.max(viewport.width, width),
    height: Math.max(viewport.height, height),
    offsetX: Math.max(0, (viewport.width - width) / 2),
    offsetY: Math.max(0, (viewport.height - height) / 2),
  };
}

export function fitZoom(layout, viewport) {
  const width = Math.max(1, viewport.width - 32);
  const height = Math.max(1, viewport.height - 32);
  return Math.min(1, width / layout.width, height / layout.height);
}

// Move the tree point under a pinch's old midpoint to its new midpoint. Buttons zoom about the center.
export function zoomScroll(layout, viewport, scroll, fromZoom, toZoom,
  fromPoint = { x: viewport.width / 2, y: viewport.height / 2 }, toPoint = fromPoint) {
  const before = mapGeometry(layout, viewport, fromZoom);
  const after = mapGeometry(layout, viewport, toZoom);
  const x = (scroll.x + fromPoint.x - before.offsetX) / fromZoom;
  const y = (scroll.y + fromPoint.y - before.offsetY) / fromZoom;
  return {
    x: Math.max(0, Math.min(after.width - viewport.width, x * toZoom + after.offsetX - toPoint.x)),
    y: Math.max(0, Math.min(after.height - viewport.height, y * toZoom + after.offsetY - toPoint.y)),
  };
}
