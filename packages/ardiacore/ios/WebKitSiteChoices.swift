import Foundation

struct WebKitSiteKey: Hashable {
  let site: String
  let kind: String
}

struct WebKitExternalGrant {
  let origin: String
  let scheme: String
  let app: String
  let appPath: String
}

struct WebKitStoreState {
  private(set) var remembered: [WebKitSiteKey: Bool] = [:]
  private(set) var externalAllowances: [WebKitSiteKey: WebKitExternalGrant] = [:]
  var zoom: [String: Double] = [:]
  private var rememberedAt: [WebKitSiteKey: Date] = [:]
  private var allowedAt: [WebKitSiteKey: Date] = [:]

  mutating func remember(_ key: WebKitSiteKey, allowed: Bool, at now: Date = Date()) {
    remembered[key] = allowed
    rememberedAt[key] = now
  }

  mutating func forgetAnswer(_ key: WebKitSiteKey) {
    remembered.removeValue(forKey: key)
    rememberedAt.removeValue(forKey: key)
  }

  mutating func allowExternal(_ key: WebKitSiteKey, _ grant: WebKitExternalGrant, at now: Date = Date()) {
    externalAllowances[key] = grant
    allowedAt[key] = now
  }

  mutating func removeExternal(_ key: WebKitSiteKey) {
    externalAllowances.removeValue(forKey: key)
    allowedAt.removeValue(forKey: key)
  }

  mutating func forgetSiteChoices(since: Date?) {
    guard let since else {
      remembered = [:]
      rememberedAt = [:]
      externalAllowances = [:]
      allowedAt = [:]
      return
    }
    for (key, at) in rememberedAt where at >= since { forgetAnswer(key) }
    for (key, at) in allowedAt where at >= since { removeExternal(key) }
  }

  static func rangeStart(sinceMilliseconds since: Double) -> Date? {
    since.isFinite && since > 0 ? Date(timeIntervalSince1970: since / 1000) : nil
  }
}
