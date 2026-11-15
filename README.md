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

You need Node 18+ and a Postgres database.

```bash
npm install
cp .env.example .env   # set DATABASE_URL; set DEV_LOGIN=true to log in as any NetID without CAS
npm run dev
```

Then open http://localhost:3000. The tables are created automatically on first run. Without a Blob token, photos are saved to `uploads/`.

## Deploy to Vercel

- `api/index.js` serves the Express app as a Vercel function, and `vercel.json` routes every path to it. Files in `public/` are served directly.
- **Database:** Postgres through Neon. In the Vercel project, open **Storage → Create Database → Neon** and connect it; this sets `DATABASE_URL`.
- **Photos:** Vercel Blob with *private* access. Under **Storage → Create → Blob**, pick private access and connect it; this sets `BLOB_READ_WRITE_TOKEN`. Photos go through `/photos/...`, so only logged-in users can see them.
- **Other variables:** set `SESSION_SECRET`. `BASE_URL` defaults to the project's production domain, so set it only if you use a custom domain.
- The browser shrinks photos to 1600px before upload, because Vercel limits each request to 4.5 MB.

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
