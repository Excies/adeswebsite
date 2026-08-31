// ======================================================================
// Cloudflare Pages — Genel orta katman (tüm isteklerin önünde çalışır)
//
// Kural:
//   - /admin.rtw  → panele gönderir (yalnızca bu adresten ulaşılır)
//   - /admin.html → kapalı (403)
//   - /admin, /wp-admin, /login vb. → honeypot (403, IP adresli uyarı)
//   - Diğer tüm yollar → normal devam (context.next)
// ======================================================================

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const p = url.pathname;

  // Gizli panel: yalnızca /admin.rtw
  if (p === '/admin.rtw' || p === '/admin.rtw/') {
    try {
      const admin = await env.ASSETS.fetch(new Request(
        new URL('/admin.html', url).toString(),
        request
      ));
      return new Response(admin.body, {
        status: admin.status,
        headers: admin.headers,
      });
    } catch (e) {
      return new Response('Panel yüklenemedi: ' + String(e && e.message || e), {
        status: 500,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }
  }

  // Panel URL'si ve kaba sözlük saldırıları → engel
  const honeypot = [
    '/admin.html',
    '/admin', '/admin/',
    '/administrator', '/administrator/',
    '/wp-admin', '/wp-admin/',
    '/login', '/login/',
  ];

  if (honeypot.includes(p)) {
    const ip = request.headers.get('CF-Connecting-IP') ||
               request.headers.get('X-Forwarded-For') ||
               'unknown';
    const text = [
      'ERISIM ENGELLENDI',
      'Bu sayfa yonetici paneli DEGILDIR.',
      'Yanlis bir URL denediniz. Bu girisim KAYDEDILDI.',
      '',
      'IP Adresiniz Kaydedildi: ' + ip,
      'Zaman: ' + new Date().toISOString(),
      '',
      'Guvenlik sistemlerimiz bu denemeyi tespit etti ve logladi.',
      'Yetkiliyseniz, dogru yonetici panel URL\'sini kullanin.',
      '',
      'ADES Medya Guvenlik Sistemi',
    ].join('\n');

    return new Response(text, {
      status: 403,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }

  return context.next();
}
