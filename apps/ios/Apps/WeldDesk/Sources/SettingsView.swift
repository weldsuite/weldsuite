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
                    // The platform's neutral icon square, not an app colour.
                    Image(systemName: "bubble.left.and.bubble.right")
                        .font(.system(size: 15))
                        .foregroundStyle(Tokens.Palette.mutedForeground)
                        .frame(width: 36, height: 36)
                        .background(Tokens.Palette.muted, in: RoundedRectangle(cornerRadius: Tokens.Radius.medium))
                        .accessibilityHidden(true)
                    Text(DeskStrings.settingsChannelsHint)
                        .font(.inter(.subheadline))
                        .foregroundStyle(Tokens.Palette.mutedForeground)
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
