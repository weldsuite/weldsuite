package expo.modules.zebradatawedge

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.content.pm.PermissionInfo
import android.os.Build
import android.os.Bundle
import android.os.Process
import android.util.Log
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.ArrayList

private const val LOG_TAG = "ZebraDataWedge"

/**
 * Zebra DataWedge bridge.
 *
 * Hardware scanners on Zebra Android computers don't go through the camera.
 * DataWedge captures the scan and forwards it to the foreground app as a
 * broadcast intent. This module:
 *
 *  1. Creates / updates a DataWedge profile associated with this app
 *  2. Disables keystroke output (so the same scan isn't typed into a TextInput)
 *  3. Enables intent output as an explicit broadcast to this package
 *  4. Emits `onBarcodeScanned` to JS with the decoded string
 *
 * The scan receiver must stay exported: DataWedge is a separate package.
 * To stop another app from injecting `com.symbol.datawedge.data_string`
 * while WeldStash is in the foreground, the receiver:
 *  - listens only for this app's unique action (not the well-known DataWedge
 *    `ACTION_BARCODE_SCANNED`)
 *  - requires a DataWedge-defined signature permission from the sender when
 *    that permission exists on the device
 *  - drops the broadcast when Android reports a sender that is not DataWedge
 *
 * Devices without DataWedge simply ignore the configure broadcasts.
 */
class ZebraDataWedgeModule : Module() {
  private var receiver: BroadcastReceiver? = null
  private var receiverContext: Context? = null

  /**
   * Prefer the application context so the scan receiver keeps getting
   * DataWedge broadcasts after React reloads. [Context.getPackageName] is
   * the same on either context.
   */
  private val context: Context
    get() = appContext.reactContext?.applicationContext
      ?: appContext.reactContext
      ?: throw Exceptions.ReactContextLost()

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
        if (!isTrustedScanBroadcast(ctx, intent)) return
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
      addCategory(Intent.CATEGORY_DEFAULT)
    }

    val host = context
    val senderPermission = signatureBroadcastPermission(host)

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      host.registerReceiver(
        scanReceiver,
        filter,
        senderPermission,
        null,
        Context.RECEIVER_EXPORTED,
      )
    } else {
      @Suppress("UnspecifiedRegisterReceiverFlag")
      host.registerReceiver(scanReceiver, filter, senderPermission, null)
    }
    receiverContext = host
    receiver = scanReceiver
  }

  private fun unregisterScanReceiver() {
    val current = receiver ?: return
    val host = receiverContext ?: context
    try {
      host.unregisterReceiver(current)
    } catch (_: IllegalArgumentException) {
      // Already unregistered.
    }
    receiver = null
    receiverContext = null
  }

  private fun configureProfile() {
    val packageName = context.packageName

    sendDataWedgeApi("com.symbol.datawedge.api.CREATE_PROFILE", PROFILE_NAME)

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

    val componentInfo = ArrayList<Bundle>().apply {
      add(
        Bundle().apply {
          putString("PACKAGE_NAME", packageName)
        },
      )
    }
    val intentParams = Bundle().apply {
      putString("intent_output_enabled", "true")
      putString("intent_action", SCAN_ACTION)
      putString("intent_category", Intent.CATEGORY_DEFAULT)
      // Integer 2 = broadcast. DataWedge's SET_CONFIG samples use putInt here.
      putInt("intent_delivery", 2)
      putParcelableArrayList("intent_component_info", componentInfo)
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

    // DataWedge reads PLUGIN_CONFIG with getParcelableArrayList. A Bundle[]
    // via putParcelableArray is ignored, so the profile stays on default
    // keystroke output — scans only land if a TextInput has focus.
    val pluginConfigs = ArrayList<Bundle>().apply {
      add(barcodePlugin)
      add(keystrokePlugin)
      add(intentPlugin)
    }

    val profileConfig = Bundle().apply {
      putString("PROFILE_NAME", PROFILE_NAME)
      putString("PROFILE_ENABLED", "true")
      putString("CONFIG_MODE", "CREATE_IF_NOT_EXIST")
      putParcelableArrayList("PLUGIN_CONFIG", pluginConfigs)
      putParcelableArray("APP_LIST", arrayOf(appConfig))
    }

    sendDataWedgeApi("com.symbol.datawedge.api.SET_CONFIG", profileConfig)
    sendDataWedgeApi("com.symbol.datawedge.api.SWITCH_TO_PROFILE", PROFILE_NAME)
  }

  private fun sendDataWedgeApi(extraKey: String, extraValue: String) {
    context.sendBroadcast(
      Intent().apply {
        action = DW_API_ACTION
        setPackage(DATAWEDGE_PACKAGE)
        putExtra(extraKey, extraValue)
      },
    )
  }

  private fun sendDataWedgeApi(extraKey: String, extraValue: Bundle) {
    context.sendBroadcast(
      Intent().apply {
        action = DW_API_ACTION
        setPackage(DATAWEDGE_PACKAGE)
        putExtra(extraKey, extraValue)
      },
    )
  }

  companion object {
    private const val PROFILE_NAME = "WeldStash"
    private const val DW_API_ACTION = "com.symbol.datawedge.api.ACTION"
    const val DATAWEDGE_PACKAGE = "com.symbol.datawedge"
    const val SCAN_ACTION = "com.weldsuite.weldstash.SCAN"
    const val EXTRA_DATA_STRING = "com.symbol.datawedge.data_string"
    const val EXTRA_LABEL_TYPE = "com.symbol.datawedge.label_type"
    const val EVENT_SCAN = "onBarcodeScanned"

    /**
     * Permission defined by DataWedge. When its protection level is
     * `signature`, only Zebra-signed senders (DataWedge itself) can satisfy
     * `registerReceiver(..., broadcastPermission, ...)`.
     */
    const val DW_DEFINED_PERMISSION = "com.symbol.datawedge.permission.contentprovider"

    internal fun isTrustedPackage(packageName: String?): Boolean =
      packageName == DATAWEDGE_PACKAGE

    internal fun isTrustedUidPackages(packagesForUid: Array<out String>?): Boolean =
      packagesForUid?.any { it == DATAWEDGE_PACKAGE } == true

    internal fun isSignatureProtection(protectionBase: Int): Boolean =
      protectionBase == PermissionInfo.PROTECTION_SIGNATURE
  }
}

/**
 * Accept a scan only from DataWedge.
 *
 * Android 14+ may report the sender via [BroadcastReceiver.getSentFromPackage]
 * / [BroadcastReceiver.getSentFromUid] when the broadcaster shares identity.
 * DataWedge typically does not, so a missing identity is not treated as
 * hostile — the unique action plus the optional signature broadcastPermission
 * still apply. An identified sender that is not DataWedge is always dropped.
 */
private fun BroadcastReceiver.isTrustedScanBroadcast(ctx: Context, intent: Intent): Boolean {
  if (intent.action != ZebraDataWedgeModule.SCAN_ACTION) return false

  if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
    val fromPackage = sentFromPackage
    if (fromPackage != null) {
      val trusted = ZebraDataWedgeModule.isTrustedPackage(fromPackage)
      if (!trusted) {
        Log.w(LOG_TAG, "Dropping scan broadcast from $fromPackage")
      }
      return trusted
    }
    val fromUid = sentFromUid
    if (fromUid != Process.INVALID_UID) {
      val packages = ctx.packageManager.getPackagesForUid(fromUid)
      val trusted = ZebraDataWedgeModule.isTrustedUidPackages(packages)
      if (!trusted) {
        Log.w(LOG_TAG, "Dropping scan broadcast from uid=$fromUid")
      }
      return trusted
    }
  }

  return true
}

/**
 * Return DataWedge's signature-level permission when it is actually defined
 * as signature-protected. A `normal` permission would be requestable by any
 * attacker app, so it is not used as a sender gate.
 */
private fun signatureBroadcastPermission(ctx: Context): String? {
  val info = try {
    ctx.packageManager.getPermissionInfo(ZebraDataWedgeModule.DW_DEFINED_PERMISSION, 0)
  } catch (_: PackageManager.NameNotFoundException) {
    return null
  }
  val base = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
    info.protection
  } else {
    @Suppress("DEPRECATION")
    info.protectionLevel and PermissionInfo.PROTECTION_MASK_BASE
  }
  return if (ZebraDataWedgeModule.isSignatureProtection(base)) {
    ZebraDataWedgeModule.DW_DEFINED_PERMISSION
  } else {
    null
  }
}
