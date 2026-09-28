/**
 * Snake Script — Lexer (Advanced)
 *
 * Mengubah source code menjadi TokenStream yang siap dikonsumsi parser.
 *
 * Arsitektur:
 *
 *   Source string
 *        │
 *        ▼
 *   ┌─────────────┐
 *   │  SourceMap  │   precompute posisi baris → lookup O(log n)
 *   └─────────────┘
 *        │
 *        ▼
 *   ┌─────────────┐
 *   │   Lexer     │   state machine: line-start, in-bracket, in-string
 *   └─────────────┘
 *        │
 *        ▼
 *   ┌─────────────┐
 *   │ TokenStream │   peek/lookahead/mark/reset untuk parser
 *   └─────────────┘
 *
 * Fitur:
 * - Indentasi otomatis (INDENT/DEDENT) dengan deteksi konsistensi
 * - NEWLINE di-skip di dalam bracket ( ) [ ] { }
 * - String interpolation ${...} dengan nested brace tracking
 * - Raw string r"..." tanpa escape processing
 * - Multi-line string """..."""
 * - Doc comment ## untuk dokumentasi
 * - Error recovery: lanjut lexing setelah error, laporkan banyak error
 * - Trivia preservation untuk formatter (opsional)
 */

import type { Location, Position } from "./ast.ts";
import type { Reporter } from "./diagnostics.ts";
import { ErrorCode } from "./diagnostics.ts";

// ============================================================
// SourceMap — Lookup Posisi Berkecepatan Tinggi
// ============================================================

/**
 * Memetakan offset byte ke (line, column) dengan binary search.
 *
 * Kenapa tidak track kolom secara incremental?
 * - Lebih lambat: setiap `advance()` butuh update line/col
 * - Lebih rawan bug: newline handling di berbagai konteks
 * - Binary search O(log n) sangat cepat untuk file normal (< 100k baris)
 *
 * Ini pendekatan yang sama dipakai rustc, esbuild, dan swc.
 */
export class SourceMap {
  /** Offset awal setiap baris. `lineStarts[0]` selalu 0. */
  private readonly lineStarts: number[] = [0];

  constructor(public readonly source: string) {
    // Precompute semua line start — sekali jalan O(n)
    for (let i = 0; i < source.length; i++) {
      if (source.charCodeAt(i) === 10 /* \n */) {
        this.lineStarts.push(i + 1);
      }
    }
  }

  /**
   * Cari index baris (0-based) untuk offset tertentu.
   * Binary search: cari lineStarts[i] ≤ offset < lineStarts[i+1].
   */
  private lineIndexOf(offset: number): number {
    let lo = 0;
    let hi = this.lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if (this.lineStarts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /**
   * Konversi offset ke Position (line 1-based, column 1-based).
   */
  position(offset: number): Position {
    const lineIdx = this.lineIndexOf(offset);
    const lineStart = this.lineStarts[lineIdx]!;
    return {
      offset,
      line: lineIdx + 1,
      column: offset - lineStart + 1,
    };
  }

  /**
   * Ambil isi satu baris (1-based). Berguna untuk error reporter.
   */
  lineContent(line: number): string {
    if (line < 1 || line > this.lineStarts.length) return "";
    const start = this.lineStarts[line - 1]!;
    const end = line < this.lineStarts.length
      ? this.lineStarts[line]! - 1  // -1 untuk buang \n
      : this.source.length;
    return this.source.slice(start, end);
  }

  get lineCount(): number {
    return this.lineStarts.length;
  }
}

// ============================================================
// Token Kind
// ============================================================

export type TokenKind =
  // --- Literals ---
  | "NUMBER"
  | "STRING"
  | "RAW_STRING"                 // r"..."
  | "MULTILINE_STRING"           // """..."""
  | "STRING_INTERP_START"        // "teks${
  | "STRING_INTERP_MIDDLE"       // }teks${
  | "STRING_INTERP_END"          // }teks"

  // --- Identifier ---
  | "IDENTIFIER"

  // --- Keywords ---
  | "CONST" | "LET" | "FN" | "RETURN" | "TYPE"
  | "IF" | "ELSE" | "ELIF"
  | "WHILE" | "FOR" | "IN" | "BREAK" | "CONTINUE"
  | "MATCH" | "CASE"
  | "TRY" | "CATCH" | "FINALLY" | "THROW"
  | "IMPORT" | "EXPORT" | "FROM" | "AS"
  | "AND" | "OR" | "NOT"
  | "TRUE" | "FALSE" | "NULL"

  // --- Punctuation ---
  | "LPAREN" | "RPAREN"
  | "LBRACKET" | "RBRACKET"
  | "LBRACE" | "RBRACE"
  | "COMMA" | "COLON" | "DOT" | "QUESTION" | "PIPE" | "UNDERSCORE"

  // --- Operators ---
  | "PLUS" | "MINUS" | "STAR" | "SLASH" | "PERCENT" | "STAR_STAR"
  | "EQ" | "EQ_EQ" | "BANG_EQ" | "LT" | "LT_EQ" | "GT" | "GT_EQ"
  | "PLUS_EQ" | "MINUS_EQ" | "STAR_EQ" | "SLASH_EQ" | "PERCENT_EQ"
  | "ARROW"       // ->
  | "FAT_ARROW"   // =>
  | "DOT_DOT"     // ..

  // --- Structural ---
  | "NEWLINE"
  | "INDENT"
  | "DEDENT"
  | "EOF"

  // --- Trivia (hanya muncul kalau preserveTrivia: true) ---
  | "COMMENT"
  | "DOC_COMMENT"
  | "BLANK_LINE"
  ;

// ============================================================
// Token
// ============================================================

export interface Token {
  readonly kind: TokenKind;
  /** Nilai semantik — sudah diproses (escape, konversi angka, dll). */
  readonly value: string | number | null;
  /** Teks mentah dari source. Berguna untuk formatter. */
  readonly raw: string;
  readonly loc: Location;
}

// ============================================================
// TokenStream — Untuk Parser
// ============================================================

/**
 * Wrapper di atas array token yang menyediakan operasi lookahead,
 * mark/reset, dan skip trivia secara otomatis.
 *
 * Parser akan bekerja dengan TokenStream, bukan array mentah.
 */
export class TokenStream {
  private pos = 0;
  private readonly marks: number[] = [];

  constructor(
    private readonly tokens: readonly Token[],
    private readonly skipTrivia = true,
  ) {}

  /** Lihat token pada offset tertentu tanpa konsumsi. */
  peek(offset = 0): Token {
    let idx = this.pos;
    let remaining = offset;
    while (idx < this.tokens.length) {
      const tok = this.tokens[idx]!;
      if (this.skipTrivia && this.isTrivia(tok)) {
        idx++;
        continue;
      }
      if (remaining === 0) return tok;
      remaining--;
      idx++;
    }
    // Return EOF
    return this.tokens[this.tokens.length - 1]!;
  }

  /** Konsumsi token saat ini, return yang sebelumnya. */
  next(): Token {
    while (this.pos < this.tokens.length) {
      const tok = this.tokens[this.pos]!;
      if (this.skipTrivia && this.isTrivia(tok)) {
        this.pos++;
        continue;
      }
      this.pos++;
      return tok;
    }
    return this.tokens[this.tokens.length - 1]!;
  }

  /** Cek apakah token saat ini punya kind tertentu. */
  check(kind: TokenKind): boolean {
    return this.peek().kind === kind;
  }

  /** Konsumsi kalau cocok, return true/false. */
  match(kind: TokenKind): boolean {
    if (this.check(kind)) {
      this.next();
      return true;
    }
    return false;
  }

  /** Tandai posisi. Bisa di-reset nanti. */
  mark(): void {
    this.marks.push(this.pos);
  }

  /** Reset ke mark terakhir. */
  reset(): void {
    const m = this.marks.pop();
    this.pos = m ?? 0;
  }

  /** Commit mark terakhir (buang tanpa reset). */
  commit(): void {
    this.marks.pop();
  }

  /** Index token saat ini (untuk debugging). */
  get index(): number {
    return this.pos;
  }

  /** Semua token mentah (untuk tooling seperti formatter). */
  get all(): readonly Token[] {
    return this.tokens;
  }

  private isTrivia(tok: Token): boolean {
    return (
      tok.kind === "COMMENT" ||
      tok.kind === "DOC_COMMENT" ||
      tok.kind === "BLANK_LINE"
    );
  }
}

// ============================================================
// Karakter — Dispatch Table
// ============================================================

const enum CharClass {
  Whitespace,
  Newline,
  Digit,
  IdentStart,
  IdentPart,
  Quote,
  Operator,
  Invalid,
}

/**
 * Lookup table untuk klasifikasi karakter. Cepat dan mudah dibaca
 * dibanding rangkaian if-else.
 */
const CHAR_TABLE: Uint8Array = (() => {
  const t = new Uint8Array(128).fill(CharClass.Invalid);

  // Whitespace horizontal
  t[32] = CharClass.Whitespace;   // spasi
  t[9]  = CharClass.Whitespace;   // tab

  // Newline
  t[10] = CharClass.Newline;      // \n
  t[13] = CharClass.Newline;      // \r

  // Digits
  for (let c = 48; c <= 57; c++) t[c] = CharClass.Digit;

  // Identifier start
  for (let c = 65; c <= 90; c++) t[c] = CharClass.IdentStart;   // A-Z
  for (let c = 97; c <= 122; c++) t[c] = CharClass.IdentStart;  // a-z
  t[95] = CharClass.IdentStart;   // _

  // Identifier part (sama dengan start + digit, akan di-override di method)

  // Quotes
  t[34] = CharClass.Quote;        // "
  t[39] = CharClass.Quote;        // '

  return t;
})();

function classify(c: string): CharClass {
  const code = c.charCodeAt(0);
  if (code < 128) return CHAR_TABLE[code] as CharClass;
  // Unicode letters di luar ASCII: treat sebagai identifier part
  // (detail: pakai regex untuk cek letter di luar Basic Latin)
  return /[\p{L}\p{N}]/u.test(c) ? CharClass.IdentStart : CharClass.Invalid;
}

// ============================================================
// Keyword Lookup
// ============================================================

const KEYWORDS: ReadonlyMap<string, TokenKind> = new Map([
  ["const", "CONST"], ["let", "LET"], ["fn", "FN"], ["return", "RETURN"],
  ["type", "TYPE"],
  ["if", "IF"], ["else", "ELSE"], ["elif", "ELIF"],
  ["while", "WHILE"], ["for", "FOR"], ["in", "IN"],
  ["break", "BREAK"], ["continue", "CONTINUE"],
  ["match", "MATCH"], ["case", "CASE"],
  ["try", "TRY"], ["catch", "CATCH"], ["finally", "FINALLY"], ["throw", "THROW"],
  ["import", "IMPORT"], ["export", "EXPORT"], ["from", "FROM"], ["as", "AS"],
  ["and", "AND"], ["or", "OR"], ["not", "NOT"],
  ["true", "TRUE"], ["false", "FALSE"], ["null", "NULL"],
]);

// ============================================================
// Lexer Options
// ============================================================

export interface LexerOptions {
  readonly file: string;
  readonly reporter: Reporter;
  /** Simpan komentar & baris kosong sebagai trivia. Default false. */
  readonly preserveTrivia?: boolean;
  /** Mode recovery: lanjut lexing setelah error. Default true. */
  readonly recoverOnError?: boolean;
}

// ============================================================
// Lexer — State Machine
// ============================================================

/**
 * State state machine yang harus dilacak:
 *
 * - pos               : offset byte saat ini
 * - indentStack       : level indentasi yang aktif
 * - bracketDepth      : kedalaman ( ) [ ] { }
 * - interpStack       : brace depth di dalam ${...}
 * - atLineStart       : apakah kita di awal baris logis
 * - trivia            : menyimpan trivia (comment, blank) bila preserveTrivia
 */
export class Lexer {
  private readonly source: string;
  private readonly file: string;
  private readonly reporter: Reporter;
  private readonly preserveTrivia: boolean;
  private readonly recoverOnError: boolean;
  private readonly sourceMap: SourceMap;

  private pos = 0;

  private readonly tokens: Token[] = [];
  private readonly indentStack: number[] = [0];
  private bracketDepth = 0;
  private readonly interpStack: number[] = [];
  private atLineStart = true;

  /** Untuk recovery: skip sampai baris baru. */
  private recovering = false;

  constructor(source: string, opts: LexerOptions) {
    this.source = source;
    this.file = opts.file;
    this.reporter = opts.reporter;
    this.preserveTrivia = opts.preserveTrivia ?? false;
    this.recoverOnError = opts.recoverOnError ?? true;
    this.sourceMap = new SourceMap(source);
  }

  // ==========================================================
  // Public API
  // ==========================================================

  /**
   * Jalankan lexing sampai EOF. Hasilnya adalah TokenStream
   * yang siap dikonsumsi parser.
   */
  tokenize(): TokenStream {
    while (!this.isAtEnd()) {
      if (this.recovering) {
        this.skipToLineEnd();
        this.recovering = false;
        continue;
      }

      if (this.atLineStart) {
        this.handleLineStart();
        if (this.isAtEnd()) break;
        if (this.recovering) continue;
      }

      this.scanToken();
    }

    this.emitFinal();
    return new TokenStream(this.tokens);
  }

  /**
   * Untuk tooling (formatter, LSP): kembalikan semua token termasuk trivia.
   */
  tokenizeWithTrivia(): TokenStream {
    const lexerWithTrivia = new Lexer(this.source, {
      file: this.file,
      reporter: this.reporter,
      preserveTrivia: true,
      recoverOnError: false,
    });
    return lexerWithTrivia.tokenize();
  }

  // ==========================================================
  // Line Start & Indentation
  // ==========================================================

  private handleLineStart(): void {
    while (!this.isAtEnd()) {
      const lineStartOffset = this.pos;
      let spaces = 0;

      while (this.peek() === " ") {
        this.advance();
        spaces++;
      }

      // Tab di awal baris = error
      if (this.peek() === "\t") {
        const startPos = this.sourceMap.position(lineStartOffset);
        const endPos = this.sourceMap.position(this.pos + 1);
        this.reporter.report({
          severity: "error",
          code: ErrorCode.INVALID_INDENT,
          message: "tab tidak diizinkan untuk indentasi",
          location: { start: startPos, end: endPos, file: this.file },
          helps: ["gunakan 4 spasi per level indentasi"],
        });
        while (this.peek() === "\t") this.advance();
        if (this.recoverOnError) {
          this.recovering = true;
          return;
        }
      }

      const c = this.peek();

      // Baris kosong
      if (c === "\n" || c === "\r") {
        this.consumeNewline();
        if (this.preserveTrivia) {
          this.emitTrivia("BLANK_LINE", lineStartOffset, this.pos);
        }
        continue;
      }

      // Baris komentar saja
      if (c === "#") {
        this.readComment();
        continue;
      }

      // Baris dengan konten — terapkan indentasi
      if (this.bracketDepth === 0 && this.interpStack.length === 0) {
        this.applyIndent(spaces, lineStartOffset);
      }

      this.atLineStart = false;
      return;
    }
  }

  private applyIndent(spaces: number, lineStartOffset: number): void {
    const top = this.indentStack[this.indentStack.length - 1]!;

    if (spaces > top) {
      this.indentStack.push(spaces);
      const p = this.sourceMap.position(lineStartOffset);
      this.emitSynthetic("INDENT", p);
      return;
    }

    if (spaces < top) {
      const pos = this.sourceMap.position(lineStartOffset);
      while (
        this.indentStack.length > 1 &&
        this.indentStack[this.indentStack.length - 1]! > spaces
      ) {
        this.indentStack.pop();
        this.emitSynthetic("DEDENT", pos);
      }

      const nowTop = this.indentStack[this.indentStack.length - 1]!;
      if (nowTop !== spaces) {
        const endPos = this.sourceMap.position(this.pos);
        this.reporter.report({
          severity: "error",
          code: ErrorCode.INVALID_INDENT,
          message: `indentasi tidak konsisten: ${spaces} spasi, diharapkan ${nowTop}`,
          location: { start: pos, end: endPos, file: this.file },
          helps: ["setiap blok harus menggunakan kelipatan 4 spasi"],
        });
      }
    }
  }

  // ==========================================================
  // Token Scanner — Dispatch
  // ==========================================================

  private scanToken(): void {
    // Skip whitespace horizontal
    while (this.peek() === " " || this.peek() === "\t") this.advance();

    if (this.isAtEnd()) return;

    const c = this.peek();
    const cls = classify(c);

    switch (cls) {
      case CharClass.Newline:
        this.scanNewline();
        return;
      case CharClass.Quote:
        this.readString();
        return;
      case CharClass.Digit:
        this.readNumber();
        return;
      case CharClass.IdentStart:
        this.readIdentifierOrKeyword();
        return;
      default:
        break;
    }

    // `#` bukan identifier — handle terpisah
    if (c === "#") {
      this.readComment();
      return;
    }

    // Operator / punctuation
    this.readOperator();
  }

  private scanNewline(): void {
    const startOffset = this.pos;
    this.consumeNewline();

    if (this.bracketDepth === 0 && this.interpStack.length === 0) {
      const start = this.sourceMap.position(startOffset);
      const end = this.sourceMap.position(this.pos);
      this.emitToken("NEWLINE", null, start, end);
      this.atLineStart = true;
    }
  }

  // ==========================================================
  // Comment
  // ==========================================================

  private readComment(): void {
    const startOffset = this.pos;
    const isDoc = this.peekAt(1) === "#";

    // Konsumsi sampai newline (tidak termasuk)
    while (!this.isAtEnd() && this.peek() !== "\n" && this.peek() !== "\r") {
      this.advance();
    }

    const raw = this.source.slice(startOffset, this.pos);
    const body = isDoc ? raw.slice(2).trim() : raw.slice(1).trim();
    const start = this.sourceMap.position(startOffset);
    const end = this.sourceMap.position(this.pos);

    if (this.preserveTrivia) {
      this.emitToken(isDoc ? "DOC_COMMENT" : "COMMENT", body, start, end);
    }

    // Konsumsi newline setelah komentar
    if (!this.isAtEnd()) {
      this.consumeNewline();
      if (this.bracketDepth === 0 && this.interpStack.length === 0) {
        if (this.preserveTrivia) {
          this.emitSynthetic("NEWLINE", end);
        }
        this.atLineStart = true;
      }
    }
  }

  // ==========================================================
  // Identifier & Keyword
  // ==========================================================

  private readIdentifierOrKeyword(): void {
    const startOffset = this.pos;

    // Cek raw string prefix: r"..." atau r'...'
    if (
      this.peek() === "r" &&
      (this.peekAt(1) === '"' || this.peekAt(1) === "'")
    ) {
      this.advance(); // r
      this.readString(/* raw */ true);
      return;
    }

    while (!this.isAtEnd()) {
      const cls = classify(this.peek());
      if (cls === CharClass.IdentStart || cls === CharClass.Digit) {
        this.advance();
      } else {
        break;
      }
    }

    const name = this.source.slice(startOffset, this.pos);
    const keyword = KEYWORDS.get(name);
    const start = this.sourceMap.position(startOffset);
    const end = this.sourceMap.position(this.pos);

    if (keyword) {
      this.emitToken(keyword, null, start, end);
    } else if (name === "_") {
      this.emitToken("UNDERSCORE", null, start, end);
    } else {
      this.emitToken("IDENTIFIER", name, start, end);
    }
  }

  // ==========================================================
  // Number
  // ==========================================================

  private readNumber(): void {
    const startOffset = this.pos;

    // Hex / Bin / Oct
    if (this.peek() === "0") {
      const next = this.peekAt(1);
      if (next === "x" || next === "X") return this.readRadix(16, startOffset, /[0-9a-fA-F_]/);
      if (next === "b" || next === "B") return this.readRadix(2, startOffset, /[01_]/);
      if (next === "o" || next === "O") return this.readRadix(8, startOffset, /[0-7_]/);
    }

    // Decimal
    while (this.isDigit(this.peek()) || this.peek() === "_") this.advance();

    // Float
    if (this.peek() === "." && this.isDigit(this.peekAt(1))) {
      this.advance();
      while (this.isDigit(this.peek()) || this.peek() === "_") this.advance();
    }

    // Exponent
    const e = this.peek();
    if (e === "e" || e === "E") {
      const after = this.peekAt(1);
      if (
        this.isDigit(after) ||
        ((after === "+" || after === "-") && this.isDigit(this.peekAt(2)))
      ) {
        this.advance();
        if (this.peek() === "+" || this.peek() === "-") this.advance();
        while (this.isDigit(this.peek())) this.advance();
      }
    }

    this.finishNumber(startOffset, 10);
  }

  private readRadix(
    radix: number,
    startOffset: number,
    pattern: RegExp,
  ): void {
    this.advance(); // 0
    this.advance(); // x/b/o
    while (pattern.test(this.peek())) this.advance();
    this.finishNumber(startOffset, radix);
  }

  private finishNumber(startOffset: number, radix: number): void {
    const raw = this.source.slice(startOffset, this.pos);
    let digits = raw;
    if (radix !== 10) digits = digits.slice(2);
    digits = digits.replace(/_/g, "");

    const value = radix === 10 ? Number(digits) : parseInt(digits, radix);
    const start = this.sourceMap.position(startOffset);
    const end = this.sourceMap.position(this.pos);

    if (Number.isNaN(value)) {
      this.reporter.report({
        severity: "error",
        code: ErrorCode.INVALID_NUMBER_LITERAL,
        message: `angka tidak valid: \`${raw}\``,
        location: { start, end, file: this.file },
      });
      this.recovering = this.recoverOnError;
      return;
    }

    this.emitToken("NUMBER", value, start, end, raw);
  }

  // ==========================================================
  // String — Normal, Raw, Multi-line, Interpolated
  // ==========================================================

  private readString(isRaw = false): void {
    const startOffset = this.pos;

    // Multi-line string """..."""
    if (
      !isRaw &&
      (this.peek() === '"' || this.peek() === "'") &&
      this.peekAt(1) === this.peek() &&
      this.peekAt(2) === this.peek()
    ) {
      return this.readMultilineString(this.peek()!);
    }

    const quote = this.peek()!;
    this.advance(); // buang quote

    let buffer = "";
    let hasInterp = false;

    while (!this.isAtEnd()) {
      const c = this.peek();

      // Akhir string
      if (c === quote) {
        this.advance();
        const start = this.sourceMap.position(startOffset);
        const end = this.sourceMap.position(this.pos);
        const raw = this.source.slice(startOffset, this.pos);

        if (hasInterp && this.interpStack.length > 0) {
          this.emitToken("STRING_INTERP_END", buffer, start, end, raw);
        } else if (isRaw) {
          this.emitToken("RAW_STRING", buffer, start, end, raw);
        } else {
          this.emitToken("STRING", buffer, start, end, raw);
        }
        return;
      }

      // Interpolasi
      if (!isRaw && c === "$" && this.peekAt(1) === "{") {
        this.advance(); // $
        this.advance(); // {
        const start = this.sourceMap.position(startOffset);
        const end = this.sourceMap.position(this.pos);
        const raw = this.source.slice(startOffset, this.pos);

        const kind: TokenKind =
          this.interpStack.length > 0
            ? "STRING_INTERP_MIDDLE"
            : "STRING_INTERP_START";
        this.emitToken(kind, buffer, start, end, raw);
        this.interpStack.push(0);
        hasInterp = true;
        return;
      }

      // Escape
      if (!isRaw && c === "\\") {
        this.advance();
        const esc = this.peek();
        const decoded = this.decodeEscape(esc, startOffset);
        if (decoded === null) {
          this.recovering = this.recoverOnError;
          return;
        }
        buffer += decoded;
        continue;
      }

      // Newline di dalam string biasa = error
      if (!isRaw && (c === "\n" || c === "\r")) {
        const start = this.sourceMap.position(startOffset);
        const end = this.sourceMap.position(this.pos);
        this.reporter.report({
          severity: "error",
          code: ErrorCode.UNTERMINATED_STRING,
          message: "string tidak ditutup di akhir baris",
          location: { start, end, file: this.file },
          helps: [
            "gunakan \"\"\" untuk string multi-baris",
            "atau pecah string dengan operator +",
          ],
        });
        this.recovering = this.recoverOnError;
        return;
      }

      buffer += c;
      this.advance();
    }

    // EOF tanpa penutup
    const start = this.sourceMap.position(startOffset);
    const end = this.sourceMap.position(this.pos);
    this.reporter.report({
      severity: "error",
      code: ErrorCode.UNTERMINATED_STRING,
      message: "string tidak ditutup sampai akhir file",
      location: { start, end, file: this.file },
    });
  }

  private readMultilineString(quote: string): void {
    const startOffset = this.pos;
    this.advance(); this.advance(); this.advance(); // buang """

    let buffer = "";

    while (!this.isAtEnd()) {
      const c = this.peek();

      // Akhir """
      if (
        c === quote &&
        this.peekAt(1) === quote &&
        this.peekAt(2) === quote
      ) {
        this.advance(); this.advance(); this.advance();
        const start = this.sourceMap.position(startOffset);
        const end = this.sourceMap.position(this.pos);
        const raw = this.source.slice(startOffset, this.pos);
        this.emitToken("MULTILINE_STRING", buffer, start, end, raw);
        return;
      }

      // Escape
      if (c === "\\") {
        this.advance();
        const decoded = this.decodeEscape(this.peek(), startOffset);
        if (decoded === null) return;
        buffer += decoded;
        continue;
      }

      buffer += c;
      this.advance();
    }

    const start = this.sourceMap.position(startOffset);
    const end = this.sourceMap.position(this.pos);
    this.reporter.report({
      severity: "error",
      code: ErrorCode.UNTERMINATED_STRING,
      message: "multi-line string tidak ditutup dengan \"\"\"",
      location: { start, end, file: this.file },
    });
  }

  /**
   * Proses escape sequence. Return null kalau error (sudah di-report).
   */
  private decodeEscape(esc: string, stringStartOffset: number): string | null {
    switch (esc) {
      case "n": this.advance(); return "\n";
      case "t": this.advance(); return "\t";
      case "r": this.advance(); return "\r";
      case "\\": this.advance(); return "\\";
      case '"': this.advance(); return '"';
      case "'": this.advance(); return "'";
      case "$": this.advance(); return "$";
      case "0": this.advance(); return "\0";
      case "":
        this.reporter.report({
          severity: "error",
          code: ErrorCode.UNTERMINATED_STRING,
          message: "string berakhir setelah backslash",
          location: {
            start: this.sourceMap.position(stringStartOffset),
            end: this.sourceMap.position(this.pos),
            file: this.file,
          },
        });
        return null;
      default: {
        const pos = this.sourceMap.position(this.pos - 1);
        this.reporter.report({
          severity: "error",
          code: ErrorCode.INVALID_STRING_LITERAL,
          message: `escape sequence tidak dikenal: \\${esc}`,
          location: {
            start: pos,
            end: this.sourceMap.position(this.pos + 1),
            file: this.file,
          },
          helps: ["escape yang valid: \\n \\t \\r \\\\ \\\" \\' \\$ \\0"],
        });
        this.advance();
        return esc;
      }
    }
  }

  /**
   * Lanjutkan string setelah `${...}` ditutup.
   */
  private readStringContinuation(): void {
    const startOffset = this.pos;
    let buffer = "";

    while (!this.isAtEnd()) {
      const c = this.peek();

      // Quote penutup
      if (c === '"' || c === "'") {
        this.advance();
        const start = this.sourceMap.position(startOffset);
        const end = this.sourceMap.position(this.pos);
        const raw = this.source.slice(startOffset, this.pos);
        this.emitToken("STRING_INTERP_END", buffer, start, end, raw);
        return;
      }

      // Interpolasi lanjutan
      if (c === "$" && this.peekAt(1) === "{") {
        this.advance(); this.advance();
        const start = this.sourceMap.position(startOffset);
        const end = this.sourceMap.position(this.pos);
        const raw = this.source.slice(startOffset, this.pos);
        this.emitToken("STRING_INTERP_MIDDLE", buffer, start, end, raw);
        this.interpStack.push(0);
        return;
      }

      // Escape
      if (c === "\\") {
        this.advance();
        const decoded = this.decodeEscape(this.peek(), startOffset);
        if (decoded === null) return;
        buffer += decoded;
        continue;
      }

      if (c === "\n" || c === "\r") {
        const start = this.sourceMap.position(startOffset);
        const end = this.sourceMap.position(this.pos);
        this.reporter.report({
          severity: "error",
          code: ErrorCode.UNTERMINATED_STRING,
          message: "string tidak ditutup di akhir baris",
          location: { start, end, file: this.file },
        });
        this.recovering = this.recoverOnError;
        return;
      }

      buffer += c;
      this.advance();
    }
  }

  // ==========================================================
  // Operators & Punctuation
  // ==========================================================

  private readOperator(): void {
    const startOffset = this.pos;
    const c = this.peek();
    this.advance();

    let kind: TokenKind | null = null;

    switch (c) {
      case "(": this.bracketDepth++; kind = "LPAREN"; break;
      case ")": if (this.bracketDepth > 0) this.bracketDepth--; kind = "RPAREN"; break;
      case "[": this.bracketDepth++; kind = "LBRACKET"; break;
      case "]": if (this.bracketDepth > 0) this.bracketDepth--; kind = "RBRACKET"; break;
      case "{": this.bracketDepth++; kind = "LBRACE"; break;
      case "}": {
        // Cek apakah menutup interpolation
        if (this.interpStack.length > 0) {
          const top = this.interpStack[this.interpStack.length - 1]!;
          if (top === 0) {
            this.interpStack.pop();
            this.readStringContinuation();
            return;
          }
          this.interpStack[this.interpStack.length - 1] = top - 1;
        }
        if (this.bracketDepth > 0) this.bracketDepth--;
        kind = "RBRACE";
        break;
      }
      case ",": kind = "COMMA"; break;
      case ":": kind = "COLON"; break;
      case "?": kind = "QUESTION"; break;
      case ".":
        if (this.peek() === ".") { this.advance(); kind = "DOT_DOT"; }
        else kind = "DOT";
        break;
      case "-":
        if (this.peek() === ">") { this.advance(); kind = "ARROW"; }
        else if (this.peek() === "=") { this.advance(); kind = "MINUS_EQ"; }
        else kind = "MINUS";
        break;
      case "+":
        if (this.peek() === "=") { this.advance(); kind = "PLUS_EQ"; }
        else kind = "PLUS";
        break;
      case "*":
        if (this.peek() === "*") { this.advance(); kind = "STAR_STAR"; }
        else if (this.peek() === "=") { this.advance(); kind = "STAR_EQ"; }
        else kind = "STAR";
        break;
      case "/":
        if (this.peek() === "=") { this.advance(); kind = "SLASH_EQ"; }
        else kind = "SLASH";
        break;
      case "%":
        if (this.peek() === "=") { this.advance(); kind = "PERCENT_EQ"; }
        else kind = "PERCENT";
        break;
      case "=":
        if (this.peek() === "=") { this.advance(); kind = "EQ_EQ"; }
        else if (this.peek() === ">") { this.advance(); kind = "FAT_ARROW"; }
        else kind = "EQ";
        break;
      case "!":
        if (this.peek() === "=") { this.advance(); kind = "BANG_EQ"; }
        else {
          this.errorAt(
            ErrorCode.INVALID_CHARACTER,
            "`!` tidak valid — gunakan `not` untuk negasi logika",
            startOffset,
            ["Snake Script menggunakan kata `not`, bukan `!`"],
          );
          return;
        }
        break;
      case "<":
        if (this.peek() === "=") { this.advance(); kind = "LT_EQ"; }
        else kind = "LT";
        break;
      case ">":
        if (this.peek() === "=") { this.advance(); kind = "GT_EQ"; }
        else kind = "GT";
        break;
      case "|":
        if (this.peek() === "|") {
          this.advance();
          this.errorAt(
            ErrorCode.INVALID_CHARACTER,
            "`||` tidak valid — gunakan `or` untuk logika",
            startOffset,
            ["Snake Script menggunakan kata `or`, bukan `||`"],
          );
          return;
        }
        kind = "PIPE";
        break;
      case "&":
        this.errorAt(
          ErrorCode.INVALID_CHARACTER,
          "`&` tidak valid — gunakan `and` untuk logika",
          startOffset,
          ["Snake Script menggunakan kata `and`, bukan `&&`"],
        );
        if (this.peek() === "&") this.advance();
        return;
      default:
        this.errorAt(
          ErrorCode.INVALID_CHARACTER,
          `karakter tidak dikenal: \`${c}\``,
          startOffset,
        );
        return;
    }

    if (kind) {
      const start = this.sourceMap.position(startOffset);
      const end = this.sourceMap.position(this.pos);
      this.emitToken(kind, null, start, end);
    }
  }

  // ==========================================================
  // Final Tokens
  // ==========================================================

  private emitFinal(): void {
    const pos = this.sourceMap.position(this.pos);

    while (this.indentStack.length > 1) {
      this.indentStack.pop();
      this.emitSynthetic("DEDENT", pos);
    }

    const last = this.lastNonTrivia();
    if (last && last.kind !== "NEWLINE" && last.kind !== "DEDENT") {
      this.emitSynthetic("NEWLINE", pos);
    }

    this.emitSynthetic("EOF", pos);
  }

  private lastNonTrivia(): Token | null {
    for (let i = this.tokens.length - 1; i >= 0; i--) {
      const t = this.tokens[i]!;
      if (
        t.kind !== "COMMENT" &&
        t.kind !== "DOC_COMMENT" &&
        t.kind !== "BLANK_LINE"
      ) {
        return t;
      }
    }
    return null;
  }

  // ==========================================================
  // Error Recovery
  // ==========================================================

  private skipToLineEnd(): void {
    while (!this.isAtEnd() && this.peek() !== "\n" && this.peek() !== "\r") {
      this.advance();
    }
    if (!this.isAtEnd()) this.consumeNewline();
    this.atLineStart = true;
  }

  private errorAt(
    code: string,
    message: string,
    startOffset: number,
    helps?: readonly string[],
  ): void {
    const start = this.sourceMap.position(startOffset);
    const end = this.sourceMap.position(this.pos);
    this.reporter.report({
      severity: "error",
      code,
      message,
      location: { start, end, file: this.file },
      helps,
    });
    this.recovering = this.recoverOnError;
  }

  // ==========================================================
  // Navigation Primitives
  // ==========================================================

  private isAtEnd(): boolean {
    return this.pos >= this.source.length;
  }

  private peek(): string {
    return this.source[this.pos] ?? "";
  }

  private peekAt(offset: number): string {
    return this.source[this.pos + offset] ?? "";
  }

  private advance(): void {
    this.pos++;
  }

  private consumeNewline(): void {
    if (this.peek() === "\r" && this.peekAt(1) === "\n") {
      this.pos += 2;
    } else if (this.peek() === "\n" || this.peek() === "\r") {
      this.pos++;
    }
  }

  private isDigit(c: string): boolean {
    return c >= "0" && c <= "9";
  }

  // ==========================================================
  // Token Emit
  // ==========================================================

  private emitToken(
    kind: TokenKind,
    value: string | number | null,
    start: Position,
    end: Position,
    raw?: string,
  ): void {
    this.tokens.push({
      kind,
      value,
      raw: raw ?? this.source.slice(start.offset, end.offset),
      loc: { start, end, file: this.file },
    });
  }

  /**
   * Emit token sintetis yang tidak punya teks di source
   * (INDENT, DEDENT, NEWLINE otomatis, EOF).
   */
  private emitSynthetic(kind: TokenKind, pos: Position): void {
    this.tokens.push({
      kind,
      value: null,
      raw: "",
      loc: { start: pos, end: pos, file: this.file },
    });
  }

  private emitTrivia(kind: TokenKind, startOffset: number, endOffset: number): void {
    const start = this.sourceMap.position(startOffset);
    const end = this.sourceMap.position(endOffset);
    this.tokens.push({
      kind,
      value: null,
      raw: this.source.slice(startOffset, endOffset),
      loc: { start, end, file: this.file },
    });
  }
}

// ============================================================
// Convenience
// ============================================================

/**
 * Entry point ringkas: lex source jadi TokenStream.
 */
export function lex(
  source: string,
  file: string,
  reporter: Reporter,
  options: Omit<LexerOptions, "file" | "reporter"> = {},
): TokenStream {
  const lexer = new Lexer(source, { file, reporter, ...options });
  return lexer.tokenize();
}
