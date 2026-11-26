import CryptoKit
import Foundation
import LocalAuthentication
import Security

/// The copy's file format (ADR PASS-010): `WPO1`, then AES-256-GCM over the
/// copy's JSON in the combined layout nonce (12 bytes) ‖ ciphertext ‖ tag
/// (16 bytes). The additional data binds a file to its device and workspace,
/// so a copy moved to another slot fails to open instead of being read as
/// that one's. The Expo app's `lib/offline/envelope.ts`, byte for byte.
enum CopyEnvelope {
    private static let magic = Data("WPO1".utf8)

    static func additionalData(deviceID: String, workspaceID: String) -> Data {
        Data("weldpass-offline:v1:\(deviceID):\(workspaceID)".utf8)
    }

    static func seal(_ json: Data, owner: CopyOwner, key: SymmetricKey) throws -> Data {
        let box = try AES.GCM.seal(json, using: key, authenticating: additionalData(deviceID: owner.deviceId, workspaceID: owner.workspaceId))
        guard let combined = box.combined else { throw CocoaError(.coderInvalidValue) }
        return magic + combined
    }

    /// The JSON, or nil for a file that isn't a copy. Throws for a wrong key or tampering.
    static func open(_ file: Data, owner: CopyOwner, key: SymmetricKey) throws -> Data? {
        guard file.count > magic.count + 28, file.prefix(magic.count) == magic else { return nil }
        let box = try AES.GCM.SealedBox(combined: file.dropFirst(magic.count))
        return try AES.GCM.open(box, using: key, authenticating: additionalData(deviceID: owner.deviceId, workspaceID: owner.workspaceId))
    }
}

/// The copy's key: 32 random bytes in the Keychain, this device only, behind
/// the passcode or biometrics (`userPresence`). Read with the context the app
/// lock just authenticated, so one Face ID opens the app and the copy. It
/// lives in the Keychain group the AutoFill extension shares
/// (`WeldPassKeychainGroup` in Info.plist), which reads it with its own prompt.
enum CopyKey {
    static let service = "com.weldsuite.weldpass.offline"
    static let account = "key"

    /// `$(AppIdentifierPrefix)com.weldsuite.weldpass.shared`, as Xcode expanded it.
    static var accessGroup: String? {
        guard let group = Bundle.main.object(forInfoDictionaryKey: "WeldPassKeychainGroup") as? String,
              !group.isEmpty, !group.contains("$(")
        else { return nil }
        return group
    }

    enum Problem: Error {
        /// The phone has no passcode: nothing to keep the key behind.
        case noPasscode
        /// The person cancelled, or the context expired.
        case locked
    }

    /// The key, made on first use.
    static func open(context: LAContext?) throws -> SymmetricKey {
        var query = base()
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        if let context { query[kSecUseAuthenticationContext as String] = context }
        var result: AnyObject?
        switch SecItemCopyMatching(query as CFDictionary, &result) {
        case errSecSuccess:
            guard let data = result as? Data, data.count == 32 else { throw Problem.locked }
            return SymmetricKey(data: data)
        case errSecItemNotFound:
            return try create()
        default:
            throw Problem.locked
        }
    }

    static func delete() {
        SecItemDelete(base() as CFDictionary)
    }

    private static func create() throws -> SymmetricKey {
        guard let access = SecAccessControlCreateWithFlags(
            nil, kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly, .userPresence, nil
        ) else { throw Problem.noPasscode }
        let key = SymmetricKey(size: .bits256)
        var item = base()
        item[kSecValueData as String] = key.withUnsafeBytes { Data($0) }
        item[kSecAttrAccessControl as String] = access
        var status = SecItemAdd(item as CFDictionary, nil)
        if status == errSecMissingEntitlement {
            // A build without the shared group (unsigned, the simulator in CI):
            // keep the key in the app's own Keychain; AutoFill can't read it there.
            item[kSecAttrAccessGroup as String] = nil
            status = SecItemAdd(item as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw Problem.noPasscode }
        return key
    }

    private static func base() -> [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        if let accessGroup { query[kSecAttrAccessGroup as String] = accessGroup }
        return query
    }
}

/// The copies on the phone, one file per workspace, outside backups, in the
/// App Group container the AutoFill extension shares; with an index naming
/// each copy's workspace and device (ids only), and the extension's queue of
/// fills (`fills.json`).
struct CopyFiles {
    static let appGroup = "group.com.weldsuite.weldpass"

    var directory: URL {
        let root = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: Self.appGroup)
            ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return root.appendingPathComponent("weldpass-offline", isDirectory: true)
    }

    private var indexFile: URL { directory.appendingPathComponent("index.json") }
    private var fillsFile: URL { directory.appendingPathComponent("fills.json") }

    private func file(_ workspaceID: String) -> URL {
        let safe = workspaceID.replacingOccurrences(of: "[^A-Za-z0-9_-]", with: "_", options: .regularExpression)
        return directory.appendingPathComponent("\(safe).wpo")
    }

    func read(_ workspaceID: String) -> Data? {
        try? Data(contentsOf: file(workspaceID))
    }

    func write(_ workspaceID: String, deviceID: String, _ data: Data) throws {
        var folder = directory
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? folder.setResourceValues(values)
        try data.write(to: file(workspaceID), options: [.atomic, .completeFileProtection])
        var entries = index()
        entries[workspaceID] = deviceID
        try? JSONEncoder().encode(entries).write(to: indexFile, options: .atomic)
    }

    func delete(_ workspaceID: String) {
        try? FileManager.default.removeItem(at: file(workspaceID))
        var entries = index()
        guard entries.removeValue(forKey: workspaceID) != nil else { return }
        try? JSONEncoder().encode(entries).write(to: indexFile, options: .atomic)
    }

    func deleteAll() {
        try? FileManager.default.removeItem(at: directory)
    }

    /// Workspace id → the device id its copy was sealed for.
    func index() -> [String: String] {
        guard let data = try? Data(contentsOf: indexFile) else { return [:] }
        return (try? JSONDecoder().decode([String: String].self, from: data)) ?? [:]
    }

    struct Fill: Codable {
        let workspaceId: String
        let vaultId: String
        let itemId: String
        let at: String
    }

    /// The extension's fills for one workspace, taken off the queue.
    func takeFills(_ workspaceID: String) -> [Fill] {
        guard let data = try? Data(contentsOf: fillsFile),
              let fills = try? JSONDecoder().decode([Fill].self, from: data)
        else { return [] }
        let taken = fills.filter { $0.workspaceId == workspaceID }
        let rest = fills.filter { $0.workspaceId != workspaceID }
        if rest.isEmpty {
            try? FileManager.default.removeItem(at: fillsFile)
        } else {
            try? JSONEncoder().encode(rest).write(to: fillsFile, options: .atomic)
        }
        return taken
    }
}

/// What the phone did with its copy (a reveal, a copy, an autofill), queued
/// until the next sync uploads it into the vaults' trails. Ids and actions
/// only, never a secret.
struct EventQueue {
    static let maxQueued = 2000
    static let perUpload = 500

    struct Event: Codable, Equatable {
        enum Action: String, Codable { case revealed, copied, autofilled }
        let vaultId: String
        let itemId: String
        let action: Action
        let at: String
    }

    let defaults: UserDefaults

    private func key(_ workspaceID: String) -> String { "weldpass:offline-events:\(workspaceID)" }

    func read(_ workspaceID: String) -> [Event] {
        guard let data = defaults.data(forKey: key(workspaceID)) else { return [] }
        return (try? JSONDecoder().decode([Event].self, from: data)) ?? []
    }

    func add(_ workspaceID: String, _ event: Event) {
        write(workspaceID, Array((read(workspaceID) + [event]).suffix(Self.maxQueued)))
    }

    /// Upload the queue in batches, oldest first. Each batch the server took
    /// leaves the front of the queue, so a failure part-way keeps only what
    /// wasn't sent, and an event recorded meanwhile stays queued.
    func flush(_ workspaceID: String, upload: ([Event]) async throws -> Void) async throws {
        while true {
            let batch = Array(read(workspaceID).prefix(Self.perUpload))
            if batch.isEmpty { return }
            try await upload(batch)
            write(workspaceID, Array(read(workspaceID).dropFirst(batch.count)))
        }
    }

    func clear(_ workspaceID: String) {
        defaults.removeObject(forKey: key(workspaceID))
    }

    private func write(_ workspaceID: String, _ events: [Event]) {
        if events.isEmpty {
            clear(workspaceID)
        } else if let data = try? JSONEncoder().encode(events) {
            defaults.set(data, forKey: key(workspaceID))
        }
    }
}
