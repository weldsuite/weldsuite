package com.weldsuite.weldpass.autofill

import android.app.Activity
import androidx.annotation.RequiresApi
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.service.autofill.Dataset
import android.view.WindowManager
import android.view.autofill.AutofillId
import android.view.autofill.AutofillManager
import android.view.autofill.AutofillValue
import android.widget.ArrayAdapter
import android.widget.ListView
import android.widget.RemoteViews
import android.widget.TextView
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_WEAK
import androidx.biometric.BiometricManager.Authenticators.DEVICE_CREDENTIAL
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import com.weldsuite.weldpass.R
import com.weldsuite.weldpass.offline.CopyKeyStore
import com.weldsuite.weldpass.offline.CopyLockedException

/**
 * The unlock behind the autofill entry: biometrics or the screen lock opens
 * the copy's key (its 30-second window), the copies are opened, the logins
 * for this app or page are listed, and the chosen one goes back to the
 * system as the dataset. Nothing leaves this process.
 */
@RequiresApi(Build.VERSION_CODES.O)
class AutofillAuthActivity : FragmentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)
        val authenticators = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            BIOMETRIC_STRONG or DEVICE_CREDENTIAL
        } else {
            BIOMETRIC_WEAK or DEVICE_CREDENTIAL
        }
        val info = BiometricPrompt.PromptInfo.Builder()
            .setTitle(getString(R.string.weldpass_autofill_unlock_reason))
            .setAllowedAuthenticators(authenticators)
            .build()
        BiometricPrompt(
            this,
            ContextCompat.getMainExecutor(this),
            object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                    val key = try {
                        CopyKeyStore(this@AutofillAuthActivity).open()
                    } catch (_: CopyLockedException) {
                        null
                    }
                    if (key == null) finishWith(null) else showLogins(key)
                }

                override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                    finishWith(null)
                }
            },
        ).authenticate(info)
    }

    private fun showLogins(key: ByteArray) {
        // The domain the service believed (a known browser's https page), never
        // one an app claimed for itself.
        val webDomain = intent.getStringExtra(EXTRA_WEB_DOMAIN)
        val packageName = intent.getStringExtra(EXTRA_PACKAGE).orEmpty()
        val all = AutofillLogins.all(this, key)
        key.fill(0)
        // Matching logins first; with none, everything, so one saved under another
        // address or without the app's package can still be picked: picked, never
        // filled unasked, and each row names its site.
        val choices = AutofillLogins.choices(all, webDomain, packageName)
        when {
            choices.logins.isEmpty() -> {
                setContentView(TextView(this).apply {
                    text = getString(R.string.weldpass_autofill_empty)
                    setPadding(48, 48, 48, 48)
                })
                window.decorView.postDelayed({ finishWith(null) }, 1_500)
            }
            choices.fillAtOnce -> fill(choices.logins.first())
            else -> {
                title = getString(R.string.weldpass_autofill_choose)
                val list = ListView(this)
                list.adapter = ArrayAdapter(
                    this,
                    android.R.layout.simple_list_item_1,
                    choices.logins.map(AutofillLogins::label),
                )
                list.setOnItemClickListener { _, _, position, _ -> fill(choices.logins[position]) }
                setContentView(list)
            }
        }
    }

    private fun fill(login: AutofillLogin) {
        val presentation = RemoteViews(packageName, android.R.layout.simple_list_item_1).apply {
            setTextViewText(android.R.id.text1, login.title)
        }
        val dataset = Dataset.Builder(presentation).apply {
            autofillId(EXTRA_USERNAME_ID)?.let { setValue(it, AutofillValue.forText(login.username)) }
            autofillId(EXTRA_PASSWORD_ID)?.let { setValue(it, AutofillValue.forText(login.password)) }
        }.build()
        AutofillLogins.recordFill(this, login)
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
