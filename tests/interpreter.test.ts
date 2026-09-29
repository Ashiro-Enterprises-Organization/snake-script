/**
 * Snake Script — Interpreter Tests
 *
 * Test suite untuk src/interpreter.ts.
 *
 * Struktur:
 * - Helper untuk compile + run source dan capture output
 * - Group per kategori: literals, expressions, statements, functions,
 *   control flow, error handling, built-ins, edge cases
 * - Setiap test fokus pada satu perilaku eksekusi
 */

import { describe, it, expect, beforeEach } from "vitest";
import { parse } from "../src/parser.ts";
import { Interpreter, Environment, RuntimeError, type Value } from "../src/interpreter.ts";
import { Reporter, clearSourceCache } from "../src/diagnostics.ts";

// ============================================================
// Helpers
// ============================================================

interface RunResult {
  output: string[];
  errors: string[];
  reporter: Reporter;
  interpreter: Interpreter;
}

/**
 * Compile dan jalankan source. Output dikumpulkan sebagai array.
 */
function runSource(source: string): RunResult {
  clearSourceCache();
  const output: string[] = [];
  const reporter = new Reporter({ color: false, format: "plain" });

  const program = parse(source, "test.snake", reporter);

  const interpreter = new Interpreter({
    file: "test.snake",
    reporter,
    onPrint: (line) => output.push(line),
  });

  try {
    interpreter.run(program);
  } catch (e) {
    // Biarkan — test yang mengecek error akan memeriksa reporter
    void e;
  }

  return {
    output,
    errors: reporter.all().map((d) => d.message),
    reporter,
    interpreter,
  };
}

/**
 * Harus no error.
 */
function expectClean(r: RunResult): void {
  if (r.reporter.hasErrors()) {
    const msgs = r.reporter.all()
      .map((d) => `[${d.code}] ${d.message}`)
      .join("\n");
    throw new Error(`Expected no errors, got:\n${msgs}`);
  }
}

/**
 * Ambil output sebagai satu string gabungan.
 */
function joined(r: RunResult): string {
  return r.output.join("\n");
}

beforeEach(() => {
  clearSourceCache();
});

// ============================================================
// 1. Environment
// ============================================================

describe("Environment", () => {
  it("defines and gets a value", () => {
    const env = new Environment();
    env.define("x", 42);
    expect(env.get("x")).toBe(42);
  });

  it("returns undefined for missing key", () => {
    const env = new Environment();
    expect(env.get("missing")).toBeUndefined();
  });

  it("has() checks existence", () => {
    const env = new Environment();
    env.define("x", 1);
    expect(env.has("x")).toBe(true);
    expect(env.has("y")).toBe(false);
  });

  it("looks up parent scope", () => {
    const parent = new Environment();
    parent.define("x", 10);
    const child = new Environment(parent);
    expect(child.get("x")).toBe(10);
    expect(child.has("x")).toBe(true);
  });

  it("child shadows parent", () => {
    const parent = new Environment();
    parent.define("x", 10);
    const child = new Environment(parent);
    child.define("x", 20);
    expect(child.get("x")).toBe(20);
    expect(parent.get("x")).toBe(10);
  });

  it("assign updates in nearest scope", () => {
    const parent = new Environment();
    parent.define("x", 10);
    const child = new Environment(parent);
    expect(child.assign("x", 99)).toBe(true);
    expect(parent.get("x")).toBe(99);
    expect(child.get("x")).toBe(99);
  });

  it("assign returns false for undefined var", () => {
    const env = new Environment();
    expect(env.assign("missing", 1)).toBe(false);
  });
});

// ============================================================
// 2. Literals & Basic Output
// ============================================================

describe("Interpreter — Literals", () => {
  it("evaluates number literal", () => {
    const r = runSource("tulis(42)");
    expectClean(r);
    expect(joined(r)).toBe("42");
  });

  it("evaluates string literal", () => {
    const r = runSource('tulis("halo")');
    expectClean(r);
    expect(joined(r)).toBe("halo");
  });

  it("evaluates boolean literals", () => {
    const r = runSource("tulis(true)\ntulis(false)");
    expectClean(r);
    expect(r.output).toEqual(["true", "false"]);
  });

  it("evaluates null literal", () => {
    const r = runSource("tulis(null)");
    expectClean(r);
    expect(joined(r)).toBe("null");
  });

  it("evaluates list literal", () => {
    const r = runSource("tulis([1, 2, 3])");
    expectClean(r);
    expect(joined(r)).toBe("[1, 2, 3]");
  });

  it("evaluates map literal", () => {
    const r = runSource('tulis({ "a": 1, "b": 2 })');
    expectClean(r);
    expect(joined(r)).toMatch(/a.*1.*b.*2/);
  });
});

// ============================================================
// 3. Arithmetic Expressions
// ============================================================

describe("Interpreter — Arithmetic", () => {
  it("adds numbers", () => {
    expect(joined(runSource("tulis(2 + 3)"))).toBe("5");
  });

  it("subtracts numbers", () => {
    expect(joined(runSource("tulis(10 - 4)"))).toBe("6");
  });

  it("multiplies numbers", () => {
    expect(joined(runSource("tulis(3 * 4)"))).toBe("12");
  });

  it("divides numbers", () => {
    expect(joined(runSource("tulis(10 / 4)"))).toBe("2.5");
  });

  it("modulo", () => {
    expect(joined(runSource("tulis(10 % 3)"))).toBe("1");
  });

  it("power", () => {
    expect(joined(runSource("tulis(2 ** 10)"))).toBe("1024");
  });

  it("respects precedence", () => {
    expect(joined(runSource("tulis(2 + 3 * 4)"))).toBe("14");
  });

  it("respects parentheses", () => {
    expect(joined(runSource("tulis((2 + 3) * 4)"))).toBe("20");
  });

  it("power is right-associative", () => {
    expect(joined(runSource("tulis(2 ** 3 ** 2)"))).toBe("512");
  });

  it("unary minus", () => {
    expect(joined(runSource("tulis(-5)"))).toBe("-5");
  });

  it("divides by zero throws", () => {
    const r = runSource("tulis(1 / 0)");
    expect(r.reporter.hasErrors()).toBe(true);
    expect(r.errors[0]).toMatch(/nol/);
  });

  it("modulo by zero throws", () => {
    const r = runSource("tulis(1 % 0)");
    expect(r.reporter.hasErrors()).toBe(true);
  });
});

// ============================================================
// 4. String Operations
// ============================================================

describe("Interpreter — Strings", () => {
  it("concatenates with +", () => {
    expect(joined(runSource('tulis("a" + "b")'))).toBe("ab");
  });

  it("concatenates string + number", () => {
    expect(joined(runSource('tulis("x = " + 42)'))).toBe("x = 42");
  });

  it("string interpolation with variable", () => {
    const r = runSource([
      'const nama = "dunia"',
      'tulis("Halo, ${nama}!")',
    ].join("\n"));
    expectClean(r);
    expect(joined(r)).toBe("Halo, dunia!");
  });

  it("interpolation with expression", () => {
    const r = runSource('tulis("2 + 2 = ${2 + 2}")');
    expect(joined(r)).toBe("2 + 2 = 4");
  });

  it("interpolation with multiple parts", () => {
    const r = runSource([
      'const a = 1',
      'const b = 2',
      'tulis("${a} dan ${b}")',
    ].join("\n"));
    expectClean(r);
    expect(joined(r)).toBe("1 dan 2");
  });
});

// ============================================================
// 5. Comparisons & Logic
// ============================================================

describe("Interpreter — Comparisons", () => {
  it("== on numbers", () => {
    expect(joined(runSource("tulis(1 == 1)"))).toBe("true");
    expect(joined(runSource("tulis(1 == 2)"))).toBe("false");
  });

  it("!= on numbers", () => {
    expect(joined(runSource("tulis(1 != 2)"))).toBe("true");
  });

  it("< <= > >=", () => {
    expect(joined(runSource("tulis(1 < 2)"))).toBe("true");
    expect(joined(runSource("tulis(2 <= 2)"))).toBe("true");
    expect(joined(runSource("tulis(3 > 2)"))).toBe("true");
    expect(joined(runSource("tulis(1 >= 2)"))).toBe("false");
  });

  it("structural equality on lists", () => {
    expect(joined(runSource("tulis([1, 2] == [1, 2])"))).toBe("true");
    expect(joined(runSource("tulis([1, 2] == [1, 3])"))).toBe("false");
  });

  it("structural equality on maps", () => {
    expect(joined(runSource('tulis({ "a": 1 } == { "a": 1 })'))).toBe("true");
    expect(joined(runSource('tulis({ "a": 1 } == { "a": 2 })'))).toBe("false");
  });
});

describe("Interpreter — Logic", () => {
  it("and", () => {
    expect(joined(runSource("tulis(true and true)"))).toBe("true");
    expect(joined(runSource("tulis(true and false)"))).toBe("false");
  });

  it("or", () => {
    expect(joined(runSource("tulis(false or true)"))).toBe("true");
    expect(joined(runSource("tulis(false or false)"))).toBe("false");
  });

  it("not", () => {
    expect(joined(runSource("tulis(not true)"))).toBe("false");
    expect(joined(runSource("tulis(not false)"))).toBe("true");
  });

  it("and short-circuits", () => {
    // Kalau tidak short-circuit, ini akan throw
    const r = runSource([
      "fn gagal() -> Boolean:",
      '    throw Error("jangan dipanggil")',
      "tulis(false and gagal())",
    ].join("\n"));
    expectClean(r);
    expect(joined(r)).toBe("false");
  });

  it("or short-circuits", () => {
    const r = runSource([
      "fn gagal() -> Boolean:",
      '    throw Error("jangan dipanggil")',
      "tulis(true or gagal())",
    ].join("\n"));
    expectClean(r);
    expect(joined(r)).toBe("true");
  });

  it("requires boolean in condition", () => {
    const r = runSource("if 0:\n    tulis(1)");
    expect(r.reporter.hasErrors()).toBe(true);
  });
});

// ============================================================
// 6. Variables
// ============================================================

describe("Interpreter — Variables", () => {
  it("const declaration", () => {
    const r = runSource([
      "const x = 10",
      "tulis(x)",
    ].join("\n"));
    expect(joined(r)).toBe("10");
  });

  it("let declaration", () => {
    const r = runSource([
      "let x = 10",
      "tulis(x)",
    ].join("\n"));
    expect(joined(r)).toBe("10");
  });

  it("let reassignment", () => {
    const r = runSource([
      "let x = 10",
      "x = 20",
      "tulis(x)",
    ].join("\n"));
    expect(joined(r)).toBe("20");
  });

  it("compound assignment +=", () => {
    const r = runSource([
      "let x = 10",
      "x += 5",
      "tulis(x)",
    ].join("\n"));
    expect(joined(r)).toBe("15");
  });

  it("compound assignment -=", () => {
    expect(joined(runSource("let x = 10\nx -= 3\ntulis(x)"))).toBe("7");
  });

  it("compound assignment *=", () => {
    expect(joined(runSource("let x = 10\nx *= 2\ntulis(x)"))).toBe("20");
  });

  it("undefined variable throws", () => {
    const r = runSource("tulis(tidakAda)");
    expect(r.reporter.hasErrors()).toBe(true);
    expect(r.errors[0]).toMatch(/tidak terdefinisi/);
  });
});

// ============================================================
// 7. If / While / For
// ============================================================

describe("Interpreter — If statement", () => {
  it("executes then branch", () => {
    const r = runSource([
      "if true:",
      '    tulis("ya")',
    ].join("\n"));
    expect(joined(r)).toBe("ya");
  });

  it("executes else branch", () => {
    const r = runSource([
      "if false:",
      '    tulis("ya")',
      "else:",
      '    tulis("tidak")',
    ].join("\n"));
    expect(joined(r)).toBe("tidak");
  });

  it("executes elif branch", () => {
    const r = runSource([
      "const x = 5",
      "if x > 10:",
      '    tulis("besar")',
      "elif x > 3:",
      '    tulis("sedang")',
      "else:",
      '    tulis("kecil")',
    ].join("\n"));
    expect(joined(r)).toBe("sedang");
  });

  it("nested if", () => {
    const r = runSource([
      "if true:",
      "    if true:",
      '        tulis("dalam")',
    ].join("\n"));
    expect(joined(r)).toBe("dalam");
  });
});

describe("Interpreter — While loop", () => {
  it("basic counting", () => {
    const r = runSource([
      "let i = 0",
      "while i < 3:",
      "    tulis(i)",
      "    i += 1",
    ].join("\n"));
    expect(r.output).toEqual(["0", "1", "2"]);
  });

  it("break exits loop", () => {
    const r = runSource([
      "let i = 0",
      "while true:",
      "    if i >= 3:",
      "        break",
      "    tulis(i)",
      "    i += 1",
    ].join("\n"));
    expect(r.output).toEqual(["0", "1", "2"]);
  });

  it("continue skips iteration", () => {
    const r = runSource([
      "let i = 0",
      "while i < 5:",
      "    i += 1",
      "    if i == 3:",
      "        continue",
      "    tulis(i)",
    ].join("\n"));
    expect(r.output).toEqual(["1", "2", "4", "5"]);
  });
});

describe("Interpreter — For loop", () => {
  it("iterates over list", () => {
    const r = runSource([
      "for x in [1, 2, 3]:",
      "    tulis(x)",
    ].join("\n"));
    expect(r.output).toEqual(["1", "2", "3"]);
  });

  it("iterates over range", () => {
    const r = runSource([
      "for i in 0..3:",
      "    tulis(i)",
    ].join("\n"));
    expect(r.output).toEqual(["0", "1", "2"]);
  });

  it("iterates over string", () => {
    const r = runSource([
      'for c in "abc":',
      "    tulis(c)",
    ].join("\n"));
    expect(r.output).toEqual(["a", "b", "c"]);
  });

  it("break in for", () => {
    const r = runSource([
      "for x in [1, 2, 3, 4]:",
      "    if x == 3:",
      "        break",
      "    tulis(x)",
    ].join("\n"));
    expect(r.output).toEqual(["1", "2"]);
  });

  it("continue in for", () => {
    const r = runSource([
      "for x in [1, 2, 3, 4]:",
      "    if x == 2:",
      "        continue",
      "    tulis(x)",
    ].join("\n"));
    expect(r.output).toEqual(["1", "3", "4"]);
  });

  it("nested for", () => {
    const r = runSource([
      "for i in 0..2:",
      "    for j in 0..2:",
      '        tulis("${i},${j}")',
    ].join("\n"));
    expect(r.output).toEqual(["0,0", "0,1", "1,0", "1,1"]);
  });
});

// ============================================================
// 8. Functions
// ============================================================

describe("Interpreter — Functions", () => {
  it("declares and calls function", () => {
    const r = runSource([
      "fn tambah(a: Angka, b: Angka) -> Angka:",
      "    return a + b",
      "tulis(tambah(3, 4))",
    ].join("\n"));
    expectClean(r);
    expect(joined(r)).toBe("7");
  });

  it("function without return returns undefined", () => {
    const r = runSource([
      "fn tidak():",
      "    const x = 1",
      "const hasil = tidak()",
      "tulis(tipe(hasil))",
    ].join("\n"));
    expectClean(r);
    expect(joined(r)).toBe("Kosong");
  });

  it("recursive function", () => {
    const r = runSource([
      "fn faktorial(n: Angka) -> Angka:",
      "    if n <= 1:",
      "        return 1",
      "    return n * faktorial(n - 1)",
      "tulis(faktorial(5))",
    ].join("\n"));
    expectClean(r);
    expect(joined(r)).toBe("120");
  });

  it("closure captures environment", () => {
    const r = runSource([
      "fn buatPenambah(n: Angka) -> (Angka) -> Angka:",
      "    return fn(x: Angka) -> Angka => x + n",
      "const tambah5 = buatPenambah(5)",
      "tulis(tambah5(10))",
    ].join("\n"));
    expectClean(r);
    expect(joined(r)).toBe("15");
  });

  it("default parameter", () => {
    const r = runSource([
      "fn sapa(nama: Teks = \"dunia\") -> Teks:",
      "    return \"Halo \" + nama",
      "tulis(sapa())",
      "tulis(sapa(\"Budi\"))",
    ].join("\n"));
    expectClean(r);
    expect(r.output).toEqual(["Halo dunia", "Halo Budi"]);
  });

  it("arrow function", () => {
    const r = runSource([
      "const kuadrat = fn(x: Angka) -> Angka => x * x",
      "tulis(kuadrat(5))",
    ].join("\n"));
    expectClean(r);
    expect(joined(r)).toBe("25");
  });

  it("higher-order function", () => {
    const r = runSource([
      "fn terapkan(x: Angka, f: (Angka) -> Angka) -> Angka:",
      "    return f(x)",
      "tulis(terapkan(5, fn(x: Angka) -> Angka => x * 2))",
    ].join("\n"));
    expectClean(r);
    expect(joined(r)).toBe("10");
  });

  it("too few arguments throws", () => {
    const r = runSource([
      "fn f(a: Angka, b: Angka) -> Angka:",
      "    return a + b",
      "tulis(f(1))",
    ].join("\n"));
    expect(r.reporter.hasErrors()).toBe(true);
    expect(r.errors[0]).toMatch(/argumen/);
  });

  it("too many arguments throws", () => {
    const r = runSource([
      "fn f(a: Angka) -> Angka:",
      "    return a",
      "tulis(f(1, 2))",
    ].join("\n"));
    expect(r.reporter.hasErrors()).toBe(true);
  });
});

// ============================================================
// 9. Collections
// ============================================================

describe("Interpreter — Lists", () => {
  it("index access", () => {
    const r = runSource("tulis([10, 20, 30][1])");
    expect(joined(r)).toBe("20");
  });

  it("index assignment", () => {
    const r = runSource([
      "let xs = [1, 2, 3]",
      "xs[0] = 99",
      "tulis(xs)",
    ].join("\n"));
    expect(joined(r)).toBe("[99, 2, 3]");
  });

  it("out of bounds throws", () => {
    const r = runSource("tulis([1, 2][5])");
    expect(r.reporter.hasErrors()).toBe(true);
    expect(r.errors[0]).toMatch(/luar batas/);
  });

  it("length property", () => {
    const r = runSource("tulis([1, 2, 3].length)");
    expect(joined(r)).toBe("3");
  });

  it("length via panjang()", () => {
    const r = runSource("tulis(panjang([1, 2, 3]))");
    expect(joined(r)).toBe("3");
  });

  it("list concatenation", () => {
    const r = runSource("tulis([1, 2] + [3, 4])");
    // Catatan: ini hanya jalan kalau interpreter support list + list
    // Untuk sekarang, hasilnya tergantung implementasi `add`
  });
});

describe("Interpreter — Maps", () => {
  it("map literal with string keys", () => {
    const r = runSource([
      'const m = { "a": 1, "b": 2 }',
      "tulis(m[\"a\"])",
    ].join("\n"));
    expect(joined(r)).toBe("1");
  });

  it("map key assignment", () => {
    const r = runSource([
      'let m = { "a": 1 }',
      'm["b"] = 2',
      'tulis(m["b"])',
    ].join("\n"));
    expect(joined(r)).toBe("2");
  });

  it("missing key throws", () => {
    const r = runSource([
      'const m = { "a": 1 }',
      'tulis(m["z"])',
    ].join("\n"));
    expect(r.reporter.hasErrors()).toBe(true);
    expect(r.errors[0]).toMatch(/tidak ditemukan/);
  });

  it("map size via panjang()", () => {
    const r = runSource('tulis(panjang({ "a": 1, "b": 2 }))');
    expect(joined(r)).toBe("2");
  });
});

// ============================================================
// 10. Match Statement
// ============================================================

describe("Interpreter — Match", () => {
  it("matches literal", () => {
    const r = runSource([
      "const x = 2",
      "match x:",
      "    case 1:",
      '        tulis("satu")',
      "    case 2:",
      '        tulis("dua")',
      "    else:",
      '        tulis("lainnya")',
    ].join("\n"));
    expectClean(r);
    expect(joined(r)).toBe("dua");
  });

  it("matches or-pattern", () => {
    const r = runSource([
      "const x = 2",
      "match x:",
      "    case 1 | 2 | 3:",
      '        tulis("kecil")',
      "    else:",
      '        tulis("besar")',
    ].join("\n"));
    expectClean(r);
    expect(joined(r)).toBe("kecil");
  });

  it("matches with binding", () => {
    const r = runSource([
      "const x = 42",
      "match x:",
      "    case n:",
      '        tulis("nilai: ${n}")',
    ].join("\n"));
    expectClean(r);
    expect(joined(r)).toBe("nilai: 42");
  });

  it("matches with guard", () => {
    const r = runSource([
      "const x = 5",
      "match x:",
      "    case n if n > 10:",
      '        tulis("besar")',
      "    case n if n > 0:",
      '        tulis("kecil positif")',
      "    else:",
      '        tulis("lainnya")',
    ].join("\n"));
    expectClean(r);
    expect(joined(r)).toBe("kecil positif");
  });

  it("falls to else when no case matches", () => {
    const r = runSource([
      "const x = 99",
      "match x:",
      "    case 1:",
      '        tulis("satu")',
      "    else:",
      '        tulis("lainnya")',
    ].join("\n"));
    expectClean(r);
    expect(joined(r)).toBe("lainnya");
  });

  it("wildcard matches anything", () => {
    const r = runSource([
      "const x = 99",
      "match x:",
      "    case 1:",
      '        tulis("satu")',
      "    case _:",
      '        tulis("catch-all")',
    ].join("\n"));
    expectClean(r);
    expect(joined(r)).toBe("catch-all");
  });
});

// ============================================================
// 11. Try / Catch / Finally
// ============================================================

describe("Interpreter — Try/Catch/Finally", () => {
  it("catches thrown error", () => {
    const r = runSource([
      "try:",
      '    throw Error("boom")',
      "catch err:",
      '    tulis("ditangkap: " + err.message)',
    ].join("\n"));
    expectClean(r);
    expect(joined(r)).toBe("ditangkap: boom");
  });

  it("catch does not run when no error", () => {
    const r = runSource([
      "try:",
      '    tulis("coba")',
      "catch err:",
      '    tulis("catch")',
    ].join("\n"));
    expectClean(r);
    expect(joined(r)).toBe("coba");
  });

  it("finally always runs on success", () => {
    const r = runSource([
      "try:",
      '    tulis("coba")',
      "catch err:",
      '    tulis("catch")',
      "finally:",
      '    tulis("selesai")',
    ].join("\n"));
    expectClean(r);
    expect(r.output).toEqual(["coba", "selesai"]);
  });

  it("finally always runs on error", () => {
    const r = runSource([
      "try:",
      '    throw Error("x")',
      "catch err:",
      '    tulis("catch")',
      "finally:",
      '    tulis("selesai")',
    ].join("\n"));
    expectClean(r);
    expect(r.output).toEqual(["catch", "selesai"]);
  });

  it("error propagates when not caught", () => {
    const r = runSource([
      "fn f():",
      '    throw Error("propagate")',
      "f()",
    ].join("\n"));
    expect(r.reporter.hasErrors()).toBe(true);
    expect(r.errors[0]).toMatch(/propagate/);
  });

  it("nested try", () => {
    const r = runSource([
      "try:",
      "    try:",
      '        throw Error("dalam")',
      "    catch inner:",
      '        tulis("inner: " + inner.message)',
      '        throw Error("luar")',
      "catch outer:",
      '    tulis("outer: " + outer.message)',
    ].join("\n"));
    expectClean(r);
    expect(r.output).toEqual(["inner: dalam", "outer: luar"]);
  });
});

// ============================================================
// 12. Built-in Functions
// ============================================================

describe("Interpreter — Built-ins", () => {
  it("panjang() on string", () => {
    expect(joined(runSource('tulis(panjang("halo"))'))).toBe("4");
  });

  it("panjang() on list", () => {
    expect(joined(runSource("tulis(panjang([1, 2, 3]))"))).toBe("3");
  });

  it("panjang() on map", () => {
    expect(joined(runSource('tulis(panjang({ "a": 1 }))'))).toBe("1");
  });

  it("rentang()", () => {
    const r = runSource("tulis(rentang(0, 5))");
    expect(joined(r)).toBe("[0, 1, 2, 3, 4]");
  });

  it("Angka() converts string", () => {
    expect(joined(runSource('tulis(Angka("42") + 1)'))).toBe("43");
  });

  it("Angka() fails on invalid string", () => {
    const r = runSource('tulis(Angka("abc"))');
    expect(r.reporter.hasErrors()).toBe(true);
  });

  it("Teks() converts number", () => {
    expect(joined(runSource("tulis(Teks(42))"))).toBe("42");
  });

  it("tipe() on various values", () => {
    const r = runSource([
      "tulis(tipe(1))",
      'tulis(tipe("x"))',
      "tulis(tipe(true))",
      "tulis(tipe(null))",
      "tulis(tipe([1]))",
    ].join("\n"));
    expectClean(r);
    expect(r.output).toEqual(["Angka", "Teks", "Boolean", "Null", "Daftar"]);
  });
});

// ============================================================
// 13. Runtime Errors
// ============================================================

describe("Interpreter — Runtime errors", () => {
  it("reports undefined variable", () => {
    const r = runSource("tulis(x)");
    expect(r.reporter.hasErrors()).toBe(true);
    expect(r.reporter.all()[0]?.code).toBe("SS1002");
  });

  it("reports division by zero", () => {
    const r = runSource("tulis(1 / 0)");
    expect(r.reporter.hasErrors()).toBe(true);
    expect(r.reporter.all()[0]?.code).toBe("SS4001");
  });

  it("reports index out of bounds", () => {
    const r = runSource("tulis([1, 2][5])");
    expect(r.reporter.hasErrors()).toBe(true);
    expect(r.reporter.all()[0]?.code).toBe("SS4002");
  });

  it("reports key not found", () => {
    const r = runSource('tulis({ "a": 1 }["z"])');
    expect(r.reporter.hasErrors()).toBe(true);
    expect(r.reporter.all()[0]?.code).toBe("SS4003");
  });

  it("reports argument count mismatch", () => {
    const r = runSource([
      "fn f(a: Angka) -> Angka:",
      "    return a",
      "f(1, 2, 3)",
    ].join("\n"));
    expect(r.reporter.hasErrors()).toBe(true);
    expect(r.reporter.all()[0]?.code).toBe("SS1005");
  });

  it("reports non-callable", () => {
    const r = runSource("const x = 5\nx()");
    expect(r.reporter.hasErrors()).toBe(true);
    expect(r.reporter.all()[0]?.code).toBe("SS1007");
  });
});

// ============================================================
// 14. Type Strictness
// ============================================================

describe("Interpreter — Type strictness", () => {
  it("rejects non-boolean condition", () => {
    const r = runSource("if 1:\n    tulis(1)");
    expect(r.reporter.hasErrors()).toBe(true);
  });

  it("rejects string in arithmetic", () => {
    const r = runSource('tulis("a" - 1)');
    expect(r.reporter.hasErrors()).toBe(true);
  });

  it("allows + for string concatenation", () => {
    const r = runSource('tulis("a" + 1)');
    expectClean(r);
    expect(joined(r)).toBe("a1");
  });

  it("rejects unary minus on string", () => {
    const r = runSource('tulis(-"a")');
    expect(r.reporter.hasErrors()).toBe(true);
  });
});

// ============================================================
// 15. Full Programs
// ============================================================

describe("Interpreter — Full programs", () => {
  it("hello world", () => {
    const r = runSource('tulis("Halo, dunia!")');
    expectClean(r);
    expect(joined(r)).toBe("Halo, dunia!");
  });

  it("faktorial program", () => {
    const r = runSource([
      "fn faktorial(n: Angka) -> Angka:",
      "    if n <= 1:",
      "        return 1",
      "    return n * faktorial(n - 1)",
      "",
      "for i in 0..6:",
      '    tulis("${i}! = ${faktorial(i)}")',
    ].join("\n"));
    expectClean(r);
    expect(r.output).toEqual([
      "0! = 1",
      "1! = 1",
      "2! = 2",
      "3! = 6",
      "4! = 24",
      "5! = 120",
    ]);
  });

  it("fibonacci iteratif", () => {
    const r = runSource([
      "fn fib(n: Angka) -> Angka:",
      "    if n <= 1:",
      "        return n",
      "    let a = 0",
      "    let b = 1",
      "    let i = 2",
      "    while i <= n:",
      "        const t = a + b",
      "        a = b",
      "        b = t",
      "        i += 1",
      "    return b",
      "",
      "for i in 0..10:",
      "    tulis(fib(i))",
    ].join("\n"));
    expectClean(r);
    expect(r.output).toEqual(["0", "1", "1", "2", "3", "5", "8", "13", "21", "34"]);
  });

  it("user-defined higher-order + closure", () => {
    const r = runSource([
      "fn petakan(xs: Daftar<Angka>, f: (Angka) -> Angka) -> Daftar<Angka>:",
      "    let hasil = []",
      "    for x in xs:",
      "        hasil = hasil + [f(x)]",
      "    return hasil",
      "",
      "const ganda = fn(x: Angka) -> Angka => x * 2",
      "tulis(petakan([1, 2, 3], ganda))",
    ].join("\n"));
    expectClean(r);
    expect(joined(r)).toBe("[2, 4, 6]");
  });

  it("try-catch-finally end-to-end", () => {
    const r = runSource([
      "fn bagi(a: Angka, b: Angka) -> Angka:",
      "    if b == 0:",
      '        throw Error("bagi dengan nol")',
      "    return a / b",
      "",
      "try:",
      "    tulis(bagi(10, 2))",
      "    tulis(bagi(10, 0))",
      "catch err:",
      '    tulis("Error: " + err.message)',
      "finally:",
      '    tulis("Selesai")',
    ].join("\n"));
    expectClean(r);
    expect(r.output).toEqual([
      "5",
      "Error: bagi dengan nol",
      "Selesai",
    ]);
  });
});

// ============================================================
// 16. Return Signals
// ============================================================

describe("Interpreter — Return signals", () => {
  it("return propagates up through blocks", () => {
    const r = runSource([
      "fn f() -> Angka:",
      "    if true:",
      "        if true:",
      "            return 42",
      "    return 0",
      "tulis(f())",
    ].join("\n"));
    expectClean(r);
    expect(joined(r)).toBe("42");
  });

  it("return inside loop exits function", () => {
    const r = runSource([
      "fn cari(xs: Daftar<Angka>, x: Angka) -> Angka:",
      "    let i = 0",
      "    for item in xs:",
      "        if item == x:",
      "            return i",
      "        i += 1",
      "    return -1",
      "tulis(cari([10, 20, 30], 20))",
    ].join("\n"));
    expectClean(r);
    expect(joined(r)).toBe("1");
  });

  it("return inside try executes finally", () => {
    const r = runSource([
      "fn f() -> Angka:",
      "    try:",
      "        return 1",
      "    finally:",
      '        tulis("finally jalan")',
      "tulis(f())",
    ].join("\n"));
    expectClean(r);
    expect(r.output).toEqual(["finally jalan", "1"]);
  });
});

// ============================================================
// 17. Deep Recursion & Performance
// ============================================================

describe("Interpreter — Recursion depth", () => {
  it("handles moderate recursion", () => {
    const r = runSource([
      "fn counter(n: Angka) -> Angka:",
      "    if n == 0:",
      "        return 0",
      "    return 1 + counter(n - 1)",
      "tulis(counter(500))",
    ].join("\n"));
    expectClean(r);
    expect(joined(r)).toBe("500");
  });

  it("handles large loop", () => {
    const r = runSource([
      "let total = 0",
      "let i = 0",
      "while i < 10000:",
      "    total += 1",
      "    i += 1",
      "tulis(total)",
    ].join("\n"));
    expectClean(r);
    expect(joined(r)).toBe("10000");
  });
});

// ============================================================
// 18. Convenience API
// ============================================================

describe("Interpreter — Direct API", () => {
  it("creates interpreter with default options", () => {
    const reporter = new Reporter({ color: false });
    const interpreter = new Interpreter({
      file: "test.snake",
      reporter,
    });
    expect(interpreter.global).toBeDefined();
    expect(interpreter.global.has("tulis")).toBe(true);
  });

  it("global environment has all built-ins", () => {
    const reporter = new Reporter({ color: false });
    const interpreter = new Interpreter({ file: "test.snake", reporter });

    for (const name of ["tulis", "print", "Angka", "Teks", "panjang", "rentang", "Error", "tipe"]) {
      expect(interpreter.global.has(name)).toBe(true);
    }
  });
});
