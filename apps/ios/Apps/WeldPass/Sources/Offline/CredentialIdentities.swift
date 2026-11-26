import AuthenticationServices
import Foundation

/// The system's list of WeldPass logins for QuickType suggestions: host and
/// username only, never a password (ADR PASS-010). Replaced after each sync.
/// A record identifier is `<workspaceId>|<vaultId>|<itemId>`, which the
/// AutoFill extension looks up in the copy.
enum CredentialIdentities {
    static func replace(with copy: OfflineCopy) async {
        let store = ASCredentialIdentityStore.shared
        // Off in Settings → Passwords → AutoFill: nothing to keep up to date.
        guard await store.state().isEnabled else { return }
        var identities: [ASPasswordCredentialIdentity] = []
        for vault in copy.vaults.values {
            for item in vault.items.values {
                let summary = item.value1
                guard let host = summary.host, !host.isEmpty, let user = item.value2.fields.username, !user.isEmpty else { continue }
                identities.append(ASPasswordCredentialIdentity(
                    serviceIdentifier: ASCredentialServiceIdentifier(identifier: host, type: .domain),
                    user: user,
                    recordIdentifier: "\(copy.workspaceId)|\(summary.vaultId)|\(summary.id)"
                ))
            }
        }
        try? await store.replaceCredentialIdentities(with: identities)
    }

    static func removeAll() async {
        try? await ASCredentialIdentityStore.shared.removeAllCredentialIdentities()
    }

    /// Whether WeldPass is turned on in Settings → Passwords → AutoFill.
    static func isEnabled() async -> Bool {
        await ASCredentialIdentityStore.shared.state().isEnabled
    }
}
