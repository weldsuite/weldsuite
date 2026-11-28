import SwiftUI
import UIKit
import WeldCore
import WeldUI

// Banking, reconciliation, reports and VAT returns (Android `ui/FinanceScreens.kt`).

/// A US bank account type in words, or the code itself.
private func bankAccountTypeLabel(_ type: String) -> String {
    switch type {
    case "checking": return BooksStrings.bankAccountTypesChecking
    case "savings": return BooksStrings.bankAccountTypesSavings
    case "credit_card": return BooksStrings.bankAccountTypesCreditCard
    case "money_market": return BooksStrings.bankAccountTypesMoneyMarket
    case "line_of_credit": return BooksStrings.bankAccountTypesLineOfCredit
    default: return type
    }
}

/// "Chase · Checking ••••1234", else the IBAN or the bank's name.
private func bankSubtitle(_ account: BankAccount) -> String? {
    Payments.accountSubtitle(account, typeLabel: bankAccountTypeLabel)
}

/// The title, and a line under it, in the navigation bar.
private struct FinanceNavTitle: View {
    let title: String
    let subtitle: String?

    var body: some View {
        VStack(spacing: 0) {
            Text(title)
                .font(.inter(.headline))
                .lineLimit(1)
            if let subtitle {
                Text(subtitle)
                    .font(.inter(.caption))
                    .foregroundStyle(Tokens.Palette.mutedForeground)
                    .lineLimit(1)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }
}

private extension View {
    /// A pushed screen's inline title, with an optional subtitle under it.
    func financeTitle(_ title: String, subtitle: String? = nil) -> some View {
        navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    FinanceNavTitle(title: title, subtitle: subtitle)
                }
            }
    }
}

// MARK: - Bank accounts

/// Balances across every bank account; a total only when they share a currency.
struct BankAccountsView: View {
    @Environment(Books.self) private var books
    @State private var loaded = Loaded<[BankAccount]>()

    init() {}

    var body: some View {
        LoadedContent(loaded, loadError: BooksStrings.bankLoadError) {
            try await books.store.bankAccounts()
        } content: { accounts in
            FinanceBankAccountsList(accounts: accounts)
        }
        .realtimeRefresh(books.env, topics: BooksTopics.banking) { await loaded.load() }
        .financeTitle(BooksStrings.bankTitle)
    }
}

private struct FinanceBankAccountsList: View {
    let accounts: [BankAccount]

    @Environment(Books.self) private var books
    @Environment(BooksNavigator.self) private var navigator

    init(accounts: [BankAccount]) {
        self.accounts = accounts
    }

    /// The sum of the balances, when every account is in the same currency.
    private var total: String? {
        guard let first = accounts.first, accounts.allSatisfy({ $0.currency == first.currency }) else { return nil }
        let sum = accounts.reduce(Decimal(0)) { $0 + $1.balance }
        return books.money(sum, currency: first.currency)
    }

    var body: some View {
        List {
            if let total {
                KpiCard(label: BooksStrings.bankTotalBalance, value: total, systemImage: "building.columns", tag: "bank-total")
                    .listRowSeparator(.hidden)
                    .listRowBackground(Tokens.Palette.background)
            }
            ForEach(accounts) { account in
                accountRow(account)
                    .platformRow()
            }
        }
        .platformList()
        .overlay {
            if accounts.isEmpty {
                BooksEmptyState(systemImage: "building.columns", title: BooksStrings.bankEmptyTitle, description: BooksStrings.bankEmptyDescription)
            }
        }
        .tagged("bank-accounts")
    }

    private func accountRow(_ account: BankAccount) -> some View {
        let meta = account.lastImportDate.map { BooksStrings.bankLastImport(date: books.date($0)) } ?? BooksStrings.bankNeverImported
        let color: Color? = account.balance < 0 ? Tokens.Status.danger : nil
        return RecordRow(
            title: account.name,
            subtitle: bankSubtitle(account),
            meta: meta,
            amount: books.money(account.balance, currency: account.currency),
            amountColor: color,
            tag: "bank-account-row",
            onTap: { navigator.open(.bankAccount(id: account.id)) },
            leading: { EmptyView() },
            badge: { EmptyView() }
        )
    }
}

private struct FinanceBankPage {
    var account: BankAccount
    var transactions: [BankTransaction]
}

/// One bank account: its balance and the 50 latest transactions.
struct BankAccountView: View {
    let id: String

    @Environment(Books.self) private var books
    @State private var loaded = Loaded<FinanceBankPage>()

    init(id: String) {
        self.id = id
    }

    var body: some View {
        let account = loaded.data?.account
        LoadedContent(loaded, loadError: BooksStrings.bankDetailLoadError, id: id) {
            let result = try await books.store.bankAccount(id: id)
            return FinanceBankPage(account: result.account, transactions: result.transactions)
        } content: { page in
            FinanceBankAccountDetail(account: page.account, transactions: page.transactions)
        }
        .realtimeRefresh(books.env, topics: BooksTopics.banking) { await loaded.load() }
        .financeTitle(account?.name ?? BooksStrings.bankDetailTitle, subtitle: account.flatMap { bankSubtitle($0) })
    }
}

private struct FinanceBankAccountDetail: View {
    let account: BankAccount
    let transactions: [BankTransaction]

    @Environment(Books.self) private var books

    init(account: BankAccount, transactions: [BankTransaction]) {
        self.account = account
        self.transactions = transactions
    }

    var body: some View {
        List {
            balanceCard
                .listRowSeparator(.hidden)
                .listRowBackground(Tokens.Palette.background)
            if transactions.isEmpty {
                BooksEmptyState(
                    systemImage: "arrow.left.arrow.right",
                    title: BooksStrings.bankDetailEmptyTitle,
                    description: BooksStrings.bankDetailEmptyDescription
                )
                .listRowSeparator(.hidden)
                .listRowBackground(Tokens.Palette.background)
            }
            // Grouped by status like the platform's transaction list.
            ForEach(groups, id: \.key) { group in
                let rows = transactions.filter { transactionGroup($0) == group.key }
                if !rows.isEmpty {
                    Section {
                        ForEach(rows) { line in
                            FinanceTransactionRow(line: line, currency: account.currency)
                                .platformRow()
                        }
                    } header: {
                        GroupHeader(label: group.label, count: rows.count)
                            .groupHeaderInsets()
                    }
                }
            }
        }
        .platformList()
        .tagged("bank-account")
    }

    private var groups: [Choice] {
        [
            Choice("unreconciled", BooksStrings.groupsUnreconciled),
            Choice("reconciled", BooksStrings.groupsReconciled),
            Choice("excluded", BooksStrings.groupsExcluded),
        ]
    }

    private func transactionGroup(_ line: BankTransaction) -> String {
        line.status == "reconciled" || line.status == "excluded" ? line.status : "unreconciled"
    }

    /// The balance as the platform's KPI card, then the account's properties.
    private var balanceCard: some View {
        VStack(alignment: .leading, spacing: Tokens.Spacing.s) {
            KpiCard(
                label: BooksStrings.bankDetailCurrentBalance,
                value: books.money(account.balance, currency: account.currency),
                hint: account.bankName,
                systemImage: "building.columns",
                tone: account.balance < 0 ? Tokens.Status.danger : nil,
                tag: "bank-balance"
            )
            if account.routingNumber != nil || account.accountNumberLast4 != nil {
                if let type = account.accountType, Payments.bankAccountTypes.contains(type) {
                    PropertyRow("building.columns", BooksStrings.bankDetailAccountType, bankAccountTypeLabel(type))
                }
                if let routing = account.routingNumber {
                    PropertyRow("number", BooksStrings.bankDetailRoutingNumber, routing)
                }
                if let number = Payments.masked(account.accountNumberLast4) {
                    PropertyRow("creditcard", BooksStrings.bankDetailAccountNumber, number)
                }
            }
        }
        .padding(.vertical, Tokens.Spacing.xs)
    }
}

private struct FinanceTransactionRow: View {
    let line: BankTransaction
    let currency: String?

    @Environment(Books.self) private var books

    init(line: BankTransaction, currency: String?) {
        self.line = line
        self.currency = currency
    }

    /// A bank line as the platform's transaction list draws it: the description,
    /// the counterparty, the date, the amount (green coming in) and the status chip.
    var body: some View {
        let incoming = line.amount >= 0
        let amountColor: Color? = incoming ? Tones.positive : nil
        RecordRow(
            title: line.description ?? line.counterpartyName ?? BooksStrings.bankDetailTransaction,
            // The counterparty and the bank's reference: the platform's Counterparty and Reference columns.
            subtitle: [line.description != nil ? line.counterpartyName : nil, line.reference].compactMap { $0 }.joined(separator: " · ").nilIfEmpty,
            meta: books.shortDate(line.date),
            amount: books.money(line.amount, currency: currency),
            amountColor: amountColor,
            tag: "transaction-row",
            badge: {
                switch line.status {
                case "reconciled":
                    StatusBadge(BooksStrings.bankDetailReconciled, color: Tones.green)
                case "excluded":
                    StatusBadge(BooksStrings.bankDetailExcluded, color: Tones.gray)
                default:
                    StatusBadge(BooksStrings.bankDetailUnmatched, color: Tones.gray)
                }
            }
        )
    }
}

// MARK: - Reconciliation

private struct FinanceReconciliationPage {
    var stats: ReconciliationStats
    var lines: [UnmatchedTransaction]
    var hasBankAccount: Bool
}

/// Bank reconciliation: each open line with the invoices and bills it may pay;
/// a tap on one reconciles it. The confidence shows so a weak suggestion reads
/// as a guess.
struct ReconciliationView: View {
    @Environment(Books.self) private var books
    @Environment(Toaster.self) private var toaster
    @State private var loaded = Loaded<FinanceReconciliationPage>()
    @State private var matching: String?

    init() {}

    var body: some View {
        LoadedContent(loaded, loadError: BooksStrings.reconciliationLoadError) {
            let store = books.store
            let stats = try await store.reconciliationStats()
            let lines = try await store.unmatchedTransactions(limit: 20)
            let accounts = try await store.bankAccounts()
            return FinanceReconciliationPage(stats: stats, lines: lines, hasBankAccount: !accounts.isEmpty)
        } content: { page in
            FinanceReconciliationBody(page: page, matching: matching) { line, suggestion in
                match(line, suggestion)
            }
        }
        .realtimeRefresh(books.env, topics: BooksTopics.banking) { await loaded.load() }
        .financeTitle(BooksStrings.reconciliationTitle)
    }

    private func match(_ line: UnmatchedTransaction, _ suggestion: MatchSuggestion) {
        let store = books.store
        matching = line.id
        Task {
            do {
                try await store.reconcile(transactionId: line.transaction.id, suggestion: suggestion)
                toaster.show(BooksStrings.reconciliationMatched)
                // Drop it here so the list doesn't jump while the counts refresh.
                loaded.update { page in
                    var next = page
                    next.lines.removeAll { $0.id == line.id }
                    next.stats.unmatched = max(next.stats.unmatched - 1, 0)
                    next.stats.matched += 1
                    return next
                }
            } catch {
                toaster.show(ErrorTexts.describe(error, fallback: BooksStrings.reconciliationMatchFailed))
            }
            matching = nil
        }
    }
}

private struct FinanceReconciliationBody: View {
    let page: FinanceReconciliationPage
    let matching: String?
    let onMatch: (UnmatchedTransaction, MatchSuggestion) -> Void

    @Environment(Books.self) private var books

    init(page: FinanceReconciliationPage, matching: String?, onMatch: @escaping (UnmatchedTransaction, MatchSuggestion) -> Void) {
        self.page = page
        self.matching = matching
        self.onMatch = onMatch
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                // Without a bank account there is nothing to reconcile: "everything reconciled" would be a lie.
                if !page.hasBankAccount {
                    BooksEmptyState(systemImage: "building.columns", title: BooksStrings.bankEmptyTitle, description: BooksStrings.bankEmptyDescription)
                } else {
                    statsRow
                    if page.lines.isEmpty {
                        BooksEmptyState(
                            systemImage: "arrow.triangle.merge",
                            title: BooksStrings.reconciliationEmptyTitle,
                            description: BooksStrings.reconciliationEmptyDescription
                        )
                    }
                    ForEach(page.lines) { line in
                        FinanceUnmatchedCard(line: line, busy: matching == line.id) { suggestion in
                            onMatch(line, suggestion)
                        }
                    }
                }
            }
            .padding(.bottom, Tokens.Spacing.xl)
        }
        .groupedBackground()
        .tagged("reconciliation")
    }

    /// The platform's KPI cards: what is open, what is done, and the money still to match.
    private var statsRow: some View {
        VStack(spacing: Tokens.Spacing.m) {
            HStack(spacing: Tokens.Spacing.m) {
                KpiCard(label: BooksStrings.reconciliationUnmatched, value: String(page.stats.unmatched), tag: "stat-unmatched")
                KpiCard(label: BooksStrings.reconciliationReconciled, value: String(page.stats.matched), tone: Tones.positive, tag: "stat-reconciled")
            }
            KpiCard(label: BooksStrings.reconciliationPending, value: books.money(page.stats.pendingAmount), tag: "stat-pending")
        }
        .padding(.horizontal, Tokens.Spacing.l)
        .padding(.vertical, Tokens.Spacing.s)
    }
}

private struct FinanceUnmatchedCard: View {
    let line: UnmatchedTransaction
    let busy: Bool
    let onMatch: (MatchSuggestion) -> Void

    @Environment(Books.self) private var books

    init(line: UnmatchedTransaction, busy: Bool, onMatch: @escaping (MatchSuggestion) -> Void) {
        self.line = line
        self.busy = busy
        self.onMatch = onMatch
    }

    var body: some View {
        let tx = line.transaction
        let incoming = tx.amount >= 0
        SectionCard {
            HStack(spacing: Tokens.Spacing.m) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(tx.description ?? tx.counterpartyName ?? BooksStrings.reconciliationTransaction)
                        .font(.inter(.subheadline, weight: .medium))
                        .lineLimit(1)
                    Text(books.shortDate(tx.date))
                        .font(.inter(.caption))
                        .monospacedDigit()
                        .foregroundStyle(Tokens.Palette.mutedForeground)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                Text(books.money(tx.amount))
                    .font(.inter(.subheadline, weight: .medium))
                    .monospacedDigit()
                    .foregroundStyle(incoming ? Tones.positive : Tokens.Palette.foreground)
            }
            if line.suggestions.isEmpty {
                HintText(BooksStrings.reconciliationNoSuggestions)
            } else {
                Hairline().padding(.vertical, Tokens.Spacing.m)
                Text(BooksStrings.reconciliationSuggestedMatches)
                    .font(.inter(.caption, weight: .medium))
                    .foregroundStyle(Tokens.Palette.mutedForeground)
                ForEach(line.suggestions) { suggestion in
                    suggestionRow(suggestion)
                }
            }
        }
        .accessibilityElement(children: .contain)
        .tagged("unmatched-transaction")
    }

    private func suggestionRow(_ suggestion: MatchSuggestion) -> some View {
        let kind = suggestion.type == "invoice" ? BooksStrings.reconciliationInvoice : BooksStrings.reconciliationBill
        let parts: [String?] = [kind, suggestion.number, suggestion.contactName]
        let description = parts.compactMap { $0 }.joined(separator: " · ")
        let percent = Int(suggestion.confidence * 100)
        let tone: Color
        if suggestion.confidence >= 0.8 {
            tone = Tones.green
        } else if suggestion.confidence >= 0.6 {
            tone = Tones.amber
        } else {
            tone = Tones.gray
        }
        return Button {
            onMatch(suggestion)
        } label: {
            HStack(spacing: Tokens.Spacing.s) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(description)
                        .font(.inter(.subheadline))
                        .lineLimit(1)
                    Text(books.money(suggestion.amount))
                        .font(.inter(.footnote))
                        .foregroundStyle(Tokens.Palette.mutedForeground)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                StatusBadge("\(percent)%", color: tone)
                Image(systemName: "checkmark")
                    .font(.inter(.footnote))
                    .foregroundStyle(Tokens.Palette.mutedForeground)
                    .accessibilityHidden(true)
            }
            .padding(Tokens.Spacing.m)
            .overlay(
                RoundedRectangle(cornerRadius: Tokens.Radius.medium)
                    .stroke(Tokens.Palette.border, lineWidth: 1)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(busy)
        .accessibilityLabel(BooksStrings.reconciliationMatchWith(description: description))
        .tagged("match-suggestion")
        .padding(.top, Tokens.Spacing.s)
    }
}

// MARK: - Reports

private struct FinanceReport: Identifiable {
    let title: String
    let subtitle: String
    let systemImage: String
    let route: Route
    let tag: String

    var id: String { tag }
}

/// The reports there are on a phone: profit and loss, and the balance sheet.
struct ReportsView: View {
    @Environment(BooksNavigator.self) private var navigator

    init() {}

    private var reports: [FinanceReport] {
        [
            FinanceReport(
                title: BooksStrings.reportsProfitLoss, subtitle: BooksStrings.reportsProfitLossSub,
                systemImage: "chart.line.uptrend.xyaxis", route: .profitLoss, tag: "report-profit-loss"
            ),
            FinanceReport(
                title: BooksStrings.reportsBalanceSheet, subtitle: BooksStrings.reportsBalanceSheetSub,
                systemImage: "scalemass", route: .balanceSheet, tag: "report-balance-sheet"
            ),
        ]
    }

    var body: some View {
        List {
            Section {
                ForEach(reports) { report in
                    Button {
                        navigator.open(report.route)
                    } label: {
                        HStack(spacing: Tokens.Spacing.m) {
                            ListIcon(report.systemImage)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(report.title)
                                    .font(.inter(.subheadline, weight: .medium))
                                    .foregroundStyle(Tokens.Palette.foreground)
                                Text(report.subtitle)
                                    .font(.inter(.footnote))
                                    .foregroundStyle(Tokens.Palette.mutedForeground)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            Image(systemName: "chevron.right")
                                .font(.inter(.footnote, weight: .semibold))
                                .foregroundStyle(Tokens.Palette.mutedForeground)
                                .accessibilityHidden(true)
                        }
                        .contentShape(Rectangle())
                    }
                    .platformRow()
                    .tagged(report.tag)
                }
            }
        }
        .platformList()
        .tagged("reports")
        .financeTitle(BooksStrings.reportsTitle)
    }
}

/// Profit and loss for this month or this year; the margin is worked out here, 0% without revenue.
struct ProfitLossView: View {
    @Environment(Books.self) private var books
    @State private var period = "month"
    @State private var loaded = Loaded<ProfitLoss>()

    init() {}

    private var range: (from: Day, to: Day) {
        let days = period == "year" ? Days.yearRange() : Days.monthRange()
        return (from: days.0, to: days.1)
    }

    var body: some View {
        let dates = range
        VStack(spacing: 0) {
            Picker(BooksStrings.profitLossTitle, selection: $period) {
                Text(BooksStrings.profitLossThisMonth)
                    .accessibilityIdentifier("period-month")
                    .tag("month")
                Text(BooksStrings.profitLossThisYear)
                    .accessibilityIdentifier("period-year")
                    .tag("year")
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .padding(.horizontal, Tokens.Spacing.m)
            .padding(.vertical, Tokens.Spacing.s)
            LoadedContent(loaded, loadError: BooksStrings.profitLossLoadError, id: period) {
                try await books.store.profitLoss(from: dates.from.iso, to: dates.to.iso)
            } content: { data in
                FinanceProfitLossBody(data: data)
            }
        }
        .groupedBackground()
        .realtimeRefresh(books.env, topics: BooksTopics.reports) { await loaded.load() }
        .financeTitle(
            BooksStrings.profitLossTitle,
            subtitle: "\(books.date(dates.from.iso)) – \(books.date(dates.to.iso))"
        )
    }
}

private struct FinanceProfitLossBody: View {
    let data: ProfitLoss

    @Environment(Books.self) private var books

    init(data: ProfitLoss) {
        self.data = data
    }

    var body: some View {
        let profitable = data.netProfit >= 0
        let net = profitable ? BooksStrings.profitLossNetProfit : BooksStrings.profitLossNetLoss
        ScrollView {
            VStack(spacing: 0) {
                KpiCard(
                    label: net,
                    value: books.money(data.netProfit.magnitude),
                    hint: BooksStrings.profitLossMargin(percent: "\(Amounts.plain(data.margin))%"),
                    systemImage: "chart.line.uptrend.xyaxis",
                    tone: profitable ? Tones.positive : Tokens.Status.danger,
                    tag: "net-profit"
                )
                .padding(.horizontal, Tokens.Spacing.l)
                .padding(.vertical, Tokens.Spacing.s)
                SectionCard(title: BooksStrings.profitLossBreakdown) {
                    TotalsBlock(
                        rows: [
                            (BooksStrings.profitLossRevenue, books.money(data.revenue)),
                            (BooksStrings.profitLossExpenses, "−" + books.money(data.expenses)),
                        ],
                        total: (net, books.money(data.netProfit))
                    )
                }
            }
            .padding(.bottom, Tokens.Spacing.xl)
        }
        .tagged("profit-loss")
    }
}

/// The balance sheet; a difference between assets and liabilities plus equity is flagged, not rounded away.
struct BalanceSheetView: View {
    @Environment(Books.self) private var books
    @State private var loaded = Loaded<BalanceSheet>()

    init() {}

    var body: some View {
        LoadedContent(loaded, loadError: BooksStrings.balanceSheetLoadError) {
            try await books.store.balanceSheet()
        } content: { data in
            FinanceBalanceSheetBody(data: data)
        }
        .realtimeRefresh(books.env, topics: BooksTopics.reports) { await loaded.load() }
        .financeTitle(BooksStrings.balanceSheetTitle)
    }
}

private struct FinanceBalanceSheetBody: View {
    let data: BalanceSheet

    @Environment(Books.self) private var books

    init(data: BalanceSheet) {
        self.data = data
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                KpiCard(
                    label: BooksStrings.balanceSheetTotalAssets,
                    value: books.money(data.totalAssets),
                    systemImage: "scalemass",
                    tag: "total-assets"
                )
                .padding(.horizontal, Tokens.Spacing.l)
                .padding(.vertical, Tokens.Spacing.s)
                if !data.isBalanced {
                    Banner(
                        BooksStrings.balanceSheetUnbalancedBody(
                            assets: books.money(data.totalAssets),
                            liabilities: books.money(data.totalLiabilitiesAndEquity)
                        ),
                        tone: "warning",
                        title: BooksStrings.balanceSheetUnbalancedTitle
                    )
                }
                FinanceBalanceSection(
                    title: BooksStrings.balanceSheetAssets,
                    totalLabel: BooksStrings.balanceSheetTotalAssetsLabel,
                    rows: data.assets,
                    total: data.totalAssets
                )
                FinanceBalanceSection(
                    title: BooksStrings.balanceSheetLiabilities,
                    totalLabel: BooksStrings.balanceSheetTotalLiabilities,
                    rows: data.liabilities,
                    total: data.totalLiabilities
                )
                FinanceBalanceSection(
                    title: BooksStrings.balanceSheetEquity,
                    totalLabel: BooksStrings.balanceSheetTotalEquity,
                    rows: data.equity,
                    total: data.totalEquity
                )
                SectionCard {
                    HStack {
                        Text(BooksStrings.balanceSheetLiabilitiesAndEquity)
                            .font(.inter(.subheadline, weight: .semibold))
                        Spacer()
                        Text(books.money(data.totalLiabilitiesAndEquity))
                            .font(.inter(.subheadline, weight: .semibold))
                    }
                    .accessibilityElement(children: .combine)
                }
            }
            .padding(.bottom, Tokens.Spacing.xl)
        }
        .groupedBackground()
        .tagged("balance-sheet")
    }
}

private struct FinanceBalanceSection: View {
    let title: String
    let totalLabel: String
    let rows: [BalanceRow]
    let total: Decimal

    @Environment(Books.self) private var books

    init(title: String, totalLabel: String, rows: [BalanceRow], total: Decimal) {
        self.title = title
        self.totalLabel = totalLabel
        self.rows = rows
        self.total = total
    }

    var body: some View {
        if !rows.isEmpty || total != 0 {
            SectionCard(title: title) {
                ForEach(rows.indices, id: \.self) { index in
                    let row = rows[index]
                    HStack(alignment: .center) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(row.name).font(.inter(.subheadline))
                            if !row.code.isBlank {
                                Text(row.code)
                                    .font(.inter(.caption))
                                    .foregroundStyle(Tokens.Palette.mutedForeground)
                            }
                        }
                        Spacer(minLength: Tokens.Spacing.m)
                        Text(books.money(row.balance)).font(.inter(.subheadline))
                    }
                    .padding(.vertical, 5)
                    .accessibilityElement(children: .combine)
                }
                Hairline().padding(.vertical, Tokens.Spacing.s)
                HStack {
                    Text(totalLabel).font(.inter(.subheadline, weight: .semibold))
                    Spacer()
                    Text(books.money(total)).font(.inter(.subheadline, weight: .semibold))
                }
                .accessibilityElement(children: .combine)
            }
        }
    }
}

// MARK: - VAT returns

/// The Dutch BTW returns, by year; only where the company's country files one.
struct VatReturnsView: View {
    @Environment(Books.self) private var books

    init() {}

    var body: some View {
        if books.features.vatReturn {
            FinanceVatReturnsList()
        } else {
            FeatureUnavailableView()
        }
    }
}

private struct FinanceVatReturnsList: View {
    @Environment(Books.self) private var books
    @State private var year: Int?
    @State private var loaded = Loaded<[VatReturn]>()
    private let thisYear: Int

    init() {
        let year = Days.today().year
        thisYear = year
        _year = State(initialValue: year)
    }

    var body: some View {
        VStack(spacing: 0) {
            yearChips
            LoadedContent(loaded, loadError: BooksStrings.vatLoadError) {
                try await books.store.vatReturns()
            } content: { all in
                FinanceVatReturnRows(returns: all.filter { year == nil || $0.year == year }, year: year)
            }
        }
        .realtimeRefresh(books.env, topics: BooksTopics.vat) { await loaded.load() }
        .financeTitle(BooksStrings.vatTitle)
    }

    private var yearChips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                chip(BooksStrings.vatAllYears, selected: year == nil, tag: "vat-year-all") { year = nil }
                ForEach([thisYear, thisYear - 1, thisYear - 2], id: \.self) { option in
                    chip(String(option), selected: year == option, tag: "vat-year-\(option)") { year = option }
                }
            }
            .padding(.horizontal, Tokens.Spacing.l)
            .padding(.vertical, Tokens.Spacing.s)
        }
    }

    private func chip(_ label: String, selected: Bool, tag: String, action: @escaping () -> Void) -> some View {
        FilterChipView(label: label, on: selected, action: action)
            .tagged(tag)
    }
}

private struct FinanceVatReturnRows: View {
    let returns: [VatReturn]
    let year: Int?

    @Environment(Books.self) private var books
    @Environment(BooksNavigator.self) private var navigator

    init(returns: [VatReturn], year: Int?) {
        self.returns = returns
        self.year = year
    }

    private var emptyText: String {
        guard let year else { return BooksStrings.vatEmptyAll }
        return BooksStrings.vatEmptyYear(year: String(year))
    }

    var body: some View {
        List {
            ForEach(returns) { item in
                row(item)
                    .platformRow()
            }
        }
        .platformList()
        .overlay {
            if returns.isEmpty {
                BooksEmptyState(systemImage: "checkmark.seal", title: BooksStrings.vatEmptyTitle, description: emptyText)
            }
        }
        .tagged("vat-returns")
    }

    private func row(_ item: VatReturn) -> some View {
        let color: Color? = item.netAmount < 0 ? Tones.positive : nil
        return RecordRow(
            title: item.period,
            subtitle: BooksStrings.vatOutputInput(output: books.money(item.salesTax), input: books.money(item.purchaseTax)),
            amount: books.money(item.netAmount),
            amountColor: color,
            tag: "vat-return-row",
            onTap: { navigator.open(.vatReturn(id: item.id)) },
            badge: { StatusPill(item.status) }
        )
    }
}

/// One BTW return. Filing is a real submission to the tax office, so it asks first.
struct VatReturnView: View {
    let id: String

    @Environment(Books.self) private var books

    init(id: String) {
        self.id = id
    }

    var body: some View {
        if books.features.vatReturn {
            FinanceVatReturnDetail(id: id)
        } else {
            FeatureUnavailableView()
        }
    }
}

private struct FinanceVatReturnDetail: View {
    let id: String

    @Environment(Books.self) private var books
    @Environment(Toaster.self) private var toaster
    @State private var loaded = Loaded<VatReturn>()
    @State private var confirming = false
    @State private var filing = false

    init(id: String) {
        self.id = id
    }

    var body: some View {
        LoadedContent(loaded, loadError: BooksStrings.vatDetailLoadError, id: id) {
            try await books.store.vatReturn(id: id)
        } content: { item in
            FinanceVatReturnBody(item: item, filing: filing) { confirming = true }
        }
        .realtimeRefresh(books.env, topics: BooksTopics.vat) { await loaded.load() }
        .financeTitle(loaded.data?.period ?? BooksStrings.vatDetailTitle)
        .confirmDialog(
            BooksStrings.vatDetailFileTitle,
            isPresented: $confirming,
            message: BooksStrings.vatDetailFileMessage,
            confirm: BooksStrings.vatDetailFileReturn
        ) {
            file()
        }
    }

    private func file() {
        guard let item = loaded.data else { return }
        let store = books.store
        filing = true
        Task {
            do {
                try await store.fileVatReturn(id: item.id)
                toaster.show(BooksStrings.vatDetailFiledSuccess)
                await loaded.load()
            } catch {
                toaster.show(ErrorTexts.describe(error, fallback: BooksStrings.vatDetailFileFailed))
            }
            filing = false
        }
    }
}

/// A box of the Dutch return worth showing on a phone.
private struct FinanceVatBox: Identifiable {
    let key: String
    let label: String

    var id: String { key }
}

private struct FinanceVatReturnBody: View {
    let item: VatReturn
    let filing: Bool
    let onFile: () -> Void

    @Environment(Books.self) private var books

    init(item: VatReturn, filing: Bool, onFile: @escaping () -> Void) {
        self.item = item
        self.filing = filing
        self.onFile = onFile
    }

    private var boxes: [FinanceVatBox] {
        let all = [
            FinanceVatBox(key: "r1a", label: BooksStrings.vatDetailR1a),
            FinanceVatBox(key: "r1b", label: BooksStrings.vatDetailR1b),
            FinanceVatBox(key: "r2a", label: BooksStrings.vatDetailR2a),
            FinanceVatBox(key: "r3a", label: BooksStrings.vatDetailR3a),
            FinanceVatBox(key: "r3b", label: BooksStrings.vatDetailR3b),
            FinanceVatBox(key: "r4a", label: BooksStrings.vatDetailR4a),
            FinanceVatBox(key: "r4b", label: BooksStrings.vatDetailR4b),
        ]
        return all.filter { item.boxes[$0.key] != nil }
    }

    private var filedText: String {
        guard let filedAt = item.filedAt else { return BooksStrings.vatDetailFiled }
        return BooksStrings.vatDetailFiledOn(date: books.date(filedAt))
    }

    var body: some View {
        let payable = item.netAmount >= 0
        ScrollView {
            VStack(spacing: 0) {
                KpiCard(
                    label: payable ? BooksStrings.vatDetailToPay : BooksStrings.vatDetailToReclaim,
                    value: books.money(item.netAmount.magnitude),
                    systemImage: "checkmark.seal",
                    tone: payable ? nil : Tones.positive,
                    tag: "vat-net"
                )
                .padding(.horizontal, Tokens.Spacing.l)
                .padding(.vertical, Tokens.Spacing.s)
                HStack {
                    StatusPill(item.status)
                    Spacer()
                }
                .padding(.horizontal, Tokens.Spacing.l)
                .padding(.vertical, Tokens.Spacing.xs)
                if item.isFiled {
                    Banner(filedText, tone: "success")
                }
                SectionCard(title: BooksStrings.vatDetailPeriod) {
                    DetailRow(BooksStrings.vatDetailPeriod, item.period)
                    if let start = item.periodStart {
                        DetailRow(BooksStrings.vatDetailFrom, books.date(start))
                    }
                    if let end = item.periodEnd {
                        DetailRow(BooksStrings.vatDetailTo, books.date(end))
                    }
                }
                SectionCard(title: BooksStrings.vatDetailSummary) {
                    TotalsBlock(
                        rows: [
                            (BooksStrings.vatDetailOutputVat, books.money(item.salesTax)),
                            (BooksStrings.vatDetailInputVat, books.money(item.purchaseTax)),
                        ],
                        total: (payable ? BooksStrings.vatDetailPayable : BooksStrings.vatDetailReclaimable, books.money(item.netAmount.magnitude))
                    )
                }
                if !boxes.isEmpty {
                    SectionCard(title: BooksStrings.vatDetailRubrieken) {
                        ForEach(boxes) { box in
                            DetailRow(box.label, books.money(item.boxes[box.key] ?? 0))
                        }
                    }
                }
                if item.isFileable {
                    Button(action: onFile) {
                        Label(BooksStrings.vatDetailFileReturn, systemImage: "paperplane")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                    .disabled(filing)
                    .tagged("file-vat-return")
                    .padding(Tokens.Spacing.m)
                }
            }
            .padding(.bottom, Tokens.Spacing.xl)
        }
        .groupedBackground()
        .tagged("vat-return")
    }
}
