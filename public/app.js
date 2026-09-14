/* App frontend logic */

let currentUser = null;
let currentRole = 'admin';
let calDate = new Date();
let calDate2 = new Date();
let editingEventId = null;
let editingUserId = null;
let activeModalId = null;
let modalFocusCleanup = null;
let lastFocusedBeforeModal = null;
let directMessageUsers = [];
let activeDirectMessageUserId = null;
let selectedEventOrganizer = { name: '', email: '' };

// Chart instances (for cleanup)
let chartInstances = {};

const FOCUSABLE_SELECTOR = 'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

function sanitizeHTML(markup) {
  if (typeof markup !== 'string') return markup;
  if (window.DOMPurify) {
    return window.DOMPurify.sanitize(markup, { USE_PROFILES: { html: true } });
  }
  return markup;
}

// Local data cache — populated from API
const DATA = {
  users: [],
  events: [],
  rooms: [],
  guests: [],
  services: [],
  audit: [],
  servicesCatalog: [
    {name:'Traiteur Gastronomique', icon:'🍽️', desc:'Menu 5 services, buffet ou plats servis à table', priceFrom:45},
    {name:'Audiovisuel Premium', icon:'🎛️', desc:'Sono, projecteurs, écrans LED, éclairage scénique', priceFrom:800},
    {name:'Sécurité & Accueil', icon:'🛡️', desc:'Agents de sécurité et personnel d\'accueil événementiel', priceFrom:240},
    {name:'Décoration & Fleurs', icon:'🌸', desc:'Décoration thématique complète et arrangements floraux', priceFrom:600},
    {name:'Photographie', icon:'📷', desc:'Photographe professionnel pour toute durée', priceFrom:400},
    {name:'Animation & DJ', icon:'🎵', desc:'DJ professionnel ou groupe musical live', priceFrom:750},
    {name:'Transport VIP', icon:'🚘', desc:'Service de limousine ou navette pour invités', priceFrom:300},
    {name:'Bar & Cocktails', icon:'🍸', desc:'Barman + sélection de vins, spiritueux et mocktails', priceFrom:500},
    {name:'Signalisation', icon:'🪧', desc:'Affiches, bannières et signalétique personnalisée', priceFrom:200},
  ],
  invoices: [],
  payments: [],
  notifications: [],
  reservations: [],
};

function getInitials(name = '') {
  return String(name)
    .split(' ')
    .filter(Boolean)
    .map(part => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getTodayDateKey() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function normalizeStatusValue(value = '') {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

function isActiveReservation(reservation) {
  if (!reservation) return false;
  const status = normalizeStatusValue(reservation.status);
  const dateKey = String(reservation.date || '').slice(0, 10);
  return status !== 'annule' && dateKey >= getTodayDateKey();
}

function getActiveReservations() {
  return DATA.reservations.filter(isActiveReservation);
}

function isValidEmailAddress(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
}

function isValidDateKey(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
  const [year, month, day] = String(value).split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function isValidTimeValue(value) {
  return /^([01]\d|2[0-3]):([0-5]\d)$/.test(String(value || ''));
}

function timeToMinutes(value) {
  if (!isValidTimeValue(value)) return null;
  const [hours, minutes] = String(value).split(':').map(Number);
  return hours * 60 + minutes;
}

function isPastDateTime(dateKey, timeValue = '00:00') {
  if (!isValidDateKey(dateKey) || !isValidTimeValue(timeValue)) return false;
  const now = new Date();
  const today = getTodayDateKey();
  const nowTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  if (dateKey < today) return true;
  if (dateKey > today) return false;
  return timeValue <= nowTime;
}

function isPastDateOnly(dateKey) {
  return isValidDateKey(dateKey) && dateKey < getTodayDateKey();
}

function isLockedEvent(event) {
  const status = normalizeStatusValue(event?.status);
  return status === 'annule' || status === 'termine';
}

function isUsableEvent(event) {
  if (!event || isLockedEvent(event)) return false;
  if (event.date && isPastDateTime(event.date, event.time || '23:59')) return false;
  return true;
}

function getClickedButton() {
  const element = document.activeElement;
  return element && element.tagName === 'BUTTON' ? element : null;
}

function setActionBusy(button, isBusy, label = 'Traitement...') {
  if (!button) return;
  if (isBusy) {
    button.dataset.originalText = button.dataset.originalText || button.textContent;
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    button.textContent = label;
  } else {
    button.disabled = false;
    button.removeAttribute('aria-busy');
    if (button.dataset.originalText) {
      button.textContent = button.dataset.originalText;
      delete button.dataset.originalText;
    }
  }
}

function getReservationConflict(roomId, date, startTime, endTime) {
  const start = timeToMinutes(startTime);
  const end = timeToMinutes(endTime);
  if (start === null || end === null) return null;
  return DATA.reservations.find(res => {
    if (!isActiveReservation(res)) return false;
    if (Number(res.roomId) !== Number(roomId) || res.date !== date) return false;
    const existingStart = timeToMinutes(res.startTime);
    const existingEnd = timeToMinutes(res.endTime);
    if (existingStart === null || existingEnd === null) return false;
    return existingStart < end && existingEnd > start;
  }) || null;
}

function getFocusableElements(container) {
  return Array.from(container.querySelectorAll(FOCUSABLE_SELECTOR))
    .filter(el => !el.hasAttribute('hidden') && el.offsetParent !== null);
}

function syncTabAccessibility(scope = document) {
  scope.querySelectorAll('.tabs').forEach((tabsBar, index) => {
    tabsBar.setAttribute('role', 'tablist');
    tabsBar.querySelectorAll('.tab').forEach((tab, tabIndex) => {
      if (!tab.id) tab.id = `tab-${index}-${tabIndex}`;
      const targetId = tab.dataset.target || '';
      const panel = targetId ? document.getElementById(targetId) : null;
      const active = tab.classList.contains('active');
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', active ? 'true' : 'false');
      tab.setAttribute('tabindex', active ? '0' : '-1');
      if (targetId) tab.setAttribute('aria-controls', targetId);
      if (panel) {
        panel.setAttribute('role', 'tabpanel');
        panel.setAttribute('aria-labelledby', tab.id);
        panel.hidden = !active;
      }
    });
  });
}

function enhanceInteractiveAccessibility(scope = document) {
  scope.querySelectorAll('[onclick]:not(button):not(a):not(input):not(select):not(textarea)').forEach((node) => {
    if (node.classList.contains('page') || node.classList.contains('modal-overlay')) return;
    node.dataset.clickable = 'true';
    if (!node.hasAttribute('tabindex')) node.tabIndex = 0;
    if (!node.hasAttribute('role')) node.setAttribute('role', 'button');
    if (!node.hasAttribute('aria-label')) {
      const text = node.textContent.replace(/\s+/g, ' ').trim();
      if (text) node.setAttribute('aria-label', text);
    }
  });

  scope.querySelectorAll('.modal-overlay').forEach((overlay) => {
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
  });

  syncTabAccessibility(scope);
}

function trapModalFocus(event) {
  if (event.key !== 'Tab' || !activeModalId) return;
  const overlay = document.getElementById(activeModalId);
  if (!overlay || !overlay.classList.contains('open')) return;
  const focusables = getFocusableElements(overlay);
  if (!focusables.length) {
    event.preventDefault();
    return;
  }
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function ensureModalFocus(id) {
  const overlay = document.getElementById(id);
  if (!overlay) return;
  const focusables = getFocusableElements(overlay);
  const initial = focusables.find(el => el.matches('input, select, textarea, button')) || focusables[0] || overlay.querySelector('.modal');
  if (initial) initial.focus();
}

/* Section */
let socket = null;
let socketConnected = false;

function initSocket() {
  if (socket) {
    if (!socket.connected) socket.connect();
    return;
  }

  if (!window.io) {
    console.warn('Socket.io not loaded');
    return;
  }
  
  socket = io({
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: 5,
    reconnectionDelay: 1000,
  });
  
  socket.on('connect', () => {
    console.log('Socket connected:', socket.id);
    socketConnected = true;
    
    // Authenticate with JWT token
    const token = window.TOKEN || localStorage.getItem('token') || sessionStorage.getItem('token');
    if (token) {
      socket.emit('authenticate', token);
    }
    
    updateConnectionStatus(true);
  });
  
  socket.on('authenticated', (data) => {
    if (data.success) {
      console.log('? Socket authenticated');
    } else {
      console.warn('Socket auth failed:', data.error);
    }
  });
  
  socket.on('disconnect', () => {
    console.log('Socket disconnected');
    socketConnected = false;
    updateConnectionStatus(false);
  });
  
  // Real-time event handlers
  
  socket.on('event:created', (data) => {
    console.log('New event:', data.name);
    showRealtimeToast('Nouvel événement', `"${data.name}" vient d'être créé`, 'info');
    refreshCurrentPage(['events', 'dashboard']);
  });
  
  socket.on('event:updated', (data) => {
    console.log('Event updated:', data.name);
    showRealtimeToast('Événement modifié', `"${data.name}" a été mis à jour`, 'info');
    refreshCurrentPage(['events', 'dashboard', 'rooms']);
  });
  
  socket.on('event:deleted', (data) => {
    console.log('Event deleted:', data.name);
    showRealtimeToast('Événement annulé', `"${data.name}" a été annulé`, 'warning');
    refreshCurrentPage(['events', 'dashboard']);
  });
  
  socket.on('reservation:created', (data) => {
    console.log('New reservation:', data.roomName);
    showRealtimeToast('Nouvelle réservation', `${data.roomName} réservée le ${data.date}`, 'success');
    refreshCurrentPage(['rooms', 'dashboard']);
    if (window.fullCalendarInstance) {
      refreshFullCalendar();
    }
  });
  
  socket.on('reservation:updated', (data) => {
    console.log('Reservation updated:', data.id);
    refreshCurrentPage(['rooms']);
    if (window.fullCalendarInstance) {
      refreshFullCalendar();
    }
  });
  
  socket.on('service:created', (data) => {
    console.log('New service:', data.name);
    showRealtimeToast('Nouveau service', `"${data.name}" demandé`, 'info');
    refreshCurrentPage(['services', 'dashboard']);
  });
  
  socket.on('service:updated', (data) => {
    console.log('Service updated:', data.name);
    showRealtimeToast('Service mis à jour', `"${data.name}" - ${data.status}`, 'info');
    refreshCurrentPage(['services']);
  });
  
  socket.on('invoice:updated', (data) => {
    console.log('Invoice updated:', data.id);
    refreshCurrentPage(['billing']);
  });
  
  socket.on('notification:new', (data) => {
    console.log('New notification:', data.title);
    showRealtimeToast(data.title, data.body, data.type);
    // Refresh notifications list and badge
    fetchNotifications().then((response) => {
      DATA.notifications = response.notifications || [];
      updateNotificationBadge();
      if (getCurrentPage() === 'notifications') {
        renderAllNotifications();
      }
    });
  });
  
  socket.on('notification:role', (data) => {
    console.log('Role notification:', data.role, data.title);
    // This triggers for the current user's role
    fetchNotifications().then((response) => {
      DATA.notifications = response.notifications || [];
      updateNotificationBadge();
    });
  });

  socket.on('direct-message:new', (message) => {
    handleDirectMessageRealtime(message, true);
  });

  socket.on('direct-message:sent', (message) => {
    handleDirectMessageRealtime(message, false);
  });

}

function updateConnectionStatus(connected) {
  const indicator = document.getElementById('connection-status');
  if (indicator) {
    indicator.className = connected ? 'status-dot online' : 'status-dot offline';
    indicator.title = connected ? 'Connecté en temps réel' : 'Hors ligne';
  }
}

function showRealtimeToast(title, message, type = 'info') {
  // Create toast element
  const toast = document.createElement('div');
  toast.className = `realtime-toast toast-${type} animate__animated animate__slideInRight`;
  toast.innerHTML = `
    <div class="toast-icon">${getToastIcon(type)}</div>
    <div class="toast-content">
      <strong>${title}</strong>
      <p>${message}</p>
    </div>
    <button class="toast-close" onclick="this.parentElement.remove()">×</button>
  `;
  
  // Add to container
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    document.body.appendChild(container);
  }
  
  container.appendChild(toast);
  
  // Auto-remove after 5 seconds
  setTimeout(() => {
    toast.classList.remove('animate__slideInRight');
    toast.classList.add('animate__slideOutRight');
    setTimeout(() => toast.remove(), 500);
  }, 5000);
}

function getToastIcon(type) {
  switch(type) {
    case 'success': return '✓';
    case 'warning': return '⚠';
    case 'danger': return '✖';
    default: return 'ℹ';
  }
}

function getCurrentPage() {
  // Determine current page from active nav or visible section
  const activeNav = document.querySelector('.nav-item.active');
  if (activeNav) {
    const href = activeNav.getAttribute('onclick');
    const match = href && href.match(/navigateTo\(['"](\w+)['"]\)/);
    return match ? match[1] : 'dashboard';
  }
  const activePage = document.querySelector('.page.active');
  return activePage ? activePage.id.replace('page-', '') : 'dashboard';
}

function refreshCurrentPage(affectedPages = []) {
  const currentPage = getCurrentPage();
  if (affectedPages.length === 0 || affectedPages.includes(currentPage)) {
    // Re-fetch data and re-render current page
    switch(currentPage) {
      case 'dashboard':
        renderDashboard();
        break;
      case 'events':
        renderEvents();
        break;
      case 'rooms':
        renderRooms();
        break;
      case 'guests':
        renderGuests();
        break;
      case 'services':
        renderServices();
        break;
      case 'billing':
        renderBilling();
        break;
      case 'notifications':
        renderAllNotifications();
        break;
    }
  }
}

function updateNotificationBadge() {
  const unread = DATA.notifications.filter(n => !n.isRead).length;
  const badge = document.querySelector('#nav-notifications .nav-badge');
  if (badge) {
    badge.textContent = unread || '';
    badge.style.display = unread ? 'inline-flex' : 'none';
  }

  const dot = document.getElementById('notif-dot');
  if (dot) dot.style.display = unread > 0 ? 'block' : 'none';
}

/* Section */
function initTheme() {
  const savedTheme = localStorage.getItem('hotelTheme') || 'dark';
  document.documentElement.setAttribute('data-theme', savedTheme);
  updateThemeIcon(savedTheme);
}

function toggleTheme() {
  const html = document.documentElement;
  const currentTheme = html.getAttribute('data-theme');
  const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
  
  html.setAttribute('data-theme', newTheme);
  localStorage.setItem('hotelTheme', newTheme);
  updateThemeIcon(newTheme);
  
  // Recreate charts with new theme colors
  if (typeof updateChartsTheme === 'function') {
    updateChartsTheme();
  }
}

function updateThemeIcon(theme) {
  const icon = document.getElementById('theme-icon');
  if (icon) {
    icon.textContent = theme === 'dark' ? '🌙' : '☀️';
  }
}

function setLoginBusy(isBusy, label = 'Se connecter') {
  const button = document.querySelector('.btn-login-connect');
  if (!button) return;
  button.disabled = isBusy;
  button.textContent = isBusy ? label : 'Se connecter';
  button.style.opacity = isBusy ? '0.8' : '1';
  button.style.cursor = isBusy ? 'wait' : 'pointer';
}

// Initialize theme on page load
document.addEventListener('DOMContentLoaded', initTheme);

/* Section */
let isOnline = navigator.onLine;

function initOfflineDetection() {
  // Create offline indicator
  const indicator = document.createElement('div');
  indicator.id = 'offline-indicator';
  indicator.className = 'offline-indicator';
  indicator.innerHTML = 'Vous êtes hors ligne. Les fonctionnalités sont limitées.';
  document.body.prepend(indicator);
  
  // Update on network status change
  window.addEventListener('online', () => {
    isOnline = true;
    showOnlineStatus();
  });
  
  window.addEventListener('offline', () => {
    isOnline = false;
    showOfflineStatus();
  });
  
  // Check initial status
  if (!navigator.onLine) {
    showOfflineStatus();
  }
}

function showOfflineStatus() {
  const indicator = document.getElementById('offline-indicator');
  if (indicator) {
    indicator.className = 'offline-indicator show';
    indicator.innerHTML = 'Vous êtes hors ligne. Les fonctionnalités sont limitées.';
  }
  // Update connection status dot
  const statusDot = document.getElementById('connection-status');
  if (statusDot) {
    statusDot.className = 'status-dot offline';
    statusDot.title = 'Hors ligne';
  }
}

function showOnlineStatus() {
  const indicator = document.getElementById('offline-indicator');
  if (indicator) {
    indicator.className = 'offline-indicator show online';
    indicator.innerHTML = '? Connexion rétablie';
    // Hide after 3 seconds
    setTimeout(() => {
      indicator.classList.remove('show');
    }, 3000);
  }
  // Update connection status dot
  const statusDot = document.getElementById('connection-status');
  if (statusDot) {
    statusDot.className = 'status-dot online';
    statusDot.title = 'Connecté';
  }
}

// Initialize offline detection on page load
document.addEventListener('DOMContentLoaded', initOfflineDetection);

/* Section */
function showSkeleton(containerId, type = 'card', count = 4) {
  const container = document.getElementById(containerId);
  if (!container) return;
  
  let html = '';
  for (let i = 0; i < count; i++) {
    if (type === 'stat') {
      html += `<div class="stat-card skeleton-stat" style="animation-delay:${i * 0.1}s"></div>`;
    } else if (type === 'table') {
      html += `<div class="skeleton skeleton-table-row" style="animation-delay:${i * 0.05}s"></div>`;
    } else if (type === 'card') {
      html += `<div class="skeleton skeleton-card" style="animation-delay:${i * 0.1}s"></div>`;
    }
  }
  container.innerHTML = html;
}

function showChartSkeleton(containerId) {
  const container = document.getElementById(containerId);
  if (container) {
    container.innerHTML = '<div class="skeleton skeleton-chart"></div>';
  }
}

/* Section */
function getChartColors() {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  return {
    gold: isDark ? '#C9A84C' : '#9A7B2D',
    goldLight: isDark ? 'rgba(201, 168, 76, 0.2)' : 'rgba(154, 123, 45, 0.2)',
    goldGradientStart: isDark ? 'rgba(201, 168, 76, 0.4)' : 'rgba(154, 123, 45, 0.4)',
    goldGradientEnd: isDark ? 'rgba(201, 168, 76, 0.05)' : 'rgba(154, 123, 45, 0.05)',
    text: isDark ? '#F0EAD6' : '#1A1A1A',
    textMuted: isDark ? '#8A8070' : '#6B6560',
    gridColor: isDark ? 'rgba(201, 168, 76, 0.1)' : 'rgba(154, 123, 45, 0.1)',
    success: '#4CAF7C',
    warning: '#E8A84C',
    danger: '#C9524C',
    info: '#4C8EC9',
  };
}

function createGradient(ctx, colorStart, colorEnd) {
  const gradient = ctx.createLinearGradient(0, 0, 0, 250);
  gradient.addColorStop(0, colorStart);
  gradient.addColorStop(1, colorEnd);
  return gradient;
}

function destroyChart(chartId) {
  if (chartInstances[chartId]) {
    chartInstances[chartId].destroy();
    delete chartInstances[chartId];
  }
}

function updateChartsTheme() {
  // Re-render dashboard if visible
  const dashPage = document.getElementById('page-dashboard');
  if (dashPage && dashPage.classList.contains('active')) {
    renderDashboard();
  }
  // Re-render reports if visible  
  const reportsPage = document.getElementById('page-reports');
  if (reportsPage && reportsPage.classList.contains('active')) {
    renderReports();
  }
}

/* Section */
const HOTEL_LOCATION = {
  lat: 45.5017,
  lon: -73.5673,
  city: 'Montréal, QC',
  address: '123 Avenue La Promenade',
  timezone: 'America/Toronto'
};

async function fetchWeather() {
  const container = document.getElementById('weather-widget');
  const headerWeather = document.getElementById('header-weather');
  if (!container && !headerWeather) return;

  const now = new Date();
  const timeLabel = new Intl.DateTimeFormat('fr-CA', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: HOTEL_LOCATION.timezone
  }).format(now);
  const dateLabel = new Intl.DateTimeFormat('fr-CA', {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    timeZone: HOTEL_LOCATION.timezone
  }).format(now);

  if (headerWeather) {
    headerWeather.innerHTML = `
        <div class="weather-chip-icon">⌖</div>
        <div class="weather-chip-copy">
          <div class="weather-chip-meta">Heure locale</div>
          <div class="weather-chip-main">
            <span class="weather-chip-temp">${timeLabel}</span>
            <span class="weather-chip-desc">${HOTEL_LOCATION.city}</span>
          </div>
          <div class="weather-chip-sub">${HOTEL_LOCATION.address} · ${dateLabel}</div>
        </div>
    `;
  }

  if (container) {
    container.innerHTML = `
      <div class="weather-widget compact">
        <div class="weather-icon">⌖</div>
        <div class="weather-info">
          <div class="weather-temp">${timeLabel}</div>
          <div class="weather-desc">Heure locale de l'hôtel</div>
          <div class="weather-location">📍 ${HOTEL_LOCATION.address}, ${HOTEL_LOCATION.city}</div>
          <div class="weather-details">
            <div class="weather-detail">
              <span class="weather-detail-icon">◷</span>
              <span>${dateLabel}</span>
            </div>
            <div class="weather-detail">
              <span class="weather-detail-icon">⌂</span>
              <span>Réceptions et coordination sur place</span>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  if (!fetchWeather.clockStarted) {
    fetchWeather.clockStarted = true;
    setInterval(fetchWeather, 60 * 1000);
  }
}

function getWeatherInfo(code) {
  // WMO Weather interpretation codes
  const weatherCodes = {
    0: { icon: '☀️', desc: 'Ciel dégagé' },
    1: { icon: '🌤️', desc: 'Principalement dégagé' },
    2: { icon: '⛅', desc: 'Partiellement nuageux' },
    3: { icon: '☁️', desc: 'Nuageux' },
    45: { icon: '🌫️', desc: 'Brouillard' },
    48: { icon: '🌫️', desc: 'Brouillard givrant' },
    51: { icon: '🌦️', desc: 'Bruine légère' },
    53: { icon: '🌦️', desc: 'Bruine modérée' },
    55: { icon: '🌧️', desc: 'Bruine dense' },
    61: { icon: '🌧️', desc: 'Pluie légère' },
    63: { icon: '🌧️', desc: 'Pluie modérée' },
    65: { icon: '🌧️', desc: 'Pluie forte' },
    66: { icon: '🌧️', desc: 'Pluie verglaçante légère' },
    67: { icon: '🌧️', desc: 'Pluie verglaçante forte' },
    71: { icon: '🌨️', desc: 'Neige légère' },
    73: { icon: '🌨️', desc: 'Neige modérée' },
    75: { icon: '❄️', desc: 'Neige forte' },
    77: { icon: '❄️', desc: 'Grains de neige' },
    80: { icon: '🌦️', desc: 'Averses légères' },
    81: { icon: '🌧️', desc: 'Averses modérées' },
    82: { icon: '⛈️', desc: 'Averses violentes' },
    85: { icon: '🌨️', desc: 'Averses de neige légères' },
    86: { icon: '🌨️', desc: 'Averses de neige fortes' },
    95: { icon: '⛈️', desc: 'Orage' },
    96: { icon: '⛈️', desc: 'Orage avec grêle légère' },
    99: { icon: '⛈️', desc: 'Orage avec grêle forte' },
  };
  
  return weatherCodes[code] || { icon: '🌤️', desc: 'Conditions variées' };
}

/* Section */
let hotelMap = null;

function initHotelMap() {
  const mapContainer = document.getElementById('hotel-map');
  if (!mapContainer || !window.L) return;
  
  // Destroy existing map if any
  if (hotelMap) {
    hotelMap.remove();
    hotelMap = null;
  }
  
  // Create map centered on hotel location
  hotelMap = L.map('hotel-map', {
    scrollWheelZoom: false
  }).setView([HOTEL_LOCATION.lat, HOTEL_LOCATION.lon], 15);
  
  // Add OpenStreetMap tiles
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors',
    maxZoom: 19
  }).addTo(hotelMap);
  
  // Custom gold marker icon
  const goldIcon = L.divIcon({
    className: 'custom-marker',
    html: `<div style="
      width: 40px;
      height: 40px;
      background: var(--gold, #C9A84C);
      border: 3px solid var(--dark, #0D0D0D);
      border-radius: 50% 50% 50% 0;
      transform: rotate(-45deg);
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    "><span style="transform: rotate(45deg); font-size: 18px;">✦</span></div>`,
    iconSize: [40, 40],
    iconAnchor: [20, 40],
    popupAnchor: [0, -40]
  });
  
  // Add marker with popup
  const marker = L.marker([HOTEL_LOCATION.lat, HOTEL_LOCATION.lon], { icon: goldIcon }).addTo(hotelMap);
  
  marker.bindPopup(`
    <div class="hotel-popup">
      <div class="popup-stars">★★★★★</div>
      <h4>Hôtel La Promenade</h4>
      <p>123 Avenue du Parc</p>
      <p>${HOTEL_LOCATION.city}</p>
      <p style="margin-top: 8px; color: var(--gold, #C9A84C);">☎ (514) 555-0123</p>
    </div>
  `);
  
  // Add nearby points of interest
  const pois = [
    { lat: 45.5035, lon: -73.5690, name: 'Parc Mont-Royal', icon: '🌿' },
    { lat: 45.4990, lon: -73.5655, name: 'Centre-ville', icon: '🏙️' },
    { lat: 45.5030, lon: -73.5640, name: 'Station de métro', icon: '🚇' },
  ];

  const neighbourhood = document.getElementById('neighbourhood-highlights');
  if (neighbourhood) {
    neighbourhood.innerHTML = `
      <div class="locale-pulse-item">
        <div class="locale-pulse-icon">📍</div>
        <div>
          <div class="locale-pulse-label">Adresse d’accueil</div>
          <div class="locale-pulse-value">123 Avenue La Promenade, Montréal</div>
        </div>
      </div>
      ${pois.map((poi) => `
        <div class="locale-pulse-item">
          <div class="locale-pulse-icon">${poi.icon}</div>
          <div>
            <div class="locale-pulse-label">${poi.name}</div>
            <div class="locale-pulse-value">Un point de repère utile pour l’arrivée des invités et prestataires.</div>
          </div>
        </div>
      `).join('')}
    `;
  }
  
  pois.forEach(poi => {
    const poiIcon = L.divIcon({
      className: 'poi-marker',
      html: `<div style="
        font-size: 24px;
        filter: drop-shadow(0 2px 4px rgba(0,0,0,0.3));
      ">${poi.icon}</div>`,
      iconSize: [30, 30],
      iconAnchor: [15, 15]
    });
    
    L.marker([poi.lat, poi.lon], { icon: poiIcon })
      .addTo(hotelMap)
      .bindPopup(`<strong>${poi.name}</strong>`);
  });
  
  // Invalidate size after a short delay (for proper rendering)
  setTimeout(() => {
    hotelMap.invalidateSize();
  }, 100);
}

/* Section */
async function getEventWeatherForecast(eventDate) {
  return null;
}

function renderEventWeatherBadge(forecast) {
  if (!forecast) return '';
  
  const weather = getWeatherInfo(forecast.weatherCode);
  const precipWarning = forecast.precipProb > 50
    ? `<span style="color: #4C8EC9;"> ${forecast.precipProb}%</span>`
    : '';
  
  return `
    <div class="event-weather-badge" title="Prévisions météo pour cet événement">
      <span>${weather.icon}</span>
      <span>${forecast.tempMax}°/${forecast.tempMin}°</span>
      ${precipWarning}
    </div>
  `;
}

/* Section */
function animateValue(element, start, end, duration = 1000) {
  if (!element) return;
  
  const startTime = performance.now();
  const isNumber = !isNaN(end);
  
  function update(currentTime) {
    const elapsed = currentTime - startTime;
    const progress = Math.min(elapsed / duration, 1);
    
    // Easing function (ease-out)
    const easeOut = 1 - Math.pow(1 - progress, 3);
    
    if (isNumber) {
      const current = Math.floor(start + (end - start) * easeOut);
      element.textContent = current.toLocaleString('fr-CA');
    }
    
    if (progress < 1) {
      requestAnimationFrame(update);
    } else {
      element.classList.add('counting');
      setTimeout(() => element.classList.remove('counting'), 500);
    }
  }
  
  requestAnimationFrame(update);
}

/* Section */
const NAV_CONFIG = {
  admin: [
    {section:'Principal', items:[
      {icon:'◈', label:'Tableau de bord', page:'dashboard'},
      {icon:'◉', label:'Événements', page:'events'},
      {icon:'▣', label:'Réservation salles', page:'rooms'},
      {icon:'♟', label:'Invités', page:'guests'},
    ]},
    {section:'Gestion', items:[
      {icon:'⊛', label:'Services', page:'services'},
      {icon:'◎', label:'Facturation', page:'billing'},
      {icon:'⊡', label:'Rapports', page:'reports'},
    ]},
    {section:'Administration', items:[
      {icon:'⊞', label:'Utilisateurs', page:'users'},
      {icon:'◫', label:'Notifications', page:'notifications', badge: () => DATA.notifications.filter(n => !n.isRead).length},
    ]},
  ],
  organisateur: [
    {section:'Mes activités', items:[
      {icon:'◈', label:'Tableau de bord', page:'dashboard'},
      {icon:'◉', label:'Mes événements', page:'events'},
      {icon:'▣', label:'Réservation salles', page:'rooms'},
      {icon:'♟', label:'Invités', page:'guests'},
      {icon:'⊛', label:'Services', page:'services'},
      {icon:'◎', label:'Facturation', page:'billing'},
      {icon:'⊡', label:'Rapports', page:'reports'},
      {icon:'◫', label:'Notifications', page:'notifications', badge: () => DATA.notifications.filter(n => !n.isRead).length},
    ]},
  ],
  coordonnateur: [
    {section:'Coordination', items:[
      {icon:'◈', label:'Tableau de bord', page:'dashboard'},
      {icon:'◉', label:'Événements', page:'events'},
      {icon:'⊛', label:'Services', page:'services'},
      {icon:'▣', label:'Salles', page:'rooms'},
      {icon:'◫', label:'Notifications', page:'notifications', badge: () => DATA.notifications.filter(n => !n.isRead).length},
    ]},
  ],
  compta: [
    {section:'Finance', items:[
      {icon:'◈', label:'Tableau de bord', page:'dashboard'},
      {icon:'◎', label:'Facturation', page:'billing'},
      {icon:'⊡', label:'Rapports', page:'reports'},
      {icon:'◫', label:'Notifications', page:'notifications', badge: () => DATA.notifications.filter(n => !n.isRead).length},
    ]},
  ],
};

const ROLE_LABELS = {
  admin:'Administrateur', organisateur:'Organisateur', coordonnateur:'Coordonnateur', compta:'Comptabilité'
};

/* Section */
function getLoginFields() {
  return {
    email: document.getElementById('login-email'),
    password: document.getElementById('login-password')
  };
}

function clearLoginFields() {
  const { email, password } = getLoginFields();
  [email, password].forEach((field) => {
    if (!field) return;
    field.value = '';
    field.defaultValue = '';
  });
}

function unlockLoginField(event) {
  event.currentTarget.removeAttribute('readonly');
}

function hardenLoginAutofill() {
  const { email, password } = getLoginFields();
  const fields = [email, password].filter(Boolean);

  fields.forEach((field) => {
    field.setAttribute('readonly', 'readonly');
    field.setAttribute('autocomplete', 'new-password');
    field.setAttribute('data-lpignore', 'true');
    field.setAttribute('data-1p-ignore', 'true');
    field.setAttribute('data-form-type', 'other');
    field.addEventListener('focus', unlockLoginField, { once: true });
    field.addEventListener('pointerdown', unlockLoginField, { once: true });
  });

  [0, 100, 400, 900].forEach((delay) => {
    setTimeout(() => {
      if (fields.includes(document.activeElement)) return;
      clearLoginFields();
    }, delay);
  });
}

function goToLogin() {
  document.getElementById('getstarted-screen').style.display = 'none';
  document.getElementById('login-screen').style.display = 'flex';
  hardenLoginAutofill();
}

function goToGetStarted() {
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('getstarted-screen').style.display = 'flex';
}

// Generate floating particles for lamp effect
function initLampParticles() {
  const container = document.getElementById('lamp-particles');
  if (!container) return;
  for (let i = 0; i < 20; i++) {
    const p = document.createElement('div');
    p.className = 'lamp-particle';
    p.style.left = (Math.random() * 100) + '%';
    p.style.bottom = (Math.random() * 20) + '%';
    p.style.animationDelay = (Math.random() * 6) + 's';
    p.style.animationDuration = (4 + Math.random() * 4) + 's';
    p.style.width = p.style.height = (1 + Math.random() * 2) + 'px';
    container.appendChild(p);
  }
}

/* Section */
async function doLogin() {
  const email = document.getElementById('login-email').value.trim().toLowerCase();
  const password = document.getElementById('login-password').value;
  const rememberSession = document.getElementById('remember-session')?.checked !== false;
  if (!email || !password) { showToast('Courriel et mot de passe requis.', 'error'); return; }

  try {
    setLoginBusy(true, 'Connexion...');
    const data = await apiLogin(email, password, rememberSession);
    currentUser = data.user;
    currentRole = data.user.role;

    document.getElementById('getstarted-screen').style.display = 'none';
    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('app').style.display = 'block';

    await new Promise(resolve => requestAnimationFrame(resolve));
    await initApp();
    initChatForUser();
    setTimeout(() => initSocket(), 0);
    showToast('Bienvenue, ' + currentUser.fname + ' !', 'success');
  } catch (err) {
    showToast(err.message || 'Échec de connexion', 'error');
  } finally {
    setLoginBusy(false);
  }
}

function doLogout() {
  apiLogout();
  currentUser = null;
  currentRole = 'admin';
  DATA.events = []; DATA.rooms = []; DATA.guests = []; DATA.services = [];
  DATA.invoices = []; DATA.payments = []; DATA.notifications = []; DATA.reservations = [];
  DATA.users = [];

  // Disconnect socket
  if (socket) {
    socket.disconnect();
    socket = null;
    socketConnected = false;
  }

  // Hide chat and reset
  resetChat();
  document.getElementById('chat-fab').style.display = 'none';
  document.getElementById('chat-panel').classList.remove('open');
  chatOpen = false;

  document.getElementById('app').style.display = 'none';
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('getstarted-screen').style.display = 'flex';
  clearLoginFields();
  hardenLoginAutofill();
}

/* Section */
async function initApp() {
  document.getElementById('user-name').textContent = currentUser.fname + ' ' + currentUser.lname;
  document.getElementById('user-role-label').textContent = ROLE_LABELS[currentRole] || currentRole;
  document.getElementById('user-avatar').textContent = currentUser.fname[0];

  buildNav();
  navigateTo('dashboard');

  const startupTasks = [fetchNotifications(), fetchRooms(), fetchServiceCatalog(currentRole === 'admin')];
  if (currentRole === 'admin') startupTasks.push(fetchUsers());

  const [notifData, roomData, catalogData, usersData] = await Promise.allSettled(startupTasks);
  DATA.notifications = notifData.status === 'fulfilled' ? (notifData.value.notifications || []) : [];
  DATA.rooms = roomData.status === 'fulfilled' ? (roomData.value.rooms || []) : [];
  if (catalogData.status === 'fulfilled') {
    DATA.servicesCatalog = (catalogData.value.services || []).map((item) => ({
      ...item,
      desc: item.description || item.desc || '',
      priceFrom: Number(item.priceFrom || 0)
    }));
  }
  if (currentRole === 'admin' && usersData.status === 'fulfilled') {
    DATA.users = usersData.value.users || [];
  }
  const roomSel = document.getElementById('ev-room');
  if (roomSel) {
    roomSel.innerHTML = '<option value="">— Sélectionner —</option>' +
      DATA.rooms.filter(r => Number(r.available) !== 0).map(r => `<option>${escapeHtml(r.name)}</option>`).join('');
  }

  // Fill services checkboxes in event modal
  const svcCheck = document.getElementById('ev-services-check');
  svcCheck.innerHTML = DATA.servicesCatalog.slice(0, 6).map(s =>
    `<label class="service-check-item">
      <input type="checkbox">
      <span class="service-check-icon">${s.icon}</span>
      <span class="service-check-name">${escapeHtml(s.name)}</span>
    </label>`).join('');

  renderNotifPanel();
  updateNotifBadge();
}

function buildNav() {
  const config = NAV_CONFIG[currentRole];
  if (!config) return;
  const nav = document.getElementById('sidebar-nav');
  nav.innerHTML = config.map(section => `
    <div class="nav-section-label">${section.section}</div>
    ${section.items.map(item => {
      const badge = item.badge ? item.badge() : 0;
      const label = escapeHtml(item.label);
      return `<button type="button" class="nav-item" onclick="navigateTo('${item.page}')" id="nav-${item.page}" aria-label="${label}" aria-current="false">
        <span class="nav-icon">${item.icon}</span>
        <span>${label}</span>
        ${badge > 0 ? `<span class="nav-badge">${badge}</span>` : ''}
      </button>`;
    }).join('')}
  `).join('');
  enhanceInteractiveAccessibility(nav);
}

/* Section */
const PAGE_TITLES = {
  dashboard: 'Tableau de bord',
  events: 'Gestion des événements',
  rooms: 'Réservation des salles',
  guests: 'Gestion des invités',
  services: 'Coordination des services',
  billing: 'Facturation',
  reports: 'Rapports & Analyses',
  users: 'Utilisateurs',
  notifications: 'Notifications',
};

const PAGE_SUBTITLES = {
  dashboard: 'Vue d’ensemble de la maison, de l’ambiance locale et des activités en cours',
  events: 'Présentez les événements comme des expériences, pas seulement comme des lignes de données',
  rooms: 'Orchestrez les espaces de réception, de réunion et de cérémonie avec précision',
  guests: 'Suivez les invités avec une logique d’accueil et de service haut de gamme',
  services: 'Coordonnez les demandes hôtelières, techniques et événementielles au même endroit',
  billing: 'Supervisez les devis, factures et paiements avec une lecture claire des enjeux',
  reports: 'Lisez les performances et les tendances sans quitter l’univers de l’hôtel',
  users: 'Cadrez l’accès des équipes internes avec des rôles alignés sur l’exploitation',
  notifications: 'Gardez la cadence des opérations avec des alertes lisibles et hiérarchisées'
};

function navigateTo(page) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));

  const p = document.getElementById('page-' + page);
  if (p) p.classList.add('active');
  const n = document.getElementById('nav-' + page);
  if (n) n.classList.add('active');
  document.querySelectorAll('.nav-item').forEach((item) => {
    item.setAttribute('aria-current', item.id === `nav-${page}` ? 'page' : 'false');
  });

  document.getElementById('page-title').textContent = PAGE_TITLES[page] || page;
  const subtitle = document.getElementById('page-subtitle');
  if (subtitle) subtitle.textContent = PAGE_SUBTITLES[page] || PAGE_SUBTITLES.dashboard;

  const btn = document.getElementById('topbar-action-btn');
  if (page === 'events') {
    btn.style.display = 'flex';
    btn.textContent = '+ Nouvel événement';
  } else { btn.style.display = 'none'; }

  const renders = {
    dashboard: renderDashboard,
    events: renderEvents,
    rooms: renderRooms,
    guests: renderGuests,
    services: renderServices,
    billing: renderBilling,
    reports: renderReports,
    users: renderUsers,
    notifications: renderAllNotifications,
  };
  if (renders[page]) renders[page]();
  if (p) enhanceInteractiveAccessibility(p);
}

function openDashboardDestination(destination = {}) {
  const page = destination.page || 'dashboard';
  navigateTo(page);

  window.setTimeout(() => {
    if (destination.tab) {
      const tab = document.querySelector(`#page-${page} .tab[data-target="${destination.tab}"]`);
      if (tab) switchTab(tab, destination.tab);
    }

    if (page === 'events' && destination.status) {
      const statusFilter = document.getElementById('event-status-filter');
      if (statusFilter) statusFilter.value = destination.status;
      renderEvents('', destination.status);
    }

    if (page === 'guests' && destination.search) {
      const guestSearch = document.getElementById('guest-search-input');
      if (guestSearch) guestSearch.value = destination.search;
      renderGuests(destination.search);
    }

    if (page === 'billing' && destination.invoiceStatus) {
      const invoiceStatus = document.getElementById('invoice-status-filter');
      if (invoiceStatus) invoiceStatus.value = destination.invoiceStatus;
      renderBilling();
    }

    if (page === 'users' && destination.search) {
      const userSearch = document.getElementById('users-search');
      if (userSearch) userSearch.value = destination.search;
      renderUsersTable();
    }
  }, 0);
}

function topbarAction() { openEventModal(); }

/* Section */
async function renderDashboard() {
  let summary = null;
  try {
    const fetches = [fetchEvents(), fetchNotifications(), fetchReportSummary()];
    // Organisateur & Coordonnateur don't need invoices; admin & compta do
    if (currentRole === 'admin' || currentRole === 'compta') {
      fetches.push(fetchRevenueByMonth());
    } else {
      fetches.push(Promise.resolve({ data: [] }));
    }
    fetches.push(fetchReservations());
    fetches.push(fetchServices());
    fetches.push(currentRole === 'admin' || currentRole === 'compta' ? fetchInvoices() : Promise.resolve({ invoices: [] }));
    fetches.push(currentRole === 'admin' || currentRole === 'compta' ? fetchPayments() : Promise.resolve({ payments: [] }));
    const results = await Promise.allSettled(fetches);
    DATA.events = results[0].status === 'fulfilled' ? (results[0].value.events || []) : [];
    DATA.notifications = results[1].status === 'fulfilled' ? (results[1].value.notifications || []) : [];
    summary = results[2].status === 'fulfilled' ? results[2].value : null;
    DATA._revenueByMonth = results[3].status === 'fulfilled' ? (results[3].value.data || []) : [];
    DATA.reservations = results[4].status === 'fulfilled' ? (results[4].value.reservations || []) : [];
    DATA.services = results[5].status === 'fulfilled' ? (results[5].value.services || []) : [];
    DATA.invoices = results[6].status === 'fulfilled' ? (results[6].value.invoices || []) : [];
    DATA.payments = results[7].status === 'fulfilled' ? (results[7].value.payments || []) : [];
  } catch (e) { console.error('Dashboard fetch error:', e); }

  // Role-aware stat cards
  const statsEl = document.getElementById('dashboard-stats');

  // Personalize hero header
  const heroTitle = document.getElementById('dash-hero-title');
  const heroDesc = document.getElementById('dash-hero-desc');
  const heroKicker = document.getElementById('dash-hero-kicker');
  const heroSignature = document.querySelector('.dash-hero-signature');
  const roleHero = {
    admin: {
      kicker: 'Direction de maison',
      title: `Centre de commandement, ${currentUser?.fname || 'Admin'}`,
      desc: 'Pilotez l’activité de la maison: événements actifs, salons engagés, équipe, risques et revenus à sécuriser.',
      signature: 'Une vue exécutive conçue pour décider vite sans perdre le niveau de détail opérationnel.'
    },
    organisateur: {
      kicker: 'Carnet d’organisation',
      title: `Atelier de réception, ${currentUser?.fname || 'Organisateur'}`,
      desc: 'Préparez vos événements, invités, salles et services avec une lecture claire des prochaines actions.',
      signature: 'Un espace orienté client pour transformer chaque dossier en réception prête à vivre.'
    },
    coordonnateur: {
      kicker: 'Régie opérationnelle',
      title: `Console terrain, ${currentUser?.fname || 'Coordonnateur'}`,
      desc: 'Gardez la cadence entre salles, fournisseurs, services et confirmations pour éviter les frictions du jour J.',
      signature: 'Une régie pensée pour prioriser les urgences et maintenir la qualité de service.'
    },
    compta: {
      kicker: 'Salon financier',
      title: `Bureau des encaissements, ${currentUser?.fname || 'Comptabilité'}`,
      desc: 'Suivez les factures, paiements, relances et revenus confirmés dans une lecture financière plus nette.',
      signature: 'Une vue sobre pour sécuriser les montants, les échéances et les suivis client.'
    }
  };
  const hero = roleHero[currentRole] || roleHero.admin;
  if (heroTitle) heroTitle.textContent = hero.title;
  if (heroKicker) heroKicker.textContent = hero.kicker;
  if (heroDesc) heroDesc.textContent = hero.desc;
  if (heroSignature) heroSignature.textContent = hero.signature;

  if (summary) {
    const cards = [];
    if (currentRole === 'admin') {
      cards.push({icon:'◇',label:'Événements actifs',value:summary.events.active,sub:`${summary.events.total} au total`,hint:'Ouvrir les événements actifs',destination:{page:'events'}});
      cards.push({icon:'▣',label:'Salles réservées',value:summary.rooms.reserved,sub:`sur ${summary.rooms.total} disponibles`,hint:'Ouvrir les réservations de salles',destination:{page:'rooms',tab:'rooms-reservations'}});
      cards.push({icon:'⊞',label:'Équipe active',value:summary.users.active || DATA.users.filter(user => user.status === 'Actif').length || 0,sub:`${summary.users.total || DATA.users.length || 0} comptes internes`,hint:'Ouvrir les utilisateurs actifs',destination:{page:'users',search:'Actif'}});
      cards.push({icon:'♟',label:'Invités',value:summary.guests.total,sub:`${summary.guests.confirmed} confirmés`,hint:'Ouvrir les invités',destination:{page:'guests'}});
      cards.push({icon:'◎',label:'Revenus encaissés',value:fmtMoney(summary.revenue.paid),sub:`${fmtMoney(summary.revenue.pending)} en attente`,hint:'Ouvrir les paiements',destination:{page:'billing',tab:'billing-payments'}});
    } else if (currentRole === 'organisateur') {
      cards.push({icon:'◇',label:'Mes événements',value:summary.events.active,sub:`${summary.events.total} au total`,hint:'Ouvrir mes événements',destination:{page:'events'}});
      cards.push({icon:'▣',label:'Salles réservées',value:summary.rooms.reserved,sub:`sur ${summary.rooms.total} disponibles`,hint:'Ouvrir mes réservations de salles',destination:{page:'rooms',tab:'rooms-reservations'}});
      cards.push({icon:'♟',label:'Invités',value:summary.guests.total,sub:`${summary.guests.confirmed} confirmés`,hint:'Ouvrir les invités',destination:{page:'guests'}});
    } else if (currentRole === 'coordonnateur') {
      cards.push({icon:'◇',label:'Événements actifs',value:summary.events.active,sub:`${summary.events.total} au total`,hint:'Ouvrir les événements actifs',destination:{page:'events'}});
      cards.push({icon:'▣',label:'Salles réservées',value:summary.rooms.reserved,sub:`sur ${summary.rooms.total} disponibles`,hint:'Ouvrir les réservations de salles',destination:{page:'rooms',tab:'rooms-reservations'}});
      cards.push({icon:'⊛',label:'Coordination',value:summary.events.active,sub:'événements à coordonner',hint:'Ouvrir les demandes de services',destination:{page:'services',tab:'svc-requests'}});
    } else if (currentRole === 'compta') {
      cards.push({icon:'◎',label:'Revenus encaissés',value:fmtMoney(summary.revenue.paid),sub:'total payé',hint:'Ouvrir les paiements encaissés',destination:{page:'billing',tab:'billing-payments'}});
      cards.push({icon:'⏳',label:'En attente',value:fmtMoney(summary.revenue.pending),sub:'factures en cours',hint:'Ouvrir les factures en attente',destination:{page:'billing',invoiceStatus:'En attente'}});
      cards.push({icon:'⚠',label:'Factures en retard',value:summary.invoices.overdue,sub:'à relancer',hint:'Ouvrir les factures en retard',destination:{page:'billing',invoiceStatus:'En retard'}});
      cards.push({icon:'◫',label:'Événements facturés',value:summary.events.total,sub:`${summary.events.active} actifs`,hint:'Ouvrir les événements facturés',destination:{page:'events'}});
    }
    statsEl.style.gridTemplateColumns = `repeat(${cards.length}, 1fr)`;
    statsEl.innerHTML = cards.map(c => `
      <article class="stat-card stat-card-clickable" role="button" tabindex="0" aria-label="${escapeHtml(c.hint || c.label)}" data-destination='${escapeHtml(JSON.stringify(c.destination || { page: 'dashboard' }))}'>
        <div class="stat-icon-wrap">${c.icon}</div>
        <div class="stat-label">${c.label}</div>
        <div class="stat-value">${c.value}</div>
        <div class="stat-sub">${c.sub}</div>
      </article>`).join('');
    statsEl.querySelectorAll('.stat-card-clickable').forEach((card) => {
      const activate = () => {
        try {
          openDashboardDestination(JSON.parse(card.dataset.destination || '{}'));
        } catch (error) {
          console.error('Destination dashboard invalide:', error);
        }
      };
      card.addEventListener('click', activate);
      card.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          activate();
        }
      });
    });

    const todayStr = new Date().toISOString().slice(0, 10);
    const todaysEvents = DATA.events.filter(e => e.date === todayStr && e.status !== 'Annulé').length;
    const heroMetrics = {
      events: todaysEvents || summary.events.active || 0,
      rooms: `${summary.rooms.reserved}/${summary.rooms.total}`,
      guests: summary.guests.total || 0,
      revenue: currentRole === 'admin' || currentRole === 'compta'
        ? fmtMoney(summary.revenue.paid)
        : `${summary.events.active || 0} actifs`
    };
    const heroMetricEvents = document.getElementById('hero-metric-events');
    const heroMetricRooms = document.getElementById('hero-metric-rooms');
    const heroMetricGuests = document.getElementById('hero-metric-guests');
    const heroMetricRevenue = document.getElementById('hero-metric-revenue');
    if (heroMetricEvents) heroMetricEvents.textContent = heroMetrics.events;
    if (heroMetricRooms) heroMetricRooms.textContent = heroMetrics.rooms;
    if (heroMetricGuests) heroMetricGuests.textContent = heroMetrics.guests;
    if (heroMetricRevenue) heroMetricRevenue.textContent = heroMetrics.revenue;
  }

  // Upcoming events
  const upcoming = DATA.events
    .filter(e => e.status !== 'Terminé' && e.status !== 'Annulé')
    .sort((a, b) => (a.date || '').localeCompare(b.date || '')).slice(0, 4);
  const monthLabels = ['Jan','Fév','Mar','Avr','Mai','Jun','Jul','Aoû','Sep','Oct','Nov','Déc'];

  document.getElementById('upcoming-events-list').innerHTML = (upcoming.length ? `<div class="dashboard-list">${upcoming.map(e => `
    <div class="dashboard-list-item">
      <div class="dashboard-list-date">
        <span class="dashboard-list-day">${(e.date || '--').split('-')[2] || '--'}</span>
        <span class="dashboard-list-month">${e.date ? monthLabels[parseInt(e.date.split('-')[1], 10) - 1] : ''}</span>
      </div>
      <div>
        <div class="dashboard-list-title">${e.name}</div>
        <div class="dashboard-list-meta">${e.room || 'Salle à confirmer'} · ${e.time || 'Horaire à confirmer'} · ${e.guests || 0} invités</div>
      </div>
      ${statusBadge(e.status)}
    </div>
  `).join('')}</div>` : '<div class="dashboard-empty">Aucun événement à venir.</div>');

  // Notifications list
  const recentNotifications = DATA.notifications.slice(0, 4);
  document.getElementById('dash-notif-list').innerHTML = (recentNotifications.length ? `<div class="notification-stack">${recentNotifications.map(n => `
    <div class="notif-item${n.isRead ? '' : ' unread'}">
      <div class="notif-item-title">
        ${n.isRead ? '' : '<div style="width:7px;height:7px;border-radius:50%;background:var(--gold);flex-shrink:0"></div>'}
        <span style="font-weight:${n.isRead ? 500 : 600};color:${n.isRead ? 'var(--text)' : 'var(--gold-light)'}">${n.title}</span>
      </div>
      <div class="notif-item-body">${n.body || ''}</div>
      <div class="notif-item-time">${formatTimeAgo(n.dateCreated)}</div>
    </div>
  `).join('')}</div>` : '<div class="dashboard-empty">Aucune notification récente.</div>');

  // Hide/show dashboard sections by role
  const revenueCard = document.querySelector('#revenue-chart-canvas').closest('.card');
  if (revenueCard) revenueCard.closest('.grid-2').style.display = (currentRole === 'admin' || currentRole === 'compta') ? '' : 'none';
  renderRoleDashboardSpotlight(summary);

  renderCalendar();
  renderRevenueChartJS();
  
  // Initialize weather and map widgets
  fetchWeather();
  setTimeout(initHotelMap, 100);
  enhanceInteractiveAccessibility(document.getElementById('page-dashboard'));
}

function fmtMoney(val) {
  const n = Number(val) || 0;
  return n >= 1000 ? `$${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : `$${n}`;
}

function money(val) {
  const n = Number(val) || 0;
  return '$' + n.toLocaleString('fr-CA', {minimumFractionDigits:2, maximumFractionDigits:2});
}

function formatDateTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('fr-CA', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function getRoleSpotlightConfig(summary) {
  const today = new Date().toISOString().slice(0, 10);
  const myEvents = DATA.events.filter(event => event.status !== 'Annulé');
  const todaysEvents = myEvents.filter(event => event.date === today);
  const pendingServices = DATA.services.filter(service => !['Confirmé', 'Terminé'].includes(service.status));
  const dueInvoices = DATA.invoices.filter(invoice => ['En attente', 'Partiel', 'En retard'].includes(invoice.status));
  const paymentsToday = DATA.payments.filter(payment => String(payment.dateCreated || '').slice(0, 10) === today);
  const nextEvent = myEvents
    .filter(event => event.date >= today && event.status !== 'Terminé')
    .sort((a, b) => `${a.date || ''}${a.time || ''}`.localeCompare(`${b.date || ''}${b.time || ''}`))[0];

  const configs = {
    admin: {
      eyebrow: 'Contrôle opérationnel',
      title: 'Le rythme de la maison et les risques du jour',
      intro: 'Surveillez les signaux faibles, les revenus à confirmer et les tensions de coordination avant qu’elles n’affectent l’expérience client.',
      metrics: [
        { label: 'Salons engagés', value: `${summary.rooms.reserved || 0}/${summary.rooms.total || 0}`, note: 'occupation visible' },
        { label: 'Équipe active', value: summary.users.active || DATA.users.filter(user => user.status === 'Actif').length || 0, note: `${summary.users.total || DATA.users.length || 0} comptes internes` },
        { label: 'Services ouverts', value: pendingServices.length, note: 'à arbitrer' },
        { label: 'Factures à suivre', value: dueInvoices.length, note: 'relances utiles' }
      ],
      pulse: [
        `${todaysEvents.length} evenement(s) planifie(s) aujourd'hui`,
        `${DATA.notifications.filter(item => !item.isRead).length} notification(s) non lue(s)`,
        `${summary.revenue.pending ? money(summary.revenue.pending) : money(0)} restent à encaisser`
      ],
      actions: [
        { label: 'Voir les rapports', page: 'reports', helper: 'Finances et occupation' },
        { label: 'Ouvrir l’audit', page: 'users', helper: 'Traçabilité admin' },
        { label: 'Coordonner les services', page: 'services', helper: 'Besoins en attente' }
      ]
    },
    organisateur: {
      eyebrow: 'Carnet d’organisation',
      title: 'Vos réceptions à venir et les points de finition',
      intro: 'Gardez une lecture claire de vos événements, des invités attendus et des postes à verrouiller avant le jour J.',
      metrics: [
        { label: 'Prochain événement', value: nextEvent ? formatDate(nextEvent.date) : 'À venir', note: nextEvent?.name || 'Aucun programme' },
        { label: 'Invités', value: summary.guests.total || 0, note: `${summary.guests.confirmed || 0} confirmés` },
        { label: 'Services demandés', value: DATA.services.length, note: 'prestations suivies' }
      ],
      pulse: [
        nextEvent ? `${nextEvent.name} dans ${nextEvent.room || 'une salle à confirmer'}` : 'Aucun événement imminent',
        `${todaysEvents.length} evenement(s) à vivre aujourd'hui`,
        `${DATA.notifications.filter(item => !item.isRead).length} rappel(s) opérationnels`
      ],
      actions: [
        { label: 'Créer un événement', action: 'openEventModal', helper: 'Nouveau dossier' },
        { label: 'Ajouter un invité', page: 'guests', helper: 'Liste d’accueil' },
        { label: 'Réserver une salle', page: 'rooms', helper: 'Capacités et planning' }
      ]
    },
    coordonnateur: {
      eyebrow: 'Régie opérationnelle',
      title: 'Les espaces, les équipes et la cadence terrain',
      intro: 'Faites ressortir les points de friction de coordination pour garder un service fluide entre salles, fournisseurs et accueil.',
      metrics: [
        { label: 'Événements à coordonner', value: summary.events.active || 0, note: 'en cours ou planifiés' },
        { label: 'Services en attente', value: pendingServices.length, note: 'validation requise' },
        { label: 'Réservations à suivre', value: getActiveReservations().length, note: 'planning espaces' }
      ],
      pulse: [
        `${todaysEvents.length} evenement(s) à ouvrir ou fermer aujourd'hui`,
        `${getActiveReservations().filter(item => normalizeStatusValue(item.status) === 'en attente').length} réservation(s) en attente`,
        `${pendingServices.slice(0, 2).map(item => item.name).join(' ; ') || 'Aucun service critique'}`
      ],
      actions: [
        { label: 'Valider les services', page: 'services', helper: 'Flux fournisseurs' },
        { label: 'Voir les salles', page: 'rooms', helper: 'Disponibilités' },
        { label: 'Revoir les événements', page: 'events', helper: 'Brief terrain' }
      ]
    },
    compta: {
      eyebrow: 'Salon financier',
      title: 'Encaissements, relances et respiration du revenu',
      intro: 'Mettez en avant les factures qui bougent, les paiements du jour et les relances à sécuriser sans perdre la vision premium du lieu.',
      metrics: [
        { label: 'Paiements du jour', value: paymentsToday.length, note: paymentsToday.length ? money(paymentsToday.reduce((sum, payment) => sum + Number(payment.amount || 0), 0)) : money(0) },
        { label: 'En attente', value: dueInvoices.length, note: 'factures à suivre' },
        { label: 'Encaisse', value: summary.revenue.paid ? money(summary.revenue.paid) : money(0), note: 'cumulé confirmé' }
      ],
      pulse: [
        `${dueInvoices.filter(invoice => invoice.status === 'En retard').length} facture(s) en retard`,
        `${paymentsToday.length} paiement(s) consignés aujourd'hui`,
        `${summary.revenue.pending ? money(summary.revenue.pending) : money(0)} restent à recevoir`
      ],
      actions: [
        { label: 'Ouvrir la facturation', page: 'billing', helper: 'Factures et paiements' },
        { label: 'Voir les rapports', page: 'reports', helper: 'Lecture mensuelle' },
        { label: 'Contacter les clients', page: 'billing', helper: 'Relances et envois' }
      ]
    }
  };

  return configs[currentRole] || configs.admin;
}

function buildRoleActionMarkup(action) {
  const label = escapeHtml(action.label);
  const helper = escapeHtml(action.helper || '');
  if (action.page) {
    return `<button type="button" class="quick-action-chip" onclick="navigateTo('${action.page}')">
      <span>${label}</span>
      <small>${helper}</small>
    </button>`;
  }
  return `<button type="button" class="quick-action-chip" onclick="${action.action}()">
    <span>${label}</span>
    <small>${helper}</small>
  </button>`;
}

function renderRoleDashboardSpotlight(summary) {
  const container = document.getElementById('dashboard-role-spotlight');
  if (!container) return;
  const config = getRoleSpotlightConfig(summary);
  container.innerHTML = `
    <section class="role-spotlight-shell">
      <div class="role-spotlight-card">
        <div class="role-spotlight-kicker">${escapeHtml(config.eyebrow)}</div>
        <h2 class="role-spotlight-title">${escapeHtml(config.title)}</h2>
        <p class="role-spotlight-copy">${escapeHtml(config.intro)}</p>
        <div class="role-spotlight-metrics">
          ${config.metrics.map(metric => `
            <article class="role-metric-card">
              <div class="role-metric-label">${escapeHtml(metric.label)}</div>
              <strong class="role-metric-value">${escapeHtml(metric.value)}</strong>
              <div class="role-metric-note">${escapeHtml(metric.note)}</div>
            </article>
          `).join('')}
        </div>
      </div>
      <div class="role-pulse-card">
        <div class="role-pulse-head">
          <div class="role-pulse-kicker">Pulse de role</div>
          <div class="role-pulse-date">${formatDateTime(new Date().toISOString())}</div>
        </div>
        <div class="role-pulse-list">
          ${config.pulse.map(item => `
            <div class="role-pulse-item">
              <span class="role-pulse-dot"></span>
              <span>${escapeHtml(item)}</span>
            </div>
          `).join('')}
        </div>
        <div class="quick-action-grid">
          ${config.actions.map(buildRoleActionMarkup).join('')}
        </div>
      </div>
    </section>
  `;
}

/* Section */
async function renderRevenueChartJS() {
  const canvas = document.getElementById('revenue-chart-canvas');
  if (!canvas) return;
  
  const ctx = canvas.getContext('2d');
  const colors = getChartColors();
  
  // Destroy existing chart
  destroyChart('dashboardRevenue');
  
  // Prepare data
  const months = ['Jan','Fév','Mar','Avr','Mai','Jun','Jul','Aoû','Sep','Oct','Nov','Déc'];
  let vals = new Array(12).fill(0);
  
  if (DATA._revenueByMonth && DATA._revenueByMonth.length) {
    DATA._revenueByMonth.forEach(r => {
      if (r.month) {
        const mo = parseInt(r.month.split('-')[1]) - 1;
        if (mo >= 0 && mo < 12) vals[mo] = r.revenue || 0;
      }
    });
  }
  
  // Create gradient fill
  const gradient = createGradient(ctx, colors.goldGradientStart, colors.goldGradientEnd);
  
  chartInstances['dashboardRevenue'] = new Chart(ctx, {
    type: 'line',
    data: {
      labels: months,
      datasets: [{
        label: 'Revenus (CAD)',
        data: vals,
        borderColor: colors.gold,
        backgroundColor: gradient,
        fill: true,
        tension: 0.4,
        pointBackgroundColor: colors.gold,
        pointBorderColor: colors.gold,
        pointHoverBackgroundColor: '#fff',
        pointHoverBorderColor: colors.gold,
        pointRadius: 4,
        pointHoverRadius: 6,
        borderWidth: 2,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        intersect: false,
        mode: 'index',
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: colors.text === '#F0EAD6' ? '#1A1A1A' : '#FFFFFF',
          titleColor: colors.gold,
          bodyColor: colors.text === '#F0EAD6' ? '#F0EAD6' : '#1A1A1A',
          borderColor: colors.gold,
          borderWidth: 1,
          padding: 12,
          displayColors: false,
          callbacks: {
            label: (ctx) => `${money(ctx.parsed.y)} CAD`
          }
        }
      },
      scales: {
        x: {
          grid: { color: colors.gridColor, drawBorder: false },
          ticks: { color: colors.textMuted, font: { size: 10 } }
        },
        y: {
          grid: { color: colors.gridColor, drawBorder: false },
          ticks: { 
            color: colors.textMuted, 
            font: { size: 10 },
            callback: (val) => fmtMoney(val)
          },
          beginAtZero: true
        }
      },
      animation: {
        duration: 1000,
        easing: 'easeOutQuart'
      }
    }
  });
}

/* Section */
const MONTHS = ['Janvier','Février','Mars','Avril','Mai','Juin','Juillet','Août','Septembre','Octobre','Novembre','Décembre'];
const DAYS = ['Dim','Lun','Mar','Mer','Jeu','Ven','Sam'];

// FullCalendar instance
let roomsCalendar = null;

function buildRoomsCalendarEvents() {
  const fcEvents = DATA.events
    .filter(e => e.date && e.status !== 'Annulé')
    .map(e => {
      const start = e.date + (e.time ? 'T' + e.time : '');
      let end = e.date;
      if (e.endTime) {
        end = e.date + 'T' + e.endTime;
      } else if (e.time && e.duration) {
        const durationHours = parseInt(e.duration) || 2;
        const [h, m] = e.time.split(':').map(Number);
        const endH = h + durationHours;
        end = e.date + 'T' + String(endH).padStart(2, '0') + ':' + String(m).padStart(2, '0');
      }

      return {
        id: e.id,
        title: e.name,
        start,
        end,
        extendedProps: {
          room: e.room,
          guests: e.guests,
          status: e.status,
          type: e.type,
          organizer: e.organizer
        },
        classNames: [getEventStatusClass(e.status)],
        editable: e.status !== 'Terminé' && e.status !== 'Annulé'
      };
    });

  const reservationEvents = DATA.reservations
    .filter(r => r.date && r.status !== 'Annulé')
    .map(r => ({
      id: 'res-' + r.id,
      title: `📍 ${r.roomName || 'Salle'} - ${r.eventName || 'Réservation'}`,
      start: r.date + (r.startTime ? 'T' + r.startTime : ''),
      end: r.date + (r.endTime ? 'T' + r.endTime : ''),
      backgroundColor: r.status === 'Confirmé' ? 'var(--success)' : 'var(--warning)',
      borderColor: r.status === 'Confirmé' ? 'var(--success)' : 'var(--warning)',
      extendedProps: {
        isReservation: true,
        roomId: r.roomId,
        status: r.status
      },
      editable: false
    }));

  return [...fcEvents, ...reservationEvents];
}

function renderCalendar(targetId = 'cal-grid', dateRef = null) {
  const d = dateRef || calDate;
  const title = document.getElementById(targetId === 'cal-grid' ? 'cal-title' : 'cal2-title');
  if (title) title.textContent = MONTHS[d.getMonth()] + ' ' + d.getFullYear();

  const firstDay = new Date(d.getFullYear(), d.getMonth(), 1).getDay();
  const daysInMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  const today = new Date();

  let html = DAYS.map(day => `<div class="cal-header">${day}</div>`).join('');

  for (let i = 0; i < firstDay; i++) {
    const prevDay = new Date(d.getFullYear(), d.getMonth(), -firstDay + i + 1);
    html += `<div class="cal-day other-month"><span class="cal-day-num">${prevDay.getDate()}</span></div>`;
  }

  for (let day = 1; day <= daysInMonth; day++) {
    const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const events = DATA.events.filter(e => e.date === dateStr);
    const isToday = today.getFullYear() === d.getFullYear() && today.getMonth() === d.getMonth() && today.getDate() === day;

    html += `<div class="cal-day${isToday ? ' today' : ''}${events.length ? ' has-event' : ''}" onclick="calDayClick('${dateStr}')">
      <span class="cal-day-num">${day}</span>
      ${events.length ? `<div class="cal-dots">${events.slice(0, 3).map(e => `<div class="cal-dot ${e.status === 'Confirmé' ? 'success' : e.status === 'Planifié' ? '' : 'warning'}"></div>`).join('')}</div>` : ''}
    </div>`;
  }

  const target = document.getElementById(targetId);
  if (target) target.innerHTML = html;
}

function calPrev() { calDate.setMonth(calDate.getMonth() - 1); renderCalendar(); }
function calNext() { calDate.setMonth(calDate.getMonth() + 1); renderCalendar(); }

function calDayClick(dateStr) {
  const events = DATA.events.filter(e => e.date === dateStr);
  if (events.length) {
    showToast(`${events.length} événement(s) le ${dateStr}`, 'info');
  }
}

/* Section */
function getEventStatusClass(status) {
  const statusMap = {
    'Planifié': 'event-planifie',
    'Confirmé': 'event-confirme',
    'En cours': 'event-encours',
    'Terminé': 'event-termine',
    'Annulé': 'event-annule',
    'Brouillon': 'event-brouillon'
  };
  return statusMap[status] || 'event-planifie';
}

function initRoomsFullCalendar() {
  const calendarEl = document.getElementById('rooms-fullcalendar');
  if (!calendarEl || typeof FullCalendar === 'undefined') return;

  if (roomsCalendar) {
    refreshFullCalendar();
    window.requestAnimationFrame(() => roomsCalendar.updateSize());
    return;
  }

  roomsCalendar = new FullCalendar.Calendar(calendarEl, {
    initialView: 'dayGridMonth',
    locale: 'fr',
    firstDay: 0, // Sunday
    headerToolbar: {
      left: 'prev,next today',
      center: 'title',
      right: 'dayGridMonth,timeGridWeek,timeGridDay,listWeek'
    },
    buttonText: {
      today: "Aujourd'hui",
      month: 'Mois',
      week: 'Semaine',
      day: 'Jour',
      list: 'Liste'
    },
    events: buildRoomsCalendarEvents(),
    editable: true,
    selectable: true,
    selectMirror: true,
    dayMaxEvents: 3,
    weekends: true,
    nowIndicator: true,
    
    // Event click - open event details
    eventClick: function(info) {
      const event = info.event;
      if (event.extendedProps.isReservation) {
        showToast(`Réservation: ${event.title}`, 'info');
      } else {
        viewEvent(parseInt(event.id));
      }
    },
    
    // Date select - create new event
    select: function(info) {
      const selectedDate = info.startStr.split('T')[0];
      if (isPastDateOnly(selectedDate)) {
        roomsCalendar.unselect();
        showToast('Impossible de créer un événement dans une date passée.', 'error');
        return;
      }
      // Pre-fill event modal with selected date
      const dateInput = document.getElementById('ev-date');
      if (dateInput) {
        dateInput.min = getTodayDateKey();
        dateInput.value = selectedDate;
      }
      openEventModal();
      if (dateInput) dateInput.value = selectedDate;
      roomsCalendar.unselect();
    },
    
    // Event drag & drop - update event date
    eventDrop: async function(info) {
      const event = info.event;
      if (event.extendedProps.isReservation) {
        info.revert();
        showToast('Les réservations ne peuvent pas être déplacées ici', 'warning');
        return;
      }
      
      try {
        const newDate = info.event.startStr.split('T')[0];
        const newTime = info.event.start.toTimeString().slice(0, 5);
        if (isPastDateTime(newDate, newTime)) {
          info.revert();
          showToast('Impossible de déplacer un événement dans le passé.', 'error');
          return;
        }
        
        await updateEvent(parseInt(event.id), {
          date: newDate,
          time: newTime
        });
        
        showToast(`"${event.title}" déplacé au ${formatDate(newDate)}`, 'success');
        
        // Update local data
        const localEvent = DATA.events.find(e => e.id === parseInt(event.id));
        if (localEvent) {
          localEvent.date = newDate;
          localEvent.time = newTime;
        }
      } catch (err) {
        info.revert();
        showToast('Erreur lors du déplacement: ' + err.message, 'error');
      }
    },
    
    // Event resize - update duration
    eventResize: async function(info) {
      const event = info.event;
      if (event.extendedProps.isReservation) {
        info.revert();
        return;
      }
      
      try {
        const startTime = info.event.start.toTimeString().slice(0, 5);
        const endTime = info.event.end ? info.event.end.toTimeString().slice(0, 5) : null;
        if (isPastDateTime(info.event.startStr.split('T')[0], startTime)) {
          info.revert();
          showToast('Impossible de placer un événement dans le passé.', 'error');
          return;
        }
        if (endTime && timeToMinutes(endTime) <= timeToMinutes(startTime)) {
          info.revert();
          showToast('L’heure de fin doit être après l’heure de début.', 'error');
          return;
        }
        
        await updateEvent(parseInt(event.id), {
          time: startTime,
          endTime: endTime
        });
        
        showToast(`Durée de "${event.title}" mise à jour`, 'success');
      } catch (err) {
        info.revert();
        showToast('Erreur: ' + err.message, 'error');
      }
    },
    
    // Loading state
    loading: function(isLoading) {
      const container = document.querySelector('.fullcalendar-container');
      if (container) {
        if (isLoading) {
          container.style.opacity = '0.6';
        } else {
          container.style.opacity = '1';
        }
      }
    },
    
    // Date cell content customization
    dayCellDidMount: function(info) {
      // Add hover effect
      info.el.addEventListener('mouseenter', () => {
        info.el.style.cursor = 'pointer';
      });
    },
    
    // Event content customization
    eventContent: function(arg) {
      const props = arg.event.extendedProps;
      let html = `<div class="fc-event-main-frame">
        <div class="fc-event-title-container">
          <div class="fc-event-title">${arg.event.title}</div>
        </div>`;
      
      if (props.room && !props.isReservation) {
        html += `<div style="font-size:9px;opacity:0.8;margin-top:2px">📍 ${props.room}</div>`;
      }
      
      html += '</div>';
      return { html: html };
    }
  });
  
  roomsCalendar.render();
}

// Refresh FullCalendar after data changes
function refreshFullCalendar() {
  if (roomsCalendar) {
    roomsCalendar.batchRendering(() => {
    roomsCalendar.removeAllEvents();
    roomsCalendar.addEventSource(buildRoomsCalendarEvents());
    });
  }
}

/* Section */
async function renderEvents(filter = '', statusFilter = '') {
  try {
    const data = await fetchEvents();
    DATA.events = data.events || [];
  } catch (e) { console.error('Events fetch error:', e); }

  let events = DATA.events;
  if (filter) events = events.filter(e => e.name.toLowerCase().includes(filter.toLowerCase()) || (e.type || '').toLowerCase().includes(filter.toLowerCase()));
  if (statusFilter) events = events.filter(e => e.status === statusFilter);

  document.getElementById('events-grid').innerHTML = events.map(e => `
    <div class="event-card" onclick="viewEvent(${e.id})">
      <div class="event-card-main">
        <div class="event-card-head">
          <div class="event-card-title">${e.name}</div>
          ${statusBadge(e.status)}
        </div>
        <div class="event-card-meta">
          <div class="event-meta-item">📅 ${formatDate(e.date)}</div>
          <div class="event-meta-item">🕒 ${e.time || ''}</div>
          <div class="event-meta-item">👥 ${e.guests || 0}</div>
        </div>
        <div class="event-meta-item" style="margin-bottom:12px">📍 ${e.room || ''}</div>
        <div style="margin-bottom:8px">
          ${(() => {
            const used = e.budgetUsed || 0;
            const budget = e.budget || 0;
            if (budget <= 0) return `
              <div style="display:flex;justify-content:space-between;margin-bottom:4px">
                <span style="font-size:11px;color:var(--text-muted)">Budget non défini</span>
                <span style="font-size:11px;color:var(--text-muted)">—</span>
              </div>
              <div class="progress-bar"><div class="progress-fill" style="width:0%"></div></div>`;
            const pct = Math.min(100, Math.round(used / budget * 100));
            const color = pct > 90 ? 'var(--danger)' : pct > 70 ? 'var(--warning)' : 'var(--gold)';
            return `
              <div style="display:flex;justify-content:space-between;margin-bottom:4px">
                <span style="font-size:11px;color:var(--text-muted)">Budget: ${money(used)} / ${money(budget)} CAD</span>
                <span style="font-size:11px;color:${color}">${pct}%</span>
              </div>
              <div class="progress-bar"><div class="progress-fill" style="width:${pct}%;background:${pct > 90 ? 'var(--danger)' : pct > 70 ? 'linear-gradient(90deg, var(--warning), var(--gold))' : ''}"></div></div>`;
          })()}
        </div>
      </div>
      <div class="event-card-footer">
        <div class="event-card-actions">
          <button class="btn btn-sm" onclick="event.stopPropagation();editEvent(${e.id})">Modifier</button>
          ${e.status !== 'Terminé' && e.status !== 'Annulé' ? `<button class="btn btn-sm btn-danger" onclick="event.stopPropagation();cancelEvent(${e.id})">Annuler</button>` : ''}
        </div>
      </div>
    </div>
  `).join('') || '<div style="color:var(--text-muted);padding:32px;text-align:center">Aucun événement trouvé</div>';
}

function filterEvents(v) { renderEvents(v); }
function filterEventStatus(v) { renderEvents('', v); }

function viewEvent(id) {
  const e = DATA.events.find(ev => ev.id === id);
  if (!e) return;
  showToast(`Événement: ${e.name} — ${formatDate(e.date)}`, 'info');
}

async function populateEventOwnerSelect(selectedOwnerId = '') {
  const group = document.getElementById('ev-owner-group');
  const select = document.getElementById('ev-owner');
  if (!group || !select) return;
  if (currentRole !== 'admin') {
    group.style.display = 'none';
    select.value = '';
    selectedEventOrganizer = {
      name: `${currentUser?.fname || ''} ${currentUser?.lname || ''}`.trim(),
      email: currentUser?.email || ''
    };
    return;
  }
  group.style.display = '';
  try {
    if (!DATA.users.length) {
      const data = await fetchUsers();
      DATA.users = data.users || [];
    }
  } catch (err) {
    console.warn('Could not load users for event owner select:', err);
  }
  const organizers = DATA.users.filter(user => user.role === 'organisateur' && user.status !== 'Inactif');
  select.innerHTML = '<option value="">— Sélectionner un organisateur —</option>' +
    organizers.map(user => {
      const name = `${user.fname || ''} ${user.lname || ''}`.trim() || user.email;
      return `<option value="${user.id}" data-name="${escapeHtml(name)}" data-email="${escapeHtml(user.email || '')}">${escapeHtml(name)} · ${escapeHtml(user.email || '')}</option>`;
    }).join('');
  select.value = selectedOwnerId && organizers.some(user => Number(user.id) === Number(selectedOwnerId)) ? String(selectedOwnerId) : '';
  syncSelectedOrganizer();
}

function syncSelectedOrganizer() {
  const select = document.getElementById('ev-owner');
  const helper = document.getElementById('ev-owner-helper');
  if (!select) return;

  const option = select.selectedOptions?.[0];
  const name = option?.dataset?.name || '';
  const email = option?.dataset?.email || '';
  selectedEventOrganizer = { name, email };
  if (helper) helper.textContent = email ? `Contact: ${email}` : 'Choisissez un organisateur actif du système.';
}

async function editEvent(id) {
  const e = DATA.events.find(ev => ev.id === id);
  if (!e) return;
  editingEventId = id;
  document.getElementById('event-modal-title').textContent = 'Modifier l\'événement';
  document.getElementById('ev-name').value = e.name || '';
  document.getElementById('ev-type').value = e.type || 'Conférence';
  document.getElementById('ev-date').min = getTodayDateKey();
  document.getElementById('ev-date').value = e.date || '';
  document.getElementById('ev-time').value = e.time || '';
  document.getElementById('ev-end-time').value = e.endTime || '';
  document.getElementById('ev-budget').value = e.budget || '';
  document.getElementById('ev-guests').value = e.guests || '';
  selectedEventOrganizer = { name: e.organizer || '', email: e.contact || '' };
  document.getElementById('ev-desc').value = e.description || e.desc || '';
  if (e.room) document.getElementById('ev-room').value = e.room;
  await populateEventOwnerSelect(e.userId || '');
  openModal('event-modal');
}

async function cancelEvent(id) {
  const button = getClickedButton();
  const e = DATA.events.find(ev => ev.id === id);
  if (!e) return;
  
  const confirmed = await confirmAction({
    title: 'Annuler cet vnement ',
    text: `L'vnement "${e.name}" sera annul. Les services associs seront notifis.`,
    icon: 'warning',
    confirmText: 'Oui, annuler l\'vnement',
    cancelText: 'Non, garder'
  });
  
  if (confirmed) {
    try {
      setActionBusy(button, true, 'Annulation...');
      showLoading('Annulation en cours...');
      await updateEvent(id, { name: e.name, type: e.type, date: e.date, time: e.time, endTime: e.endTime, duration: e.duration, status: 'Annulé', budget: e.budget, guests: e.guests, room: e.room, organizer: e.organizer, contact: e.contact, description: e.description });
      hideLoading();
      showSuccess('Événement annulé', `"${e.name}" a été annulé avec succès.`);
      renderEvents();
    } catch (err) {
      hideLoading();
      showError('Erreur', err.message || 'Impossible d\'annuler l\'événement.');
    } finally {
      setActionBusy(button, false);
    }
  }
}

/* Section */
async function renderRooms() {
  try {
    const [roomData, resData, eventData] = await Promise.all([fetchRooms(), fetchReservations(), fetchEvents()]);
    DATA.rooms = roomData.rooms || [];
    DATA.reservations = resData.reservations || [];
    DATA.events = eventData.events || [];
  } catch (e) { console.error('Rooms fetch error:', e); }

  const activeReservations = DATA.reservations.filter(isActiveReservation);
  document.querySelectorAll('.admin-only-control').forEach(el => { el.style.display = currentRole === 'admin' ? '' : 'none'; });
  const availableRooms = DATA.rooms.filter(room => Number(room.available) !== 0 && !activeReservations.some(res => Number(res.roomId) === Number(room.id)));
  const maxCapacity = DATA.rooms.reduce((max, room) => Math.max(max, Number(room.capacity || 0)), 0);
  const roomsHeroTotal = document.getElementById('rooms-hero-total');
  const roomsHeroFree = document.getElementById('rooms-hero-free');
  const roomsHeroCapacity = document.getElementById('rooms-hero-capacity');
  if (roomsHeroTotal) roomsHeroTotal.textContent = DATA.rooms.length;
  if (roomsHeroFree) roomsHeroFree.textContent = availableRooms.length;
  if (roomsHeroCapacity) roomsHeroCapacity.textContent = maxCapacity;
  const typeFilter = document.getElementById('room-type-filter');
  if (typeFilter) {
    const previous = typeFilter.value;
    const types = [...new Set(DATA.rooms.map(r => r.type).filter(Boolean))].sort();
    typeFilter.innerHTML = '<option value="">Tous les types</option>' + types.map(type => `<option value="${escapeHtml(type)}">${escapeHtml(type)}</option>`).join('');
    typeFilter.value = previous;
  }
  const selectedType = typeFilter?.value || '';
  const minCapacity = Number(document.getElementById('room-capacity-filter')?.value || 0);
  const featureNeedle = (document.getElementById('room-feature-filter')?.value || '').trim().toLowerCase();
  const visibleRooms = DATA.rooms.filter((room) => {
    if (selectedType && room.type !== selectedType) return false;
    if (minCapacity && Number(room.capacity || 0) < minCapacity) return false;
    if (featureNeedle && !String(room.features || '').toLowerCase().includes(featureNeedle)) return false;
    return true;
  });

  document.getElementById('rooms-grid').innerHTML = visibleRooms.map(r => {
    const features = typeof r.features === 'string' ? r.features.split(',').map(f => f.trim()).filter(Boolean) : (r.features || []);
    const isReserved = activeReservations.some(res => res.roomId === r.id);
    const status = r.available === 0 ? 'Maintenance' : (isReserved ? 'Réservé' : 'Disponible');
    return `
    <div class="room-card${status === 'Maintenance' ? ' unavailable' : ''}" onclick="${status !== 'Maintenance' ? 'selectRoom(' + r.id + ')' : ''}">
      <div style="display:flex;justify-content:space-between;align-items:flex-start">
        <div class="room-name">${r.name}</div>
        <span class="badge ${status === 'Disponible' ? 'badge-success' : status === 'Réservé' ? 'badge-warning' : 'badge-danger'}">${status}</span>
      </div>
      <div class="room-capacity">👥 Capacité: ${r.capacity} personnes</div>
      <div class="room-capacity">💲 ${r.hourlyRate || 0}$ CAD / heure</div>
      <div class="room-features">${features.map(f => `<span class="feature-tag">${f}</span>`).join('')}</div>
      <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">
        ${status === 'Disponible' ? `<button class="btn btn-primary btn-sm" onclick="event.stopPropagation();doReserveRoom(${r.id})">Réserver</button>` : ''}
        ${currentRole === 'admin' ? `<button class="btn btn-sm" onclick="event.stopPropagation();openRoomAdminModal(${r.id})">Modifier</button><button class="btn btn-sm btn-danger" onclick="event.stopPropagation();removeRoomAdmin(${r.id})">Désactiver</button>` : ''}
      </div>
    </div>`;
  }).join('') || '<div style="color:var(--text-muted);padding:32px;text-align:center">Aucune salle trouvée</div>';

  // Reservations table
  document.getElementById('reservations-tbody').innerHTML = activeReservations.map(res => `
    <tr>
      <td>${res.eventName || '-'}</td>
      <td>${res.roomName || '-'}</td>
      <td>${formatDate(res.date)}</td>
      <td>${res.startTime || ''} – ${res.endTime || ''}</td>
      <td>${statusBadge(res.status)}</td>
      <td>${
        res.status === 'Confirmé'
          ? '<span style="color:var(--success);font-size:12px">✓</span>'
          : isPastDateTime(res.date, res.startTime || '00:00')
            ? '<span style="color:var(--text-muted);font-size:12px">Passée</span>'
            : `<button class="btn btn-sm" onclick="confirmReservation(${res.id})">Confirmer</button>`
      }</td>
    </tr>
  `).join('') || '<tr><td colspan="6" style="color:var(--text-muted);text-align:center">Aucune réservation</td></tr>';

  const calendarTab = document.getElementById('rooms-calendar');
  if (calendarTab && calendarTab.style.display !== 'none') {
    window.requestAnimationFrame(() => initRoomsFullCalendar());
  } else {
    refreshFullCalendar();
  }
}

async function doReserveRoom(roomId) {
  const button = getClickedButton();
  const room = DATA.rooms.find(r => r.id === roomId);
  const roomName = room ? room.name : 'Salle';

  const eventOptions = DATA.events.filter(isUsableEvent);
  const defaultDate = getTodayDateKey();
  const eventChoices = eventOptions.map(e =>
    `<option value="${e.id}">${e.name} (${formatDate(e.date)})</option>`
  ).join('');

  const reservationData = await promptForm({
    title: `Réserver ${roomName}`,
    confirmText: 'Confirmer la réservation',
    html: `
      <div style="display:grid;gap:14px;text-align:left">
        <div>
          <label style="display:block;font-size:12px;color:var(--text-muted);margin-bottom:6px">Événement associé</label>
          <select id="swal-room-event" class="swal2-input" style="margin:0;width:100%">
            <option value="">Aucun événement</option>
            ${eventChoices}
          </select>
        </div>
        <div>
          <label style="display:block;font-size:12px;color:var(--text-muted);margin-bottom:6px">Date</label>
          <input id="swal-room-date" type="date" class="swal2-input" min="${defaultDate}" value="${defaultDate}" style="margin:0;width:100%">
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
          <div>
            <label style="display:block;font-size:12px;color:var(--text-muted);margin-bottom:6px">Début</label>
            <input id="swal-room-start" type="time" class="swal2-input" value="09:00" style="margin:0;width:100%">
          </div>
          <div>
            <label style="display:block;font-size:12px;color:var(--text-muted);margin-bottom:6px">Fin</label>
            <input id="swal-room-end" type="time" class="swal2-input" value="17:00" style="margin:0;width:100%">
          </div>
        </div>
      </div>
    `,
    preConfirm: () => {
      const eventId = document.getElementById('swal-room-event').value;
      const date = document.getElementById('swal-room-date').value;
      const startTime = document.getElementById('swal-room-start').value;
      const endTime = document.getElementById('swal-room-end').value;

      if (!date || !startTime || !endTime) {
        Swal.showValidationMessage('La date et les heures sont requises.');
        return false;
      }

      if (!isValidDateKey(date) || !isValidTimeValue(startTime) || !isValidTimeValue(endTime)) {
        Swal.showValidationMessage('La date ou les heures sont invalides.');
        return false;
      }

      if (isPastDateTime(date, startTime)) {
        Swal.showValidationMessage('Impossible de réserver une salle dans le passé.');
        return false;
      }

      if (endTime <= startTime) {
        Swal.showValidationMessage('L\'heure de fin doit être après l\'heure de début.');
        return false;
      }

      const selectedEvent = eventId ? DATA.events.find(e => Number(e.id) === Number(eventId)) : null;
      if (selectedEvent) {
        if (!isUsableEvent(selectedEvent)) {
          Swal.showValidationMessage('Cet événement est terminé, annulé ou déjà passé.');
          return false;
        }
        if (selectedEvent.date && selectedEvent.date !== date) {
          Swal.showValidationMessage('La réservation doit être à la même date que l’événement associé.');
          return false;
        }
        if (room && Number(selectedEvent.guests || 0) > Number(room.capacity || 0)) {
          Swal.showValidationMessage(`${roomName} ne peut accueillir que ${room.capacity || 0} invités.`);
          return false;
        }
      }

      const conflict = getReservationConflict(roomId, date, startTime, endTime);
      if (conflict) {
        Swal.showValidationMessage(`${conflict.roomName || roomName} est déjà réservée de ${conflict.startTime} à ${conflict.endTime}.`);
        return false;
      }

      return {
        eventId: eventId ? parseInt(eventId, 10) : null,
        date,
        startTime,
        endTime
      };
    }
  });

  if (!reservationData) return;

  try {
    setActionBusy(button, true, 'Réservation...');
    const result = await reserveRoom({ roomId, ...reservationData });
    showToast(`${roomName} réservée! Coût: $${result.cost || 0}`, 'success');
    renderRooms();
  } catch (err) {
    showToast(err.message || 'Erreur de réservation', 'error');
  } finally {
    setActionBusy(button, false);
  }
}

async function confirmReservation(id) {
  const button = getClickedButton();
  const reservation = DATA.reservations.find(res => Number(res.id) === Number(id));
  if (reservation && isPastDateTime(reservation.date, reservation.startTime || '00:00')) {
    showToast('Impossible de confirmer une réservation déjà passée.', 'error');
    return;
  }
  try {
    setActionBusy(button, true, 'Confirmation...');
    await updateReservation(id, { status: 'Confirmé' });
    showToast('Réservation confirmée!', 'success');
    renderRooms();
  } catch (err) {
    showToast(err.message || 'Erreur', 'error');
  } finally {
    setActionBusy(button, false);
  }
}

function selectRoom(id) {}

function openRoomAdminModal(id = null) {
  const room = id ? DATA.rooms.find(r => Number(r.id) === Number(id)) : null;
  document.getElementById('room-admin-title').textContent = room ? 'Modifier salle et tarif' : 'Nouvelle salle et tarif';
  document.getElementById('room-admin-id').value = room?.id || '';
  document.getElementById('room-admin-name').value = room?.name || '';
  document.getElementById('room-admin-type').value = room?.type || 'Salle';
  document.getElementById('room-admin-capacity').value = room?.capacity || '';
  document.getElementById('room-admin-rate').value = room?.hourlyRate || '';
  document.getElementById('room-admin-features').value = room?.features || '';
  document.getElementById('room-admin-available').value = Number(room?.available ?? 1) === 0 ? '0' : '1';
  openModal('room-admin-modal');
}

async function saveRoomAdmin() {
  const id = document.getElementById('room-admin-id').value;
  const payload = {
    name: document.getElementById('room-admin-name').value.trim(),
    type: document.getElementById('room-admin-type').value.trim(),
    capacity: Number(document.getElementById('room-admin-capacity').value),
    hourlyRate: Number(document.getElementById('room-admin-rate').value),
    features: document.getElementById('room-admin-features').value.trim(),
    available: document.getElementById('room-admin-available').value === '1'
  };
  if (!payload.name || !payload.capacity) {
    showToast('Nom et capacité requis.', 'error');
    return;
  }
  try {
    if (id) await updateRoom(id, payload);
    else await createRoom(payload);
    closeModal('room-admin-modal');
    showToast('Salle et tarif enregistrés.', 'success');
    await renderRooms();
  } catch (err) {
    showToast(err.message || 'Erreur salle', 'error');
  }
}

async function removeRoomAdmin(id) {
  const confirmed = await confirmAction({
    title: 'Désactiver cette salle ?',
    text: 'La salle sera supprimée si elle n’a aucun historique, sinon mise en maintenance.',
    icon: 'warning',
    confirmText: 'Continuer',
    cancelText: 'Annuler'
  });
  if (!confirmed) return;
  try {
    await deleteRoom(id);
    showToast('Salle mise à jour.', 'success');
    await renderRooms();
  } catch (err) {
    showToast(err.message || 'Erreur salle', 'error');
  }
}

/* Section */
async function renderGuests(filter = '') {
  try {
    const [guestData, eventData] = await Promise.all([
      fetchGuests(filter ? { search: filter } : {}),
      fetchEvents()
    ]);
    DATA.guests = guestData.guests || [];
    DATA.events = eventData.events || [];
  } catch (e) { console.error('Guests fetch error:', e); }

  document.getElementById('guests-tbody').innerHTML = DATA.guests.map(g => {
    const canInvite = isValidEmailAddress(g.email);
    return `
    <tr>
      <td><strong>${g.fname} ${g.lname}</strong></td>
      <td>${g.email || ''}</td>
      <td>${g.eventName || '-'}</td>
      <td>${statusBadge(g.status)}</td>
      <td></td>
      <td>
        <button class="btn btn-sm" ${canInvite ? `onclick="doSendInvitation(${g.id})"` : 'disabled title="Courriel invalide ou manquant"'}>✉️ Inviter</button>
        <button class="btn btn-sm btn-danger" onclick="removeGuest(${g.id})">🗑️</button>
      </td>
    </tr>
  `;
  }).join('') || '<tr><td colspan="6" style="color:var(--text-muted);text-align:center">Aucun invité</td></tr>';

  // Guest event select
  const sel = document.getElementById('guest-event');
  sel.innerHTML = '<option value="">— Sélectionner —</option>' +
    DATA.events.filter(isUsableEvent).map(e => `<option value="${e.id}">${e.name}</option>`).join('');
}

function filterGuests(v) { renderGuests(v); }

let pendingGuestImportEventId = null;

async function openGuestCsvImport() {
  try {
    if (!DATA.events.length) {
      const eventData = await fetchEvents();
      DATA.events = eventData.events || [];
    }
  } catch (err) {
    showToast('Impossible de charger les événements pour l’import.', 'error');
    return;
  }

  const usableEvents = DATA.events.filter(isUsableEvent);
  const eventOptions = usableEvents.map(e => `<option value="${e.id}">${escapeHtml(e.name)} (${formatDate(e.date)})</option>`).join('');
  const result = await promptForm({
    title: 'Importer des invités CSV/Excel',
    confirmText: 'Choisir le fichier',
    html: `
      <div style="display:grid;gap:12px;text-align:left">
        <p style="color:var(--text-muted);font-size:12px;margin:0">Formats acceptés: CSV, XLS, XLSX. Colonnes: prenom, nom, email/courriel, telephone, statut, notes.</p>
        <label style="font-size:12px;color:var(--text-muted)">Événement associé</label>
        <select id="swal-import-event" class="swal2-input" style="margin:0;width:100%">
          <option value="">Aucun événement</option>
          ${eventOptions}
        </select>
      </div>
    `,
    preConfirm: () => ({ eventId: document.getElementById('swal-import-event').value || '' })
  });
  if (!result) return;
  pendingGuestImportEventId = result.eventId || null;
  const input = document.getElementById('guest-csv-input');
  if (input) {
    input.value = '';
    input.click();
  }
}

async function handleGuestCsvImport(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  if (!/\.(csv|xls|xlsx)$/i.test(file.name)) {
    showToast('Veuillez choisir un fichier CSV ou Excel.', 'error');
    input.value = '';
    return;
  }
  try {
    showLoading('Import invités en cours...');
    const result = await importGuests(file, pendingGuestImportEventId);
    hideLoading();
    showToast(result.message || 'Invités importés.', 'success');
    renderGuests();
  } catch (err) {
    hideLoading();
    showToast(err.message || 'Erreur d’import invités', 'error');
  } finally {
    pendingGuestImportEventId = null;
    input.value = '';
  }
}

async function doSendInvitation(id) {
  const button = getClickedButton();
  const guest = DATA.guests.find(g => Number(g.id) === Number(id));
  if (!guest || !isValidEmailAddress(guest.email)) {
    showToast('Courriel invité invalide ou manquant.', 'error');
    return;
  }
  const custom = await promptForm({
    title: 'Envoyer une invitation',
    confirmText: 'Envoyer',
    html: `
      <div style="display:grid;gap:12px;text-align:left">
        <label style="font-size:12px;color:var(--text-muted)">Message personnalisé</label>
        <textarea id="swal-invite-message" class="swal2-textarea" style="margin:0;width:100%;min-height:120px" placeholder="Bonjour ${escapeHtml(guest.fname)}, ..."></textarea>
      </div>
    `,
    preConfirm: () => ({ message: document.getElementById('swal-invite-message').value.trim() })
  });
  if (!custom) return;
  try {
    setActionBusy(button, true, 'Envoi...');
    const result = await sendInvitation(id, custom);
    showToast(result.message || 'Invitation envoyée!', 'success');
    renderGuests();
  } catch (err) {
    showToast(err.message || 'Erreur', 'error');
  } finally {
    setActionBusy(button, false);
  }
}

async function removeGuest(id) {
  const confirmed = await confirmAction({
    title: 'Supprimer cet invité ',
    text: 'Cette action supprimera définitivement cet invité de la liste.',
    icon: 'warning',
    confirmText: 'Oui, supprimer',
    cancelText: 'Annuler'
  });
  
  if (confirmed) {
    try {
      await deleteGuest(id);
      showSuccess('Invité supprimé', 'L\'invité a été retiré de la liste.');
      renderGuests();
    } catch (err) {
      showError('Erreur', err.message || 'Impossible de supprimer l\'invité.');
    }
  }
}

// Override api-integration's exportGuests with UI wrapper
async function exportGuests() {
  try {
    const blob = await apiRequest('/guests/export');
    if (blob instanceof Blob) {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'invites.csv';
      a.click();
      URL.revokeObjectURL(url);
    }
    showToast('Export CSV téléchargé!', 'success');
  } catch (err) {
    showToast(err.message || 'Erreur d\'export', 'error');
  }
}

/* Section */
async function renderServices() {
  try {
    const [data, catalog] = await Promise.all([fetchServices(), fetchServiceCatalog(currentRole === 'admin')]);
    DATA.services = data.services || [];
    DATA.servicesCatalog = (catalog.services || []).map(item => ({ ...item, desc: item.description || item.desc || '' }));
  } catch (e) { console.error('Services fetch error:', e); }

  document.getElementById('services-tbody').innerHTML = DATA.services.map(s => {
    const lockedEvent = isLockedEvent({ status: s.eventStatus }) || (s.eventDate && isPastDateTime(s.eventDate, s.eventTime || '23:59'));
    return `
    <tr>
      <td>${s.eventName || '-'}</td>
      <td>${s.name}</td>
      <td style="max-width:200px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${s.detail || ''}</td>
      <td>${statusBadge(s.status)}</td>
      <td style="color:var(--gold)">${money(s.cost)}</td>
      <td>
        ${(s.status === 'Demandé' || s.status === 'En attente') && !lockedEvent ? `<button class="btn btn-sm" onclick="validateService(${s.id})">✓ Valider</button>` : ''}
        ${(s.status === 'Demandé' || s.status === 'En attente') && lockedEvent ? '<span style="color:var(--text-muted);font-size:12px">Événement fermé</span>' : ''}
        ${s.status === 'Confirmé' ? '<span style="color:var(--success);font-size:12px">✓ Confirmé</span>' : ''}
      </td>
    </tr>
  `;
  }).join('') || '<tr><td colspan="6" style="color:var(--text-muted);text-align:center">Aucun service</td></tr>';

  document.querySelectorAll('.admin-only-control').forEach(el => { el.style.display = currentRole === 'admin' ? '' : 'none'; });
  document.getElementById('services-catalog-grid').innerHTML = DATA.servicesCatalog.map((s, idx) => `
    <div class="card" style="cursor:pointer" onclick="${Number(s.active) === 0 ? '' : `requestService(${idx})`}">
      <div style="font-size:28px;margin-bottom:8px">${s.icon}</div>
      <div style="font-size:15px;font-weight:500;margin-bottom:6px">${s.name}</div>
      <div style="font-size:12px;color:var(--text-muted);margin-bottom:12px">${s.desc}</div>
      <div style="font-size:11px;color:var(--gold)">À partir de ${s.priceFrom}$ / unité</div>
      <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">
        ${Number(s.active) !== 0 ? `<button class="btn btn-sm btn-primary" onclick="event.stopPropagation();requestService(${idx})">Demander</button>` : '<span class="badge badge-muted">Inactif</span>'}
        ${currentRole === 'admin' ? `<button class="btn btn-sm" onclick="event.stopPropagation();openCatalogServiceModal(${s.id})">Modifier</button><button class="btn btn-sm btn-danger" onclick="event.stopPropagation();removeCatalogService(${s.id})">Désactiver</button>` : ''}
      </div>
    </div>
  `).join('');
}

function openCatalogServiceModal(id = null) {
  const service = id ? DATA.servicesCatalog.find(s => Number(s.id) === Number(id)) : null;
  document.getElementById('catalog-service-title').textContent = service ? 'Modifier service catalogue' : 'Nouveau service catalogue';
  document.getElementById('catalog-service-id').value = service?.id || '';
  document.getElementById('catalog-service-name').value = service?.name || '';
  document.getElementById('catalog-service-type').value = service?.type || '';
  document.getElementById('catalog-service-icon').value = service?.icon || '•';
  document.getElementById('catalog-service-price').value = service?.priceFrom || 0;
  document.getElementById('catalog-service-description').value = service?.description || service?.desc || '';
  document.getElementById('catalog-service-active').value = Number(service?.active ?? 1) === 0 ? '0' : '1';
  openModal('catalog-service-modal');
}

async function saveCatalogService() {
  const id = document.getElementById('catalog-service-id').value;
  const payload = {
    name: document.getElementById('catalog-service-name').value.trim(),
    type: document.getElementById('catalog-service-type').value.trim(),
    icon: document.getElementById('catalog-service-icon').value.trim() || '•',
    description: document.getElementById('catalog-service-description').value.trim(),
    priceFrom: Number(document.getElementById('catalog-service-price').value || 0),
    active: document.getElementById('catalog-service-active').value === '1'
  };
  if (!payload.name) return showToast('Nom du service requis.', 'error');
  try {
    if (id) await updateCatalogService(id, payload);
    else await createCatalogService(payload);
    closeModal('catalog-service-modal');
    showToast('Catalogue de services mis à jour.', 'success');
    await renderServices();
  } catch (err) {
    showToast(err.message || 'Erreur catalogue', 'error');
  }
}

async function removeCatalogService(id) {
  const confirmed = await confirmAction({ title: 'Désactiver ce service ?', text: 'Il restera dans l’historique mais ne sera plus proposé.', icon: 'warning', confirmText: 'Désactiver', cancelText: 'Annuler' });
  if (!confirmed) return;
  try {
    await deleteCatalogService(id);
    showToast('Service désactivé.', 'success');
    await renderServices();
  } catch (err) {
    showToast(err.message || 'Erreur catalogue', 'error');
  }
}

async function validateService(id) {
  const button = getClickedButton();
  try {
    const s = DATA.services.find(x => x.id === id);
    if (s) {
      if (isLockedEvent({ status: s.eventStatus }) || (s.eventDate && isPastDateTime(s.eventDate, s.eventTime || '23:59'))) {
        showToast('Impossible de valider un service lié à un événement fermé.', 'error');
        return;
      }
      setActionBusy(button, true, 'Validation...');
      await updateService(id, { name: s.name, type: s.type, detail: s.detail, status: 'Confirmé', cost: s.cost, supplier: s.supplier, notes: s.notes });
      showToast('Service validé!', 'success');
      renderServices();
    }
  } catch (err) {
    showToast(err.message || 'Erreur', 'error');
  } finally {
    setActionBusy(button, false);
  }
}

async function requestService(catalogIndexOrName) {
  try {
    // Resolve catalog entry: accept index (number) or name (string)
    let preSelectedName = '';
    let preSelectedPrice = '';
    if (typeof catalogIndexOrName === 'number') {
      const cat = DATA.servicesCatalog[catalogIndexOrName];
      if (cat) { preSelectedName = cat.name; preSelectedPrice = cat.priceFrom; }
    } else if (typeof catalogIndexOrName === 'string' && catalogIndexOrName) {
      preSelectedName = catalogIndexOrName;
      const cat = DATA.servicesCatalog.find(c => c.name === catalogIndexOrName);
      if (cat) preSelectedPrice = cat.priceFrom;
    }

    // Ensure events are loaded for the dropdown
    try {
      const evData = await fetchEvents();
      DATA.events = evData.events || [];
    } catch (e) { console.warn('Could not load events:', e); }

    // Populate event dropdown with names
    const evtSel = document.getElementById('svc-event');
    evtSel.innerHTML = '<option value="">— Sélectionner un événement —</option>' +
      DATA.events.filter(isUsableEvent).map(e => `<option value="${e.id}">${e.name} (${formatDate(e.date)})</option>`).join('');

    // Reset form
    document.getElementById('svc-name').value = preSelectedName || '';
    document.getElementById('svc-custom-name').value = '';
    document.getElementById('svc-custom-group').style.display = 'none';
    document.getElementById('svc-detail').value = '';
    document.getElementById('svc-cost').value = preSelectedPrice || '';
    document.getElementById('svc-supplier').value = '';

    // On service dropdown change: auto-fill price from catalog
    document.getElementById('svc-name').onchange = function() {
      const selName = this.value;
      document.getElementById('svc-custom-group').style.display = selName === '__custom' ? '' : 'none';
      if (selName && selName !== '__custom') {
        const cat = DATA.servicesCatalog.find(c => c.name === selName);
        if (cat) document.getElementById('svc-cost').value = cat.priceFrom;
      } else {
        document.getElementById('svc-cost').value = '';
      }
    };

    openModal('service-modal');
  } catch (err) {
    console.error('requestService error:', err);
    showToast('Erreur lors de l\'ouverture du formulaire: ' + (err.message || err), 'error');
  }
}

async function saveServiceRequest() {
  const button = getClickedButton();
  const eventId = document.getElementById('svc-event').value;
  if (!eventId) { showToast('Veuillez sélectionner un événement.', 'error'); return; }
  const selectedEvent = DATA.events.find(e => Number(e.id) === Number(eventId));
  if (!isUsableEvent(selectedEvent)) { showToast('Impossible d’ajouter un service à cet événement.', 'error'); return; }

  let name = document.getElementById('svc-name').value;
  if (name === '__custom') name = document.getElementById('svc-custom-name').value.trim();
  if (!name) { showToast('Veuillez sélectionner ou saisir un service.', 'error'); return; }

  const cost = Number(document.getElementById('svc-cost').value);
  if (!Number.isFinite(cost)) { showToast('Veuillez saisir un coût valide.', 'error'); return; }
  if (cost <= 0) { showToast('Veuillez saisir un coût valide.', 'error'); return; }

  const detail = document.getElementById('svc-detail').value;
  const supplier = document.getElementById('svc-supplier').value;

  try {
    setActionBusy(button, true, 'Ajout...');
    await createService({ name, type: name, eventId: parseInt(eventId), detail, cost, supplier });
    showToast(`Service "${name}" ajouté avec succès!`, 'success');
    closeModal('service-modal');

    // Auto-generate or update invoice for this event
    try {
      const evt = DATA.events.find(e => e.id === parseInt(eventId));
      await generateInvoice(eventId, evt ? evt.organizer : '');
      showToast('Facture mise à jour automatiquement.', 'info');
    } catch (invErr) {
      // Invoice already exists — re-generate by updating it
      if (invErr.message && invErr.message.includes('existante')) {
        // Invoice exists, we need to regenerate totals
        try {
          const invData = await fetchInvoices();
          const existingInv = (invData.invoices || []).find(i => i.eventId === parseInt(eventId));
          if (existingInv) {
            // Fetch updated services total
            const svcData = await fetchServices(eventId);
            const svcs = svcData.services || [];
            const newAmount = svcs.reduce((s, sv) => s + (sv.cost || 0), 0);
            const newTaxes = Math.round(newAmount * 0.14975 * 100) / 100;
            const newTotal = Math.round((newAmount + newTaxes) * 100) / 100;
            await updateInvoice(existingInv.id, { status: existingInv.status, client: existingInv.client, notes: existingInv.notes });
            showToast('Facture existante trouvée — les totaux seront mis à jour.', 'info');
          }
        } catch (e2) { /* silently ignore */ }
      }
    }

    renderServices();
  } catch (err) {
    showToast(err.message || 'Erreur', 'error');
  } finally {
    setActionBusy(button, false);
  }
}

/* Section */
async function renderBilling() {
  try {
    if (!DATA.events.length) DATA.events = (await fetchEvents()).events || [];
    const eventFilter = document.getElementById('invoice-event-filter');
    if (eventFilter) {
      const previous = eventFilter.value;
      eventFilter.innerHTML = '<option value="">Tous les événements</option>' + DATA.events.map(e => `<option value="${e.id}">${escapeHtml(e.name)}</option>`).join('');
      eventFilter.value = previous;
    }
    const filters = {
      eventId: eventFilter?.value || '',
      status: document.getElementById('invoice-status-filter')?.value || '',
      from: document.getElementById('invoice-from-filter')?.value || '',
      to: document.getElementById('invoice-to-filter')?.value || ''
    };
    const [invData, payData] = await Promise.all([fetchInvoices(filters), fetchPayments()]);
    DATA.invoices = invData.invoices || [];
    DATA.payments = payData.payments || [];
  } catch (e) { console.error('Billing fetch error:', e); }

  // -- Invoices table --
  document.getElementById('invoices-tbody').innerHTML = DATA.invoices.map(inv => `
    <tr>
      <td style="color:var(--gold);font-family:monospace">${inv.number || 'INV-' + inv.id}</td>
      <td>${inv.eventName || '-'}</td>
      <td>${inv.client || ''}</td>
      <td>${money(inv.amount)}</td>
      <td style="color:var(--text-muted)">${money(inv.taxes)}</td>
      <td style="font-weight:500;color:var(--text)">${money(inv.total)}</td>
      <td>${invStatusBadge(inv.status)}</td>
      <td>
        <button class="btn btn-sm" onclick="viewInvoice(${inv.id})">Voir</button>
        <button class="btn btn-sm" onclick="sendInvoiceToClient(${inv.id})">? Envoyer</button>
        ${inv.status !== 'Payée' ? `<button class="btn btn-sm btn-primary" onclick="doPayInvoice(${inv.id})">💳 Payer</button>` : ''}
      </td>
    </tr>
  `).join('') || '<tr><td colspan="8" style="color:var(--text-muted);text-align:center">Aucune facture</td></tr>';

  // -- Payment summary stats (dynamic) --
  const paid = DATA.invoices.filter(i => i.status === 'Payée');
  const pending = DATA.invoices.filter(i => i.status === 'En attente' || i.status === 'Partiel');
  const overdue = DATA.invoices.filter(i => i.status === 'En retard');
  const paidTotal = paid.reduce((s, i) => s + (i.total || 0), 0);
  const pendingTotal = pending.reduce((s, i) => s + (i.total || 0), 0);
  const overdueTotal = overdue.reduce((s, i) => s + (i.total || 0), 0);

  document.getElementById('payment-stats').innerHTML = `
    <div class="stat-card"><div class="stat-label">Total encaissé</div><div class="stat-value">${money(paidTotal)}</div><div class="stat-sub">${paid.length} facture(s) payée(s)</div></div>
    <div class="stat-card"><div class="stat-label">En attente</div><div class="stat-value">${money(pendingTotal)}</div><div class="stat-sub">${pending.length} facture(s)</div></div>
    <div class="stat-card"><div class="stat-label">En retard</div><div class="stat-value">${money(overdueTotal)}</div><div class="stat-sub" style="color:var(--danger)">${overdue.length} facture(s)</div></div>
  `;

  // -- Payments table --
  document.getElementById('payments-tbody').innerHTML = DATA.payments.map(p => `
    <tr>
      <td>${formatDate(p.date)}</td>
      <td style="color:var(--gold);font-family:monospace">${p.invoiceNumber || ''}</td>
      <td>${p.client || ''}</td>
      <td style="color:var(--text)">${money(p.amount)}</td>
      <td>${p.method || ''}</td>
      <td></td>
    </tr>
  `).join('') || '<tr><td colspan="6" style="color:var(--text-muted);text-align:center">Aucun paiement</td></tr>';
}

async function viewInvoice(id) {
  const inv = DATA.invoices.find(i => i.id === id);
  if (!inv) return;

  document.getElementById('inv-modal-title').textContent = 'Facture ' + (inv.number || inv.id);

  // Fetch services for this event
  let services = [];
  if (inv.eventId) {
    try {
      const svcData = await fetchServices(inv.eventId);
      services = svcData.services || [];
    } catch (e) {}
  }

  document.getElementById('invoice-preview').innerHTML = `
    <div style="font-family:'Cormorant Garamond',serif">
      <div style="display:flex;justify-content:space-between;margin-bottom:24px">
        <div>
          <div style="font-size:24px;color:var(--gold);letter-spacing:2px">HÔTEL LA PROMENADE</div>
          <div style="font-size:12px;color:var(--text-muted)">123 Avenue La Promenade, Montréal, QC H3X 1A1</div>
          <div style="font-size:12px;color:var(--text-muted)">info@lapromenade.com · (514) 555-0100</div>
        </div>
        <div style="text-align:right">
          <div style="font-size:32px;font-weight:300;color:var(--text)">${inv.number || inv.id}</div>
          <div style="font-size:12px;color:var(--text-muted)">Émise le: ${inv.issueDate || new Date().toLocaleDateString('fr-CA')}</div>
          <div style="font-size:12px;color:var(--text-muted)">Échéance: ${inv.dueDate || ''}</div>
        </div>
      </div>
      <div style="border-top:1px solid var(--border);padding-top:16px;margin-bottom:16px">
        <div style="font-size:11px;letter-spacing:2px;color:var(--text-muted);margin-bottom:6px">FACTURER À</div>
        <div style="font-size:16px;font-weight:500">${inv.client || ''}</div>
        <div style="font-size:13px;color:var(--text-muted)">Événement: ${inv.eventName || ''}</div>
      </div>
      <table style="font-family:'DM Sans',sans-serif;margin-bottom:16px">
        <thead><tr><th>Service</th><th style="text-align:right">Montant</th></tr></thead>
        <tbody>
          ${services.map(s => `
            <tr><td>${s.name}${s.detail ? ' — ' + s.detail : ''}</td><td style="text-align:right;color:var(--text)">${money(s.cost)}</td></tr>
          `).join('')}
          <tr style="border-top:1px solid var(--border)">
            <td style="padding-top:12px;color:var(--text-muted)">Sous-total</td>
            <td style="text-align:right;padding-top:12px">${money(inv.amount)}</td>
          </tr>
          <tr><td style="color:var(--text-muted)">TPS + TVQ (14.975%)</td><td style="text-align:right">${money(inv.taxes)}</td></tr>
          <tr><td style="font-size:18px;color:var(--gold);padding-top:12px;border-top:1px solid var(--border-strong)">TOTAL</td>
            <td style="text-align:right;font-size:20px;color:var(--gold);font-weight:600;padding-top:12px;border-top:1px solid var(--border-strong)">${money(inv.total)}</td>
          </tr>
        </tbody>
      </table>
      <div style="margin-top:8px">${invStatusBadge(inv.status)}</div>
      <div style="margin-top:16px;display:flex;gap:8px">
        <button class="btn btn-sm" onclick="downloadInvoicePDF(${inv.id},'${(inv.number || '').replace(/'/g, "\\'")}')">📄 Télécharger PDF</button>
        <button class="btn btn-sm" onclick="sendInvoiceToClient(${inv.id})">? Envoyer au client</button>
        ${inv.status === 'Payée' ? `<button class="btn btn-sm" onclick="downloadReceipt(${inv.id},'${(inv.number || '').replace(/'/g, "\\'")}')">🧾 Reçu PDF</button>` : ''}
      </div>
    </div>
  `;
  openModal('invoice-modal');
}

async function sendInvoiceToClient(id) {
  const button = getClickedButton();
  const inv = DATA.invoices.find(i => i.id === id);
  if (!inv) return;
  const suggestedEmailMatch = String(inv.eventContact || inv.client || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  const suggestedEmail = suggestedEmailMatch ? suggestedEmailMatch[0] : '';
  const email = await promptForm({
    title: 'Envoyer la facture',
    confirmText: 'Envoyer',
    html: `
      <div style="text-align:left">
        <label style="display:block;font-size:12px;color:var(--text-muted);margin-bottom:6px">Courriel du client</label>
        <input id="swal-invoice-email" class="swal2-input" style="margin:0;width:100%" placeholder="client@entreprise.com" value="${suggestedEmail}">
      </div>
    `,
    preConfirm: () => {
      const value = document.getElementById('swal-invoice-email').value.trim();
      if (!isValidEmailAddress(value)) {
        Swal.showValidationMessage('Veuillez saisir un courriel client valide.');
        return false;
      }
      return value;
    }
  });
  if (!email) return;
  try {
    setActionBusy(button, true, 'Envoi...');
    const result = await sendInvoiceEmail(id, email);
    showToast(result.message || 'Facture envoyée.', 'success');
  } catch (err) {
    showToast(err.message || 'Impossible d\'envoyer la facture', 'error');
  } finally {
    setActionBusy(button, false);
  }
}

async function doPayInvoice(id) {
  const button = getClickedButton();
  const inv = DATA.invoices.find(i => Number(i.id) === Number(id));
  if (!inv) return;
  const paidAmount = DATA.payments
    .filter(payment => Number(payment.invoiceId) === Number(id))
    .reduce((sum, payment) => sum + Number(payment.amount || 0), 0);
  const remaining = Math.max(0, Math.round((Number(inv.total || 0) - paidAmount) * 100) / 100);
  if (remaining <= 0 && inv.status === 'Payée') {
    showToast('Cette facture est déjà payée.', 'info');
    return;
  }
  const paymentData = await promptForm({
    title: 'Traiter le paiement',
    confirmText: 'Encaisser le paiement',
    html: `
      <div style="text-align:left;display:grid;gap:14px">
        <div style="font-size:13px;color:var(--text-muted)">Solde restant: <strong style="color:var(--text)">${money(remaining)}</strong></div>
        <label style="display:block;font-size:12px;color:var(--text-muted);margin-bottom:6px">Méthode de paiement</label>
        <select id="swal-payment-method" class="swal2-input" style="margin:0;width:100%">
          <option value="En ligne">En ligne</option>
          <option value="Carte">Carte</option>
          <option value="Virement">Virement</option>
          <option value="Chèque">Chèque</option>
        </select>
        <label style="display:block;font-size:12px;color:var(--text-muted);margin-bottom:6px">Montant encaissé</label>
        <input id="swal-payment-amount" type="number" class="swal2-input" style="margin:0;width:100%" min="0" step="0.01" max="${remaining}" value="${remaining}">
      </div>
    `,
    preConfirm: () => {
      const method = document.getElementById('swal-payment-method').value;
      const amount = Number(document.getElementById('swal-payment-amount').value);
      if (!Number.isFinite(amount) || amount < 0) {
        Swal.showValidationMessage('Montant invalide.');
        return false;
      }
      if (remaining > 0 && amount <= 0) {
        Swal.showValidationMessage('Le paiement doit être supérieur à zéro.');
        return false;
      }
      if (amount > remaining + 0.005) {
        Swal.showValidationMessage('Le paiement dépasse le solde restant.');
        return false;
      }
      return { method, amount };
    }
  });
  if (!paymentData) return;
  try {
    setActionBusy(button, true, 'Paiement...');
    const result = await payInvoice(id, paymentData.method, paymentData.amount);
    showToast(result.message || 'Paiement traité!', 'success');
    renderBilling();
  } catch (err) {
    showToast(err.message || 'Erreur de paiement', 'error');
  } finally {
    setActionBusy(button, false);
  }
}

async function simulatePay() {
  const invText = document.getElementById('inv-modal-title').textContent;
  const inv = DATA.invoices.find(i => invText.includes(i.number || String(i.id)));
  if (inv) {
    try {
      await payInvoice(inv.id, 'En ligne');
      closeModal('invoice-modal');
      showToast('Paiement en ligne traité avec succès! ?', 'success');
      renderBilling();
    } catch (err) {
      showToast(err.message || 'Erreur', 'error');
    }
  } else {
    closeModal('invoice-modal');
    showToast('Paiement traité (simulation).', 'success');
  }
}

/* Section */
/* Section */
function getReportFilters() {
  return {
    from: document.getElementById('report-from-filter')?.value || '',
    to: document.getElementById('report-to-filter')?.value || '',
    eventId: document.getElementById('report-event-filter')?.value || ''
  };
}

async function renderReports() {
  const colors = getChartColors();
  if (!DATA.events.length) {
    try { DATA.events = (await fetchEvents()).events || []; } catch (e) {}
  }
  const eventFilter = document.getElementById('report-event-filter');
  if (eventFilter) {
    const previous = eventFilter.value;
    eventFilter.innerHTML = '<option value="">Tous les événements</option>' + DATA.events.map(e => `<option value="${e.id}">${escapeHtml(e.name)}</option>`).join('');
    eventFilter.value = previous;
  }
  const reportFilters = getReportFilters();
  
  // Revenue by month - Chart.js Line/Bar Chart
  try {
    const revData = await fetchRevenueByMonth(reportFilters);
    const chartData = revData.data || [];
    const monthNames = ['Jan', 'Fév', 'Mar', 'Avr', 'Mai', 'Jun', 'Jul', 'Aoû', 'Sep', 'Oct', 'Nov', 'Déc'];
    
    const canvas = document.getElementById('report-revenue-chart');
    if (canvas) {
      const ctx = canvas.getContext('2d');
      destroyChart('reportRevenue');
      
      let labels = [], values = [];
      if (chartData.length > 0) {
        chartData.forEach(d => {
          const mIdx = d.month ? parseInt(d.month.split('-')[1]) - 1 : 0;
          labels.push(monthNames[mIdx] || d.month);
          values.push(d.revenue || 0);
        });
      } else {
        labels = monthNames;
        values = monthNames.map(() => 0);
      }
      
      const gradient = createGradient(ctx, colors.goldGradientStart, colors.goldGradientEnd);
      
      chartInstances['reportRevenue'] = new Chart(ctx, {
        type: 'bar',
        data: {
          labels: labels,
          datasets: [{
            label: 'Revenus (CAD)',
            data: values,
            backgroundColor: gradient,
            borderColor: colors.gold,
            borderWidth: 1,
            borderRadius: 6,
            hoverBackgroundColor: colors.gold,
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: {
              backgroundColor: colors.text === '#F0EAD6' ? '#1A1A1A' : '#FFFFFF',
              titleColor: colors.gold,
              bodyColor: colors.text === '#F0EAD6' ? '#F0EAD6' : '#1A1A1A',
              borderColor: colors.gold,
              borderWidth: 1,
              callbacks: { label: (ctx) => `${money(ctx.parsed.y)} CAD` }
            }
          },
          scales: {
            x: { 
              grid: { color: colors.gridColor, drawBorder: false },
              ticks: { color: colors.textMuted, font: { size: 10 } }
            },
            y: { 
              grid: { color: colors.gridColor, drawBorder: false },
              ticks: { color: colors.textMuted, callback: (val) => fmtMoney(val) },
              beginAtZero: true
            }
          },
          animation: { duration: 800, easing: 'easeOutQuart' }
        }
      });
    }
  } catch (e) { console.error(e); }

  // Events by type - Doughnut Chart
  try {
    const typeData = await fetchEventsByType(reportFilters);
    const types = typeData.data || [];
    
    const canvas = document.getElementById('events-type-chart-canvas');
    if (canvas) {
      const ctx = canvas.getContext('2d');
      destroyChart('eventsType');
      
      const typeColors = [colors.gold, colors.success, colors.warning, colors.info, colors.danger, '#9C27B0', '#00BCD4', '#FF5722'];
      
      chartInstances['eventsType'] = new Chart(ctx, {
        type: 'doughnut',
        data: {
          labels: types.map(t => t.type || 'Autre'),
          datasets: [{
            data: types.map(t => t.count),
            backgroundColor: typeColors.slice(0, types.length),
            borderColor: colors.text === '#F0EAD6' ? '#1A1A1A' : '#FFFFFF',
            borderWidth: 2,
            hoverOffset: 8
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          cutout: '60%',
          plugins: {
            legend: {
              position: 'right',
              labels: { color: colors.textMuted, font: { size: 11 }, padding: 12 }
            },
            tooltip: {
              backgroundColor: colors.text === '#F0EAD6' ? '#1A1A1A' : '#FFFFFF',
              titleColor: colors.gold,
              bodyColor: colors.text === '#F0EAD6' ? '#F0EAD6' : '#1A1A1A',
              borderColor: colors.gold,
              borderWidth: 1
            }
          },
          animation: { duration: 1000, animateRotate: true }
        }
      });
    }
  } catch (e) { console.error(e); }

  // Room occupancy - Horizontal Bar Chart
  try {
    const occData = await fetchRoomOccupancy(reportFilters);
    const rooms = occData.data || [];
    
    const canvas = document.getElementById('room-occupancy-chart');
    if (canvas) {
      const ctx = canvas.getContext('2d');
      destroyChart('roomOccupancy');
      
      chartInstances['roomOccupancy'] = new Chart(ctx, {
        type: 'bar',
        data: {
          labels: rooms.map(r => r.name),
          datasets: [{
            label: 'Réservations',
            data: rooms.map(r => r.totalReservations || 0),
            backgroundColor: rooms.map(r => r.totalReservations > 0 ? colors.gold : colors.gridColor),
            borderRadius: 4,
          }]
        },
        options: {
          indexAxis: 'y',
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: {
              backgroundColor: colors.text === '#F0EAD6' ? '#1A1A1A' : '#FFFFFF',
              titleColor: colors.gold,
              bodyColor: colors.text === '#F0EAD6' ? '#F0EAD6' : '#1A1A1A',
              borderColor: colors.gold,
              borderWidth: 1,
              callbacks: { label: (ctx) => `${ctx.parsed.x} réservation(s)` }
            }
          },
          scales: {
            x: { 
              grid: { color: colors.gridColor, drawBorder: false },
              ticks: { color: colors.textMuted, stepSize: 1 },
              beginAtZero: true
            },
            y: { 
              grid: { display: false },
              ticks: { color: colors.textMuted, font: { size: 10 } }
            }
          },
          animation: { duration: 800 }
        }
      });
    }
  } catch (e) { console.error(e); }

  // Services cost - Polar Area Chart
  try {
    const svcData = await fetchServicesCost(reportFilters);
    const services = svcData.data || [];
    
    const canvas = document.getElementById('services-cost-chart');
    if (canvas) {
      const ctx = canvas.getContext('2d');
      destroyChart('servicesCost');
      
      const svcColors = [colors.gold, colors.success, colors.warning, colors.info, colors.danger, '#9C27B0', '#00BCD4', '#FF5722', '#795548'];
      
      chartInstances['servicesCost'] = new Chart(ctx, {
        type: 'polarArea',
        data: {
          labels: services.map(s => s.name || 'Service'),
          datasets: [{
            data: services.map(s => s.totalCost || 0),
            backgroundColor: svcColors.slice(0, services.length).map(c => c + '80'),
            borderColor: svcColors.slice(0, services.length),
            borderWidth: 1
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: {
              position: 'right',
              labels: { color: colors.textMuted, font: { size: 10 }, padding: 8 }
            },
            tooltip: {
              backgroundColor: colors.text === '#F0EAD6' ? '#1A1A1A' : '#FFFFFF',
              titleColor: colors.gold,
              bodyColor: colors.text === '#F0EAD6' ? '#F0EAD6' : '#1A1A1A',
              callbacks: { label: (ctx) => `${money(ctx.parsed.r)} CAD` }
            }
          },
          scales: {
            r: {
              grid: { color: colors.gridColor },
              ticks: { display: false },
              beginAtZero: true
            }
          },
          animation: { duration: 1000 }
        }
      });
    }
  } catch (e) { console.error(e); }
}

/* Section */
async function renderUsers() {
  try {
    const [usersData, auditData, settingsData] = await Promise.allSettled([
      fetchUsers(),
      currentRole === 'admin' ? fetchAudit() : Promise.resolve({ history: [] }),
      currentRole === 'admin' ? fetchSettings() : Promise.resolve({ settings: {} })
    ]);
    if (usersData.status === 'fulfilled') {
      DATA.users = usersData.value.users || [];
    } else if (!DATA.users.length) {
      showToast('Impossible de charger l’équipe pour le moment.', 'warning');
    }
    DATA.audit = auditData.status === 'fulfilled' ? (auditData.value.history || []) : [];
    if (settingsData.status === 'fulfilled') fillSettingsForm(settingsData.value.settings || {});
  } catch (e) {
    if (!DATA.users.length) {
      showToast('Impossible de charger l’équipe pour le moment.', 'warning');
    }
    DATA.audit = [];
  }

  renderUsersTable();
  renderAuditLog();
  enhanceInteractiveAccessibility(document.getElementById('page-users'));
}

function fillSettingsForm(settings) {
  Object.entries(settings).forEach(([key, value]) => {
    const input = document.getElementById(`setting-${key}`);
    if (input) input.value = value || '';
  });
}

async function saveSettings() {
  try {
    await updateSettings({
      hotelName: document.getElementById('setting-hotelName').value,
      invoicePaymentTermsDays: document.getElementById('setting-invoicePaymentTermsDays').value,
      taxRate: document.getElementById('setting-taxRate').value,
      contactEmail: document.getElementById('setting-contactEmail').value,
      billingAddress: document.getElementById('setting-billingAddress').value
    });
    showToast('Paramètres enregistrés.', 'success');
  } catch (err) {
    showToast(err.message || 'Erreur paramètres', 'error');
  }
}

function renderUsersTable() {
  const search = (document.getElementById('users-search').value || '').trim().toLowerCase();
  const filteredUsers = DATA.users.filter((u) => {
    if (!search) return true;
    return [u.fname, u.lname, u.email, u.role, u.status].join(' ').toLowerCase().includes(search);
  });

  document.getElementById('users-tbody').innerHTML = filteredUsers.map(u => `
    <tr>
      <td><strong>${u.fname} ${u.lname}</strong></td>
      <td>${u.email}</td>
      <td><span class="badge badge-gold">${u.role}</span></td>
      <td style="color:var(--text-muted)">${u.lastAccess || '–'}</td>
      <td><span class="badge ${u.status === 'Actif' ? 'badge-success' : 'badge-danger'}">${u.status}</span></td>
      <td>
        <button class="btn btn-sm" onclick="editUser(${u.id})">Modifier</button>
        ${u.email !== 'admin@lapromenade.com' ? `<button class="btn btn-sm btn-danger" onclick="deleteUser(${u.id})">Désactiver</button>` : ''}
      </td>
    </tr>
  `).join('') || '<tr><td colspan="6" style="color:var(--text-muted);text-align:center">Aucun utilisateur</td></tr>';
}

async function deleteUser(id) {
  const confirmed = await confirmAction({
    title: 'Désactiver cet utilisateur ',
    text: 'L\'utilisateur ne pourra plus se connecter mais ses données seront conservées.',
    icon: 'warning',
    confirmText: 'Oui, désactiver',
    cancelText: 'Annuler'
  });
  
  if (confirmed) {
    try {
      await deactivateUser(id);
      showToast('Utilisateur désactivé.', 'warning');
      renderUsers();
    } catch (err) {
      showError('Erreur', err.message || 'Impossible de désactiver l\'utilisateur.');
    }
  }
}

/* Section */
function renderNotifPanel() {
  document.getElementById('notif-list-panel').innerHTML = DATA.notifications.map(n => `
    <div class="notif-item${n.isRead ? '' : ' unread'}" onclick="markRead(${n.id})">
      <div class="notif-item-title">${getNotifIcon(n.type)} ${n.title}</div>
      <div class="notif-item-body">${n.body || ''}</div>
      <div class="notif-item-time">${formatTimeAgo(n.dateCreated)}</div>
    </div>
  `).join('') || '<div style="color:var(--text-muted);font-size:13px;padding:16px">Aucune notification</div>';
  enhanceInteractiveAccessibility(document.getElementById('notif-panel'));
}

async function renderAllNotifications() {
  try {
    const data = await fetchNotifications();
    DATA.notifications = data.notifications || [];
  } catch (e) {}

  document.getElementById('all-notif-list').innerHTML = DATA.notifications.map(n => `
    <div class="notif-item${n.isRead ? '' : ' unread'}" style="background:var(--surface);border:1px solid var(--border);margin-bottom:8px;border-radius:2px" onclick="markRead(${n.id})">
      <div class="notif-item-title">${getNotifIcon(n.type)} ${n.title}</div>
      <div class="notif-item-body">${n.body || ''}</div>
      <div class="notif-item-time">${formatTimeAgo(n.dateCreated)}</div>
    </div>
  `).join('') || '<div style="color:var(--text-muted);font-size:13px;padding:16px">Aucune notification</div>';
  enhanceInteractiveAccessibility(document.getElementById('page-notifications'));
}

function getNotifIcon(type) {
  return { success: '✓', danger: '⚠', warning: '⏳', info: 'ℹ' }[type] || 'ℹ';
}

async function markRead(id) {
  try {
    await markNotificationRead(id);
    const n = DATA.notifications.find(x => x.id === id);
    if (n) n.isRead = 1;
    renderNotifPanel();
    updateNotifBadge();
  } catch (e) {}
}

async function markAllRead() {
  try {
    await markAllNotificationsRead();
    DATA.notifications.forEach(n => n.isRead = 1);
    renderNotifPanel();
    updateNotifBadge();
    renderAllNotifications();
    buildNav();
  } catch (e) {}
}

function addNotification(title, body, type = 'info') {
  DATA.notifications.unshift({
    id: Date.now(), title, body, dateCreated: new Date().toISOString(), isRead: 0, type
  });
  renderNotifPanel();
  updateNotifBadge();
  buildNav();
}

function updateNotifBadge() {
  const unread = DATA.notifications.filter(n => !n.isRead).length;
  const dot = document.getElementById('notif-dot');
  if (dot) dot.style.display = unread > 0 ? 'block' : 'none';
}

function updateTeamChatBadge(unread = null) {
  const dot = document.getElementById('chat-unread-dot');
  if (!dot) return;
  const count = unread === null
    ? directMessageUsers.reduce((total, user) => total + Number(user.unreadCount || 0), 0)
    : Number(unread || 0);
  dot.style.display = count > 0 ? 'block' : 'none';
}

function teamChatUserName(user) {
  return `${user.fname || ''} ${user.lname || ''}`.trim() || user.email || 'Utilisateur';
}

function roleBadgeHtml(role) {
  const normalized = normalizeStatusValue(role || '');
  const label = ROLE_LABELS[role] || role || '';
  return `<span class="role-badge role-badge-${escapeHtml(normalized)}">${escapeHtml(label)}</span>`;
}

function renderTeamChatUsers() {
  const container = document.getElementById('team-chat-users');
  if (!container) return;
  container.innerHTML = directMessageUsers.map(user => `
    <button class="team-chat-user ${Number(user.id) === Number(activeDirectMessageUserId) ? 'active' : ''}" onclick="selectTeamChatUser(${user.id})">
      <span class="team-chat-avatar">${escapeHtml(getInitials(teamChatUserName(user)))}</span>
      <span>
        <span class="team-chat-name">${escapeHtml(teamChatUserName(user))}</span>
        <span class="team-chat-role">${roleBadgeHtml(user.role)}</span>
      </span>
      ${Number(user.unreadCount || 0) > 0 ? `<span class="team-chat-count">${Number(user.unreadCount)}</span>` : ''}
    </button>
  `).join('') || '<div class="team-chat-empty" style="padding:18px">Aucun autre utilisateur actif.</div>';
  updateTeamChatBadge();
}

async function refreshTeamChatUsers() {
  try {
    const data = await fetchDirectMessageUsers();
    directMessageUsers = data.users || [];
    renderTeamChatUsers();
    updateTeamChatBadge(data.unread || 0);
  } catch (err) {
    console.warn('Team chat users:', err.message);
  }
}

function teamMessageHtml(message) {
  const mine = Number(message.senderId) === Number(currentUser?.id || CURRENT_USER?.id);
  const name = mine ? 'Vous' : (message.senderName || 'Utilisateur');
  const role = mine ? (currentRole || CURRENT_USER?.role) : message.senderRole;
  return `
    <div class="team-message ${mine ? 'mine' : ''}" data-message-id="${message.id}">
      <div class="team-message-meta">
        <strong>${escapeHtml(name)}</strong>
        <span>${escapeHtml(ROLE_LABELS[role] || role || '')}</span>
        <time>${formatDateTime(message.dateCreated)}</time>
      </div>
      <div class="team-message-body">${escapeHtml(message.message)}</div>
    </div>`;
}

function renderTeamMessages(messages = []) {
  const container = document.getElementById('team-chat-messages');
  if (!container) return;
  container.innerHTML = messages.length
    ? messages.map(teamMessageHtml).join('')
    : '<div class="team-chat-empty team-chat-empty-card"><div class="team-chat-empty-mark">✦</div><div class="team-chat-empty-title">Premier mot de service</div><div class="team-chat-empty-copy">Aucun message pour cette conversation. Envoyez une note courte et précise pour lancer la coordination.</div></div>';
  container.scrollTop = container.scrollHeight;
}

function appendTeamMessage(message) {
  const container = document.getElementById('team-chat-messages');
  if (!container) return;
  if (container.querySelector(`[data-message-id="${message.id}"]`)) return;
  const empty = container.querySelector('.team-chat-empty');
  if (empty) empty.remove();
  container.insertAdjacentHTML('beforeend', teamMessageHtml(message));
  container.scrollTop = container.scrollHeight;
}

async function selectTeamChatUser(userId) {
  activeDirectMessageUserId = userId;
  const user = directMessageUsers.find(item => Number(item.id) === Number(userId));
  document.getElementById('team-chat-current-name').textContent = user ? teamChatUserName(user) : 'Conversation';
  document.getElementById('team-chat-current-role').textContent = user ? (ROLE_LABELS[user.role] || user.role || '') : 'Messages directs internes';
  renderTeamChatUsers();
  try {
    const data = await fetchDirectMessages(userId);
    renderTeamMessages(data.messages || []);
    await refreshTeamChatUsers();
  } catch (err) {
    showError('Conversation indisponible', err.message || 'Impossible de charger les messages.');
  }
}

async function toggleTeamChat(forceOpen) {
  const panel = document.getElementById('team-chat-panel');
  const button = document.getElementById('team-chat-btn');
  if (!panel) return;
  const open = typeof forceOpen === 'boolean' ? forceOpen : !panel.classList.contains('open');
  panel.classList.toggle('open', open);
  if (button) button.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (open) {
    await refreshTeamChatUsers();
  }
}

async function submitTeamChatMessage() {
  const input = document.getElementById('team-chat-input');
  const text = input.value.trim();
  if (!activeDirectMessageUserId) return showToast('Sélectionnez un destinataire.', 'warning');
  if (!text) return;
  const button = getClickedButton();
  try {
    setActionBusy(button, true, 'Envoi...');
    const result = await sendDirectMessage(activeDirectMessageUserId, text);
    input.value = '';
    appendTeamMessage(result.message);
    await refreshTeamChatUsers();
  } catch (err) {
    showError('Message non envoyé', err.message || 'Impossible d’envoyer le message.');
  } finally {
    setActionBusy(button, false);
  }
}

function handleDirectMessageRealtime(message, inbound) {
  const otherUserId = inbound ? message.senderId : message.recipientId;
  if (Number(otherUserId) === Number(activeDirectMessageUserId) && document.getElementById('team-chat-panel')?.classList.contains('open')) {
    appendTeamMessage(message);
    if (inbound) fetchDirectMessages(otherUserId).then(() => refreshTeamChatUsers()).catch(() => {});
  } else if (inbound) {
    showRealtimeToast('Nouveau message', `${message.senderName || 'Un utilisateur'} vous a écrit.`, 'info');
    refreshTeamChatUsers();
  }
}

function toggleNotifications() {
  const panel = document.getElementById('notif-panel');
  const button = document.getElementById('notif-btn');
  const open = panel.classList.toggle('open');
  if (button) button.setAttribute('aria-expanded', open ? 'true' : 'false');
}

/* Section */
function openModal(id) {
  const overlay = document.getElementById(id);
  if (!overlay) return;
  lastFocusedBeforeModal = document.activeElement;
  overlay.classList.add('open');
  activeModalId = id;
  modalFocusCleanup = trapModalFocus;
  document.addEventListener('keydown', modalFocusCleanup);
  ensureModalFocus(id);
}

function closeModal(id) {
  const overlay = document.getElementById(id);
  if (!overlay) return;
  overlay.classList.remove('open');
  if (activeModalId === id) {
    activeModalId = null;
    if (modalFocusCleanup) {
      document.removeEventListener('keydown', modalFocusCleanup);
      modalFocusCleanup = null;
    }
    if (lastFocusedBeforeModal && typeof lastFocusedBeforeModal.focus === 'function') {
      lastFocusedBeforeModal.focus();
    }
  }
}

async function openEventModal() {
  editingEventId = null;
  document.getElementById('event-modal-title').textContent = 'Nouvel événement';
  document.getElementById('ev-name').value = '';
  document.getElementById('ev-type').value = 'Conférence';
  document.getElementById('ev-date').min = getTodayDateKey();
  document.getElementById('ev-date').value = getTodayDateKey();
  document.getElementById('ev-time').value = '09:00';
  document.getElementById('ev-end-time').value = '11:00';
  document.getElementById('ev-budget').value = '';
  document.getElementById('ev-guests').value = '';
  selectedEventOrganizer = { name: '', email: '' };
  document.getElementById('ev-desc').value = '';
  await populateEventOwnerSelect('');
  openModal('event-modal');
}

function buildEventPayload(status) {
  const name = document.getElementById('ev-name').value.trim();
  const date = document.getElementById('ev-date').value;
  const time = document.getElementById('ev-time').value || '09:00';
  const endTime = document.getElementById('ev-end-time').value || '';
  const budgetRaw = document.getElementById('ev-budget').value;
  const guestsRaw = document.getElementById('ev-guests').value;
  const organizer = selectedEventOrganizer.name || '';
  const contact = selectedEventOrganizer.email || '';
  const ownerUserId = document.getElementById('ev-owner')?.value || '';
  const budget = budgetRaw === '' ? 0 : Number(budgetRaw);
  const guests = guestsRaw === '' ? 0 : Number(guestsRaw);

  if (!name) return { error: 'Le nom est requis.' };
  if (status !== 'Brouillon' && !date) return { error: 'La date est requise.' };
  if (date && !isValidDateKey(date)) return { error: 'La date est invalide.' };
  if (time && !isValidTimeValue(time)) return { error: 'L’heure de début est invalide.' };
  if (endTime && !isValidTimeValue(endTime)) return { error: 'L’heure de fin est invalide.' };
  if (time && endTime && timeToMinutes(endTime) <= timeToMinutes(time)) return { error: 'L’heure de fin doit être après l’heure de début.' };
  if (status !== 'Brouillon' && date && time && isPastDateTime(date, time)) {
    return { error: 'Impossible de créer un événement dans le passé.' };
  }
  if (!Number.isFinite(budget) || budget < 0) return { error: 'Le budget doit être positif ou zéro.' };
  if (!Number.isInteger(guests) || guests < 0) return { error: 'Le nombre d’invités doit être un entier positif ou zéro.' };
  if (currentRole === 'admin' && status !== 'Brouillon' && !ownerUserId) return { error: 'Veuillez choisir un organisateur dans la liste.' };
  if (contact && !isValidEmailAddress(contact)) return { error: 'Le courriel de contact est invalide.' };

  return { value: {
    name,
    type: document.getElementById('ev-type').value,
    date,
    time,
    endTime,
    duration: document.getElementById('ev-duration').value,
    budget,
    guests,
    room: document.getElementById('ev-room').value,
    organizer,
    contact,
    description: document.getElementById('ev-desc').value,
    status,
    ownerUserId: ownerUserId || undefined,
  } };
}

async function saveEvent() {
  const button = getClickedButton();
  const built = buildEventPayload('Planifié');
  if (built.error) { showToast(built.error, 'error'); return; }
  const eventData = built.value;
  const name = eventData.name;

  try {
    setActionBusy(button, true, 'Enregistrement...');
    if (editingEventId) {
      await updateEvent(editingEventId, eventData);
      showToast('Événement modifié!', 'success');
    } else {
      await createEvent(eventData);
      showToast(`"${name}" créé avec succès!`, 'success');
    }
    closeModal('event-modal');
    editingEventId = null;
    renderEvents();
  } catch (err) {
    showToast(err.message || 'Erreur', 'error');
  } finally {
    setActionBusy(button, false);
  }
}

async function saveEventDraft() {
  const button = getClickedButton();
  const built = buildEventPayload('Brouillon');
  if (built.error) { showToast(built.error, 'error'); return; }
  const eventData = built.value;
  const name = eventData.name;

  try {
    setActionBusy(button, true, 'Sauvegarde...');
    if (editingEventId) {
      await updateEvent(editingEventId, eventData);
    } else {
      await createEvent(eventData);
    }
    closeModal('event-modal');
    editingEventId = null;
    showToast(`Brouillon "${name}" sauvegardé.`, 'info');
    renderEvents();
  } catch (err) {
    showToast(err.message || 'Erreur', 'error');
  } finally {
    setActionBusy(button, false);
  }
}

function openGuestModal() {
  const sel = document.getElementById('guest-event');
  sel.innerHTML = '<option value="">— Sélectionner —</option>' +
    DATA.events.filter(isUsableEvent).map(e => `<option value="${e.id}">${e.name}</option>`).join('');
  document.getElementById('guest-fname').value = '';
  document.getElementById('guest-lname').value = '';
  document.getElementById('guest-email').value = '';
  document.getElementById('guest-phone').value = '';
  document.getElementById('guest-notes').value = '';
  openModal('guest-modal');
}

async function saveGuest() {
  const button = getClickedButton();
  const fname = document.getElementById('guest-fname').value.trim();
  const lname = document.getElementById('guest-lname').value.trim();
  const email = document.getElementById('guest-email').value.trim().toLowerCase();
  const eventId = parseInt(document.getElementById('guest-event').value) || null;
  if (!fname || !lname) { showToast('Prénom et nom requis.', 'error'); return; }
  if (!email || !isValidEmailAddress(email)) { showToast('Courriel valide requis.', 'error'); return; }
  if (eventId) {
    const selectedEvent = DATA.events.find(e => Number(e.id) === Number(eventId));
    if (!isUsableEvent(selectedEvent)) { showToast('Impossible d’ajouter un invité à cet événement.', 'error'); return; }
    const duplicate = DATA.guests.find(g => Number(g.eventId) === Number(eventId) && String(g.email || '').toLowerCase() === email);
    if (duplicate) { showToast('Cet invité existe déjà pour cet événement.', 'error'); return; }
  }

  try {
    setActionBusy(button, true, 'Ajout...');
    await createGuest({
      fname, lname,
      email,
      phone: document.getElementById('guest-phone').value,
      eventId,
      status: document.getElementById('guest-status').value,
      vip: document.getElementById('guest-vip').value === '1',
      notes: document.getElementById('guest-notes').value,
    });
    closeModal('guest-modal');
    showToast(`${fname} ${lname} ajouté(e) comme invité(e).`, 'success');
    renderGuests();
  } catch (err) {
    showToast(err.message || 'Erreur', 'error');
  } finally {
    setActionBusy(button, false);
  }
}

const USER_ROLE_LABELS = {
  admin: 'Administrateur',
  organisateur: 'Organisateur',
  coordonnateur: 'Coordonnateur',
  compta: 'Comptabilité'
};

const USER_ROLE_VALUES = Object.fromEntries(Object.entries(USER_ROLE_LABELS).map(([value, label]) => [label, value]));

function resetUserModal() {
  editingUserId = null;
  document.getElementById('user-modal-title').textContent = 'Nouvel utilisateur';
  document.getElementById('u-fname').value = '';
  document.getElementById('u-lname').value = '';
  document.getElementById('u-email').value = '';
  document.getElementById('u-role').value = 'Organisateur';
  document.getElementById('u-phone').value = '';
  document.getElementById('u-status').value = 'Actif';
  document.getElementById('u-pass').value = '';
  document.getElementById('u-pass').placeholder = 'Mot de passe provisoire';
  document.getElementById('u-pass-label').textContent = 'Mot de passe provisoire *';
  document.getElementById('user-modal-submit').textContent = 'Créer l\'utilisateur';
}

function openUserModal() {
  resetUserModal();
  openModal('user-modal');
}

function editUser(id) {
  const user = DATA.users.find(u => Number(u.id) === Number(id));
  if (!user) {
    showToast('Utilisateur introuvable.', 'error');
    return;
  }

  editingUserId = user.id;
  document.getElementById('user-modal-title').textContent = 'Modifier l\'utilisateur';
  document.getElementById('u-fname').value = user.fname || '';
  document.getElementById('u-lname').value = user.lname || '';
  document.getElementById('u-email').value = user.email || '';
  document.getElementById('u-role').value = USER_ROLE_LABELS[user.role] || 'Organisateur';
  document.getElementById('u-phone').value = user.phone || '';
  document.getElementById('u-status').value = user.status || 'Actif';
  document.getElementById('u-pass').value = '';
  document.getElementById('u-pass').placeholder = 'Laisser vide pour conserver le mot de passe';
  document.getElementById('u-pass-label').textContent = 'Nouveau mot de passe';
  document.getElementById('user-modal-submit').textContent = 'Enregistrer les modifications';
  openModal('user-modal');
}

async function saveUser() {
  const button = getClickedButton();
  const fname = document.getElementById('u-fname').value.trim();
  const lname = document.getElementById('u-lname').value.trim();
  const email = document.getElementById('u-email').value.trim().toLowerCase();
  const password = document.getElementById('u-pass').value;
  const role = USER_ROLE_VALUES[document.getElementById('u-role').value] || 'organisateur';
  const phone = document.getElementById('u-phone') ? document.getElementById('u-phone').value : '';
  const status = document.getElementById('u-status') ? document.getElementById('u-status').value : 'Actif';
  if (!fname || !lname) { showToast('Prénom et nom requis.', 'error'); return; }
  if (!email || !isValidEmailAddress(email)) { showToast('Courriel valide requis.', 'error'); return; }
  if (!editingUserId && !password) { showToast('Mot de passe requis.', 'error'); return; }
  if (password && password.length < 10) { showToast('Le mot de passe doit contenir au moins 10 caractères.', 'error'); return; }

  try {
    const payload = {
      fname, lname,
      email,
      role,
      phone,
      status
    };
    if (password) payload.password = password;

    setActionBusy(button, true, editingUserId ? 'Enregistrement...' : 'Création...');
    if (editingUserId) {
      await updateUser(editingUserId, payload);
    } else {
      await createUser(payload);
    }
    closeModal('user-modal');
    showToast(editingUserId ? `Utilisateur ${fname} ${lname} modifié.` : `Utilisateur ${fname} ${lname} créé.`, 'success');
    editingUserId = null;
    renderUsers();
  } catch (err) {
    showToast(err.message || 'Erreur', 'error');
  } finally {
    setActionBusy(button, false);
  }
}

/* Section */
function switchTab(el, targetId) {
  const tabsBar = el.closest('.tabs');
  const parent = tabsBar.parentElement;
  tabsBar.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  el.classList.add('active');
  // Only hide direct children of the page that are tab content (skip the .tabs bar itself)
  Array.from(parent.children).forEach(child => {
    if (child !== tabsBar) child.style.display = 'none';
  });
  const target = document.getElementById(targetId);
  if (target) target.style.display = '';
  el.dataset.target = targetId;
  syncTabAccessibility(parent);

  if (targetId === 'rooms-calendar') {
    window.requestAnimationFrame(() => initRoomsFullCalendar());
  }
}

function renderAuditLog() {
  const tbody = document.getElementById('audit-tbody');
  if (!tbody) return;

  const search = (document.getElementById('audit-search').value || '').trim().toLowerCase();
  const actionFilter = document.getElementById('audit-action-filter').value || '';
  const entityFilter = document.getElementById('audit-entity-filter').value || '';

  const actionSelect = document.getElementById('audit-action-filter');
  const entitySelect = document.getElementById('audit-entity-filter');
  if (actionSelect && actionSelect.options.length <= 1) {
    const actions = [...new Set(DATA.audit.map(item => item.action).filter(Boolean))].sort();
    actionSelect.innerHTML = '<option value="">Toutes les actions</option>' + actions.map(action => `<option value="${escapeHtml(action)}">${escapeHtml(action)}</option>`).join('');
  }
  if (entitySelect && entitySelect.options.length <= 1) {
    const entities = [...new Set(DATA.audit.map(item => item.entity).filter(Boolean))].sort();
    entitySelect.innerHTML = '<option value="">Toutes les entites</option>' + entities.map(entity => `<option value="${escapeHtml(entity)}">${escapeHtml(entity)}</option>`).join('');
  }
  if (actionSelect && actionFilter) actionSelect.value = actionFilter;
  if (entitySelect && entityFilter) entitySelect.value = entityFilter;

  const rows = DATA.audit.filter((entry) => {
    const haystack = [entry.fname, entry.lname, entry.action, entry.entity, entry.details, entry.dateCreated].join(' ').toLowerCase();
    return (!search || haystack.includes(search))
      && (!actionFilter || entry.action === actionFilter)
      && (!entityFilter || entry.entity === entityFilter);
  });

  const meta = document.getElementById('audit-results-meta');
  if (meta) meta.textContent = `${rows.length} trace${rows.length > 1 ? 's' : ''} affichée${rows.length > 1 ? 's' : ''}`;

  tbody.innerHTML = rows.map((entry) => `
    <tr>
      <td>${formatDateTime(entry.dateCreated)}</td>
      <td>
        <div class="audit-user-cell">
          <span class="audit-avatar">${getInitials(`${entry.fname || ''} ${entry.lname || ''}`) || 'LP'}</span>
          <div>
            <strong>${escapeHtml(`${entry.fname || ''} ${entry.lname || ''}`.trim() || 'Systeme')}</strong>
            <div style="color:var(--text-muted);font-size:11px">${escapeHtml(entry.userId ? `ID ${entry.userId}` : 'Automatique')}</div>
          </div>
        </div>
      </td>
      <td><span class="badge badge-gold">${escapeHtml(entry.action || 'Action')}</span></td>
      <td>${escapeHtml(entry.entity || '-')}</td>
      <td>${escapeHtml(entry.details || '-')}</td>
    </tr>
  `).join('') || '<tr><td colspan="5" style="color:var(--text-muted);text-align:center">Aucune trace d audit pour ces filtres</td></tr>';
}

function applyUserSearch() {
  renderUsersTable();
}

function applyAuditFilters() {
  renderAuditLog();
}

/* Section */
function statusBadge(status) {
  const map = {
    'Confirmé': 'badge-success', 'Planifié': 'badge-info', 'En cours': 'badge-gold',
    'Terminé': 'badge-muted', 'Annulé': 'badge-danger', 'Brouillon': 'badge-muted',
    'En attente': 'badge-warning', 'Demandé': 'badge-info', 'Invité': 'badge-info',
    'Décliné': 'badge-danger',
  };
  return `<span class="badge ${map[status] || 'badge-muted'}">${status || ''}</span>`;
}

function invStatusBadge(status) {
  const map = { 'Payée': 'badge-success', 'En attente': 'badge-warning', 'Partiel': 'badge-gold', 'En retard': 'badge-danger', 'Brouillon': 'badge-muted' };
  return `<span class="badge ${map[status] || 'badge-muted'}">${status || ''}</span>`;
}

function formatDate(dateStr) {
  if (!dateStr) return '-';
  const [y, m, d] = dateStr.split('-');
  const months = ['janv', 'févr', 'mars', 'avr', 'mai', 'juin', 'juil', 'août', 'sept', 'oct', 'nov', 'déc'];
  return `${parseInt(d)} ${months[parseInt(m) - 1]} ${y}`;
}

function formatTimeAgo(isoStr) {
  if (!isoStr) return '';
  const date = new Date(isoStr);
  const now = new Date();
  const diffMs = now - date;
  const diffMin = Math.floor(diffMs / 60000);
  const diffH = Math.floor(diffMin / 60);
  const diffD = Math.floor(diffH / 24);
  if (diffMin < 1) return 'À l\'instant';
  if (diffMin < 60) return `Il y a ${diffMin} min`;
  if (diffH < 24) return `Il y a ${diffH}h`;
  if (diffD === 1) return 'Hier';
  if (diffD < 7) return `Il y a ${diffD} jours`;
  return date.toLocaleDateString('fr-CA');
}

function showToast(msg, type = 'info') {
  // Use SweetAlert2 toast instead of custom toast
  const Toast = Swal.mixin({
    toast: true,
    position: 'top-end',
    showConfirmButton: false,
    timer: 4000,
    timerProgressBar: true,
    didOpen: (toast) => {
      toast.onmouseenter = Swal.stopTimer;
      toast.onmouseleave = Swal.resumeTimer;
    }
  });
  
  const iconMap = { success: 'success', error: 'error', warning: 'warning', info: 'info' };
  Toast.fire({
    icon: iconMap[type] || 'info',
    title: msg
  });
}

/* Section */

// Confirmation dialog for destructive actions
async function confirmAction(options = {}) {
  const result = await Swal.fire({
    title: options.title || 'Êtes-vous sûr ',
    text: options.text || 'Cette action est irréversible.',
    icon: options.icon || 'warning',
    showCancelButton: true,
    confirmButtonText: options.confirmText || 'Oui, confirmer',
    cancelButtonText: options.cancelText || 'Annuler',
    reverseButtons: true,
    focusCancel: true
  });
  
  return result.isConfirmed;
}

// Success notification
function showSuccess(title, text = '') {
  return Swal.fire({
    icon: 'success',
    title: title,
    text: text,
    timer: 2500,
    showConfirmButton: false
  });
}

// Error notification
function showError(title, text = '') {
  return Swal.fire({
    icon: 'error',
    title: title,
    text: text
  });
}

// Input dialog
async function promptInput(options = {}) {
  const result = await Swal.fire({
    title: options.title || 'Entrez une valeur',
    input: options.inputType || 'text',
    inputLabel: options.label || '',
    inputPlaceholder: options.placeholder || '',
    inputValue: options.defaultValue || '',
    showCancelButton: true,
    confirmButtonText: options.confirmText || 'Confirmer',
    cancelButtonText: 'Annuler',
    inputValidator: options.validator || null
  });
  
  return result.isConfirmed ? result.value : null;
}

async function promptForm(options = {}) {
  const result = await Swal.fire({
    title: options.title || 'Formulaire',
    html: options.html || '',
    showCancelButton: true,
    focusConfirm: false,
    confirmButtonText: options.confirmText || 'Confirmer',
    cancelButtonText: options.cancelText || 'Annuler',
    preConfirm: options.preConfirm || (() => true)
  });

  return result.isConfirmed ? result.value : null;
}

// Loading indicator
function showLoading(title = 'Chargement...') {
  Swal.fire({
    title: title,
    allowOutsideClick: false,
    allowEscapeKey: false,
    showConfirmButton: false,
    didOpen: () => {
      Swal.showLoading();
    }
  });
}

function hideLoading() {
  Swal.close();
}

// Close panels on outside click
document.addEventListener('click', e => {
  const panel = document.getElementById('notif-panel');
  const btn = document.getElementById('notif-btn');
  if (panel && panel.classList.contains('open') && !panel.contains(e.target) && e.target !== btn && !btn.contains(e.target)) {
    panel.classList.remove('open');
  }
});

document.addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.dataset.clickable === 'true') {
    e.preventDefault();
    e.target.click();
  }

  if (e.target.classList.contains('tab') && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
    const tabs = Array.from(e.target.closest('.tabs').querySelectorAll('.tab') || []);
    if (!tabs.length) return;
    const currentIndex = tabs.indexOf(e.target);
    const nextIndex = e.key === 'ArrowRight'
      ? (currentIndex + 1) % tabs.length
      : (currentIndex - 1 + tabs.length) % tabs.length;
    const nextTab = tabs[nextIndex];
    nextTab.focus();
    nextTab.click();
  }
});

// Escape key closes modals
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.modal-overlay.open').forEach(m => closeModal(m.id));
    document.getElementById('notif-panel').classList.remove('open');
  }
});

// Auto-login if token exists (session restore)
window.addEventListener('DOMContentLoaded', () => {
  initLampParticles();
  enhanceInteractiveAccessibility(document);
  hardenLoginAutofill();
  if (TOKEN && CURRENT_USER) {
    currentUser = CURRENT_USER;
    currentRole = CURRENT_USER.role;
    document.getElementById('getstarted-screen').style.display = 'none';
    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('app').style.display = 'block';
    initApp();
    initChatForUser();
    initSocket();
  } else {
    document.getElementById('app').style.display = 'none';
    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('getstarted-screen').style.display = 'flex';
  }
});

window.addEventListener('storage', (event) => {
  if (!['token', 'currentUser'].includes(event.key)) return;
  if (!localStorage.getItem('token') && !sessionStorage.getItem('token') && currentUser) {
    doLogout();
  }
});

/* Section */
let chatHistory = [];
let chatOpen = false;

const CHAT_SUGGESTIONS = {
  admin: [
    { icon: '👤', label: 'Gestion utilisateurs', text: 'Montre-moi un résumé des statistiques' },
    { icon: '📊', label: 'Rapports', text: 'Quels sont les revenus et factures en cours ' },
    { icon: '🏛️', label: 'Salles disponibles', text: 'Quelles salles sont disponibles ' },
    { icon: '📋', label: 'Audit', text: 'Résume mes notifications récentes' }
  ],
  organisateur: [
    { icon: '✨', label: 'Créer un événement', text: 'Aide-moi à créer un nouvel événement' },
    { icon: '🏛️', label: 'Réserver une salle', text: 'Quelles salles sont disponibles ' },
    { icon: '👥', label: 'Ajouter des invités', text: 'Comment ajouter des invités à mon événement ' },
    { icon: '🛎️', label: 'Services', text: 'Quels services puis-je demander pour un événement ' }
  ],
  coordonnateur: [
    { icon: '📋', label: 'Événements en cours', text: 'Liste-moi les événements en cours' },
    { icon: '🛎️', label: 'Services à valider', text: 'Quels services sont en attente de validation ' },
    { icon: '🏛️', label: 'Occupation des salles', text: 'Montre-moi les salles réservées' },
    { icon: '🔔', label: 'Notifications', text: 'Résume mes notifications récentes' }
  ],
  compta: [
    { icon: '🧾', label: 'Facturation', text: 'Montre-moi les factures en attente' },
    { icon: '📊', label: 'Revenus', text: 'Quel est le résumé des revenus ' },
    { icon: '💼', label: 'Générer facture', text: 'Comment générer une facture pour un événement ' },
    { icon: '🔔', label: 'Alertes', text: 'Résume mes notifications récentes' }
  ]
};

function initChatForUser() {
  resetChat();
  document.getElementById('chat-fab').style.display = 'flex';

  // Set role-specific suggestions
  const suggestions = CHAT_SUGGESTIONS[currentRole] || CHAT_SUGGESTIONS.organisateur;
  const sugEl = document.getElementById('chat-suggestions');
  sugEl.style.display = 'flex';
  sugEl.innerHTML = suggestions.map(s =>
    `<button class="chat-suggestion-btn" onclick="chatSuggest('${s.text.replace(/'/g, "\\'")}')"> ${s.icon} ${s.label}</button>`
  ).join('');

  // Set role-specific welcome message
  const roleGreetings = {
    admin: 'Bonjour ! En tant qu\'administrateur, je peux vous aider avec la gestion des utilisateurs, les statistiques globales, l\'audit et toutes les opérations de la plateforme.',
    organisateur: 'Bonjour ! Je peux vous aider à créer des événements, réserver des salles, gérer vos invités et demander des services.',
    coordonnateur: 'Bonjour ! Je peux vous aider à suivre les événements, valider les services et gérer l\'occupation des salles.',
    compta: 'Bonjour ! Je peux vous aider avec la facturation, les paiements, les rapports financiers et le suivi des revenus.'
  };
  const welcome = roleGreetings[currentRole] || 'Bonjour ! Comment puis-je vous aider ';
  const msgEl = document.getElementById('chat-messages');
  msgEl.innerHTML = sanitizeHTML(`<div class="chat-bubble ai">
    <div class="chat-bubble-avatar">
      <div class="chat-bubble-avatar-icon">✦</div>
      <div class="chat-bubble-avatar-name">Concierge IA</div>
    </div>
    ${welcome}
  </div>`);
}

function resetChat() {
  chatHistory = [];
  chatOpen = false;
  document.getElementById('chat-panel').classList.remove('open');
  document.getElementById('chat-fab').classList.remove('open');
  document.getElementById('chat-fab-icon').textContent = '🤖';
}

function toggleChat() {
  chatOpen = !chatOpen;
  document.getElementById('chat-panel').classList.toggle('open', chatOpen);
  document.getElementById('chat-fab').classList.toggle('open', chatOpen);
  document.getElementById('chat-fab-icon').textContent = chatOpen ? '✕' : '🤖';
  if (chatOpen) {
    setTimeout(() => document.getElementById('chat-input').focus(), 350);
  }
}

function chatSuggest(text) {
  document.getElementById('chat-input').value = text;
  sendChat();
}

function appendChatBubble(content, sender) {
  const container = document.getElementById('chat-messages');
  const bubble = document.createElement('div');
  bubble.className = `chat-bubble ${sender}`;

  if (sender === 'ai') {
    bubble.innerHTML = sanitizeHTML(`
      <div class="chat-bubble-avatar">
        <div class="chat-bubble-avatar-icon">✦</div>
        <div class="chat-bubble-avatar-name">Concierge IA</div>
      </div>
      ${formatChatContent(content)}`);
  } else {
    bubble.textContent = content;
  }

  container.appendChild(bubble);
  container.scrollTop = container.scrollHeight;
  return bubble;
}

function formatChatContent(text) {
  return text
    .replace(/\*\*(.*)\*\*/g, '<strong>$1</strong>')
    .replace(/\n/g, '<br>')
    .replace(/`(.*)`/g, '<code style="background:var(--surface3);padding:1px 5px;border-radius:3px;font-size:12px">$1</code>');
}

function showTypingIndicator() {
  const container = document.getElementById('chat-messages');
  const typing = document.createElement('div');
  typing.className = 'chat-bubble ai';
  typing.id = 'chat-typing';
  typing.innerHTML = `
    <div class="chat-bubble-avatar">
      <div class="chat-bubble-avatar-icon">✦</div>
      <div class="chat-bubble-avatar-name">Concierge IA</div>
    </div>
    <div class="chat-typing">
      <div class="chat-typing-dot"></div>
      <div class="chat-typing-dot"></div>
      <div class="chat-typing-dot"></div>
    </div>`;
  container.appendChild(typing);
  container.scrollTop = container.scrollHeight;
}

function removeTypingIndicator() {
  const el = document.getElementById('chat-typing');
  if (el) el.remove();
}

function buildLocalChatFallback(text) {
  const preview = String(text || '').slice(0, 90);
  return `Je peux continuer avec votre demande${preview ? `: "${preview}"` : ''}. Donnez les détails opérationnels: lister les salles, créer un événement, réserver une salle, ajouter un invité avec prénom, nom et événement, demander un service, générer une facture ou résumer les rapports.`;
}

async function sendChat() {
  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  if (!text) return;

  // Hide suggestions after first message
  const suggestions = document.getElementById('chat-suggestions');
  if (suggestions) suggestions.style.display = 'none';

  input.value = '';
  document.getElementById('chat-send-btn').disabled = true;

  appendChatBubble(text, 'user');
  chatHistory.push({ role: 'user', content: text });

  showTypingIndicator();

  try {
    const data = await sendChatMessage(chatHistory);
    removeTypingIndicator();
    const reply = data.reply || 'Désolé, une erreur est survenue.';
    appendChatBubble(reply, 'ai');
    chatHistory.push({ role: 'assistant', content: reply });

    // If the AI performed actions, refresh the frontend data
    if (data.actions && data.actions.length > 0) {
      await refreshAfterChatActions(data.actions);
    }
  } catch (err) {
    removeTypingIndicator();
    const reply = buildLocalChatFallback(text);
    appendChatBubble(reply, 'ai');
    chatHistory.push({ role: 'assistant', content: reply });
  }

  document.getElementById('chat-send-btn').disabled = false;
  input.focus();
}

async function refreshAfterChatActions(actions) {
  const types = new Set(actions.map(a => a.action));
  try {
    if (types.has('create_event') || types.has('list_events')) {
      DATA.events = (await fetchEvents()).events || [];
    }
    if (types.has('reserve_room') || types.has('list_rooms')) {
      DATA.rooms = (await fetchRooms()).rooms || [];
      DATA.reservations = (await fetchReservations()).reservations || [];
    }
    if (types.has('add_guest') || types.has('list_guests')) {
      DATA.guests = (await fetchGuests()).guests || [];
    }
    if (types.has('request_service') || types.has('list_services')) {
      DATA.services = (await fetchServices()).services || [];
    }
    if (types.has('generate_invoice')) {
      DATA.invoices = (await fetchInvoices()).invoices || [];
    }
    if (types.has('get_notifications')) {
      DATA.notifications = (await fetchNotifications()).notifications || [];
    }
    // Re-render current page to reflect changes
    const activePage = document.querySelector('.page.active');
    if (activePage) {
      const pageId = activePage.id.replace('page-', '');
      navigateTo(pageId);
    }
  } catch (e) {
    console.log('Chat data refresh:', e.message);
  }
}

// Export UI handlers explicitly so inline actions remain reliable across browsers.
Object.assign(window, {
  goToLogin,
  goToGetStarted,
  doLogin,
  doLogout,
  toggleTheme,
  toggleNotifications,
  toggleTeamChat,
  selectTeamChatUser,
  submitTeamChatMessage,
  topbarAction,
  navigateTo,
  openDashboardDestination,
  calDayClick,
  calPrev,
  calNext,
  switchTab,
  applyUserSearch,
  applyAuditFilters,
  openModal,
  closeModal,
  openEventModal,
  syncSelectedOrganizer,
  saveEvent,
  saveEventDraft,
  viewEvent,
  editEvent,
  cancelEvent,
  selectRoom,
  doReserveRoom,
  confirmReservation,
  openRoomAdminModal,
  saveRoomAdmin,
  removeRoomAdmin,
  openGuestModal,
  saveGuest,
  openGuestCsvImport,
  handleGuestCsvImport,
  filterEvents,
  filterEventStatus,
  filterGuests,
  doSendInvitation,
  removeGuest,
  requestService,
  saveServiceRequest,
  validateService,
  openCatalogServiceModal,
  saveCatalogService,
  removeCatalogService,
  viewInvoice,
  sendInvoiceToClient,
  doPayInvoice,
  simulatePay,
  openUserModal,
  editUser,
  saveUser,
  deleteUser,
  saveSettings,
  showToast,
  renderAllNotifications,
  markRead,
  markAllRead,
  getReportFilters,
  toggleChat,
  chatSuggest,
  sendChat
});

