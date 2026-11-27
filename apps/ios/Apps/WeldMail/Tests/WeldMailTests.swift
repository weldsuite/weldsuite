import XCTest
@testable import WeldMail

final class WeldMailTests: XCTestCase {
    func testTheAppHasAName() {
        XCTAssertFalse(MailStrings.appName.isEmpty)
    }
}
