import SwiftUI
import WeldCore
import WeldUI

// The tab roots: the dashboard, the invoice and expense lists, and the More
// menu (Android `ui/HomeScreens.kt`), laid out as the platform's WeldBooks.

// MARK: - Dashboard

/// The open company at a glance, as the platform's WeldBooks overview: "Today"
/// (this year's running total of a figure against last year's, and the
/// balances to act on), then what is due this week and the latest payments.
/// Above it, the actions this app starts from; captures still waiting for a
/// connection are named at the top.
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
                    HomeQuickActions()
                    if let data {
                        HomeTodaySection(data: data)
                        HomeBalances(data: data)
                        HomeDueThisWeek(items: data.dueThisWeek)
                        HomeLatestPayments(payments: data.recentPayments, currency: data.currency)
                    } else {
                        ProgressView()
                            .frame(maxWidth: .infinity)
                            .padding(Tokens.Spacing.xl)
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

/// New invoice, quick expense, scan, reports: the platform's outline buttons, in a row that scrolls sideways.
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
            QuickAction(label: BooksStrings.invoicesNewInvoice, systemImage: "doc.text", route: .newInvoice, tag: "action-invoice"),
            QuickAction(label: BooksStrings.expensesAddExpense, systemImage: "creditcard", route: Route.quickExpenseBlank, tag: "action-expense"),
            QuickAction(label: BooksStrings.dashboardScan, systemImage: "camera", route: .scan, tag: "action-scan"),
            QuickAction(label: BooksStrings.dashboardReports, systemImage: "chart.bar", route: .reports, tag: "action-reports"),
        ]
    }

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: Tokens.Spacing.s) {
                ForEach(actions) { action in
                    Button {
                        navigator.open(action.route)
                    } label: {
                        Label(action.label, systemImage: action.systemImage)
                            .font(.inter(.subheadline, weight: .medium))
                            .foregroundStyle(Tokens.Palette.foreground)
                            .padding(.horizontal, Tokens.Spacing.m)
                            .frame(height: 36)
                            .background(Tokens.Palette.background, in: RoundedRectangle(cornerRadius: Tokens.Radius.medium))
                            .overlay(RoundedRectangle(cornerRadius: Tokens.Radius.medium).strokeBorder(Tokens.Palette.input, lineWidth: 1))
                            .contentShape(RoundedRectangle(cornerRadius: Tokens.Radius.medium))
                    }
                    .buttonStyle(.plain)
                    .tagged(action.tag)
                }
            }
            .padding(.horizontal, Tokens.Spacing.l)
            .padding(.vertical, Tokens.Spacing.s)
        }
    }
}

/// `Jan`, or `Nov 2026` with the year, in the company's language.
private func monthText(year: Int, month: Int, withYear: Bool, locale: Locale) -> String {
    var components = DateComponents()
    components.year = year
    components.month = month
    components.day = 1
    let calendar = Calendar(identifier: .gregorian)
    guard let date = calendar.date(from: components) else { return "" }
    let formatter = DateFormatter()
    formatter.calendar = calendar
    formatter.locale = locale
    formatter.setLocalizedDateFormatFromTemplate(withYear ? "MMMyyyy" : "MMM")
    return formatter.string(from: date)
}

/// "Jan – Nov 2026": January of `year` up to the trend's last month.
private func yearSpan(_ year: Int, through: String?, locale: Locale) -> String {
    guard let through, through.count >= 7, let month = Int(through.dropping(5).take(2)) else { return "" }
    return "\(monthText(year: year, month: 1, withYear: false, locale: locale)) – \(monthText(year: year, month: month, withYear: true, locale: locale))"
}

/// "Today": a figure picked from a menu, this year's running total and last year's, and the two as lines.
private struct HomeTodaySection: View {
    let data: Dashboard

    @Environment(Books.self) private var books
    @State private var metric = "revenue"

    private var labels: [Choice] {
        [
            Choice("revenue", BooksStrings.dashboardRevenue),
            Choice("expenses", BooksStrings.dashboardExpenses),
            Choice("profit", BooksStrings.dashboardNetProfit),
        ]
    }

    var body: some View {
        let hasTrend = DashboardSeries.hasTrend(data.trend)
        let active = hasTrend ? metric : "revenue"
        let ytd = DashboardSeries.yearToDate(data.trend, metric: active)
        let activeLabel = labels.first { $0.key == active }?.label ?? BooksStrings.dashboardRevenue
        VStack(alignment: .leading, spacing: 0) {
            Text(BooksStrings.dashboardToday)
                .font(.inter(.title2, weight: .medium))
                .accessibilityAddTraits(.isHeader)
            Hairline()
                .padding(.top, Tokens.Spacing.m)
                .padding(.bottom, Tokens.Spacing.l)
            HStack(alignment: .top, spacing: Tokens.Spacing.xl) {
                VStack(alignment: .leading, spacing: 4) {
                    Menu {
                        ForEach(labels) { option in
                            Button {
                                metric = option.key
                            } label: {
                                if option.key == active {
                                    Label(option.label, systemImage: "checkmark")
                                } else {
                                    Text(option.label)
                                }
                            }
                        }
                    } label: {
                        HStack(spacing: 4) {
                            Text(activeLabel).font(.inter(.subheadline, weight: .medium))
                            if hasTrend {
                                Image(systemName: "chevron.down")
                                    .font(.system(size: 11, weight: .semibold))
                                    .foregroundStyle(Tokens.Palette.mutedForeground)
                            }
                        }
                        .foregroundStyle(Tokens.Palette.foreground)
                    }
                    .disabled(!hasTrend)
                    .accessibilityLabel(BooksStrings.dashboardMetric)
                    .tagged("dashboard-metric")
                    Text(books.money(ytd.total, currency: data.currency))
                        .font(.inter(.title3, weight: .regular))
                        .monospacedDigit()
                        .foregroundStyle(ytd.total < 0 ? Tokens.Status.danger : Tokens.Palette.foreground)
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)
                        .tagged("kpi-profit")
                    Text(yearSpan(ytd.year, through: ytd.throughMonth, locale: books.locale))
                        .font(.inter(.caption))
                        .foregroundStyle(Tokens.Palette.mutedForeground)
                }
                VStack(alignment: .leading, spacing: 4) {
                    Text(BooksStrings.dashboardLastYear).font(.inter(.subheadline, weight: .medium))
                    Text(books.money(ytd.lastYearTotal, currency: data.currency))
                        .font(.inter(.title3, weight: .regular))
                        .monospacedDigit()
                        .foregroundStyle(Tokens.Palette.mutedForeground)
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)
                    Text(yearSpan(ytd.year - 1, through: ytd.throughMonth, locale: books.locale))
                        .font(.inter(.caption))
                        .foregroundStyle(Tokens.Palette.mutedForeground)
                }
            }
            HomeComparisonChart(ytd: ytd, locale: books.locale)
                .padding(.top, Tokens.Spacing.l)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, Tokens.Spacing.l)
        .padding(.top, Tokens.Spacing.l)
    }
}

/// The platform's hero comparison chart: this year's running total as a line in
/// the chart colour, last year's dashed and muted, one baseline, the first and
/// last month under the ends.
private struct HomeComparisonChart: View {
    let ytd: YearToDate
    let locale: Locale

    var body: some View {
        let values = ytd.points.flatMap { [$0.value, $0.lastYear].compactMap { $0 } }.map(chartNumber) + [0]
        let top = values.max() ?? 0
        let bottom = values.min() ?? 0
        let range = top - bottom > 0 ? top - bottom : 1
        let points = ytd.points
        VStack(spacing: 6) {
            Canvas { context, size in
                let height = size.height - 5
                func spot(_ index: Int, _ value: Decimal) -> CGPoint {
                    CGPoint(x: size.width * CGFloat(index) / 11, y: 4 + height * CGFloat((top - chartNumber(value)) / range))
                }
                func path(_ pick: (YearToDate.Point) -> Decimal?) -> Path {
                    var path = Path()
                    var started = false
                    for (index, point) in points.enumerated() {
                        guard let value = pick(point) else {
                            started = false
                            continue
                        }
                        if started {
                            path.addLine(to: spot(index, value))
                        } else {
                            path.move(to: spot(index, value))
                            started = true
                        }
                    }
                    return path
                }
                var baseline = Path()
                baseline.move(to: CGPoint(x: 0, y: size.height - 0.5))
                baseline.addLine(to: CGPoint(x: size.width, y: size.height - 0.5))
                context.stroke(baseline, with: .color(Tokens.Palette.border), lineWidth: 1)
                context.stroke(path { $0.lastYear }, with: .color(Tokens.Palette.mutedForeground), style: StrokeStyle(lineWidth: 1.5, dash: [4, 4]))
                context.stroke(path { $0.value }, with: .color(Tones.chart), style: StrokeStyle(lineWidth: 2, lineJoin: .round))
            }
            .frame(height: 140)
            .accessibilityHidden(true)
            HStack {
                Text(monthText(year: ytd.year, month: 1, withYear: false, locale: locale))
                Spacer()
                Text(monthText(year: ytd.year, month: 12, withYear: false, locale: locale))
            }
            .font(.inter(.caption))
            .foregroundStyle(Tokens.Palette.mutedForeground)
            .accessibilityHidden(true)
        }
    }
}

/// A chart value as a plain number.
private func chartNumber(_ value: Decimal) -> Double {
    NSDecimalNumber(decimal: value).doubleValue
}

/// Cash, to receive, to pay and documents to process: a title that opens the list, the figure, one muted line.
private struct HomeBalances: View {
    let data: Dashboard

    @Environment(Books.self) private var books
    @Environment(BooksNavigator.self) private var navigator

    var body: some View {
        let overdue = data.overdue > 0
        VStack(spacing: Tokens.Spacing.xl) {
            HStack(alignment: .top, spacing: Tokens.Spacing.l) {
                HomeBalance(
                    label: BooksStrings.dashboardCashBalance,
                    value: books.money(data.cashBalance, currency: data.currency),
                    sub: BooksStrings.dashboardBankAccountCount(data.bankAccountCount),
                    tag: "kpi-cash"
                ) { navigator.open(.bank) }
                HomeBalance(
                    label: BooksStrings.dashboardToReceive,
                    value: books.money(data.outstanding, currency: data.currency),
                    sub: overdue
                        ? BooksStrings.dashboardOverdueAmount(amount: books.money(data.overdue, currency: data.currency))
                        : BooksStrings.dashboardOpenInvoiceCount(data.outstandingCount),
                    subColor: overdue ? Tokens.Status.danger : nil,
                    subTag: "kpi-overdue",
                    tag: "kpi-outstanding"
                ) { navigator.open(.invoices) }
            }
            HStack(alignment: .top, spacing: Tokens.Spacing.l) {
                HomeBalance(
                    label: BooksStrings.dashboardToPay,
                    value: books.money(data.payables, currency: data.currency),
                    sub: BooksStrings.dashboardOpenBillCount(data.payablesCount),
                    tag: "kpi-payables"
                ) { navigator.open(.expenses) }
                HomeBalance(
                    label: BooksStrings.dashboardDocuments,
                    value: String(data.pendingDocuments),
                    sub: BooksStrings.dashboardDocumentsWaiting,
                    tag: "kpi-documents",
                    onTap: nil
                )
            }
        }
        .padding(.horizontal, Tokens.Spacing.l)
        .padding(.vertical, Tokens.Spacing.xl)
    }
}

/// One balance: the label (a link when it opens a list), the figure, the line under it.
private struct HomeBalance: View {
    let label: String
    let value: String
    let sub: String
    var subColor: Color?
    var subTag: String?
    let tag: String
    let onTap: (() -> Void)?

    init(label: String, value: String, sub: String, subColor: Color? = nil, subTag: String? = nil, tag: String, onTap: (() -> Void)?) {
        self.label = label
        self.value = value
        self.sub = sub
        self.subColor = subColor
        self.subTag = subTag
        self.tag = tag
        self.onTap = onTap
    }

    var body: some View {
        if let onTap {
            Button(action: onTap) { content }
                .buttonStyle(.plain)
                .tagged(tag)
        } else {
            content.tagged(tag)
        }
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label)
                .font(.inter(.subheadline, weight: .medium))
                .foregroundStyle(Tokens.Palette.foreground)
                .lineLimit(1)
            Text(value)
                .font(.inter(.title3, weight: .regular))
                .monospacedDigit()
                .foregroundStyle(Tokens.Palette.foreground)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
            Text(sub)
                .font(.inter(.caption))
                .foregroundStyle(subColor ?? Tokens.Palette.mutedForeground)
                .lineLimit(1)
                .tagged(subTag)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
    }
}

/// A titled box of rows on the dashboard: bordered, `rounded-lg`, a hairline between the rows.
private struct HomeDashboardList<Content: View>: View {
    let title: String
    let empty: String
    let isEmpty: Bool
    let tag: String
    private let content: Content

    init(title: String, empty: String, isEmpty: Bool, tag: String, @ViewBuilder content: () -> Content) {
        self.title = title
        self.empty = empty
        self.isEmpty = isEmpty
        self.tag = tag
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Spacing.m) {
            Text(title).font(.inter(.subheadline, weight: .semibold))
            if isEmpty {
                Text(empty)
                    .font(.inter(.subheadline))
                    .foregroundStyle(Tokens.Palette.mutedForeground)
            } else {
                VStack(spacing: 0) { content }
                    .clipShape(RoundedRectangle(cornerRadius: Tokens.Radius.large))
                    .overlay(RoundedRectangle(cornerRadius: Tokens.Radius.large).strokeBorder(Tokens.Palette.border, lineWidth: 1))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, Tokens.Spacing.l)
        .padding(.vertical, Tokens.Spacing.s)
        .tagged(tag)
    }
}

/// Invoices falling due and bills to pay in the next seven days (and late ones), soonest first.
private struct HomeDueThisWeek: View {
    let items: [DueItem]

    @Environment(Books.self) private var books
    @Environment(BooksNavigator.self) private var navigator

    var body: some View {
        HomeDashboardList(
            title: BooksStrings.dashboardDueThisWeek,
            empty: BooksStrings.dashboardNoDueThisWeek,
            isEmpty: items.isEmpty,
            tag: "due-this-week"
        ) {
            ForEach(Array(items.enumerated()), id: \.element.rowId) { index, item in
                if index > 0 { Hairline() }
                RecordRow(
                    title: item.number ?? BooksStrings.commonDash,
                    subtitle: item.contactName,
                    meta: books.shortDate(item.dueDate),
                    amount: books.money(item.amount, currency: item.currency),
                    tag: item.kind == "invoice" ? "due-invoice" : "due-bill",
                    onTap: { navigator.open(item.kind == "invoice" ? .invoice(id: item.id) : .bill(id: item.id)) },
                    badge: {
                        StatusBadge(
                            item.kind == "invoice" ? BooksStrings.dashboardToReceive : BooksStrings.dashboardToPay,
                            color: item.kind == "invoice" ? Tones.green : Tones.blue
                        )
                    }
                )
                .padding(.horizontal, Tokens.Spacing.l)
                .padding(.vertical, Tokens.Spacing.s)
            }
        }
    }
}

/// The latest payments: the date, received or paid, how, and the amount. A payment opens what it paid.
private struct HomeLatestPayments: View {
    let payments: [RecentPayment]
    let currency: String

    @Environment(Books.self) private var books
    @Environment(BooksNavigator.self) private var navigator

    var body: some View {
        HomeDashboardList(
            title: BooksStrings.dashboardLatestPayments,
            empty: BooksStrings.dashboardNoRecentPayments,
            isEmpty: payments.isEmpty,
            tag: "latest-payments"
        ) {
            ForEach(Array(payments.enumerated()), id: \.element.id) { index, payment in
                if index > 0 { Hairline() }
                RecordRow(
                    title: books.date(payment.date),
                    subtitle: how(payment),
                    amount: books.money(payment.amount, currency: payment.currency ?? currency),
                    tag: "payment-row",
                    onTap: onTap(payment),
                    badge: {
                        StatusBadge(
                            payment.type == "received" ? BooksStrings.dashboardPaymentReceived : BooksStrings.dashboardPaymentSent,
                            color: payment.type == "received" ? Tones.green : Tones.blue
                        )
                    }
                )
                .padding(.horizontal, Tokens.Spacing.l)
                .padding(.vertical, Tokens.Spacing.s)
            }
        }
    }

    /// "Bank transfer · INV-0002": how it was paid and its reference.
    private func how(_ payment: RecentPayment) -> String? {
        [payment.method.map { paymentMethodLabel($0) }, payment.reference].compactMap { $0 }.joined(separator: " · ").nilIfEmpty
    }

    /// Opens the invoice the payment was recorded on, else the bill; nil for neither.
    private func onTap(_ payment: RecentPayment) -> (() -> Void)? {
        let route: Route
        if let id = payment.invoiceId {
            route = .invoice(id: id)
        } else if let id = payment.billId {
            route = .bill(id: id)
        } else {
            return nil
        }
        return { navigator.open(route) }
    }
}

/// An invoice or bill in a list, as the platform's row: the number, the contact
/// with its avatar, the due date, the amount and the status chip.
private struct HomeDocumentRow: View {
    let number: String
    let contactName: String?
    let dueDate: String
    let amount: String
    let status: String

    @Environment(Books.self) private var books

    var body: some View {
        HStack(spacing: Tokens.Spacing.m) {
            VStack(alignment: .leading, spacing: 4) {
                Text(number)
                    .font(.inter(.subheadline, weight: .medium))
                    .foregroundStyle(Tokens.Palette.foreground)
                    .lineLimit(1)
                HStack(spacing: 6) {
                    if let contactName {
                        RowAvatar(name: contactName)
                        Text(contactName)
                            .font(.inter(.footnote))
                            .foregroundStyle(Tokens.Palette.mutedForeground)
                            .lineLimit(1)
                        Text("·")
                            .font(.inter(.footnote))
                            .foregroundStyle(Tokens.Palette.mutedForeground)
                    }
                    Text(BooksStrings.commonDueOn(date: books.shortDate(dueDate)))
                        .font(.inter(.caption))
                        .monospacedDigit()
                        .foregroundStyle(Tokens.Palette.mutedForeground)
                        .lineLimit(1)
                        .layoutPriority(1)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            VStack(alignment: .trailing, spacing: 4) {
                Text(amount)
                    .font(.inter(.subheadline, weight: .medium))
                    .monospacedDigit()
                    .lineLimit(1)
                StatusPill(status)
            }
        }
        .padding(.vertical, 4)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

/// An invoice in a list; the caller wraps it in a link.
private struct HomeInvoiceRow: View {
    let invoice: Invoice

    @Environment(Books.self) private var books

    var body: some View {
        HomeDocumentRow(
            number: invoice.number ?? BooksStrings.commonDraft,
            contactName: invoice.contactName,
            dueDate: invoice.dueDate,
            amount: books.money(invoice.total, currency: invoice.currency),
            status: invoice.displayStatus()
        )
    }
}

/// A bill in a list; the caller wraps it in a link.
private struct HomeBillRow: View {
    let bill: Bill

    @Environment(Books.self) private var books

    var body: some View {
        HomeDocumentRow(
            number: bill.number ?? BooksStrings.commonDraft,
            contactName: bill.contactName ?? BooksStrings.expensesUnknownVendor(supplier: books.labels.supplierLower),
            dueDate: bill.dueDate,
            amount: books.money(bill.total, currency: bill.currency),
            status: bill.displayStatus()
        )
    }
}

/// The groups of the invoice list, most urgent first, as on the platform.
private func invoiceGroups() -> [Choice] {
    [
        Choice("overdue", BooksStrings.groupsOverdue),
        Choice("finalized", BooksStrings.groupsFinalized),
        Choice("sent", BooksStrings.groupsSent),
        Choice("partial", BooksStrings.groupsPartiallyPaid),
        Choice("draft", BooksStrings.groupsDraft),
        Choice("paid", BooksStrings.groupsPaid),
        Choice("other", BooksStrings.groupsOther),
    ]
}

private func invoiceGroup(_ invoice: Invoice) -> String {
    switch invoice.displayStatus() {
    case "overdue": return "overdue"
    case "finalized": return "finalized"
    case "sent", "viewed": return "sent"
    case "partially_paid": return "partial"
    case "draft": return "draft"
    case "paid": return "paid"
    default: return "other"
    }
}

/// The groups of the bill list: overdue, approved (partly paid too), awaiting approval, paid.
private func billGroups() -> [Choice] {
    [
        Choice("overdue", BooksStrings.groupsOverdue),
        Choice("approved", BooksStrings.groupsApproved),
        Choice("draft", BooksStrings.groupsDraft),
        Choice("paid", BooksStrings.groupsPaid),
        Choice("other", BooksStrings.groupsOther),
    ]
}

private func billGroup(_ bill: Bill) -> String {
    switch bill.displayStatus() {
    case "overdue": return "overdue"
    case "approved", "partially_paid": return "approved"
    case "draft", "pending": return "draft"
    case "paid": return "paid"
    default: return "other"
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
                groups: invoiceGroups(),
                groupOf: { invoiceGroup($0) },
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
            HomeInvoiceRow(invoice: invoice)
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
                groups: billGroups(),
                groupOf: { billGroup($0) },
                route: { bill in Route.bill(id: bill.id) },
                rowTag: "bill-row",
                emptyIcon: "creditcard",
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
    /// The platform's status groups, in order, and the group of an item.
    var groups: [Choice]
    var groupOf: (T) -> String
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
/// Under "All" the rows sit under the platform's status groups.
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
        .groupedBackground()
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
                if filter == "all" {
                    // Grouped by status like the platform's lists, unless a status filter already picks one.
                    ForEach(config.groups) { group in
                        let rows = visible.filter { config.groupOf($0) == group.key }
                        if !rows.isEmpty {
                            Section {
                                rowsView(rows, all: visible)
                            } header: {
                                GroupHeader(label: group.label, count: rows.count, more: list.hasMore)
                                    .groupHeaderInsets()
                            }
                        }
                    }
                } else {
                    rowsView(visible, all: visible)
                }
                if list.loadingMore {
                    ProgressView()
                        .frame(maxWidth: .infinity)
                        .padding(Tokens.Spacing.l)
                        .listRowSeparator(.hidden)
                        .listRowBackground(Color.clear)
                }
            }
            .platformList()
            .refreshable { await pullToRefresh() }
            .tagged(config.tag)
        }
    }

    /// The rows; one of the last few rows of the whole list appearing loads the next page.
    private func rowsView(_ rows: [T], all: [T]) -> some View {
        let tail = Set(all.suffix(4).map(\.id))
        return ForEach(rows) { item in
            NavigationLink(value: config.route(item)) {
                row(item)
            }
            .platformRow()
            .tagged(config.rowTag)
            .onAppear {
                if tail.contains(item.id) { loadMore() }
            }
        }
    }

    /// Nothing yet (with a way to add the first), or nothing matches the search.
    private var emptyState: some View {
        let searching = !search.isEmpty
        return BooksEmptyState(
            systemImage: searching ? "magnifyingglass" : config.emptyIcon,
            title: searching ? config.noMatchTitle : config.emptyTitle,
            description: searching ? config.noMatchDescription : config.emptyDescription,
            action: searching ? nil : config.newLabel,
            actionTag: "\(config.tag)-empty-new",
            onAction: { navigator.open(config.newRoute) }
        )
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
    let route: Route
    let tag: String
    var id: String { tag }
}

private struct HomeMenuSection: Identifiable {
    let title: String
    let entries: [HomeMenuEntry]
    var id: String { title }
}

/// The open administration (tap to switch or add one), then the platform's
/// WeldBooks menu groups this app has: Bank, Reports, Contacts, and Settings.
/// Plain rows with the menu's icons.
struct MoreView: View {
    @Environment(Books.self) private var books

    init() {}

    private var sections: [HomeMenuSection] {
        let reports: [HomeMenuEntry?] = [
            HomeMenuEntry(
                title: BooksStrings.moreProfitLoss, subtitle: BooksStrings.moreProfitLossSub,
                systemImage: "chart.line.uptrend.xyaxis", route: .profitLoss, tag: "more-profit-loss"
            ),
            HomeMenuEntry(
                title: BooksStrings.moreBalanceSheet, subtitle: BooksStrings.moreBalanceSheetSub,
                systemImage: "scalemass", route: .balanceSheet, tag: "more-balance-sheet"
            ),
            // The VAT return: only companies whose country files one.
            books.features.vatReturn
                ? HomeMenuEntry(
                    title: BooksStrings.moreVatReturns, subtitle: BooksStrings.moreVatReturnsSub,
                    systemImage: "checkmark.seal", route: .vat, tag: "more-vat"
                )
                : nil,
        ]
        return [
            HomeMenuSection(title: BooksStrings.moreBank, entries: [
                HomeMenuEntry(
                    title: BooksStrings.moreBankAccounts, subtitle: BooksStrings.moreBankAccountsSub,
                    systemImage: "building.columns", route: .bank, tag: "more-bank"
                ),
                HomeMenuEntry(
                    title: BooksStrings.moreReconciliation, subtitle: BooksStrings.moreReconciliationSub,
                    systemImage: "arrow.triangle.merge", route: .reconciliation, tag: "more-reconciliation"
                ),
            ]),
            HomeMenuSection(title: BooksStrings.moreReports, entries: reports.compactMap { $0 }),
            HomeMenuSection(title: BooksStrings.moreContactsGroup, entries: [
                HomeMenuEntry(
                    title: BooksStrings.moreContacts, subtitle: BooksStrings.moreContactsSub(suppliers: books.labels.suppliersLower),
                    systemImage: "person.2", route: .contacts, tag: "more-contacts"
                ),
            ]),
            HomeMenuSection(title: BooksStrings.moreOther, entries: [
                HomeMenuEntry(
                    title: BooksStrings.moreSettings, subtitle: BooksStrings.moreSettingsSub,
                    systemImage: "gearshape", route: .settings, tag: "more-settings"
                ),
            ]),
        ]
    }

    var body: some View {
        let entities = books.entities
        List {
            if let entity = entities.active {
                Section {
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
                            chevron: true
                        )
                    }
                    .platformRow()
                    .tagged("administration-row")
                } header: {
                    HomeMenuHeader(title: BooksStrings.moreAdministration)
                }
            }
            ForEach(sections) { section in
                Section {
                    ForEach(section.entries) { entry in
                        NavigationLink(value: entry.route) {
                            HomeMenuLabel(title: entry.title, subtitle: entry.subtitle, systemImage: entry.systemImage, chevron: false)
                        }
                        .platformRow()
                        .tagged(entry.tag)
                    }
                } header: {
                    HomeMenuHeader(title: section.title)
                }
            }
        }
        .platformList()
        .navigationTitle(BooksStrings.moreTitle)
    }
}

/// A menu group's label: the platform sidebar's, small, medium and muted.
private struct HomeMenuHeader: View {
    let title: String

    var body: some View {
        Text(title)
            .font(.inter(.caption, weight: .medium))
            .foregroundStyle(Tokens.Palette.mutedForeground)
            .textCase(nil)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.top, Tokens.Spacing.s)
    }
}

/// The item's icon, a title and a line under it; `chevron` for a row that isn't a navigation link.
private struct HomeMenuLabel: View {
    let title: String
    let subtitle: String
    let systemImage: String
    let chevron: Bool

    var body: some View {
        HStack(spacing: Tokens.Spacing.m) {
            ListIcon(systemImage)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.inter(.subheadline, weight: .medium))
                    .foregroundStyle(Tokens.Palette.foreground)
                    .lineLimit(1)
                Text(subtitle)
                    .font(.inter(.footnote))
                    .foregroundStyle(Tokens.Palette.mutedForeground)
                    .lineLimit(2)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if chevron {
                Image(systemName: "chevron.right")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Tokens.Palette.mutedForeground)
                    .accessibilityHidden(true)
            }
        }
        .padding(.vertical, 2)
        .contentShape(Rectangle())
    }
}
