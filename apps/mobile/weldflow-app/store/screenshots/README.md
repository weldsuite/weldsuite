# Screenshots

Capture real screenshots from a `preview` build on a real device, then drop them into these folders.

## Required

- `ios-6.7/`, iPhone 15/16 Pro Max class (1290x2796)
- `ios-ipad-13/`, 13" iPad Pro (2064x2752), **required because `supportsTablet: true`**
- `android-phone/`, 1080x1920+ portrait
- `android-feature-graphic/`, 1024x500 JPG/PNG

## Optional but recommended

- `ios-6.5/`, 1242x2688
- `android-7in-tablet/`, 1200x1920+
- `android-10in-tablet/`, 1800x2560+

## Shot list (consistent across devices)

1. **Projects list**, 3+ projects with different colors and statuses
2. **Project detail**, active project with visible task list
3. **Task detail + status picker open**, shows the one-tap status change feature
4. **My Tasks dashboard**, mix of in-progress and to-do tasks
5. **Dark mode**, any of the above in dark theme

Keep device status bar clean (full battery, strong signal, no notifications). Use Simulator's `xcrun simctl status_bar override` or the Android equivalent if needed.
