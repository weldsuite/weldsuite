import UIKit
import WeldCore

/// WeldChat's app delegate: the core's (notifications and the APNs token),
/// plus PushKit started at launch. A VoIP push that woke a terminated app
/// must be reported to CallKit right away, before any screen is up.
final class WeldChatAppDelegate: WeldAppDelegate {
    override func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        let launched = super.application(application, didFinishLaunchingWithOptions: launchOptions)
        CallKitService.shared.start()
        return launched
    }
}
