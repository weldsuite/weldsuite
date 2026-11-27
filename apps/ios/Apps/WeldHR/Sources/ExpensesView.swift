import SwiftUI
import WeldCore
import WeldUI

/// Expenses: the member's own claims, and for who approves expenses the ones
/// waiting for them; each list searches as you type, with a filter.
struct ExpensesView: View {
    @Environment(HRStore.self) private var store
    @Environment(HRNavigator.self) private var nav
    @State private var chosen = "mine"

    var body: some View {
        let access = store.access.data ?? .noAccess
        let state = SelfState.of(me: store.me, access: store.access)
        var options: [Segment<String>] = []
        if access.me { options.append(Segment(value: "mine", label: HRStrings.expensesMine, tag: "expenses-mine")) }
        if access.approveExpenses {
            options.append(Segment(value: "approve", label: withCount(HRStrings.expensesToApprove, store.pendingExpenses.data?.count ?? 0), tag: "expenses-approve"))
        }
        let view = options.contains { $0.value == chosen } ? chosen : options.first?.value ?? "mine"
        return List {
            if options.count > 1 {
                Section {
                    Segments(options: options, selection: Binding(get: { view }, set: { chosen = $0 }))
                        .listRowInsets(EdgeInsets())
                        .listRowBackground(Color.clear)
                }
            }
            if view == "mine" {
                SelfGate(state: state, retry: { await store.load(.me) }) { _, features in
                    QueryBody(state: store.declarations, retry: { await store.load(.declarations) }) { data in
                        MyExpenses(data: data, canClaim: features.declarations)
                    }
                }
            } else {
                QueryBody(state: store.pendingExpenses, retry: { await store.load(.pendingExpenses) }) { rows in
                    if rows.isEmpty {
                        ContentUnavailableView(HRStrings.teamNothingToApprove, systemImage: "checkmark.circle", description: Text(HRStrings.teamNothingToApproveDescription))
                    } else {
                        ExpensesToApprove(rows: rows)
                    }
                }
            }
        }
        .navigationTitle(HRStrings.expensesTitle)
        .refreshable {
            await store.load(.declarations)
            if access.approveExpenses { await store.load(.pendingExpenses) }
        }
        .task(id: "\(view)-\(state.features != nil)") {
            if view == "mine", state.features != nil { await store.ensure(.declarations) }
            if view == "approve" { await store.ensure(.pendingExpenses) }
        }
    }
}

private struct MyExpenses: View {
    let data: HRDeclarations
    let canClaim: Bool
    @Environment(HRNavigator.self) private var nav
    @State private var search = ""
    @State private var filter = ExpenseFilter()
    @State private var filtering = false

    var body: some View {
        let rows = data.declarations
        let shown = rows.filter { row in
            filter.passes(row) && HRSearch.matches(search, [
                row.description, Labels.category(row.category), Labels.declarationStatus(row.status),
                Fmt.money(row.amount, row.currency), Fmt.day(row.expenseDate),
            ])
        }
        let totals = data.open.filter { $0.pending > 0 || $0.approved > 0 }
        if !canClaim {
            Section { Text(HRStrings.expensesTurnedOff).font(.subheadline).foregroundStyle(.secondary) }
        }
        if rows.isEmpty {
            ContentUnavailableView {
                Label(HRStrings.expensesNoExpenses, systemImage: "receipt")
            } description: {
                Text(HRStrings.expensesNoExpensesDescription)
            } actions: {
                if canClaim {
                    Button(HRStrings.expensesNewExpense) { nav.present(.expense(start: nil)) }
                        .buttonStyle(.borderedProminent)
                        .accessibilityIdentifier("expenses-new")
                }
            }
        } else {
            Section {
                SearchBox(text: $search, placeholder: HRStrings.expensesSearch, filtered: filter.isActive, onFilter: { filtering = true }, tag: "expenses")
                    .sheet(isPresented: $filtering) {
                        FilterSheet(
                            options: ExpenseFilter.statusChoices(rows, filter: filter).map { ($0, Labels.declarationStatus($0)) },
                            off: filter.statuses
                        ) { filter.statuses = $0 }
                    }
            }
            if !totals.isEmpty && search.trimmingCharacters(in: .whitespaces).isEmpty && !filter.isActive {
                Section {
                    LabeledContent(HRStrings.expensesAwaiting, value: totals.map { Fmt.money($0.pending, $0.currency) }.joined(separator: " · "))
                    LabeledContent(HRStrings.expensesToBePaid, value: totals.map { Fmt.money($0.approved, $0.currency) }.joined(separator: " · "))
                }
            }
            if shown.isEmpty {
                NoMatches(
                    title: HRStrings.expensesNoResults,
                    description: HRStrings.expensesNoResultsDescription,
                    filtered: filter.isActive,
                    clearFilters: { filter = ExpenseFilter() },
                    clearSearch: { search = "" }
                )
            } else {
                Section {
                    ForEach(shown) { row in
                        Button { nav.open(.expense(row.id)) } label: { DeclarationRowView(row: row) }
                            .buttonStyle(.plain)
                    }
                } header: {
                    HeadWithFigure(title: HRStrings.expensesDeclarations, figure: String(shown.count))
                }
            }
        }
    }
}

/// A claim: its category tile, the status in colour, the amount and the day; a paperclip with a receipt.
struct DeclarationRowView: View {
    let row: HRDeclaration

    var body: some View {
        HRRow(
            title: row.description,
            subtitle: Labels.declarationStatus(row.status),
            subtitleColor: statusColor(row.status),
            detail: Fmt.day(row.expenseDate),
            muted: row.status == "cancelled"
        ) {
            CategoryTile(category: row.category)
        } value: {
            HStack(spacing: 4) {
                if row.hasReceipt { Image(systemName: "paperclip").font(.caption).foregroundStyle(.secondary) }
                Text(Fmt.money(row.amount, row.currency)).font(.subheadline).monospacedDigit()
            }
        }
        .accessibilityIdentifier("expense-\(row.id)")
    }
}

/// The claims waiting for this approver, searchable, filterable by category.
private struct ExpensesToApprove: View {
    let rows: [HRDeclaration]
    @Environment(HRStore.self) private var store
    @State private var search = ""
    @State private var filter = ExpenseFilter()
    @State private var filtering = false

    var body: some View {
        let shown = rows.filter { row in
            filter.passes(row) && HRSearch.matches(search, [
                row.employeeName, row.description, Labels.category(row.category),
                Fmt.money(row.amount, row.currency), Fmt.day(row.expenseDate),
            ])
        }
        Section {
            SearchBox(text: $search, placeholder: HRStrings.expensesSearch, filtered: filter.isActive, onFilter: { filtering = true }, tag: "approvals")
                .sheet(isPresented: $filtering) {
                    FilterSheet(
                        options: ExpenseFilter.categoryChoices(rows, filter: filter).map { ($0, Labels.category($0)) },
                        off: filter.categories
                    ) { filter.categories = $0 }
                }
        }
        if shown.isEmpty {
            NoMatches(
                title: HRStrings.expensesNoResults,
                description: HRStrings.expensesNoResultsDescription,
                filtered: filter.isActive,
                clearFilters: { filter = ExpenseFilter() },
                clearSearch: { search = "" }
            )
        } else {
            Section {
                ForEach(shown) { row in
                    ApprovalRow(
                        id: row.id,
                        name: row.employeeName ?? "",
                        subtitle: row.description,
                        note: nil,
                        value: Fmt.money(row.amount, row.currency),
                        detail: Fmt.day(row.expenseDate)
                    ) { approve, note in
                        try await store.reviewExpense(id: row.id, approve: approve, note: note)
                    }
                }
            }
        }
    }
}

/// Announcements: what HR posted, pinned first, unread ones marked.
struct AnnouncementsView: View {
    @Environment(HRStore.self) private var store
    @Environment(HRNavigator.self) private var nav

    var body: some View {
        let state = SelfState.of(me: store.me, access: store.access)
        List {
            SelfGate(state: state, retry: { await store.load(.me) }) { _, _ in
                QueryBody(state: store.announcements, retry: { await store.load(.announcements) }) { data in
                    if data.announcements.isEmpty {
                        ContentUnavailableView(HRStrings.announcementsEmpty, systemImage: "megaphone", description: Text(HRStrings.announcementsEmptyDescription))
                    } else {
                        ForEach(AnnouncementRules.sort(data.announcements)) { announcement in
                            Button { nav.open(.announcement(announcement.id)) } label: {
                                HRRow(
                                    title: announcement.title,
                                    subtitle: AnnouncementRules.preview(announcement.body),
                                    subtitleLines: 2,
                                    value: Labels.age(announcement.publishedAt)
                                ) {
                                    IconTile(symbol: announcement.pinned ? "pin" : "megaphone")
                                        .overlay(alignment: .topTrailing) {
                                            if announcement.readAt == nil {
                                                Circle().fill(Tokens.Brand.weldhr).frame(width: 9, height: 9)
                                                    .accessibilityLabel(HRStrings.announcementsUnread)
                                            }
                                        }
                                }
                            }
                            .buttonStyle(.plain)
                            .accessibilityIdentifier("announcement-\(announcement.id)")
                        }
                    }
                }
            }
        }
        .navigationTitle(HRStrings.announcementsTitle)
        .refreshable { await store.load(.announcements) }
        .task(id: state.features != nil) {
            if state.features != nil { await store.ensure(.announcements) }
        }
    }
}
