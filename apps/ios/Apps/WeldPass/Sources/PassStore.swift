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
    var totp: String?
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

/// A login with something to fix, from the password health report.
struct PassHealthEntry: Identifiable, Equatable {
    enum Issue: String { case weak, reused, old }

    let item: PassItem
    let issues: [Issue]
    /// How many of the caller's logins share this password, itself included.
    let reuseCount: Int

    var id: String { item.id }
}

struct PassHealthReport: Equatable {
    let checked: Int
    let healthy: Int
    let weak: Int
    let reused: Int
    let old: Int
    let entries: [PassHealthEntry]
}

/// A list as the screens show it: what was last loaded, and how loading went.
struct Loadable<T> {
    var data: T?
    var loading = false
    var error: APIError?
}

/// Vaults and items for the active workspace: from the offline copy while
/// it's open (ADR PASS-010), from the server otherwise. Lists carry no
/// secrets; a revealed item is handed to the screen that asked and never kept
/// here.
@MainActor
@Observable
final class PassStore {
    private var serverVaults = Loadable<[PassVault]>()
    private var serverItems = Loadable<[PassItem]>()
    let offline: OfflineStore

    @ObservationIgnored private let env: AppEnvironment
    @ObservationIgnored private var workspace: String?

    init(env: AppEnvironment) {
        self.env = env
        offline = OfflineStore(env: env)
    }

    var vaults: Loadable<[PassVault]> {
        if let copy = offline.readable { return Loadable(data: CopyRules.vaults(copy), loading: offline.syncing) }
        return serverVaults
    }

    var items: Loadable<[PassItem]> {
        if let copy = offline.readable { return Loadable(data: CopyRules.items(copy), loading: offline.syncing) }
        return serverItems
    }

    private func client() throws -> Client {
        guard let api = env.api else { throw APIError(status: nil, code: nil) }
        return Client(serverURL: api.serverURL, transport: api.transport, middlewares: api.middlewares)
    }

    /// Forget another workspace's lists the moment the workspace changes.
    func use(workspace id: String) {
        guard workspace != id else { return }
        workspace = id
        serverVaults = Loadable()
        serverItems = Loadable()
    }

    /// Sync the copy when it's open, else read the lists from the server.
    func refresh() async {
        if offline.readable != nil {
            await offline.sync()
            return
        }
        let forWorkspace = workspace
        serverVaults.loading = true
        serverItems.loading = true
        async let loadedVaults = fetchVaults()
        async let loadedItems = fetchItems()
        let vaultResult: Result<[PassVault], Error>
        let itemResult: Result<[PassItem], Error>
        do { vaultResult = .success(try await loadedVaults) } catch { vaultResult = .failure(error) }
        do { itemResult = .success(try await loadedItems) } catch { itemResult = .failure(error) }
        guard workspace == forWorkspace else { return }
        switch vaultResult {
        case let .success(list): serverVaults = Loadable(data: list)
        case let .failure(error): serverVaults = Loadable(data: serverVaults.data, error: APIError.from(error))
        }
        switch itemResult {
        case let .success(list): serverItems = Loadable(data: list)
        case let .failure(error): serverItems = Loadable(data: serverItems.data, error: APIError.from(error))
        }
    }

    /// The item's secret fields: from the copy when it holds the item (the
    /// reveal is queued for the vault's trail), else from the server, which
    /// audits it.
    func reveal(vaultID: String, itemID: String) async throws -> PassFields {
        if let copy = offline.readable, let fields = CopyRules.fields(copy, vaultID: vaultID, itemID: itemID) {
            offline.recordEvent(vaultID: vaultID, itemID: itemID, action: .revealed)
            return fields
        }
        do {
            switch try await client().revealItem(path: .init(vaultId: vaultID, itemId: itemID)) {
            case let .ok(ok):
                return Self.fields(try ok.body.json.data.value2.fields)
            case let .default(status, response):
                throw APIError(status: status, code: try? response.body.json.error.code)
            }
        } catch {
            throw APIError.from(error)
        }
    }

    /// A secret copied from the copy goes into the vault's trail at the next sync.
    func recordCopy(vaultID: String, itemID: String) {
        if offline.readable != nil { offline.recordEvent(vaultID: vaultID, itemID: itemID, action: .copied) }
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

    /// Add an item, then reload the lists.
    func create(vaultID: String, input: PassItemInput) async throws {
        do {
            switch try await client().createItem(path: .init(vaultId: vaultID), body: .json(Self.generated(input))) {
            case .created:
                await refresh()
            case let .default(status, response):
                throw APIError(status: status, code: try? response.body.json.error.code)
            }
        } catch {
            throw APIError.from(error)
        }
    }

    /// Replace an item (every field of its type), then reload the lists.
    func update(vaultID: String, itemID: String, input: PassItemInput) async throws {
        do {
            switch try await client().updateItem(path: .init(vaultId: vaultID, itemId: itemID), body: .json(Self.generated(input))) {
            case .ok:
                await refresh()
            case let .default(status, response):
                throw APIError(status: status, code: try? response.body.json.error.code)
            }
        } catch {
            throw APIError.from(error)
        }
    }

    func delete(vaultID: String, itemID: String) async throws {
        do {
            switch try await client().deleteItem(path: .init(vaultId: vaultID, itemId: itemID)) {
            case .noContent:
                await refresh()
            case let .default(status, response):
                throw APIError(status: status, code: try? response.body.json.error.code)
            }
        } catch {
            throw APIError.from(error)
        }
    }

    /// Weak, reused and old passwords; worked out on the server without sending a password.
    func health() async throws -> PassHealthReport {
        do {
            switch try await client().passwordHealth() {
            case let .ok(ok):
                let report = try ok.body.json.data
                return PassHealthReport(
                    checked: report.checked,
                    healthy: report.healthy,
                    weak: report.weak,
                    reused: report.reused,
                    old: report.old,
                    entries: report.items.map { entry in
                        PassHealthEntry(
                            item: Self.item(entry.value1),
                            issues: entry.value2.issues.compactMap { PassHealthEntry.Issue(rawValue: $0.rawValue) },
                            reuseCount: entry.value2.reuseCount
                        )
                    }
                )
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

    /// The generated request body. Unset fields stay out of the JSON.
    private static func generated(_ input: PassItemInput) -> Components.Schemas.ItemInput {
        let fields = input.fields
        return Components.Schemas.ItemInput(
            _type: {
                switch input.kind {
                case .login: return .login
                case .note: return .note
                case .card: return .card
                }
            }(),
            title: input.title,
            url: input.url,
            fields: Components.Schemas.ItemFields(
                username: fields.username,
                password: fields.password,
                totp: fields.totp,
                notes: fields.notes,
                apps: fields.apps.isEmpty ? nil : fields.apps,
                content: fields.content,
                cardholder: fields.cardholder,
                number: fields.number,
                expiry: fields.expiry,
                cvc: fields.cvc
            )
        )
    }

    /// swift-openapi-generator escapes `type` as `_type`.
    nonisolated static func item(_ item: Components.Schemas.Item) -> PassItem {
        PassItem(
            id: item.id,
            vaultID: item.vaultId,
            kind: {
                switch item._type {
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

    private func fetchVaults() async throws -> [PassVault] {
        switch try await client().listVaults() {
        case let .ok(ok):
            return try ok.body.json.data.map(Self.vault)
        case let .default(status, response):
            throw APIError(status: status, code: try? response.body.json.error.code)
        }
    }

    private func fetchItems() async throws -> [PassItem] {
        switch try await client().listItems() {
        case let .ok(ok):
            return try ok.body.json.data.map(Self.item)
        case let .default(status, response):
            throw APIError(status: status, code: try? response.body.json.error.code)
        }
    }

    nonisolated static func vault(_ vault: Components.Schemas.Vault) -> PassVault {
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

    nonisolated static func fields(_ fields: Components.Schemas.ItemFields) -> PassFields {
        PassFields(
            username: fields.username,
            password: fields.password,
            totp: fields.totp,
            notes: fields.notes,
            apps: fields.apps ?? [],
            content: fields.content,
            cardholder: fields.cardholder,
            number: fields.number,
            expiry: fields.expiry,
            cvc: fields.cvc
        )
    }
}
