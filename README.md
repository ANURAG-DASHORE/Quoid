# Quoid

From RFQ to paid invoice in one grid. Built for the PayPal AI Hackathon 2026.

A small manufacturing shop pastes (or uploads) a customer's request for quote. **Gemini** extracts the parts as structured data, a **deterministic pricing engine** prices every line (the AI never sets a price), and the quote appears in an editable **AG Grid** table. One approval click creates and sends two **PayPal** invoices, a 30% deposit and the balance. PayPal webhooks flip the job status when each invoice is paid.

## Run locally
Needs Node 20+.
```bash
npm install
cp .env.example .env     # fill in the keys below
npm run dev              # http://localhost:3000
```
Without `DATABASE_URL`, quotes are kept in memory. On localhost PayPal cannot reach the webhook, so use the **Check payment status** button after paying a sandbox invoice.

## Keys
| Variable | Where to get it |
|---|---|
| `GEMINI_API_KEY` | Google AI Studio (free tier). Set `LLM_MODEL` to a current Flash model if the default alias changes. |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | developer.paypal.com, Apps & Credentials, Sandbox, create an app under your sandbox business account |
| `PAYPAL_WEBHOOK_ID` | Same app, add a webhook to `https://<your-host>/api/paypal/webhook` with the `INVOICING.INVOICE.PAID` event, copy its ID |
| `DATABASE_URL` | Optional Postgres URL (Neon or Render) |

## Try it (judges)
1. Click **Use sample request**, then **Generate quote**. Edit a quantity, material or margin and watch the prices update.
2. Enter a **sandbox personal** account's email as the customer, then **Approve and send PayPal invoices**.
3. Open an invoice link, pay it with the sandbox buyer login, and the status changes to *Deposit paid* (or press **Check payment status**).

## Deploy on Render
Push this repo to GitHub, create a Blueprint from `render.yaml`, fill the environment variables, and register the webhook URL in PayPal.

## Design notes
- Gemini only extracts facts. Prices come from `priceLine()` in `server.js`, so every number is auditable and each row explains itself.
- Light mode uses blue and green, dark mode uses red and grey.

License: MIT
