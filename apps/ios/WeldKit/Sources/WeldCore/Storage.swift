import Foundation
import Security

/// Secrets (the OIDC session) in the Keychain, this device only, readable
/// once the phone has been unlocked after a restart.
public struct Keychain: Sendable {
    private let service: String

    public init(service: String = "org.weldsuite.session") {
        self.service = service
    }

    public func data(for key: String) -> Data? {
        var query = baseQuery(key)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess else { return nil }
        return result as? Data
    }

    public func set(_ data: Data, for key: String) {
        let update: [String: Any] = [kSecValueData as String: data]
        let status = SecItemUpdate(baseQuery(key) as CFDictionary, update as CFDictionary)
        if status == errSecItemNotFound {
            var add = baseQuery(key)
            add[kSecValueData as String] = data
            add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            SecItemAdd(add as CFDictionary, nil)
        }
    }

    public func remove(_ key: String) {
        SecItemDelete(baseQuery(key) as CFDictionary)
    }

    private func baseQuery(_ key: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
    }
}

/// Non-secret values (the person's name, the workspace list, the last good
/// `/config.json`) in the app's defaults.
public struct Cache: Sendable {
    public init() {}

    public func data(for key: String) -> Data? { UserDefaults.standard.data(forKey: key) }
    public func set(_ data: Data, for key: String) { UserDefaults.standard.set(data, forKey: key) }
    public func string(for key: String) -> String? { UserDefaults.standard.string(forKey: key) }
    public func set(_ string: String, for key: String) { UserDefaults.standard.set(string, forKey: key) }
    public func remove(_ key: String) { UserDefaults.standard.removeObject(forKey: key) }
}
