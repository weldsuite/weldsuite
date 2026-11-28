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
        let sections = MailLogic.sections(visible, pinned: store.pinned)
        let tail = Set(visible.suffix(10).map(\.id))
        let system = SystemLabel.of(store.label)
        let customColors = Dictionary(store.labels.custom.map { ($0.name, $0.color) }, uniquingKeysWith: { first, _ in first })

        List {
            Section {
                controls
            }
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
                ForEach(sections) { section in
                    Section(sectionTitle(section.section)) {
                        ForEach(section.messages) { message in
                            row(message, customColors: customColors)
                                .onAppear { if tail.contains(message.id) { store.loadMore() } }
                        }
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
                    .font(.inter(.headline))
                    .padding(.horizontal, Tokens.Spacing.l)
                    .padding(.vertical, Tokens.Spacing.m)
                    .background(Capsule().fill(Color.accentColor))
                    .foregroundStyle(.white)
                    .shadow(radius: 4, y: 2)
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

    private var controls: some View {
        VStack(alignment: .leading, spacing: Tokens.Spacing.s) {
            Button {
                nav.tab = .search
            } label: {
                HStack {
                    Image(systemName: "magnifyingglass")
                    Text(MailStrings.inboxSearchMail)
                    Spacer()
                }
                .foregroundStyle(.secondary)
                .padding(.horizontal, Tokens.Spacing.m)
                .padding(.vertical, 10)
                .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: Tokens.Radius.medium))
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("search-mail")
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: Tokens.Spacing.s) {
                    ForEach(InboxFilter.allCases) { option in
                        FilterChip(title: filterTitle(option), selected: filter == option) { filter = option }
                            .accessibilityIdentifier("filter-\(option.rawValue)")
                    }
                }
            }
        }
    }

    private func filterTitle(_ option: InboxFilter) -> String {
        switch option {
        case .all: return MailStrings.inboxFilterAll
        case .unread: return MailStrings.inboxFilterUnread
        case .starred: return MailStrings.inboxFilterStarred
        case .attachments: return MailStrings.inboxFilterAttachments
        }
    }

    private func sectionTitle(_ section: DateSection) -> String {
        switch section {
        case .pinned: return MailStrings.inboxPinned
        case .today: return CoreStrings.commonToday
        case .yesterday: return CoreStrings.commonYesterday
        case .thisWeek: return MailStrings.inboxThisWeek
        case .older: return MailStrings.inboxOlder
        }
    }

    private func row(_ message: MailMessage, customColors: [String: String?]) -> some View {
        let pinned = store.pinned.contains(message.id)
        return Button {
            if !message.isRead { store.setRead(message.id, true) }
            nav.open(.message(message.id))
        } label: {
            MessageRow(message: message, pinned: pinned, customColors: customColors)
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("inbox-email-row")
        .swipeActions(edge: .leading, allowsFullSwipe: true) {
            Button {
                store.setRead(message.id, !message.isRead)
            } label: {
                Label(message.isRead ? MailStrings.swipeUnread : MailStrings.swipeRead, systemImage: message.isRead ? "envelope.badge" : "envelope.open")
            }
            .tint(MailColors.read)
            Button {
                store.togglePin(message.id)
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
            .tint(MailColors.delete)
            Button {
                store.archive(message.id)
            } label: {
                Label(MailStrings.swipeArchive, systemImage: "archivebox")
            }
            .tint(MailColors.archive)
            Button {
                snoozing = message
            } label: {
                Label(MailStrings.swipeSnooze, systemImage: "clock")
            }
            .tint(MailColors.snooze)
        }
    }
}

/// A chip that filters a list.
struct FilterChip: View {
    let title: String
    let selected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.inter(.subheadline))
                .padding(.horizontal, Tokens.Spacing.m)
                .padding(.vertical, 6)
                .background(selected ? Color.accentColor.opacity(0.15) : Color(.secondarySystemBackground), in: Capsule())
                .overlay(Capsule().stroke(selected ? Color.accentColor : Color.clear))
                .foregroundStyle(selected ? Color.accentColor : Color.primary)
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

/// One email in a list.
struct MessageRow: View {
    let message: MailMessage
    let pinned: Bool
    let customColors: [String: String?]

    var body: some View {
        let sender = message.senderName ?? MailStrings.commonUnknown
        HStack(alignment: .top, spacing: Tokens.Spacing.m) {
            SenderAvatar(name: sender)
                .overlay(alignment: .topTrailing) {
                    if !message.isRead {
                        Circle().fill(Color.accentColor).frame(width: 10, height: 10)
                    }
                }
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: Tokens.Spacing.xs) {
                    Text(sender)
                        .fontWeight(message.isRead ? .medium : .semibold)
                        .foregroundStyle(message.isRead ? .secondary : .primary)
                        .lineLimit(1)
                    if message.threadCount > 1 {
                        Text("\(message.threadCount)")
                            .font(.inter(.caption2))
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 5)
                            .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 4))
                    }
                    Spacer(minLength: 0)
                    if message.hasAttachments {
                        Image(systemName: "paperclip").font(.inter(.caption)).foregroundStyle(.secondary)
                            .accessibilityLabel(MailStrings.inboxHasAttachments)
                    }
                    if pinned {
                        Image(systemName: "pin.fill").font(.inter(.caption)).foregroundStyle(MailColors.pin)
                            .accessibilityLabel(MailStrings.inboxIsPinned)
                    }
                    if message.isStarred {
                        Image(systemName: "star.fill").font(.inter(.caption)).foregroundStyle(MailColors.star)
                            .accessibilityLabel(MailStrings.inboxIsStarred)
                    }
                    Text(rowTime(message.listDate)).font(.inter(.caption)).foregroundStyle(.secondary)
                }
                Text(message.subject.flatMap { $0.trimmingCharacters(in: .whitespaces).isEmpty ? nil : $0 } ?? MailStrings.commonNoSubject)
                    .fontWeight(message.isRead ? .regular : .medium)
                    .foregroundStyle(message.isRead ? .secondary : .primary)
                    .lineLimit(1)
                Text(message.preview ?? "")
                    .font(.inter(.footnote))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                let shown = MailLogic.displayLabels(message.labels)
                if !shown.isEmpty {
                    HStack(spacing: Tokens.Spacing.xs) {
                        ForEach(Array(shown.prefix(3)), id: \.self) { name in
                            LabelChip(name: name, color: MailLogic.labelColor(name, own: customColors[name] ?? nil))
                        }
                        if shown.count > 3 {
                            Text("+\(shown.count - 3)").font(.inter(.caption2)).foregroundStyle(.secondary)
                        }
                    }
                    .padding(.top, 2)
                }
            }
        }
        .padding(.vertical, Tokens.Spacing.xs)
        .contentShape(Rectangle())
    }
}

/// The mailboxes, the folders and labels of the one on screen, subscriptions.
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
                    VStack(alignment: .leading, spacing: 2) {
                        Text(selected?.displayName ?? MailStrings.drawerAllInboxes).font(.inter(.headline))
                        Text(selected?.email ?? MailStrings.drawerAccounts(own.count)).font(.inter(.footnote)).foregroundStyle(.secondary)
                        Text(workspace.name).font(.inter(.caption)).foregroundStyle(.secondary)
                    }
                    menuRow(MailStrings.drawerAllInboxes, systemImage: "tray.2", selected: store.mailbox == .unified, tag: "mailbox-unified") {
                        store.select(mailbox: .unified)
                        dismiss()
                    }
                    ForEach(own) { account in
                        Button {
                            store.select(mailbox: .account(account.id))
                            dismiss()
                        } label: {
                            HStack {
                                SenderAvatar(name: account.displayName, size: 24)
                                VStack(alignment: .leading) {
                                    Text(account.displayName).lineLimit(1).foregroundStyle(.primary)
                                    Text(account.email).font(.inter(.caption)).foregroundStyle(.secondary).lineLimit(1)
                                }
                                Spacer()
                                if selected?.id == account.id { Image(systemName: "checkmark").foregroundStyle(Color.accentColor) }
                            }
                        }
                        .accessibilityIdentifier("mailbox-\(account.email)")
                    }
                    menuRow(MailStrings.drawerAddAccount, systemImage: "plus.circle", selected: false, tag: "add-account") {
                        dismiss()
                        nav.tab = .mail
                        nav.open(.addAccount)
                    }
                }
                ForEach(others.keys.sorted(), id: \.self) { name in
                    Section(MailStrings.drawerInWorkspace(workspace: name)) {
                        ForEach(others[name] ?? []) { account in
                            Button {
                                guard let workspaceID = account.workspaceID else { return }
                                store.preselect(workspace: workspaceID, accountID: account.id)
                                dismiss()
                                env.chooseWorkspace(workspaceID)
                            } label: {
                                HStack {
                                    SenderAvatar(name: account.displayName, size: 24)
                                    Text(account.displayName).lineLimit(1).foregroundStyle(.primary)
                                }
                            }
                        }
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
                    menuRow(more ? MailStrings.drawerLess : MailStrings.drawerMore, systemImage: more ? "chevron.up" : "chevron.down", selected: false, tag: "drawer-more") {
                        more.toggle()
                    }
                }
                Section {
                    if store.labels.custom.isEmpty {
                        Text(MailStrings.drawerNoLabels).font(.inter(.footnote)).foregroundStyle(.secondary)
                    }
                    ForEach(store.labels.custom) { custom in
                        Button {
                            store.select(label: custom.slug)
                            dismiss()
                        } label: {
                            HStack {
                                Image(systemName: "tag").foregroundStyle(Color(mailRGB: MailLogic.labelColor(custom.name, own: custom.color)))
                                Text(custom.name).lineLimit(1).foregroundStyle(.primary)
                                Spacer()
                                if custom.count > 0 { Text("\(custom.count)").font(.inter(.caption)).foregroundStyle(.secondary) }
                                if store.label == custom.slug { Image(systemName: "checkmark").foregroundStyle(Color.accentColor) }
                            }
                        }
                    }
                } header: {
                    HStack {
                        Text(MailStrings.drawerLabels)
                        Spacer()
                        if selected != nil {
                            Button {
                                creating = true
                            } label: {
                                Image(systemName: "plus")
                            }
                            .accessibilityLabel(MailStrings.drawerCreateLabel)
                            .accessibilityIdentifier("create-label")
                        }
                    }
                }
            }
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

    private func folder(_ system: SystemLabel) -> some View {
        Button {
            store.select(label: system.slug)
            dismiss()
        } label: {
            HStack {
                Label(system.title, systemImage: system.systemImage).foregroundStyle(.primary)
                Spacer()
                if let count = store.labels.systemCounts[system.slug], count > 0 {
                    Text("\(count)").font(.inter(.caption)).foregroundStyle(.secondary)
                }
                if store.label == system.slug { Image(systemName: "checkmark").foregroundStyle(Color.accentColor) }
            }
        }
        .accessibilityIdentifier("folder-\(system.slug.lowercased())")
    }

    private func menuRow(_ title: String, systemImage: String, selected: Bool, tag: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack {
                Label(title, systemImage: systemImage).foregroundStyle(.primary)
                Spacer()
                if selected { Image(systemName: "checkmark").foregroundStyle(Color.accentColor) }
            }
        }
        .accessibilityIdentifier(tag)
    }
}
