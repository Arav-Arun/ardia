import { readFileSync } from "node:fs";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { runSwiftTests } from "./swift-testing.mjs";

test("a ranged clear keeps permissions and external-app allowances chosen before the range (Swift Testing)", (t) => {
  runSwiftTests(t, "site-choices-test", ["../ios/WebKitSiteChoices.swift", "./webkit-site-choices.test.swift"]);
});

const method = (source, signature) => {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, signature);
  const body = source.indexOf("{", start);
  let depth = 1, end = body + 1;
  for (; depth && end < source.length; end++) depth += Number(source[end] === "{") - Number(source[end] === "}");
  return source.slice(start, end);
};

test("WebKit's clear hands the time range to permissions, HSTS and site data alike", (t) => {
  const probe = spawnSync("swiftc", ["--version"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) return t.skip("swiftc is not available");
  const clear = method(readFileSync(new URL("../ios/WebKitHub.swift", import.meta.url), "utf8"), "func clearBrowsingData(profile: String");
  const choices = readFileSync(new URL("../ios/WebKitSiteChoices.swift", import.meta.url), "utf8");
  const dir = mkdtempSync(join(tmpdir(), "ardia-webkit-clear-range-"));
  try {
    const file = join(dir, "main.swift"), binary = join(dir, "test");
    writeFileSync(file, `${choices}
var log: [String] = []
func describe(_ date: Date?) -> String { date.map { String(Int($0.timeIntervalSince1970)) } ?? "all" }
enum WebKitTabHistory { static func cleared(profile: String) { log.append("history") } }
final class Certificates { func forgetTransportSecurity(profile: String, since: Date?) { log.append("hsts " + describe(since)) } }
final class DataStore { func removeData(ofTypes kinds: Set<String>, modifiedSince date: Date, completionHandler: @escaping () -> Void) { log.append("data " + String(Int(date.timeIntervalSince1970))); completionHandler() } }
final class Stores {
  func hasStore(for profile: String) -> Bool { true }
  func dataStore(for profile: String) -> DataStore { DataStore() }
  func forgetSitePermissions(of profile: String, since: Date?) { log.append("choices " + describe(since)) }
}
let WKWebsiteDataTypeDiskCache = "disk", WKWebsiteDataTypeMemoryCache = "memory", WKWebsiteDataTypeFetchCache = "fetch"
final class Hub {
  static let siteDataTypes: Set<String> = ["cookies"]
  let certificates = Certificates()
  let stores = Stores()
  ${clear}
}
for (since, want) in [(1_800_000_000_000.0, "1800000000"), (0, "all")] {
  log = []
  Hub().clearBrowsingData(profile: "p", types: ["siteData", "cache"], since: since) {}
  let data = want == "all" ? String(Int(Date.distantPast.timeIntervalSince1970)) : want
  precondition(log == ["hsts " + want, "choices " + want, "data " + data], log.joined(separator: ", "))
}
log = []
Hub().clearBrowsingData(profile: "p", types: ["cache"], since: 1_800_000_000_000) {}
precondition(log == ["data 1800000000"], log.joined(separator: ", "))
`);
    const built = spawnSync("swiftc", ["-swift-version", "5", file, "-o", binary], { encoding: "utf8", timeout: 120_000 });
    assert.equal(built.status, 0, built.stderr);
    const ran = spawnSync(binary, [], { encoding: "utf8", timeout: 10_000 });
    assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
