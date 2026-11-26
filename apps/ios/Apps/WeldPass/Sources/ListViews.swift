import SwiftUI
import WeldCore
import WeldUI

/// A searchable list of items: all of them, or one vault's. Search and the
/// type filter run on the phone over what a list carries (titles,
/// usernames, sites), never a secret, so a keystroke costs no request.
struct ItemListView: View {
    let store: PassStore
    let vaultID: String?
    let emptyTitle: String
    let emptyDescription: String
    var note: String?

    @State private var query = ""
    @State private var kind: PassItem.Kind?

    var body: some View {
        let state = store.items
        let visible = PassLogic.filterItems(state.data ?? [], query: query, kind: kind, vaultID: vaultID)
        List {
            if let note {
                Text(note).font(.subheadline).foregroundStyle(.secondary)
            }
            Picker(PassStrings.formType, selection: $kind) {
                Text(PassStrings.itemsAll).tag(PassItem.Kind?.none)
                Text(PassStrings.typesLoginPlural).tag(PassItem.Kind?.some(.login))
                Text(PassStrings.typesNotePlural).tag(PassItem.Kind?.some(.note))
                Text(PassStrings.typesCardPlural).tag(PassItem.Kind?.some(.card))
            }
            .pickerStyle(.segmented)
            .listRowSeparator(.hidden)

            if state.data == nil, state.error == nil {
                ProgressView().frame(maxWidth: .infinity)
            } else if state.data == nil {
                ContentUnavailableView(passErrorMessage(state.error), systemImage: "exclamationmark.triangle")
            } else if visible.isEmpty {
                if query.isEmpty, kind == nil {
                    ContentUnavailableView(emptyTitle, systemImage: "key", description: Text(emptyDescription))
                } else {
                    ContentUnavailableView(
                        PassStrings.itemsNoMatches,
                        systemImage: "magnifyingglass",
                        description: Text(PassStrings.itemsNoMatchesDescription)
                    )
                }
            } else {
                ForEach(visible) { item in
                    NavigationLink(value: ItemRoute(vaultID: item.vaultID, itemID: item.id)) {
                        ItemRow(item: item)
                    }
                    .accessibilityIdentifier("item-\(item.title)")
                }
            }
        }
        .listStyle(.plain)
        .searchable(text: $query, prompt: PassStrings.itemsSearch)
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
        .refreshable { await store.refresh() }
    }
}

private struct ItemRow: View {
    let item: PassItem

    var body: some View {
        HStack(spacing: Tokens.Spacing.m) {
            ItemIcon(kind: item.kind)
            VStack(alignment: .leading, spacing: 2) {
                Text(item.title).font(.body.weight(.semibold)).lineLimit(1)
                let supporting = [item.subtitle, item.host].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
                if !supporting.isEmpty {
                    Text(supporting).font(.subheadline).foregroundStyle(.secondary).lineLimit(1)
                }
            }
        }
    }
}

/// The vaults the person can see: their personal vault first, then shared ones by name.
struct VaultsView: View {
    let store: PassStore

    var body: some View {
        let state = store.vaults
        let sorted = PassLogic.sortVaults(state.data ?? [])
        List {
            if state.data == nil, state.error == nil {
                ProgressView().frame(maxWidth: .infinity)
            } else if state.data == nil {
                ContentUnavailableView(passErrorMessage(state.error), systemImage: "exclamationmark.triangle")
            } else if sorted.isEmpty {
                ContentUnavailableView(
                    PassStrings.vaultsEmpty,
                    systemImage: "lock.rectangle.stack",
                    description: Text(PassStrings.vaultsEmptyDescription)
                )
            } else {
                ForEach(sorted) { vault in
                    NavigationLink(value: VaultRoute(vaultID: vault.id)) {
                        VaultRow(vault: vault)
                    }
                    .accessibilityIdentifier("vault-\(vault.kind == .personal ? "personal" : vault.name)")
                }
            }
        }
        .listStyle(.plain)
        .refreshable { await store.refresh() }
    }
}

private struct VaultRow: View {
    let vault: PassVault

    var body: some View {
        HStack(spacing: Tokens.Spacing.m) {
            Image(systemName: vault.kind == .personal ? "lock" : "person.2")
                .foregroundStyle(Tokens.Brand.weldpass)
                .frame(width: 40, height: 40)
                .background(Tokens.Brand.weldpass.opacity(0.12), in: RoundedRectangle(cornerRadius: Tokens.Radius.medium))
            VStack(alignment: .leading, spacing: 2) {
                Text(vaultLabel(vault)).font(.body.weight(.semibold)).lineLimit(1)
                Text(vault.kind == .personal ? PassStrings.vaultsPersonalDescription : summary)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
    }

    /// "12 items · 4 members · Can edit" for a shared vault.
    private var summary: String {
        var parts: [String] = []
        if let count = vault.itemCount { parts.append(PassStrings.itemsCount(count)) }
        if let count = vault.memberCount { parts.append(PassStrings.vaultsMembers(count)) }
        switch vault.role {
        case .viewer: parts.append(PassStrings.vaultsRolesViewer)
        case .editor: parts.append(PassStrings.vaultsRolesEditor)
        case .manager: parts.append(PassStrings.vaultsRolesManager)
        case nil: break
        }
        return parts.joined(separator: " · ")
    }
}

/// One vault's items.
struct VaultView: View {
    let store: PassStore
    let vaultID: String

    var body: some View {
        let vault = store.vaults.data?.first { $0.id == vaultID }
        Group {
            if PassLogic.isNonMemberView(vault) {
                ContentUnavailableView(PassStrings.vaultsNotMember, systemImage: "lock")
            } else {
                ItemListView(
                    store: store,
                    vaultID: vaultID,
                    emptyTitle: PassStrings.vaultsNoItems,
                    emptyDescription: PassStrings.vaultsNoItemsDescription,
                    note: note(vault)
                )
            }
        }
        .navigationTitle(vault.map(vaultLabel) ?? "")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func note(_ vault: PassVault?) -> String? {
        guard let vault else { return nil }
        if vault.kind == .personal { return PassStrings.vaultsPersonalDescription }
        return PassLogic.canEdit(vault) ? nil : PassStrings.vaultsReadOnly
    }
}
