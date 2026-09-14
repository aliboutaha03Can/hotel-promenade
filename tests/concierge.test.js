const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const dbPath = path.join(os.tmpdir(), `hotel-promenade-concierge-test-${Date.now()}.db`);

let telegramCalls = [];
let telegramServer;
let listener;
let baseUrl;
let mockBase;
let serverModule;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function futureDate(days = 30) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

function collectRequestBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

async function api(pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, options);
  const contentType = response.headers.get('content-type') || '';
  const body = contentType.includes('application/json') ? await response.json() : await response.text();
  return { response, body };
}

async function login(email, password) {
  for (let attempt = 0; attempt < 15; attempt++) {
    const result = await api('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    if (result.response.status === 200) {
      return result.body.token;
    }
    await wait(200);
  }
  const finalResult = await api('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  assert.equal(finalResult.response.status, 200, JSON.stringify(finalResult.body));
  return finalResult.body.token;
}

test.before(async () => {
  telegramServer = http.createServer(async (req, res) => {
    const body = await collectRequestBody(req);
    telegramCalls.push({ url: req.url, body: body.toString('utf8') });
    res.writeHead(200, { 'Content-Type': 'application/json' });

    if (req.url.includes('/getUpdates')) {
      res.end(JSON.stringify({ ok: true, result: [] }));
      return;
    }

    if (req.url.includes('/sendMessage')) {
      res.end(JSON.stringify({ ok: true, result: { message_id: 101 } }));
      return;
    }

    if (req.url.includes('/sendAudio')) {
      res.end(JSON.stringify({ ok: true, result: { message_id: 202 } }));
      return;
    }

    res.end(JSON.stringify({ ok: true, result: {} }));
  });

  await new Promise((resolve) => telegramServer.listen(0, '127.0.0.1', resolve));
  const telegramAddress = telegramServer.address();
  mockBase = `http://127.0.0.1:${telegramAddress.port}`;

  process.env.JWT_SECRET = 'hotel-promenade-concierge-test-secret-123456789';
  process.env.DB_PATH = dbPath;
  process.env.BOOTSTRAP_ADMIN_EMAIL = 'admin@lapromenade.com';
  process.env.BOOTSTRAP_ADMIN_PASSWORD = 'AdminTestPass123!';
  process.env.ENABLE_DEMO_USERS = 'false';
  process.env.TELEGRAM_BOT_TOKEN = 'test-concierge-bot-token';
  process.env.TELEGRAM_ADMIN_CHAT_ID = '123456';
  process.env.TELEGRAM_API_BASE = mockBase;
  process.env.CONCIERGE_TIMEZONE = 'America/Toronto';

  serverModule = require('../server.js');
  listener = serverModule.startServer(0);
  await wait(1200);
  const address = listener.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

test.after(async () => {
  await serverModule.conciergeTelegram.stop();
  await new Promise((resolve) => listener.close(resolve));
  await new Promise((resolve) => telegramServer.close(resolve));
  await new Promise((resolve, reject) => {
    serverModule.db.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
  fs.rmSync(dbPath, { force: true });
});

test('admin concierge debrief sends Telegram summary and French audio', { timeout: 120000 }, async () => {
  const adminToken = await login('admin@lapromenade.com', 'AdminTestPass123!');
  const eventDate = futureDate(30);

  const createEvent = await api('/api/events', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${adminToken}`
    },
    body: JSON.stringify({
      name: 'Gala Telegram Test',
      type: 'Gala',
      date: eventDate,
      time: '18:00',
      endTime: '23:00',
      contact: 'client@example.com'
    })
  });
  assert.equal(createEvent.response.status, 201, JSON.stringify(createEvent.body));

  const roomList = await api('/api/rooms', {
    headers: { 'Authorization': `Bearer ${adminToken}` }
  });
  assert.equal(roomList.response.status, 200);
  const roomId = roomList.body.rooms[0].id;

  const reserve = await api('/api/rooms/reserve', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${adminToken}`
    },
    body: JSON.stringify({
      roomId,
      eventId: createEvent.body.id,
      date: eventDate,
      startTime: '18:00',
      endTime: '23:00'
    })
  });
  assert.equal(reserve.response.status, 201, JSON.stringify(reserve.body));

  const invoice = await api(`/api/invoices/generate/${createEvent.body.id}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${adminToken}`
    },
    body: JSON.stringify({ client: 'Client Telegram' })
  });
  assert.equal(invoice.response.status, 201, JSON.stringify(invoice.body));

  const pay = await api(`/api/invoices/${invoice.body.id}/pay`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${adminToken}`
    },
    body: JSON.stringify({ method: 'Carte' })
  });
  assert.equal(pay.response.status, 200, JSON.stringify(pay.body));

  const debrief = await api('/api/concierge/debrief', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${adminToken}`
    },
    body: JSON.stringify({ date: eventDate })
  });

  assert.equal(debrief.response.status, 200, JSON.stringify(debrief.body));
  assert.equal(debrief.body.ok, true);
  assert.match(debrief.body.script, /Gala Telegram Test/i);
  assert.ok(fs.existsSync(debrief.body.audioPath), 'Expected generated audio file');
  assert.ok(telegramCalls.some((entry) => entry.url.includes('/sendMessage')), 'Telegram sendMessage was not called');
  assert.ok(telegramCalls.some((entry) => entry.url.includes('/sendAudio')), 'Telegram sendAudio was not called');
});
