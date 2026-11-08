```typescript
/**
 * Snake Script — Advanced Diagnostics & Reporting Engine
 *
 * Sistem pelaporan error, warning, info, dan hint kelas produksi (setara Rustc / Ariadne):
 *
 * 1. Perbaikan Visualisasi & Penyelarasan Kolom:
 *    - Memperbaiki bug pemotongan string ANSI (`bar.slice(...)`) yang sebelumnya merusak
 *      escape code warna terminal.
 *    - Warna garis bawah caret (`^` / `~`) otomatis menyesuaikan tingkat `Severity`
 *      (merah untuk error, kuning untuk warning, biru untuk info, cyan untuk hint).
 *    - Ekspansi karakter tab (`\t`) yang presisi sehingga posisi caret selalu lurus dengan teks.
 *    - Mendukung rentang multi-baris (multi-line span) dan baris konteks sebelum/sesudah error.
 *
 * 2. Secondary Labels, Quick-Fix Patches, & Error Catalog (`--explain`):
 *    - Mendukung `labels` tambahan untuk menunjuk lokasi terkait (misal lokasi deklarasi awal).
 *    - Mendukung `fixes` (`CodeFix`) untuk saran perbaikan kode otomatis beserta pratinjau diff
 *      dan fungsi `applyCodeFixes()` untuk menerapkan patch langsung ke source code.
 *    - Dilengkapi katalog penjelasan kode error (`explainErrorCode("SS1001")`).
 *
 * 3. Multi-Format Output & Integrasi Tooling:
 *    - Mendukung format `"pretty"`, `"plain"`, `"compact"`, `"json"`, `"lsp"` (Language Server Protocol),
 *      dan `"sarif"` (GitHub Code Scanning / SARIF 2.1.0).
 *    - Deduplikasi otomatis untuk mencegah banjir pesan error identik saat panic recovery,
 *      serta opsi `warningsAsErrors`, `maxErrors`, dan `suppressedCodes`.
 */

// ============================================================
// Severity
// ============================================================

export type Severity = "error" | "warning" | "info" | "hint";

// ============================================================
// Location & Position
// ============================================================

export interface Position {
  readonly offset: number;
  readonly line: number;
  readonly column: number;
}

export interface Location {
  readonly start: Position;
  readonly end: Position;
  readonly file: string;
}

// ============================================================
// Secondary Label & Automated Code Fix
// ============================================================

export interface DiagnosticLabel {
  readonly location: Location;
  readonly message: string;
  readonly style?: "primary" | "secondary";
}

export interface CodeFix {
  readonly title: string;
  readonly location: Location;
  readonly replacement: string;
}

// ============================================================
// Diagnostic
// ============================================================

export interface Diagnostic {
  readonly severity: Severity;
  readonly code: string;
  readonly message: string;
  readonly location: Location;
  readonly notes?: readonly string[];
  readonly helps?: readonly string[];
  readonly labels?: readonly DiagnosticLabel[];
  readonly fixes?: readonly CodeFix[];
}

// ============================================================
// Kode Error (SS1xxx - SS9xxx)
// ============================================================

export const ErrorCode = {
  // --- Tipe (1001-1099) ---
  TYPE_MISMATCH:            "SS1001",
  UNDEFINED_VARIABLE:       "SS1002",
  UNDEFINED_FUNCTION:       "SS1003",
  INVALID_RETURN_TYPE:      "SS1004",
  ARGUMENT_COUNT_MISMATCH:  "SS1005",
  ARGUMENT_TYPE_MISMATCH:   "SS1006",
  NOT_CALLABLE:             "SS1007",
  INVALID_OPERATOR:         "SS1008",
  NOT_INDEXABLE:            "SS1009",
  MISSING_FIELD:            "SS1010",
  UNKNOWN_FIELD:            "SS1011",
  GENERIC_ARG_MISMATCH:     "SS1012",

  // --- Sintaks (2001-2099) ---
  UNEXPECTED_TOKEN:         "SS2001",
  INVALID_INDENT:           "SS2002",
  UNEXPECTED_EOF:           "SS2003",
  INVALID_NUMBER_LITERAL:   "SS2004",
  INVALID_STRING_LITERAL:   "SS2005",
  UNTERMINATED_STRING:      "SS2006",
  UNCLOSED_BRACKET:         "SS2007",
  INVALID_CHARACTER:        "SS2008",
  DUPLICATE_PARAMETER:      "SS2009",
  UNEXPECTED_DEDENT:        "SS2010",

  // --- Keamanan & Aliran Kontrol (3001-3099) ---
  NULLABLE_ACCESS:          "SS3001",
  IMMUTABLE_REASSIGN:       "SS3002",
  UNUSED_VARIABLE:          "SS3003",
  UNREACHABLE_CODE:         "SS3004",
  MISSING_RETURN:           "SS3005",
  SHADOWED_VARIABLE:        "SS3006",

  // --- Runtime (4001-4099) ---
  DIVISION_BY_ZERO:         "SS4001",
  INDEX_OUT_OF_BOUNDS:      "SS4002",
  KEY_NOT_FOUND:            "SS4003",
  FILE_NOT_FOUND:           "SS4004",
  STACK_OVERFLOW:           "SS4005",
  INVALID_CAST:             "SS4006",

  // --- Modul (5001-5099) ---
  MODULE_NOT_FOUND:         "SS5001",
  EXPORT_NOT_FOUND:         "SS5002",
  CIRCULAR_IMPORT:          "SS5003",
  DUPLICATE_EXPORT:         "SS5004",

  // --- Internal (9001+) ---
  INTERNAL_ERROR:           "SS9001",
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

// ============================================================
// Katalog Dokumentasi Kode Error (`explainErrorCode`)
// ============================================================

export interface ErrorExplanation {
  readonly code: ErrorCodeValue;
  readonly title: string;
  readonly category: "Tipe" | "Sintaks" | "Keamanan" | "Runtime" | "Modul" | "Internal";
  readonly description: string;
  readonly example?: string;
}

const ERROR_CATALOG: Readonly<Record<ErrorCodeValue, ErrorExplanation>> = {
  SS1001: {
    code: "SS1001",
    title: "Ketidakcocokan Tipe (Type Mismatch)",
    category: "Tipe",
    description:
      "Nilai yang diberikan tidak sesuai dengan tipe yang dideklarasikan atau diharapkan oleh ekspresi/fungsi.",
    example: 'let umur: Angka = "dua puluh" # Error SS1001: diharapkan Angka, dapat Teks',
  },
  SS1002: {
    code: "SS1002",
    title: "Variabel Tidak Terdefinisi",
    category: "Tipe",
    description:
      "Variabel diakses sebelum dideklarasikan dengan `let` atau `const`, atau berada di luar cakupan (scope).",
  },
  SS1003: {
    code: "SS1003",
    title: "Fungsi Tidak Terdefinisi",
    category: "Tipe",
    description: "Fungsi yang dipanggil belum dideklarasikan atau belum di-import.",
  },
  SS1004: {
    code: "SS1004",
    title: "Tipe Nilai Kembalian Tidak Valid",
    category: "Tipe",
    description: "Nilai yang dikembalikan oleh `return` tidak cocok dengan anotasi `-> Tipe` pada fungsi.",
  },
  SS1005: {
    code: "SS1005",
    title: "Jumlah Argumen Tidak Sesuai",
    category: "Tipe",
    description: "Jumlah argumen saat pemanggilan fungsi kurang dari parameter wajib atau melebihi batas parameter.",
  },
  SS1006: {
    code: "SS1006",
    title: "Tipe Argumen Tidak Sesuai",
    category: "Tipe",
    description: "Argumen yang dikirimkan ke fungsi tidak sesuai dengan tipe parameter yang dideklarasikan.",
  },
  SS1007: {
    code: "SS1007",
    title: "Nilai Tidak Dapat Dipanggil (Not Callable)",
    category: "Tipe",
    description: "Mencoba memanggil nilai non-fungsi (seperti Angka atau Teks) menggunakan tanda kurung `()`.",
  },
  SS1008: {
    code: "SS1008",
    title: "Operator Tidak Valid untuk Tipe Ini",
    category: "Tipe",
    description: "Operator digunakan pada tipe operand yang tidak mendukungnya (misal mengurangi Teks dengan Angka).",
  },
  SS1009: {
    code: "SS1009",
    title: "Tipe Tidak Dapat Diakses dengan Indeks",
    category: "Tipe",
    description: "Operator indeks `[i]` hanya dapat digunakan pada `Daftar`, `Peta`, atau `Teks`.",
  },
  SS1010: {
    code: "SS1010",
    title: "Field Wajib Tidak Ditemukan",
    category: "Tipe",
    description: "Map/Record tidak menyertakan field wajib yang ditentukan dalam deklarasi tipe.",
  },
  SS1011: {
    code: "SS1011",
    title: "Field atau Method Tidak Dikenal",
    category: "Tipe",
    description: "Properti atau method yang diakses dengan `.` tidak tersedia pada nilai tersebut.",
  },
  SS1012: {
    code: "SS1012",
    title: "Jumlah Argumen Generik Tidak Sesuai",
    category: "Tipe",
    description: "Jumlah parameter tipe di dalam `<...>` tidak sesuai dengan definisi tipe generik.",
  },
  SS2001: {
    code: "SS2001",
    title: "Token Tidak Terduga (Syntax Error)",
    category: "Sintaks",
    description: "Parser menemukan token yang tidak sesuai dengan aturan tata bahasa Snake Script.",
  },
  SS2002: {
    code: "SS2002",
    title: "Indentasi Tidak Valid",
    category: "Sintaks",
    description: "Indentasi menggunakan karakter tab atau jumlah spasi tidak sejajar dengan blok di atasnya.",
  },
  SS2003: {
    code: "SS2003",
    title: "Akhir File Tidak Terduga (Unexpected EOF)",
    category: "Sintaks",
    description: "File berakhir ketika parser masih mengharapkan lanjutan blok atau ekspresi.",
  },
  SS2004: {
    code: "SS2004",
    title: "Literal Angka Tidak Valid",
    category: "Sintaks",
    description: "Format penulisan angka desimal, biner (`0b`), oktal (`0o`), heksadesimal (`0x`), atau eksponen salah.",
  },
  SS2005: {
    code: "SS2005",
    title: "Literal String / Escape Sequence Tidak Valid",
    category: "Sintaks",
    description: "Terdapat karakter escape setelah `\\` yang tidak dikenal atau kode heksadesimal/Unicode rusak.",
  },
  SS2006: {
    code: "SS2006",
    title: "String Tidak Ditutup",
    category: "Sintaks",
    description: "Tanda kutip pembuka string atau kurung interpolasi `${...}` belum ditutup.",
  },
  SS2007: {
    code: "SS2007",
    title: "Kurung Tidak Ditutup atau Tidak Cocok",
    category: "Sintaks",
    description: "Kurung `(`, `[`, atau `{` tidak ditutup atau ditutup dengan jenis kurung yang berbeda.",
  },
  SS2008: {
    code: "SS2008",
    title: "Karakter atau Operator Tidak Dikenal",
    category: "Sintaks",
    description: "Karakter tidak menjadi bagian dari sintaks Snake Script (misal `;`, `&&`, `||`, `!`).",
  },
  SS2009: {
    code: "SS2009",
    title: "Parameter Duplikat",
    category: "Sintaks",
    description: "Terdapat dua parameter dengan nama yang sama dalam satu deklarasi fungsi.",
  },
  SS2010: {
    code: "SS2010",
    title: "Dedent Tidak Terduga",
    category: "Sintaks",
    description: "Level indentasi kembali ke luar tanpa kecocokan dengan blok induk mana pun.",
  },
  SS3001: {
    code: "SS3001",
    title: "Akses pada Nilai Nullable",
    category: "Keamanan",
    description: "Nilai bertipe opsional (`T?`) diakses tanpa pemeriksaan `null` terlebih dahulu.",
  },
  SS3002: {
    code: "SS3002",
    title: "Pengubahan Konstanta (`const`)",
    category: "Keamanan",
    description: "Variabel yang dideklarasikan dengan `const` tidak dapat diubah nilainya setelah inisialisasi.",
  },
  SS3003: {
    code: "SS3003",
    title: "Variabel Tidak Digunakan",
    category: "Keamanan",
    description: "Variabel dideklarasikan tetapi tidak pernah dibaca. Gunakan awalan `_` jika disengaja.",
  },
  SS3004: {
    code: "SS3004",
    title: "Kode Tidak Dapat Dijangkau (Unreachable Code)",
    category: "Keamanan",
    description: "Pernyataan berada setelah `return`, `break`, `continue`, atau `throw` pada blok yang sama.",
  },
  SS3005: {
    code: "SS3005",
    title: "Fungsi Tidak Mengembalikan Nilai di Semua Jalur",
    category: "Keamanan",
    description: "Fungsi yang memiliki tipe kembalian bukan `Kosong` memiliki cabang yang tidak berakhir dengan `return`.",
  },
  SS3006: {
    code: "SS3006",
    title: "Penutupan Variabel (Variable Shadowing)",
    category: "Keamanan",
    description: "Variabel lokal mendeklarasikan ulang nama yang sama dengan variabel di scope luar.",
  },
  SS4001: {
    code: "SS4001",
    title: "Pembagian atau Modulo dengan Nol",
    category: "Runtime",
    description: "Penyebut pada operasi pembagian (`/`) atau sisa bagi (`%`) bernilai `0`.",
  },
  SS4002: {
    code: "SS4002",
    title: "Indeks di Luar Batas (Index Out of Bounds)",
    category: "Runtime",
    description: "Indeks yang diakses kurang dari batas bawah atau melebihi panjang `Daftar`/`Teks`.",
  },
  SS4003: {
    code: "SS4003",
    title: "Key Tidak Ditemukan di Peta",
    category: "Runtime",
    description: "Mencoba membaca key yang belum terdaftar di dalam `Peta`.",
  },
  SS4004: {
    code: "SS4004",
    title: "File Tidak Ditemukan",
    category: "Runtime",
    description: "File sumber atau target I/O tidak ditemukan pada sistem berkas.",
  },
  SS4005: {
    code: "SS4005",
    title: "Melampaui Batas Rekursi (Stack Overflow)",
    category: "Runtime",
    description: "Kedalaman pemanggilan fungsi melampaui batas maksimum rekursi.",
  },
  SS4006: {
    code: "SS4006",
    title: "Konversi Tipe Tidak Valid",
    category: "Runtime",
    description: "Nilai tidak dapat dikonversi ke tipe tujuan (misal `Angka(\"abc\")`).",
  },
  SS5001: {
    code: "SS5001",
    title: "Modul Tidak Ditemukan",
    category: "Modul",
    description: "Nama atau path modul pada pernyataan `import ... from` tidak ditemukan.",
  },
  SS5002: {
    code: "SS5002",
    title: "Simbol Export Tidak Ditemukan",
    category: "Modul",
    description: "Simbol yang diminta pada `import { ... }` tidak di-export oleh modul tujuan.",
  },
  SS5003: {
    code: "SS5003",
    title: "Ketergantungan Modul Melingkar (Circular Import)",
    category: "Modul",
    description: "Dua atau lebih modul saling meng-import satu sama lain secara melingkar.",
  },
  SS5004: {
    code: "SS5004",
    title: "Duplikasi Export",
    category: "Modul",
    description: "Simbol dengan nama yang sama di-export lebih dari satu kali dalam satu modul.",
  },
  SS9001: {
    code: "SS9001",
    title: "Kesalahan Internal Kompiler/Interpreter",
    category: "Internal",
    description: "Terjadi kesalahan tak terduga di dalam mesin internal Snake Script.",
  },
};

export function explainErrorCode(code: string): ErrorExplanation | null {
  return ERROR_CATALOG[code as ErrorCodeValue] ?? null;
}

// ============================================================
// Diagnostic Factory & Fluent Builder
// ============================================================

export interface DiagnosticExtras {
  readonly notes?: readonly string[];
  readonly helps?: readonly string[];
  readonly labels?: readonly DiagnosticLabel[];
  readonly fixes?: readonly CodeFix[];
}

export function makeDiagnostic(
  severity: Severity,
  code: string,
  message: string,
  location: Location,
  extras?: DiagnosticExtras,
): Diagnostic {
  return {
    severity,
    code,
    message,
    location,
    notes: extras?.notes,
    helps: extras?.helps,
    labels: extras?.labels,
    fixes: extras?.fixes,
  };
}

export function error(
  code: string,
  message: string,
  location: Location,
  extras?: DiagnosticExtras,
): Diagnostic {
  return makeDiagnostic("error", code, message, location, extras);
}

export function warning(
  code: string,
  message: string,
  location: Location,
  extras?: DiagnosticExtras,
): Diagnostic {
  return makeDiagnostic("warning", code, message, location, extras);
}

export function info(
  code: string,
  message: string,
  location: Location,
  extras?: DiagnosticExtras,
): Diagnostic {
  return makeDiagnostic("info", code, message, location, extras);
}

export function hint(
  code: string,
  message: string,
  location: Location,
  extras?: DiagnosticExtras,
): Diagnostic {
  return makeDiagnostic("hint", code, message, location, extras);
}

/**
 * Fluent Builder untuk merangkai diagnostic yang kompleks secara bertahap.
 */
export class DiagnosticBuilder {
  private readonly notesList: string[] = [];
  private readonly helpsList: string[] = [];
  private readonly labelsList: DiagnosticLabel[] = [];
  private readonly fixesList: CodeFix[] = [];

  constructor(
    private readonly severity: Severity,
    private readonly code: string,
    private readonly message: string,
    private readonly location: Location,
    private readonly targetReporter?: Reporter,
  ) {}

  note(text: string): this {
    this.notesList.push(text);
    return this;
  }

  help(text: string): this {
    this.helpsList.push(text);
    return this;
  }

  label(
    location: Location,
    message: string,
    style: "primary" | "secondary" = "secondary",
  ): this {
    this.labelsList.push({ location, message, style });
    return this;
  }

  fix(title: string, location: Location, replacement: string): this {
    this.fixesList.push({ title, location, replacement });
    return this;
  }

  build(): Diagnostic {
    return {
      severity: this.severity,
      code: this.code,
      message: this.message,
      location: this.location,
      notes: this.notesList.length > 0 ? [...this.notesList] : undefined,
      helps: this.helpsList.length > 0 ? [...this.helpsList] : undefined,
      labels: this.labelsList.length > 0 ? [...this.labelsList] : undefined,
      fixes: this.fixesList.length > 0 ? [...this.fixesList] : undefined,
    };
  }

  emit(): Diagnostic {
    const diag = this.build();
    this.targetReporter?.report(diag);
    return diag;
  }
}

// ============================================================
// Otomasi Penerapan CodeFix
// ============================================================

/**
 * Menerapkan daftar `CodeFix` pada teks sumber secara aman (dari offset terbesar ke terkecil
 * agar perubahan panjang teks tidak menggeser offset patch berikutnya).
 */
export function applyCodeFixes(source: string, fixes: readonly CodeFix[]): string {
  if (fixes.length === 0) return source;
  const sorted = [...fixes].sort(
    (a, b) => b.location.start.offset - a.location.start.offset,
  );
  let result = source;
  let lastStart = Infinity;

  for (const fix of sorted) {
    const start = Math.max(0, fix.location.start.offset);
    const end = Math.min(result.length, fix.location.end.offset);
    // Abaikan fix yang tumpang tindih dengan fix yang sudah diterapkan
    if (end > lastStart) continue;
    result = result.slice(0, start) + fix.replacement + result.slice(end);
    lastStart = start;
  }
  return result;
}

// ============================================================
// Warna ANSI
// ============================================================

const ANSI = {
  reset:     "\x1b[0m",
  bold:      "\x1b[1m",
  dim:       "\x1b[2m",
  underline: "\x1b[4m",

  red:       "\x1b[31m",
  yellow:    "\x1b[33m",
  blue:      "\x1b[34m",
  magenta:   "\x1b[35m",
  cyan:      "\x1b[36m",
  gray:      "\x1b[90m",
  green:     "\x1b[32m",
} as const;

// ============================================================
// Reporter Options
// ============================================================

export type OutputFormat = "pretty" | "plain" | "compact" | "json" | "lsp" | "sarif";

export interface ReporterOptions {
  readonly color: boolean;
  readonly format: OutputFormat;
  /** Jumlah baris konteks di atas dan di bawah baris error pada mode `pretty`. Default: 1. */
  readonly contextLines?: number;
  /** Perlakukan semua `warning` sebagai `error`. Default: false. */
  readonly warningsAsErrors?: boolean;
  /** Cegah pelaporan diagnostic duplikat yang persis sama. Default: true. */
  readonly deduplicate?: boolean;
  /** Batas maksimum diagnostic yang disimpan. Default: 200. */
  readonly maxDiagnostics?: number;
  /** Daftar kode diagnostic yang ingin dibungkam (diabaikan). */
  readonly suppressedCodes?: ReadonlySet<string> | readonly string[];
  /** Fungsi output kustom saat `flush()` dipanggil (default: `process.stderr.write`). */
  readonly writer?: (text: string) => void;
}

// ============================================================
// Source Cache
// ============================================================

const sourceCache = new Map<string, string[]>();

export function loadSource(file: string, content: string): void {
  sourceCache.set(file, content.split(/\r\n|\r|\n/));
}

export function getSourceLine(file: string, line: number): string | null {
  const lines = sourceCache.get(file);
  if (!lines) return null;
  return lines[line - 1] ?? null;
}

export function getSourceLineCount(file: string): number {
  return sourceCache.get(file)?.length ?? 0;
}

export function clearSourceCache(): void {
  sourceCache.clear();
}

// ============================================================
// Formatter — Pretty (Rustc / Ariadne Style)
// ============================================================

interface Colorizer {
  (text: string, ...codes: string[]): string;
}

function makeColorizer(enabled: boolean): Colorizer {
  if (!enabled) return (text: string) => text;
  return (text: string, ...codes: string[]) =>
    codes.join("") + text + ANSI.reset;
}

function severityColor(sev: Severity): string {
  switch (sev) {
    case "error":   return ANSI.red;
    case "warning": return ANSI.yellow;
    case "info":    return ANSI.blue;
    case "hint":    return ANSI.cyan;
  }
}

function formatSeverity(sev: Severity, c: Colorizer): string {
  return c(sev, ANSI.bold, severityColor(sev));
}

function gutterWidth(maxLine: number): number {
  return Math.max(2, String(maxLine).length);
}

function pad(num: number | string, width: number): string {
  return String(num).padStart(width, " ");
}

/**
 * Mengonversi karakter `\t` menjadi spasi sekaligus menghitung ulang posisi kolom visual
 * agar garis bawah caret `^` selalu sejajar dengan karakter di layar.
 */
function expandTabsWithColumnMap(
  rawLine: string,
  tabWidth = 4,
): { visualLine: string; mapCol: (col1Based: number) => number } {
  let visual = "";
  const colOffsets: number[] = [1]; // 1-based index

  for (let i = 0; i < rawLine.length; i++) {
    const ch = rawLine[i]!;
    if (ch === "\t") {
      const spacesToAdd = tabWidth - (visual.length % tabWidth);
      visual += " ".repeat(spacesToAdd);
    } else {
      visual += ch;
    }
    colOffsets.push(visual.length + 1);
  }

  return {
    visualLine: visual,
    mapCol: (col1Based: number): number => {
      if (col1Based <= 1) return 1;
      if (col1Based - 1 < colOffsets.length) {
        return colOffsets[col1Based - 1]!;
      }
      return visual.length + (col1Based - rawLine.length);
    },
  };
}

function formatPretty(diag: Diagnostic, opts: ReporterOptions): string {
  const c = makeColorizer(opts.color);
  const sevColor = severityColor(diag.severity);
  const lines: string[] = [];

  // 1. Header: `error[SS1001]: pesan`
  const sev = formatSeverity(diag.severity, c);
  const code = c(diag.code, ANSI.bold, sevColor);
  lines.push(`${sev}[${code}]${c(":", ANSI.bold)} ${c(diag.message, ANSI.bold)}`);

  const { start, end, file } = diag.location;
  const maxLineNo = Math.max(
    start.line,
    end.line,
    ...(diag.labels?.map((l) => l.location.end.line) ?? [0]),
  );
  const gw = gutterWidth(maxLineNo + (opts.contextLines ?? 1));
  const emptyGutter = " ".repeat(gw);
  const pipe = c("|", ANSI.blue);

  // 2. Lokasi File: `  --> file.ss:baris:kolom`
  const locStr = `${file}:${start.line}:${start.column}`;
  lines.push(`${emptyGutter}${c("╭─[", ANSI.blue)} ${c(locStr, ANSI.cyan)} ${c("]", ANSI.blue)}`);

  const sourceLine = getSourceLine(file, start.line);
  const ctxCount = opts.contextLines ?? 1;

  if (sourceLine !== null) {
    lines.push(`${emptyGutter} ${pipe}`);

    // Baris konteks sebelum baris error
    for (let l = Math.max(1, start.line - ctxCount); l < start.line; l++) {
      const prevLine = getSourceLine(file, l);
      if (prevLine !== null) {
        const { visualLine } = expandTabsWithColumnMap(prevLine);
        lines.push(
          `${c(pad(l, gw), ANSI.dim)} ${pipe} ${c(visualLine, ANSI.dim)}`,
        );
      }
    }

    // Rentang satu baris vs multi-baris
    if (start.line === end.line || end.line <= start.line) {
      const { visualLine, mapCol } = expandTabsWithColumnMap(sourceLine);
      lines.push(`${c(pad(start.line, gw), ANSI.blue, ANSI.bold)} ${pipe} ${visualLine}`);

      const vStartCol = mapCol(start.column);
      const vEndCol = mapCol(Math.max(start.column + 1, end.column));
      const caretLen = Math.max(1, vEndCol - vStartCol);
      const caretChar = diag.severity === "error" ? "^" : "~";

      const arrowLine =
        " ".repeat(Math.max(0, vStartCol - 1)) +
        c(caretChar.repeat(caretLen), sevColor, ANSI.bold);

      lines.push(`${emptyGutter} ${pipe} ${arrowLine}`);
    } else {
      // Multi-line span (`start.line` s/d `end.line`)
      const maxSpanLines = 6;
      const spanEnd = Math.min(end.line, start.line + maxSpanLines - 1);

      for (let l = start.line; l <= spanEnd; l++) {
        const raw = getSourceLine(file, l) ?? "";
        const { visualLine, mapCol } = expandTabsWithColumnMap(raw);
        lines.push(`${c(pad(l, gw), ANSI.blue, ANSI.bold)} ${pipe} ${visualLine}`);

        if (l === start.line) {
          const vStart = mapCol(start.column);
          const len = Math.max(1, visualLine.length - vStart + 1);
          lines.push(
            `${emptyGutter} ${pipe} ${" ".repeat(Math.max(0, vStart - 1))}${c("^".repeat(len), sevColor, ANSI.bold)}`,
          );
        } else if (l === end.line) {
          const vEnd = mapCol(end.column);
          const len = Math.max(1, vEnd - 1);
          lines.push(
            `${emptyGutter} ${pipe} ${c("^".repeat(len), sevColor, ANSI.bold)}`,
          );
        }
      }

      if (end.line > spanEnd) {
        lines.push(
          `${c(pad("...", gw), ANSI.dim)} ${pipe} ${c(`(${end.line - spanEnd} baris lainnya)`, ANSI.dim)}`,
        );
      }
    }

    // Baris konteks sesudah baris error
    const afterStart = Math.max(start.line, end.line) + 1;
    for (let l = afterStart; l < afterStart + ctxCount; l++) {
      const nextLine = getSourceLine(file, l);
      if (nextLine !== null) {
        const { visualLine } = expandTabsWithColumnMap(nextLine);
        lines.push(
          `${c(pad(l, gw), ANSI.dim)} ${pipe} ${c(visualLine, ANSI.dim)}`,
        );
      }
    }
  }

  // 3. Secondary Labels (jika ada)
  if (diag.labels && diag.labels.length > 0) {
    for (const lbl of diag.labels) {
      const lblLine = getSourceLine(lbl.location.file, lbl.location.start.line);
      const lblColor = lbl.style === "primary" ? sevColor : ANSI.cyan;
      lines.push(`${emptyGutter} ${pipe}`);
      if (lblLine !== null) {
        const { visualLine, mapCol } = expandTabsWithColumnMap(lblLine);
        lines.push(
          `${c(pad(lbl.location.start.line, gw), ANSI.cyan)} ${pipe} ${visualLine}`,
        );
        const vStart = mapCol(lbl.location.start.column);
        const vEnd =
          lbl.location.start.line === lbl.location.end.line
            ? mapCol(Math.max(lbl.location.start.column + 1, lbl.location.end.column))
            : visualLine.length + 1;
        const len = Math.max(1, vEnd - vStart);
        lines.push(
          `${emptyGutter} ${pipe} ${" ".repeat(Math.max(0, vStart - 1))}${c("-".repeat(len), lblColor)} ${c(lbl.message, lblColor)}`,
        );
      } else {
        lines.push(
          `${emptyGutter} ${c("=", ANSI.blue)} ${c("lokasi terkait:", ANSI.cyan)} ${lbl.location.file}:${lbl.location.start.line}:${lbl.location.start.column} — ${lbl.message}`,
        );
      }
    }
  }

  // 4. Notes
  if (diag.notes && diag.notes.length > 0) {
    lines.push(`${emptyGutter} ${pipe}`);
    for (const note of diag.notes) {
      lines.push(
        `${emptyGutter} ${c("=", ANSI.blue)} ${c("catatan:", ANSI.bold, ANSI.cyan)} ${note}`,
      );
    }
  }

  // 5. Helps
  if (diag.helps && diag.helps.length > 0) {
    if (!diag.notes || diag.notes.length === 0) {
      lines.push(`${emptyGutter} ${pipe}`);
    }
    for (const help of diag.helps) {
      lines.push(
        `${emptyGutter} ${c("=", ANSI.blue)} ${c("saran:", ANSI.bold, ANSI.green)} ${help}`,
      );
    }
  }

  // 6. Quick Fixes (`CodeFix`)
  if (diag.fixes && diag.fixes.length > 0) {
    for (const fix of diag.fixes) {
      lines.push(
        `${emptyGutter} ${c("=", ANSI.blue)} ${c("perbaikan otomatis:", ANSI.bold, ANSI.green)} ${fix.title} -> \`${fix.replacement}\``,
      );
    }
  }

  lines.push(`${emptyGutter}${c("╰──", ANSI.blue)}`);
  return lines.join("\n");
}

// ============================================================
// Formatter — Plain & Compact
// ============================================================

function formatPlain(diag: Diagnostic): string {
  const { start, file } = diag.location;
  const loc = `${file}:${start.line}:${start.column}`;
  return `${diag.severity}[${diag.code}]: ${diag.message} (${loc})`;
}

function formatCompact(diag: Diagnostic): string {
  const { start, file } = diag.location;
  return `${file}:${start.line}:${start.column}: ${diag.severity}[${diag.code}]: ${diag.message}`;
}

// ============================================================
// Formatter — JSON, LSP, & SARIF
// ============================================================

function toJsonObject(diag: Diagnostic): Record<string, unknown> {
  return {
    severity: diag.severity,
    code: diag.code,
    message: diag.message,
    file: diag.location.file,
    range: {
      start: diag.location.start,
      end: diag.location.end,
    },
    notes: diag.notes ?? [],
    helps: diag.helps ?? [],
    labels: diag.labels ?? [],
    fixes: diag.fixes ?? [],
  };
}

/**
 * Konversi ke struktur standar Language Server Protocol (LSP 3.17).
 * Baris dan kolom pada LSP bersifat 0-indexed.
 */
export function toLspDiagnostic(diag: Diagnostic): Record<string, unknown> {
  const severityMap: Record<Severity, number> = {
    error: 1,
    warning: 2,
    info: 3,
    hint: 4,
  };
  return {
    range: {
      start: {
        line: Math.max(0, diag.location.start.line - 1),
        character: Math.max(0, diag.location.start.column - 1),
      },
      end: {
        line: Math.max(0, diag.location.end.line - 1),
        character: Math.max(0, diag.location.end.column - 1),
      },
    },
    severity: severityMap[diag.severity],
    code: diag.code,
    source: "snake-script",
    message: [
      diag.message,
      ...(diag.notes?.map((n) => `Catatan: ${n}`) ?? []),
      ...(diag.helps?.map((h) => `Saran: ${h}`) ?? []),
    ].join("\n"),
  };
}

function formatSarif(diagnostics: readonly Diagnostic[]): string {
  const sarifLevel: Record<Severity, string> = {
    error: "error",
    warning: "warning",
    info: "note",
    hint: "note",
  };

  const payload = {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "Snake Script Compiler",
            informationUri: "https://snakescript.dev",
            rules: Object.values(ERROR_CATALOG).map((r) => ({
              id: r.code,
              name: r.title,
              shortDescription: { text: r.title },
              fullDescription: { text: r.description },
            })),
          },
        },
        results: diagnostics.map((d) => ({
          ruleId: d.code,
          level: sarifLevel[d.severity],
          message: { text: d.message },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: d.location.file },
                region: {
                  startLine: d.location.start.line,
                  startColumn: d.location.start.column,
                  endLine: d.location.end.line,
                  endColumn: Math.max(d.location.start.column + 1, d.location.end.column),
                },
              },
            },
          ],
        })),
      },
    ],
  };

  return JSON.stringify(payload, null, 2);
}

// ============================================================
// Reporter
// ============================================================

export interface ReportSummary {
  readonly errors: number;
  readonly warnings: number;
  readonly infos: number;
  readonly hints: number;
}

export class Reporter {
  private readonly diagnostics: Diagnostic[] = [];
  private readonly seenKeys = new Set<string>();
  private readonly suppressed: Set<string>;
  private readonly opts: Required<
    Pick<
      ReporterOptions,
      "color" | "format" | "contextLines" | "warningsAsErrors" | "deduplicate" | "maxDiagnostics"
    >
  > & { readonly writer: (text: string) => void };

  constructor(opts: Partial<ReporterOptions> = {}) {
    const isTty =
      typeof process !== "undefined" &&
      Boolean(process.stdout?.isTTY || process.stderr?.isTTY);

    this.suppressed = new Set(opts.suppressedCodes ?? []);
    this.opts = {
      color: opts.color ?? isTty,
      format: opts.format ?? "pretty",
      contextLines: opts.contextLines ?? 0,
      warningsAsErrors: opts.warningsAsErrors ?? false,
      deduplicate: opts.deduplicate ?? true,
      maxDiagnostics: opts.maxDiagnostics ?? 200,
      writer:
        opts.writer ??
        ((text: string) => {
          if (typeof process !== "undefined" && process.stderr) {
            process.stderr.write(text);
          } else {
            console.error(text.trimEnd());
          }
        }),
    };
  }

  /**
   * Membuat `DiagnosticBuilder` yang terhubung langsung dengan reporter ini.
   */
  build(
    severity: Severity,
    code: string,
    message: string,
    location: Location,
  ): DiagnosticBuilder {
    return new DiagnosticBuilder(severity, code, message, location, this);
  }

  report(diag: Diagnostic): void {
    if (this.suppressed.has(diag.code)) return;
    if (this.diagnostics.length >= this.opts.maxDiagnostics) return;

    const normalized: Diagnostic =
      this.opts.warningsAsErrors && diag.severity === "warning"
        ? { ...diag, severity: "error" }
        : diag;

    if (this.opts.deduplicate) {
      const key = `${normalized.severity}:${normalized.code}:${normalized.location.file}:${normalized.location.start.line}:${normalized.location.start.column}:${normalized.message}`;
      if (this.seenKeys.has(key)) return;
      this.seenKeys.add(key);
    }

    this.diagnostics.push(normalized);
  }

  hasErrors(): boolean {
    return this.diagnostics.some((d) => d.severity === "error");
  }

  hasWarnings(): boolean {
    return this.diagnostics.some((d) => d.severity === "warning");
  }

  count(): number {
    return this.diagnostics.length;
  }

  summary(): ReportSummary {
    let errors = 0;
    let warnings = 0;
    let infos = 0;
    let hints = 0;
    for (const d of this.diagnostics) {
      switch (d.severity) {
        case "error":   errors++; break;
        case "warning": warnings++; break;
        case "info":    infos++; break;
        case "hint":    hints++; break;
      }
    }
    return { errors, warnings, infos, hints };
  }

  all(): readonly Diagnostic[] {
    return this.diagnostics;
  }

  errors(): readonly Diagnostic[] {
    return this.diagnostics.filter((d) => d.severity === "error");
  }

  warnings(): readonly Diagnostic[] {
    return this.diagnostics.filter((d) => d.severity === "warning");
  }

  forFile(file: string): readonly Diagnostic[] {
    return this.diagnostics.filter((d) => d.location.file === file);
  }

  merge(other: Reporter): void {
    for (const d of other.all()) {
      this.report(d);
    }
  }

  clear(): void {
    this.diagnostics.length = 0;
    this.seenKeys.clear();
  }

  /**
   * Mengurutkan diagnostic berdasarkan file, nomor baris, lalu kolom.
   */
  sort(): void {
    this.diagnostics.sort((a, b) => {
      if (a.location.file !== b.location.file) {
        return a.location.file.localeCompare(b.location.file);
      }
      if (a.location.start.line !== b.location.start.line) {
        return a.location.start.line - b.location.start.line;
      }
      return a.location.start.column - b.location.start.column;
    });
  }

  format(): string {
    if (this.diagnostics.length === 0) return "";

    switch (this.opts.format) {
      case "json":
        return JSON.stringify(this.diagnostics.map(toJsonObject), null, 2);
      case "lsp":
        return JSON.stringify(this.diagnostics.map(toLspDiagnostic), null, 2);
      case "sarif":
        return formatSarif(this.diagnostics);
      case "plain":
        return this.diagnostics.map(formatPlain).join("\n");
      case "compact":
        return this.diagnostics.map(formatCompact).join("\n");
      case "pretty":
        return this.diagnostics
          .map((d) => formatPretty(d, this.opts))
          .join("\n\n");
    }
  }

  flush(): boolean {
    if (this.diagnostics.length === 0) return false;

    const output = this.format();
    this.opts.writer(output + "\n");

    if (
      this.opts.format !== "json" &&
      this.opts.format !== "lsp" &&
      this.opts.format !== "sarif"
    ) {
      const s = this.summary();
      const c = makeColorizer(this.opts.color);
      const parts: string[] = [];

      if (s.errors > 0) {
        parts.push(c(`${s.errors} error`, ANSI.red, ANSI.bold));
      }
      if (s.warnings > 0) {
        parts.push(c(`${s.warnings} warning`, ANSI.yellow, ANSI.bold));
      }
      if (s.infos > 0) {
        parts.push(c(`${s.infos} info`, ANSI.blue));
      }
      if (s.hints > 0) {
        parts.push(c(`${s.hints} hint`, ANSI.cyan));
      }

      if (parts.length > 0) {
        const prefix = s.errors > 0 ? c("kesalahan:", ANSI.red, ANSI.bold) : c("peringatan:", ANSI.yellow, ANSI.bold);
        this.opts.writer(`${prefix} ${parts.join(", ")} ditemukan\n`);
      }
    }

    return this.hasErrors();
  }
}

// ============================================================
// Internal Error
// ============================================================

export class InternalError extends Error {
  readonly context?: string;

  constructor(message: string, context?: string) {
    super(`[SS9001] Internal error: ${message}${context ? ` (${context})` : ""}`);
    this.name = "InternalError";
    this.context = context;
  }
}
```
