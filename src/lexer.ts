/**
 * Snake Script — Lexer (Advanced Production-Grade)
 *
 * Mengubah source code Snake Script menjadi `TokenStream` dengan fitur:
 *
 * 1. Indentation & Off-Side Rule Engine (Python-style):
 *    - Deteksi `INDENT` dan `DEDENT` otomatis berbasis stack spasi.
 *    - Penanganan cerdas untuk baris kosong, komentar sebaris (inline trailing comment),
 *      dan komentar satu baris penuh tanpa menelan token `NEWLINE` secara tidak sengaja.
 *    - Supresi `NEWLINE`/`INDENT`/`DEDENT` otomatis di dalam kurung `()`, `[]`, `{}`
 *      dan ekspresi interpolasi `${...}`.
 *
 * 2. String & Interpolasi Bersarang (`${...}`) Tingkat Lanjut:
 *    - Mendukung single-line (`"..."`, `'...'`), raw string (`r"..."`, `r'...'`),
 *      multi-line (`"""..."""`, `'''...'''`), dan raw multi-line (`r"""..."""`).
 *    - Interpolasi `${...}` bekerja di dalam string biasa maupun multi-line string,
 *      lengkap dengan pelacakan kedalaman kurung kurawal (`braceDepth`) untuk map literal
 *      bersarang di dalam ekspresi interpolasi.
 *    - Dukungan escape sequence lengkap: `\n`, `\t`, `\r`, `\\`, `\"`, `\'`, `\$`, `\0`,
 *      `\b`, `\f`, `\v`, hex `\xHH`, Unicode `\uXXXX` & `\u{XXXXXX}`, serta line-continuation `\<newline>`.
 *
 * 3. Validasi Angka & Pemisah Digit (`_`) Ketat:
 *    - Mendukung desimal, float, notasi ilmiah (`1.5e-10`), heksadesimal (`0xFF`),
 *      biner (`0b1010`), dan oktal (`0o755`).
 *    - Mendeteksi digit tidak valid pada basis tertentu (misal `0b102` atau `0o78`),
 *      underscore di posisi terlarang (`100_`, `0x_FF`, `1._5`, `1__000`), dan eksponen kosong.
 *
 * 4. Bracket Stack & Diagnostik Presisi:
 *    - Melacak stack kurung buka `(` / `[` / `{` beserta posisinya untuk melaporkan
 *      kurung tutup yang tidak cocok (misal `(1 + 2]`) atau kurung yang belum ditutup hingga EOF.
 *    - Memberikan saran idiomatik Snake Script untuk operator asing (`===`, `!==`, `&&`, `||`, `!`, `;`, `++`, `--`).
 *    - `SourceMap` mendukung penuh `\n`, `\r\n` (CRLF), dan `\r` mandiri, dilengkapi pembuatan cuplikan kode (`snippet`).
 */

import type { Location, Position } from "./ast.ts";
import type { Reporter } from "./diagnostics.ts";
import { ErrorCode } from "./diagnostics.ts";

// ============================================================
// SourceMap
// ============================================================

export class SourceMap {
  private readonly lineStarts: number[] = [0];
  readonly source: string;

  constructor(source: string) {
    this.source = source;
    for (let i = 0; i < source.length; i++) {
      const code = source.charCodeAt(i);
      if (code === 10) {
        // \n
        this.lineStarts.push(i + 1);
      } else if (code === 13) {
        // \r\n atau \r mandiri
        if (source.charCodeAt(i + 1) === 10) {
          i++;
        }
        this.lineStarts.push(i + 1);
      }
    }
  }

  private lineIndexOf(offset: number): number {
    const clamped = Math.max(0, Math.min(offset, this.source.length));
    let lo = 0;
    let hi = this.lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if (this.lineStarts[mid]! <= clamped) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  position(offset: number): Position {
    const clamped = Math.max(0, Math.min(offset, this.source.length));
    const lineIdx = this.lineIndexOf(clamped);
    const lineStart = this.lineStarts[lineIdx]!;
    return {
      offset: clamped,
      line: lineIdx + 1,
      column: clamped - lineStart + 1,
    };
  }

  /**
   * Konversi nomor baris (1-based) dan kolom (1-based) kembali ke offset karakter.
   */
  offsetOf(line: number, column = 1): number {
    if (line < 1) return 0;
    if (line > this.lineStarts.length) return this.source.length;
    const start = this.lineStarts[line - 1]!;
    return Math.min(this.source.length, start + Math.max(0, column - 1));
  }

  lineContent(line: number): string {
    if (line < 1 || line > this.lineStarts.length) return "";
    const start = this.lineStarts[line - 1]!;
    let end =
      line < this.lineStarts.length
        ? this.lineStarts[line]!
        : this.source.length;

    // Bersihkan karakter newline (\r\n, \n, \r) di ujung baris
    while (
      end > start &&
      (this.source.charCodeAt(end - 1) === 10 ||
        this.source.charCodeAt(end - 1) === 13)
    ) {
      end--;
    }
    return this.source.slice(start, end);
  }

  /**
   * Menghasilkan cuplikan baris kode beserta garis bawah caret (`^`) untuk lokasi tertentu.
   */
  formatSnippet(loc: Location): string {
    const lineText = this.lineContent(loc.start.line);
    const colStart = Math.max(1, loc.start.column);
    const spanLen =
      loc.end.line === loc.start.line
        ? Math.max(1, loc.end.column - loc.start.column)
        : Math.max(1, lineText.length - colStart + 1);
    const gutter = `${loc.start.line} | `;
    const pad = " ".repeat(gutter.length + colStart - 1);
    const carets = "^".repeat(spanLen);
    return `${gutter}${lineText}\n${pad}${carets}`;
  }

  get lineCount(): number {
    return this.lineStarts.length;
  }
}

// ============================================================
// Token Kind
// ============================================================

export type TokenKind =
  | "NUMBER"
  | "STRING"
  | "RAW_STRING"
  | "MULTILINE_STRING"
  | "STRING_INTERP_START"
  | "STRING_INTERP_MIDDLE"
  | "STRING_INTERP_END"
  | "IDENTIFIER"
  | "CONST" | "LET" | "FN" | "RETURN" | "TYPE"
  | "IF" | "ELSE" | "ELIF"
  | "WHILE" | "FOR" | "IN" | "BREAK" | "CONTINUE"
  | "MATCH" | "CASE"
  | "TRY" | "CATCH" | "FINALLY" | "THROW"
  | "IMPORT" | "EXPORT" | "FROM" | "AS"
  | "AND" | "OR" | "NOT"
  | "TRUE" | "FALSE" | "NULL"
  | "LPAREN" | "RPAREN"
  | "LBRACKET" | "RBRACKET"
  | "LBRACE" | "RBRACE"
  | "COMMA" | "COLON" | "DOT" | "QUESTION" | "PIPE" | "UNDERSCORE"
  | "PLUS" | "MINUS" | "STAR" | "SLASH" | "PERCENT" | "STAR_STAR"
  | "EQ" | "EQ_EQ" | "BANG_EQ" | "LT" | "LT_EQ" | "GT" | "GT_EQ"
  | "PLUS_EQ" | "MINUS_EQ" | "STAR_EQ" | "SLASH_EQ" | "PERCENT_EQ"
  | "ARROW"
  | "FAT_ARROW"
  | "DOT_DOT"
  | "NEWLINE"
  | "INDENT"
  | "DEDENT"
  | "EOF"
  | "COMMENT"
  | "DOC_COMMENT"
  | "BLANK_LINE";

// ============================================================
// Token
// ============================================================

export interface Token {
  readonly kind: TokenKind;
  readonly value: string | number | null;
  readonly raw: string;
  readonly loc: Location;
}

// ============================================================
// Interpolation & Bracket Frames
// ============================================================

interface InterpFrame {
  readonly quote: string;
  readonly multiline: boolean;
  readonly startOffset: number;
  braceDepth: number;
}

interface BracketFrame {
  readonly open: "(" | "[" | "{";
  readonly expectedClose: ")" | "]" | "}";
  readonly offset: number;
}

// ============================================================
// TokenStream
// ============================================================

export class TokenStream {
  private pos = 0;
  private readonly marks: number[] = [];
  private readonly tokens: readonly Token[];
  private readonly nonTriviaIndices: readonly number[];
  private readonly skipTrivia: boolean;

  constructor(tokens: readonly Token[], skipTrivia = true) {
    if (tokens.length === 0) {
      throw new Error("TokenStream: tokens tidak boleh kosong (minimal EOF)");
    }
    this.tokens = tokens;
    this.skipTrivia = skipTrivia;

    // Pre-compute indeks non-trivia agar operasi `peek(offset)` berjalan O(1)
    if (skipTrivia) {
      const indices: number[] = [];
      for (let i = 0; i < tokens.length; i++) {
        if (!TokenStream.isTriviaToken(tokens[i]!)) {
          indices.push(i);
        }
      }
      if (indices.length === 0) {
        indices.push(tokens.length - 1);
      }
      this.nonTriviaIndices = indices;
    } else {
      this.nonTriviaIndices = [];
    }
  }

  peek(offset = 0): Token {
    if (!this.skipTrivia) {
      const target = Math.min(
        Math.max(0, this.pos + offset),
        this.tokens.length - 1,
      );
      return this.tokens[target]!;
    }

    // Cari posisi saat ini di tabel nonTriviaIndices menggunakan binary search
    const logicalIdx = this.findLogicalIndex(this.pos);
    const targetLogical = Math.min(
      Math.max(0, logicalIdx + offset),
      this.nonTriviaIndices.length - 1,
    );
    return this.tokens[this.nonTriviaIndices[targetLogical]!]!;
  }

  peekKind(offset = 0): TokenKind {
    return this.peek(offset).kind;
  }

  /**
   * Memeriksa apakah urutan token ke depan cocok dengan daftar `kinds` yang diberikan.
   */
  checkSequence(...kinds: TokenKind[]): boolean {
    for (let i = 0; i < kinds.length; i++) {
      if (this.peekKind(i) !== kinds[i]) return false;
    }
    return true;
  }

  current(): Token {
    return this.peek();
  }

  check(kind: TokenKind, offset = 0): boolean {
    return this.peek(offset).kind === kind;
  }

  previous(offset = 0): Token {
    let idx = this.pos - 1;
    let remaining = offset;
    while (idx >= 0) {
      const tok = this.tokens[idx]!;
      if (this.skipTrivia && TokenStream.isTriviaToken(tok)) {
        idx--;
        continue;
      }
      if (remaining === 0) return tok;
      remaining--;
      idx--;
    }
    return this.tokens[0]!;
  }

  previousKind(offset = 0): TokenKind {
    return this.previous(offset).kind;
  }

  /**
   * Mengambil semua komentar dokumentasi (`DOC_COMMENT`) yang berada tepat sebelum token saat ini.
   */
  leadingDocComments(): string[] {
    const docs: string[] = [];
    const currentTok = this.peek();
    const currentIdx = this.tokens.indexOf(currentTok);
    if (currentIdx <= 0) return docs;

    for (let i = currentIdx - 1; i >= 0; i--) {
      const t = this.tokens[i]!;
      if (t.kind === "DOC_COMMENT") {
        docs.unshift(String(t.value ?? ""));
      } else if (t.kind === "COMMENT" || t.kind === "NEWLINE") {
        continue;
      } else {
        break;
      }
    }
    return docs;
  }

  next(): Token {
    while (this.pos < this.tokens.length) {
      const tok = this.tokens[this.pos]!;
      if (this.skipTrivia && TokenStream.isTriviaToken(tok)) {
        this.pos++;
        continue;
      }
      this.pos++;
      return tok;
    }
    return this.tokens[this.tokens.length - 1]!;
  }

  match(kind: TokenKind): boolean {
    if (this.check(kind)) {
      this.next();
      return true;
    }
    return false;
  }

  matchAny(...kinds: TokenKind[]): Token | null {
    const currentKind = this.peekKind();
    for (const k of kinds) {
      if (currentKind === k) {
        return this.next();
      }
    }
    return null;
  }

  tryConsume(kind: TokenKind): Token | null {
    if (this.check(kind)) {
      return this.next();
    }
    return null;
  }

  mark(): void {
    this.marks.push(this.pos);
  }

  reset(): void {
    const m = this.marks.pop();
    if (m === undefined) {
      throw new Error("TokenStream.reset(): tidak ada mark aktif");
    }
    this.pos = m;
  }

  commit(): void {
    const m = this.marks.pop();
    if (m === undefined) {
      throw new Error("TokenStream.commit(): tidak ada mark aktif");
    }
  }

  saveState(): number {
    return this.pos;
  }

  restoreState(state: number): void {
    if (state < 0 || state > this.tokens.length) {
      throw new Error(`TokenStream.restoreState(): state tidak valid: ${state}`);
    }
    this.pos = state;
  }

  tryParse<T>(fn: () => T | null): T | null {
    const saved = this.saveState();
    try {
      const result = fn();
      if (result === null) {
        this.restoreState(saved);
      }
      return result;
    } catch (e) {
      this.restoreState(saved);
      throw e;
    }
  }

  isAtEnd(): boolean {
    return this.peek().kind === "EOF";
  }

  get index(): number {
    return this.pos;
  }

  get length(): number {
    return this.tokens.length;
  }

  get all(): readonly Token[] {
    return this.tokens;
  }

  lastLocation(): Location {
    return this.previous().loc;
  }

  currentLocation(): Location {
    return this.peek().loc;
  }

  get skipsTrivia(): boolean {
    return this.skipTrivia;
  }

  private findLogicalIndex(rawPos: number): number {
    let lo = 0;
    let hi = this.nonTriviaIndices.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.nonTriviaIndices[mid]! < rawPos) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    return lo;
  }

  private static isTriviaToken(tok: Token): boolean {
    return (
      tok.kind === "COMMENT" ||
      tok.kind === "DOC_COMMENT" ||
      tok.kind === "BLANK_LINE"
    );
  }
}

// ============================================================
// CharClass & Fast Lookup Table
// ============================================================

const CharClass = {
  Whitespace: 0,
  Newline: 1,
  Digit: 2,
  IdentStart: 3,
  IdentPart: 4,
  Quote: 5,
  Operator: 6,
  Invalid: 7,
} as const;

type CharClassValue = (typeof CharClass)[keyof typeof CharClass];

const CHAR_TABLE: Uint8Array = (() => {
  const t = new Uint8Array(128).fill(CharClass.Invalid);
  t[32] = CharClass.Whitespace; // ' '
  t[9] = CharClass.Whitespace;  // '\t'
  t[10] = CharClass.Newline;    // '\n'
  t[13] = CharClass.Newline;    // '\r'
  for (let c = 48; c <= 57; c++) t[c] = CharClass.Digit;      // 0-9
  for (let c = 65; c <= 90; c++) t[c] = CharClass.IdentStart; // A-Z
  for (let c = 97; c <= 122; c++) t[c] = CharClass.IdentStart;// a-z
  t[95] = CharClass.IdentStart; // '_'
  t[34] = CharClass.Quote;      // '"'
  t[39] = CharClass.Quote;      // "'"
  return t;
})();

const UNICODE_IDENT_START = /[\p{ID_Start}_]/u;
const UNICODE_IDENT_CONTINUE = /[\p{ID_Continue}]/u;

function classifyCodePoint(cp: number): CharClassValue {
  if (cp < 128) return CHAR_TABLE[cp] as CharClassValue;
  const ch = String.fromCodePoint(cp);
  if (UNICODE_IDENT_START.test(ch)) return CharClass.IdentStart;
  if (UNICODE_IDENT_CONTINUE.test(ch)) return CharClass.IdentPart;
  return CharClass.Invalid;
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
// Lexer Options & Metrics
// ============================================================

export interface LexerOptions {
  readonly file: string;
  readonly reporter: Reporter;
  readonly preserveTrivia?: boolean;
  readonly recoverOnError?: boolean;
  /** Ukuran spasi standar per level indentasi (untuk validasi peringatan). Default: 4. */
  readonly indentSize?: number;
}

export interface LexerMetrics {
  readonly file: string;
  readonly tokenCount: number;
  readonly lineCount: number;
  readonly errorCount: number;
  readonly durationMs: number;
}

// ============================================================
// Lexer
// ============================================================

export class Lexer {
  private readonly source: string;
  private readonly file: string;
  private readonly reporter: Reporter;
  private readonly preserveTrivia: boolean;
  private readonly recoverOnError: boolean;
  private readonly indentSize: number;
  readonly sourceMap: SourceMap;

  private pos = 0;
  private errorCount = 0;
  private lastMetrics: LexerMetrics | null = null;

  private readonly tokens: Token[] = [];
  private readonly indentStack: number[] = [0];
  private readonly bracketStack: BracketFrame[] = [];
  private readonly interpStack: InterpFrame[] = [];
  private atLineStart = true;
  private recovering = false;

  constructor(source: string, opts: LexerOptions) {
    this.source = source;
    this.file = opts.file;
    this.reporter = opts.reporter;
    this.preserveTrivia = opts.preserveTrivia ?? false;
    this.recoverOnError = opts.recoverOnError ?? true;
    this.indentSize = opts.indentSize ?? 4;
    this.sourceMap = new SourceMap(source);
  }

  tokenize(): TokenStream {
    const startTime = performance.now();

    // Lewati UTF-8 BOM jika ada di awal file
    if (this.source.charCodeAt(0) === 0xfeff) {
      this.pos = 1;
    }

    // Lewati baris Shebang (`#!/usr/bin/env ...`) di baris pertama
    if (this.peek() === "#" && this.peekAt(1) === "!") {
      while (!this.isAtEnd() && this.peek() !== "\n" && this.peek() !== "\r") {
        this.advance();
      }
      this.consumeNewline();
    }

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

    this.lastMetrics = {
      file: this.file,
      tokenCount: this.tokens.length,
      lineCount: this.sourceMap.lineCount,
      errorCount: this.errorCount,
      durationMs: performance.now() - startTime,
    };

    return new TokenStream(this.tokens, !this.preserveTrivia);
  }

  tokenizeWithTrivia(): TokenStream {
    const lexerWithTrivia = new Lexer(this.source, {
      file: this.file,
      reporter: this.reporter,
      preserveTrivia: true,
      recoverOnError: this.recoverOnError,
      indentSize: this.indentSize,
    });
    return lexerWithTrivia.tokenize();
  }

  getMetrics(): LexerMetrics | null {
    return this.lastMetrics;
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

      if (this.peek() === "\t") {
        const startPos = this.sourceMap.position(lineStartOffset);
        while (this.peek() === "\t" || this.peek() === " ") {
          this.advance();
        }
        const endPos = this.sourceMap.position(this.pos);
        this.reportError({
          code: ErrorCode.INVALID_INDENT,
          message: "karakter tab tidak diizinkan untuk indentasi",
          location: { start: startPos, end: endPos, file: this.file },
          helps: [`gunakan ${this.indentSize} spasi per level indentasi`],
        });
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

      // Baris yang hanya berisi komentar
      if (c === "#") {
        this.readComment(true);
        continue;
      }

      if (this.bracketStack.length === 0 && this.interpStack.length === 0) {
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
        this.reportError({
          code: ErrorCode.INVALID_INDENT,
          message: `indentasi tidak konsisten: ditemukan ${spaces} spasi, tetapi level blok sebelumnya adalah ${nowTop} spasi`,
          location: { start: pos, end: endPos, file: this.file },
          helps: [`pastikan setiap blok sejajar dengan kelipatan ${this.indentSize} spasi`],
        });
      }
    }
  }

  // ==========================================================
  // Main Token Scanner
  // ==========================================================

  private scanToken(): void {
    // Lewati spasi horizontal dan line-continuation (`\` diikuti newline)
    while (!this.isAtEnd()) {
      const ch = this.peek();
      if (ch === " " || ch === "\t") {
        this.advance();
        continue;
      }
      if (
        ch === "\\" &&
        (this.peekAt(1) === "\n" ||
          (this.peekAt(1) === "\r" && this.peekAt(2) === "\n"))
      ) {
        this.advance(); // consume '\'
        this.consumeNewline();
        continue;
      }
      break;
    }

    if (this.isAtEnd()) return;

    const cp = this.peekCodePoint();
    const cls = classifyCodePoint(cp);

    switch (cls) {
      case CharClass.Newline:
        this.scanNewline();
        return;
      case CharClass.Quote:
        this.readString(false);
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

    if (this.peek() === "#") {
      // Komentar di ujung baris kode (inline trailing comment):
      // JANGAN menelan token NEWLINE agar statement sebelum `#` tetap memiliki terminator baris!
      this.readComment(false);
      return;
    }

    this.readOperator();
  }

  private scanNewline(): void {
    const startOffset = this.pos;
    this.consumeNewline();

    if (this.bracketStack.length === 0 && this.interpStack.length === 0) {
      const start = this.sourceMap.position(startOffset);
      const end = this.sourceMap.position(this.pos);
      this.emitToken("NEWLINE", null, start, end);
      this.atLineStart = true;
    }
  }

  /**
   * Membaca komentar `# ...` atau dokumentasi `## ...`.
   * @param isFullLine - `true` jika komentar berada di awal baris (tanpa kode sebelumnya),
   *                     `false` jika komentar berada di belakang statement pada baris yang sama.
   */
  private readComment(isFullLine: boolean): void {
    const startOffset = this.pos;
    const isDoc = this.peekAt(1) === "#" && this.peekAt(2) !== "#";

    while (!this.isAtEnd() && this.peek() !== "\n" && this.peek() !== "\r") {
      this.advance();
    }

    const raw = this.source.slice(startOffset, this.pos);
    const body = isDoc ? raw.slice(2).trim() : raw.slice(1).trim();
    const start = this.sourceMap.position(startOffset);
    const end = this.sourceMap.position(this.pos);

    if (this.preserveTrivia) {
      this.emitToken(isDoc ? "DOC_COMMENT" : "COMMENT", body, start, end, raw);
    }

    // Jika komentar satu baris penuh, langsung konsumsi newline dan kembali ke state awal baris.
    // Jika komentar berada di belakang kode (inline), biarkan karakter `\n` dibaca oleh
    // `scanNewline()` pada iterasi berikutnya agar token `NEWLINE` tetap dipancarkan!
    if (isFullLine && !this.isAtEnd()) {
      this.consumeNewline();
      this.atLineStart = true;
    }
  }

  private readIdentifierOrKeyword(): void {
    const startOffset = this.pos;

    // Deteksi Raw String: `r"..."`, `r'...'`, `r"""..."""`, `r'''...'''`
    if (
      this.peek() === "r" &&
      (this.peekAt(1) === '"' || this.peekAt(1) === "'")
    ) {
      this.advance(); // consume 'r'
      this.readString(true, startOffset);
      return;
    }

    while (!this.isAtEnd()) {
      const cp = this.peekCodePoint();
      const cls = classifyCodePoint(cp);
      if (
        cls === CharClass.IdentStart ||
        cls === CharClass.IdentPart ||
        cls === CharClass.Digit
      ) {
        this.advanceCodePoint(cp);
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
  // Number Literal & Strict Separator Validation
  // ==========================================================

  private readNumber(): void {
    const startOffset = this.pos;

    if (this.peek() === "0") {
      const next = this.peekAt(1);
      if (next === "x" || next === "X") {
        return this.readRadix(16, startOffset, /[0-9a-fA-F]/, "heksadesimal");
      }
      if (next === "b" || next === "B") {
        return this.readRadix(2, startOffset, /[01]/, "biner");
      }
      if (next === "o" || next === "O") {
        return this.readRadix(8, startOffset, /[0-7]/, "oktal");
      }
    }

    this.scanDigitsWithUnderscores(startOffset, "desimal");

    // Bagian pecahan desimal `.123` (pastikan bukan operator `..` atau method call `10.toString()`)
    if (
      this.peek() === "." &&
      this.peekAt(1) !== "." &&
      this.isDigit(this.peekAt(1))
    ) {
      this.advance(); // consume '.'
      this.scanDigitsWithUnderscores(startOffset, "pecahan desimal");
    }

    // Bagian eksponen ilmiah `e` / `E`
    const e = this.peek();
    if (e === "e" || e === "E") {
      this.advance(); // consume 'e'/'E'
      if (this.peek() === "+" || this.peek() === "-") {
        this.advance();
      }
      if (!this.isDigit(this.peek())) {
        const start = this.sourceMap.position(startOffset);
        const end = this.sourceMap.position(this.pos);
        this.reportError({
          code: ErrorCode.INVALID_NUMBER_LITERAL,
          message: `notasi ilmiah tidak memiliki digit eksponen: \`${this.source.slice(startOffset, this.pos)}\``,
          location: { start, end, file: this.file },
          helps: ["tambahkan angka setelah `e`, misalnya `1.5e10` atau `2e-3`"],
        });
        this.recovering = this.recoverOnError;
        return;
      }
      this.scanDigitsWithUnderscores(startOffset, "eksponen");
    }

    this.finishNumber(startOffset, 10);
  }

  private scanDigitsWithUnderscores(startOffset: number, partName: string): void {
    let prevUnderscore = false;
    while (this.isDigit(this.peek()) || this.peek() === "_") {
      if (this.peek() === "_") {
        if (prevUnderscore) {
          this.reportError({
            code: ErrorCode.INVALID_NUMBER_LITERAL,
            message: `pemisah angka \`_\` tidak boleh berurutan ganda pada bagian ${partName}`,
            location: {
              start: this.sourceMap.position(startOffset),
              end: this.sourceMap.position(this.pos + 1),
              file: this.file,
            },
          });
        }
        prevUnderscore = true;
      } else {
        prevUnderscore = false;
      }
      this.advance();
    }

    if (prevUnderscore) {
      this.reportError({
        code: ErrorCode.INVALID_NUMBER_LITERAL,
        message: `angka tidak boleh diakhiri dengan pemisah \`_\``,
        location: {
          start: this.sourceMap.position(startOffset),
          end: this.sourceMap.position(this.pos),
          file: this.file,
        },
      });
    }
  }

  private readRadix(
    radix: number,
    startOffset: number,
    validDigit: RegExp,
    radixLabel: string,
  ): void {
    this.advance(); // '0'
    this.advance(); // 'x' | 'b' | 'o'

    if (this.peek() === "_") {
      this.reportError({
        code: ErrorCode.INVALID_NUMBER_LITERAL,
        message: `pemisah \`_\` tidak boleh langsung mengikuti prefix angka ${radixLabel}`,
        location: {
          start: this.sourceMap.position(startOffset),
          end: this.sourceMap.position(this.pos + 1),
          file: this.file,
        },
      });
    }

    let digitCount = 0;
    let prevUnderscore = false;

    while (!this.isAtEnd()) {
      const ch = this.peek();
      if (ch === "_") {
        if (prevUnderscore) {
          this.reportError({
            code: ErrorCode.INVALID_NUMBER_LITERAL,
            message: `pemisah \`_\` ganda tidak valid pada angka ${radixLabel}`,
            location: {
              start: this.sourceMap.position(startOffset),
              end: this.sourceMap.position(this.pos + 1),
              file: this.file,
            },
          });
        }
        prevUnderscore = true;
        this.advance();
        continue;
      }

      if (validDigit.test(ch)) {
        digitCount++;
        prevUnderscore = false;
        this.advance();
        continue;
      }

      // Tangkap digit alfanumerik yang salah basis (misal `0b102` atau `0o78`)
      if (/[0-9a-zA-Z]/.test(ch)) {
        const badOffset = this.pos;
        while (/[0-9a-zA-Z_]/.test(this.peek())) this.advance();
        this.reportError({
          code: ErrorCode.INVALID_NUMBER_LITERAL,
          message: `digit \`${ch}\` tidak valid untuk angka ${radixLabel} (\`${this.source.slice(startOffset, this.pos)}\`)`,
          location: {
            start: this.sourceMap.position(badOffset),
            end: this.sourceMap.position(this.pos),
            file: this.file,
          },
        });
        this.recovering = this.recoverOnError;
        return;
      }

      break;
    }

    if (digitCount === 0 || prevUnderscore) {
      this.reportError({
        code: ErrorCode.INVALID_NUMBER_LITERAL,
        message:
          digitCount === 0
            ? `angka ${radixLabel} harus memiliki minimal satu digit setelah prefix`
            : `angka ${radixLabel} tidak boleh diakhiri dengan \`_\``,
        location: {
          start: this.sourceMap.position(startOffset),
          end: this.sourceMap.position(this.pos),
          file: this.file,
        },
      });
      this.recovering = this.recoverOnError;
      return;
    }

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
      this.reportError({
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
  // String & Interpolation
  // ==========================================================

  private readString(isRaw = false, customStartOffset?: number): void {
    const startOffset = customStartOffset ?? this.pos;
    const quote = this.peek()!;

    // Cek triple-quote `"""` atau `'''` (baik biasa maupun raw `r"""`)
    if (this.peekAt(1) === quote && this.peekAt(2) === quote) {
      return this.readMultilineString(quote, isRaw, startOffset);
    }

    this.advance(); // consume opening quote

    let buffer = "";

    while (!this.isAtEnd()) {
      const c = this.peek();

      // Penutup string
      if (c === quote) {
        this.advance();
        const start = this.sourceMap.position(startOffset);
        const end = this.sourceMap.position(this.pos);
        const raw = this.source.slice(startOffset, this.pos);

        this.emitToken(
          isRaw ? "RAW_STRING" : "STRING",
          buffer,
          start,
          end,
          raw,
        );
        return;
      }

      // Mulai interpolasi `${`
      if (!isRaw && c === "$" && this.peekAt(1) === "{") {
        const interpOffset = this.pos;
        this.advance(); // '$'
        this.advance(); // '{'
        const start = this.sourceMap.position(startOffset);
        const end = this.sourceMap.position(this.pos);
        const raw = this.source.slice(startOffset, this.pos);

        this.emitToken("STRING_INTERP_START", buffer, start, end, raw);
        this.interpStack.push({
          quote,
          multiline: false,
          startOffset: interpOffset,
          braceDepth: 0,
        });
        return;
      }

      // Escape sequence
      if (c === "\\") {
        if (isRaw) {
          // Dalam raw string, `\"` atau `\\` tetap menjaga karakter di dalam string
          buffer += "\\";
          this.advance();
          if (!this.isAtEnd() && this.peek() !== "\n" && this.peek() !== "\r") {
            buffer += this.peek();
            this.advance();
          }
          continue;
        }

        this.advance(); // consume '\'
        // Dukung line continuation di dalam string
        if (this.peek() === "\n" || this.peek() === "\r") {
          this.consumeNewline();
          continue;
        }
        const decoded = this.decodeEscape(startOffset);
        if (decoded === null) {
          this.recovering = this.recoverOnError;
          return;
        }
        buffer += decoded;
        continue;
      }

      // Newline di string satu baris = error
      if (c === "\n" || c === "\r") {
        const start = this.sourceMap.position(startOffset);
        const end = this.sourceMap.position(this.pos);
        this.reportError({
          code: ErrorCode.UNTERMINATED_STRING,
          message: `string tidak ditutup dengan \`${quote}\` sebelum akhir baris`,
          location: { start, end, file: this.file },
          helps: [
            `gunakan ${quote.repeat(3)}...${quote.repeat(3)} untuk string multi-baris`,
            "atau tutup tanda kutip di baris ini",
          ],
        });
        this.recovering = this.recoverOnError;
        return;
      }

      const cp = this.peekCodePoint();
      buffer += String.fromCodePoint(cp);
      this.advanceCodePoint(cp);
    }

    const start = this.sourceMap.position(startOffset);
    const end = this.sourceMap.position(this.pos);
    this.reportError({
      code: ErrorCode.UNTERMINATED_STRING,
      message: "string tidak ditutup sampai akhir file",
      location: { start, end, file: this.file },
    });
  }

  private readMultilineString(
    quote: string,
    isRaw: boolean,
    startOffset: number,
  ): void {
    this.advance();
    this.advance();
    this.advance();

    // Jika langsung diikuti newline tepat setelah `"""`, lewati newline pembuka pertama (Python-style)
    if (this.peek() === "\r" || this.peek() === "\n") {
      this.consumeNewline();
    }

    let buffer = "";

    while (!this.isAtEnd()) {
      const c = this.peek();

      if (
        c === quote &&
        this.peekAt(1) === quote &&
        this.peekAt(2) === quote
      ) {
        this.advance();
        this.advance();
        this.advance();
        const start = this.sourceMap.position(startOffset);
        const end = this.sourceMap.position(this.pos);
        const raw = this.source.slice(startOffset, this.pos);
        this.emitToken(
          isRaw ? "RAW_STRING" : "MULTILINE_STRING",
          buffer,
          start,
          end,
          raw,
        );
        return;
      }

      // Interpolasi `${` di dalam multiline string (kecuali raw)
      if (!isRaw && c === "$" && this.peekAt(1) === "{") {
        const interpOffset = this.pos;
        this.advance();
        this.advance();
        const start = this.sourceMap.position(startOffset);
        const end = this.sourceMap.position(this.pos);
        const raw = this.source.slice(startOffset, this.pos);

        this.emitToken("STRING_INTERP_START", buffer, start, end, raw);
        this.interpStack.push({
          quote,
          multiline: true,
          startOffset: interpOffset,
          braceDepth: 0,
        });
        return;
      }

      if (!isRaw && c === "\\") {
        this.advance();
        if (this.peek() === "\n" || this.peek() === "\r") {
          this.consumeNewline();
          continue;
        }
        const decoded = this.decodeEscape(startOffset);
        if (decoded === null) return;
        buffer += decoded;
        continue;
      }

      if (c === "\r" && this.peekAt(1) === "\n") {
        this.pos += 2;
        buffer += "\n";
        continue;
      }

      const cp = this.peekCodePoint();
      buffer += String.fromCodePoint(cp);
      this.advanceCodePoint(cp);
    }

    const start = this.sourceMap.position(startOffset);
    const end = this.sourceMap.position(this.pos);
    this.reportError({
      code: ErrorCode.UNTERMINATED_STRING,
      message: `multi-line string tidak ditutup dengan ${quote.repeat(3)}`,
      location: { start, end, file: this.file },
    });
  }

  /**
   * Mendekode escape sequence setelah backslash `\`.
   * Mendukung `\n`, `\t`, `\r`, `\b`, `\f`, `\v`, `\\`, `\"`, `\'`, `\$`, `\0`,
   * `\xHH` (2 digit hex), `\uXXXX` (4 digit hex), dan `\u{X...X}` (kode poin Unicode).
   */
  private decodeEscape(stringStartOffset: number): string | null {
    const esc = this.peek();

    switch (esc) {
      case "n": this.advance(); return "\n";
      case "t": this.advance(); return "\t";
      case "r": this.advance(); return "\r";
      case "b": this.advance(); return "\b";
      case "f": this.advance(); return "\f";
      case "v": this.advance(); return "\v";
      case "\\": this.advance(); return "\\";
      case '"': this.advance(); return '"';
      case "'": this.advance(); return "'";
      case "$": this.advance(); return "$";
      case "0": this.advance(); return "\0";
      case "x": {
        this.advance(); // consume 'x'
        return this.readHexEscape(2, "\\xHH");
      }
      case "u": {
        this.advance(); // consume 'u'
        if (this.peek() === "{") {
          this.advance(); // consume '{'
          const hexStart = this.pos;
          while (!this.isAtEnd() && this.peek() !== "}" && /[0-9a-fA-F]/.test(this.peek())) {
            this.advance();
          }
          const hexDigits = this.source.slice(hexStart, this.pos);
          if (this.peek() !== "}" || hexDigits.length === 0 || hexDigits.length > 6) {
            this.reportError({
              code: ErrorCode.INVALID_STRING_LITERAL,
              message: "escape Unicode `\\u{...}` tidak valid (harus 1-6 digit heksadesimal)",
              location: {
                start: this.sourceMap.position(hexStart - 3),
                end: this.sourceMap.position(this.pos + 1),
                file: this.file,
              },
            });
            if (this.peek() === "}") this.advance();
            return "\uFFFD";
          }
          this.advance(); // consume '}'
          const codePoint = parseInt(hexDigits, 16);
          if (codePoint > 0x10ffff) {
            this.reportError({
              code: ErrorCode.INVALID_STRING_LITERAL,
              message: `nilai kode poin Unicode \\u{${hexDigits}} melebihi batas maksimum 0x10FFFF`,
              location: {
                start: this.sourceMap.position(hexStart - 3),
                end: this.sourceMap.position(this.pos),
                file: this.file,
              },
            });
            return "\uFFFD";
          }
          return String.fromCodePoint(codePoint);
        }
        return this.readHexEscape(4, "\\uXXXX");
      }
      case "":
        this.reportError({
          code: ErrorCode.UNTERMINATED_STRING,
          message: "string berakhir tepat setelah backslash `\\`",
          location: {
            start: this.sourceMap.position(stringStartOffset),
            end: this.sourceMap.position(this.pos),
            file: this.file,
          },
        });
        return null;
      default: {
        const pos = this.sourceMap.position(this.pos - 1);
        this.reportError({
          code: ErrorCode.INVALID_STRING_LITERAL,
          message: `escape sequence tidak dikenal: \`\\${esc}\``,
          location: {
            start: pos,
            end: this.sourceMap.position(this.pos + 1),
            file: this.file,
          },
          helps: [
            "escape yang valid: \\n \\t \\r \\b \\f \\v \\\\ \\\" \\' \\$ \\0 \\xHH \\uXXXX \\u{...}",
          ],
        });
        this.advance();
        return esc;
      }
    }
  }

  private readHexEscape(length: number, formatHint: string): string {
    const start = this.pos - 2;
    let hex = "";
    for (let i = 0; i < length; i++) {
      const ch = this.peek();
      if (!/[0-9a-fA-F]/.test(ch)) {
        this.reportError({
          code: ErrorCode.INVALID_STRING_LITERAL,
          message: `escape heksadesimal tidak lengkap; diharapkan format \`${formatHint}\``,
          location: {
            start: this.sourceMap.position(start),
            end: this.sourceMap.position(this.pos + 1),
            file: this.file,
          },
        });
        return "\uFFFD";
      }
      hex += ch;
      this.advance();
    }
    return String.fromCharCode(parseInt(hex, 16));
  }

  /**
   * Lanjutkan membaca string setelah `}` menutup ekspresi interpolasi `${...}`.
   */
  private readStringContinuation(frame: InterpFrame): void {
    const startOffset = this.pos;
    const { quote, multiline } = frame;
    let buffer = "";

    while (!this.isAtEnd()) {
      const c = this.peek();

      // Penutup string
      if (multiline) {
        if (
          c === quote &&
          this.peekAt(1) === quote &&
          this.peekAt(2) === quote
        ) {
          this.advance();
          this.advance();
          this.advance();
          const start = this.sourceMap.position(startOffset);
          const end = this.sourceMap.position(this.pos);
          const raw = this.source.slice(startOffset, this.pos);
          this.emitToken("STRING_INTERP_END", buffer, start, end, raw);
          return;
        }
      } else if (c === quote) {
        this.advance();
        const start = this.sourceMap.position(startOffset);
        const end = this.sourceMap.position(this.pos);
        const raw = this.source.slice(startOffset, this.pos);
        this.emitToken("STRING_INTERP_END", buffer, start, end, raw);
        return;
      }

      // Interpolasi lanjutan `${`
      if (c === "$" && this.peekAt(1) === "{") {
        const nextInterpOffset = this.pos;
        this.advance();
        this.advance();
        const start = this.sourceMap.position(startOffset);
        const end = this.sourceMap.position(this.pos);
        const raw = this.source.slice(startOffset, this.pos);
        this.emitToken("STRING_INTERP_MIDDLE", buffer, start, end, raw);
        this.interpStack.push({
          quote,
          multiline,
          startOffset: nextInterpOffset,
          braceDepth: 0,
        });
        return;
      }

      // Escape
      if (c === "\\") {
        this.advance();
        if (this.peek() === "\n" || this.peek() === "\r") {
          this.consumeNewline();
          continue;
        }
        const decoded = this.decodeEscape(startOffset);
        if (decoded === null) return;
        buffer += decoded;
        continue;
      }

      if (!multiline && (c === "\n" || c === "\r")) {
        const start = this.sourceMap.position(startOffset);
        const end = this.sourceMap.position(this.pos);
        this.reportError({
          code: ErrorCode.UNTERMINATED_STRING,
          message: "string berinterpolasi tidak ditutup di akhir baris",
          location: { start, end, file: this.file },
        });
        this.recovering = this.recoverOnError;
        return;
      }

      if (multiline && c === "\r" && this.peekAt(1) === "\n") {
        this.pos += 2;
        buffer += "\n";
        continue;
      }

      const cp = this.peekCodePoint();
      buffer += String.fromCodePoint(cp);
      this.advanceCodePoint(cp);
    }

    const start = this.sourceMap.position(startOffset);
    const end = this.sourceMap.position(this.pos);
    this.reportError({
      code: ErrorCode.UNTERMINATED_STRING,
      message: "string berinterpolasi tidak ditutup sampai akhir file",
      location: { start, end, file: this.file },
    });
  }

  // ==========================================================
  // Operators & Bracket Balance Tracking
  // ==========================================================

  private pushBracket(open: "(" | "[" | "{", offset: number): void {
    const expectedClose = open === "(" ? ")" : open === "[" ? "]" : "}";
    this.bracketStack.push({ open, expectedClose, offset });
  }

  private popBracket(close: ")" | "]" | "}", closeOffset: number): void {
    if (this.bracketStack.length === 0) {
      this.reportError({
        code: ErrorCode.UNEXPECTED_TOKEN,
        message: `kurung tutup \`${close}\` tidak memiliki pasangan kurung buka`,
        location: {
          start: this.sourceMap.position(closeOffset),
          end: this.sourceMap.position(this.pos),
          file: this.file,
        },
      });
      return;
    }

    const top = this.bracketStack[this.bracketStack.length - 1]!;
    if (top.expectedClose !== close) {
      const openPos = this.sourceMap.position(top.offset);
      this.reportError({
        code: ErrorCode.UNEXPECTED_TOKEN,
        message: `kurung tutup \`${close}\` tidak cocok dengan \`${top.open}\` yang dibuka di baris ${openPos.line}:${openPos.column} (diharapkan \`${top.expectedClose}\`)`,
        location: {
          start: this.sourceMap.position(closeOffset),
          end: this.sourceMap.position(this.pos),
          file: this.file,
        },
      });
    }
    this.bracketStack.pop();
  }

  private readOperator(): void {
    const startOffset = this.pos;
    const c = this.peek();
    this.advance();

    let kind: TokenKind | null = null;

    switch (c) {
      case "(":
        this.pushBracket("(", startOffset);
        kind = "LPAREN";
        break;
      case ")":
        this.popBracket(")", startOffset);
        kind = "RPAREN";
        break;
      case "[":
        this.pushBracket("[", startOffset);
        kind = "LBRACKET";
        break;
      case "]":
        this.popBracket("]", startOffset);
        kind = "RBRACKET";
        break;
      case "{": {
        this.pushBracket("{", startOffset);
        if (this.interpStack.length > 0) {
          const top = this.interpStack[this.interpStack.length - 1]!;
          top.braceDepth++;
        }
        kind = "LBRACE";
        break;
      }
      case "}": {
        if (this.interpStack.length > 0) {
          const top = this.interpStack[this.interpStack.length - 1]!;
          if (top.braceDepth > 0) {
            top.braceDepth--;
            this.popBracket("}", startOffset);
            kind = "RBRACE";
            break;
          }
          // `}` menutup ekspresi interpolasi `${...}`
          const finishedFrame = this.interpStack.pop()!;
          this.readStringContinuation(finishedFrame);
          return;
        }
        this.popBracket("}", startOffset);
        kind = "RBRACE";
        break;
      }
      case ",": kind = "COMMA"; break;
      case ":": kind = "COLON"; break;
      case "?": kind = "QUESTION"; break;
      case ".":
        if (this.peek() === ".") {
          this.advance();
          kind = "DOT_DOT";
        } else {
          kind = "DOT";
        }
        break;
      case "-":
        if (this.peek() === ">") {
          this.advance();
          kind = "ARROW";
        } else if (this.peek() === "=") {
          this.advance();
          kind = "MINUS_EQ";
        } else if (this.peek() === "-") {
          this.advance();
          this.errorAt(
            ErrorCode.INVALID_CHARACTER,
            "operator `--` tidak didukung di Snake Script",
            startOffset,
            ["gunakan `x -= 1` untuk mengurangi nilai variabel"],
          );
          return;
        } else {
          kind = "MINUS";
        }
        break;
      case "+":
        if (this.peek() === "=") {
          this.advance();
          kind = "PLUS_EQ";
        } else if (this.peek() === "+") {
          this.advance();
          this.errorAt(
            ErrorCode.INVALID_CHARACTER,
            "operator `++` tidak didukung di Snake Script",
            startOffset,
            ["gunakan `x += 1` untuk menambah nilai variabel"],
          );
          return;
        } else {
          kind = "PLUS";
        }
        break;
      case "*":
        if (this.peek() === "*") {
          this.advance();
          kind = "STAR_STAR";
        } else if (this.peek() === "=") {
          this.advance();
          kind = "STAR_EQ";
        } else {
          kind = "STAR";
        }
        break;
      case "/":
        if (this.peek() === "/") {
          // Banyak pengguna dari JS/C++ menulis `//` untuk komentar
          while (!this.isAtEnd() && this.peek() !== "\n" && this.peek() !== "\r") {
            this.advance();
          }
          this.errorAt(
            ErrorCode.INVALID_CHARACTER,
            "komentar `//` tidak valid di Snake Script",
            startOffset,
            ["gunakan tanda pagar `#` untuk menulis komentar"],
          );
          return;
        } else if (this.peek() === "=") {
          this.advance();
          kind = "SLASH_EQ";
        } else {
          kind = "SLASH";
        }
        break;
      case "%":
        if (this.peek() === "=") {
          this.advance();
          kind = "PERCENT_EQ";
        } else {
          kind = "PERCENT";
        }
        break;
      case "=":
        if (this.peek() === "=") {
          this.advance();
          if (this.peek() === "=") {
            this.advance();
            this.errorAt(
              ErrorCode.INVALID_CHARACTER,
              "operator `===` tidak diperlukan — `==` di Snake Script sudah memeriksa kesetaraan ketat",
              startOffset,
              ["gunakan `==` untuk membandingkan nilai"],
            );
            kind = "EQ_EQ";
            break;
          }
          kind = "EQ_EQ";
        } else if (this.peek() === ">") {
          this.advance();
          kind = "FAT_ARROW";
        } else {
          kind = "EQ";
        }
        break;
      case "!":
        if (this.peek() === "=") {
          this.advance();
          if (this.peek() === "=") {
            this.advance();
            this.errorAt(
              ErrorCode.INVALID_CHARACTER,
              "operator `!==` tidak diperlukan — gunakan `!=`",
              startOffset,
              ["gunakan `!=` untuk membandingkan ketidaksamaan"],
            );
          }
          kind = "BANG_EQ";
        } else {
          this.errorAt(
            ErrorCode.INVALID_CHARACTER,
            "`!` tidak valid — gunakan `not` untuk negasi logika",
            startOffset,
            ["Snake Script menggunakan kata kunci `not`, bukan `!`"],
          );
          return;
        }
        break;
      case "<":
        if (this.peek() === "=") {
          this.advance();
          kind = "LT_EQ";
        } else {
          kind = "LT";
        }
        break;
      case ">":
        if (this.peek() === "=") {
          this.advance();
          kind = "GT_EQ";
        } else {
          kind = "GT";
        }
        break;
      case "|":
        if (this.peek() === "|") {
          this.advance();
          this.errorAt(
            ErrorCode.INVALID_CHARACTER,
            "`||` tidak valid — gunakan `or` untuk disjungsi logika",
            startOffset,
            ["Snake Script menggunakan kata kunci `or`, bukan `||`"],
          );
          return;
        }
        kind = "PIPE";
        break;
      case "&":
        if (this.peek() === "&") this.advance();
        this.errorAt(
          ErrorCode.INVALID_CHARACTER,
          "`&` / `&&` tidak valid — gunakan `and` untuk konjungsi logika",
          startOffset,
          ["Snake Script menggunakan kata kunci `and`, bukan `&&`"],
        );
        return;
      case ";":
        this.errorAt(
          ErrorCode.INVALID_CHARACTER,
          "titik koma `;` tidak digunakan di Snake Script",
          startOffset,
          ["akhiri setiap statement cukup dengan baris baru (newline)"],
        );
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
  // Finalization
  // ==========================================================

  private emitFinal(): void {
    const pos = this.sourceMap.position(this.pos);

    // Laporkan kurung buka yang belum ditutup sampai akhir file
    while (this.bracketStack.length > 0) {
      const unclosed = this.bracketStack.pop()!;
      const openPos = this.sourceMap.position(unclosed.offset);
      const openEndPos = this.sourceMap.position(unclosed.offset + 1);
      this.reportError({
        code: ErrorCode.UNEXPECTED_TOKEN,
        message: `kurung \`${unclosed.open}\` tidak pernah ditutup dengan \`${unclosed.expectedClose}\` sampai akhir file`,
        location: { start: openPos, end: openEndPos, file: this.file },
      });
    }

    // Laporkan interpolasi yang belum ditutup
    if (this.interpStack.length > 0) {
      const unclosedInterp = this.interpStack[this.interpStack.length - 1]!;
      const interpPos = this.sourceMap.position(unclosedInterp.startOffset);
      this.reportError({
        code: ErrorCode.UNTERMINATED_STRING,
        message: "interpolasi `${...}` tidak ditutup dengan `}`",
        location: { start: interpPos, end: pos, file: this.file },
      });
      this.interpStack.length = 0;
    }

    const lastBeforeDedent = this.lastNonTrivia();
    if (
      lastBeforeDedent &&
      lastBeforeDedent.kind !== "NEWLINE" &&
      lastBeforeDedent.kind !== "DEDENT"
    ) {
      this.emitSynthetic("NEWLINE", pos);
    }

    while (this.indentStack.length > 1) {
      this.indentStack.pop();
      this.emitSynthetic("DEDENT", pos);
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
  // Error Recovery & Reporting
  // ==========================================================

  private skipToLineEnd(): void {
    while (!this.isAtEnd() && this.peek() !== "\n" && this.peek() !== "\r") {
      this.advance();
    }
    if (!this.isAtEnd()) {
      const nlStart = this.pos;
      this.consumeNewline();
      if (this.bracketStack.length === 0) {
        this.emitToken(
          "NEWLINE",
          null,
          this.sourceMap.position(nlStart),
          this.sourceMap.position(this.pos),
        );
      }
    }
    this.atLineStart = true;
    this.interpStack.length = 0;
  }

  private reportError(diag: {
    code: string;
    message: string;
    location: Location;
    helps?: readonly string[];
  }): void {
    this.errorCount++;
    this.reporter.report({
      severity: "error",
      code: diag.code,
      message: diag.message,
      location: diag.location,
      helps: diag.helps ? [...diag.helps] : undefined,
    });
  }

  private errorAt(
    code: string,
    message: string,
    startOffset: number,
    helps?: readonly string[],
  ): void {
    const start = this.sourceMap.position(startOffset);
    const end = this.sourceMap.position(this.pos);
    this.reportError({
      code,
      message,
      location: { start, end, file: this.file },
      helps,
    });
    this.recovering = this.recoverOnError;
  }

  // ==========================================================
  // Character Navigation (Unicode CodePoint Aware)
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

  private peekCodePoint(): number {
    return this.source.codePointAt(this.pos) ?? 0;
  }

  private advance(): void {
    this.pos++;
  }

  private advanceCodePoint(cp: number): void {
    this.pos += cp > 0xffff ? 2 : 1;
  }

  private consumeNewline(): void {
    if (this.peek() === "\r" && this.peekAt(1) === "\n") {
      this.pos += 2;
    } else if (this.peek() === "\n" || this.peek() === "\r") {
      this.pos += 1;
    }
  }

  private isDigit(c: string): boolean {
    return c >= "0" && c <= "9";
  }

  // ==========================================================
  // Token Emission
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

  private emitSynthetic(kind: TokenKind, pos: Position): void {
    this.tokens.push({
      kind,
      value: null,
      raw: "",
      loc: { start: pos, end: pos, file: this.file },
    });
  }

  private emitTrivia(
    kind: TokenKind,
    startOffset: number,
    endOffset: number,
  ): void {
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
// Convenience & Debug Formatting
// ============================================================

export function lex(
  source: string,
  file: string,
  reporter: Reporter,
  options: Omit<LexerOptions, "file" | "reporter"> = {},
): TokenStream {
  const lexer = new Lexer(source, { file, reporter, ...options });
  return lexer.tokenize();
}

export function lexWithMetrics(
  source: string,
  file: string,
  reporter: Reporter,
  options: Omit<LexerOptions, "file" | "reporter"> = {},
): { stream: TokenStream; metrics: LexerMetrics; sourceMap: SourceMap } {
  const lexer = new Lexer(source, { file, reporter, ...options });
  const stream = lexer.tokenize();
  return {
    stream,
    metrics: lexer.getMetrics()!,
    sourceMap: lexer.sourceMap,
  };
}
