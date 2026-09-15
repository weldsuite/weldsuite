/**
 * Phone Billing API Routes
 *
 * Manages a separate Stripe subscription for phone number billing.
 * Each workspace can have one phone subscription with multiple items
 * (one per country+type price tier), using quantity to track count.
 *
 * After Stripe payment succeeds, calls the platform internal API to
 * purchase the number from Twilio and save it.
 */

import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import type { Env } from '../index';
import { clerkJwtAuth } from '../middleware/auth';
import { getMasterDb, masterSchema } from '../lib/db';
import {
  createStripeSubscription,
  createStripeCustomer,
  createCheckoutSession,
  retrieveSubscription,
  addSubscriptionItem,
  updateSubscriptionItemQuantity,
  deleteSubscriptionItem,
  cancelSubscriptionImmediately,
  listPaymentMethods,
  createStripeProduct,
  createStripePrice,
} from '../lib/stripe';

type PhoneBillBody = {
  stripePriceId?: string;
  unitAmountCents?: number;
  currency?: string;
  countryCode: string;
  numberType: string;
  phoneNumber: string;
  friendlyName?: string;
  displayName?: string;
  addressSid?: string;
  addressId?: string;
  bundleSid?: string;
  clerkOrgId?: string;
};

async function resolvePhoneStripePriceId(
  stripeKey: string,
  body: PhoneBillBody,
): Promise<string | null> {
  if (body.stripePriceId) return body.stripePriceId;
  const cents = body.unitAmountCents;
  if (!cents || cents < 1) return null;
  const product = await createStripeProduct(stripeKey, {
    name: `Phone Number - ${body.countryCode} ${body.numberType}`,
    metadata: {
      countryCode: body.countryCode,
      numberType: body.numberType,
      managedBy: 'weldsuite',
    },
  });
  const price = await createStripePrice(stripeKey, {
    productId: product.id,
    unitAmount: cents,
    currency: body.currency || 'USD',
    interval: 'month',
  });
  return price.id as string;
}

const { workspaces } = masterSchema;

export const phoneBillingRoutes = new Hono<{
  Bindings: Env;
  Variables: {
    userId: string;
    orgId: string | null;
  };
}>();

// Apply JWT auth to all phone billing routes
phoneBillingRoutes.use('*', clerkJwtAuth());

// ============================================================================
// GET /subscription — Current phone subscription details
// ============================================================================

phoneBillingRoutes.get('/subscription', async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return c.json({ error: 'No organization selected' }, 400);

  const masterDb = getMasterDb(c.env);

  const [workspace] = await masterDb
    .select()
    .from(workspaces)
    .where(eq(workspaces.clerkOrgId, orgId));

  if (!workspace) return c.json({ error: 'Workspace not found' }, 404);

  if (!workspace.stripePhoneSubscriptionId) {
    return c.json({ exists: false });
  }

  try {
    const subscription = await retrieveSubscription(
      c.env.STRIPE_SECRET_KEY,
      workspace.stripePhoneSubscriptionId
    );

    const items = (subscription.items?.data || []).map((item: any) => ({
      id: item.id,
      priceId: item.price.id,
      quantity: item.quantity,
      amount: (item.price.unit_amount || 0) * item.quantity,
      currency: item.price.currency,
      interval: item.price.recurring?.interval || 'month',
    }));

    const totalMonthly = items.reduce((sum: number, item: any) => sum + item.amount, 0);

    return c.json({
      exists: true,
      subscriptionId: subscription.id,
      status: subscription.status,
      items,
      totalMonthly,
      currentPeriodStart: subscription.current_period_start
        ? new Date(subscription.current_period_start * 1000).toISOString()
        : null,
      currentPeriodEnd: subscription.current_period_end
        ? new Date(subscription.current_period_end * 1000).toISOString()
        : null,
    });
  } catch (error) {
    console.error('[Phone Billing] Error fetching subscription:', error);
    return c.json({ exists: false });
  }
});

// ============================================================================
// POST /add-number — Add a phone number to billing, then trigger provisioning
// ============================================================================

phoneBillingRoutes.post('/add-number', async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return c.json({ error: 'No organization selected' }, 400);

  const body = await c.req.json<PhoneBillBody>();

  if (!body.phoneNumber) {
    return c.json({ error: 'Missing phoneNumber' }, 400);
  }

  const stripePriceId = await resolvePhoneStripePriceId(c.env.STRIPE_SECRET_KEY, body);
  if (!stripePriceId) {
    return c.json({ error: 'Missing stripePriceId or unitAmountCents' }, 400);
  }

  const masterDb = getMasterDb(c.env);

  const [workspace] = await masterDb
    .select()
    .from(workspaces)
    .where(eq(workspaces.clerkOrgId, orgId));

  if (!workspace) return c.json({ error: 'Workspace not found' }, 404);

  // Ensure Stripe customer exists
  let customerId: string = workspace.stripeCustomerId || '';
  if (!customerId) {
    const customer = await createStripeCustomer(c.env.STRIPE_SECRET_KEY, {
      name: workspace.name,
      metadata: {
        workspaceId: workspace.id,
        clerkOrgId: orgId,
      },
    });
    customerId = customer.id;

    await masterDb
      .update(workspaces)
      .set({ stripeCustomerId: customerId, updatedAt: new Date() })
      .where(eq(workspaces.id, workspace.id));
  }

  // If no phone subscription exists, create one
  if (!workspace.stripePhoneSubscriptionId) {
    // Check if customer has a payment method
    const paymentMethods = await listPaymentMethods(c.env.STRIPE_SECRET_KEY, customerId);
    const hasPaymentMethod = paymentMethods.data && paymentMethods.data.length > 0;

    if (!hasPaymentMethod) {
      return c.json({ requiresCheckout: true });
    }

    // Create new phone subscription with phone details in metadata
    const subscription = await createStripeSubscription(c.env.STRIPE_SECRET_KEY, {
      customerId,
      priceId: stripePriceId,
      quantity: 1,
      metadata: {
        type: 'phone',
        workspaceId: workspace.id,
        clerkOrgId: orgId,
        phone_number: body.phoneNumber,
        phone_country_code: body.countryCode,
        phone_number_type: body.numberType,
        ...(body.friendlyName ? { phone_friendly_name: body.friendlyName } : {}),
        ...(body.displayName ? { phone_display_name: body.displayName } : {}),
        ...((body.addressId || body.addressSid) ? { phone_address_id: body.addressId || body.addressSid || '' } : {}),
        ...(body.bundleSid ? { phone_bundle_sid: body.bundleSid } : {}),
      },
    });

    // Save subscription ID
    await masterDb
      .update(workspaces)
      .set({
        stripePhoneSubscriptionId: subscription.id,
        updatedAt: new Date(),
      })
      .where(eq(workspaces.id, workspace.id));

    return c.json({
      success: true,
      subscriptionId: subscription.id,
      provisioningStatus: 'unavailable',
    });
  }

  // Phone subscription exists — check if an item with this price already exists
  const subscription = await retrieveSubscription(
    c.env.STRIPE_SECRET_KEY,
    workspace.stripePhoneSubscriptionId
  );

  const existingItem = subscription.items?.data?.find(
    (item: any) => item.price.id === stripePriceId
  );

  if (existingItem) {
    // Increment quantity
    await updateSubscriptionItemQuantity(
      c.env.STRIPE_SECRET_KEY,
      existingItem.id,
      existingItem.quantity + 1
    );
  } else {
    // Add new subscription item
    await addSubscriptionItem(
      c.env.STRIPE_SECRET_KEY,
      workspace.stripePhoneSubscriptionId,
      stripePriceId,
      1
    );
  }

  return c.json({
    success: true,
    subscriptionId: subscription.id,
    provisioningStatus: 'unavailable',
  });
});

// ============================================================================
// POST /remove-number — Remove a phone number from billing
// ============================================================================

phoneBillingRoutes.post('/remove-number', async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return c.json({ error: 'No organization selected' }, 400);

  const body = await c.req.json<{ stripePriceId: string }>();
  if (!body.stripePriceId) {
    return c.json({ error: 'Missing stripePriceId' }, 400);
  }

  const masterDb = getMasterDb(c.env);

  const [workspace] = await masterDb
    .select()
    .from(workspaces)
    .where(eq(workspaces.clerkOrgId, orgId));

  if (!workspace) return c.json({ error: 'Workspace not found' }, 404);

  if (!workspace.stripePhoneSubscriptionId) {
    return c.json({ error: 'No phone subscription found' }, 400);
  }

  const subscription = await retrieveSubscription(
    c.env.STRIPE_SECRET_KEY,
    workspace.stripePhoneSubscriptionId
  );

  const existingItem = subscription.items?.data?.find(
    (item: any) => item.price.id === body.stripePriceId
  );

  if (!existingItem) {
    return c.json({ error: 'No subscription item found for this price' }, 404);
  }

  const totalItems = subscription.items?.data?.length || 0;

  if (existingItem.quantity > 1) {
    // Decrement quantity
    await updateSubscriptionItemQuantity(
      c.env.STRIPE_SECRET_KEY,
      existingItem.id,
      existingItem.quantity - 1
    );
    return c.json({ success: true, subscriptionCanceled: false });
  }

  if (totalItems > 1) {
    // Delete this item, other items remain
    await deleteSubscriptionItem(c.env.STRIPE_SECRET_KEY, existingItem.id);
    return c.json({ success: true, subscriptionCanceled: false });
  }

  // Last item with quantity 1 — cancel the entire subscription
  await cancelSubscriptionImmediately(c.env.STRIPE_SECRET_KEY, workspace.stripePhoneSubscriptionId);

  await masterDb
    .update(workspaces)
    .set({
      stripePhoneSubscriptionId: null,
      updatedAt: new Date(),
    })
    .where(eq(workspaces.id, workspace.id));

  return c.json({ success: true, subscriptionCanceled: true });
});

// ============================================================================
// POST /checkout — Create Stripe Checkout for users without payment method
// ============================================================================

phoneBillingRoutes.post('/checkout', async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return c.json({ error: 'No organization selected' }, 400);

  const body = await c.req.json<PhoneBillBody & { successUrl?: string; cancelUrl?: string }>();

  if (!body.phoneNumber) {
    return c.json({ error: 'Missing phoneNumber' }, 400);
  }

  const stripePriceId = await resolvePhoneStripePriceId(c.env.STRIPE_SECRET_KEY, body);
  if (!stripePriceId) {
    return c.json({ error: 'Missing stripePriceId or unitAmountCents' }, 400);
  }

  const masterDb = getMasterDb(c.env);

  const [workspace] = await masterDb
    .select()
    .from(workspaces)
    .where(eq(workspaces.clerkOrgId, orgId));

  if (!workspace) return c.json({ error: 'Workspace not found' }, 404);

  // Ensure Stripe customer exists
  let checkoutCustomerId: string = workspace.stripeCustomerId || '';
  if (!checkoutCustomerId) {
    const customer = await createStripeCustomer(c.env.STRIPE_SECRET_KEY, {
      name: workspace.name,
      metadata: {
        workspaceId: workspace.id,
        clerkOrgId: orgId,
      },
    });
    checkoutCustomerId = customer.id;

    await masterDb
      .update(workspaces)
      .set({ stripeCustomerId: checkoutCustomerId, updatedAt: new Date() })
      .where(eq(workspaces.id, workspace.id));
  }

  // Store phone details in session metadata so the webhook can order Telnyx
  // after payment_status=paid — same order as WeldHost domain registration.
  const session = await createCheckoutSession(c.env.STRIPE_SECRET_KEY, {
    customerId: checkoutCustomerId,
    priceId: stripePriceId,
    quantity: 1,
    successUrl: body.successUrl || 'https://app.weldsuite.org/settings/apps/phone-numbers?billing=success',
    cancelUrl: body.cancelUrl || 'https://app.weldsuite.org/settings/apps/phone-numbers?billing=canceled',
    metadata: {
      type: 'phone_checkout',
      workspaceId: workspace.id,
      clerkOrgId: orgId,
      phone_number: body.phoneNumber,
      phone_country_code: body.countryCode,
      phone_number_type: body.numberType,
      ...(body.friendlyName ? { phone_friendly_name: body.friendlyName } : {}),
      ...(body.displayName ? { phone_display_name: body.displayName } : {}),
      ...((body.addressId || body.addressSid) ? { phone_address_id: body.addressId || body.addressSid || '' } : {}),
      ...(body.bundleSid ? { phone_bundle_sid: body.bundleSid } : {}),
    },
  });

  return c.json({ url: session.url });
});
