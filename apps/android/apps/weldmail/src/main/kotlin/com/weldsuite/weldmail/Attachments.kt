package com.weldsuite.weldmail

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import android.webkit.MimeTypeMap
import androidx.core.content.FileProvider
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.weldsuite.core.AppEnvironment
import org.weldsuite.core.WeldJson
import org.weldsuite.core.api.ApiException
import java.io.File
import java.io.IOException

/** A file picked in the composer, not uploaded yet. */
data class PickedFile(val uri: Uri, val name: String, val mimeType: String, val size: Long)

/**
 * An attachment's bytes, both ways. Neither is JSON, so neither is in the
 * OpenAPI file: they go out with the same headers as every API call (the
 * session's token, `X-Weld-App`, `X-Weld-Workspace`).
 *
 * - Opening one downloads it through `GET /api/mail-attachments/{id}/download`
 *   (the mailbox's access check; no public URL) into the app's cache, and
 *   hands the file to a viewer.
 * - Attaching one asks `POST /api/storage/generate-upload-url` for a one-time
 *   upload URL, `PUT`s the bytes there (without the session's headers: the
 *   URL's token is the permission), and sends the storage key with the mail.
 */
class Attachments(private val context: Context, private val env: AppEnvironment) {
    @Serializable
    private data class UploadUrlRequest(val fileName: String, val contentType: String, val fileSize: Long, val folder: String)

    @Serializable
    private data class UploadUrl(val uploadUrl: String? = null, val fileKey: String? = null)

    private suspend fun authorised(builder: Request.Builder): Request.Builder {
        val token = env.session?.getToken()
        builder.header("X-Weld-App", env.app.code).header("Accept", "*/*")
        token?.let { builder.header("Authorization", "Bearer $it") }
        env.session?.activeWorkspaceId?.let { builder.header("X-Weld-Workspace", it) }
        return builder
    }

    /** Downloads the attachment into the cache (one folder per id). */
    suspend fun download(attachment: MailAttachment): File = withContext(Dispatchers.IO) {
        val url = "${env.serverOrigin}/api/mail-attachments/${Uri.encode(attachment.id)}/download"
        val request = authorised(Request.Builder().url(url).get()).build()
        val response = try {
            env.http.newCall(request).execute()
        } catch (error: IOException) {
            throw ApiException(null, null, error.message, error)
        }
        response.use {
            if (!it.isSuccessful) throw ApiException(it.code, null, "Download failed")
            val folder = File(File(context.cacheDir, CACHE_FOLDER), MailLogic.safeFileName(attachment.id))
            folder.mkdirs()
            val file = File(folder, MailLogic.safeFileName(attachment.fileName))
            val body = it.body ?: throw ApiException(it.code, null, "Empty download")
            file.outputStream().use { out -> body.byteStream().copyTo(out) }
            file
        }
    }

    /** Hands a downloaded file to a viewer. False when the phone has none for it. */
    fun open(file: File, mimeType: String?): Boolean {
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.files", file)
        val type = mimeType?.takeIf { it.isNotBlank() }
            ?: MimeTypeMap.getSingleton().getMimeTypeFromExtension(file.extension.lowercase())
            ?: "*/*"
        val view = Intent(Intent.ACTION_VIEW).setDataAndType(uri, type).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        val chooser = Intent.createChooser(view, file.name).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        return try {
            context.startActivity(chooser)
            true
        } catch (_: ActivityNotFoundException) {
            false
        }
    }

    /** A content URI's name, type and size, for the composer's chips. */
    fun describe(uri: Uri, fallbackName: String): PickedFile {
        var name = fallbackName
        var size = 0L
        context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) {
                cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME).takeIf { it >= 0 }?.let { cursor.getString(it) }?.let { name = it }
                cursor.getColumnIndex(OpenableColumns.SIZE).takeIf { it >= 0 }?.let { if (!cursor.isNull(it)) size = cursor.getLong(it) }
            }
        }
        val type = context.contentResolver.getType(uri) ?: "application/octet-stream"
        return PickedFile(uri, name, type, size)
    }

    /** A file the camera can write a photo to. */
    fun newPhotoUri(): Uri {
        val folder = File(context.cacheDir, PHOTO_FOLDER).apply { mkdirs() }
        val file = File(folder, "photo_${System.currentTimeMillis()}.jpg")
        return FileProvider.getUriForFile(context, "${context.packageName}.files", file)
    }

    /** Uploads one file; what the send references. Throws when it fails, so nothing is sent without it. */
    suspend fun upload(file: PickedFile): UploadedAttachment = withContext(Dispatchers.IO) {
        val bytes = context.contentResolver.openInputStream(file.uri)?.use { it.readBytes() }
            ?: throw IOException("Could not read ${file.name}")
        val request = UploadUrlRequest(file.name, file.mimeType, bytes.size.toLong(), "mail-attachments")
        val generate = authorised(
            Request.Builder()
                .url("${env.serverOrigin}/api/storage/generate-upload-url")
                .post(WeldJson.encodeToString(UploadUrlRequest.serializer(), request).toRequestBody("application/json".toMediaTypeOrNull())),
        ).header("Accept", "application/json").build()
        val target = execute(generate) { body -> WeldJson.decodeFromString(UploadUrl.serializer(), body) }
        val uploadUrl = target.uploadUrl ?: throw ApiException(0, null, "No upload URL")
        val fileKey = target.fileKey ?: throw ApiException(0, null, "No file key")
        // The URL's own one-time token authorises the write: the session's token never goes with it.
        val put = Request.Builder().url(uploadUrl).put(bytes.toRequestBody(file.mimeType.toMediaTypeOrNull())).build()
        execute(put) { }
        UploadedAttachment(filename = file.name, contentType = file.mimeType, size = bytes.size.toLong(), fileKey = fileKey)
    }

    private fun <T> execute(request: Request, read: (String) -> T): T {
        val response = try {
            env.http.newCall(request).execute()
        } catch (error: IOException) {
            throw ApiException(null, null, error.message, error)
        }
        return response.use {
            if (!it.isSuccessful) throw ApiException(it.code, null, "Upload failed")
            read(it.body?.string().orEmpty())
        }
    }

    private companion object {
        const val CACHE_FOLDER = "mail-attachments"
        const val PHOTO_FOLDER = "camera"
    }
}
