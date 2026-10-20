// LMJ – online order site
// Zero-dependency Node.js server (Node 18+). Run with:  node server.js
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

// ---------- config (.env) ----------
loadEnv(path.join(__dirname, '.env'));
const ENV = {
  port: Number(process.env.PORT || 3000),
  baseUrl: (process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, ''),
  adminKey: process.env.ADMIN_KEY || 'change-me',
  mnotifyKey: process.env.MNOTIFY_API_KEY || '',
  mnotifySender: process.env.MNOTIFY_SENDER_ID || 'LMJ',
  paystackSecret: process.env.PAYSTACK_SECRET_KEY || '',
  waToken: process.env.WHATSAPP_TOKEN || '',
  waPhoneId: process.env.WHATSAPP_PHONE_ID || '',
};
const DATA_DIR = path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const FILES = {
  orders: path.join(DATA_DIR, 'orders.json'),
  products: path.join(DATA_DIR, 'products.json'),
  settings: path.join(DATA_DIR, 'settings.json'),
};

// Defaults used the first time (and as fallback). The owner edits these from /admin → Settings.
const DEFAULT_SETTINGS = {
  businessName: process.env.BUSINESS_NAME || 'LMJ',
  tagline: 'Kills 99.9% germs',
  ownerPhone: process.env.OWNER_PHONE || '0558527351',      // receives order alerts (SMS + WhatsApp)
  callPhone: process.env.CONTACT_PHONE || '0535623533',    // "Call to order" button
  whatsappPhone: process.env.CONTACT_PHONE || '0535623533',// "Chat on WhatsApp" button
  deliveryFee: Number(process.env.DELIVERY_FEE || 0),
  pickupInfo: '',                                          // e.g. "Pickup at Madina, near the market, 8am–6pm"
  footerNote: 'Keep out of reach of children. Use as directed.',
};
const DEFAULT_PRODUCTS = [{
  id: 'lmj-pink-blossom', name: 'LMJ Surface Disinfectant – Pink Blossom', size: '100ml',
  price: Number(process.env.PRODUCT_PRICE || 25), description: 'Kills 99.9% germs. Spray evenly on the surface and allow to air-dry for 30 seconds. Perfect for chairs, handles, toilet seats, tables & more.',
  image: '/product.jpg', active: true, sort: 1,
}];

// ---------- tiny JSON store ----------
function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function writeJson(file, data) { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(file, JSON.stringify(data, null, 2)); }
const loadOrders = () => readJson(FILES.orders, []);
const saveOrders = (o) => writeJson(FILES.orders, o);
const loadProducts = () => readJson(FILES.products, DEFAULT_PRODUCTS);
const saveProducts = (p) => writeJson(FILES.products, p);
const loadSettings = () => ({ ...DEFAULT_SETTINGS, ...readJson(FILES.settings, {}) });
const saveSettings = (s) => writeJson(FILES.settings, s);

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
function newOrderId() { return 'LMJ-' + crypto.randomBytes(2).toString('hex').toUpperCase() + Date.now().toString().slice(-4); }
function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'item'; }
function json(res, code, body) { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); }
function redirect(res, to) { res.writeHead(302, { Location: to }); res.end(); }
function readBody(req, limit = 6 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let raw = ''; let size = 0;
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('Body too large')); req.destroy(); } raw += c; });
    req.on('end', () => resolve(raw));
  });
}
async function readJsonBody(req) { try { return JSON.parse(await readBody(req) || '{}'); } catch { return null; } }
function log(...a) { console.log(new Date().toISOString(), ...a); }

// ---------- messaging ----------
async function sendSMS(to, message) {
  const recipient = normalizePhone(to);
  if (!ENV.mnotifyKey) { log('[SMS not configured] →', recipient, '|', message); return { mock: true }; }
  try {
    const r = await fetch('https://api.mnotify.com/api/sms/quick?key=' + encodeURIComponent(ENV.mnotifyKey), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient: [recipient], sender: ENV.mnotifySender, message, is_schedule: 'false', schedule_date: '' }),
    });
    const data = await r.json().catch(() => ({}));
    log('[mNotify]', recipient, r.status, JSON.stringify(data).slice(0, 200));
    return data;
  } catch (e) { log('[mNotify error]', e.message); return { error: e.message }; }
}
async function sendWhatsApp(to, message) {
  const recipient = normalizePhone(to);
  if (!ENV.waToken || !ENV.waPhoneId) { log('[WhatsApp API not configured] →', recipient, '|', message); return { mock: true }; }
  try {
    const r = await fetch(`https://graph.facebook.com/v20.0/${ENV.waPhoneId}/messages`, {
      method: 'POST', headers: { Authorization: 'Bearer ' + ENV.waToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: recipient, type: 'text', text: { body: message } }),
    });
    const data = await r.json().catch(() => ({}));
    log('[WhatsApp]', recipient, r.status, JSON.stringify(data).slice(0, 200));
    return data;
  } catch (e) { log('[WhatsApp error]', e.message); return { error: e.message }; }
}
async function notifyBoth(to, message) { await Promise.all([sendSMS(to, message), sendWhatsApp(to, message)]); }

function trackLink(o) { return `${ENV.baseUrl}/track?id=${o.id}`; }
function itemsText(o) { return o.items.map(i => `${i.qty} x ${i.name}`).join(', '); }
function orderSummary(o) {
  const fulfil = o.fulfilment === 'delivery' ? `Delivery to: ${o.address}` : 'Pickup';
  return `${itemsText(o)} = ${money(o.amount)}. ${fulfil}.`;
}

const STATUS_FLOW = ['placed', 'accepted', 'processing', 'ready', 'delivered', 'completed', 'cancelled'];
const STATUS_LABEL = {
  pending_payment: 'Awaiting payment', placed: 'Order placed', accepted: 'Accepted', processing: 'Being processed',
  ready: 'Ready for pickup / delivery', delivered: 'Delivered – awaiting your confirmation', completed: 'Completed', cancelled: 'Cancelled',
};

function clientMessage(o, status, S) {
  const t = trackLink(o); const B = S.businessName;
  switch (status) {
    case 'placed': return `Hi ${o.name}, your ${B} order ${o.id} has been received. ${orderSummary(o)} Payment: ${o.payment.status}. Track it here: ${t}`;
    case 'accepted': return `Good news ${o.name}! ${B} has ACCEPTED your order ${o.id}. We'll update you as it progresses. ${t}`;
    case 'processing': return `${B}: your order ${o.id} is now being PROCESSED. ${t}`;
    case 'ready': return o.fulfilment === 'delivery'
      ? `${B}: your order ${o.id} is READY and out for delivery to ${o.address}. ${t}`
      : `${B}: your order ${o.id} is READY FOR PICKUP.${S.pickupInfo ? ' ' + S.pickupInfo + '.' : ''} Call ${S.callPhone} to arrange. ${t}`;
    case 'delivered': return `${B}: order ${o.id} has been delivered. Please confirm you received it to close the order: ${t}`;
    case 'completed': return `Thank you ${o.name}! Order ${o.id} is now complete. We appreciate your purchase from ${B}.`;
    case 'cancelled': return `${B}: order ${o.id} has been cancelled. Call ${S.callPhone} if you have questions.`;
    default: return `${B}: order ${o.id} status: ${STATUS_LABEL[status] || status}. ${t}`;
  }
}
function ownerMessage(o, status) {
  if (status === 'placed')
    return `NEW ORDER ${o.id}\n${o.name} (${o.phone})\n${orderSummary(o)}\nPayment: ${o.payment.status}${o.note ? '\nNote: ' + o.note : ''}\nManage: ${ENV.baseUrl}/admin`;
  if (status === 'completed') return `Order ${o.id} CLOSED – ${o.name} confirmed receipt of ${itemsText(o)}.`;
  return `Order ${o.id} → ${STATUS_LABEL[status] || status}`;
}

async function setStatus(id, status, extra) {
  const S = loadSettings();
  const o = updateOrder(id, (x) => { x.status = status; x.timeline.push({ status, at: new Date().toISOString(), ...(extra || {}) }); });
  if (!o) return null;
  await notifyBoth(o.phone, clientMessage(o, status, S));
  if (status === 'placed' || status === 'completed') await notifyBoth(S.ownerPhone, ownerMessage(o, status));
  return o;
}

// ---------- Paystack ----------
async function paystackInit(o) {
  const r = await fetch('https://api.paystack.co/transaction/initialize', {
    method: 'POST', headers: { Authorization: 'Bearer ' + ENV.paystackSecret, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: o.email || `${normalizePhone(o.phone)}@lmj-orders.local`, amount: Math.round(o.amount * 100), currency: 'GHS',
      reference: o.id + '-' + crypto.randomBytes(3).toString('hex'), callback_url: `${ENV.baseUrl}/pay/callback`,
      metadata: { order_id: o.id, customer_name: o.name, phone: o.phone }, channels: ['card', 'mobile_money', 'bank_transfer'],
    }),
  });
  const data = await r.json();
  if (!data.status) throw new Error(data.message || 'Paystack initialize failed');
  return data.data;
}
async function paystackVerify(reference) {
  const r = await fetch('https://api.paystack.co/transaction/verify/' + encodeURIComponent(reference), { headers: { Authorization: 'Bearer ' + ENV.paystackSecret } });
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

// ---------- public config ----------
function publicConfig() {
  const S = loadSettings();
  return {
    businessName: S.businessName, tagline: S.tagline, deliveryFee: Number(S.deliveryFee) || 0, pickupInfo: S.pickupInfo, footerNote: S.footerNote,
    callPhone: S.callPhone, whatsappPhone: normalizePhone(S.whatsappPhone || S.callPhone), paystack: !!ENV.paystackSecret,
    products: loadProducts().filter(p => p.active !== false).sort((a, b) => (a.sort || 0) - (b.sort || 0)),
  };
}

// ---------- routes ----------
async function handleApi(req, res, url) {
  const p = url.pathname;

  if (req.method === 'GET' && p === '/api/config') return json(res, 200, publicConfig());

  // Create order
  if (req.method === 'POST' && p === '/api/orders') {
    const b = await readJsonBody(req); if (!b) return json(res, 400, { error: 'Invalid request' });
    const S = loadSettings();
    const products = loadProducts().filter(x => x.active !== false);
    const name = String(b.name || '').trim();
    const phone = String(b.phone || '').trim();
    const fulfilment = b.fulfilment === 'delivery' ? 'delivery' : 'pickup';
    const address = String(b.address || '').trim();
    if (name.length < 2) return json(res, 400, { error: 'Please enter your name.' });
    if (normalizePhone(phone).length < 12) return json(res, 400, { error: 'Please enter a valid Ghana phone number (e.g. 0241234567).' });
    if (fulfilment === 'delivery' && address.length < 5) return json(res, 400, { error: 'Please enter a delivery address.' });
    const items = [];
    for (const it of (Array.isArray(b.items) ? b.items : [])) {
      const prod = products.find(x => x.id === it.id);
      const qty = Math.max(0, Math.min(500, parseInt(it.qty, 10) || 0));
      if (prod && qty > 0) items.push({ id: prod.id, name: prod.name + (prod.size ? ` (${prod.size})` : ''), unitPrice: Number(prod.price), qty });
    }
    if (!items.length) return json(res, 400, { error: 'Please choose at least one product.' });
    const subtotal = items.reduce((s, i) => s + i.unitPrice * i.qty, 0);
    const deliveryFee = fulfilment === 'delivery' ? (Number(S.deliveryFee) || 0) : 0;
    const amount = +(subtotal + deliveryFee).toFixed(2);
    const now = new Date().toISOString();
    const order = {
      id: newOrderId(), name, phone, email: String(b.email || '').trim(), items, qty: items.reduce((s, i) => s + i.qty, 0),
      fulfilment, address, note: String(b.note || '').trim().slice(0, 300), subtotal, deliveryFee, amount,
      status: 'pending_payment', payment: { status: 'unpaid', method: 'paystack' }, timeline: [{ status: 'pending_payment', at: now }], createdAt: now, updatedAt: now,
    };
    const orders = loadOrders(); orders.push(order); saveOrders(orders);

    if (ENV.paystackSecret) {
      try {
        const init = await paystackInit(order);
        updateOrder(order.id, (x) => { x.payment.reference = init.reference; });
        return json(res, 200, { orderId: order.id, paymentUrl: init.authorization_url });
      } catch (e) {
        log('[Paystack init error]', e.message);
        return json(res, 502, { error: 'Payment could not be started. Please try again or call ' + S.callPhone });
      }
    }
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
    const S = loadSettings();
    return json(res, 200, { ...o, statusLabel: STATUS_LABEL[o.status], ownerWhatsApp: normalizePhone(S.whatsappPhone || S.callPhone), ownerPhone: S.callPhone, businessName: S.businessName });
  }

  // Public: customer confirms delivery → closes order
  const mConfirm = p.match(/^\/api\/orders\/([A-Z0-9-]+)\/confirm$/);
  if (req.method === 'POST' && mConfirm) {
    const b = (await readJsonBody(req)) || {};
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
    const sig = crypto.createHmac('sha512', ENV.paystackSecret).update(raw).digest('hex');
    if (sig !== req.headers['x-paystack-signature']) return json(res, 401, { error: 'bad signature' });
    const ev = JSON.parse(raw);
    if (ev.event === 'charge.success') {
      const orderId = ev.data.metadata && ev.data.metadata.order_id;
      if (orderId) await markPaid(orderId, ev.data.reference, ev.data.channel);
    }
    return json(res, 200, { received: true });
  }

  // ---------- Admin ----------
  if (p.startsWith('/api/admin/')) {
    if (req.headers['x-admin-key'] !== ENV.adminKey) return json(res, 401, { error: 'Unauthorized' });

    // Orders
    if (req.method === 'GET' && p === '/api/admin/orders') {
      const list = loadOrders().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return json(res, 200, { orders: list, statuses: STATUS_FLOW, labels: STATUS_LABEL, settings: loadSettings() });
    }
    const mStatus = p.match(/^\/api\/admin\/orders\/([A-Z0-9-]+)\/status$/);
    if (req.method === 'POST' && mStatus) {
      const b = (await readJsonBody(req)) || {};
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

    // Settings
    if (req.method === 'GET' && p === '/api/admin/settings') return json(res, 200, loadSettings());
    if (req.method === 'PUT' && p === '/api/admin/settings') {
      const b = await readJsonBody(req); if (!b) return json(res, 400, { error: 'Invalid request' });
      const S = loadSettings();
      for (const k of Object.keys(DEFAULT_SETTINGS)) if (k in b) S[k] = k === 'deliveryFee' ? Math.max(0, Number(b[k]) || 0) : String(b[k]).trim().slice(0, 300);
      if (normalizePhone(S.ownerPhone).length < 12) return json(res, 400, { error: 'Owner alert number is not a valid Ghana number.' });
      saveSettings(S);
      return json(res, 200, S);
    }

    // Products
    if (req.method === 'GET' && p === '/api/admin/products') return json(res, 200, loadProducts().sort((a, b) => (a.sort || 0) - (b.sort || 0)));
    if (req.method === 'POST' && p === '/api/admin/products') {
      const b = await readJsonBody(req); if (!b) return json(res, 400, { error: 'Invalid request' });
      const products = loadProducts();
      const name = String(b.name || '').trim();
      const price = Number(b.price);
      if (name.length < 2) return json(res, 400, { error: 'Product name is required.' });
      if (!(price >= 0)) return json(res, 400, { error: 'Enter a valid price.' });
      let prod = b.id ? products.find(x => x.id === b.id) : null;
      if (!prod) {
        let id = slug(name); let n = 1; while (products.some(x => x.id === id)) id = slug(name) + '-' + (++n);
        prod = { id, sort: products.length + 1, active: true, image: '' };
        products.push(prod);
      }
      Object.assign(prod, {
        name, price, size: String(b.size || '').trim().slice(0, 40), description: String(b.description || '').trim().slice(0, 600),
        active: b.active !== false && b.active !== 'false',
        sort: Number(b.sort) || prod.sort,
      });
      if (typeof b.image === 'string' && (b.image.startsWith('data:image/') || b.image.startsWith('/') || b.image === '')) {
        if (b.image.length > 1.5 * 1024 * 1024) return json(res, 400, { error: 'Image is too large. Please use a smaller photo.' });
        prod.image = b.image;
      }
      saveProducts(products);
      return json(res, 200, prod);
    }
    const mDel = p.match(/^\/api\/admin\/products\/([a-z0-9-]+)$/);
    if (req.method === 'DELETE' && mDel) {
      const products = loadProducts();
      const i = products.findIndex(x => x.id === mDel[1]);
      if (i < 0) return json(res, 404, { error: 'Product not found' });
      products.splice(i, 1); saveProducts(products);
      return json(res, 200, { ok: true });
    }

    // Backup / restore (settings + products + orders)
    if (req.method === 'GET' && p === '/api/admin/backup') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="lmj-backup-${new Date().toISOString().slice(0, 10)}.json"` });
      return res.end(JSON.stringify({ exportedAt: new Date().toISOString(), settings: loadSettings(), products: loadProducts(), orders: loadOrders() }, null, 2));
    }
    if (req.method === 'POST' && p === '/api/admin/restore') {
      const b = await readJsonBody(req); if (!b || typeof b !== 'object') return json(res, 400, { error: 'Invalid backup file' });
      if (b.settings) saveSettings({ ...DEFAULT_SETTINGS, ...b.settings });
      if (Array.isArray(b.products)) saveProducts(b.products);
      if (Array.isArray(b.orders)) { const cur = loadOrders(); const ids = new Set(cur.map(o => o.id)); saveOrders(cur.concat(b.orders.filter(o => !ids.has(o.id)))); }
      return json(res, 200, { ok: true });
    }
  }
  return json(res, 404, { error: 'Not found' });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp' };
function serveStatic(res, file) {
  const full = path.join(PUBLIC_DIR, file);
  if (!full.startsWith(PUBLIC_DIR) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
  fs.createReadStream(full).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, ENV.baseUrl);
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (url.pathname === '/pay/callback') {
      const ref = url.searchParams.get('reference') || url.searchParams.get('trxref');
      const v = ref && ENV.paystackSecret ? await paystackVerify(ref) : null;
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
  } catch (e) { log('[error]', e); json(res, 500, { error: 'Server error' }); }
});

server.listen(ENV.port, () => {
  log(`${loadSettings().businessName} order site running at ${ENV.baseUrl}`);
  log(`SMS (mNotify): ${ENV.mnotifyKey ? 'ON' : 'OFF – set MNOTIFY_API_KEY'} | Paystack: ${ENV.paystackSecret ? 'ON' : 'OFF – set PAYSTACK_SECRET_KEY'} | WhatsApp API: ${ENV.waToken ? 'ON' : 'OFF (wa.me links used)'}`);
});
