/**
 * Snake Script — Parser Tests
 *
 * Test suite untuk src/parser.ts.
 *
 * Struktur:
 * - Helper untuk parse source dan ambil AST
 * - Group per kategori: declarations, control flow, expressions,
 *   types, patterns, error handling, full programs
 * - Setiap test fokus pada satu konstruksi
 */

import { describe, it, expect, beforeEach } from "vitest";
import { parse, Parser } from "../src/parser.ts";
import { Lexer } from "../src/lexer.ts";
import { Reporter, clearSourceCache } from "../src/diagnostics.ts";
import type {
  ProgramNode,
  StmtNode,
  ExprNode,
  TypeNode,
  VarDeclNode,
  FunctionDeclNode,
  IfStmtNode,
  WhileStmtNode,
  ForStmtNode,
  MatchStmtNode,
  TryStmtNode,
  ReturnStmtNode,
  ImportStmtNode,
  ExportStmtNode,
  TypeDeclNode,
  BinaryExprNode,
  UnaryExprNode,
  AssignExprNode,
  CallExprNode,
  MemberExprNode,
  IndexExprNode,
  ListExprNode,
  MapExprNode,
  InterpolatedStringNode,
  FunctionExprNode,
  PrimitiveTypeNode,
  NullableTypeNode,
  UnionTypeNode,
  NamedTypeNode,
  RecordTypeNode,
  FunctionTypeNode,
} from "../src/ast.ts";

// ============================================================
// Helpers
// ============================================================

interface ParseResult {
  ast: ProgramNode;
  reporter: Reporter;
  errors: number;
}

function parseSource(source: string): ParseResult {
  const reporter = new Reporter({ color: false, format: "plain" });
  const ast = parse(source, "test.snake", reporter);
  return {
    ast,
    reporter,
    errors: reporter.summary().errors,
  };
}

function expectNoError(r: ParseResult): void {
  if (r.errors > 0) {
    const msgs = r.reporter.all().map((d) => `[${d.code}] ${d.message}`).join("\n");
    throw new Error(`Expected no errors, got ${r.errors}:\n${msgs}`);
  }
}

function firstStmt(r: ParseResult): StmtNode {
  expectNoError(r);
  expect(r.ast.statements.length).toBeGreaterThan(0);
  return r.ast.statements[0]!;
}

beforeEach(() => {
  clearSourceCache();
});

// ============================================================
// 1. Variable Declarations
// ============================================================

describe("Parser — Variable declarations", () => {
  it("parses const with initializer and inferred type", () => {
    const stmt = firstStmt(parseSource("const x = 5"));
    expect(stmt.kind).toBe("VarDecl");
    const v = stmt as VarDeclNode;
    expect(v.mutable).toBe(false);
    expect(v.name).toBe("x");
    expect(v.typeAnnotation).toBeNull();
    expect(v.initializer?.kind).toBe("Literal");
  });

  it("parses let with type annotation", () => {
    const stmt = firstStmt(parseSource("let y: Angka = 10"));
    const v = stmt as VarDeclNode;
    expect(v.mutable).toBe(true);
    expect(v.name).toBe("y");
    expect(v.typeAnnotation?.kind).toBe("PrimitiveType");
    expect((v.typeAnnotation as PrimitiveTypeNode).name).toBe("Angka");
  });

  it("parses const without initializer (needs type)", () => {
    const stmt = firstStmt(parseSource("const x: Angka"));
    const v = stmt as VarDeclNode;
    expect(v.initializer).toBeNull();
    expect(v.typeAnnotation).not.toBeNull();
  });

  it("reports error for const without type and without initializer", () => {
    const r = parseSource("const x");
    expect(r.errors).toBeGreaterThan(0);
    expect(r.reporter.all()[0]?.code).toBe("SS2001");
  });

  it("parses nullable type annotation", () => {
    const stmt = firstStmt(parseSource("const x: Teks? = null"));
    const v = stmt as VarDeclNode;
    expect(v.typeAnnotation?.kind).toBe("NullableType");
  });
});

// ============================================================
// 2. Function Declarations
// ============================================================

describe("Parser — Function declarations", () => {
  it("parses simple function", () => {
    const src = [
      "fn tambah(a: Angka, b: Angka) -> Angka:",
      "    return a + b",
    ].join("\n");
    const stmt = firstStmt(parseSource(src));
    expect(stmt.kind).toBe("FunctionDecl");
    const fn = stmt as FunctionDeclNode;
    expect(fn.name).toBe("tambah");
    expect(fn.params.length).toBe(2);
    expect(fn.params[0]?.name).toBe("a");
    expect(fn.returnType?.kind).toBe("PrimitiveType");
    expect(fn.body.statements.length).toBe(1);
  });

  it("parses function without return type", () => {
    const src = [
      "fn cetak(x: Teks):",
      "    tulis(x)",
    ].join("\n");
    const stmt = firstStmt(parseSource(src)) as FunctionDeclNode;
    expect(stmt.returnType).toBeNull();
  });

  it("parses function with default parameter", () => {
    const src = [
      "fn sapa(nama: Teks = \"dunia\") -> Teks:",
      "    return nama",
    ].join("\n");
    const stmt = firstStmt(parseSource(src)) as FunctionDeclNode;
    expect(stmt.params[0]?.defaultValue?.kind).toBe("Literal");
  });

  it("rejects non-default after default parameter", () => {
    const src = [
      "fn bad(a: Angka = 1, b: Angka) -> Angka:",
      "    return a",
    ].join("\n");
    const r = parseSource(src);
    expect(r.errors).toBeGreaterThan(0);
  });

  it("parses function with type parameters", () => {
    const src = [
      "fn identitas<T>(x: T) -> T:",
      "    return x",
    ].join("\n");
    const stmt = firstStmt(parseSource(src)) as FunctionDeclNode;
    expect(stmt.typeParams).toEqual(["T"]);
  });

  it("parses empty function body", () => {
    const src = "fn kosong():\n    return";
    const stmt = firstStmt(parseSource(src)) as FunctionDeclNode;
    expect(stmt.body.statements.length).toBe(1);
    expect(stmt.body.statements[0]?.kind).toBe("ReturnStmt");
  });
});

// ============================================================
// 3. Import / Export
// ============================================================

describe("Parser — Import / Export", () => {
  it("parses named import", () => {
    const stmt = firstStmt(parseSource('import { PI, luas } from "mat"'));
    const imp = stmt as ImportStmtNode;
    expect(imp.importKind).toBe("named");
    expect(imp.names).toEqual(["PI", "luas"]);
    expect(imp.source).toBe("mat");
  });

  it("parses namespace import", () => {
    const stmt = firstStmt(parseSource('import * as mat from "mat"'));
    const imp = stmt as ImportStmtNode;
    expect(imp.importKind).toBe("namespace");
    expect(imp.alias).toBe("mat");
  });

  it("parses default import", () => {
    const stmt = firstStmt(parseSource('import matematika from "mat"'));
    const imp = stmt as ImportStmtNode;
    expect(imp.importKind).toBe("default");
    expect(imp.alias).toBe("matematika");
  });

  it("parses export const", () => {
    const stmt = firstStmt(parseSource("export const PI = 3.14"));
    expect(stmt.kind).toBe("ExportStmt");
    const exp = stmt as ExportStmtNode;
    expect(exp.declaration.kind).toBe("VarDecl");
  });

  it("parses export function", () => {
    const src = [
      "export fn tambah(a: Angka, b: Angka) -> Angka:",
      "    return a + b",
    ].join("\n");
    const stmt = firstStmt(parseSource(src)) as ExportStmtNode;
    expect(stmt.declaration.kind).toBe("FunctionDecl");
  });

  it("rejects export without declaration", () => {
    const r = parseSource("export 5");
    expect(r.errors).toBeGreaterThan(0);
  });
});

// ============================================================
// 4. Type Declarations
// ============================================================

describe("Parser — Type declarations", () => {
  it("parses simple type alias", () => {
    const stmt = firstStmt(parseSource("type UserId = Angka"));
    const t = stmt as TypeDeclNode;
    expect(t.name).toBe("UserId");
    expect(t.value.kind).toBe("PrimitiveType");
  });

  it("parses union type", () => {
    const stmt = firstStmt(parseSource("type Hasil = Sukses | Gagal")) as TypeDeclNode;
    expect(stmt.value.kind).toBe("UnionType");
    expect((stmt.value as UnionTypeNode).members.length).toBe(2);
  });

  it("parses record type single-line", () => {
    const stmt = firstStmt(
      parseSource("type User = { nama: Teks, umur: Angka }"),
    ) as TypeDeclNode;
    expect(stmt.value.kind).toBe("RecordType");
    expect((stmt.value as RecordTypeNode).fields.length).toBe(2);
  });

  it("parses record type multi-line", () => {
    const src = [
      "type User = {",
      "    nama: Teks",
      "    umur: Angka?",
      "    email: Teks",
      "}",
    ].join("\n");
    const stmt = firstStmt(parseSource(src)) as TypeDeclNode;
    const rec = stmt.value as RecordTypeNode;
    expect(rec.fields.length).toBe(3);
    expect(rec.fields[1]?.type.kind).toBe("NullableType");
  });

  it("parses named generic type", () => {
    const stmt = firstStmt(parseSource("type AngkaList = Daftar<Angka>")) as TypeDeclNode;
    expect(stmt.value.kind).toBe("NamedType");
    expect((stmt.value as NamedTypeNode).typeArgs.length).toBe(1);
  });

  it("parses function type", () => {
    const stmt = firstStmt(
      parseSource("type F = (Angka, Teks) -> Boolean"),
    ) as TypeDeclNode;
    expect(stmt.value.kind).toBe("FunctionType");
    const fnType = stmt.value as FunctionTypeNode;
    expect(fnType.params.length).toBe(2);
    expect(fnType.returns.kind).toBe("PrimitiveType");
  });

  it("parses nested generic type", () => {
    const stmt = firstStmt(
      parseSource("type X = Peta<Teks, Daftar<Angka>>"),
    ) as TypeDeclNode;
    const named = stmt.value as NamedTypeNode;
    expect(named.typeArgs.length).toBe(2);
    expect(named.typeArgs[1]?.kind).toBe("NamedType");
  });
});

// ============================================================
// 5. Control Flow — If / While / For
// ============================================================

describe("Parser — If statement", () => {
  it("parses simple if", () => {
    const src = [
      "if x > 0:",
      "    tulis(1)",
    ].join("\n");
    const stmt = firstStmt(parseSource(src));
    expect(stmt.kind).toBe("IfStmt");
    const s = stmt as IfStmtNode;
    expect(s.condition.kind).toBe("BinaryExpr");
    expect(s.then.statements.length).toBe(1);
    expect(s.else).toBeNull();
    expect(s.elifs.length).toBe(0);
  });

  it("parses if-else", () => {
    const src = [
      "if x > 0:",
      "    tulis(1)",
      "else:",
      "    tulis(2)",
    ].join("\n");
    const s = firstStmt(parseSource(src)) as IfStmtNode;
    expect(s.else).not.toBeNull();
    expect(s.else?.statements.length).toBe(1);
  });

  it("parses if-elif-else", () => {
    const src = [
      "if x > 0:",
      "    tulis(\"positif\")",
      "elif x < 0:",
      "    tulis(\"negatif\")",
      "else:",
      "    tulis(\"nol\")",
    ].join("\n");
    const s = firstStmt(parseSource(src)) as IfStmtNode;
    expect(s.elifs.length).toBe(1);
    expect(s.else).not.toBeNull();
  });
});

describe("Parser — While statement", () => {
  it("parses while", () => {
    const src = [
      "while x < 10:",
      "    x += 1",
    ].join("\n");
    const s = firstStmt(parseSource(src)) as WhileStmtNode;
    expect(s.kind).toBe("WhileStmt");
    expect(s.body.statements.length).toBe(1);
  });
});

describe("Parser — For statement", () => {
  it("parses for-in", () => {
    const src = [
      "for x in [1, 2, 3]:",
      "    tulis(x)",
    ].join("\n");
    const s = firstStmt(parseSource(src)) as ForStmtNode;
    expect(s.variable).toBe("x");
    expect(s.iterable.kind).toBe("ListExpr");
  });

  it("parses for over range", () => {
    const src = [
      "for i in 0..10:",
      "    tulis(i)",
    ].join("\n");
    const s = firstStmt(parseSource(src)) as ForStmtNode;
    // Range di-parse sebagai CallExpr `rentang(0, 10)`
    expect(s.iterable.kind).toBe("CallExpr");
    const call = s.iterable as CallExprNode;
    expect(call.args.length).toBe(2);
    expect(call.callee.kind).toBe("Identifier");
  });
});

// ============================================================
// 6. Match
// ============================================================

describe("Parser — Match statement", () => {
  it("parses match with literal cases", () => {
    const src = [
      "match x:",
      "    case 0:",
      "        tulis(\"nol\")",
      "    case 1:",
      "        tulis(\"satu\")",
    ].join("\n");
    const s = firstStmt(parseSource(src)) as MatchStmtNode;
    expect(s.kind).toBe("MatchStmt");
    expect(s.cases.length).toBe(2);
    expect(s.cases[0]?.pattern.kind).toBe("LiteralPattern");
  });

  it("parses match with or-pattern", () => {
    const src = [
      "match x:",
      "    case 1 | 2:",
      "        tulis(\"kecil\")",
    ].join("\n");
    const s = firstStmt(parseSource(src)) as MatchStmtNode;
    expect(s.cases[0]?.pattern.kind).toBe("OrPattern");
  });

  it("parses match with guard", () => {
    const src = [
      "match x:",
      "    case n if n > 10:",
      "        tulis(\"besar\")",
    ].join("\n");
    const s = firstStmt(parseSource(src)) as MatchStmtNode;
    expect(s.cases[0]?.guard).not.toBeNull();
  });

  it("parses match with wildcard", () => {
    const src = [
      "match x:",
      "    case _:",
      "        tulis(\"lainnya\")",
    ].join("\n");
    const s = firstStmt(parseSource(src)) as MatchStmtNode;
    expect(s.cases[0]?.pattern.kind).toBe("WildcardPattern");
  });

  it("parses match with else", () => {
    const src = [
      "match x:",
      "    case 0:",
      "        tulis(\"nol\")",
      "    else:",
      "        tulis(\"lainnya\")",
    ].join("\n");
    const s = firstStmt(parseSource(src)) as MatchStmtNode;
    expect(s.else).not.toBeNull();
  });
});

// ============================================================
// 7. Try / Catch / Finally
// ============================================================

describe("Parser — Try statement", () => {
  it("parses try-catch", () => {
    const src = [
      "try:",
      "    a = 1",
      "catch err:",
      "    tulis(err)",
    ].join("\n");
    const s = firstStmt(parseSource(src)) as TryStmtNode;
    expect(s.kind).toBe("TryStmt");
    expect(s.errorName).toBe("err");
    expect(s.finallyBody).toBeNull();
  });

  it("parses try-catch-finally", () => {
    const src = [
      "try:",
      "    a = 1",
      "catch err:",
      "    tulis(err)",
      "finally:",
      "    tulis(2)",
    ].join("\n");
    const s = firstStmt(parseSource(src)) as TryStmtNode;
    expect(s.finallyBody).not.toBeNull();
  });
});

// ============================================================
// 8. Return / Break / Continue / Throw
// ============================================================

describe("Parser — Jump statements", () => {
  it("parses return without value", () => {
    const src = "fn f():\n    return";
    const fn = firstStmt(parseSource(src)) as FunctionDeclNode;
    const ret = fn.body.statements[0] as ReturnStmtNode;
    expect(ret.kind).toBe("ReturnStmt");
    expect(ret.value).toBeNull();
  });

  it("parses return with value", () => {
    const src = "fn f() -> Angka:\n    return 42";
    const fn = firstStmt(parseSource(src)) as FunctionDeclNode;
    const ret = fn.body.statements[0] as ReturnStmtNode;
    expect(ret.value?.kind).toBe("Literal");
  });

  it("parses break and continue", () => {
    const src = [
      "while true:",
      "    break",
      "while true:",
      "    continue",
    ].join("\n");
    const r = parseSource(src);
    expectNoError(r);
    expect(r.ast.statements[0]?.kind).toBe("WhileStmt");
    expect(r.ast.statements[1]?.kind).toBe("WhileStmt");
  });

  it("parses throw", () => {
    const stmt = firstStmt(parseSource("throw Error(\"gagal\")"));
    expect(stmt.kind).toBe("ThrowStmt");
  });
});

// ============================================================
// 9. Expressions — Binary & Unary
// ============================================================

describe("Parser — Binary expressions", () => {
  it("parses arithmetic precedence", () => {
    const stmt = firstStmt(parseSource("x = 2 + 3 * 4"));
    const v = stmt as import("../src/ast.ts").ExprStmtNode;
    const assign = v.expression as AssignExprNode;
    const bin = assign.value as BinaryExprNode;
    expect(bin.operator).toBe("+");
    expect((bin.right as BinaryExprNode).operator).toBe("*");
  });

  it("parses power as right-associative", () => {
    const src = "x = 2 ** 3 ** 2";
    const stmt = firstStmt(parseSource(src)) as import("../src/ast.ts").ExprStmtNode;
    const assign = stmt.expression as AssignExprNode;
    const bin = assign.value as BinaryExprNode;
    expect(bin.operator).toBe("**");
    expect((bin.right as BinaryExprNode).operator).toBe("**");
  });

  it("parses comparison", () => {
    const stmt = firstStmt(parseSource("x = a < b")) as import("../src/ast.ts").ExprStmtNode;
    const assign = stmt.expression as AssignExprNode;
    expect((assign.value as BinaryExprNode).operator).toBe("<");
  });

  it("parses logic operators", () => {
    const stmt = firstStmt(parseSource("x = a and b or c")) as import("../src/ast.ts").ExprStmtNode;
    const assign = stmt.expression as AssignExprNode;
    const bin = assign.value as BinaryExprNode;
    // `or` di root karena presedensi lebih rendah
    expect(bin.operator).toBe("or");
  });
});

describe("Parser — Unary expressions", () => {
  it("parses unary minus", () => {
    const stmt = firstStmt(parseSource("x = -5")) as import("../src/ast.ts").ExprStmtNode;
    const assign = stmt.expression as AssignExprNode;
    expect(assign.value.kind).toBe("UnaryExpr");
    expect((assign.value as UnaryExprNode).operator).toBe("-");
  });

  it("parses not", () => {
    const stmt = firstStmt(parseSource("x = not flag")) as import("../src/ast.ts").ExprStmtNode;
    const assign = stmt.expression as AssignExprNode;
    expect((assign.value as UnaryExprNode).operator).toBe("not");
  });

  it("parses not twice", () => {
    const stmt = firstStmt(parseSource("x = not not flag")) as import("../src/ast.ts").ExprStmtNode;
    const assign = stmt.expression as AssignExprNode;
    const outer = assign.value as UnaryExprNode;
    expect(outer.operator).toBe("not");
    expect((outer.operand as UnaryExprNode).operator).toBe("not");
  });
});

// ============================================================
// 10. Expressions — Call / Member / Index
// ============================================================

describe("Parser — Member access and calls", () => {
  it("parses member access", () => {
    const stmt = firstStmt(parseSource("x = user.nama")) as import("../src/ast.ts").ExprStmtNode;
    const assign = stmt.expression as AssignExprNode;
    const m = assign.value as MemberExprNode;
    expect(m.kind).toBe("MemberExpr");
    expect(m.property).toBe("nama");
  });

  it("parses index access", () => {
    const stmt = firstStmt(parseSource("x = arr[0]")) as import("../src/ast.ts").ExprStmtNode;
    const assign = stmt.expression as AssignExprNode;
    expect(assign.value.kind).toBe("IndexExpr");
  });

  it("parses function call", () => {
    const stmt = firstStmt(parseSource("f(1, 2, 3)")) as import("../src/ast.ts").ExprStmtNode;
    const call = stmt.expression as CallExprNode;
    expect(call.kind).toBe("CallExpr");
    expect(call.args.length).toBe(3);
  });

  it("parses chained member and call", () => {
    const stmt = firstStmt(parseSource("x = a.b.c(1).d[2]")) as import("../src/ast.ts").ExprStmtNode;
    const assign = stmt.expression as AssignExprNode;
    // Root adalah IndexExpr
    expect(assign.value.kind).toBe("IndexExpr");
  });
});

// ============================================================
// 11. Expressions — Literals
// ============================================================

describe("Parser — Literal expressions", () => {
  it("parses list literal", () => {
    const stmt = firstStmt(parseSource("x = [1, 2, 3]")) as import("../src/ast.ts").ExprStmtNode;
    const assign = stmt.expression as AssignExprNode;
    const list = assign.value as ListExprNode;
    expect(list.kind).toBe("ListExpr");
    expect(list.elements.length).toBe(3);
  });

  it("parses empty list", () => {
    const stmt = firstStmt(parseSource("x = []")) as import("../src/ast.ts").ExprStmtNode;
    const assign = stmt.expression as AssignExprNode;
    expect((assign.value as ListExprNode).elements.length).toBe(0);
  });

  it("parses map literal", () => {
    const stmt = firstStmt(parseSource('x = { "a": 1, "b": 2 }')) as import("../src/ast.ts").ExprStmtNode;
    const assign = stmt.expression as AssignExprNode;
    const map = assign.value as MapExprNode;
    expect(map.kind).toBe("MapExpr");
    expect(map.entries.length).toBe(2);
    expect(map.entries[0]?.key).toBe("a");
  });

  it("parses map with identifier keys", () => {
    const stmt = firstStmt(parseSource("x = { nama: 1 }")) as import("../src/ast.ts").ExprStmtNode;
    const assign = stmt.expression as AssignExprNode;
    const map = assign.value as MapExprNode;
    expect(map.entries[0]?.key).toBe("nama");
  });

  it("parses interpolated string", () => {
    const stmt = firstStmt(parseSource('x = "Halo ${nama}!"')) as import("../src/ast.ts").ExprStmtNode;
    const assign = stmt.expression as AssignExprNode;
    const interp = assign.value as InterpolatedStringNode;
    expect(interp.kind).toBe("InterpolatedString");
    expect(interp.parts.length).toBe(3);
    expect(interp.parts[0]).toBe("Halo ");
    expect(interp.parts[2]).toBe("!");
  });

  it("parses interpolated string with expression", () => {
    const stmt = firstStmt(parseSource('x = "hasil: ${2 + 3}"')) as import("../src/ast.ts").ExprStmtNode;
    const assign = stmt.expression as AssignExprNode;
    const interp = assign.value as InterpolatedStringNode;
    const expr = interp.parts[1];
    expect(typeof expr).not.toBe("string");
    expect((expr as ExprNode).kind).toBe("BinaryExpr");
  });

  it("parses function expression", () => {
    const stmt = firstStmt(
      parseSource("x = fn(a: Angka) -> Angka => a * 2"),
    ) as import("../src/ast.ts").ExprStmtNode;
    const assign = stmt.expression as AssignExprNode;
    const fn = assign.value as FunctionExprNode;
    expect(fn.kind).toBe("FunctionExpr");
    expect(fn.params.length).toBe(1);
  });
});

// ============================================================
// 12. Assignment
// ============================================================

describe("Parser — Assignment", () => {
  it("parses simple assignment", () => {
    const stmt = firstStmt(parseSource("x = 5")) as import("../src/ast.ts").ExprStmtNode;
    const assign = stmt.expression as AssignExprNode;
    expect(assign.operator).toBe("=");
  });

  it("parses compound assignments", () => {
    for (const op of ["+=", "-=", "*=", "/=", "%="] as const) {
      const stmt = firstStmt(parseSource(`x ${op} 1`)) as import("../src/ast.ts").ExprStmtNode;
      const assign = stmt.expression as AssignExprNode;
      expect(assign.operator).toBe(op);
    }
  });

  it("parses chained assignment", () => {
    const stmt = firstStmt(parseSource("a = b = 5")) as import("../src/ast.ts").ExprStmtNode;
    const assign = stmt.expression as AssignExprNode;
    expect(assign.operator).toBe("=");
    expect(assign.value.kind).toBe("AssignExpr");
  });

  it("rejects assignment to literal", () => {
    const r = parseSource("5 = 10");
    expect(r.errors).toBeGreaterThan(0);
  });
});

// ============================================================
// 13. Parentheses
// ============================================================

describe("Parser — Parentheses", () => {
  it("overrides precedence with parentheses", () => {
    const stmt = firstStmt(parseSource("x = (2 + 3) * 4")) as import("../src/ast.ts").ExprStmtNode;
    const assign = stmt.expression as AssignExprNode;
    const mul = assign.value as BinaryExprNode;
    expect(mul.operator).toBe("*");
    // Left side adalah ParenExpr wrapping BinaryExpr(+)
    expect(mul.left.kind).toBe("ParenExpr");
  });

  it("parses nested parentheses", () => {
    const stmt = firstStmt(parseSource("x = ((1))")) as import("../src/ast.ts").ExprStmtNode;
    const assign = stmt.expression as AssignExprNode;
    expect(assign.value.kind).toBe("ParenExpr");
  });
});

// ============================================================
// 14. Error Recovery
// ============================================================

describe("Parser — Error recovery", () => {
  it("recovers from error and continues parsing", () => {
    const src = [
      "const a = 1",
      "const = 2",  // error: no identifier
      "const b = 3",
    ].join("\n");

    const r = parseSource(src);
    expect(r.errors).toBeGreaterThan(0);
    // Statement pertama dan ketiga harus ada
    const names = r.ast.statements
      .filter((s) => s.kind === "VarDecl")
      .map((s) => (s as VarDeclNode).name);
    expect(names).toContain("a");
    expect(names).toContain("b");
  });

  it("recovers inside block", () => {
    const src = [
      "fn f():",
      "    const a = 1",
      "    const = 2",
      "    const b = 3",
    ].join("\n");

    const r = parseSource(src);
    expect(r.errors).toBeGreaterThan(0);
    const fn = r.ast.statements[0] as FunctionDeclNode;
    // Harus ada statement setelah error
    expect(fn.body.statements.length).toBeGreaterThanOrEqual(2);
  });

  it("reports multiple errors in one pass", () => {
    const src = [
      "const = 1",
      "const = 2",
      "const = 3",
    ].join("\n");
    const r = parseSource(src);
    expect(r.errors).toBeGreaterThanOrEqual(2);
  });
});

// ============================================================
// 15. Full Programs
// ============================================================

describe("Parser — Full programs", () => {
  it("parses hello world", () => {
    const r = parseSource('tulis("Halo, dunia!")');
    expectNoError(r);
    expect(r.ast.statements.length).toBe(1);
  });

  it("parses factorial function", () => {
    const src = [
      "fn faktorial(n: Angka) -> Angka:",
      "    if n <= 1:",
      "        return 1",
      "    return n * faktorial(n - 1)",
    ].join("\n");

    const r = parseSource(src);
    expectNoError(r);
    const fn = r.ast.statements[0] as FunctionDeclNode;
    expect(fn.name).toBe("faktorial");
    expect(fn.body.statements.length).toBe(2);
    expect(fn.body.statements[0]?.kind).toBe("IfStmt");
    expect(fn.body.statements[1]?.kind).toBe("ReturnStmt");
  });

  it("parses program with multiple statements", () => {
    const src = [
      "const PI = 3.14",
      "",
      "fn luas(r: Angka) -> Angka:",
      "    return PI * r * r",
      "",
      "const r = 5",
      "const hasil = luas(r)",
      'tulis("Luas: ${hasil}")',
    ].join("\n");

    const r = parseSource(src);
    expectNoError(r);
    expect(r.ast.statements.length).toBe(4);
  });

  it("parses user-defined type usage", () => {
    const src = [
      "type User = {",
      "    id: Angka",
      "    nama: Teks",
      "    umur: Angka?",
      "}",
      "",
      "fn sapa(u: User) -> Teks:",
      "    return u.nama",
    ].join("\n");

    const r = parseSource(src);
    expectNoError(r);
    expect(r.ast.statements.length).toBe(2);
  });

  it("parses nested control flow", () => {
    const src = [
      "for i in 0..10:",
      "    if i % 2 == 0:",
      "        tulis(i)",
      "    else:",
      "        tulis(-i)",
    ].join("\n");

    const r = parseSource(src);
    expectNoError(r);
    const forStmt = r.ast.statements[0] as ForStmtNode;
    expect(forStmt.body.statements[0]?.kind).toBe("IfStmt");
  });

  it("parses complete feature-rich program", () => {
    const src = [
      "import { map, filter } from \"stdlib\"",
      "",
      "type User = {",
      "    nama: Teks",
      "    umur: Angka",
      "}",
      "",
      "fn dewasa(users: Daftar<User>) -> Daftar<User>:",
      "    return filter(users, fn(u: User) -> Boolean => u.umur >= 18)",
      "",
      "const users = [",
      "    { nama: \"A\", umur: 20 },",
      "    { nama: \"B\", umur: 15 },",
      "]",
      "",
      "for u in dewasa(users):",
      '    tulis("${u.nama}")',
    ].join("\n");

    const r = parseSource(src);
    expectNoError(r);
    expect(r.ast.statements.length).toBe(4);
  });
});

// ============================================================
// 16. Location Tracking
// ============================================================

describe("Parser — Location tracking", () => {
  it("tracks location of var decl", () => {
    const stmt = firstStmt(parseSource("const x = 5"));
    expect(stmt.loc.start.line).toBe(1);
    expect(stmt.loc.start.column).toBe(1);
    expect(stmt.loc.file).toBe("test.snake");
  });

  it("tracks location of nested expression", () => {
    const src = "const x = 1 + 2";
    const stmt = firstStmt(parseSource(src)) as VarDeclNode;
    const bin = stmt.initializer as BinaryExprNode;
    // `+` di kolom 13
    expect(bin.loc.start.column).toBe(11);
    expect(bin.loc.end.column).toBe(16);
  });

  it("tracks multi-line location", () => {
    const src = [
      "fn f():",
      "    return 1",
    ].join("\n");
    const fn = firstStmt(parseSource(src)) as FunctionDeclNode;
    expect(fn.loc.start.line).toBe(1);
    expect(fn.loc.end.line).toBe(2);
  });
});

// ============================================================
// 17. Convenience API
// ============================================================

describe("Parser — Convenience", () => {
  it("parses via top-level parse()", () => {
    const reporter = new Reporter({ color: false });
    const ast = parse("x = 1", "test.snake", reporter);
    expect(ast.kind).toBe("Program");
    expect(ast.statements.length).toBe(1);
    expect(reporter.hasErrors()).toBe(false);
  });

  it("parses via Parser class directly", () => {
    const reporter = new Reporter({ color: false });
    const lexer = new Lexer("x = 1", { file: "test.snake", reporter });
    const stream = lexer.tokenize();
    const parser = new Parser(stream, { file: "test.snake", reporter });
    const ast = parser.parseProgram();
    expect(ast.kind).toBe("Program");
    expect(reporter.hasErrors()).toBe(false);
  });
});

// ============================================================
// 18. Edge Cases
// ============================================================

describe("Parser — Edge cases", () => {
  it("parses empty program", () => {
    const r = parseSource("");
    expect(r.ast.statements.length).toBe(0);
    expect(r.errors).toBe(0);
  });

  it("parses program with only newlines", () => {
    const r = parseSource("\n\n\n");
    expect(r.ast.statements.length).toBe(0);
    expect(r.errors).toBe(0);
  });

  it("parses program with only comments", () => {
    const r = parseSource("# komentar\n# lagi\n");
    expect(r.ast.statements.length).toBe(0);
  });

  it("parses deeply nested expressions", () => {
    const src = "x = ((((1 + 2))))";
    const r = parseSource(src);
    expectNoError(r);
  });

  it("parses long list", () => {
    const items = Array.from({ length: 100 }, (_, i) => i).join(", ");
    const r = parseSource(`x = [${items}]`);
    expectNoError(r);
    const stmt = r.ast.statements[0] as VarDeclNode;
    expect((stmt.initializer as ListExprNode).elements.length).toBe(100);
  });

  it("parses multi-line function call", () => {
    const src = [
      "const x = f(",
      "    1,",
      "    2,",
      "    3,",
      ")",
    ].join("\n");
    const r = parseSource(src);
    expectNoError(r);
  });

  it("parses nested function with closure", () => {
    const src = [
      "const adder = fn(a: Angka) -> (Angka) -> Angka =>",
      "    fn(b: Angka) -> Angka => a + b",
    ].join("\n");
    const r = parseSource(src);
    expectNoError(r);
  });
});
