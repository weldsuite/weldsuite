package com.weldsuite.weldbooks.ui

import android.content.Intent
import android.graphics.pdf.PdfDocument
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Share
import androidx.compose.material.icons.outlined.Description
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material.icons.outlined.Payments
import androidx.compose.material.icons.automirrored.outlined.Send
import androidx.compose.material3.Button
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.FileProvider
import com.weldsuite.weldbooks.NewInvoice
import com.weldsuite.weldbooks.R
import com.weldsuite.weldbooks.TaxPreview
import com.weldsuite.weldbooks.logic.AddressDraft
import com.weldsuite.weldbooks.logic.Addresses
import com.weldsuite.weldbooks.logic.BooksTopics
import com.weldsuite.weldbooks.logic.CompanyForm
import com.weldsuite.weldbooks.logic.Days
import com.weldsuite.weldbooks.logic.Invoice
import com.weldsuite.weldbooks.logic.Jurisdictions
import com.weldsuite.weldbooks.logic.LineItems
import com.weldsuite.weldbooks.logic.Statuses
import com.weldsuite.weldbooks.logic.TaxBreakdown
import com.weldsuite.weldbooks.logic.TaxMode
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.weldsuite.core.LoadState
import org.weldsuite.ui.CenteredProgress
import org.weldsuite.ui.LoadErrorState
import org.weldsuite.ui.RealtimeRefresh
import org.weldsuite.ui.Tokens
import org.weldsuite.ui.tagged
import java.io.File

private enum class InvoiceConfirm { Delete, Cancel, CreditNote }

/** One invoice: its figures, the company fields it still needs, and the actions its status allows. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun InvoiceDetailScreen(id: String, onBack: () -> Unit, onOpenDocument: (String) -> Unit, onReplace: (String) -> Unit) {
    val books = LocalBooks.current
    val scope = rememberCoroutineScope()
    var state by remember { mutableStateOf(LoadState<Invoice>(loading = true)) }
    var refreshing by remember { mutableStateOf(false) }
    var menu by remember { mutableStateOf(false) }
    var paying by remember { mutableStateOf(false) }
    var editingCompany by remember { mutableStateOf(false) }
    var confirm by remember { mutableStateOf<InvoiceConfirm?>(null) }
    val mutations = rememberMutations()

    suspend fun load() {
        state = runCatching { books.repository.invoice(id) }.fold({ LoadState(it) }, { LoadState(state.data, error = it) })
        refreshing = false
    }
    LaunchedEffect(id) { load() }
    RealtimeRefresh(books.env, BooksTopics.invoices) { load() }

    val invoice = state.data
    BooksScaffold(
        title = invoice?.number ?: if (invoice?.isCreditNote == true) books.labels.creditNote else stringResource(R.string.weldbooks_invoice_detail_title),
        subtitle = invoice?.contactName,
        onBack = onBack,
        actions = {
            if (invoice != null) {
                IconButton(onClick = { onOpenDocument(invoice.id) }, modifier = Modifier.tagged("view-document")) {
                    Icon(Icons.Outlined.Description, contentDescription = stringResource(R.string.weldbooks_invoice_detail_view_document))
                }
                Box {
                    IconButton(onClick = { menu = true }, modifier = Modifier.tagged("invoice-actions")) {
                        Icon(Icons.Filled.MoreVert, contentDescription = stringResource(R.string.weldbooks_invoice_detail_more_actions))
                    }
                    DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                        val duplicated = stringResource(R.string.weldbooks_invoice_detail_duplicated)
                        DropdownMenuItem(text = { Text(stringResource(R.string.weldbooks_invoice_detail_duplicate)) }, onClick = {
                            menu = false
                            mutations.run(duplicated, reload = {}) { onReplace(books.repository.duplicateInvoice(invoice.id)) }
                        })
                        if (invoice.status == "draft") {
                            DropdownMenuItem(text = { Text(stringResource(R.string.weldbooks_invoice_detail_delete_draft), color = MaterialTheme.colorScheme.error) }, onClick = {
                                menu = false
                                confirm = InvoiceConfirm.Delete
                            })
                        } else if (invoice.status != "cancelled") {
                            DropdownMenuItem(text = { Text(stringResource(R.string.weldbooks_invoice_detail_create_credit_note, books.labels.creditNoteLower)) }, onClick = {
                                menu = false
                                confirm = InvoiceConfirm.CreditNote
                            })
                            DropdownMenuItem(text = { Text(stringResource(R.string.weldbooks_invoice_detail_cancel_invoice), color = MaterialTheme.colorScheme.error) }, onClick = {
                                menu = false
                                confirm = InvoiceConfirm.Cancel
                            })
                        }
                    }
                }
            }
        },
    ) { padding ->
        when {
            invoice == null && state.error != null -> LoadErrorState(state.error, onRetry = { scope.launch { load() } }, modifier = Modifier.padding(padding))
            invoice == null -> CenteredProgress(Modifier.padding(padding))
            else -> PullToRefreshBox(
                isRefreshing = refreshing,
                onRefresh = {
                    refreshing = true
                    // The company too: its fields may have been filled in on the web since.
                    scope.launch { books.entities.load() }
                    scope.launch { load() }
                },
                modifier = Modifier.padding(padding),
            ) {
                InvoiceBody(invoice, mutations, onPay = { paying = true }, onAddCompany = { editingCompany = true }, onOpenDocument = { onOpenDocument(invoice.id) }, reload = { load() })
            }
        }
    }

    if (invoice != null && paying) {
        val recorded = stringResource(R.string.weldbooks_invoice_detail_payment_recorded)
        PaymentSheet(invoice.balanceDue, invoice.currency ?: books.currency, received = true, busy = mutations.busy, onDismiss = { paying = false }) { payment ->
            paying = false
            mutations.run(recorded, reload = { load() }) { books.repository.recordInvoicePayment(invoice.id, payment) }
        }
    }
    if (editingCompany) EditCompanySheet(onDismiss = { editingCompany = false }, onSaved = { mutations.clear() })

    if (invoice != null) {
        when (confirm) {
            InvoiceConfirm.Delete -> {
                val deleted = stringResource(R.string.weldbooks_invoice_detail_deleted)
                val failed = stringResource(R.string.weldbooks_invoice_detail_delete_failed)
                ConfirmDialog(
                    stringResource(R.string.weldbooks_invoice_detail_delete_title),
                    stringResource(R.string.weldbooks_invoice_detail_delete_message),
                    stringResource(org.weldsuite.core.R.string.core_common_delete),
                    destructive = true,
                    onConfirm = {
                        confirm = null
                        mutations.remove(deleted, failed, onBack) { books.repository.deleteInvoice(invoice.id) }
                    },
                    onDismiss = { confirm = null },
                )
            }
            InvoiceConfirm.Cancel -> {
                val cancelled = stringResource(R.string.weldbooks_invoice_detail_cancelled)
                ConfirmDialog(
                    stringResource(R.string.weldbooks_invoice_detail_cancel_title),
                    stringResource(R.string.weldbooks_invoice_detail_cancel_message),
                    stringResource(R.string.weldbooks_invoice_detail_cancel_invoice),
                    destructive = true,
                    dismiss = stringResource(R.string.weldbooks_common_keep),
                    onConfirm = {
                        confirm = null
                        mutations.run(cancelled, reload = { load() }) { books.repository.cancelInvoice(invoice.id) }
                    },
                    onDismiss = { confirm = null },
                )
            }
            InvoiceConfirm.CreditNote -> {
                val created = stringResource(R.string.weldbooks_invoice_detail_credit_note_created, books.labels.creditNote)
                ConfirmDialog(
                    stringResource(R.string.weldbooks_invoice_detail_credit_note_title, books.labels.creditNoteLower),
                    stringResource(R.string.weldbooks_invoice_detail_credit_note_message),
                    stringResource(R.string.weldbooks_common_create),
                    onConfirm = {
                        confirm = null
                        mutations.run(created, reload = {}) { onReplace(books.repository.createCreditNote(invoice.id)) }
                    },
                    onDismiss = { confirm = null },
                )
            }
            null -> Unit
        }
    }
}

@Composable
private fun InvoiceBody(
    invoice: Invoice,
    mutations: Mutations,
    onPay: () -> Unit,
    onAddCompany: () -> Unit,
    onOpenDocument: () -> Unit,
    reload: suspend () -> Unit,
) {
    val books = LocalBooks.current
    val currency = invoice.currency ?: books.currency
    val status = invoice.displayStatus()
    val isDraft = invoice.status == "draft"
    val required = Jurisdictions.requiredInvoiceFields(books.code, books.jurisdictions)
    val companyMissing = CompanyForm.missingInvoiceFields(books.entity, required)
    val missingUsAddress = books.isUs && isDraft &&
        !AddressDraft.of(invoice.shippingAddress).isUsTaxable && !AddressDraft.of(invoice.billingAddress).isUsTaxable

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).tagged("invoice-detail")) {
        DocumentSummary(
            invoice.balanceDue, invoice.total, currency, invoice.dueDate, status,
            stringResource(R.string.weldbooks_invoice_detail_balance_due), stringResource(R.string.weldbooks_invoice_detail_total), isInvoice = true,
        )
        if (missingUsAddress) Banner(stringResource(R.string.weldbooks_invoice_detail_address_missing), tone = "warning")
        val rejected = mutations.missingFields
        if (isDraft && companyMissing.isNotEmpty() && rejected.isEmpty()) {
            Banner(stringResource(R.string.weldbooks_invoice_detail_company_fields_missing, invoiceFieldNames(companyMissing)), tone = "warning")
            OutlinedButton(onClick = onAddCompany, modifier = Modifier.padding(horizontal = Tokens.Spacing.l).tagged("add-company-details")) {
                Text(stringResource(R.string.weldbooks_invoice_detail_add_company_details))
            }
        }
        mutations.error?.let { error ->
            Banner(
                if (rejected.isNotEmpty()) stringResource(R.string.weldbooks_invoice_detail_company_fields_rejected, invoiceFieldNames(rejected)) else error,
                tone = "error",
                title = stringResource(R.string.weldbooks_invoice_detail_finalise_failed),
                onClose = { mutations.clear() },
            )
            if (rejected.isNotEmpty()) {
                OutlinedButton(onClick = onAddCompany, modifier = Modifier.padding(horizontal = Tokens.Spacing.l)) {
                    Text(stringResource(R.string.weldbooks_invoice_detail_add_company_details))
                }
            }
        }
        SectionCard(title = stringResource(R.string.weldbooks_invoice_detail_details)) {
            if (invoice.isCreditNote) DetailRow(stringResource(R.string.weldbooks_invoice_detail_document_type), books.labels.creditNote)
            DetailRow(stringResource(R.string.weldbooks_invoice_detail_customer), invoice.contactName ?: stringResource(R.string.weldbooks_common_dash))
            invoice.contactEmail?.let { DetailRow(stringResource(R.string.weldbooks_invoice_detail_email), it) }
            DetailRow(stringResource(R.string.weldbooks_invoice_detail_issue_date), books.date(invoice.issueDate))
            DetailRow(stringResource(R.string.weldbooks_invoice_detail_due_date), books.date(invoice.dueDate))
            invoice.reference?.let { DetailRow(stringResource(R.string.weldbooks_invoice_detail_reference), it) }
            if (books.isUs) {
                val shipTo = Addresses.lines(invoice.shippingAddress)
                val billTo = Addresses.lines(invoice.billingAddress)
                if (shipTo.isNotEmpty()) DetailRow(stringResource(R.string.weldbooks_invoice_detail_ship_to), shipTo.joinToString("\n"))
                if (billTo.isNotEmpty() && billTo != shipTo) DetailRow(stringResource(R.string.weldbooks_invoice_detail_bill_to), billTo.joinToString("\n"))
            }
        }
        DocumentLines(invoice.lines, currency, stringResource(R.string.weldbooks_invoice_detail_line_items), isInvoice = true)
        DocumentTotals(invoice.subtotal, invoice.taxTotal, invoice.total, invoice.amountPaid, invoice.balanceDue, currency, books.labels.tax, invoice.taxBreakdown, isInvoice = true)
        if (books.isUs) {
            TaxBreakdownCard(invoice.taxBreakdown, invoice.taxWarnings, currency, initiallyExpanded = isDraft)
        } else if (TaxBreakdown.hasTreatments(invoice.taxBreakdown)) {
            TreatmentBreakdownCard(invoice.taxBreakdown, currency)
        }
        invoice.notes?.let { notes ->
            SectionCard(title = stringResource(R.string.weldbooks_invoice_detail_notes)) {
                Text(notes, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        val canSend = !isDraft && !Statuses.invoiceIsSettled(invoice.status)
        val canPay = invoice.balanceDue.signum() > 0 && !isDraft && invoice.status != "cancelled"
        val finalised = stringResource(R.string.weldbooks_invoice_detail_finalised)
        val sent = stringResource(R.string.weldbooks_invoice_detail_sent)
        Column(Modifier.padding(Tokens.Spacing.m), verticalArrangement = Arrangement.spacedBy(Tokens.Spacing.s)) {
            if (isDraft) {
                Button(onClick = { mutations.run(finalised, reload) { books.repository.finalizeInvoice(invoice.id) } }, enabled = !mutations.busy, modifier = Modifier.fillMaxWidth().tagged("finalise-invoice")) {
                    Icon(Icons.Outlined.Lock, contentDescription = null)
                    Text(stringResource(R.string.weldbooks_invoice_detail_finalise), modifier = Modifier.padding(start = Tokens.Spacing.s))
                }
            }
            if (canSend) {
                OutlinedButton(onClick = { mutations.run(sent, reload) { books.repository.sendInvoice(invoice.id) } }, enabled = !mutations.busy, modifier = Modifier.fillMaxWidth().tagged("send-invoice")) {
                    Icon(Icons.AutoMirrored.Outlined.Send, contentDescription = null)
                    Text(stringResource(R.string.weldbooks_invoice_detail_send), modifier = Modifier.padding(start = Tokens.Spacing.s))
                }
            }
            if (canPay) {
                Button(onClick = onPay, enabled = !mutations.busy, modifier = Modifier.fillMaxWidth().tagged("record-payment")) {
                    Icon(Icons.Outlined.Payments, contentDescription = null)
                    Text(stringResource(R.string.weldbooks_invoice_detail_record_payment), modifier = Modifier.padding(start = Tokens.Spacing.s))
                }
            }
            TextButton(onClick = onOpenDocument, modifier = Modifier.fillMaxWidth()) {
                Icon(Icons.Outlined.Description, contentDescription = null)
                Text(stringResource(R.string.weldbooks_invoice_detail_view_document), modifier = Modifier.padding(start = Tokens.Spacing.s))
            }
        }
        BottomSpace()
    }
}

/** The printable invoice (HTML from the server), with sharing as a PDF. */
@Composable
fun InvoiceDocumentScreen(id: String, onBack: () -> Unit) {
    val books = LocalBooks.current
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val notify = LocalNotify.current
    var state by remember { mutableStateOf(LoadState<String>(loading = true)) }
    var webView by remember { mutableStateOf<WebView?>(null) }
    val shareFailed = stringResource(R.string.weldbooks_invoice_document_share_failed)
    val shareTitle = stringResource(R.string.weldbooks_invoice_document_share)

    suspend fun load() {
        state = runCatching { books.repository.invoiceDocument(id) }.fold({ LoadState(it) }, { LoadState(error = it) })
    }
    LaunchedEffect(id) { load() }

    BooksScaffold(
        title = stringResource(R.string.weldbooks_invoice_document_title),
        onBack = onBack,
        actions = {
            val view = webView
            if (state.data != null && view != null) {
                IconButton(
                    onClick = {
                        scope.launch {
                            runCatching {
                                val file = File(File(context.cacheDir, "shared").apply { mkdirs() }, "invoice-$id.pdf")
                                writePdf(view, file)
                                val uri = FileProvider.getUriForFile(context, "${context.packageName}.files", file)
                                val send = Intent(Intent.ACTION_SEND).apply {
                                    type = "application/pdf"
                                    putExtra(Intent.EXTRA_STREAM, uri)
                                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                                }
                                context.startActivity(Intent.createChooser(send, shareTitle))
                            }.onFailure { notify(shareFailed) }
                        }
                    },
                    modifier = Modifier.tagged("share-document"),
                ) { Icon(Icons.Filled.Share, contentDescription = stringResource(R.string.weldbooks_invoice_document_share_pdf)) }
            }
        },
    ) { padding ->
        val html = state.data
        when {
            html != null -> AndroidView(
                factory = { ctx ->
                    WebView(ctx).apply {
                        // The document is our own markup without scripts; it may not navigate anywhere.
                        settings.javaScriptEnabled = false
                        webViewClient = object : WebViewClient() {
                            override fun shouldOverrideUrlLoading(view: WebView, request: android.webkit.WebResourceRequest): Boolean = true
                        }
                        setBackgroundColor(android.graphics.Color.WHITE)
                        loadDataWithBaseURL(null, html, "text/html", "utf-8", null)
                        webView = this
                    }
                },
                modifier = Modifier.fillMaxSize().padding(padding).tagged("invoice-document"),
            )
            state.error != null -> Column(Modifier.padding(padding)) {
                Banner(stringResource(R.string.weldbooks_invoice_document_load_error), tone = "error")
                LoadErrorState(state.error, onRetry = { scope.launch { load() } })
            }
            else -> Column(Modifier.fillMaxSize().padding(padding)) {
                CenteredProgress()
            }
        }
    }
}

/** Draws the rendered document onto A4 pages. */
private suspend fun writePdf(view: WebView, file: File) {
    val pageWidth = 595
    val pageHeight = 842
    val width = view.width.coerceAtLeast(1)
    val height = (view.contentHeight * view.resources.displayMetrics.density).toInt().coerceAtLeast(view.height)
    val scale = pageWidth.toFloat() / width
    val slice = (pageHeight / scale).toInt().coerceAtLeast(1)
    val document = PdfDocument()
    try {
        var top = 0
        var number = 1
        while (top < height) {
            val page = document.startPage(PdfDocument.PageInfo.Builder(pageWidth, pageHeight, number++).create())
            page.canvas.scale(scale, scale)
            page.canvas.translate(0f, -top.toFloat())
            view.draw(page.canvas)
            document.finishPage(page)
            top += slice
        }
        withContext(Dispatchers.IO) { file.outputStream().use { document.writeTo(it) } }
    } finally {
        document.close()
    }
}

/**
 * A new draft invoice. The server numbers it now and books it on finalise. A US
 * invoice asks where the goods go and takes a tax code per line; the form
 * previews the server's sales tax as it is typed.
 */
@Composable
fun InvoiceFormScreen(onBack: () -> Unit, onCreated: (String) -> Unit) {
    val books = LocalBooks.current
    val notify = LocalNotify.current
    val errors = LocalErrors.current
    val scope = rememberCoroutineScope()
    val isUs = books.isUs
    val mode = TaxMode.of(isUs, isInvoice = true)
    val defaultRate = Jurisdictions.defaultTaxRate(books.code)

    var name by rememberSaveable { mutableStateOf("") }
    var email by rememberSaveable { mutableStateOf("") }
    var issueDate by remember { mutableStateOf(Days.today()) }
    var dueDate by remember { mutableStateOf(Days.today().plusDays(30)) }
    var lines by remember { mutableStateOf(listOf(LineItems.empty(defaultRate))) }
    var shipTo by remember { mutableStateOf(AddressDraft()) }
    var billSame by rememberSaveable { mutableStateOf(true) }
    var billTo by remember { mutableStateOf(AddressDraft()) }
    var notes by rememberSaveable { mutableStateOf("") }
    var reference by rememberSaveable { mutableStateOf("") }
    var saving by remember { mutableStateOf(false) }
    var nameError by remember { mutableStateOf<String?>(null) }
    var itemsError by remember { mutableStateOf<String?>(null) }
    var dueError by remember { mutableStateOf<String?>(null) }
    var shipProblems by remember { mutableStateOf(com.weldsuite.weldbooks.logic.UsAddressProblems()) }
    var billProblems by remember { mutableStateOf(com.weldsuite.weldbooks.logic.UsAddressProblems()) }
    var preview by remember { mutableStateOf<TaxPreview?>(null) }
    var previewState by remember { mutableStateOf("idle") }
    val billing = if (billSame) shipTo else billTo

    // US: the sales tax the server would charge, once there is something to tax and a place to tax it.
    LaunchedEffect(isUs, lines, shipTo, billing, issueDate, name) {
        if (!isUs) return@LaunchedEffect
        val inputs = LineItems.inputs(lines, mode, books.decimalPoint)
        if (inputs.isEmpty() || !shipTo.isUsTaxable) {
            preview = null
            previewState = "idle"
            return@LaunchedEffect
        }
        previewState = "loading"
        delay(800)
        runCatching {
            books.repository.previewSalesTax(name, issueDate.toString(), Addresses.usAddress(shipTo), Addresses.usAddress(billing), inputs)
        }.onSuccess {
            preview = it
            previewState = "ready"
        }.onFailure { previewState = "failed" }
    }

    val texts = InvoiceFormTexts(
        nameError = stringResource(R.string.weldbooks_invoice_new_name_error),
        itemsError = stringResource(R.string.weldbooks_invoice_new_items_error),
        dueError = stringResource(R.string.weldbooks_invoice_new_due_before_issue),
        created = stringResource(R.string.weldbooks_invoice_new_created),
        failed = stringResource(R.string.weldbooks_invoice_new_create_failed),
    )

    fun save() {
        nameError = if (name.isBlank()) texts.nameError else null
        itemsError = if (LineItems.valid(lines, books.decimalPoint).isEmpty()) texts.itemsError else null
        dueError = if (dueDate < issueDate) texts.dueError else null
        if (isUs) {
            shipProblems = Addresses.usProblems(shipTo, requireStateAndZip = true)
            billProblems = if (billSame) com.weldsuite.weldbooks.logic.UsAddressProblems() else Addresses.usProblems(billTo)
        }
        if (nameError != null || itemsError != null || dueError != null || !shipProblems.isEmpty && isUs || !billProblems.isEmpty && isUs) return
        saving = true
        scope.launch {
            runCatching {
                books.repository.createInvoice(
                    NewInvoice(
                        contactName = name.trim(),
                        contactEmail = email.trim().ifEmpty { null },
                        issueDate = issueDate.toString(),
                        dueDate = dueDate.toString(),
                        notes = notes.trim().ifEmpty { null },
                        reference = reference.trim().ifEmpty { null },
                        shippingAddress = if (isUs) Addresses.usAddress(shipTo) else null,
                        billingAddress = if (isUs) Addresses.usAddress(billing) else null,
                        lines = LineItems.inputs(lines, mode, books.decimalPoint),
                    ),
                )
            }.onSuccess {
                notify(texts.created)
                onCreated(it)
            }.onFailure { notify(errors.describe(it, texts.failed)) }
            saving = false
        }
    }

    BooksScaffold(title = stringResource(R.string.weldbooks_invoice_new_title), onBack = onBack) { padding ->
        Column(Modifier.padding(padding).fillMaxSize().imePadding().verticalScroll(rememberScrollState()).tagged("invoice-form")) {
            SectionCard(title = stringResource(R.string.weldbooks_invoice_new_customer)) {
                FormField(
                    stringResource(R.string.weldbooks_invoice_new_name),
                    name,
                    {
                        name = it
                        nameError = null
                    },
                    placeholder = if (isUs) stringResource(R.string.weldbooks_examples_company_us) else stringResource(R.string.weldbooks_invoice_new_name_placeholder),
                    error = nameError,
                    helper = stringResource(R.string.weldbooks_invoice_new_name_hint),
                    tag = "invoice-customer",
                )
                FormField(stringResource(R.string.weldbooks_invoice_new_email), email, { email = it }, placeholder = stringResource(R.string.weldbooks_invoice_new_email_placeholder), keyboard = KeyboardType.Email, tag = "invoice-email")
            }
            if (isUs) {
                SectionCard(title = stringResource(R.string.weldbooks_invoice_new_ship_to)) {
                    HintText(stringResource(R.string.weldbooks_invoice_new_ship_to_hint))
                    AddressFields(shipTo, {
                        shipTo = it
                        shipProblems = com.weldsuite.weldbooks.logic.UsAddressProblems()
                    }, shipProblems)
                    SwitchRow(stringResource(R.string.weldbooks_invoice_new_bill_to_same), billSame, { billSame = it })
                }
                if (!billSame) {
                    SectionCard(title = stringResource(R.string.weldbooks_invoice_new_bill_to)) {
                        AddressFields(billTo, {
                            billTo = it
                            billProblems = com.weldsuite.weldbooks.logic.UsAddressProblems()
                        }, billProblems)
                    }
                }
            }
            SectionCard(title = stringResource(R.string.weldbooks_invoice_new_dates)) {
                DateField(stringResource(R.string.weldbooks_invoice_new_issue_date), issueDate, {
                    issueDate = it
                    dueError = null
                }, tag = "invoice-issue-date")
                DateField(stringResource(R.string.weldbooks_invoice_new_due_date), dueDate, {
                    dueDate = it
                    dueError = null
                }, error = dueError, tag = "invoice-due-date")
            }
            LineItemsEditor(
                lines = lines,
                onChange = {
                    lines = it
                    itemsError = null
                },
                mode = mode,
                defaultTaxRate = defaultRate,
                currency = books.currency,
                error = itemsError,
                serverTax = if (isUs) ServerTax(preview?.taxTotal ?: java.math.BigDecimal.ZERO, preview?.total ?: java.math.BigDecimal.ZERO, previewState != "ready") else null,
            )
            if (isUs) {
                when (previewState) {
                    "idle" -> Text(
                        stringResource(R.string.weldbooks_sales_tax_needs_address),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(horizontal = Tokens.Spacing.l),
                    )
                    "loading" -> Banner(stringResource(R.string.weldbooks_sales_tax_calculating))
                    "failed" -> Banner(stringResource(R.string.weldbooks_sales_tax_preview_failed), tone = "warning")
                    else -> preview?.let { TaxBreakdownCard(it.taxBreakdown, it.warnings, books.currency, footnote = stringResource(R.string.weldbooks_sales_tax_estimate_note)) }
                }
            }
            SectionCard(title = stringResource(R.string.weldbooks_invoice_new_extras)) {
                FormField(stringResource(R.string.weldbooks_invoice_new_notes), notes, { notes = it }, placeholder = stringResource(R.string.weldbooks_invoice_new_notes_placeholder), singleLine = false, minLines = 3)
                FormField(stringResource(R.string.weldbooks_invoice_new_reference), reference, { reference = it }, placeholder = stringResource(R.string.weldbooks_invoice_new_reference_placeholder))
            }
            Button(onClick = ::save, enabled = !saving, modifier = Modifier.fillMaxWidth().padding(Tokens.Spacing.m).tagged("create-invoice")) {
                Text(stringResource(R.string.weldbooks_invoice_new_create_draft))
            }
            BottomSpace()
        }
    }
}

private data class InvoiceFormTexts(val nameError: String, val itemsError: String, val dueError: String, val created: String, val failed: String)
