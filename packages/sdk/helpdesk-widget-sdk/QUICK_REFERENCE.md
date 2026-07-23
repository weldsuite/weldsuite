# Quick Reference Card

## Publishing (for Maintainers)

### Publish via GitHub Actions UI
1. Go to Actions → "Publish Helpdesk Widget SDK"
2. Click "Run workflow"
3. Enter version (e.g., `1.0.0`, `1.0.1-beta.1`)
4. Select tag (`latest`, `beta`, `alpha`, `next`)
5. Click "Run workflow"

### Publish via Git Tag
```bash
git tag helpdesk-widget-sdk-v1.0.0
git push origin helpdesk-widget-sdk-v1.0.0
```

## Installing (for Developers)

### Setup Authentication (.npmrc)
```
@weldcorporation:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=YOUR_GITHUB_PAT
```

### Install Package
```bash
npm install @weldcorporation/helpdesk-widget-sdk
```

## Framework Usage

### React
```tsx
import { HelpdeskWidgetReact } from '@weldcorporation/helpdesk-widget-sdk/react';

<HelpdeskWidgetReact widgetId="your-widget-id" />
```

### Vue
```vue
<script setup>
import { HelpdeskWidget } from '@weldcorporation/helpdesk-widget-sdk/vue';
</script>

<template>
  <HelpdeskWidget widget-id="your-widget-id" />
</template>
```

### Angular
```typescript
import { HelpdeskWidgetComponent } from '@weldcorporation/helpdesk-widget-sdk/angular';

@Component({
  imports: [HelpdeskWidgetComponent],
  template: `<helpdesk-widget [widgetId]="'your-widget-id'"></helpdesk-widget>`
})
```

### Svelte
```svelte
<script>
  import { HelpdeskWidget } from '@weldcorporation/helpdesk-widget-sdk/svelte';
</script>

<HelpdeskWidget widgetId="your-widget-id" />
```

### Vanilla JS
```typescript
import { initHelpdeskWidget } from '@weldcorporation/helpdesk-widget-sdk';

initHelpdeskWidget({ widgetId: 'your-widget-id' });
```

## Environment Configuration

### Development (localhost:3100)
```typescript
import { initHelpdeskWidget, DEV_CONFIG } from '@weldcorporation/helpdesk-widget-sdk';

initHelpdeskWidget({
  widgetId: 'your-widget-id',
  baseUrl: DEV_CONFIG.baseUrl
});
```

### Staging
```typescript
import { STAGING_CONFIG } from '@weldcorporation/helpdesk-widget-sdk';

initHelpdeskWidget({
  widgetId: 'your-widget-id',
  baseUrl: STAGING_CONFIG.baseUrl
});
```

### Production (Default)
```typescript
// No baseUrl needed - defaults to https://widget.welddesk.com
initHelpdeskWidget({ widgetId: 'your-widget-id' });
```

## Event Handlers

```typescript
import { HelpdeskWidgetReact } from '@weldcorporation/helpdesk-widget-sdk/react';

<HelpdeskWidgetReact
  widgetId="your-widget-id"
  onReady={(event) => console.log('Ready', event)}
  onOpened={(event) => console.log('Opened', event)}
  onClosed={(event) => console.log('Closed', event)}
  onError={(event) => console.error('Error', event)}
/>
```

## Programmatic Control

```typescript
import { HelpdeskWidget } from '@weldcorporation/helpdesk-widget-sdk';

const widget = new HelpdeskWidget({ widgetId: 'your-widget-id' });
widget.init();

widget.show();    // Show widget
widget.hide();    // Hide widget
widget.toggle();  // Toggle visibility

// Event handlers
widget.on('widget:ready', (event) => console.log('Ready'));
widget.off('widget:ready', handler); // Remove handler
```

## Local Development

```bash
# Install dependencies
pnpm install

# Type check
pnpm typecheck

# Build package
pnpm build

# Watch mode
pnpm dev

# Test with pnpm link
pnpm link
cd /path/to/test/project
pnpm link @weldcorporation/helpdesk-widget-sdk
```

## Common URLs

- **Production**: `https://widget.welddesk.com`
- **Staging**: `https://widget-staging.welddesk.com`
- **Development**: `http://localhost:3100`

## Troubleshooting

### Can't install package
✅ Check `.npmrc` has GitHub PAT with `read:packages` permission

### Widget not loading
✅ Verify `widgetId` is correct
✅ Check browser console for errors
✅ Confirm `baseUrl` is accessible

### TypeScript errors
✅ Run `pnpm install` to get type definitions
✅ Check import paths match framework exports

## Links

- [Full README](./README.md)
- [Publishing Guide](./PUBLISHING.md)
- [Testing Guide](./TEST.md)
