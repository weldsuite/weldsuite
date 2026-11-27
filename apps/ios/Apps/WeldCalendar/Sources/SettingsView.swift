import SwiftUI
import WeldCore
import WeldUI

/// WeldSuite's privacy pages, as the Expo app linked them.
private enum PrivacyLinks {
    static let policy = URL(string: "https://weldsuite.com/privacy")
    static let terms = URL(string: "https://weldsuite.com/terms")
    static let support = URL(string: "mailto:privacy@weldsuite.com?subject=Privacy%20Inquiry")
}

/// The More tab: the app's own privacy links first, then the settings every
/// app shares (workspace, lock, notifications, appearance, language, and the
/// account with sign-out and account deletion).
struct SettingsView: View {
    let env: AppEnvironment
    let person: Person
    let workspace: WorkspaceRef
    let workspaces: [WorkspaceRef]
    @Binding var appearance: AppAppearance

    @Environment(\.openURL) private var openURL

    var body: some View {
        Form {
            Section(CalendarStrings.settingsPrivacy) {
                link(CalendarStrings.settingsPrivacyPolicy, PrivacyLinks.policy, id: "privacy-policy")
                link(CalendarStrings.settingsTerms, PrivacyLinks.terms, id: "terms")
                link(CalendarStrings.settingsContactSupport, PrivacyLinks.support, id: "contact-support")
            }
            CommonSettingsSections(
                env: env,
                appName: CalendarStrings.appName,
                person: person,
                workspace: workspace,
                workspaces: workspaces,
                appearance: $appearance
            )
        }
        .navigationTitle(CalendarStrings.settingsTitle)
    }

    @ViewBuilder private func link(_ title: String, _ url: URL?, id: String) -> some View {
        if let url {
            Button(title) { openURL(url) }
                .foregroundStyle(.primary)
                .accessibilityIdentifier(id)
        }
    }
}
