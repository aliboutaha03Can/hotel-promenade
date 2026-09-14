const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEZONE = process.env.CONCIERGE_TIMEZONE || 'America/Toronto';

function getTodayKey(timeZone = DEFAULT_TIMEZONE) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date());
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function normalizeDateKey(input, timeZone = DEFAULT_TIMEZONE) {
  const text = String(input || '').trim();
  if (!text) return getTodayKey(timeZone);
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return getTodayKey(timeZone);
  return `${match[1]}-${match[2]}-${match[3]}`;
}

function formatMoney(value) {
  return new Intl.NumberFormat('fr-CA', {
    style: 'currency',
    currency: 'CAD',
    maximumFractionDigits: 2
  }).format(Number(value || 0));
}

function formatDateForSpeech(dateKey, timeZone = DEFAULT_TIMEZONE) {
  const date = new Date(`${dateKey}T12:00:00`);
  return new Intl.DateTimeFormat('fr-CA', {
    timeZone,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  }).format(date);
}

function formatHour(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const [hh = '00', mm = '00'] = text.split(':');
  if (mm === '00') return `${Number(hh)} h`;
  return `${Number(hh)} h ${mm}`;
}

function linesToScript(lines) {
  return lines
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function chunkLines(lines, size = 6) {
  const chunks = [];
  for (let i = 0; i < lines.length; i += size) {
    chunks.push(lines.slice(i, i + size));
  }
  return chunks;
}

function buildTelegramSummary(payload) {
  const header = [
    `Concierge debrief ${payload.dateKey}`,
    `Evenements du jour: ${payload.events.length}`,
    `Salles occupees: ${payload.reservedRoomCount}`,
    `Valeur facturee: ${formatMoney(payload.dayInvoiceTotal)}`,
    `Encaisse aujourd'hui: ${formatMoney(payload.cashCollectedToday)}`
  ];

  const details = payload.events.slice(0, 8).map((event) => {
    const roomBits = event.rooms.length
      ? event.rooms.map((room) => `${room.roomName} ${room.startTime || ''}-${room.endTime || ''}`.trim()).join(', ')
      : 'sans salle reservee';
    return `- ${event.name} (${event.date}) : ${roomBits}`;
  });

  const standalone = payload.standaloneReservations.slice(0, 8).map((reservation) => (
    `- Reservation directe (${reservation.date}) : ${reservation.roomName} ${reservation.startTime || ''}-${reservation.endTime || ''}`.trim()
  ));

  return [...header, '', ...details, ...standalone].join('\n');
}

function buildDebriefScript(payload) {
  const spokenDate = formatDateForSpeech(payload.dateKey, payload.timeZone);
  const lines = [`Bonjour. Voici le debrief du ${spokenDate} a l'Hotel La Promenade.`];

  if (!payload.events.length && !payload.standaloneReservations.length) {
    lines.push(`Aucun evenement n'est planifie pour cette date.`);
    lines.push(`Aucune salle n'est occupee et aucun encaissement n'a ete confirme aujourd'hui.`);
    lines.push(`Fin du debrief.`);
    return linesToScript(lines);
  }

  if (payload.events.length) {
    lines.push(`${payload.events.length} evenement${payload.events.length > 1 ? 's sont' : ' est'} au programme.`);
  } else {
    lines.push(`Aucun evenement n'est planifie, mais ${payload.reservedRoomCount} salle${payload.reservedRoomCount > 1 ? 's sont reservees' : ' est reservee'} en reservation directe.`);
  }

  for (const event of payload.events.slice(0, 6)) {
    const roomText = event.rooms.length
      ? event.rooms
          .map((room) => {
            const start = formatHour(room.startTime);
            const end = formatHour(room.endTime);
            if (start && end) return `${room.roomName} de ${start} a ${end}`;
            return room.roomName;
          })
          .join(', ')
      : 'sans salle reservee';

    const invoiceText = event.invoiceTotal > 0
      ? `La valeur facturee atteint ${formatMoney(event.invoiceTotal)}.`
      : `Aucune facture n'est encore emise.`;

    lines.push(
      `${event.name}, prevu le ${event.date}, utilise ${roomText}. ${invoiceText}`
    );
  }

  for (const reservation of payload.standaloneReservations.slice(0, 6)) {
    const start = formatHour(reservation.startTime);
    const end = formatHour(reservation.endTime);
    const schedule = start && end ? `de ${start} a ${end}` : `pour la journee`;
    lines.push(
      `Reservation directe pour ${reservation.roomName}, ${schedule}, sans evenement rattache pour le moment.`
    );
  }

  lines.push(`Au total, la valeur facturee des evenements du jour atteint ${formatMoney(payload.dayInvoiceTotal)}.`);
  lines.push(`Les paiements confirmes aujourd'hui representent ${formatMoney(payload.cashCollectedToday)}.`);

  if (payload.pendingInvoiceCount > 0) {
    lines.push(`${payload.pendingInvoiceCount} facture${payload.pendingInvoiceCount > 1 ? 's restent' : ' reste'} a suivre.`);
  } else {
    lines.push(`Aucune facture en attente critique pour cette date.`);
  }

  lines.push(`Fin du debrief.`);
  return linesToScript(lines);
}

function createTelegramConcierge(options) {
  const {
    dbGet,
    dbAll,
    dbRun,
    logAudit,
    createNotification,
    appRoot = __dirname
  } = options;

  const outputDir = path.join(appRoot, 'runtime', 'concierge');
  const apiBase = String(process.env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/$/, '');
  const botToken = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
  const envAdminChatId = String(process.env.TELEGRAM_ADMIN_CHAT_ID || '').trim();
  const timeZone = DEFAULT_TIMEZONE;

  let pollTimer = null;
  let polling = false;
  let inFlight = false;
  let cachedAdminChatId = envAdminChatId || null;
  let lastPollAt = null;
  let lastPollError = null;
  let lastDelivery = null;
  let started = false;

  async function ensureOutputDir() {
    await fsp.mkdir(outputDir, { recursive: true });
  }

  async function getSetting(key) {
    const row = await dbGet('SELECT value FROM app_settings WHERE key = ?', [key]);
    return row ? row.value : null;
  }

  async function setSetting(key, value) {
    await dbRun(
      `INSERT INTO app_settings (key, value, updatedAt)
       VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value, updatedAt=CURRENT_TIMESTAMP`,
      [key, value]
    );
  }

  async function getAdminChatId() {
    if (envAdminChatId) return envAdminChatId;
    if (cachedAdminChatId) return cachedAdminChatId;
    cachedAdminChatId = await getSetting('telegram_admin_chat_id');
    return cachedAdminChatId;
  }

  async function setAdminChatId(chatId) {
    cachedAdminChatId = String(chatId);
    if (!envAdminChatId) {
      await setSetting('telegram_admin_chat_id', cachedAdminChatId);
    }
    return cachedAdminChatId;
  }

  async function getLastUpdateId() {
    const stored = await getSetting('telegram_last_update_id');
    return Number(stored || 0);
  }

  async function setLastUpdateId(updateId) {
    await setSetting('telegram_last_update_id', String(updateId));
  }

  async function telegramRequest(method, payload = {}, options = {}) {
    if (!botToken) {
      throw new Error('TELEGRAM_BOT_TOKEN manquant');
    }

    const url = `${apiBase}/bot${botToken}/${method}`;
    const init = { method: options.method || 'POST' };

    if (options.formData) {
      init.body = options.formData;
    } else {
      init.headers = { 'Content-Type': 'application/json' };
      init.body = JSON.stringify(payload);
    }

    const response = await fetch(url, init);
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) {
      throw new Error(data.description || `Telegram API ${method} failed`);
    }
    return data.result;
  }

  async function sendTelegramMessage(chatId, text) {
    return telegramRequest('sendMessage', {
      chat_id: String(chatId),
      text
    });
  }

  async function sendTelegramAudio(chatId, filePath, caption) {
    const buffer = await fsp.readFile(filePath);
    const form = new FormData();
    form.set('chat_id', String(chatId));
    form.set('caption', caption || '');
    form.set('audio', new Blob([buffer], { type: 'audio/wav' }), path.basename(filePath));
    return telegramRequest('sendAudio', {}, { formData: form });
  }

  async function collectDebriefPayload(dateInput) {
    const dateKey = normalizeDateKey(dateInput, timeZone);
    const events = await dbAll(
      `SELECT e.id, e.name, e.date, e.time, e.endTime, e.status, e.type, e.organizer,
              COALESCE(i.id, 0) AS invoiceId,
              COALESCE(i.total, 0) AS invoiceTotal,
              COALESCE(i.status, 'Aucune') AS invoiceStatus
       FROM events e
       LEFT JOIN invoices i ON i.eventId = e.id
       WHERE e.date = ?
       ORDER BY COALESCE(e.time, '23:59'), e.name`,
      [dateKey]
    );

    const reservations = await dbAll(
      `SELECT r.id, r.eventId, r.date, r.startTime, r.endTime, r.cost, r.status, rm.name AS roomName
       FROM reservations r
       LEFT JOIN rooms rm ON rm.id = r.roomId
       WHERE r.date = ? AND COALESCE(r.status, '') NOT IN ('Annule', 'Annulé')
       ORDER BY r.startTime, rm.name`,
      [dateKey]
    );

    const paymentRows = await dbAll(
      `SELECT p.*, i.eventId
       FROM payments p
       LEFT JOIN invoices i ON i.id = p.invoiceId
       WHERE substr(COALESCE(p.date, p.dateCreated), 1, 10) = ?`,
      [dateKey]
    );

    const eventMap = new Map();
    const standaloneReservations = [];
    for (const event of events) {
      eventMap.set(event.id, {
        id: event.id,
        name: event.name,
        date: event.date,
        time: event.time,
        endTime: event.endTime,
        status: event.status,
        type: event.type,
        organizer: event.organizer,
        invoiceId: event.invoiceId,
        invoiceTotal: Number(event.invoiceTotal || 0),
        invoiceStatus: event.invoiceStatus,
        rooms: []
      });
    }

    for (const reservation of reservations) {
      const roomEntry = {
        roomName: reservation.roomName || 'Salle non definie',
        startTime: reservation.startTime,
        endTime: reservation.endTime,
        cost: Number(reservation.cost || 0)
      };

      if (!eventMap.has(reservation.eventId)) {
        standaloneReservations.push({
          id: reservation.id,
          date: reservation.date,
          ...roomEntry
        });
        continue;
      }

      eventMap.get(reservation.eventId).rooms.push(roomEntry);
    }

    const pendingInvoiceCount = Array.from(eventMap.values()).filter((entry) =>
      ['En attente', 'Partiel', 'Brouillon', 'En retard'].includes(entry.invoiceStatus)
    ).length;

    return {
      dateKey,
      timeZone,
      events: Array.from(eventMap.values()),
      standaloneReservations,
      reservedRoomCount: reservations.length,
      dayInvoiceTotal: Array.from(eventMap.values()).reduce((sum, event) => sum + Number(event.invoiceTotal || 0), 0),
      cashCollectedToday: paymentRows.reduce((sum, row) => sum + Number(row.amount || 0), 0),
      paymentCount: paymentRows.length,
      pendingInvoiceCount
    };
  }

  async function synthesizeFrenchBriefing(script, dateKey) {
    await ensureOutputDir();
    const outputPath = path.join(outputDir, `concierge-debrief-${dateKey}.wav`);
    const powershellScript = `
Add-Type -AssemblyName System.Speech
$ErrorActionPreference = 'Stop'
$text = ${JSON.stringify(script)}
$output = ${JSON.stringify(outputPath)}
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$voice = $synth.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -like 'fr*' } | Select-Object -First 1
if ($voice) { $synth.SelectVoice($voice.VoiceInfo.Name) }
$synth.Rate = 0
$synth.Volume = 100
$synth.SetOutputToWaveFile($output)
$synth.Speak($text)
$synth.Dispose()
Write-Output $output
`;

    const encoded = Buffer.from(powershellScript, 'utf16le').toString('base64');
    await execFileAsync('powershell', ['-NoProfile', '-EncodedCommand', encoded], { windowsHide: true, timeout: 120000 });
    return outputPath;
  }

  async function sendDebrief(options = {}) {
    const dateKey = normalizeDateKey(options.date, timeZone);
    const payload = await collectDebriefPayload(dateKey);
    const script = buildDebriefScript(payload);
    const summaryText = buildTelegramSummary(payload);
    const chatId = options.chatId || (await getAdminChatId());

    if (!chatId) {
      throw new Error('Aucun chat Telegram administrateur n est lie. Envoyez /start au bot Concierge.');
    }

    const audioPath = await synthesizeFrenchBriefing(script, dateKey);
    const textMessage = await sendTelegramMessage(chatId, summaryText);
    const audioMessage = await sendTelegramAudio(chatId, audioPath, `Debrief concierge ${dateKey}`);

    lastDelivery = {
      dateKey,
      chatId: String(chatId),
      audioPath,
      textMessageId: textMessage.message_id || null,
      audioMessageId: audioMessage.message_id || null,
      deliveredAt: new Date().toISOString()
    };

    if (options.actorUserId) {
      await logAudit(options.actorUserId, 'SEND', 'telegram_debrief', 0, `Debrief concierge envoye pour ${dateKey}`);
      await createNotification(options.actorUserId, 'Debrief Telegram envoye', `Le debrief du ${dateKey} a ete envoye sur Telegram.`, 'success');
    }

    return {
      ok: true,
      ...payload,
      script,
      summaryText,
      audioPath,
      chatId: String(chatId),
      audioMessageId: audioMessage.message_id || null,
      textMessageId: textMessage.message_id || null
    };
  }

  async function sendUnauthorized(chatId) {
    try {
      await sendTelegramMessage(chatId, 'Acces refuse. Ce concierge Telegram est reserve a l administrateur de l hotel.');
    } catch (_) {}
  }

  async function handleCommand(text, chatId, fromUser) {
    const adminChatId = await getAdminChatId();
    const normalizedChatId = String(chatId);
    const isStart = /^\/start\b/i.test(text);

    if (!adminChatId && isStart) {
      await setAdminChatId(normalizedChatId);
      await sendTelegramMessage(chatId, 'Le concierge Telegram est maintenant lie a ce compte administrateur. Commandes: /debrief, /debrief 2026-04-08, /status');
      return;
    }

    if (adminChatId && String(adminChatId) !== normalizedChatId) {
      await sendUnauthorized(chatId);
      return;
    }

    if (/^\/start\b/i.test(text) || /^\/help\b/i.test(text)) {
      await sendTelegramMessage(chatId, 'Concierge admin actif. Utilisez /debrief pour le resume vocal du jour, /debrief 2026-04-08 pour une date precise, ou /status pour l etat du bot.');
      return;
    }

    if (/^\/status\b/i.test(text)) {
      const status = await getStatus();
      await sendTelegramMessage(chatId, [
        'Etat du concierge Telegram',
        `Bot configure: ${status.enabled ? 'oui' : 'non'}`,
        `Chat admin: ${status.adminChatId || 'non lie'}`,
        `Dernier poll: ${status.lastPollAt || 'jamais'}`,
        `Derniere erreur: ${status.lastPollError || 'aucune'}`,
        `Derniere livraison: ${status.lastDelivery.deliveredAt || 'aucune'}`
      ].join('\n'));
      return;
    }

    const debriefMatch = text.match(/^\/debrief(:\s+(\d{4}-\d{2}-\d{2}))$/i);
    if (debriefMatch) {
      const result = await sendDebrief({
        date: debriefMatch[1] || undefined,
        chatId: normalizedChatId
      });
      await logAudit(null, 'COMMAND', 'telegram_debrief', 0, `Commande /debrief par ${fromUser || 'telegram_admin'} pour ${result.dateKey}`);
      return;
    }

    await sendTelegramMessage(chatId, 'Commande non reconnue. Utilisez /debrief ou /status.');
  }

  async function pollOnce() {
    if (!botToken || inFlight) return;
    inFlight = true;

    try {
      const lastUpdateId = await getLastUpdateId();
      const result = await telegramRequest('getUpdates', {
        offset: lastUpdateId + 1,
        timeout: 20,
        allowed_updates: ['message']
      });

      lastPollAt = new Date().toISOString();
      lastPollError = null;

      for (const update of result || []) {
        if (update.update_id) {
          await setLastUpdateId(update.update_id);
        }

        const message = update.message;
        const chatId = message.chat.id;
        const text = String(message.text || '').trim();
        if (!chatId || !text) continue;
        await handleCommand(text, chatId, message.from.username || message.from.first_name || null);
      }
    } catch (error) {
      lastPollAt = new Date().toISOString();
      lastPollError = error.message || String(error);
    } finally {
      inFlight = false;
    }
  }

  function schedulePoll(delayMs) {
    if (!polling) return;
    pollTimer = setTimeout(async () => {
      await pollOnce();
      schedulePoll(lastPollError ? 5000 : 1500);
    }, delayMs);
    pollTimer.unref();
  }

  async function start() {
    if (started) return;
    started = true;
    if (!botToken) return;
    await ensureOutputDir();
    polling = true;
    schedulePoll(200);
  }

  async function stop() {
    polling = false;
    started = false;
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
  }

  async function getStatus() {
    return {
      enabled: Boolean(botToken),
      apiBase,
      adminChatId: await getAdminChatId(),
      lastPollAt,
      lastPollError,
      lastDelivery
    };
  }

  return {
    start,
    stop,
    getStatus,
    sendDebrief,
    collectDebriefPayload,
    buildDebriefScript,
    buildTelegramSummary
  };
}

module.exports = {
  createTelegramConcierge,
  buildDebriefScript,
  buildTelegramSummary
};

