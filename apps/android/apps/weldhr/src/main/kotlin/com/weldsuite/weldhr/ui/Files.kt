package com.weldsuite.weldhr.ui

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import androidx.core.content.FileProvider
import com.weldsuite.weldhr.PickedFile
import com.weldsuite.weldhr.Receipts
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File

/** Files in and out: a receipt picked or photographed, a document opened in the phone's viewer. */
object HrFiles {
    private fun authority(context: Context) = "${context.packageName}.files"

    /** Where the camera writes a receipt photo (TakePicture needs a content Uri). */
    fun cameraUri(context: Context): Uri {
        val folder = File(context.cacheDir, "camera").apply { mkdirs() }
        val file = File(folder, "receipt-${System.currentTimeMillis()}.jpg")
        return FileProvider.getUriForFile(context, authority(context), file)
    }

    sealed interface Picked {
        data class File(val file: PickedFile) : Picked
        data class Problem(val problem: Receipts.Problem) : Picked
        data object Failed : Picked
    }

    /** Read a picked photo or PDF, refusing what the server would (type, more than 10 MB). */
    suspend fun read(context: Context, uri: Uri, today: String): Picked = withContext(Dispatchers.IO) {
        val resolver = context.contentResolver
        var name: String? = null
        var size: Long? = null
        runCatching {
            resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { cursor ->
                if (cursor.moveToFirst()) {
                    name = cursor.getString(0)
                    size = if (cursor.isNull(1)) null else cursor.getLong(1)
                }
            }
        }
        val type = resolver.getType(uri) ?: name?.let(Receipts::guessType) ?: Receipts.guessType(uri.toString())
        Receipts.problem(type, size)?.let { return@withContext Picked.Problem(it) }
        val bytes = runCatching { resolver.openInputStream(uri)?.use { it.readBytes() } }.getOrNull() ?: return@withContext Picked.Failed
        if (bytes.size > Receipts.MAX_BYTES) return@withContext Picked.Problem(Receipts.Problem.SIZE)
        val mime = type ?: return@withContext Picked.Problem(Receipts.Problem.TYPE)
        Picked.File(PickedFile(Receipts.fileName(name, mime, today), mime, bytes))
    }

    /** Hand a downloaded file to the phone's viewer; false when none can open it. */
    fun open(context: Context, file: File, mimeType: String): Boolean {
        val uri = FileProvider.getUriForFile(context, authority(context), file)
        val intent = Intent(Intent.ACTION_VIEW)
            .setDataAndType(uri, mimeType)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        return try {
            context.startActivity(intent)
            true
        } catch (_: ActivityNotFoundException) {
            false
        }
    }

    /** The type a viewer needs, from the file name. */
    fun mimeTypeFor(fileName: String): String = Receipts.guessType(fileName) ?: "*/*"
}
