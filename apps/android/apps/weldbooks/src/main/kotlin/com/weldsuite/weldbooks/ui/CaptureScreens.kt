package com.weldsuite.weldbooks.ui

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Bolt
import androidx.compose.material.icons.outlined.Category
import androidx.compose.material.icons.outlined.CameraAlt
import androidx.compose.material.icons.outlined.DirectionsCar
import androidx.compose.material.icons.outlined.Flight
import androidx.compose.material.icons.outlined.Inventory2
import androidx.compose.material.icons.outlined.PhotoLibrary
import androidx.compose.material.icons.outlined.PictureAsPdf
import androidx.compose.material.icons.outlined.Restaurant
import androidx.compose.material.icons.outlined.Shield
import androidx.compose.material.icons.outlined.Work
import androidx.compose.material.icons.automirrored.outlined.ReceiptLong
import androidx.compose.material.icons.outlined.Description
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.FileProvider
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.weldsuite.weldbooks.LocalFile
import com.weldsuite.weldbooks.OfflineQueue
import com.weldsuite.weldbooks.QueuedExpense
import com.weldsuite.weldbooks.QueuedLine
import com.weldsuite.weldbooks.QuickExpenseNotBooked
import com.weldsuite.weldbooks.R
import com.weldsuite.weldbooks.values
import com.weldsuite.weldbooks.logic.Amounts
import com.weldsuite.weldbooks.logic.BillPrefill
import com.weldsuite.weldbooks.logic.Days
import com.weldsuite.weldbooks.logic.ExpenseCategories
import com.weldsuite.weldbooks.logic.GlAccount
import com.weldsuite.weldbooks.logic.Jurisdictions
import com.weldsuite.weldbooks.logic.Payments
import com.weldsuite.weldbooks.logic.PrefillLine
import com.weldsuite.weldbooks.logic.QuickExpense
import com.weldsuite.weldbooks.logic.UsRules
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.weldsuite.core.api.ApiException
import org.weldsuite.ui.Tokens
import org.weldsuite.ui.tagged
import java.io.ByteArrayOutputStream
import java.io.File
import java.math.BigDecimal
import java.util.UUID

/** A receipt on this phone: a photo (made smaller for upload) or a PDF, in the cache. */
data class CapturedReceipt(val path: String, val mimeType: String)

private fun receiptsDir(context: Context) = File(context.cacheDir, "receipts").apply { mkdirs() }

/** A photo made at most 2000 px on its long side and saved as JPEG; a PDF copied as is. */
private suspend fun capture(context: Context, uri: Uri, mimeType: String?): CapturedReceipt? = withContext(Dispatchers.IO) {
    runCatching {
        val resolver = context.contentResolver
        val type = mimeType ?: resolver.getType(uri) ?: "image/jpeg"
        if (type == "application/pdf") {
            val target = File(receiptsDir(context), "${UUID.randomUUID()}.pdf")
            resolver.openInputStream(uri)?.use { input -> target.outputStream().use { input.copyTo(it) } } ?: return@runCatching null
            return@runCatching CapturedReceipt(target.absolutePath, type)
        }
        val bytes = resolver.openInputStream(uri)?.use { it.readBytes() } ?: return@runCatching null
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        var sample = 1
        while (maxOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= 2000) sample *= 2
        val bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample })
            ?: return@runCatching null
        val out = ByteArrayOutputStream()
        bitmap.compress(Bitmap.CompressFormat.JPEG, 70, out)
        val target = File(receiptsDir(context), "${UUID.randomUUID()}.jpg")
        target.writeBytes(out.toByteArray())
        CapturedReceipt(target.absolutePath, "image/jpeg")
    }.getOrNull()
}

/**
 * The receipt scanner: the camera, a photo or a PDF, then upload and OCR, so
 * the bill or quick expense form opens filled in. If OCR fails the receipt
 * still attaches. Offline, a quick expense takes the photo along; leaving
 * any other way keeps it in the offline queue.
 */
@Composable
fun ScanScreen(onClose: () -> Unit, onContinue: (target: String, documentId: String?, receipt: String?, receiptType: String?) -> Unit) {
    val books = LocalBooks.current
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val online by books.queue.isOnline.collectAsStateWithLifecycle()
    val errors = LocalErrors.current
    var receipt by remember { mutableStateOf<CapturedReceipt?>(null) }
    var status by remember { mutableStateOf("idle") }
    var documentId by remember { mutableStateOf<String?>(null) }
    var prefill by remember { mutableStateOf<BillPrefill?>(null) }
    var failure by remember { mutableStateOf<String?>(null) }
    var request by remember { mutableIntStateOf(0) }
    var photoUri by rememberSaveable { mutableStateOf<String?>(null) }
    var launched by rememberSaveable { mutableStateOf(false) }
    // A photo taken offline that no quick expense took along: leaving keeps it in the queue.
    var unsaved by remember { mutableStateOf<CapturedReceipt?>(null) }
    val keep by rememberUpdatedState(unsaved)
    DisposableEffect(Unit) {
        onDispose {
            val left = keep ?: return@onDispose
            books.env.scope.launch {
                val bytes = withContext(Dispatchers.IO) { File(left.path).takeIf { it.exists() }?.readBytes() } ?: return@launch
                books.queue.addDocument(books.workspaceId, books.repository.entityId, books.queue.keep(bytes, left.mimeType))
            }
        }
    }

    val uploadFailed = stringResource(R.string.weldbooks_scan_upload_failed)
    val ocrFailed = stringResource(R.string.weldbooks_scan_ocr_failed)
    val ocrNoCredits = stringResource(R.string.weldbooks_scan_ocr_no_credits)
    val ocrTooLarge = stringResource(R.string.weldbooks_scan_ocr_too_large)

    fun process(captured: CapturedReceipt) {
        val current = ++request
        unsaved = null
        receipt = captured
        documentId = null
        prefill = null
        failure = null
        if (!online) {
            unsaved = captured
            status = "offline"
            return
        }
        status = "uploading"
        scope.launch {
            var uploaded: String? = null
            runCatching {
                val bytes = withContext(Dispatchers.IO) { File(captured.path).readBytes() }
                val id = books.repository.uploadReceipt(LocalFile(bytes, OfflineQueue.receiptFileName(captured.mimeType), captured.mimeType))
                uploaded = id
                if (current != request) return@launch
                documentId = id
                status = "reading"
                books.repository.processDocument(id)
                val read = books.repository.billFromDocument(id)
                if (current != request) return@launch
                prefill = read
                status = "ready"
            }.onFailure { error ->
                if (current != request) return@launch
                status = "failed"
                val api = error as? ApiException
                failure = when {
                    uploaded == null -> uploadFailed
                    api?.status == 402 -> ocrNoCredits
                    api?.message?.lowercase()?.contains("too large") == true -> ocrTooLarge
                    else -> ocrFailed
                }
            }
        }
        errors.hashCode()
    }

    val camera = rememberLauncherForActivityResult(ActivityResultContracts.TakePicture()) { taken ->
        val uri = photoUri?.let(Uri::parse)
        if (taken && uri != null) scope.launch { capture(context, uri, "image/jpeg")?.let(::process) }
    }
    val gallery = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        if (uri != null) scope.launch { capture(context, uri, null)?.let(::process) }
    }
    val pdfPicker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null) scope.launch { capture(context, uri, "application/pdf")?.let(::process) }
    }
    fun openCamera() {
        val file = File(receiptsDir(context), "camera-${UUID.randomUUID()}.jpg")
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.files", file)
        photoUri = uri.toString()
        runCatching { camera.launch(uri) }
    }
    // Straight to the camera, as the scan tab always did.
    LaunchedEffect(Unit) {
        if (!launched) {
            launched = true
            openCamera()
        }
    }

    val busy = status == "uploading" || status == "reading"
    val captured = receipt
    BooksScaffold(title = stringResource(if (captured == null) R.string.weldbooks_scan_scan_receipt else R.string.weldbooks_scan_receipt), onBack = onClose) { padding ->
        Column(Modifier.padding(padding).fillMaxSize().padding(Tokens.Spacing.l), verticalArrangement = Arrangement.spacedBy(Tokens.Spacing.s)) {
            if (captured == null) {
                Column(Modifier.weight(1f).fillMaxWidth(), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
                    Icon(Icons.AutoMirrored.Outlined.ReceiptLong, contentDescription = null, modifier = Modifier.padding(Tokens.Spacing.m))
                    Text(stringResource(R.string.weldbooks_scan_align_hint), style = MaterialTheme.typography.bodyMedium, textAlign = TextAlign.Center)
                }
                ChoiceButton(Icons.Outlined.CameraAlt, stringResource(R.string.weldbooks_scan_scan_document), "scan-camera") { openCamera() }
                ChoiceButton(Icons.Outlined.PhotoLibrary, stringResource(R.string.weldbooks_scan_pick_from_gallery), "scan-gallery") {
                    gallery.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
                }
                ChoiceButton(Icons.Outlined.PictureAsPdf, stringResource(R.string.weldbooks_scan_pick_pdf), "scan-pdf") { pdfPicker.launch(arrayOf("application/pdf")) }
                TextButton(onClick = onClose, modifier = Modifier.fillMaxWidth()) { Text(stringResource(R.string.weldbooks_scan_go_back)) }
            } else {
                Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
                    if (captured.mimeType == "application/pdf") {
                        Column(horizontalAlignment = Alignment.CenterHorizontally) {
                            Icon(Icons.Outlined.PictureAsPdf, contentDescription = null)
                            Text(stringResource(R.string.weldbooks_scan_pdf_selected))
                        }
                    } else {
                        val bitmap = remember(captured.path) { BitmapFactory.decodeFile(captured.path) }
                        if (bitmap != null) androidx.compose.foundation.Image(bitmap.asImageBitmap(), contentDescription = null, contentScale = ContentScale.Fit, modifier = Modifier.fillMaxSize().tagged("scan-preview"))
                    }
                }
                val summary = prefill?.let { pf ->
                    val currency = pf.currency ?: books.currency
                    val parts = listOfNotNull(pf.contactName, (pf.total ?: pf.subtotal)?.let { books.money(it, currency) })
                    if (parts.isEmpty()) stringResource(R.string.weldbooks_scan_extracted) else stringResource(R.string.weldbooks_scan_found, parts.joinToString(" · "))
                } ?: stringResource(R.string.weldbooks_scan_attached)
                when (status) {
                    "uploading" -> Banner(stringResource(R.string.weldbooks_scan_uploading))
                    "reading" -> Banner(stringResource(R.string.weldbooks_scan_reading))
                    "ready" -> Banner(summary, tone = "success")
                    "failed" -> Banner(failure ?: ocrFailed, tone = "warning")
                    "offline" -> Banner(stringResource(R.string.weldbooks_scan_offline_banner))
                }
                Button(
                    onClick = {
                        unsaved = null
                        onContinue("expense/quick", documentId, captured.path, captured.mimeType)
                    },
                    enabled = !busy,
                    modifier = Modifier.fillMaxWidth().tagged("scan-quick-expense"),
                ) { Text(stringResource(R.string.weldbooks_scan_quick_expense)) }
                // A bill is only made online; offline the photo goes with a quick expense.
                OutlinedButton(
                    onClick = { onContinue("bill/new", documentId, captured.path, captured.mimeType) },
                    enabled = !busy && status != "offline",
                    modifier = Modifier.fillMaxWidth().tagged("scan-create-bill"),
                ) { Text(stringResource(R.string.weldbooks_scan_create_bill)) }
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    TextButton(onClick = {
                        request++
                        unsaved = null
                        receipt = null
                        status = "idle"
                    }, modifier = Modifier.tagged("scan-retake")) { Text(stringResource(R.string.weldbooks_scan_retake)) }
                    TextButton(onClick = onClose) { Text(stringResource(R.string.weldbooks_scan_close)) }
                }
            }
        }
    }
}

@Composable
private fun ChoiceButton(icon: ImageVector, label: String, tag: String, onClick: () -> Unit) {
    OutlinedButton(onClick = onClick, modifier = Modifier.fillMaxWidth().tagged(tag)) {
        Icon(icon, contentDescription = null)
        Text(label, modifier = Modifier.padding(start = Tokens.Spacing.s))
    }
}

private val categoryIcons: Map<String, ImageVector> = mapOf(
    "food" to Icons.Outlined.Restaurant,
    "transport" to Icons.Outlined.DirectionsCar,
    "office" to Icons.Outlined.Work,
    "travel" to Icons.Outlined.Flight,
    "supplies" to Icons.Outlined.Inventory2,
    "utilities" to Icons.Outlined.Bolt,
    "insurance" to Icons.Outlined.Shield,
    "other" to Icons.Outlined.Category,
)

@Composable
private fun categoryLabel(key: String): String = when (key) {
    "food" -> stringResource(R.string.weldbooks_expense_quick_food)
    "transport" -> stringResource(R.string.weldbooks_expense_quick_transport)
    "office" -> stringResource(R.string.weldbooks_expense_quick_office)
    "travel" -> stringResource(R.string.weldbooks_expense_quick_travel)
    "supplies" -> stringResource(R.string.weldbooks_expense_quick_supplies)
    "utilities" -> stringResource(R.string.weldbooks_expense_quick_utilities)
    "insurance" -> stringResource(R.string.weldbooks_expense_quick_insurance)
    else -> stringResource(R.string.weldbooks_expense_quick_other)
}

/** What a scan keeps for the save: the matched supplier, the currency, and the lines when they carry several rates. */
private data class Scanned(
    val vendorName: String?,
    val contactId: String?,
    val currency: String?,
    val total: String?,
    val lines: List<PrefillLine>?,
    val rates: List<BigDecimal>,
)

/**
 * The fastest way from a receipt to a booked cost: what was paid, VAT
 * included, saved as a bill that is approved and paid at once. Offline it
 * goes to the queue.
 */
@Composable
fun QuickExpenseScreen(documentId: String?, receipt: String?, receiptType: String?, onDone: () -> Unit) {
    val books = LocalBooks.current
    val notify = LocalNotify.current
    val errors = LocalErrors.current
    val scope = rememberCoroutineScope()
    val online by books.queue.isOnline.collectAsStateWithLifecycle()
    val isUs = books.isUs
    val defaultRate = Jurisdictions.defaultTaxRate(books.code)

    var amount by rememberSaveable { mutableStateOf("") }
    var category by rememberSaveable { mutableStateOf("other") }
    var vendor by rememberSaveable { mutableStateOf("") }
    var description by rememberSaveable { mutableStateOf("") }
    var date by remember { mutableStateOf(Days.today()) }
    var taxRate by rememberSaveable { mutableStateOf(defaultRate) }
    var accrueUseTax by rememberSaveable { mutableStateOf(false) }
    var taxCode by rememberSaveable { mutableStateOf(UsRules.DEFAULT_TAX_CODE) }
    var method by rememberSaveable { mutableStateOf(Payments.defaultExpenseMethod(isUs)) }
    var accounts by remember { mutableStateOf<List<GlAccount>>(emptyList()) }
    var accountId by rememberSaveable { mutableStateOf("") }
    var accountTouched by rememberSaveable { mutableStateOf(false) }
    var scanned by remember { mutableStateOf<Scanned?>(null) }
    var saving by remember { mutableStateOf(false) }
    var storedDocument by remember { mutableStateOf(documentId) }
    var amountError by remember { mutableStateOf<String?>(null) }
    var ocr by remember { mutableStateOf(if (documentId != null) "loading" else "idle") }

    LaunchedEffect(online) {
        if (!online) return@LaunchedEffect
        // Without the chart the expense books to the default expense account.
        runCatching { books.repository.accounts() }.onSuccess { accounts = ExpenseCategories.expenseAccounts(it) }
    }
    LaunchedEffect(category, accounts, accountTouched) {
        if (!accountTouched) accountId = ExpenseCategories.accountFor(category, accounts)?.id.orEmpty()
    }
    LaunchedEffect(documentId) {
        val id = documentId ?: return@LaunchedEffect
        runCatching { books.repository.billFromDocument(id) }.onSuccess { prefill ->
            val total = QuickExpense.totalFromPrefill(prefill)?.takeIf { it.signum() > 0 }?.let { Amounts.plain(Amounts.cents(it)) }
            val rates = if (isUs) emptyList() else QuickExpense.rates(prefill)
            prefill.contactName?.let { vendor = it }
            prefill.issueDate?.let(Days::of)?.let { date = it }
            total?.let { amount = it }
            if (!isUs) QuickExpense.mainRate(prefill)?.let { taxRate = it }
            val first = prefill.items.firstOrNull()?.description?.trim()
            if (!first.isNullOrEmpty() && first != prefill.contactName) description = first
            scanned = Scanned(prefill.contactName, prefill.matchedContactId, prefill.currency, total, prefill.items.takeIf { rates.size > 1 }, rates)
            ocr = "ready"
        }.onFailure { ocr = "failed" }
    }

    // Booked per receipt line while the scanned total stands; editing it falls back to one rate.
    val mixedRates = scanned?.takeIf { it.lines != null && amount == it.total }?.rates
    val amountErrorText = stringResource(R.string.weldbooks_expense_quick_amount_error)
    val categoryText = categoryLabel(category)
    val rounding = stringResource(R.string.weldbooks_expense_quick_rounding)
    val saved = stringResource(R.string.weldbooks_expense_quick_saved)
    val savedOffline = stringResource(R.string.weldbooks_expense_quick_saved_offline)
    val queuedRetry = stringResource(R.string.weldbooks_expense_quick_queued_retry)
    val saveFailed = stringResource(R.string.weldbooks_expense_quick_save_failed)
    val notBookedTemplate = stringResource(R.string.weldbooks_expense_quick_not_booked, "%REASON%")

    fun save() {
        val value = Amounts.parse(amount, books.decimalPoint)
        if (value.signum() <= 0) {
            amountError = amountErrorText
            return
        }
        amountError = null
        val name = vendor.trim()
        val scan = scanned
        val expense = QueuedExpense(
            amount = Amounts.plain(value),
            category = categoryText,
            description = description.trim().ifEmpty { null },
            vendorName = name.ifEmpty { null },
            contactId = scan?.contactId?.takeIf { name == scan.vendorName?.trim() },
            currency = scan?.currency,
            date = date.toString(),
            documentId = storedDocument,
            accountId = accountId.ifEmpty { null },
            // A US expense is booked at what was paid: the tax in it is part of the cost.
            taxRate = if (isUs) "0" else Amounts.plain(Amounts.parse(taxRate.ifBlank { "0" }, books.decimalPoint)),
            receiptLines = scan?.lines?.takeIf { amount == scan.total }?.map { QueuedLine(it.description, it.quantity, it.unitPrice, it.taxRate, it.sortOrder) },
            roundingDescription = rounding,
            paymentMethod = method,
            accrueUseTax = isUs && accrueUseTax,
            taxCode = taxCode.takeIf { isUs && accrueUseTax },
        )
        saving = true
        scope.launch {
            val photo = receipt?.takeIf { storedDocument == null }
            suspend fun keepPhoto() = photo?.let { path ->
                withContext(Dispatchers.IO) { File(path).takeIf { it.exists() }?.readBytes() }?.let { books.queue.keep(it, receiptType ?: "image/jpeg") }
            }
            if (!online) {
                books.queue.addExpense(books.workspaceId, books.repository.entityId, expense, keepPhoto())
                notify(savedOffline)
                saving = false
                onDone()
                return@launch
            }
            var pending = expense
            try {
                if (photo != null) {
                    val bytes = withContext(Dispatchers.IO) { File(photo).takeIf { it.exists() }?.readBytes() }
                    if (bytes != null) {
                        val type = receiptType ?: "image/jpeg"
                        val id = books.repository.uploadReceipt(LocalFile(bytes, OfflineQueue.receiptFileName(type), type))
                        storedDocument = id
                        pending = pending.copy(documentId = id)
                    }
                }
                books.repository.createQuickExpense(pending.values(pending.documentId))
                notify(saved)
                onDone()
            } catch (error: QuickExpenseNotBooked) {
                notify(notBookedTemplate.replace("%REASON%", errors.describe(error.cause, error.message ?: saveFailed)))
                onDone()
            } catch (error: ApiException) {
                if (!error.isNetwork) {
                    // The server answered: queueing would fail the same way on every sync.
                    notify(errors.describe(error, saveFailed))
                } else {
                    books.queue.addExpense(books.workspaceId, books.repository.entityId, pending, if (pending.documentId == null) keepPhoto() else null)
                    notify(queuedRetry)
                    onDone()
                }
            } finally {
                saving = false
            }
        }
    }

    val brand = Brand.current()
    BooksScaffold(title = stringResource(R.string.weldbooks_expense_quick_title), onBack = onDone) { padding ->
        Column(Modifier.padding(padding).fillMaxSize().imePadding().verticalScroll(rememberScrollState()).tagged("quick-expense")) {
            if (!online) Banner(stringResource(R.string.weldbooks_expense_quick_offline_banner), tone = "warning")
            when (ocr) {
                "loading" -> Banner(stringResource(R.string.weldbooks_expense_quick_ocr_loading))
                "ready" -> Banner(stringResource(R.string.weldbooks_expense_quick_ocr_ready), tone = "success")
                "failed" -> Banner(stringResource(R.string.weldbooks_expense_quick_ocr_failed), tone = "warning")
            }
            LocalReceiptPreview(receipt, receiptType)
            Card(
                modifier = Modifier.fillMaxWidth().padding(horizontal = Tokens.Spacing.m, vertical = Tokens.Spacing.xs),
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainerLow),
            ) {
                Column(Modifier.fillMaxWidth().padding(Tokens.Spacing.l), horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(stringResource(R.string.weldbooks_expense_quick_amount), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    BasicTextField(
                        value = amount,
                        onValueChange = {
                            amount = it
                            amountError = null
                        },
                        textStyle = TextStyle(fontSize = 44.sp, fontWeight = FontWeight.Bold, textAlign = TextAlign.Center, color = MaterialTheme.colorScheme.onSurface),
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                        singleLine = true,
                        cursorBrush = SolidColor(brand),
                        decorationBox = { inner ->
                            Box(contentAlignment = Alignment.Center) {
                                if (amount.isEmpty()) Text("0.00", style = TextStyle(fontSize = 44.sp, fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.outline))
                                inner()
                            }
                        },
                        modifier = Modifier.fillMaxWidth().tagged("expense-amount"),
                    )
                    val error = amountError
                    if (error != null) {
                        Text(error, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                    } else if (isUs) {
                        HintText(stringResource(R.string.weldbooks_expense_quick_amount_hint_us))
                    } else {
                        val rate = Amounts.parse(taxRate.ifBlank { "0" }, books.decimalPoint)
                        val tax = QuickExpense.split(Amounts.parse(amount.ifBlank { "0" }, books.decimalPoint), rate).tax
                        HintText(stringResource(R.string.weldbooks_expense_quick_amount_hint, books.money(tax), books.labels.tax, Amounts.percent(rate)))
                    }
                }
            }
            SectionCard(title = stringResource(R.string.weldbooks_expense_quick_category)) {
                ExpenseCategories.all.chunked(4).forEach { row ->
                    Row(Modifier.fillMaxWidth().padding(vertical = 4.dp), horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s)) {
                        row.forEach { key ->
                            val selected = key == category
                            val color = if (selected) brand else MaterialTheme.colorScheme.onSurfaceVariant
                            OutlinedButton(
                                onClick = { category = key },
                                border = BorderStroke(1.dp, if (selected) brand else MaterialTheme.colorScheme.outlineVariant),
                                shape = RoundedCornerShape(Tokens.Radius.medium),
                                contentPadding = androidx.compose.foundation.layout.PaddingValues(4.dp),
                                modifier = Modifier.weight(1f).height(76.dp).let { if (selected) it.background(brand.copy(alpha = 0.12f), RoundedCornerShape(Tokens.Radius.medium)) else it }.tagged("category-$key"),
                            ) {
                                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                                    Icon(categoryIcons.getValue(key), contentDescription = null, tint = color)
                                    Text(categoryLabel(key), color = color, style = MaterialTheme.typography.labelSmall, maxLines = 1)
                                }
                            }
                        }
                    }
                }
                if (accounts.isNotEmpty()) {
                    Dropdown(
                        stringResource(R.string.weldbooks_expense_quick_account),
                        accountId,
                        listOf("" to stringResource(R.string.weldbooks_expense_quick_default_account)) + accounts.map { it.id to "${it.code} ${it.name}" },
                        {
                            accountId = it
                            accountTouched = true
                        },
                        tag = "expense-account",
                    )
                }
            }
            SectionCard(title = stringResource(R.string.weldbooks_expense_quick_details)) {
                FormField(books.labels.supplier, vendor, { vendor = it }, placeholder = stringResource(R.string.weldbooks_expense_quick_vendor_placeholder), tag = "expense-vendor")
                DateField(stringResource(R.string.weldbooks_expense_quick_date), date, { date = it }, tag = "expense-date")
                if (isUs) {
                    SwitchRow(stringResource(R.string.weldbooks_expense_quick_accrue_use_tax), accrueUseTax, { accrueUseTax = it })
                    HintText(stringResource(R.string.weldbooks_expense_quick_accrue_use_tax_hint))
                    if (accrueUseTax) Dropdown(stringResource(R.string.weldbooks_sales_tax_tax_code), taxCode, UsRules.taxCodes.map { it to taxCodeLabel(it) }, { taxCode = it })
                } else if (mixedRates != null) {
                    HintText(stringResource(R.string.weldbooks_expense_quick_mixed_rates, books.labels.tax, mixedRates.joinToString(", ") { "${Amounts.percent(it)}%" }))
                } else {
                    FormField(books.labels.taxPercent, taxRate, { taxRate = it }, keyboard = KeyboardType.Decimal, placeholder = defaultRate, tag = "expense-tax-rate")
                }
                Dropdown(
                    stringResource(R.string.weldbooks_expense_quick_paid_with),
                    method,
                    Payments.methods(isUs).filter { it != "manual" }.map { it to paymentMethodLabel(it) },
                    { method = it },
                    tag = "expense-method",
                )
                FormField(stringResource(R.string.weldbooks_expense_quick_description), description, { description = it }, placeholder = stringResource(R.string.weldbooks_expense_quick_description_placeholder), singleLine = false, minLines = 3)
            }
            Button(onClick = ::save, enabled = !saving, modifier = Modifier.fillMaxWidth().padding(Tokens.Spacing.m).tagged("expense-save")) {
                Text(stringResource(if (online) R.string.weldbooks_expense_quick_save else R.string.weldbooks_expense_quick_queue))
            }
            BottomSpace()
        }
    }
}

