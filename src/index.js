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

// ---------- POST /api/submit ----------
// Rezervasyon ve Ekibe Katıl (başvuru) formları tarayıcıdan buraya gelir;
// worker sunucu tarafında FormSubmit AJAX ucu üzerinden e-posta olarak
// iletir. Böylece tarayıcıda CORS engeli oluşmaz ve e-postalar düşer.
async function handleFormSubmit(request, env) {
  const toEmail = env.CONTACT_EMAIL || 'iletisim.adesmedia@gmail.com';

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

  const payload = {
    board: toEmail,
    _subject: subject,
    _template: 'table',
    _captcha: 'false',
    _honey: '',
    _datatable: fields,
  };

  try {
    const origin = new URL(request.url).origin;
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
    // FormSubmit, hatada bile HTTP 200 (+ success:false) dönebilir. JSON gövdesine bak.
    let ok = res.status >= 200 && res.status < 300;
    let msg = '';
    try {
      const j = await res.json();
      if (j) {
        if (j.success === false || j.success === 'false') ok = false;
        if (j.message) msg = j.message;
      }
    } catch (e) { /* boş gövde */ }
    if (ok) return json({ ok:true });
    return json({ ok:false, error: msg || ('FormSubmit HTTP ' + res.status) }, 502);
  } catch (e) {
    return json({ ok:false, error:String(e && e.message || e) }, 502);
  }
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

// ---------- Admin auth endpoint ----------
async function handleAdminAuth(request, env) {
  if (request.method !== 'POST') {
    return json({ ok:false, error:'Sadece POST kullanılır.' }, 405);
  }
  
  const clientIp = request.headers.get('CF-Connecting-IP') || 
                   request.headers.get('X-Forwarded-For') || 
                   'unknown';
  
  let body;
  try { body = await request.json(); } catch (e) { 
    return json({ ok:false, error:'Geçersiz JSON isteği.' }, 400); 
  }
  
  const password = body && body.password;
  const correctPassword = env.ADMIN_PASSWORD || 'iu1818iu';
  
  if (password === correctPassword) {
    return json({ ok:true, token: 'admin-authenticated' });
  } else {
    // Log failed attempt (in production, you'd store this in KV or log service)
    console.warn(`[ADMIN AUTH FAILED] IP: ${clientIp}, Time: ${new Date().toISOString()}`);
    return json({ ok:false, error:'Şifre hatalı!' }, 401);
  }
}

// ---------- Admin check endpoint (for session validation) ----------
async function handleAdminCheck(request, env) {
  // In a real app, you'd validate a JWT or session token here
  // For now, we'll just check if the request has the right header
  const authHeader = request.headers.get('Authorization');
  if (authHeader === 'Bearer admin-authenticated') {
    return json({ ok:true, authenticated: true });
  }
  return json({ ok:false, authenticated: false }, 401);
}

// ---------- ana fetch ----------
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Admin auth endpoints (backend only)
    if (path === '/api/admin/auth' && request.method === 'POST') {
      return handleAdminAuth(request, env);
    }
    if (path === '/api/admin/check') {
      return handleAdminCheck(request, env);
    }
    
    // Admin panel route - custom URL: /adMiN
    if (path === '/adMiN' || path === '/adMiN/') {
      return env.ASSETS.fetch(new Request('/admin.html', request));
    }
    
    // Honeypot: /admin and common admin paths - show scary warning
    const adminHoneypotPaths = ['/admin', '/admin/', '/administrator', '/administrator/', '/wp-admin', '/wp-admin/', '/login', '/login/'];
    if (adminHoneypotPaths.includes(path)) {
      const clientIp = request.headers.get('CF-Connecting-IP') || 
                       request.headers.get('X-Forwarded-For') || 
                       'unknown';
      console.warn(`[HONEYPOT TRIGGERED] IP: ${clientIp} attempted to access: ${path} at ${new Date().toISOString()}`);
      
      return new Response(`
<!DOCTYPE html>
<html lang="tr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Erişim Engellendi</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: #07100b;
      color: #eef7f0;
      font-family: 'Segoe UI', system-ui, sans-serif;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .container {
      text-align: center;
      max-width: 600px;
      background: #0d1912;
      border: 1px solid #22382c;
      border-radius: 10px;
      padding: 40px;
    }
    .warning-icon {
      font-size: 64px;
      margin-bottom: 20px;
      animation: pulse 2s infinite;
    }
    @keyframes pulse {
      0%, 100% { transform: scale(1); }
      50% { transform: scale(1.1); }
    }
    h1 {
      font-size: 28px;
      letter-spacing: 0.06em;
      margin-bottom: 16px;
      color: #ff5d5d;
    }
    .ip-info {
      background: #101f16;
      border: 1px solid #33513f;
      border-radius: 6px;
      padding: 20px;
      margin: 24px 0;
      font-family: 'Consolas', monospace;
      font-size: 14px;
      color: #2fe88a;
    }
    .ip-label {
      color: #9db8a6;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      margin-bottom: 8px;
    }
    p {
      color: #9db8a6;
      line-height: 1.7;
      margin-bottom: 16px;
    }
    .scary-text {
      color: #ff5d5d;
      font-weight: 600;
    }
    .footer {
      margin-top: 32px;
      padding-top: 24px;
      border-top: 1px solid #22382c;
      font-size: 12px;
      color: #5c7768;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="warning-icon">⚠️</div>
    <h1>ERİŞİM ENGELLENDİ</h1>
    <p>Bu sayfa yönetici paneli <span class="scary-text">DEĞİLDİR</span>.</p>
    <p>Yanlış bir URL denediniz. Bu girişim <span class="scary-text">KAYDEDİLDİ</span>.</p>
    <div class="ip-info">
      <div class="ip-label">IP Adresiniz Kaydedildi</div>
      <div>${clientIp}</div>
    </div>
    <p>Güvenlik sistemlerimiz bu denemeyi tespit etti ve logladı.</p>
    <p>Yetkiliyseniz, doğru yönetici panel URL'sini kullanın.</p>
    <div class="footer">
      ADES Medya Güvenlik Sistemi • ${new Date().toISOString()}
    </div>
  </div>
</body>
</html>
      `, {
        status: 403,
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      });
    }

    if (path === '/api/content' && request.method === 'POST') {
      return handleContentSave(request, env);
    }
    if (path === '/api/igfeed') {
      return handleIgFeed(request, env);
    }
    if (path === '/api/visit' ) {
      return handleVisit(request, env);
    }
    if (path === '/api/submit' && request.method === 'POST') {
      return handleFormSubmit(request, env);
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
