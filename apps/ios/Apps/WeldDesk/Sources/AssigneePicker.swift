import SwiftUI
import WeldCore
import WeldUI

/// Who to assign the conversation to: "Unassign" on top when it is
/// assigned, then the team, searchable. The roster loads the first time it opens.
struct AssigneePicker: View {
    let model: ConversationModel
    /// Nil unassigns.
    let onSelect: (String?) -> Void
    @State private var search = ""
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                if let assignee = model.detail?.conversation.assigneeID, !assignee.isEmpty {
                    Button {
                        onSelect(nil)
                    } label: {
                        Label(DeskStrings.conversationUnassign, systemImage: "person.badge.minus")
                    }
                    .accessibilityIdentifier("assignee-unassign")
                }
                content
            }
            .listStyle(.plain)
            .searchable(text: $search, placement: .navigationBarDrawer(displayMode: .always), prompt: DeskStrings.conversationSearchMembers)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .navigationTitle(DeskStrings.conversationAssignTitle)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(CoreStrings.commonClose) { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .task {
            if model.members == nil { await model.loadMembers() }
        }
    }

    @ViewBuilder
    private var content: some View {
        if let members = model.members {
            let visible = DeskLogic.filterMembers(members, search: search)
            if visible.isEmpty {
                Text(DeskStrings.conversationNoMembers)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity)
                    .listRowSeparator(.hidden)
            } else {
                ForEach(visible) { member in
                    Button {
                        onSelect(member.userID)
                    } label: {
                        MemberRow(member: member, isMe: member.userID == model.userID, selected: member.userID == model.detail?.conversation.assigneeID)
                    }
                    .accessibilityIdentifier("assignee-\(member.userID)")
                }
            }
        } else if model.membersFailed {
            VStack(spacing: Tokens.Spacing.s) {
                Text(DeskStrings.conversationMembersError).foregroundStyle(.secondary).multilineTextAlignment(.center)
                Button(CoreStrings.commonTryAgain) { Task { await model.loadMembers(force: true) } }
                    .accessibilityIdentifier("retry")
            }
            .frame(maxWidth: .infinity)
            .padding(Tokens.Spacing.xl)
            .listRowSeparator(.hidden)
        } else {
            ProgressView().frame(maxWidth: .infinity).listRowSeparator(.hidden)
        }
    }
}

private struct MemberRow: View {
    let member: DeskMember
    let isMe: Bool
    let selected: Bool

    var body: some View {
        HStack(spacing: Tokens.Spacing.m) {
            AvatarView(name: member.name, url: member.picture.flatMap(URL.init(string:)), size: 32)
            VStack(alignment: .leading, spacing: 1) {
                Text(isMe ? "\(member.name) (\(DeskStrings.conversationAssignedToYou))" : member.name)
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                if !member.email.isEmpty, member.email != member.name {
                    Text(member.email).font(.inter(.caption)).foregroundStyle(.secondary).lineLimit(1)
                }
            }
            Spacer(minLength: 0)
            if selected {
                Image(systemName: "checkmark").foregroundStyle(Tokens.Palette.primary)
            }
        }
    }
}
