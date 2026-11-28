import SwiftUI
import WeldCore
import WeldUI

/// Invite people to a channel (from its long-press menu): the workspace's
/// people who aren't in it yet, pick one or more, Add.
struct InvitePeopleView: View {
    let store: ChatStore
    let channelID: String
    let name: String

    @Environment(Toaster.self) private var toaster
    @Environment(\.dismiss) private var dismiss

    @State private var memberIDs: Set<String> = []
    @State private var loading = true
    @State private var search = ""
    @State private var selected: [String] = []
    @State private var adding = false

    var body: some View {
        NavigationStack {
            let people = ChannelRules.invitable(roster: store.roster, memberIDs: memberIDs, search: search)
            List {
                if loading {
                    ProgressView().frame(maxWidth: .infinity).listRowSeparator(.hidden)
                } else if people.isEmpty {
                    Text(search.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? ChatStrings.invitePeopleEveryoneIn : ChatStrings.invitePeopleNoMatch)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity)
                        .listRowSeparator(.hidden)
                } else {
                    ForEach(people) { member in
                        let isSelected = selected.contains(member.userID)
                        Button {
                            toggle(member.userID)
                        } label: {
                            HStack(spacing: Tokens.Spacing.m) {
                                ChatAvatar(name: member.displayName, url: member.picture, size: 36)
                                Text(member.displayName).lineLimit(1).foregroundStyle(Color.primary)
                                Spacer()
                                Image(systemName: isSelected ? "checkmark.circle.fill" : "circle")
                                    .font(.inter(.title3))
                                    .foregroundStyle(isSelected ? Tokens.Palette.primary : Color.secondary)
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityAddTraits(isSelected ? .isSelected : [])
                        .accessibilityIdentifier("person-row-\(member.userID)")
                    }
                }
            }
            .listStyle(.plain)
            .searchable(text: $search, placement: .navigationBarDrawer(displayMode: .always), prompt: ChatStrings.invitePeopleSearch)
            .navigationTitle(ChatStrings.invitePeopleTitle)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(CoreStrings.commonCancel) { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if adding {
                        ProgressView()
                    } else {
                        Button(selected.count > 1 ? ChatStrings.invitePeopleAddWithCount(count: selected.count) : ChatStrings.invitePeopleAdd) {
                            Task { await add() }
                        }
                        .disabled(selected.isEmpty)
                        .accessibilityIdentifier("invite-add")
                    }
                }
            }
        }
        .task { await load() }
    }

    private func toggle(_ userID: String) {
        guard !adding else { return }
        if let index = selected.firstIndex(of: userID) {
            selected.remove(at: index)
        } else {
            selected.append(userID)
        }
    }

    /// Everyone in the workspace, minus who is already in the channel.
    private func load() async {
        await store.loadRosterIfNeeded()
        if let members = try? await store.channelMembers(channelID) {
            memberIDs = Set(members.map(\.userID))
        }
        loading = false
    }

    private func add() async {
        guard !adding, !selected.isEmpty else { return }
        adding = true
        do {
            try await store.addMembers(channelID, userIDs: selected)
            toaster.show(ChatStrings.invitePeopleAdded(selected.count))
            dismiss()
        } catch {
            toaster.show(ChatStrings.invitePeopleFailed)
            adding = false
        }
    }
}
