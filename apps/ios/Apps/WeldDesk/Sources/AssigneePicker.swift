import SwiftUI
import WeldCore
import WeldUI

/// Who to assign the conversation to, as the platform's assign menu: the
/// search, "Assign to me" first, the team (a check on the assignee), and
/// "Unassign" last, in red. The roster loads the first time it opens.
struct AssigneePicker: View {
    let model: ConversationModel
    /// Nil unassigns.
    let onSelect: (String?) -> Void
    @State private var search = ""
    @Environment(\.dismiss) private var dismiss

    private var assigneeID: String? {
        guard let id = model.detail?.conversation.assigneeID, !id.isEmpty else { return nil }
        return id
    }

    var body: some View {
        NavigationStack {
            List {
                if let userID = model.userID, assigneeID != userID, search.trimmingCharacters(in: .whitespaces).isEmpty {
                    Button {
                        onSelect(userID)
                    } label: {
                        PickerRow(title: DeskStrings.conversationAssignToMe) {
                            Image(systemName: "person.crop.circle.badge.checkmark")
                                .foregroundStyle(Tokens.Palette.foreground)
                        }
                    }
                    .accessibilityIdentifier("assign-to-me")
                }
                content
                if assigneeID != nil {
                    Button(role: .destructive) {
                        onSelect(nil)
                    } label: {
                        PickerRow(title: DeskStrings.conversationUnassign, color: Tokens.Status.danger) {
                            Image(systemName: "person.badge.minus")
                                .foregroundStyle(Tokens.Status.danger)
                        }
                    }
                    .accessibilityIdentifier("assignee-unassign")
                }
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
                    .font(.inter(.subheadline))
                    .foregroundStyle(Tokens.Palette.mutedForeground)
                    .frame(maxWidth: .infinity)
                    .listRowSeparator(.hidden)
            } else {
                ForEach(visible) { member in
                    Button {
                        onSelect(member.userID)
                    } label: {
                        PickerRow(
                            title: member.userID == model.userID ? "\(member.name) (\(DeskStrings.conversationAssignedToYou))" : member.name,
                            checked: member.userID == assigneeID
                        ) {
                            InitialAvatar(name: member.name, url: member.picture.flatMap(URL.init(string:)), size: 24)
                        }
                    }
                    .accessibilityIdentifier("assignee-\(member.userID)")
                }
            }
        } else if model.membersFailed {
            VStack(spacing: Tokens.Spacing.s) {
                Text(DeskStrings.conversationMembersError)
                    .font(.inter(.subheadline))
                    .foregroundStyle(Tokens.Palette.mutedForeground)
                    .multilineTextAlignment(.center)
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

/// One choice of the assign menu: an icon or avatar, the title, and a check on the current one.
private struct PickerRow<Leading: View>: View {
    let title: String
    var color: Color = Tokens.Palette.foreground
    var checked = false
    @ViewBuilder var leading: () -> Leading

    var body: some View {
        HStack(spacing: Tokens.Spacing.m) {
            leading()
                .frame(width: 24, height: 24)
            Text(title)
                .font(.inter(.subheadline))
                .foregroundStyle(color)
                .lineLimit(1)
            Spacer(minLength: 0)
            if checked {
                Image(systemName: "checkmark")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Tokens.Palette.primary)
            }
        }
        .contentShape(Rectangle())
    }
}
