import SwiftUI
import WeldCore
import WeldUI

/// WeldDesk's own settings (the channels are set up on the web), then the ones every app has.
struct SettingsView: View {
    let env: AppEnvironment
    let person: Person
    let workspace: WorkspaceRef
    let workspaces: [WorkspaceRef]
    @Binding var appearance: AppAppearance

    var body: some View {
        Form {
            Section(DeskStrings.settingsChannels) {
                HStack(alignment: .top, spacing: Tokens.Spacing.m) {
                    let violet = Color(red: 0.55, green: 0.36, blue: 0.96)
                    Image(systemName: "bubble.left.and.bubble.right")
                        .foregroundStyle(violet)
                        .frame(width: 36, height: 36)
                        .background(violet.opacity(0.12), in: RoundedRectangle(cornerRadius: Tokens.Radius.small))
                        .accessibilityHidden(true)
                    Text(DeskStrings.settingsChannelsHint)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                .accessibilityIdentifier("channels-hint")
            }
            CommonSettingsSections(
                env: env,
                appName: DeskStrings.appName,
                person: person,
                workspace: workspace,
                workspaces: workspaces,
                appearance: $appearance
            )
        }
        .accessibilityIdentifier("settings")
    }
}
