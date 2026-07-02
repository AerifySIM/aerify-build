# Airalo Partners API — Agent Coding Skill

## Overview

The Airalo Partners REST API lets you sell and manage eSIMs covering 200+ destinations worldwide.
It is a JSON REST API (v2) authenticated via OAuth client credentials tokens.

**Base URL:** `https://partners-api.airalo.com`  
**All endpoints:** `/v2/...`  
**Auth:** `Authorization: Bearer <access_token>` on every request  
**Docs:** https://developers.partners.airalo.com

---

## API Modes

The API has a single base URL but supports two operating modes:

| Mode | Description |
|---|---|
| Sandbox | No real provisioning; uses real production packages for testing |
| Production | Live transactions; real eSIM provisioning and charges apply |

Switch between modes via a configuration toggle in the partner dashboard — same credentials and base URL for both.

---

## Standard Response Envelope

Every response wraps data in:

```json
{
  "data": { ... },
  "meta": { "message": "success" }
}
```

List endpoints also return a `"pricing"` field:

```json
{
  "pricing": { "model": "net_pricing", "discount_percentage": 0 },
  "data": [ ... ],
  "meta": { ... }
}
```

---

## Error Handling

All errors return a non-2xx status with a JSON body:

```json
{
  "data": { "field": "Error description" },
  "meta": { "message": "the parameter is invalid" }
}
```

| Status | Meaning |
|---|---|
| 401 | Unauthorized — token missing, expired, or invalid |
| 404 | Resource not found (invalid ICCID, order ID, etc.) |
| 422 | Validation error — check `data` field for per-field messages |
| 429 | Rate limit exceeded — back off and retry |

---

## Rate Limits

| Endpoint | Limit |
|---|---|
| `POST /v2/token` | 3 requests per minute |
| `GET /v2/packages` | 80 requests per minute per unique token |
| `GET /v2/sims/{iccid}/usage` | 10 req/min per ICCID; 5 req/sec per company; 20-min response cache |
| `POST /v2/refund` | 1 request per 5 minutes per unique IP |
| All other endpoints | 80 requests per minute (standard) |

---

---

## ENDPOINT REFERENCE

---

### AUTHENTICATE

---

#### Request access token

```
POST
/v2/token
```

> 💡 **Rate limit:** Up to 3 requests per minute. Access token is valid for 24 hours.

Obtain an access token required for all subsequent API requests. Submit `client_id` and `client_secret` to receive a 24-hour token. Call this endpoint every 24 hours to avoid expiry. Cache the token and reuse it — do not request a new one on every API call.

**Important notes:**
- The response contains the access token, which must be cached and reused until it expires or is refreshed.
- Store the client ID and secret securely in encrypted format.
- All actions performed using these credentials are considered valid transactions; the partner is responsible for all associated costs.

**Header params:**

| Param | Type | Required | Example |
|---|---|---|---|
| `Accept` | string | required | `application/json` |
| `url` | string | optional | `https://partners-api.airalo.com` |

**Body params (application/x-www-form-urlencoded):**

| Param | Type | Required | Description |
|---|---|---|---|
| `client_id` | string | required | Unique identifier for your application. Keep secure; never expose publicly. |
| `client_secret` | string | required | Confidential key for your client ID. Keep secure; never expose publicly. |
| `grant_type` | string | required | Must be `client_credentials` (server-to-server auth). |

**Request:**

```bash
curl --location 'https://partners-api.airalo.com/v2/token' \
--header 'Accept: application/json' \
--header 'url: https://partners-api.airalo.com' \
--data-urlencode 'client_id=<replace with client id>' \
--data-urlencode 'client_secret=<replace with client secret>' \
--data-urlencode 'grant_type=client_credentials'
```

```javascript
const body = new URLSearchParams();
body.append('client_id', '<your_client_id>');
body.append('client_secret', '<your_client_secret>');
body.append('grant_type', 'client_credentials');

const res = await fetch('https://partners-api.airalo.com/v2/token', {
  method: 'POST',
  headers: { 'Accept': 'application/json' },
  body
});
const { data } = await res.json();
// data.access_token — cache this for 24 hours
```

**Response 200:**

```json
{
  "data": {
    "token_type": "Bearer",
    "expires_in": 31622400,
    "access_token": "<access_token>"
  },
  "meta": { "message": "success" }
}
```

**Response 422 / 401:** Validation or credential error — check `data` field.

---

### BROWSE PACKAGES

---

#### Get packages

```
GET
/v2/packages
```

> 💡 **Rate limit:** 80 requests per minute per unique authentication token.

Retrieve a list of local and global eSIM packages available through the Airalo Partners API. Local packages cover a single country; global packages span multiple countries. Use this to sync your product catalog.

**Features:**
- Supports standard data packages and Voice & Text packages.
- Filter by operator type or country code.
- Supports pagination.
- Set `limit` to a high value (e.g. 1,000) to fetch all packages in a single request.
- Use `include=topup` to fetch packages along with their associated top-up packages.
- Multi-currency pricing available; conversion rates updated daily at 00:00 UTC.

**Recommended implementation:** Run an hourly background sync — call `GET /v2/packages` once per hour, store results as a snapshot, upsert by `package_id`, and remove any packages missing from the latest snapshot.

**Unlimited packages with throttling policy:** Check `is_fair_usage_policy` (boolean). If true, `fair_usage_policy` describes the speed restriction (e.g. "Lower speed rate of 1 Mbps after 3 GB usage per day").

**Query params:**

| Param | Type | Description |
|---|---|---|
| `filter[type]` | string | Filter by `local` or `global` |
| `filter[country]` | string | Filter by country code (e.g. `TR`, `US`) |
| `limit` | integer | Number of results to return (default 50; set high to avoid pagination) |
| `page` | integer | Page number for pagination |
| `include` | string | Pass `topup` to include top-up packages |

**Header params:**

| Param | Type | Required |
|---|---|---|
| `Accept` | string | required: `application/json` |
| `Authorization` | string | required: `Bearer {{token}}` |
| `url` | string | optional |

**Request:**

```bash
curl --location --globoff \
'https://partners-api.airalo.com/v2/packages?filter[type]=global&filter[country]=TR&limit=&page=1&include=topup' \
--header 'Accept: application/json' \
--header 'Authorization: Bearer {{token}}' \
--header 'url: https://partners-api.airalo.com'
```

```javascript
const res = await fetch('https://partners-api.airalo.com/v2/packages?limit=1000', {
  headers: {
    'Accept': 'application/json',
    'Authorization': `Bearer ${token}`
  }
});
const { data: packages } = await res.json();
// packages = array of country/operator/package objects
```

**Response 200 (abbreviated):**

```json
{
  "pricing": { "model": "net_pricing", "discount_percentage": 0 },
  "data": [
    {
      "slug": "united-states",
      "country_code": "US",
      "title": "United States",
      "operators": [
        {
          "id": 1181,
          "type": "local",
          "title": "Change",
          "plan_type": "data",
          "activation_policy": "first-usage",
          "rechargeability": true,
          "install_window_days": 365,
          "topup_grace_window_days": 180,
          "is_fair_usage_policy": false,
          "fair_usage_policy": null,
          "packages": [
            {
              "id": "change-in-3days-unlimited",
              "type": "sim",
              "price": 11.5,
              "amount": 0,
              "day": 3,
              "is_unlimited": true,
              "title": "Unlimited - 3 days"
            }
          ]
        }
      ]
    }
  ]
}
```

---

### PLACE ORDER

---

#### Submit order

```
POST
/v2/orders
```

Submit a synchronous order for an eSIM package. Provide `package_id` and `quantity` at minimum. The response includes all eSIM provisioning details immediately.

Optionally provide `to_email` to send the end user a white-label eSIM cloud email with installation instructions.

Response includes `direct_apple_installation_url` for direct iOS 17.4+ installation.

**Header params:**

| Param | Type | Required |
|---|---|---|
| `Accept` | string | required: `application/json` |
| `Authorization` | string | required: `Bearer {{token}}` |
| `url` | string | optional |

**Body params (multipart/form-data):**

| Param | Type | Required | Description |
|---|---|---|---|
| `package_id` | string | required | ID of the eSIM package to order (from `GET /v2/packages`) |
| `quantity` | integer | required | Number of eSIMs to purchase |
| `type` | string | required | Must be `sim` |
| `description` | string | optional | Internal reference note or order description |
| `brand_settings_name` | string | optional | White-label brand name to associate with the eSIM |
| `to_email` | string | optional | User's email to send eSIM cloud sharing link |
| `sharing_option[]` | string | optional | Sharing method, e.g. `link` |
| `copy_address[]` | string | optional | Additional email to CC on the eSIM share email |

**Request:**

```bash
curl --location 'https://partners-api.airalo.com/v2/orders' \
--header 'Accept: application/json' \
--header 'Authorization: Bearer {{token}}' \
--header 'url: https://partners-api.airalo.com' \
--form 'quantity="1"' \
--form 'package_id="kallur-digital-7days-1gb"' \
--form 'type="sim"' \
--form 'description="1 sim kallur-digital-7days-1gb"' \
--form 'brand_settings_name="our perfect brand"' \
--form 'to_email="valid_email@address.com"' \
--form 'sharing_option[]="link"' \
--form 'copy_address[]="valid_email@address.com"'
```

```javascript
const form = new FormData();
form.append('package_id', 'kallur-digital-7days-1gb');
form.append('quantity', '1');
form.append('type', 'sim');
form.append('description', 'My order description');

const res = await fetch('https://partners-api.airalo.com/v2/orders', {
  method: 'POST',
  headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
  body: form
});
const { data: order } = await res.json();
// order.sims[0].iccid — eSIM ICCID for provisioning
// order.sims[0].qrcode — LPA string for QR code display
// order.sims[0].direct_apple_installation_url — iOS 17.4+ direct install
```

**Response 200:**

```json
{
  "data": {
    "package_id": "kallur-digital-7days-1gb",
    "quantity": "1",
    "type": "sim",
    "id": 9666,
    "code": "20230227-009666",
    "currency": "USD",
    "price": 9.5,
    "pricing_model": "net_pricing",
    "validity": 7,
    "data": "1 GB",
    "created_at": "2023-02-27 14:09:55",
    "sims": [
      {
        "id": 11047,
        "iccid": "891000000000009125",
        "lpa": "lpa.airalo.com",
        "matching_id": "TEST",
        "qrcode": "LPA:1$lpa.airalo.com$TEST",
        "qrcode_url": "https://sandbox.airalo.com/qr?...",
        "direct_apple_installation_url": "https://esimsetup.apple.com/esim_qrcode_provisioning?carddata=LPA:1$...",
        "apn_type": "automatic",
        "apn_value": null,
        "is_roaming": true,
        "confirmation_code": null
      }
    ]
  },
  "meta": { "message": "success" }
}
```

**Error responses:** 422 for missing/invalid fields, insufficient quantity, or brand not found.

---

#### Submit order async

```
POST
/v2/orders-async
```

Submit an asynchronous order. Returns immediately with a `request_id`. The actual order is processed in the background; Airalo pushes a webhook to your `webhook_url` (or the URL registered during opt-in) when complete.

Store the `request_id` — it is the reference for mapping incoming webhook payloads to your pending orders.

Supports `direct_apple_installation_url` in the webhook payload for iOS 17.4+.

**Body params (multipart/form-data):**

| Param | Type | Required | Description |
|---|---|---|---|
| `package_id` | string | required | ID of the eSIM package |
| `quantity` | integer | required | Number of eSIMs |
| `type` | string | required | Must be `sim` |
| `description` | string | optional | Internal reference |
| `webhook_url` | string | optional | Override URL for this specific order's webhook |
| `brand_settings_name` | string | optional | White-label brand name |
| `to_email` | string | optional | User's email for eSIM sharing link |
| `sharing_option[]` | string | optional | e.g. `link` |
| `copy_address[]` | string | optional | CC email address |

**Request:**

```bash
curl --location 'https://partners-api.airalo.com/v2/orders-async' \
--header 'Accept: application/json' \
--header 'Authorization: Bearer {{token}}' \
--header 'url: https://partners-api.airalo.com' \
--form 'quantity="1"' \
--form 'package_id="kallur-digital-7days-1gb"' \
--form 'type="sim"' \
--form 'description="1 sim kallur-digital-7days-1gb"' \
--form 'webhook_url="https://your-webhook.com"'
```

**Response 202:**

```json
{
  "data": {
    "request_id": "3NhR3gKmqCWK7IWppurpDX3Cg",
    "accepted_at": "2024-07-11 15:26:02"
  },
  "meta": { "message": "success" }
}
```

**Error responses:** 422 for validation errors, insufficient quantity, or no webhook URL provided and not opted in.

---

#### Future orders (place order)

```
POST
/v2/future-orders
```

Schedule an eSIM order for future activation. The order is not provisioned immediately; it activates at the specified future date. Useful for pre-purchasing eSIMs for upcoming trips.

**Note:** Future orders can be cancelled via `POST /v2/future-orders/{id}/cancel` before activation.

---

#### eSIM voucher

```
POST
/v2/vouchers
```

Order an eSIM in voucher format. Instead of provisioning an eSIM profile directly, generates a voucher code that the end user can redeem themselves. Useful for retail/gift-card workflows.

---

### REQUEST REFUND

---

#### Request refund

```
POST
/v2/refund
```

> 💡 **Rate limit:** 1 request per 5 minutes per unique IP address.

Submit a refund request for one or more eSIMs. Available to all API partners by default — no activation required. However, **approval is not automatic** — every request is manually reviewed by Airalo's Customer Support team against the refund policy. If approved, the refund is credited to your account as Airalo credits.

**Header params:**

| Param | Type | Required |
|---|---|---|
| `Accept` | string | required: `application/json` |
| `Authorization` | string | required: `Bearer {{token}}` |
| `url` | string | optional |

**Body params (multipart/form-data):**

| Param | Type | Required | Description |
|---|---|---|---|
| `iccids` | JSON string | required | JSON array of ICCIDs to refund, e.g. `["894000000000001", "894000000000002"]` |
| `reason` | string | required | Refund reason, e.g. `INSTALLATION_FAILURE` |
| `notes` | string | optional | Additional notes for the support team |
| `email` | string | optional | Contact email for follow-up |

**Request:**

```bash
curl --location 'https://partners-api.airalo.com/v2/refund' \
--header 'Accept: application/json' \
--header 'Authorization: Bearer {{token}}' \
--header 'url: https://partners-api.airalo.com' \
--form 'iccids="[\"894000000000001\", \"894000000000002\"]"' \
--form 'reason="INSTALLATION_FAILURE"' \
--form 'notes=""' \
--form 'email="email@example.com"'
```

**Response 202:**

```json
{
  "data": {
    "refund_id": "12345",
    "created_at": "2024-10-12 09:30"
  },
  "meta": { "message": "success" }
}
```

**Error responses:** 422 for invalid ICCIDs, missing fields, or invalid reason. 429 for rate limit exceeded.

---

### INSTALL ESIM

---

#### Get eSIM

```
GET
/v2/sims/{sim_iccid}
```

Retrieve the full details of a specific eSIM by its ICCID. Only eSIMs ordered via the API are retrievable. Supports optional `include` query params to attach related data.

Includes `direct_apple_installation_url` for iOS 17.4+ direct installation.

**Path params:**

| Param | Type | Required | Description |
|---|---|---|---|
| `sim_iccid` | string | required | The ICCID of the eSIM |

**Query params:**

| Param | Type | Description |
|---|---|---|
| `include` | string | Comma-separated: `order`, `order.status`, `order.user`, `share` |

**Request:**

```bash
curl --location 'https://partners-api.airalo.com/v2/sims/{iccid}?include=order,order.status,order.user,share' \
--header 'Accept: application/json' \
--header 'Authorization: Bearer {{token}}' \
--header 'url: https://partners-api.airalo.com'
```

**Response 200:**

```json
{
  "data": {
    "id": 11028,
    "iccid": "8944465400000267221",
    "lpa": "lpa.airalo.com",
    "matching_id": "TEST",
    "qrcode": "LPA:1$lpa.airalo.com$TEST",
    "qrcode_url": "https://sandbox.airalo.com/qr?...",
    "direct_apple_installation_url": "https://esimsetup.apple.com/esim_qrcode_provisioning?carddata=...",
    "apn_type": "automatic",
    "apn_value": null,
    "is_roaming": true,
    "confirmation_code": "5751",
    "brand_settings_name": "our perfect brand",
    "recycled": true,
    "recycled_at": "2025-05-05 10:52:39",
    "simable": {
      "id": 9647,
      "code": "20230227-009647",
      "package_id": "kallur-digital-7days-1gb",
      "package": "Kallur Digital-1 GB - 7 Days",
      "validity": "7",
      "price": "9.50",
      "data": "1 GB",
      "currency": "USD",
      "status": { "name": "Completed", "slug": "completed" },
      "sharing": {
        "link": "https://esims.cloud/our-perfect-brand/a4g5ht-58sdf1a",
        "access_code": "4812"
      }
    }
  },
  "meta": { "message": "success" }
}
```

---

#### Get installation instructions

```
GET
/v2/sims/{sim_iccid}/instructions
```

Retrieve language-specific installation instructions for a specific eSIM. Pass `Accept-Language` header with a language code (e.g. `en`, `fr`, `de`) for a translated response.

Returns step-by-step instructions for both iOS and Android (QR code and manual methods), plus network setup steps.

Includes `direct_apple_installation_url` for iOS 17.4+ direct installation.

**Path params:**

| Param | Type | Required |
|---|---|---|
| `sim_iccid` | string | required |

**Header params:**

| Param | Type | Required | Description |
|---|---|---|---|
| `Accept` | string | required | `application/json` |
| `Authorization` | string | required | `Bearer {{token}}` |
| `Accept-Language` | string | optional | Language code, e.g. `en` |
| `url` | string | optional | |

**Request:**

```bash
curl --location 'https://partners-api.airalo.com/v2/sims/{iccid}/instructions' \
--header 'Accept: application/json' \
--header 'Authorization: Bearer {{token}}' \
--header 'Accept-Language: en' \
--header 'url: https://partners-api.airalo.com'
```

**Response 200:**

```json
{
  "data": {
    "instructions": {
      "language": "EN",
      "ios": [
        {
          "model": null,
          "version": "14,15,13",
          "installation_via_qr_code": {
            "steps": {
              "1": "Go to Settings > Cellular/Mobile > Add Cellular/Mobile Plan.",
              "2": "Scan the QR Code.",
              "3": "Tap on 'Add Cellular Plan'."
            },
            "qr_code_data": "LPA:1$lpa.airalo.com$TEST",
            "qr_code_url": "https://sandbox.airalo.com/qr?...",
            "direct_apple_installation_url": "https://esimsetup.apple.com/..."
          },
          "installation_manual": {
            "steps": { "1": "Go to Settings > ...", "2": "Tap 'Enter Details Manually'." },
            "smdp_address_and_activation_code": "lpa.airalo.com"
          },
          "network_setup": {
            "steps": { "1": "Select your eSIM under 'Cellular Plans'.", "2": "..." },
            "apn_type": "manual",
            "apn_value": "singleall",
            "is_roaming": true
          }
        }
      ],
      "android": [ { ... } ]
    }
  },
  "meta": { "message": "success" }
}
```

---

### MONITOR USAGE

---

#### Get usage (data, text & voice)

```
GET
/v2/sims/{sim_iccid}/usage
```

> 💡 **Rate limit:** 10 requests per minute per unique ICCID; 5 requests per second per company. Response cache: 20 minutes.

Retrieve total data, voice, and text usage for a specific eSIM. All data values are in **megabytes**; voice in **minutes**; text in **message count**.

**Response field units:**
- `total` — total MB in the package
- `remaining` — remaining MB left
- `total_text` — initial total SMS messages
- `remaining_text` — SMS messages remaining
- `total_voice` — initial total voice minutes
- `remaining_voice` — voice minutes remaining

**eSIM status values:** `NOT_ACTIVE`, `ACTIVE`, `FINISHED`, `UNKNOWN`, `EXPIRED`

**Path params:**

| Param | Type | Required |
|---|---|---|
| `sim_iccid` | string | required |

**Request:**

```bash
curl --location --request GET 'https://partners-api.airalo.com/v2/sims/{iccid}/usage' \
--header 'Accept: application/json' \
--header 'Authorization: Bearer {{token}}' \
--header 'url: https://partners-api.airalo.com'
```

**Response 200:**

```json
{
  "data": {
    "remaining": 767,
    "total": 2048,
    "expired_at": "2022-01-01 00:00:00",
    "is_unlimited": true,
    "status": "ACTIVE",
    "remaining_voice": 0,
    "remaining_text": 0,
    "total_voice": 0,
    "total_text": 0
  },
  "meta": { "message": "api.success" }
}
```

**Error responses:** 404 for invalid ICCID. 429 for rate limit exceeded.

---

### TOP UP ESIM

---

#### Get top-up package list

```
GET
/v2/sims/{iccid}/topups
```

Retrieve the available top-up packages for a specific eSIM. Returns only top-up packages compatible with the eSIM's operator and configuration. Also supports Voice & Text top-up packages.

**Note for unlimited packages:** `remaining`, `total`, and `amount` fields default to `0` for unlimited packages — do not display these values to end users.

**Path params:**

| Param | Type | Required |
|---|---|---|
| `iccid` | string | required |

**Request:**

```bash
curl --location 'https://partners-api.airalo.com/v2/sims/8910300000005271146/topups' \
--header 'Accept: application/json' \
--header 'Authorization: Bearer {{token}}' \
--header 'url: https://partners-api.airalo.com'
```

**Response 200:**

```json
{
  "pricing": { "model": "net_pricing", "discount_percentage": 0 },
  "data": [
    {
      "id": "bonbon-mobile-30days-3gb-topup",
      "type": "topup",
      "price": 10,
      "amount": 3072,
      "day": 30,
      "is_unlimited": false,
      "title": "3 GB - 100 SMS - 100 Mins - 30 Days",
      "data": "3 GB",
      "voice": 100,
      "text": 100,
      "net_price": 8
    }
  ]
}
```

**Error responses:** 404 for invalid ICCID. 422 for recycled eSIM.

---

#### Submit top-up order

```
POST
/v2/orders/topups
```

Purchase a top-up package for a specific eSIM. Provide `package_id` (from `GET /v2/sims/{iccid}/topups`) and `iccid`.

**Complete top-up workflow:**
1. `GET /v2/sims` — list previously purchased eSIMs
2. `GET /v2/sims/{iccid}/topups` — list available top-ups for the eSIM
3. `POST /v2/orders/topups` — purchase the top-up
4. `GET /v2/sims/{iccid}/history` — verify the top-up was applied

**Body params (multipart/form-data):**

| Param | Type | Required | Description |
|---|---|---|---|
| `package_id` | string | required | ID of the top-up package |
| `iccid` | string | required | ICCID of the eSIM to top up |
| `description` | string | optional | Internal order reference note |

**Request:**

```bash
curl --location 'https://partners-api.airalo.com/v2/orders/topups' \
--header 'Accept: application/json' \
--header 'Authorization: Bearer {{token}}' \
--header 'url: https://partners-api.airalo.com' \
--form 'package_id="change-7days-1gb-topup"' \
--form 'iccid="873000000000042542"' \
--form 'description="Example description"'
```

**Response 200:**

```json
{
  "data": {
    "id": 111,
    "code": "20251118-000111",
    "package_id": "change-7days-1gb-topup",
    "currency": "USD",
    "quantity": 1,
    "type": "topup",
    "validity": 7,
    "data": "1 GB",
    "price": 4.5,
    "net_price": 3.6,
    "pricing_model": "net_pricing",
    "created_at": "2025-11-18 13:37:07"
  },
  "meta": { "message": "success" }
}
```

**Error responses:** 422 for purchase limit exceeded, missing fields, invalid package ID, or recycled eSIM.

---

### MANAGE ORDERS

---

#### Get order list

```
GET
/v2/orders
```

Retrieve a paginated list of your orders, filterable by date range, order code, status, ICCID, or description.

**Query params:**

| Param | Type | Description |
|---|---|---|
| `include` | string | Comma-separated: `sims`, `user`, `status` |
| `filter[created_at]` | string | Date range: `Y-m-d - Y-m-d` |
| `filter[code]` | string | Filter by order code, e.g. `20221021-003188` |
| `filter[order_status]` | string | Filter by status, e.g. `completed` |
| `filter[iccid]` | string | Filter by specific eSIM ICCID |
| `filter[description]` | string | Filter by order description |
| `limit` | integer | Number of results per page (default 50) |
| `page` | integer | Page number |

**Request:**

```bash
curl --location --globoff \
'https://partners-api.airalo.com/v2/orders?include=sims,user,status&filter[order_status]=completed&limit=50&page=1' \
--header 'Accept: application/json' \
--header 'Authorization: Bearer {{token}}' \
--header 'url: https://partners-api.airalo.com'
```

**Response 200:** Returns list of order objects. **Response 422:** Validation error on params.

---

#### Get order

```
GET
/v2/orders/{order_id}
```

Retrieve details of a specific order by its ID. Include related data with the `include` query param.

**Path params:**

| Param | Type | Required |
|---|---|---|
| `order_id` | string/integer | required |

**Query params:**

| Param | Type | Description |
|---|---|---|
| `include` | string | Comma-separated: `sims`, `user`, `status` |

**Request:**

```bash
curl --location --request GET \
'https://partners-api.airalo.com/v2/orders/{order_id}?include=sims,user,status' \
--header 'Accept: application/json' \
--header 'Authorization: Bearer {{token}}' \
--header 'url: https://partners-api.airalo.com'
```

**Response 200:** Full order object. **Response 401:** Unauthorized.

---

#### Cancel future orders

```
POST
/v2/future-orders/{id}/cancel
```

Cancel a future (pre-scheduled) order before it is activated. Only applicable to orders placed via the Future Orders endpoint.

---

#### Get future orders list

```
GET
/v2/future-orders
```

Retrieve a list of your scheduled future orders.

---

### MANAGE ESIMS

---

#### Get eSIMs list

```
GET
/v2/sims
```

> 💡 **GDPR note:** Airalo does not store end-user PII. Store and map customer data to ICCIDs within your own system.

Retrieve a paginated list of all eSIMs ordered via your account. Filterable by date and ICCID.

**Query params:**

| Param | Type | Description |
|---|---|---|
| `include` | string | Comma-separated: `order`, `order.status`, `order.user`, `share` |
| `filter[created_at]` | string | Date range: `Y-m-d - Y-m-d` |
| `filter[iccid]` | string | Filter by ICCID |
| `limit` | integer | Results per page (default 100) |
| `page` | integer | Page number |

**Request:**

```bash
curl --location --globoff \
'https://partners-api.airalo.com/v2/sims?include=order,order.status,order.user,share&limit=100&page=1' \
--header 'Accept: application/json' \
--header 'Authorization: Bearer {{token}}' \
--header 'url: https://partners-api.airalo.com'
```

**Response 200:** List of eSIM objects. **Response 422:** Validation error on params.

---

#### Update eSIM brand

```
PUT
/v2/sims/{sim_iccid}/brand
```

Associate a white-label brand with a specific eSIM. Used to customize the eSIM cloud sharing link with your brand identity.

**Path params:**

| Param | Type | Required |
|---|---|---|
| `sim_iccid` | string | required |

**Body params:**

| Param | Type | Required | Description |
|---|---|---|---|
| `brand_settings_name` | string | required | Name of the brand to apply to this eSIM |

---

#### Get eSIM package history

```
GET
/v2/sims/{iccid}/history
```

Retrieve the full list of packages (initial + all top-ups) purchased for a specific eSIM, in chronological order.

**Path params:**

| Param | Type | Required |
|---|---|---|
| `iccid` | string | required |

**Request:**

```bash
curl --location 'https://partners-api.airalo.com/v2/sims/{iccid}/history' \
--header 'Accept: application/json' \
--header 'Authorization: Bearer {{token}}' \
--header 'url: https://partners-api.airalo.com'
```

---

### COMPATIBLE DEVICES

---

#### Get compatible device lite list

```
GET
/v2/compatible-devices/lite
```

Retrieve a lightweight list of eSIM-compatible devices. Returns make/model data suitable for a device compatibility check UI.

> Note: The original `GET /v2/compatible-devices` endpoint is deprecated. Use this lite version instead.

---

### NOTIFICATIONS (WEBHOOKS)

---

#### Opt in to async order notifications

```
POST
/v2/notifications/async-orders/opt-in
```

Register a webhook URL to receive push notifications when async orders are fulfilled. Required before using `POST /v2/orders-async` without specifying a per-request `webhook_url`.

**Body params:**

| Param | Type | Required | Description |
|---|---|---|---|
| `url` | string | required | Your HTTPS webhook endpoint URL |

---

#### Get async order notification details

```
GET
/v2/notifications/async-orders
```

Retrieve the current async orders notification configuration (opted-in URL, status, etc.).

---

#### Opt out of async order notifications

```
POST
/v2/notifications/async-orders/opt-out
```

Unregister the webhook for async order notifications.

---

#### Opt in to low data notifications

```
POST
/v2/notifications/low-data/opt-in
```

Register a webhook URL to receive push notifications when an eSIM's data falls below a threshold.

**Body params:**

| Param | Type | Required | Description |
|---|---|---|---|
| `url` | string | required | Your HTTPS webhook endpoint URL |

---

#### Get low data notification details

```
GET
/v2/notifications/low-data
```

Retrieve current low-data notification configuration.

---

#### Opt out of low data notifications

```
POST
/v2/notifications/low-data/opt-out
```

Unregister the low-data webhook.

---

#### Opt in to credit limit notifications

```
POST
/v2/notifications/credit-limit/opt-in
```

Register a webhook URL to receive push notifications when your account balance drops below a threshold.

**Body params:**

| Param | Type | Required | Description |
|---|---|---|---|
| `url` | string | required | Your HTTPS webhook endpoint URL |

---

#### Get credit limit notification details

```
GET
/v2/notifications/credit-limit
```

Retrieve current credit limit notification configuration.

---

#### Opt out of credit limit notifications

```
POST
/v2/notifications/credit-limit/opt-out
```

Unregister the credit limit webhook.

---

#### Webhook simulator

```
POST
/v2/notifications/simulator
```

Send a test webhook payload to your registered URL. Use this to verify your webhook endpoint handles incoming events correctly without placing a real order.

---

### CHECK BALANCE

---

#### Get balance

```
GET
/v2/balance
```

Retrieve your current account balance. Monitor your Airalo credit to ensure you have sufficient funds to avoid order failures due to insufficient balance. Returns an empty array if there is no account configured.

**Header params:**

| Param | Type | Required |
|---|---|---|
| `Authorization` | string | required: `Bearer {{token}}` |
| `url` | string | optional |

**Request:**

```bash
curl --location 'https://partners-api.airalo.com/v2/balance' \
--header 'Authorization: Bearer {{token}}' \
--header 'url: https://partners-api.airalo.com'
```

**Response 200:**

```json
{
  "data": {
    "balances": {
      "name": "balance",
      "availableBalance": {
        "amount": 0,
        "currency": "USD"
      }
    }
  },
  "meta": { "message": "success" }
}
```

---

## Implementation Patterns

### Token caching (recommended)

```javascript
let cachedToken = null;
let tokenExpiry = null;

async function getToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;

  const body = new URLSearchParams({
    client_id: process.env.AIRALO_CLIENT_ID,
    client_secret: process.env.AIRALO_CLIENT_SECRET,
    grant_type: 'client_credentials'
  });

  const res = await fetch('https://partners-api.airalo.com/v2/token', {
    method: 'POST',
    body
  });
  const { data } = await res.json();

  cachedToken = data.access_token;
  tokenExpiry = Date.now() + (23 * 60 * 60 * 1000); // refresh 1hr before expiry
  return cachedToken;
}
```

### Retry with backoff for rate limits

```javascript
async function apiCall(url, options, retries = 3) {
  for (let i = 0; i < retries; i++) {
    const res = await fetch(url, options);
    if (res.status === 429) {
      await new Promise(r => setTimeout(r, Math.pow(2, i) * 1000));
      continue;
    }
    return res;
  }
  throw new Error('Rate limit exceeded after retries');
}
```

### Complete purchase flow

```javascript
// 1. Authenticate
const token = await getToken();

// 2. Find packages for a country
const pkgRes = await fetch(
  'https://partners-api.airalo.com/v2/packages?filter[country]=FR&limit=50',
  { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } }
);
const { data: packages } = await pkgRes.json();

// 3. Place order
const form = new FormData();
form.append('package_id', packages[0].operators[0].packages[0].id);
form.append('quantity', '1');
form.append('type', 'sim');

const orderRes = await fetch('https://partners-api.airalo.com/v2/orders', {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  body: form
});
const { data: order } = await orderRes.json();
const iccid = order.sims[0].iccid;

// 4. Get installation instructions
const instrRes = await fetch(
  `https://partners-api.airalo.com/v2/sims/${iccid}/instructions`,
  { headers: { Authorization: `Bearer ${token}`, 'Accept-Language': 'en' } }
);
const { data: instructions } = await instrRes.json();
```

---

## Key Gotchas

- **Token expiry:** Tokens expire after ~24 hours. Always check expiry before use; refresh proactively.
- **Rate limits are per-token:** Each unique token has its own quota bucket.
- **Async orders:** `POST /v2/orders-async` returns `202` immediately. The webhook fires when the order is fulfilled. Always store `request_id` to match webhooks.
- **Non-idempotent POST:** `POST /v2/orders` creates a new order on every call. Don't retry blindly on timeout — use async orders or idempotency logic.
- **GDPR:** Airalo stores no user PII. Store and manage the mapping between customer IDs and ICCIDs yourself.
- **Unlimited packages:** `amount`, `remaining`, and `total` are `0` for unlimited packages — don't display them.
- **Recycled eSIMs:** Recycled eSIMs return 422 on top-up and some other operations.
- **Package sync:** Sync hourly via `GET /v2/packages` — don't query per-user at purchase time; instead query your local snapshot.

---

## Resources

- Docs: https://developers.partners.airalo.com
- Quick start: https://developers.partners.airalo.com/quick-start-2508979f0
- Error handling: https://developers.partners.airalo.com/error-handling-780831m0
- Sandbox mode: https://developers.partners.airalo.com/sandbox-mode-2114305m0
- Rate limits: https://developers.partners.airalo.com/rate-limits-752590m0
- Webhooks guide: https://developers.partners.airalo.com/webhooks-guide-930005m0
- Attribute descriptions: https://developers.partners.airalo.com/attribute-descriptions-752392m0
- FAQ: https://developers.partners.airalo.com/faq-752238m0
- Support: partner.support@airalo.com
