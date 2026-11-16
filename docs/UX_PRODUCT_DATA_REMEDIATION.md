# Perbaikan UX, produk, dan data di dev

5 November 2026. Pekerjaan lokal pada tiga repo: Frontend `dev`, admin-dashboard `dev`, support `dev`. Branch dev pada dua repo web dibuat dari main lokal yang diperiksa pada awal pekerjaan. Tidak ada push, rilis, perubahan Supabase live, atau commit yang dibuat oleh pekerjaan ini.

Acuan workspace: `UX_PRODUCT_DATA_AUDIT.md` (18 temuan) dan `REMEDIATION_PLAN.md` (A01–A33/B00–B08). Ini implementasi audit UX/produk/data beserta pengamanan yang langsung terkait, bukan pernyataan bahwa seluruh 33 temuan teknis sudah ditutup. File pengguna `admin-dashboard/AdminGuide.md` dipertahankan.

## Hasil dan status

| Temuan | Implementasi dev | Batas verifikasi |
| --- | --- | --- |
| U01 | Default sosial kosong; validator bersama; telepon/lokasi opsional; Guru tidak wajib tahun lulus; Siswa memakai label perkiraan | Kontrak source/fixture lolos; perangkat belum diuji |
| U02 | Email kontak disimpan di socials.email, terpisah dari email login; edit memuat sumber yang sama | Tidak mengubah email Auth; pengujian tulis live belum dilakukan |
| U03 | Gate tidak memasang screen sebelum verifikasi; error koneksi dibedakan; halaman status, cek ulang, edit biodata dan bantuan | Tidak mengarang antrean, penolakan atau SLA yang belum tersedia di backend |
| U04 | Semua tab memiliki label tetap, role, selected state dan long press | Font besar/VoiceOver/TalkBack belum diuji pada perangkat |
| U05 | Pencarian multi-token pada nama lengkap, nickname dan tahun | Fixture lolos; performa/pagination server direktori masih backlog A30 |
| U06 | Donasi sheet tidak memanggil RSVP; pilihan tidak aktif bila campaign belum terhubung; RSVP diberi label daftar/terdaftar dan konfirmasi batal yang tepat | Schema saat ini belum menghubungkan kegiatan ke campaign donasi |
| U07 | Follow/unfollow komunitas dipersist dan dibaca ulang; error tidak memberi sukses; WhatsApp https tervalidasi dibuka dengan Linking | Index pasangan unik disiapkan; policy membership live perlu diuji |
| U08 | Mobile membuka /tickets; login menyimpan tujuan; redirect internal divalidasi | Callback PKCE lintas browser/native belum memperoleh pengujian sesi end-to-end |
| U09 | Error direktori/riwayat/tiket/dashboard tidak berubah menjadi daftar kosong atau angka nol; ada retry | Tidak seluruh service legacy sudah dikonsolidasi |
| P01 | Keputusan pengguna: pisahkan Energi dan Koin, sepanjang waktu; nilai sama mendapat rank sama; posisi pribadi dihitung dari populasi yang sama | RPC baru wajib diterapkan sebelum client baru diaktifkan |
| P02 | Hilangkan sukses pembayaran/award koin tanpa bukti; legacy success URL tidak menjadi bukti; hapus akun menjadi request; completed manual ditolak; consent ranking pada server; notifikasi ditandai belum tersedia | Pembayaran gateway dan eksekusi delete_user_account/storage belum diintegrasikan. Privasi authenticated/view/RPC belum ditutup secara menyeluruh |
| D01 | Total sepanjang waktu dari agregat server terpisah dari pagination riwayat; receipt kontribusi dibaca berdasarkan akun aktif | Agregat legacy dan saldo historis masih memerlukan rekonsiliasi |
| D02 | Target dana diberi nama sesuai makna; admin aggregate server; grafik menghitung record dibuat, zona WIB dan error eksplisit; tiket pending/normal selaras | Belum membuat laporan dana diterima/retensi dari angka yang belum direkonsiliasi |
| D03 | RPC klaim menyimpan kuantitas/unit, versi konversi dan snapshot; ledger+saldo atomik; idempotent; tanggal/tipe/batas diverifikasi server | Data legacy diberi status legacy, tidak diisi kuantitas rekaan; race multi-koneksi belum diuji |
| D04 | Form menulis batch_status; filter mendukung batch lama; Guru tersedia pada edit | Tidak ada backfill live; schema types penuh masih perlu regenerasi |
| D05 | Mobile menormalisasi embedding objek/array/null verifikasi | Respons embedding live belum diambil ulang |
| D06 | Pelapor/terlapor memakai Auth ID, target memakai alumni ID | Fixture lolos; policy insert/report live belum diuji |
| D07 | Null koordinat dipertahankan; angka nol sah; peta memfilter lokasi yang tidak lengkap | Tidak menyatakan peta aktif atau pengujian marker sudah dilakukan |

## Database: disiapkan, belum diterapkan

- `supabase/migrations/004_product_data_contract.sql`: metadata kontribusi, index idempotensi, membership unik, RPC ranking/consent/summary/claim/admin overview, serta pembatasan direct writes reward dan baca scoreboard.
- `supabase/migrations/005_anonymous_profile_privacy.sql`: mencabut SELECT tabel/kolom anonim pada alumni, alumni_private dan users, termasuk grant PUBLIC yang relevan. Ini menutup jalur langsung yang ditemukan audit A01; bukan bukti consent seluruh jalur authenticated/view/definer RPC sudah aman.
- Nama fungsi baru: `get_contribution_rankings`, `set_my_ranking_consent`, `get_my_contribution_summary`, `claim_challenge_energy`, `get_admin_product_overview`.
- Claim memperoleh identitas dari auth.uid, menghitung poin sendiri, mengunci profil untuk serialisasi, memeriksa verifikasi/deaktivasi/blacklist, dan menolak hadiah dari jumlah/jenis/periode yang tidak sesuai. Nilai request_id dipakai ulang saat retry payload yang sama dalam screen.
- Ranking hanya memuat pemilik skor dengan identitas cocok, consent ranking boolean true, dan akun tidak dideaktivasi. UUID dipakai hanya sebagai urutan stabil dalam grup nilai sama, bukan memecah peringkat seri.

## Urutan staging dan kompatibilitas

1. Ambil snapshot schema/policy/grants/index/RPC dan backup staging. Periksa baseline migration 001–003 serta konflik nomor migration yang mungkin ada di backend; file lokal sebelumnya tidak merupakan riwayat lengkap production.
2. Jalankan profiling agregat pada snapshot berizin untuk duplikasi membership dan identitas ledger. Index unik 004 sengaja menggagalkan transaksi jika ada duplikasi; tidak menghapus data historis diam-diam.
3. Tinjau policy/grants dan trigger aktual. 004 sengaja berhenti bila ada trigger non-internal contribution/scoreboard agar tidak menggandakan reward; inspeksi dan sesuaikan kontraknya terlebih dahulu, jangan sekadar membuang guard. Periksa aturan alumni/admin_roles yang dipakai policy scoreboard, kebutuhan direct write admin pada kontribusi, grants kolom dan fungsi/view alternatif yang dapat membaca profil. Uji admin, pemilik, alumni lain, anonim dan akun dinonaktifkan.
4. Terapkan 004/005 di staging, kemudian regenerasi generated types ketiga repo dari schema yang disepakati. Perubahan kegiatan_ends di types Frontend saat ini hanya memperbaiki mismatch yang sudah terbukti pada schema; encoding UTF-16 dipertahankan.
5. Uji tulis dengan data sintetis: follow/leave, request penghapusan, report akun, consent lintas perangkat, reward retry, rollback, dan dua klaim bersamaan pada beberapa koneksi.
6. Aktifkan client dev setelah RPC tersedia. Client baru gagal dengan pesan error jika RPC belum ada; tidak fallback ke penambahan saldo non-atomik. Client lama yang menulis langsung contribution/scoreboard akan ditolak oleh 004. Tetapkan versi minimum/strategi rollout sebelum production.
7. Selesaikan integrasi gateway dan body/izin RPC penghapusan yang sudah ada, termasuk cleanup Storage dan bukti hasil. Tombol selesai tidak boleh diaktifkan hanya dengan mengubah status database. Saat ini donasi di aplikasi dijelaskan belum tersedia; bantuan dan campaign tetap dapat diakses.

Pemulihan: perbaiki client/RPC secara maju dengan data tetap dipertahankan. Jangan mengembalikan grant reward atau pembacaan anonim yang berbahaya untuk menghidupkan client lama. Snapshot grants dan kebijakan diperlukan untuk rollback yang spesifik; tidak ada down migration destruktif yang dibuat. Seluruh deployment tetap memerlukan peninjauan hasil staging.

## Pengujian lokal

Frontend:

```sh
npm ci --ignore-scripts
npm run test:product
npx tsc --noEmit
npx expo export --platform android --platform ios --output-dir /tmp/satu-dev-mobile-export
```

Support API:

```sh
npm run test:product
npm run build
```

Database PostgreSQL WASM terisolasi, dependency hanya di direktori sementara:

```sh
npm install --prefix /tmp/satu-dev-db-check @electric-sql/pglite@0.5.15 --no-audit --no-fund
PRODUCT_DB_TEST_MODULE=/tmp/satu-dev-db-check/node_modules/@electric-sql/pglite/dist/index.js npm run test:product-db
```

Admin dashboard:

```sh
npm run build
npx eslint src/modules/overview/StatsCard.js src/modules/overview/ChartAreaInteractive.js src/modules/tickets/TicketsTable.js middleware.js
```

Hasil akhir lokal: **44 pemeriksaan lolos** (16 Frontend, 8 API/support/middleware, 20 PostgreSQL WASM), typecheck Frontend/support lolos, build admin/support lolos, export Android+iOS lolos, lint file yang berubah 0 error (warning masih ada), serta 6 HTTP smoke lokal lolos. Snapshot dan log ada di `audit/results/dev-remediation-checks.json`, `dev-http-smoke.json` dan `audit/logs/dev-*.log` pada workspace induk. Server smoke telah dihentikan. Skenario offline tidak membuktikan policy production, cleanup akun, settlement gateway, layout nyata atau aksesibilitas perangkat. Script reproduksi audit lama adalah bukti baseline bug, bukan acceptance suite sesudah perbaikan.

Perubahan tambahan yang langsung terkait: guard role aktif pada middleware dashboard dan API penghapusan support, pembatas pagination/transisi status, serta konfigurasi lint dashboard disesuaikan dengan Next 16. Dependency mobile dipasang ulang dari lockfile; tidak ada upgrade SDK/native.
