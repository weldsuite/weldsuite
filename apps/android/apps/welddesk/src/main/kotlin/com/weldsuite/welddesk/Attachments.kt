package com.weldsuite.welddesk

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import androidx.core.content.FileProvider
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.io.IOException

/** What became of a file the agent picked. */
sealed interface ReadResult {
    data class File(val file: PickedFile) : ReadResult
    data class Refused(val name: String, val problem: DeskLogic.AttachmentProblem) : ReadResult
    data class Failed(val name: String) : ReadResult
}

/** Reads a picked photo or document from its content URI, and makes room for a camera photo. */
object Attachments {
    /** The name, type and size of [uri], then its bytes when it can go on a reply. */
    suspend fun read(context: Context, uri: Uri, fallbackName: String): ReadResult = withContext(Dispatchers.IO) {
        val resolver = context.contentResolver
        var name: String? = null
        var size: Long? = null
        runCatching {
            resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { cursor ->
                if (cursor.moveToFirst()) {
                    val nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                    val sizeIndex = cursor.getColumnIndex(OpenableColumns.SIZE)
                    if (nameIndex >= 0 && !cursor.isNull(nameIndex)) name = cursor.getString(nameIndex)
                    if (sizeIndex >= 0 && !cursor.isNull(sizeIndex)) size = cursor.getLong(sizeIndex)
                }
            }
        }
        val display = DeskLogic.displayName(name, fallbackName)
        val type = resolver.getType(uri)?.lowercase()
        DeskLogic.attachmentProblem(type, size)?.let { return@withContext ReadResult.Refused(display, it) }
        try {
            val bytes = resolver.openInputStream(uri)?.use { input ->
                // One byte more than allowed tells a file without a known size is too large.
                val buffer = input.readNBytesCompat(DeskLogic.MAX_ATTACHMENT_BYTES + 1)
                buffer
            } ?: return@withContext ReadResult.Failed(display)
            if (bytes.size > DeskLogic.MAX_ATTACHMENT_BYTES) {
                return@withContext ReadResult.Refused(display, DeskLogic.AttachmentProblem.TOO_LARGE)
            }
            ReadResult.File(PickedFile(display, type ?: "application/octet-stream", bytes))
        } catch (_: IOException) {
            ReadResult.Failed(display)
        } catch (_: SecurityException) {
            ReadResult.Failed(display)
        }
    }

    /** A new file for the camera to write a photo to, as a URI it may write (the app's FileProvider). */
    fun cameraUri(context: Context): Uri {
        val folder = File(context.cacheDir, "camera").apply { mkdirs() }
        val file = File(folder, "photo-${System.currentTimeMillis()}.jpg")
        return FileProvider.getUriForFile(context, "${context.packageName}.files", file)
    }

    /** `InputStream.readNBytes` before API 33. */
    private fun java.io.InputStream.readNBytesCompat(limit: Long): ByteArray {
        val out = java.io.ByteArrayOutputStream()
        val chunk = ByteArray(64 * 1024)
        var total = 0L
        while (total < limit) {
            val read = read(chunk, 0, minOf(chunk.size.toLong(), limit - total).toInt())
            if (read < 0) break
            out.write(chunk, 0, read)
            total += read
        }
        return out.toByteArray()
    }
}
