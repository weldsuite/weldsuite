import SwiftUI
import WeldCore
import WeldUI

/// WeldMail's own settings (new mailboxes, subscriptions, the offline outbox), then the shared ones.
struct SettingsView: View {
    let env: AppEnvironment
    let store: MailStore
    let person: Person
    let workspace: WorkspaceRef
    let workspaces: [WorkspaceRef]
    @Binding var appearance: AppAppearance

    @Environment(MailNavigator.self) private var nav

    var body: some View {
        Form {
            Section(MailStrings.settingsMail) {
                if env.isAvailable("mail-free-addresses") || env.isAvailable("mail-domains") {
                    Button {
                        nav.open(.addAccount)
                    } label: {
                        Label(MailStrings.settingsAddAccount, systemImage: "plus.circle")
                    }
                    .accessibilityIdentifier("settings-add-account")
                }
                Button {
                    nav.open(.subscriptions)
                } label: {
                    Label(MailStrings.settingsSubscriptions, systemImage: "envelope.badge.shield.half.filled")
                }
                .accessibilityIdentifier("settings-subscriptions")
                VStack(alignment: .leading, spacing: Tokens.Spacing.xs) {
                    HStack {
                        Label(MailStrings.settingsOutbox, systemImage: "arrow.triangle.2.circlepath")
                        Spacer()
                        if store.pending > 0 {
                            Button(MailStrings.settingsSendNow) {
                                Task { await store.flush() }
                            }
                            .buttonStyle(.borderless)
                            .accessibilityIdentifier("settings-sync-now")
                        }
                    }
                    Text(store.pending == 0 ? MailStrings.settingsOutboxEmpty : MailStrings.settingsOutboxWaiting(store.pending))
                        .font(.footnote)
                    Text(MailStrings.settingsOutboxDescription)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                .accessibilityIdentifier("settings-outbox")
            }
            CommonSettingsSections(
                env: env,
                appName: MailStrings.appName,
                person: person,
                workspace: workspace,
                workspaces: workspaces,
                appearance: $appearance
            )
        }
        .accessibilityIdentifier("settings-list")
        .navigationTitle(CoreStrings.settingsTitle)
    }
}
