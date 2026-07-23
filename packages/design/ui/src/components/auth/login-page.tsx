'use client';

import { useState } from 'react';
import { useAuthForm } from '../../hooks/use-secure-auth';
import { Button } from '../button';
import { Input } from '../input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../card';
import { Alert, AlertDescription } from '../alert';
import { Label } from '../label';
import { Checkbox } from '../checkbox';
import { Icons } from '../icons';
import { Zap } from 'lucide-react';

interface LoginPageProps {
  appName?: string;
  showSocialLogin?: boolean;
  redirectTo?: string;
}

export function LoginPage({
  appName = 'WeldSuite',
  showSocialLogin = true,
  redirectTo = '/dashboard'
}: LoginPageProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [rememberMe, setRememberMe] = useState(false);

  const {
    isSubmitting,
    error,
    clearError,
    handleSignIn,
    handleSocialSignIn,
  } = useAuthForm();

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await handleSignIn(email, password, rememberMe);
  };

  return (
    <div className="flex min-h-screen">
      {/* Left Side - Branding */}
      <div className="hidden lg:flex lg:w-1/2 bg-gradient-to-br from-primary via-primary/90 to-primary/80 relative overflow-hidden">
        <div className="absolute inset-0 bg-grid-white/[0.05] bg-[size:20px_20px]" />

        <div className="relative z-10 flex flex-col justify-between p-12 text-primary-foreground w-full">
          {/* Logo & Brand */}
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-lg bg-primary-foreground/10 backdrop-blur-sm border border-primary-foreground/20 flex items-center justify-center">
              <Zap className="h-6 w-6" />
            </div>
            <span className="text-2xl font-bold">{appName}</span>
          </div>

          {/* Center Content */}
          <div className="space-y-6">
            <h1 className="text-5xl font-bold leading-tight">
              Your Business,
              <br />
              Unified.
            </h1>
            <p className="text-xl text-primary-foreground/80 max-w-md">
              Manage accounting, commerce, CRM, warehouse, projects, and more — all in one powerful platform.
            </p>

            {/* Feature Highlights */}
            <div className="space-y-4 pt-8">
              {[
                'Integrated business management suite',
                'Real-time collaboration & insights',
                'Secure, scalable, enterprise-ready'
              ].map((feature, i) => (
                <div key={i} className="flex items-center gap-3">
                  <div className="h-6 w-6 rounded-full bg-primary-foreground/10 backdrop-blur-sm border border-primary-foreground/20 flex items-center justify-center flex-shrink-0">
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                  </div>
                  <span className="text-primary-foreground/90">{feature}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Bottom */}
          <div className="text-sm text-primary-foreground/60">
            © 2024 {appName}. All rights reserved.
          </div>
        </div>

        {/* Decorative Elements */}
        <div className="absolute top-1/4 -right-20 h-96 w-96 rounded-full bg-primary-foreground/5 blur-3xl" />
        <div className="absolute bottom-1/4 -left-20 h-96 w-96 rounded-full bg-primary-foreground/5 blur-3xl" />
      </div>

      {/* Right Side - Login Form */}
      <div className="flex-1 flex items-center justify-center p-8 bg-background">
        <div className="w-full max-w-md space-y-8">
          {/* Mobile Logo */}
          <div className="flex lg:hidden items-center justify-center gap-3 mb-8">
            <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center">
              <Zap className="h-6 w-6 text-primary" />
            </div>
            <span className="text-2xl font-bold">{appName}</span>
          </div>

          <Card className="border-border/50 shadow-lg">
            <CardHeader className="space-y-1 pb-6">
              <CardTitle className="text-3xl font-bold tracking-tight">
                Welcome back
              </CardTitle>
              <CardDescription className="text-base">
                Sign in to your account to continue
              </CardDescription>
            </CardHeader>

            <CardContent className="space-y-6">
              {error && (
                <Alert variant="destructive" className="animate-in fade-in slide-in-from-top-1">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}

              <form onSubmit={onSubmit} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="email">Email address</Label>
                  <Input
                    id="email"
                    type="email"
                    placeholder="name@example.com"
                    value={email}
                    onChange={(e) => {
                      setEmail(e.target.value);
                      clearError();
                    }}
                    required
                    disabled={isSubmitting}
                    autoComplete="email"
                    className="h-11"
                  />
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="password">Password</Label>
                    <a
                      href="/reset-password"
                      className="text-sm text-primary hover:underline underline-offset-4 transition-colors"
                    >
                      Forgot password?
                    </a>
                  </div>
                  <Input
                    id="password"
                    type="password"
                    value={password}
                    onChange={(e) => {
                      setPassword(e.target.value);
                      clearError();
                    }}
                    required
                    disabled={isSubmitting}
                    autoComplete="current-password"
                    className="h-11"
                  />
                </div>

                <div className="flex items-center space-x-2">
                  <Checkbox
                    id="remember"
                    checked={rememberMe}
                    onCheckedChange={(checked) => setRememberMe(checked as boolean)}
                    disabled={isSubmitting}
                  />
                  <Label
                    htmlFor="remember"
                    className="text-sm font-normal cursor-pointer select-none"
                  >
                    Remember me for 7 days
                  </Label>
                </div>

                <Button
                  type="submit"
                  className="w-full h-11 text-base font-medium"
                  disabled={isSubmitting}
                >
                  {isSubmitting ? (
                    <>
                      <Icons.spinner className="mr-2 h-4 w-4 animate-spin" />
                      Signing in...
                    </>
                  ) : (
                    'Sign in'
                  )}
                </Button>
              </form>

              {showSocialLogin && (
                <>
                  <div className="relative">
                    <div className="absolute inset-0 flex items-center">
                      <div className="w-full border-t border-border" />
                    </div>
                    <div className="relative flex justify-center text-xs uppercase">
                      <span className="bg-card px-2 text-muted-foreground">
                        Or continue with
                      </span>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <Button
                      variant="outline"
                      onClick={() => handleSocialSignIn('google')}
                      disabled={isSubmitting}
                      className="h-11"
                    >
                      <Icons.google className="mr-2 h-4 w-4" />
                      Google
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => handleSocialSignIn('github')}
                      disabled={isSubmitting}
                      className="h-11"
                    >
                      <Icons.gitHub className="mr-2 h-4 w-4" />
                      GitHub
                    </Button>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <Button
                      variant="outline"
                      onClick={() => handleSocialSignIn('facebook')}
                      disabled={isSubmitting}
                      className="h-11"
                    >
                      <Icons.facebook className="mr-2 h-4 w-4" />
                      Facebook
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => handleSocialSignIn('twitter')}
                      disabled={isSubmitting}
                      className="h-11"
                    >
                      <Icons.twitter className="mr-2 h-4 w-4" />
                      Twitter
                    </Button>
                  </div>
                </>
              )}

              <div className="pt-4 text-center text-sm text-muted-foreground">
                Don't have an account?{' '}
                <a
                  href="/signup"
                  className="font-medium text-primary hover:underline underline-offset-4 transition-colors"
                >
                  Create account
                </a>
              </div>
            </CardContent>
          </Card>

          {/* Additional Info */}
          <p className="text-center text-xs text-muted-foreground px-8">
            By signing in, you agree to our{' '}
            <a href="/terms" className="underline underline-offset-4 hover:text-foreground transition-colors">
              Terms of Service
            </a>{' '}
            and{' '}
            <a href="/privacy" className="underline underline-offset-4 hover:text-foreground transition-colors">
              Privacy Policy
            </a>
          </p>
        </div>
      </div>
    </div>
  );
}