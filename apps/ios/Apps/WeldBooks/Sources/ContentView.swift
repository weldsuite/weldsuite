import SwiftUI
import WeldCore
import WeldUI

/// WeldBooks once signed in, in a workspace and unlocked: the company gate,
/// then the tabs (Android `ui/WeldBooksApp.kt`).
struct ContentView: View {
    let env: AppEnvironment
    let books: Books
    let navigator: BooksNavigator
    let person: Person
    let workspace: WorkspaceRef
    let workspaces: [WorkspaceRef]
    @Binding var appearance: AppAppearance

    @Environment(Toaster.self) private var toaster
    @State private var switching = false

    var body: some View {
        gate
            .task(id: "\(person.id)|\(workspace.id)") {
                if books.personId != person.id {
                    // Someone else signed in: nothing of the last person's companies stays.
                    books.personId = person.id
                    books.entities.clear()
                }
                books.workspaceId = workspace.id
                await books.entities.use(workspace.id)
                await books.queue.sync()
            }
            .onChange(of: books.entities.activeId) {
                // Another company: its books start on Home, as on Android.
                navigator.reset()
            }
            .onOpenURL { url in
                if let route = DeepLinks.route(for: url) { navigator.pending = route }
            }
            .sheet(isPresented: $switching) {
                NavigationStack {
                    WorkspacePicker(workspaces: workspaces) { id in
                        switching = false
                        env.chooseWorkspace(id)
                    }
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) {
                            Button(CoreStrings.commonCancel) { switching = false }
                        }
                    }
                }
            }
    }

    @ViewBuilder
    private var gate: some View {
        let entities = books.entities
        if entities.loading {
            ProgressView()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if entities.failed {
            MessageView(
                title: BooksStrings.appName,
                message: BooksStrings.layoutCompanyLoadError,
                primary: (CoreStrings.commonTryAgain, { Task { await entities.load() } })
            )
        } else if !entities.hasEntity {
            NavigationStack {
                EntityEmptyStateView(workspaces: workspaces, onSwitchWorkspace: { switching = true })
            }
            .booksContext(books: books, navigator: navigator, toaster: toaster)
        } else {
            BooksTabs(person: person, workspace: workspace, workspaces: workspaces, appearance: $appearance)
                .id(entities.activeId)
        }
    }
}

/// The tabs: Home, Invoices, Scan (a button that opens the scanner), Expenses
/// and More, each with its own stack; push taps and deep links open their
/// screen; the administration switcher is mounted here once.
struct BooksTabs: View {
    let person: Person
    let workspace: WorkspaceRef
    let workspaces: [WorkspaceRef]
    @Binding var appearance: AppAppearance

    @Environment(Books.self) private var books
    @Environment(BooksNavigator.self) private var navigator
    @Environment(Toaster.self) private var toaster

    var body: some View {
        @Bindable var nav = navigator
        TabView(selection: Binding(get: { navigator.tab }, set: { navigator.select($0) })) {
            NavigationStack(path: $nav.homePath) {
                DashboardView()
                    .booksDestinations(person: person, workspace: workspace, workspaces: workspaces, appearance: $appearance)
            }
            .tabItem { Label(BooksStrings.tabsHome, systemImage: "square.grid.2x2") }
            .tag(BooksTab.home)
            .accessibilityIdentifier(BooksTab.home.tag)

            NavigationStack(path: $nav.invoicesPath) {
                InvoicesView()
                    .booksDestinations(person: person, workspace: workspace, workspaces: workspaces, appearance: $appearance)
            }
            .tabItem { Label(BooksStrings.tabsInvoices, systemImage: "doc.text") }
            .tag(BooksTab.invoices)
            .accessibilityIdentifier(BooksTab.invoices.tag)

            // Never shown: selecting Scan opens the scanner and keeps the tab.
            Color.clear
                .tabItem { Label(BooksStrings.tabsScan, systemImage: "camera") }
                .tag(BooksTab.scan)
                .accessibilityIdentifier(BooksTab.scan.tag)

            NavigationStack(path: $nav.expensesPath) {
                ExpensesView()
                    .booksDestinations(person: person, workspace: workspace, workspaces: workspaces, appearance: $appearance)
            }
            .tabItem { Label(BooksStrings.tabsExpenses, systemImage: "list.bullet.rectangle") }
            .tag(BooksTab.expenses)
            .accessibilityIdentifier(BooksTab.expenses.tag)

            NavigationStack(path: $nav.morePath) {
                MoreView()
                    .booksDestinations(person: person, workspace: workspace, workspaces: workspaces, appearance: $appearance)
            }
            .tabItem { Label(BooksStrings.tabsMore, systemImage: "ellipsis.circle") }
            .tag(BooksTab.more)
            .accessibilityIdentifier(BooksTab.more.tag)
        }
        .fullScreenCover(isPresented: $nav.scanning) {
            ScanView()
                .booksContext(books: books, navigator: navigator, toaster: toaster)
        }
        .sheet(isPresented: Binding(
            get: { books.entities.switcherOpen },
            set: { open in if !open { books.entities.closeSwitcher() } }
        )) {
            AdministrationSheet()
                .booksContext(books: books, navigator: navigator, toaster: toaster)
        }
        .onChange(of: navigator.pending, initial: true) {
            if let route = navigator.takePending() { navigator.open(route) }
        }
        .onChange(of: PushCenter.shared.pendingTap, initial: true) { _, tap in
            // A tapped notification: open what it is about.
            guard tap != nil, let payload = books.env.takePushTap(),
                  let route = pushRoute(entityType: payload.entityType, entityId: payload.entityID, actionUrl: payload.actionURL)
            else { return }
            navigator.open(route)
        }
    }
}

extension View {
    /// The app's context for content presented on its own (a sheet, a full-screen
    /// cover): the environment objects and the toasts shown inside it.
    func booksContext(books: Books, navigator: BooksNavigator, toaster: Toaster) -> some View {
        environment(books)
            .environment(navigator)
            .toastOverlay(toaster)
    }
}
