import Observation
import SwiftUI
import UIKit
import WeldCore
import WeldUI

// The pieces every WeldBooks screen is built from (Android `ui/Common.kt`, the
// list helpers of `HomeScreens.kt` and `FinanceScreens.kt`). Card layouts
// (`SectionCard`, `DetailRow`, …) go in a `ScrollView` + `VStack(spacing: 0)`
// with `.groupedBackground()`; list screens use `List` and `RecordRow`.

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

    /// The grouped background card screens sit on.
    func groupedBackground() -> some View {
        background(Color(uiColor: .systemGroupedBackground).ignoresSafeArea())
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

/// Accent colours per area, matching the platform's WeldBooks sidebar.
enum Accents {
    static let banking = Color(hex: 0x3B82F6)
    static let reconciliation = Color(hex: 0x8B5CF6)
    static let vat = Color(hex: 0x10B981)
    static let profitLoss = Color(hex: 0xF59E0B)
    static let balanceSheet = Color(hex: 0xEC4899)
    static let contacts = Color(hex: 0x06B6D4)
    static let settings = Color(hex: 0x6B7280)
    /// The app's brand colour (Android `Brand`).
    static let brand = Tokens.Palette.primary
}

private extension Color {
    init(hex: UInt32) {
        self.init(
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255
        )
    }
}

/// A rounded card with an optional title and action (a button on the title row).
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
                        Text(title).font(.inter(.subheadline, weight: .semibold))
                    }
                    Spacer(minLength: Tokens.Spacing.s)
                    action
                }
                .padding(.bottom, Tokens.Spacing.s)
                .padding(.horizontal, padded ? 0 : Tokens.Spacing.l)
            }
            content
        }
        .padding(.horizontal, padded ? Tokens.Spacing.l : 0)
        .padding(.vertical, padded ? Tokens.Spacing.l : Tokens.Spacing.s)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: Tokens.Radius.large))
        .padding(.horizontal, Tokens.Spacing.m)
        .padding(.vertical, Tokens.Spacing.xs + 2)
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
                .foregroundStyle(Color.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
            Text(value)
                .font(.inter(.subheadline).weight(strong ? .semibold : .regular))
                .foregroundStyle(valueColor ?? Color.primary)
                .multilineTextAlignment(.trailing)
                .frame(maxWidth: .infinity, alignment: .trailing)
                .layoutPriority(1)
        }
        .padding(.vertical, 5)
        .accessibilityElement(children: .combine)
    }
}

/// Rows of amounts and a total under a rule.
struct TotalsBlock: View {
    let rows: [(String, String)]
    let total: (String, String)

    var body: some View {
        VStack(spacing: 0) {
            ForEach(rows.indices, id: \.self) { index in
                DetailRow(rows[index].0, rows[index].1)
            }
            Divider().padding(.vertical, Tokens.Spacing.s)
            HStack {
                Text(total.0).font(.inter(.subheadline, weight: .semibold))
                Spacer()
                Text(total.1).font(.inter(.subheadline, weight: .semibold))
            }
            .accessibilityElement(children: .combine)
        }
    }
}

/// An SF Symbol on a tinted rounded tile.
struct IconTile: View {
    let systemImage: String
    let color: Color
    var size: CGFloat = 40

    var body: some View {
        Image(systemName: systemImage)
            .font(.system(size: size * 0.45, weight: .medium))
            .foregroundStyle(color)
            .frame(width: size, height: size)
            .background(color.opacity(0.12), in: RoundedRectangle(cornerRadius: size * 0.3))
            .accessibilityHidden(true)
    }
}

/// A list row: a tile, a title and subtitle, and an amount with a badge or meta line.
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
                Text(title).font(.inter(.body, weight: .semibold)).lineLimit(1)
                if let subtitle {
                    Text(subtitle).font(.inter(.footnote)).foregroundStyle(Color.secondary).lineLimit(1)
                }
                if let meta {
                    Text(meta).font(.inter(.footnote)).foregroundStyle(Color.secondary).lineLimit(1)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            VStack(alignment: .trailing, spacing: 4) {
                if let amount {
                    Text(amount).font(.inter(.body, weight: .semibold)).foregroundStyle(amountColor ?? Color.primary)
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

/// The colour of a status's tone (`Statuses.tone`).
func statusColor(_ status: String) -> Color {
    switch Statuses.tone(status) {
    case "success": return Tokens.Status.success
    case "warning": return Tokens.Status.warning
    case "danger": return Tokens.Status.danger
    case "neutral": return Color.secondary
    default: return Accents.brand
    }
}

/// A status as a coloured label.
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

/// A notice in the flow of a screen: `info`, `success`, `warning` or `error`.
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

    private var color: Color {
        switch tone {
        case "success": return Tokens.Status.success
        case "warning": return Tokens.Status.warning
        case "error": return Tokens.Status.danger
        default: return Accents.brand
        }
    }

    var body: some View {
        HStack(alignment: .top, spacing: Tokens.Spacing.s) {
            VStack(alignment: .leading, spacing: 2) {
                if let title {
                    Text(title).font(.inter(.subheadline, weight: .semibold)).foregroundStyle(color)
                }
                Text(text).font(.inter(.subheadline))
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if let onClose {
                Button(action: onClose) {
                    Image(systemName: "xmark").font(.inter(.caption, weight: .semibold))
                }
                .buttonStyle(.plain)
                .foregroundStyle(Color.secondary)
                .accessibilityLabel(CoreStrings.commonClose)
            }
        }
        .padding(Tokens.Spacing.m)
        .background(color.opacity(0.1), in: RoundedRectangle(cornerRadius: Tokens.Radius.medium))
        .padding(.horizontal, Tokens.Spacing.m)
        .padding(.vertical, Tokens.Spacing.xs)
    }
}

/// A small heading over a group of cards.
struct GroupLabel: View {
    let text: String

    init(_ text: String) {
        self.text = text
    }

    var body: some View {
        Text(text)
            .font(.inter(.footnote, weight: .semibold))
            .foregroundStyle(Color.secondary)
            .textCase(.uppercase)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.leading, Tokens.Spacing.xl)
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
            .font(.inter(.footnote))
            .foregroundStyle(Color.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 4)
    }
}

/// Shown instead of a screen the company's country doesn't have (Android `FeatureUnavailable`).
struct FeatureUnavailableView: View {
    var body: some View {
        ContentUnavailableView(
            BooksStrings.commonNotAvailableTitle,
            systemImage: "lock",
            description: Text(BooksStrings.commonNotAvailableDescription)
        )
        .navigationTitle(BooksStrings.commonNotAvailableTitle)
        .navigationBarTitleDisplayMode(.inline)
    }
}

/// A search box and a row of filter chips that scrolls sideways (identifiers `search`, `filter-<key>`).
struct SearchAndFilters: View {
    @Binding var search: String
    let placeholder: String
    let filters: [Choice]
    @Binding var selected: String

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Spacing.s) {
            HStack(spacing: Tokens.Spacing.s) {
                Image(systemName: "magnifyingglass").foregroundStyle(Color.secondary)
                TextField(placeholder, text: $search)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.search)
                    .tagged("search")
                if !search.isEmpty {
                    Button {
                        search = ""
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(Color.secondary)
                    .accessibilityLabel(CoreStrings.commonClose)
                }
            }
            .padding(.horizontal, Tokens.Spacing.m)
            .padding(.vertical, Tokens.Spacing.s)
            .background(Color(uiColor: .tertiarySystemFill), in: RoundedRectangle(cornerRadius: Tokens.Radius.medium))

            if !filters.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(filters) { choice in
                            let on = choice.key == selected
                            Button {
                                selected = choice.key
                            } label: {
                                Text(choice.label)
                                    .font(.inter(.subheadline, weight: .medium))
                                    .padding(.horizontal, Tokens.Spacing.m)
                                    .padding(.vertical, 6)
                                    .foregroundStyle(on ? Color.white : Color.primary)
                                    .background(on ? Accents.brand : Color(uiColor: .secondarySystemFill), in: Capsule())
                            }
                            .buttonStyle(.plain)
                            .accessibilityAddTraits(on ? .isSelected : [])
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
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
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
