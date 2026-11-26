import Foundation
import LocalAuthentication
import Observation

/// The app lock: Face ID, Touch ID or the passcode.
///
/// In `required` mode (WeldPass) the app starts locked and locks again after
/// `grace` in the background. `confirm` asks before a secret is shown or
/// copied; one confirmation covers the next `confirmWindow`.
@MainActor
@Observable
public final class AppLock {
    public private(set) var isLocked: Bool

    @ObservationIgnored private let required: Bool
    @ObservationIgnored private let grace: TimeInterval
    @ObservationIgnored private let confirmWindow: TimeInterval
    @ObservationIgnored private var backgroundedAt: Date?
    @ObservationIgnored private var confirmedAt = Date.distantPast

    public init(required: Bool, grace: TimeInterval = 60, confirmWindow: TimeInterval = 10) {
        self.required = required
        self.grace = grace
        self.confirmWindow = confirmWindow
        isLocked = required
    }

    /// Whether the phone has a passcode at all. Without one, WeldPass can't be used.
    public var hasScreenLock: Bool {
        LAContext().canEvaluatePolicy(.deviceOwnerAuthentication, error: nil)
    }

    /// "Face ID", "Touch ID" or "Optic ID"; nil when only the passcode is set up.
    public var biometryName: String? {
        let context = LAContext()
        guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil) else { return nil }
        switch context.biometryType {
        case .faceID: return "Face ID"
        case .touchID: return "Touch ID"
        case .opticID: return "Optic ID"
        default: return nil
        }
    }

    /// The context the last unlock authenticated, until the app locks again.
    /// A Keychain item behind the same check can be read with it without a
    /// second prompt (WeldPass's offline copy key).
    @ObservationIgnored public private(set) var unlockedContext: LAContext?

    public func unlock(reason: String) async -> Bool {
        guard isLocked else { return true }
        let context = LAContext()
        let ok = await authenticate(reason: reason, context: context)
        if ok {
            unlockedContext = context
            isLocked = false
            confirmedAt = Date()
        }
        return ok
    }

    /// Ask before a secret is shown or copied, unless the last confirmation was moments ago.
    public func confirm(reason: String) async -> Bool {
        if Date().timeIntervalSince(confirmedAt) < confirmWindow { return true }
        let ok = await authenticate(reason: reason, context: LAContext())
        if ok { confirmedAt = Date() }
        return ok
    }

    public func didEnterBackground() {
        backgroundedAt = Date()
    }

    public func willEnterForeground() {
        guard let since = backgroundedAt else { return }
        backgroundedAt = nil
        if required, Date().timeIntervalSince(since) >= grace { relock() }
    }

    public func lockNow() {
        if required { relock() }
        confirmedAt = .distantPast
    }

    private func relock() {
        isLocked = true
        unlockedContext?.invalidate()
        unlockedContext = nil
    }

    private func authenticate(reason: String, context: LAContext) async -> Bool {
        do {
            return try await context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason)
        } catch {
            return false
        }
    }
}
