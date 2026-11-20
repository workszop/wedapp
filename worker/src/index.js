// Bee Talk API – one Durable Object (SQLite storage) per wedding event.
//
// Why a Durable Object instead of D1 + polling: every guest keeps one hibernating WebSocket open, so new
// guests, changed answers and chat messages are pushed to the other phones. Nobody polls, which keeps a
// 300-guest evening inside the free plan, and "delete everything" is one deleteAll() on the event's object.
//
// Public routes (all under /api/e/:slug):
//   GET    /event               event name, date line, guest count and photo version (no auth)
//   GET    /photo               the couple's photo (no auth; guests see it on the welcome screen)
//   PUT    /me/photo  DELETE /me/photo   bride or groom only: raw image body / remove (= no photo)
//   GET    /manifest            web app manifest whose start_url keeps the event (and, with ?r=, a restore code)
//   POST   /join                {name, answers[10] (music: a list of options), token?, role?, code?} -> {token, me}   (same token again = same guest)
//   GET    /me   PUT /me   DELETE /me      own profile, answers and settings; delete = erase my data
//   PUT    /me/avatar  DELETE /me/avatar  own profile photo: raw image body (the app sends a small square JPEG) / remove
//   GET    /avatar/:id?v=N     a guest's profile photo (no auth, but only with the current version N, which only the guest list reveals)
//   POST   /me/role {role, code}           take the bride/groom role on an existing guest (409 role_taken while someone else holds it)
//   POST   /me/restore -> {code}   POST /restore {code, token}     log the installed app in as the same guest
//   GET    /graph               every visible guest except me: id, name, role, answers, msg, photo (version, 0 = none)
//   GET    /inbox   GET /messages?with=ID   POST /messages {to, body}   POST /messages/read {with}
//   GET    /messages/all   POST /messages/all {body}     bride or groom only: their messages to all guests / send one (each guest gets it in the chat with the sender)
//   GET    /ws                  WebSocket (token in Sec-WebSocket-Protocol: "tt, <token>")
//   GET    /admin   PUT /admin   DELETE /admin   DELETE /admin/guests/:id   PUT /admin/guests/:id {role: bride|groom|null}   PUT|DELETE /admin/photo     couple only (Bearer admin code)
// Operator route:
//   POST   /api/admin/events    {names, dateLine, adminCode?} with Bearer MASTER_KEY -> {slug, adminCode}   (adminCode lets the operator reuse a couple's code)
//   POST   /api/admin/events/:slug/code {adminCode?} with Bearer MASTER_KEY -> {adminCode}   a new couple's code; the old one and links with it stop working
import { DurableObject } from 'cloudflare:workers';

const OPT_COUNTS = [3, 2, 5, 4, 12, 4, 4, 6, 6, 6];   // number of options per question, same order as Q in index.html
const MULTI_Q = new Map([[4, 12], [7, 2], [9, 2]]);   // questions where a guest may pick several options -> how many (music: any, talk about and hobby: two); the answer is a sorted array of options, or null
const SLUG_RE = /^[a-z0-9]{12,40}$/;
const NAME_RE = /^[\p{L}\p{M}\d .'’-]{1,24}$/u;
const MAX_GUESTS = 200, MAX_BODY = 500, KEEP_DAYS = 60;
const JOIN_LIMIT = [300, 10 * 60e3];  // joins per IP per window – above the guest cap, because the whole venue shares one Wi-Fi address
const SEND_LIMIT = [20, 60e3];        // messages per guest per window
const BULK_LIMIT = [5, 60e3];         // messages to all guests, per bride/groom per window
const ADMIN_FAILS = [8, 10 * 60e3];   // wrong couple codes per IP per window before further wrong ones get 429
const PHOTO_MAX = 1500 * 1024;   // the app shrinks photos to ~200 KB before upload; this is only a safety cap
const AVATAR_MAX = 150 * 1024;   // profile photos arrive as ~320 px JPEGs of 15-30 KB; this is only a safety cap
const AVATAR_LIMIT = [12, 10 * 60e3];   // profile photo changes per guest per window
const imageType = b => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff ? 'image/jpeg' : b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 ? 'image/png' : b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50 ? 'image/webp' : null;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/, RESTORE_RE = /^[A-Za-z0-9_-]{32}$/, RESTORE_TTL = 24 * 3600e3;

const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers } });
const err = (status, error) => json({ error }, status);
const now = () => new Date().toISOString();
const bearer = req => (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
async function sha256(s) { const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)); return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join(''); }
function randomString(len, alphabet) { const a = crypto.getRandomValues(new Uint8Array(len)); let s = ''; for (const b of a) s += alphabet[b % alphabet.length]; return s; }
const TOKEN_ABC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';   // 64 symbols: no modulo bias
const SLUG_ABC = 'abcdefghijklmnopqrstuvwxyz234567';                                    // 32 symbols
const CODE_ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';                                    // 32 symbols, no 0/O/1/I
const cleanText = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
async function readJson(req) { try { const t = await req.text(); if (t.length > 4000) return null; const v = JSON.parse(t); return v && typeof v === 'object' && !Array.isArray(v) ? v : null; } catch (e) { return null; } }   // only JSON objects

function rateOk(map, key, [limit, windowMs]) {
  const t = Date.now(), list = (map.get(key) || []).filter(x => t - x < windowMs);
  if (list.length >= limit) { map.set(key, list); return false; }
  list.push(t); map.set(key, list); return true;
}
/** Answers as sent or as stored -> the current shape, or null when they are not valid.
    Music used to be one number, where option 5 meant "a bit of everything" (removed): old values become a one-item list, old 5 becomes "not answered". */
function normAnswers(a) {
  if (!Array.isArray(a) || a.length !== OPT_COUNTS.length) return null;
  const out = [];
  for (let i = 0; i < a.length; i++) {
    let v = a[i]; const ok = x => Number.isInteger(x) && x >= 0 && x < OPT_COUNTS[i];
    if (MULTI_Q.has(i)) {
      if (Number.isInteger(v)) v = i === 4 && v === 5 ? null : [v];   // answers stored before multi-select
      if (v !== null) {
        if (!Array.isArray(v) || !v.every(ok)) return null;
        v = [...new Set(v)].sort((x, y) => x - y); if (v.length > MULTI_Q.get(i)) return null; if (!v.length) v = null;
      }
    } else if (v !== null && !ok(v)) return null;
    out.push(v);
  }
  return out[0] !== null && out[1] !== null ? out : null;   // bride-or-groom and friend-or-family are required
}
/** Stored answers in the current shape (events created before multi-select). The bride and the groom are not asked friend-or-family
    or where they met the couple, so for them the first is always "family" and the second empty, whatever was saved earlier. */
const answersOf = g => { const p = JSON.parse(g.answers), a = normAnswers(p) || p; if (g.role === 'bride' || g.role === 'groom') { a[1] = 1; a[2] = null; } return a; };

export class EventRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.joins = new Map(); this.sends = new Map(); this.adminFails = new Map(); this.avatarPuts = new Map(); this.bulks = new Map();
    this.isReady = null;
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));   // keep-alive without waking the object
  }

  // ---------- storage ----------
  ready() {
    if (this.isReady === null) {
      this.isReady = this.sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='meta'").toArray().length > 0;
      if (this.isReady) this.extraTables();   // events created before these tables existed
    }
    return this.isReady;
  }
  /** sessions: extra login tokens of a guest (the installed app). restores: short-lived codes that let the installed app log in as the guest. */
  extraTables() {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, guest_id INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS restores (hash TEXT PRIMARY KEY, guest_id INTEGER NOT NULL, exp INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS photo (k INTEGER PRIMARY KEY CHECK (k = 1), mime TEXT NOT NULL, data BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS avatars (guest_id INTEGER PRIMARY KEY, mime TEXT NOT NULL, data BLOB NOT NULL);`);
    // guests.photo = version of the guest's profile photo (0 = none); added here so events created earlier get it too
    if (!this.sql.exec('PRAGMA table_info(guests)').toArray().some(c => c.name === 'photo')) this.sql.exec('ALTER TABLE guests ADD COLUMN photo INTEGER NOT NULL DEFAULT 0');
    // A message from the bride or the groom to all guests: one row in bulks (what the sender sees under "All guests") and one ordinary
    // message per guest, marked with messages.bulk, so every guest gets it in the chat with the sender and can answer there.
    this.sql.exec('CREATE TABLE IF NOT EXISTS bulks (id INTEGER PRIMARY KEY AUTOINCREMENT, from_id INTEGER NOT NULL, body TEXT NOT NULL, at TEXT NOT NULL, n INTEGER NOT NULL)');
    if (!this.sql.exec('PRAGMA table_info(messages)').toArray().some(c => c.name === 'bulk')) this.sql.exec('ALTER TABLE messages ADD COLUMN bulk INTEGER');
  }
  meta(k) { const r = this.sql.exec('SELECT v FROM meta WHERE k = ?', k).toArray()[0]; return r ? r.v : null; }
  setMeta(k, v) { this.sql.exec('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', k, String(v)); }
  one(q, ...a) { return this.sql.exec(q, ...a).toArray()[0] || null; }
  all(q, ...a) { return this.sql.exec(q, ...a).toArray(); }

  /** Called once by the operator route. Returns false if the event already exists. */
  /** A new couple's code (operator only): the old code, and every link carrying it, stops working. */
  async setAdminHash(adminHash) { if (!this.ready()) return false; this.setMeta('adminHash', adminHash); return true; }
  async init({ slug, names, dateLine, adminHash }) {
    if (this.ready()) return false;
    this.sql.exec(`
      CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
      CREATE TABLE guests (id INTEGER PRIMARY KEY AUTOINCREMENT, token_hash TEXT NOT NULL UNIQUE, name TEXT NOT NULL, answers TEXT NOT NULL,
        tbl INTEGER /* unused: table numbers were removed, the column stays for events created earlier */, role TEXT, allow_messages INTEGER NOT NULL DEFAULT 1, visible INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, from_id INTEGER NOT NULL, to_id INTEGER NOT NULL, body TEXT NOT NULL, at TEXT NOT NULL, read_at TEXT);
      CREATE INDEX messages_to ON messages (to_id, from_id);
      CREATE INDEX messages_from ON messages (from_id, to_id);`);
    this.extraTables();
    const purgeAt = Date.now() + KEEP_DAYS * 864e5;
    this.setMeta('slug', slug); this.setMeta('names', names); this.setMeta('dateLine', dateLine); this.setMeta('adminHash', adminHash);
    this.setMeta('createdAt', now()); this.setMeta('purgeAt', new Date(purgeAt).toISOString());
    await this.ctx.storage.setAlarm(purgeAt);   // data minimisation: the event erases itself KEEP_DAYS after it was created
    this.isReady = true;
    return true;
  }
  async alarm() { await this.wipe(); }
  async wipe() {
    for (const ws of this.ctx.getWebSockets()) { try { ws.close(4001, 'event deleted'); } catch (e) {} }
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.isReady = false;
  }

  // ---------- views ----------
  me(g) { return { id: String(g.id), name: g.name, answers: answersOf(g), role: g.role, photo: g.photo || 0, allowMessages: !!g.allow_messages, visible: !!g.visible }; }
  card(g) { return { id: String(g.id), name: g.name, answers: answersOf(g), role: g.role, photo: g.photo || 0, msg: !!g.allow_messages }; }
  msg(m, meId) { const who = id => id === meId ? 'me' : String(id); return { id: String(m.id), from: who(m.from_id), to: who(m.to_id), body: m.body, at: m.at, readAt: m.read_at, ...(m.bulk ? { all: true } : {}) }; }
  bulkMsg(b) { return { id: 'a' + b.id, from: 'me', to: 'all', body: b.body, at: b.at, readAt: null, all: true, sent: b.n }; }
  eventInfo() {
    const ps = this.meta('photoState') || '';   // '' = not decided yet, 'set', 'declined'
    return { slug: this.meta('slug'), names: this.meta('names'), dateLine: this.meta('dateLine'), guests: this.one('SELECT COUNT(*) AS n FROM guests').n, photo: ps === 'set' ? +(this.meta('photoV') || 1) : 0, photoState: ps };
  }

  // ---------- the couple's photo (shown under their names on the welcome screen) ----------
  async putPhoto(request) {
    const len = +(request.headers.get('Content-Length') || 0);
    if (len > PHOTO_MAX) return err(413, 'photo_too_big');
    const buf = await request.arrayBuffer();
    if (!buf.byteLength || buf.byteLength > PHOTO_MAX) return err(buf.byteLength ? 413 : 400, buf.byteLength ? 'photo_too_big' : 'bad_request');
    const b = new Uint8Array(buf, 0, Math.min(12, buf.byteLength)), mime = imageType(b);
    if (!mime) return err(415, 'not_an_image');
    this.sql.exec('INSERT INTO photo (k, mime, data) VALUES (1, ?, ?) ON CONFLICT(k) DO UPDATE SET mime = excluded.mime, data = excluded.data', mime, buf);
    this.setMeta('photoV', (+(this.meta('photoV') || 0)) + 1); this.setMeta('photoState', 'set');
    this.broadcast({ type: 'event' });
    return json(this.eventInfo());
  }
  dropPhoto() {   // removing the photo also means "no photo, thanks": the couple is not asked again
    this.sql.exec('DELETE FROM photo'); this.setMeta('photoState', 'declined');
    this.broadcast({ type: 'event' });
    return json(this.eventInfo());
  }
  getPhoto() {
    const r = this.one('SELECT mime, data FROM photo WHERE k = 1');
    if (!r || this.meta('photoState') !== 'set') return err(404, 'no_photo');
    return new Response(r.data, { headers: { 'Content-Type': r.mime, 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff' } });
  }

  // ---------- guests' profile photos (optional; shown next to their name) ----------
  async putAvatar(g, request) {
    if (+(request.headers.get('Content-Length') || 0) > AVATAR_MAX) return err(413, 'photo_too_big');
    if (!rateOk(this.avatarPuts, g.id, AVATAR_LIMIT)) return err(429, 'slow_down');
    const buf = await request.arrayBuffer();
    if (!buf.byteLength || buf.byteLength > AVATAR_MAX) return err(buf.byteLength ? 413 : 400, buf.byteLength ? 'photo_too_big' : 'bad_request');
    const mime = imageType(new Uint8Array(buf, 0, Math.min(12, buf.byteLength)));
    if (!mime) return err(415, 'not_an_image');
    this.sql.exec('INSERT INTO avatars (guest_id, mime, data) VALUES (?, ?, ?) ON CONFLICT(guest_id) DO UPDATE SET mime = excluded.mime, data = excluded.data', g.id, mime, buf);
    const v = Math.max(Math.floor(Date.now() / 1000), (g.photo || 0) + 1);   // a new version = a new address, so phones never show a stale cached photo
    const u = this.one('UPDATE guests SET photo = ?, updated_at = ? WHERE id = ? RETURNING *', v, now(), g.id);
    this.announce(u);
    return json(this.me(u));
  }
  dropAvatar(g) {
    this.sql.exec('DELETE FROM avatars WHERE guest_id = ?', g.id);
    const u = this.one('UPDATE guests SET photo = 0, updated_at = ? WHERE id = ? RETURNING *', now(), g.id);
    this.announce(u);
    return json(this.me(u));
  }
  getAvatar(id, v) {
    const g = this.one('SELECT photo FROM guests WHERE id = ?', id);
    const r = g && g.photo && String(g.photo) === v ? this.one('SELECT mime, data FROM avatars WHERE guest_id = ?', id) : null;
    if (!r) return err(404, 'no_photo');
    return new Response(r.data, { headers: { 'Content-Type': r.mime, 'Cache-Control': 'private, max-age=604800, immutable', 'X-Content-Type-Options': 'nosniff' } });
  }

  // ---------- realtime ----------
  sendTo(gid, obj) { const s = JSON.stringify(obj); for (const ws of this.ctx.getWebSockets('g:' + gid)) { try { ws.send(s); } catch (e) {} } }
  broadcast(obj, exceptId) {
    const s = JSON.stringify(obj);
    for (const ws of this.ctx.getWebSockets()) { const a = ws.deserializeAttachment(); if (a && a.gid === exceptId) continue; try { ws.send(s); } catch (e) {} }
  }
  /** Tell everyone else what this guest now looks like on the graph (or that they are gone). */
  announce(g) { this.broadcast(g.visible ? { type: 'guest', guest: this.card(g) } : { type: 'gone', id: String(g.id) }, g.id); }
  webSocketMessage() {}   // clients only listen; "ping" is answered by the auto-response above
  webSocketClose(ws, code) { try { ws.close(code === 1005 || code === 1006 ? 1000 : code); } catch (e) {} }
  webSocketError() {}

  // ---------- auth ----------
  async guestFrom(token) {
    if (!token) return null;
    const h = await sha256(token);
    return this.one('SELECT * FROM guests WHERE token_hash = ?', h) || this.one('SELECT g.* FROM guests g JOIN sessions s ON s.guest_id = g.id WHERE s.hash = ?', h);
  }
  /** true = right code, false = wrong, null = wrong and over the limit (429). The right code always works: the whole venue
      shares one IP, so a lockout would let any guest shut the couple out. Guessing a 60-bit code online is hopeless anyway. */
  async checkCode(raw, ip) {
    const code = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (code && await sha256(code) === this.meta('adminHash')) return true;
    const t = Date.now(), fails = (this.adminFails.get(ip) || []).filter(x => t - x < ADMIN_FAILS[1]);
    fails.push(t); this.adminFails.set(ip, fails.slice(-50));
    return fails.length > ADMIN_FAILS[0] ? null : false;
  }
  isAdmin(req) { return this.checkCode(bearer(req), req.headers.get('CF-Connecting-IP') || '?'); }
  /** There is one bride and one groom: a role someone else holds cannot be taken with the couple's link, only the panel can move it. */
  roleHolder(role, exceptId) { return this.one('SELECT id FROM guests WHERE role = ? AND id != ?', role, exceptId); }
  /** Give the bride/groom role to this guest (the panel only); whoever held it before loses it, and the other phones are told. */
  takeRole(role, exceptId) { for (const old of this.all('UPDATE guests SET role = NULL WHERE role = ? AND id != ? RETURNING *', role, exceptId)) this.announce(old); }

  // ---------- HTTP ----------
  async fetch(request) {
    const url = new URL(request.url), path = url.pathname.replace(/^\/api\/e\/[^/]+/, '') || '/', method = request.method;
    if (!this.ready()) return err(404, 'unknown_event');

    if (path === '/event' && method === 'GET') return json(this.eventInfo());
    if (path === '/photo' && method === 'GET') return this.getPhoto();
    const av = path.match(/^\/avatar\/(\d+)$/);
    if (av && method === 'GET') return this.getAvatar(parseInt(av[1], 10), url.searchParams.get('v') || '');
    if (path === '/manifest' && method === 'GET') return this.manifest(url, request.headers.get('X-App-Url'));
    if (path === '/join' && method === 'POST') return this.join(request);
    if (path === '/restore' && method === 'POST') return this.restore(request);
    if (path === '/admin' || path.startsWith('/admin/')) return this.admin(request, path, method);

    if (path === '/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') return err(426, 'expected_websocket');
      const protos = (request.headers.get('Sec-WebSocket-Protocol') || '').split(',').map(s => s.trim());
      const g = protos[0] === 'tt' ? await this.guestFrom(protos[1]) : null;
      if (!g) return err(401, 'unauthorized');
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1], ['g:' + g.id]);
      pair[1].serializeAttachment({ gid: g.id });
      return new Response(null, { status: 101, webSocket: pair[0], headers: { 'Sec-WebSocket-Protocol': 'tt' } });
    }

    const g = await this.guestFrom(bearer(request));
    if (!g) return err(401, 'unauthorized');

    if (path === '/me/role' && method === 'POST') {   // the couple's link opened on a phone that had already joined as a guest
      const b = await readJson(request);
      if (!b || (b.role !== 'bride' && b.role !== 'groom')) return err(400, 'bad_request');
      const ok = await this.checkCode(b.code, request.headers.get('CF-Connecting-IP') || '?');
      if (ok === null) return err(429, 'slow_down');
      if (!ok) return err(403, 'bad_code');
      if (this.roleHolder(b.role, g.id)) return err(409, 'role_taken');
      const a = answersOf(g); a[0] = b.role === 'bride' ? 0 : 1;
      const u = this.one('UPDATE guests SET role = ?, answers = ?, updated_at = ? WHERE id = ? RETURNING *', b.role, JSON.stringify(a), now(), g.id);
      this.announce(u);
      return json(this.me(u));
    }
    if (path === '/me/photo') {   // the bride or the groom can add, replace or decline the photo from the app
      if (!g.role) return err(403, 'couple_only');
      if (method === 'PUT') return this.putPhoto(request);
      if (method === 'DELETE') return this.dropPhoto();
    }
    if (path === '/me/avatar') {
      if (method === 'PUT') return this.putAvatar(g, request);
      if (method === 'DELETE') return this.dropAvatar(g);
    }
    if (path === '/me/restore' && method === 'POST') {   // code for the manifest of the installed app; reusable for a day, so the login token never travels in a URL
      const code = randomString(32, TOKEN_ABC), exp = Date.now() + RESTORE_TTL;
      this.sql.exec('DELETE FROM restores WHERE guest_id = ? OR exp < ?', g.id, Date.now());
      this.sql.exec('INSERT INTO restores (hash, guest_id, exp) VALUES (?, ?, ?)', await sha256(code), g.id, exp);
      return json({ code, expiresAt: exp });
    }
    if (path === '/me') {
      if (method === 'GET') return json(this.me(g));
      if (method === 'PUT') return this.updateMe(g, await readJson(request));
      if (method === 'DELETE') { this.removeGuest(g.id); return json({ deleted: true }); }
    }
    if (path === '/graph' && method === 'GET') {
      return json({ total: this.one('SELECT COUNT(*) AS n FROM guests').n, guests: this.all('SELECT * FROM guests WHERE visible = 1 AND id != ? ORDER BY id', g.id).map(x => this.card(x)) });
    }
    if (path === '/inbox' && method === 'GET') {
      const by = new Map();
      for (const m of this.all('SELECT * FROM messages WHERE from_id = ? OR to_id = ? ORDER BY id', g.id, g.id)) {
        if (m.bulk && m.from_id === g.id) continue;   // the sender's own messages to all guests live under "All guests", not in one thread per guest
        const peer = String(m.from_id === g.id ? m.to_id : m.from_id), t = by.get(peer) || { withId: peer, last: null, unread: 0 };
        if (!t.peer) { const p = this.one('SELECT * FROM guests WHERE id = ?', +peer); if (!p) continue; t.peer = this.card(p); }   // lets the app name chat partners who are hidden from the graph
        t.last = this.msg(m, g.id); if (m.to_id === g.id && !m.read_at) t.unread++; by.set(peer, t);
      }
      return json([...by.values()].sort((a, b) => b.last.at.localeCompare(a.last.at)));
    }
    if (path === '/messages/all' && method === 'GET') return json(this.all('SELECT * FROM bulks WHERE from_id = ? ORDER BY id', g.id).map(b => this.bulkMsg(b)));
    if (path === '/messages/all' && method === 'POST') {   // the bride or the groom writes to every guest at once
      if (g.role !== 'bride' && g.role !== 'groom') return err(403, 'not_couple');
      const b = await readJson(request), body = cleanText(b && b.body, MAX_BODY);
      if (!body) return err(400, 'bad_request');
      if (!g.allow_messages) return err(403, 'own_messages_off');
      if (!rateOk(this.bulks, g.id, BULK_LIMIT)) return err(429, 'slow_down');
      const to = this.all('SELECT id FROM guests WHERE id != ? AND allow_messages = 1', g.id), at = now(), peer = this.card(g);   // guests who turned messages off are left out
      const bulk = this.one('INSERT INTO bulks (from_id, body, at, n) VALUES (?, ?, ?, ?) RETURNING *', g.id, body, at, to.length);
      for (const r of to) {
        const m = this.one('INSERT INTO messages (from_id, to_id, body, at, bulk) VALUES (?, ?, ?, ?, ?) RETURNING *', g.id, r.id, body, at, bulk.id);
        this.sendTo(r.id, { type: 'message', message: this.msg(m, r.id), peer });
      }
      return json(this.bulkMsg(bulk), 201);
    }
    if (path === '/messages' && method === 'GET') {
      const peer = parseInt(url.searchParams.get('with'), 10);
      if (!Number.isInteger(peer)) return err(400, 'bad_request');
      return json(this.all('SELECT * FROM messages WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?) ORDER BY id', g.id, peer, peer, g.id).map(m => this.msg(m, g.id)));
    }
    if (path === '/messages' && method === 'POST') {
      const b = await readJson(request), to = parseInt(b && b.to, 10), body = cleanText(b && b.body, MAX_BODY);
      if (!Number.isInteger(to) || !body || to === g.id) return err(400, 'bad_request');
      const peer = this.one('SELECT id, allow_messages FROM guests WHERE id = ?', to);
      if (!peer) return err(404, 'guest_gone');
      if (!peer.allow_messages) return err(403, 'messages_off');
      if (!g.allow_messages) return err(403, 'own_messages_off');   // you cannot write to people who cannot answer you
      if (!rateOk(this.sends, g.id, SEND_LIMIT)) return err(429, 'slow_down');
      const m = this.one('INSERT INTO messages (from_id, to_id, body, at) VALUES (?, ?, ?, ?) RETURNING *', g.id, to, body, now());
      this.sendTo(to, { type: 'message', message: this.msg(m, to), peer: this.card(g) });
      return json(this.msg(m, g.id), 201);
    }
    if (path === '/messages/read' && method === 'POST') {
      const b = await readJson(request), peer = parseInt(b && b.with, 10);
      if (!Number.isInteger(peer)) return err(400, 'bad_request');
      this.sql.exec('UPDATE messages SET read_at = ? WHERE from_id = ? AND to_id = ? AND read_at IS NULL', now(), peer, g.id);
      return json({ ok: true });
    }
    return err(404, 'not_found');
  }

  manifest(url, app) {
    const slug = this.meta('slug'), pl = url.searchParams.get('lang') !== 'en';
    const r = url.searchParams.get('r') || '', start = `${app}?e=${slug}` + (RESTORE_RE.test(r) ? `#r=${r}` : '');
    const icon = (f, s, p) => ({ src: `${app}icons/${f}?v=4`, sizes: `${s}x${s}`, type: 'image/png', purpose: p });
    return json({
      id: `${app}?e=${slug}`, lang: pl ? 'pl' : 'en', name: `Bee Talk – ${this.meta('names')}`, short_name: 'Bee Talk',
      description: pl ? 'Znajdź na brunchu ślubnym gości, z którymi znajdziesz wspólny język.' : 'Find the guests you’ll click with at the wedding brunch.',
      start_url: start, scope: app, display: 'standalone', background_color: '#ffffff', theme_color: '#ffffff',
      icons: [icon('icon-192.png', 192, 'any'), icon('icon-512.png', 512, 'any'), icon('icon-maskable-512.png', 512, 'maskable')],
    }, 200, { 'Content-Type': 'application/manifest+json; charset=utf-8' });
  }

  async join(request) {
    const ip = request.headers.get('CF-Connecting-IP') || '?';
    if (!rateOk(this.joins, ip, JOIN_LIMIT)) return err(429, 'slow_down');
    const b = await readJson(request);
    if (!b) return err(400, 'bad_request');
    const name = cleanText(b.name, 40);
    if (!NAME_RE.test(name)) return err(400, 'bad_name');
    const answers = normAnswers(b.answers);
    if (!answers) return err(400, 'bad_request');
    // The app sends a token it generated itself, so a join whose reply was lost can be repeated without creating a second guest.
    const token = TOKEN_RE.test(b.token || '') ? b.token : randomString(43, TOKEN_ABC), hash = await sha256(token);
    const again = this.one('SELECT * FROM guests WHERE token_hash = ?', hash);
    if (again) {
      const res = this.updateMe(again, { name, answers });
      return res.status === 200 ? json({ token, me: this.me(this.one('SELECT * FROM guests WHERE id = ?', again.id)) }) : res;
    }
    if (this.one('SELECT COUNT(*) AS n FROM guests').n >= MAX_GUESTS) return err(403, 'event_full');
    let role = null;
    if (b.role !== undefined && b.role !== null) {   // the couple join with the admin code so nobody else can pose as them
      if (b.role !== 'bride' && b.role !== 'groom') return err(400, 'bad_request');
      const ok = await this.checkCode(b.code, ip);
      if (ok === null) return err(429, 'slow_down');
      if (!ok) return err(403, 'bad_code');
      if (this.roleHolder(b.role, 0)) return err(409, 'role_taken');   // a re-join on a new phone: the panel first removes the old entry or makes it a guest
      role = b.role;
    }
    const t = now();
    const g = this.one('INSERT INTO guests (token_hash, name, answers, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING *', hash, name, JSON.stringify(answers), role, t, t);
    this.announce(g);
    return json({ token, me: this.me(g) }, 201);
  }

  /** The installed app trades a restore code for a login of its own (its token is generated on the phone). */
  async restore(request) {
    if (!rateOk(this.joins, request.headers.get('CF-Connecting-IP') || '?', JOIN_LIMIT)) return err(429, 'slow_down');
    const b = await readJson(request);
    if (!b || !RESTORE_RE.test(b.code || '') || !TOKEN_RE.test(b.token || '')) return err(400, 'bad_request');
    const r = this.one('SELECT * FROM restores WHERE hash = ? AND exp > ?', await sha256(b.code), Date.now());
    const g = r && this.one('SELECT * FROM guests WHERE id = ?', r.guest_id);
    if (!g) return err(403, 'restore_gone');
    this.sql.exec('INSERT OR IGNORE INTO sessions (hash, guest_id) VALUES (?, ?)', await sha256(b.token), g.id);
    return json({ me: this.me(g) });
  }

  updateMe(g, b) {
    if (!b) return err(400, 'bad_request');
    const next = { name: g.name, answers: g.answers, allow_messages: g.allow_messages, visible: g.visible };
    if ('name' in b) { const n = cleanText(b.name, 40); if (!NAME_RE.test(n)) return err(400, 'bad_name'); next.name = n; }
    if ('answers' in b) { const a = normAnswers(b.answers); if (!a) return err(400, 'bad_request'); next.answers = JSON.stringify(a); }
    if ('allowMessages' in b) next.allow_messages = b.allowMessages ? 1 : 0;
    if ('visible' in b) next.visible = b.visible ? 1 : 0;
    const changed = Object.keys(next).some(k => next[k] !== g[k]);
    if (!changed) return json(this.me(g));
    const u = this.one('UPDATE guests SET name = ?, answers = ?, allow_messages = ?, visible = ?, updated_at = ? WHERE id = ? RETURNING *', next.name, next.answers, next.allow_messages, next.visible, now(), g.id);
    this.announce(u);
    return json(this.me(u));
  }

  removeGuest(id) {
    this.sql.exec('DELETE FROM messages WHERE from_id = ? OR to_id = ?', id, id); this.sql.exec('DELETE FROM bulks WHERE from_id = ?', id);
    this.sql.exec('DELETE FROM sessions WHERE guest_id = ?', id); this.sql.exec('DELETE FROM restores WHERE guest_id = ?', id);
    this.sql.exec('DELETE FROM avatars WHERE guest_id = ?', id);
    this.sql.exec('DELETE FROM guests WHERE id = ?', id);
    this.broadcast({ type: 'gone', id: String(id) }, id);
    for (const ws of this.ctx.getWebSockets('g:' + id)) { try { ws.close(4002, 'guest deleted'); } catch (e) {} }
  }

  async admin(request, path, method) {
    const ok = await this.isAdmin(request);
    if (ok === null) return err(429, 'slow_down');
    if (!ok) return err(403, 'bad_code');
    if (path === '/admin' && method === 'GET') {
      // The couple see who joined, never what guests wrote to each other.
      return json({
        event: { ...this.eventInfo(), createdAt: this.meta('createdAt'), purgeAt: this.meta('purgeAt') },
        online: new Set(this.ctx.getWebSockets().map(ws => (ws.deserializeAttachment() || {}).gid)).size,
        messages: this.one('SELECT COUNT(*) AS n FROM messages').n,
        guests: this.all('SELECT * FROM guests ORDER BY id').map(g => ({ ...this.card(g), visible: !!g.visible, answered: answersOf(g).filter(a => a !== null).length, createdAt: g.created_at })),
      });
    }
    if (path === '/admin' && method === 'PUT') {
      const b = await readJson(request); if (!b) return err(400, 'bad_request');
      if ('names' in b) { const v = cleanText(b.names, 60); if (!v) return err(400, 'bad_request'); this.setMeta('names', v); }
      if ('dateLine' in b) this.setMeta('dateLine', cleanText(b.dateLine, 80));
      return json(this.eventInfo());
    }
    if (path === '/admin' && method === 'DELETE') { await this.wipe(); return json({ deleted: true }); }
    if (path === '/admin/photo' && method === 'PUT') return this.putPhoto(request);
    if (path === '/admin/photo' && method === 'DELETE') return this.dropPhoto();
    const m = path.match(/^\/admin\/guests\/(\d+)$/);
    if (m && method === 'DELETE') { this.removeGuest(parseInt(m[1], 10)); return json({ deleted: true }); }
    if (m && method === 'PUT') {   // the couple make a guest the bride or the groom (the previous holder becomes a guest), or an ordinary guest
      const b = await readJson(request); if (!b || !(b.role === 'bride' || b.role === 'groom' || b.role === null)) return err(400, 'bad_request');
      const g = this.one('SELECT * FROM guests WHERE id = ?', parseInt(m[1], 10)); if (!g) return err(404, 'not_found');
      if (b.role) this.takeRole(b.role, g.id);
      const a = answersOf(g); if (b.role) a[0] = b.role === 'bride' ? 0 : 1;   // their own side, as POST /me/role sets it
      const u = this.one('UPDATE guests SET role = ?, answers = ?, updated_at = ? WHERE id = ? RETURNING *', b.role, JSON.stringify(a), now(), g.id);
      this.announce(u); return json(this.card(u));
    }
    return err(404, 'not_found');
  }
}

// APP_URLS lists every address the static app is served from (first = default). Their origins, plus
// ALLOWED_ORIGINS for local development, are the browsers allowed to call the API.
const appUrls = env => (env.APP_URLS || '').split(',').map(s => s.trim()).filter(Boolean).map(u => u.replace(/\/?$/, '/'));
/** The app address this request came from (so manifests and links stay on the same domain), else the default. */
function appFor(request, env) { const o = request.headers.get('Origin'), list = appUrls(env); return list.find(u => new URL(u).origin === o) || list[0]; }
function corsHeaders(request, env) {
  const origin = request.headers.get('Origin'), allowed = [...appUrls(env).map(u => new URL(u).origin), ...(env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean)];
  const h = { Vary: 'Origin' };
  if (origin && allowed.includes(origin)) Object.assign(h, { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Max-Age': '86400' });
  return h;
}

async function route(request, env, url) {
  if (url.pathname === '/api/health') return json({ ok: true });
  if (url.pathname === '/api/admin/events' && request.method === 'POST') {
    if (!env.MASTER_KEY) return err(503, 'not_configured');
    const key = bearer(request);
    if (!key || await sha256(key) !== await sha256(env.MASTER_KEY)) return err(403, 'bad_key');
    const b = await readJson(request), names = cleanText(b && b.names, 60), dateLine = cleanText(b && b.dateLine, 80);
    if (!names) return err(400, 'bad_request');
    const wanted = b && b.adminCode != null ? String(b.adminCode).toUpperCase().replace(/[^A-Z0-9]/g, '') : '';
    if (wanted && !/^[A-Z0-9]{10,32}$/.test(wanted)) return err(400, 'bad_code_format');
    const slug = randomString(20, SLUG_ABC), adminCode = wanted || randomString(12, CODE_ABC);
    const created = await env.ROOM.get(env.ROOM.idFromName(slug)).init({ slug, names, dateLine, adminHash: await sha256(adminCode) });
    if (!created) return err(409, 'exists');
    return json({ slug, adminCode, url: `${appFor(request, env)}?e=${slug}` }, 201);
  }
  const rc = url.pathname.match(/^\/api\/admin\/events\/([^/]+)\/code$/);
  if (rc && request.method === 'POST') {   // operator: a new couple's code for an existing event
    if (!env.MASTER_KEY) return err(503, 'not_configured');
    const key = bearer(request);
    if (!key || await sha256(key) !== await sha256(env.MASTER_KEY)) return err(403, 'bad_key');
    if (!SLUG_RE.test(rc[1])) return err(404, 'unknown_event');
    const b = await readJson(request), wanted = b && b.adminCode != null ? String(b.adminCode).toUpperCase().replace(/[^A-Z0-9]/g, '') : '';
    if (wanted && !/^[A-Z0-9]{10,32}$/.test(wanted)) return err(400, 'bad_code_format');
    const adminCode = wanted || randomString(12, CODE_ABC);
    if (!await env.ROOM.get(env.ROOM.idFromName(rc[1])).setAdminHash(await sha256(adminCode))) return err(404, 'unknown_event');
    return json({ adminCode });
  }
  const m = url.pathname.match(/^\/api\/e\/([^/]+)(\/|$)/);
  if (m) {
    if (!SLUG_RE.test(m[1])) return err(404, 'unknown_event');
    const h = new Headers(request.headers); h.set('X-App-Url', appFor(request, env));   // set here, so a client cannot choose it
    return env.ROOM.get(env.ROOM.idFromName(m[1])).fetch(new Request(request, { headers: h }));
  }
  return err(404, 'not_found');
}

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    let res;
    try { res = await route(request, env, new URL(request.url)); } catch (e) { console.error(e && e.stack || e); res = err(500, 'internal_error'); }
    if (res.status === 101) return res;
    const h = new Headers(res.headers);
    for (const [k, v] of Object.entries(cors)) h.set(k, v);
    return new Response(res.body, { status: res.status, headers: h });
  },
};
