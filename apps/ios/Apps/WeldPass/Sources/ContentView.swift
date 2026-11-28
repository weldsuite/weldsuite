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
                ItemListView(
                    store: store,
                    vaultID: nil,
                    emptyTitle: PassStrings.itemsEmpty,
                    emptyDescription: PassStrings.itemsEmptyDescription,
                    onAdd: canAdd ? { addItem() } : nil
                )
                .navigationTitle(PassStrings.itemsTitle)
                .toolbar {
                    ToolbarItem(placement: .primaryAction) { AddItemButton(id: "add-item", action: addItem) }
                }
                .navigationDestination(for: ItemRoute.self, destination: itemView)
            }
            // The platform sidebar's icons: LockKeyhole, Vault, Wand2, Settings.
            .tabItem { Label(PassStrings.tabsItems, systemImage: "lock") }
            .accessibilityIdentifier("tab-items")

            NavigationStack {
                VaultsView(store: store)
                    .navigationTitle(PassStrings.vaultsTitle)
                    .navigationDestination(for: VaultRoute.self) { route in
                        VaultView(store: store, vaultID: route.vaultID) { form = .new(.login, vaultID: route.vaultID) }
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
            // Shown only unlocked: open this workspace's copy (one Face ID opened
            // both), then the lists come from it, or from the server without one.
            store.use(workspace: workspace.id)
            await store.offline.open(person: person, workspace: workspace)
            if store.offline.readable == nil { await store.refresh() }
        }
    }

    /// "Add item": the form, where the type is picked, as on the platform.
    private func addItem() {
        form = .new(.login, vaultID: nil)
    }

    private var canAdd: Bool {
        (store.vaults.data ?? []).contains { PassLogic.canEdit($0) }
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

/// A server timestamp as the phone shows dates and times.
func formatWhen(_ iso: String) -> String {
    guard let date = PassLogic.parseDate(iso) else { return iso }
    return date.formatted(date: .abbreviated, time: .shortened)
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

/// The platform's icon for an item type (`ItemTypeIcon`: globe, sticky note, credit card).
func typeSymbol(_ kind: PassItem.Kind) -> String {
    switch kind {
    case .login: "globe"
    case .note: "note.text"
    case .card: "creditcard"
    }
}

/// The item type's icon, plain, in the muted colour unless told otherwise.
struct TypeIcon: View {
    let kind: PassItem.Kind
    var size: CGFloat = 16
    var color: Color = Tokens.Palette.mutedForeground

    var body: some View {
        Image(systemName: typeSymbol(kind))
            .font(.system(size: size))
            .foregroundStyle(color)
            .frame(width: size + 4)
            .accessibilityHidden(true)
    }
}

/// "Add item", in a navigation bar.
struct AddItemButton: View {
    let id: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: "plus")
        }
        .accessibilityLabel(PassStrings.itemsAdd)
        .accessibilityIdentifier(id)
    }
}

/// A server timestamp as time ago ("5 minutes ago", "yesterday"), like the platform's `TimeAgo`.
func formatAgo(_ iso: String) -> String {
    guard let date = PassLogic.parseDate(iso) else { return iso }
    return date.formatted(.relative(presentation: .named))
}
