import SwiftUI
import WeldCore
import WeldUI

/// WeldMail once signed in, in a workspace and unlocked.
struct ContentView: View {
    let env: AppEnvironment
    let person: Person
    let workspace: WorkspaceRef
    let workspaces: [WorkspaceRef]
    @Binding var appearance: AppAppearance

    var body: some View {
        NavigationStack {
            Form {
                CommonSettingsSections(
                    env: env,
                    appName: MailStrings.appName,
                    person: person,
                    workspace: workspace,
                    workspaces: workspaces,
                    appearance: $appearance
                )
            }
            .navigationTitle(MailStrings.appName)
        }
    }
}
