# Aerify Backend Architecture & Implementation Plan
# IMPORTANT DO NOT TAKE ANY CODE IN THE /old_code DIRECTORY UNLESS EXPLICITLY SAID SO

## 0. Legacy Code Context & Frontend Migration
Old Frontend (GitHub Pages): A strictly static Single Page Application (SPA) hosted on GitHub Pages. It relies entirely on client-side JavaScript to fetch data, making dynamic SEO for individual country pages virtually impossible.

Old Backend (Cloudflare Worker + KV): A monolithic worker handling data storage via flat, stringified NoSQL JSON arrays. This architecture suffers from catastrophic race conditions during concurrent user updates (Read-Modify-Write failures), lacks database-level idempotency constraints for Stripe webhooks, and relies on fragile if/else code blocks for user security.

The Migration Target: We are tearing this down. The static GitHub Pages site is being rebuilt into a dynamic framework hosted on Cloudflare Pages for global edge rendering. The backend and state management are moving entirely to Supabase (PostgreSQL) to leverage ACID compliance, native UNIQUE constraints for webhooks, and Row Level Security (RLS).
## 1. System Architecture Overview
The Aerify backend relies on a decoupled, API-first architecture. The frontend (Cloudflare Pages) handles UI and routing, while **Supabase (PostgreSQL)** acts as the secure data and execution layer.

* **Database:** Supabase PostgreSQL (handles users, orders, and eSIM inventory).
* **Authentication:** Supabase Auth (manages user sessions and secures API access).
* **Execution (Serverless):** Supabase Edge Functions (handles Stripe webhooks, Airalo API calls).
* **Payment Gateway:** Stripe Checkout Sessions (handles global payments dynamically).
* **Telecom Provider:** Airalo Partner API (provisions eSIMs and fetches usage data).

---

## 2. Database Schema (PostgreSQL)
To maintain data integrity, eliminate race conditions, and support a future mobile app, the database is strictly typed with Row Level Security (RLS) enabled. 

* **`auth.users`:** Managed by Supabase Auth (UUID, Email).
* **`public.orders`:** Tracks financial intent. Includes `stripe_session_id` (UNIQUE for idempotency), Airalo package ID, amount paid, and an `order_status` ENUM (`pending_payment`, `paid`, `provisioning_failed`, `completed`).
* **`public.active_esims`:** Tracks live cellular profiles. Includes `iccid` (Primary Key), installation URLs, SM-DP+ address, matching ID, data limits, and expiry dates.

**Security Requirement:** RLS is enabled on all public tables. Users can only `SELECT`, `INSERT`, or `UPDATE` rows where `auth.uid() = user_id`.

---

## 3. Payment Processing (Strict Stripe Best Practices)
Following modern Stripe integration standards, Aerify completely avoids legacy APIs (like the Charges API or Tokens API) and relies on Checkout Sessions.

* **Dynamic Payment Methods:** The `payment_method_types` parameter is intentionally omitted in API calls. This allows Stripe to automatically display the highest-converting local payment methods (e.g., Alipay, Apple Pay) based on the user's location.
* **Idempotency & Webhooks:** Fulfillment is never handled via client-side redirects. A Supabase Edge Function (`stripe-webhook`) listens for `checkout.session.completed`. The `stripe_session_id` is logged as a `UNIQUE` constraint in the database to drop duplicate webhooks instantly.

---

## 4. Fulfillment & Airalo Integration
Fulfillment is handled entirely asynchronously by secure backend listeners to prevent users from paying without receiving their eSIM.

1.  **Listen & Verify:** `stripe-webhook` intercepts the event and verifies the Stripe signature.
2.  **Acknowledge:** Extracts `user_id` and `package_id` from Stripe metadata. Creates a row in `orders`.
3.  **Fulfill:** Calls the Airalo API `/v2/orders` endpoint using the local Postgres order ID as an Idempotency Key.
4.  **Finalize:** Upon Airalo success, inserts the `iccid` into `active_esims`, updates the `orders` status to `completed`, and returns a 200 OK to Stripe.

---

## 5. Strategic Exit Strategy (Decoupling)
To prevent absolute vendor lock-in to Supabase and ensure the platform can migrate to self-hosted PostgreSQL or enterprise Auth providers at scale:

1.  **Abstracted Client:** The frontend does not use the Supabase client directly in UI components. All database calls are wrapped in a Repository Pattern (e.g., `esimRepository.ts`).
2.  **RLS is Defense-in-Depth:** Core business logic (like initiating purchases) is routed through secure API endpoints/Edge Functions rather than relying purely on client-side RLS queries.
3.  **Agnostic User IDs:** The `user_id` columns in the database are treated as generic UUIDs, ensuring the data schema does not need to be rewritten if the platform migrates away from Supabase GoTrue authentication.