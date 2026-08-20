# WeldStash

Warehouse-floor app for **product search and stock adjustments**. It talks to the same `app-api` products / inventory / warehouses surfaces as the WeldStash platform module.

## What it does

- Search products by name, SKU, or barcode
- Create a product (name, SKU, barcode)
- View on-hand stock per warehouse and adjust it (`POST /api/inventory/adjust`)
- Hardware barcode scanning on Zebra Android computers via DataWedge

## Zebra scanner

Zebra TC-series devices do **not** send camera frames. The hardware imager is owned by **DataWedge**, which forwards the decoded string to the foreground app.

WeldStash uses that intent path:

1. On launch, the app creates a DataWedge profile named `WeldStash` associated with `com.weldsuite.weldstash`.
2. Barcode input stays on; **keystroke output is turned off** so a scan is not typed into a random text field.
3. Intent output is an **explicit broadcast** to this package with action `com.weldsuite.weldstash.SCAN` (not the well-known `com.symbol.datawedge.ACTION_BARCODE_SCANNED`).
4. The native module accepts `com.symbol.datawedge.data_string` only from DataWedge (sender permission + package check) and the JS app treats that as a product search.

If DataWedge is missing (simulator, iOS, a non-Zebra phone), the search field still accepts a **keyboard-wedge** scan: the scanner types the barcode and sends Enter.

### Manual DataWedge fallback

If auto-config is blocked by device policy, create the profile in DataWedge:

- Profile name: `WeldStash`
- Associated app: `com.weldsuite.weldstash` / `*`
- Barcode input: enabled
- Keystroke output: disabled
- Intent output: enabled, action `com.weldsuite.weldstash.SCAN`, delivery **Broadcast**, component = this app

A development build (`expo run:android` / EAS) is required. Expo Go cannot receive DataWedge broadcasts.

## Run

```bash
pnpm install
pnpm --filter weldstash-app test
pnpm --filter weldstash-app start
```

Fill in `apps/mobile/weldstash-app/.env` (`EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY`, `EXPO_PUBLIC_APP_API_URL`).
