import SwiftUI
import WeldCore
import WeldUI

/// The generator's choices, as the platform's (`GeneratePasswordOptions`).
struct GeneratorOptions: Equatable {
    var length = 20
    var uppercase = true
    var digits = true
    var symbols = true

    func generate() -> String {
        PassForms.generatePassword(length: length, uppercase: uppercase, digits: digits, symbols: symbols)
    }
}

/// The password generator tab, on the system's secure random generator,
/// laid out as the platform's generator panel. Nothing here is stored or
/// sent; a copy is cleared from the clipboard after 30 s, and the password on
/// screen is replaced when the app goes to the background.
struct GeneratorView: View {
    @Environment(ToastCenter.self) private var toast
    @Environment(\.scenePhase) private var scenePhase
    @State private var options = GeneratorOptions()
    @State private var password = ""

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Tokens.Spacing.l) {
                GeneratorBox {
                    GeneratedPassword(password: password, size: 16) { password = options.generate() }
                    StrengthMeter(password: password)
                    GeneratorControls(options: $options)
                }
                Button {
                    PassClipboard.copySecret(password)
                    toast.show(PassStrings.itemCopiedSecret(field: PassStrings.itemPassword))
                } label: {
                    Text(PassStrings.generatorCopy).frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .accessibilityIdentifier("copy-generated")
                Text(PassStrings.generatorHint)
                    .font(.inter(.footnote))
                    .foregroundStyle(Tokens.Palette.mutedForeground)
            }
            .padding(Tokens.Spacing.l)
        }
        .background(Tokens.Palette.background)
        .onAppear { if password.isEmpty { password = options.generate() } }
        .onChange(of: options) { _, next in password = next.generate() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .background { password = options.generate() }
        }
    }
}

/// The generator inside the item form, as the platform's: a fresh password
/// with every change, then Cancel or "Use this password".
struct GeneratorPanel: View {
    let onUse: (String) -> Void
    let onCancel: () -> Void

    @State private var options = GeneratorOptions()
    @State private var generated = GeneratorOptions().generate()

    var body: some View {
        GeneratorBox {
            GeneratedPassword(password: generated, size: 13) { generated = options.generate() }
            StrengthMeter(password: generated)
            GeneratorControls(options: $options)
            HStack(spacing: Tokens.Spacing.s) {
                Spacer()
                Button(PassStrings.commonCancel, action: onCancel)
                    .buttonStyle(.borderless)
                    .foregroundStyle(Tokens.Palette.foreground)
                Button(PassStrings.generatorUse) { onUse(generated) }
                    .buttonStyle(.borderedProminent)
                    .accessibilityIdentifier("use-generated")
            }
            .font(.inter(.subheadline, weight: .medium))
        }
        .onChange(of: options) { _, next in generated = next.generate() }
    }
}

/// The generator's panel: `rounded-md border bg-muted/30 p-3`.
private struct GeneratorBox<Content: View>: View {
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Spacing.m) {
            content()
        }
        .padding(Tokens.Spacing.m)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Tokens.Palette.muted.opacity(0.3), in: RoundedRectangle(cornerRadius: Tokens.Radius.medium))
        .overlay(RoundedRectangle(cornerRadius: Tokens.Radius.medium).stroke(Tokens.Palette.border, lineWidth: 1))
    }
}

/// The password in monospace on the background, with "Generate another" beside it.
private struct GeneratedPassword: View {
    let password: String
    let size: CGFloat
    let regenerate: () -> Void

    var body: some View {
        HStack(spacing: Tokens.Spacing.s) {
            Text(password)
                .font(.system(size: size, design: .monospaced))
                .foregroundStyle(Tokens.Palette.foreground)
                .textSelection(.disabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, Tokens.Spacing.s)
                .padding(.vertical, 6)
                .background(Tokens.Palette.background, in: RoundedRectangle(cornerRadius: Tokens.Radius.small))
                .accessibilityIdentifier("generated-password")
            FieldIconButton(systemImage: "arrow.clockwise", label: PassStrings.generatorRegenerate, action: regenerate)
                .accessibilityIdentifier("regenerate")
        }
    }
}

/// "Length: 20" over a slider, and the three kinds of character as checkboxes.
private struct GeneratorControls: View {
    @Binding var options: GeneratorOptions

    private static let range = 8...64

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Spacing.xs) {
            Text(PassStrings.generatorLength(count: options.length))
                .font(.inter(.caption, weight: .medium))
                .foregroundStyle(Tokens.Palette.foreground)
            Slider(
                value: Binding(
                    get: { Double(options.length) },
                    set: { options.length = min(Self.range.upperBound, max(Self.range.lowerBound, Int($0.rounded()))) }
                ),
                in: Double(Self.range.lowerBound)...Double(Self.range.upperBound),
                step: 1
            )
            .accessibilityIdentifier("generator-length")
        }
        HStack(spacing: Tokens.Spacing.l) {
            Checkbox(label: PassStrings.generatorUppercase, isOn: $options.uppercase)
            Checkbox(label: PassStrings.generatorDigits, isOn: $options.digits)
            Checkbox(label: PassStrings.generatorSymbols, isOn: $options.symbols)
        }
    }
}

/// The platform's checkbox: a small rounded square, filled with the primary colour when on.
private struct Checkbox: View {
    let label: String
    @Binding var isOn: Bool

    var body: some View {
        Button {
            isOn.toggle()
        } label: {
            HStack(spacing: Tokens.Spacing.s) {
                Image(systemName: isOn ? "checkmark.square.fill" : "square")
                    .font(.system(size: 17))
                    .foregroundStyle(isOn ? Tokens.Palette.primary : Tokens.Palette.mutedForeground)
                Text(label)
                    .font(.inter(.footnote))
                    .foregroundStyle(Tokens.Palette.foreground)
            }
            .frame(minHeight: 40)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(isOn ? .isSelected : [])
    }
}

/// How strong a password is, as the platform's meter: three bars filled red,
/// amber or green, and the word beside them.
struct StrengthMeter: View {
    let password: String

    var body: some View {
        if !password.isEmpty {
            let (filled, bar, text, label): (Int, Color, Color, String) = switch PassForms.strength(password) {
            case .weak: (1, PassColors.weakBar, PassColors.weakText, PassStrings.strengthWeak)
            case .fair: (2, PassColors.fairBar, PassColors.fairText, PassStrings.strengthFair)
            case .strong: (3, PassColors.strongBar, PassColors.strongText, PassStrings.strengthStrong)
            }
            HStack(spacing: Tokens.Spacing.s) {
                HStack(spacing: Tokens.Spacing.xs) {
                    ForEach(0..<3, id: \.self) { index in
                        Capsule()
                            .fill(index < filled ? bar : Tokens.Palette.muted)
                            .frame(height: 4)
                    }
                }
                Text(label)
                    .font(.inter(.caption, weight: .medium))
                    .foregroundStyle(text)
            }
            .accessibilityElement(children: .combine)
        }
    }
}

/// Weak, reused and old passwords in the vaults the person can open, as the
/// platform's health page: one group per issue, worst first, each login
/// under its worst one. The server works it out without sending a password.
struct HealthView: View {
    let store: PassStore

    @State private var report: PassHealthReport?
    @State private var problem: String?
    @State private var attempt = 0

    var body: some View {
        Group {
            if let problem {
                EmptyMessage(
                    systemImage: "exclamationmark.triangle",
                    title: problem,
                    action: (label: PassStrings.commonTryAgain, id: "retry", run: { attempt += 1 })
                )
            } else if let report {
                content(report)
            } else {
                ProgressView()
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Tokens.Palette.background)
        .navigationTitle(PassStrings.healthTitle)
        .task(id: attempt) {
            problem = nil
            do {
                report = try await store.health()
            } catch {
                problem = passErrorMessage(error as? APIError)
            }
        }
    }

    @ViewBuilder private func content(_ report: PassHealthReport) -> some View {
        if report.entries.isEmpty {
            // Nothing checked yet reads differently from everything checked and fine.
            ScrollView {
                EmptyMessage(
                    systemImage: "checkmark.shield",
                    title: PassStrings.healthAttentionTitle,
                    description: report.checked > 0 ? PassStrings.healthAllHealthy : PassStrings.healthEmptyDescription
                )
            }
        } else {
            List {
                ForEach(PassLogic.groupByWorstIssue(report.entries)) { group in
                    Section {
                        ForEach(group.entries) { entry in
                            NavigationLink(value: ItemRoute(vaultID: entry.item.vaultID, itemID: entry.item.id)) {
                                HealthRow(entry: entry)
                            }
                            .platformRow()
                        }
                    } header: {
                        GroupHeader(label: issueTitle(group.issue), count: group.entries.count)
                    }
                }
                Text(PassStrings.healthFixHint)
                    .font(.inter(.footnote))
                    .foregroundStyle(Tokens.Palette.mutedForeground)
                    .plainListRow()
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
        }
    }

    private func issueTitle(_ issue: PassHealthEntry.Issue) -> String {
        switch issue {
        case .weak: PassStrings.healthWeak
        case .reused: PassStrings.healthReused
        case .old: PassStrings.healthOld
        }
    }
}

/// A login with its site and its issues as badges: weak in red, reused in amber, old neutral.
private struct HealthRow: View {
    let entry: PassHealthEntry

    var body: some View {
        HStack(spacing: Tokens.Spacing.m) {
            TypeIcon(kind: .login)
            VStack(alignment: .leading, spacing: Tokens.Spacing.xs) {
                Text(entry.item.title)
                    .font(.inter(.subheadline, weight: .medium))
                    .foregroundStyle(Tokens.Palette.foreground)
                    .lineLimit(1)
                if let host = entry.item.host, !host.isEmpty {
                    Text(host)
                        .font(.inter(.footnote))
                        .foregroundStyle(Tokens.Palette.mutedForeground)
                        .lineLimit(1)
                }
                HStack(spacing: 6) {
                    ForEach(PassLogic.issueOrder.filter { entry.issues.contains($0) }, id: \.self) { issue in
                        switch issue {
                        case .weak: StatusBadge(PassStrings.healthWeak, color: Tokens.Status.danger)
                        case .reused: StatusBadge(PassStrings.healthReusedOn(entry.reuseCount), color: Tokens.Status.warning)
                        case .old: NeutralBadge(PassStrings.healthOld)
                        }
                    }
                }
            }
        }
        .padding(.vertical, 2)
    }
}
