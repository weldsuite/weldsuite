import SwiftUI
import WeldCore
import WeldUI

/// WeldPass once signed in, in a workspace and unlocked.
struct ContentView: View {
    let env: AppEnvironment
    let store: PassStore
    let person: Person
    let workspace: WorkspaceRef
    let workspaces: [WorkspaceRef]

    /// The item form in a sheet: a new item, or an edit.
    @State private var form: ItemFormMode?

    var body: some View {
        TabView {
            NavigationStack {
                ItemListView(store: store, vaultID: nil, emptyTitle: PassStrings.itemsEmpty, emptyDescription: PassStrings.itemsEmptyDescription)
                    .navigationTitle(PassStrings.itemsTitle)
                    .toolbar {
                        ToolbarItem(placement: .primaryAction) {
                            NewItemMenu { kind in form = .new(kind, vaultID: nil) }
                        }
                    }
                    .navigationDestination(for: ItemRoute.self, destination: itemView)
            }
            .tabItem { Label(PassStrings.tabsItems, systemImage: "key") }
            .accessibilityIdentifier("tab-items")

            NavigationStack {
                VaultsView(store: store)
                    .navigationTitle(PassStrings.vaultsTitle)
                    .navigationDestination(for: VaultRoute.self) { route in
                        VaultView(store: store, vaultID: route.vaultID) { kind in form = .new(kind, vaultID: route.vaultID) }
                    }
                    .navigationDestination(for: ItemRoute.self, destination: itemView)
            }
            .tabItem { Label(PassStrings.tabsVaults, systemImage: "lock.rectangle.stack") }
            .accessibilityIdentifier("tab-vaults")

            NavigationStack {
                GeneratorView()
                    .navigationTitle(PassStrings.generatorTitle)
            }
            .tabItem { Label(PassStrings.tabsGenerator, systemImage: "wand.and.stars") }
            .accessibilityIdentifier("tab-generator")

            NavigationStack {
                SettingsView(env: env, store: store, person: person, workspace: workspace, workspaces: workspaces)
                    .navigationTitle(PassStrings.settingsTitle)
                    .navigationDestination(for: HealthRoute.self) { _ in HealthView(store: store) }
                    .navigationDestination(for: ItemRoute.self, destination: itemView)
            }
            .tabItem { Label(PassStrings.tabsSettings, systemImage: "gearshape") }
            .accessibilityIdentifier("tab-settings")
        }
        .sheet(item: $form) { mode in
            ItemFormView(env: env, store: store, mode: mode)
        }
        .task(id: workspace.id) {
            store.use(workspace: workspace.id)
            await store.refresh()
        }
    }

    private func itemView(_ route: ItemRoute) -> some View {
        ItemView(env: env, store: store, route: route) {
            form = .edit(vaultID: route.vaultID, itemID: route.itemID)
        }
    }
}

/// The password health screen, opened from Settings.
struct HealthRoute: Hashable {}

struct ItemRoute: Hashable {
    let vaultID: String
    let itemID: String
}

struct VaultRoute: Hashable {
    let vaultID: String
}

/// What went wrong with a WeldPass request, in words the person can act on.
func passErrorMessage(_ error: APIError?) -> String {
    guard let error else { return PassStrings.errorsGeneric }
    if error.isNetwork { return PassStrings.errorsOffline }
    if error.code == "CRYPTO_ERROR" { return PassStrings.errorsCrypto }
    switch error.status {
    case 403: return PassStrings.errorsForbidden
    case 404: return PassStrings.errorsNotFound
    default: return PassStrings.errorsGeneric
    }
}

/// The personal vault is named by what it is, not by its stored name.
func vaultLabel(_ vault: PassVault) -> String {
    vault.kind == .personal ? PassStrings.vaultsPersonal : vault.name
}

func typeLabel(_ kind: PassItem.Kind) -> String {
    switch kind {
    case .login: PassStrings.typesLogin
    case .note: PassStrings.typesNote
    case .card: PassStrings.typesCard
    }
}

/// The item type's icon on a tinted tile.
struct ItemIcon: View {
    let kind: PassItem.Kind
    var size: CGFloat = 40

    var body: some View {
        Image(systemName: symbol)
            .font(.system(size: size * 0.45))
            .foregroundStyle(Tokens.Brand.weldpass)
            .frame(width: size, height: size)
            .background(Tokens.Brand.weldpass.opacity(0.12), in: RoundedRectangle(cornerRadius: size * 0.28))
    }

    private var symbol: String {
        switch kind {
        case .login: "key"
        case .note: "note.text"
        case .card: "creditcard"
        }
    }
}
