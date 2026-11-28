import Observation
import SwiftUI
import UIKit
import WeldCore
import WeldUI

// The pieces every WeldBooks screen is built from (Android `ui/Common.kt`, the
// list helpers of `HomeScreens.kt` and `FinanceScreens.kt`), drawn as the web
// platform's WeldBooks draws them (`apps/web/platform/app/weldbooks`,
// `components/accounting/weldbooks-row-cells.tsx`, `@weldsuite/ui`): plain rows
// with hairlines on the page, coloured status chips, bordered cards only for
// figures, forms and settings, labels above bordered inputs. Card layouts
// (`SectionCard`, `PanelSection`, …) go in a `ScrollView` + `VStack(spacing: 0)`
// with `.groupedBackground()`; list screens use `List` with `.platformList()`.

extension View {
    /// The accessibility identifier Maestro selects on, the same string as the Android test tag; nothing for nil.
    @ViewBuilder
    func tagged(_ tag: String?) -> some View {
        if let tag {
            accessibilityIdentifier(tag)
        } else {
            self
        }
    }

    /// The page colour screens sit on: the platform's background (white, or its dark grey).
    func groupedBackground() -> some View {
        background(Tokens.Palette.background.ignoresSafeArea())
    }

    /// A plain list on the platform's background, with its hairlines in the border colour.
    func platformList() -> some View {
        listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(Tokens.Palette.background)
    }

    /// A list row's hairline in the platform's border colour.
    func platformRow() -> some View {
        listRowSeparatorTint(Tokens.Palette.border)
            .listRowBackground(Tokens.Palette.background)
    }
}

/// An option of a picker or a filter chip: the value and its words.
struct Choice: Hashable, Identifiable, Sendable {
    let key: String
    let label: String

    init(_ key: String, _ label: String) {
        self.key = key
        self.label = label
    }

    var id: String { key }
}

extension Color {
    /// A colour with a light and a dark variant (`0xRRGGBB`), like the design tokens.
    init(dayHex: UInt32, nightHex: UInt32) {
        self.init(uiColor: UIColor { traits in
            let hex = traits.userInterfaceStyle == .dark ? nightHex : dayHex
            return UIColor(
                red: CGFloat((hex >> 16) & 0xFF) / 255,
                green: CGFloat((hex >> 8) & 0xFF) / 255,
                blue: CGFloat(hex & 0xFF) / 255,
                alpha: 1
            )
        })
    }
}

/// The platform's chip colours (`weldbooks-row-cells.tsx`): the text colour,
/// light and dark; the chip's fill is a wash of it.
enum Tones {
    /// `text-gray-600`, `dark:text-muted-foreground`.
    static let gray = Color(dayHex: 0x4B5563, nightHex: 0xB5BDC9)
    static let blue = Color(dayHex: 0x2563EB, nightHex: 0x60A5FA)
    static let green = Color(dayHex: 0x059669, nightHex: 0x34D399)
    static let amber = Color(dayHex: 0xD97706, nightHex: 0xFBBF24)
    static let red = Color(dayHex: 0xDC2626, nightHex: 0xF87171)
    static let purple = Color(dayHex: 0x9333EA, nightHex: 0xC084FC)
    static let indigo = Color(dayHex: 0x4338CA, nightHex: 0x818CF8)
    /// A money amount coming in: `text-emerald-600 dark:text-emerald-400`.
    static let positive = green
    /// What has been paid, in the totals: `text-green-600 dark:text-green-400`.
    static let paid = Color(dayHex: 0x16A34A, nightHex: 0x4ADE80)
    /// The row avatar's fill: `bg-gray-200 dark:bg-accent`.
    static let avatarFill = Color(dayHex: 0xE5E7EB, nightHex: 0x2E3238)
    /// The platform's `--chart-1`.
    static let chart = Color(dayHex: 0x2C7FFF, nightHex: 0x266DF0)

    /// A tone by name (`Statuses.tone`); gray for anything else.
    static func of(_ name: String) -> Color {
        switch name {
        case "blue": return blue
        case "green": return green
        case "amber": return amber
        case "red": return red
        case "purple": return purple
        case "indigo": return indigo
        default: return gray
        }
    }
}

/// The platform's card: bordered, `rounded-xl`, on the card colour, with an
/// optional title and action (a button on the title row). For figures, forms
/// and settings; a record's details sit on the page in a `PanelSection`.
struct SectionCard<Action: View, Content: View>: View {
    var title: String?
    var padded: Bool
    private let hasAction: Bool
    private let action: Action
    private let content: Content

    init(title: String? = nil, padded: Bool = true, @ViewBuilder action: () -> Action, @ViewBuilder content: () -> Content) {
        self.title = title
        self.padded = padded
        hasAction = true
        self.action = action()
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if title != nil || hasAction {
                HStack(alignment: .center) {
                    if let title {
                        Text(title).font(.inter(.callout, weight: .semibold))
                    }
                    Spacer(minLength: Tokens.Spacing.s)
                    action
                }
                .padding(.bottom, Tokens.Spacing.s)
                .padding(.horizontal, padded ? 0 : Tokens.Spacing.l)
                .padding(.top, padded ? 0 : Tokens.Spacing.s)
            }
            content
        }
        .padding(.horizontal, padded ? Tokens.Spacing.l : 0)
        .padding(.vertical, padded ? Tokens.Spacing.l : Tokens.Spacing.xs)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Tokens.Palette.card, in: RoundedRectangle(cornerRadius: Tokens.Radius.xlarge))
        .overlay(RoundedRectangle(cornerRadius: Tokens.Radius.xlarge).strokeBorder(Tokens.Palette.border, lineWidth: 1))
        .padding(.horizontal, Tokens.Spacing.l)
        .padding(.vertical, 6)
    }
}

extension SectionCard where Action == EmptyView {
    init(title: String? = nil, padded: Bool = true, @ViewBuilder content: () -> Content) {
        self.title = title
        self.padded = padded
        hasAction = false
        action = EmptyView()
        self.content = content()
    }
}

/// A titled block of a record's details, on the page (the platform's `PanelSection`).
struct PanelSection<Content: View>: View {
    var title: String?
    private let content: Content

    init(title: String? = nil, @ViewBuilder content: () -> Content) {
        self.title = title
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let title {
                Text(title)
                    .font(.inter(.subheadline, weight: .semibold))
                    .frame(minHeight: 32)
            }
            content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, Tokens.Spacing.l)
        .padding(.vertical, Tokens.Spacing.s)
    }
}

/// A hairline between blocks of a page, in the border colour.
struct Hairline: View {
    var body: some View {
        Rectangle().fill(Tokens.Palette.border).frame(height: 1).frame(maxWidth: .infinity)
    }
}

/// A label and its value on one row.
struct DetailRow: View {
    let label: String
    let value: String
    var valueColor: Color?
    var strong: Bool = false

    init(_ label: String, _ value: String, valueColor: Color? = nil, strong: Bool = false) {
        self.label = label
        self.value = value
        self.valueColor = valueColor
        self.strong = strong
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Tokens.Spacing.l) {
            Text(label)
                .font(.inter(.subheadline))
                .foregroundStyle(Tokens.Palette.mutedForeground)
                .frame(maxWidth: .infinity, alignment: .leading)
            Text(value)
                .font(.inter(.subheadline).weight(strong ? .semibold : .regular))
                .monospacedDigit()
                .foregroundStyle(valueColor ?? Tokens.Palette.foreground)
                .multilineTextAlignment(.trailing)
                .frame(maxWidth: .infinity, alignment: .trailing)
                .layoutPriority(1)
        }
        .padding(.vertical, 5)
        .accessibilityElement(children: .combine)
    }
}

/// A property of a record, as the platform's object panels list them: the icon
/// and label in a column, the value beside it; a dash when there is none.
struct PropertyRow<Value: View>: View {
    let systemImage: String
    let label: String
    private let value: Value

    init(_ systemImage: String, _ label: String, @ViewBuilder value: () -> Value) {
        self.systemImage = systemImage
        self.label = label
        self.value = value()
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Tokens.Spacing.s) {
            HStack(spacing: Tokens.Spacing.s) {
                Image(systemName: systemImage)
                    .font(.system(size: 14))
                    .frame(width: 16)
                    .foregroundStyle(Tokens.Palette.mutedForeground)
                    .accessibilityHidden(true)
                Text(label)
                    .font(.inter(.subheadline))
                    .foregroundStyle(Tokens.Palette.mutedForeground)
                    .lineLimit(2)
            }
            .frame(width: 136, alignment: .leading)
            value
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(minHeight: 36)
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }
}

extension PropertyRow where Value == PropertyText {
    /// A plain value; a dash when there is none.
    init(_ systemImage: String, _ label: String, _ text: String?, color: Color? = nil) {
        self.init(systemImage, label) { PropertyText(text: text, color: color) }
    }
}

/// A property's value in words, or a muted dash.
struct PropertyText: View {
    let text: String?
    var color: Color?

    var body: some View {
        if let text, !text.trimmed.isEmpty {
            Text(text)
                .font(.inter(.subheadline))
                .monospacedDigit()
                .foregroundStyle(color ?? Tokens.Palette.foreground)
        } else {
            Text(BooksStrings.commonDash)
                .font(.inter(.subheadline))
                .foregroundStyle(Tokens.Palette.mutedForeground)
        }
    }
}

/// The platform's `KpiCard`: a card with the label (and its icon) on top, the
/// figure large and bold in tabular numerals, coloured by `tone`, and a muted hint.
struct KpiCard: View {
    let label: String
    let value: String
    var hint: String?
    var systemImage: String?
    var tone: Color?
    var tag: String?

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Spacing.s) {
            HStack(spacing: Tokens.Spacing.s) {
                Text(label)
                    .font(.inter(.subheadline, weight: .medium))
                    .foregroundStyle(Tokens.Palette.mutedForeground)
                    .lineLimit(1)
                Spacer(minLength: 0)
                if let systemImage {
                    Image(systemName: systemImage)
                        .font(.system(size: 14))
                        .foregroundStyle(Tokens.Palette.mutedForeground)
                        .accessibilityHidden(true)
                }
            }
            Text(value)
                .font(.inter(.title2, weight: .bold))
                .monospacedDigit()
                .foregroundStyle(tone ?? Tokens.Palette.foreground)
                .lineLimit(1)
                .minimumScaleFactor(0.6)
            if let hint {
                Text(hint)
                    .font(.inter(.caption))
                    .foregroundStyle(Tokens.Palette.mutedForeground)
                    .lineLimit(2)
            }
        }
        .padding(Tokens.Spacing.l)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Tokens.Palette.card, in: RoundedRectangle(cornerRadius: Tokens.Radius.xlarge))
        .overlay(RoundedRectangle(cornerRadius: Tokens.Radius.xlarge).strokeBorder(Tokens.Palette.border, lineWidth: 1))
        .contentShape(RoundedRectangle(cornerRadius: Tokens.Radius.xlarge))
        .accessibilityElement(children: .combine)
        .tagged(tag)
    }
}

/// Rows of amounts and a total under a rule (the platform's totals: muted labels,
/// a semibold total), then what comes after it (paid in green, the balance due).
struct TotalsBlock: View {
    let rows: [(String, String)]
    let total: (String, String)
    var after: [(String, String, Color?)] = []

    var body: some View {
        VStack(spacing: Tokens.Spacing.s) {
            ForEach(rows.indices, id: \.self) { index in
                line(rows[index].0, rows[index].1, color: nil, strong: false)
            }
            Hairline()
            line(total.0, total.1, color: nil, strong: true)
            ForEach(after.indices, id: \.self) { index in
                let row = after[index]
                line(row.0, row.1, color: row.2, strong: row.2 == nil)
            }
        }
    }

    private func line(_ label: String, _ value: String, color: Color?, strong: Bool) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(label)
                .font(strong ? Font.inter(.callout, weight: .semibold) : Font.inter(.subheadline))
                .foregroundStyle(color ?? (strong ? Tokens.Palette.foreground : Tokens.Palette.mutedForeground))
            Spacer(minLength: Tokens.Spacing.m)
            Text(value)
                .font(strong ? Font.inter(.callout, weight: .semibold) : Font.inter(.subheadline))
                .monospacedDigit()
                .foregroundStyle(color ?? Tokens.Palette.foreground)
        }
        .accessibilityElement(children: .combine)
    }
}

/// The small round avatar of a list row (the platform's `RowAvatar`): the
/// initial, or an SF Symbol (a building, a person), on a neutral fill.
struct RowAvatar: View {
    let name: String?
    var systemImage: String?
    var size: CGFloat = 20

    var body: some View {
        Group {
            if let systemImage {
                Image(systemName: systemImage)
                    .font(.system(size: size * 0.5, weight: .medium))
            } else {
                Text(String(AvatarView.initials(of: name).prefix(1)))
                    .font(.inter(size: size * 0.5, weight: .medium))
            }
        }
        .foregroundStyle(Tones.gray)
        .frame(width: size, height: size)
        .background(Tones.avatarFill, in: Circle())
        .accessibilityHidden(true)
    }
}

/// A list item's leading icon, as the platform's menus draw them: plain and muted, no tile.
struct ListIcon: View {
    let systemImage: String

    init(_ systemImage: String) {
        self.systemImage = systemImage
    }

    var body: some View {
        Image(systemName: systemImage)
            .font(.system(size: 17))
            .foregroundStyle(Tokens.Palette.mutedForeground)
            .frame(width: 24)
            .accessibilityHidden(true)
    }
}

/// A list row as the platform's WeldBooks lists draw it: a medium title, muted
/// lines under it, the amount and a chip on the right. The list draws the hairline.
/// With `onTap` the whole row is a button; else wrap it in your own `Button`/`NavigationLink`.
struct RecordRow<Leading: View, Badge: View>: View {
    let title: String
    var subtitle: String?
    var meta: String?
    var amount: String?
    var amountColor: Color?
    var tag: String?
    var onTap: (() -> Void)?
    private let leading: Leading
    private let badge: Badge

    init(
        title: String,
        subtitle: String? = nil,
        meta: String? = nil,
        amount: String? = nil,
        amountColor: Color? = nil,
        tag: String? = nil,
        onTap: (() -> Void)? = nil,
        @ViewBuilder leading: () -> Leading,
        @ViewBuilder badge: () -> Badge
    ) {
        self.title = title
        self.subtitle = subtitle
        self.meta = meta
        self.amount = amount
        self.amountColor = amountColor
        self.tag = tag
        self.onTap = onTap
        self.leading = leading()
        self.badge = badge()
    }

    var body: some View {
        if let onTap {
            Button(action: onTap) { row }
                .buttonStyle(.plain)
                .tagged(tag)
        } else {
            row.tagged(tag)
        }
    }

    private var row: some View {
        HStack(spacing: Tokens.Spacing.m) {
            leading
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.inter(.subheadline, weight: .medium))
                    .foregroundStyle(Tokens.Palette.foreground)
                    .lineLimit(1)
                if let subtitle {
                    Text(subtitle).font(.inter(.footnote)).foregroundStyle(Tokens.Palette.mutedForeground).lineLimit(1)
                }
                if let meta {
                    Text(meta).font(.inter(.caption)).monospacedDigit().foregroundStyle(Tokens.Palette.mutedForeground).lineLimit(1)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            VStack(alignment: .trailing, spacing: 4) {
                if let amount {
                    Text(amount)
                        .font(.inter(.subheadline, weight: .medium))
                        .monospacedDigit()
                        .foregroundStyle(amountColor ?? Tokens.Palette.foreground)
                        .lineLimit(1)
                }
                badge
            }
        }
        .padding(.vertical, 4)
        .contentShape(Rectangle())
    }
}

extension RecordRow where Badge == EmptyView {
    init(
        title: String,
        subtitle: String? = nil,
        meta: String? = nil,
        amount: String? = nil,
        amountColor: Color? = nil,
        tag: String? = nil,
        onTap: (() -> Void)? = nil,
        @ViewBuilder leading: () -> Leading
    ) {
        self.init(title: title, subtitle: subtitle, meta: meta, amount: amount, amountColor: amountColor, tag: tag, onTap: onTap, leading: leading) {
            EmptyView()
        }
    }
}

extension RecordRow where Leading == EmptyView {
    init(
        title: String,
        subtitle: String? = nil,
        meta: String? = nil,
        amount: String? = nil,
        amountColor: Color? = nil,
        tag: String? = nil,
        onTap: (() -> Void)? = nil,
        @ViewBuilder badge: () -> Badge
    ) {
        self.init(title: title, subtitle: subtitle, meta: meta, amount: amount, amountColor: amountColor, tag: tag, onTap: onTap, leading: { EmptyView() }, badge: badge)
    }
}

/// The header over a group of rows (the platform's list groups, "Overdue 3"):
/// a small muted label and the count in a chip, on a muted band.
struct GroupHeader: View {
    let label: String
    let count: Int
    var more: Bool = false

    var body: some View {
        HStack(spacing: Tokens.Spacing.s) {
            Text(label)
                .font(.inter(.caption, weight: .medium))
                .foregroundStyle(Tokens.Palette.mutedForeground)
            Text(more ? "\(count)+" : "\(count)")
                .font(.system(size: 10, design: .monospaced))
                .foregroundStyle(Tokens.Palette.mutedForeground)
                .padding(.horizontal, 4)
                .frame(minWidth: 16, minHeight: 16)
                .background(Tokens.Palette.muted, in: RoundedRectangle(cornerRadius: 5))
                .overlay(RoundedRectangle(cornerRadius: 5).strokeBorder(Tokens.Palette.border, lineWidth: 1))
            Spacer(minLength: 0)
        }
        .padding(.horizontal, Tokens.Spacing.l)
        .frame(minHeight: 32)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Tokens.Palette.muted.opacity(0.5))
        .background(Tokens.Palette.background)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }
}

extension View {
    /// A `List` section header as the platform's group header, edge to edge.
    func groupHeaderInsets() -> some View {
        listRowInsets(EdgeInsets())
    }
}

/// An empty list or screen, as the platform draws one: the icon in a muted
/// rounded square, a semibold title, a muted line, and the action that fills it.
struct BooksEmptyState: View {
    let systemImage: String
    let title: String
    var description: String?
    var action: String?
    var actionTag: String?
    var onAction: (() -> Void)?

    var body: some View {
        VStack(spacing: Tokens.Spacing.s) {
            Image(systemName: systemImage)
                .font(.system(size: 22))
                .foregroundStyle(Tokens.Palette.mutedForeground)
                .frame(width: 48, height: 48)
                .background(Tokens.Palette.muted, in: RoundedRectangle(cornerRadius: Tokens.Radius.large))
                .accessibilityHidden(true)
            Text(title)
                .font(.inter(.subheadline, weight: .semibold))
                .multilineTextAlignment(.center)
                .padding(.top, Tokens.Spacing.s)
            if let description {
                Text(description)
                    .font(.inter(.subheadline))
                    .foregroundStyle(Tokens.Palette.mutedForeground)
                    .multilineTextAlignment(.center)
            }
            if let action, let onAction {
                Button(action: onAction) {
                    Label(action, systemImage: "plus").font(.inter(.subheadline, weight: .medium))
                }
                .buttonStyle(.borderedProminent)
                .padding(.top, Tokens.Spacing.m)
                .tagged(actionTag)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, Tokens.Spacing.xl)
        .padding(.vertical, 48)
    }
}

/// The colour of a status's chip (`Statuses.tone`, the platform's tones).
func statusColor(_ status: String) -> Color {
    Tones.of(Statuses.tone(status))
}

/// A status as the platform's coloured chip.
struct StatusPill: View {
    let status: String

    init(_ status: String) {
        self.status = status
    }

    var body: some View {
        StatusBadge(statusLabel(status), color: statusColor(status))
    }
}

/// A status in words; an unknown one made readable.
func statusLabel(_ status: String) -> String {
    switch status {
    case "draft": return BooksStrings.statusDraft
    case "finalized": return BooksStrings.statusFinalized
    case "sent": return BooksStrings.statusSent
    case "viewed": return BooksStrings.statusViewed
    case "partially_paid", "partial": return BooksStrings.statusPartiallyPaid
    case "paid": return BooksStrings.statusPaid
    case "overdue": return BooksStrings.statusOverdue
    case "cancelled": return BooksStrings.statusCancelled
    case "uncollectible": return BooksStrings.statusUncollectible
    case "pending": return BooksStrings.statusPending
    case "approved": return BooksStrings.statusApproved
    case "rejected": return BooksStrings.statusRejected
    case "submitted": return BooksStrings.statusSubmitted
    case "accepted": return BooksStrings.statusAccepted
    case "calculated": return BooksStrings.statusCalculated
    case "reviewed": return BooksStrings.statusReviewed
    case "filed": return BooksStrings.statusFiled
    default: return status.replacingOccurrences(of: "_", with: " ").capitalizedFirst
    }
}

/// A notice in the flow of a screen, as the platform's `InfoBanner`: `info`, `success`, `warning` or `error`.
struct Banner: View {
    let text: String
    var tone: String = "info"
    var title: String?
    var onClose: (() -> Void)?

    init(_ text: String, tone: String = "info", title: String? = nil, onClose: (() -> Void)? = nil) {
        self.text = text
        self.tone = tone
        self.title = title
        self.onClose = onClose
    }

    /// Border, fill, text and icon: the `InfoBanner` variant's colours.
    private var colors: (border: Color, fill: Color, text: Color, icon: Color) {
        switch tone {
        case "success":
            return (Color(dayHex: 0xBBF7D0, nightHex: 0x14532D), Color(dayHex: 0xF0FDF4, nightHex: 0x052E16), Color(dayHex: 0x14532D, nightHex: 0xDCFCE7), Color(dayHex: 0x16A34A, nightHex: 0x4ADE80))
        case "warning":
            return (Color(dayHex: 0xFEF08A, nightHex: 0x713F12), Color(dayHex: 0xFEFCE8, nightHex: 0x422006), Color(dayHex: 0x713F12, nightHex: 0xFEF9C3), Color(dayHex: 0xCA8A04, nightHex: 0xFACC15))
        case "error":
            let danger = Tokens.Status.danger
            return (danger.opacity(0.4), danger.opacity(0.1), danger, danger)
        default:
            return (Color(dayHex: 0xBFDBFE, nightHex: 0x1E3A8A), Color(dayHex: 0xEFF6FF, nightHex: 0x172554), Color(dayHex: 0x1E3A8A, nightHex: 0xDBEAFE), Color(dayHex: 0x2563EB, nightHex: 0x60A5FA))
        }
    }

    private var icon: String {
        switch tone {
        case "success": return "checkmark.circle"
        case "warning", "error": return "exclamationmark.triangle"
        default: return "info.circle"
        }
    }

    var body: some View {
        let palette = colors
        HStack(alignment: .top, spacing: Tokens.Spacing.m) {
            Image(systemName: icon)
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(palette.icon)
                .padding(.top, 2)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                if let title {
                    Text(title).font(.inter(.subheadline, weight: .semibold))
                }
                Text(text).font(.inter(.subheadline))
            }
            .foregroundStyle(palette.text)
            .frame(maxWidth: .infinity, alignment: .leading)
            if let onClose {
                Button(action: onClose) {
                    Image(systemName: "xmark").font(.system(size: 12, weight: .semibold))
                }
                .buttonStyle(.plain)
                .foregroundStyle(palette.text)
                .accessibilityLabel(CoreStrings.commonClose)
            }
        }
        .padding(.horizontal, Tokens.Spacing.l)
        .padding(.vertical, Tokens.Spacing.m)
        .background(palette.fill, in: RoundedRectangle(cornerRadius: Tokens.Radius.large))
        .overlay(RoundedRectangle(cornerRadius: Tokens.Radius.large).strokeBorder(palette.border, lineWidth: 1))
        .padding(.horizontal, Tokens.Spacing.l)
        .padding(.vertical, Tokens.Spacing.xs)
    }
}

/// The label over a group of menu rows: the platform sidebar's group label, small, medium and muted.
struct GroupLabel: View {
    let text: String

    init(_ text: String) {
        self.text = text
    }

    var body: some View {
        Text(text)
            .font(.inter(.caption, weight: .medium))
            .foregroundStyle(Tokens.Palette.mutedForeground)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, Tokens.Spacing.l)
            .padding(.top, Tokens.Spacing.l)
            .padding(.bottom, Tokens.Spacing.s)
    }
}

/// A line of explanation under a field or a section.
struct HintText: View {
    let text: String

    init(_ text: String) {
        self.text = text
    }

    var body: some View {
        Text(text)
            .font(.inter(.caption))
            .foregroundStyle(Tokens.Palette.mutedForeground)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 4)
    }
}

/// Shown instead of a screen the company's country doesn't have (Android `FeatureUnavailable`).
struct FeatureUnavailableView: View {
    var body: some View {
        BooksEmptyState(
            systemImage: "lock",
            title: BooksStrings.commonNotAvailableTitle,
            description: BooksStrings.commonNotAvailableDescription
        )
        .frame(maxHeight: .infinity)
        .groupedBackground()
        .navigationTitle(BooksStrings.commonNotAvailableTitle)
        .navigationBarTitleDisplayMode(.inline)
    }
}

/// A filter chip, as the platform's filter pills: bordered, the accent fill when on.
struct FilterChipView: View {
    let label: String
    let on: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(label)
                .font(.inter(.subheadline, weight: .medium))
                .padding(.horizontal, Tokens.Spacing.m)
                .padding(.vertical, 6)
                .foregroundStyle(on ? Tokens.Palette.foreground : Tokens.Palette.mutedForeground)
                .background(on ? Tokens.Palette.accent : Tokens.Palette.background, in: RoundedRectangle(cornerRadius: Tokens.Radius.medium))
                .overlay(RoundedRectangle(cornerRadius: Tokens.Radius.medium).strokeBorder(on ? Tokens.Palette.input : Tokens.Palette.border, lineWidth: 1))
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(on ? .isSelected : [])
    }
}

/// The platform's search box (a bordered input with the search icon) and a row of
/// filter chips that scrolls sideways (identifiers `search`, `filter-<key>`).
struct SearchAndFilters: View {
    @Binding var search: String
    let placeholder: String
    let filters: [Choice]
    @Binding var selected: String

    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Spacing.s) {
            HStack(spacing: Tokens.Spacing.s) {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 14))
                    .foregroundStyle(Tokens.Palette.mutedForeground)
                TextField(placeholder, text: $search)
                    .font(.inter(.subheadline))
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.search)
                    .focused($focused)
                    .tagged("search")
                if !search.isEmpty {
                    Button {
                        search = ""
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(Tokens.Palette.mutedForeground)
                    .accessibilityLabel(CoreStrings.commonClose)
                }
            }
            .padding(.horizontal, Tokens.Spacing.m)
            .frame(minHeight: 40)
            .background(Tokens.Palette.background, in: RoundedRectangle(cornerRadius: Tokens.Radius.medium))
            .overlay(
                RoundedRectangle(cornerRadius: Tokens.Radius.medium)
                    .strokeBorder(focused ? Tokens.Palette.ring : Tokens.Palette.input, lineWidth: 1)
            )

            if !filters.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(filters) { choice in
                            FilterChipView(label: choice.label, on: choice.key == selected) {
                                selected = choice.key
                            }
                            .tagged("filter-\(choice.key)")
                        }
                    }
                }
            }
        }
        .padding(.horizontal, Tokens.Spacing.l)
        .padding(.vertical, Tokens.Spacing.s)
    }
}

// MARK: - Loading

/// A screen's data: loaded once, refreshed by pull, realtime or after an
/// action; a failed refresh keeps what was shown (Android `Loaded`). Keep it in
/// `@State private var loaded = Loaded<T>()` and show it with `LoadedContent`.
@MainActor
@Observable
final class Loaded<T> {
    private(set) var data: T?
    private(set) var error: Error?
    private(set) var loading = true
    private(set) var refreshing = false

    @ObservationIgnored var fetch: (() async throws -> T)?
    @ObservationIgnored private var key: AnyHashable?

    init() {}

    /// Load with `fetch` for `key`. A different key starts over (a spinner, not the old data).
    func use(key: AnyHashable, fetch: @escaping () async throws -> T) {
        if self.key != key {
            if self.key != nil {
                data = nil
                error = nil
                loading = true
            }
            self.key = key
        }
        self.fetch = fetch
    }

    func load() async {
        guard let fetch else { return }
        do {
            let value = try await fetch()
            data = value
            error = nil
        } catch {
            // A screen that went away cancels its load; that isn't a failure to show.
            if !Task.isCancelled { self.error = error }
        }
        loading = false
        refreshing = false
    }

    /// Pull to refresh: keeps what is shown while loading.
    func refresh() async {
        refreshing = true
        await load()
    }

    /// After a failed first load.
    func retry() async {
        loading = true
        await load()
    }

    /// Change what is shown without a round trip (an item just handled).
    func update(_ change: (T) -> T) {
        if let data { self.data = change(data) }
    }
}

/// Loading, the error with a retry, or the content with pull to refresh. The
/// content should be a `List` or `ScrollView` for the pull to work.
///
/// ```swift
/// LoadedContent(loaded, loadError: BooksStrings.bankLoadError) {
///     try await books.store.bankAccounts()
/// } content: { accounts in
///     List(accounts) { … }
/// }
/// .realtimeRefresh(books.env, topics: BooksTopics.banking) { await loaded.load() }
/// ```
struct LoadedContent<T, Content: View>: View {
    let loaded: Loaded<T>
    let loadError: String
    let id: AnyHashable
    let fetch: () async throws -> T
    let content: (T) -> Content

    /// `id`: what the data depends on (a search, a period); a change loads again from scratch.
    init(
        _ loaded: Loaded<T>,
        loadError: String,
        id: AnyHashable = AnyHashable(0),
        fetch: @escaping () async throws -> T,
        @ViewBuilder content: @escaping (T) -> Content
    ) {
        self.loaded = loaded
        self.loadError = loadError
        self.id = id
        self.fetch = fetch
        self.content = content
    }

    var body: some View {
        Group {
            if let data = loaded.data {
                content(data)
            } else if loaded.loading {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity).groupedBackground()
            } else {
                VStack(spacing: 0) {
                    Banner(loadError, tone: "error")
                    LoadErrorView(error: apiError(loaded.error)) { await loaded.retry() }
                }
                .frame(maxHeight: .infinity, alignment: .top)
            }
        }
        .refreshable { await loaded.refresh() }
        .task(id: id) {
            loaded.use(key: id, fetch: fetch)
            await loaded.load()
        }
    }
}

/// A searchable, filterable list that loads page by page (Android `PagedList`).
/// Keep it in `@State`, set `fetch` before the first `load`, and call
/// `loadMore` when the last row appears.
@MainActor
@Observable
final class PagedList<T> {
    private(set) var items: [T] = []
    private(set) var loading = true
    private(set) var refreshing = false
    private(set) var loadingMore = false
    private(set) var hasMore = false
    private(set) var error: Error?

    /// `(page, search, status)` → a page, 1-based.
    @ObservationIgnored var fetch: ((Int, String?, String?) async throws -> Page<T>)?
    @ObservationIgnored private var page = 1

    init(fetch: ((Int, String?, String?) async throws -> Page<T>)? = nil) {
        self.fetch = fetch
    }

    func load(search: String?, status: String?, refresh: Bool = false) async {
        guard let fetch else { return }
        if refresh { refreshing = true }
        do {
            let result = try await fetch(1, search, status)
            items = result.items
            hasMore = result.hasMore
            page = 1
            error = nil
        } catch {
            if !Task.isCancelled { self.error = error }
        }
        loading = false
        refreshing = false
    }

    func loadMore(search: String?, status: String?) async {
        guard let fetch, hasMore, !loadingMore, !loading else { return }
        loadingMore = true
        if let result = try? await fetch(page + 1, search, status) {
            items += result.items
            hasMore = result.hasMore
            page += 1
        }
        loadingMore = false
    }
}
