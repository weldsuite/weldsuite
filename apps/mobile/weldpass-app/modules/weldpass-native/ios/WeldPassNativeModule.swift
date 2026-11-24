import AuthenticationServices
import ExpoModulesCore
import UIKit
import UniformTypeIdentifiers

/// WeldPass's native pieces on iOS. See `index.ts` for the JS API.
public class WeldPassNativeModule: Module {
  public func definition() -> ModuleDefinition {
    Name("WeldPassNative")

    /// A local-only item (not shared with other devices through Universal
    /// Clipboard) that the system removes at `expiresInSeconds`. The token is
    /// the pasteboard's change count, so clearing later never reads the
    /// clipboard (which would show iOS's paste banner).
    AsyncFunction("setSensitiveString") { (text: String, expiresInSeconds: Double) -> String in
      let pasteboard = UIPasteboard.general
      pasteboard.setItems(
        [[UTType.utf8PlainText.identifier: text]],
        options: [
          .localOnly: true,
          .expirationDate: Date().addingTimeInterval(max(1, expiresInSeconds)),
        ]
      )
      return String(pasteboard.changeCount)
    }.runOnQueue(.main)

    AsyncFunction("clearIfUnchanged") { (token: String) -> Bool in
      let pasteboard = UIPasteboard.general
      guard String(pasteboard.changeCount) == token else { return false }
      pasteboard.items = []
      return true
    }.runOnQueue(.main)

    /// The offline copy's folder stays out of iCloud and iTunes backups
    /// (ADR PASS-010). Its key is this-device-only anyway; this keeps the
    /// ciphertext off Apple's servers too.
    Function("excludeFromBackup") { (uri: String) -> Bool in
      guard var url = URL(string: uri) else { return false }
      var values = URLResourceValues()
      values.isExcludedFromBackup = true
      do {
        try url.setResourceValues(values)
        return true
      } catch {
        return false
      }
    }

    // MARK: Native autofill (phase 4C)

    /// The Keychain group the app shares with its AutoFill extension, as
    /// Xcode expanded it in Info.plist; nil in a build without it.
    Function("keychainGroup") { () -> String? in
      Bundle.main.object(forInfoDictionaryKey: "WeldPassKeychainGroup") as? String
    }

    AsyncFunction("replaceCredentialIdentities") { (json: String, promise: Promise) in
      CredentialIdentities.replace(json: json) { promise.resolve($0) }
    }

    AsyncFunction("clearCredentialIdentities") { (promise: Promise) in
      CredentialIdentities.clear { promise.resolve($0) }
    }

    AsyncFunction("autofillEnabled") { (promise: Promise) in
      CredentialIdentities.isEnabled { promise.resolve($0) }
    }

    /// Settings → General → AutoFill & Passwords, where WeldPass is switched on.
    Function("openAutofillSettings") {
      if #available(iOS 17.0, *) {
        ASSettingsHelper.openCredentialProviderAppSettings { _ in }
      }
    }
  }
}
