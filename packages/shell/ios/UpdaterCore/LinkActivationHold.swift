import CoreGraphics

enum LinkActivationHold {
  struct Listed: Equatable {
    let number: Int
    let owner: Int32
    let layer: Int
    let bounds: CGRect
    var windowServer = false
  }

  private static let sharedEdge: CGFloat = 1
  static let overlayLayer = Int(CGWindowLevelForKey(.draggingWindow))

  static func covered(_ window: CGRect, by inFront: [CGRect]) -> Bool {
    inFront.contains {
      let overlap = window.intersection($0)
      return overlap.width > sharedEdge && overlap.height > sharedEdge
    }
  }

  static func underPointer(_ pointer: CGPoint, frontToBack list: [Listed]) -> Listed? {
    list.first { !$0.windowServer && (0..<overlayLayer).contains($0.layer) && $0.bounds.contains(pointer) }
  }

  static func leftToWindowManager(pointer: CGPoint?, own: Int32, windowManagers: Set<Int32>, frontToBack list: [Listed]) -> Bool {
    guard let pointer, !list.isEmpty else { return true }
    guard let hit = underPointer(pointer, frontToBack: list) else { return false }
    if windowManagers.contains(hit.owner) { return true }
    return hit.owner == own && list.first { $0.layer == 0 } == hit
  }
}
