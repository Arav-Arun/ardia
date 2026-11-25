import { capFittedFontSize } from "../glyph/capFit";

const INITIAL = { scale: 0.64, nudgeX: 0.25, nudgedUpToPixelsPerPoint: 2.5 } as const;

export type InitialGlyph = { fontSize: number; lineShiftX: number };

const spansWholePixels = (points: number, pixelsPerPoint: number) => Math.abs(points * pixelsPerPoint - Math.round(points * pixelsPerPoint)) < 1e-6;

export function initialGlyph(tile: number, pixelsPerPoint: number, snapsBaselines: boolean): InitialGlyph {
  const fontSize = Math.round(tile * INITIAL.scale);
  if (!snapsBaselines || !spansWholePixels(tile, pixelsPerPoint)) return { fontSize, lineShiftX: 0 };
  const nudged = pixelsPerPoint <= INITIAL.nudgedUpToPixelsPerPoint;
  return {
    fontSize: capFittedFontSize(fontSize, tile, pixelsPerPoint),
    lineShiftX: nudged ? Math.floor(2 * INITIAL.nudgeX * pixelsPerPoint) / (2 * pixelsPerPoint) : 0,
  };
}
