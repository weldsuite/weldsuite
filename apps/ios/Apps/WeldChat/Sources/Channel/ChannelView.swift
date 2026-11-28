import SwiftUI
import UIKit
import WeldCore
import WeldUI

/// A sheet over a conversation: a held message's actions, the full
/// reaction list, or the pin steps.
private enum MessageSheet: Identifiable {
    case actions(ChatMessage)
    case reactions(ChatMessage)
    case pin(ChatMessage)

    var id: String {
        switch self {
        case let .actions(message): "actions-\(message.id)"
        case let .reactions(message): "reactions-\(message.id)"
        case let .pin(message): "pin-\(message.id)"
        }
    }
}

/// Where the message list should scroll to next.
private struct ScrollTarget: Equatable {
    let id: String
    let anchor: UnitPoint
    let animated: Bool
    let nonce = UUID()
}

/// A channel, a DM or a record chat (port of the Expo `ChannelView`): the
/// header (who or what, calls, follow), the pinned bar, the messages
/// newest at the bottom with older pages as you scroll up, and the composer.
/// Hold a message for its actions, drag it right to reply.
struct ChannelView: View {
    let env: AppEnvironment
    let store: ChatStore
    let person: Person
    let route: ChannelRoute

    @State private var model: ChannelModel
    @Environment(CallManager.self) private var calls
    @Environment(ChatNavigator.self) private var navigator
    @Environment(Toaster.self) private var toaster
    @Environment(\.dismiss) private var dismiss
    @FocusState private var composerFocused: Bool

    @State private var sheet: MessageSheet?
    @State private var viewer: ImageViewerState?
    @State private var deleteTarget: ChatMessage?
    @State private var unpinTarget: ChatMessage?
    @State private var flashID: String?
    @State private var flashTask: Task<Void, Never>?
    @State private var atBottom = true
    @State private var scrollTarget: ScrollTarget?
    @State private var micDenied = false
    @State private var callFailed = false

    private static let bottomID = "channel-bottom"

    init(env: AppEnvironment, store: ChatStore, person: Person, route: ChannelRoute) {
        self.env = env
        self.store = store
        self.person = person
        self.route = route
        _model = State(initialValue: ChannelModel(channelID: route.channelID, store: store, env: env, person: person))
    }

    // MARK: Derived

    private var kind: ConversationKind {
        ConversationKind(type: model.channel?.type ?? route.type)
    }

    private var name: String {
        ChannelRules.displayName(channel: model.channel, routeName: route.name)
    }

    private var entityType: String? {
        model.channel?.entityType ?? route.entityType
    }

    private var peerUserID: String? {
        guard kind == .dm else { return nil }
        return ChannelRules.peerUserID(dm: model.dm, name: name, roster: store.roster)
    }

    private var activeCall: ActiveChannelCall? {
        calls.activeChannelCalls[route.channelID]
    }

    private var joinable: ActiveChannelCall? {
        ChannelRules.joinableCall(active: activeCall, inCallID: calls.inCallID)
    }

    private var candidates: [MentionCandidate] {
        guard let query = model.mentionQuery else { return [] }
        return ChannelRules.mentionCandidates(query: query, agents: model.agents, people: store.roster)
    }

    // MARK: Body

    var body: some View {
        let timeline = model.timeline
        let names = model.names
        let pinned = model.pinned
        VStack(spacing: 0) {
            if !pinned.isEmpty {
                let position = ChatLogic.pinnedPosition(index: model.pinnedIndex, count: pinned.count)
                pinnedBar(pinned[position], position: position, count: pinned.count, names: names, rows: timeline.rows)
            }
            messageList(timeline: timeline, names: names)
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            ChannelComposer(
                model: model,
                kind: kind,
                name: name,
                candidates: candidates,
                isArchived: model.channel?.isArchived == true,
                focus: $composerFocused,
                onSend: send,
                onStartRecording: startRecording,
                onSendVoice: sendVoice,
                onContinueInThread: continueInThread,
                onUnarchive: unarchive
            )
        }
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.hidden, for: .tabBar)
        .toolbar {
            ToolbarItem(placement: .principal) { identity }
            ToolbarItemGroup(placement: .topBarTrailing) { trailingActions }
        }
        .task {
            await model.start()
            await store.loadRosterIfNeeded()
            await calls.refreshActiveCall(channelID: route.channelID)
        }
        .onDisappear { model.stop() }
        .sheet(item: $sheet) { item in sheetView(item, names: names) }
        .fullScreenCover(item: $viewer) { state in ImageViewer(state: state) }
        .alert(
            ChatStrings.channelDeleteMessageTitle,
            isPresented: Binding(get: { deleteTarget != nil }, set: { if !$0 { deleteTarget = nil } }),
            presenting: deleteTarget
        ) { message in
            Button(CoreStrings.commonDelete, role: .destructive) { delete(message) }
            Button(CoreStrings.commonCancel, role: .cancel) {}
        } message: { _ in
            Text(ChatStrings.channelDeleteMessageBody)
        }
        .alert(
            ChatStrings.channelUnpinTitle,
            isPresented: Binding(get: { unpinTarget != nil }, set: { if !$0 { unpinTarget = nil } }),
            presenting: unpinTarget
        ) { message in
            Button(ChatStrings.channelUnpin, role: .destructive) {
                Task { await model.unpin(message) }
            }
            Button(CoreStrings.commonCancel, role: .cancel) {}
        } message: { _ in
            Text(ChatStrings.channelUnpinBody)
        }
        .alert(ChatStrings.composerMicPermissionTitle, isPresented: $micDenied) {
            Button(CoreStrings.commonCancel, role: .cancel) {}
            Button(ChatStrings.composerOpenSettings) {
                if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
            }
        } message: {
            Text(ChatStrings.composerMicPermissionBody)
        }
        .alert(ChatStrings.channelCallFailedTitle, isPresented: $callFailed) {
            Button(CoreStrings.commonClose, role: .cancel) {}
        } message: {
            Text(ChatStrings.channelCallFailedBody)
        }
    }

    // MARK: Messages

    private func messageList(timeline: (rows: [ChatMessage], calls: [String: CallLogEntry], openCallID: String?), names: [String: String]) -> some View {
        let rows = timeline.rows
        return ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    if model.hasOlder {
                        ProgressView()
                            .frame(maxWidth: .infinity)
                            .padding(Tokens.Spacing.m)
                            // A new identity after every page, so a spinner
                            // still on screen asks for the next one.
                            .id("older-\(rows.first?.id ?? "")")
                            .onAppear { loadOlder(anchorID: rows.first?.id) }
                    }
                    if rows.isEmpty {
                        emptyState
                    }
                    ForEach(Array(rows.enumerated()), id: \.element.id) { index, message in
                        row(message, previous: index > 0 ? rows[index - 1] : nil, timeline: timeline, names: names)
                    }
                    Color.clear
                        .frame(height: 1)
                        .id(Self.bottomID)
                        .onAppear { atBottom = true }
                        .onDisappear { atBottom = false }
                }
                .padding(.bottom, Tokens.Spacing.s)
            }
            .defaultScrollAnchor(.bottom)
            .scrollDismissesKeyboard(.interactively)
            .accessibilityIdentifier("message-list")
            .overlay(alignment: .bottomTrailing) {
                if !atBottom, !rows.isEmpty {
                    Button {
                        scrollToBottom(animated: true)
                    } label: {
                        Image(systemName: "chevron.down")
                            .font(.system(size: 16, weight: .bold))
                            .frame(width: 40, height: 40)
                            .background(.regularMaterial, in: Circle())
                            .shadow(radius: 2, y: 1)
                    }
                    .buttonStyle(.plain)
                    .padding(Tokens.Spacing.m)
                    .accessibilityLabel(ChatStrings.channelScrollToLatest)
                    .accessibilityIdentifier("scroll-to-latest")
                }
            }
            .onChange(of: scrollTarget) { _, target in
                guard let target else { return }
                if target.animated {
                    withAnimation { proxy.scrollTo(target.id, anchor: target.anchor) }
                } else {
                    proxy.scrollTo(target.id, anchor: target.anchor)
                }
            }
            .onChange(of: model.loading) { _, loading in
                if !loading { scrollToBottom(animated: false) }
            }
            .onChange(of: rows.last?.id) { _, _ in
                // A new message: follow it when at the bottom, or when it's your own send.
                if atBottom || rows.last?.pending == true { scrollToBottom(animated: true) }
            }
        }
    }

    @ViewBuilder
    private func row(
        _ message: ChatMessage,
        previous: ChatMessage?,
        timeline: (rows: [ChatMessage], calls: [String: CallLogEntry], openCallID: String?),
        names: [String: String]
    ) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            if MessageLayout.startsNewDay(message, previous: previous), let date = message.date {
                DateSeparator(date: date)
            }
            if message.isSystem {
                if let entry = timeline.calls[message.id] {
                    let ongoing = entry.outcome == nil && timeline.openCallID == message.id && activeCall != nil
                    CallLogCard(
                        entry: entry,
                        ongoing: ongoing,
                        joinable: ongoing && joinable != nil,
                        createdAt: message.createdAt
                    ) {
                        startOrJoinCall(entry.isVideo ? .video : .voice)
                    }
                } else {
                    SystemMessageRow(text: MentionText.plainText(message.content, names: names))
                }
            } else {
                MessageRow(
                    message: message,
                    compact: MessageLayout.isCompact(message, previous: previous),
                    names: names,
                    selfID: person.id,
                    highlighted: model.replyTo?.messageID == message.id || flashID == message.id,
                    actions: rowActions
                )
            }
        }
        .id(message.id)
    }

    private var rowActions: MessageRowActions {
        var actions = MessageRowActions()
        actions.openActions = { message in
            composerFocused = false
            sheet = .actions(message)
        }
        actions.reply = { message in
            model.startReply(message)
            composerFocused = true
        }
        actions.toggleReaction = { message, emoji in react(message, emoji: emoji) }
        actions.openImage = { url in
            viewer = ImageViewerState(images: ChannelRules.images(model.messages), start: url)
        }
        actions.openProfile = { userID in
            composerFocused = false
            navigator.open(.member(userID: userID))
        }
        actions.openThread = { message in
            navigator.open(.thread(messageID: message.id, channelID: route.channelID, draft: nil))
        }
        actions.jumpTo = { id in jump(to: id) }
        return actions
    }

    private var emptyState: some View {
        VStack(spacing: Tokens.Spacing.s) {
            if model.loading || (model.channel == nil && name.isEmpty) {
                ProgressView()
            } else {
                Text(ChannelRules.welcome(kind: kind, name: name))
                    .font(.inter(.title3, weight: .bold))
                    .multilineTextAlignment(.center)
                Text(ChatStrings.channelStartOfConversation)
                    .font(.inter(.subheadline))
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, Tokens.Spacing.xl)
        .padding(.vertical, 48)
    }

    // MARK: Pinned bar

    private func pinnedBar(_ current: ChatMessage, position: Int, count: Int, names: [String: String], rows: [ChatMessage]) -> some View {
        HStack(spacing: Tokens.Spacing.m) {
            VStack(spacing: 2) {
                ForEach(0..<count, id: \.self) { index in
                    Capsule()
                        .fill(index == position ? Tokens.Palette.primary : Color.secondary.opacity(0.3))
                        .frame(width: 3)
                }
            }
            .frame(height: 32)
            Image(systemName: "pin.fill").font(.inter(.caption)).foregroundStyle(Tokens.Palette.primary)
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: Tokens.Spacing.s) {
                    Text(current.authorName).font(.inter(.caption, weight: .semibold)).lineLimit(1)
                    if count > 1 {
                        Text(ChatStrings.channelPinPosition(position: "\(position + 1)", count: count))
                            .font(.inter(.caption2))
                            .foregroundStyle(.secondary)
                    }
                }
                Text(MentionText.plainText(current.content, names: names))
                    .font(.inter(.subheadline))
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
            Button {
                unpinTarget = current
            } label: {
                Image(systemName: "xmark").font(.inter(.caption, weight: .bold)).foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(ChatStrings.channelUnpin)
            .accessibilityIdentifier("pinned-unpin")
        }
        .padding(.horizontal, Tokens.Spacing.l)
        .padding(.vertical, Tokens.Spacing.s)
        .background(.bar)
        .overlay(alignment: .bottom) { Divider() }
        .contentShape(Rectangle())
        .onTapGesture {
            if count > 1 { model.pinnedIndex += 1 }
            if rows.contains(where: { $0.id == current.id }) {
                scrollTarget = ScrollTarget(id: current.id, anchor: .center, animated: true)
            }
        }
        .accessibilityIdentifier("pinned-bar")
    }

    // MARK: Header

    /// The avatar or icon, the name and what it is; a tap opens the person,
    /// the channel's details, or a record chat's menu.
    @ViewBuilder
    private var identity: some View {
        switch kind {
        case .record:
            let app = model.channel?.entityID == nil ? nil : entityType.flatMap(RecordChatRules.app(for:))
            let following = model.following == true
            if app != nil || following {
                Menu {
                    if let app, let type = entityType, let id = model.channel?.entityID {
                        Button {
                            Task { await RecordOpener.open(type: type, entityID: id, store: store, toaster: toaster) }
                        } label: {
                            Label(ChatStrings.recordChatsOpenIn(app: app), systemImage: "arrow.up.forward.app")
                        }
                    }
                    if following {
                        Button {
                            toggleRecordMute()
                        } label: {
                            Label(
                                model.recordMuted ? ChatStrings.recordChatsUnmute : ChatStrings.recordChatsMute,
                                systemImage: model.recordMuted ? "bell" : "bell.slash"
                            )
                        }
                    }
                } label: {
                    identityLabel
                }
                .accessibilityIdentifier("channel-title")
            } else {
                identityLabel.accessibilityIdentifier("channel-title")
            }
        case .dm:
            Button {
                if let peer = peerUserID {
                    composerFocused = false
                    navigator.open(.member(userID: peer))
                }
            } label: {
                identityLabel
            }
            .buttonStyle(.plain)
            .disabled(peerUserID == nil)
            .accessibilityIdentifier("channel-title")
        case .channel, .privateChannel:
            Button {
                composerFocused = false
                navigator.open(.channelInfo(channelID: route.channelID, name: name))
            } label: {
                identityLabel
            }
            .buttonStyle(.plain)
            .disabled(model.channel == nil)
            .accessibilityLabel(name.isEmpty ? ChatStrings.channelChannelDetails : "\(name), \(ChatStrings.channelChannelDetails)")
            .accessibilityIdentifier("channel-title")
        }
    }

    private var identityLabel: some View {
        HStack(spacing: Tokens.Spacing.s) {
            headerIcon
            VStack(alignment: .leading, spacing: 0) {
                Text(name.isEmpty ? ChatStrings.channelLoadingTitle : name)
                    .font(.inter(.headline))
                    .foregroundStyle(Color.primary)
                    .lineLimit(1)
                if let subtitle = headerSubtitle {
                    Text(subtitle).font(.inter(.caption)).foregroundStyle(.secondary).lineLimit(1)
                }
            }
        }
    }

    @ViewBuilder
    private var headerIcon: some View {
        switch kind {
        case .dm:
            Group {
                if let dm = model.dm {
                    DmAvatar(dm: dm, size: 30)
                } else {
                    ChatAvatar(name: name, url: nil, size: 30)
                }
            }
            .overlay(alignment: .bottomTrailing) {
                if let peer = peerUserID, store.memberStatus(peer)?.uppercased() == "ACTIVE" {
                    Circle()
                        .fill(Tokens.Status.success)
                        .frame(width: 9, height: 9)
                        .overlay(Circle().stroke(Color(.systemBackground), lineWidth: 2))
                }
            }
        case .record:
            Image(systemName: RecordChatRules.symbol(entityType)).font(.system(size: 16, weight: .semibold))
        case .privateChannel:
            Image(systemName: "lock").font(.system(size: 16, weight: .semibold))
        case .channel:
            Image(systemName: "number").font(.system(size: 16, weight: .semibold))
        }
    }

    /// The DM person's presence, or a record chat's type.
    private var headerSubtitle: String? {
        switch kind {
        case .dm:
            guard let peer = peerUserID else { return nil }
            return ChannelRules.presenceSubtitle(status: store.memberStatus(peer))
        case .record:
            guard let type = entityType, RecordChatRules.isType(type) else { return nil }
            return RecordChatRules.typeLabel(type)
        case .channel, .privateChannel:
            return nil
        }
    }

    /// Follow (a record chat), and the call buttons or Join.
    private var trailingActions: some View {
        HStack(spacing: Tokens.Spacing.m) {
            if kind == .record, let following = model.following {
                Button {
                    toggleFollow()
                } label: {
                    Text(following ? ChatStrings.recordChatsFollowing : ChatStrings.recordChatsFollow)
                        .font(.inter(.subheadline, weight: .semibold))
                }
                .buttonStyle(.bordered)
                .tint(following ? Color.secondary : Tokens.Palette.primary)
                .controlSize(.small)
                .accessibilityAddTraits(following ? .isSelected : [])
                .accessibilityIdentifier("channel-follow")
            }
            // Calls need the server's video provider.
            if env.isAvailable("chat-calls") {
                if let join = joinable {
                    Button {
                        startOrJoinCall(join.callType)
                    } label: {
                        Label(ChatStrings.channelJoinCall, systemImage: join.callType == .video ? "video.fill" : "phone.fill")
                            .labelStyle(.titleAndIcon)
                            .font(.inter(.subheadline, weight: .semibold))
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(Tokens.Status.success)
                    .controlSize(.small)
                    .accessibilityLabel("\(ChatStrings.channelJoinCall): \(join.callType == .video ? ChatStrings.inCallVideoCall : ChatStrings.inCallVoiceCall)")
                    .accessibilityIdentifier("channel-join-call")
                } else {
                    Button {
                        startOrJoinCall(.video)
                    } label: {
                        Image(systemName: "video")
                    }
                    .disabled(calls.session != nil)
                    .accessibilityLabel(ChatStrings.channelStartVideoCall)
                    .accessibilityIdentifier("channel-call-video")
                    Button {
                        startOrJoinCall(.voice)
                    } label: {
                        Image(systemName: "phone")
                    }
                    .disabled(calls.session != nil)
                    .accessibilityLabel(ChatStrings.channelStartVoiceCall)
                    .accessibilityIdentifier("channel-call-voice")
                }
            }
        }
    }

    // MARK: Sheets

    @ViewBuilder
    private func sheetView(_ item: MessageSheet, names: [String: String]) -> some View {
        switch item {
        case let .actions(message):
            MessageActionsSheet(
                message: message,
                isOwn: message.authorID == person.id,
                onQuickReact: { emoji in
                    sheet = nil
                    react(message, emoji: emoji)
                },
                onMoreReactions: { sheet = .reactions(message) },
                onReply: {
                    sheet = nil
                    model.startReply(message)
                    focusComposerSoon()
                },
                onThread: {
                    afterSheet {
                        navigator.open(.thread(messageID: message.id, channelID: route.channelID, draft: nil))
                    }
                },
                onCopy: {
                    sheet = nil
                    UIPasteboard.general.string = ChannelRules.copyText(message, names: names)
                    UINotificationFeedbackGenerator().notificationOccurred(.success)
                    toaster.show(ChatStrings.channelCopied)
                },
                onPin: { pinTapped(message) },
                onSave: {
                    sheet = nil
                    save(message)
                },
                onEdit: {
                    sheet = nil
                    model.startEdit(message)
                    focusComposerSoon()
                },
                onDelete: {
                    afterSheet { deleteTarget = message }
                }
            )
        case let .reactions(message):
            ReactionPickerSheet { emoji in
                sheet = nil
                react(message, emoji: emoji)
            }
        case let .pin(message):
            PinMessageSheet { duration, notify in
                sheet = nil
                Task {
                    if !(await model.pin(message, duration: duration, notify: notify)) {
                        toaster.show(ChatStrings.channelPinFailed)
                    }
                }
            }
        }
    }

    /// Close the sheet, then act once it is down (an alert or a push
    /// started while a sheet is still leaving can be dropped).
    private func afterSheet(_ action: @escaping @MainActor () -> Void) {
        sheet = nil
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(400))
            action()
        }
    }

    private func focusComposerSoon() {
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(400))
            composerFocused = true
        }
    }

    // MARK: Actions

    private func scrollToBottom(animated: Bool) {
        scrollTarget = ScrollTarget(id: Self.bottomID, anchor: .bottom, animated: animated)
    }

    private func loadOlder(anchorID: String?) {
        Task {
            await model.loadOlder()
            // Keep the message that was on top where it was.
            if let anchorID { scrollTarget = ScrollTarget(id: anchorID, anchor: .top, animated: false) }
        }
    }

    /// Scroll to a reply's original and tint it for a moment; say so when it isn't loaded.
    private func jump(to id: String) {
        guard model.timeline.rows.contains(where: { $0.id == id }) else {
            toaster.show(ChatStrings.channelOriginalFurtherBack)
            return
        }
        scrollTarget = ScrollTarget(id: id, anchor: .center, animated: true)
        flashID = id
        flashTask?.cancel()
        flashTask = Task { @MainActor in
            try? await Task.sleep(for: ChannelRules.jumpFlash)
            guard !Task.isCancelled else { return }
            flashID = nil
        }
    }

    private func send() {
        Task {
            switch await model.send() {
            case .sent, .edited:
                break
            case .aiUnavailable:
                toaster.show(ChatStrings.channelAiUnavailable)
            case .failed:
                toaster.show(ChatStrings.channelSendFailed)
            case .editFailed:
                toaster.show(ChatStrings.channelEditFailed)
            }
        }
    }

    private func startRecording() {
        composerFocused = false
        Task {
            switch await model.recorder.start() {
            case .started:
                UIImpactFeedbackGenerator(style: .medium).impactOccurred()
            case .denied:
                micDenied = true
            case .failed:
                toaster.show(ChatStrings.composerRecordFailed)
            }
        }
    }

    private func sendVoice() {
        Task {
            switch await model.sendVoice() {
            case .sent:
                UINotificationFeedbackGenerator().notificationOccurred(.success)
                scrollToBottom(animated: true)
            case .tooShort:
                toaster.show(ChatStrings.composerVoiceTooShort)
            case .failed:
                toaster.show(ChatStrings.composerVoiceSendFailed)
            }
        }
    }

    private func continueInThread() {
        guard let next = model.continueInThread() else { return }
        composerFocused = false
        navigator.open(.thread(messageID: next.rootID, channelID: route.channelID, draft: next.draft))
    }

    private func unarchive() {
        Task {
            if await model.unarchive() {
                await store.loadDmList()
                dismiss()
            }
        }
    }

    private func react(_ message: ChatMessage, emoji: String) {
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        Task {
            if !(await model.toggleReaction(message, emoji: emoji)) {
                toaster.show(ChatStrings.channelReactionFailed)
            }
        }
    }

    /// Unpin at once; a new pin asks for how long first, unless three are pinned.
    private func pinTapped(_ message: ChatMessage) {
        if message.isPinned {
            sheet = nil
            Task { await model.unpin(message) }
        } else if !ChannelRules.canPin(pinnedCount: model.pinned.count) {
            sheet = nil
            toaster.show(ChatStrings.channelPinLimit)
        } else {
            sheet = .pin(message)
        }
    }

    private func save(_ message: ChatMessage) {
        Task {
            do {
                let already = try await store.bookmark(messageID: message.id, channelID: route.channelID)
                toaster.show(already ? ChatStrings.channelAlreadySaved : ChatStrings.channelSavedForLater)
            } catch {
                toaster.show(ChatStrings.channelSaveMessageFailed)
            }
        }
    }

    private func delete(_ message: ChatMessage) {
        Task {
            if !(await model.delete(message)) {
                toaster.show(ChatStrings.channelDeleteFailed)
            }
        }
    }

    /// Join the call running here, or start one (the server's start-and-join
    /// joins a running one too).
    private func startOrJoinCall(_ type: CallType) {
        composerFocused = false
        let peer = ChannelRules.callPeer(kind: kind, name: name, picture: model.dm?.picture)
        let running = activeCall
        let channelID = route.channelID
        Task {
            do {
                if let running {
                    try await calls.joinCall(callID: running.callID, peer: peer)
                } else {
                    try await calls.startCall(channelID: channelID, callType: type, peer: peer)
                }
            } catch {
                callFailed = true
            }
        }
    }

    private func toggleFollow() {
        let wasFollowing = model.following == true
        Task {
            if await model.toggleFollow() {
                store.refreshRecordChats(.all)
            } else {
                toaster.show(wasFollowing ? ChatStrings.recordChatsUnfollowFailed : ChatStrings.recordChatsFollowFailed)
            }
        }
    }

    private func toggleRecordMute() {
        Task {
            if !(await model.toggleRecordMute()) {
                toaster.show(ChatStrings.recordChatsMuteFailed)
            }
        }
    }
}

/// A server notice in the conversation ("Ann pinned a message").
struct SystemMessageRow: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.inter(.caption))
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.center)
            .frame(maxWidth: .infinity)
            .padding(.horizontal, Tokens.Spacing.xl)
            .padding(.vertical, Tokens.Spacing.s)
    }
}
