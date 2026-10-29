# Getting URA shops on Google (for the owner)

Plain steps. You do steps 1 to 3 and 5 to 9; the CTO does step 4. Do this
**after** the routing change in docs/google-routing.md is live.

## 1. Use a company Google account

Sign in with a Google account the company owns (for example
`admin@ura.com.ng` or a shared company Gmail), not a personal one. Whoever
controls this account controls URA in Google Search.

## 2. Open Google Search Console

Go to https://search.google.com/search-console and click **Add property**.

## 3. Add a "Domain" property

Choose **Domain** (the left box), type `ura.com.ng` (no www, no https) and
click **Continue**. Google shows a line starting with
`google-site-verification=...`. Click **Copy**.

## 4. Send the code to the CTO

Send that line to the CTO. The CTO adds it as a **TXT record** on `ura.com.ng`
in AWS (Route 53, hosted zone `ura.com.ng`, record name blank, type TXT, value
the full line in quotes). It is not secret, but send it only to the CTO.

Fallback (only if DNS is not possible): the CTO sets
`GOOGLE_SITE_VERIFICATION` on the API server to the code (the part after `=`)
and you choose the **URL prefix** property `https://www.ura.com.ng` with the
**HTML tag** method instead.

## 5. Click Verify

When the CTO says the record is added, go back and click **Verify**. If it
fails, wait an hour and try again (DNS can take time).

## 6. Submit the sitemap

In Search Console, open **Sitemaps**, type `sitemap.xml` and click **Submit**.
Status should say "Success" within a day.

## 7. Ask Google to look at your 5 best shops

Pick 5 shops with a good About, products and photos. For each: paste the shop
link (for example `https://www.ura.com.ng/tunde-boots`) in the search bar at
the top of Search Console, then click **Request indexing**.

## 8. Add the CTO as a user

**Settings > Users and permissions > Add user**, the CTO's email, permission
**Full**.

## 9. Check the Pages report every week

Open **Indexing > Pages**. "Indexed" should grow week by week. Shops that are
not ready (no About and no products) are left out on purpose. If you see
"Server error (5xx)" or "Not found (404)" growing, tell the CTO.

## Optional: Bing

Go to https://www.bing.com/webmasters, sign in, choose **Import from Google
Search Console**, and allow it. Bing then uses the same setup and sitemap.

## For the CTO: the release check

After each deploy, or in CI:

```
bun run src/scripts/seo-check.ts
SEO_CHECK_URL=https://<staging-id>.cloudfront.net bun run src/scripts/seo-check.ts
```

It fetches `/sitemap.xml`, one Ready shop and one product, and fails if the
sitemap, a page title or the structured data is missing.

Readiness numbers (read-only): `bun run src/scripts/seo-report.ts`, or
`GET /api/v1/admin/reports/seo` as an admin (`ADMIN_EMAILS`).
