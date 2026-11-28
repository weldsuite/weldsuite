import AVFoundation
import PhotosUI
import SwiftUI
import UIKit
import UniformTypeIdentifiers
import VisionKit
import WeldCore
import WeldUI

// The receipt scanner and the quick expense (Android `ui/CaptureScreens.kt`).
//
// A captured receipt is kept in the offline queue's folder at once
// (`books.queue.keep`), so the forms it goes on to, and the queue, find it by
// its file name (`QueuedReceipt.path`). The scanner owns that file until it
// hands it to a form, queues it, or drops it.

// MARK: - Scanner

/// What the scanner is doing with the receipt it has.
private enum ScanStatus {
    case idle, uploading, reading, ready, failed, offline
}

/// A receipt on this phone, kept in the offline queue's folder.
private struct ScanCapture {
    let receipt: QueuedReceipt
    /// The photo as shown; nil for a PDF.
    let preview: UIImage?
    /// The company it was captured for: the open books could change before it is queued.
    let entityId: String?
}

/// The receipt scanner: the camera (straight away), a photo or a PDF, then
/// upload and OCR, so the bill or quick expense form opens filled in. If OCR
/// fails the receipt still attaches. Offline, a quick expense takes the photo
/// along; leaving any other way keeps it in the offline queue.
struct ScanView: View {
    @Environment(Books.self) private var books
    @Environment(BooksNavigator.self) private var navigator
    @Environment(Toaster.self) private var toaster

    @State private var captured: ScanCapture?
    @State private var status: ScanStatus = .idle
    @State private var documentId: String?
    @State private var prefill: BillPrefill?
    @State private var failure: String?
    @State private var request = 0
    @State private var launched = false
    @State private var cameraOpen = false
    @State private var cameraDenied = false
    @State private var choosingPhoto = false
    @State private var photoItem: PhotosPickerItem?
    @State private var choosingPdf = false
    /// A receipt captured offline that no quick expense took along: leaving keeps it in the queue.
    @State private var unsaved: ScanCapture?
    /// The receipt went on to a form, which has the file now.
    @State private var handedOver = false
    @State private var finished = false

    init() {}

    private var busy: Bool { status == .uploading || status == .reading }

    private var cameraAvailable: Bool {
        VNDocumentCameraViewController.isSupported || UIImagePickerController.isSourceTypeAvailable(.camera)
    }

    var body: some View {
        ZStack {
            NavigationStack {
                screen
                    .navigationTitle(captured == nil ? BooksStrings.scanScanReceipt : BooksStrings.scanReceipt)
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) {
                            Button {
                                leave()
                            } label: {
                                Image(systemName: "xmark")
                            }
                            .accessibilityLabel(BooksStrings.scanCloseScanner)
                            .tagged("back")
                        }
                    }
            }
            // The camera covers the scanner while it is open (not a second cover: the
            // scanner must not see itself disappear and queue its receipt).
            if cameraOpen {
                camera
                    .ignoresSafeArea()
            }
        }
        .photosPicker(isPresented: $choosingPhoto, selection: $photoItem, matching: .images)
        .onChange(of: photoItem) { _, item in
            guard let item else { return }
            photoItem = nil
            Task {
                guard let data = try? await item.loadTransferable(type: Data.self), let image = UIImage(data: data) else {
                    toaster.show(BooksStrings.scanCaptureFailed)
                    return
                }
                take(image)
            }
        }
        .fileImporter(isPresented: $choosingPdf, allowedContentTypes: [.pdf]) { result in
            guard case let .success(url) = result else { return }
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            guard let data = try? Data(contentsOf: url), !data.isEmpty else {
                toaster.show(BooksStrings.scanCaptureFailed)
                return
            }
            capture(data, mimeType: "application/pdf", preview: nil)
        }
        .onAppear {
            // Straight to the camera, as the scan tab always did.
            guard !launched else { return }
            launched = true
            openCamera()
        }
        .onDisappear { finish() }
    }

    @ViewBuilder
    private var screen: some View {
        if let captured {
            review(captured)
        } else {
            choices
        }
    }

    @ViewBuilder
    private var camera: some View {
        if VNDocumentCameraViewController.isSupported {
            ScanDocumentCamera { cameraDone($0) }
        } else {
            ScanPhotoCamera { cameraDone($0) }
        }
    }

    // MARK: Choosing a receipt

    private var choices: some View {
        VStack(spacing: Tokens.Spacing.s) {
            Spacer(minLength: Tokens.Spacing.l)
            Image(systemName: "doc.text.viewfinder")
                .font(.system(size: 48))
                .foregroundStyle(Color.secondary)
                .accessibilityHidden(true)
            Text(BooksStrings.scanAlignHint)
                .font(.inter(.subheadline))
                .multilineTextAlignment(.center)
                .padding(.horizontal, Tokens.Spacing.l)
            if cameraDenied {
                Banner(BooksStrings.scanCameraDescription, tone: "warning", title: BooksStrings.scanCameraNeeded)
                Button(BooksStrings.scanGrantPermission) { openSettings() }
                    .tagged("scan-grant-permission")
            }
            Spacer(minLength: Tokens.Spacing.l)
            choiceButton(systemImage: "camera", label: BooksStrings.scanScanDocument, tag: "scan-camera") { openCamera() }
                .disabled(!cameraAvailable)
            choiceButton(systemImage: "photo.on.rectangle", label: BooksStrings.scanPickFromGallery, tag: "scan-gallery") {
                choosingPhoto = true
            }
            choiceButton(systemImage: "doc.richtext", label: BooksStrings.scanPickPdf, tag: "scan-pdf") {
                choosingPdf = true
            }
            Button(BooksStrings.scanGoBack) { leave() }
                .frame(maxWidth: .infinity)
                .padding(.top, Tokens.Spacing.xs)
        }
        .padding(Tokens.Spacing.l)
    }

    private func choiceButton(systemImage: String, label: String, tag: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(label, systemImage: systemImage)
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.bordered)
        .controlSize(.large)
        .tagged(tag)
    }

    // MARK: Reviewing it

    private func review(_ capture: ScanCapture) -> some View {
        VStack(spacing: Tokens.Spacing.s) {
            preview(capture)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            statusBanner
            Button {
                continueTo(bill: false)
            } label: {
                Text(BooksStrings.scanQuickExpense).frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .disabled(busy)
            .tagged("scan-quick-expense")
            // A bill is only made online; offline the photo goes with a quick expense.
            Button {
                continueTo(bill: true)
            } label: {
                Text(BooksStrings.scanCreateBill).frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .controlSize(.large)
            .disabled(busy || status == .offline)
            .tagged("scan-create-bill")
            HStack {
                Button(BooksStrings.scanRetake) { retake() }
                    .tagged("scan-retake")
                Spacer()
                Button(BooksStrings.scanClose) { leave() }
                    .tagged("scan-close")
            }
            .padding(.top, Tokens.Spacing.xs)
        }
        .padding(Tokens.Spacing.l)
    }

    @ViewBuilder
    private func preview(_ capture: ScanCapture) -> some View {
        if capture.receipt.mimeType == "application/pdf" {
            VStack(spacing: Tokens.Spacing.s) {
                Image(systemName: "doc.richtext")
                    .font(.system(size: 48))
                    .accessibilityHidden(true)
                Text(BooksStrings.scanPdfSelected)
            }
            .foregroundStyle(Color.secondary)
        } else if let image = capture.preview {
            Image(uiImage: image)
                .resizable()
                .scaledToFit()
                .clipShape(RoundedRectangle(cornerRadius: Tokens.Radius.medium))
                .accessibilityLabel(BooksStrings.scanReceipt)
                .tagged("scan-preview")
        }
    }

    @ViewBuilder
    private var statusBanner: some View {
        switch status {
        case .idle:
            EmptyView()
        case .uploading:
            Banner(BooksStrings.scanUploading)
        case .reading:
            Banner(BooksStrings.scanReading)
        case .ready:
            Banner(summary, tone: "success")
        case .failed:
            Banner(failure ?? BooksStrings.scanOcrFailed, tone: "warning")
        case .offline:
            Banner(BooksStrings.scanOfflineBanner)
        }
    }

    /// "Found Albert Heijn · €12.40. Review on the next screen."
    private var summary: String {
        guard let prefill else { return BooksStrings.scanAttached }
        let currency = prefill.currency ?? books.currency
        let amount: Decimal? = prefill.total ?? prefill.subtotal
        let parts: [String?] = [prefill.contactName, amount.map { books.money($0, currency: currency) }]
        let found = parts.compactMap { $0 }
        return found.isEmpty ? BooksStrings.scanExtracted : BooksStrings.scanFound(summary: found.joined(separator: " · "))
    }

    // MARK: Camera

    private func openCamera() {
        guard cameraAvailable else { return }
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .denied, .restricted:
            cameraDenied = true
        case .notDetermined:
            Task {
                if await AVCaptureDevice.requestAccess(for: .video) {
                    cameraDenied = false
                    cameraOpen = true
                } else {
                    cameraDenied = true
                }
            }
        default:
            cameraDenied = false
            cameraOpen = true
        }
    }

    private func openSettings() {
        if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
    }

    private func cameraDone(_ outcome: ScanCameraOutcome) {
        cameraOpen = false
        switch outcome {
        case let .photo(image):
            take(image)
        case .cancelled:
            break
        case .failed:
            toaster.show(BooksStrings.scanCaptureFailed)
        }
    }

    // MARK: Capture, upload and read

    /// A photo made at most 2000 px on its long side, as JPEG.
    private func take(_ image: UIImage) {
        guard let data = ScanImages.jpeg(image) else {
            toaster.show(BooksStrings.scanCaptureFailed)
            return
        }
        capture(data, mimeType: "image/jpeg", preview: UIImage(data: data))
    }

    private func capture(_ data: Data, mimeType: String, preview: UIImage?) {
        let kept: QueuedReceipt
        do {
            kept = try books.queue.keep(data, mimeType: mimeType)
        } catch {
            toaster.show(BooksStrings.scanCaptureFailed)
            return
        }
        process(ScanCapture(receipt: kept, preview: preview, entityId: books.store.entityId), data: data)
    }

    private func process(_ next: ScanCapture, data: Data) {
        request += 1
        let current = request
        if let previous = captured { discard(previous) }
        unsaved = nil
        captured = next
        documentId = nil
        prefill = nil
        failure = nil
        if !books.queue.isOnline {
            unsaved = next
            status = .offline
            return
        }
        status = .uploading
        let store = books.store
        Task {
            var uploaded: String?
            do {
                let id = try await store.uploadReceipt(LocalFile(bytes: data, fileName: next.receipt.fileName, mimeType: next.receipt.mimeType))
                uploaded = id
                guard current == request else { return }
                documentId = id
                status = .reading
                try await store.processDocument(id: id)
                let read = try await store.billFromDocument(id: id)
                guard current == request else { return }
                prefill = read
                status = .ready
            } catch {
                guard current == request else { return }
                status = .failed
                failure = Self.failureText(error, uploaded: uploaded != nil)
            }
        }
    }

    /// Why the receipt couldn't be read: not stored at all, no AI credits (402), too large, or anything else.
    private static func failureText(_ error: Error, uploaded: Bool) -> String {
        if !uploaded { return BooksStrings.scanUploadFailed }
        let failure = BooksError.from(error)
        if failure.api.status == 402 { return BooksStrings.scanOcrNoCredits }
        if failure.message?.lowercased().contains("too large") == true { return BooksStrings.scanOcrTooLarge }
        return BooksStrings.scanOcrFailed
    }

    private func retake() {
        request += 1
        if let captured { discard(captured) }
        unsaved = nil
        captured = nil
        status = .idle
    }

    /// On to the quick expense or a new bill, which take the receipt along.
    private func continueTo(bill: Bool) {
        guard let captured else { return }
        unsaved = nil
        handedOver = true
        finished = true
        let path = captured.receipt.path
        let type = captured.receipt.mimeType
        navigator.continueFromScan(
            bill
                ? .newBill(documentId: documentId, receipt: path, receiptType: type)
                : .quickExpense(documentId: documentId, receipt: path, receiptType: type)
        )
    }

    private func leave() {
        finish()
        navigator.closeScanner()
    }

    /// Leaving: a receipt captured offline goes to the queue; any other is dropped (it was stored, or couldn't be).
    private func finish() {
        guard !finished else { return }
        finished = true
        if handedOver { return }
        if let unsaved {
            books.queue.addDocument(workspaceId: books.workspaceId, entityId: unsaved.entityId, receipt: unsaved.receipt)
        } else if let captured {
            discard(captured)
        }
    }

    private func discard(_ capture: ScanCapture) {
        try? FileManager.default.removeItem(at: books.queue.fileURL(capture.receipt))
    }
}

/// A photo made smaller for upload: at most 2000 px on its long side, JPEG at 0.7.
@MainActor
private enum ScanImages {
    static let maxSide: CGFloat = 2000

    static func jpeg(_ image: UIImage) -> Data? {
        let width = image.size.width * image.scale
        let height = image.size.height * image.scale
        let longest = max(width, height)
        guard longest > 0 else { return nil }
        let factor = min(1, maxSide / longest)
        let size = CGSize(width: max(1, (width * factor).rounded()), height: max(1, (height * factor).rounded()))
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        let resized = UIGraphicsImageRenderer(size: size, format: format).image { _ in
            image.draw(in: CGRect(origin: .zero, size: size))
        }
        return resized.jpegData(compressionQuality: 0.7)
    }
}

private enum ScanCameraOutcome {
    case photo(UIImage)
    case cancelled
    case failed
}

/// VisionKit's document camera: it finds the receipt's edges and straightens it. The first page is the receipt.
private struct ScanDocumentCamera: UIViewControllerRepresentable {
    let onFinish: (ScanCameraOutcome) -> Void

    func makeUIViewController(context: Context) -> VNDocumentCameraViewController {
        let controller = VNDocumentCameraViewController()
        controller.delegate = context.coordinator
        return controller
    }

    func updateUIViewController(_ controller: VNDocumentCameraViewController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(onFinish: onFinish) }

    final class Coordinator: NSObject, VNDocumentCameraViewControllerDelegate {
        let onFinish: (ScanCameraOutcome) -> Void

        init(onFinish: @escaping (ScanCameraOutcome) -> Void) {
            self.onFinish = onFinish
        }

        func documentCameraViewController(_ controller: VNDocumentCameraViewController, didFinishWith scan: VNDocumentCameraScan) {
            onFinish(scan.pageCount > 0 ? .photo(scan.imageOfPage(at: 0)) : .cancelled)
        }

        func documentCameraViewControllerDidCancel(_ controller: VNDocumentCameraViewController) {
            onFinish(.cancelled)
        }

        func documentCameraViewController(_ controller: VNDocumentCameraViewController, didFailWithError error: Error) {
            onFinish(.failed)
        }
    }
}

/// The plain camera, where the document camera isn't supported.
private struct ScanPhotoCamera: UIViewControllerRepresentable {
    let onFinish: (ScanCameraOutcome) -> Void

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ controller: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(onFinish: onFinish) }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let onFinish: (ScanCameraOutcome) -> Void

        init(onFinish: @escaping (ScanCameraOutcome) -> Void) {
            self.onFinish = onFinish
        }

        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            if let image = info[.originalImage] as? UIImage {
                onFinish(.photo(image))
            } else {
                onFinish(.failed)
            }
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            onFinish(.cancelled)
        }
    }
}

// MARK: - Quick expense

/// A quick-expense category in words.
private func categoryLabel(_ key: String) -> String {
    switch key {
    case "food": return BooksStrings.expenseQuickFood
    case "transport": return BooksStrings.expenseQuickTransport
    case "office": return BooksStrings.expenseQuickOffice
    case "travel": return BooksStrings.expenseQuickTravel
    case "supplies": return BooksStrings.expenseQuickSupplies
    case "utilities": return BooksStrings.expenseQuickUtilities
    case "insurance": return BooksStrings.expenseQuickInsurance
    default: return BooksStrings.expenseQuickOther
    }
}

private func categoryIcon(_ key: String) -> String {
    switch key {
    case "food": return "fork.knife"
    case "transport": return "car"
    case "office": return "briefcase"
    case "travel": return "airplane"
    case "supplies": return "shippingbox"
    case "utilities": return "bolt"
    case "insurance": return "shield"
    default: return "square.grid.2x2"
    }
}

/// What a scan keeps for the save: the matched supplier, the currency, and the lines when they carry several rates.
private struct QuickExpenseScan {
    var vendorName: String?
    var contactId: String?
    var currency: String?
    /// The amount as it was filled in from the receipt.
    var total: String?
    var lines: [PrefillLine]?
    var rates: [Decimal]
}

/// Reading the scanned receipt the expense starts from.
private enum QuickExpenseReading {
    case idle, loading, ready, failed
}

/// The fastest way from a receipt to a booked cost: what was paid, VAT
/// included, saved as a bill that is approved and paid at once. Offline it
/// goes to the queue.
struct QuickExpenseView: View {
    let documentId: String?
    let receipt: String?
    let receiptType: String?

    @Environment(Books.self) private var books
    @Environment(Toaster.self) private var toaster
    @Environment(\.dismiss) private var dismiss

    @State private var amount = ""
    @State private var category = "other"
    @State private var vendor = ""
    @State private var details = ""
    @State private var date = Days.today()
    /// Nil until typed (or read from the receipt): the country's default rate.
    @State private var taxRate: String?
    @State private var accrueUseTax = false
    @State private var taxCode = UsRules.defaultTaxCode
    /// Nil until chosen: the usual way a receipt is paid.
    @State private var method: String?
    @State private var accounts: [GlAccount] = []
    @State private var accountId = ""
    @State private var accountTouched = false
    @State private var scanned: QuickExpenseScan?
    @State private var saving = false
    @State private var storedDocument: String?
    @State private var amountError: String?
    @State private var reading: QuickExpenseReading

    init(documentId: String?, receipt: String?, receiptType: String?) {
        self.documentId = documentId
        self.receipt = receipt
        self.receiptType = receiptType
        _storedDocument = State(initialValue: documentId)
        _reading = State(initialValue: documentId == nil ? .idle : .loading)
    }

    private var isUs: Bool { books.isUs }
    private var online: Bool { books.queue.isOnline }
    private var defaultRate: String { Jurisdictions.defaultTaxRate(books.code) }
    private var rateText: String { taxRate ?? defaultRate }
    private var chosenMethod: String { method ?? Payments.defaultExpenseMethod(isUs: isUs) }

    /// The account picked, else the one the category suggests ("" books to the default expense account).
    private var chosenAccountId: String {
        if accountTouched { return accountId }
        return ExpenseCategories.accountFor(category, accounts)?.id ?? ""
    }

    /// Booked per receipt line while the scanned total stands; editing it falls back to one rate.
    private var mixedRates: [Decimal]? {
        guard let scanned, scanned.lines != nil, amount == scanned.total else { return nil }
        return scanned.rates
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                if !online {
                    Banner(BooksStrings.expenseQuickOfflineBanner, tone: "warning")
                }
                readingBanner
                LocalReceiptPreview(path: receipt, mimeType: receiptType)
                amountCard
                categoryCard
                detailsCard
                Button(action: save) {
                    Text(online ? BooksStrings.expenseQuickSave : BooksStrings.expenseQuickQueue)
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .disabled(saving)
                .tagged("expense-save")
                .padding(Tokens.Spacing.m)
            }
            .padding(.bottom, Tokens.Spacing.xl)
        }
        .scrollDismissesKeyboard(.interactively)
        .groupedBackground()
        .tagged("quick-expense")
        .navigationTitle(BooksStrings.expenseQuickTitle)
        .navigationBarTitleDisplayMode(.inline)
        .task(id: online) { await loadAccounts() }
        .task { await readReceipt() }
    }

    @ViewBuilder
    private var readingBanner: some View {
        switch reading {
        case .idle:
            EmptyView()
        case .loading:
            Banner(BooksStrings.expenseQuickOcrLoading)
        case .ready:
            Banner(BooksStrings.expenseQuickOcrReady, tone: "success")
        case .failed:
            Banner(BooksStrings.expenseQuickOcrFailed, tone: "warning")
        }
    }

    private var amountCard: some View {
        SectionCard {
            VStack(spacing: Tokens.Spacing.xs) {
                Text(BooksStrings.expenseQuickAmount)
                    .font(.inter(.caption))
                    .foregroundStyle(Color.secondary)
                TextField(
                    Self.amountPlaceholder,
                    text: Binding(get: { amount }, set: { value in
                        amount = value
                        amountError = nil
                    })
                )
                .font(.system(size: 44, weight: .bold))
                .multilineTextAlignment(.center)
                .keyboardType(.decimalPad)
                .minimumScaleFactor(0.5)
                .tagged("expense-amount")
                Text(amountHint)
                    .font(.inter(.footnote))
                    .foregroundStyle(amountError == nil ? Color.secondary : Tokens.Status.danger)
                    .multilineTextAlignment(.center)
            }
            .frame(maxWidth: .infinity)
        }
    }

    private static let amountPlaceholder = "0.00"

    /// The error, else what the tax in the amount is (or, in the US, that tax paid is part of the cost).
    private var amountHint: String {
        if let amountError { return amountError }
        if isUs { return BooksStrings.expenseQuickAmountHintUs }
        let rate = Amounts.parse(rateText.orIfBlank("0"), decimalPoint: books.decimalPoint)
        let total = Amounts.parse(amount.orIfBlank("0"), decimalPoint: books.decimalPoint)
        let tax = QuickExpense.split(total, rate: rate).tax
        return BooksStrings.expenseQuickAmountHint(amount: books.money(tax), tax: books.labels.tax, rate: Amounts.percent(rate))
    }

    private var categoryCard: some View {
        SectionCard(title: BooksStrings.expenseQuickCategory) {
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: Tokens.Spacing.s), count: 4), spacing: Tokens.Spacing.s) {
                ForEach(ExpenseCategories.all, id: \.self) { key in
                    categoryButton(key)
                }
            }
            if !accounts.isEmpty {
                Dropdown(
                    BooksStrings.expenseQuickAccount,
                    value: chosenAccountId,
                    options: accountChoices,
                    tag: "expense-account"
                ) { id in
                    accountId = id
                    accountTouched = true
                }
                .padding(.top, Tokens.Spacing.s)
            }
        }
    }

    private var accountChoices: [Choice] {
        [Choice("", BooksStrings.expenseQuickDefaultAccount)] + accounts.map { account in Choice(account.id, "\(account.code) \(account.name)") }
    }

    private func categoryButton(_ key: String) -> some View {
        let selected = key == category
        let color: Color = selected ? Accents.brand : Color.secondary
        return Button {
            category = key
        } label: {
            VStack(spacing: Tokens.Spacing.xs) {
                Image(systemName: categoryIcon(key))
                    .font(.inter(.title3))
                    .accessibilityHidden(true)
                Text(categoryLabel(key))
                    .font(.inter(.caption2))
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
            }
            .foregroundStyle(color)
            .frame(maxWidth: .infinity, minHeight: 68)
            .background(selected ? Accents.brand.opacity(0.12) : Color.clear, in: RoundedRectangle(cornerRadius: Tokens.Radius.medium))
            .overlay(
                RoundedRectangle(cornerRadius: Tokens.Radius.medium)
                    .stroke(selected ? Accents.brand : Color(uiColor: .separator), lineWidth: 1)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
        .tagged("category-\(key)")
    }

    private var detailsCard: some View {
        SectionCard(title: BooksStrings.expenseQuickDetails) {
            FormField(books.labels.supplier, text: $vendor, placeholder: BooksStrings.expenseQuickVendorPlaceholder, tag: "expense-vendor")
            DateField(BooksStrings.expenseQuickDate, value: $date, tag: "expense-date")
            taxFields
            Dropdown(
                BooksStrings.expenseQuickPaidWith,
                value: chosenMethod,
                options: Payments.methods(isUs: isUs).filter { $0 != "manual" }.map { Choice($0, paymentMethodLabel($0)) },
                tag: "expense-method"
            ) { method = $0 }
            FormField(
                BooksStrings.expenseQuickDescription,
                text: $details,
                placeholder: BooksStrings.expenseQuickDescriptionPlaceholder,
                lines: 3
            )
        }
    }

    /// US: use tax accrued with a tax code. Elsewhere the VAT rate, or the receipt's rates when it has several.
    @ViewBuilder
    private var taxFields: some View {
        if isUs {
            SwitchRow(BooksStrings.expenseQuickAccrueUseTax, isOn: $accrueUseTax)
            HintText(BooksStrings.expenseQuickAccrueUseTaxHint)
            if accrueUseTax {
                Dropdown(BooksStrings.salesTaxTaxCode, value: taxCode, options: UsRules.taxCodes.map { Choice($0, taxCodeLabel($0)) }) { taxCode = $0 }
            }
        } else if let rates = mixedRates {
            HintText(mixedRatesText(rates))
        } else {
            FormField(
                books.labels.taxPercent,
                text: Binding(get: { rateText }, set: { taxRate = $0 }),
                placeholder: defaultRate,
                keyboard: .decimalPad,
                tag: "expense-tax-rate"
            )
        }
    }

    private func mixedRatesText(_ rates: [Decimal]) -> String {
        let list = rates.map { rate in "\(Amounts.percent(rate))%" }.joined(separator: ", ")
        return BooksStrings.expenseQuickMixedRates(tax: books.labels.tax, rates: list)
    }

    // MARK: Loading

    /// The chart of accounts, to book the category to its own account; without it the expense goes to the default one.
    private func loadAccounts() async {
        guard online else { return }
        if let list = try? await books.store.accounts() {
            accounts = ExpenseCategories.expenseAccounts(list)
        }
    }

    private func readReceipt() async {
        guard reading == .loading, let id = documentId else { return }
        do {
            let prefill = try await books.store.billFromDocument(id: id)
            apply(prefill)
            reading = .ready
        } catch {
            if !Task.isCancelled { reading = .failed }
        }
    }

    private func apply(_ prefill: BillPrefill) {
        let total: String? = QuickExpense.totalFromPrefill(prefill).flatMap { value in value > 0 ? Amounts.plain(Amounts.cents(value)) : nil }
        let rates: [Decimal] = isUs ? [] : QuickExpense.rates(prefill)
        if let name = prefill.contactName { vendor = name }
        if let day = Days.of(prefill.issueDate) { date = day }
        if let total { amount = total }
        if !isUs, let rate = QuickExpense.mainRate(prefill) { taxRate = rate }
        if let first = prefill.items.first?.description.trimmed, !first.isEmpty, first != prefill.contactName {
            details = first
        }
        scanned = QuickExpenseScan(
            vendorName: prefill.contactName,
            contactId: prefill.matchedContactId,
            currency: prefill.currency,
            total: total,
            lines: rates.count > 1 ? prefill.items : nil,
            rates: rates
        )
    }

    // MARK: Saving

    private func queuedExpense(_ value: Decimal) -> QueuedExpense {
        let name = vendor.trimmed
        let scan = scanned
        // The supplier OCR matched, while its name is what was kept.
        let contactId: String? = scan.flatMap { found in name == found.vendorName?.trimmed ? found.contactId : nil }
        let lines: [QueuedLine]? = scan.flatMap { found -> [QueuedLine]? in
            guard amount == found.total, let lines = found.lines else { return nil }
            return lines.map { line in
                QueuedLine(description: line.description, quantity: line.quantity, unitPrice: line.unitPrice, taxRate: line.taxRate, sortOrder: line.sortOrder)
            }
        }
        // A US expense is booked at what was paid: the tax in it is part of the cost.
        let rate = isUs ? "0" : Amounts.plain(Amounts.parse(rateText.orIfBlank("0"), decimalPoint: books.decimalPoint))
        let useTax = isUs && accrueUseTax
        return QueuedExpense(
            amount: Amounts.plain(value),
            category: categoryLabel(category),
            description: details.trimmed.nilIfEmpty,
            vendorName: name.nilIfEmpty,
            contactId: contactId,
            currency: scan?.currency,
            date: date.iso,
            documentId: storedDocument,
            accountId: chosenAccountId.nilIfEmpty,
            taxRate: rate,
            receiptLines: lines,
            roundingDescription: BooksStrings.expenseQuickRounding,
            paymentMethod: chosenMethod,
            accrueUseTax: useTax,
            taxCode: useTax ? taxCode : nil
        )
    }

    private func save() {
        let value = Amounts.parse(amount, decimalPoint: books.decimalPoint)
        guard value > 0 else {
            amountError = BooksStrings.expenseQuickAmountError
            return
        }
        amountError = nil
        let expense = queuedExpense(value)
        // A photo taken offline is stored with the expense; a scanned one already was.
        let photo = storedDocument == nil ? receipt : nil
        let type = receiptType ?? "image/jpeg"
        let workspaceId = books.workspaceId
        let entityId = books.store.entityId
        let store = books.store
        saving = true
        Task {
            if !books.queue.isOnline {
                queue(expense, photo: photo, type: type, workspaceId: workspaceId, entityId: entityId)
                toaster.show(BooksStrings.expenseQuickSavedOffline)
                saving = false
                dismiss()
                return
            }
            var pending = expense
            do {
                if let photo, let bytes = readPhoto(photo) {
                    let id = try await store.uploadReceipt(LocalFile(bytes: bytes, fileName: OfflineQueue.receiptFileName(mimeType: type), mimeType: type))
                    storedDocument = id
                    pending.documentId = id
                }
                _ = try await store.createQuickExpense(pending.values(documentId: pending.documentId))
                dropReceipt()
                toaster.show(BooksStrings.expenseQuickSaved)
                saving = false
                dismiss()
            } catch let notBooked as QuickExpenseNotBooked {
                // The bill exists as a draft: saving again would create it twice.
                dropReceipt()
                let reason = ErrorTexts.describe(notBooked.cause, fallback: BooksStrings.expenseQuickSaveFailed)
                toaster.show(BooksStrings.expenseQuickNotBooked(reason: reason))
                saving = false
                dismiss()
            } catch {
                if BooksError.from(error).api.isNetwork {
                    queue(pending, photo: pending.documentId == nil ? photo : nil, type: type, workspaceId: workspaceId, entityId: entityId)
                    toaster.show(BooksStrings.expenseQuickQueuedRetry)
                    saving = false
                    dismiss()
                } else {
                    // The server answered: queueing would fail the same way on every sync.
                    toaster.show(ErrorTexts.describe(error, fallback: BooksStrings.expenseQuickSaveFailed))
                    saving = false
                }
            }
        }
    }

    /// Into the offline queue, with the photo when there is one to store; a receipt no longer needed is dropped.
    private func queue(_ expense: QueuedExpense, photo: String?, type: String, workspaceId: String, entityId: String?) {
        let kept = keptPhoto(photo, type: type)
        if kept == nil { dropReceipt() }
        books.queue.addExpense(workspaceId: workspaceId, entityId: entityId, expense: expense, receipt: kept)
    }

    /// The photo as the queue keeps it: it already is in the queue's folder.
    private func keptPhoto(_ path: String?, type: String) -> QueuedReceipt? {
        guard let path else { return nil }
        let url = books.queue.fileURL(path: path)
        guard FileManager.default.fileExists(atPath: url.path(percentEncoded: false)) else { return nil }
        return QueuedReceipt(path: url.lastPathComponent, fileName: OfflineQueue.receiptFileName(mimeType: type), mimeType: type)
    }

    private func readPhoto(_ path: String) -> Data? {
        guard let data = try? Data(contentsOf: books.queue.fileURL(path: path)), !data.isEmpty else { return nil }
        return data
    }

    /// The receipt on this phone, once it is stored (or stays out of the queue).
    private func dropReceipt() {
        guard let receipt else { return }
        try? FileManager.default.removeItem(at: books.queue.fileURL(path: receipt))
    }
}
