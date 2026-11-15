# Tiger Closet

Princeton students can use Tiger Closet to lend, borrow and swap formal dresses.

- **Princeton-only accounts.** You log in with Princeton CAS (NetID) or, if you set it up, a Princeton Microsoft/Outlook account. Listings and photos are hidden from anyone who isn't logged in.
- **Post dresses with photos.** Each listing takes up to 6 photos plus size, length, color, designer and a description.
- **Borrowing terms.** The owner picks which terms they'll accept. The borrower then either
  - offers a **deposit** of at least the owner's minimum, or
  - **agrees to dry clean** the dress before returning it, or
  - offers a **swap** with one of their own listed dresses.
- **Requests.** The owner accepts or declines each request. After an accept, both people see each other's contact info. The owner can mark the dress as returned.

Payment for deposits happens outside the site (Venmo, cash, etc.).

## Run locally

```bash
npm install
cp .env.example .env   # set DEV_LOGIN=true to log in as any NetID without CAS
npm run dev
```

Then open http://localhost:3000.

## Deploy

You need a Node 18+ host with a persistent disk, because the SQLite database is stored in `data/` and photos in `uploads/`. Render, Railway and Fly.io all work. Set these variables:

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `BASE_URL` | your public https URL, e.g. `https://tigercloset.onrender.com` |
| `SESSION_SECRET` | a long random string |
| `DB_PATH`, `UPLOAD_DIR` | paths on your persistent disk (optional) |

### Princeton CAS
CAS works with no extra setup: the site redirects to `https://fed.princeton.edu/cas` and checks the ticket with `serviceValidate`. If CAS rejects your domain, ask Princeton OIT to allow it as a CAS service.

### Microsoft / Outlook login (optional)
1. In the [Azure portal](https://portal.azure.com) → **App registrations** → **New registration**.
   - Supported account types: *Accounts in any organizational directory* (or Princeton's directory only, if OIT registers the app for you).
   - Redirect URI (Web): `https://YOUR-DOMAIN/auth/microsoft`
2. Under **Certificates & secrets**, create a client secret.
3. Set `MS_CLIENT_ID` and `MS_CLIENT_SECRET`. Set `MS_TENANT` to Princeton's tenant ID if you have it. With no tenant ID it defaults to `organizations`.

The site only accepts accounts whose sign-in name ends in `@princeton.edu`. It uses the part before the `@` as the NetID, so a person who signs in with CAS and later with Microsoft gets the same account.

> Princeton may require admin consent for third-party apps. If students see "Need admin approval", contact OIT, or keep using CAS.
