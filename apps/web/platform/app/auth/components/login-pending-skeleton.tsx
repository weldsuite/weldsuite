import { Skeleton } from '@weldsuite/ui/components/skeleton';

/**
 * Login-shaped pending UI. Set as the `pendingComponent` on the auth login
 * route so a cold entry reads as the sign-in form (centered card: heading,
 * OAuth button, divider, email + password fields, submit) instead of the
 * generic dashboard table skeleton (`RoutePendingSkeleton`), which looks
 * nothing like the page it precedes.
 */
export function LoginPendingSkeleton() {
  return (
    <div className="min-h-screen bg-white flex relative" data-slot="login-pending">
      <div className="flex-1 flex flex-col justify-center px-8 py-12 lg:px-16">
        <div className="w-full max-w-[448px] mx-auto">
          {/* Heading + subtitle */}
          <div className="mb-[32px] space-y-2">
            <Skeleton className="h-[26px] w-48" />
            <Skeleton className="h-4 w-72 max-w-full" />
          </div>

          {/* OAuth (Google) button */}
          <Skeleton className="h-[42px] w-full rounded-[calc(var(--radius)+1px)]" />

          {/* "or" divider */}
          <div className="relative my-6 flex items-center gap-3">
            <div className="h-px flex-1 bg-gray-200" />
            <Skeleton className="h-3 w-6" />
            <div className="h-px flex-1 bg-gray-200" />
          </div>

          {/* Email + password fields */}
          <div className="space-y-[25px]">
            <div className="space-y-2">
              <Skeleton className="h-4 w-16" />
              <Skeleton className="h-[40px] w-full" />
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Skeleton className="h-4 w-20" />
                <Skeleton className="h-3 w-28" />
              </div>
              <Skeleton className="h-[40px] w-full" />
            </div>

            {/* Submit */}
            <Skeleton className="h-[42px] w-full rounded-[calc(var(--radius)+1px)] !mt-[4px]" />
          </div>
        </div>
      </div>

      {/* "Need an account? Sign up" line */}
      <div className="absolute bottom-6 left-0 right-0 flex justify-center">
        <Skeleton className="h-4 w-52" />
      </div>
    </div>
  );
}
