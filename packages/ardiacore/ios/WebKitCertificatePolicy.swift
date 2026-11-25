import Foundation

struct WebKitTransportSecurity: Codable, Equatable, Sendable {
  let expires: Double
  let subdomains: Bool
  let observed: Double?

  init(expires: Double, subdomains: Bool, observed: Double? = nil) {
    self.expires = expires
    self.subdomains = subdomains
    self.observed = observed
  }
}

struct WebKitCertificatePolicy: Sendable {
  struct Exception: Equatable, Sendable {
    let errors: Set<String>
    let granted: Date

    var expires: Date { granted.addingTimeInterval(WebKitCertificatePolicy.exceptionLifetime) }
  }

  struct Bypass: Equatable, Sendable {
    var errors: Set<String>
    var granted: Date
  }

  static let exceptionLifetime: TimeInterval = 7 * 86_400
  static let fatalErrors: Set<String> = ["invalid", "revoked"]
  static let dynamicHostLimit = 5_000
  static let maxAgeLimit: TimeInterval = 365 * 86_400

  private(set) var exceptions: [String: [String: Exception]] = [:]
  private(set) var bypassed: [String: [String: Bypass]] = [:]
  private(set) var transportSecurity: [String: WebKitTransportSecurity] = [:]

  init(transportSecurity: [String: WebKitTransportSecurity] = [:]) {
    self.transportSecurity = transportSecurity
  }

  static func normalizedHost(_ host: String) -> String {
    host.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "."))
  }

  static func overridable(_ errors: [String]) -> Bool {
    !errors.isEmpty && fatalErrors.isDisjoint(with: errors)
  }

  mutating func allow(host: String, fingerprint: String, errors: [String], now: Date) {
    guard Self.overridable(errors) else { return }
    exceptions[Self.normalizedHost(host), default: [:]][fingerprint] = Exception(errors: Set(errors), granted: now)
  }

  func hasException(host: String, now: Date) -> Bool {
    let name = Self.normalizedHost(host)
    if bypassed[name] != nil { return true }
    return exceptions[name]?.values.contains { $0.expires > now } == true
  }

  mutating func admits(host: String, fingerprint: String, errors: [String], now: Date) -> Bool {
    let name = Self.normalizedHost(host)
    guard let exception = exceptions[name]?[fingerprint] else { return false }
    guard exception.expires > now else {
      exceptions[name]?.removeValue(forKey: fingerprint)
      if exceptions[name]?.isEmpty == true { exceptions.removeValue(forKey: name) }
      return false
    }
    guard Self.overridable(errors), Set(errors).isSubset(of: exception.errors) else { return false }
    var bypass = bypassed[name]?[fingerprint] ?? Bypass(errors: [], granted: exception.granted)
    bypass.errors.formUnion(errors)
    bypass.granted = max(bypass.granted, exception.granted)
    bypassed[name, default: [:]][fingerprint] = bypass
    return true
  }

  func bypassedErrors(host: String, fingerprint: String?) -> [String]? {
    guard let byPrint = bypassed[Self.normalizedHost(host)] else { return nil }
    guard let fingerprint else { return Array(Set(byPrint.values.flatMap(\.errors))).sorted() }
    return byPrint[fingerprint].map { Array($0.errors).sorted() }
  }

  func trustedThroughBypass(host: String, fingerprint: String?) -> Bool {
    guard let fingerprint else { return false }
    return bypassed[Self.normalizedHost(host)]?[fingerprint] != nil
  }

  mutating func noteHeader(_ header: String, host: String, fingerprint: String? = nil, now: Date) -> Bool {
    guard !trustedThroughBypass(host: host, fingerprint: fingerprint), let parsed = Self.parse(header) else { return false }
    let name = Self.normalizedHost(host)
    guard !name.isEmpty else { return false }
    if parsed.maxAge <= 0 { return transportSecurity.removeValue(forKey: name) != nil }
    let entry = WebKitTransportSecurity(expires: now.addingTimeInterval(parsed.maxAge).timeIntervalSince1970, subdomains: parsed.subdomains, observed: now.timeIntervalSince1970)
    guard transportSecurity[name] != entry else { return false }
    transportSecurity[name] = entry
    trim(now: now)
    return true
  }

  func requiresHTTPS(host: String, now: Date) -> Bool {
    let labels = Self.normalizedHost(host).split(separator: ".", omittingEmptySubsequences: false)
    for index in labels.indices {
      let candidate = labels[index...].joined(separator: ".")
      guard let entry = transportSecurity[candidate], entry.expires > now.timeIntervalSince1970 else { continue }
      if index == labels.startIndex || entry.subdomains { return true }
    }
    return false
  }

  mutating func forget(since: Date) {
    let cutoff = since.timeIntervalSince1970
    transportSecurity = transportSecurity.filter { ($0.value.observed ?? -.infinity) < cutoff }
    exceptions = Self.keeping(exceptions) { $0.granted < since }
    bypassed = Self.keeping(bypassed) { $0.granted < since }
  }

  private static func keeping<Value>(_ byHost: [String: [String: Value]], _ keep: (Value) -> Bool) -> [String: [String: Value]] {
    byHost.compactMapValues { byPrint in
      let kept = byPrint.filter { keep($0.value) }
      return kept.isEmpty ? nil : kept
    }
  }

  func savedTransportSecurity(now: Date) -> [String: WebKitTransportSecurity] {
    transportSecurity.filter { $0.value.expires > now.timeIntervalSince1970 }
  }

  private mutating func trim(now: Date) {
    let cutoff = now.timeIntervalSince1970
    transportSecurity = transportSecurity.filter { $0.value.expires > cutoff }
    guard transportSecurity.count > Self.dynamicHostLimit else { return }
    let dropped = transportSecurity.sorted { $0.value.expires < $1.value.expires }.prefix(transportSecurity.count - Self.dynamicHostLimit)
    for (host, _) in dropped { transportSecurity.removeValue(forKey: host) }
  }

  static func parse(_ header: String) -> (maxAge: TimeInterval, subdomains: Bool)? {
    var maxAge: TimeInterval?
    var subdomains = false
    var seen = Set<String>()
    for directive in header.split(separator: ";") {
      let parts = directive.split(separator: "=", maxSplits: 1).map { $0.trimmingCharacters(in: .whitespaces) }
      guard let name = parts.first?.lowercased(), !name.isEmpty else { continue }
      guard seen.insert(name).inserted else { return nil }
      switch name {
      case "max-age":
        guard parts.count == 2 else { return nil }
        let raw = parts[1].count >= 2 && parts[1].hasPrefix("\"") && parts[1].hasSuffix("\"") ? String(parts[1].dropFirst().dropLast()) : parts[1]
        guard !raw.isEmpty, raw.allSatisfy(\.isASCII), raw.allSatisfy(\.isNumber), let value = TimeInterval(raw) else { return nil }
        maxAge = min(value, maxAgeLimit)
      case "includesubdomains":
        guard parts.count == 1 else { return nil }
        subdomains = true
      default: break
      }
    }
    return maxAge.map { ($0, subdomains) }
  }
}

enum WebKitTransportSecurityFile {
  static func read(_ file: URL) -> [String: WebKitTransportSecurity] {
    guard let data = try? Data(contentsOf: file),
      let saved = try? JSONDecoder().decode([String: WebKitTransportSecurity].self, from: data)
    else { return [:] }
    return saved
  }

  static func write(_ entries: [String: WebKitTransportSecurity]?, to file: URL) -> String? {
    do {
      guard let entries else {
        if FileManager.default.fileExists(atPath: file.path) { try FileManager.default.removeItem(at: file) }
        return nil
      }
      let data = try JSONEncoder().encode(entries)
      try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
      try data.write(to: file, options: .atomic)
      return nil
    } catch {
      return "couldn't save the HSTS list: \(error.localizedDescription)"
    }
  }
}
