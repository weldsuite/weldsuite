package expo.modules.weldpassnative.autofill

import android.app.Activity
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.service.autofill.Dataset
import android.view.autofill.AutofillId
import android.view.autofill.AutofillManager
import android.view.autofill.AutofillValue
import android.widget.ArrayAdapter
import android.widget.ListView
import android.widget.RemoteViews
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity

/**
 * The unlock behind the autofill entry: Face / fingerprint (or the screen
 * lock on Android 11+) unwraps the copy's key, the copy is opened, the
 * logins for this app or page are listed, and the chosen one goes back to
 * the system as the dataset. Nothing leaves this process.
 */
class AutofillAuthActivity : FragmentActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    if (!AutofillKey.hasKey(this)) {
      finishWith(null)
      return
    }
    val authenticators =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        BiometricManager.Authenticators.BIOMETRIC_STRONG or BiometricManager.Authenticators.DEVICE_CREDENTIAL
      } else {
        BiometricManager.Authenticators.BIOMETRIC_STRONG
      }
    val info = BiometricPrompt.PromptInfo.Builder()
      .setTitle(Labels.unlockTitle(this))
      .setAllowedAuthenticators(authenticators)
      .apply { if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) setNegativeButtonText(Labels.cancel(this@AutofillAuthActivity)) }
      .build()
    BiometricPrompt(
      this,
      ContextCompat.getMainExecutor(this),
      object : BiometricPrompt.AuthenticationCallback() {
        override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
          // The prompt opened the wrapping key's 30 s window.
          val key = AutofillKey.unwrap(this@AutofillAuthActivity)
          if (key == null) finishWith(null) else showLogins(key)
        }

        override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
          finishWith(null)
        }
      },
    ).authenticate(info)
  }

  private fun showLogins(key: ByteArray) {
    val fields =
      FormFields(
        username = autofillId(EXTRA_USERNAME_ID),
        password = autofillId(EXTRA_PASSWORD_ID),
        webDomain = intent.getStringExtra(EXTRA_WEB_DOMAIN),
        packageName = intent.getStringExtra(EXTRA_PACKAGE).orEmpty(),
      )
    val all = OfflineCopyReader.logins(this, key)
    key.fill(0)
    val matching = OfflineCopyReader.matching(all, fields)
    // Matching logins first; with none, everything, so one saved under
    // another address or without the app's package can still be picked.
    val choices = matching.ifEmpty { all }
    when (choices.size) {
      0 -> finishWith(null)
      1 -> fill(fields, choices.first())
      else -> {
        val list = ListView(this)
        list.adapter =
          ArrayAdapter(
            this, android.R.layout.simple_list_item_1,
            choices.map { listOf(it.title, it.username).filter(String::isNotEmpty).joinToString(" · ") },
          )
        list.setOnItemClickListener { _, _, position, _ -> fill(fields, choices[position]) }
        setContentView(list)
      }
    }
  }

  private fun fill(fields: FormFields, login: OfflineCopyReader.Login) {
    val presentation = RemoteViews(packageName, android.R.layout.simple_list_item_1).apply {
      setTextViewText(android.R.id.text1, login.title)
    }
    val dataset = Dataset.Builder(presentation).apply {
      fields.username?.let { setValue(it, AutofillValue.forText(login.username)) }
      fields.password?.let { setValue(it, AutofillValue.forText(login.password)) }
    }.build()
    OfflineCopyReader.recordFill(this, login)
    finishWith(dataset)
  }

  private fun autofillId(name: String): AutofillId? =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      intent.getParcelableExtra(name, AutofillId::class.java)
    } else {
      @Suppress("DEPRECATION")
      intent.getParcelableExtra(name)
    }

  private fun finishWith(dataset: Dataset?) {
    if (dataset == null) {
      setResult(Activity.RESULT_CANCELED)
    } else {
      setResult(Activity.RESULT_OK, Intent().putExtra(AutofillManager.EXTRA_AUTHENTICATION_RESULT, dataset))
    }
    finish()
  }

  companion object {
    const val EXTRA_USERNAME_ID = "weldpass.usernameId"
    const val EXTRA_PASSWORD_ID = "weldpass.passwordId"
    const val EXTRA_WEB_DOMAIN = "weldpass.webDomain"
    const val EXTRA_PACKAGE = "weldpass.package"
  }
}
