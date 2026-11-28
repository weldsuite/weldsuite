import SwiftUI
import UIKit
import WeldCore
import WeldUI

/// The inbox: a folder of one mailbox or of all of them, with the mailboxes,
/// folders and labels in a sheet (Android's drawer).
struct InboxView: View {
    let env: AppEnvironment
    let store: MailStore
    let workspace: WorkspaceRef

    @Environment(MailNavigator.self) private var nav
    @Environment(MailNotifier.self) private var notifier
    @State private var filter = InboxFilter.all
    @State private var snoozing: MailMessage?
    @State private var showingMailboxes = false

    var body: some View {
        let visible = MailLogic.filter(store.inbox.messages, filter)
        let sections = MailLogic.sections(visible)
        let tail = Set(visible.suffix(10).map(\.id))
        let system = SystemLabel.of(store.label)
        let labelColors = Dictionary(store.labels.custom.map { ($0.name, $0.color) }, uniquingKeysWith: { first, _ in first })
        let outgoing = MailLogic.isOutgoingFolder(store.label)

        List {
            controls
                .listRowInsets(EdgeInsets())
                .listRowSeparator(.hidden)

            if store.inbox.loading && store.inbox.messages.isEmpty {
                ProgressView()
                    .frame(maxWidth: .infinity)
                    .padding(48)
                    .listRowSeparator(.hidden)
            } else if store.accountsLoaded && store.sendableAccounts.isEmpty && store.inbox.messages.isEmpty {
                MailEmptyView(title: MailStrings.emptyNoMailboxTitle, description: MailStrings.emptyNoMailboxDescription, systemImage: "envelope")
                    .listRowSeparator(.hidden)
            } else if sections.isEmpty {
                let empty = emptyText(system)
                MailEmptyView(title: empty.title, description: empty.description, systemImage: system?.systemImage ?? "tray")
                    .listRowSeparator(.hidden)
            } else {
                ForEach(Array(sections.enumerated()), id: \.element.id) { index, section in
                    // As on the platform, today's mail at the top of the list has no header.
                    if index > 0 || section.group.kind != .today {
                        GroupHeader(title: groupTitle(section.group), count: section.messages.count)
                            .listRowInsets(EdgeInsets())
                            .listRowSeparator(.hidden)
                    }
                    ForEach(section.messages) { message in
                        row(message, outgoing: outgoing, labelColors: labelColors)
                            .onAppear { if tail.contains(message.id) { store.loadMore() } }
                    }
                }
            }
            if store.inbox.loadingMore {
                ProgressView().frame(maxWidth: .infinity).listRowSeparator(.hidden)
            }
            Color.clear.frame(height: 72).listRowSeparator(.hidden)
        }
        .listStyle(.plain)
        .accessibilityIdentifier("inbox-list")
        .refreshable { await store.refresh() }
        .safeAreaInset(edge: .top, spacing: 0) {
            if !store.connectivity.online { OfflineBanner() }
        }
        .overlay(alignment: .bottomTrailing) {
            Button {
                nav.compose(ComposePrefill())
            } label: {
                Label(MailStrings.inboxCompose, systemImage: "square.and.pencil")
                    .font(.inter(.subheadline, weight: .medium))
                    .padding(.horizontal, Tokens.Spacing.l)
                    .padding(.vertical, Tokens.Spacing.m)
                    .background(Tokens.Palette.primary, in: RoundedRectangle(cornerRadius: Tokens.Radius.xlarge))
                    .foregroundStyle(Tokens.Palette.primaryForeground)
                    .shadow(color: .black.opacity(0.15), radius: 4, y: 2)
            }
            .padding(Tokens.Spacing.l)
            .accessibilityIdentifier("compose")
        }
        .navigationTitle(system?.title ?? store.labels.custom.first { $0.slug == store.label }?.name ?? store.label)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button {
                    showingMailboxes = true
                } label: {
                    Image(systemName: "line.3.horizontal")
                }
                .accessibilityLabel(MailStrings.inboxOpenMailboxes)
                .accessibilityIdentifier("open-mailboxes")
            }
        }
        .onChange(of: sections.flatMap { $0.messages.map(\.id) }, initial: true) { _, ids in
            store.visibleIDs = ids
        }
        .sheet(isPresented: $showingMailboxes) {
            MailboxMenuView(env: env, store: store, workspace: workspace)
        }
        .sheet(item: $snoozing) { message in
            TimeChoiceSheet(title: MailStrings.snoozeTitle, choices: TimeChoice.snooze(), tint: MailColors.snooze) { at in
                snoozing = nil
                store.snooze(message, until: WeldDate.timestampString(at))
                notifier.show(MailStrings.inboxSnoozed(time: momentText(at)), action: MailStrings.commonUndo) {
                    store.unsnooze(message)
                }
            }
        }
    }

    /// Above the list: the search box and the quick filters, as the platform's list header.
    private var controls: some View {
        VStack(alignment: .leading, spacing: Tokens.Spacing.s) {
            Button {
                nav.tab = .search
            } label: {
                HStack(spacing: Tokens.Spacing.s) {
                    Image(systemName: "magnifyingglass").font(.system(size: 14))
                    Text(MailStrings.inboxSearchMail).font(.inter(.subheadline))
                    Spacer()
                }
                .foregroundStyle(Tokens.Palette.mutedForeground)
                .padding(.horizontal, 10)
                .frame(height: 40)
                .background(Tokens.Palette.background, in: RoundedRectangle(cornerRadius: Tokens.Radius.medium))
                .overlay(RoundedRectangle(cornerRadius: Tokens.Radius.medium).stroke(Tokens.Palette.border))
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .padding(.horizontal, Tokens.Spacing.l)
            .accessibilityIdentifier("search-mail")
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: Tokens.Spacing.s) {
                    ForEach(InboxFilter.allCases) { option in
                        FilterChip(title: filterTitle(option), selected: filter == option) { filter = option }
                            .accessibilityIdentifier("filter-\(option.rawValue)")
                    }
                }
                .padding(.horizontal, Tokens.Spacing.l)
                .padding(.vertical, 1)
            }
        }
        .padding(.vertical, Tokens.Spacing.s)
        .overlay(alignment: .bottom) { Hairline() }
    }

    private func filterTitle(_ option: InboxFilter) -> String {
        switch option {
        case .all: return MailStrings.inboxFilterAll
        case .unread: return MailStrings.inboxFilterUnread
        case .starred: return MailStrings.inboxFilterStarred
        case .attachments: return MailStrings.inboxFilterAttachments
        }
    }

    private func row(_ message: MailMessage, outgoing: Bool, labelColors: [String: String?]) -> some View {
        let pinned = MailLogic.isPinned(message)
        return Button {
            if !message.isRead { store.setRead(message.id, true) }
            nav.open(.message(message.id))
        } label: {
            MessageRow(message: message, pinned: pinned, outgoing: outgoing, labelColors: labelColors)
        }
        .buttonStyle(.plain)
        .listRowInsets(EdgeInsets())
        .listRowSeparatorTint(Tokens.Palette.border)
        .alignmentGuide(.listRowSeparatorLeading) { _ in 0 }
        .accessibilityIdentifier("inbox-email-row")
        .swipeActions(edge: .leading, allowsFullSwipe: true) {
            Button {
                store.setRead(message.id, !message.isRead)
            } label: {
                Label(message.isRead ? MailStrings.swipeUnread : MailStrings.swipeRead, systemImage: message.isRead ? "envelope.badge" : "envelope.open")
            }
            .tint(MailColors.neutral)
            Button {
                Task {
                    do {
                        try await store.setPinned(message.id, labels: message.labels, on: !pinned)
                    } catch {
                        notifier.show(error)
                    }
                }
            } label: {
                Label(pinned ? MailStrings.swipeUnpin : MailStrings.swipePin, systemImage: pinned ? "pin.slash" : "pin")
            }
            .tint(MailColors.pin)
        }
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            Button(role: .destructive) {
                store.delete(message.id)
            } label: {
                Label(MailStrings.swipeDelete, systemImage: "trash")
            }
            .tint(Tokens.Status.danger)
            Button {
                store.archive(message.id)
            } label: {
                Label(MailStrings.swipeArchive, systemImage: "archivebox")
            }
            .tint(MailColors.neutral)
            Button {
                snoozing = message
            } label: {
                Label(MailStrings.swipeSnooze, systemImage: "clock")
            }
            .tint(MailColors.snooze)
        }
    }
}

/// The mailbox menu, as the platform's mail sidebar in a sheet: the
/// mailboxes to switch between (all of them, each account, those in other
/// workspaces), then the "Mailboxes" group (the folders, more behind More)
/// and the "Labels" group with each label's colour and count.
struct MailboxMenuView: View {
    let env: AppEnvironment
    let store: MailStore
    let workspace: WorkspaceRef

    @Environment(MailNavigator.self) private var nav
    @Environment(\.dismiss) private var dismiss
    @State private var more = false
    @State private var creating = false

    var body: some View {
        let own = store.sendableAccounts
        let others = Dictionary(grouping: store.accounts.filter { !$0.inActiveWorkspace }) { $0.workspaceName ?? "" }
        let selected = store.selectedAccount
        NavigationStack {
            List {
                Section {
                    HStack(spacing: Tokens.Spacing.m) {
                        if let selected {
                            MailAvatar(name: selected.displayName, size: 32)
                        } else {
                            Image(systemName: "tray")
                                .font(.system(size: 14))
                                .foregroundStyle(Tokens.Palette.mutedForeground)
                                .frame(width: 32, height: 32)
                                .background(Tokens.Palette.muted, in: Circle())
                        }
                        VStack(alignment: .leading, spacing: 1) {
                            Text(selected?.displayName ?? MailStrings.drawerAllInboxes).font(.inter(.subheadline, weight: .semibold)).lineLimit(1)
                            Text(selected?.email ?? MailStrings.drawerAccounts(own.count)).font(.inter(.caption)).foregroundStyle(Tokens.Palette.mutedForeground).lineLimit(1)
                            Text(workspace.name).font(.inter(.caption)).foregroundStyle(Tokens.Palette.mutedForeground).lineLimit(1)
                        }
                    }
                    .padding(.vertical, Tokens.Spacing.xs)
                    .menuRowStyle(selected: false)
                    menuRow(MailStrings.drawerAllInboxes, systemImage: "tray", selected: store.mailbox == .unified, tag: "mailbox-unified") {
                        store.select(mailbox: .unified)
                        dismiss()
                    }
                    ForEach(own) { account in
                        accountRow(account, selected: selected?.id == account.id) {
                            store.select(mailbox: .account(account.id))
                            dismiss()
                        }
                        .accessibilityIdentifier("mailbox-\(account.email)")
                    }
                    menuRow(MailStrings.drawerAddAccount, systemImage: "plus", selected: false, muted: true, tag: "add-account") {
                        dismiss()
                        nav.tab = .mail
                        nav.open(.addAccount)
                    }
                }
                ForEach(others.keys.sorted(), id: \.self) { name in
                    Section {
                        ForEach(others[name] ?? []) { account in
                            accountRow(account, selected: false) {
                                guard let workspaceID = account.workspaceID else { return }
                                store.preselect(workspace: workspaceID, accountID: account.id)
                                dismiss()
                                env.chooseWorkspace(workspaceID)
                            }
                        }
                    } header: {
                        groupLabel(MailStrings.drawerInWorkspace(workspace: name))
                    }
                }
                Section {
                    ForEach(SystemLabel.main) { folder($0) }
                    if more {
                        ForEach(SystemLabel.secondary) { folder($0) }
                        menuRow(MailStrings.drawerSubscriptions, systemImage: "envelope.badge.shield.half.filled", selected: false, tag: "open-subscriptions") {
                            dismiss()
                            nav.tab = .mail
                            nav.open(.subscriptions)
                        }
                    }
                    menuRow(more ? MailStrings.drawerLess : MailStrings.drawerMore, systemImage: more ? "chevron.up" : "chevron.down", selected: false, muted: true, tag: "drawer-more") {
                        more.toggle()
                    }
                } header: {
                    groupLabel(MailStrings.drawerTitle)
                }
                Section {
                    if store.labels.custom.isEmpty {
                        Text(MailStrings.drawerNoLabels)
                            .font(.inter(.footnote))
                            .foregroundStyle(Tokens.Palette.mutedForeground)
                            .menuRowStyle(selected: false)
                    }
                    ForEach(store.labels.custom) { custom in
                        Button {
                            store.select(label: custom.slug)
                            dismiss()
                        } label: {
                            HStack(spacing: Tokens.Spacing.m) {
                                Circle().fill(labelTint(custom.name, own: custom.color)).frame(width: 10, height: 10).frame(width: 20)
                                Text(custom.name).font(.inter(.subheadline, weight: store.label == custom.slug ? .medium : .regular)).lineLimit(1).foregroundStyle(Tokens.Palette.foreground)
                                Spacer()
                                if custom.count > 0 { count(custom.count) }
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .menuRowStyle(selected: store.label == custom.slug)
                    }
                    if selected != nil {
                        Button {
                            creating = true
                        } label: {
                            Label(MailStrings.drawerAddLabel, systemImage: "plus")
                                .font(.inter(.footnote))
                                .foregroundStyle(Tokens.Palette.mutedForeground)
                                .frame(maxWidth: .infinity)
                                .frame(height: 36)
                                .overlay(
                                    RoundedRectangle(cornerRadius: Tokens.Radius.medium)
                                        .strokeBorder(Tokens.Palette.mutedForeground.opacity(0.3), style: StrokeStyle(lineWidth: 1, dash: [4, 3]))
                                )
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .menuRowStyle(selected: false)
                        .accessibilityIdentifier("create-label")
                    }
                } header: {
                    groupLabel(MailStrings.drawerLabels)
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(Tokens.Palette.chrome)
            .accessibilityIdentifier("mailbox-drawer")
            .navigationTitle(MailStrings.drawerTitle)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(CoreStrings.commonClose) { dismiss() }
                }
            }
            .sheet(isPresented: $creating) {
                if let selected {
                    CreateLabelSheet(aiAvailable: env.isAvailable("mail-ai")) { name, color in
                        try await store.createLabel(accountID: selected.id, name: name, color: color)
                    }
                }
            }
        }
    }

    /// A group's name: small, medium, muted, as the platform sidebar's group labels.
    private func groupLabel(_ text: String) -> some View {
        Text(text)
            .font(.inter(.caption, weight: .medium))
            .foregroundStyle(Tokens.Palette.mutedForeground)
            .textCase(nil)
    }

    private func count(_ value: Int) -> some View {
        Text("\(value)").font(.inter(.caption, weight: .medium)).foregroundStyle(Tokens.Palette.mutedForeground)
    }

    private func folder(_ system: SystemLabel) -> some View {
        Button {
            store.select(label: system.slug)
            dismiss()
        } label: {
            HStack(spacing: Tokens.Spacing.m) {
                Image(systemName: system.systemImage).font(.system(size: 15)).foregroundStyle(Tokens.Palette.mutedForeground).frame(width: 20)
                Text(system.title).font(.inter(.subheadline, weight: store.label == system.slug ? .medium : .regular)).foregroundStyle(Tokens.Palette.foreground)
                Spacer()
                if let value = store.labels.systemCounts[system.slug], value > 0 { count(value) }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .menuRowStyle(selected: store.label == system.slug)
        .accessibilityIdentifier("folder-\(system.slug.lowercased())")
    }

    private func accountRow(_ account: MailAccount, selected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: Tokens.Spacing.m) {
                MailAvatar(name: account.displayName, size: 20).frame(width: 20)
                VStack(alignment: .leading, spacing: 0) {
                    Text(account.displayName).font(.inter(.subheadline, weight: selected ? .medium : .regular)).lineLimit(1).foregroundStyle(Tokens.Palette.foreground)
                    if account.email != account.displayName {
                        Text(account.email).font(.inter(.caption)).foregroundStyle(Tokens.Palette.mutedForeground).lineLimit(1)
                    }
                }
                Spacer()
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .menuRowStyle(selected: selected)
    }

    private func menuRow(_ title: String, systemImage: String, selected: Bool, muted: Bool = false, tag: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: Tokens.Spacing.m) {
                Image(systemName: systemImage).font(.system(size: 15)).foregroundStyle(Tokens.Palette.mutedForeground).frame(width: 20)
                Text(title)
                    .font(.inter(.subheadline, weight: selected ? .medium : .regular))
                    .foregroundStyle(muted ? Tokens.Palette.mutedForeground : Tokens.Palette.foreground)
                Spacer()
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .menuRowStyle(selected: selected)
        .accessibilityIdentifier(tag)
    }
}

private extension View {
    /// A row of the mailbox menu, as a platform sidebar item: no separators, the accent fill when it is the one on screen.
    func menuRowStyle(selected: Bool) -> some View {
        self
            .padding(.horizontal, Tokens.Spacing.s)
            .padding(.vertical, 2)
            .frame(minHeight: 36)
            .background(selected ? Tokens.Palette.accent : Color.clear, in: RoundedRectangle(cornerRadius: Tokens.Radius.medium))
            .listRowInsets(EdgeInsets(top: 1, leading: Tokens.Spacing.s, bottom: 1, trailing: Tokens.Spacing.s))
            .listRowSeparator(.hidden)
            .listRowBackground(Color.clear)
            .accessibilityAddTraits(selected ? .isSelected : [])
    }
}
