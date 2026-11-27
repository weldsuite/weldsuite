import XCTest
@testable import WeldCalendar

final class WeldCalendarTests: XCTestCase {
    func testTheAppHasAName() {
        XCTAssertFalse(CalendarStrings.appName.isEmpty)
    }
}
