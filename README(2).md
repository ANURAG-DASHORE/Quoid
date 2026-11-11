<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="public/logo-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="public/logo-green.svg">
    <img src="public/logo-green.svg" alt="Quoid logo" width="140">
  </picture>
</p>

# Quoid

**From RFQ to paid invoice in one grid.**

Quoid is an AI agent for small manufacturing shops. A customer sends a request for quote (RFQ) as text, a PDF or a photo. Quoid reads it, prices every line, shows the quote in an editable grid, builds a quotation document, and sends the customer PayPal invoices for a deposit and the final payment. Built for the PayPal AI Hackathon 2026.

**See the payment flow in action, with screenshots:** [docs/payment-flow.md](docs/payment-flow.md)

| Link | URL |
|---|---|
| Live demo | https://YOUR-APP-NAME.onrender.com |
| Devpost submission | https://devpost.com/software/YOUR-PROJECT-NAME |
| Demo video (YouTube) | https://youtu.be/YOUR-VIDEO-ID |

<!-- Replace the three placeholder URLs above before you submit. -->

## What it does

1. **Reads the RFQ.** Gemini turns the customer's message (text, PDF or photo) into structured parts: item, material, process, quantity, size and tolerance. Anything unclear is flagged instead of guessed.
2. **Prices every line.** A deterministic pricing engine (material, machine time, setup, margin) sets every price. The AI never invents a number, so each price is explainable.
3. **Shows an editable quote** in an AG Grid table. Change a quantity, material, process or margin and everything reprices.
4. **Builds a quotation document** in a side panel. It is drawn in the browser from the quote data, so editing the company details, customer details, validity, tax, deposit % or terms updates it instantly with no AI call. It can be printed or saved as a PDF.
5. **Sends PayPal invoices** with one click: a deposit invoice and a balance invoice, created and sent through the PayPal Invoicing API (sandbox).
6. **Tracks payment.** The quote status moves from Ready to send, to Awaiting deposit, Part paid or Deposit paid, to Paid in full. Online, PayPal's webhook updates it (see [the payment walkthrough](docs/payment-flow.md)). If the status has not changed after you pay, click `CHECK PAYMENT STATUS`.

Light and dark themes are included.

## How it works

```
RFQ text / PDF / photo
        |
   Gemini API  ->  structured JSON (parts, materials, sizes, confidence)
        |
 pricing engine (server.js, deterministic)  ->  line prices, tax, deposit, balance
        |
 AG Grid quote  +  live quotation preview (browser only)
        |
 PayPal Invoicing API  ->  deposit invoice + balance invoice
        |
 PayPal webhook (INVOICING.INVOICE.PAID) / Check payment status  ->  quote status
```

**Stack:** Node.js, Express, plain HTML/CSS/JS, AG Grid Community, Google Gemini API, PayPal Invoicing API v2 (sandbox) and webhooks, PostgreSQL (optional), Render for hosting.

## Run it locally

You need Node.js 20 or newer.

```bash
npm install
cp .env.example .env      # on Windows: copy .env.example .env
# edit .env and fill in the keys below
npm run dev
```

Open http://localhost:3000.

### Environment variables

| Variable | What it is |
|---|---|
| `GEMINI_API_KEY` | Key from Google AI Studio |
| `LLM_MODEL` | One or more Gemini model names separated by commas. They are tried in order. Example: `gemini-3.5-flash,gemini-3.1-flash-lite,gemini-3.5-flash-lite` |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | From a PayPal developer **sandbox** app |
| `PAYPAL_ENV` | `sandbox` |
| `PAYPAL_WEBHOOK_ID` | ID of the webhook you add in PayPal after deploying (see below). Leave empty locally. |
| `DATABASE_URL` | Optional PostgreSQL connection string. Without it, quotes are saved to `data/jobs.json`. |

Write each value with no quotes and no spaces around the `=`.

## Try it (for judges)

> After paying an invoice, click `CHECK PAYMENT STATUS` to update the quote.

You need a PayPal **sandbox** buyer account. The login for the test buyer is in the testing instructions of the Devpost submission.

1. Click **Try a sample**, then the send arrow. You should get 3 parts and a total of about $954.68 (with the default 30% deposit: $286.40 deposit and $668.28 balance).
2. Edit a quantity, a material or the margin in the grid. The totals update.
3. Click **Open preview**. In **Quotation details**, type a company name, set tax and deposit %, and watch the document change.
4. Put the sandbox buyer's email in **Bill to**, then click **Approve and send invoices**. Two invoice links appear under the quote.
5. Open the **Deposit** link, log in with the sandbox buyer, and pay.
6. Return to Quoid. The status updates by itself when PayPal's webhook arrives. If it still says "Awaiting deposit", click `CHECK PAYMENT STATUS`.
7. Pay the **Balance** invoice and check again. The quote becomes **Paid in full**.

Everything uses PayPal's sandbox, so no real money is involved.

See the payment steps with screenshots in [docs/payment-flow.md](docs/payment-flow.md).

## Deploy on Render

1. Push this repository to GitHub.
2. Create a free PostgreSQL database (for example at [neon.tech](https://neon.tech)) and copy its connection string.
3. On [Render](https://render.com), create a **Blueprint** from this repo (it reads `render.yaml`), or create a Web Service with build command `npm install` and start command `node server.js`.
4. Add the environment variables from the table above, including `DATABASE_URL`.
5. In the PayPal developer dashboard, open your sandbox app, add a webhook at `https://<your-app>.onrender.com/api/paypal/webhook`, subscribe to **Invoice paid** (`INVOICING.INVOICE.PAID`), and copy its Webhook ID into `PAYPAL_WEBHOOK_ID` on Render.

Render's free web services go to sleep when idle, so the first visit after a quiet period can take about a minute to load.

## Project layout

```
server.js            API, pricing engine, Gemini and PayPal calls
public/index.html    the whole interface (grid, chat, preview panel, logo)
render.yaml          Render blueprint
.env.example         the settings you need
```

## Notes and limits

- PayPal is used in sandbox mode only.
- The material and machine rates in `server.js` are example values for a demo shop. A real shop would replace them with its own.
- The Gemini free tier has rate limits. Results are cached, and if one model is busy Quoid tries the next one in `LLM_MODEL`.

## License

MIT. See [LICENSE](LICENSE).
