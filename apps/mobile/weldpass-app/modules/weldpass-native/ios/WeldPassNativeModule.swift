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
  }
}
