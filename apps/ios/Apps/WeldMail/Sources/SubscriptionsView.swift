import SwiftUI
import UIKit
import WeldCore
import WeldUI

/// The newsletters and mailing lists a mailbox receives, with one-tap unsubscribe.
struct SubscriptionsView: View {
    let store: MailStore

    @Environment(MailNotifier.self) private var notifier
    @State private var account: MailAccount?
    @State private var items: [MailSubscription] = []
    @State private var loading = true
    @State private var error: APIError?
    @State private var scanning = false
    @State private var query = ""
    @State private var showUnsubscribed = false
    @State private var pending: MailSubscription?
    @State private var busy = false
    @State private var reload = 0

    var body: some View {
        let active = items.filter(\.active).count
        let shown = items.filter { $0.active == !showUnsubscribed && MailLogic.matches($0, query: query) }
        Group {
            if account == nil && !loading {
                MailEmptyView(title: MailStrings.subscriptionsNoMailboxTitle, description: MailStrings.subscriptionsNoMailbox, systemImage: "envelope")
            } else {
                List {
                    Section {
                        if store.sendableAccounts.count > 1 {
                            ScrollView(.horizontal, showsIndicators: false) {
                                HStack(spacing: Tokens.Spacing.s) {
                                    ForEach(store.sendableAccounts) { option in
                                        FilterChip(title: option.email, selected: option.id == account?.id) {
                                            guard option.id != account?.id else { return }
                                            account = option
                                            items = []
                                            loading = true
                                        }
                                    }
                                }
                            }
                        }
                        HStack {
                            Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                            TextField(MailStrings.subscriptionsSearchPlaceholder, text: $query)
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
                                .accessibilityIdentifier("subscriptions-search")
                        }
                        Picker("", selection: $showUnsubscribed) {
                            Text(MailStrings.subscriptionsSubscribed(count: active)).tag(false)
                            Text(MailStrings.subscriptionsUnsubscribedTab(count: items.count - active)).tag(true)
                        }
                        .pickerStyle(.segmented)
                    }
                    .listRowSeparator(.hidden)

                    if loading {
                        ProgressView().frame(maxWidth: .infinity).padding(48).listRowSeparator(.hidden)
                    } else if let error, items.isEmpty {
                        LoadErrorView(error: error) { reload += 1 }.listRowSeparator(.hidden)
                    } else if shown.isEmpty {
                        let hint = query.trimmingCharacters(in: .whitespaces).isEmpty && !showUnsubscribed
                        VStack(spacing: Tokens.Spacing.m) {
                            MailEmptyView(
                                title: !query.trimmingCharacters(in: .whitespaces).isEmpty
                                    ? MailStrings.subscriptionsNoMatches
                                    : (showUnsubscribed ? MailStrings.subscriptionsEmptyUnsubscribed : MailStrings.subscriptionsEmptyActive),
                                description: hint ? MailStrings.subscriptionsEmptyHint : nil,
                                systemImage: "envelope.badge.shield.half.filled"
                            )
                            if hint {
                                Button(scanning ? MailStrings.subscriptionsScanning : MailStrings.subscriptionsScan) { scan() }
                                    .buttonStyle(.borderedProminent)
                                    .disabled(scanning)
                            }
                        }
                        .frame(maxWidth: .infinity)
                        .listRowSeparator(.hidden)
                    } else {
                        ForEach(shown) { item in
                            SubscriptionRow(item: item) { pending = item }
                        }
                    }
                }
                .listStyle(.plain)
                .accessibilityIdentifier("subscriptions-list")
                .refreshable { await load() }
            }
        }
        .navigationTitle(MailStrings.subscriptionsTitle)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    scan()
                } label: {
                    if scanning { ProgressView() } else { Image(systemName: "arrow.clockwise") }
                }
                .disabled(scanning || account == nil)
                .accessibilityLabel(MailStrings.subscriptionsScan)
                .accessibilityIdentifier("subscriptions-scan")
            }
        }
        .task(id: TaskKey(account: account?.id, reload: reload)) {
            if account == nil {
                account = store.selectedAccount.flatMap { $0.inActiveWorkspace ? $0 : nil } ?? store.sendableAccounts.first
            }
            await load()
        }
        .alert(
            pending.map { MailStrings.unsubscribeConfirmTitle(sender: $0.senderLabel) } ?? "",
            isPresented: Binding(get: { pending != nil }, set: { if !$0 { pending = nil } }),
            presenting: pending
        ) { item in
            Button(Unsubscribing.confirmLabel(item)) { unsubscribe(item) }
                .accessibilityIdentifier("confirm-unsubscribe")
            Button(CoreStrings.commonCancel, role: .cancel) { pending = nil }
        } message: { item in
            Text(Unsubscribing.message(item))
        }
    }

    private struct TaskKey: Hashable {
        let account: String?
        let reload: Int
    }

    private func load() async {
        guard let current = account else {
            loading = false
            return
        }
        error = nil
        do {
            let list = try await store.repository.subscriptions(accountID: current.id)
            if account?.id == current.id { items = list }
        } catch {
            if account?.id == current.id { self.error = APIError.from(error) }
        }
        loading = false
    }

    private func scan() {
        guard let current = account else { return }
        scanning = true
        Task {
            do {
                let result = try await store.repository.scan(accountID: current.id)
                store.forgetSubscriptions(accountID: current.id)
                notifier.show(MailStrings.subscriptionsScanned(foundCount: result.found, scannedCount: result.scanned))
                reload += 1
            } catch {
                notifier.show(MailStrings.subscriptionsScanFailed)
            }
            scanning = false
        }
    }

    private func unsubscribe(_ item: MailSubscription) {
        busy = true
        pending = nil
        Task {
            do {
                let result = try await store.repository.unsubscribe(item.id)
                store.forgetSubscriptions(accountID: item.accountID)
                items = items.map { current in
                    guard current.id == item.id else { return current }
                    var done = current
                    done.active = false
                    done.unsubscribedAt = WeldDate.timestampString(Date())
                    return done
                }
                Unsubscribing.announce(result, sender: item.senderLabel, notifier: notifier)
            } catch {
                notifier.show(MailStrings.unsubscribeFailed(sender: item.senderLabel))
            }
            busy = false
        }
    }
}

private struct SubscriptionRow: View {
    let item: MailSubscription
    let onUnsubscribe: () -> Void

    var body: some View {
        HStack(spacing: Tokens.Spacing.m) {
            MailAvatar(name: item.senderLabel, size: 36)
            VStack(alignment: .leading, spacing: 2) {
                Text(item.senderLabel).fontWeight(.semibold).lineLimit(1)
                if let subject = item.lastSubject { Text(subject).font(.inter(.footnote)).lineLimit(1) }
                Text("\(MailStrings.subscriptionsEmails(item.messageCount)) · \(MailStrings.subscriptionsLast(date: rowTime(item.lastReceivedAt)))")
                    .font(.inter(.caption))
                    .foregroundStyle(.secondary)
            }
            Spacer()
            if !item.active {
                Text(MailLogic.stillSending(item) ? MailStrings.unsubscribeStillSending : MailStrings.unsubscribeUnsubscribed)
                    .font(.inter(.caption))
                    .foregroundStyle(.secondary)
            } else if MailLogic.canUnsubscribe(item) {
                Button(MailStrings.unsubscribeButton, action: onUnsubscribe)
                    .buttonStyle(.bordered)
                    .accessibilityLabel(MailStrings.unsubscribeAccessibility(sender: item.senderLabel))
                    .accessibilityIdentifier("unsubscribe-\(item.senderEmail)")
            }
        }
        .padding(.vertical, Tokens.Spacing.xs)
        .accessibilityIdentifier("subscription-row")
    }
}
