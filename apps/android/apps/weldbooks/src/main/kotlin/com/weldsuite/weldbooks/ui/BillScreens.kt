package com.weldsuite.weldbooks.ui

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Payments
import androidx.compose.material.icons.outlined.PictureAsPdf
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.weldsuite.weldbooks.LocalFile
import com.weldsuite.weldbooks.NewBill
import com.weldsuite.weldbooks.OfflineQueue
import com.weldsuite.weldbooks.R
import com.weldsuite.weldbooks.logic.AddressDraft
import com.weldsuite.weldbooks.logic.Addresses
import com.weldsuite.weldbooks.logic.Bill
import com.weldsuite.weldbooks.logic.BooksTopics
import com.weldsuite.weldbooks.logic.Days
import com.weldsuite.weldbooks.logic.Jurisdictions
import com.weldsuite.weldbooks.logic.LineItems
import com.weldsuite.weldbooks.logic.Statuses
import com.weldsuite.weldbooks.logic.TaxBreakdown
import com.weldsuite.weldbooks.logic.TaxMode
import com.weldsuite.weldbooks.logic.UsAddressProblems
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.weldsuite.core.LoadState
import org.weldsuite.ui.CenteredProgress
import org.weldsuite.ui.LoadErrorState
import org.weldsuite.ui.RealtimeRefresh
import org.weldsuite.ui.Tokens
import org.weldsuite.ui.tagged
import java.io.File
import java.time.LocalDate

/** A receipt image, as a thumbnail that opens full screen. [loading] while it is fetched; [pdf] for a document that has no image. */
@Composable
fun ReceiptPreview(bitmap: Bitmap?, loading: Boolean = false, pdf: Boolean = false, failed: Boolean = false) {
    if (bitmap == null && !loading && !pdf && !failed) return
    var open by remember { mutableStateOf(false) }
    SectionCard(title = stringResource(R.string.weldbooks_receipt_title)) {
        Box(
            Modifier.fillMaxWidth().height(160.dp).background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(Tokens.Radius.medium))
                .let { if (bitmap != null) it.clickable { open = true } else it }
                .tagged("receipt-preview"),
            contentAlignment = Alignment.Center,
        ) {
            when {
                bitmap != null -> Image(bitmap.asImageBitmap(), contentDescription = stringResource(R.string.weldbooks_receipt_open), contentScale = ContentScale.Fit, modifier = Modifier.fillMaxSize())
                loading -> CircularProgressIndicator()
                pdf -> Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Icon(Icons.Outlined.PictureAsPdf, contentDescription = null)
                    Text(stringResource(R.string.weldbooks_receipt_pdf), style = MaterialTheme.typography.bodySmall)
                }
                else -> Text(stringResource(R.string.weldbooks_receipt_unavailable), style = MaterialTheme.typography.bodySmall)
            }
        }
    }
    if (open && bitmap != null) {
        Dialog(onDismissRequest = { open = false }, properties = DialogProperties(usePlatformDefaultWidth = false)) {
            Box(Modifier.fillMaxSize().background(Color.Black)) {
                Image(bitmap.asImageBitmap(), contentDescription = null, contentScale = ContentScale.Fit, modifier = Modifier.fillMaxSize())
                IconButton(onClick = { open = false }, modifier = Modifier.align(Alignment.TopEnd).padding(Tokens.Spacing.l)) {
                    Icon(Icons.Filled.Close, contentDescription = stringResource(R.string.weldbooks_receipt_close), tint = Color.White)
                }
            }
        }
    }
}

/** A photo kept on this phone (a scan not stored yet), decoded for the preview. */
@Composable
fun LocalReceiptPreview(path: String?, mimeType: String?) {
    if (path == null) return
    val bitmap by produceState<Bitmap?>(null, path) {
        value = withContext(Dispatchers.IO) { runCatching { BitmapFactory.decodeFile(path) }.getOrNull() }
    }
    ReceiptPreview(bitmap, loading = bitmap == null && mimeType?.startsWith("image/") != false, pdf = mimeType == "application/pdf")
}

/** The receipt a bill was booked from, read from storage with the member's own token. */
@Composable
fun StoredReceiptPreview(documentId: String?) {
    if (documentId == null) return
    val books = LocalBooks.current
    var state by remember(documentId) { mutableStateOf<Pair<Bitmap?, Boolean>>(null to true) }
    LaunchedEffect(documentId) {
        val file = runCatching { books.repository.storedReceipt(documentId) }.getOrNull()
        val bitmap = file?.let { withContext(Dispatchers.Default) { BitmapFactory.decodeByteArray(it.bytes, 0, it.bytes.size) } }
        state = bitmap to false
    }
    val (bitmap, loading) = state
    if (bitmap != null || loading) ReceiptPreview(bitmap, loading = loading)
}

private enum class BillConfirm { Reject, Delete }

/** One bill: approve or reject it while it awaits approval, record its payment once approved. */
@OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
@Composable
fun BillDetailScreen(id: String, onBack: () -> Unit) {
    val books = LocalBooks.current
    val scope = rememberCoroutineScope()
    var state by remember { mutableStateOf(LoadState<Bill>(loading = true)) }
    var refreshing by remember { mutableStateOf(false) }
    var paying by remember { mutableStateOf(false) }
    var confirm by remember { mutableStateOf<BillConfirm?>(null) }
    val mutations = rememberMutations()

    suspend fun load() {
        state = runCatching { books.repository.bill(id) }.fold({ LoadState(it) }, { LoadState(state.data, error = it) })
        refreshing = false
    }
    LaunchedEffect(id) { load() }
    RealtimeRefresh(books.env, BooksTopics.bills) { load() }

    val bill = state.data
    BooksScaffold(
        title = bill?.number ?: stringResource(R.string.weldbooks_bill_detail_title),
        subtitle = bill?.contactName,
        onBack = onBack,
        actions = {
            if (bill != null && Statuses.billAwaitsApproval(bill)) {
                IconButton(onClick = { confirm = BillConfirm.Delete }, modifier = Modifier.tagged("delete-bill")) {
                    Icon(Icons.Outlined.Delete, contentDescription = stringResource(R.string.weldbooks_bill_detail_delete_bill), tint = MaterialTheme.colorScheme.error)
                }
            }
        },
    ) { padding ->
        when {
            bill == null && state.error != null -> LoadErrorState(state.error, onRetry = { scope.launch { load() } }, modifier = Modifier.padding(padding))
            bill == null -> CenteredProgress(Modifier.padding(padding))
            else -> PullToRefreshBox(isRefreshing = refreshing, onRefresh = {
                refreshing = true
                scope.launch { load() }
            }, modifier = Modifier.padding(padding)) {
                BillBody(bill, mutations, onPay = { paying = true }, onReject = { confirm = BillConfirm.Reject }, reload = { load() })
            }
        }
    }

    if (bill != null && paying) {
        val recorded = stringResource(R.string.weldbooks_bill_detail_payment_recorded)
        PaymentSheet(bill.balanceDue, bill.currency ?: books.currency, received = false, busy = mutations.busy, onDismiss = { paying = false }) { payment ->
            paying = false
            mutations.run(recorded, reload = { load() }) { books.repository.recordBillPayment(bill.id, payment) }
        }
    }
    if (bill != null) {
        when (confirm) {
            BillConfirm.Reject -> {
                val rejected = stringResource(R.string.weldbooks_bill_detail_rejected)
                val reason = stringResource(R.string.weldbooks_bill_detail_reject_message)
                ConfirmDialog(
                    stringResource(R.string.weldbooks_bill_detail_reject_title),
                    reason,
                    stringResource(R.string.weldbooks_bill_detail_reject),
                    destructive = true,
                    onConfirm = {
                        confirm = null
                        mutations.run(rejected, reload = { load() }) { books.repository.rejectBill(bill.id, "Rejected from the WeldBooks mobile app") }
                    },
                    onDismiss = { confirm = null },
                )
            }
            BillConfirm.Delete -> {
                val deleted = stringResource(R.string.weldbooks_bill_detail_deleted)
                val failed = stringResource(R.string.weldbooks_bill_detail_delete_failed)
                ConfirmDialog(
                    stringResource(R.string.weldbooks_bill_detail_delete_title),
                    stringResource(R.string.weldbooks_bill_detail_delete_message),
                    stringResource(org.weldsuite.core.R.string.core_common_delete),
                    destructive = true,
                    onConfirm = {
                        confirm = null
                        mutations.remove(deleted, failed, onBack) { books.repository.deleteBill(bill.id) }
                    },
                    onDismiss = { confirm = null },
                )
            }
            null -> Unit
        }
    }
}

@Composable
private fun BillBody(bill: Bill, mutations: Mutations, onPay: () -> Unit, onReject: () -> Unit, reload: suspend () -> Unit) {
    val books = LocalBooks.current
    val currency = bill.currency ?: books.currency
    // US: the vendor's tax is part of the cost; use tax accrued where it charged none is owed to the state.
    val useTax = if (books.isUs) TaxBreakdown.useTaxTotal(bill.taxBreakdown) else java.math.BigDecimal.ZERO
    val approved = stringResource(R.string.weldbooks_bill_detail_approved)
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).tagged("bill-detail")) {
        DocumentSummary(
            bill.balanceDue, bill.total, currency, bill.dueDate, bill.displayStatus(),
            stringResource(R.string.weldbooks_bill_detail_balance_due), stringResource(R.string.weldbooks_bill_detail_total), isInvoice = false,
        )
        mutations.error?.let { Banner(it, tone = "error", onClose = { mutations.clear() }) }
        SectionCard(title = stringResource(R.string.weldbooks_bill_detail_details)) {
            DetailRow(books.labels.supplier, bill.contactName ?: stringResource(R.string.weldbooks_common_dash))
            DetailRow(stringResource(R.string.weldbooks_bill_detail_issue_date), books.date(bill.issueDate))
            DetailRow(stringResource(R.string.weldbooks_bill_detail_due_date), books.date(bill.dueDate))
            bill.reference?.let { DetailRow(stringResource(R.string.weldbooks_bill_detail_reference), it) }
            if (books.isUs) {
                val delivered = Addresses.lines(bill.deliveryAddress)
                if (delivered.isNotEmpty()) DetailRow(stringResource(R.string.weldbooks_bill_detail_delivered_to), delivered.joinToString("\n"))
            }
        }
        StoredReceiptPreview(bill.sourceDocumentId)
        DocumentLines(bill.lines, currency, stringResource(R.string.weldbooks_bill_detail_line_items), isInvoice = false)
        DocumentTotals(
            bill.subtotal, bill.taxTotal, bill.total, bill.amountPaid, bill.balanceDue, currency,
            taxLabel = if (books.isUs) stringResource(R.string.weldbooks_bill_detail_tax_paid, books.labels.tax) else books.labels.tax,
            taxBreakdown = bill.taxBreakdown,
            isInvoice = false,
            extraRows = if (useTax.signum() > 0) listOf(stringResource(R.string.weldbooks_sales_tax_use_tax_accrued) to books.money(useTax, currency)) else emptyList(),
        )
        if (!books.isUs && TaxBreakdown.hasTreatments(bill.taxBreakdown)) TreatmentBreakdownCard(bill.taxBreakdown, currency)
        if (useTax.signum() > 0) {
            TaxBreakdownCard(
                bill.taxBreakdown, emptyList(), currency,
                title = stringResource(R.string.weldbooks_sales_tax_use_tax_accrued),
                footnote = stringResource(R.string.weldbooks_bill_detail_use_tax_hint, books.labels.supplierLower),
            )
        }
        bill.notes?.let { notes ->
            SectionCard(title = stringResource(R.string.weldbooks_bill_detail_notes)) {
                Text(notes, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        Column(Modifier.padding(Tokens.Spacing.m), verticalArrangement = Arrangement.spacedBy(Tokens.Spacing.s)) {
            if (Statuses.billAwaitsApproval(bill)) {
                Button(onClick = { mutations.run(approved, reload) { books.repository.approveBill(bill.id) } }, enabled = !mutations.busy, modifier = Modifier.fillMaxWidth().tagged("approve-bill")) {
                    Icon(Icons.Outlined.Check, contentDescription = null)
                    Text(stringResource(R.string.weldbooks_bill_detail_approve), modifier = Modifier.padding(start = Tokens.Spacing.s))
                }
                OutlinedButton(onClick = onReject, enabled = !mutations.busy, modifier = Modifier.fillMaxWidth().tagged("reject-bill")) {
                    Icon(Icons.Filled.Close, contentDescription = null, tint = MaterialTheme.colorScheme.error)
                    Text(stringResource(R.string.weldbooks_bill_detail_reject), modifier = Modifier.padding(start = Tokens.Spacing.s))
                }
            }
            if (Statuses.billIsPayable(bill)) {
                Button(onClick = onPay, enabled = !mutations.busy, modifier = Modifier.fillMaxWidth().tagged("record-bill-payment")) {
                    Icon(Icons.Outlined.Payments, contentDescription = null)
                    Text(stringResource(R.string.weldbooks_bill_detail_record_payment), modifier = Modifier.padding(start = Tokens.Spacing.s))
                }
            }
        }
        BottomSpace()
    }
}

/**
 * A new bill, filled in from a scanned receipt when there is one. The receipt
 * stays attached as the bill's source document; a photo kept on the phone is
 * stored first.
 */
@Composable
fun BillFormScreen(documentId: String?, receipt: String?, receiptType: String?, onBack: () -> Unit, onCreated: (String) -> Unit) {
    val books = LocalBooks.current
    val notify = LocalNotify.current
    val errors = LocalErrors.current
    val scope = rememberCoroutineScope()
    val isUs = books.isUs
    val mode = TaxMode.of(isUs, isInvoice = false)
    val defaultRate = Jurisdictions.defaultTaxRate(books.code)

    var name by rememberSaveable { mutableStateOf("") }
    var number by rememberSaveable { mutableStateOf("") }
    var issueDate by remember { mutableStateOf(Days.today()) }
    var dueDate by remember { mutableStateOf(Days.today().plusDays(30)) }
    var lines by remember { mutableStateOf(listOf(LineItems.empty(defaultRate))) }
    var deliveredTo by remember { mutableStateOf(AddressDraft()) }
    var deliveredProblems by remember { mutableStateOf(UsAddressProblems()) }
    var notes by rememberSaveable { mutableStateOf("") }
    var reference by rememberSaveable { mutableStateOf("") }
    var saving by remember { mutableStateOf(false) }
    var ocr by remember { mutableStateOf(if (documentId != null) "loading" else "idle") }
    var scanned by remember { mutableStateOf<Triple<String?, String?, String?>?>(null) }
    var nameError by remember { mutableStateOf<String?>(null) }
    var itemsError by remember { mutableStateOf<String?>(null) }
    var dueError by remember { mutableStateOf<String?>(null) }
    val accruesUseTax = isUs && lines.any { it.accrueUseTax }

    LaunchedEffect(documentId) {
        val id = documentId ?: return@LaunchedEffect
        runCatching { books.repository.billFromDocument(id) }
            .onSuccess { prefill ->
                prefill.contactName?.let { name = it }
                prefill.externalReference?.let { reference = it }
                val issued = prefill.issueDate?.let(Days::of)
                val due = prefill.dueDate?.let(Days::of)
                if (issued != null) {
                    issueDate = issued
                    dueDate = due ?: issued.plusDays(30)
                } else if (due != null) {
                    dueDate = due
                }
                if (prefill.items.isNotEmpty()) lines = LineItems.fromPrefill(prefill, defaultRate)
                // The supplier OCR matched (by VAT number, KvK or IBAN) and the receipt's currency.
                scanned = Triple(prefill.contactName, prefill.matchedContactId, prefill.currency)
                ocr = "ready"
            }
            .onFailure { ocr = "failed" }
    }

    val nameErrorText = stringResource(R.string.weldbooks_bill_new_name_error, books.labels.supplierLower)
    val itemsErrorText = stringResource(R.string.weldbooks_bill_new_items_error)
    val dueErrorText = stringResource(R.string.weldbooks_bill_new_due_before_issue)
    val created = stringResource(R.string.weldbooks_bill_new_created)
    val failed = stringResource(R.string.weldbooks_bill_new_create_failed)

    fun save() {
        nameError = if (name.isBlank()) nameErrorText else null
        itemsError = if (LineItems.valid(lines, books.decimalPoint).isEmpty()) itemsErrorText else null
        dueError = if (dueDate < issueDate) dueErrorText else null
        // Use tax is rated where the goods were delivered; blank means the company address.
        deliveredProblems = if (accruesUseTax) Addresses.usProblems(deliveredTo) else UsAddressProblems()
        if (nameError != null || itemsError != null || dueError != null || !deliveredProblems.isEmpty) return
        saving = true
        scope.launch {
            runCatching {
                val match = scanned
                val sameSupplier = match?.second != null && name.trim() == match.first?.trim()
                var sourceDocumentId = documentId
                // A photo scanned offline (or whose upload failed) is stored now, so the bill links it.
                if (sourceDocumentId == null && receipt != null) {
                    val bytes = withContext(Dispatchers.IO) { File(receipt).takeIf { it.exists() }?.readBytes() }
                    if (bytes != null) {
                        val type = receiptType ?: "image/jpeg"
                        sourceDocumentId = books.repository.uploadReceipt(LocalFile(bytes, OfflineQueue.receiptFileName(type), type))
                    }
                }
                books.repository.createBill(
                    NewBill(
                        contactId = if (sameSupplier) match?.second else null,
                        contactName = name.trim(),
                        billNumber = number.trim().ifEmpty { null },
                        currency = match?.third,
                        issueDate = issueDate.toString(),
                        dueDate = dueDate.toString(),
                        notes = notes.trim().ifEmpty { null },
                        reference = reference.trim().ifEmpty { null },
                        sourceDocumentId = sourceDocumentId,
                        deliveryAddress = if (accruesUseTax) Addresses.usAddress(deliveredTo) else null,
                        lines = LineItems.inputs(lines, mode, books.decimalPoint),
                    ),
                )
            }.onSuccess {
                notify(created)
                onCreated(it)
            }.onFailure { notify(errors.describe(it, failed)) }
            saving = false
        }
    }

    BooksScaffold(title = stringResource(R.string.weldbooks_bill_new_title), onBack = onBack) { padding ->
        Column(Modifier.padding(padding).fillMaxSize().imePadding().verticalScroll(rememberScrollState()).tagged("bill-form")) {
            when (ocr) {
                "loading" -> Banner(stringResource(R.string.weldbooks_bill_new_ocr_loading))
                "ready" -> Banner(stringResource(R.string.weldbooks_bill_new_ocr_ready), tone = "success")
                "failed" -> Banner(stringResource(R.string.weldbooks_bill_new_ocr_failed), tone = "warning")
            }
            LocalReceiptPreview(receipt, receiptType)
            SectionCard(title = books.labels.supplier) {
                FormField(
                    stringResource(R.string.weldbooks_bill_new_name),
                    name,
                    {
                        name = it
                        nameError = null
                    },
                    placeholder = stringResource(R.string.weldbooks_bill_new_name_placeholder, books.labels.supplierLower),
                    error = nameError,
                    helper = stringResource(R.string.weldbooks_bill_new_name_hint),
                    tag = "bill-supplier",
                )
                FormField(stringResource(R.string.weldbooks_bill_new_bill_number), number, { number = it }, placeholder = stringResource(R.string.weldbooks_bill_new_bill_number_placeholder))
            }
            SectionCard(title = stringResource(R.string.weldbooks_bill_new_dates)) {
                DateField(stringResource(R.string.weldbooks_bill_new_issue_date), issueDate, { day: LocalDate ->
                    issueDate = day
                    dueError = null
                })
                DateField(stringResource(R.string.weldbooks_bill_new_due_date), dueDate, { day: LocalDate ->
                    dueDate = day
                    dueError = null
                }, error = dueError)
            }
            LineItemsEditor(lines, {
                lines = it
                itemsError = null
            }, mode, defaultRate, books.currency, itemsError)
            if (accruesUseTax) {
                SectionCard(title = stringResource(R.string.weldbooks_bill_new_delivered_to)) {
                    HintText(stringResource(R.string.weldbooks_bill_new_delivered_to_hint))
                    AddressFields(deliveredTo, {
                        deliveredTo = it
                        deliveredProblems = UsAddressProblems()
                    }, deliveredProblems)
                    HintText(stringResource(R.string.weldbooks_bill_new_use_tax_note))
                }
            }
            SectionCard(title = stringResource(R.string.weldbooks_bill_new_extras)) {
                FormField(stringResource(R.string.weldbooks_bill_new_notes), notes, { notes = it }, placeholder = stringResource(R.string.weldbooks_bill_new_notes_placeholder), singleLine = false, minLines = 3)
                FormField(stringResource(R.string.weldbooks_bill_new_reference), reference, { reference = it }, placeholder = stringResource(R.string.weldbooks_bill_new_reference_placeholder, books.labels.supplierLower))
            }
            Button(onClick = ::save, enabled = !saving, modifier = Modifier.fillMaxWidth().padding(Tokens.Spacing.m).tagged("create-bill")) {
                Text(stringResource(R.string.weldbooks_bill_new_create))
            }
            BottomSpace()
        }
    }
}
