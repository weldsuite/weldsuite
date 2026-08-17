# WeldWMS

Warehouse-floor app for **product search and stock adjustments**. It talks to the same `app-api` products / inventory / warehouses surfaces as WeldStash.

## What it does

- Search products by name, SKU, or barcode
- Create a product (name, SKU, barcode)
- View on-hand stock per warehouse and adjust it (`POST /api/inventory/adjust`)
- Hardware barcode scanning on Zebra Android computers via DataWedge

## Zebra scanner

Zebra TC-series devices do **not** send camera frames. The hardware imager is owned by **DataWedge**, which forwards the decoded string to the foreground app.

WeldWMS uses that intent path:

1. On launch, the app creates a DataWedge profile named `WeldWMS` associated with `com.weldsuite.weldwms`.
2. Barcode input stays on; **keystroke output is turned off** so a scan is not typed into a random text field.
3. Intent output is a **broadcast** with action `com.weldsuite.weldwms.SCAN`.
4. The native module listens for `com.symbol.datawedge.data_string` and the JS app treats that as a product search.

If DataWedge is missing (simulator, iOS, a non-Zebra phone), the search field still accepts a **keyboard-wedge** scan: the scanner types the barcode and sends Enter.

### Manual DataWedge fallback

If auto-config is blocked by device policy, create the profile in DataWedge:

- Profile name: `WeldWMS`
- Associated app: `com.weldsuite.weldwms` / `*`
- Barcode input: enabled
- Keystroke output: disabled
- Intent output: enabled, action `com.weldsuite.weldwms.SCAN`, delivery **Broadcast**

A development build (`expo run:android` / EAS) is required. Expo Go cannot receive DataWedge broadcasts.

## Run

```bash
pnpm install
pnpm --filter weldwms-app test
pnpm --filter weldwms-app start
```

Fill in `apps/mobile/weldwms-app/.env` (`EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY`, `EXPO_PUBLIC_APP_API_URL`).
