import SwiftUI
import WeldCore
import WeldUI

/// A team member, laid out like the platform's member panel: the avatar
/// with presence, the name and custom status, "⋮" (e-mail, call, video call,
/// open chat), and the Overview / Common / Activity tabs.
struct MemberView: View {
    let env: AppEnvironment
    let store: ChatStore
    let person: Person
    let userID: String

    @Environment(ChatNavigator.self) private var navigator
    @Environment(CallManager.self) private var calls
    @Environment(Toaster.self) private var toaster
    @Environment(\.openURL) private var openURL

    @State private var profile: MemberProfileInfo?
    @State private var presence: MemberPresence?
    @State private var state: MemberScreenRules.LoadState = .loading
    @State private var tab: MemberTab = .overview

    private var isSelf: Bool { person.id == userID }

    var body: some View {
        let name = MemberScreenRules.headerName(profile: profile, state: state)
        ScrollView {
            VStack(alignment: .leading, spacing: Tokens.Spacing.l) {
                header(name: name)
                if let profile {
                    tabBar
                    switch tab {
                    case .overview:
                        MemberOverviewTab(store: store, profile: Binding(
                            get: { profile },
                            set: { self.profile = $0 }
                        ))
                    case .common:
                        MemberCommonTab(store: store, userID: profile.userID)
                    case .activity:
                        MemberActivityTab(store: store, userID: profile.userID, memberName: profile.name)
                    }
                } else {
                    unavailable
                }
            }
            .padding(Tokens.Spacing.l)
        }
        .scrollDismissesKeyboard(.interactively)
        .navigationTitle(name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                if profile != nil { actionsMenu(name: name) }
            }
        }
        .task(id: userID) { await load() }
    }

    // MARK: Parts

    private func header(name: String) -> some View {
        HStack(spacing: Tokens.Spacing.m) {
            ZStack(alignment: .bottomTrailing) {
                if let profile {
                    ChatAvatar(name: name, url: profile.picture, size: 56)
                    Circle()
                        .fill(Color(hex: MemberLogic.presenceHex(presence?.status ?? .offline)))
                        .frame(width: 14, height: 14)
                        .overlay(Circle().stroke(Color(.systemBackground), lineWidth: 2))
                } else if state == .notFound {
                    Image(systemName: "person.crop.circle.badge.xmark").font(.system(size: 44)).foregroundStyle(.secondary)
                } else if state == .failed {
                    Image(systemName: "exclamationmark.triangle").font(.system(size: 36)).foregroundStyle(Tokens.Status.danger)
                }
            }
            VStack(alignment: .leading, spacing: 2) {
                if state != .loading {
                    Text(name).font(.inter(.title3, weight: .semibold)).lineLimit(1)
                    if let status = MemberScreenRules.customStatus(presence) {
                        Text(status).font(.inter(.subheadline)).foregroundStyle(.secondary).lineLimit(1)
                    }
                }
            }
            Spacer(minLength: 0)
        }
    }

    private var tabBar: some View {
        HStack(spacing: 0) {
            ForEach(MemberScreenRules.tabs(isSelf: isSelf)) { option in
                Button {
                    tab = option
                } label: {
                    VStack(spacing: 6) {
                        Label(option.label, systemImage: option.symbol)
                            .font(.inter(.subheadline).weight(option == tab ? .semibold : .regular))
                            .foregroundStyle(option == tab ? Color.primary : Color.secondary)
                        Rectangle()
                            .fill(option == tab ? Tokens.Palette.primary : Color.clear)
                            .frame(height: 2)
                    }
                    .frame(maxWidth: .infinity)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(option == tab ? .isSelected : [])
                .accessibilityIdentifier("member-tab-\(option.rawValue)")
            }
        }
        .overlay(alignment: .bottom) { Divider() }
    }

    @ViewBuilder
    private var unavailable: some View {
        switch state {
        case .loading, .ready:
            ProgressView().frame(maxWidth: .infinity).padding(.top, Tokens.Spacing.xl)
        case .notFound:
            ChatEmptyState(
                title: ChatStrings.memberNotFoundTitle,
                description: ChatStrings.memberNotFoundDescription,
                symbol: "person.crop.circle.badge.xmark"
            )
        case .failed:
            ContentUnavailableView {
                Label(ChatStrings.memberProfileLoadFailedTitle, systemImage: "exclamationmark.triangle")
            } description: {
                Text(ChatStrings.memberProfileLoadFailedDescription)
            } actions: {
                Button(CoreStrings.commonTryAgain) { Task { await load() } }
                    .accessibilityIdentifier("retry")
            }
        }
    }

    /// E-mail, call, video call and chat, as on the platform.
    private func actionsMenu(name: String) -> some View {
        Menu {
            if let email = profile?.email, !email.isEmpty, let url = URL(string: "mailto:\(email)") {
                Button {
                    openURL(url)
                } label: {
                    Label(ChatStrings.memberComposeEmail, systemImage: "envelope")
                }
            }
            if !isSelf {
                if env.isAvailable("chat-calls") {
                    Button {
                        Task { await call(.voice, name: name) }
                    } label: {
                        Label(ChatStrings.memberCall, systemImage: "phone")
                    }
                    .accessibilityIdentifier("member-call")
                    Button {
                        Task { await call(.video, name: name) }
                    } label: {
                        Label(ChatStrings.memberVideoCall, systemImage: "video")
                    }
                    .accessibilityIdentifier("member-video-call")
                }
                Button {
                    Task { await openChat(name: name) }
                } label: {
                    Label(ChatStrings.memberOpenChat, systemImage: "bubble.left")
                }
                .accessibilityIdentifier("member-open-chat")
            }
        } label: {
            Image(systemName: "ellipsis.circle")
        }
        .accessibilityLabel(ChatStrings.memberMoreActions)
        .accessibilityIdentifier("member-actions")
    }

    // MARK: Actions

    /// A gone member (404) and a failure read differently: only the failure offers a retry.
    private func load() async {
        if profile == nil { state = .loading }
        let id = userID
        let presenceLoad = Task { try? await store.presence(of: id) }
        do {
            profile = try await store.memberProfile(id)
            state = .ready
        } catch {
            profile = nil
            state = (error as? APIError)?.status == 404 ? .notFound : .failed
        }
        presence = await presenceLoad.value
        if !MemberScreenRules.tabs(isSelf: isSelf).contains(tab) { tab = .overview }
    }

    private func call(_ type: CallType, name: String) async {
        do {
            let dm = try await store.ensureDm(with: userID)
            try await calls.startCall(channelID: dm.id, callType: type, peer: CallPeer(name: name, avatar: profile?.picture, isDirect: true))
        } catch {
            toaster.show(ChatStrings.memberStartCallFailed)
        }
    }

    private func openChat(name: String) async {
        do {
            let dm = try await store.ensureDm(with: userID)
            navigator.openConversation(channelID: dm.id, name: name, type: "dm")
        } catch {
            toaster.show(APIError.from(error))
        }
    }
}
