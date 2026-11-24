import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const { DEFAULT_LOOK } = await import("../../lib/themeLook.ts");
const { setActiveLook } = await import("../../lib/activeLook.ts");
const { SIDEBAR_FIELD_CONTROL } = await import("./geometry.ts");

test("sidebar URL site controls use field-derived button metrics", () => {
  const look = { ...DEFAULT_LOOK, radii: { ...DEFAULT_LOOK.radii, chrome: 14 } };
  setActiveLook(look);
  try {
    assert.equal(SIDEBAR_FIELD_CONTROL.box, 24);
    assert.equal(SIDEBAR_FIELD_CONTROL.inset, 5);
    assert.equal(SIDEBAR_FIELD_CONTROL.radius, 9);
    assert.match(readFileSync(new URL("./SidebarField.tsx", import.meta.url), "utf8"), /radius=\{SIDEBAR_FIELD_CONTROL\.radius\}/);
  } finally {
    setActiveLook(DEFAULT_LOOK);
  }
});
