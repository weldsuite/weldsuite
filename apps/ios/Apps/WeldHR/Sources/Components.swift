import SwiftUI
import UIKit
import WeldCore
import WeldUI

extension Color {
    /// `0xRRGGBB`.
    init(hrRGB rgb: UInt32) {
        self.init(
            red: Double((rgb >> 16) & 0xFF) / 255,
            green: Double((rgb >> 8) & 0xFF) / 255,
            blue: Double(rgb & 0xFF) / 255
        )
    }

    /// A platform colour with its dark-mode variant (`0xRRGGBB` each).
    init(hrLight light: UInt32, dark: UInt32) {
        func ui(_ rgb: UInt32) -> UIColor {
            UIColor(
                red: CGFloat((rgb >> 16) & 0xFF) / 255,
                green: CGFloat((rgb >> 8) & 0xFF) / 255,
                blue: CGFloat(rgb & 0xFF) / 255,
                alpha: 1
            )
        }
        self.init(uiColor: UIColor { traits in traits.userInterfaceStyle == .dark ? ui(dark) : ui(light) })
    }
}

/// The platform's badge (`@weldsuite/ui` Badge): a pill in one of its four variants.
/// WeldHR's statuses use these, not tinted colours.
struct ToneBadge: View {
    let text: String
    let tone: Tone
    @Environment(\.colorScheme) private var scheme

    init(_ text: String, tone: Tone) {
        self.text = text
        self.tone = tone
    }

    var body: some View {
        Text(text)
            .font(.inter(.caption, weight: .medium))
            .foregroundStyle(ink)
            .lineLimit(1)
            .fixedSize()
            .padding(.horizontal, Tokens.Spacing.s)
            .padding(.vertical, 2)
            .background(fill, in: Capsule())
            .overlay {
                if tone == .outline { Capsule().strokeBorder(Tokens.Palette.border, lineWidth: 1) }
            }
    }

    private var fill: Color {
        switch tone {
        case .primary: Tokens.Palette.primary
        case .secondary: Tokens.Palette.secondary
        case .destructive: scheme == .dark ? Tokens.Status.danger.opacity(0.6) : Tokens.Status.danger
        case .outline: .clear
        }
    }

    private var ink: Color {
        switch tone {
        case .primary: Tokens.Palette.primaryForeground
        case .secondary: Tokens.Palette.secondaryForeground
        case .destructive: .white
        case .outline: Tokens.Palette.foreground
        }
    }
}

/// A WeldHR status as the platform's badge: its label, in the variant the platform gives it.
struct HRTag {
    let text: String
    let tone: Tone

    static func status(_ status: String, _ label: String) -> HRTag { HRTag(text: label, tone: .of(status)) }
}

/// A leave type's colour dot (the platform's `ColorDot`); neutral grey without a colour.
struct ColorDot: View {
    let color: String?
    var size: CGFloat = 8

    var body: some View {
        Circle().fill(Color(hrRGB: Swatches.dot(color))).frame(width: size, height: size).accessibilityHidden(true)
    }
}

/// An evaluation score (0-100) in its colour band, as the platform's `ScoreBadge`.
struct ScoreBadge: View {
    let score: Double

    var body: some View {
        let band = colors
        Text(String(format: "%.1f", score))
            .font(.inter(.caption, weight: .medium))
            .monospacedDigit()
            .foregroundStyle(band.ink)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(band.fill, in: RoundedRectangle(cornerRadius: Tokens.Radius.small))
    }

    /// Emerald, sky, amber and red: -100 fill and -800 text, -950 and -300 when dark.
    private var colors: (fill: Color, ink: Color) {
        switch Swatches.scoreBand(score) {
        case 0: return (Color(hrLight: 0xD1FAE5, dark: 0x022C22), Color(hrLight: 0x065F46, dark: 0x6EE7B7))
        case 1: return (Color(hrLight: 0xE0F2FE, dark: 0x082F49), Color(hrLight: 0x075985, dark: 0x7DD3FC))
        case 2: return (Color(hrLight: 0xFEF3C7, dark: 0x451A03), Color(hrLight: 0x92400E, dark: 0xFCD34D))
        default: return (Color(hrLight: 0xFEE2E2, dark: 0x450A0A), Color(hrLight: 0x991B1B, dark: 0xFCA5A5))
        }
    }
}

/// The coloured bar in front of a shift: its client's colour, the default blue without one.
struct ShiftBar: View {
    let client: String?

    var body: some View {
        RoundedRectangle(cornerRadius: 2)
            .fill(Color(hrRGB: Swatches.shiftColor(client)))
            .frame(width: 4, height: 36)
            .accessibilityHidden(true)
    }
}

/// A count in the platform's small mono chip, beside a group head or a tab.
struct CountChip: View {
    let count: Int

    var body: some View {
        Text("\(count)")
            .font(.system(size: 10, design: .monospaced))
            .foregroundStyle(Tokens.Palette.mutedForeground)
            .padding(.horizontal, 4)
            .frame(minWidth: 16, minHeight: 16)
            .background(Tokens.Palette.muted, in: RoundedRectangle(cornerRadius: 5))
            .overlay(RoundedRectangle(cornerRadius: 5).strokeBorder(Tokens.Palette.border, lineWidth: 1))
    }
}

/// A leave type's dot before a title or a subtitle.
struct HRDot {
    var color: String?
}

/// A row of the app's lists, as the platform's list rows: what is on the left,
/// the title (medium, with a dot or symbol in front) over a muted line, and a
/// value, detail and badge on the right.
struct HRRow<Leading: View, Value: View>: View {
    let title: String
    var subtitle: String?
    var subtitleColor: Color = .secondary
    var subtitleLines = 1
    var detail: String?
    var detailColor: Color = .secondary
    var muted = false
    var strike = false
    var unread = false
    var dot: HRDot?
    var symbol: String?
    var subtitleDot: HRDot?
    var subtitleSymbol: String?
    var tag: HRTag?
    @ViewBuilder var leading: () -> Leading
    @ViewBuilder var value: () -> Value

    var body: some View {
        HStack(alignment: .center, spacing: Tokens.Spacing.m) {
            leading()
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    if let dot { ColorDot(color: dot.color) }
                    if let symbol { Image(systemName: symbol).font(.system(size: 12)).foregroundStyle(.secondary) }
                    Text(title)
                        .font(.inter(size: 15, weight: unread ? .semibold : .medium))
                        .foregroundStyle(muted ? .secondary : .primary)
                        .strikethrough(strike)
                        .lineLimit(2)
                }
                if let subtitle, !subtitle.isEmpty {
                    HStack(spacing: 6) {
                        if let subtitleDot { ColorDot(color: subtitleDot.color) }
                        if let subtitleSymbol { Image(systemName: subtitleSymbol).font(.system(size: 11)).foregroundStyle(.secondary) }
                        Text(subtitle).font(.inter(.footnote)).foregroundStyle(subtitleColor).lineLimit(subtitleLines)
                    }
                }
            }
            Spacer(minLength: Tokens.Spacing.s)
            VStack(alignment: .trailing, spacing: 4) {
                value()
                if let detail { Text(detail).font(.inter(.caption)).foregroundStyle(detailColor).lineLimit(1) }
                if let tag { ToneBadge(tag.text, tone: tag.tone) }
            }
        }
        .contentShape(Rectangle())
    }
}

extension HRRow where Value == Text? {
    init(
        title: String,
        subtitle: String? = nil,
        subtitleColor: Color = .secondary,
        subtitleLines: Int = 1,
        value: String? = nil,
        detail: String? = nil,
        detailColor: Color = .secondary,
        muted: Bool = false,
        strike: Bool = false,
        unread: Bool = false,
        dot: HRDot? = nil,
        symbol: String? = nil,
        subtitleDot: HRDot? = nil,
        subtitleSymbol: String? = nil,
        tag: HRTag? = nil,
        @ViewBuilder leading: @escaping () -> Leading
    ) {
        self.title = title
        self.subtitle = subtitle
        self.subtitleColor = subtitleColor
        self.subtitleLines = subtitleLines
        self.detail = detail
        self.detailColor = detailColor
        self.muted = muted
        self.strike = strike
        self.unread = unread
        self.dot = dot
        self.symbol = symbol
        self.subtitleDot = subtitleDot
        self.subtitleSymbol = subtitleSymbol
        self.tag = tag
        self.leading = leading
        self.value = { value.map { Text($0).font(.inter(.subheadline)).monospacedDigit() } }
    }
}

extension HRRow where Leading == EmptyView, Value == Text? {
    /// A row with nothing in front of the title.
    init(
        title: String,
        subtitle: String? = nil,
        subtitleColor: Color = .secondary,
        subtitleLines: Int = 1,
        value: String? = nil,
        detail: String? = nil,
        detailColor: Color = .secondary,
        muted: Bool = false,
        strike: Bool = false,
        unread: Bool = false,
        dot: HRDot? = nil,
        symbol: String? = nil,
        subtitleDot: HRDot? = nil,
        subtitleSymbol: String? = nil,
        tag: HRTag? = nil
    ) {
        self.init(
            title: title, subtitle: subtitle, subtitleColor: subtitleColor, subtitleLines: subtitleLines,
            value: value, detail: detail, detailColor: detailColor, muted: muted, strike: strike, unread: unread,
            dot: dot, symbol: symbol, subtitleDot: subtitleDot, subtitleSymbol: subtitleSymbol, tag: tag
        ) { EmptyView() }
    }
}

/// A label and its value, as the platform's property rows: the label in a muted column, the value beside it.
struct FactRow: View {
    let label: String
    let value: String

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Tokens.Spacing.s) {
            Text(label).font(.inter(.subheadline)).foregroundStyle(.secondary).frame(width: 128, alignment: .leading)
            Text(value).font(.inter(.subheadline)).frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

/// The facts of a detail page, the empty ones left out.
struct Facts: View {
    let rows: [(String, String?)]

    var body: some View {
        ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
            if let value = row.1, !value.isEmpty { FactRow(label: row.0, value: value) }
        }
    }
}

/// A time with the clock glyph in front, for hours still counting.
struct Running: View {
    let text: String

    var body: some View {
        Label(text, systemImage: "clock").font(.inter(.subheadline, weight: .medium)).monospacedDigit()
    }
}

/// Now, in milliseconds since 1970 (what ShiftMath counts in).
func nowMillis() -> Double { Date().timeIntervalSince1970 * 1000 }

/// A week, a year or a day, with the arrows to go back and forth.
struct PeriodNav: View {
    let label: String
    var sublabel: String?
    let onPrevious: () -> Void
    let onNext: (() -> Void)?
    var onLabel: (() -> Void)?

    var body: some View {
        HStack {
            Button(action: onPrevious) { Image(systemName: "chevron.left") }
                .accessibilityLabel(HRStrings.calendarPrevious)
                .accessibilityIdentifier("period-previous")
            Spacer()
            Button { onLabel?() } label: {
                VStack(spacing: 0) {
                    Text(label).font(.inter(.headline)).foregroundStyle(.primary)
                    if let sublabel { Text(sublabel).font(.inter(.caption)).foregroundStyle(.secondary) }
                }
            }
            .disabled(onLabel == nil)
            .accessibilityIdentifier("period-label")
            Spacer()
            Button { onNext?() } label: { Image(systemName: "chevron.right") }
                .disabled(onNext == nil)
                .accessibilityLabel(HRStrings.calendarNext)
                .accessibilityIdentifier("period-next")
        }
        .buttonStyle(.borderless)
        .padding(.horizontal, Tokens.Spacing.l)
        .padding(.vertical, Tokens.Spacing.s)
    }
}

/// A view of a tab; `count` is work waiting there, shown in a chip.
struct Segment<Value: Hashable>: Identifiable {
    let value: Value
    let label: String
    var tag: String?
    var count = 0

    var id: Value { value }
}

/// The views of a tab (My week / Team), as the platform's page tabs: medium
/// labels, muted until picked, a 2pt foreground underline; nothing when there
/// is only one. Put it in a list row of its own (`segmentsRow()`).
struct Segments<Value: Hashable>: View {
    let options: [Segment<Value>]
    @Binding var selection: Value

    var body: some View {
        if options.count > 1 {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: Tokens.Spacing.l) {
                    ForEach(options) { option in
                        let picked = option.value == selection
                        Button { selection = option.value } label: {
                            HStack(spacing: Tokens.Spacing.s) {
                                Text(option.label).font(.inter(.subheadline, weight: .medium))
                                if option.count > 0 { CountChip(count: option.count) }
                            }
                            .foregroundStyle(picked ? Tokens.Palette.foreground : Tokens.Palette.mutedForeground)
                            .padding(.vertical, Tokens.Spacing.s)
                            .overlay(alignment: .bottom) {
                                if picked { Rectangle().fill(Tokens.Palette.foreground).frame(height: 2) }
                            }
                        }
                        .buttonStyle(.plain)
                        .accessibilityAddTraits(picked ? .isSelected : [])
                        .accessibilityIdentifier(option.tag ?? "")
                    }
                }
                .padding(.horizontal, Tokens.Spacing.l)
            }
            .overlay(alignment: .bottom) { Rectangle().fill(Tokens.Palette.border).frame(height: 1) }
        }
    }
}

extension View {
    /// A list row that runs edge to edge without a separator: the tabs, a group head.
    func segmentsRow() -> some View {
        listRowInsets(EdgeInsets()).listRowSeparator(.hidden)
    }
}

/// An empty list, as the platform's: the icon in a muted rounded square, a
/// semibold title and a muted description, with the action under it.
struct HREmpty<Actions: View>: View {
    let title: String
    var description: String?
    var symbol: String?
    @ViewBuilder var actions: () -> Actions

    var body: some View {
        ContentUnavailableView {
            VStack(spacing: Tokens.Spacing.m) {
                if let symbol {
                    Image(systemName: symbol)
                        .font(.system(size: 22))
                        .foregroundStyle(Tokens.Palette.mutedForeground)
                        .frame(width: 48, height: 48)
                        .background(Tokens.Palette.muted, in: RoundedRectangle(cornerRadius: Tokens.Radius.large))
                }
                Text(title).font(.inter(size: 15, weight: .semibold))
            }
        } description: {
            if let description { Text(description).font(.inter(.subheadline)) }
        } actions: {
            actions()
        }
    }
}

extension HREmpty where Actions == EmptyView {
    init(_ title: String, description: String? = nil, symbol: String? = nil) {
        self.init(title: title, description: description, symbol: symbol) { EmptyView() }
    }
}

/// What a list shows while loading or after a failure; the content once there is data.
struct QueryBody<T, Content: View>: View {
    let state: LoadState<T>
    let retry: () async -> Void
    @ViewBuilder let content: (T) -> Content

    var body: some View {
        if let data = state.data {
            content(data)
        } else if state.error != nil {
            LoadErrorView(error: state.error, retry: retry)
        } else {
            ProgressView().frame(maxWidth: .infinity).padding(.vertical, 40)
        }
    }
}

/// My HR's gate: without `employees:self` or a linked employee record there is nothing to show.
struct SelfGate<Content: View>: View {
    let state: SelfState
    let retry: () async -> Void
    @ViewBuilder let content: (HRProfile, HRFeatures) -> Content

    var body: some View {
        switch state {
        case .loading:
            ProgressView().frame(maxWidth: .infinity).padding(.vertical, 40)
        case .noAccess:
            ContentUnavailableView(HRStrings.notLinkedNoAccessTitle, systemImage: "person.slash", description: Text(HRStrings.notLinkedNoAccessDescription))
        case .notLinked:
            ContentUnavailableView(HRStrings.notLinkedTitle, systemImage: "person.crop.circle.badge.questionmark", description: Text(HRStrings.notLinkedDescription))
        case let .failed(error):
            LoadErrorView(error: error, retry: retry)
        case let .ready(profile, features):
            content(profile, features)
        }
    }
}

/// A search field with the filter button beside it.
struct SearchBox: View {
    @Binding var text: String
    let placeholder: String
    var filtered = false
    var onFilter: (() -> Void)?
    let tag: String

    var body: some View {
        HStack {
            HStack {
                Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                TextField(placeholder, text: $text)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .accessibilityIdentifier("\(tag)-search")
                if !text.isEmpty {
                    Button { text = "" } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary) }
                        .accessibilityLabel(HRStrings.commonClearSearch)
                }
            }
            .padding(Tokens.Spacing.s)
            .background(Color(.secondarySystemFill), in: RoundedRectangle(cornerRadius: Tokens.Radius.small))
            if let onFilter {
                Button(action: onFilter) {
                    Image(systemName: filtered ? "line.3.horizontal.decrease.circle.fill" : "line.3.horizontal.decrease.circle")
                        .font(.inter(.title2))
                }
                .accessibilityLabel(HRStrings.commonFilter)
                .accessibilityIdentifier("\(tag)-filter")
            }
        }
        .buttonStyle(.borderless)
    }
}

/// Nothing matches the search or the filter, with the ways out.
struct NoMatches: View {
    let title: String
    let description: String
    let filtered: Bool
    let clearFilters: () -> Void
    let clearSearch: () -> Void

    var body: some View {
        ContentUnavailableView {
            Label(title, systemImage: "magnifyingglass")
        } description: {
            Text(description)
        } actions: {
            if filtered { Button(HRStrings.commonClearFilters, action: clearFilters) }
            Button(HRStrings.commonClearSearch, action: clearSearch)
        }
    }
}

/// A switch per option, all on to begin with; `off` are the ones switched off.
struct FilterSheet: View {
    let options: [(String, String)]
    let off: Set<String>
    let onApply: (Set<String>) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var hidden: Set<String> = []

    var body: some View {
        NavigationStack {
            List {
                ForEach(options, id: \.0) { option in
                    Toggle(option.1, isOn: Binding(
                        get: { !hidden.contains(option.0) },
                        set: { on in if on { hidden.remove(option.0) } else { hidden.insert(option.0) } }
                    ))
                    .accessibilityIdentifier("filter-\(option.0)")
                }
            }
            .navigationTitle(HRStrings.commonFilter)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button(hidden.isEmpty ? HRStrings.commonDisableAll : HRStrings.commonEnableAll) {
                        hidden = hidden.isEmpty ? Set(options.map(\.0)) : []
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(HRStrings.commonApply) {
                        onApply(hidden)
                        dismiss()
                    }
                    .accessibilityIdentifier("filter-apply")
                }
            }
        }
        .presentationDetents([.medium, .large])
        .onAppear { hidden = off }
    }
}

/// A group's head, as the platform's list groups: a small muted label with its
/// count in a chip, and a figure on the right (a total, a range). Use it as a
/// section header.
struct GroupHead: View {
    let title: String
    var count: Int?
    var figure: String?

    var body: some View {
        HStack(spacing: Tokens.Spacing.s) {
            Text(title).font(.inter(.caption, weight: .medium)).foregroundStyle(Tokens.Palette.mutedForeground).lineLimit(1)
            if let count { CountChip(count: count) }
            Spacer(minLength: Tokens.Spacing.s)
            if let figure { Text(figure).font(.inter(.caption)).foregroundStyle(Tokens.Palette.mutedForeground).monospacedDigit().lineLimit(1) }
        }
        .textCase(nil)
        .padding(.horizontal, Tokens.Spacing.l)
        .frame(minHeight: 32)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Tokens.Palette.muted.opacity(0.5))
        .overlay(alignment: .bottom) { Rectangle().fill(Tokens.Palette.border.opacity(0.7)).frame(height: 1) }
        .listRowInsets(EdgeInsets())
    }
}

/// A section head with a figure on the right (a total), as the platform's group head.
struct HeadWithFigure: View {
    let title: String
    let figure: String?

    var body: some View { GroupHead(title: title, figure: figure) }
}

/// "Ma 26 okt" and the day's figure or count, a day's head in a grouped list.
struct DayHead: View {
    let day: String
    var figure: String?
    var count: Int?

    var body: some View {
        GroupHead(title: "\(Fmt.weekdayShort(day)) \(Fmt.shortDate(day))", count: count, figure: figure)
    }
}

/// The person's picture or initials.
struct PersonAvatar: View {
    let name: String?
    var url: String?
    var size: CGFloat = 34

    var body: some View {
        AvatarView(name: name, url: url.flatMap(URL.init(string:)), size: size)
    }
}
