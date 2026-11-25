import XCTest
@testable import ArdiaTranslateCore

final class PackedPassagesTests: XCTestCase {
  private enum Run {
    case piece(String, Int, Int)
    case gap(String, Int)
    case plain(String)
  }

  private func answer(_ runs: [Run]) -> AttributedString {
    var text = AttributedString()
    for run in runs {
      switch run {
      case let .piece(words, p, i):
        var r = AttributedString(words)
        r.link = URL(string: "ac-piece:\(p).\(i)")
        text += r
      case let .gap(words, p):
        var r = AttributedString(words)
        r.link = URL(string: "ac-gap:\(p)")
        text += r
      case let .plain(words):
        text += AttributedString(words)
      }
    }
    return text
  }

  func testEveryPassageAndPieceIsTaggedWithGapsBetweenPassages() {
    let text = PackedPassages.text([["Hauptseite"], ["Lies die ", "Hinweise"]])
    let runs = text.runs.map { (String(text[$0.range].characters), $0.link?.absoluteString ?? "") }
    XCTAssertEqual(runs.map(\.0), ["Hauptseite", " · ", "Lies die ", "Hinweise"])
    XCTAssertEqual(runs.map(\.1), ["ac-piece:0.0", "ac-gap:1", "ac-piece:1.0", "ac-piece:1.1"])
  }

  func testEachPassageGetsItsOwnPartsBack() {
    let parts = PackedPassages.parts(
      of: answer([.piece("Main page", 0, 0), .gap(" · ", 1), .piece("Read the ", 1, 0), .piece("notes", 1, 1)]),
      over: [["Hauptseite"], ["Lies die ", "Hinweise"]])
    XCTAssertEqual(parts.count, 2)
    XCTAssertEqual(parts[0], ["Main page"])
    XCTAssertEqual(parts[1], ["Read the ", "notes"])
  }

  func testAPassageMissingATagFailsAloneSoOnlyItIsAskedAgain() {
    let parts = PackedPassages.parts(
      of: answer([.piece("Main page", 0, 0), .gap(" · ", 1), .piece("Read the notes", 1, 0), .gap(" · ", 2), .piece("Help", 2, 0)]),
      over: [["Hauptseite"], ["Lies die ", "Hinweise"], ["Hilfe"]])
    XCTAssertEqual(parts[0], ["Main page"])
    XCTAssertNil(parts[1])
    XCTAssertEqual(parts[2], ["Help"])
  }

  func testASeparatorLeftInAnAnswerFailsThatPassage() {
    let parts = PackedPassages.parts(
      of: answer([.piece("Main page ·", 0, 0), .gap(" ", 1), .piece("Help", 1, 0)]),
      over: [["Hauptseite"], ["Hilfe"]])
    XCTAssertNil(parts[0])
    XCTAssertEqual(parts[1], ["Help"])
  }

  func testUntaggedTextFollowsThePieceBeforeItInItsOwnPassage() {
    let parts = PackedPassages.parts(
      of: answer([.plain("« "), .piece("Read", 0, 0), .plain(" »"), .gap(" · ", 1), .piece("Help", 1, 0)]),
      over: [["Lies"], ["Hilfe"]])
    XCTAssertEqual(parts[0], ["« Read »"])
    XCTAssertEqual(parts[1], ["Help"])
  }

  func testEdgesKeepTheSourceWhitespaceNotTheModels() {
    let parts = PackedPassages.parts(
      of: answer([.piece("Main page ", 0, 0), .gap(" · ", 1), .piece(" Read the ", 1, 0), .piece("notes ", 1, 1)]),
      over: [["Hauptseite"], [" Lies die ", "Hinweise"]])
    XCTAssertEqual(parts[0], ["Main page"])
    XCTAssertEqual(parts[1], [" Read the ", "notes"])
  }

  func testAForeignTagFailsTheWholePack() {
    var text = AttributedString("x")
    text.link = URL(string: "https://example.com")
    XCTAssertEqual(PackedPassages.parts(of: text, over: [["a"], ["b"]]).compactMap { $0 }.count, 0)
  }

  func testAMissingGapLeavesBothPassagesToBeAskedAgainInsteadOfMovingTextAcross() {
    let parts = PackedPassages.parts(
      of: answer([.piece("Settings", 0, 0), .plain(" Helpful "), .piece("links", 1, 0), .gap(" · ", 2), .piece("Help", 2, 0)]),
      over: [["Einstellungen"], ["Links"], ["Hilfe"]])
    XCTAssertNil(parts[0])
    XCTAssertNil(parts[1])
    XCTAssertEqual(parts[2], ["Help"])
  }

  func testAPassageWhosePiecesStraddleAnotherPassageIsAskedAgain() {
    let parts = PackedPassages.parts(
      of: answer([.piece("Read the ", 0, 0), .gap(" · ", 1), .piece("Help", 1, 0), .piece("notes", 0, 1)]),
      over: [["Lies die ", "Hinweise"], ["Hilfe"]])
    XCTAssertNil(parts[0])
    XCTAssertNil(parts[1])
  }

  func testUntaggedTextRightAfterAGapGoesToTheNextPassageOnly() {
    let parts = PackedPassages.parts(
      of: answer([.piece("Main page", 0, 0), .gap(" · ", 1), .plain("« "), .piece("Help", 1, 0)]),
      over: [["Hauptseite"], ["Hilfe"]])
    XCTAssertEqual(parts[0], ["Main page"])
    XCTAssertEqual(parts[1], ["« Help"])
  }

  func testPacksStopAtTheCharacterLimitAndTheCount() {
    let passages = [["aaaa"], ["bb"], ["cccccc"], ["d"], ["e"], ["f"]]
    XCTAssertEqual(PackedPassages.packs(passages, limit: 6, count: 10), [0..<2, 2..<3, 3..<6])
    XCTAssertEqual(PackedPassages.packs(passages, limit: 100, count: 4), [0..<4, 4..<6])
    XCTAssertEqual(PackedPassages.packs([["long passage over the limit"]], limit: 4, count: 4), [0..<1])
    XCTAssertEqual(PackedPassages.packs([], limit: 4, count: 4), [])
  }
}
