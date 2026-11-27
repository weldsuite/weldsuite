import SwiftUI
import WeldCore
import WeldUI

/// A search box: the glass, the text, and a clear button while it holds text.
struct ChatSearchField: View {
    let placeholder: String
    @Binding var text: String
    var identifier: String
    var focus: FocusState<Bool>.Binding?

    var body: some View {
        HStack(spacing: Tokens.Spacing.s) {
            Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
            field
            if !text.isEmpty {
                Button {
                    text = ""
                } label: {
                    Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(CoreStrings.commonClose)
            }
        }
        .padding(.horizontal, Tokens.Spacing.m)
        .padding(.vertical, 9)
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: Tokens.Radius.medium))
    }

    @ViewBuilder
    private var field: some View {
        if let focus {
            TextField(placeholder, text: $text)
                .focused(focus)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.search)
                .accessibilityIdentifier(identifier)
        } else {
            TextField(placeholder, text: $text)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.search)
                .accessibilityIdentifier(identifier)
        }
    }
}

/// A person to pick: the avatar, the name (and e-mail), a tick when picked.
struct PickPersonRow: View {
    let name: String
    var email: String?
    var picture: String?
    let selected: Bool

    var body: some View {
        HStack(spacing: Tokens.Spacing.m) {
            ChatAvatar(name: name, url: picture, size: 36)
            VStack(alignment: .leading, spacing: 1) {
                Text(name).lineLimit(1).foregroundStyle(Color.primary)
                if let email, !email.isEmpty, email != name {
                    Text(email).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
            }
            Spacer(minLength: 0)
            Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                .font(.title3)
                .foregroundStyle(selected ? Tokens.Brand.weldchat : Color.secondary)
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

/// A row of chips that scrolls sideways.
struct ChipRow<Item: Identifiable & Hashable>: View {
    let items: [Item]
    let selected: Item
    let title: (Item) -> String
    var symbol: (Item) -> String? = { _ in nil }
    let identifier: (Item) -> String
    let onSelect: (Item) -> Void

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: Tokens.Spacing.s) {
                ForEach(items) { item in
                    FilterChip(title: title(item), selected: item == selected, symbol: symbol(item)) {
                        onSelect(item)
                    }
                    .accessibilityIdentifier(identifier(item))
                }
            }
            .padding(.vertical, 2)
        }
    }
}

/// An inline message under a form: what went wrong, in red.
struct InlineError: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.footnote)
            .foregroundStyle(Tokens.Status.danger)
            .accessibilityIdentifier("inline-error")
    }
}
