const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dotenv = require('dotenv');
const { chromium } = require('@playwright/test');

dotenv.config();

const dbPath = path.join(os.tmpdir(), `hotel-promenade-ui-master-${Date.now()}.db`);
const demoPassword = process.env.DEMO_USER_PASSWORD || 'admin123';
const bootstrapAdminEmail = process.env.BOOTSTRAP_ADMIN_EMAIL || 'admin@lapromenade.com';
const bootstrapAdminPassword = process.env.BOOTSTRAP_ADMIN_PASSWORD || 'admin123';

process.env.DB_PATH = dbPath;
process.env.PORT = '0';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'hotel-promenade-ui-master-secret-123456789';
process.env.BOOTSTRAP_ADMIN_EMAIL = bootstrapAdminEmail;
process.env.BOOTSTRAP_ADMIN_PASSWORD = bootstrapAdminPassword;
process.env.ENABLE_DEMO_USERS = 'true';
process.env.DEMO_USER_PASSWORD = demoPassword;

const serverModule = require('../server.js');

let listener;
let browser;
let page;
let baseUrl;
const runtimeIssues = [];

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function api(pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, options);
  const contentType = response.headers.get('content-type') || '';
  const body = contentType.includes('application/json') ? await response.json() : await response.text();
  return { response, body };
}

async function loginApi(email, password) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const result = await api('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    if (result.response.status === 200) return result.body.token;
    await wait(250);
  }
  const finalResult = await api('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  assert.equal(finalResult.response.status, 200, `Login failed for ${email}: ${JSON.stringify(finalResult.body)}`);
  return finalResult.body.token;
}

async function seedUiData() {
  const organizerToken = await loginApi('organisateur@lapromenade.com', demoPassword);
  const roomList = await api('/api/rooms', {
    headers: { Authorization: `Bearer ${organizerToken}` }
  });
  assert.equal(roomList.response.status, 200, JSON.stringify(roomList.body));
  const room = roomList.body.rooms[0];

  const eventDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const createEvent = await api('/api/events', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${organizerToken}`
    },
    body: JSON.stringify({
      name: 'Master Test Reception',
      type: 'Gala',
      date: eventDate,
      time: '18:30',
      endTime: '22:30',
      organizer: 'UI Master',
      contact: process.env.GMAIL_USER || 'client@example.com',
      guests: 60,
      budget: 8500
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
      date: eventDate,
      startTime: '18:30',
      endTime: '22:30'
    })
  });
  assert.equal(reserveRoom.response.status, 201, JSON.stringify(reserveRoom.body));

  const createGuest = await api('/api/guests', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${organizerToken}`
    },
    body: JSON.stringify({
      fname: 'Claire',
      lname: 'Lavigne',
      email: 'claire.lavigne@example.com',
      eventId,
      status: 'Confirmé'
    })
  });
  assert.equal(createGuest.response.status, 201, JSON.stringify(createGuest.body));

  const createService = await api('/api/services', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${organizerToken}`
    },
    body: JSON.stringify({
      name: 'Traiteur Signature',
      type: 'Restauration',
      detail: 'Menu premium test UI',
      eventId,
      cost: 1200
    })
  });
  assert.equal(createService.response.status, 201, JSON.stringify(createService.body));

  const invoice = await api(`/api/invoices/generate/${eventId}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${organizerToken}`
    },
    body: JSON.stringify({ client: 'Client Master Test' })
  });
  assert.equal(invoice.response.status, 201, JSON.stringify(invoice.body));
}

async function openLoginScreen() {
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  const loginScreen = page.locator('#login-screen');
  const getStartedScreen = page.locator('#getstarted-screen');
  if (await getStartedScreen.isVisible()) {
    await page.locator('.lamp-btn').click({ force: true });
    await page.waitForFunction(() => {
      const node = document.getElementById('getstarted-screen');
      return !node || getComputedStyle(node).display === 'none';
    }, null, { timeout: 10000 });
    await loginScreen.waitFor({ state: 'visible', timeout: 10000 });
  }
}

async function fillLoginCredentials(email, password) {
  await page.waitForTimeout(1100);
  await page.locator('#login-email').evaluate((node) => node.removeAttribute('readonly'));
  await page.locator('#login-password').evaluate((node) => node.removeAttribute('readonly'));
  await page.locator('#login-email').fill(email);
  await page.locator('#login-password').fill(password);
  await expectInputValue('#login-email', email);
  await expectInputValue('#login-password', password);
}

async function verifyLoginCredentialsCanBeEntered() {
  const cases = [
    { email: bootstrapAdminEmail, password: bootstrapAdminPassword },
    { email: 'organisateur@lapromenade.com', password: demoPassword },
    { email: 'coordonnateur@lapromenade.com', password: demoPassword },
    { label: 'Comptabilité', email: 'compta@lapromenade.com', password: demoPassword }
  ];

  for (const item of cases) {
    await fillLoginCredentials(item.email, item.password);
  }
}

async function expectInputValue(selector, value) {
  await page.waitForFunction(
    ({ selector: currentSelector, value: currentValue }) => {
      const node = document.querySelector(currentSelector);
      return !!node && node.value === currentValue;
    },
    { selector, value },
    { timeout: 5000 }
  );
}

async function loginViaUi(role) {
  await fillLoginCredentials(role.email, role.password);
  await page.getByRole('button', { name: 'Se connecter' }).click({ force: true });
  await page.locator('#app').waitFor({ state: 'visible', timeout: 15000 });
  await page.locator('#nav-dashboard').waitFor({ state: 'visible', timeout: 10000 });
  await page.waitForFunction(() => document.querySelector('#page-dashboard.page.active') !== null, null, { timeout: 10000 });
  await page.waitForTimeout(700);
}

async function logoutViaUi() {
  await page.getByRole('button', { name: /Se déconnecter/i }).click();
  await page.locator('#getstarted-screen').waitFor({ state: 'visible', timeout: 10000 });
}

async function testThemeToggle() {
  const before = await page.locator('html').getAttribute('data-theme');
  await page.locator('.theme-toggle').click();
  await page.waitForFunction((theme) => document.documentElement.getAttribute('data-theme') !== theme, before);
  const after = await page.locator('html').getAttribute('data-theme');
  assert.notEqual(after, before, 'Theme did not toggle');
  await page.locator('.theme-toggle').click();
  await page.waitForFunction((theme) => document.documentElement.getAttribute('data-theme') === theme, before);
}

async function clickSidebarPage(pageName) {
  const nav = page.locator(`#nav-${pageName}`);
  await nav.waitFor({ state: 'visible', timeout: 10000 });
  await nav.click();
  await page.waitForFunction((expectedPage) => {
    const active = document.querySelector('.page.active');
    return !!active && active.id === `page-${expectedPage}`;
  }, pageName, { timeout: 12000 });
  await page.waitForTimeout(500);
}

async function runRolePass(role) {
  await loginViaUi(role);
  const visibleNavIds = await page.locator('.sidebar-nav .nav-item').evaluateAll((nodes) => nodes.map((node) => node.id));
  assert.deepEqual(visibleNavIds, role.expectedNavIds, `${role.key} sidebar mismatch`);

  if (role.key === 'admin') {
    await testThemeToggle();
  }

  for (const pageName of role.expectedPages) {
    await clickSidebarPage(pageName);
  }

  await logoutViaUi();
}

async function main() {
  listener = serverModule.startServer(0);
  await wait(1500);
  baseUrl = `http://127.0.0.1:${listener.address().port}`;

  await seedUiData();

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  await context.route('https://api.open-meteo.com/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        current: {
          temperature_2m: 21.4,
          relative_humidity_2m: 52,
          apparent_temperature: 22.1,
          weather_code: 1,
          wind_speed_10m: 11.3
        }
      })
    });
  });
  page = await context.newPage();

  page.on('pageerror', (error) => {
    runtimeIssues.push(`pageerror: ${error.message}`);
  });
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      const text = msg.text();
      if (/Failed to load resource/i.test(text)) return;
      runtimeIssues.push(`console: ${text}`);
    }
  });
  page.on('requestfailed', (request) => {
    const url = request.url();
    if (!url.startsWith(baseUrl)) return;
    if (url.includes('/socket.io/')) return;
    const errorText = request.failure()?.errorText || 'unknown';
    if (errorText === 'net::ERR_ABORTED') return;
    runtimeIssues.push(`requestfailed: ${request.method()} ${url} :: ${errorText}`);
  });

  await openLoginScreen();
  await verifyLoginCredentialsCanBeEntered();

  const roles = [
    {
      key: 'admin',
      quickAccessLabel: 'Administrateur',
      email: bootstrapAdminEmail,
      password: bootstrapAdminPassword,
      expectedPages: ['dashboard', 'events', 'rooms', 'guests', 'services', 'billing', 'reports', 'users', 'notifications'],
      expectedNavIds: ['nav-dashboard', 'nav-events', 'nav-rooms', 'nav-guests', 'nav-services', 'nav-billing', 'nav-reports', 'nav-users', 'nav-notifications']
    },
    {
      key: 'organisateur',
      quickAccessLabel: 'Organisateur',
      email: 'organisateur@lapromenade.com',
      password: demoPassword,
      expectedPages: ['dashboard', 'events', 'rooms', 'guests', 'services', 'billing', 'reports', 'notifications'],
      expectedNavIds: ['nav-dashboard', 'nav-events', 'nav-rooms', 'nav-guests', 'nav-services', 'nav-billing', 'nav-reports', 'nav-notifications']
    },
    {
      key: 'coordonnateur',
      quickAccessLabel: 'Coordonnateur',
      email: 'coordonnateur@lapromenade.com',
      password: demoPassword,
      expectedPages: ['dashboard', 'events', 'services', 'rooms', 'notifications'],
      expectedNavIds: ['nav-dashboard', 'nav-events', 'nav-services', 'nav-rooms', 'nav-notifications']
    },
    {
      key: 'compta',
      quickAccessLabel: 'Comptabilité',
      email: 'compta@lapromenade.com',
      password: demoPassword,
      expectedPages: ['dashboard', 'billing', 'reports', 'notifications'],
      expectedNavIds: ['nav-dashboard', 'nav-billing', 'nav-reports', 'nav-notifications']
    }
  ];

  for (const role of roles) {
    await openLoginScreen();
    await runRolePass(role);
  }

  if (runtimeIssues.length > 0) {
    throw new Error(`UI master test captured runtime issues:\n- ${runtimeIssues.join('\n- ')}`);
  }

  console.log('[UI Master] Quick-access login presets, every role login, theme toggle, and sidebar navigation all passed.');
}

main()
  .catch((error) => {
    console.error('[UI Master] FAILED:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await browser.close();
    } catch (_) {}

    try {
      await serverModule.conciergeTelegram.stop();
    } catch (_) {}

    try {
      if (listener) {
        await new Promise((resolve) => listener.close(resolve));
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
