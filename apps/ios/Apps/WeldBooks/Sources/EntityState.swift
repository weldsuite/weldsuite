import Foundation
import Observation

/// The companies (accounting entities) of the workspace and the one whose books
/// are open. Every WeldBooks route is scoped to one, so the app shows the setup
/// door until there is one. The choice is kept per workspace (UserDefaults) and
/// sent as `X-Accounting-Entity-Id`. Only the first load gates the app: a failed
/// refresh keeps what was loaded.
///
/// Android keeps these in a `Snapshot`; here they are the observable
/// properties themselves: `snapshot.canSwitch` is `books.entities.canSwitch`.
@MainActor
@Observable
final class EntityState {
    private(set) var loading = true
    private(set) var failed = false
    private(set) var refreshing = false
    private(set) var entities: [Entity] = []
    private(set) var activeId: String?
    /// The supported countries; nil until (or unless) they load, and the built-in table answers.
    private(set) var jurisdictions: [Jurisdiction]?
    /// The administration switcher (`AdministrationSheet`) is open.
    private(set) var switcherOpen = false

    var active: Entity? { entities.first { $0.id == activeId } }
    var hasEntity: Bool { !entities.isEmpty }
    var canSwitch: Bool { entities.count > 1 }

    @ObservationIgnored private let store: BooksStore
    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private var workspace: String?
    @ObservationIgnored private var loaded = false

    init(store: BooksStore, defaults: UserDefaults = .standard) {
        self.store = store
        self.defaults = defaults
    }

    /// Start over for `workspaceId`: entities are per workspace.
    func use(_ workspaceId: String) async {
        if workspace == workspaceId, loaded { return }
        workspace = workspaceId
        loaded = false
        store.entityId = nil
        reset()
        await load()
        await loadJurisdictions()
    }

    func load() async {
        guard let forWorkspace = workspace else { return }
        if loaded { refreshing = true }
        let result: Result<[Entity], Error>
        do {
            result = .success(try await store.entities())
        } catch {
            result = .failure(error)
        }
        guard workspace == forWorkspace else { return }
        switch result {
        case let .success(rows):
            let active = rows.filter(\.isActive)
            let stored = defaults.string(forKey: Self.key(forWorkspace))
            let resolved = resolveActiveEntity(active, selectedId: activeId ?? stored, id: { $0.id }, isDefault: { $0.isDefault })
            store.entityId = resolved?.id
            if let resolved, resolved.id != stored { defaults.set(resolved.id, forKey: Self.key(forWorkspace)) }
            loaded = true
            loading = false
            failed = false
            refreshing = false
            entities = active
            activeId = resolved?.id
        case .failure:
            loading = false
            failed = !loaded
            refreshing = false
        }
    }

    /// The supported countries; the built-in table answers until (or unless) they load.
    private func loadJurisdictions() async {
        if jurisdictions != nil { return }
        if let list = try? await store.jurisdictions() { jurisdictions = list }
    }

    /// Open the books of company `id`.
    func select(_ id: String) {
        guard let forWorkspace = workspace else { return }
        store.entityId = id
        defaults.set(id, forKey: Self.key(forWorkspace))
        activeId = id
        switcherOpen = false
    }

    /// A company that was just created: add it and open its books.
    func adopt(_ entity: Entity) {
        if !entities.contains(where: { $0.id == entity.id }) { entities.append(entity) }
        select(entity.id)
    }

    func openSwitcher() { switcherOpen = true }

    func closeSwitcher() { switcherOpen = false }

    /// Forget the workspace (at sign-out); the countries stay.
    func clear() {
        workspace = nil
        loaded = false
        store.entityId = nil
        reset()
    }

    private func reset() {
        loading = true
        failed = false
        refreshing = false
        entities = []
        activeId = nil
        switcherOpen = false
    }

    nonisolated static func key(_ workspaceId: String) -> String { "weldbooks.entities.active.\(workspaceId)" }
}
