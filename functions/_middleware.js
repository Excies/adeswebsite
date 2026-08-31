// ======================================================================
// Cloudflare Pages — Genel orta katman (tüm isteklerin önünde çalışır)
//
// Kural:
//   - /admin.html               → kapalı (403) — panel yalnızca /admin.rtw
//   - /admin, /wp-admin, /login vb. → honeypot (403, IP adresli uyarı)
//   - Diğer tüm yollar          → normal devam
// ======================================================================

export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  const p = url.pathname;

  const honeypot = [
    '/admin', '/admin/',
    '/administrator', '/administrator/',
    '/wp-admin', '/wp-admin/',
    '/login', '/login/',
  ];

  if (honeypot.includes(p) || p === '/admin.html') {
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
