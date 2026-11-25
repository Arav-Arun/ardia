import Foundation
import Testing

struct TransportSecurityFiles {
  let folder = FileManager.default.temporaryDirectory.appendingPathComponent("ardia-hsts-\(UUID().uuidString)")
  let entries = ["bank.example": WebKitTransportSecurity(expires: 1_900_000_000, subdomains: true, observed: 1_800_000_000)]

  @Test func `a write creates its folder and reads back the same hosts`() {
    let file = folder.appendingPathComponent("nested").appendingPathComponent("p00.json")
    defer { try? FileManager.default.removeItem(at: folder) }
    #expect(WebKitTransportSecurityFile.write(entries, to: file) == nil)
    #expect(WebKitTransportSecurityFile.read(file) == entries)
  }

  @Test func `writing nothing removes the file, and a missing file is not an error`() {
    let file = folder.appendingPathComponent("p00.json")
    defer { try? FileManager.default.removeItem(at: folder) }
    #expect(WebKitTransportSecurityFile.write(entries, to: file) == nil)
    #expect(WebKitTransportSecurityFile.write(nil, to: file) == nil)
    #expect(!FileManager.default.fileExists(atPath: file.path))
    #expect(WebKitTransportSecurityFile.write(nil, to: file) == nil)
    #expect(WebKitTransportSecurityFile.read(file).isEmpty)
  }

  @Test func `a write that can't reach the disk says so`() throws {
    defer { try? FileManager.default.removeItem(at: folder) }
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    let blocker = folder.appendingPathComponent("blocker")
    try Data().write(to: blocker)
    let error = WebKitTransportSecurityFile.write(entries, to: blocker.appendingPathComponent("p00.json"))
    #expect(error?.hasPrefix("couldn't save the HSTS list") == true)
  }
}
