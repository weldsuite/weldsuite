import AppAuth
import Foundation
import Observation
import UIKit

/// How a sign-in ended.
public enum SignInOutcome: Equatable, Sendable {
    case signedIn
    case cancelled
    case unreachable
    case failed
}

/// WeldID sign-in for the native apps, through AppAuth: authorization code
/// with PKCE in `ASWebAuthenticationSession`, the public client from
/// `/config.json` (`mobileClientId`), redirect `<scheme>://sso-callback`.
///
/// WeldID runs in membership mode: the token names no workspace. The
/// workspace list is WeldSuite's own (`GET /api/workspaces`), read after
/// sign-in and at start, and cached with the profile; the active workspace
/// is a choice made here and sent in `X-Weld-Workspace`.
///
/// AppAuth's `OIDAuthState` (refresh token included) is kept in the
/// Keychain. After a sign-out, the next sign-in asks WeldID for its form
/// (`prompt=login`), so WeldID's own session in the browser can't sign the
/// same account straight back in.
@MainActor
@Observable
public final class OidcSession {
    public private(set) var isLoaded = false
    public private(set) var person: Person?
    public private(set) var workspaces: [WorkspaceRef] = []
    public private(set) var activeWorkspaceID: String?
    /// No workspace list has been read for this person yet, and one is being read.
    public private(set) var isLoadingWorkspaces = false

    @ObservationIgnored private let settings: OidcSettings
    @ObservationIgnored private let redirectURL: URL
    @ObservationIgnored private let keychain: Keychain
    @ObservationIgnored private let cache: Cache
    @ObservationIgnored private let loadWorkspaces: (String) async -> [WorkspaceRef]?
    @ObservationIgnored private let authKey: String
    @ObservationIgnored private let profileKey: String
    @ObservationIgnored private let promptLoginKey: String
    @ObservationIgnored private var authState: OIDAuthState?
    @ObservationIgnored private var profile: CachedProfile?
    @ObservationIgnored private var configuration: OIDServiceConfiguration?
    @ObservationIgnored private var userAgentSession: OIDExternalUserAgentSession?
    @ObservationIgnored private var activeChosenAt = Date.distantPast
    @ObservationIgnored private var directoryTask: Task<Void, Never>?

    public init(
        settings: OidcSettings,
        redirectURL: URL,
        storageID: String,
        keychain: Keychain = Keychain(),
        cache: Cache = Cache(),
        loadWorkspaces: @escaping (String) async -> [WorkspaceRef]?
    ) {
        self.settings = settings
        self.redirectURL = redirectURL
        self.keychain = keychain
        self.cache = cache
        self.loadWorkspaces = loadWorkspaces
        authKey = "weldsuite.oidc.\(storageID)"
        profileKey = "weldsuite:oidc-profile:\(storageID)"
        promptLoginKey = "weldsuite:oidc-prompt-login:\(storageID)"
    }

    /// Read the stored session. Never waits for the network.
    public func start() {
        guard !isLoaded else { return }
        let state = keychain.data(for: authKey).flatMap {
            try? NSKeyedUnarchiver.unarchivedObject(ofClass: OIDAuthState.self, from: $0)
        }
        let cached = cache.data(for: profileKey).flatMap { try? JSONDecoder().decode(CachedProfile.self, from: $0) }
        if let state, let cached, state.isAuthorized {
            authState = state
            profile = cached
        } else {
            clearStorage()
        }
        publish()
        if profile != nil { readDirectory(force: false) }
    }

    /// The access token for API calls, refreshed when it's about to run out. Nil when signed out.
    public func token() async -> String? {
        guard let state = authState else { return nil }
        return await withCheckedContinuation { (continuation: CheckedContinuation<String?, Never>) in
            state.performAction { [weak self] accessToken, _, error in
                if let error = error as NSError?, error.domain == OIDOAuthTokenErrorDomain {
                    // The refresh token was refused: the session is over.
                    Task { @MainActor in self?.forget() }
                }
                continuation.resume(returning: accessToken)
            }
        }
    }

    /// Refresh now, whatever the expiry says (after a 401).
    public func refreshedToken() async -> String? {
        authState?.setNeedsTokenRefresh()
        return await token()
    }

    /// Sign in (or create an account) on WeldID's page.
    public func signIn(createAccount: Bool, locale: String) async -> SignInOutcome {
        let config: OIDServiceConfiguration
        do {
            config = try await serviceConfiguration()
        } catch {
            return .unreachable
        }
        var extra = ["ui_locales": locale]
        if createAccount {
            extra["prompt"] = "create"
        } else if cache.string(for: promptLoginKey) == "1" {
            extra["prompt"] = "login"
        }
        let request = OIDAuthorizationRequest(
            configuration: config,
            clientId: settings.clientID,
            clientSecret: nil,
            scopes: settings.scopes,
            redirectURL: redirectURL,
            responseType: OIDResponseTypeCode,
            additionalParameters: extra
        )
        guard let presenter = UIApplication.shared.topViewController else { return .failed }

        let result: (OIDAuthState?, Error?) = await withCheckedContinuation { continuation in
            userAgentSession = OIDAuthState.authState(
                byPresenting: request,
                presenting: presenter,
                prefersEphemeralSession: false
            ) { state, error in
                continuation.resume(returning: (state, error))
            }
        }
        userAgentSession = nil
        guard let state = result.0 else {
            let error = result.1 as NSError?
            if error?.domain == OIDGeneralErrorDomain,
               error?.code == OIDErrorCode.userCanceledAuthorizationFlow.rawValue
                || error?.code == OIDErrorCode.programCanceledAuthorizationFlow.rawValue {
                return .cancelled
            }
            if error?.domain == OIDGeneralErrorDomain, error?.code == OIDErrorCode.networkError.rawValue {
                return .unreachable
            }
            return .failed
        }
        let claims = jwtClaims(state.lastTokenResponse?.idToken) ?? jwtClaims(state.lastTokenResponse?.accessToken)
        guard let signedIn = WeldCore.person(fromClaims: claims) else { return .failed }

        let samePerson = profile?.person.id == signedIn.id
        authState = state
        profile = CachedProfile(
            person: signedIn,
            workspaces: samePerson ? profile?.workspaces ?? [] : [],
            activeWorkspaceID: samePerson ? profile?.activeWorkspaceID : nil,
            directoryAt: samePerson ? profile?.directoryAt : nil
        )
        persist()
        cache.remove(promptLoginKey)
        publish()
        readDirectory(force: true)
        return .signedIn
    }

    /// Choose the active workspace. A local choice: one token serves every workspace.
    public func setActiveWorkspace(_ id: String) {
        guard let current = profile else { return }
        activeChosenAt = Date()
        profile = CachedProfile(
            person: current.person,
            workspaces: current.workspaces,
            activeWorkspaceID: id,
            directoryAt: current.directoryAt
        )
        persist()
        publish()
    }

    /// Read the workspace list again (after creating or joining one).
    public func reloadWorkspaces() async {
        readDirectory(force: true)
        await directoryTask?.value
    }

    /// Forget the session here and revoke its refresh token at WeldID. The
    /// next sign-in asks for WeldID's form.
    public func signOut() async {
        let refreshToken = authState?.refreshToken
        let revocation = authState?.lastAuthorizationResponse.request.configuration.discoveryDocument?
            .discoveryDictionary["revocation_endpoint"] as? String
        forget()
        cache.set("1", for: promptLoginKey)
        guard let refreshToken, let revocation, let url = URL(string: revocation) else { return }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.httpBody = formBody([
            "token": refreshToken,
            "token_type_hint": "refresh_token",
            "client_id": settings.clientID,
        ])
        // Best effort: offline, the token expires at WeldID on its own.
        _ = try? await URLSession.shared.data(for: request)
    }

    // MARK: - Workspace directory

    /// Read WeldSuite's workspace list in the background. A first read that
    /// fails is tried a few times; later failures keep the cached list.
    private func readDirectory(force: Bool) {
        guard let personID = profile?.person.id else { return }
        if directoryTask != nil, !force { return }
        directoryTask?.cancel()
        let startedAt = Date()
        directoryTask = Task { [weak self] in
            for (attempt, wait) in ([0] + Self.directoryRetrySeconds).enumerated() {
                if attempt > 0 { try? await Task.sleep(for: .seconds(wait)) }
                guard let self, !Task.isCancelled, self.profile?.person.id == personID else { return }
                let token = await self.token()
                var list: [WorkspaceRef]?
                if let token { list = await self.loadWorkspaces(token) }
                guard self.profile?.person.id == personID else { return }
                if let list {
                    self.acceptDirectory(list, startedAt: startedAt)
                    break
                }
                if token == nil || self.profile?.directoryAt != nil { break }
            }
            self?.directoryTask = nil
            self?.publish()
        }
        publish()
    }

    private func acceptDirectory(_ list: [WorkspaceRef], startedAt: Date) {
        guard let current = profile else { return }
        let active = chooseActiveWorkspace(
            list,
            current: current.activeWorkspaceID,
            chosenAfterReadStarted: activeChosenAt >= startedAt
        )
        profile = CachedProfile(person: current.person, workspaces: list, activeWorkspaceID: active, directoryAt: Date())
        persist()
        publish()
    }

    // MARK: - Storage

    private func serviceConfiguration() async throws -> OIDServiceConfiguration {
        if let configuration { return configuration }
        let fetched: OIDServiceConfiguration = try await withCheckedThrowingContinuation { continuation in
            OIDAuthorizationService.discoverConfiguration(forIssuer: settings.issuer) { config, error in
                if let config {
                    continuation.resume(returning: config)
                } else {
                    continuation.resume(throwing: error ?? URLError(.cannotConnectToHost))
                }
            }
        }
        configuration = fetched
        return fetched
    }

    private func persist() {
        if let authState,
           let data = try? NSKeyedArchiver.archivedData(withRootObject: authState, requiringSecureCoding: true) {
            keychain.set(data, for: authKey)
        }
        if let profile, let data = try? JSONEncoder().encode(profile) {
            cache.set(data, for: profileKey)
        }
    }

    private func forget() {
        authState = nil
        profile = nil
        directoryTask?.cancel()
        directoryTask = nil
        clearStorage()
        publish()
    }

    private func clearStorage() {
        keychain.remove(authKey)
        cache.remove(profileKey)
    }

    private func publish() {
        let signedIn = authState != nil && profile != nil
        isLoaded = true
        person = signedIn ? profile?.person : nil
        workspaces = signedIn ? profile?.workspaces ?? [] : []
        activeWorkspaceID = signedIn ? profile?.activeWorkspaceID : nil
        isLoadingWorkspaces = signedIn && profile?.directoryAt == nil && directoryTask != nil
    }

    private func formBody(_ values: [String: String]) -> Data {
        var components = URLComponents()
        components.queryItems = values.map { URLQueryItem(name: $0.key, value: $0.value) }
        return Data((components.percentEncodedQuery ?? "").utf8)
    }

    private struct CachedProfile: Codable {
        let person: Person
        let workspaces: [WorkspaceRef]
        let activeWorkspaceID: String?
        let directoryAt: Date?
    }

    private static let directoryRetrySeconds: [Int] = [1, 3, 9]
}

extension UIApplication {
    /// The view controller on top, to present WeldID's sign-in sheet from.
    var topViewController: UIViewController? {
        let scene = connectedScenes.compactMap { $0 as? UIWindowScene }.first { $0.activationState == .foregroundActive }
            ?? connectedScenes.compactMap { $0 as? UIWindowScene }.first
        var top = scene?.windows.first { $0.isKeyWindow }?.rootViewController ?? scene?.windows.first?.rootViewController
        while let presented = top?.presentedViewController { top = presented }
        return top
    }
}
