import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export interface AuthMiddlewareConfig {
  publicPaths?: string[];
  authPaths?: string[];
  adminPaths?: string[];
  apiPaths?: string[];
  loginPath?: string;
  unauthorizedPath?: string;
  enableCsrf?: boolean;
  enableRateLimit?: boolean;
  cookieName?: string;
}

export function createAuthMiddleware(config: AuthMiddlewareConfig) {
  return function middleware(request: NextRequest) {
    const { pathname } = request.nextUrl;
    const publicPaths = config.publicPaths || [];
    
    // Check if the path is public
    const isPublicPath = publicPaths.some(path => 
      pathname === path || pathname.startsWith(path + '/')
    );
    
    if (isPublicPath) {
      return NextResponse.next();
    }
    
    // Check for session cookie
    const sessionCookie = request.cookies.get(config.cookieName || 'session');
    
    if (!sessionCookie) {
      // Redirect to login
      const url = request.nextUrl.clone();
      url.pathname = config.loginPath || '/login';
      url.searchParams.set('redirect', pathname);
      return NextResponse.redirect(url);
    }
    
    return NextResponse.next();
  };
}

export const authMiddlewareConfig = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|public).*)',
  ],
};