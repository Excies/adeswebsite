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
  const token = env.GITHUB_TOKEN || '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';
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
    if (path === '/content.json') {
      const stored = env.CONTENT && (await env.CONTENT.get('content'));
      if (stored) {
        return new Response(stored, { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
      }
    }
    return env.ASSETS.fetch(request);
  },
};
