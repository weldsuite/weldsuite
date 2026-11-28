import XCTest
@testable import WeldChat

final class WeldChatTests: XCTestCase {
    func testTheAppHasAName() {
        XCTAssertFalse(ChatStrings.appName.isEmpty)
    }
}
