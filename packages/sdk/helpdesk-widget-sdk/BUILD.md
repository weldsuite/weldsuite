# Build & Publish Guide

This guide explains how to build and publish the helpdesk widget SDK to npm.

## Prerequisites

- Node.js 18+
- pnpm (or npm/yarn)
- npm account with publish permissions

## Development Setup

1. **Install dependencies:**

```bash
cd packages/helpdesk-widget-sdk
pnpm install
```

2. **Run type checking:**

```bash
pnpm typecheck
```

## Building the Package

### Development Build (with watch mode)

```bash
pnpm dev
```

This will watch for file changes and rebuild automatically.

### Production Build

```bash
pnpm build
```

This creates:
- `dist/index.js` - CommonJS build
- `dist/index.esm.js` - ES Module build
- `dist/index.umd.js` - UMD build (for browsers)
- `dist/index.d.ts` - TypeScript type definitions
- Source maps for all builds

## Testing Locally

### Option 1: Link the Package

```bash
# In the SDK package directory
pnpm link

# In your test project
pnpm link helpdesk-widget
```

### Option 2: Use Examples

Open the example HTML files directly in your browser:

```bash
# From the SDK directory
open examples/basic.html
open examples/advanced.html
```

### Option 3: Test with a Local Server

```bash
# Install a simple HTTP server
npm install -g http-server

# Serve the examples directory
cd examples
http-server -p 8080

# Open in browser: http://localhost:8080/basic.html
```

## Publishing to npm

### 1. Update Version

Update the version in `package.json` following [semantic versioning](https://semver.org/):

```json
{
  "version": "1.0.0"  // Update this
}
```

Or use npm version command:

```bash
npm version patch  # 1.0.0 -> 1.0.1
npm version minor  # 1.0.0 -> 1.1.0
npm version major  # 1.0.0 -> 2.0.0
```

### 2. Build for Production

```bash
pnpm build
```

### 3. Test the Package

```bash
# Check what files will be published
npm pack --dry-run

# Check package contents
npm pack
tar -xvzf weldsuite-helpdesk-widget-*.tgz
cd package && ls -la
```

### 4. Login to npm

```bash
npm login
```

### 5. Publish

```bash
npm publish --access public
```

For scoped packages (like `helpdesk-widget`), you need `--access public` on first publish.

### 6. Verify Publication

```bash
npm view helpdesk-widget
```

Visit: https://www.npmjs.com/package/helpdesk-widget

## Publishing Checklist

Before publishing, make sure:

- [ ] All tests pass
- [ ] TypeScript compiles without errors (`pnpm typecheck`)
- [ ] Build succeeds (`pnpm build`)
- [ ] Version number is updated in `package.json`
- [ ] CHANGELOG.md is updated (if you have one)
- [ ] README.md is accurate and up-to-date
- [ ] Examples work correctly
- [ ] Git changes are committed
- [ ] You're on the main branch

## Automated Publishing (CI/CD)

### GitHub Actions Example

Create `.github/workflows/publish.yml`:

```yaml
name: Publish Package

on:
  push:
    tags:
      - 'v*'

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3

      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '20'
          registry-url: 'https://registry.npmjs.org'

      - name: Install pnpm
        uses: pnpm/action-setup@v2
        with:
          version: 10

      - name: Install dependencies
        run: pnpm install

      - name: Build
        run: pnpm build

      - name: Publish to npm
        run: npm publish --access public
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

Then publish by creating a git tag:

```bash
git tag v1.0.0
git push origin v1.0.0
```

## Unpublishing

**Warning:** Unpublishing should be avoided. It can break dependent packages.

If you must unpublish within 72 hours:

```bash
npm unpublish helpdesk-widget@1.0.0
```

After 72 hours, you can only deprecate:

```bash
npm deprecate helpdesk-widget@1.0.0 "This version has been deprecated"
```

## Troubleshooting

### Build Errors

```bash
# Clean build artifacts
rm -rf dist

# Reinstall dependencies
rm -rf node_modules
pnpm install

# Rebuild
pnpm build
```

### Publish Permission Denied

Make sure you:
1. Are logged in: `npm whoami`
2. Have permissions for the `@weldsuite` scope
3. Used `--access public` flag for scoped packages

### Type Definitions Not Generated

Check that:
1. `tsconfig.json` has `"declaration": true`
2. `rollup.config.js` includes the `dts` plugin
3. Build completed without TypeScript errors

## Best Practices

1. **Test before publishing** - Always test the built package locally
2. **Version properly** - Follow semantic versioning
3. **Document changes** - Update CHANGELOG.md
4. **Tag releases** - Create git tags for releases
5. **Keep README updated** - Ensure documentation is current
6. **Use .npmignore** - Don't publish unnecessary files

## Support

For questions or issues:
- Open an issue on GitHub
- Contact the development team
- Check npm documentation: https://docs.npmjs.com/

---

Made with ❤️ by WeldSuite
