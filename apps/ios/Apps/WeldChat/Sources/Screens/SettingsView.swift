import SwiftUI
import WeldCore
import WeldUI

/// Settings: your profile first, then what every app has (workspace, app
/// lock, notifications, appearance, language, account and version).
struct SettingsView: View {
    let env: AppEnvironment
    let person: Person
    let workspace: WorkspaceRef
    let workspaces: [WorkspaceRef]
    @Binding var appearance: AppAppearance

    var body: some View {
        Form {
            Section {
                NavigationLink(value: ChatRoute.profile) {
                    HStack(spacing: Tokens.Spacing.m) {
                        ChatAvatar(name: person.name ?? person.email, url: nil, size: 36)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(ChatStrings.profileYourProfile)
                            if let detail = person.name ?? person.email {
                                Text(detail).font(.inter(.caption)).foregroundStyle(.secondary).lineLimit(1)
                            }
                        }
                    }
                }
                .accessibilityIdentifier("settings-profile")
            }

            CommonSettingsSections(
                env: env,
                appName: ChatStrings.appName,
                person: person,
                workspace: workspace,
                workspaces: workspaces,
                appearance: $appearance
            )
        }
        .navigationTitle(CoreStrings.settingsTitle)
        .navigationBarTitleDisplayMode(.inline)
    }
}

/// Your profile: the picture, the name and e-mail (and phone, when set),
/// and where to change them: the account on the web.
struct ProfileView: View {
    let env: AppEnvironment
    let store: ChatStore
    let person: Person

    @Environment(\.openURL) private var openURL
    @State private var profile: MemberProfileInfo?

    var body: some View {
        let name = profile?.name ?? person.name ?? person.email ?? ChatStrings.memberFallbackName
        let email = profile?.email ?? person.email
        Form {
            Section {
                VStack(spacing: Tokens.Spacing.s) {
                    ChatAvatar(name: name, url: profile?.picture, size: 84)
                    Text(name).font(.inter(.title2, weight: .semibold)).multilineTextAlignment(.center)
                    if let title = profile?.title, !title.isEmpty {
                        Text(title).font(.inter(.subheadline)).foregroundStyle(.secondary)
                    }
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, Tokens.Spacing.s)
                .listRowBackground(Color.clear)
            }

            Section(ChatStrings.profilePersonalInfo) {
                LabeledContent {
                    Text(name)
                } label: {
                    Label(ChatStrings.profileName, systemImage: "person")
                }
                if let email, !email.isEmpty {
                    LabeledContent {
                        Text(email).lineLimit(1)
                    } label: {
                        Label(ChatStrings.profileEmail, systemImage: "envelope")
                    }
                }
                if let phone = profile?.phone, !phone.isEmpty {
                    LabeledContent {
                        Text(phone)
                    } label: {
                        Label(ChatStrings.memberFieldsPhone, systemImage: "phone")
                    }
                }
            }

            Section {
                Button {
                    openURL(env.serverURL)
                } label: {
                    Label(ChatStrings.profileManageOnWeb, systemImage: "lock.shield")
                }
                .accessibilityIdentifier("profile-manage-on-web")
            }
        }
        .navigationTitle(ChatStrings.profileTitle)
        .navigationBarTitleDisplayMode(.inline)
        .task { profile = try? await store.memberProfile(person.id) }
    }
}
