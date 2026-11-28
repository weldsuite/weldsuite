import SwiftUI
import UIKit
import WebKit
import WeldCore
import WeldUI

// One invoice, its printable document, and the new-invoice form (Android
// `ui/InvoiceScreens.kt`).

// MARK: - Detail

private enum InvoiceConfirmKind {
    case delete, cancel, creditNote
}

/// One invoice: its figures, the company fields it still needs, and the actions its status allows.
struct InvoiceDetailView: View {
    let id: String

    @Environment(Books.self) private var books
    @Environment(BooksNavigator.self) private var navigator
    @Environment(Toaster.self) private var toaster
    @Environment(\.dismiss) private var dismiss
    @State private var loaded = Loaded<Invoice>()
    @State private var mutations = Mutations()
    @State private var paying = false
    @State private var editingCompany = false
    @State private var confirm: InvoiceConfirmKind?

    init(id: String) {
        self.id = id
    }

    private var title: String {
        let invoice = loaded.data
        if let number = invoice?.number { return number }
        return invoice?.isCreditNote == true ? books.labels.creditNote : BooksStrings.invoiceDetailTitle
    }

    var body: some View {
        LoadedContent(loaded, loadError: BooksStrings.invoiceDetailLoadError, id: id) {
            try await books.store.invoice(id: id)
        } content: { invoice in
            InvoiceBodyView(
                invoice: invoice,
                mutations: mutations,
                onPay: { paying = true },
                onAddCompany: { editingCompany = true },
                onOpenDocument: { navigator.open(.invoiceDocument(id: invoice.id)) },
                reload: { await loaded.load() }
            )
            .refreshable { await refreshWithCompany() }
        }
        .groupedBackground()
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                InvoiceNavTitle(title: title, subtitle: loaded.data?.contactName)
            }
            ToolbarItemGroup(placement: .primaryAction) {
                if let invoice = loaded.data {
                    Button {
                        navigator.open(.invoiceDocument(id: invoice.id))
                    } label: {
                        Label(BooksStrings.invoiceDetailViewDocument, systemImage: "doc.text")
                            .labelStyle(.iconOnly)
                    }
                    .tagged("view-document")
                    actionsMenu(invoice)
                }
            }
        }
        .realtimeRefresh(books.env, topics: BooksTopics.invoices) { await loaded.load() }
        .sheet(isPresented: $paying) {
            paymentSheet
        }
        .sheet(isPresented: $editingCompany) {
            EditCompanySheet { mutations.clear() }
                .booksContext(books: books, navigator: navigator, toaster: toaster)
        }
        .confirmDialog(
            BooksStrings.invoiceDetailDeleteTitle,
            isPresented: confirming(.delete),
            message: BooksStrings.invoiceDetailDeleteMessage,
            confirm: CoreStrings.commonDelete,
            destructive: true
        ) { deleteDraft() }
        .confirmDialog(
            BooksStrings.invoiceDetailCancelTitle,
            isPresented: confirming(.cancel),
            message: BooksStrings.invoiceDetailCancelMessage,
            confirm: BooksStrings.invoiceDetailCancelInvoice,
            destructive: true,
            dismiss: BooksStrings.commonKeep
        ) { cancelInvoice() }
        .confirmDialog(
            BooksStrings.invoiceDetailCreditNoteTitle(creditNote: books.labels.creditNoteLower),
            isPresented: confirming(.creditNote),
            message: BooksStrings.invoiceDetailCreditNoteMessage,
            confirm: BooksStrings.commonCreate
        ) { createCreditNote() }
    }

    /// Duplicate; delete a draft; or a credit note and cancelling for a booked invoice.
    private func actionsMenu(_ invoice: Invoice) -> some View {
        Menu {
            Button(BooksStrings.invoiceDetailDuplicate) { duplicate(invoice) }
            if invoice.status == "draft" {
                Button(BooksStrings.invoiceDetailDeleteDraft, role: .destructive) { confirm = .delete }
            } else if invoice.status != "cancelled" {
                Button(BooksStrings.invoiceDetailCreateCreditNote(creditNote: books.labels.creditNoteLower)) { confirm = .creditNote }
                Button(BooksStrings.invoiceDetailCancelInvoice, role: .destructive) { confirm = .cancel }
            }
        } label: {
            Label(BooksStrings.invoiceDetailMoreActions, systemImage: "ellipsis.circle")
                .labelStyle(.iconOnly)
        }
        .tagged("invoice-actions")
    }

    @ViewBuilder
    private var paymentSheet: some View {
        if let invoice = loaded.data {
            PaymentSheet(balanceDue: invoice.balanceDue, currency: invoice.currency ?? books.currency, received: true, busy: mutations.busy) { payment in
                paying = false
                let store = books.store
                mutations.run(toaster, success: BooksStrings.invoiceDetailPaymentRecorded, reload: { await loaded.load() }) {
                    try await store.recordInvoicePayment(id: invoice.id, payment: payment)
                }
            }
            .booksContext(books: books, navigator: navigator, toaster: toaster)
        }
    }

    /// Pull to refresh: the company too, as its fields may have been filled in on the web since.
    private func refreshWithCompany() async {
        let entities = books.entities
        let company = Task { await entities.load() }
        await loaded.refresh()
        await company.value
    }

    private func confirming(_ kind: InvoiceConfirmKind) -> Binding<Bool> {
        Binding(
            get: { confirm == kind },
            set: { shown in if !shown, confirm == kind { confirm = nil } }
        )
    }

    private func duplicate(_ invoice: Invoice) {
        let store = books.store
        mutations.run(toaster, success: BooksStrings.invoiceDetailDuplicated, reload: {}) {
            let copy = try await store.duplicateInvoice(id: invoice.id)
            navigator.replace(with: .invoice(id: copy))
        }
    }

    private func deleteDraft() {
        guard let invoice = loaded.data else { return }
        let store = books.store
        mutations.remove(
            toaster,
            success: BooksStrings.invoiceDetailDeleted,
            failMessage: BooksStrings.invoiceDetailDeleteFailed,
            leave: { dismiss() }
        ) {
            try await store.deleteInvoice(id: invoice.id)
        }
    }

    private func cancelInvoice() {
        guard let invoice = loaded.data else { return }
        let store = books.store
        mutations.run(toaster, success: BooksStrings.invoiceDetailCancelled, reload: { await loaded.load() }) {
            try await store.cancelInvoice(id: invoice.id)
        }
    }

    private func createCreditNote() {
        guard let invoice = loaded.data else { return }
        let store = books.store
        mutations.run(toaster, success: BooksStrings.invoiceDetailCreditNoteCreated(creditNoteLabel: books.labels.creditNote), reload: {}) {
            let note = try await store.createCreditNote(id: invoice.id)
            navigator.replace(with: .invoice(id: note))
        }
    }
}

/// The title and the customer under it, in the navigation bar.
private struct InvoiceNavTitle: View {
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
                    .foregroundStyle(Color.secondary)
                    .lineLimit(1)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }
}

private struct InvoiceBodyView: View {
    let invoice: Invoice
    let mutations: Mutations
    let onPay: () -> Void
    let onAddCompany: () -> Void
    let onOpenDocument: () -> Void
    let reload: () async -> Void

    @Environment(Books.self) private var books
    @Environment(Toaster.self) private var toaster

    var body: some View {
        let currency = invoice.currency ?? books.currency
        let isDraft = invoice.status == "draft"
        let required = Jurisdictions.requiredInvoiceFields(books.code, books.jurisdictions)
        let companyMissing = CompanyForm.missingInvoiceFields(books.entity, required)
        let missingUsAddress = books.isUs && isDraft
            && !AddressDraft.of(invoice.shippingAddress).isUsTaxable
            && !AddressDraft.of(invoice.billingAddress).isUsTaxable
        let rejected = mutations.missingFields
        ScrollView {
            VStack(spacing: 0) {
                DocumentSummary(
                    balanceDue: invoice.balanceDue,
                    total: invoice.total,
                    currency: currency,
                    dueDate: invoice.dueDate,
                    status: invoice.displayStatus(),
                    balanceLabel: BooksStrings.invoiceDetailBalanceDue,
                    totalLabel: BooksStrings.invoiceDetailTotal,
                    isInvoice: true
                )
                if missingUsAddress {
                    Banner(BooksStrings.invoiceDetailAddressMissing, tone: "warning")
                }
                if isDraft, !companyMissing.isEmpty, rejected.isEmpty {
                    Banner(
                        BooksStrings.invoiceDetailCompanyFieldsMissing(fields: invoiceFieldNames(companyMissing, labels: books.labels)),
                        tone: "warning"
                    )
                    addCompanyButton(tag: "add-company-details")
                }
                if let error = mutations.error {
                    Banner(
                        rejected.isEmpty
                            ? error
                            : BooksStrings.invoiceDetailCompanyFieldsRejected(fields: invoiceFieldNames(rejected, labels: books.labels)),
                        tone: "error",
                        title: BooksStrings.invoiceDetailFinaliseFailed,
                        onClose: { mutations.clear() }
                    )
                    if !rejected.isEmpty {
                        addCompanyButton(tag: nil)
                    }
                }
                details
                DocumentLines(lines: invoice.lines, currency: currency, title: BooksStrings.invoiceDetailLineItems, isInvoice: true)
                DocumentTotals(
                    subtotal: invoice.subtotal,
                    taxTotal: invoice.taxTotal,
                    total: invoice.total,
                    amountPaid: invoice.amountPaid,
                    balanceDue: invoice.balanceDue,
                    currency: currency,
                    taxLabel: books.labels.tax,
                    taxBreakdown: invoice.taxBreakdown,
                    isInvoice: true
                )
                if books.isUs {
                    TaxBreakdownCard(rows: invoice.taxBreakdown, warnings: invoice.taxWarnings, currency: currency, initiallyExpanded: isDraft)
                } else if TaxBreakdown.hasTreatments(invoice.taxBreakdown) {
                    TreatmentBreakdownCard(rows: invoice.taxBreakdown, currency: currency)
                }
                notes
                actions(isDraft: isDraft)
            }
            .padding(.bottom, Tokens.Spacing.xl)
        }
        .tagged("invoice-detail")
    }

    private func addCompanyButton(tag: String?) -> some View {
        Button(action: onAddCompany) {
            Text(BooksStrings.invoiceDetailAddCompanyDetails)
        }
        .buttonStyle(.bordered)
        .tagged(tag)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, Tokens.Spacing.l)
        .padding(.vertical, Tokens.Spacing.xs)
    }

    private var details: some View {
        SectionCard(title: BooksStrings.invoiceDetailDetails) {
            if invoice.isCreditNote {
                DetailRow(BooksStrings.invoiceDetailDocumentType, books.labels.creditNote)
            }
            DetailRow(BooksStrings.invoiceDetailCustomer, invoice.contactName ?? BooksStrings.commonDash)
            if let email = invoice.contactEmail {
                DetailRow(BooksStrings.invoiceDetailEmail, email)
            }
            DetailRow(BooksStrings.invoiceDetailIssueDate, books.date(invoice.issueDate))
            DetailRow(BooksStrings.invoiceDetailDueDate, books.date(invoice.dueDate))
            if let reference = invoice.reference {
                DetailRow(BooksStrings.invoiceDetailReference, reference)
            }
            if books.isUs {
                let shipTo = Addresses.lines(invoice.shippingAddress)
                let billTo = Addresses.lines(invoice.billingAddress)
                if !shipTo.isEmpty {
                    DetailRow(BooksStrings.invoiceDetailShipTo, shipTo.joined(separator: "\n"))
                }
                if !billTo.isEmpty, billTo != shipTo {
                    DetailRow(BooksStrings.invoiceDetailBillTo, billTo.joined(separator: "\n"))
                }
            }
        }
    }

    @ViewBuilder
    private var notes: some View {
        if let notes = invoice.notes {
            SectionCard(title: BooksStrings.invoiceDetailNotes) {
                Text(notes)
                    .font(.inter(.subheadline))
                    .foregroundStyle(Color.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    /// Finalise a draft; send, record a payment, or view the document of a booked invoice.
    private func actions(isDraft: Bool) -> some View {
        let canSend = !isDraft && !Statuses.invoiceIsSettled(invoice.status)
        let canPay = invoice.balanceDue > 0 && !isDraft && invoice.status != "cancelled"
        let store = books.store
        let invoiceId = invoice.id
        return VStack(spacing: Tokens.Spacing.s) {
            if isDraft {
                Button {
                    mutations.run(toaster, success: BooksStrings.invoiceDetailFinalised, reload: reload) {
                        try await store.finalizeInvoice(id: invoiceId)
                    }
                } label: {
                    Label(BooksStrings.invoiceDetailFinalise, systemImage: "lock")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .disabled(mutations.busy)
                .tagged("finalise-invoice")
            }
            if canSend {
                Button {
                    mutations.run(toaster, success: BooksStrings.invoiceDetailSent, reload: reload) {
                        try await store.sendInvoice(id: invoiceId)
                    }
                } label: {
                    Label(BooksStrings.invoiceDetailSend, systemImage: "paperplane")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .controlSize(.large)
                .disabled(mutations.busy)
                .tagged("send-invoice")
            }
            if canPay {
                Button(action: onPay) {
                    Label(BooksStrings.invoiceDetailRecordPayment, systemImage: "banknote")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .disabled(mutations.busy)
                .tagged("record-payment")
            }
            Button(action: onOpenDocument) {
                Label(BooksStrings.invoiceDetailViewDocument, systemImage: "doc.text")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderless)
            .controlSize(.large)
        }
        .padding(Tokens.Spacing.m)
    }
}

// MARK: - Document

/// The printable invoice (HTML from the server), with sharing as a PDF.
struct InvoiceDocumentView: View {
    let id: String

    @Environment(Books.self) private var books
    @Environment(Toaster.self) private var toaster
    @State private var loaded = Loaded<String>()
    @State private var holder = InvoiceWebHolder()
    @State private var ready = false
    @State private var rendering = false
    @State private var shared: InvoiceSharedPdf?

    init(id: String) {
        self.id = id
    }

    var body: some View {
        LoadedContent(loaded, loadError: BooksStrings.invoiceDocumentLoadError, id: id) {
            try await books.store.invoiceDocument(id: id)
        } content: { html in
            InvoiceWebView(html: html, holder: holder) { ready = true }
                .ignoresSafeArea(edges: .bottom)
                .tagged("invoice-document")
        }
        .overlay {
            if rendering {
                ProgressView(BooksStrings.invoiceDocumentRendering)
                    .padding(Tokens.Spacing.l)
                    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: Tokens.Radius.large))
            }
        }
        .navigationTitle(BooksStrings.invoiceDocumentTitle)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                if loaded.data != nil, ready {
                    Button(action: share) {
                        Label(BooksStrings.invoiceDocumentSharePdf, systemImage: "square.and.arrow.up")
                            .labelStyle(.iconOnly)
                    }
                    .disabled(rendering)
                    .tagged("share-document")
                }
            }
        }
        .sheet(item: $shared) { file in
            InvoiceShareSheet(url: file.url)
                .presentationDetents([.medium, .large])
        }
    }

    private func share() {
        guard let view = holder.view, !rendering else { return }
        rendering = true
        Task {
            // Let the badge show before the main thread is busy drawing the pages.
            try? await Task.sleep(for: .milliseconds(50))
            do {
                let url = try InvoicePdf.write(view, id: id)
                shared = InvoiceSharedPdf(url: url)
            } catch {
                toaster.show(BooksStrings.invoiceDocumentShareFailed)
            }
            rendering = false
        }
    }
}

/// The PDF waiting to be shared.
private struct InvoiceSharedPdf: Identifiable {
    let url: URL
    var id: String { url.absoluteString }
}

/// The web view showing the document, for drawing it into a PDF.
@MainActor
private final class InvoiceWebHolder {
    weak var view: WKWebView?
}

/// The document is our own markup: scripts off, nothing stored, and nothing in it navigates anywhere.
private struct InvoiceWebView: UIViewRepresentable {
    let html: String
    let holder: InvoiceWebHolder
    let onLoaded: () -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(onLoaded: onLoaded)
    }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = false
        configuration.dataDetectorTypes = []
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = context.coordinator
        view.uiDelegate = context.coordinator
        view.isOpaque = true
        view.backgroundColor = .white
        view.scrollView.backgroundColor = .white
        holder.view = view
        return view
    }

    func updateUIView(_ view: WKWebView, context: Context) {
        context.coordinator.onLoaded = onLoaded
        holder.view = view
        guard context.coordinator.html != html else { return }
        context.coordinator.html = html
        context.coordinator.loaded = false
        view.loadHTMLString(html, baseURL: nil)
    }

    static func dismantleUIView(_ view: WKWebView, coordinator: Coordinator) {
        view.navigationDelegate = nil
        view.uiDelegate = nil
    }

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        var html: String?
        /// The document has loaded: from now on every navigation is a link, and links go nowhere.
        var loaded = false
        var onLoaded: () -> Void

        init(onLoaded: @escaping () -> Void) {
            self.onLoaded = onLoaded
        }

        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction) async -> WKNavigationActionPolicy {
            if !loaded, navigationAction.navigationType == .other { return .allow }
            return .cancel
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            loaded = true
            onLoaded()
        }

        /// `target="_blank"`: never a new web view.
        func webView(
            _ webView: WKWebView,
            createWebViewWith configuration: WKWebViewConfiguration,
            for navigationAction: WKNavigationAction,
            windowFeatures: WKWindowFeatures
        ) -> WKWebView? {
            nil
        }
    }
}

/// A4 paper with a margin, for drawing the document into pages.
private final class InvoicePageRenderer: UIPrintPageRenderer {
    private let paper = CGRect(x: 0, y: 0, width: 595.2, height: 841.8)

    override var paperRect: CGRect { paper }
    override var printableRect: CGRect { paper.insetBy(dx: 28, dy: 28) }
}

/// The rendered document on A4 pages, as a file to share.
@MainActor
private enum InvoicePdf {
    struct Failed: Error {}

    static func write(_ view: WKWebView, id: String) throws -> URL {
        let renderer = InvoicePageRenderer()
        renderer.addPrintFormatter(view.viewPrintFormatter(), startingAtPageAt: 0)
        let pages = renderer.numberOfPages
        guard pages > 0 else { throw Failed() }
        let paper = renderer.paperRect
        let data = UIGraphicsPDFRenderer(bounds: paper, format: UIGraphicsPDFRendererFormat()).pdfData { context in
            renderer.prepare(forDrawingPages: NSRange(location: 0, length: pages))
            for page in 0..<pages {
                context.beginPage()
                renderer.drawPage(at: page, in: paper)
            }
        }
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("shared", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let name = String(id.filter { $0.isLetter || $0.isNumber || $0 == "_" || $0 == "-" })
        let file = folder.appendingPathComponent("invoice-\(name).pdf")
        try data.write(to: file, options: .atomic)
        return file
    }
}

/// The system share sheet for a file.
private struct InvoiceShareSheet: UIViewControllerRepresentable {
    let url: URL

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: [url], applicationActivities: nil)
    }

    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}

// MARK: - New invoice

private enum InvoicePreviewState {
    case idle, loading, ready, failed
}

/// What the sales tax preview depends on: a change asks the server again.
private struct InvoicePreviewKey: Hashable {
    var isUs: Bool
    var lines: [LineDraft]
    var shipTo: AddressDraft
    var billTo: AddressDraft
    var issueDate: Day
    var name: String
}

/// A new draft invoice. The server numbers it now and books it on finalise. A
/// US invoice asks where the goods go and takes a tax code per line; the form
/// previews the server's sales tax as it is typed.
struct InvoiceFormView: View {
    @Environment(Books.self) private var books
    @Environment(BooksNavigator.self) private var navigator
    @Environment(Toaster.self) private var toaster

    @State private var name = ""
    @State private var email = ""
    @State private var issueDate = Days.today()
    @State private var dueDate = Days.today().adding(days: 30)
    @State private var lines: [LineDraft] = []
    @State private var shipTo = AddressDraft()
    @State private var billSame = true
    @State private var billTo = AddressDraft()
    @State private var notes = ""
    @State private var reference = ""
    @State private var saving = false
    @State private var nameError: String?
    @State private var itemsError: String?
    @State private var dueError: String?
    @State private var shipProblems = UsAddressProblems()
    @State private var billProblems = UsAddressProblems()
    @State private var preview: TaxPreview?
    @State private var previewState = InvoicePreviewState.idle

    init() {}

    private var isUs: Bool { books.isUs }
    private var mode: TaxMode { TaxMode.of(isUs: books.isUs, isInvoice: true) }
    private var defaultRate: String { Jurisdictions.defaultTaxRate(books.code) }
    private var billing: AddressDraft { billSame ? shipTo : billTo }

    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                SectionCard(title: BooksStrings.invoiceNewCustomer) {
                    FormField(
                        BooksStrings.invoiceNewName,
                        text: Binding(get: { name }, set: { value in
                            name = value
                            nameError = nil
                        }),
                        placeholder: isUs ? BooksStrings.examplesCompanyUs : BooksStrings.invoiceNewNamePlaceholder,
                        error: nameError,
                        helper: BooksStrings.invoiceNewNameHint,
                        tag: "invoice-customer"
                    )
                    FormField(
                        BooksStrings.invoiceNewEmail,
                        text: $email,
                        placeholder: BooksStrings.invoiceNewEmailPlaceholder,
                        keyboard: .emailAddress,
                        tag: "invoice-email"
                    )
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                }
                if isUs {
                    addresses
                }
                SectionCard(title: BooksStrings.invoiceNewDates) {
                    DateField(BooksStrings.invoiceNewIssueDate, value: $issueDate, tag: "invoice-issue-date")
                    DateField(BooksStrings.invoiceNewDueDate, value: $dueDate, error: dueError, tag: "invoice-due-date")
                }
                LineItemsEditor(
                    lines: $lines,
                    mode: mode,
                    defaultTaxRate: defaultRate,
                    currency: books.currency,
                    error: itemsError,
                    serverTax: isUs
                        ? ServerTax(taxTotal: preview?.taxTotal ?? 0, total: preview?.total ?? 0, loading: previewState != .ready)
                        : nil
                )
                if isUs {
                    previewSection
                }
                SectionCard(title: BooksStrings.invoiceNewExtras) {
                    FormField(BooksStrings.invoiceNewNotes, text: $notes, placeholder: BooksStrings.invoiceNewNotesPlaceholder, lines: 3)
                    FormField(BooksStrings.invoiceNewReference, text: $reference, placeholder: BooksStrings.invoiceNewReferencePlaceholder)
                }
                Button(action: save) {
                    Text(BooksStrings.invoiceNewCreateDraft)
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .disabled(saving)
                .tagged("create-invoice")
                .padding(Tokens.Spacing.m)
            }
            .padding(.bottom, Tokens.Spacing.xl)
        }
        .scrollDismissesKeyboard(.interactively)
        .groupedBackground()
        .tagged("invoice-form")
        .navigationTitle(BooksStrings.invoiceNewTitle)
        .navigationBarTitleDisplayMode(.inline)
        .onAppear {
            if lines.isEmpty { lines = [LineItems.empty(taxRate: defaultRate)] }
        }
        .onChange(of: issueDate) { dueError = nil }
        .onChange(of: dueDate) { dueError = nil }
        .onChange(of: lines) { itemsError = nil }
        .task(id: InvoicePreviewKey(isUs: isUs, lines: lines, shipTo: shipTo, billTo: billing, issueDate: issueDate, name: name)) {
            await refreshPreview()
        }
    }

    /// US: where the goods go (it decides the sales tax), and who pays when someone else does.
    @ViewBuilder
    private var addresses: some View {
        SectionCard(title: BooksStrings.invoiceNewShipTo) {
            HintText(BooksStrings.invoiceNewShipToHint)
            AddressFields(
                value: Binding(get: { shipTo }, set: { value in
                    shipTo = value
                    shipProblems = UsAddressProblems()
                }),
                problems: shipProblems
            )
            SwitchRow(BooksStrings.invoiceNewBillToSame, isOn: $billSame)
        }
        if !billSame {
            SectionCard(title: BooksStrings.invoiceNewBillTo) {
                AddressFields(
                    value: Binding(get: { billTo }, set: { value in
                        billTo = value
                        billProblems = UsAddressProblems()
                    }),
                    problems: billProblems
                )
            }
        }
    }

    @ViewBuilder
    private var previewSection: some View {
        switch previewState {
        case .idle:
            Text(BooksStrings.salesTaxNeedsAddress)
                .font(.inter(.footnote))
                .foregroundStyle(Color.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, Tokens.Spacing.xl)
                .padding(.vertical, Tokens.Spacing.xs)
        case .loading:
            Banner(BooksStrings.salesTaxCalculating)
        case .failed:
            Banner(BooksStrings.salesTaxPreviewFailed, tone: "warning")
        case .ready:
            if let preview {
                TaxBreakdownCard(
                    rows: preview.taxBreakdown,
                    warnings: preview.warnings,
                    currency: books.currency,
                    footnote: BooksStrings.salesTaxEstimateNote
                )
            }
        }
    }

    /// US: the sales tax the server would charge, once there is something to tax and a place to tax it.
    private func refreshPreview() async {
        guard isUs else { return }
        let inputs = LineItems.inputs(lines, mode: mode, decimalPoint: books.decimalPoint)
        if inputs.isEmpty || !shipTo.isUsTaxable {
            preview = nil
            previewState = .idle
            return
        }
        previewState = .loading
        try? await Task.sleep(for: .milliseconds(800))
        if Task.isCancelled { return }
        do {
            let result = try await books.store.previewSalesTax(
                contactName: name,
                issueDate: issueDate.iso,
                shipTo: Addresses.usAddress(shipTo),
                billTo: Addresses.usAddress(billing),
                lines: inputs
            )
            if Task.isCancelled { return }
            preview = result
            previewState = .ready
        } catch {
            if !Task.isCancelled { previewState = .failed }
        }
    }

    private func save() {
        nameError = name.isBlank ? BooksStrings.invoiceNewNameError : nil
        itemsError = LineItems.valid(lines, decimalPoint: books.decimalPoint).isEmpty ? BooksStrings.invoiceNewItemsError : nil
        dueError = dueDate < issueDate ? BooksStrings.invoiceNewDueBeforeIssue : nil
        if isUs {
            shipProblems = Addresses.usProblems(shipTo, requireStateAndZip: true)
            billProblems = billSame ? UsAddressProblems() : Addresses.usProblems(billTo)
        }
        if nameError != nil || itemsError != nil || dueError != nil { return }
        if isUs, !shipProblems.isEmpty || !billProblems.isEmpty { return }
        let values = NewInvoice(
            contactName: name.trimmed,
            contactEmail: email.trimmed.nilIfEmpty,
            issueDate: issueDate.iso,
            dueDate: dueDate.iso,
            notes: notes.trimmed.nilIfEmpty,
            reference: reference.trimmed.nilIfEmpty,
            shippingAddress: isUs ? Addresses.usAddress(shipTo) : nil,
            billingAddress: isUs ? Addresses.usAddress(billing) : nil,
            lines: LineItems.inputs(lines, mode: mode, decimalPoint: books.decimalPoint)
        )
        let store = books.store
        saving = true
        Task {
            do {
                let id = try await store.createInvoice(values)
                toaster.show(BooksStrings.invoiceNewCreated)
                navigator.replace(with: .invoice(id: id))
            } catch {
                toaster.show(ErrorTexts.describe(error, fallback: BooksStrings.invoiceNewCreateFailed))
            }
            saving = false
        }
    }
}
