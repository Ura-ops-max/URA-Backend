# Payluk payments: staging guide

Branch: `payluk-sdk-payments` (backend and frontend). Deploy both together.
The new frontend needs the new backend, and the old frontend does not work
with the new backend.

Test on Payluk **staging** only, with `sk_test_` and `pk_test_` keys.

## 1. Settings

Put the values straight into the server and the frontend host settings.
Never put them in git, chat or WhatsApp.

Backend (`.env` on the staging server):

| Setting | Value |
| --- | --- |
| `PAYLUK_BASE_URL` | `https://staging.api.payluk.ng` |
| `PAYLUK_SECRET_KEY` | Your `sk_test_...` key. It also checks webhook signatures. |
| `PAYLUK_RATE_LIMIT_PER_MIN` | Leave empty (10). Only raise it if Payluk raises your limit. |
| `PLATFORM_FEE_PERCENT` | URA's charge, in percent of the goods. Empty means 0. |
| `ADMIN_EMAILS` | Emails that may read the admin delivery report. |

`PAYLUK_WEBHOOK_SECRET` is not used any more. Payluk signs webhooks with the
secret key. `PAYLUK_PAID_STATUSES` is not used either. A payment counts as
paid when Payluk says the escrow is `OPENED` (or `CLOSED` after funding).

Frontend (build settings):

| Setting | Value |
| --- | --- |
| `VITE_PAYLUK_PUBLIC_KEY` | Your `pk_test_...` publishable key. Never a secret key. |

After changing backend settings, restart the backend: `pm2 restart ura-dev-api`.

## 2. Set the webhook URL in Payluk

1. Open the Payluk dashboard, then Business settings.
2. Choose the **test** environment.
3. Set the callback URL to `https://<staging-api-host>/api/v1/webhooks/payluk`.
4. Save.

Payluk signs each webhook with the test secret key. URA rejects any webhook
with a wrong signature (401). Check the backend logs for lines that start
with `[webhook]`.

## 3. Pay on staging with the Payluk Test Bank

1. Place an order on staging and tap **Pay**. The Payluk widget opens over URA.
2. Choose bank transfer in the widget. It shows a test-bank account.
3. Pay it from the Payluk Test Bank (see Payluk's guide "Simulate bank
   transfers with the Payluk Test Bank").
4. Watch the order turn paid. The backend log shows `escrow.ongoing`.

## 4. Checklist

- [ ] No browser request goes to Payluk's API (check the Network tab). Only
      the SDK widget loads: `checkout.payluk.ng/escrow-checkout.min.js` and
      `staging.live.payluk.ng/v1/checkout/session`.
- [ ] The buyer never leaves ura.com.ng during payment.
- [ ] Normal order (card, then transfer in the widget): the seller is paid
      automatically within a minute, once only, goods amount only.
- [ ] The delivery fee lands in URA's merchant wallet, not the seller's.
- [ ] Buyer-Protected order: the money is held. "I've received my order"
      releases it. The seller gets the goods amount only.
- [ ] Closing the widget leaves the order unpaid and payable again.
- [ ] The same webhook twice changes nothing.
- [ ] Wallet balance, history and withdrawal work through URA's routes.
- [ ] A product with no description and no photo saves and shows the name
      placeholder.

Also check:

- [ ] An order under ₦1,000 is refused with a clear message.
- [ ] A dispute on a Buyer-Protected order pauses the seller's buttons.
- [ ] `GET /api/v1/admin/reports/delivery` works for an email in `ADMIN_EMAILS`.

## 5. If a Normal order is not released

The release runs as a background job. It retries for 24 hours, then flags the
order. A `401 Access denied` from Payluk flags the order at once: it means
the key is not a merchant super-admin key.

Find flagged orders in MongoDB: `orders` where `adminFlag` exists. Find the
job in `paylukjobs` with key `release:<orderId>`. After fixing the cause, set
that job's `status` to `pending` and `runAt` to now. The worker picks it up
within a few seconds.

## 6. Limits to know

Payluk allows 10 requests a minute per secret key, across all routes and all
users. URA queues calls, serves checkout and releases first, and caches the
wallet screens. Under heavy use, a buyer may see "Payments are busy. Please
try again in a moment." Ask Payluk to raise the limit before launch.
