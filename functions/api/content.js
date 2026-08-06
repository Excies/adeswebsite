// ======================================================================
// Cloudflare Pages Function — Admin panelden GitHub'a içerik yazma (canlı yayın)
// URL: /api/content  (sadece POST)
//
// Panelde "🚀 Canlı Yayınla" denince bu fonksiyon, panelden gelen yeni
// content.json içeriğini GitHub repo'suna COMMIT eder. GitHub/Cloudflare
// otomatik olarak siteyi yeniden yayınlar. İçerik yalnızca git'te saklanır.
//
// Gerekli ortam değişkenleri (Cloudflare Dashboard → Pages projesi → Ayarlar)
//   GITHUB_TOKEN  → GitHub kişisel erişim token'i (repo yazma izni = `repo`)
//   GITHUB_REPO   → "sahip/repo"  (varsayılan: Excies/adeswebsite)  [opsiyonel]
//   GITHUB_BRANCH → dal adı   (varsayılan: main)                     [opsiyonel]
//   GITHUB_NAME / GITHUB_EMAIL → commit yazarı [opsiyonel]
//
// Not: Token asla statik dosyalara veya panele gömülmez; yalnızca bu
// sunucu-tarafı fonksiyonu env değişkeninden okur. Güvende kalır.
// ======================================================================

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function b64encode(str) {
  if (typeof btoa === 'function') return btoa(unescape(encodeURIComponent(str)));
  return Buffer.from(str, 'utf-8').toString('base64');
}

export async function onRequest(context) {
  if (context.request.method !== 'POST') {
    return json({ ok:false, error:'Sadece POST kullanılır.' }, 405);
  }

  const env = context.env || {};
  const token = env.GITHUB_TOKEN || env.GH_TOKEN;
  if (!token) {
    return json({ ok:false, error:'GitHub token ayarlanmamış. Cloudflare > Work ve en üstteki GITHUB_TOKEN gizli değişkenini tanımla.' }, 500);
  }

  let body;
  try { body = await context.request.json(); }
  catch (e) { return json({ ok:false, error:'Geçersiz JSON isteği.' }, 400); }

  const content = body && body.content;
  if (!content || typeof content !== 'object') {
    return json({ ok:false, error:'«content» (içerik nesnesi) gerekli.' }, 400);
  }

  const repo = (env.GITHUB_REPO || 'Excies/adeswebsite').replace(/^\/+|\/+$/g,'');
  const branch = env.GITHUB_BRANCH || 'main';
  const authorName = (body.name || env.GITHUB_NAME || 'ADES Panel').trim();
  const authorEmail = (body.email || env.GITHUB_EMAIL || 'publish@localhost').trim();
  const message = (body.message || 'İçerik güncellendi (panel)').toString().slice(0, 200);

  const api = 'https://api.github.com';
  const path = 'content.json';
  const headers = {
    'Authorization': 'Bearer ' + token,
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'ades-panel',
    'X-GitHub-Api-Version': '2022-11-28',
  };

  // 1) Mevcut content.json'un SHA'sını al (ilk commit olsa da gerekmez)
  let sha = null;
  try {
    const r = await fetch(`${api}/repos/${repo}/contents/${path}?ref=${encodeURIComponent(branch)}`, { headers });
    if (r.ok) { const j = await r.json(); if (j && j.sha) sha = j.sha; }
  } catch (e) { /* yoksa yazard: ilk commit */ }

  const payload = {
    message,
    content: b64encode(JSON.stringify(content, null, 2)),
    branch,
    author: { name: authorName, email: authorEmail },
    committer: { name: authorName, email: authorEmail },
  };
  if (sha) payload.sha = sha;

  const res = await fetch(`${api}/repos/${repo}/contents/${path}`, {
    method: 'PUT',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (res.ok) {
    return json({ ok:true, repo, branch, commit: message });
  }

  let detail = 'GitHub API hatası (HTTP ' + res.status + ')';
  try { const j = await res.json(); detail = j && (j.message || detail); } catch (e) {}
  return json({ ok:false, error: detail }, 500);
}