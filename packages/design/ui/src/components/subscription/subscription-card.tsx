"use client";

import { useState } from "react";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "../card";
import { Button } from "../button";
import { Badge } from "../badge";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "../alert-dialog";
import { CreditCard } from "lucide-react";

interface SubscriptionCardProps {
  subscription?: {
    plan: {
      name: string;
      displayName: string;
      price: number;
    };
    status: string;
    currentPeriodEnd: string;
    cancelledAt?: string;
  };
  usage?: {
    isFreePlan: boolean;
  };
  onUpgrade?: () => void;
  onManage?: () => void;
  onCancel?: () => void;
}

export function SubscriptionCard({
  subscription,
  usage,
  onUpgrade,
  onManage,
  onCancel,
}: SubscriptionCardProps) {
  const [cancelDialogOpen, setCancelDialogOpen] = useState(false);

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  };

  const getStatusBadge = (status: string) => {
    const variants: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
      ACTIVE: "default",
      TRIALING: "secondary",
      PAST_DUE: "destructive",
      CANCELLED: "outline",
    };
    return (
      <Badge variant={variants[status] || "default"}>
        {status.replace("_", " ")}
      </Badge>
    );
  };

  const isFreePlan = usage?.isFreePlan || !subscription;
  const planName = subscription?.plan?.displayName || "Free Plan";

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex justify-between items-start">
            <div>
              <CardTitle>{planName}</CardTitle>
              <CardDescription>
                {isFreePlan
                  ? "Upgrade to Pro for more storage and features"
                  : subscription?.cancelledAt
                  ? `Cancelled - Expires ${formatDate(subscription.currentPeriodEnd)}`
                  : `Renews ${formatDate(subscription?.currentPeriodEnd || "")}`}
              </CardDescription>
            </div>
            {subscription && getStatusBadge(subscription.status)}
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Plan Details */}
          <div className="space-y-2">
            {isFreePlan ? (
              <div className="flex justify-between text-sm">
                <span>Monthly Cost</span>
                <span className="font-medium">Free</span>
              </div>
            ) : (
              <div className="flex justify-between text-sm">
                <span>Monthly Subscription</span>
                <span className="font-medium">
                  ${(subscription?.plan.price || 0) / 100}/month
                </span>
              </div>
            )}
          </div>
        </CardContent>
        <CardFooter className="flex gap-2">
          {isFreePlan ? (
            <Button onClick={onUpgrade} className="w-full">
              <CreditCard className="w-4 h-4 mr-2" />
              Upgrade to Pro ($150/month)
            </Button>
          ) : (
            <>
              <Button onClick={onManage} variant="outline" className="flex-1">
                Manage Billing
              </Button>
              {subscription?.status !== "CANCELLED" && (
                <Button
                  onClick={() => setCancelDialogOpen(true)}
                  variant="destructive"
                  className="flex-1"
                >
                  Cancel Plan
                </Button>
              )}
            </>
          )}
        </CardFooter>
      </Card>

      <AlertDialog open={cancelDialogOpen} onOpenChange={setCancelDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel Subscription</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to cancel your subscription? You will lose access to Pro features
              at the end of your current billing period.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep Subscription</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                onCancel?.();
                setCancelDialogOpen(false);
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Cancel Subscription
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}