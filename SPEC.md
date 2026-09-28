# Snake Script — Spesifikasi Bahasa

Version: 0.1.0
Status: Draft
Last updated: 2025

Dokumen ini adalah spesifikasi normatif bahasa Snake Script.
Setiap implementasi (interpreter, compiler, analyzer) harus
mengikuti aturan di sini.

---

## 1. Gambaran Umum

Snake Script adalah bahasa pemrograman dengan sintaks indentation-based
seperti Python, dan sistem tipe statis yang ketat seperti TypeScript.

Prinsip desain:

- Sintaks readable tanpa simbol berlebihan
- Tipe statis, nullable eksplisit
- Immutable by default
- Satu cara benar untuk setiap operasi

Source code Snake Script disimpan dalam file berekstensi `.snake`,
dikodekan UTF-8.

---

## 2. Struktur Leksikal

### 2.1 Whitespace dan Indentasi

Snake Script menggunakan indentasi sebagai penanda blok, sama seperti Python.

- Satu level indentasi = 4 spasi
- Tab tidak diperbolehkan
- Indentasi harus konsisten dalam satu blok

Baris kosong diabaikan untuk keperluan indentasi.

### 2.2 Komentar

Komentar satu baris dimulai dengan `#` sampai akhir baris.

```snake
# ini komentar
const x = 10   # komentar di akhir baris
```

Tidak ada komentar blok. Untuk menonaktifkan banyak baris,
gunakan string literal yang tidak digunakan atau hapus saja.

2.3 Identifier

Identifier dimulai dengan huruf atau _, diikuti huruf, angka, atau _.

Regex: [A-Za-z_][A-Za-z0-9_]*

Konvensi penamaan:

· camelCase untuk variabel dan fungsi
· PascalCase untuk tipe
· SCREAMING_SNAKE_CASE untuk konstanta global

Konvensi ini tidak dipaksa oleh compiler, hanya gaya penulisan.

2.4 Keyword

Daftar lengkap keyword yang tidak boleh dipakai sebagai identifier:

```
const    let      fn       return
if       else     elif     while
for      in       break    continue
type     match    case     try
catch    finally  throw    import
export   from     as       and
or       not      true     false
null     Kosong
```

Keyword bersifat case-sensitive.

2.5 Literal

Angka

```snake
42          # integer
3.14        # float
1_000_000   # pemisah visual
0xFF        # heksadesimal
0b1010      # biner
0o755       # oktal
1e6         # notasi ilmiah
```

Teks

```snake
"halo"
'halo'
"baris satu\nbaris dua"
```

Tidak ada multi-line string untuk saat ini.

String interpolation

Gunakan ${...} di dalam string.

```snake
const nama = "dunia"
print("Halo ${nama}")   # Halo dunia
```

Boolean

```snake
true
false
```

Null

```snake
null
```

2.6 Operator dan Tanda Baca

Aritmatika: + - * / % **

Perbandingan: == != < <= > >=

Logika: and or not (keyword, bukan simbol)

Assignment: = += -= *= /= %=

Panah: -> (untuk return type fungsi)

Tanda baca: ( ) [ ] { } , : . ? |

---

3. Sistem Tipe

3.1 Tipe Primitif

Nama Deskripsi Contoh
Angka Bilangan bulat atau desimal (64-bit) 42, 3.14
Teks String Unicode "halo"
Boolean Benar atau salah true, false
Null Tipe dari nilai null null
Kosong Tipe kosong, untuk fungsi tanpa return —

3.2 Tipe Komposit

Daftar (List)

```snake
const angka: Daftar<Angka> = [1, 2, 3]
const nama: Daftar<Teks> = ["a", "b"]
```

Peta (Map)

```snake
const umur: Peta<Teks, Angka> = {
    "budi": 20,
    "siti": 22,
}
```

Tipe Fungsi

```snake
const f: (Angka, Angka) -> Angka = fn(a, b) => a + b
```

3.3 Tipe Nullable

Nilai yang bisa null harus ditandai dengan ?.

```snake
const nama: Teks? = null       # valid
const umur: Angka? = 20        # valid
const alamat: Teks = null      # ERROR: null tidak boleh tanpa ?
```

Sebelum mengakses nilai nullable, wajib dicek:

```snake
if nama != null:
    print(nama.length)   # aman, di-narrow oleh type checker
```

3.4 Union Type

```snake
const hasil: Angka | Teks = 42
```

Type checker mempersempit tipe secara otomatis berdasarkan konteks.

3.5 Type Alias

```snake
type UserId = Angka
type Hasil = Sukses | Gagal

type User = {
    id: Angka
    nama: Teks
    umur: Angka?
}
```

3.6 Type Inference

Tipe variabel dapat di-infer dari nilai inisialisasi.

```snake
const x = 42           # x bertipe Angka
const nama = "halo"    # nama bertipe Teks
```

Namun untuk function parameter, tipe wajib ditulis eksplisit.

3.7 Aturan Kompatibilitas

· Angka dan Teks tidak bisa dioperasikan tanpa konversi eksplisit
· null hanya bisa diberikan ke tipe nullable (T?)
· Daftar<T> invariant: Daftar<Angka> tidak kompatibel dengan Daftar<Teks>
· Tidak ada implicit casting

---

4. Deklarasi

4.1 Variabel

```snake
const x: Angka = 10       # immutable
let y: Angka = 20         # mutable

y = 30                    # valid
x = 15                    # ERROR: x immutable
```

const tanpa nilai awal harus disertai tipe:

```snake
const x: Angka            # deklarasi saja, belum diinisialisasi
x = 10                    # masih dianggap const, hanya boleh sekali
```

4.2 Fungsi

```snake
fn tambah(a: Angka, b: Angka) -> Angka:
    return a + b
```

Fungsi tanpa return type eksplisit dianggap Kosong:

```snake
fn sapa(nama: Teks):
    print("Halo ${nama}")
```

Fungsi sebagai ekspresi (arrow):

```snake
const kali = fn(a: Angka, b: Angka) -> Angka => a * b
```

4.3 Parameter Default

```snake
fn sapa(nama: Teks = "dunia") -> Teks:
    return "Halo ${nama}"
```

Parameter dengan default tidak boleh diikuti parameter wajib.

---

5. Ekspresi

5.1 Aritmatika

```snake
1 + 2          # 3
5 - 3          # 2
4 * 2          # 8
10 / 3         # 3.333...
10 % 3         # 1
2 ** 8         # 256
```

Operator / selalu menghasilkan Angka (desimal jika perlu).
Tidak ada pembagian integer terpisah.

5.2 Perbandingan

```snake
1 == 1         # true
1 != 2         # true
3 > 2          # true
```

Perbandingan == bersifat struktural untuk Daftar dan Peta.

5.3 Logika

```snake
true and false    # false
true or false     # true
not true          # false
```

Short-circuit: and dan or berhenti evaluasi jika hasil sudah pasti.

5.4 String Interpolation

```snake
const nama = "dunia"
print("Halo ${nama}!")          # Halo dunia!
print("2 + 2 = ${2 + 2}")       # 2 + 2 = 4
```

Ekspresi di dalam ${...} dievaluasi lalu dikonversi ke Teks.

5.5 Akses Anggota dan Index

```snake
const nama = "dunia"
nama.length         # 5

const angka = [1, 2, 3]
angka[0]            # 1

const umur = { "budi": 20 }
umur["budi"]        # 20
```

---

6. Statement

6.1 If / Elif / Else

```snake
if x > 0:
    print("positif")
elif x < 0:
    print("negatif")
else:
    print("nol")
```

Kondisi harus bertipe Boolean. Tidak ada truthy/falsy.

6.2 While

```snake
let i = 0
while i < 10:
    print(i)
    i += 1
```

6.3 For

```snake
for x in [1, 2, 3]:
    print(x)

for i in 0..10:
    print(i)         # 0 sampai 9
```

6.4 Return

```snake
fn cari(x: Angka, list: Daftar<Angka>) -> Angka?:
    for item in list:
        if item == x:
            return item
    return null
```

6.5 Break dan Continue

```snake
for x in [1, 2, 3, 4]:
    if x == 3:
        break
    if x == 2:
        continue
    print(x)
```

6.6 Match

```snake
match nilai:
    case 0:
        print("nol")
    case 1 | 2:
        print("satu atau dua")
    case n if n > 10:
        print("besar")
    else:
        print("lainnya")
```

6.7 Try / Catch / Finally

```snake
try:
    const data = bacaFile("data.txt")
    print(data)
catch err:
    print("Gagal: ${err.message}")
finally:
    print("Selesai")
```

err di dalam catch bertipe Error (bukan any).
Akses properti harus lewat field yang didefinisikan.

---

7. Modul

7.1 Export

```snake
export const PI = 3.14159

export fn luas(r: Angka) -> Angka:
    return PI * r * r
```

7.2 Import

```snake
import { PI, luas } from "matematika"
import * as mat from "matematika"
import matematika from "matematika"
```

Nama modul menggunakan string path relatif atau nama paket.

---

8. Error Model

Snake Script membedakan tiga jenis error:

Compile-time error

Dilaporkan sebelum program berjalan. Contoh: tipe tidak cocok,
variabel tidak ditemukan, return type salah.

Setiap error memiliki kode unik dengan format SSxxxx.

Kode Kategori
SS1001 Type mismatch
SS1002 Undefined variable
SS1003 Undefined function
SS1004 Invalid return type
SS2001 Syntax error — unexpected token
SS2002 Syntax error — invalid indent
SS3001 Nullable access without check
SS3002 Immutable reassignment

Runtime error

Terjadi saat eksekusi. Contoh: pembagian dengan nol, index di luar
batas, file tidak ditemukan.

User error

Dilempar oleh program melalui throw. Bertipe Error.

---

9. Grammar Formal

Grammar lengkap dalam notasi EBNF tersedia di docs/GRAMMAR.ebnf.

---

10. Kompatibilitas Versi

Spesifikasi ini mengikuti semantic versioning:

· 0.x — tidak stabil, breaking change diizinkan
· 1.0+ — stabil, breaking change hanya di major version

Setiap perubahan spesifikasi dicatat di CHANGELOG.md.

---

11. Keputusan Desain (Non-Normatif)

Bagian ini menjelaskan alasan di balik pilihan desain.

Kenapa indentation-based?
Lebih sedikit noise visual. Konsisten dengan Python yang sudah terbukti
mudah dibaca untuk pemula.

Kenapa and/or/not bukan &&/||/!?
Kata lebih mudah dibaca dalam bahasa natural. Simbol && sering
tertukar dengan & (bitwise).

Kenapa const dan let bukan var?
Memaksa programmer memilih antara immutable dan mutable. Tidak ada
default implisit.

Kenapa nullable harus eksplisit?
Menghilangkan seluruh kelas bug yang berasal dari null tak terduga.
Ini alasan TypeScript diciptakan.

Kenapa tipe statis tapi tanpa annotation berlebihan?
Type inference mengambil alih kasus-kasus jelas. Annotation hanya
wajib di boundary (parameter, return type publik).

```

### Keputusan desain yang aku ambil

Beberapa hal yang mungkin kamu tidak setuju, tapi aku harus memilih supaya spec konkret:

**1. Keyword bahasa Inggris, tipe bahasa Indonesia**

Konsisten dengan README yang sudah kamu setujui. `fn`, `const`, `let`, `if`, `for` dalam bahasa Inggris karena programmer sudah familiar. Tipe `Angka`, `Teks`, `Kosong` dalam bahasa Indonesia sebagai brand identity.

**2. Operator logika pakai kata: `and`/`or`/`not`**

Bukan `&&`/`||`/`!`. Alasan: lebih mudah dibaca, konsisten dengan filosofi "jelas lebih baik daripada pintar".

**3. Indentasi 4 spasi, tab dilarang**

Sama seperti Python. Tab dilarang keras untuk mencegah mixing.

**4. `const` dan `let`, bukan `tetap` dan `ubah`**

Karena keyword bahasa Inggris, konsisten. Meskipun `tetap`/`ubah` akan lebih "Indonesia". Kalau kamu mau ganti, tinggal cari-replace di spec.

**5. Tidak ada truthy/falsy**

Kondisi `if` **wajib** `Boolean`. Tidak boleh `if []:` atau `if 0:`. Ini yang membuat bahasa aman.

**6. `/` selalu menghasilkan `Angka`**

Tidak ada pembagian integer terpisah seperti Python (`//`). Kalau butuh integer, gunakan `floor()`.

**7. Error code `SSxxxx`**

Format unik untuk setiap error. Memudahkan search di Google dan dokumentasi.

**8. `Daftar<T>` invariant**

Bukan covariant seperti Java array. Lebih aman, konsisten dengan TS.

### Yang sengaja **bbelum* diputuskan

- **Generics** di fungsi (`fn map<T>(...)`) — nanti di 0.2
- **Interface** dan **trait** — nanti di 0.3
- **Async/await** — nanti di 0.4
- **Pattern matching lengkap** dengan destructuring
- **Macro atau metaprogramming**

Semua ini ditunda supaya MVP tidak overload.
