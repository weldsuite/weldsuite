import SwiftUI
import UIKit
import WeldCore

/// Light, dark, or the phone's setting. Kept per app with
/// `@AppStorage(AppAppearance.storageKey(app:))`.
public enum AppAppearance: String, CaseIterable, Identifiable, Sendable {
    case system, light, dark

    public static func storageKey(app: String) -> String { "\(app).appearance" }

    public var id: String { rawValue }

    public var colorScheme: ColorScheme? {
        switch self {
        case .system: nil
        case .light: .light
        case .dark: .dark
        }
    }

    public var label: String {
        switch self {
        case .system: CoreStrings.settingsSystem
        case .light: CoreStrings.settingsLight
        case .dark: CoreStrings.settingsDark
        }
    }
}

/// The settings every app has, as `Section`s for the app's own settings
/// `Form`, below its own: the workspace (and switching it), the app lock,
/// notifications, appearance, language, and the account with sign-out and the
/// version. Accessibility identifiers: `switch-workspace`, `app-lock`,
/// `appearance`, `language`, `notifications`, `sign-out`.
public struct CommonSettingsSections: View {
    let env: AppEnvironment
    let appName: String
    let person: Person
    let workspace: WorkspaceRef
    let workspaces: [WorkspaceRef]
    @Binding var appearance: AppAppearance

    @State private var confirmSignOut = false
    @State private var confirmDelete = false
    @State private var notificationsAllowed: Bool?
    @Environment(\.openURL) private var openURL

    public init(
        env: AppEnvironment,
        appName: String,
        person: Person,
        workspace: WorkspaceRef,
        workspaces: [WorkspaceRef],
        appearance: Binding<AppAppearance>
    ) {
        self.env = env
        self.appName = appName
        self.person = person
        self.workspace = workspace
        self.workspaces = workspaces
        _appearance = appearance
    }

    public var body: some View {
        Section(CoreStrings.settingsWorkspace) {
            LabeledContent(CoreStrings.settingsWorkspace, value: workspace.name)
            if workspaces.count > 1 {
                NavigationLink {
                    WorkspaceSwitchView(env: env, workspaces: workspaces)
                } label: {
                    Text(CoreStrings.settingsSwitchWorkspace)
                }
                .accessibilityIdentifier("switch-workspace")
            }
        }

        if env.lock.isOptional, env.lock.hasScreenLock {
            let method = env.lock.biometryName ?? CoreStrings.settingsPasscode
            Section {
                Toggle(CoreStrings.settingsLock(method: method), isOn: Binding(
                    get: { env.lock.optionalEnabled },
                    set: { on in Task { _ = await env.lock.setEnabled(on, reason: CoreStrings.settingsLock(method: method)) } }
                ))
                .accessibilityIdentifier("app-lock")
            } header: {
                Text(CoreStrings.settingsSecurity)
            } footer: {
                Text(CoreStrings.settingsLockDescription(app: appName, method: method))
            }
        }

        Section {
            if env.push != nil {
                Button(action: openSystemSettings) {
                    LabeledContent(
                        CoreStrings.settingsNotifications,
                        value: notificationsAllowed == false ? CoreStrings.commonNone : CoreStrings.settingsNotificationsOn
                    )
                }
                .accessibilityIdentifier("notifications")
                .task { notificationsAllowed = await PushCenter.shared.isAuthorized() }
            }
            Picker(CoreStrings.settingsAppearance, selection: $appearance) {
                ForEach(AppAppearance.allCases) { option in
                    Text(option.label).tag(option)
                }
            }
            .accessibilityIdentifier("appearance")
            // The app's language is iOS's per-app setting, on the app's page in Settings.
            Button(action: openSystemSettings) {
                LabeledContent(
                    CoreStrings.settingsLanguage,
                    value: Locale.current.localizedString(forLanguageCode: Locale.current.language.languageCode?.identifier ?? "en")?
                        .capitalized ?? ""
                )
            }
            .accessibilityIdentifier("language")
        } footer: {
            if env.push != nil, notificationsAllowed == false {
                Text(CoreStrings.settingsNotificationsOff(app: appName))
            }
        }

        Section {
            VStack(alignment: .leading) {
                Text(person.name ?? person.email ?? "")
                if person.name != nil, let email = person.email {
                    Text(email).font(.footnote).foregroundStyle(.secondary)
                }
            }
            LabeledContent(CoreStrings.settingsServer, value: env.serverName)
            Button(CoreStrings.settingsSignOut, role: .destructive) { confirmSignOut = true }
                .accessibilityIdentifier("sign-out")
            // In-app account deletion (App Store guideline 5.1.1(v)): finished on
            // the sign-in provider's account page.
            Button(CoreStrings.settingsDeleteAccount, role: .destructive) { confirmDelete = true }
                .accessibilityIdentifier("delete-account")
        } header: {
            Text(CoreStrings.settingsAccount)
        } footer: {
            Text(CoreStrings.settingsVersion(version: env.app.version))
        }
        .confirmationDialog(CoreStrings.settingsSignOutTitle(app: appName), isPresented: $confirmSignOut, titleVisibility: .visible) {
            Button(CoreStrings.settingsSignOut, role: .destructive) { Task { await env.signOut() } }
                .accessibilityIdentifier("confirm-sign-out")
        } message: {
            Text(CoreStrings.settingsSignOutMessage(app: appName))
        }
        .alert(CoreStrings.settingsDeleteAccountTitle, isPresented: $confirmDelete) {
            if let page = env.accountURL {
                Button(CoreStrings.settingsDeleteAccountContinue, role: .destructive) { openURL(page) }
                    .accessibilityIdentifier("delete-account-continue")
            }
            Button(CoreStrings.commonCancel, role: .cancel) {}
        } message: {
            Text(env.accountURL != nil ? CoreStrings.settingsDeleteAccountMessage : CoreStrings.settingsDeleteAccountUnavailable)
        }
    }

    private func openSystemSettings() {
        if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
    }
}

/// The workspace list from settings; closes once one is chosen.
private struct WorkspaceSwitchView: View {
    let env: AppEnvironment
    let workspaces: [WorkspaceRef]
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        WorkspacePicker(workspaces: workspaces) { id in
            env.chooseWorkspace(id)
            dismiss()
        }
    }
}
