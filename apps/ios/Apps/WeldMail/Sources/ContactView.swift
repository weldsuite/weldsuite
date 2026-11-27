import SwiftUI
import UIKit
import WeldCore
import WeldUI

/// The sender's contact card: a contact found by address (or a placeholder), its fields editable in place.
struct ContactView: View {
    let store: MailStore
    let key: String

    private struct FieldInfo: Identifiable {
        let field: ContactLogic.Field
        let label: String
        let systemImage: String
        let editable: Bool
        let keyboard: UIKeyboardType
        var id: String { field.rawValue }
    }

    private static var fields: [FieldInfo] {
        [
            FieldInfo(field: .domains, label: MailStrings.contactDomains, systemImage: "globe", editable: true, keyboard: .URL),
            FieldInfo(field: .name, label: MailStrings.contactName, systemImage: "person.text.rectangle", editable: true, keyboard: .default),
            FieldInfo(field: .description, label: MailStrings.contactDescription, systemImage: "text.alignleft", editable: true, keyboard: .default),
            FieldInfo(field: .team, label: MailStrings.contactTeam, systemImage: "person.3", editable: true, keyboard: .default),
            FieldInfo(field: .email, label: MailStrings.contactEmail, systemImage: "envelope", editable: true, keyboard: .emailAddress),
            FieldInfo(field: .phone, label: MailStrings.contactPhone, systemImage: "phone", editable: true, keyboard: .phonePad),
            FieldInfo(field: .address, label: MailStrings.contactAddress, systemImage: "mappin.and.ellipse", editable: false, keyboard: .default),
        ]
    }

    private enum Tab: Hashable {
        case details, comments
    }

    @Environment(MailNotifier.self) private var notifier
    @State private var person: MailContact?
    @State private var loading = true
    @State private var tab = Tab.details
    @State private var editing: ContactLogic.Field?
    @State private var value = ""
    @State private var saving = false
    @State private var notAContact = false
    @FocusState private var editorFocused: Bool

    var body: some View {
        Group {
            if loading {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let contact = person {
                content(contact)
            } else {
                MailEmptyView(title: MailStrings.contactNotFound, systemImage: "person.crop.circle.badge.questionmark")
            }
        }
        .navigationTitle(person.map(ContactLogic.displayName) ?? MailStrings.contactTitle)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                let email = person?.email.flatMap { ContactLogic.isEmail($0) ? $0.trimmingCharacters(in: .whitespaces) : nil }
                let phone = person?.phone.map(ContactLogic.dialable).flatMap { $0.isEmpty ? nil : $0 }
                Button {
                    if let email { openExternal("mailto:\(email)") }
                } label: {
                    Image(systemName: "envelope")
                }
                .disabled(email == nil)
                .accessibilityLabel(MailStrings.contactSendEmail)
                Button {
                    if let phone { openExternal("tel:\(phone)") }
                } label: {
                    Image(systemName: "phone")
                }
                .disabled(phone == nil)
                .accessibilityLabel(MailStrings.contactCall)
            }
        }
        .task(id: key) { await load() }
        .alert(MailStrings.contactNotContactTitle, isPresented: $notAContact) {
            Button(CoreStrings.commonDone) {}
        } message: {
            Text(MailStrings.contactNotContact)
        }
    }

    private func load() async {
        loading = true
        if key.contains("@") {
            let found = (try? await store.repository.people(search: key, limit: 20)) ?? []
            person = ContactLogic.exactMatch(found, email: key) ?? ContactLogic.placeholder(key)
        } else {
            person = try? await store.repository.person(key)
        }
        loading = false
    }

    private func content(_ contact: MailContact) -> some View {
        List {
            Section {
                HStack(spacing: Tokens.Spacing.m) {
                    SenderAvatar(name: ContactLogic.displayName(contact), size: 48)
                    VStack(alignment: .leading) {
                        Text(ContactLogic.displayName(contact)).font(.title3.weight(.semibold))
                        if let email = contact.email { Text(email).font(.footnote).foregroundStyle(.secondary) }
                    }
                }
                Picker("", selection: $tab) {
                    Text(MailStrings.contactDetails).tag(Tab.details)
                    Text(MailStrings.contactComments).tag(Tab.comments)
                }
                .pickerStyle(.segmented)
                .accessibilityIdentifier("contact-tabs")
            }
            if tab == .details {
                Section(MailStrings.contactRecordDetails) {
                    ForEach(Self.fields) { info in
                        fieldRow(info, contact: contact)
                    }
                }
            } else {
                MailEmptyView(title: MailStrings.contactNoComments, description: MailStrings.contactNoCommentsHint, systemImage: "text.bubble")
                    .listRowSeparator(.hidden)
            }
        }
    }

    @ViewBuilder
    private func fieldRow(_ info: FieldInfo, contact: MailContact) -> some View {
        let shown = ContactLogic.value(contact, info.field)
        if editing == info.field {
            HStack {
                Image(systemName: info.systemImage).foregroundStyle(.secondary).frame(width: 24)
                TextField(info.label, text: $value, axis: info.field == .description ? .vertical : .horizontal)
                    .keyboardType(info.keyboard)
                    .textInputAutocapitalization(info.field == .email || info.field == .domains ? .never : .sentences)
                    .focused($editorFocused)
                    .disabled(saving)
                    .onSubmit { save(info.field, contact: contact) }
                    .accessibilityIdentifier("contact-edit-\(info.field.rawValue)")
                if saving {
                    ProgressView()
                } else {
                    Button(CoreStrings.commonSave) { save(info.field, contact: contact) }
                }
            }
            .onAppear { editorFocused = true }
        } else {
            HStack {
                Button {
                    tap(info, shown: shown)
                } label: {
                    HStack(alignment: .top) {
                        Image(systemName: info.systemImage).foregroundStyle(.secondary).frame(width: 24)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(info.label).font(.caption).foregroundStyle(.secondary)
                            Text(shown ?? MailStrings.contactSetField(field: info.label))
                                .foregroundStyle(shown == nil ? Color.secondary : (info.field == .email || info.field == .phone ? Color.accentColor : Color.primary))
                                .lineLimit(info.field == .description ? 3 : 1)
                        }
                        Spacer()
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(!info.editable && shown == nil)
                .accessibilityIdentifier("contact-field-\(info.field.rawValue)")
                if info.editable && (info.field == .email || info.field == .phone), let shown {
                    Button(CoreStrings.commonEdit) {
                        value = shown
                        editing = info.field
                    }
                    .buttonStyle(.borderless)
                }
            }
        }
    }

    private func tap(_ info: FieldInfo, shown: String?) {
        if info.field == .email, let shown, ContactLogic.isEmail(shown) {
            openExternal("mailto:\(shown.trimmingCharacters(in: .whitespaces))")
        } else if info.field == .phone, let shown {
            openExternal("tel:\(ContactLogic.dialable(shown))")
        } else if info.editable {
            value = shown ?? ""
            editing = info.field
        }
    }

    private func save(_ field: ContactLogic.Field, contact: MailContact) {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed == (ContactLogic.value(contact, field) ?? "") {
            editing = nil
            return
        }
        // A sender who isn't a contact has the address as its id.
        if contact.id.contains("@") {
            editing = nil
            notAContact = true
            return
        }
        saving = true
        Task {
            do {
                person = try await store.repository.updatePerson(contact.id, change: ContactLogic.change(field, trimmed))
                notifier.show(MailStrings.contactSaved)
            } catch {
                notifier.show(MailStrings.contactSaveFailed)
            }
            saving = false
            editing = nil
        }
    }
}
