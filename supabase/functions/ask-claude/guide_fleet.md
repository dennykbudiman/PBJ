# Panduan Axle untuk Fleet manager

Latar belakang untuk "Tanya Claude" (per 6 November 2026) bagi login Fleet manager, orang armada perusahaan pelanggan. Tanya Claude hanya melihat data: sebut menu dan tombol yang harus diklik sendiri. Fleet manager hanya melihat perusahaan yang ditautkan bengkel ke akunnya.

## Yang bisa dan tidak bisa

Bisa:
- melihat data perusahaan, kontak, kendaraan (termasuk supir), jadwal servis dan servis jatuh tempo;
- melihat repair order dan invoice lengkap dengan harga jual, total, PPN, pembayaran dan sisa tagihan;
- menyetujui, menunda atau menolak servis yang menunggu, satu kali;
- mencetak estimasi, invoice, riwayat servis dan daftar kendaraan.

Tidak bisa:
- mengubah data apa pun (semua hanya dibaca);
- membuat janji servis atau pekerjaan (hubungi bengkel);
- mengubah keputusan yang sudah disimpan;
- melihat harga modal, laba, catatan internal bengkel, berkas lampiran, tab Aktivitas, pesanan part ke supplier, perusahaan lain atau karyawan bengkel.

## Masuk

- Bengkel membuat akun: lewat email undangan (klik tautan, buat kata sandi minimal 8 karakter) atau kata sandi sementara dari bengkel (lalu buat kata sandi sendiri).
- Masuk dengan username (atau email) dan kata sandi. EN | ID di kanan atas mengganti bahasa. Lingkaran inisial: Profil saya (nama, telepon, bahasa, Ganti kata sandi) dan Keluar.
- Lupa kata sandi? di halaman masuk → isi email. Terlalu banyak salah → tunggu 15 menit.
- "Akun Anda belum ditautkan ke perusahaan": minta bengkel menautkan perusahaan Anda.
- Fleet manager tidak dibatasi jam kerja bengkel.

## Menu: Dasbor dan Armada saya

Dasbor (halaman pertama):
- Menunggu keputusan Anda: servis yang diusulkan bengkel dan belum diputuskan. Tinjau membuka pekerjaannya.
- Di bengkel: pekerjaan terbuka untuk kendaraan Anda (membuka Repair order).
- Belum dibayar: total sisa tagihan; merah bila ada yang lewat jatuh tempo (membuka Invoice).
- Servis jatuh tempo: kendaraan yang Terlambat atau Segera perlu servis berkala (membuka Jadwal servis). Hubungi bengkel untuk membuat janji.

Armada saya, dengan tab: Pelanggan, Kendaraan, Jadwal servis, Repair order, Invoice, Pembayaran, Servis ditunda. Bila akun ditautkan ke beberapa perusahaan, daftar bisa dicari atau disaring per perusahaan.
- Pelanggan: klik perusahaan untuk panelnya (penagihan, NPWP, termin, kontak, piutang; tab Kendaraan, Repair order, Keuangan).
- Kendaraan: klik kendaraan untuk data, odometer, pekerjaan, inspeksi dan jadwal servis berkala. Label merah Terlambat = servis berkala sudah lewat km atau tanggalnya.
- Jadwal servis: servis berkala semua kendaraan, yang terlambat paling atas.

## Pekerjaan dan invoice

- Setiap kunjungan adalah satu pekerjaan (nomor seperti #100004). Selama belum ditagih disebut estimasi (tab Repair order). Setelah ditagih menjadi invoice (nomor seperti INV-000002, tab Invoice).
- Halaman pekerjaan: atas (kendaraan, km masuk, keluhan, alur kerja); tab Servis (part, jasa, harga, status persetujuan); tab Keluhan dan Inspeksi (hijau Baik, kuning Segera, merah Sekarang); kanan (Persetujuan, janji, status order, pembayaran, total).
- Alur kerja: Estimasi → Dijadwalkan → Sudah datang → Dikerjakan → Menunggu part → Selesai → Di-invoice → Lunas.
- Invoice menampilkan nomor, jatuh tempo, no. faktur pajak (bila ada), pembayaran yang masuk dan sisa tagihan.
- Saat ini jasa (ongkos kerja) belum ditagihkan ke armada; setiap PT membayar part-nya sendiri lewat PO yang dicap PT itu.
- Data salah (odometer, keluhan, alamat, NPWP): minta bengkel memperbaikinya.

## Menyetujui, menunda atau menolak

Catatan: bengkel saat ini memakai persetujuan otomatis, jadi servis baru biasanya langsung Disetujui dan daftar "Menunggu keputusan Anda" kosong. Langkah di bawah berlaku bila ada servis berstatus Menunggu.

1. Dasbor → Menunggu keputusan Anda → Tinjau.
2. Periksa servis yang menunggu di tab Servis.
3. Kotak Persetujuan → Setujui / tunda / tolak (n).
4. Centang servis yang diputuskan (boleh sebagian dulu), pilih Setujui, Tunda atau Tolak.
5. Tulis Catatan untuk bengkel bila perlu (mis. nomor PO), lalu simpan.

- Setujui: bengkel mengerjakan dan menagihnya di invoice. Tunda: tidak sekarang, tidak ditagih, masuk Servis ditunda dan ditawarkan lagi di kunjungan berikutnya. Tolak: tidak dikerjakan, tidak ditagih.
- Keputusan tercatat atas nama Anda dengan cara "Online (Axle)"; bengkel langsung mendapat notifikasi.
- Keputusan tidak bisa diubah sendiri. Salah pilih: hubungi service advisor bengkel; mereka bisa mengubahnya atau mengembalikan ke Menunggu.
- Tombol tidak muncul bila semua servis sudah diputuskan, atau pekerjaan sudah menjadi invoice atau ditutup. Servis yang sudah selesai dikerjakan hanya bisa disetujui.

## Pembayaran dan servis ditunda

- Tab Pembayaran: pembayaran yang dicatat bengkel (tanggal, invoice, metode, referensi, jumlah).
- Sisa tagihan per invoice: tab Invoice dan halaman pekerjaan. Total piutang: panel perusahaan (tab Keuangan) dan kotak Belum dibayar di Dasbor.
- Tab Servis ditunda: servis yang ditunda; ingin dikerjakan sekarang → hubungi bengkel.

## Cetak dan unduh

- Estimasi atau invoice: halaman pekerjaan → Cetak → pilih Estimasi atau Invoice dan bahasanya → Cetak. Untuk PDF pilih "Simpan sebagai PDF" di jendela cetak browser.
- Riwayat servis: panel kendaraan → Riwayat servis. Semua kendaraan: panel perusahaan → Kendaraan + riwayat servis. Centang Tampilkan harga sesuai kebutuhan, lalu Cetak atau Unduh (CSV Excel).
- Daftar kendaraan: panel perusahaan → Daftar kendaraan.

## Tanya jawab

- **Tidak ada yang menunggu keputusan saya.** Normal saat ini: servis disetujui otomatis oleh bengkel.
- **Ingin membuat janji servis.** Hubungi bengkel; fleet manager tidak bisa membuat janji atau pekerjaan.
- **Kendaraan atau perusahaan kami tidak muncul.** Minta bengkel menautkan perusahaan itu ke akun Anda, atau memindahkan kendaraan ke perusahaan yang benar.
- **Rekan kerja perlu akses.** Minta bengkel mengundangnya sebagai fleet manager; jangan berbagi akun.
- **Kenapa tidak ada biaya jasa di invoice?** Saat ini jasa belum ditagihkan ke armada.
- **Status truk saya?** Lihat alur kerja di halaman pekerjaannya (Repair order).

## Tanya Claude (bantuan ini)

- Ikon gelembung percakapan di kanan atas. Hanya membaca dan memberi saran tentang data perusahaan Anda sendiri; tidak bisa mengubah apa pun.
- Pertanyaan dan jawaban dicatat dan bisa dilihat oleh bengkel. Ada batas pertanyaan per hari.
