# Google routing for ura.com.ng (for the CTO)

Shop and product pages must reach Google as real HTML. The backend builds
them (`GET /api/v1/seo/page`). This document is the one routing change the
host needs so those paths go to the backend, while the app, `/api` and
static files stay exactly as they are.

## What the site runs on today (checked from the live site)

| Thing | Found |
|---|---|
| Frontend host | **S3 + CloudFront** (workflow `deploy-prod.yaml`: `aws s3 sync` + invalidation). Distribution `E1X70L4E1SGWB0`, eu-west-1 bucket. No Vercel, Amplify or nginx config in the repos. |
| Unknown paths | Served `index.html` with status **200** by CloudFront "custom error responses" (403/404 to `/index.html`, 200). Every shop path is a "soft 200" today. |
| http to https | Already redirects (CloudFront). |
| Bare domain | `ura.com.ng` **301 to `https://www.ura.com.ng`** (a CloudFront Function). So the live canonical host is **www**. |
| robots.txt, sitemap.xml | Static files in the frontend repo `public/`. |

## Why Lambda@Edge (not a CloudFront Function)

CloudFront picks a behaviour (and its origin) **before** a CloudFront Function
runs, so a CloudFront Function cannot send `/tunde-boots` to a different
origin. A Lambda@Edge **origin request** function can change the origin per
request. Shop slugs are arbitrary (`/<anything>`), so a path-pattern behaviour
cannot match them either.

## The rule

Code: [`infra/lambda-edge/seo-router.js`](../infra/lambda-edge/seo-router.js)
(tested in `tests/unit/seo-router.test.ts`).

| Viewer path | Goes to |
|---|---|
| `/<slug>` (not a reserved word, no dot) | `https://api.ura.com.ng/api/v1/seo/page?path=/<slug>` |
| `/<slug>/p/<24-hex id>-<name>` | `https://api.ura.com.ng/api/v1/seo/page?path=...` |
| `/sitemap.xml` | `https://api.ura.com.ng/api/v1/seo/sitemap/index` |
| `/sitemaps/<name>.xml` | `https://api.ura.com.ng/api/v1/seo/sitemap/<name>` |
| `/robots.txt` | `https://api.ura.com.ng/api/v1/seo/robots` |
| Any other path with no file extension (`/dashboard/...`, `/auth/...`, `/about`) | S3 `/index.html` (the app) |
| Files (`/assets/*.js`, `/sw.js`, images) | S3, unchanged |

Because the function now serves `index.html` for app paths itself, the 403/404
custom error responses must be **removed** (last step below). Otherwise
CloudFront would hide the page-builder's real 404 and 410 behind a 200.

The function caches per viewer URL (CloudFront's normal cache key), and the
backend sends `Cache-Control: s-maxage=3600` for built pages and sitemaps.

## Backend settings (on the API server, `.env`)

| Setting | Value |
|---|---|
| `PUBLIC_SITE_URL` | `https://www.ura.com.ng` (the canonical host; see "www or bare domain") |
| `FRONTEND_INDEX_URL` | Leave empty: defaults to `${PUBLIC_SITE_URL}/index.html` (served by S3 through CloudFront; has a dot, so the function leaves it on S3, no loop). |
| `GOOGLE_SITE_VERIFICATION` | Optional fallback only; prefer the DNS TXT record (docs/google-setup.md). |

Deploy the backend branch first and check it directly:

```
curl -s "https://api.ura.com.ng/api/v1/seo/page?path=/<a-real-slug>" | grep -E "<title>|ld\+json"
curl -s "https://api.ura.com.ng/api/v1/seo/sitemap/index"
curl -s "https://api.ura.com.ng/api/v1/seo/robots"
```

## Staging (do this first)

1. **Create a staging distribution** in the CloudFront console: copy `E1X70L4E1SGWB0`
   (same S3 origin). Leave it on its `*.cloudfront.net` address; no domain.
2. **Create the function** (Lambda console, region **us-east-1**, required for Lambda@Edge):
   - Name `ura-seo-router`, runtime **Node.js 20.x**.
   - Paste `infra/lambda-edge/seo-router.js`, Deploy.
   - Role: add the trust principal `edgelambda.amazonaws.com` next to `lambda.amazonaws.com`.
   - **Actions > Publish new version** (Lambda@Edge needs a numbered version).
3. **Attach it** to the staging distribution: Behaviours > Default (*) > Edit >
   Function associations > **Origin request** > Lambda@Edge > the version ARN
   (`arn:aws:lambda:us-east-1:<account>:function:ura-seo-router:1`). Save.
4. **Remove the custom error responses** for 403 and 404 on the staging
   distribution (Error pages tab).
5. **Wait for "Deployed"** (5 to 10 minutes), then test with the staging address:
   ```
   S=https://<staging-id>.cloudfront.net
   curl -sI "$S/<a-real-slug>"                     # 200, text/html
   curl -s  "$S/<a-real-slug>" | grep -E "<title>|ld\+json|<h1>"
   curl -sI "$S/no-such-shop-xyz"                  # 404
   curl -sI "$S/dashboard"                         # 200 (the app)
   curl -sI "$S/assets/<any built file>.js"        # 200 from S3
   curl -s  "$S/sitemap.xml" | head -c 300
   curl -s  "$S/robots.txt"
   ```
   Open a shop and `/dashboard` in a phone browser: the app must work as normal.

## Live

1. Attach the **same function version** to `E1X70L4E1SGWB0`, Default behaviour, **Origin request**.
2. When it shows Deployed, remove the 403/404 custom error responses.
3. Invalidate: `aws cloudfront create-invalidation --distribution-id E1X70L4E1SGWB0 --paths "/*"`.
4. Re-run the staging checks against `https://www.ura.com.ng`, then run the check
   script: `bun run src/scripts/seo-check.ts` (docs/google-setup.md).

## Roll back (about 10 minutes)

1. Distribution > Behaviours > Default > Edit > Function associations >
   Origin request: **No association**. Save.
2. Add back the custom error responses: 403 and 404, response page
   `/index.html`, HTTP code **200**.
3. Invalidate `/*`. The site is back to exactly how it was. The backend changes
   are harmless when nothing routes to them.

## www or bare domain

The prompt asks for `https://ura.com.ng` as the main address. The live site
does the **opposite** today (bare domain redirects to www), and the app's own
`index.html` canonical and the static robots.txt use www. The page-builder
uses `PUBLIC_SITE_URL`, so either works:

- **Keep www (recommended, no change):** `PUBLIC_SITE_URL=https://www.ura.com.ng`.
- **Switch to the bare domain:** set `PUBLIC_SITE_URL=https://ura.com.ng`; flip the
  viewer-request CloudFront Function so `www` redirects to the bare domain:
  ```js
  function handler(event) {
    var req = event.request;
    var host = req.headers.host.value;
    if (host === 'www.ura.com.ng') {
      var qs = Object.keys(req.querystring).map(function (k) {
        return k + '=' + req.querystring[k].value;
      }).join('&');
      return {
        statusCode: 301,
        statusDescription: 'Moved Permanently',
        headers: { location: { value: 'https://ura.com.ng' + req.uri + (qs ? '?' + qs : '') } },
      };
    }
    return req;
  }
  ```
  and update `index.html` (canonical, og:url) and `public/robots.txt` in the
  frontend to the bare domain. Do this before submitting to Search Console.

## If the frontend moves to Vercel

`vercel.json` (frontend repo), replacing the SPA fallback:

```json
{
  "rewrites": [
    { "source": "/robots.txt", "destination": "https://api.ura.com.ng/api/v1/seo/robots" },
    { "source": "/sitemap.xml", "destination": "https://api.ura.com.ng/api/v1/seo/sitemap/index" },
    { "source": "/sitemaps/:name.xml", "destination": "https://api.ura.com.ng/api/v1/seo/sitemap/:name" },
    {
      "source": "/:slug((?!(?:about|contact|terms|privacy|faq|invite|payments|products|posts|auth|dashboard|api|health|b|login|register|signin|signup|admin|settings|product|businesses|explore|search|cart|checkout|welcome|google|payment-complete|payluk|p|seo|sitemap|sitemaps|robots|assets|images|sounds|mock-data|sw|static|favicon|manifest|site|menu|notifications|wallet|orders|chat|inventory)$)[a-z0-9-]{1,80})",
      "destination": "https://api.ura.com.ng/api/v1/seo/page?path=/:slug"
    },
    {
      "source": "/:slug([a-z0-9-]{1,80})/p/:ref([0-9a-f]{24}[^/.]*)",
      "destination": "https://api.ura.com.ng/api/v1/seo/page?path=/:slug/p/:ref"
    },
    { "source": "/((?!.*\\.).*)", "destination": "/index.html" }
  ]
}
```

Keep the reserved words in line with `RESERVED_SLUGS`.

## If it is served by nginx

```nginx
location = /robots.txt   { proxy_pass https://api.ura.com.ng/api/v1/seo/robots; }
location = /sitemap.xml  { proxy_pass https://api.ura.com.ng/api/v1/seo/sitemap/index; }
location ~ ^/sitemaps/([a-z]+-[0-9]{1,4})\.xml$ { proxy_pass https://api.ura.com.ng/api/v1/seo/sitemap/$1; }

# Shop and product pages (reserved words and dotted files excluded).
location ~ "^/(?!(about|contact|terms|privacy|faq|invite|payments|products|posts|auth|dashboard|api|health|b|login|register|signin|signup|admin|settings|product|businesses|explore|search|cart|checkout|welcome|google|payment-complete|payluk|p|seo|sitemap|sitemaps|robots|assets|images|sounds|mock-data|sw|static|favicon|manifest|site|menu|notifications|wallet|orders|chat|inventory)(/|$))[a-z0-9-]{1,80}(/p/[0-9a-f]{24}[^/.]*)?$" {
  proxy_set_header Host api.ura.com.ng;
  proxy_ssl_server_name on;
  proxy_pass https://api.ura.com.ng/api/v1/seo/page?path=$uri;
}

location / { try_files $uri /index.html; }
```

nginx regex locations are case-sensitive; shop slugs are always lowercase.
