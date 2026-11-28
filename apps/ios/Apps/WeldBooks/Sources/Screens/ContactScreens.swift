import SwiftUI
import UIKit
import WeldCore
import WeldUI

// The customers and suppliers invoices and bills are issued to (Android `ui/ContactScreens.kt`).

/// "Customer", "Supplier" or "Customer & supplier", in the country's words.
private func contactRoleLabel(_ role: String, labels: Labels) -> String {
    switch role {
    case "customer": return BooksStrings.contactsCustomer
    case "supplier": return labels.supplier
    case "both": return BooksStrings.contactsBoth(supplier: labels.supplierLower)
    default: return role
    }
}

/// A building for a company, a person for a private individual; an older contact keeps the building.
private struct ContactKindTile: View {
    let kind: String?
    var size: CGFloat = 40

    var body: some View {
        IconTile(systemImage: kind == "person" ? "person" : "building.2", color: Accents.contacts, size: size)
    }
}

/// The title, and a line under it, in the navigation bar.
private struct ContactNavTitle: View {
    let title: String
    let subtitle: String?

    var body: some View {
        VStack(spacing: 0) {
            Text(title)
                .font(.inter(.headline))
                .lineLimit(1)
            if let subtitle {
                Text(subtitle)
                    .font(.inter(.caption))
                    .foregroundStyle(Color.secondary)
                    .lineLimit(1)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }
}

private extension View {
    /// A pushed screen's inline title, with an optional subtitle under it.
    func contactTitle(_ title: String, subtitle: String? = nil) -> some View {
        navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    ContactNavTitle(title: title, subtitle: subtitle)
                }
            }
    }
}

// MARK: - Contacts

/// The customers and suppliers, searched (as typed, after a pause) and filtered by role.
struct ContactsView: View {
    @Environment(Books.self) private var books
    @Environment(BooksNavigator.self) private var navigator
    @State private var searchText = ""
    /// What is searched: `searchText` once typing pauses.
    @State private var query = ""
    @State private var filter = "all"
    @State private var loaded = Loaded<[Contact]>()

    init() {}

    private var role: String? {
        switch filter {
        case "customer": return "customer"
        case "vendor": return "supplier"
        default: return nil
        }
    }

    private var filters: [Choice] {
        [
            Choice("all", BooksStrings.contactsFilterAll),
            Choice("customer", BooksStrings.contactsFilterCustomers),
            Choice("vendor", books.labels.suppliers),
        ]
    }

    var body: some View {
        let count = loaded.data?.count ?? 0
        let currentRole = role
        let currentQuery = query
        let key: String = currentQuery + "|" + (currentRole ?? "")
        VStack(spacing: 0) {
            SearchAndFilters(
                search: $searchText,
                placeholder: BooksStrings.contactsSearchPlaceholder,
                filters: filters,
                selected: $filter
            )
            LoadedContent(loaded, loadError: BooksStrings.contactsLoadError, id: key) {
                try await books.store.contacts(search: currentQuery.trimmed.nilIfEmpty, role: currentRole)
            } content: { contacts in
                ContactsList(contacts: contacts, searching: !searchText.isEmpty)
            }
        }
        .debounced(searchText, milliseconds: 300) { query = searchText }
        .realtimeRefresh(books.env, topics: BooksTopics.contacts) { await loaded.load() }
        .contactTitle(BooksStrings.contactsTitle, subtitle: count > 0 ? BooksStrings.contactsShown(count: count) : nil)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    navigator.open(.newContact)
                } label: {
                    Image(systemName: "plus")
                }
                .accessibilityLabel(BooksStrings.contactsNewContact)
                .tagged("contacts-new")
            }
        }
    }
}

private struct ContactsList: View {
    let contacts: [Contact]
    let searching: Bool

    @Environment(Books.self) private var books
    @Environment(BooksNavigator.self) private var navigator

    init(contacts: [Contact], searching: Bool) {
        self.contacts = contacts
        self.searching = searching
    }

    var body: some View {
        List {
            ForEach(contacts) { contact in
                RecordRow(
                    title: contact.name.isBlank ? BooksStrings.contactsUnnamed : contact.name,
                    subtitle: contact.email,
                    meta: contactRoleLabel(contact.role, labels: books.labels),
                    tag: "contact-row",
                    onTap: { navigator.open(.contact(id: contact.id)) }
                ) {
                    ContactKindTile(kind: contact.kind)
                }
            }
        }
        .listStyle(.plain)
        .overlay {
            if contacts.isEmpty { emptyState }
        }
        .tagged("contacts")
    }

    @ViewBuilder
    private var emptyState: some View {
        if searching {
            ContentUnavailableView(
                BooksStrings.contactsNoMatchTitle,
                systemImage: "person.2",
                description: Text(BooksStrings.contactsNoMatchDescription)
            )
        } else {
            ContentUnavailableView {
                Label(BooksStrings.contactsEmptyTitle, systemImage: "person.2")
            } description: {
                Text(BooksStrings.contactsEmptyDescription(suppliers: books.labels.suppliersLower))
            } actions: {
                Button(BooksStrings.contactsNewContact) { navigator.open(.newContact) }
                    .buttonStyle(.borderedProminent)
                    .tagged("contacts-empty-new")
            }
        }
    }
}

// MARK: - One contact

private struct ContactPage {
    var contact: Contact
    var balance: ContactBalance?
    var invoices: [Invoice]
    var bills: [Bill]
}

/// The contact gates the screen; its balance and documents are best effort, loaded at the same time.
private enum ContactLoader {
    @MainActor
    static func page(_ store: BooksStore, id: String) async throws -> ContactPage {
        async let contact = store.contact(id: id)
        async let balance = orNil { try await store.contactBalance(id: id) }
        async let invoices = orNil { try await store.contactInvoices(id: id) }
        async let bills = orNil { try await store.contactBills(id: id) }
        let found = try await contact
        return ContactPage(contact: found, balance: await balance, invoices: await invoices ?? [], bills: await bills ?? [])
    }

    static func orNil<T>(_ work: () async throws -> T) async -> T? {
        do {
            return try await work()
        } catch {
            return nil
        }
    }
}

/// One contact: profile, open balance and the documents issued to it.
struct ContactView: View {
    let id: String

    @Environment(Books.self) private var books
    @Environment(Toaster.self) private var toaster
    @Environment(\.dismiss) private var dismiss
    @State private var loaded = Loaded<ContactPage>()
    @State private var mutations = Mutations()
    @State private var confirming = false

    init(id: String) {
        self.id = id
    }

    var body: some View {
        let contact = loaded.data?.contact
        let store = books.store
        LoadedContent(loaded, loadError: BooksStrings.contactDetailLoadError, id: id) {
            try await ContactLoader.page(store, id: id)
        } content: { page in
            ContactBody(page: page)
        }
        .realtimeRefresh(books.env, topics: BooksTopics.contacts) { await loaded.load() }
        .contactTitle(
            contact?.name ?? BooksStrings.contactDetailTitle,
            subtitle: contact.map { contactRoleLabel($0.role, labels: books.labels) }
        )
        .toolbar {
            if contact != nil {
                ToolbarItem(placement: .topBarTrailing) {
                    Button(role: .destructive) {
                        confirming = true
                    } label: {
                        Image(systemName: "trash")
                    }
                    .tint(Tokens.Status.danger)
                    .disabled(mutations.busy)
                    .accessibilityLabel(BooksStrings.contactDetailDeleteContact)
                    .tagged("delete-contact")
                }
            }
        }
        .confirmDialog(
            BooksStrings.contactDetailDeleteTitle,
            isPresented: $confirming,
            message: BooksStrings.contactDetailDeleteMessage,
            confirm: CoreStrings.commonDelete,
            destructive: true
        ) {
            delete()
        }
    }

    private func delete() {
        guard let contact = loaded.data?.contact else { return }
        let store = books.store
        mutations.remove(
            toaster,
            success: BooksStrings.contactDetailDeleted,
            failMessage: BooksStrings.contactDetailDeleteFailed,
            leave: { dismiss() }
        ) {
            try await store.deleteContact(id: contact.id)
        }
    }
}

private struct ContactBody: View {
    let page: ContactPage

    @Environment(Books.self) private var books
    @Environment(BooksNavigator.self) private var navigator

    init(page: ContactPage) {
        self.page = page
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                header
                if let balance = page.balance {
                    balanceCard(balance)
                }
                ContactInfoCard(contact: page.contact)
                ContactTaxReportingCard(contact: page.contact)
                if !page.invoices.isEmpty {
                    invoicesCard
                }
                if !page.bills.isEmpty {
                    billsCard
                }
            }
            .padding(.bottom, Tokens.Spacing.xl)
        }
        .groupedBackground()
        .tagged("contact-detail")
    }

    private var header: some View {
        let contact = page.contact
        return SectionCard {
            HStack(spacing: Tokens.Spacing.m) {
                ContactKindTile(kind: contact.kind, size: 48)
                VStack(alignment: .leading, spacing: Tokens.Spacing.xs) {
                    Text(contact.name)
                        .font(.inter(.headline))
                    HStack(spacing: 6) {
                        if let kind = contact.kind {
                            StatusBadge(
                                kind == "person" ? BooksStrings.contactsKindsPerson : BooksStrings.contactsKindsCompany,
                                color: Color.secondary
                            )
                        }
                        StatusBadge(contactRoleLabel(contact.role, labels: books.labels), color: Accents.brand)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    private func balanceCard(_ balance: ContactBalance) -> some View {
        let receivableColor: Color? = balance.receivable > 0 ? Tokens.Status.warning : nil
        let payableColor: Color? = balance.payable > 0 ? Tokens.Status.warning : nil
        return SectionCard(title: BooksStrings.contactDetailBalance) {
            DetailRow(BooksStrings.contactDetailReceivable, books.money(balance.receivable), valueColor: receivableColor, strong: true)
            DetailRow(BooksStrings.contactDetailPayable, books.money(balance.payable), valueColor: payableColor, strong: true)
        }
    }

    private var invoicesCard: some View {
        SectionCard(title: BooksStrings.contactDetailInvoices, padded: false) {
            ForEach(Array(page.invoices.prefix(5))) { invoice in
                RecordRow(
                    title: invoice.number ?? BooksStrings.commonDraft,
                    subtitle: books.shortDate(invoice.issueDate),
                    amount: books.money(invoice.total, currency: invoice.currency),
                    tag: "contact-invoice",
                    onTap: { navigator.open(.invoice(id: invoice.id)) }
                ) {
                    IconTile(systemImage: "doc.text", color: Accents.vat, size: 32)
                } badge: {
                    StatusPill(invoice.displayStatus())
                }
                .padding(.horizontal, Tokens.Spacing.l)
            }
        }
    }

    private var billsCard: some View {
        SectionCard(title: BooksStrings.contactDetailBills, padded: false) {
            ForEach(Array(page.bills.prefix(5))) { bill in
                RecordRow(
                    title: bill.number ?? BooksStrings.commonDraft,
                    subtitle: books.shortDate(bill.issueDate),
                    amount: books.money(bill.total, currency: bill.currency),
                    tag: "contact-bill",
                    onTap: { navigator.open(.bill(id: bill.id)) }
                ) {
                    IconTile(systemImage: "list.bullet.rectangle", color: Accents.profitLoss, size: 32)
                } badge: {
                    StatusPill(bill.displayStatus())
                }
                .padding(.horizontal, Tokens.Spacing.l)
            }
        }
    }
}

/// How to reach the contact; only when a main field is there (a city alone doesn't make the card).
private struct ContactInfoCard: View {
    let contact: Contact

    @Environment(Books.self) private var books

    init(contact: Contact) {
        self.contact = contact
    }

    private var billing: [String] { Addresses.lines(contact.billingAddress) }
    private var shipping: [String] { Addresses.lines(contact.shippingAddress) }

    private var personText: String? {
        guard let person = contact.contactPerson else { return nil }
        let parts: [String?] = [person.name, person.email, person.phone]
        return parts.compactMap { $0 }.joined(separator: "\n")
    }

    private var shown: Bool {
        contact.email != nil || contact.phone != nil || contact.vatNumber != nil || contact.contactPerson != nil || !billing.isEmpty
    }

    var body: some View {
        if shown {
            SectionCard(title: BooksStrings.contactDetailDetails) {
                if let personText {
                    DetailRow(BooksStrings.contactDetailContactPerson, personText)
                }
                if let email = contact.email {
                    DetailRow(BooksStrings.contactDetailEmail, email)
                }
                if let phone = contact.phone {
                    DetailRow(BooksStrings.contactDetailPhone, phone)
                }
                if let vat = contact.vatNumber {
                    DetailRow(books.labels.taxId, vat)
                }
                addressRows
            }
        }
    }

    /// US: the billing and (when different) shipping address; elsewhere the city.
    @ViewBuilder
    private var addressRows: some View {
        if books.isUs {
            if !billing.isEmpty {
                DetailRow(BooksStrings.contactDetailBillingAddress, billing.joined(separator: "\n"))
            }
            if !shipping.isEmpty, shipping != billing {
                DetailRow(BooksStrings.contactDetailShippingAddress, shipping.joined(separator: "\n"))
            }
        } else if let city = contact.city, !city.isBlank {
            DetailRow(BooksStrings.contactDetailCity, city)
        }
    }
}

/// US: whether the contact gets a 1099, and which taxpayer ID is on file (last four only; entered on the web).
private struct ContactTaxReportingCard: View {
    let contact: Contact

    @Environment(Books.self) private var books

    init(contact: Contact) {
        self.contact = contact
    }

    private var tinType: String {
        switch contact.tinType ?? "" {
        case "ein": return BooksStrings.contactDetailTinTypesEin
        case "ssn": return BooksStrings.contactDetailTinTypesSsn
        case "itin": return BooksStrings.contactDetailTinTypesItin
        default: return ""
        }
    }

    var body: some View {
        if books.isUs, contact.is1099Vendor || contact.tinLast4 != nil {
            SectionCard(title: BooksStrings.contactDetailTaxReporting) {
                if contact.is1099Vendor {
                    DetailRow(BooksStrings.contactDetailVendor1099, BooksStrings.contactDetailYes)
                }
                if let last4 = contact.tinLast4 {
                    DetailRow(BooksStrings.contactDetailTaxpayerId, BooksStrings.contactDetailTinOnFile(type: tinType, last4: last4).trimmed)
                }
            }
        }
    }
}

// MARK: - New contact

/// A new contact: a company (name, name on invoices, tax number) or a person
/// (first and last name), its role, and how to reach it. A US contact has an
/// address and no tax ID: a vendor's TIN is entered on the web, never here.
struct ContactFormView: View {
    @Environment(Books.self) private var books
    @Environment(BooksNavigator.self) private var navigator
    @Environment(Toaster.self) private var toaster
    @State private var identity = ContactIdentityDraft()
    @State private var identityProblem: String?
    @State private var email = ""
    @State private var phone = ""
    @State private var role = "customer"
    @State private var address = AddressDraft()
    @State private var addressProblems = UsAddressProblems()
    @State private var submitting = false

    init() {}

    private var isCompany: Bool { identity.kind == "company" }

    private var kind: Binding<String> {
        Binding(get: { identity.kind }, set: { value in edit { $0.kind = value } })
    }

    private func field(_ path: WritableKeyPath<ContactIdentityDraft, String>) -> Binding<String> {
        Binding(get: { identity[keyPath: path] }, set: { value in edit { $0[keyPath: path] = value } })
    }

    private var addressText: Binding<AddressDraft> {
        Binding(get: { address }, set: { value in
            address = value
            addressProblems = UsAddressProblems()
        })
    }

    var body: some View {
        let isUs = books.isUs
        Form {
            Section(BooksStrings.contactNewContact) {
                Picker(BooksStrings.contactNewContact, selection: kind) {
                    Text(BooksStrings.contactsKindsCompany)
                        .accessibilityIdentifier("contact-kind-company")
                        .tag("company")
                    Text(BooksStrings.contactsKindsPerson)
                        .accessibilityIdentifier("contact-kind-person")
                        .tag("person")
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                HintText(BooksStrings.contactNewKindHelp)
                identityFields(isUs: isUs)
                Dropdown(
                    BooksStrings.contactNewRole,
                    value: role,
                    options: ["customer", "supplier", "both"].map { Choice($0, contactRoleLabel($0, labels: books.labels)) },
                    tag: "contact-role"
                ) { role = $0 }
            }
            Section(BooksStrings.contactNewDetails) {
                FormField(
                    BooksStrings.contactNewEmail,
                    text: $email,
                    placeholder: isCompany ? BooksStrings.contactNewEmailPlaceholder : BooksStrings.contactNewEmailPlaceholderPerson,
                    keyboard: .emailAddress,
                    tag: "contact-email"
                )
                FormField(
                    BooksStrings.contactNewPhone,
                    text: $phone,
                    placeholder: isUs ? BooksStrings.examplesPhoneUs : BooksStrings.contactNewPhonePlaceholder,
                    keyboard: .phonePad,
                    tag: "contact-phone"
                )
                // A person has no VAT or registration number; the server refuses one.
                if !isUs, isCompany {
                    FormField(
                        books.labels.taxId,
                        text: field(\.taxId),
                        placeholder: books.labels.taxIdPlaceholder,
                        tag: "contact-tax-id"
                    )
                }
            }
            if isUs {
                Section(BooksStrings.contactNewAddress) {
                    AddressFields(value: addressText, problems: addressProblems)
                }
            }
            Section {
                Button(action: save) {
                    Text(BooksStrings.contactNewCreate).frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .disabled(submitting)
                .tagged("create-contact")
            }
        }
        .tagged("contact-form")
        .navigationTitle(BooksStrings.contactNewTitle)
        .navigationBarTitleDisplayMode(.inline)
    }

    @ViewBuilder
    private func identityFields(isUs: Bool) -> some View {
        if isCompany {
            FormField(
                BooksStrings.contactNewCompanyName,
                text: field(\.companyName),
                placeholder: isUs ? BooksStrings.examplesCompanyUs : BooksStrings.contactNewCompanyNamePlaceholder,
                error: identityProblem == "companyName" ? BooksStrings.contactNewCompanyNameError : nil,
                maxLength: ContactIdentityDraft.nameMax,
                tag: "contact-company-name"
            )
            FormField(
                BooksStrings.contactNewNameOnInvoices,
                text: field(\.nameOnInvoices),
                helper: BooksStrings.contactNewNameOnInvoicesHelp,
                maxLength: ContactIdentityDraft.nameMax,
                tag: "contact-name-on-invoices"
            )
        } else {
            FormField(
                BooksStrings.contactNewFirstName,
                text: field(\.firstName),
                placeholder: BooksStrings.contactNewFirstNamePlaceholder,
                error: identityProblem == "personName" ? BooksStrings.contactNewPersonNameError : nil,
                maxLength: ContactIdentityDraft.personNameMax,
                tag: "contact-first-name"
            )
            FormField(
                BooksStrings.contactNewLastName,
                text: field(\.lastName),
                placeholder: BooksStrings.contactNewLastNamePlaceholder,
                maxLength: ContactIdentityDraft.personNameMax,
                tag: "contact-last-name"
            )
        }
    }

    private func edit(_ change: (inout ContactIdentityDraft) -> Void) {
        var next = identity
        change(&next)
        identity = next
        identityProblem = nil
    }

    private func save() {
        let isUs = books.isUs
        identityProblem = identity.problem()
        if identityProblem != nil { return }
        if isUs {
            // A partly filled address is checked; a blank one is left out.
            let problems = Addresses.usProblems(address)
            addressProblems = problems
            if !problems.isEmpty { return }
        }
        let values = NewContact(
            identity: identity.payload(withTaxId: !isUs),
            email: email.trimmed.nilIfEmpty,
            phone: phone.trimmed.nilIfEmpty,
            role: role,
            billingAddress: isUs && !address.isBlank ? Addresses.usAddress(address) : nil
        )
        let store = books.store
        submitting = true
        Task {
            do {
                let id = try await store.createContact(values)
                toaster.show(BooksStrings.contactNewCreated)
                submitting = false
                navigator.replace(with: .contact(id: id))
            } catch {
                toaster.show(ErrorTexts.describe(error, fallback: BooksStrings.contactNewCreateFailed))
                submitting = false
            }
        }
    }
}
