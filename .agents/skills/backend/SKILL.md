---
name: aerify-backend
description: Guides the implementation of frontend-to-backend integration in the Aerify codebase. Always invoke this skill when writing client code (Vite, React, or HTML/JS), integrating API endpoints, handling authentication, implementing checkouts, showing active eSIMs, or querying usage stats.
---

# Aerify Backend Integration Guide

Use this skill to connect the Aerify frontend client to the Supabase backend. It details authentication patterns, table schemas, Edge Functions, and end-to-end implementation workflows.

---

## 1. Supabase Initialization & Authentication

To interact with the backend, initialize the Supabase JS Client (`@supabase/supabase-js`). The frontend should use the standard Supabase authentication client.

```javascript
import { createClient } from '@supabase/supabase-js'

const supabaseUrl = 'https://pyhkunuzaypikvmjcbln.supabase.co'
const supabaseAnonKey = 'YOUR_SUPABASE_ANON_KEY'

export const supabase = createClient(supabaseUrl, supabaseAnonKey)
```

### Authorization Header Pattern
All authenticated edge functions check ownership via the user's JWT. When executing request calls to **authenticated edge functions**, you **must** obtain the user's session token and pass it in the `Authorization` header as a Bearer token:

```javascript
const { data: { session } } = await supabase.auth.getSession()
const token = session?.access_token

const response = await fetch(`${supabaseUrl}/functions/v1/<function-name>`, {
  headers: {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  },
  // ...
})
```

---

## 2. Database Catalog & RLS Policies

Since Row-Level Security (RLS) is enabled, the frontend client can perform direct queries on the Supabase client without custom endpoints for data retrieval.

### `public.packages`
Holds synced Airalo eSIM package snapshots. Used for store listing.
- **RLS**: Public read (`anon` or `authenticated`). No write access.
- **Key Columns**:
  - `package_id` (text, PK): E.g. `"uki-mobile-plus-in-15days-20gb"`
  - `name` (text): E.g. `"Uki Mobile Plus"`
  - `operator` (text): Operator name, e.g. `"Uki Mobile"`
  - `operator_image` (text): URL to operator image logo
  - `country` (text): Country name, e.g. `"India"`
  - `country_code` (text): ISO 3166-1 alpha-2, e.g. `"IN"`
  - `category` (text): `'country' | 'regional' | 'global'`
  - `data_amount` (text): E.g. `"20 GB"`
  - `validity_days` (integer): Duration of validity
  - `price_usd` (numeric): Final price in USD (with markup applied)
  - `prices` (jsonb): Map of pricing in local currencies with markup. Schema: `{ "USD": 12.48, "EUR": 10.99, "GBP": 9.48, ... }`
  - `base_prices` (jsonb): Map of net cost from Airalo. Schema: `{ "USD": 10.40, ... }`
  - `image_url` (text): Country flag or generic region/global banner
  - `networks` (text[]): Supported carrier networks in that region, e.g. `["Airtel", "Jio"]`
  - `rechargeability` (boolean): Whether it supports top-ups.

### `public.orders`
Holds user orders (both new purchases and top-ups).
- **RLS**: Authenticated users can read their own (`user_id = auth.uid()`) and create their own.
- **Key Columns**:
  - `id` (uuid, PK): Internal order identifier
  - `user_id` (uuid): Owner user reference
  - `stripe_session_id` (text): Unique Stripe checkout ID (ensures webhook idempotency)
  - `package_id` (text): Target package purchased
  - `country` (text) & `country_code` (text): Metadata fields
  - `amount_paid` (numeric): Real amount charged (in USD)
  - `order_status` (text): `'paid' | 'provisioning' | 'completed' | 'provisioning_failed'`
  - `order_type` (text): `'sim' | 'topup'`
  - `iccid` (text, nullable): Assigned ICCID once complete
  - `airalo_order_id` (text, nullable): Airalo order ID from provider API

### `public.active_esims`
Holds all active eSIMs owned by users (useful for user dashboard).
- **RLS**: Authenticated users can read their own (`user_id = auth.uid()`).
- **Key Columns**:
  - `iccid` (text, PK): Main identifier
  - `user_id` (uuid): Owner user reference
  - `order_id` (uuid): Origin order reference
  - `plan_name` (text), `data_amount` (text), `validity_days` (integer)
  - `qrcode` (text): QR payload, e.g. `"LPA:1$smdp.address$matching-id"`
  - `qrcode_url` (text): QR image URL
  - `smdp_address` (text) & `matching_id` (text): Manual configuration details
  - `apple_installation_url` (text, nullable): Direct installation link for Apple devices
  - `image_url` (text): Country/region image URL

---

## 3. Edge Function Endpoints

Use these Edge Functions for operations that require secure server-side logic (filtering catalog, starting checkout, querying usage).

### A. Get Packages Catalog (`/get-packages`)
- **Method**: `GET`
- **Path**: `/functions/v1/get-packages`
- **Auth**: Public (no token needed).
- **Query Params**:
  - `country_code` (optional, e.g. `US`, `FR` - case insensitive)
  - `category` (optional, filter by `'country' | 'regional' | 'global'`)
  - `search` (optional, filters by country name substring)
  - `limit` (optional, default `50`, max `200`)
  - `page` (optional, default `1`)
- **Success Response (`200 OK`)**:
  ```json
  {
    "data": [
      {
        "package_id": "uki-mobile-plus-in-15days-20gb",
        "name": "Uki Mobile Plus",
        "operator": "Uki Mobile",
        "country": "India",
        "category": "country",
        "prices": {
          "USD": 12.48,
          "EUR": 10.99,
          "GBP": 9.48
        },
        ...
      }
    ],
    "meta": {
      "total": 1,
      "page": 1,
      "limit": 50,
      "pages": 1
    }
  }
  ```

### B. Purchase Checkout (`/create-checkout`)
Generates a Stripe Checkout Session for a new eSIM purchase.
- **Method**: `POST`
- **Path**: `/functions/v1/create-checkout`
- **Auth**: **Required** (`Authorization: Bearer <USER_JWT>`)
- **Body**:
  ```json
  {
    "packageId": "uki-mobile-plus-in-15days-20gb",
    "country": "India",
    "countryCode": "IN",
    "dataAmount": "20 GB",
    "validityDays": "15",
    "priceUSD": "12.48",
    "operator": "Uki Mobile",
    "planName": "Uki Mobile Plus",
    "imageUrl": "https://..."
  }
  ```
- **Success Response (`200 OK`)**:
  ```json
  {
    "url": "https://checkout.stripe.com/c/pay/cs_test_..."
  }
  ```
  *Action*: Redirect `window.location.href` to this URL.

### C. Top-up Checkout (`/create-topup-checkout`)
Generates a Stripe Checkout Session for adding data to an existing eSIM.
- **Method**: `POST`
- **Path**: `/functions/v1/create-topup-checkout`
- **Auth**: **Required** (`Authorization: Bearer <USER_JWT>`)
- **Body**:
  ```json
  {
    "packageId": "uki-mobile-plus-in-15days-20gb",
    "iccid": "8904903200001234567"
  }
  ```
- **Success Response (`200 OK`)**:
  ```json
  {
    "url": "https://checkout.stripe.com/c/pay/cs_test_..."
  }
  ```
  *Action*: Redirect `window.location.href` to this URL.

### D. Get Real-time Usage (`/get-esim-usage`)
Fetches usage information directly from the carrier network.
- **Method**: `GET`
- **Path**: `/functions/v1/get-esim-usage`
- **Auth**: **Required** (`Authorization: Bearer <USER_JWT>`)
- **Query Params**:
  - `iccid` (required, e.g. `?iccid=8904903200001234567`)
- **Success Response (`200 OK`)**:
  ```json
  {
    "iccid": "8904903200001234567",
    "data": {
      "total": 21474836480,   // total bytes
      "remaining": 15461882880, // remaining bytes
      "usage": 6012953600      // consumed bytes
    },
    "voice": null,
    "text": null,
    "expires_at": "2026-07-10T12:00:00Z"
  }
  ```

---

## 4. Client Integration Workflows

### A. Rendering the Catalog (Multi-currency support)
To render package cards in a chosen local currency (e.g. `EUR`, `CAD`, `GBP`):
1. Fetch packages using `/get-packages?category=...` or query the `packages` table.
2. Read the `prices` JSONB map of the selected package using the target currency code (fallback to `USD`).
```javascript
const userCurrency = 'EUR' // or 'USD', 'GBP', 'CAD', 'AUD', 'JPY', 'SGD'
const displayPrice = packageData.prices[userCurrency] || packageData.price_usd
```

### B. Complete Purchase Flow
1. User clicks "Buy" on a package card.
2. If unauthorized, redirect to `/login.html`.
3. If authorized, make a `POST` request to `/create-checkout` passing the package metadata.
4. On success, redirect the user to the returned Stripe Checkout URL.
5. On successful payment, Stripe redirects to `success.html?session_id={CHECKOUT_SESSION_ID}`.
6. The webhook will fulfill the eSIM in the background. The frontend should display a loading spinner and poll `supabase.from('orders').select('order_status').eq('stripe_session_id', sessionId)` until `completed` or `provisioning_failed`.

### C. eSIM Top-up Flow
1. On the user's dashboard, list their active eSIMs from `active_esims`.
2. Ensure the eSIM has `rechargeability = true`.
3. Provide a list of compatible top-up packages.
4. User selects a package and clicks "Top Up".
5. Call `/create-topup-checkout` with `packageId` and `iccid`.
6. Redirect to the Stripe Checkout session.

### D. Rendering eSIM Usage
1. Read the user's active eSIMs directly from `supabase.from('active_esims').select()`.
2. For each eSIM, display the `qrcode_url` or the `smdp_address` / `matching_id` for configuration.
3. On click, call `/get-esim-usage?iccid=<iccid>` to display a data progress bar (calculating percent remaining: `remaining / total * 100`).
