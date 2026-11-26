import SwiftUI
import WeldUI

/// The password generator, on the system's secure random generator. Nothing
/// here is stored or sent; a copy is cleared from the clipboard after 30 s.
struct GeneratorView: View {
    @Environment(ToastCenter.self) private var toast
    @State private var length = 20
    @State private var uppercase = true
    @State private var digits = true
    @State private var symbols = true
    @State private var password = ""

    var body: some View {
        Form {
            Section {
                Text(password)
                    .font(.title3.monospaced())
                    .textSelection(.disabled)
                    .accessibilityIdentifier("generated-password")
                StrengthMeter(password: password)
                HStack {
                    Button(PassStrings.generatorCopy) {
                        PassClipboard.copySecret(password)
                        toast.show(PassStrings.itemCopiedSecret(field: PassStrings.itemPassword))
                    }
                    .buttonStyle(.borderedProminent)
                    .accessibilityIdentifier("copy-generated")
                    Spacer()
                    Button {
                        regenerate()
                    } label: {
                        Label(PassStrings.generatorRegenerate, systemImage: "arrow.clockwise")
                    }
                    .buttonStyle(.bordered)
                }
            }
            Section {
                Stepper(value: $length, in: 8...64) {
                    LabeledContent(PassStrings.generatorLength, value: "\(length)")
                }
                Toggle(PassStrings.generatorUppercase, isOn: $uppercase)
                Toggle(PassStrings.generatorDigits, isOn: $digits)
                Toggle(PassStrings.generatorSymbols, isOn: $symbols)
            } footer: {
                Text(PassStrings.generatorHint)
            }
        }
        .onAppear { if password.isEmpty { regenerate() } }
        .onChange(of: length) { regenerate() }
        .onChange(of: uppercase) { regenerate() }
        .onChange(of: digits) { regenerate() }
        .onChange(of: symbols) { regenerate() }
    }

    private func regenerate() {
        password = PassForms.generatePassword(length: length, uppercase: uppercase, digits: digits, symbols: symbols)
    }
}

/// Weak, reused and old passwords in the vaults the person can open. The
/// server works it out without sending a password; this lists what needs
/// fixing, worst first.
struct HealthView: View {
    let store: PassStore

    @State private var report: PassHealthReport?
    @State private var problem: String?

    var body: some View {
        Group {
            if let problem {
                ContentUnavailableView(problem, systemImage: "exclamationmark.triangle")
            } else if let report {
                content(report)
            } else {
                ProgressView()
            }
        }
        .navigationTitle(PassStrings.healthTitle)
        .task {
            do {
                report = try await store.health()
            } catch {
                problem = passErrorMessage(error as? APIError)
            }
        }
    }

    @ViewBuilder private func content(_ report: PassHealthReport) -> some View {
        if report.checked == 0 {
            ContentUnavailableView(PassStrings.healthNothingChecked, systemImage: "key")
        } else {
            List {
                Section {
                    Text(PassStrings.healthSummary(healthy: report.healthy, checked: report.checked)).font(.headline)
                    LabeledContent(PassStrings.healthWeak, value: "\(report.weak)")
                    LabeledContent(PassStrings.healthReused, value: "\(report.reused)")
                    LabeledContent(PassStrings.healthOld, value: "\(report.old)")
                }
                if report.entries.isEmpty {
                    ContentUnavailableView(
                        PassStrings.healthAllGood,
                        systemImage: "checkmark.shield",
                        description: Text(PassStrings.healthAllGoodDescription)
                    )
                } else {
                    Section {
                        ForEach(report.entries) { entry in
                            NavigationLink(value: ItemRoute(vaultID: entry.item.vaultID, itemID: entry.item.id)) {
                                HStack(spacing: Tokens.Spacing.m) {
                                    ItemIcon(kind: .login)
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(entry.item.title).lineLimit(1)
                                        Text(issueText(entry)).font(.subheadline).foregroundStyle(Tokens.Status.danger)
                                    }
                                }
                            }
                        }
                    } footer: {
                        Text(PassStrings.healthFixHint)
                    }
                }
            }
        }
    }

    private func issueText(_ entry: PassHealthEntry) -> String {
        entry.issues.map { issue -> String in
            switch issue {
            case .weak: PassStrings.healthWeak
            case .reused: PassStrings.healthReusedCount(entry.reuseCount - 1)
            case .old: PassStrings.healthOld
            }
        }
        .joined(separator: " · ")
    }
}
