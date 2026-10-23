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

// Keep the point under the viewport's center stationary when changing the scale.
export function zoomScroll(layout, viewport, scroll, fromZoom, toZoom) {
  const before = mapGeometry(layout, viewport, fromZoom);
  const after = mapGeometry(layout, viewport, toZoom);
  const x = (scroll.x + viewport.width / 2 - before.offsetX) / fromZoom;
  const y = (scroll.y + viewport.height / 2 - before.offsetY) / fromZoom;
  return {
    x: Math.max(0, Math.min(after.width - viewport.width, x * toZoom + after.offsetX - viewport.width / 2)),
    y: Math.max(0, Math.min(after.height - viewport.height, y * toZoom + after.offsetY - viewport.height / 2)),
  };
}
