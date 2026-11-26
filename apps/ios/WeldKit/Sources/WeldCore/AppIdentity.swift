import Foundation

/// Who the app is, and what its build bakes in. The rest comes from the
/// server's `/config.json`.
public struct AppIdentity: Sendable {
    /// The app code, sent as `X-Weld-App` (`weldpass`).
    public let code: String
    public let name: String
    /// The URL scheme WeldID redirects to (`<scheme>://sso-callback`).
    public let scheme: String
    /// Modules a server must serve for the app to work there.
    public let requiredModules: [String]
    /// The WeldSuite EU server this build starts on.
    public let euServerURL: URL
    /// The app's version, for the server's minimum-version gate.
    public let version: String
    /// The app's App Store page, for "Update".
    public let storeURL: URL

    public init(
        code: String,
        name: String,
        scheme: String,
        requiredModules: [String],
        euServerURL: URL,
        version: String,
        storeURL: URL
    ) {
        self.code = code
        self.name = name
        self.scheme = scheme
        self.requiredModules = requiredModules
        self.euServerURL = euServerURL
        self.version = version
        self.storeURL = storeURL
    }

    public var redirectURL: URL { URL(string: "\(scheme)://sso-callback")! }
}
