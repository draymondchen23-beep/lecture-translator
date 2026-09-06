export function effectiveViewport({ top, bottom, sticky, dockTop }) {
  const effectiveTop = Math.max(top, sticky);
  const effectiveBottom = Math.min(bottom, dockTop - 16);
  return { top: effectiveTop, bottom: effectiveBottom, center: effectiveTop + (effectiveBottom - effectiveTop) / 2 };
}

export function targetDelta(viewport, row) {
  return row.height > viewport.bottom - viewport.top
    ? row.bottom - viewport.bottom
    : row.top + row.height / 2 - viewport.center;
}
