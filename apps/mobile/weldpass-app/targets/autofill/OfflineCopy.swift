import CryptoKit
import Foundation
import LocalAuthentication
import Security

/// The app's offline copy (ADR PASS-010), as the AutoFill extension reads it:
/// the key from the Keychain group it shares with the app (behind Face ID or
/// Touch ID), the sealed file from the App Group container. Read-only: the
/// extension never writes the copy, only the queue of fills.
///
/// Layout, as `lib/offline/envelope.ts` writes it: `WPO1` ‖ nonce (12) ‖
/// ciphertext ‖ tag (16), AES-256-GCM, additional data
/// `weldpass-offline:v1:<deviceId>:<workspaceId>`.
enum OfflineCopy {
  static let appGroup = "group.com.weldsuite.weldpass"
  static let folderName = "weldpass-offline"

  /// The Keychain item expo-secure-store writes for `weldpass.offline.key`
  /// with `requireAuthentication` (service `<keychainService>:auth`).
  private static let keyService = "weldpass-offline:auth"
  private static let keyAccount = Data("weldpass.offline.key".utf8)

  enum Failure: Error {
    case noContainer
    case noKey
    case cancelled
    case unreadable
  }

  /// The access group, expanded by Xcode from Info.plist
  /// (`$(AppIdentifierPrefix)com.weldsuite.weldpass.shared`).
  static var keychainGroup: String? {
    Bundle.main.object(forInfoDictionaryKey: "WeldPassKeychainGroup") as? String
  }

  static var folder: URL? {
    FileManager.default
      .containerURL(forSecurityApplicationGroupIdentifier: appGroup)?
      .appendingPathComponent(folderName, isDirectory: true)
  }

  /// Reads the key; the Keychain item's access control asks for Face ID.
  static func readKey(reason: String) throws -> SymmetricKey {
    let context = LAContext()
    context.localizedReason = reason
    var query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: keyService,
      kSecAttrAccount as String: keyAccount,
      kSecAttrGeneric as String: keyAccount,
      kSecReturnData as String: true,
      kSecMatchLimit as String: kSecMatchLimitOne,
      kSecUseAuthenticationContext as String: context,
    ]
    if let group = keychainGroup {
      query[kSecAttrAccessGroup as String] = group
    }
    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    switch status {
    case errSecSuccess:
      guard
        let data = item as? Data,
        let encoded = String(data: data, encoding: .utf8),
        let raw = Data(base64Encoded: encoded),
        raw.count == 32
      else { throw Failure.unreadable }
      return SymmetricKey(data: raw)
    case errSecUserCanceled:
      throw Failure.cancelled
    default:
      throw Failure.noKey
    }
  }

  /// Every copy the app keeps (one per workspace), as listed in `index.json`.
  static func entries() -> [IndexEntry] {
    guard
      let folder,
      let data = try? Data(contentsOf: folder.appendingPathComponent("index.json")),
      let index = try? JSONDecoder().decode([IndexEntry].self, from: data)
    else { return [] }
    return index
  }

  /// Opens every copy with `key` and returns its logins.
  static func logins(key: SymmetricKey) -> [Login] {
    guard let folder else { return [] }
    var logins: [Login] = []
    for entry in entries() {
      let url = folder.appendingPathComponent(entry.file)
      guard
        let file = try? Data(contentsOf: url),
        let copy = try? open(file: file, key: key, entry: entry)
      else { continue }
      for vault in copy.vaults.values {
        for item in vault.items.values where item.type == "login" {
          guard let fields = item.fields, !(fields.password ?? "").isEmpty || !(fields.username ?? "").isEmpty
          else { continue }
          logins.append(
            Login(
              vaultId: item.vaultId,
              itemId: item.id,
              workspaceId: entry.workspaceId,
              title: item.title,
              host: item.host,
              username: fields.username ?? "",
              password: fields.password ?? ""))
        }
      }
    }
    return logins.sorted { $0.title.localizedCaseInsensitiveCompare($1.title) == .orderedAscending }
  }

  static func open(file: Data, key: SymmetricKey, entry: IndexEntry) throws -> Copy {
    let magic = Data([0x57, 0x50, 0x4F, 0x31])
    guard file.count > magic.count + 28, file.prefix(magic.count) == magic else { throw Failure.unreadable }
    let box = try AES.GCM.SealedBox(combined: file.dropFirst(magic.count))
    let aad = Data("weldpass-offline:v1:\(entry.deviceId):\(entry.workspaceId)".utf8)
    let plaintext = try AES.GCM.open(box, using: key, authenticating: aad)
    return try JSONDecoder().decode(Copy.self, from: plaintext)
  }

  /// A fill, for the vault's trail: the app uploads these at its next sync.
  static func recordFill(_ login: Login) {
    guard let folder else { return }
    let url = folder.appendingPathComponent("fills.json")
    var fills = (try? JSONDecoder().decode([Fill].self, from: Data(contentsOf: url))) ?? []
    fills.append(
      Fill(
        workspaceId: login.workspaceId, vaultId: login.vaultId, itemId: login.itemId,
        at: ISO8601DateFormatter().string(from: Date())))
    if let data = try? JSONEncoder().encode(Array(fills.suffix(500))) {
      try? data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
  }

  // MARK: - The parts of the copy the extension reads

  struct IndexEntry: Decodable {
    let workspaceId: String
    let deviceId: String
    let file: String
  }

  struct Copy: Decodable {
    let vaults: [String: Vault]
  }

  struct Vault: Decodable {
    let items: [String: Item]
  }

  struct Item: Decodable {
    let id: String
    let vaultId: String
    let type: String
    let title: String
    let host: String?
    let fields: Fields?
  }

  struct Fields: Decodable {
    let username: String?
    let password: String?
  }

  struct Fill: Codable {
    let workspaceId: String
    let vaultId: String
    let itemId: String
    let at: String
  }
}

struct Login {
  let vaultId: String
  let itemId: String
  let workspaceId: String
  let title: String
  let host: String?
  let username: String
  let password: String

  var recordIdentifier: String { "\(workspaceId)/\(vaultId)/\(itemId)" }
}

/// `hostsMatch` from `@weldsuite/app-api-client` (the same host, or one a
/// subdomain of the other with at least two labels in common). Phase 1.6
/// moves the shared rule to the public-suffix list; follow it here.
enum HostMatch {
  static func host(of identifier: String) -> String? {
    let candidate = identifier.contains("://") ? identifier : "https://\(identifier)"
    guard let host = URLComponents(string: candidate)?.host?.lowercased() else { return nil }
    return host.hasPrefix("www.") ? String(host.dropFirst(4)) : host
  }

  static func matches(_ itemHost: String, _ pageHost: String) -> Bool {
    if itemHost == pageHost { return true }
    let (short, long) = itemHost.count < pageHost.count ? (itemHost, pageHost) : (pageHost, itemHost)
    return short.split(separator: ".").count >= 2 && long.hasSuffix(".\(short)")
  }
}
