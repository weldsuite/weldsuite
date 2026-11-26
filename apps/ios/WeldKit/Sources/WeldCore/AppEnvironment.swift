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

/// One per app: the server, the session, the API configuration and the lock.
@MainActor
@Observable
public final class AppEnvironment {
    public let app: AppIdentity
    public let lock: AppLock
    /// The server this build starts on. A self-hosted choice comes later (plan native-mobile-apps.md).
    public let serverURL: URL
    public private(set) var session: OidcSession?
    public private(set) var api: APIConfiguration?

    private var boot: Boot = .loading

    @ObservationIgnored private let configLoader = ServerConfigLoader()

    public init(app: AppIdentity, lockRequired: Bool) {
        self.app = app
        lock = AppLock(required: lockRequired)
        serverURL = app.euServerURL
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
                    session.start()
                }
                boot = .ready
            }
        }
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

/// Hands the session's token and workspace to the API middleware.
private final class SessionAuth: APIAuth, @unchecked Sendable {
    @MainActor weak var session: OidcSession?

    func token() async -> String? { await session?.token() }
    func refreshedToken() async -> String? { await session?.refreshedToken() }
    func workspaceID() async -> String? { await session?.activeWorkspaceID }
}
