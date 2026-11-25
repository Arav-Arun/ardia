import assert from "node:assert/strict";
import { test } from "node:test";

globalThis.__DEV__ = false;

const { initialGlyph } = await import("./initialGlyph.ts");
const { inkCentered } = await import("../glyph/CapCenteredLetter.tsx");
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

test("the line moves right a quarter point, in half device pixels the subpixel-positioned text can land on", () => {
  for (const [pixelsPerPoint, pixels] of [[1, 0], [2, 0.5], [2.5, 0.5], [3, 0]]) {
    const { lineShiftX } = initialGlyph(14, pixelsPerPoint, true);
    assert.equal(lineShiftX * pixelsPerPoint, pixels, `${pixelsPerPoint}x moves the glyph ${lineShiftX * pixelsPerPoint} px`);
    assert.ok(lineShiftX <= 0.25);
    assert.equal(Number.isInteger(2 * lineShiftX * pixelsPerPoint), true, "the padding that centres it is whole device pixels");
  }
});

test("a tile that doesn't span whole device pixels keeps the rounded size and no nudge", () => {
  for (const pixelsPerPoint of [1.7, 1.8, 2.1, 2.3]) assert.deepEqual(initialGlyph(14, pixelsPerPoint, true), { fontSize: 9, lineShiftX: 0 });
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
  assert.deepEqual(initialGlyph(12, 2, false), { fontSize: 8, lineShiftX: 0 });
  assert.deepEqual(initialGlyph(14, 2, false), { fontSize: 9, lineShiftX: 0 });
  assert.deepEqual(initialGlyph(18, 1, false), { fontSize: 12, lineShiftX: 0 });
});

test("the letter's vertical offset is rounded once onto each Interface Size's device grid", () => {
  const metrics = { ascender: 8.23, capHeight: 6 };
  for (const [scale, pixelsPerPoint] of [[0.85, 1.7], [1, 2], [1.15, 2.3], [1.25, 2.5], [1.25, 1.25]]) {
    for (const box of [12, 14, 18]) {
      const holder = inkCentered(box, 0, metrics.capHeight / 2, metrics, 0, pixelsPerPoint);
      const exact = box / 2 - Math.round(metrics.ascender) + metrics.capHeight / 2;
      const laid = holder.top * pixelsPerPoint;
      const placed = (holder.top + holder.transform[1].translateY) * pixelsPerPoint;
      assert.ok(Math.abs(laid - Math.round(laid)) < 1e-9, `${scale} lays the holder at ${laid} px`);
      assert.ok(Math.abs(placed - Math.round(exact * pixelsPerPoint)) < 1e-9, `${scale} places a ${box} pt letter at ${placed} px, not ${Math.round(exact * pixelsPerPoint)}`);
    }
  }
});
