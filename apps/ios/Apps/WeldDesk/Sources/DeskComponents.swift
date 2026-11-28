import SwiftUI
import UIKit
import WeldCore
import WeldUI

// WeldDesk's pieces of the web platform's look that WeldUI doesn't have (yet):
// the single-initial avatar of its conversation list and timeline, the outline
// toggles of its filter popover, the date group header, the empty and error
// state with the icon on a muted square, and a wrapping row for badges.

extension Color {
    /// `0xRRGGBB` at an opacity, as the platform's Tailwind classes give it.
    init(desk rgb: UInt32, opacity: Double = 1) {
        self.init(
            red: Double((rgb >> 16) & 0xFF) / 255,
            green: Double((rgb >> 8) & 0xFF) / 255,
            blue: Double(rgb & 0xFF) / 255,
            opacity: opacity
        )
    }

    /// One colour in light mode and another in dark, as a `dark:` class pairs them.
    static func desk(light: Color, dark: Color) -> Color {
        Color(uiColor: UIColor { traits in
            traits.userInterfaceStyle == .dark ? UIColor(dark) : UIColor(light)
        })
    }
}

/// The Tailwind colours WeldDesk's platform screens use, by what they mark.
enum DeskColors {
    /// `bg-blue-600`: the unread dot.
    static let unread = Color(desk: 0x2563EB)
    static let urgent = Color(desk: 0xDC2626)
    static let high = Color(desk: 0xEA580C)
    /// Tags (`#475569`).
    static let tag = Color(desk: 0x475569)
    static let email = Color(desk: 0x0F766E)
    static let phone = Color(desk: 0x1D4ED8)
    static let portal = Color(desk: 0xB45309)
    static let api = Color(desk: 0x7C3AED)
    static let unassigned = Color(desk: 0x6B7280)
    static let waiting = Color(desk: 0x2563EB)
    static let slaOk = Color(desk: 0x0F766E)
    static let slaWarning = Color(desk: 0xD97706)
    static let slaBreached = Color(desk: 0xDC2626)
    static let slaMuted = Color(desk: 0x6B7280)

    /// `emerald-500` dot, `emerald-700` / `emerald-400` text: the visitor is online.
    static let onlineDot = Color(desk: 0x10B981)
    static let onlineText = Color.desk(light: Color(desk: 0x047857), dark: Color(desk: 0x34D399))

    /// An agent's bubble: `indigo-100`, dark `indigo-500/20`.
    static let agentBubble = Color.desk(light: Color(desk: 0xE0E7FF), dark: Color(desk: 0x6366F1, opacity: 0.2))
    static let agentText = Color.desk(light: Color(desk: 0x111827), dark: Color(desk: 0xFFFFFF))
    static let agentMeta = Color.desk(light: Color(desk: 0x6B7280), dark: Color(desk: 0xB5BDC9))

    /// An internal note: `amber-50` with an `amber-200` border, dark `amber-950/30` and `amber-900`.
    static let noteBubble = Color.desk(light: Color(desk: 0xFFFBEB), dark: Color(desk: 0x451A03, opacity: 0.3))
    static let noteBorder = Color.desk(light: Color(desk: 0xFDE68A), dark: Color(desk: 0x78350F))
    static let noteText = Color.desk(light: Color(desk: 0x451A03), dark: Color(desk: 0xFEF3C7))
    static let noteMeta = Color.desk(light: Color(desk: 0xB45309), dark: Color(desk: 0xFBBF24))
    /// The composer while it writes a note: `amber-50/60`, dark `amber-950/20`.
    static let noteComposer = Color.desk(light: Color(desk: 0xFFFBEB, opacity: 0.6), dark: Color(desk: 0x451A03, opacity: 0.2))

    /// SLA lines in the timeline: `amber-600` / `amber-400`, `red-600` / `red-400`.
    static let slaWarningLine = Color.desk(light: Color(desk: 0xD97706), dark: Color(desk: 0xFBBF24))
    static let slaBreachedLine = Color.desk(light: Color(desk: 0xDC2626), dark: Color(desk: 0xF87171))

    /// The header's SLA chip, per tone: background and text.
    static func slaChip(_ tone: DeskLogic.SlaTone) -> (background: Color, text: Color) {
        switch tone {
        case .ok:
            (background: Color.desk(light: Color(desk: 0xF0FDFA), dark: Color(desk: 0x042F2E, opacity: 0.4)), text: Color.desk(light: Color(desk: 0x0F766E), dark: Color(desk: 0x2DD4BF)))
        case .warning:
            (background: Color.desk(light: Color(desk: 0xFFFBEB), dark: Color(desk: 0x451A03, opacity: 0.4)), text: Color.desk(light: Color(desk: 0xB45309), dark: Color(desk: 0xFBBF24)))
        case .breached:
            (background: Color.desk(light: Color(desk: 0xFEF2F2), dark: Color(desk: 0x450A0A, opacity: 0.4)), text: Color.desk(light: Color(desk: 0xB91C1C), dark: Color(desk: 0xF87171)))
        case .muted:
            (background: Tokens.Palette.muted, text: Tokens.Palette.mutedForeground)
        }
    }

    /// The send button while there's nothing to send: `gray-300` and `gray-500`, dark the muted colours.
    static let idleSend = Color.desk(light: Color(desk: 0xD1D5DB), dark: Color(desk: 0x232529))
    static let idleSendIcon = Color.desk(light: Color(desk: 0x6B7280), dark: Color(desk: 0xB5BDC9))
}

/// A person's picture, or the first letter of their name in white on the
/// platform's avatar colour for that name (`bot`: the AI's sparkles instead).
struct InitialAvatar: View {
    let name: String
    var url: URL?
    var size: CGFloat = 28
    var bot = false

    var body: some View {
        Group {
            if let url {
                AsyncImage(url: url) { phase in
                    if let image = phase.image {
                        image.resizable().scaledToFill()
                    } else {
                        fallback
                    }
                }
            } else {
                fallback
            }
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
        .accessibilityHidden(true)
    }

    private var fallback: some View {
        ZStack {
            PlatformColors.avatar(name)
            if bot {
                Image(systemName: "sparkles")
                    .font(.system(size: size * 0.5))
                    .foregroundStyle(.white)
            } else {
                Text(Self.initial(of: name))
                    .font(.inter(size: size * 0.43, weight: .semibold))
                    .foregroundStyle(.white)
            }
        }
    }

    /// The first letter of a name, as the platform's list and timeline avatars show it.
    static func initial(of name: String) -> String {
        name.trimmingCharacters(in: .whitespaces).first.map { String($0).uppercased() } ?? "?"
    }
}

/// The platform's outline toggle (`Toggle variant="outline" size="sm"`):
/// bordered, `rounded-md`, filled with the primary colour while on.
struct FilterChip: View {
    let title: String
    let selected: Bool
    let identifier: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.inter(.caption, weight: .medium))
                .lineLimit(1)
                .padding(.horizontal, 10)
                .frame(height: 30)
                .foregroundStyle(selected ? Tokens.Palette.primaryForeground : Tokens.Palette.foreground)
                .background(selected ? Tokens.Palette.primary : Color.clear, in: RoundedRectangle(cornerRadius: Tokens.Radius.medium))
                .overlay(RoundedRectangle(cornerRadius: Tokens.Radius.medium).stroke(selected ? Tokens.Palette.primary : Tokens.Palette.input, lineWidth: 1))
                .contentShape(RoundedRectangle(cornerRadius: Tokens.Radius.medium))
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityIdentifier(identifier)
    }
}

/// The platform's outline button at toggle size, with a leading icon (the sort).
struct OutlineChip: View {
    let title: String
    let systemImage: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Image(systemName: systemImage)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(Tokens.Palette.mutedForeground)
                Text(title)
                    .font(.inter(.caption, weight: .medium))
                    .foregroundStyle(Tokens.Palette.foreground)
                    .lineLimit(1)
            }
            .padding(.horizontal, 10)
            .frame(height: 30)
            .overlay(RoundedRectangle(cornerRadius: Tokens.Radius.medium).stroke(Tokens.Palette.input, lineWidth: 1))
            .contentShape(RoundedRectangle(cornerRadius: Tokens.Radius.medium))
        }
        .buttonStyle(.plain)
    }
}

/// A date group's header in the conversation list ("Last week 2"): a muted
/// band between hairlines, its label and a count in a small badge.
struct GroupHeaderRow: View {
    let label: String
    let count: Int

    var body: some View {
        HStack(spacing: Tokens.Spacing.s) {
            Text(label)
                .font(.inter(.caption, weight: .medium))
                .foregroundStyle(Tokens.Palette.mutedForeground)
                .lineLimit(1)
            Text("\(count)")
                .font(.inter(size: 10, weight: .medium).monospacedDigit())
                .foregroundStyle(Tokens.Palette.mutedForeground)
                .padding(.horizontal, 3)
                .frame(minWidth: 16, minHeight: 16)
                .background(Tokens.Palette.muted, in: RoundedRectangle(cornerRadius: 5))
                .overlay(RoundedRectangle(cornerRadius: 5).stroke(Tokens.Palette.border, lineWidth: 1))
            Spacer(minLength: 0)
        }
        .padding(.horizontal, Tokens.Spacing.m)
        .frame(height: 32)
        .background(Tokens.Palette.muted.opacity(0.5))
        .overlay(alignment: .top) { Rectangle().fill(Tokens.Palette.border.opacity(0.7)).frame(height: 1) }
        .overlay(alignment: .bottom) { Rectangle().fill(Tokens.Palette.border.opacity(0.7)).frame(height: 1) }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }
}

/// An empty or failed list, as the platform draws one: the icon on a muted
/// rounded square, a semibold title, a muted description, and actions.
struct DeskEmptyStateView<Actions: View>: View {
    let systemImage: String
    let title: String
    let description: String?
    var iconTint: Color = Tokens.Palette.mutedForeground
    var iconBackground: Color = Tokens.Palette.muted
    @ViewBuilder var actions: () -> Actions

    var body: some View {
        VStack(spacing: Tokens.Spacing.s) {
            Image(systemName: systemImage)
                .font(.system(size: 18))
                .foregroundStyle(iconTint)
                .frame(width: 44, height: 44)
                .background(iconBackground, in: RoundedRectangle(cornerRadius: Tokens.Radius.large))
                .accessibilityHidden(true)
            Text(title)
                .font(.inter(.subheadline, weight: .semibold))
                .multilineTextAlignment(.center)
                .padding(.top, Tokens.Spacing.xs)
            if let description {
                Text(description)
                    .font(.inter(.footnote))
                    .foregroundStyle(Tokens.Palette.mutedForeground)
                    .multilineTextAlignment(.center)
            }
            actions()
                .padding(.top, Tokens.Spacing.s)
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, Tokens.Spacing.xl)
        .padding(.vertical, 56)
    }
}

extension DeskEmptyStateView where Actions == EmptyView {
    init(systemImage: String, title: String, description: String?) {
        self.init(systemImage: systemImage, title: title, description: description) { EmptyView() }
    }
}

/// Badges that wrap onto a next line when they don't fit.
struct FlowLayout: Layout {
    var spacing: CGFloat = Tokens.Spacing.xs

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let rows = arrange(width: proposal.width ?? .infinity, subviews: subviews)
        let width = rows.map(\.width).max() ?? 0
        let height = rows.map(\.height).reduce(0, +) + spacing * CGFloat(max(rows.count - 1, 0))
        return CGSize(width: width, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var y = bounds.minY
        for row in arrange(width: bounds.width, subviews: subviews) {
            var x = bounds.minX
            for index in row.indices {
                let size = subviews[index].sizeThatFits(.unspecified)
                subviews[index].place(at: CGPoint(x: x, y: y + (row.height - size.height) / 2), proposal: ProposedViewSize(size))
                x += size.width + spacing
            }
            y += row.height + spacing
        }
    }

    private struct Row {
        var indices: [Int] = []
        var width: CGFloat = 0
        var height: CGFloat = 0
    }

    private func arrange(width: CGFloat, subviews: Subviews) -> [Row] {
        var rows: [Row] = []
        var current = Row()
        for index in subviews.indices {
            let size = subviews[index].sizeThatFits(.unspecified)
            let needed = current.indices.isEmpty ? size.width : current.width + spacing + size.width
            if !current.indices.isEmpty, needed > width {
                rows.append(current)
                current = Row()
            }
            current.width = current.indices.isEmpty ? size.width : current.width + spacing + size.width
            current.height = max(current.height, size.height)
            current.indices.append(index)
        }
        if !current.indices.isEmpty { rows.append(current) }
        return rows
    }
}
