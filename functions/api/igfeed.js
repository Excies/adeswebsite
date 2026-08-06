// ======================================================================
// Cloudflare Pages Function — Canlı Instagram akışı
// URL: /api/igfeed?username=ades.media
//
// İki yöntemle gerçek Instagram gönderilerini çeker:
//   1) Resmi Instagram Graph API  (önerilen, güvenilir)
//        Cloudflare Pages ayarlarına iki ortam değişkeni ekle:
//          IG_ACCESS_TOKEN = <uzun ömürlü Instagram Graph API erişim token'ı>
//          IG_USER_ID      = <Instagram işletme/profesyonel hesap "kullanıcı id"si>
//        (Bu token'ı Facebook/Instagram Graph API üzerinden alırsın.)
//   2) Halka açık web profili kazıma (token yoksa, yalnızca herkese açık
//        hesap ve tek seferlik tahmine dayalı; bazı hesaplarda engellenir)
//
// Hiçbiri çalışmazsa { ok:false } döner; ön yüz (index.html) otomatik
// olarak content.json'daki statik/yedek karelere geri düşer.
// ==============================================================

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
const IG_APP_ID = '936619743392459';

// -- Yöntem 1: Resmi Instagram Graph API (token ile) --
async function fetchGraph(token, userId) {
  const fields = 'id,caption,media_type,media_url,permalink,timestamp,like_count,comments_count,thumbnail_url';
  let igUserId = userId;
  let selfId = null;
  if (!igUserId) {
    const me = await fetch(
      `https://graph.instagram.com/v21.0/me?fields=id,username&access_token=${encodeURIComponent(token)}`
    ).then(r => r.json());
    igUserId = me && me.id;
    selfId = me && me.id;
    if (!igUserId) throw new Error('IG_USER_ID çözülemedi: ' + ((me && me.error && me.error.message) || 'bilinmiyor'));
  }
  const url =
    `https://graph.instagram.com/v21.0/${igUserId}/media?` +
    `fields=${encodeURIComponent(fields)}&limit=12&access_token=${encodeURIComponent(token)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('graph ' + res.status);
  const json = await res.json();
  if (!json.data || !json.data.length) throw new Error('graph veri yok');
  return (json.data || []).map(m => {
    const img = m.thumbnail_url || m.media_url || '';
    return {
      id: m.id || '',
      url: m.permalink || '',
      image: img,
      thumb: img,
      likes: m.like_count || 0,
      comments: m.comments_count || 0,
      caption: m.caption || '',
      taken_at: m.timestamp ? Math.floor(new Date(m.timestamp).getTime() / 1000) : 0,
    };
  }).filter(p => p.image && p.image.indexOf('http') === 0);
}

// -- Yöntem 2: Halka açık profil (token yok) —
async function fetchPublic(username) {
  const url = `https://i.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`;
  const res = await fetch(url, {
    headers: {
      'user-agent': UA,
      'accept': '*/*',
      'accept-language': 'tr-TR,tr;q=0.9,en;q=0.8',
      'x-ig-app-id': IG_APP_ID,
      'x-requested-with': 'XMLHttpRequest',
    },
  });
  if (!res.ok) throw new Error('ig ' + res.status);
  const j = await res.json();
  const user = j && j.data && j.data.user;
  if (!user) throw new Error('ig kullanıcı yok');
  const edges = (user.edge_owner_to_timeline_media && user.edge_owner_to_timeline_media.edges) || [];
  if (!edges.length) throw new Error('ig gönderi yok');
  return edges.slice(0, 12).map(e => {
    const n = e.node || {};
    const thumbs = n.thumbnail_resources || [];
    const thumb = thumbs.length ? thumbs[thumbs.length - 1].src : (n.display_url || '');
    const capNode =
      n.edge_media_to_caption && n.edge_media_to_caption.edges &&
      n.edge_media_to_caption.edges[0] && n.edge_media_to_caption.edges[0].node;
    return {
      id: n.id || '',
      url: n.shortcode ? `https://www.instagram.com/p/${n.shortcode}/` : '',
      image: n.display_url || '',
      thumb,
      likes: (n.edge_liked_by && n.edge_liked_by.count) || 0,
      comments: (n.edge_media_to_comment && n.edge_media_to_comment.count) || 0,
      caption: capNode ? capNode.text : '',
      taken_at: n.taken_at_timestamp || 0,
    };
  }).filter(p => p.image && p.image.indexOf('http') === 0);
}

export async function onRequest(context) {
  const url = new URL(context.request.url);
  const username = (url.searchParams.get('username') || 'ades.media')
    .replace(/[^a-zA-Z0-9._]/g, '').toLowerCase();
  const env = context.env || {};
  const token = env.IG_ACCESS_TOKEN || '';
  const userId = env.IG_USER_ID || '';

  const cacheKey = `igfeed:${username}:${token ? 1 : 0}`;
  const cache = caches.default;
  const cached = await cache.match(cacheKey).catch(() => null);
  if (cached) return cached;

  let posts = null;
  let source = '';
  try {
    if (token) {
      posts = await fetchGraph(token, userId);
      source = 'instagram-graph';
    }
  } catch (e) {
    // aynen devam — public'e düş
  }
  if (!posts) {
    try {
      posts = await fetchPublic(username);
      source = 'instagram-public';
    } catch (e) {
      posts = null;
    }
  }

  const body = JSON.stringify({
    ok: !!posts && posts.length > 0,
    username,
    source,
    updated_at: Date.now(),
    posts: posts || [],
  });
  const resp = new Response(body, {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=300',
      'access-control-allow-origin': '*',
    },
  });

  if (posts && context.waitUntil) {
    context.waitUntil(cache.put(cacheKey, resp.clone()).catch(() => {}));
  } else if (posts) {
    cache.put(cacheKey, resp.clone()).catch(() => {});
  }
  return resp;
}