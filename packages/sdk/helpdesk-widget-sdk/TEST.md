# Testing the Package Locally

## Method 1: Test with HTML Examples (Quickest)

### 1. Build the package

```bash
cd packages/helpdesk-widget-sdk
pnpm install
pnpm build
```

### 2. Start a local server

**Option A: Using Python (if installed)**
```bash
cd packages/helpdesk-widget-sdk
python -m http.server 8080
```

**Option B: Using Node.js http-server**
```bash
npx http-server -p 8080
```

**Option C: Using VS Code Live Server**
- Install "Live Server" extension in VS Code
- Right-click on `examples/basic.html`
- Select "Open with Live Server"

### 3. Open in browser

- **Basic example:** http://localhost:8080/examples/basic.html
- **Advanced example:** http://localhost:8080/examples/advanced.html

---

## Method 2: Test in Another Project with npm link

### 1. Build and link the package

```bash
cd packages/helpdesk-widget-sdk
pnpm build
pnpm link
```

### 2. Use in your test project

```bash
cd /path/to/your-test-project
pnpm link helpdesk-widget
```

### 3. Use it in your code

```javascript
import { initHelpdeskWidget } from 'helpdesk-widget';

initHelpdeskWidget({ widgetId: 'test-widget-123' });
```

### 4. Rebuild after changes

When you make changes to the SDK:

```bash
cd packages/helpdesk-widget-sdk
pnpm build
```

Your linked project will automatically use the updated version.

### 5. Unlink when done

```bash
# In your test project
pnpm unlink helpdesk-widget

# In the SDK package (optional)
pnpm unlink
```

---

## Method 3: Test with npm pack

### 1. Create a tarball

```bash
cd packages/helpdesk-widget-sdk
pnpm build
npm pack
```

This creates a file like `weldsuite-helpdesk-widget-1.0.0.tgz`

### 2. Install in test project

```bash
cd /path/to/your-test-project
npm install /path/to/weldsuite-helpdesk-widget-1.0.0.tgz
```

### 3. Use normally

```javascript
import { initHelpdeskWidget } from 'helpdesk-widget';

initHelpdeskWidget({ widgetId: 'test-widget-123' });
```

---

## Method 4: Direct Import in Test File

Create a test file in the package:

```javascript
// test.js
import { HelpdeskWidget } from './dist/index.esm.js';

const widget = new HelpdeskWidget({ widgetId: 'test-123' });
widget.init();

console.log('Widget initialized!');
```

Run it:

```bash
node test.js
```

---

## Debugging Tips

### Enable Console Logging

The widget logs to the console:
- Widget initialization
- Load success/failure
- Show/hide events

Open browser DevTools (F12) to see logs.

### Check Network Tab

In DevTools Network tab, you should see:
- Request to `https://widget.welddesk.com/widget?widgetId=your-widget-id`

### Common Issues

**Issue: "Module not found"**
- Make sure you ran `pnpm build`
- Check that `dist/` folder exists with built files

**Issue: Widget not appearing**
- Check browser console for errors
- Verify the iframe is created (inspect DOM)
- Make sure `widgetId` is set correctly

**Issue: CORS errors**
- This is expected if `https://widget.welddesk.com` is not set up yet
- The iframe will fail to load without the backend

### Mock the Widget for Testing

If the backend isn't ready, you can mock the widget endpoint:

1. Create `examples/mock-widget.html`:

```html
<!DOCTYPE html>
<html>
<head><title>Mock Widget</title></head>
<body style="margin: 0; padding: 20px; font-family: sans-serif;">
  <h2>Mock Widget Content</h2>
  <p>This is a mock widget for testing the SDK.</p>
  <button onclick="window.parent.postMessage({type: 'widget:close'}, '*')">
    Close Widget
  </button>
</body>
</html>
```

2. Temporarily change `baseUrl` in `src/index.ts` for testing:

```typescript
private readonly baseUrl = 'http://localhost:8080/examples/mock-widget.html';
```

3. Rebuild and test locally.

---

## Watch Mode (Development)

For active development with auto-rebuild:

```bash
pnpm dev
```

This watches for file changes and rebuilds automatically.

---

## TypeScript Type Checking

Check types without building:

```bash
pnpm typecheck
```

---

## Quick Test Checklist

- [ ] Package installs without errors
- [ ] Package builds successfully (`dist/` folder created)
- [ ] Example HTML files load without errors
- [ ] Widget iframe is created in DOM
- [ ] Console shows "Widget initialized"
- [ ] Show/hide/toggle methods work
- [ ] Widget can be destroyed without errors

---

## Testing Different Scenarios

### Test 1: Basic Initialization

```javascript
const widget = initHelpdeskWidget({ widgetId: 'test-123' });
// Check: Widget appears in DOM
```

### Test 2: Show/Hide

```javascript
widget.hide();
// Check: Widget container display = 'none'

widget.show();
// Check: Widget container display = 'block'
```

### Test 3: Toggle

```javascript
widget.toggle(); // Should hide
widget.toggle(); // Should show
```

### Test 4: Multiple Widgets

```javascript
const widget1 = initHelpdeskWidget({ widgetId: 'widget-1' });
const widget2 = initHelpdeskWidget({ widgetId: 'widget-2' });
// Check: Two iframes created
```

### Test 5: Cleanup

```javascript
widget.destroy();
// Check: Widget removed from DOM
```

---

## Automated Testing (Future)

Consider adding:
- Jest for unit tests
- Playwright/Puppeteer for E2E tests
- Testing library for component tests

Example test setup:

```bash
pnpm add -D jest @types/jest
```

```javascript
// __tests__/widget.test.js
import { HelpdeskWidget } from '../src/index';

describe('HelpdeskWidget', () => {
  test('requires widgetId', () => {
    expect(() => new HelpdeskWidget({})).toThrow('widgetId is required');
  });

  test('initializes with widgetId', () => {
    const widget = new HelpdeskWidget({ widgetId: 'test' });
    expect(widget).toBeDefined();
  });
});
```

---

Happy testing! 🧪
