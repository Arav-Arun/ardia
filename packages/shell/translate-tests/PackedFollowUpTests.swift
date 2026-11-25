import XCTest
@testable import ArdiaTranslateCore

@MainActor
final class PackedFollowUpTests: XCTestCase {
  private final class Gate {
    var continuations: [CheckedContinuation<Void, Never>] = []
    func wait() async { await withCheckedContinuation { continuations.append($0) } }
    func open() {
      continuations.forEach { $0.resume() }
      continuations = []
    }
  }

  private func settle() async {
    for _ in 0..<5 { await Task.yield() }
  }

  func testAnswersThatChangedNeedNoFollowUp() async {
    let work = SharedWork<String, [String]>()
    work.open(owner: "tab")
    var asked: [String] = []
    let out = await PackedFollowUp.settle(
      ["a", "b"], packed: [["A"], ["B"]], owner: "tab", work: work,
      unchanged: { key, parts in parts == [key] },
      alone: { key in asked.append(key); return nil },
      again: { key, _ in asked.append(key); return nil })
    XCTAssertEqual(out, [["A"], ["B"]])
    XCTAssertEqual(asked, [])
  }

  func testAPassageThePackLostGoesAloneAndAnUnchangedOneIsAskedAgain() async {
    let work = SharedWork<String, [String]>()
    work.open(owner: "tab")
    var alone: [String] = []
    var again: [String] = []
    let out = await PackedFollowUp.settle(
      ["a", "b", "c"], packed: [nil, ["b"], ["C"]], owner: "tab", work: work,
      unchanged: { key, parts in parts == [key] },
      alone: { key in alone.append(key); return [key.uppercased()] },
      again: { key, _ in again.append(key); return [key.uppercased()] })
    XCTAssertEqual(out, [["A"], ["B"], ["C"]])
    XCTAssertEqual(alone, ["a"])
    XCTAssertEqual(again, ["b"])
  }

  func testShowOriginalStopsTheRetriesStillToComeAndCancelsTheOneRunning() async {
    let work = SharedWork<String, [String]>()
    let gate = Gate()
    work.open(owner: "tab")
    var started: [String] = []
    var cancelled: [String] = []
    async let out = PackedFollowUp.settle(
      ["a", "b", "c"], packed: [["a"], ["b"], ["c"]], owner: "tab", work: work,
      unchanged: { key, parts in parts == [key] },
      alone: { _ in nil },
      again: { key, parts in
        started.append(key)
        await gate.wait()
        if Task.isCancelled { cancelled.append(key) }
        return Task.isCancelled ? nil : ["\(key) again"]
      })
    await settle()
    XCTAssertEqual(started, ["a"])
    work.cancel(owner: "tab")
    gate.open()
    let answers = await out
    XCTAssertEqual(started, ["a"])
    XCTAssertEqual(cancelled, ["a"])
    XCTAssertEqual(answers, [["a"], ["b"], ["c"]])
  }
}
