# Copilot Instructions — Hôtel La Promenade

## Mandatory Workflow

- After every behavior change, UI option change, or new branch of implementation, run `npm test` before considering the work complete.
- If backend auth, permissions, billing, uploads, or reports are touched, run `npm test` and also start the server once with `npm start` to verify startup.
- If Telegram, email delivery, AI orchestration, or other external automations are changed, run `npm test` and `npm run test:stress`.
- Before any demo, client presentation, or final validation pass, run `npm run test:master`.
- If the master test reveals any issue, fix it and restart the full master test loop from zero instead of resuming from the failing step.
- Do not add app-install or PWA-style UX unless explicitly requested. This project should present itself as a premium website experience first.
- Creativity is a primary requirement. Favor bold, hospitality-grade presentation over generic dashboard UI.
- When 21st Magic MCP is available, use it first for section/layout ideation and adapt the output to this codebase instead of shipping plain utility UI.
- Treat the client as a **luxury hotel brand**. Push for richer hero sections, immersive 3D-style compositions, editorial hospitality storytelling, premium typography, and stronger visual identity.
- Light mode and dark mode must both preserve readable contrast. Never leave dark surfaces with dark text or light surfaces with washed-out text.
- Accessibility is worth it and is part of the baseline: improve ARIA labels, keyboard navigation, focus handling, and color contrast toward WCAG-compliant behavior on every significant UI pass.
- Every meaningful feature/UI/security/documentation change must be reflected in `README.md` under the version history and setup notes before the task is considered complete.
- Dynamic navigation and page controls must remain functional after any sanitization or rendering changes. Do not introduce blanket DOM transformations that strip event handlers from app-generated templates.
- Any UI action referenced by inline `onclick` or dynamic HTML must be exported explicitly on `window` so sidebar/page actions do not regress across browsers.
- Demo login presets may stay visible in local development as long as the backend demo accounts are synchronized to the same credentials.
- Invoice email delivery must use the configured hotel billing mailbox when Gmail credentials are present, and the setup must be documented in `.env.example` and `README.md`.
- Telegram concierge delivery must remain admin-only, produce French debriefs, and support both a mockable test path and a stress-test path.
- Concierge IA must prefer the highest-quota provider first, back off providers that hit quota/timeouts, and fall back to direct automation for common hotel operations when LLM providers are unavailable.
- Browser-level coverage matters for this project: the master test must verify quick-login presets, all demo profiles, sidebar navigation, and role-specific page access in a real browser.

## Project Overview

Event management platform for Hôtel La Promenade. Monolithic Express.js backend + vanilla JS SPA frontend. No framework, no bundler, no TypeScript.

---

## Cahier de Charge — User Stories (8 ÉPICs)

### ÉPIC 1 : Gestion des événements

| # | User Story | Implementation |
|---|-----------|----------------|
| 1 | En tant qu'organisateur, je veux **créer un événement** afin de planifier une activité à l'hôtel. | `POST /api/events` — creates event with `userId = req.userId`, status defaults to `'Planifié'`. Frontend: `saveEvent()` in app.js. |
| 2 | En tant qu'organisateur, je veux **définir les informations d'un événement** (nom, type, date, heure, budget) afin de structurer son organisation. | Events table columns: `name`, `type`, `date`, `time`, `endTime`, `duration`, `budget`, `guests`, `room`, `organizer`, `contact`, `description`. All set via event modal form. |
| 3 | En tant qu'organisateur, je veux **sélectionner des services** pour un événement afin de répondre aux besoins des participants. | Services are linked via `eventId` FK. `POST /api/services` with `eventId`. Frontend: `requestService()` opens service modal with event dropdown. |
| 4 | En tant qu'organisateur, je veux **joindre des documents** à un événement afin de centraliser toutes les informations utiles. | `POST /api/events/:id/documents` — Multer upload (10MB limit, stored in `uploads/`). Table: `event_documents` with `eventId`, `filename`, `originalName`, `mimetype`, `size`, `uploadedBy`. |
| 5 | En tant qu'organisateur, je veux **enregistrer un événement en brouillon** afin de le compléter plus tard. | `saveEventDraft()` in app.js sends `status: 'Brouillon'` to `POST /api/events`. |
| 6 | En tant qu'organisateur, je veux **modifier un événement** afin de mettre à jour ses informations. | `PUT /api/events/:id` — checks ownership (`event.userId === req.userId`) or admin/coordonnateur role. Frontend: `editEvent(id)` prefills modal. |
| 7 | En tant qu'organisateur, je veux **annuler un événement** afin d'informer les services concernés tout en conservant l'historique. | **Soft delete**: `DELETE /api/events/:id` sets `status = 'Annulé'` (never deletes row). Notifies coordonnateurs via `notifyRole('coordonnateur', ...)`. |
| 8 | En tant que système, je veux **conserver l'historique des événements** afin d'assurer la traçabilité. | `logAudit(userId, action, entity, entityId, details)` called after every CREATE/UPDATE/DELETE on events. Stored in `audit_history` table. |

### ÉPIC 2 : Réservation des espaces

| # | User Story | Implementation |
|---|-----------|----------------|
| 1 | En tant qu'organisateur, je veux **consulter les salles disponibles via un calendrier** afin de choisir un créneau libre. | `renderCalendar()` in app.js renders monthly calendar grid. Events overlay on dates via `DATA.events.filter(e => e.date === dateStr)`. Second calendar in rooms page via `cal2-grid`. |
| 2 | En tant qu'organisateur, je veux **filtrer les salles par type, capacité et équipements** afin de trouver une salle adaptée. | `GET /api/roomstype=X&capacity=N&feature=Y` — server-side SQL filtering: `AND type = `, `AND capacity >= `, `AND features LIKE `. |
| 3 | En tant qu'organisateur, je veux **visualiser les plages horaires déjà réservées** afin d'éviter les conflits. | Reservations table visible in rooms page: `renderRooms()` shows `DATA.reservations` with room name, event name, date, start/end time, status. |
| 4 | En tant qu'organisateur, je veux **sélectionner un créneau libre** afin de réserver une salle. | `doReserveRoom(roomId)` prompts for eventId, date, startTime, endTime then calls `POST /api/rooms/reserve`. |
| 5 | En tant qu'organisateur, je veux **recevoir une confirmation de réservation** afin de valider mon choix. | After successful reserve, `createNotification()` sends confirmation to user. Frontend shows toast. `confirmReservation(id)` sets status to `'Confirmé'`. |
| 6 | En tant que système, je veux **empêcher les conflits de réservation** afin d'éviter l'utilisation simultanée d'une même salle. | **Conflict detection** in `POST /api/rooms/reserve`: SQL query checks `WHERE roomId= AND date= AND status!='Annulé' AND startTime <  AND endTime > `. Returns HTTP 409 with conflict details. |

### ÉPIC 3 : Gestion des invités

| # | User Story | Implementation |
|---|-----------|----------------|
| 1 | En tant qu'organisateur, je veux **importer une liste d'invités** afin de gagner du temps. | `POST /api/guests/import` — Multer CSV upload. Parses headers (`prénom/nom/email/téléphone`), inserts rows, deletes temp file. Frontend: `importGuests(file, eventId)`. |
| 2 | En tant qu'organisateur, je veux **ajouter un invité** afin de compléter la liste des participants. | `POST /api/guests` with `fname`, `lname`, `email`, `phone`, `eventId`, `status`, `vip`, `notes`. Frontend: `openGuestModal()` → `saveGuest()`. |
| 3 | En tant qu'organisateur, je veux **modifier ou supprimer un invité** afin de maintenir une liste à jour. | `PUT /api/guests/:id` updates all fields. `DELETE /api/guests/:id` is a **hard delete** (unlike events). Frontend: `removeGuest(id)` with confirm dialog. |
| 4 | En tant qu'organisateur, je veux **rechercher un invité** afin de retrouver rapidement ses informations. | `GET /api/guestssearch=X` — SQL `LIKE` on `fname`, `lname`, `email`. Frontend: `filterGuests(v)` triggers `renderGuests(filter)`. |
| 5 | En tant qu'organisateur, je veux **envoyer des invitations par courriel** afin d'informer les participants. | `POST /api/guests/:id/invite` — **mock email** (console.log). Updates guest status to `'Invité'`. Logs audit. Frontend: `doSendInvitation(id)`. |
| 6 | En tant qu'organisateur, je veux **suivre le statut des invités** afin de connaître leur participation. | Guest statuses: `'En attente'`, `'Invité'`, `'Confirmé'`, `'Décliné'`. Displayed as colored badges in guests table. VIP flag (`vip` column, INTEGER 0/1). |
| 7 | En tant qu'organisateur, je veux **exporter la liste des invités** afin de l'utiliser hors de la plateforme. | `GET /api/guests/exporteventId=X` — returns CSV with BOM (`\uFEFF`) for Excel compatibility. Headers: `Prénom,Nom,Courriel,Téléphone,Événement,Statut,VIP,Notes`. Frontend: `exportGuests()` triggers blob download. |

### ÉPIC 4 : Coordination des services

| # | User Story | Implementation |
|---|-----------|----------------|
| 1 | En tant qu'organisateur, je veux **demander des services** pour un événement afin d'assurer son bon déroulement. | `POST /api/services` with `name`, `type`, `detail`, `eventId`, `cost`, `supplier`, `notes`, `options`. Status defaults to `'Demandé'`. Notifies coordonnateurs. |
| 2 | En tant qu'organisateur, je veux **sélectionner des options de traiteur** afin de répondre aux besoins alimentaires. | `DATA.servicesCatalog` in app.js: `'Traiteur Gastronomique'` (45$/unit), `'Bar & Cocktails'` (500$). Auto-fills cost from catalog. |
| 3 | En tant qu'organisateur, je veux **demander des équipements audiovisuels** afin de soutenir les présentations. | Catalog entry: `'Audiovisuel Premium'` (800$) — sono, projecteurs, écrans LED, éclairage scénique. |
| 4 | En tant qu'organisateur, je veux **planifier des services de sécurité** afin d'assurer la sécurité des participants. | Catalog entry: `'Sécurité & Accueil'` (240$) — agents de sécurité et personnel d'accueil. |
| 5 | En tant que coordonnateur hôtel, je veux **valider les demandes de services** afin d'organiser les ressources internes. | `PUT /api/services/:id` with `status: 'Confirmé'`. Frontend: `validateService(id)` — only visible for coordonnateur/admin roles. Service statuses: `'Demandé'` → `'Confirmé'`. |
| 6 | En tant que système, je veux **générer un devis** selon les services demandés afin d'estimer le coût total. | `GET /api/devis/:eventId` — aggregates all services costs + room reservation cost. Returns `items[]`, `subtotal`, `taxRate` (14.975%), `taxes`, `total`. |

**Full services catalog** (9 types): Traiteur Gastronomique, Audiovisuel Premium, Sécurité & Accueil, Décoration & Fleurs, Photographie, Animation & DJ, Transport VIP, Bar & Cocktails, Signalisation.

### ÉPIC 5 : Notifications

| # | User Story | Implementation |
|---|-----------|----------------|
| 1 | En tant qu'utilisateur, je veux **recevoir des notifications** afin d'être informé des actions importantes. | `createNotification(userId, title, body, type)` — creates row in `notifications` table. Types: `'info'`, `'success'`, `'warning'`, `'danger'`. |
| 2 | En tant qu'utilisateur, je veux **recevoir des rappels** afin de ne pas oublier les échéances. | `notifyRole(role, title, body, type)` — sends notification to all active users of a given role. Used for: new events → coordonnateurs, new invoices → compta, payments → compta. |
| 3 | En tant qu'utilisateur, je veux **paramétrer mes notifications** afin de choisir le mode de réception. | `GET/PUT /api/notification-preferences` — toggles: `emailEnabled`, `smsEnabled`, `eventReminders`, `paymentAlerts`, `serviceUpdates`. Table: `notification_preferences` with `userId` UNIQUE. Uses `ON CONFLICT(userId) DO UPDATE`. |
| 4 | En tant qu'utilisateur, je veux **consulter un tableau des alertes** afin de suivre les notifications reçues. | Full notifications page: `renderAllNotifications()`. Sidebar notification panel: `renderNotifPanel()`. Dashboard shows latest 4 notifications. |
| 5 | En tant que système, je veux **gérer le statut de lecture des notifications** afin d'assurer le suivi. | `PUT /api/notifications/:id/read` sets `isRead = 1`. `PUT /api/notifications/read-all` marks all as read. Unread count shown as badge in nav via `item.badge()` function. |

### ÉPIC 6 : Facturation automatisée

| # | User Story | Implementation |
|---|-----------|----------------|
| 1 | En tant que système, je veux **générer une facture par événement** afin de centraliser les coûts. | `POST /api/invoices/generate/:eventId` — sums services costs + room reservation cost. Calculates `taxes = amount × 0.14975` (Quebec TPS+TVQ). Creates invoice with number `INV-YYYY-MMDD-eventId`, 30-day due date. Checks for existing invoice (returns 409 if exists). |
| 2 | En tant qu'organisateur, je veux **consulter les factures** afin de suivre les paiements. | `GET /api/invoices` — returns all invoices with event names. Frontend: `renderBilling()` displays invoices table + payment summary stats. `viewInvoice(id)` opens detailed modal with services breakdown. |
| 3 | En tant que comptabilité, je veux **gérer les statuts de facturation** afin d'identifier les retards. | Invoice statuses: `'En attente'`, `'Payée'`, `'Partiel'`, `'En retard'`, `'Brouillon'`. `PUT /api/invoices/:id` updates status/notes/client. Stats displayed: total paid, pending, overdue counts/amounts. |
| 4 | En tant qu'organisateur, je veux **payer une facture en ligne** afin de simplifier le paiement. | `POST /api/invoices/:id/pay` — accepts `method` (Carte/Virement/Chèque/En ligne) and `amount`. Creates payment record in `payments` table. Sets invoice status to `'Payée'` (full) or `'Partiel'`. Notifies user + compta role. |
| 5 | En tant qu'utilisateur, je veux **télécharger une facture en PDF** afin de conserver une preuve. | `GET /api/invoices/:id/pdf` — PDFKit generates formatted PDF with hotel header, client info, services itemization, subtotal/taxes/total. Streamed as `application/pdf`. |
| 6 | En tant que système, je veux **générer un reçu après paiement** afin de confirmer la transaction. | `GET /api/invoices/:id/receipt` — PDFKit generates receipt PDF (smaller format, 400×500) with payment amount, method, date. |

**Auto-recalculation**: When a service is added (`POST /api/services`) or updated (`PUT /api/services/:id`), the linked invoice's `amount`, `taxes`, `total` are automatically recalculated server-side.

### ÉPIC 7 : Rapports post-événement

| # | User Story | Implementation |
|---|-----------|----------------|
| 1 | En tant qu'organisateur, je veux **consulter un rapport post-événement** afin d'analyser les résultats. | `GET /api/reports/summary` — returns: events (total/active), guests (total/confirmed), revenue (paid/pending), invoices (overdue), rooms (total/reserved). |
| 2 | En tant qu'organisateur, je veux **visualiser des graphiques** afin de mieux comprendre les données. | 4 chart types: revenue by month (`/api/reports/revenue-by-month`), events by type (`/api/reports/events-by-type`), room occupancy (`/api/reports/room-occupancy`), services cost (`/api/reports/services-cost`). All rendered as CSS bar charts in `renderReports()`. |
| 3 | En tant qu'organisateur, je veux **filtrer les données du rapport** afin d'affiner l'analyse. | Report data is filterable via SQL grouping/aggregation. Revenue: `GROUP BY strftime('%Y-%m', paidDate)`. Events: `GROUP BY type`. Rooms: `LEFT JOIN reservations`. Services: `GROUP BY name`. |
| 4 | En tant qu'organisateur, je veux **exporter les rapports** afin de les partager ou les archiver. | Report sections displayed in cards. Invoice PDF download available per invoice. Dashboard revenue chart uses same data source. |

### ÉPIC 8 : Accès et sécurité

| # | User Story | Implementation |
|---|-----------|----------------|
| 1 | En tant qu'utilisateur, je veux **me connecter à la plateforme** afin d'accéder aux fonctionnalités. | `POST /api/auth/login` — validates email/password with bcrypt, returns JWT (24h expiry). `POST /api/auth/register` — creates user, returns JWT. Logs `LOGIN`/`REGISTER` in audit. |
| 2 | En tant qu'administrateur, je veux **gérer les rôles et permissions** afin de contrôler les accès. | Admin-only endpoints: `GET/POST/PUT/DELETE /api/users` (guarded by `requireRole('admin')`). `GET /api/audit` — admin-only audit log (last 200 entries). User CRUD: create, update role/status, deactivate (soft delete → `status = 'Inactif'`). |
| 3 | En tant que système, je veux **sécuriser les données sensibles** afin de protéger les informations. | Passwords hashed with `bcrypt.hashSync(password, 10)`. JWT secret via `process.env.JWT_SECRET` (fallback: `'hotel-promenade-secret-key-2025'`). Token in `Authorization: Bearer <token>` header. User passwords never returned in API responses. |
| 4 | En tant que système, je veux **restreindre les actions selon les rôles** afin de garantir la sécurité. | `verifyToken` middleware on all `/api/*` routes (except login/register). `requireRole(...roles)` middleware for restricted routes. Role-based data filtering: organisateur sees only own events (`WHERE userId = `), admin/coordonnateur see all. Frontend: `NAV_CONFIG` object defines visible pages per role. |

---

## Architecture

**Everything lives in 4 files**:

| File | Lines | Purpose |
|------|-------|---------|
| `server.js` | ~1405 | Express server, SQLite schema + seed data, all REST API routes (inline), Multer uploads, PDFKit PDF generation, JWT auth middleware, audit/notification helpers |
| `public/index.html` | ~1240 | Full SPA markup + embedded CSS. Gold/black hotel theme via CSS custom properties (`--gold`, `--charcoal`, `--dark`, `--surface`, etc.) |
| `public/app.js` | ~1392 | Frontend logic: role-based nav (`NAV_CONFIG`), page rendering (`renderDashboard`, `renderEvents`, etc.), DOM manipulation via template literals + `innerHTML` |
| `public/api-integration.js` | ~276 | API client layer. Every backend call has a named wrapper (e.g., `fetchEvents()`, `createGuest()`). Exported globally via `Object.assign(window, {...})` |

No framework, no bundler, no TypeScript. Frontend loads `api-integration.js` then `app.js` via `<script>` tags.

## Database

SQLite via `sqlite3` package. DB file `database.db` auto-created on first run. Schema initialized in `initializeDatabase()` using `db.serialize()`.

**12 tables**: `users`, `events`, `guests`, `services`, `rooms`, `reservations`, `invoices`, `payments`, `event_documents`, `notifications`, `notification_preferences`, `audit_history`.

**DB helpers** (always use these, never raw `db.run/get/all`):
- `dbRun(sql, params)` → `{ lastID, changes }`
- `dbGet(sql, params)` → single row or `undefined`
- `dbAll(sql, params)` → array of rows (empty `[]` if none)

**Seed data** (auto-created if missing): 1 admin + 3 demo users, 6 rooms. Delete `database.db` and restart to reset.

## Auth & Roles

JWT auth with `Authorization: Bearer <token>` header (24h expiry). Middleware: `verifyToken` → sets `req.userId`, `req.userRole`, `req.userEmail`. `requireRole(...roles)` for restricted routes.

| Role | Access | Pages |
|------|--------|-------|
| `admin` | Full access, user CRUD, audit logs | All pages including Users |
| `organisateur` | Own events only, manages guests/services | Dashboard, Events, Rooms, Guests, Services, Billing, Notifications |
| `coordonnateur` | All events, validates service requests | Dashboard, Events, Services, Rooms, Notifications |
| `compta` | Billing, invoices, financial reports | Dashboard, Billing, Reports, Notifications |

**Default credentials**: `admin@lapromenade.com` / `admin123`, `organisateur@lapromenade.com` / `org123`, `coordonnateur@lapromenade.com` / `coord123`, `compta@lapromenade.com` / `compta123`

## Key Patterns

- **Soft deletes**: Events → `status = 'Annulé'` (never deleted). Users → `status = 'Inactif'`. Preserves audit history.
- **Audit trail**: `logAudit(userId, action, entity, entityId, details)` after every mutation. Required for traceability (ÉPIC 1 & 8).
- **Notifications**: `createNotification(userId, title, body, type)` for individual. `notifyRole(role, title, body, type)` for role-wide alerts (ÉPIC 5).
- **Conflict detection**: `POST /api/rooms/reserve` checks overlapping time slots → HTTP 409 on conflict (ÉPIC 2).
- **Tax rate**: Quebec TPS+TVQ = `TAX_RATE = 0.14975`. Invoice totals auto-recalculate when services change.
- **Invoice auto-generation**: `POST /api/invoices/generate/:eventId` → sums services + room costs (ÉPIC 6).
- **Devis (quote)**: `GET /api/devis/:eventId` → cost estimate from services + room (ÉPIC 4).
- **File uploads**: Multer, `uploads/` dir, 10MB max. File types: pdf, jpg, png, gif, doc, docx, xls, xlsx, csv.
- **PDF generation**: `pdfkit` for invoice + receipt PDFs server-side (ÉPIC 6).
- **Guest invitations**: Mock email via `console.log`, updates status to `'Invité'` (ÉPIC 3).
- **CSV import/export**: Import headers: `prénom/nom/email/téléphone`. Export with BOM for Excel (ÉPIC 3).
- **Frontend data cache**: `DATA` object in app.js, synced from API. Re-fetch + re-render after mutations.
- **Role-aware dashboard**: `renderDashboard()` shows different stat cards per role.
- **Services catalog**: 9 predefined types in `DATA.servicesCatalog` with icons, descriptions, base prices.

## API Routes Reference

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/api/auth/login` | No | Login → JWT |
| POST | `/api/auth/register` | No | Register → JWT |
| GET/POST | `/api/events` | Token | List / Create events |
| GET/PUT/DELETE | `/api/events/:id` | Token | Get / Update / Soft-delete event |
| POST/GET/DELETE | `/api/events/:id/documents` | Token | Upload / List / Delete documents |
| GET | `/api/rooms` | Token | List rooms (with filters) |
| GET/POST | `/api/reservations` | Token | List / Create reservations |
| POST | `/api/rooms/reserve` | Token | Reserve room (conflict check) |
| PUT | `/api/reservations/:id` | Token | Update reservation status |
| GET/POST | `/api/guests` | Token | List / Create guests |
| PUT/DELETE | `/api/guests/:id` | Token | Update / Delete guest |
| POST | `/api/guests/:id/invite` | Token | Send mock invitation |
| POST | `/api/guests/import` | Token | CSV import |
| GET | `/api/guests/export` | Token | CSV export |
| GET/POST | `/api/services` | Token | List / Create services |
| PUT | `/api/services/:id` | Token | Update service |
| GET | `/api/devis/:eventId` | Token | Auto-generate quote |
| GET/POST | `/api/invoices` | Token | List / Create invoices |
| POST | `/api/invoices/generate/:eventId` | Token | Auto-generate invoice |
| PUT | `/api/invoices/:id` | Token | Update invoice |
| POST | `/api/invoices/:id/pay` | Token | Pay invoice |
| GET | `/api/invoices/:id/pdf` | Token | Download invoice PDF |
| GET | `/api/invoices/:id/receipt` | Token | Download receipt PDF |
| GET | `/api/payments` | Token | List payments |
| GET | `/api/notifications` | Token | List user notifications |
| PUT | `/api/notifications/:id/read` | Token | Mark notification read |
| PUT | `/api/notifications/read-all` | Token | Mark all read |
| GET/PUT | `/api/notification-preferences` | Token | Get / Update prefs |
| GET/POST/PUT/DELETE | `/api/users` | Admin | User CRUD |
| GET | `/api/audit` | Admin | Audit history |
| GET | `/api/reports/summary` | Token | Dashboard summary |
| GET | `/api/reports/events-by-type` | Token | Events by type chart |
| GET | `/api/reports/revenue-by-month` | Token | Revenue by month chart |
| GET | `/api/reports/room-occupancy` | Token | Room occupancy chart |
| GET | `/api/reports/services-cost` | Token | Services cost chart |

## AI Chatbot (Concierge IA)

**Multi-provider LLM** integration with automatic fallback chain. Supports **tool calling** — the AI can execute real actions (create events, reserve rooms, add guests, etc.) via OpenAI-compatible function calling.

**Provider chain** (tried in order, auto-fallback on rate limit):
1. **Groq llama-3.3-70b-versatile** — primary, best quality (100K TPD free tier)
2. **Groq llama-3.1-8b-instant** — fast fallback, higher limits (500K TPD, 131K TPM)
3. **Google Gemini 2.5 Flash** — secondary fallback (20 RPD free tier)
4. **Google Gemini 2.0 Flash** — tertiary fallback

**Rate limit handling**: `callSingleProvider()` parses 429 retry times. Waits up to 120s automatically (retries up to 2x). Permanent quota errors (Gemini "exceeded your current quota") are skipped instantly. `callLLM()` iterates providers starting from last successful one (`preferredProviderIdx`).

| Component | Location | Description |
|-----------|----------|-------------|
| Backend endpoint | `server.js` → `POST /api/chat` | Accepts `{messages}`, calls LLM with tools, returns `{reply, actions[]}` |
| Provider config | `server.js` → `LLM_PROVIDERS[]` | Array of {name, model, url, key, timeoutMs} — built from `GROQ_API_KEY` + `GEMINI_API_KEY` env vars |
| Provider caller | `server.js` → `callSingleProvider()` | Sends request to one provider, handles 429 (wait/retry/switch), 400 (retry without tools) |
| LLM orchestrator | `server.js` → `callLLM()` | Iterates through LLM_PROVIDERS, tracks preferred provider |
| Tool definitions | `server.js` → `CHAT_TOOLS` | 11 tools: `create_event`, `list_events`, `list_rooms`, `reserve_room`, `add_guest`, `list_guests`, `request_service`, `list_services`, `generate_invoice`, `get_report_summary`, `get_notifications` |
| Tool executor | `server.js` → `executeChatTool()` | Executes DB operations using `dbRun/dbGet/dbAll`, calls `logAudit()` + `createNotification()` |
| API client | `api-integration.js` → `sendChatMessage()` | Sends chat history to backend |
| Chat UI | `index.html` | Floating FAB button (bottom-right), expandable panel with header/messages/suggestions/input |
| Chat logic | `app.js` → `toggleChat()`, `sendChat()`, `appendChatBubble()`, `refreshAfterChatActions()` | Manages chat state, message rendering, typing indicator, auto-refreshes data after actions |

**Tool calling flow**: User message → LLM returns `tool_calls` → backend executes via `executeChatTool()` → results sent back to LLM → LLM generates human-readable summary → response returned with `{reply, actions[]}`. Max 5 tool-call iterations per request.

**System prompt**: French-speaking hotel event concierge with **dynamic current date** injection. Instructed to USE tools (not just explain). Knows all 6 rooms (with IDs), 9 service types with prices, tax rate (14.975%). Receives user context (name, role, event count, unread notifications). `getChatSystemPrompt()` generates prompt with today's date on every request.

**Chat history**: Last 20 messages sent to LLM for context. Stored client-side in `chatHistory[]` array.

**Frontend auto-refresh**: After actions, `refreshAfterChatActions()` re-fetches affected data (events, rooms, guests, services, invoices, notifications) and re-renders the current page.

**Environment**: `GROQ_API_KEY` and/or `GEMINI_API_KEY` in `.env`. At least one required. Endpoint returns HTTP 503 if none configured.

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/api/chat` | Token | AI chat with tool calling — sends messages to LLM provider chain, returns `{reply, actions[]}` |

## Language

The application UI, error messages, and API responses are in **French**. Keep all user-facing strings in French. Variable names and code structure are in English.

## Development

```bash
npm install          # install dependencies
npm run dev          # start with nodemon (auto-reload)
npm start            # production start
# App runs on http://localhost:3000
```

No test framework configured. Validate changes by running the server and testing endpoints with curl or the browser UI.
