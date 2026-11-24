import assert from "node:assert/strict";
import { test } from "node:test";
const { layout } = await import("../ui/theme.ts");
const { HEADER_TOOLS, headerToggleXIn } = await import("./dockMotion.ts");
const headerToggleX = (windowFullScreen) => headerToggleXIn({ windowFullScreen, pageFullScreen: false, controlsRow: false });
const { NO_TOOLBAR, toolbarButtonPlacements, toolbarGeometry, toolbarLeadingCorner } = await import("./geometry.ts");

test("the Mac keeps every place laid out around the traffic lights where it was", () => {
  assert.equal(layout.trafficLightsWidth, 78);
  assert.equal(HEADER_TOOLS.toggleX, 97.75);
  assert.equal(headerToggleX(false), 97.75);
  assert.equal(headerToggleX(true), 29);
  for (const state of [{ windowFullScreen: false, pageFullScreen: true, controlsRow: false }, { windowFullScreen: false, pageFullScreen: false, controlsRow: true }]) {
    assert.equal(headerToggleXIn(state), 97.75, "the traffic lights keep their toggle whatever the page or the controls row do");
  }
});

test("the Mac toolbar keeps its buttons and leaves no trailing room", () => {
  assert.deepEqual(toolbarGeometry({ sidebarButton: true }), { sidebarButton: 21, back: 56, forward: 92, reload: 127, urlLeft: 145, trailing: 0, cardRadius: 0, cardInset: 0, leadingAtCardCorner: false });
  assert.deepEqual(toolbarGeometry({ sidebarButton: false }), { sidebarButton: null, back: 21, forward: 57, reload: 92, urlLeft: 110, trailing: 0, cardRadius: 0, cardInset: 0, leadingAtCardCorner: false });
  assert.deepEqual(NO_TOOLBAR, { sidebarButton: null, back: 21, forward: 21, reload: 21, urlLeft: 8, trailing: 0, cardRadius: 0, cardInset: 0, leadingAtCardCorner: false });
  assert.equal(toolbarGeometry({ sidebarButton: true, trailing: 129 }).trailing, 129);
  assert.equal(toolbarGeometry({ sidebarButton: true, cardRadius: 10 }).cardRadius, 10);
});

test("the first toolbar button follows the page-frame corner, whether it is Hide Tabs or Back", () => {
  const row = { button: 30, center: 21.2 };
  const hideTabs = toolbarGeometry({ sidebarButton: true, cardRadius: 10, cardInset: 9, leadingAtCardCorner: true });
  const back = toolbarGeometry({ sidebarButton: false, cardRadius: 10, cardInset: 9, leadingAtCardCorner: true });
  const otherPane = toolbarGeometry({ sidebarButton: false, cardRadius: 10, cardInset: 9 });
  assert.deepEqual(toolbarLeadingCorner(hideTabs, row), { button: "sidebar", radius: 12.8 });
  assert.deepEqual(toolbarLeadingCorner(back, row), { button: "back", radius: 12.8 });
  assert.deepEqual(toolbarLeadingCorner(otherPane, row), { button: null });
  assert.equal(toolbarLeadingCorner(toolbarGeometry({ sidebarButton: false, leadingAtCardCorner: true }), row).radius, 0);
  assert.equal(toolbarLeadingCorner(back, { button: 22, center: 14 }).radius, 9);
  assert.equal(toolbarButtonPlacements(hideTabs, { ...row, buttonRadius: 8 }).sidebarButton.hit.topLeftRadius, 12.8);
  assert.equal(toolbarButtonPlacements(back, { ...row, buttonRadius: 8 }).back.hit.topLeftRadius, 12.8);
  assert.equal(toolbarButtonPlacements(otherPane, { ...row, buttonRadius: 8 }).back.hit.topLeftRadius, undefined);
});
