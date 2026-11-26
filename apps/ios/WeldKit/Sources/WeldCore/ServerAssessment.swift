import CoreAPI
import Foundation

/// Why the app can't use a server.
public enum ServerProblem: Error, Equatable, Sendable {
    /// No answer, a slow answer or a network error.
    case unreachable
    /// It answered, but not as a WeldSuite server on the Rust backend.
    case notWeldSuite
    /// It has no native client for the apps, or a sign-in this build can't do.
    case noMobileSignIn
    /// It doesn't serve the app's module.
    case appUnavailable
}

/// What the app signs in with on a server that passed `assessServer`.
public struct OidcSettings: Equatable, Sendable {
    public let issuer: URL
    public let clientID: String
    public let scopes: [String]
}

private let defaultScopes = ["openid", "profile", "email", "offline_access"]

/// Whether this app can use a server that answered with `config`, and how
/// it signs in there. The native apps support WeldID's membership mode only
/// (`workspaceSource: header`): the token names no workspace and every
/// request names it in `X-Weld-Workspace`.
public func assessServer(
    _ config: Components.Schemas.RuntimeConfig,
    app: AppIdentity
) -> Result<OidcSettings, ServerProblem> {
    guard config.backend == "rust" else { return .failure(.notWeldSuite) }
    guard let auth = config.auth,
          auth.provider == "oidc",
          let issuerString = auth.issuer, let issuer = URL(string: issuerString),
          let clientID = auth.mobileClientId, !clientID.isEmpty,
          auth.workspaceSource == "header"
    else { return .failure(.noMobileSignIn) }
    if let modules = config.modules, app.requiredModules.contains(where: { !modules.contains($0) }) {
        return .failure(.appUnavailable)
    }
    let scopes = (auth.scopes?.isEmpty == false ? auth.scopes : nil) ?? defaultScopes
    return .success(OidcSettings(issuer: issuer, clientID: clientID, scopes: scopes))
}

/// Whether `installed` is below the minimum version the server names for
/// the app (`mobile.minVersions.<code>`). Dotted numbers, compared part by
/// part; anything after a `-` is ignored. No minimum, or one that doesn't
/// parse, means no gate.
public func isBelowMinimumVersion(_ installed: String, minimum: String?) -> Bool {
    guard let minimum, !minimum.isEmpty,
          let have = versionParts(installed), let need = versionParts(minimum)
    else { return false }
    for index in 0..<max(have.count, need.count) {
        let a = index < have.count ? have[index] : 0
        let b = index < need.count ? need[index] : 0
        if a != b { return a < b }
    }
    return false
}

private func versionParts(_ version: String) -> [Int]? {
    let core = version.split(separator: "-", maxSplits: 1).first.map(String.init)?
        .trimmingCharacters(in: .whitespaces) ?? ""
    guard !core.isEmpty else { return nil }
    var parts: [Int] = []
    for piece in core.split(separator: ".", omittingEmptySubsequences: false) {
        guard let number = Int(piece) else { return nil }
        parts.append(number)
    }
    return parts
}

/// `https://app.weldsuite.eu` → `app.weldsuite.eu`, safe for a storage key.
public func storageID(for origin: URL) -> String {
    let text = origin.absoluteString.replacingOccurrences(
        of: "^[a-zA-Z]+://", with: "", options: .regularExpression
    )
    return text.replacingOccurrences(of: "[^A-Za-z0-9._-]", with: "_", options: .regularExpression)
}
