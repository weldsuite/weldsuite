import Foundation
import Network
import Observation
import WeldCore

/// A receipt photo kept on this phone until it is stored.
struct QueuedReceipt: Codable, Hashable, Sendable {
    /// The file's name in the queue's receipts folder (`OfflineQueue.fileURL(path:)`). A name, never an
    /// absolute path: the app's container moves when the app is updated.
    var path: String
    /// The name it is uploaded under (`receipt-<ms>.jpg`).
    var fileName: String
    var mimeType: String
}

struct QueuedLine: Codable, Hashable, Sendable {
    var description: String
    var quantity: String
    var unitPrice: String
    var taxRate: String?
    var sortOrder: Int = 0
}

/// A quick expense saved without a connection. Amounts are decimal strings.
struct QueuedExpense: Codable, Hashable, Sendable {
    var amount: String
    var category: String
    var description: String?
    var vendorName: String?
    var contactId: String?
    var currency: String?
    var date: String
    var documentId: String?
    var accountId: String?
    var taxRate: String = "0"
    var receiptLines: [QueuedLine]?
    var roundingDescription: String
    var paymentMethod: String
    var accrueUseTax: Bool = false
    var taxCode: String?

    /// The expense as the store takes it.
    func values(documentId: String?) -> QuickExpenseValues {
        QuickExpenseValues(
            amount: Amounts.of(amount),
            category: category,
            description: description,
            vendorName: vendorName,
            contactId: contactId,
            currency: currency,
            date: date,
            documentId: documentId,
            accountId: accountId,
            taxRate: Amounts.of(taxRate),
            receiptLines: receiptLines?.map {
                PrefillLine(description: $0.description, quantity: $0.quantity, unitPrice: $0.unitPrice, taxRate: $0.taxRate, sortOrder: $0.sortOrder)
            },
            roundingDescription: roundingDescription,
            paymentMethod: paymentMethod,
            accrueUseTax: accrueUseTax,
            taxCode: taxCode
        )
    }
}

/// An expense or a scanned receipt waiting for a connection, for the workspace and company it was captured in.
struct QueuedItem: Codable, Hashable, Identifiable, Sendable {
    var id: String
    /// `expense` or `document`.
    var type: String
    var workspaceId: String
    var entityId: String?
    /// Milliseconds since 1970.
    var createdAt: Int64
    var expense: QueuedExpense?
    var receipt: QueuedReceipt?
}

/// Receipts scanned and expenses entered without a connection, kept in a file
/// (Application Support) and replayed one by one against the regular routes
/// when the connection returns. What fails stays queued; what was already
/// stored (a receipt's document) is kept with it, so a retry doesn't store it
/// twice.
@MainActor
@Observable
final class OfflineQueue {
    private(set) var items: [QueuedItem] = []
    private(set) var isOnline = true
    private(set) var isSyncing = false

    @ObservationIgnored private let env: AppEnvironment
    @ObservationIgnored private let file: URL
    @ObservationIgnored private let receipts: URL
    @ObservationIgnored private let monitor = NWPathMonitor()

    init(env: AppEnvironment) {
        self.env = env
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        file = support.appendingPathComponent("weldbooks-queue.json")
        receipts = support.appendingPathComponent("weldbooks-receipts", isDirectory: true)
        try? FileManager.default.createDirectory(at: receipts, withIntermediateDirectories: true)
        items = Self.read(file)
        monitor.pathUpdateHandler = { [weak self] path in
            let online = path.status == .satisfied
            Task { @MainActor in self?.update(online: online) }
        }
        monitor.start(queue: DispatchQueue(label: "weldbooks.connectivity"))
    }

    private func update(online: Bool) {
        isOnline = online
        if online { Task { await sync() } }
    }

    /// Where a kept receipt is on this phone.
    func fileURL(path: String) -> URL {
        // An older absolute path still finds its file by name.
        receipts.appendingPathComponent((path as NSString).lastPathComponent)
    }

    func fileURL(_ receipt: QueuedReceipt) -> URL { fileURL(path: receipt.path) }

    /// Keep a copy of a photo in the app's own storage, so the receipt survives until it is stored.
    func keep(_ data: Data, mimeType: String) throws -> QueuedReceipt {
        let name = "\(UUID().uuidString).\(Self.fileExtension(mimeType))"
        try data.write(to: receipts.appendingPathComponent(name), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        return QueuedReceipt(path: name, fileName: Self.receiptFileName(mimeType: mimeType), mimeType: mimeType)
    }

    func addExpense(workspaceId: String, entityId: String?, expense: QueuedExpense, receipt: QueuedReceipt?) {
        add(QueuedItem(id: Self.newId(), type: "expense", workspaceId: workspaceId, entityId: entityId, createdAt: Self.now(), expense: expense, receipt: receipt))
    }

    func addDocument(workspaceId: String, entityId: String?, receipt: QueuedReceipt) {
        add(QueuedItem(id: Self.newId(), type: "document", workspaceId: workspaceId, entityId: entityId, createdAt: Self.now(), receipt: receipt))
    }

    /// Replay the current workspace's items; keep the ones that fail.
    func sync() async {
        guard let workspace = env.session?.activeWorkspaceID else { return }
        if isSyncing || !items.contains(where: { $0.workspaceId == workspace }) { return }
        isSyncing = true
        defer { isSyncing = false }
        for item in items.filter({ $0.workspaceId == workspace }) {
            let kept: QueuedItem?
            do {
                kept = try await replay(item)
            } catch {
                continue
            }
            if let kept {
                items = items.map { $0.id == item.id ? kept : $0 }
            } else {
                items.removeAll { $0.id == item.id }
                if let receipt = item.receipt { try? FileManager.default.removeItem(at: fileURL(receipt)) }
            }
            write()
        }
    }

    /// Nil once the item is done; else the item to keep (with what this attempt stored).
    private func replay(_ item: QueuedItem) async throws -> QueuedItem? {
        let store = BooksStore(env: env)
        store.entityId = item.entityId
        switch item.type {
        case "document":
            guard let receipt = item.receipt, let data = readBytes(receipt) else { return nil }
            _ = try await store.uploadReceipt(LocalFile(bytes: data, fileName: receipt.fileName, mimeType: receipt.mimeType))
            return nil
        case "expense":
            return try await replayExpense(store, item)
        default:
            return nil
        }
    }

    private func replayExpense(_ store: BooksStore, _ item: QueuedItem) async throws -> QueuedItem? {
        guard let expense = item.expense else { return nil }
        var documentId = expense.documentId
        let receipt = item.receipt
        if documentId == nil, let receipt, let data = readBytes(receipt) {
            documentId = try await store.uploadReceipt(LocalFile(bytes: data, fileName: receipt.fileName, mimeType: receipt.mimeType))
        }
        do {
            _ = try await store.createQuickExpense(expense.values(documentId: documentId))
            return nil
        } catch is QuickExpenseNotBooked {
            // The bill exists as a draft; queueing it again would create it twice.
            return nil
        } catch let error where error is BooksError || error is APIError {
            // Keep the stored receipt with the item: the retry links it instead of storing it again.
            guard documentId != expense.documentId else { throw error }
            if let receipt { try? FileManager.default.removeItem(at: fileURL(receipt)) }
            var next = item
            next.expense?.documentId = documentId
            next.receipt = nil
            return next
        }
    }

    private func readBytes(_ receipt: QueuedReceipt) -> Data? {
        guard let data = try? Data(contentsOf: fileURL(receipt)), !data.isEmpty else { return nil }
        return data
    }

    private func add(_ item: QueuedItem) {
        items.append(item)
        write()
    }

    private func write() {
        guard let data = try? JSONEncoder().encode(items) else { return }
        try? data.write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    private static func read(_ file: URL) -> [QueuedItem] {
        guard let data = try? Data(contentsOf: file) else { return [] }
        return (try? JSONDecoder().decode([QueuedItem].self, from: data)) ?? []
    }

    private static func newId() -> String { "oq_\(UUID().uuidString.lowercased())" }

    private static func now() -> Int64 { Int64(Date().timeIntervalSince1970 * 1000) }

    /// `image/jpeg` → `jpg`, `image/png` → `png`; `jpg` for anything unreadable.
    nonisolated static func fileExtension(_ mimeType: String) -> String {
        guard let slash = mimeType.firstIndex(of: "/") else { return "jpg" }
        let subtype = String(mimeType[mimeType.index(after: slash)...]).replacingOccurrences(of: "jpeg", with: "jpg")
        return subtype.isEmpty ? "jpg" : subtype
    }

    /// The name a receipt is stored under: a PNG or HEIC keeps its own extension.
    nonisolated static func receiptFileName(mimeType: String, at milliseconds: Int64 = Int64(Date().timeIntervalSince1970 * 1000)) -> String {
        "receipt-\(milliseconds).\(fileExtension(mimeType))"
    }
}
