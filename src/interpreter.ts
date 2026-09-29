/**
 * Snake Script — Interpreter
 *
 * Mengeksekusi AST secara langsung (tree-walking interpreter).
 *
 * Arsitektur:
 * - Environment: scope chain untuk variabel
 * - Value: runtime value (number, string, bool, null, list, map, function)
 * - Control flow: return/break/continue dilempar sebagai sinyal internal
 * - Error handling: try/catch lewat exception
 *
 * Interpreter bekerja setelah analyzer (kalau ada) atau langsung
 * dari parser. Untuk sekarang, tanpa type-checking runtime yang ketat.
 */

import type {
  ProgramNode,
  StmtNode,
  ExprNode,
  TypeNode,
  BlockNode,
  ParamNode,
  PatternNode,
  BinaryOperator,
  UnaryOperator,
  AssignOperator,
  FunctionDeclNode,
  VarDeclNode,
  FunctionExprNode,
  IfStmtNode,
  WhileStmtNode,
  ForStmtNode,
  MatchStmtNode,
  TryStmtNode,
  ReturnStmtNode,
  BreakStmtNode,
  ContinueStmtNode,
  ThrowStmtNode,
  ExprStmtNode,
  ImportStmtNode,
  ExportStmtNode,
  TypeDeclNode,
  LiteralNode,
  IdentifierNode,
  BinaryExprNode,
  UnaryExprNode,
  AssignExprNode,
  MemberExprNode,
  IndexExprNode,
  CallExprNode,
  ListExprNode,
  MapExprNode,
  InterpolatedStringNode,
  FunctionExprNode,
  ParenExprNode,
  CaseClauseNode,
} from "./ast.ts";

import type { Reporter } from "./diagnostics.ts";
import { ErrorCode } from "./diagnostics.ts";

// ============================================================
// Runtime Values
// ============================================================

/**
 * Nilai runtime. Snake Script pakai representasi TypeScript native
 * di mana memungkinkan:
 * - Angka   -> number
 * - Teks    -> string
 * - Boolean -> boolean
 * - Null    -> null
 * - Kosong  -> undefined (void return)
 * - Daftar  -> JS Array
 * - Peta    -> Map
 * - Fungsi  -> FunctionValue (closure)
 * - Error   -> ErrorValue
 */
export type Value =
  | number
  | string
  | boolean
  | null
  | undefined
  | Value[]
  | Map<string, Value>
  | FunctionValue
  | ErrorValue
  | NativeFunctionValue;

/**
 * Fungsi user-defined. Menyimpan:
 * - params: definisi parameter
 * - body: statement atau ekspresi (arrow)
 * - closure: environment saat fungsi dibuat
 * - name: untuk debugging
 */
export interface FunctionValue {
  readonly kind: "Function";
  readonly name: string;
  readonly params: readonly ParamNode[];
  readonly body: BlockNode | ExprNode;
  readonly closure: Environment;
  /** True kalau body adalah expression (arrow function). */
  readonly isArrow: boolean;
}

/**
 * Fungsi bawaan yang diimplementasikan di TypeScript.
 */
export interface NativeFunctionValue {
  readonly kind: "NativeFunction";
  readonly name: string;
  readonly arity: number | "variadic";
  readonly call: (args: Value[]) => Value;
}

/**
 * Error value — dipakai oleh `throw` dan `catch`.
 */
export interface ErrorValue {
  readonly kind: "Error";
  readonly message: string;
  readonly code?: string;
}

// ============================================================
// Environment
// ============================================================

/**
 * Scope chain. Setiap environment punya pointer ke parent.
 * Lookup berjalan naik sampai ketemu atau null.
 */
export class Environment {
  private readonly values = new Map<string, Value>();
  readonly parent: Environment | null;

  constructor(parent: Environment | null = null) {
    this.parent = parent;
  }

  /**
   * Definisikan variabel baru di scope saat ini.
   */
  define(name: string, value: Value): void {
    this.values.set(name, value);
  }

  /**
   * Cari nilai variabel. Cari di scope ini dulu, lalu parent.
   * Return undefined kalau tidak ketemu. Ini ambigu dengan nilai
   * `undefined` — kita pakai has() untuk cek keberadaan.
   */
  get(name: string): Value {
    if (this.values.has(name)) {
      return this.values.get(name);
    }
    if (this.parent) {
      return this.parent.get(name);
    }
    return undefined;
  }

  /**
   * Cek apakah variabel ada di scope chain.
   */
  has(name: string): boolean {
    if (this.values.has(name)) return true;
    if (this.parent) return this.parent.has(name);
    return false;
  }

  /**
   * Assign nilai ke variabel yang sudah ada. Cari di scope chain.
   * Return true kalau berhasil, false kalau variabel belum didefinisikan.
   */
  assign(name: string, value: Value): boolean {
    if (this.values.has(name)) {
      this.values.set(name, value);
      return true;
    }
    if (this.parent) {
      return this.parent.assign(name, value);
    }
    return false;
  }

  /**
   * Snapshot untuk debugging.
   */
  snapshot(): Record<string, Value> {
    return Object.fromEntries(this.values);
  }
}

// ============================================================
// Control Flow Signals
// ============================================================

/**
 * Sinyal `return`. Dilempar dari dalam fungsi untuk unwind stack
 * sampai ketemu pemanggil fungsi.
 */
class ReturnSignal {
  constructor(public readonly value: Value) {}
}

/**
 * Sinyal `break`. Dilempar untuk keluar dari loop.
 */
class BreakSignal {}

/**
 * Sinyal `continue`. Dilempar untuk lanjut ke iterasi berikutnya.
 */
class ContinueSignal {}

/**
 * Error runtime yang di-throw oleh program Snake Script.
 */
export class RuntimeError extends Error {
  constructor(
    public readonly value: ErrorValue,
    public readonly location?: import("./ast.ts").Location,
  ) {
    super(value.message);
    this.name = "RuntimeError";
  }
}

// ============================================================
// Interpreter Options
// ============================================================

export interface InterpreterOptions {
  readonly file: string;
  readonly reporter: Reporter;
  /** Callback untuk output `print` / `tulis`. Default: stdout. */
  readonly onPrint?: (line: string) => void;
  /** Direktori kerja untuk import relatif. Default: cwd. */
  readonly cwd?: string;
}

// ============================================================
// Interpreter
// ============================================================

export class Interpreter {
  private readonly file: string;
  private readonly reporter: Reporter;
  private readonly onPrint: (line: string) => void;
  private readonly cwd: string;

  /** Global environment. Persisten sepanjang eksekusi. */
  readonly global: Environment;

  /** Cache modul yang sudah di-import (kalau ada). */
  private readonly moduleCache = new Map<string, Environment>();

  constructor(opts: InterpreterOptions) {
    this.file = opts.file;
    this.reporter = opts.reporter;
    this.onPrint = opts.onPrint ?? ((line) => process.stdout.write(line + "\n"));
    this.cwd = opts.cwd ?? process.cwd();
    this.global = new Environment(null);
    this.installBuiltins();
  }

  // ==========================================================
  // Public API
  // ==========================================================

  /**
   * Jalankan program.
   */
  run(program: ProgramNode): void {
    try {
      for (const stmt of program.statements) {
        this.executeStatement(stmt, this.global);
      }
    } catch (e) {
      if (e instanceof RuntimeError) {
        this.reporter.report({
          severity: "error",
          code: e.value.code ?? ErrorCode.INTERNAL_ERROR,
          message: e.value.message,
          location: e.location ?? program.loc,
        });
        return;
      }
      if (e instanceof ReturnSignal) {
        this.reporter.report({
          severity: "error",
          code: ErrorCode.UNEXPECTED_TOKEN,
          message: "`return` tidak boleh di top-level",
          location: program.loc,
        });
        return;
      }
      if (e instanceof BreakSignal) {
        this.reporter.report({
          severity: "error",
          code: ErrorCode.UNEXPECTED_TOKEN,
          message: "`break` tidak boleh di luar loop",
          location: program.loc,
        });
        return;
      }
      if (e instanceof ContinueSignal) {
        this.reporter.report({
          severity: "error",
          code: ErrorCode.UNEXPECTED_TOKEN,
          message: "`continue` tidak boleh di luar loop",
          location: program.loc,
        });
        return;
      }
      // Error tak terduga
      throw e;
    }
  }

  // ==========================================================
  // Statement Execution
  // ==========================================================

  private executeStatement(stmt: StmtNode, env: Environment): void {
    switch (stmt.kind) {
      case "VarDecl":
        return this.execVarDecl(stmt, env);
      case "FunctionDecl":
        return this.execFunctionDecl(stmt, env);
      case "TypeDecl":
        return this.execTypeDecl(stmt, env);
      case "ExprStmt":
        return this.execExprStmt(stmt, env);
      case "IfStmt":
        return this.execIf(stmt, env);
      case "WhileStmt":
        return this.execWhile(stmt, env);
      case "ForStmt":
        return this.execFor(stmt, env);
      case "MatchStmt":
        return this.execMatch(stmt, env);
      case "TryStmt":
        return this.execTry(stmt, env);
      case "ReturnStmt":
        return this.execReturn(stmt, env);
      case "BreakStmt":
        throw new BreakSignal();
      case "ContinueStmt":
        throw new ContinueSignal();
      case "ThrowStmt":
        return this.execThrow(stmt, env);
      case "ImportStmt":
        return this.execImport(stmt, env);
      case "ExportStmt":
        return this.executeStatement(stmt.declaration, env);
      default: {
        const _exhaustive: never = stmt;
        throw new Error(`Unknown statement: ${(_exhaustive as StmtNode).kind}`);
      }
    }
  }

  // ==========================================================
  // Statements — Declarations
  // ==========================================================

  private execVarDecl(stmt: VarDeclNode, env: Environment): void {
    let value: Value;

    if (stmt.initializer) {
      value = this.evaluate(stmt.initializer, env);
    } else {
      // Tanpa initializer: isi default per tipe
      value = this.defaultValueForType(stmt.typeAnnotation);
    }

    env.define(stmt.name, value);
  }

  private execFunctionDecl(stmt: FunctionDeclNode, env: Environment): void {
    const fn: FunctionValue = {
      kind: "Function",
      name: stmt.name,
      params: stmt.params,
      body: stmt.body,
      closure: env,
      isArrow: false,
    };
    env.define(stmt.name, fn);
  }

  private execTypeDecl(_stmt: TypeDeclNode, _env: Environment): void {
    // Type hanya compile-time — di runtime tidak ada efek.
    // Nanti bisa dipakai untuk reflection / debug info.
  }

  private execExprStmt(stmt: ExprStmtNode, env: Environment): void {
    this.evaluate(stmt.expression, env);
  }

  // ==========================================================
  // Statements — Control Flow
  // ==========================================================

  private execIf(stmt: IfStmtNode, env: Environment): void {
    if (this.truthy(this.evaluate(stmt.condition, env), stmt.condition)) {
      this.executeBlock(stmt.then, new Environment(env));
      return;
    }

    for (const elif of stmt.elifs) {
      if (this.truthy(this.evaluate(elif.condition, env), elif.condition)) {
        this.executeBlock(elif.body, new Environment(env));
        return;
      }
    }

    if (stmt.else) {
      this.executeBlock(stmt.else, new Environment(env));
    }
  }

  private execWhile(stmt: WhileStmtNode, env: Environment): void {
    while (this.truthy(this.evaluate(stmt.condition, env), stmt.condition)) {
      try {
        this.executeBlock(stmt.body, new Environment(env));
      } catch (e) {
        if (e instanceof BreakSignal) return;
        if (e instanceof ContinueSignal) continue;
        throw e;
      }
    }
  }

  private execFor(stmt: ForStmtNode, env: Environment): void {
    const iterable = this.evaluate(stmt.iterable, env);
    const items = this.iterate(iterable, stmt);

    for (const item of items) {
      const loopEnv = new Environment(env);
      loopEnv.define(stmt.variable, item);
      try {
        this.executeBlock(stmt.body, loopEnv);
      } catch (e) {
        if (e instanceof BreakSignal) return;
        if (e instanceof ContinueSignal) continue;
        throw e;
      }
    }
  }

  private execMatch(stmt: MatchStmtNode, env: Environment): void {
    const subject = this.evaluate(stmt.subject, env);

    for (const c of stmt.cases) {
      const bindings = new Map<string, Value>();
      if (this.matchPattern(c.pattern, subject, bindings)) {
        const caseEnv = new Environment(env);
        for (const [name, value] of bindings) {
          caseEnv.define(name, value);
        }

        // Guard
        if (c.guard) {
          if (!this.truthy(this.evaluate(c.guard, caseEnv), c.guard)) {
            continue;
          }
        }

        this.executeBlock(c.body, caseEnv);
        return;
      }
    }

    if (stmt.else) {
      this.executeBlock(stmt.else, new Environment(env));
    }
  }

  private matchPattern(
    pattern: PatternNode,
    value: Value,
    bindings: Map<string, Value>,
  ): boolean {
    switch (pattern.kind) {
      case "LiteralPattern":
        return this.valuesEqual(pattern.value, value);

      case "WildcardPattern":
        return true;

      case "BindingPattern":
        bindings.set(pattern.name, value);
        return true;

      case "OrPattern":
        for (const p of pattern.patterns) {
          if (this.matchPattern(p, value, bindings)) return true;
        }
        return false;
    }
  }

  private execTry(stmt: TryStmtNode, env: Environment): void {
    let caught: RuntimeError | null = null;

    try {
      this.executeBlock(stmt.body, new Environment(env));
    } catch (e) {
      if (e instanceof RuntimeError) {
        caught = e;
      } else if (e instanceof ReturnSignal || e instanceof BreakSignal || e instanceof ContinueSignal) {
        // Sinyal kontrol flow tidak ditangkap try/catch
        // tapi finally tetap dijalankan
        this.runFinally(stmt, env);
        throw e;
      } else {
        throw e;
      }
    }

    if (caught) {
      const catchEnv = new Environment(env);
      catchEnv.define(stmt.errorName, caught.value);
      try {
        this.executeBlock(stmt.catchBody, catchEnv);
      } catch (e) {
        // Kalau body catch juga throw, finally tetap jalan
        this.runFinally(stmt, env);
        throw e;
      }
    }

    this.runFinally(stmt, env);
  }

  private runFinally(stmt: TryStmtNode, env: Environment): void {
    if (stmt.finallyBody) {
      this.executeBlock(stmt.finallyBody, new Environment(env));
    }
  }

  private execReturn(stmt: ReturnStmtNode, env: Environment): void {
    const value = stmt.value ? this.evaluate(stmt.value, env) : undefined;
    throw new ReturnSignal(value);
  }

  private execThrow(stmt: ThrowStmtNode, env: Environment): void {
    const value = this.evaluate(stmt.value, env);
    const errorValue = this.toErrorValue(value);
    throw new RuntimeError(errorValue, stmt.loc);
  }

  private execImport(stmt: ImportStmtNode, _env: Environment): void {
    // Implementasi import lengkap butuh file system loader.
    // Untuk MVP, kita hanya dukung import dari module cache
    // dan stdlib built-in.
    //
    // Nanti: load file, parse, execute di environment baru,
    // lalu bind hasilnya ke env saat ini.

    if (!this.moduleCache.has(stmt.source)) {
      // Cek apakah ini stdlib internal
      if (stmt.source === "stdlib") {
        // Stdlib biasanya di-inject via installBuiltins()
        this.moduleCache.set(stmt.source, this.global);
      } else {
        this.reporter.report({
          severity: "error",
          code: ErrorCode.MODULE_NOT_FOUND,
          message: `modul tidak ditemukan: \`${stmt.source}\``,
          location: stmt.loc,
          helps: [
            "import dari file belum diimplementasikan",
            "gunakan modul bawaan seperti `stdlib`",
          ],
        });
        return;
      }
    }

    // Bind nama yang di-import ke env saat ini
    const mod = this.moduleCache.get(stmt.source)!;
    if (stmt.importKind === "named") {
      for (const name of stmt.names) {
        const v = mod.get(name);
        _env.define(name, v);
      }
    } else if (stmt.importKind === "namespace") {
      // Wrap semua sebagai Map
      const namespace = new Map<string, Value>(Object.entries(mod.snapshot()));
      _env.define(stmt.alias!, namespace);
    } else {
      // default import
      _env.define(stmt.alias!, mod);
    }
  }

  private executeBlock(block: BlockNode, env: Environment): void {
    for (const stmt of block.statements) {
      this.executeStatement(stmt, env);
    }
  }

  // ==========================================================
  // Expression Evaluation
  // ==========================================================

  private evaluate(expr: ExprNode, env: Environment): Value {
    switch (expr.kind) {
      case "Literal":
        return this.evalLiteral(expr);
      case "Identifier":
        return this.evalIdentifier(expr, env);
      case "BinaryExpr":
        return this.evalBinary(expr, env);
      case "UnaryExpr":
        return this.evalUnary(expr, env);
      case "AssignExpr":
        return this.evalAssign(expr, env);
      case "MemberExpr":
        return this.evalMember(expr, env);
      case "IndexExpr":
        return this.evalIndex(expr, env);
      case "CallExpr":
        return this.evalCall(expr, env);
      case "ListExpr":
        return this.evalList(expr, env);
      case "MapExpr":
        return this.evalMap(expr, env);
      case "InterpolatedString":
        return this.evalInterpolatedString(expr, env);
      case "FunctionExpr":
        return this.evalFunctionExpr(expr, env);
      case "ParenExpr":
        return this.evaluate(expr.inner, env);
      default: {
        const _exhaustive: never = expr;
        throw new Error(`Unknown expression: ${(_exhaustive as ExprNode).kind}`);
      }
    }
  }

  private evalLiteral(expr: LiteralNode): Value {
    return expr.value;
  }

  private evalIdentifier(expr: IdentifierNode, env: Environment): Value {
    if (!env.has(expr.name)) {
      throw new RuntimeError(
        {
          kind: "Error",
          message: `variabel tidak terdefinisi: \`${expr.name}\``,
          code: ErrorCode.UNDEFINED_VARIABLE,
        },
        expr.loc,
      );
    }
    return env.get(expr.name);
  }

  private evalBinary(expr: BinaryExprNode, env: Environment): Value {
    // Short-circuit untuk and/or
    if (expr.operator === "and") {
      const left = this.evaluate(expr.left, env);
      if (!this.truthy(left, expr.left)) return false;
      return this.truthy(this.evaluate(expr.right, env), expr.right);
    }

    if (expr.operator === "or") {
      const left = this.evaluate(expr.left, env);
      if (this.truthy(left, expr.left)) return true;
      return this.truthy(this.evaluate(expr.right, env), expr.right);
    }

    const left = this.evaluate(expr.left, env);
    const right = this.evaluate(expr.right, env);

    switch (expr.operator) {
      case "+":
        return this.add(left, right, expr);
      case "-":
        return this.numericOp(left, right, expr, (a, b) => a - b);
      case "*":
        return this.numericOp(left, right, expr, (a, b) => a * b);
      case "/":
        if (right === 0) {
          throw new RuntimeError(
            {
              kind: "Error",
              message: "pembagian dengan nol",
              code: ErrorCode.DIVISION_BY_ZERO,
            },
            expr.loc,
          );
        }
        return this.numericOp(left, right, expr, (a, b) => a / b);
      case "%":
        if (right === 0) {
          throw new RuntimeError(
            {
              kind: "Error",
              message: "modulo dengan nol",
              code: ErrorCode.DIVISION_BY_ZERO,
            },
            expr.loc,
          );
        }
        return this.numericOp(left, right, expr, (a, b) => a % b);
      case "**":
        return this.numericOp(left, right, expr, (a, b) => a ** b);
      case "==":
        return this.valuesEqual(left, right);
      case "!=":
        return !this.valuesEqual(left, right);
      case "<":
        return this.compareOp(left, right, expr, (a, b) => a < b);
      case "<=":
        return this.compareOp(left, right, expr, (a, b) => a <= b);
      case ">":
        return this.compareOp(left, right, expr, (a, b) => a > b);
      case ">=":
        return this.compareOp(left, right, expr, (a, b) => a >= b);
      default:
        throw new Error(`Unknown binary operator: ${expr.operator}`);
    }
  }

  private evalUnary(expr: UnaryExprNode, env: Environment): Value {
    const operand = this.evaluate(expr.operand, env);

    switch (expr.operator) {
      case "-":
        if (typeof operand !== "number") {
          throw new RuntimeError(
            {
              kind: "Error",
              message: `operator \`-\` hanya untuk Angka, dapat ${this.typeName(operand)}`,
              code: ErrorCode.INVALID_OPERATOR,
            },
            expr.loc,
          );
        }
        return -operand;
      case "not":
        return !this.truthy(operand, expr.operand);
    }
  }

  private evalAssign(expr: AssignExprNode, env: Environment): Value {
    // Kalau operator `=`, nilai = evaluate(value)
    // Kalau `+=`, dst: nilai = current op value
    let newValue: Value;

    if (expr.operator === "=") {
      newValue = this.evaluate(expr.value, env);
    } else {
      const current = this.readTarget(expr.target, env);
      const rhs = this.evaluate(expr.value, env);
      const op = expr.operator.slice(0, -1) as BinaryOperator;
      newValue = this.applyBinaryOp(op, current, rhs, expr);
    }

    this.writeTarget(expr.target, newValue, env);
    return newValue;
  }

  private readTarget(target: ExprNode, env: Environment): Value {
    if (target.kind === "Identifier") {
      return this.evalIdentifier(target, env);
    }
    if (target.kind === "MemberExpr") {
      return this.evalMember(target, env);
    }
    if (target.kind === "IndexExpr") {
      return this.evalIndex(target, env);
    }
    throw new RuntimeError(
      {
        kind: "Error",
        message: "target assignment tidak valid",
        code: ErrorCode.INVALID_OPERATOR,
      },
      target.loc,
    );
  }

  private writeTarget(target: ExprNode, value: Value, env: Environment): void {
    if (target.kind === "Identifier") {
      const ok = env.assign(target.name, value);
      if (!ok) {
        throw new RuntimeError(
          {
            kind: "Error",
            message: `variabel tidak terdefinisi: \`${target.name}\``,
            code: ErrorCode.UNDEFINED_VARIABLE,
          },
          target.loc,
        );
      }
      return;
    }

    if (target.kind === "MemberExpr") {
      const obj = this.evaluate(target.object, env);
      if (obj instanceof Map) {
        obj.set(target.property, value);
        return;
      }
      // Kalau object adalah Map-like object, treat sebagai peta
      if (typeof obj === "object" && obj !== null && !Array.isArray(obj)) {
        // Fallback: define di object
        (obj as unknown as Record<string, unknown>)[target.property] = value;
        return;
      }
      throw new RuntimeError(
        {
          kind: "Error",
          message: `tidak bisa set properti \`${target.property}\` pada ${this.typeName(obj)}`,
          code: ErrorCode.INVALID_OPERATOR,
        },
        target.loc,
      );
    }

    if (target.kind === "IndexExpr") {
      const obj = this.evaluate(target.object, env);
      const idx = this.evaluate(target.index, env);

      if (Array.isArray(obj)) {
        if (typeof idx !== "number") {
          throw new RuntimeError(
            {
              kind: "Error",
              message: `index Daftar harus Angka, dapat ${this.typeName(idx)}`,
              code: ErrorCode.INVALID_CAST,
            },
            target.loc,
          );
        }
        if (idx < 0 || idx >= obj.length) {
          throw new RuntimeError(
            {
              kind: "Error",
              message: `index di luar batas: ${idx} (panjang ${obj.length})`,
              code: ErrorCode.INDEX_OUT_OF_BOUNDS,
            },
            target.loc,
          );
        }
        obj[idx] = value;
        return;
      }

      if (obj instanceof Map) {
        const key = String(idx);
        obj.set(key, value);
        return;
      }

      throw new RuntimeError(
        {
          kind: "Error",
          message: `tidak bisa index ${this.typeName(obj)}`,
          code: ErrorCode.NOT_INDEXABLE,
        },
        target.loc,
      );
    }

    throw new RuntimeError(
      {
        kind: "Error",
        message: "target assignment tidak valid",
        code: ErrorCode.INVALID_OPERATOR,
      },
      target.loc,
    );
  }

  private evalMember(expr: MemberExprNode, env: Environment): Value {
    const obj = this.evaluate(expr.object, env);

    // Map: akses via key
    if (obj instanceof Map) {
      if (!obj.has(expr.property)) {
        throw new RuntimeError(
          {
            kind: "Error",
            message: `key tidak ditemukan di peta: \`${expr.property}\``,
            code: ErrorCode.KEY_NOT_FOUND,
          },
          expr.loc,
        );
      }
      return obj.get(expr.property);
    }

    // String: properti khusus
    if (typeof obj === "string") {
      if (expr.property === "length" || expr.property === "panjang") {
        return obj.length;
      }
      // Fallback: method belum diimplementasikan di sini.
      // Bisa diakses via method String.prototype.
      const prop = (obj as unknown as Record<string, Value>)[expr.property];
      if (prop !== undefined) return prop;
      throw new RuntimeError(
        {
          kind: "Error",
          message: `properti \`${expr.property}\` tidak ada pada Teks`,
          code: ErrorCode.UNKNOWN_FIELD,
        },
        expr.loc,
      );
    }

    // List: properti khusus
    if (Array.isArray(obj)) {
      if (expr.property === "length" || expr.property === "panjang") {
        return obj.length;
      }
      throw new RuntimeError(
        {
          kind: "Error",
          message: `properti \`${expr.property}\` tidak ada pada Daftar`,
          code: ErrorCode.UNKNOWN_FIELD,
        },
        expr.loc,
      );
    }

    // Object literal (dari TS interop atau map dalam bentuk object)
    if (typeof obj === "object" && obj !== null) {
      const prop = (obj as unknown as Record<string, Value>)[expr.property];
      if (prop !== undefined || expr.property in (obj as object)) {
        return prop;
      }
      throw new RuntimeError(
        {
          kind: "Error",
          message: `properti \`${expr.property}\` tidak ada pada ${this.typeName(obj)}`,
          code: ErrorCode.UNKNOWN_FIELD,
        },
        expr.loc,
      );
    }

    throw new RuntimeError(
      {
        kind: "Error",
        message: `tidak bisa akses properti \`${expr.property}\` pada ${this.typeName(obj)}`,
        code: ErrorCode.UNKNOWN_FIELD,
      },
      expr.loc,
    );
  }

  private evalIndex(expr: IndexExprNode, env: Environment): Value {
    const obj = this.evaluate(expr.object, env);
    const idx = this.evaluate(expr.index, env);

    // Daftar: index numerik
    if (Array.isArray(obj)) {
      if (typeof idx !== "number") {
        throw new RuntimeError(
          {
            kind: "Error",
            message: `index Daftar harus Angka, dapat ${this.typeName(idx)}`,
            code: ErrorCode.INVALID_CAST,
          },
          expr.loc,
        );
      }
      if (idx < 0 || idx >= obj.length) {
        throw new RuntimeError(
          {
            kind: "Error",
            message: `index di luar batas: ${idx} (panjang ${obj.length})`,
            code: ErrorCode.INDEX_OUT_OF_BOUNDS,
          },
          expr.loc,
        );
      }
      return obj[idx];
    }

    // Peta: index dengan string
    if (obj instanceof Map) {
      const key = String(idx);
      if (!obj.has(key)) {
        throw new RuntimeError(
          {
            kind: "Error",
            message: `key tidak ditemukan di peta: \`${key}\``,
            code: ErrorCode.KEY_NOT_FOUND,
          },
          expr.loc,
        );
      }
      return obj.get(key);
    }

    // Teks: index karakter
    if (typeof obj === "string") {
      if (typeof idx !== "number") {
        throw new RuntimeError(
          {
            kind: "Error",
            message: `index Teks harus Angka, dapat ${this.typeName(idx)}`,
            code: ErrorCode.INVALID_CAST,
          },
          expr.loc,
        );
      }
      if (idx < 0 || idx >= obj.length) {
        throw new RuntimeError(
          {
            kind: "Error",
            message: `index di luar batas: ${idx} (panjang ${obj.length})`,
            code: ErrorCode.INDEX_OUT_OF_BOUNDS,
          },
          expr.loc,
        );
      }
      return obj[idx]!;
    }

    throw new RuntimeError(
      {
        kind: "Error",
        message: `tipe ${this.typeName(obj)} tidak bisa di-index`,
        code: ErrorCode.NOT_INDEXABLE,
      },
      expr.loc,
    );
  }

  private evalCall(expr: CallExprNode, env: Environment): Value {
    // Khusus: `rentang(a, b)` dari range syntax
    const callee = this.evaluate(expr.callee, env);
    const args = expr.args.map((a) => this.evaluate(a, env));

    return this.callFunction(callee, args, expr);
  }

  private callFunction(
    callee: Value,
    args: Value[],
    expr: CallExprNode,
  ): Value {
    // Fungsi native
    if (this.isNativeFunction(callee)) {
      if (callee.arity !== "variadic" && args.length !== callee.arity) {
        throw new RuntimeError(
          {
            kind: "Error",
            message: `fungsi \`${callee.name}\` butuh ${callee.arity} argumen, dapat ${args.length}`,
            code: ErrorCode.ARGUMENT_COUNT_MISMATCH,
          },
          expr.loc,
        );
      }
      return callee.call(args);
    }

    // Fungsi user-defined
    if (this.isFunction(callee)) {
      // Cek jumlah argumen
      const required = callee.params.filter((p) => !p.defaultValue).length;
      const max = callee.params.length;
      if (args.length < required || args.length > max) {
        const range = required === max ? `${required}` : `${required}-${max}`;
        throw new RuntimeError(
          {
            kind: "Error",
            message: `fungsi \`${callee.name}\` butuh ${range} argumen, dapat ${args.length}`,
            code: ErrorCode.ARGUMENT_COUNT_MISMATCH,
          },
          expr.loc,
        );
      }

      // Buat environment baru untuk eksekusi
      const fnEnv = new Environment(callee.closure);

      // Bind parameter
      for (let i = 0; i < callee.params.length; i++) {
        const param = callee.params[i]!;
        let value: Value;
        if (i < args.length) {
          value = args[i];
        } else if (param.defaultValue) {
          value = this.evaluate(param.defaultValue, fnEnv);
        } else {
          value = undefined;
        }
        fnEnv.define(param.name, value);
      }

      // Eksekusi body
      try {
        if (callee.isArrow) {
          return this.evaluate(callee.body as ExprNode, fnEnv);
        }
        this.executeBlock(callee.body as BlockNode, fnEnv);
        return undefined; // fungsi tanpa return eksplisit
      } catch (e) {
        if (e instanceof ReturnSignal) {
          return e.value;
        }
        throw e;
      }
    }

    throw new RuntimeError(
      {
        kind: "Error",
        message: `${this.typeName(callee)} tidak bisa dipanggil`,
        code: ErrorCode.NOT_CALLABLE,
      },
      expr.loc,
    );
  }

  private evalList(expr: ListExprNode, env: Environment): Value {
    return expr.elements.map((e) => this.evaluate(e, env));
  }

  private evalMap(expr: MapExprNode, env: Environment): Value {
    const map = new Map<string, Value>();
    for (const entry of expr.entries) {
      map.set(entry.key, this.evaluate(entry.value, env));
    }
    return map;
  }

  private evalInterpolatedString(
    expr: InterpolatedStringNode,
    env: Environment,
  ): Value {
    let result = "";
    for (const part of expr.parts) {
      if (typeof part === "string") {
        result += part;
      } else {
        const value = this.evaluate(part, env);
        result += this.toString(value);
      }
    }
    return result;
  }

  private evalFunctionExpr(expr: FunctionExprNode, env: Environment): Value {
    return {
      kind: "Function",
      name: "<anonymous>",
      params: expr.params,
      body: expr.body,
      closure: env,
      isArrow: true,
    };
  }

  // ==========================================================
  // Operators — Helpers
  // ==========================================================

  private applyBinaryOp(
    op: BinaryOperator,
    left: Value,
    right: Value,
    expr: ExprNode,
  ): Value {
    switch (op) {
      case "+": return this.add(left, right, expr);
      case "-": return this.numericOp(left, right, expr, (a, b) => a - b);
      case "*": return this.numericOp(left, right, expr, (a, b) => a * b);
      case "/":
        if (right === 0) {
          throw new RuntimeError(
            { kind: "Error", message: "pembagian dengan nol", code: ErrorCode.DIVISION_BY_ZERO },
            expr.loc,
          );
        }
        return this.numericOp(left, right, expr, (a, b) => a / b);
      case "%":
        if (right === 0) {
          throw new RuntimeError(
            { kind: "Error", message: "modulo dengan nol", code: ErrorCode.DIVISION_BY_ZERO },
            expr.loc,
          );
        }
        return this.numericOp(left, right, expr, (a, b) => a % b);
      case "**": return this.numericOp(left, right, expr, (a, b) => a ** b);
      case "==": return this.valuesEqual(left, right);
      case "!=": return !this.valuesEqual(left, right);
      case "<": return this.compareOp(left, right, expr, (a, b) => a < b);
      case "<=": return this.compareOp(left, right, expr, (a, b) => a <= b);
      case ">": return this.compareOp(left, right, expr, (a, b) => a > b);
      case ">=": return this.compareOp(left, right, expr, (a, b) => a >= b);
      case "and":
        return this.truthy(left, expr) && this.truthy(right, expr);
      case "or":
        return this.truthy(left, expr) || this.truthy(right, expr);
    }
  }

  private add(left: Value, right: Value, expr: ExprNode): Value {
    // String concatenation
    if (typeof left === "string" || typeof right === "string") {
      return this.toString(left) + this.toString(right);
    }
    // Numeric
    if (typeof left === "number" && typeof right === "number") {
      return left + right;
    }
    throw new RuntimeError(
      {
        kind: "Error",
        message: `operator \`+\` tidak bisa antara ${this.typeName(left)} dan ${this.typeName(right)}`,
        code: ErrorCode.INVALID_OPERATOR,
      },
      expr.loc,
    );
  }

  private numericOp(
    left: Value,
    right: Value,
    expr: ExprNode,
    fn: (a: number, b: number) => number,
  ): Value {
    if (typeof left !== "number" || typeof right !== "number") {
      throw new RuntimeError(
        {
          kind: "Error",
          message: `operator aritmatika hanya untuk Angka, dapat ${this.typeName(left)} dan ${this.typeName(right)}`,
          code: ErrorCode.INVALID_OPERATOR,
        },
        expr.loc,
      );
    }
    return fn(left, right);
  }

  private compareOp(
    left: Value,
    right: Value,
    expr: ExprNode,
    fn: (a: number, b: number) => boolean,
  ): Value {
    if (typeof left === "number" && typeof right === "number") {
      return fn(left, right);
    }
    if (typeof left === "string" && typeof right === "string") {
      return fn(left.charCodeAt(0) - right.charCodeAt(0), 0) || left === right;
    }
    throw new RuntimeError(
      {
        kind: "Error",
        message: `perbandingan tidak valid antara ${this.typeName(left)} dan ${this.typeName(right)}`,
        code: ErrorCode.INVALID_OPERATOR,
      },
      expr.loc,
    );
  }

  // ==========================================================
  // Helpers — Equality, Truthiness, Type
  // ==========================================================

  private valuesEqual(a: Value, b: Value): boolean {
    if (a === b) return true;
    if (typeof a !== typeof b) return false;

    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) return false;
      return a.every((v, i) => this.valuesEqual(v, b[i]));
    }

    if (a instanceof Map && b instanceof Map) {
      if (a.size !== b.size) return false;
      for (const [k, v] of a) {
        if (!b.has(k)) return false;
        if (!this.valuesEqual(v, b.get(k))) return false;
      }
      return true;
    }

    return false;
  }

  private truthy(value: Value, expr: ExprNode): boolean {
    if (typeof value === "boolean") return value;
    throw new RuntimeError(
      {
        kind: "Error",
        message: `kondisi harus Boolean, dapat ${this.typeName(value)}`,
        code: ErrorCode.TYPE_MISMATCH,
      },
      expr.loc,
    );
  }

  private typeName(value: Value): string {
    if (value === null) return "Null";
    if (value === undefined) return "Kosong";
    if (Array.isArray(value)) return "Daftar";
    if (value instanceof Map) return "Peta";
    if (typeof value === "number") return "Angka";
    if (typeof value === "string") return "Teks";
    if (typeof value === "boolean") return "Boolean";
    if (typeof value === "object" && "kind" in value) {
      if (value.kind === "Function") return "Fungsi";
      if (value.kind === "NativeFunction") return "Fungsi";
      if (value.kind === "Error") return "Error";
    }
    return "unknown";
  }

  private toString(value: Value): string {
    if (value === null) return "null";
    if (value === undefined) return "";
    if (typeof value === "string") return value;
    if (typeof value === "number") return String(value);
    if (typeof value === "boolean") return value ? "true" : "false";
    if (Array.isArray(value)) {
      return "[" + value.map((v) => this.toString(v)).join(", ") + "]";
    }
    if (value instanceof Map) {
      const entries = Array.from(value.entries())
        .map(([k, v]) => `"${k}": ${this.toString(v)}`)
        .join(", ");
      return "{" + entries + "}";
    }
    if (this.isFunction(value)) return `<fungsi ${value.name}>`;
    if (this.isNativeFunction(value)) return `<fungsi bawaan ${value.name}>`;
    if (value.kind === "Error") return `Error: ${value.message}`;
    return String(value);
  }

  private isFunction(v: Value): v is FunctionValue {
    return typeof v === "object" && v !== null && "kind" in v && v.kind === "Function";
  }

  private isNativeFunction(v: Value): v is NativeFunctionValue {
    return typeof v === "object" && v !== null && "kind" in v && v.kind === "NativeFunction";
  }

  private toErrorValue(value: Value): ErrorValue {
    if (value === null || value === undefined) {
      return { kind: "Error", message: "error tanpa pesan" };
    }
    if (typeof value === "string") {
      return { kind: "Error", message: value };
    }
    if (this.isFunction(value) || this.isNativeFunction(value)) {
      return { kind: "Error", message: "error berisi fungsi" };
    }
    if (typeof value === "object" && !Array.isArray(value) && !(value instanceof Map) && "kind" in value && value.kind === "Error") {
      return value;
    }
    return { kind: "Error", message: this.toString(value) };
  }

  private defaultValueForType(_type: TypeNode | null): Value {
    // Untuk sekarang, semua variabel tanpa initializer default ke null.
    // Nanti bisa diperbaiki dengan type info dari analyzer.
    return null;
  }

  private iterate(value: Value, expr: ExprNode): Value[] {
    if (Array.isArray(value)) return value;

    if (typeof value === "string") {
      return value.split("");
    }

    if (value instanceof Map) {
      // Iterate key-value pairs sebagai tupel [key, value]
      return Array.from(value.entries()).map(([k, v]) => [k, v] as Value);
    }

    throw new RuntimeError(
      {
        kind: "Error",
        message: `${this.typeName(value)} tidak bisa di-iterate`,
        code: ErrorCode.INVALID_OPERATOR,
      },
      expr.loc,
    );
  }

  // ==========================================================
  // Built-in Functions
  // ==========================================================

  private installBuiltins(): void {
    // === I/O ===

    this.defineNative("tulis", 1, (args) => {
      this.onPrint(this.toString(args[0]!));
      return undefined;
    });

    this.defineNative("print", 1, (args) => {
      this.onPrint(this.toString(args[0]!));
      return undefined;
    });

    // === Konversi ===

    this.defineNative("Angka", 1, (args) => {
      const v = args[0]!;
      if (typeof v === "number") return v;
      if (typeof v === "string") {
        const n = Number(v);
        if (Number.isNaN(n)) {
          throw new RuntimeError({
            kind: "Error",
            message: `tidak bisa konversi \`${v}\` ke Angka`,
            code: ErrorCode.INVALID_CAST,
          });
        }
        return n;
      }
      if (typeof v === "boolean") return v ? 1 : 0;
      throw new RuntimeError({
        kind: "Error",
        message: `tidak bisa konversi ${this.typeName(v)} ke Angka`,
        code: ErrorCode.INVALID_CAST,
      });
    });

    this.defineNative("Teks", 1, (args) => {
      return this.toString(args[0]!);
    });

    // === Matematika ===

    this.defineNative("panjang", 1, (args) => {
      const v = args[0]!;
      if (typeof v === "string") return v.length;
      if (Array.isArray(v)) return v.length;
      if (v instanceof Map) return v.size;
      throw new RuntimeError({
        kind: "Error",
        message: `panjang() tidak bisa untuk ${this.typeName(v)}`,
        code: ErrorCode.TYPE_MISMATCH,
      });
    });

    this.defineNative("rentang", 2, (args) => {
      const start = args[0]!;
      const end = args[1]!;
      if (typeof start !== "number" || typeof end !== "number") {
        throw new RuntimeError({
          kind: "Error",
          message: "rentang() butuh dua Angka",
          code: ErrorCode.TYPE_MISMATCH,
        });
      }
      const result: Value[] = [];
      for (let i = start; i < end; i++) result.push(i);
      return result;
    });

    // === Error ===

    this.defineNative("Error", 1, (args) => {
      const msg = this.toString(args[0]!);
      return { kind: "Error", message: msg } as ErrorValue;
    });

    // === Output debugging ===

    this.defineNative("tipe", 1, (args) => {
      return this.typeName(args[0]!);
    });
  }

  private defineNative(
    name: string,
    arity: number | "variadic",
    fn: (args: Value[]) => Value,
  ): void {
    const value: NativeFunctionValue = {
      kind: "NativeFunction",
      name,
      arity,
      call: fn,
    };
    this.global.define(name, value);
  }
}

// ============================================================
// Convenience
// ============================================================

/**
 * Jalankan program Snake Script.
 */
export function run(
  program: ProgramNode,
  file: string,
  reporter: Reporter,
  onPrint?: (line: string) => void,
): void {
  const interpreter = new Interpreter({ file, reporter, onPrint });
  interpreter.run(program);
}
