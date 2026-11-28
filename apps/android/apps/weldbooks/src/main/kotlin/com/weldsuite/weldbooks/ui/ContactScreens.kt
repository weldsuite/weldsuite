package com.weldsuite.weldbooks.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ReceiptLong
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.outlined.Apartment
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Description
import androidx.compose.material.icons.outlined.Group
import androidx.compose.material.icons.outlined.ArrowDownward
import androidx.compose.material.icons.outlined.ArrowUpward
import androidx.compose.material.icons.outlined.Badge
import androidx.compose.material.icons.outlined.Email
import androidx.compose.material.icons.outlined.Person
import androidx.compose.material.icons.outlined.Phone
import androidx.compose.material.icons.outlined.Place
import androidx.compose.material.icons.outlined.Receipt
import androidx.compose.material.icons.outlined.Search
import org.weldsuite.ui.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.weldsuite.weldbooks.NewContact
import com.weldsuite.weldbooks.R
import com.weldsuite.weldbooks.logic.AddressDraft
import com.weldsuite.weldbooks.logic.Addresses
import com.weldsuite.weldbooks.logic.Bill
import com.weldsuite.weldbooks.logic.BooksTopics
import com.weldsuite.weldbooks.logic.Contact
import com.weldsuite.weldbooks.logic.ContactBalance
import com.weldsuite.weldbooks.logic.ContactIdentityDraft
import com.weldsuite.weldbooks.logic.Invoice
import com.weldsuite.weldbooks.logic.UsAddressProblems
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.weldsuite.ui.EmptyState
import org.weldsuite.ui.RealtimeRefresh
import org.weldsuite.ui.StatusBadge
import org.weldsuite.ui.Tokens
import org.weldsuite.ui.tagged

/** The platform's row avatar of a contact: a building for a company, a person for a private individual; an older contact keeps the building. */
@Composable
fun ContactKindTile(kind: String?, size: androidx.compose.ui.unit.Dp = 24.dp) =
    RowAvatar(null, if (kind == "person") Icons.Outlined.Person else Icons.Outlined.Apartment, size)

/** The platform's chip colour of a role: customers blue, suppliers purple, both indigo. */
fun contactRoleTone(role: String): org.weldsuite.ui.DayNight = when (role) {
    "both" -> Tones.indigo
    "supplier" -> Tones.purple
    else -> Tones.blue
}

/** "Customer", "Supplier" or "Customer & supplier", in the country's words. */
@Composable
fun contactRoleLabel(role: String): String {
    val books = LocalBooks.current
    return when (role) {
        "customer" -> stringResource(R.string.weldbooks_contacts_customer)
        "supplier" -> books.labels.supplier
        "both" -> stringResource(R.string.weldbooks_contacts_both, books.labels.supplierLower)
        else -> role
    }
}

/** The customers and suppliers invoices and bills are issued to. */
@Composable
fun ContactsScreen(onBack: () -> Unit, open: (String) -> Unit) {
    val books = LocalBooks.current
    var search by rememberSaveable { mutableStateOf("") }
    var debounced by rememberSaveable { mutableStateOf("") }
    var filter by rememberSaveable { mutableStateOf("all") }
    LaunchedEffect(search) {
        delay(300)
        debounced = search
    }
    val role = when (filter) {
        "customer" -> "customer"
        "vendor" -> "supplier"
        else -> null
    }
    val loaded = rememberLoaded(debounced, role) { books.repository.contacts(debounced.trim().ifEmpty { null }, role) }
    RealtimeRefresh(books.env, BooksTopics.contacts) { loaded.load() }
    val count = loaded.data?.size ?: 0
    BooksScaffold(
        title = stringResource(R.string.weldbooks_contacts_title),
        subtitle = if (count > 0) stringResource(R.string.weldbooks_contacts_shown, count) else null,
        onBack = onBack,
        actions = {
            IconButton(onClick = { open("contacts/new") }, modifier = Modifier.tagged("contacts-new")) {
                Icon(Icons.Filled.Add, contentDescription = stringResource(R.string.weldbooks_contacts_new_contact))
            }
        },
    ) { padding ->
        Column(Modifier.padding(padding)) {
            SearchAndFilters(
                search,
                { search = it },
                stringResource(R.string.weldbooks_contacts_search_placeholder),
                listOf(
                    "all" to stringResource(R.string.weldbooks_contacts_filter_all),
                    "customer" to stringResource(R.string.weldbooks_contacts_filter_customers),
                    "vendor" to books.labels.suppliers,
                ),
                filter,
            ) { filter = it }
            LoadedContent(loaded, stringResource(R.string.weldbooks_contacts_load_error)) { contacts ->
                LazyColumn(Modifier.fillMaxSize().tagged("contacts")) {
                    if (contacts.isEmpty()) {
                        item {
                            val searching = search.isNotEmpty()
                            BooksEmptyState(
                                icon = if (searching) Icons.Outlined.Search else Icons.Outlined.Group,
                                title = stringResource(if (searching) R.string.weldbooks_contacts_no_match_title else R.string.weldbooks_contacts_empty_title),
                                description = if (searching) stringResource(R.string.weldbooks_contacts_no_match_description)
                                else stringResource(R.string.weldbooks_contacts_empty_description, books.labels.suppliersLower),
                                action = stringResource(R.string.weldbooks_contacts_new_contact).takeIf { !searching },
                                actionTag = "contacts-empty-new",
                                onAction = { open("contacts/new") },
                            )
                        }
                    } else {
                        item { Hairline() }
                    }
                    items(contacts, key = { it.id }) { contact ->
                        RecordRow(
                            leading = { ContactKindTile(contact.kind) },
                            title = contact.name.ifBlank { stringResource(R.string.weldbooks_contacts_unnamed) },
                            subtitle = contact.email,
                            badge = { ToneChip(contactRoleLabel(contact.role), contactRoleTone(contact.role)) },
                            tag = "contact-row",
                            onClick = { open("contacts/${contact.id}") },
                        )
                    }
                    item { BottomSpace() }
                }
            }
        }
    }
}

private data class ContactPage(val contact: Contact, val balance: ContactBalance?, val invoices: List<Invoice>, val bills: List<Bill>)

/**
 * One contact: profile, open balance and the documents issued to it. The
 * contact itself gates the screen; the balance and documents are best effort.
 */
@Composable
fun ContactScreen(id: String, onBack: () -> Unit, open: (String) -> Unit) {
    val books = LocalBooks.current
    val notify = LocalNotify.current
    val errors = LocalErrors.current
    val scope = rememberCoroutineScope()
    val loaded = rememberLoaded(id) {
        coroutineScope {
            val contact = async { books.repository.contact(id) }
            val balance = async { runCatching { books.repository.contactBalance(id) }.getOrNull() }
            val invoices = async { runCatching { books.repository.contactInvoices(id) }.getOrDefault(emptyList()) }
            val bills = async { runCatching { books.repository.contactBills(id) }.getOrDefault(emptyList()) }
            ContactPage(contact.await(), balance.await(), invoices.await(), bills.await())
        }
    }
    RealtimeRefresh(books.env, BooksTopics.contacts) { loaded.load() }
    var confirm by remember { mutableStateOf(false) }
    var deleting by remember { mutableStateOf(false) }
    val contact = loaded.data?.contact
    val deleted = stringResource(R.string.weldbooks_contact_detail_deleted)
    val failed = stringResource(R.string.weldbooks_contact_detail_delete_failed)
    BooksScaffold(
        title = contact?.name ?: stringResource(R.string.weldbooks_contact_detail_title),
        subtitle = contact?.let { contactRoleLabel(it.role) },
        onBack = onBack,
        actions = {
            if (contact != null) {
                IconButton(onClick = { confirm = true }, enabled = !deleting, modifier = Modifier.tagged("delete-contact")) {
                    Icon(Icons.Outlined.Delete, contentDescription = stringResource(R.string.weldbooks_contact_detail_delete_contact), tint = MaterialTheme.colorScheme.error)
                }
            }
        },
    ) { padding ->
        LoadedContent(loaded, stringResource(R.string.weldbooks_contact_detail_load_error), Modifier.padding(padding)) { page -> ContactBody(page, open) }
    }
    if (confirm && contact != null) {
        ConfirmDialog(
            stringResource(R.string.weldbooks_contact_detail_delete_title),
            stringResource(R.string.weldbooks_contact_detail_delete_message),
            stringResource(org.weldsuite.core.R.string.core_common_delete),
            destructive = true,
            onConfirm = {
                confirm = false
                deleting = true
                scope.launch {
                    runCatching { books.repository.deleteContact(contact.id) }
                        .onSuccess {
                            notify(deleted)
                            onBack()
                        }
                        .onFailure { notify(errors.describe(it, failed)) }
                    deleting = false
                }
            },
            onDismiss = { confirm = false },
        )
    }
}

@Composable
private fun ContactBody(page: ContactPage, open: (String) -> Unit) {
    val books = LocalBooks.current
    val contact = page.contact
    val warning = Tones.amber.current()
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).tagged("contact-detail")) {
        // The platform's page header: the avatar, the name, the kind and the role.
        Row(
            Modifier.fillMaxWidth().padding(horizontal = Tokens.Spacing.l, vertical = Tokens.Spacing.m),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.m),
        ) {
            ContactKindTile(contact.kind, 40.dp)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(contact.name, style = MaterialTheme.typography.titleMedium)
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    contact.kind?.let { kind ->
                        ToneChip(stringResource(if (kind == "person") R.string.weldbooks_contacts_kinds_person else R.string.weldbooks_contacts_kinds_company), Tones.gray)
                    }
                    ToneChip(contactRoleLabel(contact.role), contactRoleTone(contact.role))
                }
            }
        }
        page.balance?.let { balance ->
            Row(Modifier.fillMaxWidth().padding(horizontal = Tokens.Spacing.l, vertical = Tokens.Spacing.s), horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.m)) {
                KpiCard(
                    stringResource(R.string.weldbooks_contact_detail_receivable),
                    books.money(balance.receivable),
                    icon = Icons.Outlined.ArrowDownward,
                    tone = warning.takeIf { balance.receivable.signum() > 0 },
                    tag = "contact-receivable",
                    modifier = Modifier.weight(1f),
                )
                KpiCard(
                    stringResource(R.string.weldbooks_contact_detail_payable),
                    books.money(balance.payable),
                    icon = Icons.Outlined.ArrowUpward,
                    tone = warning.takeIf { balance.payable.signum() > 0 },
                    tag = "contact-payable",
                    modifier = Modifier.weight(1f),
                )
            }
        }
        ContactInfo(contact)
        TaxReporting(contact)
        if (page.invoices.isNotEmpty()) {
            PanelSection(title = stringResource(R.string.weldbooks_contact_detail_invoices)) {}
            Hairline()
            page.invoices.take(5).forEach { invoice ->
                RecordRow(
                    title = invoice.number ?: stringResource(R.string.weldbooks_common_draft),
                    meta = books.shortDate(invoice.issueDate),
                    amount = books.money(invoice.total, invoice.currency),
                    badge = { StatusPill(invoice.displayStatus()) },
                    tag = "contact-invoice",
                    onClick = { open("invoice/${invoice.id}") },
                )
            }
        }
        if (page.bills.isNotEmpty()) {
            PanelSection(title = stringResource(R.string.weldbooks_contact_detail_bills)) {}
            Hairline()
            page.bills.take(5).forEach { bill ->
                RecordRow(
                    title = bill.number ?: stringResource(R.string.weldbooks_common_draft),
                    meta = books.shortDate(bill.issueDate),
                    amount = books.money(bill.total, bill.currency),
                    badge = { StatusPill(bill.displayStatus()) },
                    tag = "contact-bill",
                    onClick = { open("bill/${bill.id}") },
                )
            }
        }
        BottomSpace()
    }
}

@Composable
private fun ContactInfo(contact: Contact) {
    val books = LocalBooks.current
    val billing = Addresses.lines(contact.billingAddress)
    val shipping = Addresses.lines(contact.shippingAddress)
    val person = contact.contactPerson
    // Only when a main field is there: a city alone doesn't make the section.
    if (contact.email == null && contact.phone == null && contact.vatNumber == null && person == null && billing.isEmpty()) return
    PanelSection(title = stringResource(R.string.weldbooks_contact_detail_details)) {
        person?.let { PropertyRow(Icons.Outlined.Person, stringResource(R.string.weldbooks_contact_detail_contact_person), listOfNotNull(it.name, it.email, it.phone).joinToString("\n")) }
        contact.email?.let { PropertyRow(Icons.Outlined.Email, stringResource(R.string.weldbooks_contact_detail_email), it) }
        contact.phone?.let { PropertyRow(Icons.Outlined.Phone, stringResource(R.string.weldbooks_contact_detail_phone), it) }
        contact.vatNumber?.let { PropertyRow(Icons.Outlined.Badge, books.labels.taxId, it) }
        if (books.isUs) {
            if (billing.isNotEmpty()) PropertyRow(Icons.Outlined.Place, stringResource(R.string.weldbooks_contact_detail_billing_address), billing.joinToString("\n"))
            if (shipping.isNotEmpty() && shipping != billing) PropertyRow(Icons.Outlined.Place, stringResource(R.string.weldbooks_contact_detail_shipping_address), shipping.joinToString("\n"))
        } else {
            contact.city?.takeIf { it.isNotBlank() }?.let { PropertyRow(Icons.Outlined.Place, stringResource(R.string.weldbooks_contact_detail_city), it) }
        }
    }
}

/** US: whether the contact gets a 1099, and which taxpayer ID is on file (last four only; entered on the web). */
@Composable
private fun TaxReporting(contact: Contact) {
    val books = LocalBooks.current
    if (!books.isUs || (!contact.is1099Vendor && contact.tinLast4 == null)) return
    PanelSection(title = stringResource(R.string.weldbooks_contact_detail_tax_reporting)) {
        if (contact.is1099Vendor) PropertyRow(Icons.Outlined.Receipt, stringResource(R.string.weldbooks_contact_detail_vendor1099), stringResource(R.string.weldbooks_contact_detail_yes))
        contact.tinLast4?.let { last4 ->
            val type = when (contact.tinType) {
                "ein" -> stringResource(R.string.weldbooks_contact_detail_tin_types_ein)
                "ssn" -> stringResource(R.string.weldbooks_contact_detail_tin_types_ssn)
                "itin" -> stringResource(R.string.weldbooks_contact_detail_tin_types_itin)
                else -> ""
            }
            PropertyRow(Icons.Outlined.Badge, stringResource(R.string.weldbooks_contact_detail_taxpayer_id), stringResource(R.string.weldbooks_contact_detail_tin_on_file, type, last4).trim())
        }
    }
}

/**
 * A new contact: a company (name, name on invoices, tax number) or a person
 * (first and last name), its role, and how to reach it. A US contact has an
 * address and no tax ID: a vendor's TIN is entered on the web, never here.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ContactFormScreen(onBack: () -> Unit, onCreated: (String) -> Unit) {
    val books = LocalBooks.current
    val notify = LocalNotify.current
    val errors = LocalErrors.current
    val scope = rememberCoroutineScope()
    val isUs = books.isUs
    var identity by remember { mutableStateOf(ContactIdentityDraft()) }
    var identityProblem by remember { mutableStateOf<String?>(null) }
    var email by rememberSaveable { mutableStateOf("") }
    var phone by rememberSaveable { mutableStateOf("") }
    var role by rememberSaveable { mutableStateOf("customer") }
    var address by remember { mutableStateOf(AddressDraft()) }
    var addressProblems by remember { mutableStateOf(UsAddressProblems()) }
    var submitting by remember { mutableStateOf(false) }
    val isCompany = identity.kind == "company"
    val created = stringResource(R.string.weldbooks_contact_new_created)
    val failed = stringResource(R.string.weldbooks_contact_new_create_failed)

    fun edit(change: (ContactIdentityDraft) -> ContactIdentityDraft) {
        identity = change(identity)
        identityProblem = null
    }

    fun save() {
        identityProblem = identity.problem()
        if (identityProblem != null) return
        if (isUs) {
            // A partly filled address is checked; a blank one is left out.
            addressProblems = Addresses.usProblems(address)
            if (!addressProblems.isEmpty) return
        }
        submitting = true
        scope.launch {
            runCatching {
                books.repository.createContact(
                    NewContact(
                        identity = identity.payload(withTaxId = !isUs),
                        email = email.trim().ifEmpty { null },
                        phone = phone.trim().ifEmpty { null },
                        role = role,
                        billingAddress = if (isUs && !address.isBlank) Addresses.usAddress(address) else null,
                    ),
                )
            }.onSuccess {
                notify(created)
                onCreated(it)
            }.onFailure { notify(errors.describe(it, failed)) }
            submitting = false
        }
    }

    BooksScaffold(title = stringResource(R.string.weldbooks_contact_new_title), onBack = onBack) { padding ->
        Column(Modifier.padding(padding).fillMaxSize().imePadding().verticalScroll(rememberScrollState()).tagged("contact-form")) {
            SectionCard(title = stringResource(R.string.weldbooks_contact_new_contact)) {
                val kinds = listOf(
                    "company" to stringResource(R.string.weldbooks_contacts_kinds_company),
                    "person" to stringResource(R.string.weldbooks_contacts_kinds_person),
                )
                SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
                    kinds.forEachIndexed { index, (key, label) ->
                        SegmentedButton(
                            selected = identity.kind == key,
                            onClick = { edit { it.copy(kind = key) } },
                            shape = SegmentedButtonDefaults.itemShape(index, kinds.size),
                            modifier = Modifier.tagged("contact-kind-$key"),
                        ) { Text(label) }
                    }
                }
                HintText(stringResource(R.string.weldbooks_contact_new_kind_help))
                if (isCompany) {
                    FormField(
                        stringResource(R.string.weldbooks_contact_new_company_name),
                        identity.companyName,
                        { text -> edit { it.copy(companyName = text) } },
                        placeholder = if (isUs) stringResource(R.string.weldbooks_examples_company_us) else stringResource(R.string.weldbooks_contact_new_company_name_placeholder),
                        error = if (identityProblem == "companyName") stringResource(R.string.weldbooks_contact_new_company_name_error) else null,
                        maxLength = ContactIdentityDraft.NAME_MAX,
                        tag = "contact-company-name",
                    )
                    FormField(
                        stringResource(R.string.weldbooks_contact_new_name_on_invoices),
                        identity.nameOnInvoices,
                        { text -> edit { it.copy(nameOnInvoices = text) } },
                        helper = stringResource(R.string.weldbooks_contact_new_name_on_invoices_help),
                        maxLength = ContactIdentityDraft.NAME_MAX,
                        tag = "contact-name-on-invoices",
                    )
                } else {
                    FormField(
                        stringResource(R.string.weldbooks_contact_new_first_name),
                        identity.firstName,
                        { text -> edit { it.copy(firstName = text) } },
                        placeholder = stringResource(R.string.weldbooks_contact_new_first_name_placeholder),
                        error = if (identityProblem == "personName") stringResource(R.string.weldbooks_contact_new_person_name_error) else null,
                        maxLength = ContactIdentityDraft.PERSON_NAME_MAX,
                        tag = "contact-first-name",
                    )
                    FormField(
                        stringResource(R.string.weldbooks_contact_new_last_name),
                        identity.lastName,
                        { text -> edit { it.copy(lastName = text) } },
                        placeholder = stringResource(R.string.weldbooks_contact_new_last_name_placeholder),
                        maxLength = ContactIdentityDraft.PERSON_NAME_MAX,
                        tag = "contact-last-name",
                    )
                }
                Dropdown(
                    stringResource(R.string.weldbooks_contact_new_role),
                    role,
                    listOf("customer", "supplier", "both").map { it to contactRoleLabel(it) },
                    { role = it },
                    tag = "contact-role",
                )
            }
            SectionCard(title = stringResource(R.string.weldbooks_contact_new_details)) {
                FormField(
                    stringResource(R.string.weldbooks_contact_new_email),
                    email,
                    { email = it },
                    placeholder = stringResource(if (isCompany) R.string.weldbooks_contact_new_email_placeholder else R.string.weldbooks_contact_new_email_placeholder_person),
                    keyboard = KeyboardType.Email,
                    tag = "contact-email",
                )
                FormField(
                    stringResource(R.string.weldbooks_contact_new_phone),
                    phone,
                    { phone = it },
                    placeholder = if (isUs) stringResource(R.string.weldbooks_examples_phone_us) else stringResource(R.string.weldbooks_contact_new_phone_placeholder),
                    keyboard = KeyboardType.Phone,
                    tag = "contact-phone",
                )
                // A person has no VAT or registration number; the server refuses one.
                if (!isUs && isCompany) {
                    FormField(books.labels.taxId, identity.taxId, { text -> edit { it.copy(taxId = text) } }, placeholder = books.labels.taxIdPlaceholder, tag = "contact-tax-id")
                }
            }
            if (isUs) {
                SectionCard(title = stringResource(R.string.weldbooks_contact_new_address)) {
                    AddressFields(address, {
                        address = it
                        addressProblems = UsAddressProblems()
                    }, addressProblems)
                }
            }
            Button(onClick = ::save, enabled = !submitting, modifier = Modifier.fillMaxWidth().padding(Tokens.Spacing.m).tagged("create-contact")) {
                Text(stringResource(R.string.weldbooks_contact_new_create))
            }
            BottomSpace()
        }
    }
}
