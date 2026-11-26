package com.weldsuite.weldpass.autofill

import android.app.PendingIntent
import android.app.assist.AssistStructure
import android.os.Build
import androidx.annotation.RequiresApi
import android.content.Intent
import android.os.CancellationSignal
import android.service.autofill.AutofillService
import android.service.autofill.Dataset
import android.service.autofill.FillCallback
import android.service.autofill.FillRequest
import android.service.autofill.FillResponse
import android.service.autofill.SaveCallback
import android.service.autofill.SaveInfo
import android.service.autofill.SaveRequest
import android.view.autofill.AutofillId
import android.view.autofill.AutofillValue
import android.widget.RemoteViews
import com.weldsuite.weldpass.MainActivity
import com.weldsuite.weldpass.R
import com.weldsuite.weldpass.offline.CopyFiles

/**
 * WeldPass in Android's autofill (ADR PASS-010).
 *
 * Every fill comes from the app's offline copy, with no network and no
 * tokens. The copy's key needs the person to unlock, so the service offers
 * one entry, "Fill with WeldPass", whose authentication opens
 * [AutofillAuthActivity]: it unlocks, finds the logins for this app (by
 * package name) or page (by domain) and hands the chosen one back. The
 * service itself never sees a password.
 *
 * A save request after a sign-in opens the app's "New login" form with what
 * was typed; saving there goes to the server like any edit.
 */
@RequiresApi(Build.VERSION_CODES.O)
class WeldPassAutofillService : AutofillService() {
    override fun onFillRequest(request: FillRequest, cancellationSignal: CancellationSignal, callback: FillCallback) {
        val structure = request.fillContexts.lastOrNull()?.structure
        if (structure == null || CopyFiles(this).index().isEmpty()) {
            callback.onSuccess(null)
            return
        }
        val fields = FormFields.from(structure)
        if (fields.isEmpty || fields.packageName == packageName) {
            callback.onSuccess(null)
            return
        }

        val unlock = Intent(this, AutofillAuthActivity::class.java).apply {
            putExtra(AutofillAuthActivity.EXTRA_USERNAME_ID, fields.username)
            putExtra(AutofillAuthActivity.EXTRA_PASSWORD_ID, fields.password)
            putExtra(AutofillAuthActivity.EXTRA_WEB_DOMAIN, fields.webDomain)
            putExtra(AutofillAuthActivity.EXTRA_PACKAGE, fields.packageName)
        }
        val sender = PendingIntent.getActivity(
            this,
            REQUEST_UNLOCK,
            unlock,
            PendingIntent.FLAG_CANCEL_CURRENT or PendingIntent.FLAG_MUTABLE,
        ).intentSender

        val presentation = RemoteViews(packageName, android.R.layout.simple_list_item_1).apply {
            setTextViewText(android.R.id.text1, getString(R.string.weldpass_autofill_fill_with))
        }
        // Placeholder values: the activity returns the real dataset.
        val dataset = Dataset.Builder(presentation).apply {
            fields.username?.let { setValue(it, AutofillValue.forText("")) }
            fields.password?.let { setValue(it, AutofillValue.forText("")) }
            setAuthentication(sender)
        }.build()

        val response = FillResponse.Builder().addDataset(dataset)
        if (fields.password != null) {
            response.setSaveInfo(
                SaveInfo.Builder(SaveInfo.SAVE_DATA_TYPE_PASSWORD or SaveInfo.SAVE_DATA_TYPE_USERNAME, fields.ids).build(),
            )
        }
        callback.onSuccess(response.build())
    }

    override fun onSaveRequest(request: SaveRequest, callback: SaveCallback) {
        val structure = request.fillContexts.lastOrNull()?.structure
        if (structure == null) {
            callback.onSuccess()
            return
        }
        val fields = FormFields.from(structure)
        val (username, password) = typedValues(structure, fields)
        if (password.isNotEmpty()) {
            PendingSave.put(PendingSave.Values(username, password, fields.webDomain, fields.packageName))
            // The app's "New login" form takes the pending save.
            startActivity(
                Intent(this, MainActivity::class.java)
                    .putExtra(MainActivity.EXTRA_FROM_AUTOFILL, true)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP),
            )
        }
        callback.onSuccess()
    }

    private fun typedValues(structure: AssistStructure, fields: FormFields): Pair<String, String> {
        var username = ""
        var password = ""
        fun visit(node: AssistStructure.ViewNode) {
            val id: AutofillId? = node.autofillId
            val text = node.autofillValue?.takeIf { it.isText }?.textValue?.toString()
            if (id != null && text != null) {
                if (id == fields.username) username = text
                if (id == fields.password) password = text
            }
            for (index in 0 until node.childCount) visit(node.getChildAt(index))
        }
        for (index in 0 until structure.windowNodeCount) visit(structure.getWindowNodeAt(index).rootViewNode)
        return username to password
    }

    private companion object {
        const val REQUEST_UNLOCK = 4210
    }
}

/**
 * A login typed into another app or page that the person asked WeldPass to
 * save. In memory only, for a minute, until the app's "New login" form takes
 * it; never in a file, a URL or a log.
 */
object PendingSave {
    data class Values(val username: String, val password: String, val webDomain: String?, val packageName: String)

    private const val TTL_MS = 60_000L

    @Volatile
    private var values: Values? = null

    @Volatile
    private var capturedAt = 0L

    fun put(next: Values) {
        values = next
        capturedAt = System.currentTimeMillis()
    }

    /** The pending save, once: taking it clears it. */
    fun take(): Values? {
        val taken = values?.takeIf { System.currentTimeMillis() - capturedAt <= TTL_MS }
        values = null
        capturedAt = 0L
        return taken
    }
}
