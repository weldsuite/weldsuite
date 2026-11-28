import SwiftUI
import WeldCore
import WeldUI

/// A new category (a section of channels on Home).
struct NewCategoryView: View {
    let store: ChatStore

    @Environment(ChatNavigator.self) private var navigator
    @Environment(\.dismiss) private var dismiss

    @State private var name = ""
    @State private var saving = false
    @State private var error: String?
    @FocusState private var focused: Bool

    private var trimmed: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField(ChatStrings.newCategoryNamePlaceholder, text: Binding(
                        get: { name },
                        set: { text in
                            name = String(text.prefix(ChannelNames.maxLength))
                            error = nil
                        }
                    ))
                    .textInputAutocapitalization(.sentences)
                    .submitLabel(.done)
                    .focused($focused)
                    .onSubmit { Task { await create() } }
                    .accessibilityIdentifier("new-category-name")
                } header: {
                    Text(ChatStrings.newCategoryNameLabel)
                } footer: {
                    if let error {
                        InlineError(text: error)
                    } else {
                        Text(ChatStrings.newCategoryHint)
                    }
                }
            }
            .navigationTitle(ChatStrings.newCategoryTitle)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(CoreStrings.commonCancel) { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if saving {
                        ProgressView()
                    } else {
                        Button(ChatStrings.newCategoryCreate) { Task { await create() } }
                            .fontWeight(.semibold)
                            .disabled(trimmed.isEmpty)
                            .accessibilityIdentifier("new-category-create")
                    }
                }
            }
        }
        .interactiveDismissDisabled(saving)
        .onAppear { focused = true }
    }

    private func create() async {
        guard !trimmed.isEmpty, !saving else { return }
        saving = true
        error = nil
        do {
            try await store.createSection(name: trimmed)
            await store.loadHome()
            navigator.finishSheet(opening: nil)
        } catch {
            self.error = ChatStrings.newCategoryFailed
            saving = false
        }
    }
}
