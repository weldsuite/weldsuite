import SwiftUI
import UIKit
import WeldCore
import WeldUI

// One bill, the new-bill form and the receipt previews (Android `ui/BillScreens.kt`).

// MARK: - Receipt previews

/// A receipt image as a thumbnail that opens full screen. `loading` while it is
/// fetched; `pdf` for a document that has no image; `failed` when it couldn't be read.
struct ReceiptPreview: View {
    let image: UIImage?
    let loading: Bool
    let pdf: Bool
    let failed: Bool

    @State private var open = false

    init(image: UIImage?, loading: Bool = false, pdf: Bool = false, failed: Bool = false) {
        self.image = image
        self.loading = loading
        self.pdf = pdf
        self.failed = failed
    }

    var body: some View {
        if image != nil || loading || pdf || failed {
            SectionCard(title: BooksStrings.receiptTitle) {
                thumbnail
            }
            .fullScreenCover(isPresented: $open) {
                if let image {
                    ReceiptFullScreenView(image: image)
                }
            }
        }
    }

    @ViewBuilder
    private var thumbnail: some View {
        let shape = RoundedRectangle(cornerRadius: Tokens.Radius.medium)
        if let image {
            Button {
                open = true
            } label: {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .frame(height: 160)
                    .background(Color(uiColor: .tertiarySystemFill), in: shape)
                    .clipShape(shape)
                    .contentShape(shape)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(BooksStrings.receiptOpen)
            .tagged("receipt-preview")
        } else {
            Group {
                if loading {
                    ProgressView()
                } else if pdf {
                    VStack(spacing: Tokens.Spacing.xs) {
                        Image(systemName: "doc.richtext")
                            .font(.inter(.title2))
                            .accessibilityHidden(true)
                        Text(BooksStrings.receiptPdf).font(.inter(.footnote))
                    }
                    .foregroundStyle(Color.secondary)
                } else {
                    Text(BooksStrings.receiptUnavailable)
                        .font(.inter(.footnote))
                        .foregroundStyle(Color.secondary)
                }
            }
            .frame(maxWidth: .infinity)
            .frame(height: 160)
            .background(Color(uiColor: .tertiarySystemFill), in: shape)
            .accessibilityElement(children: .combine)
            .tagged("receipt-preview")
        }
    }
}

/// The receipt full screen: pinch or double-tap to zoom, drag to look around.
private struct ReceiptFullScreenView: View {
    let image: UIImage

    @Environment(\.dismiss) private var dismiss
    @State private var scale: CGFloat = 1
    @State private var lastScale: CGFloat = 1
    @State private var offset: CGSize = .zero
    @State private var lastOffset: CGSize = .zero

    init(image: UIImage) {
        self.image = image
    }

    var body: some View {
        ZStack(alignment: .topTrailing) {
            Color.black.ignoresSafeArea()
            Image(uiImage: image)
                .resizable()
                .scaledToFit()
                .scaleEffect(scale)
                .offset(offset)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .contentShape(Rectangle())
                .gesture(
                    MagnifyGesture()
                        .onChanged { value in
                            scale = max(1, min(5, lastScale * value.magnification))
                        }
                        .onEnded { _ in
                            lastScale = scale
                            if scale <= 1 { reset() }
                        }
                )
                .simultaneousGesture(
                    DragGesture()
                        .onChanged { value in
                            guard scale > 1 else { return }
                            offset = CGSize(
                                width: lastOffset.width + value.translation.width,
                                height: lastOffset.height + value.translation.height
                            )
                        }
                        .onEnded { _ in
                            lastOffset = offset
                        }
                )
                .onTapGesture(count: 2) {
                    withAnimation {
                        if scale > 1 {
                            reset()
                        } else {
                            scale = 2.5
                            lastScale = 2.5
                        }
                    }
                }
                .accessibilityLabel(BooksStrings.receiptTitle)
            Button {
                dismiss()
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundStyle(Color.white)
                    .padding(10)
                    .background(Color.black.opacity(0.4), in: Circle())
            }
            .accessibilityLabel(BooksStrings.receiptClose)
            .tagged("receipt-close")
            .padding(Tokens.Spacing.l)
        }
    }

    private func reset() {
        scale = 1
        lastScale = 1
        offset = .zero
        lastOffset = .zero
    }
}

/// A photo kept on this phone (a scan not stored yet), read for the preview.
/// `path` is the file's name in the offline queue's folder (`QueuedReceipt.path`).
struct LocalReceiptPreview: View {
    let path: String?
    let mimeType: String?

    @Environment(Books.self) private var books
    @State private var image: UIImage?
    @State private var loadedPath: String?

    init(path: String?, mimeType: String?) {
        self.path = path
        self.mimeType = mimeType
    }

    var body: some View {
        if let path {
            let isImage = mimeType.map { $0.hasPrefix("image/") } ?? true
            let done = loadedPath == path
            ReceiptPreview(
                image: done ? image : nil,
                loading: isImage && !done,
                pdf: mimeType == "application/pdf",
                failed: isImage && done && image == nil
            )
            .task(id: path) { await load(path) }
        }
    }

    private func load(_ path: String) async {
        if loadedPath == path { return }
        let url = books.queue.fileURL(path: path)
        let data = await Task.detached(priority: .userInitiated) { try? Data(contentsOf: url) }.value
        var decoded: UIImage?
        if let data, let raw = UIImage(data: data) {
            decoded = await raw.byPreparingForDisplay() ?? raw
        }
        if Task.isCancelled { return }
        image = decoded
        loadedPath = path
    }
}

/// The receipt a bill was booked from, read from storage with the member's own token. Shows nothing without an image.
struct StoredReceiptPreview: View {
    let documentId: String?

    @Environment(Books.self) private var books
    @State private var image: UIImage?
    @State private var loadedId: String?

    init(documentId: String?) {
        self.documentId = documentId
    }

    var body: some View {
        if let documentId {
            let loading = loadedId != documentId
            VStack(spacing: 0) {
                if loading || image != nil {
                    ReceiptPreview(image: loading ? nil : image, loading: loading)
                }
            }
            .task(id: documentId) { await load(documentId) }
        }
    }

    private func load(_ documentId: String) async {
        if loadedId == documentId { return }
        var decoded: UIImage?
        if let file = try? await books.store.storedReceipt(documentId: documentId), let raw = UIImage(data: file.bytes) {
            decoded = await raw.byPreparingForDisplay() ?? raw
        }
        if Task.isCancelled { return }
        image = decoded
        loadedId = documentId
    }
}

// MARK: - Detail

private enum BillConfirmKind {
    case reject, delete
}

/// The reason the server records for a bill rejected from the app (the same text Android sends).
private let billRejectReason = "Rejected from the WeldBooks mobile app"

/// One bill: approve or reject it while it awaits approval, record its payment once approved.
struct BillDetailView: View {
    let id: String

    @Environment(Books.self) private var books
    @Environment(BooksNavigator.self) private var navigator
    @Environment(Toaster.self) private var toaster
    @Environment(\.dismiss) private var dismiss
    @State private var loaded = Loaded<Bill>()
    @State private var mutations = Mutations()
    @State private var paying = false
    @State private var confirm: BillConfirmKind?

    init(id: String) {
        self.id = id
    }

    private var title: String { loaded.data?.number ?? BooksStrings.billDetailTitle }

    var body: some View {
        LoadedContent(loaded, loadError: BooksStrings.billDetailLoadError, id: id) {
            try await books.store.bill(id: id)
        } content: { bill in
            BillBodyView(
                bill: bill,
                mutations: mutations,
                onPay: { paying = true },
                onReject: { confirm = .reject },
                reload: { await loaded.load() }
            )
        }
        .groupedBackground()
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                BillNavTitle(title: title, subtitle: loaded.data?.contactName)
            }
            ToolbarItem(placement: .primaryAction) {
                if let bill = loaded.data, Statuses.billAwaitsApproval(bill) {
                    Button(role: .destructive) {
                        confirm = .delete
                    } label: {
                        Label(BooksStrings.billDetailDeleteBill, systemImage: "trash")
                            .labelStyle(.iconOnly)
                    }
                    .tint(Tokens.Status.danger)
                    .tagged("delete-bill")
                }
            }
        }
        .realtimeRefresh(books.env, topics: BooksTopics.bills) { await loaded.load() }
        .sheet(isPresented: $paying) {
            paymentSheet
        }
        .confirmDialog(
            BooksStrings.billDetailRejectTitle,
            isPresented: confirming(.reject),
            message: BooksStrings.billDetailRejectMessage,
            confirm: BooksStrings.billDetailReject,
            destructive: true
        ) { reject() }
        .confirmDialog(
            BooksStrings.billDetailDeleteTitle,
            isPresented: confirming(.delete),
            message: BooksStrings.billDetailDeleteMessage,
            confirm: CoreStrings.commonDelete,
            destructive: true
        ) { deleteBill() }
    }

    @ViewBuilder
    private var paymentSheet: some View {
        if let bill = loaded.data {
            PaymentSheet(balanceDue: bill.balanceDue, currency: bill.currency ?? books.currency, received: false, busy: mutations.busy) { payment in
                paying = false
                let store = books.store
                mutations.run(toaster, success: BooksStrings.billDetailPaymentRecorded, reload: { await loaded.load() }) {
                    try await store.recordBillPayment(id: bill.id, payment: payment)
                }
            }
            .booksContext(books: books, navigator: navigator, toaster: toaster)
        }
    }

    private func confirming(_ kind: BillConfirmKind) -> Binding<Bool> {
        Binding(
            get: { confirm == kind },
            set: { shown in if !shown, confirm == kind { confirm = nil } }
        )
    }

    private func reject() {
        guard let bill = loaded.data else { return }
        let store = books.store
        mutations.run(toaster, success: BooksStrings.billDetailRejected, reload: { await loaded.load() }) {
            try await store.rejectBill(id: bill.id, reason: billRejectReason)
        }
    }

    private func deleteBill() {
        guard let bill = loaded.data else { return }
        let store = books.store
        mutations.remove(
            toaster,
            success: BooksStrings.billDetailDeleted,
            failMessage: BooksStrings.billDetailDeleteFailed,
            leave: { dismiss() }
        ) {
            try await store.deleteBill(id: bill.id)
        }
    }
}

/// The title and the supplier under it, in the navigation bar.
private struct BillNavTitle: View {
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

private struct BillBodyView: View {
    let bill: Bill
    let mutations: Mutations
    let onPay: () -> Void
    let onReject: () -> Void
    let reload: () async -> Void

    @Environment(Books.self) private var books
    @Environment(Toaster.self) private var toaster

    var body: some View {
        let currency = bill.currency ?? books.currency
        // US: the vendor's tax is part of the cost; use tax accrued where it charged none is owed to the state.
        let useTax: Decimal = books.isUs ? TaxBreakdown.useTaxTotal(bill.taxBreakdown) : 0
        ScrollView {
            VStack(spacing: 0) {
                DocumentSummary(
                    balanceDue: bill.balanceDue,
                    total: bill.total,
                    currency: currency,
                    dueDate: bill.dueDate,
                    status: bill.displayStatus(),
                    balanceLabel: BooksStrings.billDetailBalanceDue,
                    totalLabel: BooksStrings.billDetailTotal,
                    isInvoice: false
                )
                if let error = mutations.error {
                    Banner(error, tone: "error", onClose: { mutations.clear() })
                }
                details
                StoredReceiptPreview(documentId: bill.sourceDocumentId)
                DocumentLines(lines: bill.lines, currency: currency, title: BooksStrings.billDetailLineItems, isInvoice: false)
                DocumentTotals(
                    subtotal: bill.subtotal,
                    taxTotal: bill.taxTotal,
                    total: bill.total,
                    amountPaid: bill.amountPaid,
                    balanceDue: bill.balanceDue,
                    currency: currency,
                    taxLabel: books.isUs ? BooksStrings.billDetailTaxPaid(tax: books.labels.tax) : books.labels.tax,
                    taxBreakdown: bill.taxBreakdown,
                    isInvoice: false,
                    extraRows: useTax > 0 ? [(BooksStrings.salesTaxUseTaxAccrued, books.money(useTax, currency: currency))] : []
                )
                if !books.isUs, TaxBreakdown.hasTreatments(bill.taxBreakdown) {
                    TreatmentBreakdownCard(rows: bill.taxBreakdown, currency: currency)
                }
                if useTax > 0 {
                    TaxBreakdownCard(
                        rows: bill.taxBreakdown,
                        warnings: [],
                        currency: currency,
                        title: BooksStrings.salesTaxUseTaxAccrued,
                        footnote: BooksStrings.billDetailUseTaxHint(supplier: books.labels.supplierLower)
                    )
                }
                notes
                actions
            }
            .padding(.bottom, Tokens.Spacing.xl)
        }
        .tagged("bill-detail")
    }

    private var details: some View {
        SectionCard(title: BooksStrings.billDetailDetails) {
            DetailRow(books.labels.supplier, bill.contactName ?? BooksStrings.commonDash)
            DetailRow(BooksStrings.billDetailIssueDate, books.date(bill.issueDate))
            DetailRow(BooksStrings.billDetailDueDate, books.date(bill.dueDate))
            if let reference = bill.reference {
                DetailRow(BooksStrings.billDetailReference, reference)
            }
            if books.isUs {
                let delivered = Addresses.lines(bill.deliveryAddress)
                if !delivered.isEmpty {
                    DetailRow(BooksStrings.billDetailDeliveredTo, delivered.joined(separator: "\n"))
                }
            }
        }
    }

    @ViewBuilder
    private var notes: some View {
        if let notes = bill.notes {
            SectionCard(title: BooksStrings.billDetailNotes) {
                Text(notes)
                    .font(.inter(.subheadline))
                    .foregroundStyle(Color.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    /// Approve or reject while it awaits approval; pay once approved.
    private var actions: some View {
        let store = books.store
        let billId = bill.id
        return VStack(spacing: Tokens.Spacing.s) {
            if Statuses.billAwaitsApproval(bill) {
                Button {
                    mutations.run(toaster, success: BooksStrings.billDetailApproved, reload: reload) {
                        _ = try await store.approveBill(id: billId)
                    }
                } label: {
                    Label(BooksStrings.billDetailApprove, systemImage: "checkmark")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .disabled(mutations.busy)
                .tagged("approve-bill")
                Button(action: onReject) {
                    Label(BooksStrings.billDetailReject, systemImage: "xmark")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .controlSize(.large)
                .tint(Tokens.Status.danger)
                .disabled(mutations.busy)
                .tagged("reject-bill")
            }
            if Statuses.billIsPayable(bill) {
                Button(action: onPay) {
                    Label(BooksStrings.billDetailRecordPayment, systemImage: "banknote")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .disabled(mutations.busy)
                .tagged("record-bill-payment")
            }
        }
        .padding(Tokens.Spacing.m)
    }
}

// MARK: - New bill

private enum BillOcrState {
    case idle, loading, ready, failed
}

/// What OCR read about the supplier: the name, the contact it matched (by VAT number, KvK or IBAN) and the currency.
private struct BillScan: Hashable {
    var contactName: String?
    var matchedContactId: String?
    var currency: String?
}

/// A new bill, filled in from a scanned receipt when there is one. The receipt
/// stays attached as the bill's source document; a photo kept on the phone is
/// stored first.
struct BillFormView: View {
    let documentId: String?
    /// A photo kept on the phone: its file name in the offline queue's folder.
    let receipt: String?
    let receiptType: String?

    @Environment(Books.self) private var books
    @Environment(BooksNavigator.self) private var navigator
    @Environment(Toaster.self) private var toaster

    @State private var name = ""
    @State private var number = ""
    @State private var issueDate = Days.today()
    @State private var dueDate = Days.today().adding(days: 30)
    @State private var lines: [LineDraft] = []
    @State private var deliveredTo = AddressDraft()
    @State private var deliveredProblems = UsAddressProblems()
    @State private var notes = ""
    @State private var reference = ""
    @State private var saving = false
    @State private var ocr: BillOcrState
    @State private var scanned: BillScan?
    @State private var nameError: String?
    @State private var itemsError: String?
    @State private var dueError: String?

    init(documentId: String?, receipt: String?, receiptType: String?) {
        self.documentId = documentId
        self.receipt = receipt
        self.receiptType = receiptType
        _ocr = State(initialValue: documentId == nil ? .idle : .loading)
    }

    private var isUs: Bool { books.isUs }
    private var mode: TaxMode { TaxMode.of(isUs: books.isUs, isInvoice: false) }
    private var defaultRate: String { Jurisdictions.defaultTaxRate(books.code) }
    private var accruesUseTax: Bool { isUs && lines.contains { $0.accrueUseTax } }

    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                ocrBanner
                LocalReceiptPreview(path: receipt, mimeType: receiptType)
                SectionCard(title: books.labels.supplier) {
                    FormField(
                        BooksStrings.billNewName,
                        text: Binding(get: { name }, set: { value in
                            name = value
                            nameError = nil
                        }),
                        placeholder: BooksStrings.billNewNamePlaceholder(supplier: books.labels.supplierLower),
                        error: nameError,
                        helper: BooksStrings.billNewNameHint,
                        tag: "bill-supplier"
                    )
                    FormField(BooksStrings.billNewBillNumber, text: $number, placeholder: BooksStrings.billNewBillNumberPlaceholder)
                }
                SectionCard(title: BooksStrings.billNewDates) {
                    DateField(BooksStrings.billNewIssueDate, value: $issueDate)
                    DateField(BooksStrings.billNewDueDate, value: $dueDate, error: dueError)
                }
                LineItemsEditor(lines: $lines, mode: mode, defaultTaxRate: defaultRate, currency: books.currency, error: itemsError)
                if accruesUseTax {
                    SectionCard(title: BooksStrings.billNewDeliveredTo) {
                        HintText(BooksStrings.billNewDeliveredToHint)
                        AddressFields(
                            value: Binding(get: { deliveredTo }, set: { value in
                                deliveredTo = value
                                deliveredProblems = UsAddressProblems()
                            }),
                            problems: deliveredProblems
                        )
                        HintText(BooksStrings.billNewUseTaxNote)
                    }
                }
                SectionCard(title: BooksStrings.billNewExtras) {
                    FormField(BooksStrings.billNewNotes, text: $notes, placeholder: BooksStrings.billNewNotesPlaceholder, lines: 3)
                    FormField(
                        BooksStrings.billNewReference,
                        text: $reference,
                        placeholder: BooksStrings.billNewReferencePlaceholder(supplier: books.labels.supplierLower)
                    )
                }
                Button(action: save) {
                    Text(BooksStrings.billNewCreate)
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .disabled(saving)
                .tagged("create-bill")
                .padding(Tokens.Spacing.m)
            }
            .padding(.bottom, Tokens.Spacing.xl)
        }
        .scrollDismissesKeyboard(.interactively)
        .groupedBackground()
        .tagged("bill-form")
        .navigationTitle(BooksStrings.billNewTitle)
        .navigationBarTitleDisplayMode(.inline)
        .onAppear {
            if lines.isEmpty { lines = [LineItems.empty(taxRate: defaultRate)] }
        }
        .onChange(of: issueDate) { dueError = nil }
        .onChange(of: dueDate) { dueError = nil }
        .onChange(of: lines) { itemsError = nil }
        .task(id: documentId) { await readReceipt() }
    }

    @ViewBuilder
    private var ocrBanner: some View {
        switch ocr {
        case .idle:
            EmptyView()
        case .loading:
            Banner(BooksStrings.billNewOcrLoading)
        case .ready:
            Banner(BooksStrings.billNewOcrReady, tone: "success")
        case .failed:
            Banner(BooksStrings.billNewOcrFailed, tone: "warning")
        }
    }

    /// Fill the form from what OCR read, once (never over what was typed since).
    private func readReceipt() async {
        guard let documentId, ocr == .loading else { return }
        do {
            let prefill = try await books.store.billFromDocument(id: documentId)
            if Task.isCancelled { return }
            apply(prefill)
            ocr = .ready
        } catch {
            if !Task.isCancelled { ocr = .failed }
        }
    }

    private func apply(_ prefill: BillPrefill) {
        if let contactName = prefill.contactName { name = contactName }
        if let externalReference = prefill.externalReference { reference = externalReference }
        let issued = Days.of(prefill.issueDate)
        let due = Days.of(prefill.dueDate)
        if let issued {
            issueDate = issued
            dueDate = due ?? issued.adding(days: 30)
        } else if let due {
            dueDate = due
        }
        if !prefill.items.isEmpty { lines = LineItems.fromPrefill(prefill, defaultTaxRate: defaultRate) }
        // The supplier OCR matched (by VAT number, KvK or IBAN) and the receipt's currency.
        scanned = BillScan(contactName: prefill.contactName, matchedContactId: prefill.matchedContactId, currency: prefill.currency)
    }

    private func save() {
        nameError = name.isBlank ? BooksStrings.billNewNameError(supplier: books.labels.supplierLower) : nil
        itemsError = LineItems.valid(lines, decimalPoint: books.decimalPoint).isEmpty ? BooksStrings.billNewItemsError : nil
        dueError = dueDate < issueDate ? BooksStrings.billNewDueBeforeIssue : nil
        // Use tax is rated where the goods were delivered; blank means the company address.
        let useTax = accruesUseTax
        deliveredProblems = useTax ? Addresses.usProblems(deliveredTo) : UsAddressProblems()
        if nameError != nil || itemsError != nil || dueError != nil || !deliveredProblems.isEmpty { return }

        let match = scanned
        let contactName = name.trimmed
        let matchedId = match?.matchedContactId
        let sameSupplier = matchedId != nil && contactName == match?.contactName?.trimmed
        let values = NewBill(
            contactId: sameSupplier ? matchedId : nil,
            contactName: contactName,
            billNumber: number.trimmed.nilIfEmpty,
            currency: match?.currency,
            issueDate: issueDate.iso,
            dueDate: dueDate.iso,
            notes: notes.trimmed.nilIfEmpty,
            reference: reference.trimmed.nilIfEmpty,
            sourceDocumentId: documentId,
            deliveryAddress: useTax ? Addresses.usAddress(deliveredTo) : nil,
            lines: LineItems.inputs(lines, mode: mode, decimalPoint: books.decimalPoint)
        )
        // A photo scanned offline (or whose upload failed) is stored now, so the bill links it.
        let keptReceipt: URL? = documentId == nil ? receipt.map { books.queue.fileURL(path: $0) } : nil
        let type = receiptType ?? "image/jpeg"
        let store = books.store
        saving = true
        Task {
            do {
                var bill = values
                if let keptReceipt, let bytes = await Self.read(keptReceipt) {
                    bill.sourceDocumentId = try await store.uploadReceipt(
                        LocalFile(bytes: bytes, fileName: OfflineQueue.receiptFileName(mimeType: type), mimeType: type)
                    )
                }
                let id = try await store.createBill(bill)
                // iOS never clears Application Support: the kept photo is stored now, so it goes.
                if let keptReceipt { try? FileManager.default.removeItem(at: keptReceipt) }
                toaster.show(BooksStrings.billNewCreated)
                navigator.replace(with: .bill(id: id))
            } catch {
                toaster.show(ErrorTexts.describe(error, fallback: BooksStrings.billNewCreateFailed))
            }
            saving = false
        }
    }

    /// A kept file's bytes, read off the main thread; nil when it is gone or empty.
    private static func read(_ url: URL) async -> Data? {
        let data = await Task.detached(priority: .userInitiated) { try? Data(contentsOf: url) }.value
        guard let data, !data.isEmpty else { return nil }
        return data
    }
}
