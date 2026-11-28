import AuthenticationServices
import SwiftUI

/// AutoFill in Settings: whether WeldPass is turned on in Settings →
/// Passwords → AutoFill, with a way there. It reads the offline copy, so it
/// needs one.
struct AutofillSection: View {
    let offline: OfflineStore

    @Environment(\.scenePhase) private var scenePhase
    @State private var enabled = false

    var body: some View {
        Section {
            VStack(alignment: .leading, spacing: 2) {
                Text(PassStrings.settingsAutofill)
                Text(line).font(.inter(.subheadline)).foregroundStyle(.secondary)
            }
            if !enabled {
                Button(PassStrings.settingsAutofillTurnOn) {
                    Task { try? await ASSettingsHelper.openCredentialProviderAppSettings() }
                }
                .accessibilityIdentifier("autofill-turn-on")
            }
        }
        .task(id: scenePhase) {
            // Back from Settings: read it again.
            if scenePhase == .active { enabled = await CredentialIdentities.isEnabled() }
        }
    }

    private var line: String {
        if offline.readable == nil { return PassStrings.settingsAutofillNeedsCopy }
        return enabled ? PassStrings.settingsAutofillOn : PassStrings.settingsAutofillOff
    }
}
