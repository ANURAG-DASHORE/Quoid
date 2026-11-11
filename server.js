const express = require('express');
const crypto = require('crypto');
const E = process.env;
const PP = E.PAYPAL_ENV === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
const MODELS = (E.LLM_MODEL || 'gemini-3.5-flash,gemini-3.1-flash-lite,gemini-3.5-flash-lite').split(',').map(m => m.trim().replace(/^["']|["']$/g, '').replace(/^models\//, '')).filter(Boolean);
const app = express();
app.use(express.json({ limit: '15mb' }));
app.use(express.static('public'));
const wrap = f => (q, r) => f(q, r).catch(e => { console.error(e); r.status(500).json({ error: e.message }); });

/* ---------- storage: Postgres if DATABASE_URL is set, otherwise memory ---------- */
let pool = null; const mem = new Map();
// Without a database, quotes are saved to data/jobs.json so they survive a restart
const fs = require('fs'), path = require('path');
const FILE = path.join(__dirname, 'data', 'jobs.json');
try { for (const j of JSON.parse(fs.readFileSync(FILE, 'utf8'))) mem.set(j.id, j); } catch (e) { /* first run: no file yet */ }
const persist = () => { try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify([...mem.values()])); } catch (e) { console.error('Could not save quotes:', e.message); } };
if (E.DATABASE_URL) {
  const { Pool } = require('pg');
  pool = new Pool({ connectionString: E.DATABASE_URL, ssl: /render\.com|neon\.tech/.test(E.DATABASE_URL) ? { rejectUnauthorized: false } : false });
  pool.query('create table if not exists jobs(id text primary key, data jsonb not null, created timestamptz default now())').catch(console.error);
}
const store = {
  async list() { return pool ? (await pool.query('select data from jobs order by created desc limit 30')).rows.map(r => r.data) : [...mem.values()].reverse(); },
  async get(id) { return pool ? (await pool.query('select data from jobs where id=$1', [id])).rows[0]?.data : mem.get(id); },
  async save(j) { if (pool) await pool.query('insert into jobs(id,data) values($1,$2) on conflict(id) do update set data=$2', [j.id, j]); else { mem.set(j.id, j); persist(); } return j; },
  async byInvoice(id) { return (await this.list()).find(j => j.invoices?.some(i => i.id === id)); }
};

/* ---------- pricing engine: deterministic, the AI never sets a price ---------- */
const MAT = { aluminium_6061: [2.70, 6.5], mild_steel: [7.85, 1.4], stainless_304: [8.0, 5.2], brass: [8.5, 9], abs_plastic: [1.05, 3], other: [5, 5] }; // [density g/cm3, USD/kg]
const PROC = { cnc_milling: [45, 14, 60], cnc_turning: [38, 8, 45], laser_cutting: [30, 3, 20], sheet_bending: [28, 4, 25], '3d_printing': [15, 40, 10], welding: [35, 20, 30] }; // [USD/h, min/part, setup min]
const TOL = { standard: 1, tight: 1.4, very_tight: 1.8 };
const r2 = n => Math.round(n * 100) / 100;
function priceLine(it, margin) {
  const [rho, pk] = MAT[it.material] || MAT.other, [rate, mins, setup] = PROC[it.process] || PROC.cnc_milling;
  const nn = v => { v = parseFloat(v); return v > 0 ? v : 0; };
  const L = nn(it.length_mm) || 50, W = nn(it.width_mm) || 50, H = nn(it.height_mm) || 10, qty = Math.max(1, parseInt(it.quantity) || 1);
  const cm3 = L * W * H / 1000, stock = String(it.process).startsWith('cnc') ? 1.3 : 1.1;
  const kg = cm3 * rho / 1000 * stock, m = (mins * (TOL[it.tolerance] || 1) * Math.min(4, Math.max(0.5, cm3 / 100)));
  const mat = r2(kg * pk * (1 + margin)), mach = r2(m / 60 * rate * (1 + margin)), set = r2(setup / 60 * rate * (1 + margin));
  return { ...it, quantity: qty, materialCost: mat, machineCost: mach, setupCost: set, total: r2((mat + mach) * qty + set),
    reason: `${kg.toFixed(2)} kg ${String(it.material).replace('_', ' ')} at $${pk}/kg, ${m.toFixed(0)} min ${String(it.process).replace('_', ' ')} at $${rate}/h, ${setup} min setup, ${Math.round(margin * 100)}% margin` };
}
const DOC = { seller: { name: '', address: '', phone: '', email: '' }, validDays: 15, taxRate: 0, depositPct: 30,
  terms: 'Prices are valid until the date shown. The deposit is due on acceptance and the balance on delivery. Lead time is confirmed once the deposit is received.' };
const num = (v, lo, hi, d) => { v = parseFloat(v); return isNaN(v) ? d : Math.min(hi, Math.max(lo, v)); };
function priceJob(j) {
  const d = j.doc || {};
  j.doc = { ...DOC, ...d, seller: { ...DOC.seller, ...d.seller } };
  j.doc.validDays = num(j.doc.validDays, 1, 365, 15); j.doc.taxRate = num(j.doc.taxRate, 0, 100, 0); j.doc.depositPct = num(j.doc.depositPct, 0, 100, 30);
  j.items = j.items.map(i => priceLine(i, j.margin));
  j.subtotal = r2(j.items.reduce((s, i) => s + i.total, 0)); j.tax = r2(j.subtotal * j.doc.taxRate / 100);
  j.total = r2(j.subtotal + j.tax); j.deposit = r2(j.total * j.doc.depositPct / 100); j.balance = r2(j.total - j.deposit);
  return j;
}
const settle = j => { const all = j.invoices.length && j.invoices.every(i => i.paid), dep = j.invoices.find(i => i.kind === 'deposit')?.paid;
  if (j.invoices.length) j.status = all ? 'paid' : dep ? 'deposit_paid' : j.invoices.some(i => i.paid) ? 'part_paid' : 'invoiced'; return j; };

/* ---------- Gemini: extracts facts from the RFQ (text, PDF or photo) as schema-bound JSON ---------- */
const S = (type) => ({ type }), en = (...v) => ({ type: 'STRING', format: 'enum', enum: v });
const SCHEMA = { type: 'OBJECT', required: ['items'], properties: {
  customer: { type: 'OBJECT', properties: { name: S('STRING'), email: S('STRING'), company: S('STRING') } },
  items: { type: 'ARRAY', items: { type: 'OBJECT', required: ['part', 'material', 'process', 'quantity', 'tolerance', 'confidence'], properties: {
    part: S('STRING'), material: en(...Object.keys(MAT)), process: en(...Object.keys(PROC)), quantity: S('INTEGER'),
    length_mm: S('NUMBER'), width_mm: S('NUMBER'), height_mm: S('NUMBER'), tolerance: en(...Object.keys(TOL)),
    confidence: S('NUMBER'), missing: S('STRING') } } } } };
const cache = new Map();
async function extract(text, file) {
  if (!E.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not set');
  const key = crypto.createHash('sha256').update((text || '') + (file?.data || '')).digest('hex');
  if (cache.has(key)) return cache.get(key);
  const parts = [{ text: 'Extract this manufacturing request for quote (RFQ) into the schema. The request may list several numbered or separate parts: return one entry in items for EVERY part, and never stop after the first one. Only use facts stated in the request. Leave dimensions out when they are not given. Give each item a confidence from 0 to 1 and describe anything unclear in "missing".\n\nRFQ:\n' + (text || '(see attached file)') }];
  if (file) parts.push({ inline_data: { mime_type: file.mime, data: file.data } });
  let lastErr = 'unknown error';
  for (const model of MODELS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      console.log('Gemini trying', model);
      let r, j;
      try {
        r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, { method: 'POST', signal: AbortSignal.timeout(25000),
          headers: { 'content-type': 'application/json', 'x-goog-api-key': E.GEMINI_API_KEY },
          body: JSON.stringify({ contents: [{ parts }], generationConfig: { responseMimeType: 'application/json', responseSchema: SCHEMA, temperature: 0 } }) });
        j = await r.json();
      } catch (e) {
        lastErr = `${model}: ${e.name === 'TimeoutError' ? 'no answer after 25 seconds' : e.message}`;
        console.log('Gemini failed ->', lastErr); break; // try the next model
      }
      if (r.ok) {
        const out = JSON.parse(j.candidates[0].content.parts.map(p => p.text || '').join(''));
        out.items = (out.items || []).filter(i => i && i.part);
        const expected = ((text || '').match(/^\s*\d+[).]\s/gm) || []).length;
        if (out.items.length < expected) { lastErr = `${model}: found ${out.items.length} of ${expected} parts`; console.log('Gemini incomplete ->', lastErr); break; }
        cache.set(key, out); console.log('Gemini model used:', model); return out;
      }
      lastErr = `${model}: ${j.error?.message || r.status}`;
      console.log('Gemini failed ->', lastErr);
      if (r.status === 404 || (r.status === 400 && /model/i.test(j.error?.message || ''))) break; // bad or unavailable model name, try the next one
      if (![429, 500, 503].includes(r.status)) throw new Error(lastErr);
      await new Promise(res => setTimeout(res, 1500)); // busy, retry once, then next model
    }
  }
  throw new Error('All Gemini models failed. Last error: ' + lastErr);
}

/* ---------- PayPal Invoicing (sandbox) ---------- */
async function ppToken() {
  if (!E.PAYPAL_CLIENT_ID || !E.PAYPAL_CLIENT_SECRET) throw new Error('PayPal sandbox keys are not set');
  const r = await fetch(PP + '/v1/oauth2/token', { method: 'POST', body: 'grant_type=client_credentials',
    headers: { Authorization: 'Basic ' + Buffer.from(E.PAYPAL_CLIENT_ID + ':' + E.PAYPAL_CLIENT_SECRET).toString('base64'), 'content-type': 'application/x-www-form-urlencoded' } });
  if (!r.ok) throw new Error('PayPal sign-in failed. Check the client ID and secret.');
  return (await r.json()).access_token;
}
async function pp(path, body, tok) {
  const r = await fetch(PP + path, { method: 'POST', headers: { Authorization: 'Bearer ' + tok, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const t = await r.text(), j = t ? JSON.parse(t) : {};
  if (!r.ok) throw new Error(j.details?.[0]?.description || j.message || 'PayPal error ' + r.status);
  return j;
}
async function makeInvoice(tok, job, kind, label, amount) {
  const d = await pp('/v2/invoicing/invoices', {
    detail: { currency_code: 'USD', note: `${label} for quote ${job.id}`, payment_term: { term_type: 'NET_10' } },
    primary_recipients: [{ billing_info: { name: { given_name: job.customer.name || 'Customer' }, email_address: job.customer.email } }],
    items: [{ name: `${label}, quote ${job.id}`, quantity: '1', unit_amount: { currency_code: 'USD', value: amount.toFixed(2) } }] }, tok);
  const id = d.href.split('/').pop();
  const s = await pp(`/v2/invoicing/invoices/${id}/send`, { send_to_recipient: true, send_to_invoicer: false }, tok);
  return { kind, id, label, amount, url: s.href, paid: false };
}

/* ---------- routes ---------- */
app.get('/api/health', (q, r) => r.json({ ok: true }));
app.get('/api/jobs', wrap(async (q, r) => r.json(await store.list())));
app.get('/api/jobs/:id', wrap(async (q, r) => { const j = await store.get(q.params.id); j ? r.json(j) : r.status(404).json({ error: 'Quote not found' }); }));

app.post('/api/rfq', wrap(async (q, r) => {
  const { text, file } = q.body;
  if (!text && !file) return r.status(400).json({ error: 'Paste a request or attach a file first.' });
  const x = await extract(text, file);
  if (!x.items?.length) return r.status(422).json({ error: 'No parts found in that request. Add part, material, quantity and process.' });
  const job = { id: 'Q-' + Date.now().toString(36).toUpperCase(), status: 'quoted', margin: 0.25, customer: x.customer || {},
    rfq: (text || '').slice(0, 4000), items: x.items.map((i, n) => ({ ...i, row: n + 1 })), invoices: [] };
  r.json(await store.save(priceJob(job)));
}));

app.patch('/api/jobs/:id', wrap(async (q, r) => {
  const j = await store.get(q.params.id);
  if (!j) return r.status(404).json({ error: 'Quote not found' });
  if (j.status !== 'quoted') return r.status(409).json({ error: 'Invoices are already sent, so this quote is locked.' });
  for (const c of q.body.items || []) { const it = j.items.find(i => i.row === c.row); if (it) { const { row, ...rest } = c; Object.assign(it, rest); } }
  if (q.body.margin != null) j.margin = Math.min(1, Math.max(0, +q.body.margin || 0));
  if (q.body.customer) j.customer = { ...j.customer, ...q.body.customer };
  if (q.body.doc) j.doc = { ...j.doc, ...q.body.doc, seller: { ...j.doc?.seller, ...q.body.doc.seller } };
  r.json(await store.save(priceJob(j)));
}));

app.post('/api/jobs/:id/approve', wrap(async (q, r) => {
  const j = await store.get(q.params.id);
  if (!j) return r.status(404).json({ error: 'Quote not found' });
  if (j.status !== 'quoted') return r.status(409).json({ error: 'Invoices were already sent for this quote.' });
  if (q.body.email) j.customer.email = q.body.email;
  if (!j.customer.email) return r.status(400).json({ error: "Add the customer's PayPal email first." });
  const tok = await ppToken();
  j.invoices = [];
  if (j.deposit > 0) j.invoices.push(await makeInvoice(tok, j, 'deposit', `Deposit (${j.doc.depositPct}%)`, j.deposit));
  if (j.balance > 0) j.invoices.push(await makeInvoice(tok, j, 'balance', 'Balance', j.balance));
  if (!j.invoices.length) return r.status(400).json({ error: 'The quote total is zero.' });
  j.status = 'invoiced';
  r.json(await store.save(j));
}));

// Fallback for runs where PayPal cannot reach a webhook (for example on localhost)
app.post('/api/jobs/:id/sync', wrap(async (q, r) => {
  const j = await store.get(q.params.id);
  if (!j) return r.status(404).json({ error: 'Quote not found' });
  const tok = await ppToken();
  for (const i of j.invoices) if (!i.paid) {
    const r2 = await fetch(PP + '/v2/invoicing/invoices/' + i.id, { headers: { Authorization: 'Bearer ' + tok } });
    const d = await r2.json();
    i.pp = d.status || ('HTTP ' + r2.status);
    console.log('PayPal invoice', i.id, 'status:', d.status, 'due:', d.due_amount?.value);
    if (['PAID', 'MARKED_AS_PAID'].includes(d.status) || (d.due_amount && parseFloat(d.due_amount.value) === 0 && !['CANCELLED', 'DRAFT'].includes(d.status))) i.paid = true;
  }
  r.json(await store.save(settle(j)));
}));

app.post('/api/paypal/webhook', async (q, r) => {
  try {
    const h = q.headers, tok = await ppToken();
    const v = await pp('/v1/notifications/verify-webhook-signature', { auth_algo: h['paypal-auth-algo'], cert_url: h['paypal-cert-url'],
      transmission_id: h['paypal-transmission-id'], transmission_sig: h['paypal-transmission-sig'], transmission_time: h['paypal-transmission-time'],
      webhook_id: E.PAYPAL_WEBHOOK_ID, webhook_event: q.body }, tok);
    if (v.verification_status !== 'SUCCESS') return r.sendStatus(400);
    if (q.body.event_type === 'INVOICING.INVOICE.PAID') {
      const id = q.body.resource?.invoice?.id || q.body.resource?.id, j = await store.byInvoice(id);
      if (j) { j.invoices.find(i => i.id === id).paid = true; await store.save(settle(j)); }
    }
    r.sendStatus(200);
  } catch (e) { console.error(e); r.sendStatus(500); }
});

app.listen(E.PORT || 3000, () => console.log('Quoid running on port ' + (E.PORT || 3000)));
