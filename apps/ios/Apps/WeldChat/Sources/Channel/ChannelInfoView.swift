import SwiftUI
import WeldCore
import WeldUI

/// A channel's details: its icon and name (renamed in place by an owner or
/// admin), public or private, the description, how many members, and
/// leave or delete.
struct ChannelInfoView: View {
    let store: ChatStore
    let person: Person
    let channelID: String
    let initialName: String

    @Environment(ChatNavigator.self) private var navigator
    @Environment(Toaster.self) private var toaster
    @FocusState private var renameFocused: Bool

    @State private var channel: ChatChannel? = nil
    @State private var loading = true
    @State private var renaming = false
    @State private var draftName = ""
    @State private var busy: Busy? = nil
    @State private var confirmLeave = false
    @State private var confirmDelete = false

    private enum Busy { case rename, leave, delete }

    var body: some View {
        Group {
            if let channel {
                content(channel)
            } else if loading {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ContentUnavailableView {
                    Label(CoreStrings.errorsLoadFailed, systemImage: "exclamationmark.triangle")
                } description: {
                    Text(ChatStrings.channelInfoLoadFailed)
                } actions: {
                    Button(CoreStrings.commonTryAgain) { Task { await load() } }
                        .accessibilityIdentifier("retry")
                }
            }
        }
        .navigationTitle(ChatStrings.channelInfoTitle)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.hidden, for: .tabBar)
        .task { await load() }
        .alert(ChatStrings.channelInfoLeaveTitle(name: displayName), isPresented: $confirmLeave) {
            Button(CoreStrings.commonCancel, role: .cancel) {}
            Button(ChatStrings.channelInfoLeave, role: .destructive) { Task { await leave() } }
        } message: {
            Text(ChatStrings.channelInfoLeaveBody)
        }
        .alert(ChatStrings.channelInfoDeleteTitle(name: displayName), isPresented: $confirmDelete) {
            Button(CoreStrings.commonCancel, role: .cancel) {}
            Button(ChatStrings.channelInfoDelete, role: .destructive) { Task { await remove() } }
        } message: {
            Text(ChatStrings.channelInfoDeleteBody)
        }
    }

    private var displayName: String {
        channel?.name ?? initialName
    }

    private func content(_ channel: ChatChannel) -> some View {
        let permissions = ChannelRules.permissions(members: channel.members, userID: person.id)
        let description = [channel.description, channel.topic].compactMap { $0 }.first { !$0.isEmpty }
        return List {
            Section {
                VStack(spacing: Tokens.Spacing.s) {
                    Image(systemName: channel.isPrivate ? "lock" : "number")
                        .font(.system(size: 28, weight: .semibold))
                        .frame(width: 64, height: 64)
                        .background(Color(.tertiarySystemBackground), in: RoundedRectangle(cornerRadius: Tokens.Radius.large))
                    if renaming {
                        renameRow(channel)
                    } else {
                        Text("#\(displayName)")
                            .font(.title2.weight(.bold))
                            .multilineTextAlignment(.center)
                            .lineLimit(2)
                    }
                    Text(channel.isPrivate ? ChatStrings.channelInfoPrivateChannel : ChatStrings.channelInfoPublicChannel)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity)
                .listRowBackground(Color.clear)
            }

            Section(ChatStrings.channelInfoDescription) {
                Text(description ?? ChatStrings.channelInfoNoDescription)
                    .foregroundStyle(description == nil ? Color.secondary : Color.primary)
            }

            Section(ChatStrings.channelInfoMembers) {
                Label(ChatStrings.channelInfoMemberCount(channel.memberCount ?? channel.members.count), systemImage: "person.2")
            }

            if permissions.showActions {
                Section {
                    if permissions.canManage {
                        Button {
                            draftName = channel.name
                            renaming = true
                            renameFocused = true
                        } label: {
                            Label(ChatStrings.channelInfoRename, systemImage: "pencil").foregroundStyle(Color.primary)
                        }
                        .disabled(busy != nil)
                        .accessibilityIdentifier("channel-info-rename")
                    }
                    if permissions.canLeave {
                        Button(role: .destructive) {
                            confirmLeave = true
                        } label: {
                            HStack {
                                Label(ChatStrings.channelInfoLeave, systemImage: "rectangle.portrait.and.arrow.right")
                                if busy == .leave {
                                    Spacer()
                                    ProgressView()
                                }
                            }
                        }
                        .disabled(busy != nil)
                        .accessibilityIdentifier("channel-info-leave")
                    }
                    if permissions.canManage {
                        Button(role: .destructive) {
                            confirmDelete = true
                        } label: {
                            HStack {
                                Label(ChatStrings.channelInfoDelete, systemImage: "trash")
                                if busy == .delete {
                                    Spacer()
                                    ProgressView()
                                }
                            }
                        }
                        .disabled(busy != nil)
                        .accessibilityIdentifier("channel-info-delete")
                    }
                } header: {
                    Text(ChatStrings.channelInfoActions)
                } footer: {
                    if permissions.isOwner {
                        Text(ChatStrings.channelInfoOwnerCannotLeave)
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
    }

    /// The name, lower case with dashes as it is typed, saved with ✓.
    private func renameRow(_ channel: ChatChannel) -> some View {
        let canSave = !ChannelNames.trimDashes(draftName).isEmpty
        return HStack(spacing: Tokens.Spacing.s) {
            Image(systemName: "number").foregroundStyle(.secondary)
            TextField(ChatStrings.channelInfoRenamePlaceholder, text: $draftName)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.done)
                .focused($renameFocused)
                .onSubmit { Task { await submitRename(channel) } }
                .onChange(of: draftName) { _, text in
                    let normalized = ChannelNames.normalize(text)
                    if normalized != text { draftName = normalized }
                }
                .accessibilityLabel(ChatStrings.channelInfoRenameLabel)
                .accessibilityIdentifier("channel-info-rename-input")
            if busy == .rename {
                ProgressView()
            } else {
                Button {
                    Task { await submitRename(channel) }
                } label: {
                    Image(systemName: "checkmark").foregroundStyle(canSave ? Tokens.Brand.weldchat : Color.secondary)
                }
                .buttonStyle(.plain)
                .disabled(!canSave)
                .accessibilityLabel(CoreStrings.commonSave)
                .accessibilityIdentifier("channel-info-rename-save")
                Button {
                    renaming = false
                } label: {
                    Image(systemName: "xmark").foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(CoreStrings.commonCancel)
            }
        }
        .padding(Tokens.Spacing.s)
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: Tokens.Radius.medium))
    }

    // MARK: Actions

    private func load() async {
        loading = true
        do {
            channel = try await store.channel(channelID)
        } catch {
            // The retry screen shows.
        }
        loading = false
    }

    private func submitRename(_ current: ChatChannel) async {
        let next = ChannelNames.trimDashes(draftName)
        guard busy == nil, !next.isEmpty else { return }
        guard next != current.name else {
            renaming = false
            return
        }
        busy = .rename
        defer { busy = nil }
        do {
            try await store.renameChannel(current.id, name: next)
            channel?.name = next
            renaming = false
            toaster.show(ChatStrings.channelInfoRenamed)
            await store.loadHome()
        } catch {
            let status = (error as? APIError)?.status
            toaster.show(status == 409 ? ChatStrings.channelInfoRenameTaken : ChatStrings.channelInfoRenameFailed)
        }
    }

    private func leave() async {
        let name = displayName
        busy = .leave
        do {
            try await store.leaveChannel(channelID)
            toaster.show(ChatStrings.channelInfoLeft(name: name))
            navigator.popToRoot()
            await store.loadHome()
        } catch {
            toaster.show(ChatStrings.channelInfoLeaveFailed)
        }
        busy = nil
    }

    private func remove() async {
        busy = .delete
        do {
            try await store.deleteChannel(channelID)
            toaster.show(ChatStrings.channelInfoDeleted)
            navigator.popToRoot()
            await store.loadHome()
        } catch {
            toaster.show(ChatStrings.channelInfoDeleteFailed)
        }
        busy = nil
    }
}
