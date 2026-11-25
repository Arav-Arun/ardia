import { capFittedFontSize } from "../glyph/capFit";

const INITIAL = { scale: 0.64, nudgeX: 0.25 } as const;

export type InitialGlyph = { fontSize: number; leadInset: number };

export function initialGlyph(tile: number, pixelsPerPoint: number, snapsBaselines: boolean): InitialGlyph {
  const fontSize = Math.round(tile * INITIAL.scale);
  if (!snapsBaselines) return { fontSize, leadInset: 0 };
  return {
    fontSize: capFittedFontSize(fontSize, tile, pixelsPerPoint),
    leadInset: Math.floor(2 * INITIAL.nudgeX * pixelsPerPoint) / pixelsPerPoint,
  };
}
