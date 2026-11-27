import SwiftUI
import WeldCore
import WeldUI

/// A new direct message: pick one person (or, for a group, at least two)
/// and start. The server reuses a conversation with the same people.
struct NewDmView: View {
    let store: ChatStore
    let person: Person
    let isGroup: Bool

    @Environment(ChatNavigator.self) private var navigator
    @Environment(\.dismiss) private var dismiss

    @State private var search = ""
    @State private var selected: [String] = []
    @State private var creating = false
    @State private var loaded = false
    @State private var error: String?

    var body: some View {
        let people = NewDmRules.people(store.roster, selfID: person.id, query: search)
        NavigationStack {
            List {
                Section {
                    ChatSearchField(placeholder: ChatStrings.invitePeopleSearch, text: $search, identifier: "new-dm-search")
                        .listRowSeparator(.hidden)
                    if let error { InlineError(text: error).listRowSeparator(.hidden) }
                }
                if !loaded, store.roster.isEmpty {
                    ProgressView().frame(maxWidth: .infinity).listRowSeparator(.hidden)
                } else if people.isEmpty {
                    Text(search.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? ChatStrings.dmsNoOtherMembers : ChatStrings.invitePeopleNoMatch)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity)
                        .listRowSeparator(.hidden)
                } else {
                    ForEach(people) { member in
                        Button {
                            guard !creating else { return }
                            selected = NewDmRules.toggled(selected, member.userID)
                        } label: {
                            PickPersonRow(name: member.displayName, picture: member.picture, selected: selected.contains(member.userID))
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("person-row-\(member.userID)")
                    }
                }
            }
            .listStyle(.plain)
            .scrollDismissesKeyboard(.interactively)
            .navigationTitle(isGroup ? ChatStrings.dmsNewGroup : ChatStrings.newMessageTitle)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(CoreStrings.commonCancel) { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if creating {
                        ProgressView()
                    } else {
                        Button(NewDmRules.startLabel(selectedCount: selected.count)) { Task { await start() } }
                            .fontWeight(.semibold)
                            .disabled(selected.count < NewDmRules.minimum(isGroup: isGroup))
                            .accessibilityIdentifier("new-dm-start")
                    }
                }
            }
        }
        .interactiveDismissDisabled(creating)
        .task {
            await store.loadRosterIfNeeded()
            loaded = true
        }
    }

    private func start() async {
        guard !creating, selected.count >= NewDmRules.minimum(isGroup: isGroup) else { return }
        creating = true
        error = nil
        do {
            let dm = try await store.createDm(userIDs: selected)
            await store.loadDmList()
            navigator.finishSheet(opening: .channel(ChannelRoute(channelID: dm.id, name: dm.name, type: "dm")))
        } catch {
            self.error = apiErrorMessage(APIError.from(error))
            creating = false
        }
    }
}
