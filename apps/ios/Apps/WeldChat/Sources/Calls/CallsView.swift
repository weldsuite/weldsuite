import SwiftUI
import WeldCore
import WeldUI

/// The Calls tab's lists: the calls running now and the history, a page at a time.
@MainActor
@Observable
final class CallsModel {
    private(set) var active: [ActiveCallSummary] = []
    private(set) var history: [CallHistoryEntry] = []
    private(set) var loading = true
    private(set) var loadingMore = false
    private(set) var error: APIError?
    /// The history loaded at least once.
    private(set) var loaded = false

    @ObservationIgnored private var cursor: String?
    /// Bumped on every reload: a page that lands after one belongs to the old list.
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private let api: CallAPI

    static let pageSize = 30

    init(env: AppEnvironment) {
        api = CallAPI(env: env)
    }

    /// The running calls and the first page of history; each on its own, so
    /// one failing still shows the other.
    func load() async {
        generation += 1
        let current = generation
        var failure: APIError?
        do {
            let calls = try await api.activeCalls()
            if current == generation { active = calls }
        } catch {
            failure = APIError.from(error)
        }
        do {
            let page = try await api.history(cursor: nil, limit: Self.pageSize)
            if current == generation {
                history = page.entries
                cursor = page.nextCursor
                loaded = true
            }
        } catch {
            failure = APIError.from(error)
        }
        guard current == generation else { return }
        error = failure
        loading = false
    }

    func loadMore() async {
        guard let cursor, !loadingMore else { return }
        loadingMore = true
        defer { loadingMore = false }
        let current = generation
        guard let page = try? await api.history(cursor: cursor, limit: Self.pageSize), current == generation else { return }
        let seen = Set(history.map(\.id))
        history += page.entries.filter { !seen.contains($0.id) }
        self.cursor = page.nextCursor
    }

    /// The history without the calls still running: those have their own Join rows.
    var recent: [CallHistoryEntry] {
        let live = Set(active.map(\.callID))
        return history.filter { !live.contains($0.id) }
    }

    /// A running call's history row says who it is with.
    func known(_ callID: String) -> CallHistoryEntry? {
        history.first { $0.id == callID }
    }
}

/// The Calls tab (port of the Expo app's `app/(tabs)/calls.tsx`): Join the
/// calls running in your conversations, call back, open the conversation.
struct CallsView: View {
    let env: AppEnvironment
    let manager: CallManager
    let onOpenConversation: (_ channelID: String, _ name: String, _ isDM: Bool) -> Void

    @State private var model: CallsModel
    @State private var joiningID: String?
    @State private var callingID: String?
    @Environment(Toaster.self) private var toaster: Toaster?

    init(
        env: AppEnvironment,
        manager: CallManager,
        onOpenConversation: @escaping (_ channelID: String, _ name: String, _ isDM: Bool) -> Void
    ) {
        self.env = env
        self.manager = manager
        self.onOpenConversation = onOpenConversation
        _model = State(initialValue: CallsModel(env: env))
    }

    var body: some View {
        List {
            if !model.active.isEmpty {
                Section {
                    ForEach(model.active) { call in
                        ongoingRow(call)
                    }
                } header: {
                    ListGroupHeader(label: ChatStrings.callsOngoing, count: model.active.count)
                        .listRowInsets(EdgeInsets())
                }
            }
            Section {
                ForEach(model.recent) { entry in
                    historyRow(entry)
                }
                if model.loadingMore {
                    ProgressView()
                        .frame(maxWidth: .infinity)
                        .listRowSeparator(.hidden)
                }
            } header: {
                if !model.active.isEmpty, !model.recent.isEmpty {
                    ListGroupHeader(label: ChatStrings.callsRecent)
                        .listRowInsets(EdgeInsets())
                }
            }
        }
        .listStyle(.plain)
        .environment(\.defaultMinListRowHeight, 0)
        .accessibilityIdentifier("calls-list")
        .overlay { placeholder }
        .navigationTitle(ChatStrings.tabsCalls)
        .refreshable { await model.load() }
        .task { await model.load() }
        .task(id: manager.userID) { await listen() }
    }

    @ViewBuilder
    private var placeholder: some View {
        if model.active.isEmpty, model.recent.isEmpty {
            if model.loading {
                ProgressView()
            } else if let error = model.error, !model.loaded {
                LoadErrorView(error: error) { await model.load() }
            } else {
                ChatEmptyState(title: ChatStrings.callsEmptyTitle, description: ChatStrings.callsEmptyHint, symbol: "phone.arrow.up.right")
                    .accessibilityIdentifier("calls-empty")
            }
        }
    }

    /// A call starting or ending in one of the person's conversations while the list shows.
    private func listen() async {
        guard let userID = manager.userID, let realtime = env.realtime else { return }
        for await event in realtime.events(["chat.user.\(userID)"]) {
            if event.isResync || event.event == "call_started" || event.event == "call_ended" {
                await model.load()
            }
        }
    }

    // MARK: - Rows

    private func ongoingRow(_ call: ActiveCallSummary) -> some View {
        let isVideo = call.callType == .video
        let participants = ChatStrings.callsParticipantCount(call.participantCount)
        let subtitle = model.known(call.callID).map { CallRules.joined([CallRules.title($0), participants]) } ?? participants
        return HStack(spacing: Tokens.Spacing.m) {
            Image(systemName: isVideo ? "video.fill" : "phone.fill")
                .font(.system(size: 16))
                .foregroundStyle(ChatColors.joinGreen)
                .frame(width: 40, height: 40)
                .background(ChatColors.joinGreen.opacity(0.1), in: AvatarShape())
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(isVideo ? ChatStrings.callsOngoingVideoCall : ChatStrings.callsOngoingVoiceCall)
                    .font(.inter(.subheadline, weight: .medium))
                    .lineLimit(1)
                Text(subtitle)
                    .font(.inter(size: 13))
                    .foregroundStyle(Tokens.Palette.mutedForeground)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
            Button {
                join(call.callID)
            } label: {
                if joiningID == call.callID {
                    ProgressView()
                } else {
                    Text(ChatStrings.callsJoin)
                        .bold()
                }
            }
            .buttonStyle(.borderedProminent)
            // The platform's Join on a running call: `bg-green-600`.
            .tint(ChatColors.joinGreen)
            .disabled(joiningID == call.callID)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("calls-ongoing-\(call.callID)")
    }

    private func historyRow(_ entry: CallHistoryEntry) -> some View {
        let incoming = entry.direction == "incoming"
        let missed = CallRules.isMissedIncoming(entry)
        let title = CallRules.title(entry)
        return HStack(spacing: Tokens.Spacing.m) {
            avatar(entry, title: title)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.inter(.subheadline, weight: .medium))
                    .foregroundStyle(missed ? ChatColors.callRed : Tokens.Palette.foreground)
                    .lineLimit(1)
                HStack(spacing: Tokens.Spacing.xs) {
                    Image(systemName: incoming ? "arrow.down.left" : "arrow.up.right")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(missed ? ChatColors.callRed : Tokens.Palette.mutedForeground)
                        .accessibilityHidden(true)
                    Text(CallRules.subtitle(entry))
                        .font(.inter(size: 13))
                        .foregroundStyle(Tokens.Palette.mutedForeground)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 0)
            if let date = WeldDate.parse(entry.createdAt) {
                Text(CallRules.time(date))
                    .font(.inter(.caption))
                    .foregroundStyle(Tokens.Palette.mutedForeground)
            }
            Button {
                callBack(entry, title: title)
            } label: {
                if callingID == entry.id {
                    ProgressView()
                } else {
                    Image(systemName: entry.callType == .video ? "video" : "phone")
                        .font(.system(size: 17))
                        .foregroundStyle(Tokens.Palette.mutedForeground)
                }
            }
            .buttonStyle(.borderless)
            .frame(width: 44, height: 44)
            .disabled(callingID != nil)
            .accessibilityLabel(CallRules.joined([ChatStrings.callsCallBack, title]))
            .accessibilityIdentifier("calls-callback-\(entry.id)")
        }
        .contentShape(Rectangle())
        .onTapGesture { open(entry, title: title) }
        .accessibilityElement(children: .contain)
        .accessibilityAddTraits(.isButton)
        .accessibilityIdentifier("calls-row-\(entry.id)")
        .onAppear {
            if entry.id == model.recent.last?.id {
                Task { await model.loadMore() }
            }
        }
    }

    @ViewBuilder
    private func avatar(_ entry: CallHistoryEntry, title: String) -> some View {
        if !CallRules.isDM(entry) {
            Image(systemName: "number")
                .font(.system(size: 16, weight: .medium))
                .foregroundStyle(Tokens.Palette.mutedForeground)
                .frame(width: 40, height: 40)
                .background(Tokens.Palette.muted, in: AvatarShape())
                .accessibilityHidden(true)
        } else if CallRules.isGroupDM(entry) {
            Image(systemName: "person.2.fill")
                .font(.system(size: 15))
                .foregroundStyle(Tokens.Palette.mutedForeground)
                .frame(width: 40, height: 40)
                .background(Tokens.Palette.muted, in: AvatarShape())
                .accessibilityHidden(true)
        } else {
            ChatAvatar(name: title, url: entry.counterpart?.avatar, size: 40)
        }
    }

    // MARK: - Actions

    private func join(_ callID: String) {
        joiningID = callID
        Task {
            do {
                try await manager.joinCall(callID: callID, peer: nil)
            } catch {
                toaster?.show(ChatStrings.channelCallFailedBody)
            }
            joiningID = nil
        }
    }

    /// The same peer as the conversation's own call button, for the "calling" screen.
    private func callBack(_ entry: CallHistoryEntry, title: String) {
        let peer: CallPeer? = CallRules.isDM(entry)
            ? CallPeer(name: title, avatar: CallRules.isGroupDM(entry) ? nil : entry.counterpart?.avatar, isDirect: true)
            : nil
        callingID = entry.id
        Task {
            do {
                try await manager.startCall(channelID: entry.channelID, callType: entry.callType, peer: peer)
            } catch {
                toaster?.show(ChatStrings.channelCallFailedBody)
            }
            callingID = nil
        }
    }

    private func open(_ entry: CallHistoryEntry, title: String) {
        if CallRules.isDM(entry) {
            onOpenConversation(entry.channelID, title, true)
        } else {
            onOpenConversation(entry.channelID, entry.channelName ?? "", false)
        }
    }
}
