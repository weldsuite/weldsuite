import CryptoKit
import Foundation
import LocalAuthentication
import Security

/// A login the extension can fill, from a copy, in this process only.
struct Login {
    let workspaceID: String
    let vaultID: String
    let itemID: String
    let title: String
    let host: String?
    let username: String
    let password: String

    /// The identifier the app gives the system's QuickType suggestions.
    var recordIdentifier: String { "\(workspaceID)|\(vaultID)|\(itemID)" }
}

/// The app's offline copies (ADR PASS-010), as the AutoFill extension reads
/// them: the key from the Keychain group it shares with the app (the item's
/// access control asks for Face ID), the sealed files and their index from the
/// App Group container. Read-only, apart from the queue of fills the app
/// uploads at its next sync.
///
/// The app's `Offline/CopyStorage.swift` writes them: `WPO1` ‖ nonce (12) ‖
/// ciphertext ‖ tag (16), AES-256-GCM, additional data
/// `weldpass-offline:v1:<deviceId>:<workspaceId>`.
enum SharedCopy {
    static let appGroup = "group.com.weldsuite.weldpass"
    private static let keyService = "com.weldsuite.weldpass.offline"
    private static let keyAccount = "key"
    private static let magic = Data("WPO1".utf8)

    enum Failure: Error {
        case noCopy
        case cancelled
    }

    static var folder: URL? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup)?
            .appendingPathComponent("weldpass-offline", isDirectory: true)
    }

    /// The key. The Keychain item's access control asks for Face ID with `reason`.
    static func readKey(reason: String) throws -> SymmetricKey {
        let context = LAContext()
        context.localizedReason = reason
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keyService,
            kSecAttrAccount as String: keyAccount,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
            kSecUseAuthenticationContext as String: context,
        ]
        if let group = Bundle.main.object(forInfoDictionaryKey: "WeldPassKeychainGroup") as? String,
           !group.isEmpty, !group.contains("$(") {
            query[kSecAttrAccessGroup as String] = group
        }
        var item: CFTypeRef?
        switch SecItemCopyMatching(query as CFDictionary, &item) {
        case errSecSuccess:
            guard let data = item as? Data, data.count == 32 else { throw Failure.noCopy }
            return SymmetricKey(data: data)
        case errSecUserCanceled, errSecAuthFailed:
            throw Failure.cancelled
        default:
            throw Failure.noCopy
        }
    }

    /// Every login in every copy the index names, opened with `key`, by title.
    static func logins(key: SymmetricKey) -> [Login] {
        guard let folder,
              let indexData = try? Data(contentsOf: folder.appendingPathComponent("index.json")),
              let index = try? JSONDecoder().decode([String: String].self, from: indexData)
        else { return [] }
        var logins: [Login] = []
        for (workspaceID, deviceID) in index {
            let safe = workspaceID.replacingOccurrences(of: "[^A-Za-z0-9_-]", with: "_", options: .regularExpression)
            guard let file = try? Data(contentsOf: folder.appendingPathComponent("\(safe).wpo")),
                  file.count > magic.count + 28, file.prefix(magic.count) == magic,
                  let box = try? AES.GCM.SealedBox(combined: file.dropFirst(magic.count)),
                  let json = try? AES.GCM.open(box, using: key, authenticating: Data("weldpass-offline:v1:\(deviceID):\(workspaceID)".utf8)),
                  let copy = (try? JSONSerialization.jsonObject(with: json)) as? [String: Any]
            else { continue }
            logins += loginsOf(copy, workspaceID: workspaceID)
        }
        return logins.sorted { $0.title.localizedStandardCompare($1.title) == .orderedAscending }
    }

    private static func loginsOf(_ copy: [String: Any], workspaceID: String) -> [Login] {
        guard let vaults = copy["vaults"] as? [String: Any] else { return [] }
        var out: [Login] = []
        for (vaultID, entry) in vaults {
            guard let items = (entry as? [String: Any])?["items"] as? [String: Any] else { continue }
            for (itemID, value) in items {
                guard let item = value as? [String: Any], item["type"] as? String == "login",
                      let fields = item["fields"] as? [String: Any]
                else { continue }
                out.append(Login(
                    workspaceID: workspaceID,
                    vaultID: vaultID,
                    itemID: itemID,
                    title: item["title"] as? String ?? "",
                    host: (item["host"] as? String).flatMap { $0.isEmpty ? nil : $0 },
                    username: fields["username"] as? String ?? "",
                    password: fields["password"] as? String ?? ""
                ))
            }
        }
        return out
    }

    /// A fill, for the vault's trail; the app uploads it at its next sync.
    static func recordFill(_ login: Login) {
        guard let folder else { return }
        let file = folder.appendingPathComponent("fills.json")
        var fills = ((try? JSONSerialization.jsonObject(with: Data(contentsOf: file))) as? [[String: String]]) ?? []
        fills.append([
            "workspaceId": login.workspaceID,
            "vaultId": login.vaultID,
            "itemId": login.itemID,
            "at": ISO8601DateFormatter().string(from: Date()),
        ])
        if let data = try? JSONSerialization.data(withJSONObject: Array(fills.suffix(500))) {
            try? data.write(to: file, options: .atomic)
        }
    }
}

/// The platform's `hostsMatch`: the same host, or one a subdomain of the
/// other (when the shorter has a dot), ignoring `www.`.
enum HostMatch {
    static func matches(_ itemHost: String, _ pageHost: String) -> Bool {
        let item = itemHost.lowercased().replacingOccurrences(of: "^www\\.", with: "", options: .regularExpression)
        let page = pageHost.lowercased().replacingOccurrences(of: "^www\\.", with: "", options: .regularExpression)
        if item == page { return true }
        let (short, long) = item.count < page.count ? (item, page) : (page, item)
        return short.contains(".") && long.hasSuffix(".\(short)")
    }

    /// The host of a service identifier: a URL's host, or a bare domain.
    static func host(of identifier: String) -> String? {
        if let host = URL(string: identifier)?.host, !host.isEmpty { return host.lowercased() }
        let bare = identifier.trimmingCharacters(in: .whitespaces).lowercased()
        return bare.isEmpty ? nil : bare
    }
}
