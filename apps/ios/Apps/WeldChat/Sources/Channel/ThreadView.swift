import SwiftUI
import WeldCore
import WeldUI

/// A thread: the message it hangs off, "N replies", the replies, and a
/// reply box with mentions. `draft` is the text carried over when a reply
/// chain moves into the thread.
struct ThreadView: View {
    let env: AppEnvironment
    let store: ChatStore
    let person: Person
    let messageID: String
    let channelID: String

    @Environment(ChatNavigator.self) private var navigator
    @Environment(Toaster.self) private var toaster
    @FocusState private var focused: Bool

    @State private var parent: ChatMessage?
    @State private var replies: [ChatMessage] = []
    @State private var agents: [ChannelMemberInfo] = []
    @State private var input: String
    @State private var loading = true
    @State private var loadError: APIError?
    @State private var sending = false
    @State private var viewer: ImageViewerState?

    private static let bottomID = "thread-bottom"

    init(env: AppEnvironment, store: ChatStore, person: Person, messageID: String, channelID: String, draft: String?) {
        self.env = env
        self.store = store
        self.person = person
        self.messageID = messageID
        self.channelID = channelID
        _input = State(initialValue: draft ?? "")
    }

    private var names: [String: String] {
        var names = store.memberNames
        for agent in agents {
            if let name = agent.name { names[agent.userID] = name }
        }
        return names
    }

    private var ordered: [ChatMessage] {
        MessageLayout.chronological(replies)
    }

    var body: some View {
        let names = self.names
        let rows = ordered
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    if let parent {
                        // The thread link belongs to the channel, not here.
                        MessageRow(message: threadRoot(parent), compact: false, names: names, selfID: person.id, interactive: false, actions: actions)
                        if !rows.isEmpty {
                            HStack(spacing: Tokens.Spacing.s) {
                                VStack { Divider() }
                                Text(ChatStrings.channelReplyCount(rows.count))
                                    .font(.inter(.caption, weight: .semibold))
                                    .foregroundStyle(.secondary)
                                VStack { Divider() }
                            }
                            .padding(.horizontal, Tokens.Spacing.l)
                            .padding(.vertical, Tokens.Spacing.s)
                        }
                    } else if loading {
                        ProgressView().frame(maxWidth: .infinity).padding(.vertical, 48)
                    } else if let loadError {
                        LoadErrorView(error: loadError) { await load() }
                    }
                    ForEach(Array(rows.enumerated()), id: \.element.id) { index, reply in
                        MessageRow(
                            message: reply,
                            compact: MessageLayout.isCompact(reply, previous: index > 0 ? rows[index - 1] : nil),
                            names: names,
                            selfID: person.id,
                            interactive: false,
                            actions: actions
                        )
                        .id(reply.id)
                    }
                    Color.clear.frame(height: 1).id(Self.bottomID)
                }
                .padding(.bottom, Tokens.Spacing.s)
            }
            .defaultScrollAnchor(.bottom)
            .scrollDismissesKeyboard(.interactively)
            .accessibilityIdentifier("thread-list")
            .onChange(of: rows.last?.id) { _, _ in
                withAnimation { proxy.scrollTo(Self.bottomID, anchor: .bottom) }
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) { composer }
        .navigationTitle(ChatStrings.threadTitle)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.hidden, for: .tabBar)
        .task { await load() }
        .refreshable { await load() }
        .fullScreenCover(item: $viewer) { state in ImageViewer(state: state) }
    }

    private var actions: MessageRowActions {
        var actions = MessageRowActions()
        actions.openImage = { url in
            let all = (parent.map { [$0] } ?? []) + replies
            viewer = ImageViewerState(images: ChannelRules.images(all), start: url)
        }
        actions.openProfile = { userID in navigator.open(.member(userID: userID)) }
        return actions
    }

    private func threadRoot(_ message: ChatMessage) -> ChatMessage {
        var root = message
        root.threadReplyCount = 0
        return root
    }

    private var composer: some View {
        let query = MentionText.mentionQuery(input)
        return VStack(spacing: Tokens.Spacing.s) {
            if let query {
                ChannelMentionPicker(
                    candidates: ChannelRules.mentionCandidates(query: query, agents: agents, people: store.roster)
                ) { candidate in
                    input = MentionText.insertMention(input, userID: candidate.userID)
                }
            }
            HStack(alignment: .bottom, spacing: Tokens.Spacing.s) {
                TextField(ChatStrings.threadReplyPlaceholder, text: $input, axis: .vertical)
                    .lineLimit(1...6)
                    .focused($focused)
                    .padding(.horizontal, Tokens.Spacing.m)
                    .padding(.vertical, 8)
                    .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 20))
                    .accessibilityIdentifier("thread-input")
                Button {
                    Task { await send() }
                } label: {
                    Group {
                        if sending {
                            ProgressView().tint(.white)
                        } else {
                            Image(systemName: "arrow.up").font(.system(size: 16, weight: .bold))
                        }
                    }
                    .frame(width: 36, height: 36)
                    .foregroundStyle(.white)
                    .background(canSend ? Tokens.Palette.primary : Color.secondary.opacity(0.4), in: Circle())
                }
                .buttonStyle(.plain)
                .disabled(!canSend)
                .accessibilityLabel(ChatStrings.composerSend)
                .accessibilityIdentifier("thread-send")
            }
            .padding(.horizontal, Tokens.Spacing.m)
        }
        .padding(.vertical, Tokens.Spacing.s)
        .background(.bar)
    }

    private var canSend: Bool {
        !sending && !input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// The parent by id (it may be older than the channel's first page) and its replies.
    private func load() async {
        do {
            let loadedParent = try await store.message(messageID)
            let page = try await store.messages(channelID: channelID, parentID: messageID, limit: 100)
            parent = loadedParent
            replies = page.items
            loadError = nil
        } catch {
            loadError = APIError.from(error)
        }
        loading = false
        await store.loadRosterIfNeeded()
        if agents.isEmpty, let members = try? await store.channelMembers(channelID) {
            agents = members.filter { $0.isAgent && $0.name != nil }
        }
    }

    /// Cleared at once; the text comes back when the send fails.
    private func send() async {
        let body = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !body.isEmpty, !sending else { return }
        sending = true
        input = ""
        defer { sending = false }
        do {
            _ = try await store.send(channelID: channelID, body: body, parentID: messageID)
            if let page = try? await store.messages(channelID: channelID, parentID: messageID, limit: 100) {
                replies = page.items
            }
        } catch {
            if input.isEmpty { input = body }
            toaster.show(ChatStrings.threadReplyFailed)
        }
    }
}
