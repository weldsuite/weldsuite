import Observation
import SwiftUI
import WeldCore
import WeldUI

// MARK: - What phase 2 implements, and how a screen works
//
// The screens (files under Sources/Screens/), with exactly these initialisers;
// `ContentView`/`RouteView` below call them:
//
//   HomeScreens.swift      DashboardView()                  Home tab root
//                          InvoicesView()                   Invoices tab root
//                          ExpensesView()                   Expenses tab root
//                          MoreView()                       More tab root
//   InvoiceScreens.swift   InvoiceDetailView(id: String)
//                          InvoiceDocumentView(id: String)
//                          InvoiceFormView()
//   BillScreens.swift      BillDetailView(id: String)
//                          BillFormView(documentId: String?, receipt: String?, receiptType: String?)
//                          ReceiptPreview(image: UIImage?, loading: Bool = false, pdf: Bool = false, failed: Bool = false)
//                          LocalReceiptPreview(path: String?, mimeType: String?)   (also used by QuickExpenseView)
//                          StoredReceiptPreview(documentId: String?)
//   CaptureScreens.swift   ScanView()                       shown full screen over the tabs
//                          QuickExpenseView(documentId: String?, receipt: String?, receiptType: String?)
//   CompanyScreens.swift   EntityEmptyStateView(workspaces: [WorkspaceRef], onSwitchWorkspace: @escaping () -> Void)
//                          AdministrationSheet()            sheet content; ContentView presents it while
//                                                           `books.entities.switcherOpen` (closing calls closeSwitcher())
//                          CreateEntitySheet(additional: Bool = false, initialJurisdiction: String? = nil,
//                                            onCreated: @escaping (Entity) -> Void)          sheet content
//                          EditCompanySheet(onSaved: @escaping () -> Void = {})              sheet content, also
//                                                           presented by InvoiceDetailView ("add company details")
//                          SettingsView(person: Person, workspace: WorkspaceRef, workspaces: [WorkspaceRef],
//                                       appearance: Binding<AppAppearance>)
//   FinanceScreens.swift   BankAccountsView(), BankAccountView(id: String), ReconciliationView(), ReportsView(),
//                          ProfitLossView(), BalanceSheetView(), VatReturnsView(), VatReturnView(id: String)
//   ContactScreens.swift   ContactsView(), ContactView(id: String), ContactFormView()
//
// Every screen reads its context from the environment:
//
//     @Environment(Books.self) private var books              // see BooksContext.swift
//     @Environment(BooksNavigator.self) private var navigator
//     @Environment(Toaster.self) private var toaster
//
// Navigating (Android `open(route)`, `onBack`, `onReplace`/`onCreated`):
//   - open a screen:   navigator.open(.invoice(id: id))   — pushes on the current tab's stack;
//                      `.invoices` / `.expenses` switch tab, `.scan` opens the scanner.
//   - go back:         navigator.back()  (or `@Environment(\.dismiss)`); a sheet closes itself with dismiss().
//   - after creating:  navigator.replace(with: .invoice(id: newId)) — the form leaves the stack (Android popUpTo inclusive).
//   - the scanner:     navigator.closeScanner(); navigator.continueFromScan(.newBill(documentId:receipt:receiptType:))
//                      or `.quickExpense(...)`: the scanner closes and the form opens on the current tab.
//   - the company switcher: books.entities.openSwitcher(); the tabs start over when another company opens.
// A pushed screen sets `.navigationTitle(...)`; the back button is the system's. Tab roots use the large title.
//
// Sheets: give the content the app's context, so it has the environment and shows toasts above itself:
//     .sheet(isPresented: $editingCompany) {
//         EditCompanySheet { mutations.clear() }.booksContext(books: books, navigator: navigator, toaster: toaster)
//     }
// A sheet's content brings its own NavigationStack (title, Cancel) and closes itself with `@Environment(\.dismiss)`.
// Messages: toaster.show(BooksStrings.invoiceDetailSent).
// Errors in words: ErrorTexts.describe(error, fallback: BooksStrings.commonActionFailed);
// `LoadErrorView(error: apiError(error)) { … }` for a load that failed.
// Document actions: `@State private var mutations = Mutations()`; mutations.run(toaster, success: …, reload: { … }) { try await … }.
// Loading: `Loaded<T>` + `LoadedContent` (Common.swift), `PagedList<T>` + `SearchAndFilters` for the long lists.
// Realtime: `.realtimeRefresh(books.env, topics: BooksTopics.…) { await reload() }`.
// Identifiers: `.tagged("invoice-row")` — the Android test tag, the same string.
// Shared already (don't declare again): Choice, Accents, SectionCard, DetailRow, TotalsBlock, IconTile, RecordRow,
// StatusPill, statusLabel, statusColor, Banner, GroupLabel, HintText, FeatureUnavailableView, SearchAndFilters,
// Loaded, LoadedContent, PagedList, FormField, Dropdown, SwitchRow, DateField, View.confirmDialog,
// View.debounced, View.tagged, View.groupedBackground, AddressFields, ServerTax, LineItemsEditor, taxCodeLabel,
// taxLevelLabel, taxWarningLabel, TaxBreakdownCard, TreatmentBreakdownCard, PaymentSheet, paymentMethodLabel,
// DocumentSummary, DocumentLines, DocumentTotals, Mutations, invoiceFieldNames, formatMoney, formatCompact,
// formatDay, formatShortDay, and the String helpers in Logic/TextHelpers.swift.
// Each screen file keeps its own labels (entityTypeLabel, taxClassificationLabel, bankAccountTypeLabel,
// contactRoleLabel, categoryLabel): each is used by one Kotlin screen file only.

/// A screen pushed on a tab's stack (Android's routes, one case each).
enum Route: Hashable {
    /// Switches to the Invoices tab (not pushed).
    case invoices
    /// Switches to the Expenses tab (not pushed).
    case expenses
    /// Opens the scanner over the tabs (not pushed).
    case scan
    case invoice(id: String)
    case invoiceDocument(id: String)
    case newInvoice
    case bill(id: String)
    /// `receipt`: a kept photo (`QueuedReceipt.path`, `books.queue.fileURL(path:)`), `receiptType` its MIME type.
    case newBill(documentId: String?, receipt: String?, receiptType: String?)
    case quickExpense(documentId: String?, receipt: String?, receiptType: String?)
    case bank
    case bankAccount(id: String)
    case reconciliation
    case reports
    case profitLoss
    case balanceSheet
    case vat
    case vatReturn(id: String)
    case contacts
    case newContact
    case contact(id: String)
    case settings

    /// A new bill or quick expense without a receipt.
    static let newBillBlank = Route.newBill(documentId: nil, receipt: nil, receiptType: nil)
    static let quickExpenseBlank = Route.quickExpense(documentId: nil, receipt: nil, receiptType: nil)
}

/// The tabs. Scan is a button: it opens the scanner and stays unselected.
enum BooksTab: String, Hashable, CaseIterable {
    case home, invoices, scan, expenses, more

    /// The Android test tag of the tab.
    var tag: String { "tab-\(rawValue)" }
}

/// Opens screens from anywhere: one stack per tab, the scanner over them.
@MainActor
@Observable
final class BooksNavigator {
    var tab: BooksTab = .home
    var homePath: [Route] = []
    var invoicesPath: [Route] = []
    var expensesPath: [Route] = []
    var morePath: [Route] = []
    /// The scanner is open.
    var scanning = false
    /// A deep link that arrived before the tabs were there; the tabs open it.
    var pending: Route?

    /// The current tab's stack.
    var path: [Route] {
        get {
            switch tab {
            case .home, .scan: return homePath
            case .invoices: return invoicesPath
            case .expenses: return expensesPath
            case .more: return morePath
            }
        }
        set {
            switch tab {
            case .home, .scan: homePath = newValue
            case .invoices: invoicesPath = newValue
            case .expenses: expensesPath = newValue
            case .more: morePath = newValue
            }
        }
    }

    /// Open `route`: push it on the current tab, or switch tab / open the scanner.
    func open(_ route: Route) {
        switch route {
        case .invoices:
            tab = .invoices
            invoicesPath = []
        case .expenses:
            tab = .expenses
            expensesPath = []
        case .scan:
            scanning = true
        default:
            path.append(route)
        }
    }

    /// Back one screen on the current tab.
    func back() {
        if !path.isEmpty { path.removeLast() }
    }

    /// Replace the current screen with `route` (a form, by what it created).
    func replace(with route: Route) {
        var stack = path
        if !stack.isEmpty { stack.removeLast() }
        stack.append(route)
        path = stack
    }

    func popToRoot() { path = [] }

    /// A tab bar tap: Scan opens the scanner; the selected tab again goes back to its root.
    func select(_ next: BooksTab) {
        if next == .scan {
            scanning = true
        } else if next == tab {
            popToRoot()
        } else {
            tab = next
        }
    }

    func closeScanner() { scanning = false }

    /// The scanner is done: close it, then open the form for what it captured.
    func continueFromScan(_ route: Route) {
        scanning = false
        Task {
            // Let the cover go before pushing, or the push is lost in the transition.
            try? await Task.sleep(for: .milliseconds(350))
            open(route)
        }
    }

    /// Start over (another company, another workspace).
    func reset() {
        tab = .home
        homePath = []
        invoicesPath = []
        expensesPath = []
        morePath = []
        scanning = false
    }

    /// The deep link waiting to be opened, once.
    func takePending() -> Route? {
        let route = pending
        pending = nil
        return route
    }
}

/// Where a tapped notification leads: an invoice or a bill.
func pushRoute(entityType: String?, entityId: String?, actionUrl: String?) -> Route? {
    if let entityId {
        switch entityType {
        case "invoice": return .invoice(id: entityId)
        case "bill": return .bill(id: entityId)
        default: break
        }
    }
    guard let url = actionUrl else { return nil }
    if let groups = url.firstMatchGroups("/invoices?/([A-Za-z0-9_-]+)"), groups.count > 1 { return .invoice(id: groups[1]) }
    if let groups = url.firstMatchGroups("/bills?/([A-Za-z0-9_-]+)"), groups.count > 1 { return .bill(id: groups[1]) }
    return nil
}

/// `weldbooks://invoice/<id>`, `weldbooks://bill/<id>`, `weldbooks://scan`, … (the Expo app's routes).
enum DeepLinks {
    /// The screen a link opens.
    static func route(for url: URL) -> Route? {
        guard url.scheme?.lowercased() == "weldbooks" else { return nil }
        let segments = url.pathComponents.filter { $0 != "/" && !$0.isEmpty }
        return routeFor(host: url.host, segments: segments)
    }

    static func routeFor(host: String?, segments: [String]) -> Route? {
        let first = segments.first
        switch host {
        case "invoice", "invoices":
            guard let first else { return .invoices }
            return first == "new" ? .newInvoice : .invoice(id: first)
        case "bill":
            guard let first, first != "new" else { return Route.newBillBlank }
            return .bill(id: first)
        case "expense":
            return Route.quickExpenseBlank
        case "expenses":
            return .expenses
        case "scan":
            return .scan
        case "bank":
            if let first { return .bankAccount(id: first) }
            return .bank
        case "reconciliation":
            return .reconciliation
        case "reports":
            switch first {
            case "profit-loss": return .profitLoss
            case "balance-sheet": return .balanceSheet
            default: return .reports
            }
        case "vat":
            if let first { return .vatReturn(id: first) }
            return .vat
        case "contacts":
            guard let first else { return .contacts }
            return first == "new" ? .newContact : .contact(id: first)
        case "settings":
            return .settings
        default:
            return nil
        }
    }
}

/// What a tab's stack can show (the destination of every `Route`).
struct RouteView: View {
    let route: Route
    let person: Person
    let workspace: WorkspaceRef
    let workspaces: [WorkspaceRef]
    @Binding var appearance: AppAppearance

    var body: some View {
        switch route {
        case .invoices: InvoicesView()
        case .expenses: ExpensesView()
        case .scan: ScanView()
        case let .invoice(id): InvoiceDetailView(id: id)
        case let .invoiceDocument(id): InvoiceDocumentView(id: id)
        case .newInvoice: InvoiceFormView()
        case let .bill(id): BillDetailView(id: id)
        case let .newBill(documentId, receipt, receiptType):
            BillFormView(documentId: documentId, receipt: receipt, receiptType: receiptType)
        case let .quickExpense(documentId, receipt, receiptType):
            QuickExpenseView(documentId: documentId, receipt: receipt, receiptType: receiptType)
        case .bank: BankAccountsView()
        case let .bankAccount(id): BankAccountView(id: id)
        case .reconciliation: ReconciliationView()
        case .reports: ReportsView()
        case .profitLoss: ProfitLossView()
        case .balanceSheet: BalanceSheetView()
        case .vat: VatReturnsView()
        case let .vatReturn(id): VatReturnView(id: id)
        case .contacts: ContactsView()
        case .newContact: ContactFormView()
        case let .contact(id): ContactView(id: id)
        case .settings: SettingsView(person: person, workspace: workspace, workspaces: workspaces, appearance: $appearance)
        }
    }
}

extension View {
    /// The destinations every tab's stack can push.
    func booksDestinations(person: Person, workspace: WorkspaceRef, workspaces: [WorkspaceRef], appearance: Binding<AppAppearance>) -> some View {
        navigationDestination(for: Route.self) { route in
            RouteView(route: route, person: person, workspace: workspace, workspaces: workspaces, appearance: appearance)
        }
    }
}
