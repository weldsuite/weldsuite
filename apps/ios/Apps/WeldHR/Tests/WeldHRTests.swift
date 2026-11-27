import XCTest
@testable import WeldHR

final class WeldHRTests: XCTestCase {
    func testTheAppHasAName() {
        XCTAssertFalse(HRStrings.appName.isEmpty)
    }
}
