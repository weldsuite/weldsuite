import UIKit
import XCTest
@testable import WeldPass

@MainActor
final class ScreenCaptureTests: XCTestCase {
    /// The window's layer ends up inside the secure field's layer, which is
    /// what keeps it out of captures. Fails when an iOS release lays the
    /// field out differently.
    func testInstallPutsTheWindowInsideTheSecureField() throws {
        let scene = try XCTUnwrap(
            UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
        )
        let window = UIWindow(windowScene: scene)
        window.isHidden = false
        defer { window.isHidden = true }
        guard window.layer.superlayer != nil else {
            throw XCTSkip("The test host gave the window no layer to attach to.")
        }

        let field = try XCTUnwrap(ScreenCaptureGuard.install(in: window))

        XCTAssertTrue(field.isSecureTextEntry)
        XCTAssertTrue(field.layer.sublayers?.contains { $0 === window.layer.superlayer } ?? false)
    }
}
