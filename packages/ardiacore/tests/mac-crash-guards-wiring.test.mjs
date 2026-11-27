import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const delegate = read("../../../engine/ardiacore/src/ardia/core/ac_main_delegate.cc");
const softNavigationPatchName = "chromium-mac-soft-navigation-time-origin.patch";
const softNavigationPatch = read(`../../../engine/patches/${softNavigationPatchName}`);
const parseSteps = (text) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const [kind, name, platform = "all"] = line.split(/\s+/);
      return { kind, name, platform };
    });
const series = parseSteps(read("../../../engine/patches/series"));
const seriesWin = parseSteps(read("../../../scripts/windows/engine/series-win"));

const functionBody = (source, signature) => {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `ac_main_delegate.cc has no ${signature}`);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let at = open; at < source.length; at += 1) {
    if (source[at] === "{") depth += 1;
    if (source[at] === "}") depth -= 1;
    if (depth === 0) return source.slice(open, at + 1);
  }
  assert.fail(`${signature} never closes`);
};

test("the browser asks PartitionAlloc to dump, not crash, on a dangling Unretained pointer, as Chrome's Finch config does", () => {
  const body = functionBody(delegate, "void ReportDanglingUnretainedWithoutCrashing(base::CommandLine* command_line)");
  assert.match(body, /base::features::kPartitionAllocUnretainedDanglingPtr\.name/);
  assert.match(body, /base::features::kUnretainedDanglingPtrModeParam\.name/);
  assert.match(body, /"\/dump_without_crashing"/);
  assert.match(body, /MergeFeatures\(command_line, switches::kEnableFeatures,/);
  assert.ok(!/kDisableFeatures/.test(body), "the feature stays on, so BackupRefPtr still quarantines the freed object");
  assert.match(delegate, /#include "base\/allocator\/partition_alloc_features\.h"/);
});

test("a feature the command line already names in either list is left as the user set it", () => {
  const body = functionBody(delegate, "void ReportDanglingUnretainedWithoutCrashing(base::CommandLine* command_line)");
  assert.ok(body.indexOf("NamesFeature(*command_line, feature)") < body.indexOf("MergeFeatures("));
  const names = functionBody(delegate, "bool NamesFeature(const base::CommandLine& command_line, std::string_view feature)");
  assert.match(names, /switches::kEnableFeatures, switches::kDisableFeatures/);
  assert.match(names, /entry\.starts_with\('\*'\)/);
  assert.match(names, /entry\.substr\(0, entry\.find_first_of\("<:"\)\) == feature/);
});

test("only the browser process adds the mode, before Chrome initializes its feature list; helpers inherit the browser's", () => {
  const startup = functionBody(delegate, "std::optional<int> ACMainDelegate::BasicStartupComplete()");
  const browserOnly = startup.indexOf("if (!command_line->HasSwitch(switches::kProcessType)) {");
  const call = startup.indexOf("ReportDanglingUnretainedWithoutCrashing(command_line);");
  const chrome = startup.indexOf("return ChromeMainDelegate::BasicStartupComplete();");
  assert.ok(browserOnly >= 0 && call > browserOnly && call < chrome);
  assert.equal(startup.split("ReportDanglingUnretainedWithoutCrashing(").length, 2);
});

test("the soft navigation patch takes Chromium's Fuchsia early return on the Mac and changes nothing else", () => {
  const changed = softNavigationPatch
    .split("\n")
    .filter((line) => /^[-+](?![-+]{2} )/.test(line));
  assert.deepEqual(changed, ["-#if BUILDFLAG(IS_FUCHSIA)", "+#if BUILDFLAG(IS_FUCHSIA) || BUILDFLAG(IS_MAC)"]);
  const files = softNavigationPatch.split("\n").filter((line) => line.startsWith("+++ "));
  assert.deepEqual(files, ["+++ b/third_party/blink/renderer/core/timing/soft_navigation_heuristics.cc"]);
  assert.equal(softNavigationPatch.split("\n").filter((line) => line.startsWith("@@ ")).length, 1);
  assert.match(softNavigationPatch, /\n {5}if \(context->TimeOrigin\(\) <= loader->GetTiming\(\)\.ReferenceMonotonicTime\(\)\) \{\n/);
});

test("the soft navigation patch is in the Mac series only, and Windows skips it so its engine key stays", () => {
  const steps = series.filter((step) => step.name === softNavigationPatchName);
  assert.deepEqual(steps, [{ kind: "chromium", name: softNavigationPatchName, platform: "mac" }]);
  const firstLayer = series.findIndex((step) => step.kind === "layer");
  assert.ok(series.indexOf(steps[0]) < firstLayer);
  assert.deepEqual(
    seriesWin.filter((step) => step.name === softNavigationPatchName),
    [{ kind: "skip", name: softNavigationPatchName, platform: "all" }],
  );
});
