import { capFittedFontSize } from "../glyph/capFit";

const INITIAL = { scale: 0.64, nudgeX: 0.25 } as const;

export type InitialGlyph = { fontSize: number; lineShiftX: number };

export function initialGlyph(tile: number, pixelsPerPoint: number, snapsBaselines: boolean): InitialGlyph {
  const fontSize = Math.round(tile * INITIAL.scale);
  if (!snapsBaselines) return { fontSize, lineShiftX: 0 };
  return {
    fontSize: capFittedFontSize(fontSize, tile, pixelsPerPoint),
    lineShiftX: Math.floor(2 * INITIAL.nudgeX * pixelsPerPoint) / (2 * pixelsPerPoint),
  };
}
