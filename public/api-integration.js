// API Integration - Hotel La Promenade
// Connects the frontend to the backend API.

const API_BASE = '/api';
let authStorage = window.localStorage;

function getStoredAuthItem(key) {
  return window.localStorage.getItem(key) || window.sessionStorage.getItem(key);
}

function persistAuth(token, user, rememberSession = true) {
  authStorage = rememberSession ? window.localStorage : window.sessionStorage;
  const otherStorage = rememberSession ? window.sessionStorage : window.localStorage;
  otherStorage.removeItem('token');
  otherStorage.removeItem('currentUser');
  authStorage.setItem('token', token);
  authStorage.setItem('currentUser', JSON.stringify(user));
}

var TOKEN = getStoredAuthItem('token');
var CURRENT_USER = null;
const storedCurrentUser = getStoredAuthItem('currentUser');
if (storedCurrentUser) {
  try {
    CURRENT_USER = JSON.parse(storedCurrentUser);
  } catch (_) {
    window.localStorage.removeItem('currentUser');
    window.sessionStorage.removeItem('currentUser');
  }
}

function syncAuthGlobals() {
  window.TOKEN = TOKEN;
  window.CURRENT_USER = CURRENT_USER;
}

syncAuthGlobals();

async function fetchWithTimeout(resource, options = {}, timeoutMs = 12000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(resource, { ...options, signal: controller.signal });
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error('Le serveur met trop de temps à répondre. Réessayez.');
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function apiRequest(endpoint, method = 'GET', body = null, timeoutMs = 18000) {
  const options = {
    method,
    headers: {
      'Content-Type': 'application/json'
    }
  };

  if (TOKEN) {
    options.headers.Authorization = `Bearer ${TOKEN}`;
  }
  if (body) {
    options.body = JSON.stringify(body);
  }

  const response = await fetchWithTimeout(`${API_BASE}${endpoint}`, options, timeoutMs);

  if (response.status === 401 || response.status === 403) {
    apiLogout();
    const appEl = document.getElementById('app');
    const loginEl = document.getElementById('login-screen');
    const getStartedEl = document.getElementById('getstarted-screen');
    if (appEl) appEl.style.display = 'none';
    if (loginEl) loginEl.style.display = 'flex';
    if (getStartedEl) getStartedEl.style.display = 'none';
    throw new Error('Session expirée. Veuillez vous reconnecter.');
  }

  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/pdf') || contentType.includes('text/csv')) {
    const blob = await response.blob();
    if (!response.ok) {
      throw new Error(`Erreur ${response.status}`);
    }
    return blob;
  }

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || `Erreur ${response.status}`);
  }
  return data;
}

async function apiUpload(endpoint, formData) {
  const headers = {};
  if (TOKEN) {
    headers.Authorization = `Bearer ${TOKEN}`;
  }

  const response = await fetchWithTimeout(`${API_BASE}${endpoint}`, {
    method: 'POST',
    headers,
    body: formData
  }, 20000);

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || 'Upload failed');
  }
  return data;
}

async function apiLogin(email, password, rememberSession = true) {
  const response = await fetchWithTimeout(`${API_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  }, 15000);

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || 'Échec de connexion');
  }

  TOKEN = data.token;
  CURRENT_USER = data.user;
  persistAuth(TOKEN, CURRENT_USER, rememberSession);
  syncAuthGlobals();
  return data;
}

async function apiRegister(fname, lname, email, password, rememberSession = true) {
  const response = await fetchWithTimeout(`${API_BASE}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fname, lname, email, password })
  }, 12000);

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || 'Échec d’inscription');
  }

  TOKEN = data.token;
  CURRENT_USER = data.user;
  persistAuth(TOKEN, CURRENT_USER, rememberSession);
  syncAuthGlobals();
  return data;
}

function apiLogout() {
  TOKEN = null;
  CURRENT_USER = null;
  window.localStorage.removeItem('token');
  window.localStorage.removeItem('currentUser');
  window.sessionStorage.removeItem('token');
  window.sessionStorage.removeItem('currentUser');
  syncAuthGlobals();
}

async function fetchEvents() { return apiRequest('/events'); }
async function fetchEvent(id) { return apiRequest(`/events/${id}`); }
async function createEvent(data) { return apiRequest('/events', 'POST', data); }
async function updateEvent(id, data) { return apiRequest(`/events/${id}`, 'PUT', data); }
async function deleteEvent(id) { return apiRequest(`/events/${id}`, 'DELETE'); }

async function uploadDocument(eventId, file) {
  const fd = new FormData();
  fd.append('file', file);
  return apiUpload(`/events/${eventId}/documents`, fd);
}
async function fetchDocuments(eventId) { return apiRequest(`/events/${eventId}/documents`); }
async function deleteDocument(eventId, docId) { return apiRequest(`/events/${eventId}/documents/${docId}`, 'DELETE'); }

async function fetchRooms(filters = {}) {
  const params = new URLSearchParams();
  if (filters.type) params.set('type', filters.type);
  if (filters.capacity) params.set('capacity', filters.capacity);
  if (filters.feature) params.set('feature', filters.feature);
  const qs = params.toString();
  return apiRequest(`/rooms${qs ? `?${qs}` : ''}`);
}
async function fetchRoom(id) { return apiRequest(`/rooms/${id}`); }
async function createRoom(data) { return apiRequest('/rooms', 'POST', data); }
async function updateRoom(id, data) { return apiRequest(`/rooms/${id}`, 'PUT', data); }
async function deleteRoom(id) { return apiRequest(`/rooms/${id}`, 'DELETE'); }

async function fetchReservations() { return apiRequest('/reservations'); }
async function reserveRoom(data) { return apiRequest('/rooms/reserve', 'POST', data); }
async function updateReservation(id, data) { return apiRequest(`/reservations/${id}`, 'PUT', data); }

async function fetchGuests(params = {}) {
  const qs = new URLSearchParams(params).toString();
  return apiRequest(`/guests${qs ? `?${qs}` : ''}`);
}
async function createGuest(data) { return apiRequest('/guests', 'POST', data); }
async function updateGuest(id, data) { return apiRequest(`/guests/${id}`, 'PUT', data); }
async function deleteGuest(id) { return apiRequest(`/guests/${id}`, 'DELETE'); }
async function sendInvitation(id, data = {}) { return apiRequest(`/guests/${id}/invite`, 'POST', data, 60000); }

async function importGuests(file, eventId) {
  const fd = new FormData();
  fd.append('file', file);
  if (eventId) fd.append('eventId', eventId);
  return apiUpload('/guests/import', fd);
}

async function exportGuests(eventId) {
  const qs = eventId ? `?eventId=${eventId}` : '';
  const blob = await apiRequest(`/guests/export${qs}`);
  if (blob instanceof Blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'invites.csv';
    a.click();
    URL.revokeObjectURL(url);
  }
}

async function fetchServices(eventId) {
  const qs = eventId ? `?eventId=${eventId}` : '';
  return apiRequest(`/services${qs}`);
}
async function createService(data) { return apiRequest('/services', 'POST', data); }
async function updateService(id, data) { return apiRequest(`/services/${id}`, 'PUT', data); }
async function fetchServiceCatalog(includeInactive = false) { return apiRequest(`/service-catalog${includeInactive ? '?includeInactive=1' : ''}`); }
async function createCatalogService(data) { return apiRequest('/service-catalog', 'POST', data); }
async function updateCatalogService(id, data) { return apiRequest(`/service-catalog/${id}`, 'PUT', data); }
async function deleteCatalogService(id) { return apiRequest(`/service-catalog/${id}`, 'DELETE'); }

async function fetchDevis(eventId) { return apiRequest(`/devis/${eventId}`); }

async function fetchInvoices(filters = {}) {
  const qs = new URLSearchParams(Object.entries(filters).filter(([, value]) => value !== undefined && value !== null && value !== '')).toString();
  return apiRequest(`/invoices${qs ? `?${qs}` : ''}`);
}
async function createInvoice(data) { return apiRequest('/invoices', 'POST', data); }
async function generateInvoice(eventId, client) { return apiRequest(`/invoices/generate/${eventId}`, 'POST', { client }); }
async function updateInvoice(id, data) { return apiRequest(`/invoices/${id}`, 'PUT', data); }
async function payInvoice(id, method, amount) { return apiRequest(`/invoices/${id}/pay`, 'POST', { method, amount }); }
async function sendInvoiceEmail(id, email) { return apiRequest(`/invoices/${id}/send`, 'POST', { email }); }

async function downloadInvoicePDF(id, number) {
  const blob = await apiRequest(`/invoices/${id}/pdf`);
  if (blob instanceof Blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `facture-${number || id}.pdf`;
    a.click();
    URL.revokeObjectURL(url);
  }
}

async function downloadReceipt(id, number) {
  const blob = await apiRequest(`/invoices/${id}/receipt`);
  if (blob instanceof Blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `recu-${number || id}.pdf`;
    a.click();
    URL.revokeObjectURL(url);
  }
}

async function fetchPayments() { return apiRequest('/payments'); }

async function fetchNotifications() { return apiRequest('/notifications'); }
async function markNotificationRead(id) { return apiRequest(`/notifications/${id}/read`, 'PUT'); }
async function markAllNotificationsRead() { return apiRequest('/notifications/read-all', 'PUT'); }
async function fetchDirectMessageUsers() { return apiRequest('/direct-messages/users'); }
async function fetchDirectMessages(userId) { return apiRequest(`/direct-messages/${userId}`); }
async function sendDirectMessage(recipientId, message) { return apiRequest('/direct-messages', 'POST', { recipientId, message }); }
async function fetchSettings() { return apiRequest('/settings'); }
async function updateSettings(data) { return apiRequest('/settings', 'PUT', data); }

async function fetchUsers() { return apiRequest('/users'); }
async function createUser(data) { return apiRequest('/users', 'POST', data); }
async function updateUser(id, data) { return apiRequest(`/users/${id}`, 'PUT', data); }
async function deactivateUser(id) { return apiRequest(`/users/${id}`, 'DELETE'); }

async function fetchAudit() { return apiRequest('/audit'); }

function reportQuery(filters = {}) {
  return new URLSearchParams(Object.entries(filters).filter(([, value]) => value !== undefined && value !== null && value !== '')).toString();
}
async function fetchReportSummary(filters = {}) { const qs = reportQuery(filters); return apiRequest(`/reports/summary${qs ? `?${qs}` : ''}`); }
async function fetchEventsByType(filters = {}) { const qs = reportQuery(filters); return apiRequest(`/reports/events-by-type${qs ? `?${qs}` : ''}`); }
async function fetchRevenueByMonth(filters = {}) { const qs = reportQuery(filters); return apiRequest(`/reports/revenue-by-month${qs ? `?${qs}` : ''}`); }
async function fetchRoomOccupancy(filters = {}) { const qs = reportQuery(filters); return apiRequest(`/reports/room-occupancy${qs ? `?${qs}` : ''}`); }
async function fetchServicesCost(filters = {}) { const qs = reportQuery(filters); return apiRequest(`/reports/services-cost${qs ? `?${qs}` : ''}`); }

async function downloadReportCsv(filters = {}) {
  const qs = reportQuery(filters);
  const blob = await apiRequest(`/reports/export.csv${qs ? `?${qs}` : ''}`);
  if (blob instanceof Blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'rapport-evenements.csv';
    a.click();
    URL.revokeObjectURL(url);
  }
}

async function downloadReportPdf(filters = {}) {
  const qs = reportQuery(filters);
  const blob = await apiRequest(`/reports/export.pdf${qs ? `?${qs}` : ''}`);
  if (blob instanceof Blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'rapport-evenements.pdf';
    a.click();
    URL.revokeObjectURL(url);
  }
}

async function sendChatMessage(messages) {
  return apiRequest('/chat', 'POST', { messages });
}

Object.assign(window, {
  apiLogin,
  apiRegister,
  apiLogout,
  apiRequest,
  apiUpload,
  fetchEvents,
  fetchEvent,
  createEvent,
  updateEvent,
  deleteEvent,
  uploadDocument,
  fetchDocuments,
  deleteDocument,
  fetchRooms,
  fetchRoom,
  createRoom,
  updateRoom,
  deleteRoom,
  fetchReservations,
  reserveRoom,
  updateReservation,
  fetchGuests,
  createGuest,
  updateGuest,
  deleteGuest,
  sendInvitation,
  importGuests,
  exportGuests,
  fetchServices,
  createService,
  updateService,
  fetchServiceCatalog,
  createCatalogService,
  updateCatalogService,
  deleteCatalogService,
  fetchDevis,
  fetchInvoices,
  createInvoice,
  generateInvoice,
  updateInvoice,
  payInvoice,
  sendInvoiceEmail,
  downloadInvoicePDF,
  downloadReceipt,
  fetchPayments,
  fetchNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  fetchDirectMessageUsers,
  fetchDirectMessages,
  sendDirectMessage,
  fetchSettings,
  updateSettings,
  fetchUsers,
  createUser,
  updateUser,
  deactivateUser,
  fetchAudit,
  fetchReportSummary,
  fetchEventsByType,
  fetchRevenueByMonth,
  fetchRoomOccupancy,
  fetchServicesCost,
  downloadReportCsv,
  downloadReportPdf,
  sendChatMessage,
  syncAuthGlobals
});
