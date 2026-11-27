package com.weldsuite.weldmail.offline

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import com.weldsuite.weldmail.LabelState
import com.weldsuite.weldmail.MailAccount
import com.weldsuite.weldmail.MailMessage
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.withContext
import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import org.weldsuite.core.WeldJson
import java.io.File

/**
 * The last mail the phone saw, per workspace, so the app reads offline and
 * opens with something on screen (the Expo app's `lib/offline/cache.ts`):
 * each list (mailbox and folder), the mailboxes, the labels, and every message
 * and conversation once opened. Entries carry a version; a different one reads
 * as a miss, so a changed shape never reaches the screens.
 */
class MailCache(private val directory: File) {
    @Serializable
    private data class Envelope<T>(val v: Int, val t: Long, val data: T)

    private fun file(workspace: String, key: String) =
        File(File(directory, safe(workspace)), "${safe(key)}.json")

    private suspend fun <T> read(workspace: String, key: String, serializer: KSerializer<T>): T? = withContext(Dispatchers.IO) {
        val file = file(workspace, key)
        if (!file.exists()) return@withContext null
        runCatching {
            val envelope = WeldJson.decodeFromString(Envelope.serializer(serializer), file.readText())
            envelope.data.takeIf { envelope.v == VERSION }
        }.getOrNull()
    }

    private suspend fun <T> write(workspace: String, key: String, serializer: KSerializer<T>, data: T) = withContext(Dispatchers.IO) {
        runCatching {
            val file = file(workspace, key)
            file.parentFile?.mkdirs()
            val temp = File(file.parentFile, "${file.name}.tmp")
            temp.writeText(WeldJson.encodeToString(Envelope.serializer(serializer), Envelope(VERSION, System.currentTimeMillis(), data)))
            temp.renameTo(file)
        }
        Unit
    }

    private val messages = ListSerializer(MailMessage.serializer())

    suspend fun messages(workspace: String, scope: String, label: String) = read(workspace, "messages.$scope.$label", messages)

    suspend fun putMessages(workspace: String, scope: String, label: String, list: List<MailMessage>) =
        write(workspace, "messages.$scope.$label", messages, list.take(MAX_LIST))

    suspend fun accounts(workspace: String) = read(workspace, "accounts", ListSerializer(MailAccount.serializer()))

    suspend fun putAccounts(workspace: String, list: List<MailAccount>) =
        write(workspace, "accounts", ListSerializer(MailAccount.serializer()), list)

    suspend fun labels(workspace: String, scope: String) = read(workspace, "labels.$scope", LabelState.serializer())

    suspend fun putLabels(workspace: String, scope: String, state: LabelState) =
        write(workspace, "labels.$scope", LabelState.serializer(), state)

    suspend fun message(workspace: String, id: String) = read(workspace, "message.$id", MailMessage.serializer())

    suspend fun putMessage(workspace: String, message: MailMessage) =
        write(workspace, "message.${message.id}", MailMessage.serializer(), message)

    suspend fun thread(workspace: String, id: String) = read(workspace, "thread.$id", messages)

    suspend fun putThread(workspace: String, id: String, list: List<MailMessage>) = write(workspace, "thread.$id", messages, list)

    /** Everything, for every workspace: at sign-out nothing stays behind. */
    suspend fun clearAll() = withContext(Dispatchers.IO) {
        directory.deleteRecursively()
        Unit
    }

    private fun safe(name: String) = name.replace(Regex("[^A-Za-z0-9_.-]"), "_")

    private companion object {
        /** Bump to drop every entry after a change in what is stored. */
        const val VERSION = 1

        /** A list keeps its first pages; older ones load from the server. */
        const val MAX_LIST = 200
    }
}

/** Whether the phone has a working connection, as it changes. */
class Connectivity(context: Context) {
    private val manager = context.getSystemService(ConnectivityManager::class.java)
    private val state = MutableStateFlow(current())

    val online: StateFlow<Boolean> = state.asStateFlow()

    init {
        val request = NetworkRequest.Builder().addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET).build()
        runCatching {
            manager?.registerNetworkCallback(
                request,
                object : ConnectivityManager.NetworkCallback() {
                    override fun onAvailable(network: Network) {
                        state.value = true
                    }

                    override fun onLost(network: Network) {
                        state.value = current()
                    }

                    override fun onUnavailable() {
                        state.value = false
                    }
                },
            )
        }
    }

    private fun current(): Boolean {
        val network = manager?.activeNetwork ?: return false
        val capabilities = manager.getNetworkCapabilities(network) ?: return false
        return capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
    }
}
