package com.weldsuite.weldchat.media

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import android.webkit.MimeTypeMap
import com.weldsuite.weldchat.ChatAttachment
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.MultipartBody
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.weldsuite.core.AppEnvironment
import org.weldsuite.core.WeldJson
import org.weldsuite.core.api.ApiException
import java.io.IOException
import java.util.UUID
import java.util.concurrent.TimeUnit

/** A file picked (or recorded) to send with a message. */
data class PendingFile(
    val name: String,
    val uri: Uri,
    val mimeType: String,
    val id: String = UUID.randomUUID().toString(),
) {
    val isImage: Boolean get() = mimeType.startsWith("image/")
    val isAudio: Boolean get() = mimeType.startsWith("audio/")
}

/** What the system pickers hand over, as [PendingFile]s. */
object PickedFiles {
    /** A picked file's name and type, from the content provider. */
    fun from(context: Context, uri: Uri): PendingFile {
        val resolver = context.contentResolver
        val name = runCatching {
            resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
                if (cursor.moveToFirst()) cursor.getString(0) else null
            }
        }.getOrNull() ?: uri.lastPathSegment?.substringAfterLast('/') ?: "file"
        val type = resolver.getType(uri) ?: mimeType(name.substringAfterLast('.', ""))
        return PendingFile(name = name, uri = uri, mimeType = type)
    }

    fun mimeType(extension: String): String =
        MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension.lowercase()) ?: "application/octet-stream"
}

/**
 * The upload the contract can't describe (multipart): `POST
 * /api/chat-messages/upload` with `file` and `channelId`, answering 201
 * `{ data: { id, fileName, fileSize, mimeType, url } }`. Sent with the
 * headers every API call carries (bearer token, `X-Weld-App`,
 * `X-Weld-Workspace`); a 401 refreshes the token once.
 */
object ChatUpload {
    @Serializable
    private data class Answer(val data: File) {
        @Serializable
        data class File(
            val id: String? = null,
            val fileName: String? = null,
            val fileSize: Double? = null,
            val mimeType: String? = null,
            val url: String,
        )
    }

    /** Upload [file] into [channelId]'s attachments. Throws `ApiException`. */
    suspend fun upload(context: Context, env: AppEnvironment, file: PendingFile, channelId: String): ChatAttachment {
        val session = env.session ?: throw ApiException(null, null, null)
        val workspace = session.activeWorkspaceId ?: throw ApiException(null, null, null)
        val bytes = withContext(Dispatchers.IO) {
            try {
                context.contentResolver.openInputStream(file.uri)?.use { it.readBytes() }
            } catch (_: IOException) {
                null
            } catch (_: SecurityException) {
                null
            }
        } ?: throw ApiException(0, null, "File unreadable")
        val body = MultipartBody.Builder()
            .setType(MultipartBody.FORM)
            .addFormDataPart("channelId", channelId)
            .addFormDataPart("file", file.name.replace("\"", ""), bytes.toRequestBody(file.mimeType.toMediaTypeOrNull()))
            .build()
        val client = env.http.newBuilder()
            .writeTimeout(120, TimeUnit.SECONDS)
            .readTimeout(120, TimeUnit.SECONDS)
            .build()
        var token = session.getToken()
        repeat(2) { attempt ->
            val request = Request.Builder()
                .url("${env.serverOrigin}/api/chat-messages/upload")
                .post(body)
                .header("Accept", "application/json")
                .header("X-Weld-App", env.app.code)
                .header("X-Weld-Workspace", workspace)
                .apply { token?.let { header("Authorization", "Bearer $it") } }
                .build()
            val (status, text) = withContext(Dispatchers.IO) {
                try {
                    client.newCall(request).execute().use { response -> response.code to response.body?.string() }
                } catch (exception: IOException) {
                    throw ApiException(null, null, exception.message, exception)
                }
            }
            if (status == 401 && attempt == 0) {
                val fresh = session.refreshToken()
                if (fresh != null) {
                    token = fresh
                    return@repeat
                }
            }
            val answer = text?.takeIf { status in 200..299 }?.let {
                runCatching { WeldJson.decodeFromString(Answer.serializer(), it) }.getOrNull()
            } ?: throw ApiException(status, null, null)
            return ChatAttachment(
                id = answer.data.id ?: UUID.randomUUID().toString(),
                fileName = answer.data.fileName ?: file.name,
                fileSize = answer.data.fileSize ?: bytes.size.toDouble(),
                mimeType = answer.data.mimeType ?: file.mimeType,
                url = answer.data.url,
            )
        }
        throw ApiException(401, null, null)
    }
}
