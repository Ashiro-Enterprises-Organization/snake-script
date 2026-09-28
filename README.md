# Snake Script

> Kemudahan Python. Keamanan TypeScript. Kurva belajar tajam, hasil rapi.

Snake Script adalah bahasa pemrograman dengan sintaks yang mudah dibaca
seperti Python, tetapi memiliki sistem tipe statis yang ketat seperti
TypeScript. Dirancang untuk kode yang tetap jelas dibaca enam bulan
kemudian.

**Status:** Pre-alpha. Spesifikasi sedang disusun.

---

## Filosofi

**Jelas lebih baik daripada pintar.**
Kode ditulis sekali, dibaca berkali-kali. Sintaks yang bisa ditebak
lebih berharga daripada sintaks yang ringkas.

**Aman secara default.**
Nilai nullable harus eksplisit. Variabel bersifat immutable kecuali
dinyatakan sebaliknya. Tidak ada `undefined` yang muncul diam-diam.

**Sulit di awal, mudah di akhir.**
Compiler yang ketat memang merepotkan di menit pertama, tetapi
menghemat berjam-jam di bulan pertama.

**Satu cara yang benar.**
Hindari lima sintaks berbeda untuk operasi yang sama. Konsistensi
mengalahkan fleksibilitas.

**Error adalah percakapan.**
Pesan error harus menjelaskan apa yang salah, di mana, kenapa, dan
bagaimana memperbaikinya.

---

## Contoh

```snake
# Variabel immutable secara default
const nama: Teks = "dunia"

# Variabel mutable harus dinyatakan eksplisit
let hitungan: Angka = 0

# Fungsi dengan tipe parameter dan return yang jelas
fn faktorial(n: Angka) -> Angka:
    if n <= 1:
        return 1
    return n * faktorial(n - 1)

# Tipe nullable harus eksplisit
fn sapa(user: Teks, umur: Angka?) -> Teks:
    if umur != null:
        return "Halo ${user}, ${umur} tahun"
    return "Halo ${user}"

print(sapa(nama, null))       # Halo dunia
print(faktorial(5))           # 120
```

Type checker akan menolak ini sebelum program berjalan:

```snake
const x: Angka = "halo"
```

```
error[SS1001]: type mismatch
  --> contoh.snake:1:18
   |
 1 | const x: Angka = "halo"
   |                  ^^^^^^ expected `Angka`, found `Teks`
   |
   = help: gunakan `Angka("...")` untuk konversi eksplisit
```

---

Fitur

· Sistem tipe statis dengan inference, generics, dan union types
· Nullable eksplisit — tidak ada null yang lolos tanpa disadari
· Immutable by default — const dan let sebagai keyword
· Error handling dengan try / catch / finally
· Pattern matching dengan match
· Modul dengan import dan export
· Interpreter tree-walking untuk eksekusi cepat
· CLI profesional dengan output JSON, watch mode, dan error ala Rust

---

Instalasi

Belum tersedia di registry manapun. Tahap pengembangan.

```bash
git clone https://github.com/<user>/snake-script.git
cd snake-script
npm install
npm run build
npm link
```

Setelah terpasang:

```bash
snake run halo.snake
snake check halo.snake
snake repl
```

---

Dokumentasi

· Spesifikasi Bahasa — aturan normatif bahasa
· Grammar Formal — grammar dalam EBNF
· Roadmap — rencana versi
· Kontribusi — cara ikut mengembangkan

---

Struktur Proyek

```
src/
  lexer.ts         source    -> token
  parser.ts        token     -> AST
  ast.ts           definisi node AST
  analyzer.ts      AST       -> AST bertipe + diagnostik
  interpreter.ts   AST       -> eksekusi
  diagnostics.ts   sistem error dan reporter
  cli.ts           entry point CLI
stdlib/
  prelude.snake    fungsi bawaan
examples/
  *.snake          contoh program
tests/
  *.test.ts        unit test
docs/
  SPEC.md          spesifikasi bahasa
  GRAMMAR.ebnf     grammar formal
```

---

Roadmap Singkat

Versi Target
0.1.0 Lexer, parser, AST, REPL dasar
0.2.0 Type checker, sistem diagnostik
0.3.0 Interpreter lengkap, stdlib awal
0.4.0 Modul, error handling, pattern matching
0.5.0 CLI stabil, formatter, linter
1.0.0 Spesifikasi beku, stabil untuk produksi

---

Kontribusi

Kontribusi terbuka untuk siapa saja. Baca CONTRIBUTING.md
sebelum membuka pull request.

Area yang sedang aktif dikerjakan:

· Perancangan spesifikasi bahasa
· Implementasi lexer dan parser
· Penyusunan test suite

---

Lisensi

MIT. Lihat LICENSE.
