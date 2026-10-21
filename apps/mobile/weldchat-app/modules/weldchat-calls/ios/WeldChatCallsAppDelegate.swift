import ExpoModulesCore

/// Starts PushKit at launch, before JS: a VoIP push that woke a terminated app
/// must be reported to CallKit right away, long before the JS bundle runs.
public class WeldChatCallsAppDelegate: ExpoAppDelegateSubscriber {
  public func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    CallService.shared.start()
    return true
  }
}
