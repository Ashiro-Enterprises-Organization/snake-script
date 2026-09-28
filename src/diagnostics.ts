/**
 * Snake Script — Diagnostics
 *
 * Sistem pelaporan error, warning, dan informasi.
 *
 * Setiap diagnostic memiliki:
 * - severity: error, warning, atau info
 * - code: kode unik (SSxxxx) untuk referensi dan pencarian
 * - message: pesan utama, satu baris
 * - location: posisi di source code
 * - notes: penjelasan tambahan (opsional)
 * - helps: saran perbaikan (opsional)
 *
 * Reporter mengubah diagnostic jadi teks berwarna untuk terminal,
 * teks polos untuk log file, atau JSON untuk konsumsi editor/LSP.
 */

// ============================================================
// Severity
// ============================================================

export type Severity = "error" | "warning" | "info" | "hint";

// ============================================================
// Location (re-export dari ast.ts untuk kenyamanan)
// ============================================================

export interface Position {
  readonly offset: number;
  readonly line: number;   // 1-based
  readonly column: number; // 1-based
}

export interface Location {
  readonly start: Position;
  readonly end: Position;
  readonly file: string;
}

// ============================================================
// Diagnostic
// ============================================================

export interface Diagnostic {
  readonly severity: Severity;
  readonly code: string;          // "SS1001"
  readonly message: string;       // "type mismatch"
  readonly location: Location;
  readonly notes?: readonly string[];
  readonly helps?: readonly string[];
}

// ============================================================
// Kode Error
// ============================================================
//
// Format: SSxxxx
//   SS1xxx — Semantik / tipe
//   SS2xxx — Sintaks / leksikal
//   SS3xxx — Keamanan (null, mutability)
//   SS4xxx — Runtime
//   SS5xxx — Modul
//   SS9xxx — Internal
//

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

  // --- Keamanan (3001-3099) ---
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

export type ErrorCodeValue = typeof ErrorCode[keyof typeof ErrorCode];

// ============================================================
// Diagnostic Factory
// ============================================================

export function makeDiagnostic(
  severity: Severity,
  code: string,
  message: string,
  location: Location,
  extras?: { notes?: readonly string[]; helps?: readonly string[] },
): Diagnostic {
  return {
    severity,
    code,
    message,
    location,
    notes: extras?.notes,
    helps: extras?.helps,
  };
}

export function error(
  code: string,
  message: string,
  location: Location,
  extras?: { notes?: readonly string[]; helps?: readonly string[] },
): Diagnostic {
  return makeDiagnostic("error", code, message, location, extras);
}

export function warning(
  code: string,
  message: string,
  location: Location,
  extras?: { notes?: readonly string[]; helps?: readonly string[] },
): Diagnostic {
  return makeDiagnostic("warning", code, message, location, extras);
}

export function info(
  code: string,
  message: string,
  location: Location,
  extras?: { notes?: readonly string[]; helps?: readonly string[] },
): Diagnostic {
  return makeDiagnostic("info", code, message, location, extras);
}

// ============================================================
// Warna ANSI
// ============================================================

/**
 * Kode ANSI untuk pewarnaan terminal.
 * Dipakai kalau output tidak di-pipe ke file dan `--no-color` tidak aktif.
 */
const ANSI = {
  reset:   "\x1b[0m",
  bold:    "\x1b[1m",
  dim:     "\x1b[2m",

  red:     "\x1b[31m",
  yellow:  "\x1b[33m",
  blue:    "\x1b[34m",
  cyan:    "\x1b[36m",
  gray:    "\x1b[90m",
  green:   "\x1b[32m",
} as const;

// ============================================================
// Reporter Options
// ============================================================

export interface ReporterOptions {
  readonly color: boolean;
  readonly format: "pretty" | "plain" | "json";
}

// ============================================================
// Source Cache
// ============================================================

/**
 * Cache isi file source. Reporter butuh ini untuk menampilkan
 * baris yang error.
 */
const sourceCache = new Map<string, string[]>();

export function loadSource(file: string, content: string): void {
  sourceCache.set(file, content.split(/\r?\n/));
}

export function getSourceLine(file: string, line: number): string | null {
  const lines = sourceCache.get(file);
  if (!lines) return null;
  return lines[line - 1] ?? null;
}

export function clearSourceCache(): void {
  sourceCache.clear();
}

// ============================================================
// Formatter — Pretty
// ============================================================

interface Colorizer {
  (text: string, ...codes: string[]): string;
}

function makeColorizer(enabled: boolean): Colorizer {
  if (!enabled) return (text: string) => text;
  return (text: string, ...codes: string[]) =>
    codes.join("") + text + ANSI.reset;
}

function formatSeverity(sev: Severity, c: Colorizer): string {
  switch (sev) {
    case "error":   return c("error", ANSI.bold, ANSI.red);
    case "warning": return c("warning", ANSI.bold, ANSI.yellow);
    case "info":    return c("info", ANSI.bold, ANSI.blue);
    case "hint":    return c("hint", ANSI.bold, ANSI.cyan);
  }
}

/**
 * Hitung lebar maksimum nomor baris yang akan ditampilkan.
 * Ini untuk alignment gutter — supaya `3 |` sejajar dengan `12 |`.
 */
function gutterWidth(line: number): number {
  return String(line).length;
}

/**
 * Buat string padding supaya semua baris sejajar.
 */
function pad(num: number, width: number): string {
  return String(num).padStart(width, " ");
}

/**
 * Format satu diagnostic jadi teks pretty.
 *
 * Contoh output:
 *
 *   error[SS1001]: type mismatch
 *     --> contoh.snake:3:18
 *      |
 *    3 | const x: Angka = "halo"
 *      |                  ^^^^^^ expected `Angka`, found `Teks`
 *      |
 *      = note: tipe literal `Teks` tidak dapat diberikan ke `Angka`
 *      = help: gunakan `Angka("...")` untuk konversi eksplisit
 */
function formatPretty(diag: Diagnostic, opts: ReporterOptions): string {
  const c = makeColorizer(opts.color);
  const lines: string[] = [];

  const sev = formatSeverity(diag.severity, c);
  const code = c(diag.code, ANSI.bold);
  lines.push(`${sev}[${code}]: ${diag.message}`);

  const { start, end, file } = diag.location;
  const locStr = `${file}:${start.line}:${start.column}`;
  lines.push(`  ${c("-->", ANSI.blue)} ${c(locStr, ANSI.dim)}`);

  // Gutter
  const lineNo = start.line;
  const gw = gutterWidth(lineNo);
  const gutter = c(" ".repeat(gw) + " |", ANSI.blue);
  const bar    = c(" ".repeat(gw) + " |", ANSI.blue);

  lines.push(gutter);

  const sourceLine = getSourceLine(file, lineNo);
  if (sourceLine !== null) {
    const src = c(sourceLine, ANSI.reset);
    lines.push(`${c(pad(lineNo, gw), ANSI.blue)} ${bar.slice(gw + 1)} ${src}`);

    // Garis panah
    // start.column dan end.column adalah 1-based
    // Untuk single-line diagnostic, hitung panjang caret
    const startCol = start.column;
    const endCol = start.line === end.line ? end.column : sourceLine.length + 1;
    const caretLen = Math.max(1, endCol - startCol);

    const arrowLine =
      " ".repeat(startCol - 1) +
      c("^".repeat(caretLen), ANSI.red, ANSI.bold);

    lines.push(`${" ".repeat(gw)} ${bar.slice(gw + 1)} ${arrowLine}`);
  }

  // Notes
  if (diag.notes && diag.notes.length > 0) {
    lines.push(`${" ".repeat(gw)} ${c("=", ANSI.blue)}`);
    for (const note of diag.notes) {
      lines.push(`${" ".repeat(gw)} ${c("=", ANSI.blue)} ${c("note:", ANSI.bold, ANSI.cyan)} ${note}`);
    }
  }

  // Helps
  if (diag.helps && diag.helps.length > 0) {
    for (const help of diag.helps) {
      lines.push(`${" ".repeat(gw)} ${c("=", ANSI.blue)} ${c("help:", ANSI.bold, ANSI.green)} ${help}`);
    }
  }

  return lines.join("\n");
}

// ============================================================
// Formatter — Plain
// ============================================================

/**
 * Format polos tanpa warna dan tanpa snippet. Untuk log file,
 * CI yang tidak mendukung ANSI, atau redirect ke file.
 */
function formatPlain(diag: Diagnostic): string {
  const { start, file } = diag.location;
  const loc = `${file}:${start.line}:${start.column}`;
  return `${diag.severity}[${diag.code}]: ${diag.message} (${loc})`;
}

// ============================================================
// Formatter — JSON
// ============================================================

/**
 * Format JSON untuk konsumsi editor/LSP/tooling.
 */
function formatJson(diag: Diagnostic): string {
  return JSON.stringify({
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
  });
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
  private readonly opts: ReporterOptions;

  constructor(opts: Partial<ReporterOptions> = {}) {
    this.opts = {
      color: opts.color ?? process.stdout.isTTY ?? false,
      format: opts.format ?? "pretty",
    };
  }

  /**
   * Tambah diagnostic ke daftar.
   */
  report(diag: Diagnostic): void {
    this.diagnostics.push(diag);
  }

  /**
   * Cek apakah ada error (bukan warning/info).
   */
  hasErrors(): boolean {
    return this.diagnostics.some((d) => d.severity === "error");
  }

  /**
   * Jumlah total diagnostic.
   */
  count(): number {
    return this.diagnostics.length;
  }

  /**
   * Ringkasan per severity.
   */
  summary(): ReportSummary {
    let errors = 0, warnings = 0, infos = 0, hints = 0;
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

  /**
   * Dapatkan semua diagnostic (readonly).
   */
  all(): readonly Diagnostic[] {
    return this.diagnostics;
  }

  /**
   * Bersihkan semua diagnostic.
   */
  clear(): void {
    this.diagnostics.length = 0;
  }

  /**
   * Format semua diagnostic ke string. Tidak print.
   */
  format(): string {
    if (this.diagnostics.length === 0) return "";

    switch (this.opts.format) {
      case "json": {
        const entries = this.diagnostics.map((d) => JSON.parse(formatJson(d)));
        return JSON.stringify(entries, null, 2);
      }
      case "plain":
        return this.diagnostics.map(formatPlain).join("\n");
      case "pretty":
        return this.diagnostics.map((d) => formatPretty(d, this.opts)).join("\n\n");
    }
  }

  /**
   * Print semua diagnostic ke stderr, plus ringkasan.
   * Return true kalau ada error (untuk exit code).
   */
  flush(): boolean {
    if (this.diagnostics.length === 0) return false;

    const output = this.format();
    process.stderr.write(output + "\n");

    const s = this.summary();
    const c = makeColorizer(this.opts.color);
    const parts: string[] = [];

    if (s.errors > 0)   parts.push(c(`${s.errors} error${s.errors > 1 ? "s" : ""}`, ANSI.red, ANSI.bold));
    if (s.warnings > 0) parts.push(c(`${s.warnings} warning${s.warnings > 1 ? "s" : ""}`, ANSI.yellow));
    if (s.infos > 0)    parts.push(c(`${s.infos} info`, ANSI.blue));
    if (s.hints > 0)    parts.push(c(`${s.hints} hint${s.hints > 1 ? "s" : ""}`, ANSI.cyan));

    if (parts.length > 0) {
      const total = s.errors + s.warnings + s.infos + s.hints;
      const prefix = s.errors > 0 ? "error:" : "warning:";
      const suffix = total === 1 ? "ditemukan" : "ditemukan";
      process.stderr.write(`${prefix} ${parts.join(", ")} ${suffix}\n`);
    }

    return s.errors > 0;
  }
}

// ============================================================
// Internal Error (untuk bug di compiler sendiri)
// ============================================================

/**
 * Exception yang dilempar saat ada invariant yang dilanggar
 * di kode compiler itu sendiri. Ini bug, bukan kesalahan user.
 */
export class InternalError extends Error {
  constructor(message: string, public readonly context?: string) {
    super(`[SS9001] Internal error: ${message}${context ? ` (${context})` : ""}`);
    this.name = "InternalError";
  }
}
