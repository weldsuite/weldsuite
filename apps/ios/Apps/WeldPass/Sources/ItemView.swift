import SwiftUI
import UIKit
import UniformTypeIdentifiers
import WeldCore
import WeldUI

/// The secret fields of an item, by name.
private enum Secret: CaseIterable {
    case password, notes, content, cardholder, number, expiry, cvc

    func value(in fields: PassFields) -> String? {
        switch self {
        case .password: fields.password
        case .notes: fields.notes
        case .content: fields.content
        case .cardholder: fields.cardholder
        case .number: fields.number
        case .expiry: fields.expiry
        case .cvc: fields.cvc
        }
    }
}

/// The clipboard for WeldPass. A copied secret stays on this phone (no
/// Universal Clipboard) and is cleared after 30 seconds; a username or a
/// website is copied plainly.
enum PassClipboard {
    static func copySecret(_ value: String) {
        UIPasteboard.general.setItems(
            [[UTType.plainText.identifier: value]],
            options: [.localOnly: true, .expirationDate: Date().addingTimeInterval(30)]
        )
    }

    static func copyPlain(_ value: String) {
        UIPasteboard.general.string = value
    }
}

/// One item. The list's metadata shows straight away; the secret fields stay
/// dots until the person reveals them, which asks for Face ID (or the
/// passcode) and is a request the server audits. Revealed fields live in this
/// screen's state only and are dropped when the app goes to the background.
struct ItemView: View {
    let env: AppEnvironment
    let store: PassStore
    let route: ItemRoute

    @Environment(ToastCenter.self) private var toast
    @Environment(\.scenePhase) private var scenePhase
    @State private var fields: PassFields?
    @State private var shown: Set<Secret> = []
    @State private var revealing = false

    var body: some View {
        let item = store.items.data?.first { $0.id == route.itemID }
        let vault = store.vaults.data?.first { $0.id == route.vaultID }
        Group {
            if let item {
                detail(item, vault: vault)
            } else if !store.items.loading {
                ContentUnavailableView(PassStrings.itemNotFound, systemImage: "questionmark.folder")
            }
        }
        .navigationTitle(item?.title ?? "")
        .navigationBarTitleDisplayMode(.inline)
        .onChange(of: scenePhase) { _, phase in
            // Back from the background: everything hidden again.
            if phase == .background {
                fields = nil
                shown = []
            }
        }
    }

    private func detail(_ item: PassItem, vault: PassVault?) -> some View {
        List {
            Section {
                HStack(spacing: 14) {
                    ItemIcon(kind: item.kind, size: 56)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(item.title).font(.title2.bold()).lineLimit(2)
                        Text([typeLabel(item.kind), vault.map(vaultLabel)].compactMap { $0 }.joined(separator: " · "))
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .listRowBackground(Color.clear)

            Section {
                switch item.kind {
                case .login:
                    FieldRow(
                        label: PassStrings.itemUsername,
                        value: item.subtitle,
                        onCopy: item.subtitle.flatMap { $0.isEmpty ? nil : $0 }.map { username in
                            { copyPlain(PassStrings.itemUsername, username) }
                        }
                    )
                    .accessibilityIdentifier("field-username")
                    secretRow(.password, label: PassStrings.itemPassword, copyable: true, id: "field-password")
                    if let url = item.url, !url.isEmpty {
                        FieldRow(
                            label: PassStrings.itemWebsite,
                            value: url,
                            onCopy: { copyPlain(PassStrings.itemWebsite, url) },
                            onOpen: PassLogic.safeHref(url).map { href in { UIApplication.shared.open(href) } }
                        )
                        .accessibilityIdentifier("field-website")
                    }
                    if item.hasTotp {
                        TotpRow(store: store, item: item) { code in
                            Task {
                                guard await env.lock.confirm(reason: PassStrings.lockCopyPrompt) else { return }
                                PassClipboard.copySecret(code)
                                toast.show(PassStrings.itemCopiedSecret(field: PassStrings.itemTotp))
                            }
                        }
                    }
                case .card:
                    secretRow(.cardholder, label: PassStrings.itemCardholder, copyable: false, id: "field-cardholder")
                    secretRow(.number, label: PassStrings.itemNumber, copyable: true, id: "field-number")
                    secretRow(.expiry, label: PassStrings.itemExpiry, copyable: false, id: "field-expiry")
                    secretRow(.cvc, label: PassStrings.itemCvc, copyable: true, id: "field-cvc")
                case .note:
                    secretRow(.content, label: PassStrings.itemContent, copyable: true, id: "field-content")
                }
            }

            if item.kind != .note {
                Section {
                    secretRow(.notes, label: PassStrings.itemNotes, copyable: false, id: "field-notes")
                    if let apps = fields?.apps, !apps.isEmpty {
                        FieldRow(label: PassStrings.itemApps, value: apps.joined(separator: "\n"))
                    }
                }
            }

            if fields == nil {
                Section {
                    Button(PassStrings.itemReveal) {
                        Task { if await ensureFields(PassStrings.lockRevealPrompt, item: item) != nil { shown = Set(Secret.allCases) } }
                    }
                    .disabled(revealing)
                    .accessibilityIdentifier("reveal-item")
                }
            }

            Section {
                Text(PassStrings.itemUpdated(date: formatDate(item.updatedAt)))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity)
            }
            .listRowBackground(Color.clear)
        }
    }

    private func secretRow(_ secret: Secret, label: String, copyable: Bool, id: String) -> some View {
        let isShown = shown.contains(secret)
        return FieldRow(
            label: label,
            value: isShown ? fields.flatMap { secret.value(in: $0) } : nil,
            secret: true,
            shown: isShown,
            monospace: secret == .password || secret == .number,
            onToggle: { toggle(secret) },
            onCopy: copyable ? { copySecret(label, secret) } : nil
        )
        .accessibilityIdentifier(id)
    }

    private var currentItem: PassItem? { store.items.data?.first { $0.id == route.itemID } }

    /// The item's fields, revealing them (after a confirmation) the first time.
    private func ensureFields(_ reason: String, item: PassItem) async -> PassFields? {
        if let fields { return fields }
        guard await env.lock.confirm(reason: reason) else { return nil }
        revealing = true
        defer { revealing = false }
        do {
            let revealed = try await store.reveal(vaultID: item.vaultID, itemID: item.id)
            fields = revealed
            return revealed
        } catch {
            toast.show(passErrorMessage(error as? APIError))
            return nil
        }
    }

    private func toggle(_ secret: Secret) {
        if shown.contains(secret) {
            shown.remove(secret)
            return
        }
        guard let item = currentItem else { return }
        Task { if await ensureFields(PassStrings.lockRevealPrompt, item: item) != nil { shown.insert(secret) } }
    }

    private func copySecret(_ label: String, _ secret: Secret) {
        guard let item = currentItem else { return }
        Task {
            guard await env.lock.confirm(reason: PassStrings.lockCopyPrompt),
                  let fields = await ensureFields(PassStrings.lockCopyPrompt, item: item),
                  let value = secret.value(in: fields), !value.isEmpty
            else { return }
            PassClipboard.copySecret(value)
            toast.show(PassStrings.itemCopiedSecret(field: label))
        }
    }

    private func copyPlain(_ label: String, _ value: String) {
        PassClipboard.copyPlain(value)
        toast.show(PassStrings.itemCopied(field: label))
    }

    private func formatDate(_ iso: String) -> String {
        guard let date = PassLogic.parseDate(iso) else { return iso }
        return date.formatted(date: .long, time: .omitted)
    }
}

/// A labelled value, with copy, open and (for a secret) show/hide. A hidden secret shows as dots.
private struct FieldRow: View {
    let label: String
    let value: String?
    var secret = false
    var shown = false
    var monospace = false
    var onToggle: (() -> Void)?
    var onCopy: (() -> Void)?
    var onOpen: (() -> Void)?

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(label).font(.caption).foregroundStyle(.secondary)
                Text(display)
                    .font(monospace && shown ? .body.monospaced() : .body)
                    .textSelection(.disabled)
            }
            Spacer()
            if secret, let onToggle {
                Button(action: onToggle) {
                    Image(systemName: shown ? "eye.slash" : "eye")
                }
                .accessibilityLabel(shown ? PassStrings.itemHide : PassStrings.itemShow)
            }
            if let onOpen {
                Button(action: onOpen) { Image(systemName: "arrow.up.right.square") }
                    .accessibilityLabel(PassStrings.itemOpenWebsite)
            }
            if let onCopy {
                Button(action: onCopy) { Image(systemName: "doc.on.doc") }
                    .accessibilityLabel(PassStrings.commonCopy)
            }
        }
        .buttonStyle(.borderless)
    }

    private var display: String {
        if secret && !shown { return "••••••••" }
        guard let value, !value.isEmpty else { return PassStrings.commonDash }
        return value
    }
}

/// The current 2FA code, minted by the server (PASS-007: the seed stays in
/// the vault), with its countdown. A new code is fetched when this one runs out.
private struct TotpRow: View {
    let store: PassStore
    let item: PassItem
    let onCopy: (String) -> Void

    @State private var code: PassTotp?
    @State private var offline = false

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            let left = code.map { PassLogic.secondsUntil($0.expiresAt, now: context.date) } ?? 0
            Button {
                if let code { onCopy(code.code) }
            } label: {
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(PassStrings.itemTotp).font(.caption).foregroundStyle(.secondary)
                        Text(code.map { PassLogic.formatTotpCode($0.code) } ?? PassStrings.commonDash)
                            .font(.system(size: 26, weight: .semibold).monospacedDigit())
                            .foregroundStyle(.primary)
                        if code != nil {
                            Text(PassStrings.itemTotpExpires(left)).font(.caption).foregroundStyle(.secondary)
                        } else if offline {
                            Text(PassStrings.itemTotpOffline).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    Spacer()
                    Image(systemName: "doc.on.doc").foregroundStyle(.secondary)
                }
            }
            .disabled(code == nil)
            .accessibilityIdentifier("field-totp")
        }
        .task(id: item.id) {
            while !Task.isCancelled {
                if code == nil || PassLogic.secondsUntil(code!.expiresAt) == 0 {
                    do {
                        code = try await store.totp(vaultID: item.vaultID, itemID: item.id)
                        offline = false
                    } catch {
                        offline = (error as? APIError)?.isNetwork == true
                        try? await Task.sleep(for: .seconds(5))
                    }
                }
                try? await Task.sleep(for: .seconds(1))
            }
        }
    }
}
