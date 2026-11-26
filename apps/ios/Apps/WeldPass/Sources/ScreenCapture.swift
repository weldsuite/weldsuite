import SwiftUI
import UIKit

/// Keeps the screens that show an item's fields out of screenshots, screen
/// recordings and mirroring, as the Expo app did with expo-screen-capture.
/// Android blocks captures app-wide with `FLAG_SECURE`.
///
/// iOS has no API for this. The window's layer is drawn inside a secure text
/// field's layer, which every capture leaves blank while `isSecureTextEntry`
/// is on; switched off, the window looks and captures as usual.
@MainActor
enum ScreenCaptureGuard {
    private static var field: UITextField?
    private static var screens = 0

    /// An item screen appeared.
    static func prevent() {
        screens += 1
        if field == nil, let window = keyWindow() { field = install(in: window) }
        field?.isSecureTextEntry = true
    }

    /// An item screen went away. Captures work again once none is left.
    static func allow() {
        screens = max(0, screens - 1)
        if screens == 0 { field?.isSecureTextEntry = false }
    }

    /// Puts the window's layer inside a secure field's layer, once per
    /// window. Nil, and the window untouched, when iOS doesn't lay the field
    /// out as expected.
    static func install(in window: UIWindow) -> UITextField? {
        guard let superlayer = window.layer.superlayer else { return nil }
        let field = UITextField()
        field.isSecureTextEntry = true
        field.isUserInteractionEnabled = false
        field.translatesAutoresizingMaskIntoConstraints = false
        window.addSubview(field)
        NSLayoutConstraint.activate([
            field.centerXAnchor.constraint(equalTo: window.centerXAnchor),
            field.centerYAnchor.constraint(equalTo: window.centerYAnchor),
        ])
        // Since iOS 17 the layer a secure field hides is its last sublayer.
        guard let secureLayer = field.layer.sublayers?.last else {
            field.removeFromSuperview()
            return nil
        }
        superlayer.addSublayer(field.layer)
        secureLayer.addSublayer(window.layer)
        return field
    }

    private static func keyWindow() -> UIWindow? {
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
            .first(where: \.isKeyWindow)
    }
}

extension View {
    /// Leaves this screen out of screenshots and recordings while it's shown.
    func preventsScreenCapture() -> some View {
        onAppear { ScreenCaptureGuard.prevent() }
            .onDisappear { ScreenCaptureGuard.allow() }
    }
}
