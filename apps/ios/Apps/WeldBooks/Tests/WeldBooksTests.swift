import XCTest
@testable import WeldBooks

final class WeldBooksTests: XCTestCase {
    func testTheAppHasAName() {
        XCTAssertFalse(BooksStrings.appName.isEmpty)
    }
}
