package expo.modules.weldpassnative.autofill

import android.app.PendingIntent
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
import android.view.autofill.AutofillValue
import android.widget.RemoteViews

/**
 * WeldPass in Android's autofill (ADR PASS-010).
 *
 * Every fill comes from the app's offline copy, with no network and no
 * tokens. The copy is sealed with a key behind biometrics, so the service
 * offers one entry, "WeldPass", whose authentication opens
 * `AutofillAuthActivity`: it unlocks the key, finds the logins for this app
 * (by package name) or page (by the browser's domain) and hands the chosen
 * one back to the system. The service itself never sees a password.
 *
 * A save request after a sign-in opens the app's "New login" form with what
 * was typed; saving there goes to the server as any edit does.
 */
class WeldPassAutofillService : AutofillService() {
  override fun onFillRequest(request: FillRequest, cancellationSignal: CancellationSignal, callback: FillCallback) {
    val structure = request.fillContexts.lastOrNull()?.structure
    if (structure == null || !AutofillKey.hasKey(this)) {
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
    val sender =
      PendingIntent.getActivity(
        this, REQUEST_UNLOCK, unlock,
        PendingIntent.FLAG_CANCEL_CURRENT or PendingIntent.FLAG_MUTABLE,
      ).intentSender

    val presentation = RemoteViews(packageName, android.R.layout.simple_list_item_1).apply {
      setTextViewText(android.R.id.text1, Labels.fillWithWeldPass(this@WeldPassAutofillService))
    }
    // The dataset's values are placeholders: the activity returns the real one.
    val dataset = Dataset.Builder(presentation).apply {
      fields.username?.let { setValue(it, AutofillValue.forText("")) }
      fields.password?.let { setValue(it, AutofillValue.forText("")) }
      setAuthentication(sender)
    }.build()

    val response = FillResponse.Builder().addDataset(dataset)
    if (fields.password != null) {
      response.setSaveInfo(
        SaveInfo.Builder(
          SaveInfo.SAVE_DATA_TYPE_PASSWORD or SaveInfo.SAVE_DATA_TYPE_USERNAME,
          fields.ids,
        ).build())
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
    PendingSave.capture(structure, fields)
    // The app's "New login" form takes the pending save (`takePendingSave`).
    val open = Intent(Intent.ACTION_VIEW, android.net.Uri.parse("weldpass://item/new?type=login&fromAutofill=1"))
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      .setPackage(packageName)
    try {
      startActivity(open)
    } catch (_: Exception) {
      // The app isn't there to take it; nothing is kept.
      PendingSave.clear()
    }
    callback.onSuccess()
  }

  private companion object {
    const val REQUEST_UNLOCK = 4210
  }
}
