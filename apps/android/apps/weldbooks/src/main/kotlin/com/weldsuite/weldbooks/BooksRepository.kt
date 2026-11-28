package com.weldsuite.weldbooks

import com.weldsuite.weldbooks.logic.Address
import com.weldsuite.weldbooks.logic.Amounts
import com.weldsuite.weldbooks.logic.BalanceRow
import com.weldsuite.weldbooks.logic.BalanceSheet
import com.weldsuite.weldbooks.logic.BankAccount
import com.weldsuite.weldbooks.logic.BankTransaction
import com.weldsuite.weldbooks.logic.Bill
import com.weldsuite.weldbooks.logic.BillPrefill
import com.weldsuite.weldbooks.logic.Contact
import com.weldsuite.weldbooks.logic.ContactBalance
import com.weldsuite.weldbooks.logic.ContactIdentityDraft
import com.weldsuite.weldbooks.logic.ContactPerson
import com.weldsuite.weldbooks.logic.Dashboard
import com.weldsuite.weldbooks.logic.DocumentLine
import com.weldsuite.weldbooks.logic.Entity
import com.weldsuite.weldbooks.logic.EntityUpdateValues
import com.weldsuite.weldbooks.logic.Features
import com.weldsuite.weldbooks.logic.GlAccount
import com.weldsuite.weldbooks.logic.Invoice
import com.weldsuite.weldbooks.logic.Jurisdiction
import com.weldsuite.weldbooks.logic.LineInputValues
import com.weldsuite.weldbooks.logic.MatchSuggestion
import com.weldsuite.weldbooks.logic.Page
import com.weldsuite.weldbooks.logic.PrefillLine
import com.weldsuite.weldbooks.logic.ProfitLoss
import com.weldsuite.weldbooks.logic.QuickExpense
import com.weldsuite.weldbooks.logic.ReconciliationStats
import com.weldsuite.weldbooks.logic.Statuses
import com.weldsuite.weldbooks.logic.TaxRow
import com.weldsuite.weldbooks.logic.Terminology
import com.weldsuite.weldbooks.logic.UnmatchedTransaction
import com.weldsuite.weldbooks.logic.UsClassification
import com.weldsuite.weldbooks.logic.UsEntityType
import com.weldsuite.weldbooks.logic.VatReturn
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.ResponseBody
import org.weldsuite.api.weldbooks.apis.DefaultApi
import org.weldsuite.api.weldbooks.models.EntityBankDetails
import org.weldsuite.api.weldbooks.models.EntityInput
import org.weldsuite.api.weldbooks.models.EntityTaxIdentifiers
import org.weldsuite.api.weldbooks.models.EntityUpdate
import org.weldsuite.api.weldbooks.models.ErrorResponse
import org.weldsuite.api.weldbooks.models.InvoiceStatusInput
import org.weldsuite.api.weldbooks.models.LineInput
import org.weldsuite.api.weldbooks.models.PostalAddress
import org.weldsuite.api.weldbooks.models.ReconcileInput
import org.weldsuite.api.weldbooks.models.SalesTaxInput
import org.weldsuite.api.weldbooks.models.SalesTaxLine
import org.weldsuite.core.AppEnvironment
import org.weldsuite.core.WeldJson
import org.weldsuite.core.api.ApiAuth
import org.weldsuite.core.api.ApiClient
import org.weldsuite.core.api.ApiException
import retrofit2.Response
import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.POST
import retrofit2.http.Path
import java.io.IOException
import java.math.BigDecimal
import org.weldsuite.api.weldbooks.models.AccountingContact as ApiContact
import org.weldsuite.api.weldbooks.models.AccountingEntity as ApiEntity
import org.weldsuite.api.weldbooks.models.Bill as ApiBill
import org.weldsuite.api.weldbooks.models.BillInput as ApiBillInput
import org.weldsuite.api.weldbooks.models.ContactInput as ApiContactInput
import org.weldsuite.api.weldbooks.models.DocumentInput as ApiDocumentInput
import org.weldsuite.api.weldbooks.models.DocumentItem as ApiItem
import org.weldsuite.api.weldbooks.models.Invoice as ApiInvoice
import org.weldsuite.api.weldbooks.models.InvoiceInput as ApiInvoiceInput
import org.weldsuite.api.weldbooks.models.InvoicePaymentInput as ApiInvoicePayment
import org.weldsuite.api.weldbooks.models.Jurisdiction as ApiJurisdiction
import org.weldsuite.api.weldbooks.models.PaymentInput as ApiPayment
import org.weldsuite.api.weldbooks.models.TaxBreakdownRow as ApiTaxRow
import org.weldsuite.api.weldbooks.models.VatReturn as ApiVatReturn

/** A refused finalise: the company lacks the invoice fields the server names (`ENTITY_INVOICE_FIELDS_MISSING`). */
class CompanyFieldsMissing(val fields: List<String>, message: String?) : Exception(message)

/** The sales tax of a draft, as the server would book it. */
data class TaxPreview(
    val warnings: List<String>,
    val addressIncomplete: Boolean,
    val subtotal: BigDecimal,
    val taxTotal: BigDecimal,
    val total: BigDecimal,
    val taxBreakdown: List<TaxRow>,
)

data class NewInvoice(
    val contactName: String,
    val contactEmail: String?,
    val issueDate: String,
    val dueDate: String,
    val notes: String?,
    val reference: String?,
    val shippingAddress: Address?,
    val billingAddress: Address?,
    val lines: List<LineInputValues>,
)

data class NewBill(
    val contactId: String?,
    val contactName: String,
    val billNumber: String?,
    val currency: String?,
    val issueDate: String,
    val dueDate: String,
    val notes: String?,
    val reference: String?,
    val sourceDocumentId: String?,
    val deliveryAddress: Address?,
    val lines: List<LineInputValues>,
)

data class NewEntity(
    val name: String,
    val jurisdictionCode: String,
    val baseCurrency: String,
    val isDefault: Boolean,
    val entityType: String? = null,
    val taxClassification: String? = null,
    val dba: String? = null,
    val vatNumber: String? = null,
    val ein: String? = null,
    val registrationNumber: String? = null,
    val iban: String? = null,
    val bic: String? = null,
    val address: Address? = null,
)

data class NewContact(
    val identity: ContactIdentityDraft.Payload,
    val email: String?,
    val phone: String?,
    val role: String,
    val billingAddress: Address?,
)

/** A payment as the record-payment sheet takes it. */
data class PaymentValues(
    val amount: BigDecimal,
    val date: String,
    val method: String,
    val checkNumber: String? = null,
    /** US: `undeposited_funds` or `bank`, for a received check or cash. */
    val depositTo: String? = null,
)

/** A quick expense: a bill that is approved and paid straight away. */
data class QuickExpenseValues(
    val amount: BigDecimal,
    /** False only for an entry queued by an older version, typed without tax. */
    val amountIncludesTax: Boolean = true,
    /** The category's label: the line's description when none is typed. */
    val category: String,
    val description: String? = null,
    val vendorName: String? = null,
    val contactId: String? = null,
    val currency: String? = null,
    val date: String,
    val documentId: String? = null,
    val accountId: String? = null,
    val taxRate: BigDecimal = BigDecimal.ZERO,
    val receiptLines: List<PrefillLine>? = null,
    val roundingDescription: String,
    val paymentMethod: String,
    val accrueUseTax: Boolean = false,
    val taxCode: String? = null,
)

/** The bill was saved but not approved or paid; it stays a draft. Saving again would create it twice. */
class QuickExpenseNotBooked(val billId: String, cause: Throwable) : Exception(cause.message, cause)

/** A file kept on this phone: bytes to upload, with their name and type. */
data class LocalFile(val bytes: ByteArray, val fileName: String, val mimeType: String)

/** A stored receipt, read with the member's own token. */
data class StoredFile(val bytes: ByteArray, val mimeType: String?)

/** Calls the API outside the generated client: the storage broker, private files and the printable invoice (HTML). */
private interface RawApi {
    @GET("api/invoices/{id}/pdf")
    suspend fun invoiceDocument(@Path("id") id: String): Response<ResponseBody>

    @POST("api/storage/generate-upload-url")
    suspend fun uploadTicket(@Body body: RequestBody): Response<ResponseBody>

    @POST("api/storage/confirm-upload")
    suspend fun confirmUpload(@Body body: RequestBody): Response<ResponseBody>

    @GET("api/storage/private/{key}")
    suspend fun privateFile(@Path("key", encoded = true) key: String): Response<ResponseBody>
}

/**
 * Every WeldBooks call, for the active workspace and company. Maps the
 * generated API types to the app's models here and nowhere else, so a
 * generator rename stays in this file. Each request names the company in
 * `X-Accounting-Entity-Id`.
 */
class BooksRepository(private val env: AppEnvironment) {
    /** The company the requests are for; null until one is resolved (the server then uses the workspace default). */
    @Volatile
    var entityId: String? = null

    private val client: ApiClient by lazy {
        val auth = object : ApiAuth {
            override suspend fun token(): String? = env.session?.getToken()
            override suspend fun refreshedToken(): String? = env.session?.refreshToken()
            override val workspaceId: String? get() = env.session?.activeWorkspaceId
        }
        val http = env.http.newBuilder()
            .addInterceptor { chain ->
                val entity = entityId
                val request = if (entity == null) chain.request() else chain.request().newBuilder().header(ENTITY_HEADER, entity).build()
                chain.proceed(request)
            }
            .build()
        ApiClient(env.serverOrigin, env.app.code, auth, http)
    }

    private val api: DefaultApi get() = client.create()
    private val raw: RawApi get() = client.create()

    // ── entities ──

    suspend fun entities(): List<Entity> = call { api.listAccountingEntities() }.data.map(::entity)

    suspend fun jurisdictions(): List<Jurisdiction> = call { api.listJurisdictions() }.data.map(::jurisdiction)

    suspend fun createEntity(values: NewEntity): Entity {
        val identifiers = EntityTaxIdentifiers(
            vatNumber = values.vatNumber,
            registrationNumber = values.registrationNumber,
            einOrSsn = values.ein,
        ).takeIf { it.vatNumber != null || it.registrationNumber != null || it.einOrSsn != null }
        val bank = EntityBankDetails(iban = values.iban, bic = values.bic).takeIf { it.iban != null || it.bic != null }
        val input = EntityInput(
            name = values.name,
            jurisdictionCode = values.jurisdictionCode,
            baseCurrency = values.baseCurrency,
            entityType = values.entityType,
            taxClassification = values.taxClassification,
            dba = values.dba,
            taxIdentifiers = identifiers,
            bankDetails = bank,
            address = values.address?.let(::postal),
            isDefault = values.isDefault,
            seedDefaults = true,
        )
        return entity(call { api.createAccountingEntity(input) }.data)
    }

    /** The server replaces the bank details as a whole, so the stored ones are read first and the change merged in. */
    suspend fun updateEntity(id: String, update: EntityUpdateValues): Entity {
        var bank: EntityBankDetails? = null
        if (update.changesBank) {
            val current = call { api.getAccountingEntity(id) }.data.bankDetails ?: EntityBankDetails()
            // Untouched keeps the stored value; an emptied field clears it.
            bank = current.copy(
                iban = if (update.iban == null) current.iban else update.iban.ifEmpty { null },
                bic = if (update.bic == null) current.bic else update.bic.ifEmpty { null },
            )
        }
        val identifiers = if (update.changesTaxIdentifiers) {
            EntityTaxIdentifiers(vatNumber = update.vatNumber, registrationNumber = update.registrationNumber, einOrSsn = update.einOrSsn)
        } else {
            null
        }
        val body = EntityUpdate(name = update.name, taxIdentifiers = identifiers, bankDetails = bank, address = update.address?.let(::postal))
        return entity(call { api.updateAccountingEntity(id, body) }.data)
    }

    // ── dashboard and reports ──

    /**
     * The dashboard's figures, plus the approved bills (first page) whose due
     * date falls in the week: the platform's "Due this week" where the server
     * has no to-process list.
     */
    suspend fun dashboard(): Dashboard = coroutineScope {
        val figures = async { call { api.getAccountingDashboard() }.data }
        val approved = async { runCatching { bills(page = 1, pageSize = 50, search = null, status = "approved").items }.getOrDefault(emptyList()) }
        val data = figures.await()
        val accounts = data.bankAccounts
        // The ledger balance when the server has it; else the bank accounts in the base currency.
        val cash = data.cashBalance?.let { Amounts.of(it) } ?: accounts
            .filter { it.currency == null || it.currency == data.currency }
            .fold(java.math.BigDecimal.ZERO) { sum, account -> sum + Amounts.of(account.currentBalance) }
        val invoicesDue = data.upcomingDue.orEmpty().map {
            com.weldsuite.weldbooks.logic.DueItem("invoice", it.id, it.invoiceNumber, it.contactName, it.dueDate, Amounts.of(it.balanceDue), data.currency)
        }
        val billsDue = approved.await()
            .filter { it.balanceDue.signum() > 0 }
            .map { com.weldsuite.weldbooks.logic.DueItem("bill", it.id, it.number, it.contactName, it.dueDate, it.balanceDue, it.currency) }
        Dashboard(
            currency = data.currency,
            outstanding = Amounts.of(data.receivables.outstanding),
            outstandingCount = data.receivables.outstandingCount,
            overdue = Amounts.of(data.receivables.overdue),
            overdueCount = data.receivables.overdueCount,
            payables = Amounts.of(data.payables.outstanding),
            payablesCount = data.payables.outstandingCount,
            profitMonth = Amounts.of(data.profit.month),
            cashBalance = cash,
            bankAccountCount = accounts.size,
            pendingDocuments = data.pendingDocuments,
            dueThisWeek = com.weldsuite.weldbooks.logic.DashboardSeries.dueThisWeek(invoicesDue + billsDue),
            recentPayments = data.recentPayments.orEmpty().map {
                com.weldsuite.weldbooks.logic.RecentPayment(
                    it.id, it.type, it.date, Amounts.of(it.amount), it.currency, it.paymentMethod, it.reference, it.invoiceId, it.billId,
                )
            },
            trend = data.monthlyTrend.orEmpty().map {
                com.weldsuite.weldbooks.logic.TrendMonth(it.month, it.revenue?.let { v -> Amounts.of(v) }, it.expenses?.let { v -> Amounts.of(v) }, it.profit?.let { v -> Amounts.of(v) })
            },
        )
    }

    suspend fun profitLoss(from: String, to: String): ProfitLoss {
        val data = call { api.getProfitLoss(from, to) }.data
        return ProfitLoss(Amounts.of(data.totalRevenue), Amounts.of(data.totalExpenses), Amounts.of(data.netProfit))
    }

    suspend fun balanceSheet(): BalanceSheet {
        val data = call { api.getBalanceSheet() }.data
        fun rows(list: List<org.weldsuite.api.weldbooks.models.BalanceSheetRow>) =
            list.map { BalanceRow(it.accountCode, it.accountName, Amounts.of(it.balance)) }
        return BalanceSheet(
            assets = rows(data.assets),
            liabilities = rows(data.liabilities),
            equity = rows(data.equity),
            totalAssets = Amounts.of(data.totalAssets),
            totalLiabilities = Amounts.of(data.totalLiabilities),
            totalEquity = Amounts.of(data.totalEquity),
            totalLiabilitiesAndEquity = Amounts.of(data.totalLiabilitiesAndEquity),
        )
    }

    // ── VAT returns ──

    suspend fun vatReturns(): List<VatReturn> = call { api.listVatReturns() }.data.map(::vatReturn)

    suspend fun vatReturn(id: String): VatReturn = vatReturn(call { api.getVatReturn(id) }.data)

    suspend fun fileVatReturn(id: String) {
        call { api.fileVatReturn(id) }
    }

    // ── invoices ──

    suspend fun invoices(page: Int, pageSize: Int, search: String?, status: String?): Page<Invoice> {
        val result = call { api.listInvoices(page = page, pageSize = pageSize, search = search, status = status) }
        return Page(result.data.map(::invoice), result.pagination.totalCount, result.pagination.hasMore)
    }

    suspend fun invoice(id: String): Invoice = invoice(call { api.getInvoice(id) }.data)

    suspend fun createInvoice(values: NewInvoice): String {
        val contactId = resolveContactId(values.contactName, values.contactEmail)
        val input = ApiInvoiceInput(
            contactId = contactId,
            contactName = values.contactName,
            contactEmail = values.contactEmail,
            issueDate = values.issueDate,
            dueDate = values.dueDate,
            notes = values.notes,
            reference = values.reference,
            shippingAddress = values.shippingAddress?.let(::postal),
            billingAddress = values.billingAddress?.let(::postal),
            items = values.lines.map(::line),
        )
        return call { api.createInvoice(input) }.data.id
    }

    suspend fun finalizeInvoice(id: String) {
        call { api.finalizeInvoice(id) }
    }

    suspend fun sendInvoice(id: String) {
        call { api.sendInvoice(id) }
    }

    suspend fun cancelInvoice(id: String) {
        call { api.setInvoiceStatus(id, InvoiceStatusInput(InvoiceStatusInput.Status.CANCELLED)) }
    }

    suspend fun recordInvoicePayment(id: String, payment: PaymentValues) {
        val input = ApiInvoicePayment(
            amount = Amounts.plain(Amounts.cents(payment.amount)),
            date = payment.date,
            paymentMethod = payment.method,
            checkNumber = payment.checkNumber,
            depositTo = payment.depositTo?.let { target -> ApiInvoicePayment.DepositTo.entries.firstOrNull { it.value == target } },
        )
        call { api.recordInvoicePayment(id, input) }
    }

    suspend fun duplicateInvoice(id: String): String = call { api.duplicateInvoice(id) }.data.id

    suspend fun createCreditNote(id: String): String = call { api.createCreditNote(id) }.data.id

    suspend fun deleteInvoice(id: String) {
        call { api.deleteInvoice(id) }
    }

    /** The printable invoice: HTML from `GET /invoices/:id/pdf`. */
    suspend fun invoiceDocument(id: String): String = rawBody { raw.invoiceDocument(id) }.string()

    /** The sales tax of a US draft invoice; nothing is saved. */
    suspend fun previewSalesTax(contactName: String, issueDate: String, shipTo: Address?, billTo: Address?, lines: List<LineInputValues>): TaxPreview {
        val contactId = findContactId(contactName)
        val input = SalesTaxInput(
            kind = SalesTaxInput.Kind.INVOICE,
            contactId = contactId,
            issueDate = issueDate,
            shippingAddress = shipTo?.let(::postal),
            billingAddress = billTo?.let(::postal),
            items = lines.mapIndexed { index, line ->
                SalesTaxLine(
                    id = "line_$index",
                    description = line.description,
                    quantity = line.quantity,
                    unitPrice = line.unitPrice,
                    taxRate = line.taxRate,
                    taxCode = line.taxCode,
                    accrueUseTax = line.accrueUseTax.takeIf { it },
                )
            },
        )
        val data = call { api.calculateSalesTax(input) }.data
        return TaxPreview(
            warnings = data.warnings,
            addressIncomplete = data.addressIncomplete,
            subtotal = Amounts.of(data.subtotal),
            taxTotal = Amounts.of(data.taxTotal),
            total = Amounts.of(data.total),
            taxBreakdown = data.taxBreakdown.orEmpty().map(::taxRow),
        )
    }

    // ── bills ──

    suspend fun bills(page: Int, pageSize: Int, search: String?, status: String?): Page<Bill> {
        val result = call { api.listBills(page = page, pageSize = pageSize, search = search, status = status) }
        return Page(result.data.map(::bill), result.pagination.totalCount, result.pagination.hasMore)
    }

    suspend fun bill(id: String): Bill = bill(call { api.getBill(id) }.data)

    suspend fun createBill(values: NewBill): String {
        val contactId = values.contactId ?: resolveContactId(values.contactName, null)
        val input = ApiBillInput(
            contactId = contactId,
            contactName = values.contactName,
            billNumber = values.billNumber,
            currency = values.currency,
            issueDate = values.issueDate,
            dueDate = values.dueDate,
            notes = values.notes,
            reference = values.reference,
            externalReference = values.reference,
            sourceDocumentId = values.sourceDocumentId,
            deliveryAddress = values.deliveryAddress?.let(::postal),
            items = values.lines.map(::line),
        )
        return call { api.createBill(input) }.data.id
    }

    suspend fun approveBill(id: String): Bill = bill(call { api.approveBill(id) }.data)

    suspend fun rejectBill(id: String, reason: String) {
        call { api.rejectBill(id, org.weldsuite.api.weldbooks.models.BillRejectInput(reason)) }
    }

    suspend fun deleteBill(id: String) {
        callNoContent { api.deleteBill(id) }
    }

    /** Bills are settled by an outgoing payment. */
    suspend fun recordBillPayment(id: String, payment: PaymentValues) {
        val bill = bill(id)
        val input = ApiPayment(
            type = ApiPayment.Type.SENT,
            amount = Amounts.plain(Amounts.cents(payment.amount)),
            date = payment.date,
            billId = id,
            contactId = bill.contactId,
            paymentMethod = payment.method,
            checkNumber = payment.checkNumber,
        )
        call { api.createPayment(input) }
    }

    /**
     * A quick expense is a bill that is approved and paid straight away, so the
     * cost is in the books at once. Once the bill exists, a failed approval or
     * payment is a [QuickExpenseNotBooked], never a plain failure.
     */
    suspend fun createQuickExpense(values: QuickExpenseValues): String {
        val description = values.description?.ifBlank { null } ?: values.category
        val lines = if (values.amountIncludesTax) {
            QuickExpense.lines(values.amount, values.taxRate, description, values.roundingDescription, values.accountId, values.receiptLines)
        } else {
            listOf(LineInputValues(description, "1", Amounts.plain(values.amount), Amounts.plain(values.taxRate), null, false, values.accountId, 0))
        }.mapIndexed { index, line ->
            if (index == 0 && values.accrueUseTax) line.copy(accrueUseTax = true, taxCode = values.taxCode) else line
        }
        val billId = createBill(
            NewBill(
                contactId = values.contactId,
                contactName = values.vendorName?.ifBlank { null } ?: "Quick Expense",
                billNumber = null,
                currency = values.currency,
                issueDate = values.date,
                dueDate = values.date,
                notes = values.description,
                reference = null,
                sourceDocumentId = values.documentId,
                deliveryAddress = null,
                lines = lines,
            ),
        )
        if (!values.amountIncludesTax) return billId
        try {
            val approved = approveBill(billId)
            val bill = bill(billId)
            val amount = if (approved.total.signum() > 0) approved.total else bill.total
            recordBillPayment(billId, PaymentValues(amount, values.date, values.paymentMethod))
        } catch (error: ApiException) {
            throw QuickExpenseNotBooked(billId, error)
        }
        return billId
    }

    // ── documents ──

    /** Store a receipt (upload, then register it as a document) and return the document's id. */
    suspend fun uploadReceipt(file: LocalFile): String {
        val fileKey = upload(file)
        val input = ApiDocumentInput(
            type = ApiDocumentInput.Type.RECEIPT,
            fileName = file.fileName,
            originalFileName = file.fileName,
            fileKey = fileKey,
            mimeType = file.mimeType,
            source = ApiDocumentInput.Source.SCAN,
        )
        return call { api.createAccountingDocument(input) }.data.id
    }

    /** Read a document with OCR. A 402 means there are no AI credits. */
    suspend fun processDocument(id: String) {
        call { api.processAccountingDocument(id) }
    }

    suspend fun billFromDocument(id: String): BillPrefill {
        val data = call { api.billFromDocument(id) }.data
        return BillPrefill(
            contactName = data.contactName?.ifBlank { null },
            externalReference = data.externalReference?.ifBlank { null },
            issueDate = data.issueDate?.take(10)?.ifBlank { null },
            dueDate = data.dueDate?.take(10)?.ifBlank { null },
            currency = data.currency?.ifBlank { null },
            items = data.items.map { PrefillLine(it.description, it.quantity, it.unitPrice, it.taxRate?.ifBlank { null }, it.sortOrder ?: 0) },
            subtotal = data.subtotal?.let(Amounts::of),
            taxTotal = data.taxTotal?.let(Amounts::of),
            total = data.total?.let(Amounts::of),
            sourceDocumentId = data.sourceDocumentId,
            matchedContactId = data.matchedContactId,
        )
    }

    /** The image a bill was booked from; null without a stored image (a PDF isn't shown). */
    suspend fun storedReceipt(documentId: String): StoredFile? {
        val document = call { api.getAccountingDocument(documentId) }.data
        val mime = document.mimeType
        if (mime != null && !mime.startsWith("image/")) return null
        val key = document.fileKey.split('/').joinToString("/") { java.net.URLEncoder.encode(it, "UTF-8").replace("+", "%20") }
        val body = rawBody { raw.privateFile(key) }
        return StoredFile(body.bytes(), mime)
    }

    /** The storage broker's three steps: a ticket, the bytes, the confirmation. Returns the file key. */
    private suspend fun upload(file: LocalFile): String {
        val ticketBody = buildJsonObject {
            put("fileName", file.fileName)
            put("contentType", file.mimeType)
            put("fileSize", file.bytes.size)
            put("folder", "accounting-documents")
            put("entityType", "accounting-document")
        }.toString().toRequestBody(JSON)
        val ticket = WeldJson.parseToJsonElement(rawBody { raw.uploadTicket(ticketBody) }.string()).jsonObject
        val uploadUrl = ticket["uploadUrl"]?.jsonPrimitive?.content ?: throw ApiException(0, null, "Upload URL unavailable")
        val uploadToken = ticket["uploadToken"]?.jsonPrimitive?.content ?: throw ApiException(0, null, "Upload URL unavailable")
        val fileKey = ticket["fileKey"]?.jsonPrimitive?.content ?: throw ApiException(0, null, "Upload URL unavailable")
        // The token in the URL is the credential; the upload takes no session header.
        val put = Request.Builder().url(uploadUrl).put(file.bytes.toRequestBody(file.mimeType.toMediaType())).build()
        try {
            kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
                env.http.newCall(put).execute().use { response ->
                    if (!response.isSuccessful) throw ApiException(response.code, null, "Upload failed")
                }
            }
        } catch (error: IOException) {
            throw ApiException(null, null, error.message, error)
        }
        val confirm = buildJsonObject {
            put("uploadToken", uploadToken)
            put("fileKey", fileKey)
        }.toString().toRequestBody(JSON)
        rawBody { raw.confirmUpload(confirm) }.close()
        return fileKey
    }

    // ── contacts ──

    suspend fun contacts(search: String?, role: String?): List<Contact> =
        call { api.listAccountingContacts(page = 1, pageSize = 100, search = search, role = role) }.data.map(::contact)

    suspend fun contact(id: String): Contact = contact(call { api.getAccountingContact(id) }.data)

    suspend fun contactBalance(id: String): ContactBalance {
        val data = call { api.getContactBalance(id) }.data
        return ContactBalance(Amounts.of(data.receivable.totalOutstanding), Amounts.of(data.payable.totalOutstanding))
    }

    suspend fun contactInvoices(id: String): List<Invoice> = call { api.listContactInvoices(id) }.data.map(::invoice)

    suspend fun contactBills(id: String): List<Bill> = call { api.listContactBills(id) }.data.map(::bill)

    suspend fun createContact(values: NewContact): String {
        val identity = values.identity
        val input = ApiContactInput(
            kind = ApiContactInput.Kind.entries.firstOrNull { it.value == identity.kind },
            fullName = identity.fullName,
            companyName = identity.companyName,
            firstName = identity.firstName,
            lastName = identity.lastName,
            email = values.email,
            phone = values.phone,
            vatNumber = identity.vatNumber,
            role = ApiContactInput.Role.entries.firstOrNull { it.value == values.role },
            billingAddress = values.billingAddress?.let(::postal),
        )
        return call { api.createAccountingContact(input) }.data.id
    }

    suspend fun deleteContact(id: String) {
        callNoContent { api.deleteAccountingContact(id) }
    }

    /** The contact whose name is [name] (ignoring case), or null. Never creates one. */
    suspend fun findContactId(name: String): String? {
        val wanted = name.trim()
        if (wanted.isEmpty()) return null
        return runCatching {
            call { api.listAccountingContacts(page = 1, pageSize = 25, search = wanted) }.data
                .firstOrNull { it.name.equals(wanted, ignoreCase = true) }?.id
        }.getOrNull()
    }

    /** Invoices and bills need a contact id; the forms take a name, so find the contact or create it. */
    private suspend fun resolveContactId(name: String, email: String?): String {
        findContactId(name)?.let { return it }
        val input = ApiContactInput(fullName = name.trim(), email = email?.ifBlank { null })
        return call { api.createAccountingContact(input) }.data.id
    }

    // ── ledger ──

    suspend fun accounts(): List<GlAccount> = call { api.listGlAccounts() }.data.map {
        GlAccount(it.id, it.code, it.name, it.type, it.isActive != false)
    }

    // ── banking ──

    suspend fun bankAccounts(): List<BankAccount> = call { api.listBankAccounts() }.data.map(::bankAccount)

    suspend fun bankAccount(id: String): Pair<BankAccount, List<BankTransaction>> = coroutineScope {
        val account = async { bankAccount(call { api.getBankAccount(id) }.data) }
        val lines = async { call { api.listBankTransactions(bankAccountId = id, page = 1, pageSize = 50) }.data.map(::transaction) }
        account.await() to lines.await()
    }

    suspend fun reconciliationStats(): ReconciliationStats = coroutineScope {
        val open = async { call { api.listBankTransactions(status = "unreconciled", page = 1, pageSize = 100) } }
        val done = async { call { api.listBankTransactions(status = "reconciled", page = 1, pageSize = 1) } }
        val unmatched = open.await()
        ReconciliationStats(
            unmatched = unmatched.pagination.totalCount,
            matched = done.await().pagination.totalCount,
            pendingAmount = unmatched.data.fold(BigDecimal.ZERO) { sum, line -> sum + Amounts.of(line.amount).abs() },
        )
    }

    /**
     * Open bank lines with the invoices and bills they may pay. A line's
     * suggestions that fail to load degrade to none; payments, deposits and
     * rules are left out, as a line can only be matched to an invoice or bill here.
     */
    suspend fun unmatchedTransactions(limit: Int): List<UnmatchedTransaction> = coroutineScope {
        val lines = call { api.listBankTransactions(status = "unreconciled", page = 1, pageSize = limit) }.data.map(::transaction)
        lines.map { line ->
            async {
                val suggestions = runCatching { call { api.listMatchSuggestions(line.id) }.data }.getOrDefault(emptyList())
                    .filter { it.type == "invoice" || it.type == "bill" }
                    .map { MatchSuggestion(it.id, it.type, it.number, it.contactName, Amounts.of(it.amount), it.confidence) }
                UnmatchedTransaction(line, suggestions)
            }
        }.map { it.await() }
    }

    suspend fun reconcile(transactionId: String, suggestion: MatchSuggestion) {
        val type = if (suggestion.type == "invoice") ReconcileInput.Type.INVOICE else ReconcileInput.Type.BILL
        call { api.reconcileTransaction(transactionId, ReconcileInput(type = type, entityId = suggestion.id)) }
    }

    // ── calls ──

    /** The body of a successful call; a refusal as [ApiException] (or [CompanyFieldsMissing]). */
    private suspend fun <T> call(block: suspend () -> Response<T>): T {
        val response = send(block)
        return response.body() ?: throw ApiException(response.code(), null, "Empty response")
    }

    private suspend fun callNoContent(block: suspend () -> Response<Unit>) {
        send(block)
    }

    private suspend fun rawBody(block: suspend () -> Response<ResponseBody>): ResponseBody {
        val response = send(block)
        return response.body() ?: throw ApiException(response.code(), null, "Empty response")
    }

    private suspend fun <T> send(block: suspend () -> Response<T>): Response<T> {
        val response = try {
            block()
        } catch (error: IOException) {
            throw ApiException(status = null, code = null, message = error.message, cause = error)
        }
        if (response.isSuccessful) return response
        val error = response.errorBody()?.string()?.let { text ->
            runCatching { WeldJson.decodeFromString(ErrorResponse.serializer(), text).error }.getOrNull()
        }
        val missing = error?.details?.missingFields.orEmpty()
        if (missing.isNotEmpty()) throw CompanyFieldsMissing(missing, error?.message)
        throw ApiException(response.code(), error?.code, error?.message)
    }

    // ── mapping ──

    private fun postal(address: Address) = PostalAddress(
        line1 = address.line1, line2 = address.line2, city = address.city, state = address.state,
        postalCode = address.postalCode, country = address.country, county = address.county,
    )

    private fun address(postal: PostalAddress?): Address? = postal?.let {
        Address(it.line1, it.line2, it.city, it.state, it.postalCode, it.country, it.county).takeUnless { address -> address.isEmpty }
    }

    private fun line(values: LineInputValues) = LineInput(
        description = values.description,
        quantity = values.quantity,
        unitPrice = values.unitPrice,
        taxRate = values.taxRate,
        taxCode = values.taxCode,
        accrueUseTax = values.accrueUseTax.takeIf { it },
        accountId = values.accountId,
        sortOrder = values.sortOrder,
    )

    internal fun entity(row: ApiEntity): Entity {
        val ids = row.taxIdentifiers
        val ein = ids?.einOrSsn?.trim()?.takeIf { Regex("^\\d{2}-\\d{7}$").matches(it) }
        return Entity(
            id = row.id,
            name = row.name,
            legalName = row.legalName,
            jurisdictionCode = row.jurisdictionCode,
            baseCurrency = row.baseCurrency,
            locale = row.locale,
            address = address(row.address),
            entityType = row.entityType,
            taxClassification = row.taxClassification,
            dba = row.dba,
            ein = ein,
            vatNumber = ids?.vatNumber?.trim()?.ifEmpty { null },
            registrationNumber = ids?.registrationNumber?.trim()?.ifEmpty { null },
            iban = row.bankDetails?.iban?.trim()?.ifEmpty { null },
            bic = row.bankDetails?.bic?.trim()?.ifEmpty { null },
            fiscalYearStart = row.fiscalYearStart,
            isDefault = row.isDefault == true,
            isActive = row.isActive != false,
        )
    }

    private fun jurisdiction(row: ApiJurisdiction): Jurisdiction {
        val f = row.features
        val t = row.terminology
        return Jurisdiction(
            code = row.code.uppercase(),
            name = row.name,
            defaultLocale = row.defaultLocale,
            defaultCurrency = row.defaultCurrency,
            features = Features(f.vatReturn, f.icp, f.xafExport, f.smallBusinessScheme, f.gstReturn, f.salesTax, f.form1099, f.brTaxReturn, f.fiscalDocuments, f.spedEcd),
            terminology = Terminology(t.tax, t.taxId, t.registrationId, t.supplier, t.creditNote),
            invoiceRequiredFields = row.invoiceRequiredFields,
            entityTypes = row.entityTypes?.map { type ->
                UsEntityType(
                    type = type.type,
                    label = type.label,
                    defaultClassification = type.defaultClassification,
                    classifications = type.classifications.map { UsClassification(it.value, it.form, it.formLabel) },
                )
            },
        )
    }

    private fun taxRow(row: ApiTaxRow) = TaxRow(
        name = row.taxRateName,
        rate = Amounts.of(row.taxRate),
        taxableAmount = Amounts.of(row.taxableAmount),
        taxAmount = Amounts.of(row.taxAmount),
        jurisdictionCode = row.jurisdictionCode,
        jurisdictionName = row.jurisdictionName,
        level = row.jurisdictionLevel,
        stateCode = row.stateCode,
        exemptAmount = Amounts.of(row.exemptAmount),
        nonTaxableAmount = Amounts.of(row.nonTaxableAmount),
        exemptReason = row.exemptReason?.ifBlank { null },
        kind = row.kind,
        component = row.component,
        treatment = row.treatment,
    )

    private fun documentLine(row: ApiItem) = DocumentLine(
        id = row.id,
        description = row.description,
        quantity = Amounts.of(row.quantity ?: "1"),
        unitPrice = Amounts.of(row.unitPrice),
        taxRate = Amounts.of(row.taxRate),
        lineTotal = Amounts.of(row.lineTotal),
        taxCode = row.taxCode,
        accrueUseTax = row.accrueUseTax == true,
    )

    internal fun invoice(row: ApiInvoice) = Invoice(
        id = row.id,
        number = row.invoiceNumber?.ifBlank { null },
        type = row.type,
        status = row.status,
        contactId = row.contactId,
        contactName = row.contactName?.ifBlank { null },
        contactEmail = row.contactEmail?.ifBlank { null },
        issueDate = row.issueDate,
        dueDate = row.dueDate,
        currency = row.currency?.ifBlank { null },
        subtotal = Amounts.of(row.subtotal),
        taxTotal = Amounts.of(row.taxTotal),
        total = Amounts.of(row.total),
        amountPaid = Amounts.of(row.amountPaid),
        balanceDue = Amounts.of(row.balanceDue),
        notes = row.notes?.ifBlank { null },
        reference = row.reference?.ifBlank { null },
        billingAddress = address(row.billingAddress),
        shippingAddress = address(row.shippingAddress),
        taxBreakdown = row.taxBreakdown.orEmpty().map(::taxRow),
        taxWarnings = row.taxWarnings.orEmpty().filter { it.isNotBlank() },
        lines = row.items.orEmpty().map(::documentLine),
    )

    internal fun bill(row: ApiBill) = Bill(
        id = row.id,
        number = row.billNumber?.ifBlank { null },
        status = row.status,
        approvalStatus = row.approvalStatus,
        contactId = row.contactId,
        contactName = row.contactName?.ifBlank { null },
        issueDate = row.issueDate,
        dueDate = row.dueDate,
        currency = row.currency?.ifBlank { null },
        subtotal = Amounts.of(row.subtotal),
        taxTotal = Amounts.of(row.taxTotal),
        total = Amounts.of(row.total),
        amountPaid = Amounts.of(row.amountPaid),
        balanceDue = Amounts.of(row.balanceDue),
        notes = row.notes?.ifBlank { null },
        reference = (row.reference ?: row.externalReference)?.ifBlank { null },
        sourceDocumentId = row.sourceDocumentId,
        deliveryAddress = address(row.deliveryAddress),
        taxBreakdown = row.taxBreakdown.orEmpty().map(::taxRow),
        lines = row.items.orEmpty().map(::documentLine),
    )

    private fun contact(row: ApiContact): Contact {
        val kind = row.kind?.takeIf { it == "company" || it == "person" }
        val person = row.contactPerson?.takeIf { kind == "company" && it.personId.isNotEmpty() }
        return Contact(
            id = row.id,
            name = row.name,
            kind = kind,
            role = row.role,
            email = row.email?.ifBlank { null },
            phone = row.phone?.ifBlank { null },
            vatNumber = row.vatNumber?.ifBlank { null },
            contactPerson = person?.let { ContactPerson(it.name, it.email?.ifBlank { null }, it.phone?.ifBlank { null }) },
            billingAddress = address(row.billingAddress),
            shippingAddress = address(row.shippingAddress),
            is1099Vendor = row.is1099Vendor == true,
            tinType = row.tinType?.takeIf { it in setOf("ein", "ssn", "itin") },
            tinLast4 = row.tinLast4?.takeIf { Regex("^\\d{4}$").matches(it) },
        )
    }

    private fun bankAccount(row: org.weldsuite.api.weldbooks.models.BankAccount) = BankAccount(
        id = row.id,
        name = row.name,
        iban = row.iban?.ifBlank { null },
        bankName = row.bankName?.ifBlank { null },
        accountType = row.accountType,
        routingNumber = row.routingNumber?.ifBlank { null },
        accountNumberLast4 = row.accountNumberLast4,
        currency = row.currency?.ifBlank { null },
        balance = Amounts.of(row.currentBalance),
        lastImportDate = row.lastImportDate,
    )

    private fun transaction(row: org.weldsuite.api.weldbooks.models.BankTransaction) = BankTransaction(
        id = row.id,
        bankAccountId = row.bankAccountId,
        date = row.date,
        description = row.description?.ifBlank { null },
        amount = Amounts.of(row.amount),
        status = row.status,
        counterpartyName = row.counterpartyName?.ifBlank { null },
        reference = row.reference?.ifBlank { null },
    )

    internal fun vatReturn(row: ApiVatReturn): VatReturn {
        val boxes = row.rubrieken
        val values = buildMap {
            boxes?.r1a?.let { put("r1a", Amounts.of(it)) }
            boxes?.r1b?.let { put("r1b", Amounts.of(it)) }
            boxes?.r2a?.let { put("r2a", Amounts.of(it)) }
            boxes?.r3a?.let { put("r3a", Amounts.of(it)) }
            boxes?.r3b?.let { put("r3b", Amounts.of(it)) }
            boxes?.r4a?.let { put("r4a", Amounts.of(it)) }
            boxes?.r4b?.let { put("r4b", Amounts.of(it)) }
        }
        val sales = Amounts.of(boxes?.r5a)
        val purchase = Amounts.of(boxes?.r5b)
        val start = row.periodStart.take(10)
        return VatReturn(
            id = row.id,
            period = row.periodLabel?.ifBlank { null } ?: start.take(7),
            year = start.take(4).toIntOrNull() ?: 0,
            status = Statuses.vatReturn(row.status),
            salesTax = sales,
            purchaseTax = purchase,
            netAmount = boxes?.r5c?.let(Amounts::of) ?: sales.subtract(purchase),
            periodStart = row.periodStart,
            periodEnd = row.periodEnd,
            filedAt = row.filedAt,
            boxes = values,
        )
    }

    private companion object {
        const val ENTITY_HEADER = "X-Accounting-Entity-Id"
        val JSON = "application/json".toMediaType()
    }
}
