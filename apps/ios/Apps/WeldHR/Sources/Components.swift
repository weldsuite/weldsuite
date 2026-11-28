import SwiftUI
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
}

/// The size of the tiles in front of a row.
let rowTile: CGFloat = 36

/// A coloured tile with an icon: a leave type, a sick day, an expense category.
struct IconTile: View {
    let symbol: String
    var background: Color = Color(.secondarySystemFill)
    var tint: Color = .secondary
    var size: CGFloat = rowTile

    var body: some View {
        Image(systemName: symbol)
            .font(.system(size: size * 0.45, weight: .semibold))
            .foregroundStyle(tint)
            .frame(width: size, height: size)
            .background(background, in: RoundedRectangle(cornerRadius: size * 0.28, style: .continuous))
            .accessibilityHidden(true)
    }
}

/// A leave type's tile: a plane on the colour HR picked, else the brand's.
struct LeaveTypeTile: View {
    let color: String?

    var body: some View {
        if let rgb = Swatches.hex(color) {
            IconTile(symbol: "airplane", background: Color(hrRGB: rgb), tint: Swatches.prefersDarkText(rgb) ? .black : .white)
        } else {
            IconTile(symbol: "airplane", background: Tokens.Brand.weldhr, tint: .white)
        }
    }
}

struct SickTile: View {
    var body: some View { IconTile(symbol: "thermometer.medium", background: Tokens.Status.danger, tint: .white) }
}

/// An expense category's icon on its colour.
struct CategoryTile: View {
    let category: String

    var body: some View {
        let rgb = Swatches.category[category] ?? Swatches.category["other"] ?? 0x6B7280
        IconTile(symbol: symbol, background: Color(hrRGB: rgb), tint: Swatches.prefersDarkText(rgb) ? .black : .white)
    }

    private var symbol: String {
        switch category {
        case "travel": "car"
        case "meals": "fork.knife"
        case "accommodation": "bed.double"
        case "equipment": "laptopcomputer"
        case "training": "graduationcap"
        default: "receipt"
        }
    }
}

/// The coloured bar in front of a shift.
struct ShiftBar: View {
    let key: String?
    var plain = false

    var body: some View {
        RoundedRectangle(cornerRadius: 2)
            .fill(plain ? Color(.systemGray4) : Color(hrRGB: Swatches.shiftColor(key)))
            .frame(width: 4, height: 36)
            .accessibilityHidden(true)
    }
}

/// A day on a small tile: "MA" over "26".
struct DateTile: View {
    let day: String

    var body: some View {
        VStack(spacing: 0) {
            Text(Fmt.weekdayShort(day).uppercased()).font(.caption2).foregroundStyle(.secondary)
            Text(HRDays.parse(day).map { String(Calendar.current.component(.day, from: $0)) } ?? "").font(.callout.weight(.bold))
        }
        .frame(width: rowTile, height: rowTile)
        .background(Color(.secondarySystemFill), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .accessibilityHidden(true)
    }
}

/// A row of the app's lists: what is on the left, the title with a coloured
/// subtitle, and a value with a detail on the right.
struct HRRow<Leading: View, Value: View>: View {
    let title: String
    var subtitle: String?
    var subtitleColor: Color = .secondary
    var subtitleLines = 1
    var detail: String?
    var detailColor: Color = .secondary
    var muted = false
    var strike = false
    @ViewBuilder var leading: () -> Leading
    @ViewBuilder var value: () -> Value

    var body: some View {
        HStack(alignment: .center, spacing: Tokens.Spacing.m) {
            leading()
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.body.weight(.semibold))
                    .foregroundStyle(muted ? .secondary : .primary)
                    .strikethrough(strike)
                    .lineLimit(2)
                if let subtitle, !subtitle.isEmpty {
                    Text(subtitle).font(.subheadline).foregroundStyle(subtitleColor).lineLimit(subtitleLines)
                }
            }
            Spacer(minLength: Tokens.Spacing.s)
            VStack(alignment: .trailing, spacing: 2) {
                value()
                if let detail { Text(detail).font(.footnote).foregroundStyle(detailColor).lineLimit(1) }
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
        self.leading = leading
        self.value = { value.map { Text($0).font(.subheadline).monospacedDigit() } }
    }
}

/// A label and its value, in a list of facts.
struct FactRow: View {
    let label: String
    let value: String

    var body: some View {
        LabeledContent(label) { Text(value).multilineTextAlignment(.trailing) }
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
        Label(text, systemImage: "clock").font(.subheadline.weight(.semibold)).monospacedDigit()
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
                    Text(label).font(.headline).foregroundStyle(.primary)
                    if let sublabel { Text(sublabel).font(.caption).foregroundStyle(.secondary) }
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

struct Segment<Value: Hashable>: Identifiable {
    let value: Value
    let label: String
    var tag: String?

    var id: Value { value }
}

/// The views of a tab (My week / Team); nothing when there is only one.
struct Segments<Value: Hashable>: View {
    let options: [Segment<Value>]
    @Binding var selection: Value

    var body: some View {
        if options.count > 1 {
            Picker("", selection: $selection) {
                ForEach(options) { option in
                    Text(option.label).tag(option.value).accessibilityIdentifier(option.tag ?? "")
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .padding(.horizontal, Tokens.Spacing.l)
            .padding(.top, Tokens.Spacing.s)
        }
    }
}

/// "Time off (2)" for a segment with work waiting.
func withCount(_ label: String, _ count: Int) -> String { count > 0 ? "\(label) (\(count))" : label }

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
                        .font(.title2)
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

/// A section head with a figure on the right (a count, a total).
struct HeadWithFigure: View {
    let title: String
    let figure: String?

    var body: some View {
        HStack {
            Text(title)
            Spacer()
            if let figure { Text(figure).monospacedDigit() }
        }
    }
}

/// "Ma 26 okt" and the day's figure, a day's head in a grouped list.
struct DayHead: View {
    let day: String
    let figure: String?

    var body: some View {
        HeadWithFigure(title: "\(Fmt.weekdayShort(day)) \(Fmt.shortDate(day))", figure: figure)
    }
}

/// The person's picture or initials.
struct PersonAvatar: View {
    let name: String?
    var url: String?
    var size: CGFloat = 34

    var body: some View {
        AvatarView(name: name, url: url.flatMap(URL.init(string:)), size: size, tint: Tokens.Brand.weldhr)
    }
}
