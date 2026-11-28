import SwiftUI
import UIKit
import UniformTypeIdentifiers
import WeldCore
import WeldUI

/// What a hidden secret shows, as on the platform.
private let mask = "••••••••••••"

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

/// One item, laid out as the platform's item dialog. What the list carried
/// (title, username, site) shows straight away; the secret fields stay
/// masked until the person reveals them, which asks for Face ID (or the
/// passcode) and is a request the server audits. Revealed fields live in
/// this screen's state only: hiding them drops them, and so does the app
/// going to the background.
struct ItemView: View {
    let env: AppEnvironment
    let store: PassStore
    let route: ItemRoute
    let onEdit: () -> Void

    @Environment(ToastCenter.self) private var toast
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.dismiss) private var dismiss
    @State private var revealed: PassFields?
    @State private var revealing = false
    @State private var confirmDelete = false
    @State private var deleting = false

    var body: some View {
        let item = store.items.data?.first { $0.id == route.itemID }
        let vault = store.vaults.data?.first { $0.id == route.vaultID }
        Group {
            if let item {
                detail(item, vault: vault)
            } else if !store.items.loading, !deleting {
                EmptyMessage(systemImage: "exclamationmark.triangle", title: PassStrings.itemNotFound)
            }
        }
        .background(Tokens.Palette.background)
        .navigationTitle(item?.title ?? "")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if item != nil, PassLogic.canEdit(vault) {
                ToolbarItem(placement: .primaryAction) {
                    Button(PassStrings.commonEdit, action: onEdit)
                        .accessibilityIdentifier("edit-item")
                }
            }
        }
        .confirmationDialog(
            PassStrings.itemDeleteTitle(title: item?.title ?? ""),
            isPresented: $confirmDelete,
            titleVisibility: .visible
        ) {
            Button(PassStrings.commonDelete, role: .destructive) { delete() }
                .accessibilityIdentifier("confirm-delete")
            Button(PassStrings.commonCancel, role: .cancel) {}
        } message: {
            Text(PassStrings.itemDeleteMessage)
        }
        .onChange(of: scenePhase) { _, phase in
            // Back from the background: everything hidden again.
            if phase == .background { revealed = nil }
        }
        .preventsScreenCapture()
    }

    private func delete() {
        deleting = true
        Task {
            do {
                try await store.delete(vaultID: route.vaultID, itemID: route.itemID)
                toast.show(PassStrings.itemDeleted)
                dismiss()
            } catch {
                deleting = false
                toast.show(passErrorMessage(error as? APIError))
            }
        }
    }

    private func detail(_ item: PassItem, vault: PassVault?) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Tokens.Spacing.l) {
                switch item.kind {
                case .login: loginFields(item)
                case .note: noteField(item)
                case .card: cardFields(item)
                }
                meta(item, vault: vault)
                if PassLogic.canEdit(vault) {
                    Button(role: .destructive) {
                        confirmDelete = true
                    } label: {
                        Text(PassStrings.commonDelete)
                            .font(.inter(.subheadline, weight: .medium))
                            .foregroundStyle(Tokens.Status.danger)
                    }
                    .buttonStyle(.borderless)
                    .disabled(deleting)
                    .accessibilityIdentifier("delete-item")
                }
            }
            .padding(Tokens.Spacing.l)
            .padding(.bottom, 32)
        }
    }

    // MARK: - Fields per type

    @ViewBuilder private func loginFields(_ item: PassItem) -> some View {
        let username = item.subtitle ?? ""
        ReadOnlyField(label: PassStrings.itemUsername, value: username) {
            if !username.isEmpty {
                // The username is on the list already: no reveal needed.
                CopyIconButton(label: PassStrings.itemCopyUsername) {
                    PassClipboard.copyPlain(username)
                    toast.show(PassStrings.itemCopied(field: PassStrings.itemUsername))
                    return true
                }
                .accessibilityIdentifier("field-username-copy")
            }
        }
        .accessibilityIdentifier("field-username")

        ReadOnlyField(label: PassStrings.itemPassword, value: revealed?.password ?? mask, monospaced: true) {
            revealButton(item, id: "field-password-toggle")
            CopyIconButton(label: PassStrings.itemCopyPassword) {
                await copySecret(item, label: PassStrings.itemPassword) { $0.password }
            }
            .accessibilityIdentifier("field-password-copy")
        }
        .accessibilityIdentifier("field-password")

        if let href = PassLogic.safeHref(item.url) {
            ReadOnlyField(label: PassStrings.itemWebsite, value: item.url ?? "") {
                FieldIconButton(systemImage: "arrow.up.right.square", label: PassStrings.itemOpenWebsite) {
                    UIApplication.shared.open(href)
                }
            }
            .accessibilityIdentifier("field-website")
        }

        if item.hasTotp {
            LabeledField(label: PassStrings.itemTotp) {
                TotpField(store: store, item: item) { code in
                    guard await env.lock.confirm(reason: PassStrings.lockCopyPrompt) else { return false }
                    PassClipboard.copySecret(code)
                    toast.show(PassStrings.itemCopiedSecret(field: PassStrings.itemTotp))
                    return true
                }
            }
            .accessibilityIdentifier("field-totp")
        }

        notesAndApps
    }

    private func noteField(_ item: PassItem) -> some View {
        ReadOnlyField(
            label: PassStrings.itemContent,
            value: revealed?.content ?? mask,
            monospaced: revealed == nil,
            multiline: revealed != nil
        ) {
            revealButton(item, id: "field-content-toggle")
            CopyIconButton(label: PassStrings.commonCopy) {
                await copySecret(item, label: PassStrings.itemContent) { $0.content }
            }
            .accessibilityIdentifier("field-content-copy")
        }
        .accessibilityIdentifier("field-content")
    }

    @ViewBuilder private func cardFields(_ item: PassItem) -> some View {
        let listed = item.subtitle.flatMap { $0.isEmpty ? nil : $0 }
        ReadOnlyField(label: PassStrings.itemNumber, value: revealed?.number ?? listed ?? mask, monospaced: true) {
            revealButton(item, id: "field-number-toggle")
            CopyIconButton(label: PassStrings.itemCopyNumber) {
                await copySecret(item, label: PassStrings.itemNumber) { $0.number }
            }
            .accessibilityIdentifier("field-number-copy")
        }
        .accessibilityIdentifier("field-number")

        ReadOnlyField(label: PassStrings.itemCardholder, value: revealed?.cardholder ?? mask, monospaced: revealed == nil)
            .accessibilityIdentifier("field-cardholder")

        HStack(alignment: .top, spacing: Tokens.Spacing.l) {
            ReadOnlyField(label: PassStrings.itemExpiry, value: revealed?.expiry ?? mask, monospaced: true)
                .accessibilityIdentifier("field-expiry")
            ReadOnlyField(label: PassStrings.itemCvc, value: revealed?.cvc ?? mask, monospaced: true) {
                CopyIconButton(label: PassStrings.itemCopyCvc) {
                    await copySecret(item, label: PassStrings.itemCvc) { $0.cvc }
                }
                .accessibilityIdentifier("field-cvc-copy")
            }
            .accessibilityIdentifier("field-cvc")
        }

        notesAndApps
    }

    /// A revealed item's notes, and a login's Android apps, when there are any.
    @ViewBuilder private var notesAndApps: some View {
        if let notes = revealed?.notes, !notes.isEmpty {
            ReadOnlyField(label: PassStrings.itemNotes, value: notes, multiline: true)
                .accessibilityIdentifier("field-notes")
        }
        if let apps = revealed?.apps, !apps.isEmpty {
            ReadOnlyField(label: PassStrings.itemApps, value: apps.joined(separator: "\n"), multiline: true)
        }
    }

    /// The platform's footer line: type, vault, when it changed and its version, and the audit note.
    private func meta(_ item: PassItem, vault: PassVault?) -> some View {
        let changed = PassStrings.itemUpdatedMeta(time: formatAgo(item.updatedAt), version: "\(item.version)")
        let line = [vault.map(vaultLabel), changed].compactMap { $0 }.joined(separator: " · ")
        return VStack(alignment: .leading, spacing: Tokens.Spacing.xs) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                NeutralBadge(typeLabel(item.kind))
                Text(line)
            }
            Text(PassStrings.itemAuditNote)
        }
        .font(.inter(.caption))
        .foregroundStyle(Tokens.Palette.mutedForeground)
    }

    private func revealButton(_ item: PassItem, id: String) -> some View {
        FieldIconButton(
            systemImage: revealed == nil ? "eye" : "eye.slash",
            label: revealed == nil ? PassStrings.itemShow : PassStrings.itemHide
        ) {
            toggleReveal(item)
        }
        .disabled(revealing)
        .accessibilityIdentifier(id)
    }

    // MARK: - Secrets

    /// Reveal every field (after a confirmation), or hide them again and drop them.
    private func toggleReveal(_ item: PassItem) {
        if revealed != nil {
            revealed = nil
            return
        }
        Task {
            guard await env.lock.confirm(reason: PassStrings.lockRevealPrompt) else { return }
            revealing = true
            defer { revealing = false }
            do {
                revealed = try await store.reveal(vaultID: item.vaultID, itemID: item.id)
            } catch {
                toast.show(passErrorMessage(error as? APIError))
            }
        }
    }

    /// Copies a secret. Read from the revealed fields when they're on
    /// screen; otherwise fetched, copied and dropped, so the field stays masked.
    private func copySecret(_ item: PassItem, label: String, pick: (PassFields) -> String?) async -> Bool {
        guard await env.lock.confirm(reason: PassStrings.lockCopyPrompt) else { return false }
        let source: PassFields
        if let revealed {
            source = revealed
        } else {
            do {
                source = try await store.reveal(vaultID: item.vaultID, itemID: item.id)
            } catch {
                toast.show(passErrorMessage(error as? APIError))
                return false
            }
        }
        guard let value = pick(source), !value.isEmpty else { return false }
        PassClipboard.copySecret(value)
        store.recordCopy(vaultID: item.vaultID, itemID: item.id)
        toast.show(PassStrings.itemCopiedSecret(field: label))
        return true
    }
}

/// The current 2FA code, minted by the server (PASS-007: the seed stays in
/// the vault) and fetched only when asked for, as on the platform: every
/// fetch is written to the vault's trail, so there's no polling. The code
/// shows with a countdown, then hides; it's dropped when the app goes to the
/// background.
private struct TotpField: View {
    let store: PassStore
    let item: PassItem
    let onCopy: (String) async -> Bool

    @Environment(\.scenePhase) private var scenePhase
    @State private var code: PassTotp?
    @State private var now = Date()
    @State private var loading = false
    @State private var failure: String?

    var body: some View {
        let left = code.map { PassLogic.secondsUntil($0.expiresAt, now: now) } ?? 0
        Group {
            if let code, left > 0 {
                HStack(spacing: Tokens.Spacing.s) {
                    Text(PassLogic.formatTotpCode(code.code))
                        .font(.system(size: 18, weight: .semibold, design: .monospaced))
                        .tracking(2)
                        .foregroundStyle(Tokens.Palette.foreground)
                    Text(PassStrings.itemTotpExpires(left))
                        .font(.inter(.caption))
                        .foregroundStyle(Tokens.Palette.mutedForeground)
                    countdown(left: left, period: code.period)
                    CopyIconButton(label: PassStrings.itemCopyCode) { await onCopy(code.code) }
                        .accessibilityIdentifier("field-totp-copy")
                }
            } else {
                HStack(spacing: Tokens.Spacing.s) {
                    Button(action: show) {
                        HStack(spacing: 6) {
                            if loading {
                                ProgressView().controlSize(.mini)
                            } else {
                                Image(systemName: "checkmark.shield").font(.system(size: 13))
                            }
                            Text(PassStrings.itemShowCode)
                        }
                    }
                    .buttonStyle(.platformOutline)
                    .disabled(loading)
                    .accessibilityIdentifier("show-totp")
                    if code != nil {
                        Text(PassStrings.itemTotpExpired).font(.inter(.caption)).foregroundStyle(Tokens.Palette.mutedForeground)
                    }
                    if let failure {
                        Text(failure).font(.inter(.caption)).foregroundStyle(Tokens.Status.danger)
                    }
                }
            }
        }
        .task(id: code?.expiresAt) {
            // Ticks while a code is on screen, then stops.
            guard let shown = code else { return }
            while !Task.isCancelled, PassLogic.secondsUntil(shown.expiresAt) > 0 {
                try? await Task.sleep(for: .milliseconds(500))
                now = Date()
            }
            now = Date()
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .background { code = nil }
        }
    }

    /// The countdown bar: how much of the code's period is left.
    private func countdown(left: Int, period: Int) -> some View {
        let fraction = min(1, max(0, Double(left) / Double(max(period, 1))))
        return Capsule()
            .fill(Tokens.Palette.muted)
            .frame(width: 64, height: 4)
            .overlay(alignment: .leading) {
                Capsule().fill(Tokens.Palette.primary).frame(width: 64 * fraction, height: 4)
            }
            .accessibilityHidden(true)
    }

    private func show() {
        Task {
            failure = nil
            loading = true
            defer { loading = false }
            do {
                code = try await store.totp(vaultID: item.vaultID, itemID: item.id)
                now = Date()
            } catch {
                code = nil
                failure = (error as? APIError)?.isNetwork == true ? PassStrings.itemTotpOffline : PassStrings.itemTotpFailed
            }
        }
    }
}
