# ADES MEDYA — Site & Yönetim Paneli

Statik site (GitHub + Cloudflare Pages ile yayınlanır). Site içeriği `content.json` dosyasından okunur; `admin.html` ile düzenlenir.

## Dosyalar

| Dosya | Açıklama |
|---|---|
| `index.html` | Ana site (bunu ziyaretçiler görür) |
| `admin.html` | Yönetim paneli (içerik düzenleme aracı) |
| `content.json` | Tüm içerik: metinler, kapaklar, galeri, haberler, ekip, yorumlar, partnerler, Instagram |
| `README.md` | Bu dosya |

## İlk Kurulum

1. `index.html`, `admin.html`, `content.json` dosyalarını GitHub reponun **kök klasörüne** koy.
2. Cloudflare Pages → proje ekle → GitHub reposunu bağla → yayınla. Cloudflare, repodaki her `git push` sonrası siteyi otomatik yeniden yayınlar.

## İçerik Düzenleme (her güncellemede)

1. `admin.html` dosyasını tarayıcıda aç (bilgisayarda veya sitende `siten.com/admin.html`).
   - Varsayılan şifre: **`ades2026`** (Yardım sekmesinden değiştirilebilir).
2. Sekmelerden düzenle:
   - **Genel / Metinler** → e-posta, telefon, Instagram, ana sayfa ve hakkımızda metinleri.
   - **Kapaklar** → üst (hero) ve hakkımızda kapak görselleri. "Yükle" ile dosya seç veya görsel linki yapıştır.
   - **Galeri** → fotoğraf ekle/sil/sırala. Kategori yazarsan filtre butonları otomatik oluşur.
   - **Instagram** → IG önizleme kareleri (beğeni/yorum sayısı dahil).
   - **Haberler** → haber ekle/sil, başlık/metin/görsel/link düzenle.
   - **Ekip / Referanslar / Partnerler / İstatistikler** → aynı şekilde.
3. Sağ üstteki **"💾 Kaydet & İndir"** butonuna bas → tarayıcı `content.json` indirir.
4. İndirilen `content.json`'u repo kök klasöründeki eski `content.json` ile **değiştir** ve:
   ```
   git add content.json
   git commit -m "içerik güncellendi"
   git push
   ```
5. Cloudflare birkaç dakika içinde siteyi günceller.

## Sık Sorulanlar

- **Değişikliğim sitede görünmüyor?** content.json'un gerçekten repoya gittiğinden emin ol (git status ile kontrol et), ardından push. Cloudflare derlemesi bittikten sonra görünür.
- **Fotoğraf boyutu çok mu büyük?** Panel yüklediğin görseli otomatik küçültür (max 1400px, ~%82 kalite). Çok büyük dosyalarda content.json şişebilir; yine de 5-10 MB'ı geçirmemeye çalış.
- **content.json'u açarken panel boş geliyor?** `file://` ile açtığında tarayıcı dosyayı otomatik okuyamaz; "İçerik Yükle" butonuyla content.json'u elle seç. Sitede (https) sorun olmaz.
- **Panelin şifresi neden basit?** Statik sitede gerçek güvenlik mümkün değildir; şifre sadece kazara düzenlemeyi önler. Panel linkini (`admin.html`) herkesle paylaşma, şifreyi değiştir.
