import SwiftUI
import WeldCore
import WeldUI

/// A searchable list of items: all of them grouped by vault, as the
/// platform's Passwords page, or one vault's. Search and the type filter run
/// on the phone over what a list carries (titles, usernames, sites), never a
/// secret, so a keystroke costs no request.
struct ItemListView: View {
    let store: PassStore
    let vaultID: String?
    let emptyTitle: String
    let emptyDescription: String
    var note: String?
    /// "Add item" in the empty state, where the person may add one.
    var onAdd: (() -> Void)?

    @State private var query = ""
    @State private var kind: PassItem.Kind?

    var body: some View {
        let state = store.items
        let visible = PassLogic.filterItems(state.data ?? [], query: query, kind: kind, vaultID: vaultID)
        // All items are grouped by vault, as on the platform; inside a vault they aren't.
        let groups: [PassLogic.VaultGroup] = {
            guard vaultID == nil, let vaults = store.vaults.data else { return [PassLogic.VaultGroup(vault: nil, items: visible)] }
            return PassLogic.groupByVault(visible, vaults: vaults)
        }()
        List {
            Section {
                if vaultID == nil, store.offline.isOffline, let copy = store.offline.readable {
                    Label(PassStrings.itemsOfflineBanner(time: formatWhen(copy.syncedAt)), systemImage: "icloud.slash")
                        .font(.inter(.footnote))
                        .foregroundStyle(Tokens.Palette.mutedForeground)
                        .plainListRow()
                        .accessibilityIdentifier("offline-banner")
                }
                if let note {
                    Text(note)
                        .font(.inter(.footnote))
                        .foregroundStyle(Tokens.Palette.mutedForeground)
                        .plainListRow()
                }
                Picker(PassStrings.formType, selection: $kind) {
                    Text(PassStrings.itemsAll).tag(PassItem.Kind?.none)
                    Text(PassStrings.typesLoginPlural).tag(PassItem.Kind?.some(.login))
                    Text(PassStrings.typesNotePlural).tag(PassItem.Kind?.some(.note))
                    Text(PassStrings.typesCardPlural).tag(PassItem.Kind?.some(.card))
                }
                .pickerStyle(.segmented)
                .plainListRow()
            }

            if state.data == nil, state.error == nil {
                ProgressView().frame(maxWidth: .infinity).plainListRow()
            } else if state.data == nil {
                EmptyMessage(
                    systemImage: "exclamationmark.triangle",
                    title: passErrorMessage(state.error),
                    action: (label: PassStrings.commonTryAgain, id: "retry", run: { Task { await store.refresh() } })
                )
                .plainListRow()
            } else if visible.isEmpty {
                Group {
                    if query.isEmpty, kind == nil {
                        EmptyMessage(
                            systemImage: "lock",
                            title: emptyTitle,
                            description: emptyDescription,
                            action: onAdd.map { add in (label: PassStrings.itemsAdd, id: "empty-add-item", run: add) }
                        )
                    } else {
                        EmptyMessage(
                            systemImage: "magnifyingglass",
                            title: PassStrings.itemsNoMatches,
                            description: PassStrings.itemsNoMatchesDescription
                        )
                    }
                }
                .plainListRow()
            } else {
                ForEach(groups) { group in
                    if let vault = group.vault {
                        Section {
                            rows(group.items)
                        } header: {
                            GroupHeader(label: vaultLabel(vault), count: group.items.count)
                        }
                    } else {
                        Section { rows(group.items) }
                    }
                }
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(Tokens.Palette.background)
        .searchable(text: $query, prompt: PassStrings.itemsSearch)
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
        .refreshable { await store.refresh() }
    }

    private func rows(_ items: [PassItem]) -> some View {
        ForEach(items) { item in
            NavigationLink(value: ItemRoute(vaultID: item.vaultID, itemID: item.id)) {
                ItemRow(item: item)
            }
            .platformRow()
            .accessibilityIdentifier("item-\(item.title)")
        }
    }
}

/// One item, as the platform's list row: the type's icon, the title with a
/// shield when it has a 2FA code, and the username and site under it.
private struct ItemRow: View {
    let item: PassItem

    var body: some View {
        HStack(spacing: Tokens.Spacing.m) {
            TypeIcon(kind: item.kind)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(item.title)
                        .font(.inter(.subheadline, weight: .medium))
                        .foregroundStyle(Tokens.Palette.foreground)
                        .lineLimit(1)
                    if item.hasTotp {
                        Image(systemName: "checkmark.shield")
                            .font(.system(size: 12))
                            .foregroundStyle(Tokens.Palette.mutedForeground)
                            .accessibilityLabel(PassStrings.itemsHasTotp)
                    }
                }
                let supporting = [item.subtitle, item.host].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
                if !supporting.isEmpty {
                    Text(supporting)
                        .font(.inter(.footnote))
                        .foregroundStyle(Tokens.Palette.mutedForeground)
                        .lineLimit(1)
                }
            }
        }
        .padding(.vertical, 2)
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
                ProgressView().frame(maxWidth: .infinity).plainListRow()
            } else if state.data == nil {
                EmptyMessage(
                    systemImage: "exclamationmark.triangle",
                    title: passErrorMessage(state.error),
                    action: (label: PassStrings.commonTryAgain, id: "retry", run: { Task { await store.refresh() } })
                )
                .plainListRow()
            } else if sorted.isEmpty {
                EmptyMessage(
                    systemImage: "lock",
                    title: PassStrings.vaultsEmpty,
                    description: PassStrings.vaultsEmptyDescription
                )
                .plainListRow()
            } else {
                ForEach(sorted) { vault in
                    NavigationLink(value: VaultRoute(vaultID: vault.id)) {
                        VaultRow(vault: vault)
                    }
                    .platformRow()
                    .accessibilityIdentifier("vault-\(vault.kind == .personal ? "personal" : vault.name)")
                }
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(Tokens.Palette.background)
        .refreshable { await store.refresh() }
    }
}

/// One vault, as the platform's vault list shows it: the name with its
/// description under it, your role as a badge, and the item and member counts.
private struct VaultRow: View {
    let vault: PassVault

    var body: some View {
        HStack(spacing: Tokens.Spacing.m) {
            VStack(alignment: .leading, spacing: 2) {
                Text(vaultLabel(vault))
                    .font(.inter(.subheadline, weight: .medium))
                    .foregroundStyle(Tokens.Palette.foreground)
                    .lineLimit(1)
                if let description {
                    Text(description)
                        .font(.inter(.footnote))
                        .foregroundStyle(Tokens.Palette.mutedForeground)
                        .lineLimit(1)
                }
                if !counts.isEmpty {
                    Text(counts)
                        .font(.inter(.caption))
                        .foregroundStyle(Tokens.Palette.mutedForeground)
                }
            }
            Spacer(minLength: 0)
            roleBadge
        }
        .padding(.vertical, 2)
    }

    private var description: String? {
        if let text = vault.description, !text.isEmpty { return text }
        return vault.kind == .personal ? PassStrings.vaultsPersonalDescription : nil
    }

    /// "Your role": a neutral badge, or an amber "Not a member" for an admin outside the vault.
    @ViewBuilder private var roleBadge: some View {
        switch vault.role {
        case nil: StatusBadge(PassStrings.vaultsRolesNone, color: Tokens.Status.warning)
        case .viewer: NeutralBadge(PassStrings.vaultsRolesViewer)
        case .editor: NeutralBadge(PassStrings.vaultsRolesEditor)
        case .manager: NeutralBadge(PassStrings.vaultsRolesManager)
        }
    }

    /// "12 items · 4 members": the platform's Items and Members columns. A
    /// personal vault has no members to count, and an admin outside a vault
    /// sees no items.
    private var counts: String {
        var parts: [String] = []
        if vault.role != nil { parts.append(PassStrings.itemsCount(vault.itemCount ?? 0)) }
        if vault.kind == .shared { parts.append(PassStrings.vaultsMembers(vault.memberCount ?? 0)) }
        return parts.joined(separator: " · ")
    }
}

/// One vault's items: the platform's vault page. Adding is offered where the person may write.
struct VaultView: View {
    let store: PassStore
    let vaultID: String
    let onAdd: () -> Void

    var body: some View {
        let vault = store.vaults.data?.first { $0.id == vaultID }
        let canAdd = PassLogic.canEdit(vault)
        Group {
            if PassLogic.isNonMemberView(vault) {
                ScrollView {
                    EmptyMessage(
                        systemImage: "lock",
                        title: PassStrings.vaultsNotMemberTitle,
                        description: PassStrings.vaultsNotMember
                    )
                }
            } else {
                ItemListView(
                    store: store,
                    vaultID: vaultID,
                    emptyTitle: PassStrings.vaultsNoItems,
                    emptyDescription: PassStrings.vaultsNoItemsDescription,
                    note: note(vault),
                    onAdd: canAdd ? onAdd : nil
                )
            }
        }
        .navigationTitle(vault.map(vaultLabel) ?? "")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if canAdd {
                ToolbarItem(placement: .primaryAction) { AddItemButton(id: "add-item-in-vault", action: onAdd) }
            }
        }
    }

    private func note(_ vault: PassVault?) -> String? {
        guard let vault else { return nil }
        if vault.kind == .personal { return PassStrings.vaultsPersonalDescription }
        return PassLogic.canEdit(vault) ? nil : PassStrings.vaultsReadOnly
    }
}
