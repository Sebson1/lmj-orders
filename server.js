// LMJ Surface Disinfectant – order site
// Zero-dependency Node.js server (Node 18+). Run with:  node server.js
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

// ---------- config (.env) ----------
loadEnv(path.join(__dirname, '.env'));
const CFG = {
  port: Number(process.env.PORT || 3000),
  baseUrl: (process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, ''),
  adminKey: process.env.ADMIN_KEY || 'change-me',
  ownerPhone: process.env.OWNER_PHONE || '0558527351',          // receives order SMS/WhatsApp alerts
  contactPhone: process.env.CONTACT_PHONE || process.env.OWNER_PHONE || '0535623533', // shown to customers (call / WhatsApp)
  businessName: process.env.BUSINESS_NAME || 'LMJ',
  productName: process.env.PRODUCT_NAME || 'LMJ Surface Disinfectant (Pink Blossom, 100ml)',
  price: Number(process.env.PRODUCT_PRICE || 25),
  deliveryFee: Number(process.env.DELIVERY_FEE || 0),
  mnotifyKey: process.env.MNOTIFY_API_KEY || '',
  mnotifySender: process.env.MNOTIFY_SENDER_ID || 'LMJ',
  paystackSecret: process.env.PAYSTACK_SECRET_KEY || '',
  waToken: process.env.WHATSAPP_TOKEN || '',
  waPhoneId: process.env.WHATSAPP_PHONE_ID || '',
};
const DATA_FILE = path.join(__dirname, 'data', 'orders.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------- tiny JSON store ----------
function loadOrders() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { return []; }
}
function saveOrders(orders) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(orders, null, 2));
}
function findOrder(id) { return loadOrders().find(o => o.id === id); }
function updateOrder(id, fn) {
  const orders = loadOrders();
  const o = orders.find(x => x.id === id);
  if (!o) return null;
  fn(o);
  o.updatedAt = new Date().toISOString();
  saveOrders(orders);
  return o;
}

// ---------- helpers ----------
function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
function normalizePhone(p) {
  let d = String(p || '').replace(/\D/g, '');
  if (d.startsWith('0') && d.length === 10) d = '233' + d.slice(1);
  if (d.length === 9) d = '233' + d;
  return d;
}
function money(n) { return 'GHS ' + Number(n).toFixed(2); }
function newOrderId() {
  return 'LMJ-' + crypto.randomBytes(2).toString('hex').toUpperCase() + Date.now().toString().slice(-4);
}
function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}
function redirect(res, to) { res.writeHead(302, { Location: to }); res.end(); }
function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', c => raw += c);
    req.on('end', () => resolve(raw));
  });
}
function log(...a) { console.log(new Date().toISOString(), ...a); }

// ---------- messaging ----------
async function sendSMS(to, message) {
  const recipient = normalizePhone(to);
  if (!CFG.mnotifyKey) { log('[SMS not configured] →', recipient, '|', message); return { mock: true }; }
  try {
    const r = await fetch('https://api.mnotify.com/api/sms/quick?key=' + encodeURIComponent(CFG.mnotifyKey), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient: [recipient], sender: CFG.mnotifySender, message, is_schedule: 'false', schedule_date: '' }),
    });
    const data = await r.json().catch(() => ({}));
    log('[mNotify]', recipient, r.status, JSON.stringify(data).slice(0, 200));
    return data;
  } catch (e) { log('[mNotify error]', e.message); return { error: e.message }; }
}

// WhatsApp via Meta Cloud API (optional). Without it, the site still offers wa.me links.
async function sendWhatsApp(to, message) {
  const recipient = normalizePhone(to);
  if (!CFG.waToken || !CFG.waPhoneId) { log('[WhatsApp API not configured] →', recipient, '|', message); return { mock: true }; }
  try {
    const r = await fetch(`https://graph.facebook.com/v20.0/${CFG.waPhoneId}/messages`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + CFG.waToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: recipient, type: 'text', text: { body: message } }),
    });
    const data = await r.json().catch(() => ({}));
    log('[WhatsApp]', recipient, r.status, JSON.stringify(data).slice(0, 200));
    return data;
  } catch (e) { log('[WhatsApp error]', e.message); return { error: e.message }; }
}

async function notifyBoth(to, message) {
  await Promise.all([sendSMS(to, message), sendWhatsApp(to, message)]);
}

function trackLink(o) { return `${CFG.baseUrl}/track?id=${o.id}`; }
function orderSummary(o) {
  const fulfil = o.fulfilment === 'delivery' ? `Delivery to: ${o.address}` : 'Pickup';
  return `${o.qty} x ${CFG.productName} = ${money(o.amount)}. ${fulfil}.`;
}

const STATUS_FLOW = ['placed', 'accepted', 'processing', 'ready', 'delivered', 'completed', 'cancelled'];
const STATUS_LABEL = {
  pending_payment: 'Awaiting payment',
  placed: 'Order placed',
  accepted: 'Accepted',
  processing: 'Being processed',
  ready: 'Ready for pickup / delivery',
  delivered: 'Delivered – awaiting your confirmation',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

function clientMessage(o, status) {
  const t = trackLink(o);
  switch (status) {
    case 'placed':
      return `Hi ${o.name}, your ${CFG.businessName} order ${o.id} has been received. ${orderSummary(o)} Payment: ${o.payment.status}. Track it here: ${t}`;
    case 'accepted':
      return `Good news ${o.name}! ${CFG.businessName} has ACCEPTED your order ${o.id}. We'll update you as it progresses. ${t}`;
    case 'processing':
      return `${CFG.businessName}: your order ${o.id} is now being PROCESSED. ${t}`;
    case 'ready':
      return o.fulfilment === 'delivery'
        ? `${CFG.businessName}: your order ${o.id} is READY and out for delivery to ${o.address}. ${t}`
        : `${CFG.businessName}: your order ${o.id} is READY FOR PICKUP. Call ${CFG.contactPhone} to arrange. ${t}`;
    case 'delivered':
      return `${CFG.businessName}: order ${o.id} has been delivered. Please confirm you received it to close the order: ${t}`;
    case 'completed':
      return `Thank you ${o.name}! Order ${o.id} is now complete. We appreciate your purchase of ${CFG.productName}.`;
    case 'cancelled':
      return `${CFG.businessName}: order ${o.id} has been cancelled. Call ${CFG.contactPhone} if you have questions.`;
    default: return `${CFG.businessName}: order ${o.id} status: ${STATUS_LABEL[status] || status}. ${t}`;
  }
}
function ownerMessage(o, status) {
  const admin = `${CFG.baseUrl}/admin`;
  if (status === 'placed')
    return `NEW ORDER ${o.id}\n${o.name} (${o.phone})\n${orderSummary(o)}\nPayment: ${o.payment.status}${o.note ? '\nNote: ' + o.note : ''}\nManage: ${admin}`;
  if (status === 'completed')
    return `Order ${o.id} CLOSED – ${o.name} confirmed receipt of ${o.qty} x ${CFG.productName}.`;
  return `Order ${o.id} → ${STATUS_LABEL[status] || status}`;
}

async function setStatus(id, status, extra) {
  const o = updateOrder(id, (x) => {
    x.status = status;
    x.timeline.push({ status, at: new Date().toISOString(), ...(extra || {}) });
  });
  if (!o) return null;
  await notifyBoth(o.phone, clientMessage(o, status));
  if (status === 'placed' || status === 'completed') await notifyBoth(CFG.ownerPhone, ownerMessage(o, status));
  return o;
}

// ---------- Paystack ----------
async function paystackInit(o) {
  const r = await fetch('https://api.paystack.co/transaction/initialize', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + CFG.paystackSecret, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: o.email || `${normalizePhone(o.phone)}@lmj-orders.local`,
      amount: Math.round(o.amount * 100), // pesewas
      currency: 'GHS',
      reference: o.id + '-' + crypto.randomBytes(3).toString('hex'),
      callback_url: `${CFG.baseUrl}/pay/callback`,
      metadata: { order_id: o.id, customer_name: o.name, phone: o.phone },
      channels: ['card', 'mobile_money', 'bank_transfer'],
    }),
  });
  const data = await r.json();
  if (!data.status) throw new Error(data.message || 'Paystack initialize failed');
  return data.data; // { authorization_url, reference }
}
async function paystackVerify(reference) {
  const r = await fetch('https://api.paystack.co/transaction/verify/' + encodeURIComponent(reference), {
    headers: { Authorization: 'Bearer ' + CFG.paystackSecret },
  });
  const data = await r.json();
  return data.status ? data.data : null;
}
async function markPaid(orderId, reference, channel) {
  const o = findOrder(orderId);
  if (!o) return null;
  if (o.payment.status === 'paid') return o;
  updateOrder(orderId, (x) => { x.payment = { ...x.payment, status: 'paid', reference, channel, paidAt: new Date().toISOString() }; });
  return setStatus(orderId, 'placed', { reference });
}

// ---------- routes ----------
async function handleApi(req, res, url) {
  const p = url.pathname;

  // Public config for the order page
  if (req.method === 'GET' && p === '/api/config') {
    return json(res, 200, {
      price: CFG.price, deliveryFee: CFG.deliveryFee, productName: CFG.productName,
      ownerPhone: CFG.contactPhone, ownerWhatsApp: normalizePhone(CFG.contactPhone),
      paystack: !!CFG.paystackSecret, businessName: CFG.businessName,
    });
  }

  // Create order
  if (req.method === 'POST' && p === '/api/orders') {
    let b; try { b = JSON.parse(await readBody(req) || '{}'); } catch { return json(res, 400, { error: 'Invalid JSON' }); }
    const name = String(b.name || '').trim();
    const phone = String(b.phone || '').trim();
    const qty = Math.max(1, Math.min(500, parseInt(b.qty, 10) || 1));
    const fulfilment = b.fulfilment === 'delivery' ? 'delivery' : 'pickup';
    const address = String(b.address || '').trim();
    if (name.length < 2) return json(res, 400, { error: 'Please enter your name.' });
    if (normalizePhone(phone).length < 12) return json(res, 400, { error: 'Please enter a valid Ghana phone number (e.g. 0241234567).' });
    if (fulfilment === 'delivery' && address.length < 5) return json(res, 400, { error: 'Please enter a delivery address.' });

    const amount = qty * CFG.price + (fulfilment === 'delivery' ? CFG.deliveryFee : 0);
    const now = new Date().toISOString();
    const order = {
      id: newOrderId(), name, phone, email: String(b.email || '').trim(), qty, fulfilment, address,
      note: String(b.note || '').trim().slice(0, 300), unitPrice: CFG.price, amount,
      status: 'pending_payment', payment: { status: 'unpaid', method: 'paystack' },
      timeline: [{ status: 'pending_payment', at: now }], createdAt: now, updatedAt: now,
    };
    const orders = loadOrders(); orders.push(order); saveOrders(orders);

    if (CFG.paystackSecret) {
      try {
        const init = await paystackInit(order);
        updateOrder(order.id, (x) => { x.payment.reference = init.reference; });
        return json(res, 200, { orderId: order.id, paymentUrl: init.authorization_url });
      } catch (e) {
        log('[Paystack init error]', e.message);
        return json(res, 502, { error: 'Payment could not be started. Please try again or call ' + CFG.contactPhone });
      }
    }
    // Paystack not configured yet → place the order directly (owner collects payment manually)
    updateOrder(order.id, (x) => { x.payment.status = 'pay on pickup/delivery'; });
    await setStatus(order.id, 'placed');
    return json(res, 200, { orderId: order.id, paymentUrl: null, trackUrl: `/track?id=${order.id}` });
  }

  // Public: get one order (requires matching phone)
  const mGet = p.match(/^\/api\/orders\/([A-Z0-9-]+)$/);
  if (req.method === 'GET' && mGet) {
    const o = findOrder(mGet[1]);
    if (!o) return json(res, 404, { error: 'Order not found' });
    const ph = url.searchParams.get('phone');
    if (ph && normalizePhone(ph) !== normalizePhone(o.phone)) return json(res, 403, { error: 'Phone number does not match this order.' });
    return json(res, 200, { ...o, statusLabel: STATUS_LABEL[o.status], ownerWhatsApp: normalizePhone(CFG.contactPhone), ownerPhone: CFG.contactPhone, productName: CFG.productName });
  }

  // Public: customer confirms delivery → closes order
  const mConfirm = p.match(/^\/api\/orders\/([A-Z0-9-]+)\/confirm$/);
  if (req.method === 'POST' && mConfirm) {
    let b; try { b = JSON.parse(await readBody(req) || '{}'); } catch { b = {}; }
    const o = findOrder(mConfirm[1]);
    if (!o) return json(res, 404, { error: 'Order not found' });
    if (normalizePhone(b.phone) !== normalizePhone(o.phone)) return json(res, 403, { error: 'Phone number does not match this order.' });
    if (!['ready', 'delivered'].includes(o.status)) return json(res, 400, { error: 'This order is not ready to be confirmed yet.' });
    const done = await setStatus(o.id, 'completed', { confirmedByCustomer: true });
    return json(res, 200, { ok: true, order: done });
  }

  // Paystack webhook
  if (req.method === 'POST' && p === '/api/paystack/webhook') {
    const raw = await readBody(req);
    const sig = crypto.createHmac('sha512', CFG.paystackSecret).update(raw).digest('hex');
    if (sig !== req.headers['x-paystack-signature']) return json(res, 401, { error: 'bad signature' });
    const ev = JSON.parse(raw);
    if (ev.event === 'charge.success') {
      const orderId = ev.data.metadata && ev.data.metadata.order_id;
      if (orderId) await markPaid(orderId, ev.data.reference, ev.data.channel);
    }
    return json(res, 200, { received: true });
  }

  // Admin
  if (p.startsWith('/api/admin/')) {
    if (req.headers['x-admin-key'] !== CFG.adminKey) return json(res, 401, { error: 'Unauthorized' });
    if (req.method === 'GET' && p === '/api/admin/orders') {
      const list = loadOrders().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return json(res, 200, { orders: list, statuses: STATUS_FLOW, labels: STATUS_LABEL, ownerPhone: CFG.ownerPhone });
    }
    const mStatus = p.match(/^\/api\/admin\/orders\/([A-Z0-9-]+)\/status$/);
    if (req.method === 'POST' && mStatus) {
      let b; try { b = JSON.parse(await readBody(req) || '{}'); } catch { b = {}; }
      if (!STATUS_FLOW.includes(b.status)) return json(res, 400, { error: 'Invalid status' });
      const o = await setStatus(mStatus[1], b.status, { by: 'owner' });
      if (!o) return json(res, 404, { error: 'Order not found' });
      return json(res, 200, { ok: true, order: o });
    }
    const mPaid = p.match(/^\/api\/admin\/orders\/([A-Z0-9-]+)\/mark-paid$/);
    if (req.method === 'POST' && mPaid) {
      const o = updateOrder(mPaid[1], (x) => { x.payment.status = 'paid'; x.payment.method = 'manual'; x.payment.paidAt = new Date().toISOString(); });
      if (!o) return json(res, 404, { error: 'Order not found' });
      if (o.status === 'pending_payment') await setStatus(o.id, 'placed');
      return json(res, 200, { ok: true });
    }
  }
  return json(res, 404, { error: 'Not found' });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
function serveStatic(res, file) {
  const full = path.join(PUBLIC_DIR, file);
  if (!full.startsWith(PUBLIC_DIR) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
  fs.createReadStream(full).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, CFG.baseUrl);
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);

    if (url.pathname === '/pay/callback') {
      const ref = url.searchParams.get('reference') || url.searchParams.get('trxref');
      const v = ref && CFG.paystackSecret ? await paystackVerify(ref) : null;
      if (v && v.status === 'success' && v.metadata && v.metadata.order_id) {
        await markPaid(v.metadata.order_id, ref, v.channel);
        return redirect(res, `/track?id=${v.metadata.order_id}&paid=1`);
      }
      const orderId = ref ? ref.split('-').slice(0, 2).join('-') : '';
      return redirect(res, `/track?id=${orderId}&paid=0`);
    }

    if (url.pathname === '/') return serveStatic(res, 'index.html');
    if (url.pathname === '/track') return serveStatic(res, 'track.html');
    if (url.pathname === '/admin') return serveStatic(res, 'admin.html');
    return serveStatic(res, url.pathname.slice(1));
  } catch (e) {
    log('[error]', e);
    json(res, 500, { error: 'Server error' });
  }
});

server.listen(CFG.port, () => {
  log(`LMJ order site running at ${CFG.baseUrl}`);
  log(`SMS (mNotify): ${CFG.mnotifyKey ? 'ON' : 'OFF – set MNOTIFY_API_KEY'} | Paystack: ${CFG.paystackSecret ? 'ON' : 'OFF – set PAYSTACK_SECRET_KEY'} | WhatsApp API: ${CFG.waToken ? 'ON' : 'OFF (wa.me links used)'}`);
});
