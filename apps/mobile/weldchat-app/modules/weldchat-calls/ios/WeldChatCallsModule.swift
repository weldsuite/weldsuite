import ExpoModulesCore

/// JS API of the iOS incoming-call ring (CallKit + PushKit, see CallService).
/// The Android side of the same API runs the full-screen call notification.
public class WeldChatCallsModule: Module {
  public func definition() -> ModuleDefinition {
    Name("WeldChatCalls")

    Events("onCallAction", "onVoipToken")

    OnStartObserving {
      CallService.shared.setActionListener { [weak self] event in
        self?.sendEvent("onCallAction", event.mapValues { $0 as Any? })
      }
      DispatchQueue.main.async {
        CallService.shared.tokenListener = { [weak self] token in
          self?.sendEvent("onVoipToken", ["token": token])
        }
      }
    }

    OnStopObserving {
      CallService.shared.setActionListener(nil)
      DispatchQueue.main.async { CallService.shared.tokenListener = nil }
    }

    /// Where CallKit's Decline posts the ring token while the app has no session.
    Function("configure") { (declineUrl: String?) in
      CallService.shared.declineUrl = declineUrl
    }

    Function("getVoipToken") { () -> String? in
      CallService.shared.voipToken
    }

    /// Ring through CallKit for a ring JS learned about (the realtime socket).
    Function("reportIncomingCall") { (payload: [String: Any]) in
      let strings = payload.compactMapValues { $0 as? String }
      DispatchQueue.main.async { CallService.shared.reportIncoming(strings) }
    }

    /// Take the call out of CallKit (declined in-app, hung up, or over).
    Function("endCall") { (callId: String) in
      DispatchQueue.main.async { CallService.shared.endFromApp(callId) }
    }

    Function("takePendingActions") { () -> [[String: Any]] in
      CallService.shared.takePending()
    }

    // Android-only (full-screen notification); kept so JS calls one API on both platforms.
    Function("showIncomingCall") { (_: [String: Any], _: [String: Any]) -> Bool in
      false
    }
    Function("isAppInForeground") { () -> Bool in
      false
    }
    Function("canUseFullScreenIntent") { () -> Bool in
      true
    }
    Function("openFullScreenIntentSettings") {}
    AsyncFunction("releaseLockScreen") {}
  }
}
