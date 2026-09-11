// ======================================================================
// ADES Medya — Cloudflare Worker (statik assets + API)
//
// Site index.html, admin.html, content.json gibi statik dosyalardan oluşur.
// Bu worker:
//   POST /api/content   → admin panelden gelen içeriği KV'ya kaydeder ve
//                         (isteğe bağlı) GitHub'a commit eder.
//   GET  /content.json  → içeriği KV'dan döndürür (varsa); yoksa assets'e
//                         düşer. Böylece panelden yapılan değişiklik SİTEYE
//                         ANINDA yansır (redeploy beklemeden).
//   GET  /api/igfeed    → Instagram akışı (KV'daki içeriği kullanır).
//   diğer tüm istekler  → statik assets (index.html, admin.html, ...).
// ======================================================================

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': '*' },
  });
}

function b64(str) {
  return btoa(unescape(encodeURIComponent(str)));
}

// content.json'un kaynağını bul: önce KV, yoksa assets'teki dosya
async function loadContent(env, request) {
  const kv = env.CONTENT && (await env.CONTENT.get('content'));
  if (kv) {
    try { return JSON.parse(kv); } catch (e) { /* bozuksa assets'e düş */ }
  }
  const r = await env.ASSETS.fetch(new URL('/content.json', request.url));
  if (r.ok) {
    try { return await r.json(); } catch (e) { /* yok */ }
  }
  return null;
}

// ---------- POST /api/content ----------
async function handleContentSave(request, env) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ ok:false, error:'Geçersiz JSON isteği.' }, 400); }
  const content = body && body.content;
  if (!content || typeof content !== 'object') {
    return json({ ok:false, error:'«content» (içerik nesnesi) gerekli.' }, 400);
  }

  const stored = JSON.stringify(content, null, 2);

  // 1) KV'ya kaydet → site anında güncellenir
  let kvOk = false;
  if (env.CONTENT) {
    try {
      await env.CONTENT.put('content', stored);
      kvOk = true;
    } catch (e) { /* yok */ }
  }

  // 2) GitHub'a da commit et (yedek; token yoksa sessizce geç)
  let git = { ok:false, skipped:true };
  const token = env.GITHUB_TOKEN || '';
  if (token) {
    try {
      const repo = (env.GITHUB_REPO || 'Excies/adeswebsite').replace(/^\/+|\/+$/g, '');
      const branch = env.GITHUB_BRANCH || 'main';
      const api = 'https://api.github.com';
      const headers = {
        'Authorization': 'Bearer ' + token,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'ades-panel',
        'X-GitHub-Api-Version': '2022-11-28',
      };
      let sha = null;
      try {
        const r = await fetch(`${api}/repos/${repo}/contents/content.json?ref=${encodeURIComponent(branch)}`, { headers });
        if (r.ok) { const j = await r.json(); if (j && j.sha) sha = j.sha; }
      } catch (e) { /* ilk commit */ }
      const payload = {
        message: 'İçerik güncellendi (panel)',
        content: b64(stored),
        branch,
        author: { name: body.name || 'ADES Panel', email: 'publish@localhost' },
        committer: { name: body.name || 'ADES Panel', email: 'publish@localhost' },
      };
      if (sha) payload.sha = sha;
      const r2 = await fetch(`${api}/repos/${repo}/contents/content.json`, {
        method: 'PUT',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      git = r2.ok ? { ok:true } : { ok:false, skipped:false, error: 'GitHub HTTP ' + r2.status };
    } catch (e) { git = { ok:false, skipped:false, error: String(e && e.message || e) }; }
  }

  if (kvOk) {
    return json({ ok:true, kv:true, git });
  }
  return json({ ok:false, error:'İçerik KV\'ya kaydedilemedi.', git }, 500);
}

// ---------- Instagram yardımcıları ----------
function extractShortcode(postUrl) {
  const u = String(postUrl || '');
  let m = /instagram\.com\/(?:p|reel|reels|tv|share)\/([A-Za-z0-9_\-]+)/i.exec(u);
  if (!m) m = /\/p\/([A-Za-z0-9_\-]+)/i.exec(u);
  return m ? m[1] : null;
}

async function resolvePostImage(postUrl) {
  const code = extractShortcode(postUrl);
  if (!code) throw new Error('Geçersiz Instagram linki');
  const res = await fetch(`https://www.instagram.com/p/${code}/media/?size=m`, {
    redirect: 'manual',
    headers: { 'user-agent': UA, 'accept': 'image/*' },
  });
  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get('location') || '';
    if (/fbcdn|cdninstagram/i.test(loc)) return loc;
  }
  throw new Error('Görsel çözülemedi (HTTP ' + res.status + ')');
}

// ades.media gibi açık bir hesabın tüm gönderilerini çek (oturumsuz).
async function scrapePublic(username) {
  const endpoints = [
    `https://i.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`,
    `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`,
  ];
  const appIds = ['936619743392459'];
  let lastErr = null;
  for (const ep of endpoints) {
    for (const appId of appIds) {
      try {
        const res = await fetch(ep, {
          headers: {
            'user-agent': UA,
            'accept': '*/*',
            'accept-language': 'en-US,en;q=0.9',
            'x-ig-app-id': appId,
            'x-requested-with': 'XMLHttpRequest',
            'referer': 'https://www.instagram.com/' + encodeURIComponent(username) + '/',
          },
        });
        if (!res.ok) { lastErr = new Error('HTTP ' + res.status); continue; }
        const j = await res.json();
        const user = j && j.data && j.data.user;
        if (!user) { lastErr = new Error('Kullanıcı bulunamadı'); continue; }
        const edges = (user.edge_owner_to_timeline_media && user.edge_owner_to_timeline_media.edges) || [];
        if (!edges.length) { lastErr = new Error('Gönderi yok'); continue; }
        return edges.slice(0, 12).map(e => {
          const n = e.node || {};
          const res = n.thumbnail_resources || [];
          const thumb = res.length ? res[res.length - 1].src : (n.display_url || '');
          const cap = n.edge_media_to_caption && n.edge_media_to_caption.edges &&
            n.edge_media_to_caption.edges[0] && n.edge_media_to_caption.edges[0].node;
          return {
            url: n.shortcode ? `https://www.instagram.com/p/${n.shortcode}/` : '',
            image: n.display_url || '',
            thumb,
            likes: String((n.edge_liked_by && n.edge_liked_by.count) || 0),
            comments: String((n.edge_media_to_comment && n.edge_media_to_comment.count) || 0),
            caption: cap ? cap.text : '',
          };
        }).filter(p => p.image && p.image.indexOf('http') === 0);
      } catch (e) { lastErr = e; }
    }
  }
  throw lastErr || new Error('Instagram scraper başarısız');
}

async function handleIgFeed(request, env) {
  const url = new URL(request.url);
  const username = (url.searchParams.get('username') || 'ades.media').replace(/[^a-zA-Z0-9._]/g, '').toLowerCase();
  const content = await loadContent(env, request);
  const items = ((content && content.igfeed) || []).slice(0, 12);

  const posts = [];
  for (const it of items) {
    const link = String(it.link || '').trim();
    let image = '';
    if (link) {
      try { image = await resolvePostImage(link); } catch (e) { image = ''; }
    }
    if (!image && it.image) image = String(it.image);
    if (!image) continue;
    posts.push({
      url: link || (it.url || ''),
      image,
      thumb: image,
      likes: String(it.likes != null ? it.likes : '0'),
      comments: String(it.comments != null ? it.comments : '0'),
      caption: String(it.caption || ''),
    });
  }

  let source = 'kv-config';
  if (!posts.length) {
    source = 'instagram-public';
    try { posts.push(...(await scrapePublic(username))); } catch (e) { /* yok */ }
  }

  return json({
    ok: posts.length > 0,
    username,
    source,
    updated_at: Date.now(),
    posts,
  });
}

// ======================================================================
// BAŞVURU / REZERVASYON TESLİMATI (güvenilir kanal)
//
// Sorun: Firefox/Safari'den değil, FormSubmit'in kendisinden geliyordu:
// Cloudflare'ın paylaşılan çıkış IP'lerinden yapılan istekleri FormSubmit
// sık sık "Rate limit exceeded" diye kabul etmiyor. Bu yüzden form hata
// veriyordu.
//
// Artık akış şöyle:
//   1) HER başvuru önce KV'ya yazılır → ASLA kaybolmaz (admin paneldeki
//      "Başvurular" sekmesinden /api/applications ile okunur).
//   2) E-posta teslimatı denemeleri:
//        a) Cloudflare Email Service / Email Routing binding (SEND_EMAIL)
//           kuruluysa önce ORADAN gönderilir (limit yok, güvenilir).
//        b) Binding yoksa/çalışmazsa FormSubmit AJAX ucu denenir.
//   3) E-posta başarısız olsa bile kullanıcıya HATA GÖSTERİLMEZ; istek
//      hep başarılı döner, arka planda kısa süre sonra tekrar denenir.
//      (Başvuru KV'da güvende; panelde görünür.)
// ======================================================================

function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/\n/g, '<br>');
}

function buildHtmlTable(subject, fields) {
  let body = '';
  for (const [k, v] of Object.entries(fields)) {
    if (v === '' || v == null) continue;
    body += '<tr><td style="background:#f2f2f2;padding:6px 10px;border:1px solid #ddd;font-weight:600">' +
      esc(k) + '</td><td style="padding:6px 10px;border:1px solid #ddd">' + esc(v) + '</td></tr>';
  }
  return '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px">' +
    '<h2 style="margin:0 0 8px">' + esc(subject) + '</h2>' +
    '<table style="border-collapse:collapse;min-width:420px">' + body + '</table>' +
    '<p style="color:#777;margin-top:14px;font-size:12px">Bu e-posta adesmedia.com.tr formlarından gönderildi.</p></div>';
}

function buildMime(subject, html) {
  const boundary = 'ADES-' + Date.now().toString(36) + '-b';
  return 'Subject: ' + subject + '\r\n' +
    'MIME-Version: 1.0\r\n' +
    'Content-Type: multipart/alternative; boundary="' + boundary + '"\r\n' +
    'X-Auto-Response-Suppress: All\r\n\r\n' +
    '--' + boundary + '\r\n' +
    'Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n' +
    subject + '\r\n(Bu e-postayı okuyamıyorsan HTML görünümünü aç.)\r\n\r\n' +
    '--' + boundary + '\r\n' +
    'Content-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n' +
    html + '\r\n\r\n' +
    '--' + boundary + '--\r\n';
}

// Cloudflare Email Service / Email Routing üzerinden gönderim (binding kuruluysa)
async function sendViaCloudflareEmail(env, toEmail, subject, fields) {
  if (!env || !env.SEND_EMAIL) {
    return { ok:false, skipped:true };
  }
  try {
    const fromEmail = env.CONTACT_FROM || 'forms@adesmedia.com.tr';
    const html = buildHtmlTable(subject, fields);
    const mime = buildMime(subject, html);
    const Ctor = (typeof globalThis !== 'undefined' && globalThis.EmailMessage)
      || (await import('cloudflare:email')).EmailMessage;
    const msg = new Ctor(fromEmail, toEmail, null);
    msg.setFrom(fromEmail);
    msg.setTo(toEmail);
    msg.setRaw(mime);
    await env.SEND_EMAIL.send(msg);
    return { ok:true, skipped:false };
  } catch (e) {
    return { ok:false, skipped:false, error:String(e && e.message || e) };
  }
}

// FormSubmit AJAX ucu üzerinden gönderim (yedek kanal)
async function sendViaFormSubmit(subject, fields, toEmail, origin) {
  const payload = {
    board: toEmail,
    _subject: subject,
    _template: 'table',
    _captcha: 'false',
    _honey: '',
    _datatable: fields,
  };
  try {
    const res = await fetch(`https://formsubmit.co/ajax/${toEmail}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Origin': origin,
        'Referer': origin + '/',
        'User-Agent': 'Mozilla/5.0 (ADES-Worker)',
      },
      body: JSON.stringify(payload),
    });
    // FormSubmit hatada dahi HTTP 200 + success:false dönebilir → gövdeye bak.
    let ok = res.status >= 200 && res.status < 300;
    let msg = '';
    try {
      const j = await res.json();
      if (j) {
        if (j.success === false || j.success === 'false') ok = false;
        if (j.message) msg = j.message;
      }
    } catch (e) { /* boş gövde */ }
    return { ok, error: ok ? '' : (msg || ('FormSubmit HTTP ' + res.status)) };
  } catch (e) {
    return { ok:false, error:String(e && e.message || e) };
  }
}

async function attemptDelivery(env, toEmail, subject, fields, origin) {
  // Önce Cloudflare'ın kendi kanalı → sonra FormSubmit (yedek)
  if (env && env.SEND_EMAIL) {
    const r = await sendViaCloudflareEmail(env, toEmail, subject, fields);
    if (r.ok) return { method:'cloudflare', ...r };
  }
  const r2 = await sendViaFormSubmit(subject, fields, toEmail, origin);
  return { method:'formsubmit', ...r2 };
}

// ---------- KV yedekleme (başvurular asla kaybolmaz) ----------
function submissionId() {
  return 's' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

async function saveSubmission(env, rec) {
  if (!env || !env.CONTENT) return false;
  try {
    await env.CONTENT.put('subm:' + rec.id, JSON.stringify(rec));
    let list = [];
    try {
      const prev = await env.CONTENT.get('subm:index');
      list = prev ? JSON.parse(prev) : [];
    } catch (e) { /* bozuk index */ }
    if (!Array.isArray(list)) list = [];
    list.unshift(rec.id);
    if (list.length > 250) list = list.slice(0, 250);
    await env.CONTENT.put('subm:index', JSON.stringify(list));
    return true;
  } catch (e) {
    return false;
  }
}

async function readSubmissions(env, limit) {
  if (!env || !env.CONTENT) return [];
  let ids = [];
  try {
    const raw = await env.CONTENT.get('subm:index');
    ids = raw ? JSON.parse(raw) : [];
  } catch (e) { /* yok */ }
  if (!Array.isArray(ids)) ids = [];
  const out = [];
  for (const id of ids.slice(0, limit || 150)) {
    try {
      const s = await env.CONTENT.get('subm:' + id);
      if (s) out.push(JSON.parse(s));
    } catch (e) { /* tek kayıt bozuksa atla */ }
  }
  return out;
}

// ---------- GET /api/applications ----------
// Panelden okunur: /api/applications?token=<şifre>
// Varsayılan şifre admin paneldekiyle aynıdır (env.ADMIN_TOKEN ile değiştirilebilir).
async function handleApplications(request, env) {
  const url = new URL(request.url);
  const expected = (env && env.ADMIN_TOKEN) || 'ades2026';
  const auth = request.headers.get('Authorization') || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const pass = url.searchParams.get('token') || bearer;
  if (pass !== expected) {
    return json({ ok:false, error:'Yetkisiz.' }, 401);
  }
  const limit = parseInt(url.searchParams.get('limit') || '100', 10) || 100;
  const items = await readSubmissions(env, Math.min(limit, 250));
  return json({ ok:true, items });
}

// ---------- POST /api/submit ----------
// Rezervasyon ve Ekibe Katıl (başvuru) formları tarayıcıdan buraya gelir.
async function handleFormSubmit(request, env, ctx) {
  const toEmail = (env && env.CONTACT_EMAIL) || 'iletisim.adesmedia@gmail.com';

  let data;
  try {
    data = await request.formData();
  } catch (e) {
    return json({ ok:false, error:'Geçersiz form isteği.' }, 400);
  }

  const honey = String((data.get('_honey') || '').trim());
  if (honey) {
    return json({ ok:true, spam:true }); // bot tuzağı
  }

  // Çok hızlı tekrarlanan istekleri (botlar/mükerrer tıklama) sessizce süz
  const ip = request.headers.get('CF-Connecting-IP') || '';
  if (env && env.CONTENT && ip) {
    let last = 0;
    try { last = parseInt(await env.CONTENT.get('subm:gate:' + ip), 10) || 0; } catch (e) { /* yok */ }
    if (Date.now() - last < 15000) {
      return json({ ok:true, spam:true });
    }
    try { await env.CONTENT.put('subm:gate:' + ip, String(Date.now())); } catch (e) { /* yok */ }
  }

  const type = String(data.get('_type') || '');
  const labels = {
    rezervasyon: 'Ades Medya - Rezervasyon Talebi',
    basvuru: 'Ades Medya - Yeni Ekip Başvurusu',
  };
  const subject = String(data.get('_subject') || labels[type] || 'Ades Medya - Yeni Form');

  const fields = {};
  const skip = new Set(['_subject','_template','_captcha','_honey','_type','_next','_autoresponse','_replyto']);
  for (const [k, v] of data.entries()) {
    if (skip.has(k)) continue;
    fields[k] = typeof v === 'string' ? v : '';
  }

  const rec = {
    id: submissionId(),
    type,
    subject,
    fields,
    created_at: Date.now(),
    email_status: 'pending',
    email_error: '',
  };
  const saved = await saveSubmission(env, rec);

  const origin = new URL(request.url).origin;
  const delivery = await attemptDelivery(env, toEmail, subject, fields, origin);
  rec.email_status = delivery.ok ? 'delivered' : 'failed';
  rec.email_method = delivery.method;
  if (!delivery.ok) rec.email_error = delivery.error || '';
  if (saved) {
    try { await env.CONTENT.put('subm:' + rec.id, JSON.stringify(rec)); } catch (e) { /* yok */ }
  }

  // E-posta gidemezse kısa bir süre sonra bir kez daha dene (kullanıcı göremez).
  if (!delivery.ok && ctx && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil((async () => {
      await new Promise(r => setTimeout(r, 90000));
      const retry = await attemptDelivery(env, toEmail, subject, fields, origin);
      if (retry.ok) {
        rec.email_status = 'delivered';
        rec.email_method = retry.method;
        rec.email_error = '';
      }
      if (saved) {
        try { await env.CONTENT.put('subm:' + rec.id, JSON.stringify(rec)); } catch (e) { /* yok */ }
      }
    })());
  }

  // Başvuru alındı → her zaman başarılı dön (veri KV'da güvende).
  return json({
    ok: true,
    saved,
    email: delivery.ok ? 'sent' : 'queued',
    email_method: delivery.method,
  });
}

// ---------- ziyaretçi sayacı ----------
async function handleVisit(request, env) {
  const key = 'visits';
  let count = 0;
  try { count = parseInt(await env.CONTENT.get(key), 10) || 0; } catch (e) { /* yok */ }
  if (request.method === 'POST') {
    count += 1;
    try { await env.CONTENT.put(key, String(count)); } catch(e) { /* yok */ }
  }
  return json({ ok:true, visits:count }, 200);
}

// ---------- ana fetch ----------
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/api/content' && request.method === 'POST') {
      return handleContentSave(request, env);
    }
    if (path === '/api/igfeed') {
      return handleIgFeed(request, env);
    }
    if (path === '/api/visit' ) {
      return handleVisit(request, env);
    }
    if (path === '/api/applications') {
      return handleApplications(request, env);
    }
    if (path === '/api/submit' && request.method === 'POST') {
      return handleFormSubmit(request, env, ctx);
    }
    if (path === '/content.json') {
      try {
        const stored = env.CONTENT && (await env.CONTENT.get('content'));
        if (stored) {
          return new Response(stored, { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
        }
      } catch (e) { /* KV bozuksa assets'e düş */ }
    }
    return env.ASSETS.fetch(request);
  },
};
