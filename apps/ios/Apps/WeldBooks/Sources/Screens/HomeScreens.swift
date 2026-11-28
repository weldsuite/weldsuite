import SwiftUI
import WeldCore
import WeldUI

// The tab roots: the dashboard, the invoice and expense lists, and the More
// menu (Android `ui/HomeScreens.kt`).

// MARK: - Dashboard

/// The open company at a glance: what is owed and overdue, what is to pay,
/// this month's profit, quick actions and the latest invoices. Captures still
/// waiting for a connection are named at the top.
struct DashboardView: View {
    @Environment(Books.self) private var books
    @Environment(BooksNavigator.self) private var navigator
    @State private var data: Dashboard?
    @State private var error: Error?

    init() {}

    var body: some View {
        let entities = books.entities
        content
            .navigationTitle(books.entity?.name ?? BooksStrings.appName)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    if entities.canSwitch {
                        Button {
                            entities.openSwitcher()
                        } label: {
                            Label(BooksStrings.administrationsTitle, systemImage: "building.2")
                                .labelStyle(.iconOnly)
                        }
                        .tagged("title-switcher")
                    }
                }
            }
            .task { await load() }
            .realtimeRefresh(books.env, topics: BooksTopics.dashboard) { await load() }
    }

    @ViewBuilder
    private var content: some View {
        if data == nil, let error {
            LoadErrorView(error: apiError(error)) { await load() }
        } else {
            ScrollView {
                VStack(spacing: 0) {
                    queueBanner
                    if let data {
                        HomeKpiGrid(data: data)
                    } else {
                        ProgressView()
                            .frame(maxWidth: .infinity)
                            .padding(Tokens.Spacing.xl)
                    }
                    HomeQuickActions()
                    if let data {
                        recent(data)
                    }
                }
                .padding(.bottom, Tokens.Spacing.xl)
            }
            .groupedBackground()
            .refreshable { await load() }
            .tagged("dashboard")
        }
    }

    /// Offline, or captures still waiting to be stored.
    @ViewBuilder
    private var queueBanner: some View {
        let online = books.queue.isOnline
        let waiting = books.queue.items.filter { $0.workspaceId == books.workspaceId }.count
        if !online || waiting > 0 {
            Banner(
                online ? BooksStrings.dashboardItemsWaiting(waiting) : BooksStrings.dashboardOfflineQueued(waiting),
                tone: online ? "info" : "warning"
            )
        }
    }

    @ViewBuilder
    private func recent(_ data: Dashboard) -> some View {
        let invoices = Array(data.recentInvoices.prefix(8))
        if invoices.isEmpty {
            ContentUnavailableView(
                BooksStrings.dashboardNoInvoicesTitle,
                systemImage: "doc.text",
                description: Text(BooksStrings.dashboardNoInvoicesDescription)
            )
        } else {
            SectionCard(padded: false) {
                ForEach(Array(invoices.enumerated()), id: \.element.id) { index, invoice in
                    if index > 0 {
                        Divider().padding(.leading, 68)
                    }
                    HomeInvoiceRow(invoice: invoice, fallbackCurrency: data.currency) {
                        navigator.open(.invoice(id: invoice.id))
                    }
                    .padding(.horizontal, Tokens.Spacing.l)
                }
            }
        }
    }

    private func load() async {
        do {
            data = try await books.store.dashboard()
            error = nil
        } catch {
            // A failed refresh keeps the figures shown; a screen that went away isn't a failure.
            if !Task.isCancelled { self.error = error }
        }
    }
}

/// Outstanding, overdue, payables and this month's profit, two by two.
private struct HomeKpiGrid: View {
    let data: Dashboard

    @Environment(Books.self) private var books
    @Environment(BooksNavigator.self) private var navigator

    var body: some View {
        VStack(spacing: Tokens.Spacing.s) {
            HStack(spacing: Tokens.Spacing.s) {
                HomeKpiCard(
                    label: BooksStrings.dashboardOutstanding,
                    value: books.compactMoney(data.outstanding, currency: data.currency),
                    sub: BooksStrings.dashboardInvoiceCount(data.outstandingCount),
                    warn: false,
                    tag: "kpi-outstanding",
                    onTap: { navigator.open(.invoices) }
                )
                HomeKpiCard(
                    label: BooksStrings.dashboardOverdue,
                    value: books.compactMoney(data.overdue, currency: data.currency),
                    sub: BooksStrings.dashboardInvoiceCount(data.overdueCount),
                    warn: data.overdue > 0,
                    tag: "kpi-overdue",
                    onTap: { navigator.open(.invoices) }
                )
            }
            HStack(spacing: Tokens.Spacing.s) {
                HomeKpiCard(
                    label: BooksStrings.dashboardPayables,
                    value: books.compactMoney(data.payables, currency: data.currency),
                    sub: BooksStrings.dashboardBillCount(data.payablesCount),
                    warn: false,
                    tag: "kpi-payables",
                    onTap: { navigator.open(.expenses) }
                )
                HomeKpiCard(
                    label: BooksStrings.dashboardProfit,
                    value: books.compactMoney(data.profitMonth, currency: data.currency),
                    sub: BooksStrings.dashboardThisMonth,
                    warn: false,
                    tag: "kpi-profit",
                    onTap: nil
                )
            }
        }
        .padding(.horizontal, Tokens.Spacing.m)
        .padding(.top, Tokens.Spacing.s)
    }
}

/// One figure on the dashboard; a tap opens the list behind it.
private struct HomeKpiCard: View {
    let label: String
    let value: String
    let sub: String
    let warn: Bool
    let tag: String
    let onTap: (() -> Void)?

    var body: some View {
        if let onTap {
            Button(action: onTap) { card }
                .buttonStyle(.plain)
                .tagged(tag)
        } else {
            card.tagged(tag)
        }
    }

    private var card: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label)
                .font(.inter(.footnote, weight: .medium))
                .foregroundStyle(Color.secondary)
                .lineLimit(1)
            Text(value)
                .font(.inter(.title3, weight: .bold))
                .foregroundStyle(warn ? Tokens.Status.danger : Color.primary)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
            Text(sub)
                .font(.inter(.caption))
                .foregroundStyle(Color.secondary)
                .lineLimit(1)
        }
        .padding(Tokens.Spacing.l)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: Tokens.Radius.large))
        .contentShape(RoundedRectangle(cornerRadius: Tokens.Radius.large))
        .accessibilityElement(children: .combine)
    }
}

/// New invoice, quick expense, scan, reports.
private struct HomeQuickActions: View {
    @Environment(BooksNavigator.self) private var navigator

    private struct QuickAction: Identifiable {
        let label: String
        let systemImage: String
        let route: Route
        let tag: String
        var id: String { tag }
    }

    private var actions: [QuickAction] {
        [
            QuickAction(label: BooksStrings.dashboardInvoice, systemImage: "doc.text", route: .newInvoice, tag: "action-invoice"),
            QuickAction(label: BooksStrings.dashboardExpense, systemImage: "list.bullet.rectangle", route: Route.quickExpenseBlank, tag: "action-expense"),
            QuickAction(label: BooksStrings.dashboardScan, systemImage: "camera", route: .scan, tag: "action-scan"),
            QuickAction(label: BooksStrings.dashboardReports, systemImage: "chart.bar", route: .reports, tag: "action-reports"),
        ]
    }

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            ForEach(actions) { action in
                Button {
                    navigator.open(action.route)
                } label: {
                    VStack(spacing: Tokens.Spacing.s) {
                        IconTile(systemImage: action.systemImage, color: Accents.brand, size: 52)
                        Text(action.label)
                            .font(.inter(.footnote, weight: .medium))
                            .foregroundStyle(Color.secondary)
                            .lineLimit(1)
                            .minimumScaleFactor(0.8)
                    }
                    .frame(maxWidth: .infinity)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityElement(children: .combine)
                .tagged(action.tag)
            }
        }
        .padding(.horizontal, Tokens.Spacing.s)
        .padding(.vertical, Tokens.Spacing.l)
    }
}

/// An invoice in a list. With `onTap` it is its own button (`invoice-row`); without, the caller wraps it in a link.
private struct HomeInvoiceRow: View {
    let invoice: Invoice
    let fallbackCurrency: String?
    var onTap: (() -> Void)?

    @Environment(Books.self) private var books

    var body: some View {
        let draft = BooksStrings.commonDraft
        RecordRow(
            title: invoice.contactName ?? invoice.number ?? draft,
            subtitle: invoice.number ?? draft,
            meta: BooksStrings.commonDueOn(date: books.shortDate(invoice.dueDate)),
            amount: books.money(invoice.total, currency: invoice.currency ?? fallbackCurrency),
            tag: onTap == nil ? nil : "invoice-row",
            onTap: onTap,
            leading: { IconTile(systemImage: "doc.text", color: Accents.brand) },
            badge: { StatusPill(invoice.displayStatus()) }
        )
    }
}

/// A bill in a list; the caller wraps it in a link.
private struct HomeBillRow: View {
    let bill: Bill

    @Environment(Books.self) private var books

    var body: some View {
        RecordRow(
            title: bill.contactName ?? BooksStrings.expensesUnknownVendor(supplier: books.labels.supplierLower),
            subtitle: bill.number ?? BooksStrings.commonDraft,
            meta: BooksStrings.commonDueOn(date: books.shortDate(bill.dueDate)),
            amount: books.money(bill.total, currency: bill.currency),
            leading: { IconTile(systemImage: "list.bullet.rectangle", color: Accents.brand) },
            badge: { StatusPill(bill.displayStatus()) }
        )
    }
}

// MARK: - Invoices

/// Every invoice, searchable and filtered by status (`overdue` is worked out here: the server derives it).
struct InvoicesView: View {
    @Environment(Books.self) private var books

    init() {}

    var body: some View {
        let store = books.store
        HomeDocumentList(
            config: HomeListConfig<Invoice>(
                title: BooksStrings.invoicesTitle,
                newLabel: BooksStrings.invoicesNewInvoice,
                newRoute: .newInvoice,
                searchPlaceholder: BooksStrings.invoicesSearchPlaceholder,
                filters: [
                    Choice("all", BooksStrings.invoicesFilterAll),
                    Choice("draft", BooksStrings.invoicesFilterDraft),
                    Choice("sent", BooksStrings.invoicesFilterSent),
                    Choice("overdue", BooksStrings.invoicesFilterOverdue),
                    Choice("paid", BooksStrings.invoicesFilterPaid),
                ],
                topics: BooksTopics.invoices,
                // `overdue` is derived, not a stored status: it is filtered here.
                statusFor: { key in ["draft", "sent", "paid"].contains(key) ? key : nil },
                fetch: { page, search, status in
                    try await store.invoices(page: page, pageSize: 20, search: search, status: status)
                },
                keep: { invoice, filter in filter != "overdue" || invoice.displayStatus() == "overdue" },
                route: { invoice in Route.invoice(id: invoice.id) },
                rowTag: "invoice-row",
                emptyIcon: "doc.text",
                emptyTitle: BooksStrings.invoicesEmptyTitle,
                emptyDescription: BooksStrings.invoicesEmptyDescription,
                noMatchTitle: BooksStrings.invoicesNoMatchTitle,
                noMatchDescription: BooksStrings.invoicesNoMatchDescription,
                loadError: BooksStrings.invoicesLoadError,
                tag: "invoices"
            )
        ) { invoice in
            HomeInvoiceRow(invoice: invoice, fallbackCurrency: nil)
        }
    }
}

// MARK: - Expenses

/// Every bill, searchable and filtered by status. A bill awaiting approval is a draft on the server.
struct ExpensesView: View {
    @Environment(Books.self) private var books

    init() {}

    var body: some View {
        let store = books.store
        HomeDocumentList(
            config: HomeListConfig<Bill>(
                title: BooksStrings.expensesTitle,
                newLabel: BooksStrings.expensesAddExpense,
                newRoute: Route.quickExpenseBlank,
                searchPlaceholder: BooksStrings.expensesSearchPlaceholder,
                filters: [
                    Choice("all", BooksStrings.expensesFilterAll),
                    Choice("draft", BooksStrings.expensesFilterDraft),
                    Choice("pending", BooksStrings.expensesFilterPending),
                    Choice("approved", BooksStrings.expensesFilterApproved),
                    Choice("overdue", BooksStrings.expensesFilterOverdue),
                    Choice("paid", BooksStrings.expensesFilterPaid),
                ],
                topics: BooksTopics.bills,
                // A bill awaiting approval is a draft on the server; `overdue` is derived here.
                statusFor: { key in
                    switch key {
                    case "pending": return "draft"
                    case "draft", "approved", "paid": return key
                    default: return nil
                    }
                },
                fetch: { page, search, status in
                    try await store.bills(page: page, pageSize: 20, search: search, status: status)
                },
                keep: { bill, filter in filter != "overdue" || bill.displayStatus() == "overdue" },
                route: { bill in Route.bill(id: bill.id) },
                rowTag: "bill-row",
                emptyIcon: "list.bullet.rectangle",
                emptyTitle: BooksStrings.expensesEmptyTitle,
                emptyDescription: BooksStrings.expensesEmptyDescription,
                noMatchTitle: BooksStrings.expensesNoMatchTitle,
                noMatchDescription: BooksStrings.expensesNoMatchDescription,
                loadError: BooksStrings.expensesLoadError,
                tag: "expenses"
            )
        ) { bill in
            HomeBillRow(bill: bill)
        }
    }
}

// MARK: - The document lists

/// What tells the invoice list from the expense list.
private struct HomeListConfig<T: Identifiable> {
    var title: String
    var newLabel: String
    var newRoute: Route
    var searchPlaceholder: String
    var filters: [Choice]
    var topics: [String]
    /// The server status a filter chip asks for; nil for all (or a status worked out here).
    var statusFor: (String) -> String?
    var fetch: (Int, String?, String?) async throws -> Page<T>
    /// Whether a loaded item shows under a filter (for the derived `overdue`).
    var keep: (T, String) -> Bool
    var route: (T) -> Route
    var rowTag: String
    var emptyIcon: String
    var emptyTitle: String
    var emptyDescription: String
    var noMatchTitle: String
    var noMatchDescription: String
    var loadError: String
    /// The list's identifier; `<tag>-new` and `<tag>-empty-new` for the new buttons.
    var tag: String
}

private struct HomeListQuery: Hashable {
    var search: String
    var filter: String
}

/// A searchable, filterable list that loads page by page, with pull to refresh,
/// realtime updates, empty states and a new button (Android `DocumentList`).
private struct HomeDocumentList<T: Identifiable, Row: View>: View {
    let config: HomeListConfig<T>
    let row: (T) -> Row

    @Environment(Books.self) private var books
    @Environment(BooksNavigator.self) private var navigator
    @State private var list = PagedList<T>()
    @State private var search = ""
    @State private var filter = "all"

    init(config: HomeListConfig<T>, @ViewBuilder row: @escaping (T) -> Row) {
        self.config = config
        self.row = row
    }

    private var query: String? { search.trimmed.nilIfEmpty }
    private var status: String? { config.statusFor(filter) }

    var body: some View {
        VStack(spacing: 0) {
            SearchAndFilters(search: $search, placeholder: config.searchPlaceholder, filters: config.filters, selected: $filter)
            content
        }
        .navigationTitle(config.title)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    navigator.open(config.newRoute)
                } label: {
                    Label(config.newLabel, systemImage: "plus")
                        .labelStyle(.iconOnly)
                }
                .tagged("\(config.tag)-new")
            }
        }
        .task(id: HomeListQuery(search: search, filter: filter)) { await reload(debounced: true) }
        .realtimeRefresh(books.env, topics: config.topics) { await reload(debounced: false) }
    }

    /// The first page for the search and filter; a search waits until typing pauses.
    private func reload(debounced: Bool) async {
        list.fetch = config.fetch
        if debounced, !search.isEmpty {
            try? await Task.sleep(for: .milliseconds(300))
            if Task.isCancelled { return }
        }
        await list.load(search: query, status: status)
    }

    @ViewBuilder
    private var content: some View {
        let visible = list.items.filter { config.keep($0, filter) }
        if list.loading {
            ProgressView()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if list.error != nil, visible.isEmpty {
            VStack(spacing: 0) {
                Banner(config.loadError, tone: "error")
                LoadErrorView(error: apiError(list.error)) { await reload(debounced: false) }
            }
            .frame(maxHeight: .infinity, alignment: .top)
        } else {
            List {
                if visible.isEmpty {
                    emptyState
                        .listRowSeparator(.hidden)
                        .listRowBackground(Color.clear)
                        .onAppear { loadMore() }
                }
                ForEach(Array(visible.enumerated()), id: \.element.id) { index, item in
                    NavigationLink(value: config.route(item)) {
                        row(item)
                    }
                    .tagged(config.rowTag)
                    .onAppear {
                        if index >= visible.count - 4 { loadMore() }
                    }
                }
                if list.loadingMore {
                    ProgressView()
                        .frame(maxWidth: .infinity)
                        .padding(Tokens.Spacing.l)
                        .listRowSeparator(.hidden)
                }
            }
            .listStyle(.plain)
            .refreshable { await pullToRefresh() }
            .tagged(config.tag)
        }
    }

    /// Nothing yet (with a way to add the first), or nothing matches the search.
    private var emptyState: some View {
        let searching = !search.isEmpty
        return VStack(spacing: Tokens.Spacing.m) {
            ContentUnavailableView(
                searching ? config.noMatchTitle : config.emptyTitle,
                systemImage: searching ? "magnifyingglass" : config.emptyIcon,
                description: Text(searching ? config.noMatchDescription : config.emptyDescription)
            )
            if !searching {
                Button {
                    navigator.open(config.newRoute)
                } label: {
                    Text(config.newLabel)
                }
                .buttonStyle(.borderedProminent)
                .tagged("\(config.tag)-empty-new")
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, Tokens.Spacing.xl)
    }

    private func pullToRefresh() async {
        await list.load(search: query, status: status, refresh: true)
    }

    private func loadMore() {
        let currentSearch = query
        let currentStatus = status
        Task { await list.loadMore(search: currentSearch, status: currentStatus) }
    }
}

// MARK: - More

private struct HomeMenuEntry: Identifiable {
    let title: String
    let subtitle: String
    let systemImage: String
    let color: Color
    let route: Route
    let tag: String
    var id: String { tag }
}

private struct HomeMenuSection: Identifiable {
    let title: String
    let entries: [HomeMenuEntry]
    var id: String { title }
}

/// The open administration (tap to switch or add one), then banking, reports, contacts and settings.
struct MoreView: View {
    @Environment(Books.self) private var books

    init() {}

    private var sections: [HomeMenuSection] {
        let financial: [HomeMenuEntry?] = [
            HomeMenuEntry(
                title: BooksStrings.moreBankAccounts, subtitle: BooksStrings.moreBankAccountsSub,
                systemImage: "building.columns", color: Accents.banking, route: .bank, tag: "more-bank"
            ),
            HomeMenuEntry(
                title: BooksStrings.moreReconciliation, subtitle: BooksStrings.moreReconciliationSub,
                systemImage: "arrow.triangle.merge", color: Accents.reconciliation, route: .reconciliation, tag: "more-reconciliation"
            ),
            // The VAT return: only companies whose country files one.
            books.features.vatReturn
                ? HomeMenuEntry(
                    title: BooksStrings.moreVatReturns, subtitle: BooksStrings.moreVatReturnsSub,
                    systemImage: "checkmark.seal", color: Accents.vat, route: .vat, tag: "more-vat"
                )
                : nil,
        ]
        return [
            HomeMenuSection(title: BooksStrings.moreFinancial, entries: financial.compactMap { $0 }),
            HomeMenuSection(title: BooksStrings.moreReports, entries: [
                HomeMenuEntry(
                    title: BooksStrings.moreProfitLoss, subtitle: BooksStrings.moreProfitLossSub,
                    systemImage: "chart.line.uptrend.xyaxis", color: Accents.profitLoss, route: .profitLoss, tag: "more-profit-loss"
                ),
                HomeMenuEntry(
                    title: BooksStrings.moreBalanceSheet, subtitle: BooksStrings.moreBalanceSheetSub,
                    systemImage: "scalemass", color: Accents.balanceSheet, route: .balanceSheet, tag: "more-balance-sheet"
                ),
            ]),
            HomeMenuSection(title: BooksStrings.moreOther, entries: [
                HomeMenuEntry(
                    title: BooksStrings.moreContacts, subtitle: BooksStrings.moreContactsSub(suppliers: books.labels.suppliersLower),
                    systemImage: "person.2", color: Accents.contacts, route: .contacts, tag: "more-contacts"
                ),
                HomeMenuEntry(
                    title: BooksStrings.moreSettings, subtitle: BooksStrings.moreSettingsSub,
                    systemImage: "gearshape", color: Accents.settings, route: .settings, tag: "more-settings"
                ),
            ]),
        ]
    }

    var body: some View {
        let entities = books.entities
        List {
            if let entity = entities.active {
                Section(BooksStrings.moreAdministration) {
                    // Always opens the sheet: with one company it is where another one is added.
                    Button {
                        entities.openSwitcher()
                    } label: {
                        HomeMenuLabel(
                            title: entity.name,
                            subtitle: [
                                entity.jurisdictionCode,
                                entity.baseCurrency,
                                entities.canSwitch ? BooksStrings.moreTapToSwitch : BooksStrings.moreTapToAdd,
                            ].joined(separator: " · "),
                            systemImage: "building.2",
                            color: Accents.settings,
                            chevron: true
                        )
                    }
                    .tagged("administration-row")
                }
            }
            ForEach(sections) { section in
                Section(section.title) {
                    ForEach(section.entries) { entry in
                        NavigationLink(value: entry.route) {
                            HomeMenuLabel(title: entry.title, subtitle: entry.subtitle, systemImage: entry.systemImage, color: entry.color, chevron: false)
                        }
                        .tagged(entry.tag)
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle(BooksStrings.moreTitle)
    }
}

/// A tile, a title and a line under it; `chevron` for a row that isn't a navigation link.
private struct HomeMenuLabel: View {
    let title: String
    let subtitle: String
    let systemImage: String
    let color: Color
    let chevron: Bool

    var body: some View {
        HStack(spacing: Tokens.Spacing.m) {
            IconTile(systemImage: systemImage, color: color)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.inter(.body, weight: .semibold))
                    .foregroundStyle(Color.primary)
                    .lineLimit(1)
                Text(subtitle)
                    .font(.inter(.footnote))
                    .foregroundStyle(Color.secondary)
                    .lineLimit(2)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if chevron {
                Image(systemName: "chevron.right")
                    .font(.inter(.footnote, weight: .semibold))
                    .foregroundStyle(Color(uiColor: .tertiaryLabel))
                    .accessibilityHidden(true)
            }
        }
        .padding(.vertical, 2)
        .contentShape(Rectangle())
    }
}
