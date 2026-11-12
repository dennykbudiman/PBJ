# Panduan Axle untuk staf bengkel

Latar belakang untuk "Tanya Claude", per 12 November 2026. Tanya Claude hanya melihat data, tidak mengubah apa pun: sebut menu dan tombol yang harus diklik sendiri oleh pengguna. Nama tombol persis seperti di layar.

## Peran dan hak singkat

| Peran | Ringkasnya |
|---|---|
| Pemilik | Semuanya. Hanya Pemilik yang bisa menghapus kendaraan, perusahaan dan kontak, mengubah harga semua part sekaligus, dan menjadikan orang lain Pemilik. |
| Admin | Sama dengan Pemilik, kecuali hal-hal khusus Pemilik di atas dan mengubah akun Pemilik. |
| Service advisor | Pekerjaan dari janji sampai invoice, pelanggan, kendaraan, katalog, PO, terima part, retur, core, bayar tagihan supplier, semua laporan, harga modal. Tidak mencatat pembayaran pelanggan. |
| Kasir | Pembayaran, uang muka, pengembalian, kredit, tagihan supplier, no. faktur pajak, bukti transfer, 3 laporan uang. Lainnya hanya dilihat; tanpa harga modal katalog; tanpa tombol +. |
| Teknisi | Hanya melihat. Harga hanya di pekerjaan yang punya servis atas namanya (lainnya "—"). Tanpa Laporan dan tombol +. |
| Hanya lihat | Hanya melihat, tanpa harga, pembayaran dan Laporan. |
| Fleet manager | Orang armada pelanggan; menu sendiri (Dasbor, Armada saya). |

Hanya Pemilik dan Admin yang bisa: membatalkan (void) invoice, menghapus estimasi, mengoreksi stok (Sesuaikan stok), menerbitkan kredit baru (Nota kredit), mengubah atau menghapus pembayaran pada invoice yang sudah terbit, mengubah Pengaturan, mengelola pengguna, mengizinkan lembur, impor data.

## Kebijakan bengkel yang perlu diketahui

- Jasa (ongkos kerja) belum ditagihkan ke armada untuk saat ini. Setiap PT membayar part-nya sendiri lewat PO yang dicap PT itu.
- Part sisa (dibeli lewat PO satu PT tetapi tidak terpakai) diberi label manual per PT di rak. Axle tidak punya fitur "titipan"; jangan menyarankan fitur itu.
- Persetujuan pelanggan saat ini otomatis (Pengaturan "Setujui pekerjaan otomatis" menyala): servis baru langsung berstatus Disetujui. Tolak dan Tunda tetap bisa dicatat manual.
- Oli bulk (drum) dicatat dalam liter (satuan "L"). Stok oli bulk boleh minus dengan sengaja; Pemilik memakai angka itu untuk mengukur pemakaian. Jangan menyarankan koreksi stok oli bulk kecuali Pemilik memintanya.
- Jam pakai aplikasi: bila "Batasi staf sesuai jam buka bengkel" menyala, Service advisor, Kasir, Teknisi dan Hanya lihat hanya bisa memakai Axle mulai 1 jam sebelum buka sampai 1 jam setelah tutup (menurut Pengaturan → Jam buka). Di luar itu muncul layar "Di luar jam kerja". Pemilik, Admin dan Fleet manager tidak dibatasi.

## Bagian layar

- Menu atas: Dasbor, Hari ini, Papan Kerja, Kalender, Pelanggan, Katalog, Inventaris, Laporan (Laporan hanya untuk Pemilik, Admin, Service advisor, Kasir).
- Kanan atas: kotak cari, tombol + (Pekerjaan baru, Pelanggan baru, Kendaraan baru, Part baru, Janji servis baru, Purchase order baru; sesuai hak peran), roda gigi Pengaturan, lonceng Notifikasi, EN | ID, lingkaran inisial (Profil saya, Keluar).
- Cari: nama perusahaan, plat (spasi bebas), nomor pekerjaan atau invoice, lalu Enter. Plat atau nomor lengkap langsung membuka datanya.
- Lonceng: servis terlambat/segera jatuh tempo, invoice lewat jatuh tempo, keputusan online fleet manager.
- Profil saya: nama, telepon, bahasa, Ganti kata sandi (username hanya diubah admin). Lupa kata sandi? di halaman masuk → isi email. Terlalu banyak salah → tunggu 15 menit.

## 1. Membuat pekerjaan (Pemilik, Admin, Service advisor)

1. + → Pekerjaan baru (atau Pekerjaan baru di panel kendaraan, Jadwal servis, Papan Kerja; atau + Buat estimasi baru di janji).
2. Di kolom Perusahaan ketik nama perusahaan, plat nomor atau nama supir; memilih kendaraan sekaligus mengisi perusahaannya.
3. Isi Odometer masuk saat truk sudah ada di bengkel. Prioritas (Rendah, Sedang, Tinggi, Mendesak), Service advisor.
4. Supir: nama dan No. HP supir ("Dibawa oleh"). Bila kendaraan belum punya supir, supir ikut tersimpan di kendaraan; bila beda, centang "Jadikan supir tetap …" (hilangkan centang untuk supir pengganti sekali saja).
5. Keluhan pelanggan: satu keluhan per baris.
6. Buat pekerjaan. Bila kendaraan masih punya pekerjaan terbuka, Axle memperingatkan; biasanya lanjutkan pekerjaan yang lama.

Nomor pekerjaan 6 angka (mis. #100004). Pekerjaan tetap berjudul "(Estimasi)" sampai invoice dibuat.

- **Ulangi pekerjaan sebelumnya** (sejak 11 Nov 2026): tab Servis → tombol Ulangi pekerjaan sebelumnya, atau di pekerjaan baru tulisan "Truk ini terakhir servis … — Ulangi?". Pilih servis dari pekerjaan sebelumnya truk itu (atau cari No. pekerjaan), mekanik boleh dipilih → Salin. Harga = harga katalog hari ini, jumlah sama (cek liter oli bulk); keluhan tidak ikut; baris yang dulu di PO jadi baris biasa.
- **Simpan sebagai paket**: menu … servis (juga di pekerjaan yang sudah di-invoice) → Simpan sebagai paket: part dan jasa dari katalog jadi paket servis (Katalog → Paket servis). Part ketik manual tidak ikut. Pemilik, Admin, Service advisor.

## 2. Keluhan → servis (Pemilik, Admin, Service advisor)

- Pengaturan "Keluhan otomatis jadi servis" menyala: setiap baris keluhan langsung menjadi satu servis dengan nama yang sama dan saling terhubung. Bila sudah ada servis dengan nama itu, servis itu yang dihubungkan.
- Di servis yang masih kosong klik Isi dari paket… lalu pilih paket servis (mis. ganti oli + filter). Jadwal servis kendaraan yang cocok ikut terhubung.
- Atau tambah sendiri: Tambah jasa, part, atau biaya dari katalog… (stok di rak terlihat di daftar; part yang cocok untuk kendaraan ini muncul lebih dulu). Barang di luar katalog: + Baris manual… (Jasa, Part, Biaya, Sublet).
- Tambah paket servis atau paket harga tetap… di atas daftar servis menambah servis baru dari paket. Tambah servis = servis kosong.
- "N alternatif" di baris part: Ganti dengan ini atau Tambah. Menu … servis: urutan, Diskon servis…, Jadikan harga tetap, Hapus servis.
- Kolom Status baris part: Ada stok, Stok tinggal n, Stok habis, Diambil dari stok, atau status PO (Dipesan, Di draf PO, n dari m datang, Sudah datang).
- Servis kosong (tanpa part, jasa, atau mekanik) otomatis dihapus saat invoice dibuat; dialog invoice menyebut namanya.
- Pita kuning di atas pekerjaan: jadwal servis yang jatuh tempo (Tambahkan ke pekerjaan) dan servis yang pernah ditunda (Lihat dan tambahkan).
- Servis terakhir (tanggal · km · pekerjaan · invoice) tampil di halaman pekerjaan dan panel kendaraan.
- Inspeksi: tab Inspeksi → Mulai inspeksi → pilih daftar periksa → tiap poin hijau (Baik), kuning (Segera), merah (Sekarang). Jadikan keluhan untuk poin kuning/merah.

## 3. Persetujuan (Pemilik, Admin, Service advisor; Fleet manager untuk perusahaannya)

- Saat ini servis baru otomatis Disetujui. Hanya servis Disetujui yang masuk invoice.
- Untuk menolak atau menunda: kotak Persetujuan di kanan → Catat persetujuan → centang servis → Setujui, Tunda, Tolak, atau Kembalikan ke menunggu → isi Lewat (Langsung, Telepon, WhatsApp, Email, Internal) dan Diputuskan oleh → Simpan keputusan.
- Ditunda: tidak ditagih, masuk Pelanggan → Servis ditunda untuk kunjungan berikutnya (Tambahkan ke pekerjaan… atau Abaikan…). Ditolak: tidak ditagih.
- Servis yang sudah Selesai tidak bisa ditolak atau ditunda; kembalikan status kerjanya dulu.
- Bila persetujuan otomatis dimatikan, servis baru mulai sebagai Menunggu dan fleet manager bisa memutuskan sendiri secara online (tercatat "Online (Axle)", staf mendapat notifikasi). Fleet manager tidak bisa mengubah keputusannya; staf yang mengubah lewat Catat persetujuan.

## 4. Menugaskan mekanik (Pemilik, Admin, Service advisor)

- Per servis: pilih teknisi di kepala servis.
- Sekaligus: Mekanik untuk semua servis di tab Servis (hanya pekerjaan terbuka; servis yang sudah selesai tetap dengan mekaniknya).
- Mekanik wajib ada di setiap servis yang disetujui sebelum invoice.
- Teknisi tidak mengubah apa pun; mereka melapor ke Service advisor (servis selesai, kerusakan lain, part kurang, jam kerja, hasil inspeksi). Tugas teknisi: Papan Kerja (saringan Semua mekanik → namanya) dan Kalender tampilan Hari.

## 5. Status dan alur kerja

Urutan: Estimasi → Dijadwalkan → Sudah datang → Dikerjakan → Menunggu part → Selesai → Di-invoice → Lunas.

Pengaturan "Status pekerjaan bergerak sendiri" menyala. Status hanya bergerak sendiri setelah km masuk diisi:
- km masuk diisi pada pekerjaan Estimasi atau Dijadwalkan → Sudah datang (tidak ada tombol "kendaraan tiba" terpisah);
- mekanik dipasang atau kerja dimulai → Dikerjakan;
- ada part yang dipesan (PO) dan belum datang → Menunggu part; setelah diterima kembali ke Dikerjakan;
- semua servis selesai → Selesai (servis kosong tidak dihitung).

Manual: kotak Alur kerja di halaman pekerjaan, atau seret kartu di Papan Kerja (hanya yang belum di-invoice). Pindah ke Selesai manual menanyakan dulu, lalu servis yang disetujui ikut selesai. "Menunggu part" manual tanpa PO tetap dipertahankan. Di-invoice dan Lunas otomatis. Pindah ke Dijadwalkan tanpa janji membuka form janji.

Status kerja per servis: Belum, Dikerjakan, Selesai (diubah advisor di kepala servis).

## 6. PO dan menerima part (Pemilik, Admin, Service advisor)

Dua jenis PO: PO pekerjaan (nomor seperti 100005-101, dibuat dari pekerjaan) dan PO stok (nomor 900001 dst., untuk mengisi rak).

Memesan untuk pekerjaan: kotak Pesanan part → Pesan part / sublet. Part yang stoknya kurang sudah dicentang. Pilih supplier, jumlah, harga beli → Buat dan tandai dipesan (atau Simpan sebagai draf). Status pekerjaan jadi Menunggu part.

Untuk stok: Inventaris → Stok → centang → Pesan yang dipilih, atau + → Purchase order baru → Buat draf → tambah part → Tandai dipesan.

Menerima part yang sudah datang:
1. Buka PO-nya (Inventaris → Purchase order, cari nomor/supplier/plat/part; atau klik PO di "Menunggu apa" atau kotak Pesanan part).
2. Klik Terima part.
3. Di Datang sekarang ketik jumlah yang benar-benar datang (Semua datang mengisi semuanya). Sisanya tetap dipesan.
4. Isi Diterima tanggal, No. invoice supplier, Tanggal invoice; Jatuh tempo bayar boleh dikosongkan (dihitung dari termin).
5. Klik Terima. Part masuk ke rak dan muncul di Tagihan supplier. Part keluar dari rak saat pekerjaan yang memakainya dibuatkan invoice.

Lainnya di PO:
- **Sudah ada di katalog?** (sejak 11 Nov 2026): saat mengetik part di luar katalog di PO atau di pekerjaan, Axle menunjukkan part katalog yang mirip (nama atau nomor part) dengan stoknya; klik **Pakai ini** supaya yang dipakai part katalog. Baris pekerjaan yang sudah di PO dihubungkan lewat Katalog → Part di luar katalog.
- **PPN dihitung sekali dari total PO** (dan per invoice supplier bila PO datang bertahap), sama seperti faktur supplier, jadi tidak ada selisih Rp 1. Di PO, jumlah per baris tampil sebelum PPN.
- **Dibayar supir dulu (talangan)**: bila supir membayar sendiri ke bengkel luar atau toko, di PO bagian "Yang membayar supplier" centang Dibayar supir dulu (talangan); nama dan HP supir terisi dari pekerjaan, isi No. nota. Supir diganti oleh PT · pembukuan perusahaan truknya (atau oleh bengkel bila perusahaannya membayar ke bengkel). Penggantian uang supir disetujui pimpinan langsung (lisan atau WhatsApp), jadi sejak 12 Nov 2026 Axle tidak mencatat status Belum/Sudah diganti dan tidak ada tombol Sudah diganti. Cetakan PO dan cetakan invoice/estimasi menandai PO ini: baris part "Dibayar supir dulu: <nama>" dan kotak **Dibayar supir dulu (talangan)** dengan PO, nota, jumlah dan siapa yang mengganti. Lembar "bukti penggantian" tidak dipakai lagi. Bengkel tidak membayar supplier untuk PO ini.
- Salah jumlah diterima: menu baris → Koreksi jumlah diterima. Menu …: Cetak PO, Batalkan PO / Batalkan yang belum datang, Hapus draf.
- Harga modal dari PO otomatis masuk ke baris part di pekerjaan. Harga jual ikut (= modal × markup bawaan, saat ini 0%) selama belum diketik sendiri; harga jual yang diketik di pekerjaan tidak ditimpa.
- Baris pekerjaan dan baris PO-nya saling terhubung:
  - Nama diganti di salah satu, yang lain ikut. Invoice yang sudah terbit tidak berubah.
  - Harga modal: baris pekerjaan dan baris PO-nya memakai satu harga modal. Yang terakhir diubah (di pekerjaan atau di PO) yang berlaku, selama baris PO belum dibayar dan tidak dibatalkan dan pekerjaan belum di-invoice. Jadi boleh pesan dengan harga Rp 0 dulu bila harganya belum tahu.
  - Jumlah ikut berubah di kedua tempat hanya selama PO masih Draf. Setelah dipesan, pekerjaan menampilkan "PO …: dipesan 4 · pekerjaan butuh 6"; ubah jumlah di PO bila supplier setuju.
  - Bila harga modal di PO tetap berbeda (baris PO sudah dibayar), di bawah baris pekerjaan tertulis "Harga di PO …: Rp …".
- Baris yang ditambahkan langsung di PO pekerjaan (belum ada di pekerjaan) ditandai "Belum ada di pekerjaan #…". Klik **Masukkan ke pekerjaan** di PO, atau di kotak Pesanan part di halaman pekerjaan: pilih servisnya (atau servis baru "Part tambahan"). Baris yang sama dengan baris yang sudah ada di pekerjaan dihubungkan, bukan ditambah dua kali.
- Pekerjaan luar (sublet), mis. bubut, pasang/balancing ban oleh toko ban:
  - Tambahkan baris jenis Sublet di servis, lalu **Pesan part / sublet**.
  - Pekerjaan luar boleh ke supplier mana pun, jadi toko ban yang menjual ban sekaligus memasangnya cukup satu PO (ban = part, pasang = sublet). Part hanya ke pemasok part; bengkel sublet hanya menerima pekerjaan luar dan hanya untuk PO pekerjaan.
  - Di PO dan cetakannya tertulis "pekerjaan luar". Saat selesai, **Terima** dengan no. invoice mereka: stok tidak berubah, harganya masuk ke baris sublet, tagihannya masuk Tagihan supplier (atau Tagihan PT bila PO-nya dibayar PT).
  - Pekerjaan luar tidak bisa diretur. Di invoice tetap tertulis sebagai Sublet.
  - Selama belum selesai, "Menunggu apa" menulis "Sublet: … · PO … · supplier", status pekerjaan Menunggu part.
- Cetak PO pekerjaan memuat kotak Kendaraan (plat, Supir, "Pemilik: <PT pemilik truk>") agar supplier tahu PT mana yang membayar.
- Tulisan "N di rak" di baris PO adalah jumlah fisik di rak. Angka itu bisa termasuk part yang sudah dipakai di pekerjaan lain yang belum di-invoice, jadi yang benar-benar tersedia bisa lebih kecil, bahkan minus. Cek Tersedia di Inventaris → Stok atau di Kartu stok.
- "{n} tidak dipakai di job … · ada di stok": part datang untuk pekerjaan tetapi tidak jadi dipakai, sekarang dihitung sebagai stok. Secara fisik beri label PT pemiliknya.
- Part yang diketik manual tidak dihitung di stok. Tambah ke katalog di baris PO/pekerjaan, atau Katalog → Part → Part di luar katalog (Part katalog baru / Hubungkan ke part di katalog). Baris pekerjaan dan baris PO-nya ditambahkan bersama. Memasukkan hitungan ke stok hanya Pemilik/Admin; lainnya pilih "Mulai dari 0".
- **Nomor part lain** (sejak 11 Nov 2026): di form part, baris Merek + No. part dengan tombol **+ Tambah nomor** (nomor merek lain atau nomor pengganti untuk part yang sama; satu harga, satu stok). Merek yang distok dan diberi harga sendiri tetap part sendiri. Bila nomor yang diketik sudah ada di part lain, muncul "Nomor ini sudah ada di: …"; cek dulu sebelum membuat part baru.

## 7. Retur dan core (Pemilik, Admin, Service advisor)

- Retur part yang sudah diterima: buka PO → Retur ke supplier → isi jumlah Dikembalikan → Tandai untuk retur.
- Retur dari rak: Inventaris → Retur → Retur dari stok.
- Langkah retur: Akan dikirim → Dikirim (stok keluar dari rak saat ini) → Diterima supplier → Direfund (isi No. nota kredit).
- Core (mis. aki lama): muncul di Inventaris → Core saat pekerjaan dengan part bercore di-invoice. Tandai Sudah dilepas, lalu ikuti sampai Direfund.

## 8. Stok dan kartu stok

- Inventaris → Stok: Di rak, Di estimasi, Tersedia (= di rak dikurangi kebutuhan estimasi terbuka), Dipesan. Habis, Menipis, Perlu dipesan muncul sendiri (dari Pesan ulang di).
- Kartu stok: Inventaris → Stok → klik nama part (atau Kartu stok di part katalog). Menampilkan Stok sekarang (dengan satuan, mis. L), Terpakai hari ini, 7 hari terakhir (jumlah pekerjaan dan rata-rata), Di estimasi terbuka, Dipesan, dan Riwayat (Semua, Keluar, Masuk, Penyesuaian) dengan nomor pekerjaan/invoice/PO, kendaraan, siapa, dan saldo setiap baris. "di bawah nol" berarti terpakai lebih banyak dari yang masuk.
- Stok berubah sendiri: masuk saat Terima part, keluar saat invoice dibuat atau retur Dikirim, kembali saat invoice dibatalkan.
- Koreksi hasil hitung: hanya Pemilik/Admin, di kartu stok atau part katalog → Sesuaikan stok → Jumlah hasil hitung + Alasan → Konfirmasi jumlah stok baru. Peran lain minta Pemilik/Admin.
- Satuan part (mis. L, pcs, set) diisi di form part (Satuan). Tampil di kartu stok, daftar stok dan Hari ini; belum di baris pekerjaan dan cetakan.
- Oli bulk: isi jumlah liter yang benar di baris pekerjaan; jumlah bawaan katalognya 1, jadi baris yang tetap 1 biasanya berarti liternya belum diisi.

## 9. Invoice (Pemilik, Admin, Service advisor)

1. Pastikan servis yang disetujui sudah Selesai dan semuanya punya mekanik.
2. Kotak Status order → Buat invoice → periksa ringkasan → Buat invoice.

- Km keluar tidak ada lagi dan tidak diperlukan. Cetakan hanya menampilkan km masuk.
- **Km masuk wajib** sebelum invoice (sejak 10 Nov 2026). Bila km tidak bisa dibaca (truk diderek, odometer rusak): di halaman pekerjaan, di samping Km masuk, centang **Km tidak terbaca** dan isi alasannya. Cetakan menulis "Odometer: tidak terbaca". Mengisi km menghapus centangnya.
- Ditolak bila: masih ada servis Menunggu persetujuan, belum ada servis disetujui, servis disetujui belum punya mekanik, atau km masuk kosong (dan tidak dicentang Km tidak terbaca).
- **Ditolak juga bila PO pekerjaan itu belum diterima semua** (sejak 11 Nov 2026): masih ada baris PO (juga draf dan pekerjaan luar) yang dipesan − diterima − dibatalkan > 0. Dialog invoice menyebut PO-nya dengan link: Terima part, atau batalkan yang belum datang. Hanya Pemilik/Admin yang bisa tetap membuat invoice dengan menulis alasan; alasan itu tercatat di invoice dan di Aktivitas.
- Peringatan (tidak menghalangi): part masih Rp 0, stok di rak tidak cukup (stok akan minus), melebihi batas kredit, perusahaan tanpa akun tagihan.
- Setelah terbit: nomor invoice = nomor pekerjaan + versi, mis. pekerjaan #100045 → **INV-100045-1**; bila di-void lalu dibuat lagi → INV-100045-2 (sejak 10 Nov 2026; invoice lama tetap INV-000001 … INV-000031); part keluar dari stok; pekerjaan, harga, keluhan, inspeksi dan persetujuan terkunci. Masih bisa: pembayaran, teknisi dan status kerja, catatan bengkel, service advisor, prioritas, No. faktur pajak, berkas, Tandai sudah diambil.
- Invoice salah: hanya Pemilik/Admin → Status order → Batalkan invoice + alasan. Nomor lama disimpan sebagai BATAL, pekerjaan kembali jadi estimasi, pembayaran jadi kredit perusahaan dan diterapkan lagi, part kembali ke stok. Perbaiki lalu Buat invoice lagi (nomor baru).
- Tutup tanpa invoice (menu … kanan atas): untuk estimasi yang tidak jadi, wajib alasan. Tidak bisa bila ada servis disetujui atau selesai, atau ada uang. Karena servis sekarang otomatis disetujui, Tolak atau hapus servisnya dulu. Buka kembali membatalkannya.
- Hapus estimasi: hanya Pemilik/Admin, untuk estimasi tanpa pembayaran atau invoice.
- No. faktur pajak (bengkel PKP): kotak Status order setelah invoice terbit, 13–20 angka dengan titik atau tanda hubung, satu nomor per invoice. Bisa diisi advisor, Kasir, Pemilik, Admin.
- Tandai sudah diambil (advisor, Pemilik, Admin) saat kendaraan dijemput; kartunya hilang dari Papan Kerja. Salah klik → Batalkan.
- PPN tidak ditampilkan bila nilainya Rp 0.

## 10. Pembayaran pelanggan (Kasir, Pemilik, Admin; bukan Service advisor)

- Buka pekerjaan → kotak Total → Pembayaran → Jenis (Pembayaran atau Pengembalian), Jumlah (terisi sisa tagihan), Metode (Transfer bank, Tunai, Kartu, Giro, Lainnya), Tanggal, Referensi, No. kuitansi → Simpan.
- Sebelum invoice: dicatat sebagai uang muka dan otomatis mengurangi tagihan saat invoice dibuat.
- Status: Belum dibayar → Dibayar sebagian → Lunas (kartu pindah ke kolom Lunas).
- Satu transfer untuk beberapa invoice: catat satu pembayaran di setiap invoice dengan referensi yang sama.
- Kotak Total → Kredit: Terapkan, Lepas (di invoice terbit hanya Pemilik/Admin), Terbitkan kredit baru (Pemilik/Admin). Kembalikan saldo sebagai uang: panel perusahaan → Cairkan kredit.
- Bukti transfer: kotak Berkas → Tambah bukti transfer (foto atau PDF, hanya terlihat bagian keuangan).
- Salah catat: uang muka bisa dihapus (ikon tempat sampah) lalu dicatat ulang; setelah invoice terbit hanya Pemilik/Admin yang bisa mengubah atau menghapus.
- Daftar: Pelanggan → Invoice (Belum lunas, Lewat jatuh tempo, Lunas, Semua); Pelanggan → Pembayaran.

## 11. Tagihan supplier (Pemilik, Admin, Service advisor, Kasir)

- Inventaris → Tagihan supplier: part yang sudah diterima tetapi belum dibayar, per supplier, dengan Harus dibayar, Lewat jatuh tempo, Jatuh tempo 7 hari ke depan.
- Centang baris (atau Pilih semua dari <supplier>) → Bayar yang dipilih → Dibayar tanggal, Metode, Referensi → Catat pembayaran.
- Dari PO: Bayar part yang datang, atau menu baris → Bayar.
- Jumlah dihitung dari yang benar-benar diterima, termasuk biaya core dan pajak; part yang diretur tidak ditagih.
- Salah bayar: Pembayaran terakhir di bawah daftar → Batalkan.
- PO yang dibayar langsung oleh PT tidak ada di Tagihan supplier (lihat bagian 11a).
- PO talangan (dibayar supir dulu) juga tidak ada di daftar supplier. Bila perusahaannya membayar ke bengkel, PO itu muncul di bagian "Supir yang harus diganti (oleh bengkel)" (PO, supir, supplier, jumlah).

## 11a. PT yang membayar supplier sendiri, jasa tidak ditagih, drum oli

Saat ini bengkel belum punya rekening dan kasir, jadi setiap PT membayar suppliernya sendiri dan jasa belum ditagih.
- Pelanggan → perusahaan → Ubah → "Cara perusahaan ini membayar":
  - **Part dibayar langsung oleh PT ke supplier**: PO pekerjaan untuk perusahaan ini otomatis bertanda "Dibayar PT". Tidak masuk Tagihan supplier dan tidak bisa dibayar dari bengkel. Cetakan PO menulis "Tagihan atas nama: <PT>".
  - **Jasa tidak ditagih**: di halaman pekerjaan, baris jasa tetap menunjukkan harganya dengan tulisan "tidak ditagih" di bawahnya; di cetakan invoice tertulis "tidak ditagih" (Rp 0). Jasa tidak masuk total. Di bawah total tertulis "Nilai jasa tidak ditagih".
  - **PT pembayar**: isi bila beberapa perusahaan dibayar oleh satu PT. Kosong berarti perusahaan itu sendiri.
  - **Pembukuan** (sejak 10 Nov 2026): pembukuan di dalam PT pembayar tempat biaya perusahaan ini dicatat (mis. PIJ 1, PIJ 2, Ekspedisi Lintas, Umum, Kao, Horeka). Supplier tetap mengirim satu tagihan per PT, tetapi PO, invoice, Tagihan PT dan drum menunjukkan pembukuannya. Kosong berarti nama perusahaan itu sendiri.
- Di invoice perusahaan yang membayar langsung, part dan pekerjaan luar tetap tertulis dengan harganya. Di bawahnya ada baris "Dibayar langsung ke supplier oleh <PT>" (minus), jadi sisa tagihan ke bengkel hanya yang lain (mis. jasa yang ditagih).
- Di PO: bagian "Yang membayar supplier". PO pekerjaan: centang Dibayar langsung oleh PT (hanya untuk perusahaan yang "Part dibayar langsung"; perusahaan yang membayar ke bengkel tidak bisa). PO stok (mis. drum oli): ketik nama PT yang membayar, kosong berarti bengkel. Tidak bisa diganti bila bengkel sudah mencatat pembayaran di PO itu, atau bila pekerjaannya sudah di-invoice (void invoice-nya dulu; saat di-void, PO ikut pengaturan perusahaan yang sekarang).
- Dihitung per jumlah: bila PO yang dibayar PT hanya menutup sebagian baris (mis. pekerjaan butuh 3, PO PT 2; atau sebagian dibatalkan atau diretur ke supplier), sisanya dianggap dari bengkel (stok atau PO bengkel) dan ditagih ke perusahaan.
- Estimasi yang seluruhnya dibayar PT tidak ditandai Lunas sebelum dibuatkan invoice. Setelah di-invoice: sisa Rp 0, Lunas.
- Dasbor: "Tagihan bengkel bulan ini" hanya bagian bengkel. Kotak "Dibayar langsung oleh PT bulan ini" menunjukkan berapa yang dibayar setiap PT ke supplier di invoice bulan ini.
- Nama PT yang sama dengan huruf besar/kecil atau spasi berbeda (mis. "pt pulau indah jaya" dan "PT Pulau Indah Jaya") dihitung sebagai satu PT.
- Inventaris → **Tagihan PT**: daftar per bulan, per PT dan per supplier, berisi part dan pekerjaan luar yang diterima bulan itu di PO yang dibayar PT. Setiap baris menunjukkan pembukuannya, dan di bawah nama PT ada total per pembukuan. Pilihan pembukuan di atas menampilkan satu pembukuan saja (untuk dicetak bagi pembukuannya). Dipakai untuk mencocokkan tagihan akhir bulan dari supplier. Bengkel tidak mencatat pembayaran di sini. Hanya untuk yang boleh melihat harga modal atau membayar tagihan supplier.
- PO pekerjaan dan cetakannya menulis "Tagihan atas nama: <PT>" dan "Pembukuan: <pembukuan perusahaan>". PO stok (mis. drum) punya pilihan Pembukuan di bawah nama PT yang membayar (kosong = seluruh PT).
- Invoice perusahaan yang membayar langsung menulis PT pembayar dan Pembukuan di bagian Tagihan kepada.
- Inventaris → **Drum**: setiap drum oli bulk (oli, liter, harga per liter, PT dan pembukuan yang membayar, tanggal dibuka; harga bisa ditandai **harga perkiraan**). Oli yang terpakai di pekerjaan yang sudah di-invoice mengisi drum dari yang paling lama, dan tercatat saat invoice dibuat (invoice lain tidak mengubahnya; hanya menambah, menghapus atau mengubah liter/tanggal drum yang menghitung ulang). Setiap drum menunjukkan sisa, terpakai, per perusahaan, dan "<PT · pembukuan> membayar ke <PT · pembukuan>: … L = Rp …" untuk oli yang dipakai pembukuan lain, juga di dalam satu PT (mis. PIJ 2 membayar ke PIJ 1 untuk drum Meditran). Drum tanpa pembukuan milik seluruh PT. Oli di pekerjaan yang belum di-invoice belum dihitung. Tambah, ubah, hapus drum: yang boleh mengelola inventaris.
- **Lampiran oli drum** (sejak 12 Nov 2026): invoice yang memakai oli drum dicetak bersama satu lembar terpisah "Pemakaian oli drum · Lampiran invoice INV-…": per baris oli, drum milik siapa, liter, harga per liter, jumlah, total, dan "Bayar ke <PT · pembukuan>" atau "Drum sendiri"; di bawahnya "Pembayaran oli drum: bayar Rp … ke …" dan tanda tangan Service advisor dan Supir. Invoice-nya sendiri tidak lagi menyebut oli drum. Di halaman cetak bisa dipilih **Invoice + lampiran oli drum** atau **Lampiran oli drum saja**. Harga yang masih perkiraan ditandai. Bila harga drum diperbaiki, cetakan berikutnya ikut harga baru.
- **Tagihan oli drum** (sejak 11 Nov 2026): Inventaris → Drum → **Cetak tagihan**: satu lembar per pembukuan yang memakai oli drum PT/pembukuan lain (tiap invoice: tanggal, truk, liter, jumlah; total, sudah dibayar, sisa), pilih drum, pembukuan dan periode, unduh CSV; pemakaian sendiri pemilik drum dicetak terpisah sebagai info. **Tandai lunas** (Pemilik/Admin) mencatat pembayaran antar PT/pembukuan; di halaman Drum tertulis Lunas atau "dibayar …, sisa …".
- Tagihan PT juga punya **Oli dari drum · bayar ke <PT · pembukuan>** (oli dari invoice bulan itu, masuk total pembukuan) dan di sisi pemilik drum "Akan diterima"; PO talangan tampil sebagai "Dibayar supir dulu: <nama>".
- Bila harga drum diubah, Axle menawarkan mengubah harga katalog oli itu (jual dan modal) dan oli di pekerjaan yang belum di-invoice. Invoice yang sudah ada tidak berubah.
- Laporan → Penjualan menampilkan "Jasa tidak ditagih (tidak masuk total)" dan "Dibayar PT ke supplier (masuk total)" bila ada.
- PPN saat bengkel bukan PKP (Pengaturan → Status PKP = Non-PKP): bengkel tidak bisa mengkreditkan PPN supplier, jadi PPN itu bagian dari harga modal.
  - Di PO, harga per baris adalah harga supplier sebelum PPN; PPN supplier ditambahkan di total PO, sama seperti tagihan supplier.
  - Di pekerjaan, harga modal dari PO = harga PO + PPN-nya (mis. Rp 100.000 + 11% = Rp 111.000). Harga modal yang diketik di pekerjaan masuk ke PO tanpa PPN. Di jendela Pesan part, ketik harga termasuk PPN.
  - Invoice bengkel tidak memuat PPN.
  - Supplier yang tidak mengenakan PPN: Katalog → Supplier → matikan "Mengenakan PPN". PO barunya 0% PPN.
  - Satu tagihan berbeda (mis. kali ini tanpa PPN): di halaman PO, centang/hapus "Supplier mengenakan PPN di tagihan ini". Tidak bisa diubah setelah bengkel mencatat pembayaran di PO itu, atau bila ada retur.

## 12. Kalender dan janji servis (buat/ubah: Pemilik, Admin, Service advisor; lainnya melihat)

- Tampilan Hari (satu kolom per mekanik), Minggu, Bulan. Panel Permintaan berisi janji berstatus Diminta.
- Buat: klik slot kosong atau + Janji (atau + → Janji servis baru, atau Janji servis di panel perusahaan). Cari perusahaan, plat atau supir → kendaraan → tautkan pekerjaan yang ada atau + Buat estimasi baru (Keluhan pengemudi, satu per baris) → mekanik, status, catatan → Buat janji.
- Status janji: Diminta, Terjadwal, Dikonfirmasi (pekerjaan jadi Dijadwalkan), Tiba (pekerjaan jadi Sudah datang), Batal, Tidak datang. Cara utama menandai truk datang: isi km masuk.
- Seret janji untuk memindah waktu (di tampilan Hari juga mengganti mekanik). Hanya pada jam buka, paling lama 14 hari.

## 13. Kendaraan dan jadwal servis (ubah: Pemilik, Admin, Service advisor)

- Pelanggan → Kendaraan → Tambah kendaraan: perusahaan, plat, merek, model, tahun, jenis, bahan bakar, VIN, odometer, supir. Klik kendaraan untuk panelnya (Ringkasan, Pekerjaan, Inspeksi; jadwal servis, riwayat kepemilikan, Servis terakhir).
- Pindahkan ke PT lain: riwayat ikut. Tidak bisa selama ada uang muka perusahaan lama di pekerjaan terbuka.
- Hapus kendaraan ini: hanya Pemilik.
- Jadwal servis berkala: panel kendaraan → Tambah jadwal → Paket servis (opsional), nama, Setiap (km) dan/atau bulan, kapan terakhir dikerjakan. Jadwal maju sendiri saat servisnya selesai di sebuah pekerjaan. Status Terlambat, Segera, Aman, Belum pernah, Dinonaktifkan. Batas "segera" diatur di Pengaturan → Invoice & penomoran.
- Pelanggan → Jadwal servis: kendaraan Terlambat atau Segera jatuh tempo → Buat janji atau Buat pekerjaan.

## 14. Pelanggan / perusahaan (ubah: Pemilik, Admin, Service advisor)

- Setiap perusahaan (PT/CV) adalah satu pelanggan dengan tagihannya sendiri; kendaraan milik satu perusahaan.
- Pelanggan punya tab: Pelanggan, Kendaraan, Jadwal servis, Repair order, Invoice, Pembayaran, Servis ditunda.
- + Pelanggan: Nama perusahaan (singkat), Jenis pelanggan, Nama badan usaha (di invoice), NPWP, Alamat penagihan, Termin pembayaran (kosong = bawaan), Batas kredit, Akun tagihan, Bebas pajak, Catatan penting, kontak.
- Panel perusahaan: Tambah kontak, Pekerjaan baru, Tambah kendaraan, Janji servis, Daftar kendaraan, Kendaraan + riwayat servis, Nota kredit (Pemilik/Admin), Cairkan kredit (Kasir, Pemilik, Admin).
- Hapus perusahaan atau kontak: hanya Pemilik (perusahaan yang masih punya kendaraan tidak bisa dihapus).

## 15. Laporan

Pilih periode dan perusahaan; Unduh CSV untuk Excel.
- Penjualan, Umur piutang, Pembayaran diterima: Pemilik, Admin, Service advisor, Kasir.
- Teknisi, Biaya armada, Kepatuhan servis: Pemilik, Admin, Service advisor.
- Laba, Inventaris (memuat harga modal): Pemilik, Admin, Service advisor.
- **Rekap servis** (sejak 12 Nov 2026): Pemilik, Admin, Service advisor, Kasir. Apa yang dikerjakan pada kendaraan tiap perusahaan dengan harganya, dari invoice yang terbit di periode itu (menurut tanggal invoice; invoice batal tidak termasuk). Saringan: periode, PT pembayar, Pembukuan, Perusahaan, Kendaraan; jenis Part, Jasa, Pekerjaan luar, Oli drum, Lain-lain (diskon, harga paket, biaya, pajak). Tampilan **Ringkas** (per kendaraan: kunjungan, jumlah per jenis, total, kunjungan terakhir, km ditempuh dan Rp per km), **Per invoice** (tanggal, nomor, km, pekerjaan, total) atau **Rinci** (setiap servis dan baris). Jasa yang tidak ditagih tertulis Rp 0 dengan nilainya. "Satu perusahaan per halaman", Unduh CSV, Cetak (membuka halaman cetak). **Tampilkan harga modal** (modal dan laba) hanya untuk Pemilik/Admin. Juga dari panel perusahaan: tombol **Rekap servis** (tahun ini, perusahaan itu).

## 16. Hari ini (semua staf; isinya mengikuti hak peran)

Menu Hari ini, atau Lihat rincian hari ini di Dasbor: Pekerjaan dibuka, Invoice dibuat, Uang masuk, Masih di bengkel (dengan "Menunggu apa"), Part keluar dari stok, Part datang, Tagihan supplier ≤ 7 hari. Hari lain lewat panah atau Tanggal; Cetak. Uang hanya untuk yang melihat laporan; nilai part untuk yang melihat harga modal. Cocok untuk penutupan hari.

Dasbor: Hari ini (janji, Di bengkel = truk yang benar-benar ada, Menunggu part, Siap dibuatkan invoice), Keuangan (tidak untuk Teknisi/Hanya lihat), Perlu perhatian.

## 17. Papan Kerja dan "Menunggu apa"

- Semua pekerjaan yang masih di bengkel (belum diambil, tidak ditutup), satu kolom per status. Tampilan Kanban atau Daftar. Saringan: kotak cari (pekerjaan, perusahaan, plat, supir, kontak), Semua mekanik, Semua service advisor, Semua prioritas.
- Kartu: nomor, perusahaan, plat · supir, janji, prioritas, persetujuan menunggu, teknisi, servis selesai, jam, total, Menunggu apa. Menu … kartu: Buka pekerjaan, Pindah ke …, Buat janji, Tandai sudah diambil, Cetak.
- Arti "Menunggu apa" dan langkahnya:
  - Belum datang (km masuk kosong) / Belum datang · janji …: isi km masuk saat truk tiba.
  - Persetujuan: N servis menunggu: catat persetujuan.
  - Part: … · PO … · supplier · dipesan …: tunggu part, lalu Terima part di PO (klik tulisannya).
  - Menunggu part (belum ada PO): buat PO lewat Pesan part / sublet, atau ubah status bila tidak perlu.
  - PO … belum dikirim ke supplier: buka PO → Tandai dipesan.
  - Belum ada pekerjaan: isi servis dari paket atau tambah part/jasa.
  - Mekanik belum dipasang (N servis): pasang mekanik.
  - <mekanik>: N servis belum selesai: tunggu mekanik; tandai Selesai bila sudah.
  - N part masih Rp 0: isi harganya sebelum invoice.
  - Siap dibuatkan invoice: Buat invoice.
  - Sudah di-invoice · menunggu diambil: Tandai sudah diambil saat truk dijemput.

## 18. Cetak

- Pekerjaan → Cetak → Estimasi atau Invoice + bahasa (Bahasa Indonesia/English) → Cetak. Untuk WhatsApp/email pilih "Simpan sebagai PDF" di jendela cetak browser.
- Invoice memuat rekening bank, pembayaran, sisa tagihan, supir, tanda tangan Service advisor, Mekanik, Supir, Pimpinan. Harga modal tidak pernah tercetak.
- Cetak PO: menu … di PO. Riwayat servis, Daftar kendaraan, Kendaraan + riwayat servis: panel kendaraan/perusahaan.
- Invoice/estimasi dicetak per halaman A4 (sejak 10 Nov 2026): tanda tangan selalu di halaman 1. Bila semua servis muat di halaman 1, halaman 1 berisi total lengkap; bila servis berlanjut, halaman 1 berisi ringkasan dan halaman berikutnya bertanda "Lanjutan" dengan kotak paraf. Kolom Diskon tidak dicetak bila tidak ada diskon. Nomor halaman "Halaman x dari N".
- Semua cetakan lain (PO, riwayat, Tagihan PT, Hari ini, Laporan) punya margin dan nomor halaman, tanpa tombol atau kotak isian; tabel tercetak penuh dengan judul kolom di tiap halaman. Laporan punya tombol Cetak dan dicetak mendatar.

## 19. Pengaturan dan pengguna

Semua staf bisa membuka Pengaturan (roda gigi); hanya Pemilik/Admin yang mengubah, lalu Simpan perubahan. Bagian: Profil bengkel, Tampilan, Bahasa & cetak, Jam buka, Invoice & penomoran (termasuk Pekerjaan & part: Setujui pekerjaan otomatis, Keluhan otomatis jadi servis, Status pekerjaan bergerak sendiri, Markup part bawaan), Biaya & pajak, Tarif jasa, Pengguna & akses, Impor data.

- Markup part bawaan (saat ini 0%): part katalog baru dan part yang diketik diberi harga modal + markup. Terapkan …% ke semua part…: hanya Pemilik.
- Pengguna & akses (Pemilik/Admin): Undang pengguna → nama, email, username, peran → Cara masuk pertama kali: Undangan lewat email (Kirim undangan) atau Kata sandi sementara (tanpa email) (Buat login; orangnya lalu membuat kata sandi sendiri). Atur ulang kata sandi = kata sandi sementara baru. Nonaktifkan untuk yang keluar; Hapus hanya akun salah buat. Fleet manager: centang perusahaannya (Perusahaan… untuk mengubah); hentikan dengan Nonaktifkan, jangan ganti ke peran staf.
- Jam pakai aplikasi untuk staf (Pemilik/Admin, di bawah Pengguna & akses): Batasi staf sesuai jam buka bengkel; Izinkan lembur (pilih orang, sampai tanggal/jam, paling lama 2 hari ke depan; Akhiri sekarang); daftar Dipakai di luar jam kerja.
- Impor data (Pemilik/Admin): Unduh templat → isi → CSV UTF-8 → Pilih berkas CSV… → Impor.

## Istilah dan status

- Estimasi: belum di-invoice. Dijadwalkan: ada janji, truk belum datang. Sudah datang: truk di bengkel (km masuk terisi). Dikerjakan: mekanik bekerja. Menunggu part: part dipesan belum datang. Selesai: siap invoice. Di-invoice: invoice terbit (otomatis). Lunas: dibayar penuh (otomatis).
- Pembayaran: Belum dibayar, Dibayar sebagian, Lunas, Lewat jatuh tempo.
- Ditutup: ditutup tanpa invoice. Sudah diambil: truk sudah dijemput, hilang dari Papan Kerja.
- Persetujuan servis: Menunggu, Disetujui, Ditunda, Ditolak. Status kerja servis: Belum, Dikerjakan, Selesai.
- Status PO: Draf, Dipesan, Sebagian datang, Sudah datang, Dibatalkan. Baris PO: Menunggu, Sebagian diterima, Diterima, Dibatalkan.
- Di rak: jumlah fisik di rak, termasuk part yang sudah masuk estimasi terbuka. Tersedia: di rak dikurangi kebutuhan estimasi terbuka (bisa minus). Dipesan: di PO yang belum datang. Di estimasi: dibutuhkan estimasi terbuka.
- Uang muka: bayar sebelum invoice. Kredit: saldo perusahaan (dari invoice batal atau nota kredit). Sublet: pekerjaan luar. Core: part lama dikirim balik untuk refund. Part di luar katalog: diketik manual, tidak dihitung stok.
- Titipan: BUKAN fitur Axle. Part sisa per PT diberi label manual.

## Tanya jawab

- **"1 di rak" di PO tapi part tidak bisa dipakai / stok minus.** "Di rak" menghitung semua yang fisik ada, termasuk part yang sudah masuk pekerjaan lain yang belum di-invoice. Lihat Tersedia di Inventaris → Stok atau Kartu stok; bisa lebih kecil atau minus.
- **Status pekerjaan tidak bergerak.** Km masuk belum diisi. Isi Odometer masuk di halaman pekerjaan; status langsung Sudah datang (bila masih Estimasi/Dijadwalkan).
- **Km keluar di mana?** Sudah dihapus; tidak perlu untuk invoice.
- **Buat invoice ditolak.** Baca pesannya: biasanya servis disetujui belum punya mekanik, masih ada servis Menunggu, atau tidak ada servis disetujui.
- **Ada peringatan part Rp 0.** Isi harga part bila harus ditagih; invoice tetap bisa dibuat.
- **Part datang tapi tetap Menunggu part.** Cek semua baris PO sudah diterima, atau status itu dipasang manual; ubah di Alur kerja.
- **Harga part belum tahu saat pesan.** Pesan dengan harga Rp 0; ketik harga modal di pekerjaan atau di PO saat sudah tahu, yang lain ikut berubah (selama belum dibayar).
- **Part ditambah di PO tapi tidak muncul di invoice.** Baris itu belum ada di pekerjaan: klik **Masukkan ke pekerjaan** di PO atau di kotak Pesanan part.
- **Service advisor ingin mencatat pembayaran.** Tidak bisa; Kasir, Pemilik atau Admin yang mencatat. Advisor bisa membayar tagihan supplier.
- **Invoice salah.** Minta Pemilik/Admin Batalkan invoice, perbaiki, buat invoice lagi.
- **Tidak bisa Tutup tanpa invoice.** Ada servis disetujui (otomatis) atau selesai, atau ada uang. Tolak/hapus servisnya atau kembalikan uangnya dulu.
- **Stok di Axle beda dengan rak.** Pemilik/Admin: Sesuaikan stok dengan alasan. Kecuali oli bulk: minus memang disengaja.
- **Part sisa dari PO PT A.** Beri label manual untuk PT A. Tidak ada fitur titipan.
- **Oli mesin bulk SAE 40 ada dua.** Sejak 6 Nov ada drum baru "Oli mesin bulk SAE 40 Meditran S" (Pertamina); pilih yang itu di pekerjaan. Yang lama tetap ada dengan stok minus.
- **Tidak bisa menghapus kendaraan/perusahaan/kontak.** Hanya Pemilik.
- **"Di luar jam kerja".** Minta Pemilik/Admin Izinkan lembur.
- **Fleet manager salah memutuskan.** Staf mencatat keputusan baru dengan Catat persetujuan (bisa Kembalikan ke menunggu).
- **Siapa yang mengubah sesuatu?** Tab Aktivitas di pekerjaan, atau Lihat riwayat perubahan.

## Tanya Claude (bantuan ini)

- Ikon gelembung percakapan di kanan atas, di sebelah kiri roda gigi Pengaturan. Bisa dipakai semua login, termasuk Fleet manager.
- Hanya membaca dan memberi saran; tidak bisa mengubah data apa pun. Jawaban memakai data yang boleh dilihat oleh login yang bertanya.
- Pertanyaan dan jawaban dicatat dan bisa dilihat Pemilik/Admin di Pengaturan → Tanya Claude, beserta 👍/👎.
- Ada batas pertanyaan per orang per hari dan batas biaya per bulan, diatur Pemilik/Admin di Pengaturan → Tanya Claude. Bila batas tercapai muncul pesan; coba lagi besok atau minta Pemilik menaikkan batasnya.
- "Kurang jelas? Tanya lebih teliti" di bawah jawaban menanyakan ulang ke model yang lebih teliti (dihitung sebagai satu pertanyaan lagi).
