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
  }
}
