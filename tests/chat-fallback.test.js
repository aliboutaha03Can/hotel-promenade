const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dbPath = path.join(os.tmpdir(), `hotel-promenade-chat-fallback-${Date.now()}.db`);

process.env.JWT_SECRET = 'hotel-promenade-chat-fallback-secret-123456789';
process.env.DB_PATH = dbPath;
process.env.BOOTSTRAP_ADMIN_EMAIL = 'admin@lapromenade.com';
process.env.BOOTSTRAP_ADMIN_PASSWORD = 'AdminFallbackPass123!';
process.env.ENABLE_DEMO_USERS = 'false';
process.env.GEMINI_API_KEY = '';
process.env.GROQ_API_KEY = '';

const { startServer, db } = require('../server.js');

let listener;
let baseUrl;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function futureDate(days = 30) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
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
    if (result.response.status === 200) return result.body.token;
    if (result.response.status !== 503) {
      assert.equal(result.response.status, 200, `Login failed: ${JSON.stringify(result.body)}`);
    }
    await wait(250);
  }

  const { body, response } = await api('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  assert.equal(response.status, 200, `Login failed: ${JSON.stringify(body)}`);
  return body.token;
}

test.before(async () => {
  listener = startServer(0);
  await wait(1200);
  baseUrl = `http://127.0.0.1:${listener.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => listener.close(resolve));
  await new Promise((resolve, reject) => {
    db.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
  fs.rmSync(dbPath, { force: true });
});

test('chat falls back to automation without exposing quota or timeout language', async () => {
  const token = await login('admin@lapromenade.com', 'AdminFallbackPass123!');

  const result = await api('/api/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({
      messages: [{ role: 'user', content: 'Resume mes notifications recentes' }]
    })
  });

  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  assert.match(result.body.reply, /Notifications r.centes|Aucune notification|Je peux continuer/i);
  assert.doesNotMatch(result.body.reply, /Mode automatique|Mode concierge de secours/i);
  assert.doesNotMatch(result.body.reply, /token|timeout|trop de temps|rate limit/i);
});

test('chat fallback executes French room listing requests without provider keys', async () => {
  const token = await login('admin@lapromenade.com', 'AdminFallbackPass123!');

  const result = await api('/api/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({
      messages: [{ role: 'user', content: 'Lister les salles' }]
    })
  });

  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.automated, true);
  assert.match(result.body.reply, /Salle Versailles|Grand Salon|Montréal/i);
  assert.doesNotMatch(result.body.reply, /Mode automatique/i);
});

test('chat returns a graceful rescue reply for non-automatable requests when providers are unavailable', async () => {
  const token = await login('admin@lapromenade.com', 'AdminFallbackPass123!');

  const result = await api('/api/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({
      messages: [{ role: 'user', content: 'Raconte moi simplement l atmosphere ideale d un grand hotel' }]
    })
  });

  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  assert.match(result.body.reply, /Je peux continuer/i);
  assert.doesNotMatch(result.body.reply, /Mode concierge de secours/i);
  assert.doesNotMatch(result.body.reply, /token|timeout|trop de temps|rate limit/i);
});

test('chat asks for missing guest details instead of exposing provider unavailability', async () => {
  const token = await login('admin@lapromenade.com', 'AdminFallbackPass123!');

  const result = await api('/api/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({
      messages: [{ role: 'user', content: 'Ajoute un invite' }]
    })
  });

  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.automated, true);
  assert.match(result.body.reply, /ajouter un invit|identifiant/i);
  assert.doesNotMatch(result.body.reply, /indisponible|trop de temps|timeout|rate limit/i);
});

test('chat treats incomplete room reservation as reservation intent, not room listing', async () => {
  const token = await login('admin@lapromenade.com', 'AdminFallbackPass123!');

  const result = await api('/api/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({
      messages: [{ role: 'user', content: 'reserve test dans salle montreal pour le 29-04-2026' }]
    })
  });

  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.automated, true);
  assert.match(result.body.reply, /heures de début et de fin|14:00.*17:00/i);
  assert.doesNotMatch(result.body.reply, /Voici les salles disponibles/i);
  assert.doesNotMatch(result.body.reply, /Salle Versailles.*Salle Montréal/i);
});

test('chat lists active event names instead of confusing name with count', async () => {
  const token = await login('admin@lapromenade.com', 'AdminFallbackPass123!');
  const stamp = Date.now();
  const eventName = `Nom Actif Concierge ${stamp}`;
  const eventDate = futureDate(30);

  const created = await api('/api/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({
      messages: [{ role: 'user', content: `Creer un evenement ${eventName} le ${eventDate} a 10:00` }]
    })
  });

  assert.equal(created.response.status, 200, JSON.stringify(created.body));
  assert.equal(created.body.automated, true);
  assert.match(created.body.reply, /a été créé|a .t. cr/i);
  const eventId = created.body.actions?.[0]?.event?.id;
  assert.ok(eventId, JSON.stringify(created.body));

  const notifications = await api('/api/notifications', {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  assert.equal(notifications.response.status, 200, JSON.stringify(notifications.body));
  assert.ok(
    notifications.body.notifications.some((item) => item.title === 'Événement créé' && item.body.includes(eventName)),
    JSON.stringify(notifications.body.notifications)
  );

  const result = await api('/api/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({
      messages: [{ role: 'user', content: 'Donne moi le nom des evenements actifs' }]
    })
  });

  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.automated, true);
  assert.match(result.body.reply, new RegExp(eventName, 'i'));
  assert.doesNotMatch(result.body.reply, /événements au total/i);
  assert.doesNotMatch(result.body.reply, /Mode automatique/i);

  const deleted = await api(`/api/events/${eventId}`, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${token}` }
  });
  assert.equal(deleted.response.status, 200, JSON.stringify(deleted.body));
});

test('chat fallback reports active team count from the database', async () => {
  const token = await login('admin@lapromenade.com', 'AdminFallbackPass123!');

  const result = await api('/api/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({
      messages: [{ role: 'user', content: 'Combien d equipe active ?' }]
    })
  });

  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.automated, true);
  assert.match(result.body.reply, /4 membre\(s\) actif\(s\)/i);
});

test('chat fallback lists active team member names from the database', async () => {
  const token = await login('admin@lapromenade.com', 'AdminFallbackPass123!');

  const result = await api('/api/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({
      messages: [{ role: 'user', content: 'Donne moi les noms des utilisateurs actifs comme Marc Gagne' }]
    })
  });

  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.automated, true);
  assert.match(result.body.reply, /Membres de l.équipe/i);
  assert.match(result.body.reply, /Marc Gagn/i);
  assert.match(result.body.reply, /Emma C.t/i);
  assert.match(result.body.reply, /Luc Bernard/i);
  assert.doesNotMatch(result.body.reply, /membre\(s\) actif\(s\) sur/i);
  assert.doesNotMatch(result.body.reply, /Mode automatique|indisponible|timeout|rate limit/i);
});

test('chat fallback creates events and reports the right total', async () => {
  const token = await login('admin@lapromenade.com', 'AdminFallbackPass123!');
  const stamp = Date.now();

  for (const index of [1, 2, 3]) {
    const eventDate = futureDate(40 + index);
    const created = await api('/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        messages: [{ role: 'user', content: `Créer un événement Test Concierge ${stamp}-${index} le ${eventDate} à 10:00` }]
      })
    });
    assert.equal(created.response.status, 200, JSON.stringify(created.body));
    assert.equal(created.body.automated, true);
    assert.match(created.body.reply, /a été créé/i);
    assert.doesNotMatch(created.body.reply, /Mode automatique/i);
  }

  const count = await api('/api/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({
      messages: [{ role: 'user', content: 'Combien d événements actifs ?' }]
    })
  });

  assert.equal(count.response.status, 200, JSON.stringify(count.body));
  assert.equal(count.body.automated, true);
  assert.match(count.body.reply, /3 actifs/i);
  assert.doesNotMatch(count.body.reply, /Mode automatique/i);
});

test('chat fallback can list and delete an invited guest by name', async () => {
  const token = await login('admin@lapromenade.com', 'AdminFallbackPass123!');
  const stamp = Date.now();
  const eventName = `Invite Delete Event ${stamp}`;
  const guestFirst = `Alice${stamp}`;
  const guestLast = 'Suppression';
  const eventDate = futureDate(50);

  const created = await api('/api/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({
      messages: [{ role: 'user', content: `Creer un evenement ${eventName} le ${eventDate} a 11:00` }]
    })
  });
  assert.equal(created.response.status, 200, JSON.stringify(created.body));
  const eventId = created.body.actions?.[0]?.event?.id;
  assert.ok(eventId, JSON.stringify(created.body));

  const added = await api('/api/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({
      messages: [{ role: 'user', content: `Ajoute invite ${guestFirst} ${guestLast} evenement ${eventId}` }]
    })
  });
  assert.equal(added.response.status, 200, JSON.stringify(added.body));
  assert.equal(added.body.automated, true);
  assert.match(added.body.reply, new RegExp(`${guestFirst} ${guestLast}`, 'i'));

  const listed = await api('/api/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({
      messages: [{ role: 'user', content: `Liste les invites evenement ${eventId}` }]
    })
  });
  assert.equal(listed.response.status, 200, JSON.stringify(listed.body));
  assert.equal(listed.body.automated, true);
  assert.match(listed.body.reply, new RegExp(`${guestFirst} ${guestLast}`, 'i'));

  const deleted = await api('/api/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({
      messages: [{ role: 'user', content: `Supprime invite ${guestFirst} ${guestLast} evenement ${eventId}` }]
    })
  });
  assert.equal(deleted.response.status, 200, JSON.stringify(deleted.body));
  assert.equal(deleted.body.automated, true);
  assert.match(deleted.body.reply, /a Ã©tÃ© supprim|a .t. supprim/i);

  const guests = await api('/api/guests', {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  assert.equal(guests.response.status, 200, JSON.stringify(guests.body));
  assert.ok(!guests.body.guests.some((guest) => guest.fname === guestFirst && guest.lname === guestLast));
});
