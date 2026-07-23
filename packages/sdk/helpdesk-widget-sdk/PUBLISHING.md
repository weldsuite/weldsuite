# Publishing Guide

This document explains how to publish the Helpdesk Widget SDK as a private package to GitHub Packages for testing.

## Prerequisites

- Access to the WeldCorporation GitHub organization
- GitHub Personal Access Token (PAT) with `write:packages` permission
- pnpm installed locally (version 10.4.1+)

## Publishing Methods

### Method 1: Manual Workflow Trigger (Recommended)

1. Go to GitHub Actions in the repository
2. Select "Publish Helpdesk Widget SDK" workflow
3. Click "Run workflow"
4. Enter the version number (e.g., `1.0.0`, `1.0.1-beta.1`)
5. Select the dist-tag (`latest`, `beta`, `alpha`, or `next`)
6. Click "Run workflow"

The workflow will:
- ✅ Install dependencies
- ✅ Run TypeScript type checking
- ✅ Build the package
- ✅ Publish to GitHub Packages as `@weldcorporation/helpdesk-widget-sdk`

### Method 2: Git Tag (Automatic)

Create and push a tag with the format `helpdesk-widget-sdk-v{version}`:

```bash
# Example for version 1.0.0
git tag helpdesk-widget-sdk-v1.0.0
git push origin helpdesk-widget-sdk-v1.0.0

# Example for beta version
git tag helpdesk-widget-sdk-v1.0.1-beta.1
git push origin helpdesk-widget-sdk-v1.0.1-beta.1
```

The workflow will automatically:
- Detect the version from the tag name
- Determine the appropriate dist-tag (beta/alpha/next/latest)
- Publish the package

## Installing the Private Package

### Step 1: Authenticate with GitHub Packages

Create or update your `~/.npmrc` file (or project `.npmrc`):

```
@weldcorporation:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=YOUR_GITHUB_PAT
```

Replace `YOUR_GITHUB_PAT` with your GitHub Personal Access Token.

#### Creating a GitHub PAT

1. Go to GitHub Settings → Developer settings → Personal access tokens → Tokens (classic)
2. Click "Generate new token (classic)"
3. Select scopes:
   - ✅ `read:packages` (to download packages)
   - ✅ `write:packages` (to publish packages, if needed)
4. Copy the token and add it to your `.npmrc`

### Step 2: Install the Package

```bash
# Install latest version
npm install @weldcorporation/helpdesk-widget-sdk

# Install specific version
npm install @weldcorporation/helpdesk-widget-sdk@1.0.0

# Install beta version
npm install @weldcorporation/helpdesk-widget-sdk@beta

# With pnpm
pnpm add @weldcorporation/helpdesk-widget-sdk

# With yarn
yarn add @weldcorporation/helpdesk-widget-sdk
```

### Step 3: Use in Your Project

The package is identical to the public version, just hosted privately:

```typescript
// React
import { HelpdeskWidgetReact } from '@weldcorporation/helpdesk-widget-sdk/react';

// Vue
import { HelpdeskWidget } from '@weldcorporation/helpdesk-widget-sdk/vue';

// Angular
import { HelpdeskWidgetComponent } from '@weldcorporation/helpdesk-widget-sdk/angular';

// Svelte
import { HelpdeskWidget } from '@weldcorporation/helpdesk-widget-sdk/svelte';

// Vanilla JS
import { initHelpdeskWidget } from '@weldcorporation/helpdesk-widget-sdk';
```

## Versioning Strategy

Use semantic versioning with the following dist-tags:

| Version Format | Dist-Tag | Example | Use Case |
|----------------|----------|---------|----------|
| `x.y.z` | `latest` | `1.0.0` | Stable releases |
| `x.y.z-beta.n` | `beta` | `1.0.1-beta.1` | Beta testing |
| `x.y.z-alpha.n` | `alpha` | `1.1.0-alpha.1` | Early testing |
| `x.y.z-rc.n` | `next` | `1.0.0-rc.1` | Release candidates |

## CI/CD Workflow Details

The GitHub Actions workflow performs the following steps:

1. **Checkout** - Gets the repository code
2. **Setup Environment** - Configures Node.js 20 and pnpm 10.4.1
3. **Cache Dependencies** - Caches pnpm store for faster builds
4. **Install** - Installs package dependencies
5. **Version** - Sets the package version based on input or tag
6. **Type Check** - Runs TypeScript type checking
7. **Build** - Compiles the package (CJS, ESM, UMD + types)
8. **Configure** - Updates package.json for GitHub Packages
9. **Publish** - Publishes to GitHub Packages registry
10. **Summary** - Creates a release summary

## Troubleshooting

### "Unable to authenticate" error

**Problem**: npm can't authenticate with GitHub Packages

**Solution**:
1. Verify your PAT has `read:packages` permission
2. Check your `.npmrc` file has the correct token
3. Ensure the token is not expired
4. Make sure you're using the correct scope: `@weldcorporation`

### "Package not found" error

**Problem**: Package doesn't exist or you don't have access

**Solution**:
1. Verify you're a member of the WeldCorporation organization
2. Check the package was published successfully in GitHub Actions
3. Verify the package name: `@weldcorporation/helpdesk-widget-sdk`
4. Check you have the correct `.npmrc` configuration

### Build fails in GitHub Actions

**Problem**: The workflow fails during build

**Solution**:
1. Check the TypeScript errors in the workflow log
2. Run `pnpm typecheck` locally to catch issues
3. Run `pnpm build` locally to verify it builds
4. Ensure all dependencies are in `package.json`

### Wrong version published

**Problem**: Published the wrong version number

**Solution**:
1. Publish a new version with the correct number
2. Delete the incorrect version from GitHub Packages (Settings → Packages)
3. Consider using semver to bump versions correctly

## Local Testing Before Publishing

Always test the package locally before publishing:

```bash
cd packages/helpdesk-widget-sdk

# Install dependencies
pnpm install

# Type check
pnpm typecheck

# Build
pnpm build

# Test in another project with pnpm link
pnpm link

# In your test project
pnpm link @weldcorporation/helpdesk-widget-sdk
```

## Environment Variables

The workflow uses the following secrets:

- `GITHUB_TOKEN` - Automatically provided by GitHub Actions (no setup needed)

No additional secrets are required!

## Viewing Published Packages

1. Go to the GitHub repository
2. Click "Packages" in the right sidebar
3. Find `helpdesk-widget-sdk`
4. View all published versions and their details

## Unpublishing a Version

If you need to remove a version:

1. Go to the package page on GitHub
2. Select the version to delete
3. Click "Delete version"
4. Confirm deletion

**Note**: Be careful, as deletion is permanent and may break projects depending on that version.

## Best Practices

1. ✅ Always test locally before publishing
2. ✅ Use semantic versioning consistently
3. ✅ Test beta versions before promoting to latest
4. ✅ Document breaking changes in commit messages
5. ✅ Keep the README.md up to date
6. ✅ Run type checking before every publish
7. ✅ Use meaningful dist-tags (latest/beta/alpha)
8. ✅ Test the published package in a real project before wider distribution

## Support

For issues with publishing:
- Check GitHub Actions logs for error details
- Review this document for common solutions
- Contact the development team

For package usage issues:
- See the main README.md
- Check the framework-specific examples
- Review the TypeScript type definitions
