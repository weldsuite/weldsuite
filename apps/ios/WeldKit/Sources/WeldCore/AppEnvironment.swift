import CoreAPI
import Foundation
import Observation

/// Where the app is, from the server down to the workspace. The app shows one screen per state.
public enum SessionState: Equatable {
    case booting
    case serverUnavailable(ServerProblem, server: String)
    case updateRequired(storeURL: URL)
    case signedOut
    /// Signed in without an active workspace: the list is loading, empty, or a choice is needed.
    case choosingWorkspace(person: Person, loading: Bool, workspaces: [WorkspaceRef])
    case ready(person: Person, workspace: WorkspaceRef, workspaces: [WorkspaceRef])
}

/// One per app: the server, the session, the API configuration, the lock,
/// the realtime socket and push.
@MainActor
@Observable
public final class AppEnvironment {
    public let app: AppIdentity
    public let lock: AppLock
    /// The server this build starts on. A self-hosted choice comes later (plan native-mobile-apps.md).
    public let serverURL: URL
    public private(set) var session: OidcSession?
    public private(set) var api: APIConfiguration?
    /// What the server says it doesn't offer (`unavailableFeatures` in `/config.json`).
    public private(set) var unavailableFeatures: Set<String> = []
    /// The sign-in provider's account page, where a person deletes their account (`auth.accountUrl`).
    public private(set) var accountURL: URL?
    /// The workspace hub, once the server has booted (`realtimeUrl` in `/config.json`).
    public private(set) var realtime: RealtimeClient?
    /// This device's push tokens on the server, for an app that uses push.
    @ObservationIgnored public private(set) var push: PushRegistrar?

    private var boot: Boot = .loading

    @ObservationIgnored private let configLoader = ServerConfigLoader()
    @ObservationIgnored private let usesPush: Bool
    @ObservationIgnored private var realtimeWorkspace: String?

    /// - Parameters:
    ///   - lockRequired: the app can't be used without Face ID or the passcode (WeldPass).
    ///   - optionalLock: the person can turn the app lock on in the app's settings.
    ///   - usesPush: ask for notifications and register for push once in a workspace.
    public init(app: AppIdentity, lockRequired: Bool, optionalLock: Bool = false, usesPush: Bool = false) {
        self.app = app
        lock = AppLock(required: lockRequired, optionalKey: optionalLock ? "\(app.code).appLock" : nil)
        serverURL = app.euServerURL
        self.usesPush = usesPush
    }

    /// Whether the server offers a feature (`unavailableFeatures` in `/config.json` doesn't name it).
    public func isAvailable(_ feature: String) -> Bool {
        !unavailableFeatures.contains(feature)
    }

    public var serverName: String { serverURL.host ?? serverURL.absoluteString }

    public var state: SessionState {
        switch boot {
        case .loading:
            return .booting
        case let .failed(problem):
            return .serverUnavailable(problem, server: serverName)
        case .outdated:
            return .updateRequired(storeURL: app.storeURL)
        case .ready:
            guard let session, session.isLoaded else { return .booting }
            guard let person = session.person else { return .signedOut }
            if let active = session.workspaces.first(where: { $0.id == session.activeWorkspaceID }) {
                return .ready(person: person, workspace: active, workspaces: session.workspaces)
            }
            return .choosingWorkspace(person: person, loading: session.isLoadingWorkspaces, workspaces: session.workspaces)
        }
    }

    /// Load the server's `/config.json` and the stored session. Again after a failure: "Try again".
    public func start() async {
        boot = .loading
        switch await configLoader.load(serverURL) {
        case let .problem(problem):
            boot = .failed(problem)
        case let .loaded(config, _):
            unavailableFeatures = Set(config.unavailableFeatures ?? [])
            accountURL = accountPage(config.auth?.accountUrl)
            let minimum = config.mobile?.minVersions?.additionalProperties[app.code]
            if isBelowMinimumVersion(app.version, minimum: minimum) {
                boot = .outdated
                return
            }
            switch assessServer(config, app: app) {
            case let .failure(problem):
                boot = .failed(problem)
            case let .success(settings):
                if session == nil {
                    let auth = SessionAuth()
                    let api = APIConfiguration(serverURL: serverURL, appCode: app.code, auth: auth)
                    let session = OidcSession(
                        settings: settings,
                        redirectURL: app.redirectURL,
                        storageID: storageID(for: serverURL),
                        loadWorkspaces: { token in await Self.loadWorkspaces(api: api, token: token) }
                    )
                    auth.session = session
                    self.api = api
                    self.session = session
                    realtime = RealtimeClient(
                        baseURL: realtimeBase(config.realtimeUrl, server: serverURL),
                        token: { [weak session] in await session?.token() },
                        workspace: { [weak session] in session?.activeWorkspaceID }
                    )
                    if usesPush {
                        let push = PushRegistrar(serverURL: serverURL, app: app, auth: auth)
                        self.push = push
                        PushCenter.shared.onToken = { [weak self] _ in
                            guard let self, let workspace = self.session?.activeWorkspaceID else { return }
                            Task { await self.push?.registerAPNs(in: workspace) }
                        }
                    }
                    session.start()
                }
                boot = .ready
            }
        }
    }

    /// The person is in `workspace` (`SessionGate` calls this): the realtime
    /// socket follows the workspace, and an app with push asks for
    /// notifications and registers this device there.
    public func didEnterWorkspace(_ workspace: String) async {
        if realtimeWorkspace != workspace {
            realtimeWorkspace = workspace
            realtime?.restart()
        }
        guard usesPush, let push else { return }
        PushCenter.shared.clearBadge()
        if PushCenter.shared.deviceToken == nil {
            await PushCenter.shared.requestAuthorization()
        } else {
            await push.registerAPNs(in: workspace)
        }
    }

    /// The tapped notification waiting to be handled, if it comes from this
    /// server (`data.server`); a tap from a server the app no longer uses is dropped.
    public func takePushTap() -> PushPayload? {
        guard let tap = PushCenter.shared.pendingTap else { return nil }
        PushCenter.shared.pendingTap = nil
        if let server = tap.server, URL(string: server)?.host != serverURL.host { return nil }
        return tap
    }

    public func signIn(createAccount: Bool) async -> SignInOutcome {
        guard let session else { return .unreachable }
        let locale = Locale.current.language.languageCode?.identifier ?? "en"
        return await session.signIn(createAccount: createAccount, locale: locale)
    }

    public func chooseWorkspace(_ id: String) {
        session?.setActiveWorkspace(id)
    }

    public func reloadWorkspaces() async {
        await session?.reloadWorkspaces()
    }

    public func signOut() async {
        // While the token still works: no more pushes to this device.
        await push?.unregisterEverywhere()
        realtime?.stop()
        realtimeWorkspace = nil
        await session?.signOut()
        lock.lockNow()
    }

    /// `GET /api/workspaces` with a token in hand (before a workspace is chosen).
    private static func loadWorkspaces(api: APIConfiguration, token: String) async -> [WorkspaceRef]? {
        let client = Client(serverURL: api.serverURL, transport: api.transport, middlewares: api.middlewares)
        guard let output = try? await client.listWorkspaces(),
              case let .ok(ok) = output,
              let body = try? ok.body.json
        else { return nil }
        return body.data.map { WorkspaceRef(id: $0.id, name: $0.name, slug: $0.slug) }
    }

    private enum Boot {
        case loading
        case failed(ServerProblem)
        case outdated
        case ready
    }
}

/// The account page from `/config.json`, when it is an https link.
func accountPage(_ text: String?) -> URL? {
    guard let text = text?.trimmingCharacters(in: .whitespaces), text.hasPrefix("https://") else { return nil }
    return URL(string: text)
}

/// The realtime service's base URL: the server's `realtimeUrl` without a
/// trailing `/ws`, else the server itself on `ws(s)://`.
func realtimeBase(_ configured: String?, server: URL) -> URL {
    var text = (configured?.trimmingCharacters(in: .whitespaces)).flatMap { $0.isEmpty ? nil : $0 }
        ?? server.absoluteString.replacingOccurrences(of: "^http", with: "ws", options: .regularExpression)
    while text.hasSuffix("/") { text.removeLast() }
    if text.hasSuffix("/ws") { text.removeLast(3) }
    return URL(string: text) ?? server
}

/// Hands the session's token and workspace to the API middleware.
private final class SessionAuth: APIAuth, @unchecked Sendable {
    @MainActor weak var session: OidcSession?

    func token() async -> String? { await session?.token() }
    func refreshedToken() async -> String? { await session?.refreshedToken() }
    func workspaceID() async -> String? { await session?.activeWorkspaceID }
}
