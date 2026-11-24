# Chowdeck Relay delivery: backend spec

**For:** the URA backend team (`ura-v2_backend`).
**Goal:** add Chowdeck Relay as a second courier next to Fez. Chowdeck handles same-city deliveries; Fez keeps interstate; pickup and seller delivery stay as they are.
**Why the backend:** Relay calls use URA's secret API key and spend from URA's Relay wallet. The key must never ship in the mobile app or the website. Both apps already price and track delivery only through the backend (`POST /delivery/cost`, `GET /delivery/track/:trackingNumber`), so they keep doing that.

Chowdeck docs: <https://chowdeck-api.readme.io/docs/getting-started-relay>. Section 8 lists the points where those docs contradict each other; confirm them with Chowdeck before building.

---

## 1. Which courier an order uses

The backend decides; the apps never choose a courier.

| Case | Courier |
|---|---|
| Buyer chose pickup | none (`fulfilment: 'pickup'`, unchanged) |
| Seller delivers it themselves | none (`fulfilment: 'seller_delivery'`, unchanged) |
| Seller's city and the buyer's city are the **same**, and the city is in `CHOWDECK_CITIES` | **Chowdeck** |
| Anything else (interstate, or a city Chowdeck doesn't serve) | **Fez** (unchanged) |
| Chowdeck quote fails (outside its zone, Chowdeck down) | fall back to **Fez** |

Chowdeck's coverage, from their email: Lagos, Abuja, Port Harcourt, Ibadan, Edo, Delta, Ilorin, Abeokuta, Kaduna, Enugu, Owerri, Kano, Jos, Benue. No interstate. Keep the list in config (`CHOWDECK_CITIES`), not in code. Match on the business `address.city` / `address.state` and the order's `shippingAddress.city` / `state`, normalised (case, "FCT" = "Abuja", etc.).

## 2. Configuration

New environment variables:

| Variable | Purpose |
|---|---|
| `CHOWDECK_API_KEY` | Secret key from the Chowdeck dashboard (Settings → Developer). Server only. |
| `CHOWDECK_BASE_URL` | Relay host (see section 8, question 1). |
| `CHOWDECK_WEBHOOK_SECRET` | For verifying `x-chowdeck-signature`. |
| `CHOWDECK_CITIES` | Comma-separated serviceable cities. |

Add `isChowdeckConfigured()` like `isFezConfigured()`. When it's off, everything behaves exactly as today (Fez only).

All Chowdeck calls send `Authorization: Bearer ${CHOWDECK_API_KEY}`.

**Money units:** Chowdeck amounts are in **kobo** (`80000` = ₦800). URA order amounts are in naira. Convert at the edge of the Chowdeck service, in one place.

**Funding:** Chowdeck deliveries are paid from URA's **Relay wallet**, the same way URA pays Fez from its own account today. Someone must keep it funded; a low balance should alert an admin.

## 3. New service: `src/services/chowdeck.service.ts`

Mirror `fez.service.ts`:

```ts
getChowdeckQuote(opts: {
  pickup: { address: string; lat?: number; lng?: number };
  dropoff: { address: string; lat?: number; lng?: number };
  orderValueNaira?: number;            // → estimated_order_amount (kobo); adds Chowdeck's safety cover
}): Promise<{ feeId: number; totalNaira: number }>;
// POST /relay/delivery/fee
//   source_address {latitude, longitude} OR source_address_string
//   destination_address {latitude, longitude} OR destination_address_string
// → data.id (fee id), data.total_amount (kobo)

createChowdeckDelivery(opts: {
  feeId: number;
  reference: string;                   // order.orderNumber (unique; Chowdeck rejects duplicates)
  itemType: string;                    // e.g. product category
  orderValueNaira?: number;
  sender: { name: string; phone: string; email?: string };     // the shop
  recipient: { name: string; phone: string; email?: string };  // the buyer
  note?: string;
  deliveryPin?: number;                // 1000–9999, see 4.3
}): Promise<{ id: number; reference: string; trackingUrl?: string; status: string; priceNaira: number }>;
// POST /relay/delivery  { fee_id, reference, item_type, user_action: "sending",
//   source_contact {name, phone, country_code:"NG", email?},
//   destination_contact {name, phone, country_code:"NG", email?},
//   estimated_order_amount?, customer_delivery_note?, delivery_pin?, notification_channels: ["sms"] }

getChowdeckDelivery(reference: string)  // GET  /relay/delivery/{reference}
cancelChowdeckDelivery(reference: string, reason: string)  // POST /relay/delivery/{reference}/cancel  { reason }
```

Phones: Chowdeck wants 11-digit local numbers (`08100000000`). Convert `+234…` before sending.

## 4. Changes to existing flows

### 4.1 Quote at checkout: `order.service.ts`, the "Price delivery on the server" block

Today it calls `getDeliveryCost({ state, pickUpState })` (Fez). Change to:

1. Pick the courier with the rule in section 1.
2. **Chowdeck:** call `getChowdeckQuote` with
   - pickup: the business's `address.fullAddress` (+ city, state) and `location.coordinates` (`[lng, lat]`) when set;
   - dropoff: the order's `shippingAddress.fullAddress`, `city`, `state`, plus `latitude`/`longitude` if the app sent them (4.4).
   Set `deliveryFee` / `deliveryFeeCharged` from `totalNaira`. Store `deliveryProvider: 'chowdeck'` and `chowdeckCost` (instead of `fezCost`).
3. On Chowdeck failure, fall back to the Fez quote, as today.

Keep the rule that the server prices delivery and never trusts a fee from the client.

### 4.2 `POST /delivery/cost` (used by both apps at checkout)

Same courier choice as 4.1, so the price the buyer sees matches what they're charged.

**Request** (backwards compatible; `state` alone still works and quotes Fez):

```json
{
  "state": "Lagos",
  "city": "Ikeja",
  "fullAddress": "12 Adeola Odeku St, Victoria Island",
  "latitude": 6.43,
  "longitude": 3.42,
  "businessId": "…",
  "productId": "…"
}
```

**Response:** keep `data.totalCost` (the apps read it today) and add:

```json
{
  "success": true,
  "data": {
    "totalCost": 2100,
    "provider": "chowdeck",
    "providerName": "Chowdeck",
    "eta": "Same day"
  }
}
```

`provider` is `"chowdeck"` or `"fez"`. `eta` is optional free text for the checkout screen.

### 4.3 Booking the rider: `markOrderReady` in `order.service.ts`

Today: when the seller marks a delivery order ready, it books Fez and sets `fulfilment = 'fez'`.

For orders with `deliveryProvider === 'chowdeck'`:

1. **Re-quote** with `getChowdeckQuote`. Fee quotes expire ("This delivery fee has expired"), and checkout may have been hours earlier. Use the fresh `feeId` straight away.
2. Call `createChowdeckDelivery`:
   - `reference`: `order.orderNumber`. Makes retries safe: Chowdeck rejects a duplicate reference.
   - `sender`: the business name and phone (`contact.phone`).
   - `recipient`: buyer's name and `shippingAddress.phone`.
   - `orderValueNaira`: items subtotal.
   - `note`: buyer address and items summary (Chowdeck's create body has no address field; see section 8, question 3).
   - `deliveryPin`: recommended. Generate a 4-digit PIN, store it on the order, and show it **only to the buyer** in the app. The rider asks for it at handover, which protects against "never received" disputes.
3. On success set `fulfilment = 'chowdeck'`, `trackingNumber = reference`, `trackingUrl` (new field), `riderBookedAt`, and the actual cost in `chowdeckCost`. If the fresh quote is higher than what the buyer paid, URA absorbs the difference (as with Fez today); log it for the admin delivery report.
4. On failure: same handling as the Fez block (`DELIVERY_BOOKING_FAILED` notification, 502 to the seller).

### 4.4 Order model: `order-model.ts`

- `fulfilment`: add `'chowdeck'` to the enum.
- New optional fields: `deliveryProvider?: 'fez' | 'chowdeck'`, `chowdeckCost?: number`, `trackingUrl?: string`, `deliveryPin?: number` (never return it to the seller), `deliveryStatus?: string`, `deliveryUpdatedAt?: Date`.
- `shippingAddress`: allow optional `latitude` / `longitude`. The mobile app already asks for location permission and can send them.

The admin delivery report (`admin.routes.ts`, `fezCostsPaid`) should also sum `chowdeckCost`.

### 4.5 Tracking: `GET /delivery/track/:trackingNumber`

Look up the order by `trackingNumber`. Only the buyer, the seller, or an admin may read it. Route by `fulfilment` (`fez` → Fez as today, `chowdeck` → `getChowdeckDelivery`). Return one **normalised** shape for both couriers, so the apps don't need to know each courier's format:

```json
{
  "success": true,
  "data": {
    "provider": "chowdeck",
    "status": "in_transit",
    "statusLabel": "On the way",
    "trackingUrl": "https://track.chowdeck.com/…",
    "rider": { "name": "…", "phone": "…" },
    "timeline": [{ "status": "awaiting_pickup", "label": "Rider on the way to the shop", "at": "2026-11-24T10:00:00Z" }],
    "raw": {}
  }
}
```

Normalised `status` values: `booked`, `awaiting_pickup`, `in_transit`, `arrived`, `delivered`, `cancelled`, `failed`. Map Chowdeck's values (`preparing`, `awaiting_pickup`, `in_transit`/`picked`, `arrived`, `success`/`completed`, `rejected`/`cancelled`) and Fez's into these. Keep `raw` during the transition, because today's apps render Fez's own format.

### 4.6 Webhook: `POST /webhooks/chowdeck` (new)

1. Verify `x-chowdeck-signature`: HMAC-SHA256 of the **raw** request body with `CHOWDECK_WEBHOOK_SECRET`, compared with `crypto.timingSafeEqual`. Needs the raw body, so mount it before the JSON parser (as with the Payluk webhook).
2. Find the order by the delivery `reference` (= `orderNumber`). Update `deliveryStatus` / `deliveryUpdatedAt`. Make it idempotent, because Chowdeck retries.
3. Notify through `notifyOrderEvent`: rider assigned / picked up / arrived / delivered.
4. **Don't** mark the order complete or release escrow on Chowdeck's "delivered". The buyer still confirms receipt (current Payluk protected flow). Only prompt the buyer to confirm.
5. Respond `200` quickly.

Register the URL in the Chowdeck dashboard (Settings → Developers). If Relay turns out not to send webhooks (section 8, question 5), poll `getChowdeckDelivery` for open Chowdeck orders every few minutes instead.

### 4.7 Cancellation

When an order with a booked Chowdeck delivery is cancelled before pickup, call `cancelChowdeckDelivery(reference, reason)`. After pickup, Chowdeck may refuse; surface that to admin. The refund (`refund_amount`) goes back to the Relay wallet.

## 5. What the apps will change (mobile + website) once this ships

Handled on the app side, no backend work:

- **Checkout:** send `city`, `fullAddress` and (mobile) `latitude`/`longitude` to `/delivery/cost`; show "Delivered by Chowdeck · Same day" or "Delivered by Fez" from `provider` / `eta`.
- **Order page:** show the normalised status and timeline, a **Track live** button for `trackingUrl`, the rider's name/phone when present, and the **delivery PIN** for the buyer only.
- **Seller side:** "Mark ready" stays the same; the confirmation text names the courier.

## 6. Rollout

1. Build against Chowdeck's sandbox (section 8, question 2) with `CHOWDECK_CITIES` empty in production.
2. Enable one city (e.g. `Lagos`) in production and watch a few orders end to end.
3. Add the other cities.

Turning Chowdeck off = empty `CHOWDECK_CITIES` (or unset the key). Everything goes back to Fez.

## 7. Tests to add

- Courier choice: same city in list → Chowdeck; interstate → Fez; Chowdeck error → Fez.
- Kobo ↔ naira conversion.
- Re-quote then create at `markOrderReady`; duplicate-reference retry is safe.
- Webhook: bad signature → 401; good signature → status updated once even if delivered twice.
- Tracking: normalised shape for both couriers; seller never receives `deliveryPin`.

## 8. Questions for Chowdeck (their docs disagree)

1. **Host:** guides say `https://api.relay.chowdeck.com`, the API reference says `https://api.chowdeck.com`. Which is right for Relay, production and sandbox?
2. **Sandbox:** the email mentions a sandbox (console.chowdeck.com). What's its API host, and does it use separate keys?
3. **Addresses on create:** `POST /relay/delivery` takes contacts and a `fee_id` but no addresses. Are the pickup and drop-off taken from the fee quote? Can a single fee quote be used only once?
4. **Statuses:** is a cancelled delivery `rejected` or `cancelled`? Do Relay deliveries also use `picked`, `arrived`, `completed`?
5. **Webhooks:** does Relay send delivery-status webhooks (the events page only describes food orders), and where is the webhook secret shown?
6. **Limits:** how long is a fee quote valid, which statuses can be cancelled, and are there rate limits?
7. **Payment:** is every delivery charged to the Relay wallet at creation? What happens when the wallet is empty?

## 9. Where the open questions live in the code

Search the code for `TODO(chowdeck-q<n>)`:

| Question | Code |
|---|---|
| Q1 host | `chowdeckBaseUrl()` in `src/services/chowdeck.service.ts` (from `CHOWDECK_BASE_URL`, default the guides' host) |
| Q2 sandbox | same; point `CHOWDECK_BASE_URL` at the sandbox host once known |
| Q3 addresses on create | `markOrderReady` (address sent in the delivery note) |
| Q4 statuses | `CHOWDECK_STATUS` map in `src/services/courier.service.ts` |
| Q5 webhooks | `parseChowdeckEvent` in `src/services/courier.service.ts` and the webhook route |
| Q6 cancellable statuses | `cancelCourierBooking` in `src/services/courier.service.ts` |
| Q7 wallet | create errors are surfaced to the seller and admin like any booking failure |
| Rider fields | `normaliseChowdeckTracking` (the `driver` object is empty in Chowdeck's example) |
