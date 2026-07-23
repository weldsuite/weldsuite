# Token Refresh Implementation

This document explains how automatic token refresh is implemented in the WeldSuite platform app.

## Overview

Access tokens from Keycloak expire in **300 seconds (5 minutes)**. To maintain user sessions without requiring re-login, we implement automatic token refresh using refresh tokens.

## How It Works

### 1. Token Acquisition

When a user signs in, we request the `offline_access` scope from Keycloak:

```typescript
authorization: {
  params: {
    scope: 'openid profile email organization offline_access',
    prompt: 'select_account',
  }
}
```

This grants us:
- **Access Token**: Short-lived token (300 seconds) for API calls
- **Refresh Token**: Long-lived token for obtaining new access tokens
- **Expires At**: Timestamp when the access token expires

### 2. Token Storage

Tokens are stored in the NextAuth JWT:

```typescript
interface JWT {
  accessToken?: string;
  refreshToken?: string;
  accessTokenExpires?: number; // Unix timestamp in milliseconds
  error?: string;
}
```

### 3. Automatic Refresh Logic

In `auth.ts`, the `jwt` callback checks token expiration on **every request**:

```typescript
async jwt({ token, account, profile }) {
  // Initial sign in - store tokens
  if (account && profile) {
    token.accessToken = account.access_token;
    token.refreshToken = account.refresh_token;
    token.accessTokenExpires = account.expires_at * 1000;
    return token;
  }

  // Token still valid - return as-is
  if (Date.now() < (token.accessTokenExpires || 0)) {
    return token;
  }

  // Token expired - refresh it
  return refreshAccessToken(token);
}
```

### 4. Token Refresh Process

The `refreshAccessToken` function:

1. Calls Keycloak token endpoint with refresh token:
   ```
   POST {KEYCLOAK_ISSUER}/protocol/openid-connect/token
   grant_type=refresh_token
   refresh_token={refresh_token}
   client_id={KEYCLOAK_ID}
   client_secret={KEYCLOAK_SECRET}
   ```

2. Receives new tokens:
   - New access token
   - Updated expires_in
   - New refresh token (or same one)

3. Updates JWT with fresh tokens

4. If refresh fails, marks token with error: `RefreshAccessTokenError`

### 5. Error Handling

The custom `SessionProvider` component monitors for refresh errors:

```typescript
// components/auth/session-provider.tsx
useEffect(() => {
  if (session?.error === 'RefreshAccessTokenError') {
    console.error('Token refresh failed, signing out...');
    signOut({ callbackUrl: '/api/auth/signin' });
  }
}, [session]);
```

When refresh fails (e.g., refresh token expired or revoked):
- User is automatically signed out
- Redirected to login page
- Clean authentication state

## User Experience

### Normal Flow
1. User logs in → receives access + refresh tokens
2. After 5 minutes → access token expires
3. Next API request triggers automatic refresh
4. User continues working seamlessly
5. Repeat for up to 30 days (session max age)

### Refresh Token Expiration
- Refresh tokens have their own expiration (typically 30 days in Keycloak)
- When refresh token expires:
  - Automatic refresh fails
  - User signed out gracefully
  - Redirected to login page

## Configuration

### Keycloak Settings

Ensure your Keycloak client has:
- **Access Type**: confidential
- **Valid Redirect URIs**: `http://localhost:3000/*` (dev) or your production URLs
- **Access Token Lifespan**: 5 minutes (default: 300s)
- **Refresh Token Lifespan**: 30 days (configurable)

### Environment Variables

Required in `.env.local`:
```bash
KEYCLOAK_ID=weldsuite-platform
KEYCLOAK_SECRET=your_client_secret
KEYCLOAK_ISSUER=https://auth.weldsuite.org/realms/weldsuite
AUTH_SECRET=your_nextauth_secret
NEXTAUTH_URL=http://localhost:3000
```

## Benefits

✅ **Seamless UX**: Users stay logged in without interruptions
✅ **Security**: Short-lived access tokens limit exposure window
✅ **Automatic**: No manual token management required
✅ **Graceful Degradation**: Failed refresh results in clean logout
✅ **No Backend Changes**: Works with existing API structure

## Debugging

### Check Token Expiration

In your browser console during development:

```javascript
// Get current session
const session = await fetch('/api/auth/session').then(r => r.json());
console.log('Session:', session);
console.log('Has error:', session.error);
```

### Enable Logging

Refresh events are logged:
```
Console: "Access token expired, refreshing..."
Console: "Error refreshing access token:" (if failed)
```

### Common Issues

**Issue**: Refresh loop (constant refreshing)
- **Cause**: Clock skew between client and server
- **Fix**: Ensure system time is correct

**Issue**: Immediate logout after login
- **Cause**: Refresh token not being returned
- **Fix**: Check `offline_access` scope is requested

**Issue**: 400 error on refresh
- **Cause**: Invalid client credentials
- **Fix**: Verify `KEYCLOAK_ID` and `KEYCLOAK_SECRET`

## Files Modified

- `apps/web/platform/auth.ts` - Token refresh logic
- `apps/web/platform/components/auth/session-provider.tsx` - Error handling
- `apps/web/platform/app/layout.tsx` - Use custom SessionProvider

## References

- [NextAuth JWT Callback](https://next-auth.js.org/configuration/callbacks#jwt-callback)
- [Keycloak Token Endpoint](https://www.keycloak.org/docs/latest/securing_apps/#_token-exchange)
- [OAuth 2.0 Refresh Token Grant](https://www.rfc-editor.org/rfc/rfc6749#section-6)
