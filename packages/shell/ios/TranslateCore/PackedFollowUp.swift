import Foundation

enum PackedFollowUp {
  @MainActor
  static func settle<Key: Hashable>(
    _ keys: [Key],
    packed: [[String]?],
    owner: String,
    work: SharedWork<Key, [String]>,
    unchanged: (Key, [String]) -> Bool,
    alone: @escaping @MainActor (Key) async -> [String]?,
    again: @escaping @MainActor (Key, [String]) async -> [String]?
  ) async -> [[String]?] {
    var out: [[String]?] = []
    for (i, key) in keys.enumerated() {
      let parts = packed.indices.contains(i) ? packed[i] : nil
      if let parts, !unchanged(key, parts) {
        out.append(parts)
        continue
      }
      let asked = await work.value(for: key, owner: owner) {
        if let parts { return await again(key, parts) }
        return await alone(key)
      }
      out.append(asked ?? parts)
    }
    return out
  }
}
