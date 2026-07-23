# Quick Start Guide

Get your helpdesk widget up and running in less than 2 minutes!

## 1. Install the Package

```bash
npm install helpdesk-widget
```

## 2. Add to Your Website

### Option A: Simple JavaScript

```html
<!DOCTYPE html>
<html>
<head>
  <title>My Website</title>
</head>
<body>
  <h1>Welcome to my website</h1>

  <script src="https://unpkg.com/helpdesk-widget@latest/dist/index.umd.js"></script>
  <script>
    HelpdeskWidget.initHelpdeskWidget({
      widgetId: 'your-widget-id'
    });
  </script>
</body>
</html>
```

### Option B: ES Modules

```javascript
import { initHelpdeskWidget } from 'helpdesk-widget';

initHelpdeskWidget({
  widgetId: 'your-widget-id'
});
```

### Option C: React

```jsx
import { useEffect } from 'react';
import { HelpdeskWidget } from 'helpdesk-widget';

function App() {
  useEffect(() => {
    const widget = new HelpdeskWidget({ widgetId: 'your-widget-id' });
    widget.init();
    return () => widget.destroy();
  }, []);

  return <div>My App</div>;
}
```

## 3. That's It!

No configuration needed. Everything is managed in your backoffice:

- ✅ Colors and theming
- ✅ Widget position
- ✅ Enabled pages
- ✅ Welcome message
- ✅ Starting page
- ✅ And more!

## 4. Test It!

Open your website and you should see the widget. The appearance and behavior are exactly as you configured in your backoffice dashboard.

## Want to Customize?

Don't edit the code! Just:

1. Log into your backoffice at `https://backoffice.weldsuite.org`
2. Navigate to Widget Settings
3. Update colors, position, pages, etc.
4. Save changes
5. Refresh your website - changes appear instantly!

## Need Help?

- Check out the [full README](./README.md) for detailed documentation
- View [examples](./examples/) for more use cases
- Open an issue on GitHub if you encounter problems

## Advanced Usage

### Programmatic Control

```javascript
const widget = initHelpdeskWidget({ widgetId: 'your-widget-id' });

// Show/hide programmatically
widget.show();
widget.hide();
widget.toggle();

// Clean up when done
widget.destroy();
```

### Environment Variables

```bash
# .env
NEXT_PUBLIC_WIDGET_ID=your-widget-id
```

```javascript
initHelpdeskWidget({
  widgetId: process.env.NEXT_PUBLIC_WIDGET_ID
});
```

## One Parameter, Infinite Possibilities

The beauty of this SDK is its simplicity:
- **One parameter:** Just your `widgetId`
- **Zero configuration:** Everything else is in your backoffice
- **Instant updates:** Change settings without code deployments
- **Consistent styling:** Same widget across all your sites

Happy coding! 🚀
