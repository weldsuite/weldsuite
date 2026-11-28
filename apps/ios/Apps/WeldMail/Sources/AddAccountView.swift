import SwiftUI
import UIKit
import WeldCore
import WeldUI

/// A new mailbox: a free WeldMail address of the workspace, or an address on one of its own domains.
struct AddAccountView: View {
    let env: AppEnvironment
    let store: MailStore

    private enum Step {
        case choose, free, custom
    }

    @Environment(\.dismiss) private var dismiss
    @Environment(MailNotifier.self) private var notifier
    @State private var step = Step.choose
    @State private var domains: [String] = []
    @State private var freeDomain: String?
    @State private var address = ""
    @State private var displayName = ""
    @State private var domain: String?
    @State private var checking = false
    @State private var availability: AddAccountLogic.Check?
    @State private var submitting = false
    @State private var error: String?

    private var freeAddresses: Bool { env.isAvailable("mail-free-addresses") }
    private var customDomains: Bool { env.isAvailable("mail-domains") }

    var body: some View {
        Form {
            switch step {
            case .choose:
                chooser
            case .free, .custom:
                form
            }
        }
        .navigationTitle(MailStrings.addAccountTitle)
        .navigationBarTitleDisplayMode(.inline)
        .navigationBarBackButtonHidden(step != .choose)
        .toolbar {
            if step != .choose {
                ToolbarItem(placement: .topBarLeading) {
                    Button {
                        step = .choose
                        address = ""
                        displayName = ""
                        error = nil
                    } label: {
                        Image(systemName: "chevron.backward")
                    }
                    .accessibilityLabel(CoreStrings.commonClose)
                }
            }
        }
        .task {
            if customDomains {
                domains = (try? await store.repository.mailDomains()) ?? []
                domain = domains.first
            }
        }
        .task(id: step == .free) {
            if step == .free && freeDomain == nil { freeDomain = try? await store.repository.weldmailDomain() }
        }
        // The address is checked as it's typed, half a second after the last key.
        .task(id: "\(address)|\(step == .free)") {
            availability = nil
            guard step == .free, address.count >= 3 else {
                checking = false
                return
            }
            checking = true
            try? await Task.sleep(for: .milliseconds(500))
            guard !Task.isCancelled else { return }
            do {
                availability = AddAccountLogic.check(try await store.repository.checkAddress(address))
            } catch {
                availability = .unavailable(nil)
            }
            checking = false
        }
    }

    @ViewBuilder
    private var chooser: some View {
        if !freeAddresses && !(customDomains && !domains.isEmpty) {
            MailEmptyView(title: MailStrings.addAccountNothingToAdd, systemImage: "envelope")
        } else {
            Section {
                Text(MailStrings.addAccountIntro).font(.inter(.subheadline))
                if freeAddresses {
                    Button {
                        step = .free
                    } label: {
                        choiceLabel(MailStrings.addAccountFreeAddress, hint: MailStrings.addAccountFreeAddressHint, systemImage: "envelope")
                    }
                    .accessibilityIdentifier("add-free-address")
                }
                if customDomains && !domains.isEmpty {
                    Button {
                        step = .custom
                    } label: {
                        choiceLabel(MailStrings.addAccountCustomDomain, hint: MailStrings.addAccountCustomDomainHint, systemImage: "globe")
                    }
                    .accessibilityIdentifier("add-custom-domain")
                }
            } footer: {
                Text(MailStrings.addAccountFooter)
            }
        }
    }

    private func choiceLabel(_ title: String, hint: String, systemImage: String) -> some View {
        HStack(spacing: Tokens.Spacing.m) {
            Image(systemName: systemImage).foregroundStyle(Color.accentColor).frame(width: 28)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).foregroundStyle(.primary)
                Text(hint).font(.inter(.footnote)).foregroundStyle(.secondary)
            }
            Spacer()
            Image(systemName: "chevron.forward").foregroundStyle(.tertiary)
        }
    }

    @ViewBuilder
    private var form: some View {
        let suffix = (step == .free ? freeDomain : domain) ?? ""
        Section {
            Text("\(address.isEmpty ? MailStrings.addAccountAddressPlaceholder : address)@\(suffix)")
                .font(.inter(.headline))
                .accessibilityIdentifier("add-account-preview")
            HStack {
                TextField(MailStrings.addAccountAddressPlaceholder, text: Binding(get: { address }, set: { address = AddAccountLogic.cleanAddress($0) }))
                    .keyboardType(.emailAddress)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .accessibilityIdentifier("add-account-address")
                Text("@\(suffix)").foregroundStyle(.secondary)
            }
            if step == .free && !address.isEmpty {
                availabilityLine
            }
            if step == .custom {
                Picker(MailStrings.addAccountDomain, selection: Binding(get: { domain ?? "" }, set: { domain = $0 })) {
                    ForEach(domains, id: \.self) { Text($0).tag($0) }
                }
                .accessibilityIdentifier("add-account-domain")
            }
            TextField(MailStrings.addAccountDisplayNamePlaceholder, text: $displayName)
                .accessibilityIdentifier("add-account-name")
        } header: {
            Text(MailStrings.addAccountAddress)
        }
        if let error {
            Text(error).foregroundStyle(.red)
        }
        Section {
            Button {
                submit()
            } label: {
                HStack {
                    Spacer()
                    if submitting { ProgressView() } else { Text(MailStrings.addAccountCreate).bold() }
                    Spacer()
                }
            }
            .disabled(!ready || submitting)
            .accessibilityIdentifier("add-account-create")
        }
    }

    @ViewBuilder
    private var availabilityLine: some View {
        if address.count < 3 {
            Text(MailStrings.addAccountMinLength).font(.inter(.footnote))
        } else if checking {
            HStack {
                ProgressView()
                Text(MailStrings.addAccountChecking).font(.inter(.footnote))
            }
        } else if let availability {
            switch availability {
            case .available:
                Label(MailStrings.addAccountAvailable, systemImage: "checkmark.circle").font(.inter(.footnote)).foregroundStyle(Tokens.Status.success)
            case let .unavailable(reason):
                Label(unavailableText(reason), systemImage: "exclamationmark.circle").font(.inter(.footnote)).foregroundStyle(.red)
            }
        }
    }

    private func unavailableText(_ reason: String?) -> String {
        switch reason {
        case "reserved": return MailStrings.addAccountReserved
        case "taken": return MailStrings.addAccountTaken
        default: return MailStrings.addAccountNotAvailable
        }
    }

    private var ready: Bool {
        if step == .free { return availability == .available && address.count >= 3 }
        return !address.isEmpty && domain != nil
    }

    private func submit() {
        error = nil
        submitting = true
        Task {
            do {
                if step == .free {
                    let email = try await store.repository.reserveAddress(address, displayName: displayName)
                    notifier.show(MailStrings.addAccountCreated(email: email))
                } else if let chosen = domain {
                    let name = displayName.trimmingCharacters(in: .whitespaces).isEmpty ? address : displayName
                    let email = try await store.repository.createAccount(name: name, email: "\(address)@\(chosen)", displayName: name)
                    notifier.show(MailStrings.addAccountAccountCreated(email: email))
                }
                await store.loadAccounts()
                await store.loadLabels()
                dismiss()
            } catch {
                self.error = APIError.from(error).status == 403 ? CoreStrings.errorsForbidden : MailStrings.addAccountFailed
            }
            submitting = false
        }
    }
}
