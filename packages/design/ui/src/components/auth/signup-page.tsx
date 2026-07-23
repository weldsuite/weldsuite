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

interface SignupPageProps {
  appName?: string;
  showSocialLogin?: boolean;
  redirectTo?: string;
}

export function SignupPage({ 
  appName = 'WeldSuite',
  showSocialLogin = true,
  redirectTo = '/verify-email'
}: SignupPageProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [name, setName] = useState('');
  const [acceptTerms, setAcceptTerms] = useState(false);
  const [passwordError, setPasswordError] = useState('');
  
  const {
    isSubmitting,
    error,
    clearError,
    handleSignUp,
    handleSocialSignIn,
  } = useAuthForm();

  const validatePassword = () => {
    if (password.length < 12) {
      setPasswordError('Password must be at least 12 characters');
      return false;
    }
    if (password !== confirmPassword) {
      setPasswordError('Passwords do not match');
      return false;
    }
    if (!/[A-Z]/.test(password)) {
      setPasswordError('Password must contain at least one uppercase letter');
      return false;
    }
    if (!/[a-z]/.test(password)) {
      setPasswordError('Password must contain at least one lowercase letter');
      return false;
    }
    if (!/\d/.test(password)) {
      setPasswordError('Password must contain at least one number');
      return false;
    }
    if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password)) {
      setPasswordError('Password must contain at least one special character');
      return false;
    }
    setPasswordError('');
    return true;
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!validatePassword()) {
      return;
    }

    if (!acceptTerms) {
      setPasswordError('You must accept the terms and conditions');
      return;
    }

    await handleSignUp(email, password, name);
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
              Start Your
              <br />
              Journey Today
            </h1>
            <p className="text-xl text-primary-foreground/80 max-w-md">
              Join thousands of businesses using {appName} to streamline operations and boost productivity.
            </p>

            {/* Feature Highlights */}
            <div className="space-y-4 pt-8">
              {[
                'Get started in minutes, not hours',
                'No credit card required for trial',
                'Enterprise-grade security & compliance'
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

      {/* Right Side - Signup Form */}
      <div className="flex-1 flex items-center justify-center p-8 bg-background overflow-y-auto">
        <div className="w-full max-w-md space-y-8 py-8">
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
                Create an account
              </CardTitle>
              <CardDescription className="text-base">
                Enter your information to get started with {appName}
              </CardDescription>
            </CardHeader>

            <CardContent className="space-y-6">
              {(error || passwordError) && (
                <Alert variant="destructive" className="animate-in fade-in slide-in-from-top-1">
                  <AlertDescription>{error || passwordError}</AlertDescription>
                </Alert>
              )}

              <form onSubmit={onSubmit} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="name">Full name (optional)</Label>
                  <Input
                    id="name"
                    type="text"
                    placeholder="John Doe"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    disabled={isSubmitting}
                    autoComplete="name"
                    className="h-11"
                  />
                </div>

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
                  <Label htmlFor="password">Password</Label>
                  <Input
                    id="password"
                    type="password"
                    value={password}
                    onChange={(e) => {
                      setPassword(e.target.value);
                      clearError();
                      setPasswordError('');
                    }}
                    required
                    disabled={isSubmitting}
                    autoComplete="new-password"
                    className="h-11"
                  />
                  <p className="text-xs text-muted-foreground">
                    Must be at least 12 characters with uppercase, lowercase, number, and special character
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="confirmPassword">Confirm password</Label>
                  <Input
                    id="confirmPassword"
                    type="password"
                    value={confirmPassword}
                    onChange={(e) => {
                      setConfirmPassword(e.target.value);
                      setPasswordError('');
                    }}
                    required
                    disabled={isSubmitting}
                    autoComplete="new-password"
                    className="h-11"
                  />
                </div>

                <div className="flex items-start space-x-2 pt-2">
                  <Checkbox
                    id="terms"
                    checked={acceptTerms}
                    onCheckedChange={(checked) => {
                      setAcceptTerms(checked as boolean);
                      setPasswordError('');
                    }}
                    disabled={isSubmitting}
                    className="mt-0.5"
                  />
                  <Label
                    htmlFor="terms"
                    className="text-sm font-normal cursor-pointer select-none leading-relaxed"
                  >
                    I agree to the{' '}
                    <a href="/terms" className="text-primary hover:underline underline-offset-4 transition-colors">
                      Terms of Service
                    </a>{' '}
                    and{' '}
                    <a href="/privacy" className="text-primary hover:underline underline-offset-4 transition-colors">
                      Privacy Policy
                    </a>
                  </Label>
                </div>

                <Button
                  type="submit"
                  className="w-full h-11 text-base font-medium"
                  disabled={isSubmitting || !acceptTerms}
                >
                  {isSubmitting ? (
                    <>
                      <Icons.spinner className="mr-2 h-4 w-4 animate-spin" />
                      Creating account...
                    </>
                  ) : (
                    'Create account'
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
                        Or sign up with
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
                </>
              )}

              <div className="pt-4 text-center text-sm text-muted-foreground">
                Already have an account?{' '}
                <a
                  href="/login"
                  className="font-medium text-primary hover:underline underline-offset-4 transition-colors"
                >
                  Sign in
                </a>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}