# Tiger Closet

Princeton students can use Tiger Closet to lend, borrow and swap formal dresses.

- **Princeton-only accounts.** People sign up with an email and password, and only `@princeton.edu` emails are accepted. Once email sending is set up, new accounts must enter a 6-digit code sent to that address. Listings and photos are hidden from anyone who isn't logged in.
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
cp .env.example .env   # set DATABASE_URL
npm run dev
```

Then open http://localhost:3000. The tables are created automatically on first run. Without a Blob token, photos are saved to `uploads/`.

## Deploy to Vercel

- `api/index.js` serves the Express app as a Vercel function, and `vercel.json` routes every path to it. Files in `public/` are served directly.
- **Database:** Postgres through Neon. In the Vercel project, open **Storage → Create Database → Neon** and connect it; this sets `DATABASE_URL`.
- **Photos:** Vercel Blob with *private* access. Under **Storage → Create → Blob**, pick private access and connect it; this sets `BLOB_READ_WRITE_TOKEN`. Photos go through `/photos/...`, so only logged-in users can see them.
- **Other variables:** set `SESSION_SECRET`. `BASE_URL` defaults to the project's production domain, so set it only if you use a custom domain.
- The browser shrinks photos to 1600px before upload, because Vercel limits each request to 4.5 MB.

### Email (verification codes and password resets)
1. Create a free [Resend](https://resend.com) account and add your domain (e.g. `ellakowal.com`) under **Domains**.
2. Add the DNS records Resend shows you at your domain registrar, then wait for the domain to show as verified.
3. Create an API key, then set `RESEND_API_KEY` and `EMAIL_FROM` (e.g. `Tiger Closet <noreply@ellakowal.com>`) in Vercel and redeploy.

Until this is set up, people can sign up without verifying their email. Once it's on, any unverified account is asked for a code at its next login.
