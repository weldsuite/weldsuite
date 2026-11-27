import XCTest
@testable import WeldDesk

final class WeldDeskTests: XCTestCase {
    func testTheAppHasAName() {
        XCTAssertFalse(DeskStrings.appName.isEmpty)
    }
}
