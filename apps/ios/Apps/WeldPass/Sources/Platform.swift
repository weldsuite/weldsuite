import SwiftUI
import UIKit
import WeldUI

// The web platform's building blocks that WeldPass needs and WeldUI doesn't
// have yet: the list's group header, the empty state, labelled inputs and
// read-only fields, and the copy button. Candidates for WeldUI.

/// Tailwind colours the platform's WeldPass code uses by name.
enum PassColors {
    /// `text-emerald-500`: the copy button's check.
    static let copied = rgb(0x10B981)

    /// `bg-red-500`, `bg-amber-500`, `bg-emerald-500`: the strength meter's bars.
    static let weakBar = rgb(0xEF4444)
    static let fairBar = rgb(0xF59E0B)
    static let strongBar = rgb(0x10B981)

    /// `text-red-600 dark:text-red-400` and the amber and emerald pairs: the strength word.
    static let weakText = dynamic(light: 0xDC2626, dark: 0xF87171)
    static let fairText = dynamic(light: 0xD97706, dark: 0xFBBF24)
    static let strongText = dynamic(light: 0x059669, dark: 0x34D399)

    /// An input's background: none, or a wash of the input colour when dark (`dark:bg-input/30`).
    static let inputBackground = Color(uiColor: UIColor { traits in
        guard traits.userInterfaceStyle == .dark else { return .clear }
        return UIColor(Tokens.Palette.input).resolvedColor(with: traits).withAlphaComponent(0.3)
    })

    static func rgb(_ value: UInt32) -> Color {
        Color(uiColor: uiColor(value))
    }

    static func dynamic(light: UInt32, dark: UInt32) -> Color {
        Color(uiColor: UIColor { traits in uiColor(traits.userInterfaceStyle == .dark ? dark : light) })
    }

    private static func uiColor(_ value: UInt32) -> UIColor {
        UIColor(
            red: CGFloat((value >> 16) & 0xFF) / 255,
            green: CGFloat((value >> 8) & 0xFF) / 255,
            blue: CGFloat(value & 0xFF) / 255,
            alpha: 1
        )
    }
}

extension View {
    /// A list row as the platform draws one: on the background, with a
    /// full-width hairline in the border colour.
    func platformRow() -> some View {
        listRowBackground(Tokens.Palette.background)
            .listRowSeparatorTint(Tokens.Palette.border)
            .alignmentGuide(.listRowSeparatorLeading) { _ in 0 }
    }

    /// A row that holds a message or a control, not an item: no separator, no inset background.
    func plainListRow() -> some View {
        listRowBackground(Tokens.Palette.background)
            .listRowSeparator(.hidden)
    }
}

/// A group's header in a list, as `EntityList` draws it: a small muted label
/// and its count in a bordered chip, on a muted band.
struct GroupHeader: View {
    let label: String
    let count: Int

    var body: some View {
        HStack(spacing: Tokens.Spacing.s) {
            Text(label)
                .font(.inter(.caption, weight: .medium))
                .foregroundStyle(Tokens.Palette.mutedForeground)
                .lineLimit(1)
            Text("\(count)")
                .font(.system(size: 10, design: .monospaced))
                .foregroundStyle(Tokens.Palette.mutedForeground)
                .padding(.horizontal, 4)
                .frame(minWidth: 16, minHeight: 16)
                .background(Tokens.Palette.muted, in: RoundedRectangle(cornerRadius: 5))
                .overlay(RoundedRectangle(cornerRadius: 5).stroke(Tokens.Palette.border, lineWidth: 1))
            Spacer(minLength: 0)
        }
        .padding(.horizontal, Tokens.Spacing.l)
        .frame(height: 32)
        .background(Tokens.Palette.muted.opacity(0.5))
        .background(Tokens.Palette.background)
        .overlay(alignment: .bottom) {
            Rectangle().fill(Tokens.Palette.border).frame(height: 0.5)
        }
        .listRowInsets(EdgeInsets())
        .textCase(nil)
        .accessibilityElement(children: .combine)
    }
}

/// What a list shows when it has nothing: the icon in a muted rounded square,
/// a semibold title, a muted description and, maybe, the main action.
struct EmptyMessage: View {
    let systemImage: String
    let title: String
    var description: String?
    var action: (label: String, id: String, run: () -> Void)?

    var body: some View {
        VStack(spacing: 0) {
            Image(systemName: systemImage)
                .font(.system(size: 22))
                .foregroundStyle(Tokens.Palette.mutedForeground)
                .frame(width: 48, height: 48)
                .background(Tokens.Palette.muted, in: RoundedRectangle(cornerRadius: Tokens.Radius.large))
            Text(title)
                .font(.inter(size: 15, weight: .semibold))
                .foregroundStyle(Tokens.Palette.foreground)
                .multilineTextAlignment(.center)
                .padding(.top, Tokens.Spacing.l)
            if let description {
                Text(description)
                    .font(.inter(.subheadline))
                    .foregroundStyle(Tokens.Palette.mutedForeground)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 320)
                    .padding(.top, 6)
            }
            if let action {
                Button(action.label, action: action.run)
                    .buttonStyle(.borderedProminent)
                    .padding(.top, Tokens.Spacing.l)
                    .accessibilityIdentifier(action.id)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, Tokens.Spacing.xl)
        .padding(.vertical, 48)
    }
}

/// A neutral badge: the platform's `secondary` variant.
struct NeutralBadge: View {
    let text: String

    init(_ text: String) {
        self.text = text
    }

    var body: some View {
        StatusBadge(text, color: Tokens.Palette.mutedForeground)
    }
}

/// A label, the control under it, and a hint or error under that, as the
/// platform's forms stack them (`FormLabel`, `FormDescription`, `FormMessage`).
struct LabeledField<Content: View>: View {
    let label: String
    var hint: String?
    var error: String?
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Spacing.s) {
            Text(label)
                .font(.inter(.subheadline, weight: .medium))
                .foregroundStyle(Tokens.Palette.foreground)
            content()
            if let error {
                Text(error).font(.inter(.footnote)).foregroundStyle(Tokens.Status.danger)
            } else if let hint {
                Text(hint).font(.inter(.footnote)).foregroundStyle(Tokens.Palette.mutedForeground)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// The box every input and read-only value sits in: `rounded-md`, `border-input`.
struct InputBox: ViewModifier {
    var border: Color = Tokens.Palette.input
    var trailingInset: CGFloat = Tokens.Spacing.m

    func body(content: Content) -> some View {
        content
            .padding(.leading, Tokens.Spacing.m)
            .padding(.trailing, trailingInset)
            .frame(minHeight: 40)
            .background(PassColors.inputBackground, in: RoundedRectangle(cornerRadius: Tokens.Radius.medium))
            .overlay(RoundedRectangle(cornerRadius: Tokens.Radius.medium).stroke(border, lineWidth: 1))
    }
}

/// The font a field's value uses: Inter, or monospaced for a password, a
/// card number and other values read character by character.
func fieldFont(monospaced: Bool) -> Font {
    monospaced ? .system(.subheadline, design: .monospaced) : .inter(.subheadline)
}

/// The platform's `Input` and `Textarea`: a bordered `rounded-md` box, the
/// ring colour around it while focused and the danger colour on an error.
struct PlatformTextField<Trailing: View>: View {
    @Binding var text: String
    var placeholder = ""
    var secure = false
    var monospaced = false
    /// More than one line: grows from this many.
    var lines = 1
    var isError = false
    @ViewBuilder var trailing: () -> Trailing

    @FocusState private var focused: Bool

    var body: some View {
        HStack(spacing: 0) {
            Group {
                if secure {
                    SecureField(placeholder, text: $text)
                } else if lines > 1 {
                    TextField(placeholder, text: $text, axis: .vertical)
                        .lineLimit(lines...)
                } else {
                    TextField(placeholder, text: $text)
                }
            }
            .font(fieldFont(monospaced: monospaced))
            .foregroundStyle(Tokens.Palette.foreground)
            .focused($focused)
            .padding(.vertical, 10)
            trailing()
        }
        .modifier(InputBox(border: borderColor, trailingInset: Trailing.self == EmptyView.self ? Tokens.Spacing.m : 2))
    }

    private var borderColor: Color {
        if isError { return Tokens.Status.danger }
        return focused ? Tokens.Palette.ring : Tokens.Palette.input
    }
}

extension PlatformTextField where Trailing == EmptyView {
    init(
        text: Binding<String>,
        placeholder: String = "",
        secure: Bool = false,
        monospaced: Bool = false,
        lines: Int = 1,
        isError: Bool = false
    ) {
        self.init(
            text: text, placeholder: placeholder, secure: secure, monospaced: monospaced,
            lines: lines, isError: isError, trailing: { EmptyView() }
        )
    }
}

/// A value shown the way the platform's item dialog shows one: a read-only
/// input, with its actions inside the right edge. Not selectable, so a
/// secret only leaves through the copy button and its 30-second clipboard.
struct ReadOnlyField<Actions: View>: View {
    let label: String
    let value: String
    var monospaced = false
    var multiline = false
    @ViewBuilder var actions: () -> Actions

    var body: some View {
        LabeledField(label: label) {
            HStack(alignment: multiline ? .top : .center, spacing: 0) {
                Text(value.isEmpty ? PassStrings.commonDash : value)
                    .font(fieldFont(monospaced: monospaced))
                    .foregroundStyle(value.isEmpty ? Tokens.Palette.mutedForeground : Tokens.Palette.foreground)
                    .lineLimit(multiline ? nil : 1)
                    .textSelection(.disabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.vertical, 10)
                actions()
            }
            .modifier(InputBox(trailingInset: Actions.self == EmptyView.self ? Tokens.Spacing.m : 2))
        }
    }
}

extension ReadOnlyField where Actions == EmptyView {
    init(label: String, value: String, monospaced: Bool = false, multiline: Bool = false) {
        self.init(label: label, value: value, monospaced: monospaced, multiline: multiline, actions: { EmptyView() })
    }
}

/// The platform's `outline` button: a bordered `rounded-md` button with foreground text.
struct OutlineButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.inter(.subheadline, weight: .medium))
            .foregroundStyle(Tokens.Palette.foreground)
            .padding(.horizontal, Tokens.Spacing.m)
            .frame(minWidth: 40, minHeight: 40)
            .background(
                configuration.isPressed ? Tokens.Palette.accent : Tokens.Palette.background,
                in: RoundedRectangle(cornerRadius: Tokens.Radius.medium)
            )
            .overlay(RoundedRectangle(cornerRadius: Tokens.Radius.medium).stroke(Tokens.Palette.input, lineWidth: 1))
            .opacity(isEnabled ? 1 : 0.5)
    }
}

extension ButtonStyle where Self == OutlineButtonStyle {
    static var platformOutline: OutlineButtonStyle { OutlineButtonStyle() }
}

/// A small icon button for inside a field (`size="icon-xs"`).
struct FieldIconButton: View {
    let systemImage: String
    let label: String
    var tint: Color = Tokens.Palette.mutedForeground
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: 14))
                .foregroundStyle(tint)
                .frame(width: 36, height: 36)
                .contentShape(Rectangle())
        }
        .buttonStyle(.borderless)
        .accessibilityLabel(label)
    }
}

/// Copy, as the platform's `CopyButton`: the icon turns into a green check
/// for a moment after a copy. `copy` returns whether something was copied.
struct CopyIconButton: View {
    let label: String
    let copy: () async -> Bool

    @State private var copied = false
    @State private var busy = false

    var body: some View {
        FieldIconButton(
            systemImage: copied ? "checkmark" : "doc.on.doc",
            label: label,
            tint: copied ? PassColors.copied : Tokens.Palette.mutedForeground
        ) {
            guard !busy else { return }
            Task {
                busy = true
                let done = await copy()
                busy = false
                guard done else { return }
                copied = true
                try? await Task.sleep(for: .seconds(1.5))
                copied = false
            }
        }
        .disabled(busy)
    }
}
