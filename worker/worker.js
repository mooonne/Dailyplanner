// 오늘의 나 — 동기화 + 푸시 알림 서버 (Cloudflare Worker + D1)
// 필요한 설정: D1 바인딩 이름 "DB", Cron 트리거 "*/30 * * * *"
// 테이블과 푸시용 키(VAPID)는 첫 요청 때 자동으로 만들어져요.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
};
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });
const enc = new TextEncoder();
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const sha = async s => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
const rand = n => hex(crypto.getRandomValues(new Uint8Array(n)));

const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, created INTEGER)',
  'CREATE TABLE IF NOT EXISTS kv (uid TEXT NOT NULL, k TEXT NOT NULL, v TEXT, t INTEGER, seq INTEGER, PRIMARY KEY (uid, k))',
  'CREATE INDEX IF NOT EXISTS kv_seq ON kv (uid, seq)',
  'CREATE TABLE IF NOT EXISTS subs (endpoint TEXT PRIMARY KEY, uid TEXT NOT NULL, cfg TEXT, last_sent TEXT)',
  'CREATE TABLE IF NOT EXISTS config (k TEXT PRIMARY KEY, v TEXT)',
];
let ready = false;
async function init(env) {
  if (ready) return;
  if (!env.DB) throw new Error('D1 바인딩 "DB"가 없어요. Worker 설정 → 바인딩에서 D1 데이터베이스를 DB 이름으로 연결해 주세요.');
  await env.DB.batch(SCHEMA.map(s => env.DB.prepare(s)));
  ready = true;
}

/* ---------- VAPID (push signing keys, generated once and kept in D1) ---------- */
let vapidCache = null;
async function vapid(env) {
  if (vapidCache) return vapidCache;
  const get = () => env.DB.prepare('SELECT v FROM config WHERE k = ?').bind('vapid').first();
  let row = await get();
  if (!row) {
    const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const priv = await crypto.subtle.exportKey('jwk', kp.privateKey);
    const pub = b64u(await crypto.subtle.exportKey('raw', kp.publicKey));
    await env.DB.prepare('INSERT OR IGNORE INTO config (k, v) VALUES (?, ?)').bind('vapid', JSON.stringify({ priv, pub })).run();
    row = await get();
  }
  const { priv, pub } = JSON.parse(row.v);
  const key = await crypto.subtle.importKey('jwk', priv, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  return (vapidCache = { key, pub });
}
async function sendPush(endpoint, env) {
  const { key, pub } = await vapid(env);
  const header = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(enc.encode(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: env.VAPID_SUBJECT || 'https://today-me-914.pages.dev',
  })));
  const sig = b64u(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${header}.${claims}`)));
  // 내용 없는 푸시(암호화 불필요) → 앱의 서비스워커가 알림 문구를 만들어 띄워요
  return fetch(endpoint, {
    method: 'POST',
    headers: { TTL: '1800', Urgency: 'normal', Authorization: `vapid t=${header}.${claims}.${sig}, k=${pub}`, 'Content-Length': '0' },
  });
}

/* ---------- auth: "uid.token" 연결 코드 ---------- */
async function auth(req, env) {
  const m = (req.headers.get('Authorization') || '').match(/^Bearer ([a-f0-9]+)\.([a-f0-9]+)$/);
  if (!m) return null;
  const row = await env.DB.prepare('SELECT token_hash FROM users WHERE id = ?').bind(m[1]).first();
  return row && row.token_hash === (await sha(m[2])) ? m[1] : null;
}

/* ---------- reminder logic (runs on cron) ---------- */
function shouldRemind(cfg, nowMs) {
  const tz = Number.isFinite(cfg.tz) ? cfg.tz : 540; // minutes east of UTC (KST = 540)
  const unit = cfg.unit || 60, remind = cfg.remind || 0;
  if (!remind) return null;
  const local = new Date(nowMs + tz * 60000);
  let min = Math.round((local.getUTCHours() * 60 + local.getUTCMinutes()) / 30) * 30;
  let day = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()));
  if (min < cfg.wake * 60) { min += 1440; day = new Date(day.getTime() - 864e5); } // after-midnight bedtime
  if (min % remind !== 0) return null;
  const prev = min - unit; // the slot that just ended
  if (prev < cfg.wake * 60 || min > cfg.sleep * 60) return null;
  const dow = day.getUTCDay();
  if ((cfg.days || []).includes(dow) && prev >= cfg.ws * 60 && prev < cfg.we * 60) return null; // work time: no ping
  const date = day.toISOString().slice(0, 10);
  return { date, prev, tag: `${date}:${min}` };
}
async function runReminders(env) {
  await init(env);
  const { results } = await env.DB.prepare('SELECT endpoint, uid, cfg, last_sent FROM subs').all();
  const now = Date.now();
  for (const s of results) {
    let cfg; try { cfg = JSON.parse(s.cfg || '{}'); } catch { continue; }
    const r = shouldRemind(cfg, now);
    if (!r || s.last_sent === r.tag) continue;
    // already logged that slot? then stay quiet
    const dayRow = await env.DB.prepare('SELECT v FROM kv WHERE uid = ? AND k = ?').bind(s.uid, `odn.d.${r.date}`).first();
    try { if (dayRow && JSON.parse(dayRow.v)?.slots?.[r.prev]) continue; } catch {}
    const res = await sendPush(s.endpoint, env).catch(() => null);
    if (res && (res.status === 404 || res.status === 410)) {
      await env.DB.prepare('DELETE FROM subs WHERE endpoint = ?').bind(s.endpoint).run();
    } else {
      await env.DB.prepare('UPDATE subs SET last_sent = ? WHERE endpoint = ?').bind(r.tag, s.endpoint).run();
    }
  }
}

/* ---------- HTTP API ---------- */
async function handle(req, env) {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  const url = new URL(req.url), p = url.pathname;
  await init(env);

  if (p === '/' || p === '/api/health') return json({ ok: true, app: '오늘의 나 API' });
  if (p === '/api/vapid') return json({ pub: (await vapid(env)).pub });

  if (p === '/api/register' && req.method === 'POST') {
    const id = rand(6), token = rand(16);
    await env.DB.prepare('INSERT INTO users (id, token_hash, created) VALUES (?, ?, ?)').bind(id, await sha(token), Date.now()).run();
    return json({ code: `${id}.${token}` });
  }

  const uid = await auth(req, env);
  if (!uid) return json({ error: '연결 코드가 올바르지 않아요' }, 401);
  const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};

  if (p === '/api/sync' && req.method === 'POST') {
    const now = Date.now();
    const changes = Object.entries(body.changes || {}).filter(([k]) => /^odn\.(settings|cats|goals|d\.\d{4}-\d{2}-\d{2})$/.test(k)).slice(0, 500);
    if (changes.length) {
      await env.DB.batch(changes.map(([k, c]) => env.DB.prepare(
        `INSERT INTO kv (uid, k, v, t, seq) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (uid, k) DO UPDATE SET v = excluded.v, t = excluded.t, seq = excluded.seq WHERE excluded.t > kv.t`
      ).bind(uid, k, JSON.stringify(c.v), Number(c.t) || now, now)));
    }
    const { results } = await env.DB.prepare('SELECT k, v, t FROM kv WHERE uid = ? AND seq > ?').bind(uid, Number(body.since) || 0).all();
    const rows = {};
    for (const r of results) rows[r.k] = { v: JSON.parse(r.v), t: r.t };
    return json({ now, rows });
  }

  if (p === '/api/push/subscribe' && req.method === 'POST') {
    const ep = body.sub?.endpoint;
    if (!ep || !/^https:\/\//.test(ep)) return json({ error: 'bad subscription' }, 400);
    await env.DB.prepare(
      `INSERT INTO subs (endpoint, uid, cfg) VALUES (?, ?, ?)
       ON CONFLICT (endpoint) DO UPDATE SET uid = excluded.uid, cfg = excluded.cfg`
    ).bind(ep, uid, JSON.stringify(body.cfg || {})).run();
    return json({ ok: true });
  }
  if (p === '/api/push/unsubscribe' && req.method === 'POST') {
    await env.DB.prepare('DELETE FROM subs WHERE endpoint = ? AND uid = ?').bind(body.endpoint || '', uid).run();
    return json({ ok: true });
  }
  if (p === '/api/push/test' && req.method === 'POST') {
    const { results } = await env.DB.prepare('SELECT endpoint FROM subs WHERE uid = ?').bind(uid).all();
    const out = [];
    for (const s of results) { const r = await sendPush(s.endpoint, env).catch(e => ({ status: String(e) })); out.push(r.status); }
    return json({ sent: out });
  }
  return json({ error: 'not found' }, 404);
}

export default {
  async fetch(req, env) {
    try { return await handle(req, env); }
    catch (e) { return json({ error: String(e.message || e) }, 500); }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runReminders(env));
  },
};
