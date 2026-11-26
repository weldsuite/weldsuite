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

    var body: some View {
        TabView {
            NavigationStack {
                ItemListView(store: store, vaultID: nil, emptyTitle: PassStrings.itemsEmpty, emptyDescription: PassStrings.itemsEmptyDescription)
                    .navigationTitle(PassStrings.itemsTitle)
                    .navigationDestination(for: ItemRoute.self) { route in
                        ItemView(env: env, store: store, route: route)
                    }
            }
            .tabItem { Label(PassStrings.tabsItems, systemImage: "key") }
            .accessibilityIdentifier("tab-items")

            NavigationStack {
                VaultsView(store: store)
                    .navigationTitle(PassStrings.vaultsTitle)
                    .navigationDestination(for: VaultRoute.self) { route in
                        VaultView(store: store, vaultID: route.vaultID)
                    }
                    .navigationDestination(for: ItemRoute.self) { route in
                        ItemView(env: env, store: store, route: route)
                    }
            }
            .tabItem { Label(PassStrings.tabsVaults, systemImage: "lock.rectangle.stack") }
            .accessibilityIdentifier("tab-vaults")

            NavigationStack {
                SettingsView(env: env, store: store, person: person, workspace: workspace, workspaces: workspaces)
                    .navigationTitle(PassStrings.settingsTitle)
            }
            .tabItem { Label(PassStrings.tabsSettings, systemImage: "gearshape") }
            .accessibilityIdentifier("tab-settings")
        }
        .task(id: workspace.id) {
            store.use(workspace: workspace.id)
            await store.refresh()
        }
    }
}

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
