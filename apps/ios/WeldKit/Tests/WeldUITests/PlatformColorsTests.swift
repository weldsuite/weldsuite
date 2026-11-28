@testable import WeldUI
import XCTest

/// The hash must match the web platform's, so a person has the same colour everywhere.
final class PlatformColorsTests: XCTestCase {
    func testMatchesThePlatformsHash() {
        // Values from the platform's hashString in Node.
        XCTAssertEqual(PlatformColors.hash("e2e-visitor@example.com"), 9_689_464_202)
        XCTAssertEqual(PlatformColors.hash("gert@weldhost.com"), 1_453_002_847)
        XCTAssertEqual(PlatformColors.hash("Ann de Vries"), 483_627_419)
        XCTAssertEqual(PlatformColors.hash("Zoë 😀 Müller"), 4_093_051_470)
        XCTAssertEqual(PlatformColors.hash(""), 0)
    }

    func testFontsAreBundled() {
        for name in WeldFonts.faces.values {
            XCTAssertNotNil(WeldFonts.url(name), name)
        }
    }
}
