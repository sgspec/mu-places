// mu-places Worker v1.1.0 — ฐานข้อมูลกลางแผนที่สายมู (Cloudflare Worker + D1)
// Bindings: DB (D1: mu-places) · Secret: ADMIN_KEY · Var: ALLOWED_ORIGINS · (ไม่บังคับ) GOOGLE_KEY, REFRESH_DAYS, REFRESH_LIMIT
// Cron: */15 * * * *

const CATS = {
  naga:   { label: 'พญานาค', color: '#3f6b4a' },
  temple: { label: 'วัด / พระพุทธรูป', color: '#9b5a50' },
  shrine: { label: 'ศาลเจ้า / สิ่งศักดิ์สิทธิ์', color: '#a8873a' },
  vessu:  { label: 'ท้าวเวสสุวรรณ', color: '#6b6496' },
};
const CHUNK = 1500;
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
};
const json = (d, status = 200, h = {}) =>
  new Response(JSON.stringify(d), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...CORS, ...h } });

/* ---------- อนุญาตเฉพาะโดเมนในรายชื่อ (ALLOWED_ORIGINS คั่นด้วย ,  รองรับ *.example.com) ---------- */
function allowList(env) {
  return String(env.ALLOWED_ORIGINS || '').split(',').map(x => {
    let d = x.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (!d) return '';
    const wild = d.startsWith('*.');
    try { d = new URL('https://' + (wild ? d.slice(2) : d)).hostname; } catch (e) {}   // รองรับโดเมนภาษาไทย
    return (wild ? '*.' : '') + d;
  }).filter(Boolean);
}
function requestHost(req) {
  const o = req.headers.get('Origin') || req.headers.get('Referer') || '';
  try { return new URL(o).hostname.toLowerCase(); } catch (e) { return ''; }
}
function hostAllowed(host, list) {
  if (!host) return false;
  return list.some(d => d.startsWith('*.') ? (host === d.slice(2) || host.endsWith(d.slice(1))) : (host === d || host === 'www.' + d));
}
function withOrigin(res, req) {
  const o = req.headers.get('Origin');
  if (!o) return res;
  const r = new Response(res.body, res);
  r.headers.set('Access-Control-Allow-Origin', o);
  r.headers.append('Vary', 'Origin');
  return r;
}

const getMeta = (env, k) => env.DB.prepare('SELECT v FROM meta WHERE k = ?').bind(k).first('v');
const setMeta = (env, k, v) =>
  env.DB.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').bind(k, String(v)).run();

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    try {
      if (path === '/places' || path === '/place') {
        const list = allowList(env);
        if (list.length && !hostAllowed(requestHost(req), list)) return json({ error: 'forbidden' }, 403);
        if (req.method !== 'GET') return json({ error: 'method' }, 405);
        const res = path === '/places' ? await places(env) : await place(env, url.searchParams.get('id') || '', req);
        return list.length ? withOrigin(res, req) : res;
      }

      if (path.startsWith('/admin/')) {
        if (!env.ADMIN_KEY || req.headers.get('Authorization') !== 'Bearer ' + env.ADMIN_KEY) return json({ error: 'unauthorized' }, 401);
        if (path === '/admin/stats') return await adminStats(env);
        if (path === '/admin/import' && req.method === 'POST') return await adminImport(env, await req.json());
        if (path === '/admin/build' && req.method === 'POST') return json(await buildPart(env, (await req.json()).part | 0));
        if (path === '/admin/clear' && req.method === 'POST') return await adminClear(env);
      }
      if (path === '/') return json({ ok: true, service: 'mu-places', version: '1.1.0' });
      return json({ error: 'not found' }, 404);
    } catch (e) {
      return json({ error: String((e && e.message) || e) }, 500);
    }
  },

  // ถ้ามีการอัปเดตคะแนน → ทยอยสร้างรายการหน้าเว็บใหม่ทีละส่วน
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      if ((await getMeta(env, 'dirty')) !== '1') return;
      const part = parseInt((await getMeta(env, 'build_next')) || '0', 10);
      const r = await buildPart(env, part);
      if (r.done) { await setMeta(env, 'build_next', 0); await setMeta(env, 'dirty', 0); }
      else await setMeta(env, 'build_next', part + 1);
    })());
  },
};

/* ---------- รายการทั้งหมด (สำหรับแผนที่) ---------- */
async function places(env) {
  const { results } = await env.DB.prepare("SELECT k, v FROM meta WHERE k GLOB 'pj_*' OR k = 'updated'").all();
  const m = {};
  for (const r of results) m[r.k] = r.v;
  const n = parseInt(m.pj_n || '0', 10);
  const chunks = [];
  for (let i = 0; i < n; i++) if (m['pj_' + i]) chunks.push(m['pj_' + i]);
  const body = '{"updated":' + (parseInt(m.updated || '0', 10) || 0) + ',"cats":' + JSON.stringify(CATS) + ',"p":[' + chunks.join(',') + ']}';
  return new Response(body, { headers: { 'content-type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=600', ...CORS } });
}

async function buildPart(env, part) {
  const total = (await env.DB.prepare('SELECT COUNT(*) AS c FROM places').first('c')) || 0;
  const parts = Math.max(1, Math.ceil(total / CHUNK));
  if (part >= parts) part = parts - 1;
  const { results } = await env.DB.prepare(
    'SELECT place_id, name, category, province, district, lat, lng, rating, reviews, image FROM places ORDER BY rowid LIMIT ? OFFSET ?'
  ).bind(CHUNK, part * CHUNK).all();
  const str = results.map(r => JSON.stringify([
    r.place_id, r.name, r.category, r.province || '', r.district || '',
    Math.round(r.lat * 1e6) / 1e6, Math.round(r.lng * 1e6) / 1e6, r.rating || 0, r.reviews || 0, r.image || '',
  ])).join(',');
  await setMeta(env, 'pj_' + part, str);
  const done = part === parts - 1;
  if (done) {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO meta (k, v) VALUES ('pj_n', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind(String(parts)),
      env.DB.prepare("INSERT INTO meta (k, v) VALUES ('updated', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind(String(Math.floor(Date.now() / 1000))),
      env.DB.prepare("DELETE FROM meta WHERE k GLOB 'pj_[0-9]*' AND CAST(substr(k, 4) AS INTEGER) >= ?").bind(parts),
      env.DB.prepare("INSERT INTO meta (k, v) VALUES ('dirty', '0') ON CONFLICT(k) DO UPDATE SET v = '0'"),
      env.DB.prepare("INSERT INTO meta (k, v) VALUES ('build_next', '0') ON CONFLICT(k) DO UPDATE SET v = '0'"),
    ]);
  }
  return { part, parts, total, done };
}

/* ---------- รายละเอียดสถานที่ + อัปเดตคะแนนเมื่อมีคนกดดู ---------- */
const ipHits = new Map();

async function place(env, id, req) {
  if (!id) return json({ error: 'id required' }, 400);
  const row = await env.DB.prepare('SELECT place_id, address, image, rating, reviews, raw, refreshed_at FROM places WHERE place_id = ?').bind(id).first();
  if (!row) return json({ error: 'not found' }, 404);
  let raw = {};
  try { raw = JSON.parse(row.raw || '{}') || {}; } catch (e) {}

  const fresh = await maybeRefresh(env, row, req);
  const f = {};
  for (const k in raw) f[k.toLowerCase().replace(/[\s_\-.]/g, '')] = raw[k];

  const imgs = [];
  for (const k of ['imageurls', 'photos', 'images']) {
    if (!Array.isArray(f[k])) continue;
    for (const im of f[k]) {
      const u = im && typeof im === 'object' ? (im.imageUrl || im.url || '') : im;
      if (typeof u === 'string' && /^https?:\/\//.test(u)) imgs.push(u);
    }
  }
  if (!imgs.length && row.image) imgs.push(row.image);

  const hours = (Array.isArray(f.openinghours) ? f.openinghours : [])
    .filter(h => h && h.day).map(h => ({ day: String(h.day), hours: String(h.hours || '') }));
  const reviews = (Array.isArray(f.reviews) ? f.reviews : [])
    .filter(r => r && r.text).slice(0, 3)
    .map(r => ({ text: String(r.text).slice(0, 400), stars: r.stars | 0, date: String(r.publishedAtDate || '').slice(0, 10) }));
  const web = String(f.website || '');

  return json({
    rating: row.rating || 0,
    reviewsCount: row.reviews || 0,
    fresh,
    address: row.address || '',
    images: [...new Set(imgs)].slice(0, 6),
    hours,
    phone: String(f.phone || f.phoneunformatted || ''),
    website: /^https?:\/\//.test(web) ? web : '',
    reviews,
  }, 200, { 'Cache-Control': 'public, max-age=3600' });
}

async function maybeRefresh(env, row, req) {
  if (!env.GOOGLE_KEY || !/^(ChIJ|Gh|Ei|Eh)/.test(row.place_id)) return false;
  const days = parseInt(env.REFRESH_DAYS || '30', 10);
  const limit = parseInt(env.REFRESH_LIMIT || '900', 10);
  if (row.refreshed_at && Date.now() - Date.parse(row.refreshed_at) < days * 864e5) return false;

  const mk = 'refresh_' + new Date().toISOString().slice(0, 7).replace('-', '');
  if (parseInt((await getMeta(env, mk)) || '0', 10) >= limit) return false;

  const ip = req.headers.get('CF-Connecting-IP') || '';
  const now = Date.now(), h = ipHits.get(ip) || { n: 0, t: now };
  if (now - h.t > 36e5) { h.n = 0; h.t = now; }
  if (h.n >= 30) return false;                       // กันบอท: 30 ครั้ง/ชม./IP
  h.n++; ipHits.set(ip, h);

  await env.DB.prepare("INSERT INTO meta (k, v) VALUES (?, '1') ON CONFLICT(k) DO UPDATE SET v = CAST(meta.v AS INTEGER) + 1").bind(mk).run();
  const stamp = new Date().toISOString();
  let g = null;
  try {
    const r = await fetch('https://places.googleapis.com/v1/places/' + encodeURIComponent(row.place_id) + '?languageCode=th&regionCode=TH', {
      headers: { 'X-Goog-Api-Key': env.GOOGLE_KEY, 'X-Goog-FieldMask': 'rating,userRatingCount' },
    });
    if (r.ok) g = await r.json();
  } catch (e) {}

  if (!g || (g.rating == null && g.userRatingCount == null)) {
    await env.DB.prepare('UPDATE places SET refreshed_at = ? WHERE place_id = ?').bind(stamp, row.place_id).run();
    return false;
  }
  if (g.rating != null) row.rating = Math.round(g.rating * 10) / 10;
  if (g.userRatingCount != null) row.reviews = g.userRatingCount | 0;
  await env.DB.batch([
    env.DB.prepare('UPDATE places SET rating = ?, reviews = ?, refreshed_at = ?, updated_at = ? WHERE place_id = ?')
      .bind(row.rating, row.reviews, stamp, stamp, row.place_id),
    env.DB.prepare("INSERT INTO meta (k, v) VALUES ('dirty', '1') ON CONFLICT(k) DO UPDATE SET v = '1'"),
  ]);
  return true;
}

/* ---------- แอดมิน ---------- */
async function adminImport(env, body) {
  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (body.replace) await env.DB.batch([env.DB.prepare('DELETE FROM places'), env.DB.prepare("DELETE FROM meta WHERE k GLOB 'pj_*'")]);
  const sql = `INSERT INTO places (place_id, name, category, province, district, address, lat, lng, rating, reviews, image, raw, refreshed_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(place_id) DO UPDATE SET
      name = excluded.name, category = excluded.category, province = excluded.province, district = excluded.district,
      address = excluded.address, lat = excluded.lat, lng = excluded.lng, image = excluded.image, updated_at = excluded.updated_at,
      rating  = CASE WHEN places.refreshed_at IS NOT NULL AND (excluded.refreshed_at IS NULL OR excluded.refreshed_at < places.refreshed_at) THEN places.rating  ELSE excluded.rating  END,
      reviews = CASE WHEN places.refreshed_at IS NOT NULL AND (excluded.refreshed_at IS NULL OR excluded.refreshed_at < places.refreshed_at) THEN places.reviews ELSE excluded.reviews END,
      raw = excluded.raw,
      refreshed_at = CASE WHEN places.refreshed_at IS NOT NULL AND (excluded.refreshed_at IS NULL OR excluded.refreshed_at < places.refreshed_at) THEN places.refreshed_at ELSE excluded.refreshed_at END`;
  const stmt = env.DB.prepare(sql);
  const now = new Date().toISOString();
  const ok = rows.filter(p => p && p.place_id && p.name && isFinite(p.lat) && isFinite(p.lng));
  for (let i = 0; i < ok.length; i += 50) {
    await env.DB.batch(ok.slice(i, i + 50).map(p => stmt.bind(
      String(p.place_id).slice(0, 190), String(p.name).slice(0, 250), CATS[p.category] ? p.category : 'temple',
      String(p.province || ''), String(p.district || ''), String(p.address || ''),
      +p.lat, +p.lng, +p.rating || 0, p.reviews | 0, String(p.image || ''),
      typeof p.raw === 'string' ? p.raw : JSON.stringify(p.raw || {}),
      p.refreshed_at || null, now,
    )));
  }
  await setMeta(env, 'dirty', 1);
  return json({ received: rows.length, saved: ok.length });
}

async function adminStats(env) {
  const { results } = await env.DB.prepare('SELECT category, COUNT(*) AS c FROM places GROUP BY category').all();
  const cats = {};
  let total = 0;
  for (const r of results) { cats[r.category] = r.c; total += r.c; }
  const mk = 'refresh_' + new Date().toISOString().slice(0, 7).replace('-', '');
  return json({
    total, cats,
    built_parts: parseInt((await getMeta(env, 'pj_n')) || '0', 10),
    updated: parseInt((await getMeta(env, 'updated')) || '0', 10),
    dirty: (await getMeta(env, 'dirty')) === '1',
    refresh_this_month: parseInt((await getMeta(env, mk)) || '0', 10),
    google: !!env.GOOGLE_KEY,
  });
}

async function adminClear(env) {
  await env.DB.batch([env.DB.prepare('DELETE FROM places'), env.DB.prepare("DELETE FROM meta WHERE k GLOB 'pj_*' OR k IN ('dirty','build_next')")]);
  return json({ ok: true });
}
