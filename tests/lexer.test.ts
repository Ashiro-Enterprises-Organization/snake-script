/**
 * Snake Script — Lexer Tests
 *
 * Test suite untuk src/lexer.ts.
 *
 * Struktur:
 * - Helper kecil untuk setup lexer + reporter
 * - Group per kategori: literals, keywords, operators, indentation,
 *   strings, interpolation, error handling, position tracking
 * - Setiap test fokus pada satu perilaku — gagal berarti jelas apa yang rusak
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  Lexer,
  TokenStream,
  SourceMap,
  lex,
  type Token,
  type TokenKind,
} from "../src/lexer.ts";
import { Reporter, clearSourceCache } from "../src/diagnostics.ts";

// ============================================================
// Helpers
// ============================================================

interface LexResult {
  tokens: Token[];
  stream: TokenStream;
  reporter: Reporter;
  kinds: TokenKind[];
  values: (string | number | null)[];
}

/**
 * Lex source dan kembalikan token + reporter.
 * Default: tanpa trivia, dengan recovery.
 */
function lexSource(source: string, opts: { preserveTrivia?: boolean } = {}): LexResult {
  const reporter = new Reporter({ color: false, format: "plain" });
  const lexer = new Lexer(source, {
    file: "test.snake",
    reporter,
    preserveTrivia: opts.preserveTrivia ?? false,
  });
  const stream = lexer.tokenize();
  const tokens = [...stream.all];
  return {
    tokens,
    stream,
    reporter,
    kinds: tokens.map((t) => t.kind),
    values: tokens.map((t) => t.value),
  };
}

/**
 * Ambil kind token tanpa NEWLINE, INDENT, DEDENT, EOF, dan trivia.
 * Berguna untuk test yang tidak peduli struktur baris.
 */
function significantKinds(kinds: TokenKind[]): TokenKind[] {
  return kinds.filter(
    (k) =>
      k !== "NEWLINE" &&
      k !== "INDENT" &&
      k !== "DEDENT" &&
      k !== "EOF" &&
      k !== "COMMENT" &&
      k !== "DOC_COMMENT" &&
      k !== "BLANK_LINE",
  );
}

function significantValues(values: (string | number | null)[]): (string | number | null)[] {
  return values.filter((v) => v !== null);
}

beforeEach(() => {
  clearSourceCache();
});

// ============================================================
// 1. Literals — Number
// ============================================================

describe("Lexer — Number literals", () => {
  it("lexes integer", () => {
    const { kinds, values } = lexSource("42");
    expect(significantKinds(kinds)).toEqual(["NUMBER"]);
    expect(significantValues(values)).toEqual([42]);
  });

  it("lexes float", () => {
    const { values } = lexSource("3.14");
    expect(significantValues(values)).toEqual([3.14]);
  });

  it("lexes number with underscore separator", () => {
    const { values } = lexSource("1_000_000");
    expect(significantValues(values)).toEqual([1000000]);
  });

  it("lexes hex", () => {
    const { values } = lexSource("0xFF");
    expect(significantValues(values)).toEqual([255]);
  });

  it("lexes binary", () => {
    const { values } = lexSource("0b1010");
    expect(significantValues(values)).toEqual([10]);
  });

  it("lexes octal", () => {
    const { values } = lexSource("0o755");
    expect(significantValues(values)).toEqual([493]);
  });

  it("lexes scientific notation", () => {
    const { values } = lexSource("1e6");
    expect(significantValues(values)).toEqual([1000000]);
  });

  it("lexes scientific with sign", () => {
    const { values } = lexSource("1.5e-3");
    expect(significantValues(values)).toEqual([0.0015]);
  });

  it("lexes zero", () => {
    const { values } = lexSource("0");
    expect(significantValues(values)).toEqual([0]);
  });

  it("distinguishes 1.5 from 1 . 5", () => {
    const { kinds } = lexSource("1.5");
    expect(significantKinds(kinds)).toEqual(["NUMBER"]);

    const second = lexSource("x.y");
    expect(significantKinds(second.kinds)).toEqual([
      "IDENTIFIER",
      "DOT",
      "IDENTIFIER",
    ]);
  });
});

// ============================================================
// 2. Literals — String
// ============================================================

describe("Lexer — String literals", () => {
  it("lexes double-quoted string", () => {
    const { kinds, values } = lexSource('"halo"');
    expect(significantKinds(kinds)).toEqual(["STRING"]);
    expect(significantValues(values)).toEqual(["halo"]);
  });

  it("lexes single-quoted string", () => {
    const { values } = lexSource("'halo'");
    expect(significantValues(values)).toEqual(["halo"]);
  });

  it("lexes empty string", () => {
    const { values } = lexSource('""');
    expect(significantValues(values)).toEqual([""]);
  });

  it("processes escape sequences", () => {
    const { values } = lexSource('"baris\\nsatu\\ttab"');
    expect(significantValues(values)).toEqual(["baris\nsatu\ttab"]);
  });

  it("processes escaped quote", () => {
    const { values } = lexSource('"dia bilang \\"halo\\""');
    expect(significantValues(values)).toEqual(['dia bilang "halo"']);
  });

  it("processes escaped backslash", () => {
    const { values } = lexSource('"C:\\\\path"');
    expect(significantValues(values)).toEqual(["C:\\path"]);
  });

  it("lexes raw string without escape processing", () => {
    const { kinds, values } = lexSource('r"\\d+\\.\\d+"');
    expect(significantKinds(kinds)).toEqual(["RAW_STRING"]);
    expect(significantValues(values)).toEqual(["\\d+\\.\\d+"]);
  });

  it("lexes multi-line string", () => {
    const src = '"""\nbaris satu\nbaris dua\n"""';
    const { kinds, values } = lexSource(src);
    expect(significantKinds(kinds)).toEqual(["MULTILINE_STRING"]);
    expect(significantValues(values)).toEqual(["\nbaris satu\nbaris dua\n"]);
  });

  it("reports unterminated string at EOL", () => {
    const { reporter } = lexSource('"halo');
    expect(reporter.hasErrors()).toBe(true);
    const err = reporter.all()[0];
    expect(err?.code).toBe("SS2006"); // UNTERMINATED_STRING
  });

  it("reports unknown escape sequence", () => {
    const { reporter } = lexSource('"\\q"');
    expect(reporter.hasErrors()).toBe(true);
    expect(reporter.all()[0]?.code).toBe("SS2005"); // INVALID_STRING_LITERAL
  });
});

// ============================================================
// 3. String Interpolation
// ============================================================

describe("Lexer — String interpolation", () => {
  it("lexes simple interpolation", () => {
    const src = '"Halo ${nama}!"';
    const { kinds, values } = lexSource(src);

    // Harusnya ada: STRING_INTERP_START, IDENTIFIER, STRING_INTERP_END
    expect(significantKinds(kinds)).toEqual([
      "STRING_INTERP_START",
      "IDENTIFIER",
      "STRING_INTERP_END",
    ]);
    expect(values[0]).toBe("Halo ");
    expect(values[1]).toBe("nama");
    expect(values[2]).toBe("!");
  });

  it("lexes multiple interpolations", () => {
    const src = '"${a} dan ${b}"';
    const { kinds } = lexSource(src);

    expect(significantKinds(kinds)).toEqual([
      "STRING_INTERP_START",
      "IDENTIFIER",
      "STRING_INTERP_MIDDLE",
      "IDENTIFIER",
      "STRING_INTERP_END",
    ]);
  });

  it("lexes interpolation with expression", () => {
    const src = '"hasil: ${2 + 3}"';
    const { kinds } = lexSource(src);

    expect(significantKinds(kinds)).toEqual([
      "STRING_INTERP_START",
      "NUMBER",
      "PLUS",
      "NUMBER",
      "STRING_INTERP_END",
    ]);
  });

  it("handles nested braces in interpolation", () => {
    const src = '"nilai: ${map["key"]}"';
    const { kinds } = lexSource(src);

    expect(significantKinds(kinds)).toEqual([
      "STRING_INTERP_START",
      "IDENTIFIER",
      "LBRACKET",
      "STRING",
      "RBRACKET",
      "STRING_INTERP_END",
    ]);
  });

  it("handles map literal inside interpolation", () => {
    const src = '"${ {a: 1}["a"] }"';
    const { kinds } = lexSource(src);

    // Urutan: START, LBRACE, IDENTIFIER(a), COLON, NUMBER(1), RBRACE,
    //         LBRACKET, STRING(a), RBRACKET, END
    expect(significantKinds(kinds)).toEqual([
      "STRING_INTERP_START",
      "LBRACE",
      "IDENTIFIER",
      "COLON",
      "NUMBER",
      "RBRACE",
      "LBRACKET",
      "STRING",
      "RBRACKET",
      "STRING_INTERP_END",
    ]);
  });
});

// ============================================================
// 4. Keywords & Identifiers
// ============================================================

describe("Lexer — Keywords and identifiers", () => {
  it("lexes identifier", () => {
    const { kinds, values } = lexSource("nama");
    expect(significantKinds(kinds)).toEqual(["IDENTIFIER"]);
    expect(significantValues(values)).toEqual(["nama"]);
  });

  it("lexes identifier with underscore and digits", () => {
    const { values } = lexSource("_x1_y2");
    expect(significantValues(values)).toEqual(["_x1_y2"]);
  });

  it("lexes underscore as its own kind", () => {
    const { kinds } = lexSource("_");
    expect(significantKinds(kinds)).toEqual(["UNDERSCORE"]);
  });

  it("distinguishes keyword from identifier", () => {
    const { kinds } = lexSource("if ifx");
    expect(significantKinds(kinds)).toEqual(["IF", "IDENTIFIER"]);
  });

  it("lexes all declaration keywords", () => {
    const src = "const let fn return type";
    const { kinds } = lexSource(src);
    expect(significantKinds(kinds)).toEqual([
      "CONST",
      "LET",
      "FN",
      "RETURN",
      "TYPE",
    ]);
  });

  it("lexes all control flow keywords", () => {
    const src = "if else elif while for in break continue";
    const { kinds } = lexSource(src);
    expect(significantKinds(kinds)).toEqual([
      "IF",
      "ELSE",
      "ELIF",
      "WHILE",
      "FOR",
      "IN",
      "BREAK",
      "CONTINUE",
    ]);
  });

  it("lexes all logic keywords", () => {
    const { kinds } = lexSource("and or not true false null");
    expect(significantKinds(kinds)).toEqual([
      "AND",
      "OR",
      "NOT",
      "TRUE",
      "FALSE",
      "NULL",
    ]);
  });

  it("lexes all module keywords", () => {
    const { kinds } = lexSource("import export from as");
    expect(significantKinds(kinds)).toEqual([
      "IMPORT",
      "EXPORT",
      "FROM",
      "AS",
    ]);
  });

  it("lexes all error handling keywords", () => {
    const { kinds } = lexSource("try catch finally throw match case");
    expect(significantKinds(kinds)).toEqual([
      "TRY",
      "CATCH",
      "FINALLY",
      "THROW",
      "MATCH",
      "CASE",
    ]);
  });
});

// ============================================================
// 5. Operators & Punctuation
// ============================================================

describe("Lexer — Operators", () => {
  it("lexes arithmetic operators", () => {
    const { kinds } = lexSource("+ - * / % **");
    expect(significantKinds(kinds)).toEqual([
      "PLUS",
      "MINUS",
      "STAR",
      "SLASH",
      "PERCENT",
      "STAR_STAR",
    ]);
  });

  it("lexes comparison operators", () => {
    const { kinds } = lexSource("== != < <= > >=");
    expect(significantKinds(kinds)).toEqual([
      "EQ_EQ",
      "BANG_EQ",
      "LT",
      "LT_EQ",
      "GT",
      "GT_EQ",
    ]);
  });

  it("lexes assignment operators", () => {
    const { kinds } = lexSource("= += -= *= /= %=");
    expect(significantKinds(kinds)).toEqual([
      "EQ",
      "PLUS_EQ",
      "MINUS_EQ",
      "STAR_EQ",
      "SLASH_EQ",
      "PERCENT_EQ",
    ]);
  });

  it("lexes arrow operators", () => {
    const { kinds } = lexSource("-> =>");
    expect(significantKinds(kinds)).toEqual(["ARROW", "FAT_ARROW"]);
  });

  it("lexes range operator", () => {
    const { kinds } = lexSource("0..10");
    expect(significantKinds(kinds)).toEqual(["NUMBER", "DOT_DOT", "NUMBER"]);
  });

  it("lexes punctuation", () => {
    const { kinds } = lexSource("( ) [ ] { } , : . ? |");
    expect(significantKinds(kinds)).toEqual([
      "LPAREN",
      "RPAREN",
      "LBRACKET",
      "RBRACKET",
      "LBRACE",
      "RBRACE",
      "COMMA",
      "COLON",
      "DOT",
      "QUESTION",
      "PIPE",
    ]);
  });

  it("reports invalid ! operator", () => {
    const { reporter } = lexSource("x ! y");
    expect(reporter.hasErrors()).toBe(true);
    expect(reporter.all()[0]?.code).toBe("SS2008"); // INVALID_CHARACTER
  });

  it("reports invalid && operator", () => {
    const { reporter } = lexSource("a && b");
    expect(reporter.hasErrors()).toBe(true);
    expect(reporter.all()[0]?.code).toBe("SS2008");
  });

  it("reports invalid || operator", () => {
    const { reporter } = lexSource("a || b");
    expect(reporter.hasErrors()).toBe(true);
    expect(reporter.all()[0]?.code).toBe("SS2008");
  });
});

// ============================================================
// 6. Comments
// ============================================================

describe("Lexer — Comments", () => {
  it("skips single-line comment", () => {
    const src = "x = 1  # komentar\ny = 2";
    const { kinds } = lexSource(src);
    expect(significantKinds(kinds)).toEqual([
      "IDENTIFIER",
      "EQ",
      "NUMBER",
      "IDENTIFIER",
      "EQ",
      "NUMBER",
    ]);
  });

  it("preserves comment when preserveTrivia is true", () => {
    const src = "x = 1  # komentar";
    const { kinds } = lexSource(src, { preserveTrivia: true });
    expect(kinds).toContain("COMMENT");
  });

  it("recognizes doc comment ##", () => {
    const src = "## dokumentasi";
    const { kinds } = lexSource(src, { preserveTrivia: true });
    expect(kinds).toContain("DOC_COMMENT");
  });

  it("handles comment at end of file without newline", () => {
    const src = "x = 1 # akhir";
    const { kinds } = lexSource(src);
    expect(significantKinds(kinds)).toEqual(["IDENTIFIER", "EQ", "NUMBER"]);
  });
});

// ============================================================
// 7. Indentation
// ============================================================

describe("Lexer — Indentation", () => {
  it("emits INDENT and DEDENT for block", () => {
    const src = "if x:\n    y = 1\nz = 2";
    const { kinds } = lexSource(src);
    expect(kinds).toContain("INDENT");
    expect(kinds).toContain("DEDENT");

    // Urutan setelah COLON: NEWLINE, INDENT, ..., NEWLINE, DEDENT, ...
    const colonIdx = kinds.indexOf("COLON");
    const indentIdx = kinds.indexOf("INDENT");
    const dedentIdx = kinds.indexOf("DEDENT");
    expect(indentIdx).toBeGreaterThan(colonIdx);
    expect(dedentIdx).toBeGreaterThan(indentIdx);
  });

  it("handles nested indentation", () => {
    const src = [
      "if a:",
      "    if b:",
      "        c = 1",
      "    d = 2",
      "e = 3",
    ].join("\n");
    const { kinds } = lexSource(src);
    const indents = kinds.filter((k) => k === "INDENT").length;
    const dedents = kinds.filter((k) => k === "DEDENT").length;
    expect(indents).toBe(2);
    expect(dedents).toBe(2);
  });

  it("skips blank lines inside blocks", () => {
    const src = [
      "if x:",
      "    a = 1",
      "",
      "    b = 2",
    ].join("\n");
    const { kinds, reporter } = lexSource(src);
    expect(reporter.hasErrors()).toBe(false);
    expect(kinds.filter((k) => k === "INDENT").length).toBe(1);
    expect(kinds.filter((k) => k === "DEDENT").length).toBe(1);
  });

  it("skips comment-only lines", () => {
    const src = [
      "if x:",
      "    # komentar",
      "    a = 1",
    ].join("\n");
    const { kinds, reporter } = lexSource(src);
    expect(reporter.hasErrors()).toBe(false);
    expect(kinds.filter((k) => k === "INDENT").length).toBe(1);
  });

  it("reports tab indentation", () => {
    const src = "if x:\n\ty = 1";
    const { reporter } = lexSource(src);
    expect(reporter.hasErrors()).toBe(true);
    expect(reporter.all()[0]?.code).toBe("SS2002"); // INVALID_INDENT
  });

  it("reports inconsistent indentation", () => {
    const src = [
      "if x:",
      "    a = 1",
      "  b = 2",  // 2 spasi, bukan 4
    ].join("\n");
    const { reporter } = lexSource(src);
    expect(reporter.hasErrors()).toBe(true);
  });

  it("closes indent at EOF without explicit dedent", () => {
    const src = "if x:\n    y = 1";
    const { kinds, reporter } = lexSource(src);
    expect(reporter.hasErrors()).toBe(false);
    expect(kinds.filter((k) => k === "DEDENT").length).toBe(1);
  });
});

// ============================================================
// 8. Bracket Tracking (Multi-line Arrays)
// ============================================================

describe("Lexer — Bracket tracking", () => {
  it("suppresses NEWLINE inside parentheses", () => {
    const src = "x = (\n    1 +\n    2\n)";
    const { kinds } = lexSource(src);
    // Hanya boleh ada 2 NEWLINE: setelah ')' dan di EOF
    const newlines = kinds.filter((k) => k === "NEWLINE").length;
    expect(newlines).toBeLessThanOrEqual(2);
  });

  it("suppresses NEWLINE inside brackets", () => {
    const src = [
      "const data = [",
      "    1,",
      "    2,",
      "    3,",
      "]",
    ].join("\n");
    const { kinds, reporter } = lexSource(src);
    expect(reporter.hasErrors()).toBe(false);
    // Hanya 1 NEWLINE di akhir
    expect(kinds.filter((k) => k === "NEWLINE").length).toBe(1);
  });

  it("suppresses NEWLINE inside braces", () => {
    const src = [
      "const map = {",
      "    a: 1,",
      "    b: 2,",
      "}",
    ].join("\n");
    const { kinds, reporter } = lexSource(src);
    expect(reporter.hasErrors()).toBe(false);
    expect(kinds.filter((k) => k === "NEWLINE").length).toBe(1);
  });

  it("does not emit INDENT inside brackets", () => {
    const src = [
      "const x = [",
      "    1,",
      "    2,",
      "]",
    ].join("\n");
    const { kinds } = lexSource(src);
    expect(kinds).not.toContain("INDENT");
    expect(kinds).not.toContain("DEDENT");
  });
});

// ============================================================
// 9. TokenStream — Parser API
// ============================================================

describe("TokenStream", () => {
  it("peeks current token", () => {
    const { stream } = lexSource("const x = 1");
    expect(stream.peek().kind).toBe("CONST");
  });

  it("peeks with lookahead", () => {
    const { stream } = lexSource("const x = 1");
    expect(stream.peek(0).kind).toBe("CONST");
    expect(stream.peek(1).kind).toBe("IDENTIFIER");
    expect(stream.peek(2).kind).toBe("EQ");
    expect(stream.peek(3).kind).toBe("NUMBER");
  });

  it("consumes tokens with next", () => {
    const { stream } = lexSource("const x");
    expect(stream.next().kind).toBe("CONST");
    expect(stream.next().kind).toBe("IDENTIFIER");
  });

  it("checks current kind", () => {
    const { stream } = lexSource("const x");
    expect(stream.check("CONST")).toBe(true);
    expect(stream.check("LET")).toBe(false);
  });

  it("matches and consumes if kind matches", () => {
    const { stream } = lexSource("const x");
    expect(stream.match("LET")).toBe(false);
    expect(stream.peek().kind).toBe("CONST");
    expect(stream.match("CONST")).toBe(true);
    expect(stream.peek().kind).toBe("IDENTIFIER");
  });

  it("marks and resets position", () => {
    const { stream } = lexSource("const x = 1");
    stream.next(); // CONST
    stream.mark();
    stream.next(); // IDENTIFIER
    stream.next(); // EQ
    stream.reset();
    expect(stream.peek().kind).toBe("IDENTIFIER");
  });

  it("commits mark without reset", () => {
    const { stream } = lexSource("const x = 1");
    stream.mark();
    stream.next();
    stream.commit();
    stream.reset();  // tidak boleh kembali, stack kosong
    expect(stream.index).toBeGreaterThan(0);
  });

  it("returns EOF at end", () => {
    const { stream } = lexSource("x");
    stream.next();  // x
    // Lewati NEWLINE & EOF
    while (stream.peek().kind !== "EOF") stream.next();
    expect(stream.peek().kind).toBe("EOF");
  });
});

// ============================================================
// 10. SourceMap
// ============================================================

describe("SourceMap", () => {
  it("computes line and column from offset", () => {
    const src = "abc\ndef\nghi";
    const map = new SourceMap(src);

    expect(map.position(0)).toEqual({ offset: 0, line: 1, column: 1 });
    expect(map.position(2)).toEqual({ offset: 2, line: 1, column: 3 });
    expect(map.position(4)).toEqual({ offset: 4, line: 2, column: 1 });
    expect(map.position(8)).toEqual({ offset: 8, line: 3, column: 1 });
  });

  it("handles empty source", () => {
    const map = new SourceMap("");
    expect(map.position(0)).toEqual({ offset: 0, line: 1, column: 1 });
    expect(map.lineCount).toBe(1);
  });

  it("returns line content", () => {
    const src = "abc\ndef\nghi";
    const map = new SourceMap(src);
    expect(map.lineContent(1)).toBe("abc");
    expect(map.lineContent(2)).toBe("def");
    expect(map.lineContent(3)).toBe("ghi");
  });

  it("handles CRLF", () => {
    const src = "abc\r\ndef";
    const map = new SourceMap(src);
    expect(map.lineCount).toBe(2);
    expect(map.lineContent(1)).toBe("abc\r");
  });
});

// ============================================================
// 11. Position Tracking
// ============================================================

describe("Lexer — Position tracking", () => {
  it("tracks line and column correctly", () => {
    const src = "x = 1\ny = 2";
    const { tokens } = lexSource(src);

    const x = tokens.find((t) => t.value === "x")!;
    expect(x.loc.start.line).toBe(1);
    expect(x.loc.start.column).toBe(1);

    const y = tokens.find((t) => t.value === "y")!;
    expect(y.loc.start.line).toBe(2);
    expect(y.loc.start.column).toBe(1);
  });

  it("tracks multi-char token span", () => {
    const src = "abc";
    const { tokens } = lexSource(src);
    const ident = tokens.find((t) => t.kind === "IDENTIFIER")!;
    expect(ident.loc.start.column).toBe(1);
    expect(ident.loc.end.column).toBe(4);
    expect(ident.loc.end.offset - ident.loc.start.offset).toBe(3);
  });

  it("stores raw text on tokens", () => {
    const src = "1_000";
    const { tokens } = lexSource(src);
    const num = tokens.find((t) => t.kind === "NUMBER")!;
    expect(num.raw).toBe("1_000");
    expect(num.value).toBe(1000);
  });
});

// ============================================================
// 12. Error Recovery
// ============================================================

describe("Lexer — Error recovery", () => {
  it("continues after unknown character", () => {
    const src = "a = 1\n@invalid\nb = 2";
    const { kinds, reporter } = lexSource(src);
    expect(reporter.hasErrors()).toBe(true);
    // Harus tetap ada IDENTIFIER(b) dan NUMBER(2)
    const values = lexSource(src).values;
    expect(values).toContain("b");
    expect(values).toContain(2);
  });

  it("reports multiple errors in one pass", () => {
    const src = "a @ b\nc # d".replace("#", "@");
    const { reporter } = lexSource(src);
    expect(reporter.all().length).toBeGreaterThanOrEqual(2);
  });
});

// ============================================================
// 13. Integration — Program Lengkap
// ============================================================

describe("Lexer — Full program", () => {
  it("lexes a hello world program", () => {
    const src = `tulis("Halo, dunia!")`;
    const { kinds, reporter } = lexSource(src);
    expect(reporter.hasErrors()).toBe(false);
    expect(significantKinds(kinds)).toEqual([
      "IDENTIFIER",
      "LPAREN",
      "STRING",
      "RPAREN",
    ]);
  });

  it("lexes a function declaration", () => {
    const src = [
      "fn tambah(a: Angka, b: Angka) -> Angka:",
      "    return a + b",
    ].join("\n");

    const { kinds, reporter } = lexSource(src);
    expect(reporter.hasErrors()).toBe(false);

    expect(significantKinds(kinds)).toEqual([
      "FN",
      "IDENTIFIER",
      "LPAREN",
      "IDENTIFIER",
      "COLON",
      "IDENTIFIER",  // Angka (tipe = identifier)
      "COMMA",
      "IDENTIFIER",
      "COLON",
      "IDENTIFIER",
      "RPAREN",
      "ARROW",
      "IDENTIFIER",
      "COLON",
      "RETURN",
      "IDENTIFIER",
      "PLUS",
      "IDENTIFIER",
    ]);
  });

  it("lexes nested control flow", () => {
    const src = [
      "fn cek(x: Angka) -> Boolean:",
      "    if x > 0:",
      "        return true",
      "    else:",
      "        return false",
    ].join("\n");

    const { reporter, kinds } = lexSource(src);
    expect(reporter.hasErrors()).toBe(false);
    expect(kinds.filter((k) => k === "INDENT").length).toBe(2);
    expect(kinds.filter((k) => k === "DEDENT").length).toBe(2);
  });

  it("lexes a match statement", () => {
    const src = [
      "match nilai:",
      "    case 0:",
      '        tulis("nol")',
      "    case 1 | 2:",
      '        tulis("satu atau dua")',
      "    else:",
      '        tulis("lainnya")',
    ].join("\n");

    const { reporter } = lexSource(src);
    expect(reporter.hasErrors()).toBe(false);
  });

  it("lexes try/catch/finally", () => {
    const src = [
      "try:",
      "    a = 1",
      "catch err:",
      "    tulis(err)",
      "finally:",
      "    tulis(1)",
    ].join("\n");

    const { reporter, kinds } = lexSource(src);
    expect(reporter.hasErrors()).toBe(false);
    expect(kinds.filter((k) => k === "TRY").length).toBe(1);
    expect(kinds.filter((k) => k === "CATCH").length).toBe(1);
    expect(kinds.filter((k) => k === "FINALLY").length).toBe(1);
  });
});

// ============================================================
// 14. Convenience Function
// ============================================================

describe("lex() convenience", () => {
  it("lexes via top-level function", () => {
    const reporter = new Reporter({ color: false });
    const stream = lex("x = 1", "test.snake", reporter);
    const tokens = [...stream.all];
    expect(tokens[0]?.kind).toBe("IDENTIFIER");
    expect(reporter.hasErrors()).toBe(false);
  });
});
