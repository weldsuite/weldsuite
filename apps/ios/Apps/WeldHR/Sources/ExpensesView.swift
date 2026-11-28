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
            options.append(Segment(value: "approve", label: HRStrings.expensesToApprove, tag: "expenses-approve", count: store.pendingExpenses.data?.count ?? 0))
        }
        let view = options.contains { $0.value == chosen } ? chosen : options.first?.value ?? "mine"
        return List {
            if options.count > 1 {
                Section {
                    Segments(options: options, selection: Binding(get: { view }, set: { chosen = $0 }))
                        .segmentsRow()
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
                        HREmpty(HRStrings.teamNothingToApprove, description: HRStrings.teamNothingToApproveDescription, symbol: "wallet.bifold")
                    } else {
                        ExpensesToApprove(rows: rows)
                    }
                }
            }
        }
        .listStyle(.plain)
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

/// One of the platform's declaration groups, with what is still to come on the open ones.
private struct ExpenseGroup: Identifiable {
    let id: String
    let title: String
    let total: String?
    let rows: [HRDeclaration]
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
        if !canClaim {
            Section { Text(HRStrings.expensesTurnedOff).font(.inter(.subheadline)).foregroundStyle(.secondary) }
        }
        if rows.isEmpty {
            HREmpty(title: HRStrings.expensesNoExpenses, description: HRStrings.expensesNoExpensesDescription, symbol: "wallet.bifold") {
                if canClaim {
                    Button { nav.present(.expense(start: nil)) } label: {
                        Label(HRStrings.expensesNewExpense, systemImage: "plus")
                    }
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
            if shown.isEmpty {
                NoMatches(
                    title: HRStrings.expensesNoResults,
                    description: HRStrings.expensesNoResultsDescription,
                    filtered: filter.isActive,
                    clearFilters: { filter = ExpenseFilter() },
                    clearSearch: { search = "" }
                )
            } else {
                ForEach(groups(shown)) { group in
                    Section {
                        ForEach(group.rows) { row in
                            Button { nav.open(.expense(row.id)) } label: { DeclarationRowView(row: row) }
                                .buttonStyle(.plain)
                        }
                    } header: {
                        GroupHead(title: group.title, count: group.rows.count, figure: group.total)
                    }
                }
            }
        }
    }

    /// The platform's groups: awaiting a decision and approved (with the open
    /// amounts per currency), paid, rejected & cancelled, and the rest.
    private func groups(_ shown: [HRDeclaration]) -> [ExpenseGroup] {
        let pending = data.open.filter { $0.pending > 0 }.map { Fmt.money($0.pending, $0.currency) }.joined(separator: " · ")
        let approved = data.open.filter { $0.approved > 0 }.map { Fmt.money($0.approved, $0.currency) }.joined(separator: " · ")
        let known: Set<String> = ["pending", "approved", "paid", "rejected", "cancelled"]
        return [
            ExpenseGroup(id: "pending", title: HRStrings.expensesAwaiting, total: pending.isEmpty ? nil : pending, rows: shown.filter { $0.status == "pending" }),
            ExpenseGroup(id: "approved", title: HRStrings.expensesToBePaid, total: approved.isEmpty ? nil : approved, rows: shown.filter { $0.status == "approved" }),
            ExpenseGroup(id: "paid", title: HRStrings.expensesGroupsPaid, total: nil, rows: shown.filter { $0.status == "paid" }),
            ExpenseGroup(
                id: "closed",
                title: HRStrings.expensesGroupsRejectedCancelled,
                total: nil,
                rows: shown.filter { $0.status == "rejected" || $0.status == "cancelled" }
            ),
            ExpenseGroup(id: "other", title: HRStrings.expensesGroupsOther, total: nil, rows: shown.filter { !known.contains($0.status) }),
        ].filter { !$0.rows.isEmpty }
    }
}

/// A claim, as the platform's Declarations list: what it was for, the category
/// and day under it (a paperclip with a receipt), the amount and the status badge on the right.
struct DeclarationRowView: View {
    let row: HRDeclaration

    var body: some View {
        HRRow(
            title: row.description,
            subtitle: "\(Labels.category(row.category)) · \(Fmt.day(row.expenseDate))",
            subtitleSymbol: row.hasReceipt ? "paperclip" : nil,
            tag: .status(row.status, Labels.declarationStatus(row.status))
        ) {
            EmptyView()
        } value: {
            Text(Fmt.money(row.amount, row.currency)).font(.inter(.subheadline, weight: .medium)).monospacedDigit()
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
                        subtitle: "\(Labels.category(row.category)) · \(Fmt.day(row.expenseDate))",
                        subtitleSymbol: row.hasReceipt ? "paperclip" : nil,
                        note: row.description,
                        value: Fmt.money(row.amount, row.currency)
                    ) { approve, note in
                        try await store.reviewExpense(id: row.id, approve: approve, note: note)
                    }
                }
            } header: {
                GroupHead(title: HRStrings.expensesReviewGroup, count: shown.count)
            }
        }
    }
}

/// Announcements, as the platform's: Pinned and the rest in their own groups, a
/// pin before a pinned title, unread ones in semibold with "New".
struct AnnouncementsView: View {
    @Environment(HRStore.self) private var store
    @Environment(HRNavigator.self) private var nav

    var body: some View {
        let state = SelfState.of(me: store.me, access: store.access)
        List {
            SelfGate(state: state, retry: { await store.load(.me) }) { _, _ in
                QueryBody(state: store.announcements, retry: { await store.load(.announcements) }) { data in
                    if data.announcements.isEmpty {
                        HREmpty(HRStrings.announcementsEmpty, description: HRStrings.announcementsEmptyDescription, symbol: "newspaper")
                    } else {
                        let sorted = AnnouncementRules.sort(data.announcements)
                        let pinned = sorted.filter(\.pinned)
                        let rest = sorted.filter { !$0.pinned }
                        if !pinned.isEmpty {
                            Section {
                                ForEach(pinned) { AnnouncementRow(announcement: $0) }
                            } header: { GroupHead(title: HRStrings.announcementsPinned, count: pinned.count) }
                        }
                        if !rest.isEmpty {
                            Section {
                                ForEach(rest) { AnnouncementRow(announcement: $0) }
                            } header: { GroupHead(title: HRStrings.announcementsTitle, count: rest.count) }
                        }
                    }
                }
            }
        }
        .listStyle(.plain)
        .navigationTitle(HRStrings.announcementsTitle)
        .refreshable { await store.load(.announcements) }
        .task(id: state.features != nil) {
            if state.features != nil { await store.ensure(.announcements) }
        }
    }
}

/// An announcement in the list: a pin before a pinned one, semibold with "New" until it is read.
private struct AnnouncementRow: View {
    let announcement: HRAnnouncement
    @Environment(HRNavigator.self) private var nav

    var body: some View {
        let unread = announcement.readAt == nil
        Button { nav.open(.announcement(announcement.id)) } label: {
            HRRow(
                title: announcement.title,
                subtitle: AnnouncementRules.preview(announcement.body),
                subtitleLines: 2,
                detail: Labels.age(announcement.publishedAt),
                unread: unread,
                symbol: announcement.pinned ? "pin" : nil,
                tag: unread ? HRTag(text: HRStrings.announcementsNew, tone: .primary) : nil
            )
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("announcement-\(announcement.id)")
    }
}
