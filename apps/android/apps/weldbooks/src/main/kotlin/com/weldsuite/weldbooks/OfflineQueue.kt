package com.weldsuite.weldbooks

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import com.weldsuite.weldbooks.logic.Amounts
import com.weldsuite.weldbooks.logic.PrefillLine
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import org.weldsuite.core.WeldJson
import org.weldsuite.core.api.ApiException
import org.weldsuite.core.AppEnvironment
import java.io.File
import java.util.UUID

/** A receipt photo kept on this phone until it is stored. */
@Serializable
data class QueuedReceipt(val path: String, val fileName: String, val mimeType: String)

@Serializable
data class QueuedLine(val description: String, val quantity: String, val unitPrice: String, val taxRate: String? = null, val sortOrder: Int = 0)

/** A quick expense saved without a connection. */
@Serializable
data class QueuedExpense(
    val amount: String,
    val category: String,
    val description: String? = null,
    val vendorName: String? = null,
    val contactId: String? = null,
    val currency: String? = null,
    val date: String,
    val documentId: String? = null,
    val accountId: String? = null,
    val taxRate: String = "0",
    val receiptLines: List<QueuedLine>? = null,
    val roundingDescription: String,
    val paymentMethod: String,
    val accrueUseTax: Boolean = false,
    val taxCode: String? = null,
)

/** An expense or a scanned receipt waiting for a connection, for the workspace and company it was captured in. */
@Serializable
data class QueuedItem(
    val id: String,
    /** `expense` or `document`. */
    val type: String,
    val workspaceId: String,
    val entityId: String?,
    val createdAt: Long,
    val expense: QueuedExpense? = null,
    val receipt: QueuedReceipt? = null,
)

/**
 * Receipts scanned and expenses entered without a connection, kept in a file
 * and replayed one by one against the regular routes when the connection
 * returns. What fails stays queued; what was already stored (a receipt's
 * document) is kept with it, so a retry doesn't store it twice.
 */
class OfflineQueue(context: Context, private val env: AppEnvironment) {
    private val appContext = context.applicationContext
    private val file = File(appContext.filesDir, "weldbooks-queue.json")
    private val receipts = File(appContext.filesDir, "receipts").apply { mkdirs() }
    private val scope = CoroutineScope(Dispatchers.Main)
    private val lock = Mutex()
    private val itemsFlow = MutableStateFlow(read())
    private val onlineFlow = MutableStateFlow(true)
    private val syncingFlow = MutableStateFlow(false)

    val items: StateFlow<List<QueuedItem>> = itemsFlow.asStateFlow()
    val isOnline: StateFlow<Boolean> = onlineFlow.asStateFlow()
    val isSyncing: StateFlow<Boolean> = syncingFlow.asStateFlow()

    init {
        val connectivity = appContext.getSystemService(ConnectivityManager::class.java)
        onlineFlow.value = connectivity?.activeNetwork?.let { network ->
            connectivity.getNetworkCapabilities(network)?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
        } ?: false
        connectivity?.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                onlineFlow.value = true
                scope.launch { sync() }
            }

            override fun onLost(network: Network) {
                onlineFlow.value = false
            }
        })
    }

    /** Keep a copy of a photo in the app's own storage, so the receipt survives until it is stored. */
    fun keep(bytes: ByteArray, mimeType: String): QueuedReceipt {
        val extension = mimeType.substringAfter('/').replace("jpeg", "jpg").ifEmpty { "jpg" }
        val target = File(receipts, "${UUID.randomUUID()}.$extension")
        target.writeBytes(bytes)
        return QueuedReceipt(target.absolutePath, receiptFileName(mimeType), mimeType)
    }

    suspend fun addExpense(workspaceId: String, entityId: String?, expense: QueuedExpense, receipt: QueuedReceipt?) {
        add(QueuedItem(id(), "expense", workspaceId, entityId, System.currentTimeMillis(), expense = expense, receipt = receipt))
    }

    suspend fun addDocument(workspaceId: String, entityId: String?, receipt: QueuedReceipt) {
        add(QueuedItem(id(), "document", workspaceId, entityId, System.currentTimeMillis(), receipt = receipt))
    }

    /** Replay the current workspace's items; keep the ones that fail. */
    suspend fun sync() {
        val workspace = env.session?.activeWorkspaceId ?: return
        if (syncingFlow.value || itemsFlow.value.none { it.workspaceId == workspace }) return
        syncingFlow.value = true
        try {
            for (item in itemsFlow.value.filter { it.workspaceId == workspace }) {
                val outcome = runCatching { replay(item) }
                lock.withLock {
                    val current = itemsFlow.value
                    val next = outcome.fold(
                        onSuccess = { kept -> current.mapNotNull { if (it.id == item.id) kept else it } },
                        onFailure = { current },
                    )
                    if (outcome.isSuccess && next.none { it.id == item.id }) item.receipt?.let { File(it.path).delete() }
                    write(next)
                }
            }
        } finally {
            syncingFlow.value = false
        }
    }

    /** Null once the item is done; else the item to keep (with what this attempt stored). */
    private suspend fun replay(item: QueuedItem): QueuedItem? {
        val repository = BooksRepository(env).also { it.entityId = item.entityId }
        return when (item.type) {
            "document" -> {
                val receipt = item.receipt ?: return null
                val bytes = readBytes(receipt) ?: return null
                repository.uploadReceipt(LocalFile(bytes, receipt.fileName, receipt.mimeType))
                null
            }
            "expense" -> replayExpense(repository, item)
            else -> null
        }
    }

    private suspend fun replayExpense(repository: BooksRepository, item: QueuedItem): QueuedItem? {
        val expense = item.expense ?: return null
        var documentId = expense.documentId
        val receipt = item.receipt
        if (documentId == null && receipt != null) {
            documentId = readBytes(receipt)?.let { repository.uploadReceipt(LocalFile(it, receipt.fileName, receipt.mimeType)) }
        }
        return try {
            repository.createQuickExpense(expense.values(documentId))
            null
        } catch (error: QuickExpenseNotBooked) {
            // The bill exists as a draft; queueing it again would create it twice.
            null
        } catch (error: ApiException) {
            // Keep the stored receipt with the item: the retry links it instead of storing it again.
            if (documentId != expense.documentId) {
                receipt?.let { File(it.path).delete() }
                item.copy(expense = expense.copy(documentId = documentId), receipt = null)
            } else {
                throw error
            }
        }
    }

    private suspend fun readBytes(receipt: QueuedReceipt): ByteArray? = withContext(Dispatchers.IO) {
        File(receipt.path).takeIf { it.exists() && it.length() > 0 }?.readBytes()
    }

    private suspend fun add(item: QueuedItem) = lock.withLock { write(itemsFlow.value + item) }

    private suspend fun write(items: List<QueuedItem>) {
        itemsFlow.value = items
        withContext(Dispatchers.IO) {
            runCatching { file.writeText(WeldJson.encodeToString(ListSerializer(QueuedItem.serializer()), items)) }
        }
    }

    private fun read(): List<QueuedItem> = runCatching {
        if (!file.exists()) emptyList() else WeldJson.decodeFromString(ListSerializer(QueuedItem.serializer()), file.readText())
    }.getOrDefault(emptyList())

    private fun id() = "oq_${UUID.randomUUID()}"

    companion object {
        /** The name a receipt is stored under: a PNG or HEIC keeps its own extension. */
        fun receiptFileName(mimeType: String, at: Long = System.currentTimeMillis()): String {
            val extension = mimeType.substringAfter('/', "").replace("jpeg", "jpg").ifEmpty { "jpg" }
            return "receipt-$at.$extension"
        }
    }
}

/** A queued expense as the repository takes it. */
fun QueuedExpense.values(documentId: String?): QuickExpenseValues = QuickExpenseValues(
    amount = Amounts.of(amount),
    category = category,
    description = description,
    vendorName = vendorName,
    contactId = contactId,
    currency = currency,
    date = date,
    documentId = documentId,
    accountId = accountId,
    taxRate = Amounts.of(taxRate),
    receiptLines = receiptLines?.map { PrefillLine(it.description, it.quantity, it.unitPrice, it.taxRate, it.sortOrder) },
    roundingDescription = roundingDescription,
    paymentMethod = paymentMethod,
    accrueUseTax = accrueUseTax,
    taxCode = taxCode,
)
