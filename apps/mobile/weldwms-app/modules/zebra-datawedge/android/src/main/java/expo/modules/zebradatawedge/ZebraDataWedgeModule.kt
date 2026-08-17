package expo.modules.zebradatawedge

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.os.Bundle
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Zebra DataWedge bridge.
 *
 * Hardware scanners on Zebra Android computers don't go through the camera.
 * DataWedge captures the scan and forwards it to the foreground app as a
 * broadcast intent. This module:
 *
 *  1. Creates / updates a DataWedge profile associated with this app
 *  2. Disables keystroke output (so the same scan isn't typed into a TextInput)
 *  3. Enables intent output as a broadcast
 *  4. Emits `onBarcodeScanned` to JS with the decoded string
 *
 * Devices without DataWedge simply ignore the configure broadcasts.
 */
class ZebraDataWedgeModule : Module() {
  private var receiver: BroadcastReceiver? = null

  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("ZebraDataWedge")

    Events(EVENT_SCAN)

    OnStartObserving {
      registerScanReceiver()
      configureProfile()
    }

    OnStopObserving {
      unregisterScanReceiver()
    }

    Function("isSupported") {
      true
    }

    Function("configureProfile") {
      configureProfile()
    }
  }

  private fun registerScanReceiver() {
    if (receiver != null) return

    val scanReceiver = object : BroadcastReceiver() {
      override fun onReceive(ctx: Context, intent: Intent) {
        val data = intent.getStringExtra(EXTRA_DATA_STRING) ?: return
        if (data.isBlank()) return
        sendEvent(
          EVENT_SCAN,
          mapOf(
            "data" to data,
            "labelType" to (intent.getStringExtra(EXTRA_LABEL_TYPE) ?: ""),
          ),
        )
      }
    }

    val filter = IntentFilter().apply {
      addAction(SCAN_ACTION)
      addAction(SCAN_ACTION_ALT)
      addCategory(Intent.CATEGORY_DEFAULT)
    }

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      context.registerReceiver(scanReceiver, filter, Context.RECEIVER_EXPORTED)
    } else {
      @Suppress("UnspecifiedRegisterReceiverFlag")
      context.registerReceiver(scanReceiver, filter)
    }
    receiver = scanReceiver
  }

  private fun unregisterScanReceiver() {
    val current = receiver ?: return
    try {
      context.unregisterReceiver(current)
    } catch (_: IllegalArgumentException) {
      // Already unregistered.
    }
    receiver = null
  }

  private fun configureProfile() {
    val packageName = context.packageName

    val create = Intent().apply {
      action = DW_API_ACTION
      putExtra("com.symbol.datawedge.api.CREATE_PROFILE", PROFILE_NAME)
    }
    context.sendBroadcast(create)

    val barcodeParams = Bundle().apply {
      putString("scanner_selection", "auto")
      putString("scanner_input_enabled", "true")
    }
    val barcodePlugin = Bundle().apply {
      putString("PLUGIN_NAME", "BARCODE")
      putString("RESET_CONFIG", "true")
      putBundle("PARAM_LIST", barcodeParams)
    }

    // Disable keystroke output so a scan is delivered once, via intent, instead
    // of being typed into whatever TextInput currently has focus.
    val keystrokeParams = Bundle().apply {
      putString("keystroke_output_enabled", "false")
    }
    val keystrokePlugin = Bundle().apply {
      putString("PLUGIN_NAME", "KEYSTROKE")
      putString("RESET_CONFIG", "true")
      putBundle("PARAM_LIST", keystrokeParams)
    }

    val intentParams = Bundle().apply {
      putString("intent_output_enabled", "true")
      putString("intent_action", SCAN_ACTION)
      putString("intent_delivery", "2") // 2 = broadcast
    }
    val intentPlugin = Bundle().apply {
      putString("PLUGIN_NAME", "INTENT")
      putString("RESET_CONFIG", "true")
      putBundle("PARAM_LIST", intentParams)
    }

    val appConfig = Bundle().apply {
      putString("PACKAGE_NAME", packageName)
      putStringArray("ACTIVITY_LIST", arrayOf("*"))
    }

    val profileConfig = Bundle().apply {
      putString("PROFILE_NAME", PROFILE_NAME)
      putString("PROFILE_ENABLED", "true")
      putString("CONFIG_MODE", "CREATE_IF_NOT_EXIST")
      putParcelableArray("PLUGIN_CONFIG", arrayOf(barcodePlugin, keystrokePlugin, intentPlugin))
      putParcelableArray("APP_LIST", arrayOf(appConfig))
    }

    val setConfig = Intent().apply {
      action = DW_API_ACTION
      putExtra("com.symbol.datawedge.api.SET_CONFIG", profileConfig)
    }
    context.sendBroadcast(setConfig)

    val switchProfile = Intent().apply {
      action = DW_API_ACTION
      putExtra("com.symbol.datawedge.api.SWITCH_TO_PROFILE", PROFILE_NAME)
    }
    context.sendBroadcast(switchProfile)
  }

  companion object {
    private const val PROFILE_NAME = "WeldWMS"
    private const val DW_API_ACTION = "com.symbol.datawedge.api.ACTION"
    const val SCAN_ACTION = "com.weldsuite.weldwms.SCAN"
    const val SCAN_ACTION_ALT = "com.symbol.datawedge.ACTION_BARCODE_SCANNED"
    const val EXTRA_DATA_STRING = "com.symbol.datawedge.data_string"
    const val EXTRA_LABEL_TYPE = "com.symbol.datawedge.label_type"
    const val EVENT_SCAN = "onBarcodeScanned"
  }
}
