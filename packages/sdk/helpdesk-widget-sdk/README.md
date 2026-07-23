# helpdesk-widget

> Easiest way to add a helpdesk widget to your website. Just provide your `widgetId` - all styling and configuration is managed in your backoffice!

[![npm version](https://img.shields.io/npm/v/helpdesk-widget.svg)](https://www.npmjs.com/package/helpdesk-widget)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

## Features

- 🎯 **One Parameter** - Just pass your `widgetId`, that's it!
- ⚙️ **Backoffice Configuration** - Control colors, position, pages, and behavior from your admin panel
- 🔒 **Secure** - Loads in an isolated iframe with secure communication
- 📱 **Responsive** - Automatically adapts to all screen sizes
- 💪 **TypeScript** - Full TypeScript support included
- 🎯 **Framework Components** - Pre-built components for React, Vue, Angular, and Svelte
- 🎨 **Event System** - Type-safe event handlers for widget lifecycle
- 🌍 **Environment Support** - Easy dev/staging/production configuration
- 🌐 **Zero Dependencies** - Lightweight core with no external dependencies

## Installation

```bash
npm install @weldsuite/helpdesk-widget-sdk
```

or

```bash
yarn add @weldsuite/helpdesk-widget-sdk
```

or

```bash
pnpm add @weldsuite/helpdesk-widget-sdk
```

## Quick Start

### The Simplest Way

```javascript
import { initHelpdeskWidget } from 'helpdesk-widget';

initHelpdeskWidget({ widgetId: 'your-widget-id' });
```

That's it! 🎉

The widget will automatically:
- Load with your configured theme colors
- Position itself as you set in the backoffice
- Display the pages you enabled
- Apply all your custom settings

## Configuration

### Required Parameter

| Parameter | Type | Description |
|-----------|------|-------------|
| `widgetId` | `string` | **Required.** Your unique widget identifier from the backoffice |

That's the only parameter you need!

### Where to Configure Everything Else?

**All widget settings are managed in your backoffice:**
- 🎨 Theme colors (primary, button, launcher, accent)
- 📍 Position (bottom-right, bottom-left, top-right, top-left)
- 📄 Enabled pages (home, chat, help, status, etc.)
- 🚀 Auto-open behavior
- 🏠 Starting page
- 💬 Welcome message
- And much more!

This centralized approach means:
- ✅ No code changes needed to update widget appearance
- ✅ Consistent styling across all your sites
- ✅ Easy A/B testing from the backoffice
- ✅ Instant updates without redeploying your app

## Usage Examples

### Vanilla JavaScript / HTML

```html
<!DOCTYPE html>
<html>
<head>
  <title>My Website</title>
</head>
<body>
  <h1>Welcome to my website</h1>

  <!-- Load from CDN -->
  <script src="https://unpkg.com/helpdesk-widget@latest/dist/index.umd.js"></script>

  <script>
    HelpdeskWidget.initHelpdeskWidget({
      widgetId: 'your-widget-id'
    });
  </script>
</body>
</html>
```

### React

#### Using the Component (Easiest)

```tsx
import { HelpdeskWidgetReact } from '@weldsuite/helpdesk-widget-sdk/react';

function App() {
  return (
    <div className="App">
      <h1>My App</h1>
      <HelpdeskWidgetReact widgetId="your-widget-id" />
    </div>
  );
}
```

#### Using the Hook

```tsx
import { useHelpdeskWidget } from '@weldsuite/helpdesk-widget-sdk/react';

function App() {
  const widget = useHelpdeskWidget({ widgetId: 'your-widget-id' });

  return (
    <div>
      <button onClick={() => widget?.show()}>Show Support</button>
    </div>
  );
}
```

#### Using the Controls Hook

```tsx
import { useHelpdeskWidgetControls } from '@weldsuite/helpdesk-widget-sdk/react';

function App() {
  const { show, hide, toggle } = useHelpdeskWidgetControls({
    widgetId: 'your-widget-id'
  });

  return (
    <div>
      <button onClick={show}>Show Support</button>
      <button onClick={hide}>Hide Support</button>
      <button onClick={toggle}>Toggle Support</button>
    </div>
  );
}
```

#### With Event Handlers

```tsx
import { HelpdeskWidgetReact } from '@weldsuite/helpdesk-widget-sdk/react';

function App() {
  return (
    <HelpdeskWidgetReact
      widgetId="your-widget-id"
      onReady={(event) => console.log('Widget ready!', event)}
      onOpened={(event) => console.log('Widget opened!', event)}
      onClosed={(event) => console.log('Widget closed!', event)}
    />
  );
}
```

### Next.js

#### App Router (Client Component)

```tsx
// components/WidgetProvider.tsx
'use client';

import { HelpdeskWidgetReact } from '@weldsuite/helpdesk-widget-sdk/react';

export default function WidgetProvider() {
  return (
    <HelpdeskWidgetReact
      widgetId={process.env.NEXT_PUBLIC_WIDGET_ID!}
    />
  );
}
```

Then add to your layout:

```tsx
// app/layout.tsx
import WidgetProvider from './components/WidgetProvider';

export default function RootLayout({ children }) {
  return (
    <html>
      <body>
        {children}
        <WidgetProvider />
      </body>
    </html>
  );
}
```

### Vue 3

#### Using the Component (Easiest)

```vue
<script setup lang="ts">
import { HelpdeskWidget } from '@weldsuite/helpdesk-widget-sdk/vue';
</script>

<template>
  <div>
    <h1>My App</h1>
    <HelpdeskWidget widget-id="your-widget-id" />
  </div>
</template>
```

#### Using the Composable

```vue
<script setup lang="ts">
import { useHelpdeskWidget } from '@weldsuite/helpdesk-widget-sdk/vue';

const widget = useHelpdeskWidget({ widgetId: 'your-widget-id' });
</script>

<template>
  <div>
    <button @click="widget?.show()">Show Support</button>
  </div>
</template>
```

#### Using the Controls Composable

```vue
<script setup lang="ts">
import { useHelpdeskWidgetControls } from '@weldsuite/helpdesk-widget-sdk/vue';

const { show, hide, toggle } = useHelpdeskWidgetControls({
  widgetId: 'your-widget-id'
});
</script>

<template>
  <div>
    <button @click="show">Show Support</button>
    <button @click="hide">Hide Support</button>
    <button @click="toggle">Toggle Support</button>
  </div>
</template>
```

#### With Event Handlers

```vue
<script setup lang="ts">
import { HelpdeskWidget } from '@weldsuite/helpdesk-widget-sdk/vue';

const handleReady = (event) => console.log('Ready!', event);
const handleOpened = (event) => console.log('Opened!', event);
</script>

<template>
  <HelpdeskWidget
    widget-id="your-widget-id"
    :on-ready="handleReady"
    :on-opened="handleOpened"
  />
</template>
```

### Angular

#### Using the Standalone Component (Angular 14+)

```typescript
// app.component.ts
import { Component } from '@angular/core';
import { HelpdeskWidgetComponent } from '@weldsuite/helpdesk-widget-sdk/angular';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [HelpdeskWidgetComponent],
  template: `
    <h1>My App</h1>
    <helpdesk-widget [widgetId]="'your-widget-id'"></helpdesk-widget>
  `
})
export class AppComponent {}
```

#### Using the Module (Pre-Angular 14)

```typescript
// app.module.ts
import { NgModule } from '@angular/core';
import { BrowserModule } from '@angular/platform-browser';
import { HelpdeskWidgetModule } from '@weldsuite/helpdesk-widget-sdk/angular';
import { AppComponent } from './app.component';

@NgModule({
  declarations: [AppComponent],
  imports: [
    BrowserModule,
    HelpdeskWidgetModule
  ],
  bootstrap: [AppComponent]
})
export class AppModule {}
```

```typescript
// app.component.ts
import { Component } from '@angular/core';

@Component({
  selector: 'app-root',
  template: `
    <h1>My App</h1>
    <helpdesk-widget [widgetId]="'your-widget-id'"></helpdesk-widget>
  `
})
export class AppComponent {}
```

#### Using the Service

```typescript
// app.component.ts
import { Component } from '@angular/core';
import { HelpdeskWidgetService } from '@weldsuite/helpdesk-widget-sdk/angular';

@Component({
  selector: 'app-root',
  template: `
    <h1>My App</h1>
    <button (click)="showSupport()">Show Support</button>
  `
})
export class AppComponent {
  constructor(private helpdeskService: HelpdeskWidgetService) {
    this.helpdeskService.initialize({ widgetId: 'your-widget-id' });
  }

  showSupport() {
    this.helpdeskService.show();
  }
}
```

#### With Event Handlers

```typescript
// app.component.ts
import { Component } from '@angular/core';
import { HelpdeskWidgetComponent } from '@weldsuite/helpdesk-widget-sdk/angular';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [HelpdeskWidgetComponent],
  template: `
    <helpdesk-widget
      [widgetId]="'your-widget-id'"
      [onReady]="handleReady"
      [onOpened]="handleOpened">
    </helpdesk-widget>
  `
})
export class AppComponent {
  handleReady = (event: any) => {
    console.log('Widget ready', event);
  }

  handleOpened = (event: any) => {
    console.log('Widget opened', event);
  }
}
```

### Svelte

#### Using the Component

```svelte
<script lang="ts">
  import { HelpdeskWidget } from '@weldsuite/helpdesk-widget-sdk/svelte';
</script>

<h1>My App</h1>
<HelpdeskWidget widgetId="your-widget-id" />
```

#### With Programmatic Control

```svelte
<script lang="ts">
  import { HelpdeskWidget } from '@weldsuite/helpdesk-widget-sdk/svelte';

  let widgetComponent;

  const showSupport = () => {
    widgetComponent?.show();
  };
</script>

<button on:click={showSupport}>Show Support</button>
<HelpdeskWidget bind:this={widgetComponent} widgetId="your-widget-id" />
```

#### With Event Handlers

```svelte
<script lang="ts">
  import { HelpdeskWidget } from '@weldsuite/helpdesk-widget-sdk/svelte';

  const handleReady = (event) => {
    console.log('Widget ready', event);
  };

  const handleOpened = (event) => {
    console.log('Widget opened', event);
  };
</script>

<HelpdeskWidget
  widgetId="your-widget-id"
  onReady={handleReady}
  onOpened={handleOpened}
/>
```

## Environment Configuration

The SDK supports different environments with easy configuration:

### Production (Default)

```typescript
import { initHelpdeskWidget } from '@weldsuite/helpdesk-widget-sdk';

// Automatically uses https://widget.welddesk.com
initHelpdeskWidget({ widgetId: 'your-widget-id' });
```

### Development

```typescript
import { initHelpdeskWidget, DEV_CONFIG } from '@weldsuite/helpdesk-widget-sdk';

// Uses http://localhost:3100
initHelpdeskWidget({
  widgetId: 'your-widget-id',
  baseUrl: DEV_CONFIG.baseUrl
});
```

### Staging

```typescript
import { initHelpdeskWidget, STAGING_CONFIG } from '@weldsuite/helpdesk-widget-sdk';

// Uses https://widget-staging.welddesk.com
initHelpdeskWidget({
  widgetId: 'your-widget-id',
  baseUrl: STAGING_CONFIG.baseUrl
});
```

### Custom URL

```typescript
import { initHelpdeskWidget } from '@weldsuite/helpdesk-widget-sdk';

initHelpdeskWidget({
  widgetId: 'your-widget-id',
  baseUrl: 'https://your-custom-domain.com'
});
```

## Event Handling

The SDK provides type-safe event handlers for widget lifecycle events:

### Available Events

- `widget:ready` - Widget iframe has loaded and is ready
- `widget:opened` - Widget panel has been opened
- `widget:closed` - Widget panel has been closed
- `widget:error` - An error occurred in the widget

### Using Event Handlers

#### Via Configuration

```typescript
import { initHelpdeskWidget } from '@weldsuite/helpdesk-widget-sdk';

const widget = initHelpdeskWidget({
  widgetId: 'your-widget-id',
  onReady: (event) => {
    console.log('Widget is ready!', event);
  },
  onOpened: (event) => {
    console.log('Widget opened!', event);
    // Track analytics, etc.
  },
  onClosed: (event) => {
    console.log('Widget closed!', event);
  },
  onError: (event) => {
    console.error('Widget error:', event.data);
  }
});
```

#### Using on() Method

```typescript
import { HelpdeskWidget } from '@weldsuite/helpdesk-widget-sdk';

const widget = new HelpdeskWidget({ widgetId: 'your-widget-id' });

// Register event handlers
widget.on('widget:ready', (event) => {
  console.log('Ready!', event);
});

widget.on('widget:opened', (event) => {
  console.log('Opened!', event);
});

widget.init();
```

#### Removing Event Handlers

```typescript
const handleReady = (event) => {
  console.log('Ready!', event);
};

// Add handler
widget.on('widget:ready', handleReady);

// Remove handler
widget.off('widget:ready', handleReady);
```

## API Reference

### `initHelpdeskWidget(config)`

Convenience function that creates and initializes the widget in one call.

**Parameters:**
- `config.widgetId` (string, required) - Your widget ID

**Returns:** `HelpdeskWidget` instance

**Example:**
```javascript
const widget = initHelpdeskWidget({ widgetId: 'your-widget-id' });
```

### Class: `HelpdeskWidget`

#### Constructor

```typescript
new HelpdeskWidget(config: { widgetId: string })
```

#### Methods

##### `init(): void`

Initialize and mount the widget to the page.

```javascript
const widget = new HelpdeskWidget({ widgetId: 'your-widget-id' });
widget.init();
```

##### `destroy(): void`

Remove the widget from the page and clean up resources.

```javascript
widget.destroy();
```

##### `show(): void`

Show the widget.

```javascript
widget.show();
```

##### `hide(): void`

Hide the widget.

```javascript
widget.hide();
```

##### `toggle(): void`

Toggle widget visibility.

```javascript
widget.toggle();
```

##### `sendMessage(message: any): void`

Send a custom message to the widget (for advanced integrations).

```javascript
widget.sendMessage({ type: 'custom-event', data: { foo: 'bar' } });
```

## Programmatic Control

```javascript
const widget = initHelpdeskWidget({ widgetId: 'your-widget-id' });

// Show widget programmatically
document.getElementById('help-btn').addEventListener('click', () => {
  widget.show();
});

// Hide widget
document.getElementById('close-btn').addEventListener('click', () => {
  widget.hide();
});

// Toggle widget
document.getElementById('toggle-btn').addEventListener('click', () => {
  widget.toggle();
});
```

## Environment Variables

Store your widget ID in environment variables:

```bash
# .env
NEXT_PUBLIC_WIDGET_ID=your-widget-id
VITE_WIDGET_ID=your-widget-id
REACT_APP_WIDGET_ID=your-widget-id
```

Then use it:

```javascript
initHelpdeskWidget({
  widgetId: process.env.NEXT_PUBLIC_WIDGET_ID // Next.js
  // or
  widgetId: import.meta.env.VITE_WIDGET_ID // Vite
  // or
  widgetId: process.env.REACT_APP_WIDGET_ID // Create React App
});
```

## TypeScript Support

Full TypeScript support is included. No additional `@types` packages needed!

```typescript
import { HelpdeskWidget, HelpdeskWidgetConfig } from 'helpdesk-widget';

const config: HelpdeskWidgetConfig = {
  widgetId: 'your-widget-id'
};

const widget = new HelpdeskWidget(config);
widget.init();
```

## Backoffice Configuration

All widget behavior and appearance is controlled from your backoffice dashboard:

### Theme Settings
- Primary color
- Button color
- Button text color
- Launcher color
- Header color
- Accent color
- Border radius
- Font size

### Widget Behavior
- Position (bottom-right, bottom-left, top-right, top-left)
- Auto-open on page load
- Starting page
- Welcome message
- Company name

### Enabled Pages
- Home
- Chat/Messages
- Help
- Status
- Changelog
- News
- Feedback
- Announcements
- Event Sign-up
- Parcel Tracking

### Typography
- Text color
- Background color

Simply log into your backoffice, update your widget settings, and see changes instantly on all sites using that widget ID - no code deployment needed!

## Browser Support

- Chrome (latest)
- Firefox (latest)
- Safari (latest)
- Edge (latest)
- iOS Safari (latest)
- Chrome for Android (latest)

## Security

The widget is loaded in an isolated iframe with:
- Restricted iframe permissions
- Origin-verified postMessage communication
- No access to parent page DOM or JavaScript
- Secure HTTPS-only loading

## Troubleshooting

### Widget Not Appearing?

1. **Check widget ID** - Verify it matches your backoffice configuration
2. **Check console** - Look for error messages in browser console
3. **Check backoffice** - Make sure the widget is enabled and configured
4. **Network check** - Verify `https://widget.welddesk.com` is accessible

### Need to Change Colors/Position?

**Don't edit the code!** Just update the settings in your backoffice dashboard. Changes will take effect immediately.

### Testing Multiple Configurations?

Create multiple widget IDs in your backoffice with different configurations, then swap the `widgetId` in your code:

```javascript
// Development widget
const devWidgetId = 'dev-widget-123';

// Production widget
const prodWidgetId = 'prod-widget-456';

initHelpdeskWidget({
  widgetId: process.env.NODE_ENV === 'production' ? prodWidgetId : devWidgetId
});
```

## FAQ

**Q: Can I change the widget color from my code?**
A: No, all styling is managed in the backoffice. This ensures consistency across all your properties.

**Q: Can I set the position programmatically?**
A: No, position is configured in the backoffice per widget ID.

**Q: How do I enable/disable specific pages?**
A: Configure enabled pages in your backoffice dashboard.

**Q: Can I have multiple widgets on one page?**
A: Yes! Create multiple widget IDs in your backoffice and initialize each one:

```javascript
initHelpdeskWidget({ widgetId: 'sales-widget' });
initHelpdeskWidget({ widgetId: 'support-widget' });
```

**Q: Does it work with server-side rendering?**
A: Yes! Just make sure to initialize the widget in a client-side context (useEffect, onMounted, ngOnInit, etc.).

## Contributing

Contributions are welcome! Please open an issue or submit a pull request.

## License

MIT © WeldSuite

## Support

For questions or issues:
- Open an issue on [GitHub](https://github.com/weldcorporation/weldsuite/issues)
- Email: support@weldsuite.com
- Documentation: [Full Integration Guide](./INTEGRATION_GUIDE.md)

---

Made with ❤️ by [WeldSuite](https://weldsuite.com)
