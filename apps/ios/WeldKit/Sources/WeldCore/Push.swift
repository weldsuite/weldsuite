import CoreAPI
import Foundation
import Observation
import UIKit
import UserNotifications

/// What a push carries in its `data`, every value a string: `notificationType`,
/// `actionUrl`, `entityType`, `entityId`, `server` (the install it comes
/// from) and whatever the notification adds (`chatChannelId`, …).
public struct PushPayload: Sendable, Equatable {
    public let values: [String: String]

    public init(values: [String: String]) {
        self.values = values
    }

    /// From a notification's `userInfo`: the `data` object the server sends
    /// next to `aps`, or the top level when there is none.
    public init(userInfo: [AnyHashable: Any]) {
        let source = userInfo["data"] as? [AnyHashable: Any] ?? userInfo
        var values: [String: String] = [:]
        for (key, value) in source {
            guard let key = key as? String, key != "aps" else { continue }
            switch value {
            case let text as String: values[key] = text
            case let number as NSNumber: values[key] = number.stringValue
            default: break
            }
        }
        self.values = values
    }

    public var notificationType: String? { nonEmpty("notificationType") }
    public var actionURL: String? { nonEmpty("actionUrl") }
    public var entityType: String? { nonEmpty("entityType") }
    public var entityID: String? { nonEmpty("entityId") }
    public var server: String? { nonEmpty("server") }

    public subscript(key: String) -> String? { nonEmpty(key) }

    private func nonEmpty(_ key: String) -> String? {
        guard let value = values[key], !value.isEmpty else { return nil }
        return value
    }
}

/// The process's notifications: the APNs device token, what shows while the
/// app is open, and taps. `WeldAppDelegate` hands it the token; each app's
/// `AppEnvironment` registers that token with its server.
@MainActor
@Observable
public final class PushCenter: NSObject {
    public static let shared = PushCenter()

    /// A tapped notification the app hasn't handled yet. The app reads it
    /// through `AppEnvironment.takePushTap()`, which drops taps from another server.
    public var pendingTap: PushPayload?

    /// The APNs device token, hex-encoded, once iOS has handed it over.
    @ObservationIgnored public private(set) var deviceToken: String?

    /// Whether a push that arrives while the app is open shows a banner. An
    /// app sets this to hide pushes about what is already on screen.
    @ObservationIgnored public var shouldPresent: (PushPayload) -> Bool = { _ in true }

    @ObservationIgnored var onToken: ((String) -> Void)?

    /// Ask to show notifications (once; iOS remembers the answer) and
    /// register for remote notifications when allowed.
    @discardableResult
    public func requestAuthorization() async -> Bool {
        let center = UNUserNotificationCenter.current()
        let granted = (try? await center.requestAuthorization(options: [.alert, .badge, .sound])) ?? false
        if granted { UIApplication.shared.registerForRemoteNotifications() }
        return granted
    }

    /// Whether notifications are allowed (to show a hint in settings when they aren't).
    public func isAuthorized() async -> Bool {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        return settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional
    }

    public func didRegister(deviceToken data: Data) {
        let token = data.map { String(format: "%02x", $0) }.joined()
        deviceToken = token
        onToken?(token)
    }

    public func didFailToRegister(_ error: Error) {
        deviceToken = nil
    }

    /// Clear the badge (the app was opened).
    public func clearBadge() {
        UNUserNotificationCenter.current().setBadgeCount(0) { _ in }
    }
}

extension PushCenter: UNUserNotificationCenterDelegate {
    public nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        let payload = PushPayload(userInfo: notification.request.content.userInfo)
        let show = await MainActor.run { self.shouldPresent(payload) }
        return show ? [.banner, .list, .sound, .badge] : []
    }

    public nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        let payload = PushPayload(userInfo: response.notification.request.content.userInfo)
        await MainActor.run { self.pendingTap = payload }
    }
}

/// The app delegate every native app uses
/// (`@UIApplicationDelegateAdaptor(WeldAppDelegate.self)`): it makes
/// `PushCenter` the notification delegate and hands it the APNs token.
/// WeldChat subclasses it for PushKit.
open class WeldAppDelegate: NSObject, UIApplicationDelegate {
    open func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        UNUserNotificationCenter.current().delegate = PushCenter.shared
        return true
    }

    open func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        PushCenter.shared.didRegister(deviceToken: deviceToken)
    }

    open func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        PushCenter.shared.didFailToRegister(error)
    }
}

/// This install's id for push registrations (`device_tokens.device_id`):
/// made once and kept on the device. A call token uses `<id>:call`.
public enum DeviceIdentity {
    private static let key = "weldsuite.push.deviceId"

    public static var id: String {
        if let stored = UserDefaults.standard.string(forKey: key) { return stored }
        let fresh = UUID().uuidString.lowercased()
        UserDefaults.standard.set(fresh, forKey: key)
        return fresh
    }

    /// `iPhone16,2`, not the marketing name.
    public static var model: String {
        var info = utsname()
        uname(&info)
        return withUnsafeBytes(of: &info.machine) { raw in
            String(decoding: raw.prefix { $0 != 0 }, as: UTF8.self)
        }
    }
}

/// Registers this device's push tokens with the server, in each workspace
/// the person opens (the tokens live in the workspace's database), and
/// removes them from all of those at sign-out.
@MainActor
public final class PushRegistrar {
    private let serverURL: URL
    private let app: AppIdentity
    private let auth: any APIAuth
    private let workspacesKey: String
    /// The workspace the APNs token was last registered in, with that token.
    private var registered: (workspace: String, token: String)?

    init(serverURL: URL, app: AppIdentity, auth: any APIAuth) {
        self.serverURL = serverURL
        self.app = app
        self.auth = auth
        workspacesKey = "weldsuite:push-workspaces:\(storageID(for: serverURL)):\(app.code)"
    }

    /// The workspaces a token was registered in, to remove it from at sign-out.
    private var knownWorkspaces: Set<String> {
        get { Set(UserDefaults.standard.stringArray(forKey: workspacesKey) ?? []) }
        set { UserDefaults.standard.set(Array(newValue), forKey: workspacesKey) }
    }

    /// Register the APNs token in `workspace`, when there is one and it isn't there yet.
    func registerAPNs(in workspace: String) async {
        guard let token = PushCenter.shared.deviceToken else { return }
        if let registered, registered.workspace == workspace, registered.token == token { return }
        if await register(token: token, type: .apns, deviceID: DeviceIdentity.id, in: workspace) {
            registered = (workspace, token)
        }
    }

    /// Register another token of this device in `workspace` (WeldChat's VoIP
    /// call token: `type` `.voip`, `deviceID` `<DeviceIdentity.id>:call`).
    @discardableResult
    public func register(
        token: String,
        type: Components.Schemas.PushTokenRegistration.TokenTypePayload,
        deviceID: String,
        in workspace: String
    ) async -> Bool {
        let body = Components.Schemas.PushTokenRegistration(
            token: token,
            platform: .ios,
            deviceId: deviceID,
            tokenType: type,
            appCode: app.code,
            deviceModel: DeviceIdentity.model,
            osVersion: UIDevice.current.systemVersion,
            appVersion: app.version
        )
        do {
            let output = try await client(workspace: workspace).registerPushToken(body: .json(body))
            guard case .ok = output else { return false }
            knownWorkspaces.insert(workspace)
            return true
        } catch {
            return false
        }
    }

    /// Stop pushes to this device in every workspace it registered in. Runs
    /// before the session's tokens are revoked.
    func unregisterEverywhere() async {
        let deviceID = DeviceIdentity.id
        for workspace in knownWorkspaces {
            _ = try? await client(workspace: workspace).unregisterPushToken(query: .init(deviceId: deviceID))
        }
        knownWorkspaces = []
        registered = nil
    }

    private func client(workspace: String) -> Client {
        let config = APIConfiguration(serverURL: serverURL, appCode: app.code, auth: FixedWorkspaceAuth(base: auth, workspace: workspace))
        return Client(serverURL: config.serverURL, transport: config.transport, middlewares: config.middlewares)
    }
}

/// The session's token with a given workspace, for a call made for a workspace that isn't the active one.
private struct FixedWorkspaceAuth: APIAuth {
    let base: any APIAuth
    let workspace: String

    func token() async -> String? { await base.token() }
    func refreshedToken() async -> String? { await base.refreshedToken() }
    func workspaceID() async -> String? { workspace }
}
