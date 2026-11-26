import Foundation
import Observation
import WeldCore
import WeldPassAPI

/// A vault as the screens use it. Mapped from the generated API types here
/// and nowhere else, so a change in the generated names stays in this file.
struct PassVault: Identifiable, Equatable {
    enum Kind { case personal, shared }
    enum Role { case viewer, editor, manager }

    let id: String
    let kind: Kind
    let name: String
    /// Nil for a workspace admin looking at a shared vault they are not in.
    let role: Role?
    let itemCount: Int?
    let memberCount: Int?
}

/// What a list shows of an item. Nothing here is secret.
struct PassItem: Identifiable, Equatable {
    enum Kind { case login, note, card }

    let id: String
    let vaultID: String
    let kind: Kind
    let title: String
    /// The login's username, or "•••• 4242" for a card.
    let subtitle: String?
    let url: String?
    let host: String?
    let hasTotp: Bool
    let updatedAt: String
}

/// An item's secret fields, once revealed.
struct PassFields: Equatable {
    var username: String?
    var password: String?
    var notes: String?
    var apps: [String]
    var content: String?
    var cardholder: String?
    var number: String?
    var expiry: String?
    var cvc: String?
}

struct PassTotp: Equatable {
    let code: String
    let expiresAt: String
}

/// A list as the screens show it: what was last loaded, and how loading went.
struct Loadable<T> {
    var data: T?
    var loading = false
    var error: APIError?
}

/// Vaults and items for the active workspace. Lists carry no secrets; a
/// revealed item is handed to the screen that asked and never kept here.
@MainActor
@Observable
final class PassStore {
    private(set) var vaults = Loadable<[PassVault]>()
    private(set) var items = Loadable<[PassItem]>()

    @ObservationIgnored private let env: AppEnvironment
    @ObservationIgnored private var workspace: String?

    init(env: AppEnvironment) {
        self.env = env
    }

    private func client() throws -> Client {
        guard let api = env.api else { throw APIError(status: nil, code: nil) }
        return Client(serverURL: api.serverURL, transport: api.transport, middlewares: api.middlewares)
    }

    /// Forget another workspace's lists the moment the workspace changes.
    func use(workspace id: String) {
        guard workspace != id else { return }
        workspace = id
        vaults = Loadable()
        items = Loadable()
    }

    func refresh() async {
        let forWorkspace = workspace
        vaults.loading = true
        items.loading = true
        async let loadedVaults = fetchVaults()
        async let loadedItems = fetchItems()
        let vaultResult: Result<[PassVault], Error>
        let itemResult: Result<[PassItem], Error>
        do { vaultResult = .success(try await loadedVaults) } catch { vaultResult = .failure(error) }
        do { itemResult = .success(try await loadedItems) } catch { itemResult = .failure(error) }
        guard workspace == forWorkspace else { return }
        switch vaultResult {
        case let .success(list): vaults = Loadable(data: list)
        case let .failure(error): vaults = Loadable(data: vaults.data, error: APIError.from(error))
        }
        switch itemResult {
        case let .success(list): items = Loadable(data: list)
        case let .failure(error): items = Loadable(data: items.data, error: APIError.from(error))
        }
    }

    /// The item's secret fields. Each call is a reveal the server audits.
    func reveal(vaultID: String, itemID: String) async throws -> PassFields {
        do {
            switch try await client().revealItem(path: .init(vaultId: vaultID, itemId: itemID)) {
            case let .ok(ok):
                let fields = try ok.body.json.data.value2.fields
                return PassFields(
                    username: fields.username,
                    password: fields.password,
                    notes: fields.notes,
                    apps: fields.apps ?? [],
                    content: fields.content,
                    cardholder: fields.cardholder,
                    number: fields.number,
                    expiry: fields.expiry,
                    cvc: fields.cvc
                )
            case let .default(status, response):
                throw APIError(status: status, code: try? response.body.json.error.code)
            }
        } catch {
            throw APIError.from(error)
        }
    }

    func totp(vaultID: String, itemID: String) async throws -> PassTotp {
        do {
            switch try await client().generateTotp(path: .init(vaultId: vaultID, itemId: itemID)) {
            case let .ok(ok):
                let code = try ok.body.json.data
                return PassTotp(code: code.code, expiresAt: code.expiresAt)
            case let .default(status, response):
                throw APIError(status: status, code: try? response.body.json.error.code)
            }
        } catch {
            throw APIError.from(error)
        }
    }

    func clear() {
        workspace = nil
        vaults = Loadable()
        items = Loadable()
    }

    private func fetchVaults() async throws -> [PassVault] {
        switch try await client().listVaults() {
        case let .ok(ok):
            return try ok.body.json.data.map { vault in
                PassVault(
                    id: vault.id,
                    kind: vault.kind == .personal ? .personal : .shared,
                    name: vault.name,
                    role: vault.role.map { role -> PassVault.Role in
                        switch role {
                        case .viewer: return .viewer
                        case .editor: return .editor
                        case .manager: return .manager
                        }
                    },
                    itemCount: vault.itemCount,
                    memberCount: vault.memberCount
                )
            }
        case let .default(status, response):
            throw APIError(status: status, code: try? response.body.json.error.code)
        }
    }

    private func fetchItems() async throws -> [PassItem] {
        switch try await client().listItems() {
        case let .ok(ok):
            return try ok.body.json.data.map { item in
                PassItem(
                    id: item.id,
                    vaultID: item.vaultId,
                    kind: { () -> PassItem.Kind in
                        switch item.type {
                        case .login: return .login
                        case .note: return .note
                        case .card: return .card
                        }
                    }(),
                    title: item.title,
                    subtitle: item.subtitle,
                    url: item.url,
                    host: item.host,
                    hasTotp: item.hasTotp,
                    updatedAt: item.updatedAt
                )
            }
        case let .default(status, response):
            throw APIError(status: status, code: try? response.body.json.error.code)
        }
    }
}
