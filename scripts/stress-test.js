const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const dotenv = require('dotenv');

dotenv.config();

const liveTelegram = process.env.LIVE_TELEGRAM_STRESS === 'true';
const dbPath = path.join(os.tmpdir(), `hotel-promenade-stress-${Date.now()}.db`);
const testEventDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

let telegramServer = null;
let telegramCalls = [];
let listener = null;
let serverModule = null;
let baseUrl = null;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function collectRequestBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

async function startMockTelegram() {
  telegramServer = http.createServer(async (req, res) => {
    const body = await collectRequestBody(req);
    telegramCalls.push({
      url: req.url,
      body: body.toString('utf8')
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });

    if (req.url.includes('/getUpdates')) {
      res.end(JSON.stringify({ ok: true, result: [] }));
      return;
    }

    if (req.url.includes('/sendMessage')) {
      res.end(JSON.stringify({ ok: true, result: { message_id: 3001 } }));
      return;
    }

    if (req.url.includes('/sendAudio')) {
      res.end(JSON.stringify({ ok: true, result: { message_id: 3002 } }));
      return;
    }

    res.end(JSON.stringify({ ok: true, result: {} }));
  });

  await new Promise((resolve) => telegramServer.listen(0, '127.0.0.1', resolve));
  const address = telegramServer.address();
  process.env.TELEGRAM_API_BASE = `http://127.0.0.1:${address.port}`;
  process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || 'mock-telegram-token';
  process.env.TELEGRAM_ADMIN_CHAT_ID = process.env.TELEGRAM_ADMIN_CHAT_ID || '8656413450';
}

async function api(pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, options);
  const contentType = response.headers.get('content-type') || '';
  const body = contentType.includes('application/json') ? await response.json() : await response.text();
  return { response, body };
}

async function login(email, password) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const result = await api('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    if (result.response.status === 200) {
      return result.body.token;
    }
    await wait(250);
  }

  const result = await api('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  assert.equal(result.response.status, 200, `Login failed for ${email}: ${JSON.stringify(result.body)}`);
  return result.body.token;
}

async function main() {
  if (!liveTelegram) {
    await startMockTelegram();
  }

  process.env.DB_PATH = dbPath;
  process.env.PORT = '0';
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'hotel-promenade-stress-secret-123456789';
  process.env.BOOTSTRAP_ADMIN_EMAIL = process.env.BOOTSTRAP_ADMIN_EMAIL || 'admin@lapromenade.com';
  process.env.BOOTSTRAP_ADMIN_PASSWORD = process.env.BOOTSTRAP_ADMIN_PASSWORD || 'admin123';
  process.env.ENABLE_DEMO_USERS = 'true';
  process.env.DEMO_USER_PASSWORD = process.env.DEMO_USER_PASSWORD || 'admin123';
  process.env.CONCIERGE_TIMEZONE = process.env.CONCIERGE_TIMEZONE || 'America/Toronto';

  serverModule = require('../server.js');
  listener = serverModule.startServer(0);
  await wait(1500);
  baseUrl = `http://127.0.0.1:${listener.address().port}`;

  console.log(`[Stress] Server running at ${baseUrl}`);

  const homepage = await api('/');
  assert.equal(homepage.response.status, 200);
  for (const needle of ['page-dashboard', 'page-events', 'page-rooms', 'page-billing', 'page-reports', 'page-users']) {
    assert.match(homepage.body, new RegExp(needle), `Homepage missing ${needle}`);
  }

  const adminToken = await login(process.env.BOOTSTRAP_ADMIN_EMAIL, process.env.BOOTSTRAP_ADMIN_PASSWORD);
  const organizerToken = await login('organisateur@lapromenade.com', process.env.DEMO_USER_PASSWORD);
  const coordinatorToken = await login('coordonnateur@lapromenade.com', process.env.DEMO_USER_PASSWORD);
  const financeToken = await login('compta@lapromenade.com', process.env.DEMO_USER_PASSWORD);

  const newUser = await api('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fname: 'Stress',
      lname: 'User',
      email: `stress.user.${Date.now()}@example.com`,
      password: 'StressUserPass123!'
    })
  });
  assert.equal(newUser.response.status, 201, JSON.stringify(newUser.body));
  assert.equal(newUser.body.user.role, 'organisateur');

  const rooms = await api('/api/rooms', {
    headers: { Authorization: `Bearer ${organizerToken}` }
  });
  assert.equal(rooms.response.status, 200);
  assert.ok(Array.isArray(rooms.body.rooms) && rooms.body.rooms.length > 0, 'Expected seeded rooms');
  const room = rooms.body.rooms.find((candidate) => Number(candidate.capacity || 0) >= 120);
  assert.ok(room, 'Expected at least one seeded room with capacity for 120 guests');

  const createEvent = await api('/api/events', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${organizerToken}`
    },
    body: JSON.stringify({
      name: 'Soiree Signature Stress',
      type: 'Gala',
      date: testEventDate,
      time: '19:00',
      endTime: '23:00',
      organizer: 'Equipe Stress',
      contact: process.env.GMAIL_USER || 'client@example.com',
      budget: 12000,
      guests: 120
    })
  });
  assert.equal(createEvent.response.status, 201, JSON.stringify(createEvent.body));
  const eventId = createEvent.body.id;

  const reserveRoom = await api('/api/rooms/reserve', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${organizerToken}`
    },
    body: JSON.stringify({
      roomId: room.id,
      eventId,
      date: testEventDate,
      startTime: '19:00',
      endTime: '23:00'
    })
  });
  assert.equal(reserveRoom.response.status, 201, JSON.stringify(reserveRoom.body));

  const service = await api('/api/services', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${organizerToken}`
    },
    body: JSON.stringify({
      name: 'Traiteur Prestige',
      type: 'Restauration',
      detail: 'Menu degustation 5 services',
      eventId,
      cost: 1850
    })
  });
  assert.equal(service.response.status, 201, JSON.stringify(service.body));

  const invoice = await api(`/api/invoices/generate/${eventId}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${organizerToken}`
    },
    body: JSON.stringify({ client: process.env.GMAIL_USER || 'client@example.com' })
  });
  assert.equal(invoice.response.status, 201, JSON.stringify(invoice.body));
  const invoiceId = invoice.body.id;

  const sendInvoice = await api(`/api/invoices/${invoiceId}/send`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${organizerToken}`
    },
    body: JSON.stringify({ email: process.env.STRESS_TEST_EMAIL_RECIPIENT || process.env.GMAIL_USER })
  });
  assert.equal(sendInvoice.response.status, 200, JSON.stringify(sendInvoice.body));
  assert.ok(sendInvoice.body.messageId, 'Invoice email did not return a messageId');

  const payInvoice = await api(`/api/invoices/${invoiceId}/pay`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${organizerToken}`
    },
    body: JSON.stringify({ method: 'Carte' })
  });
  assert.equal(payInvoice.response.status, 200, JSON.stringify(payInvoice.body));

  const reservations = await api('/api/reservations', {
    headers: { Authorization: `Bearer ${coordinatorToken}` }
  });
  assert.equal(reservations.response.status, 200);
  assert.ok(reservations.body.reservations.some((entry) => entry.eventId === eventId), 'Reservation not visible to coordinator');

  const payments = await api('/api/payments', {
    headers: { Authorization: `Bearer ${financeToken}` }
  });
  assert.equal(payments.response.status, 200);
  assert.ok(payments.body.payments.some((entry) => entry.invoiceId === invoiceId), 'Payment not visible to finance');

  const summary = await api('/api/reports/summary', {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  assert.equal(summary.response.status, 200);
  assert.ok(summary.body.events.total >= 1, 'Summary did not count events');
  assert.ok(Number(summary.body.revenue.paid) > 0, 'Summary did not count paid revenue');

  for (const endpoint of ['/api/reports/events-by-type', '/api/reports/revenue-by-month', '/api/reports/room-occupancy', '/api/reports/services-cost']) {
    const report = await api(endpoint, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert.equal(report.response.status, 200, `Failed report endpoint ${endpoint}`);
  }

  const chat = await api('/api/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${adminToken}`
    },
    body: JSON.stringify({
      messages: [
        { role: 'user', content: 'Resume rapidement les activites et les salles disponibles aujourd hui.' }
      ]
    })
  });
  assert.equal(chat.response.status, 200, JSON.stringify(chat.body));
  assert.ok(typeof chat.body.reply === 'string' && chat.body.reply.trim(), 'AI reply missing');
  assert.ok(!/temporairement indisponible/i.test(chat.body.reply), `AI reply indicates failure: ${chat.body.reply}`);
  assert.ok(!/token|timeout|trop de temps|rate limit/i.test(chat.body.reply), `AI reply leaked provider failure language: ${chat.body.reply}`);

  const conciergeStatus = await api('/api/concierge/status', {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  assert.equal(conciergeStatus.response.status, 200, JSON.stringify(conciergeStatus.body));

  const debrief = await api('/api/concierge/debrief', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${adminToken}`
    },
    body: JSON.stringify({ date: testEventDate })
  });
  assert.equal(debrief.response.status, 200, JSON.stringify(debrief.body));
  assert.ok(fs.existsSync(debrief.body.audioPath), 'Concierge audio was not generated');
  assert.match(debrief.body.script, /Soiree Signature Stress/i);
  assert.match(debrief.body.script, new RegExp(room.name, 'i'));
  assert.match(debrief.body.script, /paiements confirmes aujourd'hui representent/i);

  if (!liveTelegram) {
    assert.ok(telegramCalls.some((entry) => entry.url.includes('/sendMessage')), 'Mock Telegram did not receive sendMessage');
    assert.ok(telegramCalls.some((entry) => entry.url.includes('/sendAudio')), 'Mock Telegram did not receive sendAudio');
  }

  console.log('[Stress] Auth, pages, bookings, services, invoices, email, payments, reports, AI, and concierge debrief all passed.');
  if (!liveTelegram) {
    console.log(`[Stress] Telegram was validated against a local mock server (${telegramCalls.length} calls captured).`);
  }
}

main()
  .catch((error) => {
    console.error('[Stress] FAILED:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await serverModule.conciergeTelegram.stop();
    } catch (_) {}

    try {
      if (listener) {
        await new Promise((resolve) => listener.close(resolve));
      }
    } catch (_) {}

    try {
      if (telegramServer) {
        await new Promise((resolve) => telegramServer.close(resolve));
      }
    } catch (_) {}

    try {
      if (serverModule.db) {
        await new Promise((resolve, reject) => {
          serverModule.db.close((err) => {
            if (err) reject(err);
            else resolve();
          });
        });
      }
    } catch (_) {}

    try {
      fs.rmSync(dbPath, { force: true });
    } catch (_) {}
  });
