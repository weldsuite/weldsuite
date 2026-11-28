import SwiftUI
import WeldCore
import WeldUI

/// A new channel, one thing per step as Slack does it on mobile: the name,
/// then public or private (and its category on Home), then, for a private
/// channel, who is in it. A public channel already includes everyone.
struct NewChannelView: View {
    let store: ChatStore
    let person: Person
    let workspace: WorkspaceRef
    let initialSectionID: String?

    @Environment(ChatNavigator.self) private var navigator
    @Environment(\.dismiss) private var dismiss

    @State private var step = 0
    @State private var name = ""
    @State private var isPrivate = false
    @State private var sectionID: String?
    @State private var query = ""
    @State private var selected: [String] = []
    @State private var creating = false
    @State private var error: String?
    @FocusState private var nameFocused: Bool

    init(store: ChatStore, person: Person, workspace: WorkspaceRef, initialSectionID: String?) {
        self.store = store
        self.person = person
        self.workspace = workspace
        self.initialSectionID = initialSectionID
        _sectionID = State(initialValue: initialSectionID)
    }

    var body: some View {
        NavigationStack {
            Group {
                switch step {
                case 0: nameStep
                case 1: visibilityStep
                default: peopleStep
                }
            }
            .animation(.easeInOut(duration: 0.25), value: step)
            .navigationTitle(NewChannelRules.title(step: step))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    if step == 0 {
                        Button(CoreStrings.commonCancel) { dismiss() }
                    } else {
                        Button {
                            go(to: step - 1)
                        } label: {
                            Label(ChatStrings.commonBack, systemImage: "chevron.left")
                        }
                        .disabled(creating)
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if creating {
                        ProgressView()
                    } else {
                        Button(NewChannelRules.primaryLabel(step: step, isPrivate: isPrivate, selectedCount: selected.count)) {
                            primary()
                        }
                        .fontWeight(.semibold)
                        .disabled(!NewChannelRules.canContinue(step: step, name: name, creating: creating))
                        .accessibilityIdentifier("new-channel-next")
                    }
                }
            }
        }
        .interactiveDismissDisabled(creating)
        .task {
            if store.sections.isEmpty { await store.loadHome() }
            await store.loadRosterIfNeeded()
        }
    }

    // MARK: Steps

    private var nameStep: some View {
        Form {
            Section {
                HStack(spacing: Tokens.Spacing.s) {
                    Image(systemName: isPrivate ? "lock" : "number").foregroundStyle(.secondary)
                    TextField(ChatStrings.newChannelNamePlaceholder, text: Binding(
                        get: { name },
                        set: { text in
                            name = ChannelNames.normalize(text)
                            error = nil
                        }
                    ))
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.next)
                    .focused($nameFocused)
                    .onSubmit { primary() }
                    .accessibilityIdentifier("new-channel-name")
                    Text(verbatim: "\(ChannelNames.maxLength - name.count)")
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.secondary)
                        .accessibilityLabel(ChatStrings.newChannelRemaining(count: ChannelNames.maxLength - name.count))
                }
            } header: {
                Text(ChatStrings.newChannelNameLabel)
            } footer: {
                if let error {
                    InlineError(text: error)
                } else {
                    Text(ChatStrings.newChannelNameHint)
                }
            }
        }
        .onAppear { nameFocused = true }
    }

    private var visibilityStep: some View {
        Form {
            Section {
                option(
                    symbol: "number",
                    title: ChatStrings.newChannelPublicTitle,
                    hint: ChatStrings.newChannelPublicHint(workspace: workspace.name.isEmpty ? ChatStrings.homeWorkspaceFallback : workspace.name),
                    selected: !isPrivate,
                    identifier: "new-channel-public"
                ) { isPrivate = false }
                option(
                    symbol: "lock",
                    title: ChatStrings.newChannelPrivateTitle,
                    hint: ChatStrings.newChannelPrivateHint,
                    selected: isPrivate,
                    identifier: "new-channel-private"
                ) { isPrivate = true }
            } header: {
                Text(ChatStrings.newChannelVisibilityLabel)
            } footer: {
                if step == 1, let error { InlineError(text: error) }
            }

            if !store.sections.isEmpty {
                Section {
                    FlowLayout(spacing: Tokens.Spacing.s) {
                        FilterChip(title: ChatStrings.newChannelNoCategory, selected: sectionID == nil) { sectionID = nil }
                            .accessibilityIdentifier("new-channel-category-none")
                        ForEach(store.sections) { section in
                            FilterChip(title: section.name, selected: sectionID == section.id) { sectionID = section.id }
                                .accessibilityIdentifier("new-channel-category-\(section.id)")
                        }
                    }
                    .padding(.vertical, 4)
                } header: {
                    Text(ChatStrings.newChannelCategoryLabel)
                } footer: {
                    Text(ChatStrings.newChannelCategoryHint)
                }
            }
        }
    }

    private var peopleStep: some View {
        let people = NewChannelRules.people(store.roster, selfID: person.id, query: query)
        let finalName = NewChannelRules.finalName(name)
        return List {
            Section {
                ChatSearchField(placeholder: ChatStrings.newChannelPeopleSearch, text: $query, identifier: "new-channel-people-search")
                    .listRowSeparator(.hidden)
                Text(ChatStrings.newChannelPeopleHint(name: finalName.isEmpty ? ChatStrings.newChannelNamePlaceholder : finalName))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .listRowSeparator(.hidden)
                if let error { InlineError(text: error).listRowSeparator(.hidden) }
            }
            if store.roster.isEmpty {
                ProgressView().frame(maxWidth: .infinity).listRowSeparator(.hidden)
            } else if people.isEmpty {
                Text(ChatStrings.newChannelNoPeople).foregroundStyle(.secondary).frame(maxWidth: .infinity).listRowSeparator(.hidden)
            } else {
                ForEach(people) { member in
                    Button {
                        guard !creating else { return }
                        selected = NewDmRules.toggled(selected, member.userID)
                    } label: {
                        PickPersonRow(
                            name: member.displayName,
                            email: member.name != nil ? member.email : nil,
                            picture: member.picture,
                            selected: selected.contains(member.userID)
                        )
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("person-row-\(member.userID)")
                }
            }
        }
        .listStyle(.plain)
        .scrollDismissesKeyboard(.interactively)
    }

    private func option(symbol: String, title: String, hint: String, selected: Bool, identifier: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: Tokens.Spacing.m) {
                Image(systemName: symbol).frame(width: 24)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(.body.weight(.semibold)).foregroundStyle(Color.primary)
                    Text(hint).font(.footnote).foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
                Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                    .font(.title3)
                    .foregroundStyle(selected ? Tokens.Brand.weldchat : Color.secondary)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityIdentifier(identifier)
    }

    // MARK: Actions

    private func go(to next: Int) {
        error = nil
        step = max(0, next)
    }

    private func primary() {
        guard NewChannelRules.canContinue(step: step, name: name, creating: creating) else { return }
        if step < NewChannelRules.lastStep(isPrivate: isPrivate) {
            go(to: step + 1)
        } else {
            Task { await create() }
        }
    }

    private func create() async {
        let finalName = NewChannelRules.finalName(name)
        guard !finalName.isEmpty, !creating else { return }
        creating = true
        error = nil
        do {
            let id = try await store.createChannel(
                name: finalName,
                isPrivate: isPrivate,
                sectionID: sectionID,
                memberIDs: isPrivate ? selected : []
            )
            await store.loadHome()
            navigator.finishSheet(opening: .channel(ChannelRoute(channelID: id, name: finalName, type: isPrivate ? "private" : "public")))
        } catch {
            creating = false
            if NewChannelRules.isNameTaken(error) {
                // The name is what has to change: back to it.
                step = 0
                self.error = ChatStrings.newChannelNameTaken
            } else {
                self.error = ChatStrings.newChannelCreateFailed
            }
        }
    }
}
