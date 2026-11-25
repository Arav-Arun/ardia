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
  const body = source.indexOf(" {\n", start) + 1;
  let depth = 1, end = body + 1;
  for (; depth && end < source.length; end++) depth += Number(source[end] === "{") - Number(source[end] === "}");
  return source.slice(start, end);
};

const compile = (t, name, source) => {
  const probe = spawnSync("swiftc", ["--version"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) return t.skip("swiftc is not available");
  const dir = mkdtempSync(join(tmpdir(), `ardia-${name}-`));
  try {
    const file = join(dir, "main.swift"), binary = join(dir, "test");
    writeFileSync(file, source);
    const built = spawnSync("swiftc", ["-swift-version", "5", file, "-o", binary], { encoding: "utf8", timeout: 120_000 });
    assert.equal(built.status, 0, built.stderr);
    const ran = spawnSync(binary, [dir], { encoding: "utf8", timeout: 10_000 });
    assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};
const ios = (name) => readFileSync(new URL(`../ios/${name}`, import.meta.url), "utf8");

test("the saved HSTS list round-trips, is removed on an all-time clear and reports write failures (Swift Testing)", (t) => {
  runSwiftTests(t, "transport-security-file-test", ["../ios/WebKitCertificatePolicy.swift", "./webkit-transport-security-file.test.swift"]);
});

test("WebKit's clear hands the time range to permissions, HSTS and site data, and finishes only after the HSTS list is saved", (t) => {
  const clear = method(ios("WebKitHub.swift"), "func clearBrowsingData(profile: String");
  compile(t, "webkit-clear-range", `${ios("WebKitSiteChoices.swift")}
var log: [String] = []
var hstsDone: ((String?) -> Void)?
func describe(_ date: Date?) -> String { date.map { String(Int($0.timeIntervalSince1970)) } ?? "all" }
enum WebKitTabHistory { static func cleared(profile: String) { log.append("history") } }
final class Certificates {
  func forgetTransportSecurity(profile: String, since: Date?, done: @escaping (String?) -> Void) { log.append("hsts " + describe(since)); hstsDone = done }
}
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
func drain() { RunLoop.main.run(until: Date().addingTimeInterval(0.05)) }
for (since, want, saveError) in [(1_800_000_000_000.0, "1800000000", nil), (0, "all", "couldn't save the HSTS list: full" as String?)] {
  log = []
  var replies: [String?] = []
  Hub().clearBrowsingData(profile: "p", types: ["siteData", "cache"], since: since) { replies.append($0) }
  drain()
  let data = want == "all" ? String(Int(Date.distantPast.timeIntervalSince1970)) : want
  precondition(log == ["hsts " + want, "choices " + want, "data " + data], log.joined(separator: ", "))
  precondition(replies.isEmpty, "the clear finished before the HSTS list was saved")
  hstsDone?(saveError)
  drain()
  precondition(replies.count == 1 && replies[0] == saveError, String(describing: replies))
}
log = []
var cacheReplies = 0
Hub().clearBrowsingData(profile: "p", types: ["cache"], since: 1_800_000_000_000) { precondition($0 == nil); cacheReplies += 1 }
drain()
precondition(log == ["data 1800000000"] && cacheReplies == 1, log.joined(separator: ", "))
`);
});

test("a ranged HSTS clear is on disk by the time it reports done, so quitting right after can't bring hosts back", (t) => {
  const source = ios("WebKitTab+Certificate.swift");
  const forget = method(source, "func forgetTransportSecurity(profile: String");
  const change = method(source, "private func change<T>(");
  compile(t, "webkit-hsts-persist", `${ios("WebKitCertificatePolicy.swift")}
import Foundation
enum StoreID: Hashable { case profile(String) }
final class Stores { func id(of profile: String) -> StoreID { .profile(profile) } }
final class WebKitHub { static let shared = WebKitHub(); let stores = Stores() }
let folder = URL(fileURLWithPath: CommandLine.arguments[1])
final class Certificates {
  static let files = DispatchQueue(label: "files")
  var policies: [StoreID: WebKitCertificatePolicy] = [:]
  static func file(for store: StoreID) -> URL? { folder.appendingPathComponent("p.json") }
  func policy(_ store: StoreID) -> WebKitCertificatePolicy {
    policies[store] ?? WebKitCertificatePolicy(transportSecurity: WebKitTransportSecurityFile.read(Self.file(for: store)!))
  }
  ${change}
  ${forget}
}
let now = Date()
let file = Certificates.file(for: .profile("p"))!
let saved = [
  "old.example": WebKitTransportSecurity(expires: now.timeIntervalSince1970 + 86_400, subdomains: false, observed: now.timeIntervalSince1970 - 7 * 86_400),
  "new.example": WebKitTransportSecurity(expires: now.timeIntervalSince1970 + 86_400, subdomains: false, observed: now.timeIntervalSince1970 - 60),
]
precondition(WebKitTransportSecurityFile.write(saved, to: file) == nil)
let certificates = Certificates()
var finished: String?? = .none
certificates.forgetTransportSecurity(profile: "p", since: now.addingTimeInterval(-3_600)) { finished = .some($0) }
let deadline = Date().addingTimeInterval(5)
while finished == nil && Date() < deadline { RunLoop.main.run(until: Date().addingTimeInterval(0.01)) }
precondition(finished == .some(nil), "the clear never finished")
precondition(Set(WebKitTransportSecurityFile.read(file).keys) == ["old.example"], String(describing: WebKitTransportSecurityFile.read(file).keys))
finished = .none
certificates.forgetTransportSecurity(profile: "p", since: nil) { finished = .some($0) }
while finished == nil && Date() < deadline { RunLoop.main.run(until: Date().addingTimeInterval(0.01)) }
precondition(finished == .some(nil) && !FileManager.default.fileExists(atPath: file.path))
`);
});
