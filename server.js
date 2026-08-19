const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const outputRoot = __dirname;
const port = Number(process.env.PORT || 4173);
const pendingOrders = new Map();

function loadEnvFile() {
  const envPath = path.join(outputRoot, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
}

loadEnvFile();

function clean(value, maxLength = 120) {
  return String(value || '').replace(/[<>]/g, '').trim().slice(0, maxLength);
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  response.end(body);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });
}

function razorpayRequest(payload) {
  return new Promise((resolve, reject) => {
    const credentials = Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString('base64');
    const request = https.request({
      hostname: 'api.razorpay.com',
      path: '/v1/orders',
      method: 'POST',
      headers: { Authorization: `Basic ${credentials}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(JSON.stringify(payload)) }
    }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(body); } catch { reject(new Error('Invalid Razorpay response.')); return; }
        if (response.statusCode < 200 || response.statusCode >= 300) { reject(new Error(parsed.error?.description || 'Razorpay order creation failed.')); return; }
        resolve(parsed);
      });
    });
    request.on('error', reject);
    request.write(JSON.stringify(payload));
    request.end();
  });
}

async function createRazorpayOrder(request, response) {
  if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
    sendJson(response, 503, { message: 'Razorpay is not configured. Add RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET to outputs/.env.' });
    return;
  }
  let payload;
  try { payload = JSON.parse(await readBody(request)); } catch { sendJson(response, 400, { message: 'Invalid order request.' }); return; }
  const amount = Number(payload.amount);
  const phone = clean(payload.phone, 15);
  const email = clean(payload.email, 160);
  if (!Number.isInteger(amount) || amount < 100 || !/^\d{10}$/.test(phone) || !email.includes('@')) {
    sendJson(response, 400, { message: 'Please provide a valid amount, phone number, and email.' });
    return;
  }
  const receipt = `RIR${Date.now()}`;
  try {
    const razorpayOrder = await razorpayRequest({ amount, currency: 'INR', receipt, notes: { hostel: clean(payload.hostel, 80), room: clean(payload.room, 40), items: clean(payload.items, 255) } });
    pendingOrders.set(razorpayOrder.id, { id: razorpayOrder.id, amount: razorpayOrder.amount, createdAt: Date.now() });
    sendJson(response, 200, { orderId: razorpayOrder.id, amount: razorpayOrder.amount, currency: razorpayOrder.currency, keyId: process.env.RAZORPAY_KEY_ID });
  } catch (error) {
    sendJson(response, 502, { message: error.message || 'Razorpay order creation failed.' });
  }
}

function signaturesMatch(expected, received) {
  const expectedBuffer = Buffer.from(expected, 'hex');
  const receivedBuffer = Buffer.from(String(received || ''), 'hex');
  return expectedBuffer.length === receivedBuffer.length && crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
}

async function verifyRazorpayPayment(request, response) {
  if (!process.env.RAZORPAY_KEY_SECRET) { sendJson(response, 503, { message: 'Razorpay is not configured.' }); return; }
  let payload;
  try { payload = JSON.parse(await readBody(request)); } catch { sendJson(response, 400, { message: 'Invalid verification request.' }); return; }
  const storedOrder = pendingOrders.get(clean(payload.orderId, 50));
  if (!storedOrder || !payload.paymentId || !payload.signature) { sendJson(response, 400, { verified: false, message: 'Payment order could not be verified.' }); return; }
  const expected = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(`${storedOrder.id}|${clean(payload.paymentId, 60)}`).digest('hex');
  const verified = signaturesMatch(expected, payload.signature);
  if (verified) pendingOrders.set(storedOrder.id, { ...storedOrder, paymentId: clean(payload.paymentId, 60), paidAt: new Date().toISOString() });
  sendJson(response, verified ? 200 : 400, { verified });
}

async function verifyWebhook(request, response) {
  const body = await readBody(request);
  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
  const received = request.headers['x-razorpay-signature'];
  if (!webhookSecret || !received) { response.writeHead(400); response.end('Invalid webhook'); return; }
  const expected = crypto.createHmac('sha256', webhookSecret).update(body).digest('hex');
  if (!signaturesMatch(expected, received)) { response.writeHead(400); response.end('Invalid webhook'); return; }
  response.writeHead(200); response.end('ok');
}

function serveStatic(request, response) {
  const requested = decodeURIComponent(new URL(request.url, `http://localhost:${port}`).pathname);
  const relative = requested === '/' ? 'index.html' : requested.replace(/^\/+/, '');
  const filePath = path.resolve(outputRoot, relative);
  if (!filePath.startsWith(outputRoot) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) { response.writeHead(404); response.end('Not found'); return; }
  const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8' };
  response.writeHead(200, { 'Content-Type': types[path.extname(filePath)] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(response);
}

const server = http.createServer(async (request, response) => {
  try {
    if (request.method === 'POST' && request.url === '/api/razorpay/create-order') { await createRazorpayOrder(request, response); return; }
    if (request.method === 'POST' && request.url === '/api/razorpay/verify-payment') { await verifyRazorpayPayment(request, response); return; }
    if (request.method === 'POST' && request.url === '/api/razorpay/webhook') { await verifyWebhook(request, response); return; }
    if (request.method === 'GET') { serveStatic(request, response); return; }
    response.writeHead(405); response.end('Method not allowed');
  } catch { sendJson(response, 500, { message: 'Payment server error.' }); }
});

server.listen(port, '0.0.0.0', () => console.log(`Rock In Roll running at http://localhost:${port}`));
