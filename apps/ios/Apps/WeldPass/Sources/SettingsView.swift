import SwiftUI
import WeldCore
import WeldUI

/// The workspace, the server, the lock and the account.
struct SettingsView: View {
    let env: AppEnvironment
    let store: PassStore
    let person: Person
    let workspace: WorkspaceRef
    let workspaces: [WorkspaceRef]

    @State private var confirmSignOut = false
    @State private var switching = false

    var body: some View {
        List {
            Section(PassStrings.settingsWorkspace) {
                if workspaces.count > 1 {
                    Button {
                        switching = true
                    } label: {
                        LabeledContent(workspace.name, value: PassStrings.settingsSwitchWorkspace)
                    }
                    .accessibilityIdentifier("switch-workspace")
                } else {
                    Text(workspace.name)
                }
            }

            Section(PassStrings.settingsServer) {
                Text(env.serverName)
            }

            Section {
                Text(PassStrings.settingsLock(method: env.lock.biometryName ?? PassStrings.lockBiometrics))
                NavigationLink(PassStrings.settingsHealth, value: HealthRoute())
                    .accessibilityIdentifier("password-health")
            } header: {
                Text(PassStrings.settingsSecurity)
            } footer: {
                Text(PassStrings.settingsLockAlwaysOn)
            }

            Section(PassStrings.settingsAccount) {
                VStack(alignment: .leading) {
                    Text(person.name ?? person.email ?? "")
                    if person.name != nil, let email = person.email {
                        Text(email).font(.subheadline).foregroundStyle(.secondary)
                    }
                }
                Button(PassStrings.settingsSignOut, role: .destructive) { confirmSignOut = true }
                    .accessibilityIdentifier("sign-out")
            }

            Section {
                let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? ""
                Text(PassStrings.settingsVersion(version: version))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity)
            }
            .listRowBackground(Color.clear)
        }
        .confirmationDialog(PassStrings.settingsSignOutTitle, isPresented: $confirmSignOut, titleVisibility: .visible) {
            Button(PassStrings.settingsSignOut, role: .destructive) {
                store.clear()
                Task { await env.signOut() }
            }
            .accessibilityIdentifier("confirm-sign-out")
            Button(PassStrings.commonCancel, role: .cancel) {}
        } message: {
            Text(PassStrings.settingsSignOutMessage)
        }
        .sheet(isPresented: $switching) {
            NavigationStack {
                WorkspacePicker(workspaces: workspaces) { id in
                    switching = false
                    env.chooseWorkspace(id)
                }
            }
        }
    }
}
