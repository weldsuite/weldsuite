import AuthenticationServices
import Foundation

/// The system's list of WeldPass logins for QuickType suggestions: host and
/// username only, never a password (ADR PASS-010). Replaced after each sync.
enum CredentialIdentities {
  private struct Identity: Decodable {
    let host: String
    let username: String
    let recordIdentifier: String
  }

  static func replace(json: String, completion: @escaping (Bool) -> Void) {
    guard
      let data = json.data(using: .utf8),
      let identities = try? JSONDecoder().decode([Identity].self, from: data)
    else {
      completion(false)
      return
    }
    let store = ASCredentialIdentityStore.shared
    store.getState { state in
      // Off in Settings → Passwords → AutoFill: nothing to keep up to date.
      guard state.isEnabled else {
        completion(false)
        return
      }
      let entries = identities.map {
        ASPasswordCredentialIdentity(
          serviceIdentifier: ASCredentialServiceIdentifier(identifier: $0.host, type: .domain),
          user: $0.username,
          recordIdentifier: $0.recordIdentifier)
      }
      store.replaceCredentialIdentities(with: entries) { success, _ in completion(success) }
    }
  }

  static func clear(completion: @escaping (Bool) -> Void) {
    ASCredentialIdentityStore.shared.removeAllCredentialIdentities { success, _ in completion(success) }
  }

  static func isEnabled(completion: @escaping (Bool) -> Void) {
    ASCredentialIdentityStore.shared.getState { state in completion(state.isEnabled) }
  }
}
