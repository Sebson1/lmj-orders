# LMJ Surface Disinfectant – Online Order Site

A small website where customers order **LMJ Surface Disinfectant (Pink Blossom)**, pay online with **Paystack**, and get **SMS (mNotify) + WhatsApp** updates at every step. The owner gets every order by SMS/WhatsApp and manages it from a dashboard.

Share the site link on Facebook, Instagram, TikTok, WhatsApp status etc. — the page already carries a preview image and description for social media.

## Pages

| Page | Who | What it does |
|---|---|---|
| `/` | Customers | Product page + order form → Paystack payment |
| `/track?id=…` | Customers | Live order progress; **"I have received my order"** button closes the order |
| `/admin` | Owner | Password-protected dashboard: accept → processing → ready → delivered; mark paid; WhatsApp the customer |

## Order flow & messages

| Step | Who triggers it | Customer gets (SMS + WhatsApp) | Owner gets (SMS + WhatsApp) |
|---|---|---|---|
| Order placed & paid | Customer (Paystack) | "Order received…" + tracking link | "NEW ORDER … Manage: /admin" |
| Accepted | Owner (dashboard) | "Your order has been ACCEPTED" | – |
| Processing | Owner | "Your order is being PROCESSED" | – |
| Ready | Owner | "READY for pickup" / "out for delivery" | – |
| Delivered | Owner | "Please confirm you received it" + link | – |
| Completed | **Customer confirms** on `/track` | "Thank you, order complete" | "Order CLOSED – customer confirmed receipt" |

Every message includes the tracking link so the customer can always see where their order is.

## Setup (10 minutes)

1. **Install Node.js** (v18 or newer) from https://nodejs.org – nothing else to install, there are no dependencies.
2. Copy `.env.example` to `.env` and fill in:
   - `ADMIN_KEY` – a strong password for `/admin`
   - `OWNER_PHONE` – the number that receives orders (default `0535623533`)
   - `MNOTIFY_API_KEY` – from https://mnotify.com → Developer → API key. `MNOTIFY_SENDER_ID` must be a sender ID approved on your mNotify account (max 11 characters, e.g. `LMJ`).
   - `PAYSTACK_SECRET_KEY` – from https://dashboard.paystack.com → Settings → API Keys & Webhooks. Use the **test** key first (`sk_test_…`), then the **live** key.
   - `BASE_URL` – the public address of the site once hosted (e.g. `https://lmj.onrender.com`). This is used in the SMS tracking links and the Paystack return URL.
3. Run:
   ```
   node server.js
   ```
   Open http://localhost:3000.

### Paystack webhook (recommended)
In the Paystack dashboard → Settings → API Keys & Webhooks, set the webhook URL to
`https://YOUR-DOMAIN/api/paystack/webhook`. This makes sure an order is still marked paid even if the customer closes the browser before returning to the site.

### WhatsApp
Two options, both work out of the box:
- **Default (free):** the site uses `wa.me` links. The customer gets a "Chat on WhatsApp" / "Message seller" button that opens WhatsApp with the order details pre-filled, and the owner dashboard has a 💬 button to open a chat with the customer.
- **Automatic WhatsApp messages:** if you have a WhatsApp Business Cloud API account (Meta), set `WHATSAPP_TOKEN` and `WHATSAPP_PHONE_ID` in `.env` and the same messages that go by SMS will also be sent on WhatsApp automatically.

Until keys are added, SMS/WhatsApp messages are printed in the terminal instead of being sent, and orders are placed without online payment (marked "pay on pickup/delivery"), so you can test everything locally.

## Hosting (so the link works on social media)

Any Node host works. Easiest free/cheap options:
- **Render** (https://render.com): New → Web Service → upload/connect this folder → Start command `node server.js` → add the `.env` values under *Environment*. You get a `https://….onrender.com` link.
- **Railway**, **Fly.io**, or a small VPS (`node server.js` behind nginx) also work.

Orders are saved in `data/orders.json`. On hosts with a temporary filesystem (Render free tier), add a persistent disk mounted at `/data` or back the file up regularly.

## Changing price or product text
Edit `.env`: `PRODUCT_PRICE`, `DELIVERY_FEE`, `PRODUCT_NAME`, `BUSINESS_NAME`. The product picture is `public/product.jpg`.
