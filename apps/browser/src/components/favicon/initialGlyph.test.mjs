import assert from "node:assert/strict";
import { test } from "node:test";

globalThis.__DEV__ = false;

const { initialGlyph } = await import("./initialGlyph.ts");
const { SYSTEM_FONT } = await import("../glyph/capFit.ts");
const { appliedInterfaceScale, devicePixelsPerRootPoint } = await import("../../state/settings/interfaceScale.ts");

const capPixels = (fontSize, pixelsPerPoint) => fontSize * SYSTEM_FONT.capHeight * pixelsPerPoint;

function assertCentredOnPixels(tile, pixelsPerPoint) {
  const { fontSize } = initialGlyph(tile, pixelsPerPoint, true);
  const cap = capPixels(fontSize, pixelsPerPoint);
  assert.ok(Math.abs(cap - Math.round(cap)) < 1e-9, `cap ${cap} px is not whole at ${pixelsPerPoint}x for a ${tile} pt tile`);
  assert.equal((Math.round(tile * pixelsPerPoint) - Math.round(cap)) % 2, 0, `cap ${cap} px can't centre in a ${tile} pt tile at ${pixelsPerPoint}x`);
  const base = capPixels(Math.round(tile * 0.64), pixelsPerPoint);
  assert.ok(Math.abs(cap - base) <= 1 + 1e-9, `cap ${cap} px strays more than a pixel from ${base} px`);
}

test("the initial's cap height is whole device pixels with the tile's parity on a Retina display", () => {
  for (const tile of [12, 14, 16, 18]) assertCentredOnPixels(tile, 2);
  assert.ok(Math.abs(initialGlyph(14, 2, true).fontSize - 12 / (SYSTEM_FONT.capHeight * 2)) < 1e-9);
});

test("on a 1x display the cap height fits the 1x pixel grid, not the Retina one", () => {
  for (const tile of [12, 14, 16, 18]) assertCentredOnPixels(tile, 1);
  const compact = initialGlyph(12, 1, true);
  assert.equal((12 - Math.round(capPixels(compact.fontSize, 1))) % 2, 0);
});

test("the quarter-point nudge only lands where a device pixel can carry it", () => {
  assert.equal(initialGlyph(14, 2, true).leadInset, 0.5);
  assert.equal(initialGlyph(14, 1, true).leadInset, 0);
  assert.equal(initialGlyph(14, 2.5, true).leadInset, 0.4);
});

test("an Interface Size change refits the initial to the new device pixels per point", () => {
  appliedInterfaceScale(1);
  const before = initialGlyph(12, devicePixelsPerRootPoint(), true);
  appliedInterfaceScale(1.25);
  assert.equal(devicePixelsPerRootPoint(), 2.5);
  const after = initialGlyph(12, devicePixelsPerRootPoint(), true);
  assert.notEqual(after.fontSize, before.fontSize);
  assertCentredOnPixels(12, 2.5);
  appliedInterfaceScale(1);
});

test("Linux and Windows keep the rounded font size and no nudge", () => {
  assert.deepEqual(initialGlyph(12, 2, false), { fontSize: 8, leadInset: 0 });
  assert.deepEqual(initialGlyph(14, 2, false), { fontSize: 9, leadInset: 0 });
  assert.deepEqual(initialGlyph(18, 1, false), { fontSize: 12, leadInset: 0 });
});
