```typescript
/**
 * Snake Script — Advanced Interpreter & Runtime Engine
 *
 * Mengeksekusi AST (`ProgramNode`) secara langsung (Tree-Walk Interpreter) dengan fitur:
 *
 * 1. Eksekusi Penuh Fitur Bahasa & Ekstensi Parser:
 *    - Mendukung `SliceExpr` (`a[1:5:2]`), `ListCompExpr` (`[x * 2 for x in daftar if x > 0]`),
 *      `ConditionalExpr` (`a if cond else b`), `SpreadExpr` (`..sisa`), dan `TryPropagateExpr` (`expr?`).
 *    - Mendukung operator pipeline (`|>`), nullish coalescing (`??` via `__coalesce`),
 *      serta `in` / `not in` (via `__contains`).
 *    - Pattern matching lengkap: `LiteralPattern`, `WildcardPattern`, `BindingPattern`,
 *      `OrPattern` (dengan isolasi transaksi binding), `RangePattern`, `ListPattern` (`[a, ..rest]`),
 *      `RecordPattern` (`{ nama, umur: u }`), dan `ExtractorPattern` (`Error(pesan)`).
 *
 * 2. Keamanan Runtime, Immutability, & Pemeriksaan Tipe Dinamis:
 *    - Pelacakan variabel `const` vs `let` di `Environment` (mencegah mutasi ulang `const`).
 *    - Validasi anotasi tipe runtime (`TypeNode`) untuk variabel, parameter fungsi, dan nilai kembalian.
 *    - Pelacakan Call Stack (`StackFrame`) dengan proteksi kedalaman rekursi (`maxCallDepth`)
 *      dan pelaporan *stack trace* yang informatif saat terjadi `RuntimeError`.
 *    - Proteksi *infinite loop* opsional melalui `maxLoopIterations`.
 *
 * 3. Built-in Methods & Standard Library (`stdlib`, `math`, `json`, `koleksi`):
 *    - Method bawaan kaya fitur pada `Teks` (String), `Daftar` (Array), `Peta` (Map), dan `Error`.
 *    - Fungsi global variadik (`tulis`, `print`, `min`, `maks`, `rentang` 1-3 argumen, `enumerasi`, `zip`, `pastikan`).
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
  FunctionDeclNode,
  VarDeclNode,
  IfStmtNode,
  WhileStmtNode,
  ForStmtNode,
  MatchStmtNode,
  TryStmtNode,
  ReturnStmtNode,
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
  Location,
} from "./ast.ts";

import type {
  SliceExprNode,
  ListCompExprNode,
  ConditionalExprNode,
  SpreadExprNode,
  TryPropagateExprNode,
  ListPatternNode,
  RecordPatternNode,
  RangePatternNode,
  ExtractorPatternNode,
} from "./parser.ts";

import type { Reporter } from "./diagnostics.ts";
import { ErrorCode } from "./diagnostics.ts";

// ============================================================
// Runtime Values
// ============================================================

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

export interface FunctionValue {
  readonly kind: "Function";
  readonly name: string;
  readonly params: readonly ParamNode[];
  readonly returnType?: TypeNode | null;
  readonly body: BlockNode | ExprNode;
  readonly closure: Environment;
  readonly isArrow: boolean;
}

export interface NativeFunctionValue {
  readonly kind: "NativeFunction";
  readonly name: string;
  readonly arity: number | "variadic" | readonly [number, number];
  readonly call: (args: Value[], callSite?: Location) => Value;
}

export interface ErrorValue {
  readonly kind: "Error";
  readonly message: string;
  readonly code?: string;
  readonly stack?: readonly StackFrame[];
}

export interface StackFrame {
  readonly functionName: string;
  readonly location?: Location;
}

// ============================================================
// Environment (dengan Pelacakan Mutability `const` vs `let`)
// ============================================================

interface BindingEntry {
  value: Value;
  readonly mutable: boolean;
  readonly exported: boolean;
}

export class Environment {
  private readonly bindings = new Map<string, BindingEntry>();
  readonly parent: Environment | null;

  constructor(parent: Environment | null = null) {
    this.parent = parent;
  }

  define(
    name: string,
    value: Value,
    mutable = true,
    exported = false,
  ): void {
    this.bindings.set(name, { value, mutable, exported });
  }

  get(name: string): Value {
    const entry = this.bindings.get(name);
    if (entry !== undefined) {
      return entry.value;
    }
    if (this.parent) {
      return this.parent.get(name);
    }
    return undefined;
  }

  has(name: string): boolean {
    if (this.bindings.has(name)) return true;
    if (this.parent) return this.parent.has(name);
    return false;
  }

  isMutable(name: string): boolean {
    const entry = this.bindings.get(name);
    if (entry !== undefined) return entry.mutable;
    if (this.parent) return this.parent.isMutable(name);
    return false;
  }

  assign(name: string, value: Value): "ok" | "not_found" | "immutable" {
    const entry = this.bindings.get(name);
    if (entry !== undefined) {
      if (!entry.mutable) {
        return "immutable";
      }
      entry.value = value;
      return "ok";
    }
    if (this.parent) {
      return this.parent.assign(name, value);
    }
    return "not_found";
  }

  snapshot(onlyExported = false): Record<string, Value> {
    const out: Record<string, Value> = {};
    for (const [k, entry] of this.bindings.entries()) {
      if (!onlyExported || entry.exported) {
        out[k] = entry.value;
      }
    }
    return out;
  }
}

// ============================================================
// Control Flow Signals
// ============================================================

class ReturnSignal {
  readonly value: Value;
  readonly location?: Location;

  constructor(value: Value, location?: Location) {
    this.value = value;
    this.location = location;
  }
}

class BreakSignal {
  readonly location?: Location;
  constructor(location?: Location) {
    this.location = location;
  }
}

class ContinueSignal {
  readonly location?: Location;
  constructor(location?: Location) {
    this.location = location;
  }
}

// ============================================================
// Runtime Error
// ============================================================

export class RuntimeError extends Error {
  readonly value: ErrorValue;
  readonly location?: Location;
  readonly stackFrames: readonly StackFrame[];

  constructor(
    value: ErrorValue,
    location?: Location,
    stackFrames: readonly StackFrame[] = [],
  ) {
    super(value.message);
    this.name = "RuntimeError";
    this.value = value;
    this.location = location;
    this.stackFrames = value.stack ?? stackFrames;
  }
}

// ============================================================
// Interpreter Options & Execution Metrics
// ============================================================

export interface InterpreterOptions {
  readonly file: string;
  readonly reporter: Reporter;
  readonly onPrint?: (line: string) => void;
  readonly cwd?: string;
  /** Batas maksimum kedalaman pemanggilan fungsi (rekursi). Default: 500. */
  readonly maxCallDepth?: number;
  /** Batas maksimum iterasi per satu loop (`while`/`for`) untuk mencegah freeze. Default: 1_000_000. */
  readonly maxLoopIterations?: number;
  /** Validasi anotasi tipe pada saat runtime. Default: true. */
  readonly checkTypes?: boolean;
  /** Resolver kustom untuk `import ... from "..."`. */
  readonly moduleLoader?: (source: string, importer: string) => Environment | Map<string, Value> | null;
}

export interface ExecutionMetrics {
  readonly file: string;
  readonly statementsExecuted: number;
  readonly expressionsEvaluated: number;
  readonly functionCalls: number;
  readonly maxCallDepthReached: number;
  readonly durationMs: number;
}

// ============================================================
// Interpreter
// ============================================================

export class Interpreter {
  private readonly file: string;
  private readonly reporter: Reporter;
  private readonly onPrint: (line: string) => void;
  private readonly cwd: string;
  private readonly maxCallDepth: number;
  private readonly maxLoopIterations: number;
  private readonly checkTypes: boolean;
  private readonly moduleLoader?: (
    source: string,
    importer: string,
  ) => Environment | Map<string, Value> | null;

  readonly global: Environment;

  private readonly moduleCache = new Map<string, Environment>();
  private readonly typeAliases = new Map<string, TypeNode>();
  private readonly callStack: StackFrame[] = [];

  private statementsExecuted = 0;
  private expressionsEvaluated = 0;
  private functionCalls = 0;
  private maxCallDepthReached = 0;
  private lastMetrics: ExecutionMetrics | null = null;

  constructor(opts: InterpreterOptions) {
    this.file = opts.file;
    this.reporter = opts.reporter;
    this.onPrint =
      opts.onPrint ??
      ((line) => {
        if (typeof process !== "undefined" && process.stdout) {
          process.stdout.write(line + "\n");
        } else {
          console.log(line);
        }
      });
    this.cwd =
      opts.cwd ??
      (typeof process !== "undefined" && typeof process.cwd === "function"
        ? process.cwd()
        : ".");
    this.maxCallDepth = opts.maxCallDepth ?? 500;
    this.maxLoopIterations = opts.maxLoopIterations ?? 1_000_000;
    this.checkTypes = opts.checkTypes ?? true;
    this.moduleLoader = opts.moduleLoader;

    this.global = new Environment(null);
    this.installBuiltins();
    this.installBuiltinModules();
  }

  /**
   * Menjalankan seluruh `ProgramNode` dan mengembalikan nilai ekspresi terakhir (jika ada).
   */
  run(program: ProgramNode): Value {
    const startTime = performance.now();
    let lastValue: Value = undefined;

    try {
      for (const stmt of program.statements) {
        lastValue = this.executeStatement(stmt, this.global);
      }
    } catch (e) {
      if (e instanceof RuntimeError) {
        const stackHelp = this.formatStackTrace(e.stackFrames);
        this.reporter.report({
          severity: "error",
          code: e.value.code ?? ErrorCode.INTERNAL_ERROR,
          message: e.value.message,
          location: e.location ?? program.loc,
          helps: stackHelp.length > 0 ? stackHelp : undefined,
        });
        return undefined;
      }
      if (e instanceof ReturnSignal) {
        this.reporter.report({
          severity: "error",
          code: ErrorCode.UNEXPECTED_TOKEN,
          message: "`return` tidak boleh digunakan di level terluar (top-level)",
          location: e.location ?? program.loc,
        });
        return undefined;
      }
      if (e instanceof BreakSignal) {
        this.reporter.report({
          severity: "error",
          code: ErrorCode.UNEXPECTED_TOKEN,
          message: "`break` tidak boleh digunakan di luar perulangan",
          location: e.location ?? program.loc,
        });
        return undefined;
      }
      if (e instanceof ContinueSignal) {
        this.reporter.report({
          severity: "error",
          code: ErrorCode.UNEXPECTED_TOKEN,
          message: "`continue` tidak boleh digunakan di luar perulangan",
          location: e.location ?? program.loc,
        });
        return undefined;
      }
      throw e;
    } finally {
      this.lastMetrics = {
        file: this.file,
        statementsExecuted: this.statementsExecuted,
        expressionsEvaluated: this.expressionsEvaluated,
        functionCalls: this.functionCalls,
        maxCallDepthReached: this.maxCallDepthReached,
        durationMs: performance.now() - startTime,
      };
    }

    return lastValue;
  }

  getMetrics(): ExecutionMetrics | null {
    return this.lastMetrics;
  }

  // ==========================================================
  // Statement Execution
  // ==========================================================

  private executeStatement(
    stmt: StmtNode,
    env: Environment,
    isExported = false,
  ): Value {
    this.statementsExecuted++;

    switch (stmt.kind) {
      case "VarDecl":
        return this.execVarDecl(stmt, env, isExported);
      case "FunctionDecl":
        return this.execFunctionDecl(stmt, env, isExported);
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
        throw new BreakSignal(stmt.loc);
      case "ContinueStmt":
        throw new ContinueSignal(stmt.loc);
      case "ThrowStmt":
        return this.execThrow(stmt, env);
      case "ImportStmt":
        return this.execImport(stmt, env);
      case "ExportStmt":
        return this.executeStatement(stmt.declaration, env, true);
      default: {
        const _exhaustive: never = stmt;
        throw new Error(`Unknown statement: ${(_exhaustive as StmtNode).kind}`);
      }
    }
  }

  private execVarDecl(
    stmt: VarDeclNode,
    env: Environment,
    isExported = false,
  ): Value {
    let value: Value;

    if (stmt.initializer) {
      value = this.evaluate(stmt.initializer, env);
      if (this.checkTypes && stmt.typeAnnotation) {
        this.assertMatchesType(
          value,
          stmt.typeAnnotation,
          stmt.initializer.loc,
          `inisialisasi variabel \`${stmt.name}\``,
        );
      }
    } else {
      value = this.defaultValueForType(stmt.typeAnnotation);
    }

    env.define(stmt.name, value, stmt.mutable, isExported);
    return value;
  }

  private execFunctionDecl(
    stmt: FunctionDeclNode,
    env: Environment,
    isExported = false,
  ): Value {
    const fn: FunctionValue = {
      kind: "Function",
      name: stmt.name,
      params: stmt.params,
      returnType: stmt.returnType,
      body: stmt.body,
      closure: env,
      isArrow: false,
    };
    // Fungsi yang dideklarasikan dengan `fn` bersifat konstan secara default
    env.define(stmt.name, fn, false, isExported);
    return fn;
  }

  private execTypeDecl(stmt: TypeDeclNode, _env: Environment): Value {
    this.typeAliases.set(stmt.name, stmt.value);
    return undefined;
  }

  private execExprStmt(stmt: ExprStmtNode, env: Environment): Value {
    return this.evaluate(stmt.expression, env);
  }

  private execIf(stmt: IfStmtNode, env: Environment): Value {
    if (this.truthy(this.evaluate(stmt.condition, env), stmt.condition)) {
      return this.executeBlock(stmt.then, new Environment(env));
    }

    for (const elif of stmt.elifs) {
      if (this.truthy(this.evaluate(elif.condition, env), elif.condition)) {
        return this.executeBlock(elif.body, new Environment(env));
      }
    }

    if (stmt.else) {
      return this.executeBlock(stmt.else, new Environment(env));
    }
    return undefined;
  }

  private execWhile(stmt: WhileStmtNode, env: Environment): Value {
    let iterations = 0;
    while (this.truthy(this.evaluate(stmt.condition, env), stmt.condition)) {
      iterations++;
      if (iterations > this.maxLoopIterations) {
        throw this.createRuntimeError(
          `perulangan \`while\` melampaui batas maksimum iterasi (${this.maxLoopIterations})`,
          ErrorCode.INTERNAL_ERROR,
          stmt.loc,
        );
      }

      try {
        this.executeBlock(stmt.body, new Environment(env));
      } catch (e) {
        if (e instanceof BreakSignal) return undefined;
        if (e instanceof ContinueSignal) continue;
        throw e;
      }
    }
    return undefined;
  }

  private execFor(stmt: ForStmtNode, env: Environment): Value {
    const iterable = this.evaluate(stmt.iterable, env);
    const items = this.iterate(iterable, stmt.iterable);

    let iterations = 0;
    for (const item of items) {
      iterations++;
      if (iterations > this.maxLoopIterations) {
        throw this.createRuntimeError(
          `perulangan \`for\` melampaui batas maksimum iterasi (${this.maxLoopIterations})`,
          ErrorCode.INTERNAL_ERROR,
          stmt.loc,
        );
      }

      const loopEnv = new Environment(env);
      loopEnv.define(stmt.variable, item, true);
      try {
        this.executeBlock(stmt.body, loopEnv);
      } catch (e) {
        if (e instanceof BreakSignal) return undefined;
        if (e instanceof ContinueSignal) continue;
        throw e;
      }
    }
    return undefined;
  }

  private execMatch(stmt: MatchStmtNode, env: Environment): Value {
    const subject = this.evaluate(stmt.subject, env);

    for (const c of stmt.cases) {
      const bindings = new Map<string, Value>();
      if (this.matchPattern(c.pattern, subject, bindings)) {
        const caseEnv = new Environment(env);
        for (const [name, value] of bindings) {
          caseEnv.define(name, value, false);
        }

        if (c.guard) {
          if (!this.truthy(this.evaluate(c.guard, caseEnv), c.guard)) {
            continue;
          }
        }

        return this.executeBlock(c.body, caseEnv);
      }
    }

    if (stmt.else) {
      return this.executeBlock(stmt.else, new Environment(env));
    }
    return undefined;
  }

  /**
   * Mencocokkan nilai terhadap `PatternNode` (termasuk pola struktural lanjutan).
   * Menggunakan pencocokan transaksional untuk `OrPattern` agar binding parsial
   * yang gagal tidak bocor ke cabang berikutnya.
   */
  private matchPattern(
    pattern: PatternNode,
    value: Value,
    bindings: Map<string, Value>,
  ): boolean {
    const rawKind = (pattern as { kind: string }).kind;

    switch (rawKind) {
      case "LiteralPattern": {
        const lit = pattern as Extract<PatternNode, { kind: "LiteralPattern" }>;
        return this.valuesEqual(lit.value, value);
      }

      case "WildcardPattern":
        return true;

      case "BindingPattern": {
        const bind = pattern as Extract<PatternNode, { kind: "BindingPattern" }>;
        // Jika identifier merupakan nama tipe primitif (misal `case Angka:`),
        // cocokkan terhadap tipe runtime nilai tersebut!
        if (
          bind.name === "Angka" ||
          bind.name === "Teks" ||
          bind.name === "Boolean" ||
          bind.name === "Daftar" ||
          bind.name === "Peta" ||
          bind.name === "Error" ||
          bind.name === "Fungsi"
        ) {
          return this.typeName(value) === bind.name;
        }
        bindings.set(bind.name, value);
        return true;
      }

      case "OrPattern": {
        const orPat = pattern as Extract<PatternNode, { kind: "OrPattern" }>;
        for (const sub of orPat.patterns) {
          const branchBindings = new Map<string, Value>(bindings);
          if (this.matchPattern(sub, value, branchBindings)) {
            for (const [k, v] of branchBindings) {
              bindings.set(k, v);
            }
            return true;
          }
        }
        return false;
      }

      case "RangePattern": {
        const rangePat = pattern as unknown as RangePatternNode;
        if (
          typeof value === "number" &&
          typeof rangePat.start === "number" &&
          typeof rangePat.end === "number"
        ) {
          return rangePat.inclusive
            ? value >= rangePat.start && value <= rangePat.end
            : value >= rangePat.start && value < rangePat.end;
        }
        if (
          typeof value === "string" &&
          typeof rangePat.start === "string" &&
          typeof rangePat.end === "string"
        ) {
          return rangePat.inclusive
            ? value >= rangePat.start && value <= rangePat.end
            : value >= rangePat.start && value < rangePat.end;
        }
        return false;
      }

      case "ListPattern": {
        const listPat = pattern as unknown as ListPatternNode;
        if (!Array.isArray(value)) return false;
        if (listPat.rest === null && value.length !== listPat.elements.length) {
          return false;
        }
        if (listPat.rest !== null && value.length < listPat.elements.length) {
          return false;
        }

        const tempBindings = new Map<string, Value>(bindings);
        for (let i = 0; i < listPat.elements.length; i++) {
          if (!this.matchPattern(listPat.elements[i]!, value[i], tempBindings)) {
            return false;
          }
        }
        if (listPat.rest !== null && listPat.rest !== "_") {
          tempBindings.set(listPat.rest, value.slice(listPat.elements.length));
        }
        for (const [k, v] of tempBindings) bindings.set(k, v);
        return true;
      }

      case "RecordPattern": {
        const recPat = pattern as unknown as RecordPatternNode;
        if (!(value instanceof Map)) return false;

        const tempBindings = new Map<string, Value>(bindings);
        for (const field of recPat.fields) {
          if (!value.has(field.key)) return false;
          const fieldVal = value.get(field.key);
          if (!this.matchPattern(field.pattern, fieldVal, tempBindings)) {
            return false;
          }
        }
        for (const [k, v] of tempBindings) bindings.set(k, v);
        return true;
      }

      case "ExtractorPattern": {
        const extPat = pattern as unknown as ExtractorPatternNode;
        // Mendukung ekstraksi `Error(pesan)` atau pencocokan tipe `Angka(x)`, `Teks(s)`, dll.
        if (extPat.name === "Error") {
          if (!this.isErrorValue(value)) return false;
          if (extPat.args.length === 0) return true;
          if (extPat.args.length === 1) {
            return this.matchPattern(extPat.args[0]!, value.message, bindings);
          }
          return false;
        }
        if (
          extPat.name === "Angka" ||
          extPat.name === "Teks" ||
          extPat.name === "Boolean" ||
          extPat.name === "Daftar" ||
          extPat.name === "Peta"
        ) {
          if (this.typeName(value) !== extPat.name) return false;
          if (extPat.args.length === 0) return true;
          if (extPat.args.length === 1) {
            return this.matchPattern(extPat.args[0]!, value, bindings);
          }
          return false;
        }
        // Mendukung map dengan field `kind` atau `tipe` yang bernilai `extPat.name`
        if (value instanceof Map) {
          const tag = value.get("kind") ?? value.get("tipe");
          if (tag === extPat.name) {
            if (extPat.args.length === 0) return true;
            const payload = value.get("value") ?? value.get("nilai") ?? value;
            return this.matchPattern(extPat.args[0]!, payload, bindings);
          }
        }
        return false;
      }

      default:
        return false;
    }
  }

  private execTry(stmt: TryStmtNode, env: Environment): Value {
    let caught: RuntimeError | null = null;
    let result: Value = undefined;

    try {
      result = this.executeBlock(stmt.body, new Environment(env));
    } catch (e) {
      if (e instanceof RuntimeError) {
        caught = e;
      } else if (
        e instanceof ReturnSignal ||
        e instanceof BreakSignal ||
        e instanceof ContinueSignal
      ) {
        this.runFinally(stmt, env);
        throw e;
      } else {
        throw e;
      }
    }

    if (caught) {
      const catchEnv = new Environment(env);
      catchEnv.define(stmt.errorName, caught.value, false);
      try {
        result = this.executeBlock(stmt.catchBody, catchEnv);
      } catch (e) {
        this.runFinally(stmt, env);
        throw e;
      }
    }

    this.runFinally(stmt, env);
    return result;
  }

  private runFinally(stmt: TryStmtNode, env: Environment): void {
    if (stmt.finallyBody) {
      this.executeBlock(stmt.finallyBody, new Environment(env));
    }
  }

  private execReturn(stmt: ReturnStmtNode, env: Environment): never {
    const value = stmt.value ? this.evaluate(stmt.value, env) : undefined;
    throw new ReturnSignal(value, stmt.loc);
  }

  private execThrow(stmt: ThrowStmtNode, env: Environment): never {
    const value = this.evaluate(stmt.value, env);
    const errorValue = this.toErrorValue(value);
    throw this.createRuntimeError(
      errorValue.message,
      errorValue.code ?? ErrorCode.INTERNAL_ERROR,
      stmt.loc,
    );
  }

  private execImport(stmt: ImportStmtNode, env: Environment): Value {
    if (!this.moduleCache.has(stmt.source)) {
      if (this.moduleLoader) {
        const loaded = this.moduleLoader(stmt.source, this.file);
        if (loaded instanceof Environment) {
          this.moduleCache.set(stmt.source, loaded);
        } else if (loaded instanceof Map) {
          const modEnv = new Environment(null);
          for (const [k, v] of loaded) modEnv.define(k, v, false, true);
          this.moduleCache.set(stmt.source, modEnv);
        }
      }

      if (!this.moduleCache.has(stmt.source)) {
        this.reporter.report({
          severity: "error",
          code: ErrorCode.MODULE_NOT_FOUND,
          message: `modul tidak ditemukan: \`${stmt.source}\``,
          location: stmt.loc,
          helps: [
            "modul bawaan yang tersedia: `stdlib`, `math`, `matematika`, `json`, `teks`, `daftar`, `waktu`",
          ],
        });
        return undefined;
      }
    }

    const mod = this.moduleCache.get(stmt.source)!;

    if (stmt.importKind === "named") {
      for (const rawSpec of stmt.names) {
        // Dukung `import { tambah as plus } from "math"`
        const parts = rawSpec.split(/\s+as\s+/);
        const importedName = parts[0]!.trim();
        const localName = (parts[1] ?? parts[0])!.trim();
        if (!mod.has(importedName)) {
          throw this.createRuntimeError(
            `simbol \`${importedName}\` tidak ditemukan di modul \`${stmt.source}\``,
            ErrorCode.UNDEFINED_VARIABLE,
            stmt.loc,
          );
        }
        env.define(localName, mod.get(importedName), false);
      }
    } else if (stmt.importKind === "namespace" || stmt.importKind === "default") {
      const namespace = new Map<string, Value>(Object.entries(mod.snapshot()));
      env.define(stmt.alias!, namespace, false);
    }

    return undefined;
  }

  private executeBlock(block: BlockNode, env: Environment): Value {
    let last: Value = undefined;
    for (const stmt of block.statements) {
      last = this.executeStatement(stmt, env);
    }
    return last;
  }

  // ==========================================================
  // Expression Evaluation (Termasuk Node Ekstensi Parser)
  // ==========================================================

  private evaluate(expr: ExprNode, env: Environment): Value {
    this.expressionsEvaluated++;
    const rawKind = (expr as { kind: string }).kind;

    switch (rawKind) {
      case "Literal":
        return this.evalLiteral(expr as LiteralNode);
      case "Identifier":
        return this.evalIdentifier(expr as IdentifierNode, env);
      case "BinaryExpr":
        return this.evalBinary(expr as BinaryExprNode, env);
      case "UnaryExpr":
        return this.evalUnary(expr as UnaryExprNode, env);
      case "AssignExpr":
        return this.evalAssign(expr as AssignExprNode, env);
      case "MemberExpr":
        return this.evalMember(expr as MemberExprNode, env);
      case "IndexExpr":
        return this.evalIndex(expr as IndexExprNode, env);
      case "SliceExpr":
        return this.evalSlice(expr as unknown as SliceExprNode, env);
      case "CallExpr":
        return this.evalCall(expr as CallExprNode, env);
      case "ListExpr":
        return this.evalList(expr as ListExprNode, env);
      case "ListCompExpr":
        return this.evalListComp(expr as unknown as ListCompExprNode, env);
      case "MapExpr":
        return this.evalMap(expr as MapExprNode, env);
      case "InterpolatedString":
        return this.evalInterpolatedString(expr as InterpolatedStringNode, env);
      case "FunctionExpr":
        return this.evalFunctionExpr(expr as FunctionExprNode, env);
      case "ConditionalExpr":
        return this.evalConditional(expr as unknown as ConditionalExprNode, env);
      case "TryPropagateExpr":
        return this.evalTryPropagate(expr as unknown as TryPropagateExprNode, env);
      case "ParenExpr":
        return this.evaluate((expr as ParenExprNode).inner, env);
      default:
        throw new Error(`Unknown expression kind: ${rawKind}`);
    }
  }

  private evalLiteral(expr: LiteralNode): Value {
    return expr.value;
  }

  private evalIdentifier(expr: IdentifierNode, env: Environment): Value {
    if (!env.has(expr.name)) {
      throw this.createRuntimeError(
        `variabel tidak terdefinisi: \`${expr.name}\``,
        ErrorCode.UNDEFINED_VARIABLE,
        expr.loc,
      );
    }
    return env.get(expr.name);
  }

  private evalConditional(expr: ConditionalExprNode, env: Environment): Value {
    const cond = this.evaluate(expr.condition, env);
    if (this.truthy(cond, expr.condition)) {
      return this.evaluate(expr.consequent, env);
    }
    return this.evaluate(expr.alternate, env);
  }

  /**
   * Evaluasi operator postfix `?` (`TryPropagateExpr`):
   * Jika operand menghasilkan `ErrorValue`, otomatis melempar `ReturnSignal(err)`
   * bila berada di dalam fungsi, atau `RuntimeError` bila di luar fungsi.
   */
  private evalTryPropagate(expr: TryPropagateExprNode, env: Environment): Value {
    const val = this.evaluate(expr.operand, env);
    if (this.isErrorValue(val)) {
      if (this.callStack.length > 0) {
        throw new ReturnSignal(val, expr.loc);
      }
      throw new RuntimeError(val, expr.loc, [...this.callStack]);
    }
    return val;
  }

  private evalBinary(expr: BinaryExprNode, env: Environment): Value {
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

    return this.applyBinaryOp(expr.operator, left, right, expr);
  }

  private evalUnary(expr: UnaryExprNode, env: Environment): Value {
    const operand = this.evaluate(expr.operand, env);

    switch (expr.operator) {
      case "-":
        if (typeof operand !== "number") {
          throw this.createRuntimeError(
            `operator unary \`-\` hanya untuk Angka, dapat ${this.typeName(operand)}`,
            ErrorCode.INVALID_OPERATOR,
            expr.loc,
          );
        }
        return -operand;
      case "not":
        return !this.truthy(operand, expr.operand);
    }
  }

  private evalAssign(expr: AssignExprNode, env: Environment): Value {
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
    throw this.createRuntimeError(
      "target assignment tidak valid",
      ErrorCode.INVALID_OPERATOR,
      target.loc,
    );
  }

  private writeTarget(target: ExprNode, value: Value, env: Environment): void {
    if (target.kind === "Identifier") {
      const status = env.assign(target.name, value);
      if (status === "not_found") {
        throw this.createRuntimeError(
          `variabel tidak terdefinisi: \`${target.name}\``,
          ErrorCode.UNDEFINED_VARIABLE,
          target.loc,
        );
      }
      if (status === "immutable") {
        throw this.createRuntimeError(
          `tidak dapat mengubah nilai konstanta \`${target.name}\` yang dideklarasikan dengan \`const\``,
          ErrorCode.INVALID_OPERATOR,
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
      if (typeof obj === "object" && obj !== null && !Array.isArray(obj)) {
        (obj as unknown as Record<string, unknown>)[target.property] = value;
        return;
      }
      throw this.createRuntimeError(
        `tidak bisa menetapkan properti \`${target.property}\` pada ${this.typeName(obj)}`,
        ErrorCode.INVALID_OPERATOR,
        target.loc,
      );
    }

    if (target.kind === "IndexExpr") {
      const obj = this.evaluate(target.object, env);
      const idx = this.evaluate(target.index, env);

      if (Array.isArray(obj)) {
        if (typeof idx !== "number" || !Number.isInteger(idx)) {
          throw this.createRuntimeError(
            `index Daftar harus bilangan bulat (Angka), dapat ${this.typeName(idx)}`,
            ErrorCode.INVALID_CAST,
            target.loc,
          );
        }
        const resolvedIdx = idx < 0 ? obj.length + idx : idx;
        if (resolvedIdx < 0 || resolvedIdx >= obj.length) {
          throw this.createRuntimeError(
            `index di luar batas: ${idx} (panjang ${obj.length})`,
            ErrorCode.INDEX_OUT_OF_BOUNDS,
            target.loc,
          );
        }
        obj[resolvedIdx] = value;
        return;
      }

      if (obj instanceof Map) {
        const key = String(idx);
        obj.set(key, value);
        return;
      }

      throw this.createRuntimeError(
        `tidak bisa menetapkan elemen melalui index pada ${this.typeName(obj)}`,
        ErrorCode.NOT_INDEXABLE,
        target.loc,
      );
    }

    throw this.createRuntimeError(
      "target assignment tidak valid",
      ErrorCode.INVALID_OPERATOR,
      target.loc,
    );
  }

  // ==========================================================
  // Member Access & Built-In Prototype Methods
  // ==========================================================

  private evalMember(expr: MemberExprNode, env: Environment): Value {
    const obj = this.evaluate(expr.object, env);
    const prop = expr.property;

    // 1. Jika objek bernilai null/undefined, kembalikan null dengan aman pada properti opsional
    if (obj === null || obj === undefined) {
      throw this.createRuntimeError(
        `tidak bisa mengakses properti \`${prop}\` pada nilai \`${this.typeName(obj)}\``,
        ErrorCode.UNKNOWN_FIELD,
        expr.loc,
      );
    }

    // 2. Peta (Map): cek method bawaan terlebih dahulu, lalu key di dalam Map
    if (obj instanceof Map) {
      if (obj.has(prop)) {
        return obj.get(prop);
      }
      const mapMethod = this.getMapMember(obj, prop);
      if (mapMethod !== undefined) {
        return mapMethod;
      }
      throw this.createRuntimeError(
        `key atau method \`${prop}\` tidak ditemukan di Peta`,
        ErrorCode.KEY_NOT_FOUND,
        expr.loc,
      );
    }

    // 3. Teks (String)
    if (typeof obj === "string") {
      const strMember = this.getStringMember(obj, prop, expr.loc);
      if (strMember !== undefined) return strMember;
      throw this.createRuntimeError(
        `properti atau method \`${prop}\` tidak ada pada Teks`,
        ErrorCode.UNKNOWN_FIELD,
        expr.loc,
      );
    }

    // 4. Daftar (Array)
    if (Array.isArray(obj)) {
      const arrMember = this.getListMember(obj, prop, expr.loc);
      if (arrMember !== undefined) return arrMember;
      throw this.createRuntimeError(
        `properti atau method \`${prop}\` tidak ada pada Daftar`,
        ErrorCode.UNKNOWN_FIELD,
        expr.loc,
      );
    }

    // 5. ErrorValue
    if (this.isErrorValue(obj)) {
      if (prop === "message" || prop === "pesan") return obj.message;
      if (prop === "code" || prop === "kode") return obj.code ?? null;
    }

    // 6. Objek lainnya
    if (typeof obj === "object") {
      const val = (obj as unknown as Record<string, Value>)[prop];
      if (val !== undefined || prop in (obj as object)) {
        return val;
      }
    }

    throw this.createRuntimeError(
      `properti \`${prop}\` tidak ada pada ${this.typeName(obj)}`,
      ErrorCode.UNKNOWN_FIELD,
      expr.loc,
    );
  }

  private getStringMember(str: string, prop: string, loc: Location): Value | undefined {
    switch (prop) {
      case "panjang":
      case "length":
        return str.length;
      case "besar":
      case "upper":
        return this.boundMethod("besar", 0, () => str.toUpperCase());
      case "kecil":
      case "lower":
        return this.boundMethod("kecil", 0, () => str.toLowerCase());
      case "pangkas":
      case "trim":
        return this.boundMethod("pangkas", 0, () => str.trim());
      case "pisah":
      case "split":
        return this.boundMethod("pisah", [0, 1], (args) => {
          const sep = args[0] !== undefined ? this.toString(args[0]) : " ";
          return str.split(sep);
        });
      case "ganti":
      case "replace":
        return this.boundMethod("ganti", 2, (args) => {
          const target = this.toString(args[0]);
          const replacement = this.toString(args[1]);
          return str.split(target).join(replacement);
        });
      case "berisi":
      case "includes":
        return this.boundMethod("berisi", 1, (args) =>
          str.includes(this.toString(args[0])),
        );
      case "mulaiDengan":
      case "startsWith":
        return this.boundMethod("mulaiDengan", 1, (args) =>
          str.startsWith(this.toString(args[0])),
        );
      case "akhiriDengan":
      case "endsWith":
        return this.boundMethod("akhiriDengan", 1, (args) =>
          str.endsWith(this.toString(args[0])),
        );
      case "ulang":
      case "repeat":
        return this.boundMethod("ulang", 1, (args) => {
          const n = args[0];
          if (typeof n !== "number" || n < 0) {
            throw this.createRuntimeError(
              "argumen `ulang(n)` harus Angka >= 0",
              ErrorCode.TYPE_MISMATCH,
              loc,
            );
          }
          return str.repeat(Math.floor(n));
        });
      case "indeks":
      case "indexOf":
        return this.boundMethod("indeks", 1, (args) =>
          str.indexOf(this.toString(args[0])),
        );
      default:
        return undefined;
    }
  }

  private getListMember(arr: Value[], prop: string, loc: Location): Value | undefined {
    switch (prop) {
      case "panjang":
      case "length":
        return arr.length;
      case "tambah":
      case "push":
        return this.boundMethod("tambah", "variadic", (args) => {
          arr.push(...args);
          return arr.length;
        });
      case "ambil":
      case "pop":
        return this.boundMethod("ambil", 0, () => {
          if (arr.length === 0) return null;
          return arr.pop()!;
        });
      case "gabung":
      case "join":
        return this.boundMethod("gabung", [0, 1], (args) => {
          const sep = args[0] !== undefined ? this.toString(args[0]) : "";
          return arr.map((v) => this.toString(v)).join(sep);
        });
      case "berisi":
      case "includes":
        return this.boundMethod("berisi", 1, (args) =>
          arr.some((item) => this.valuesEqual(item, args[0])),
        );
      case "balik":
      case "reverse":
        return this.boundMethod("balik", 0, () => [...arr].reverse());
      case "urut":
      case "sort":
        return this.boundMethod("urut", 0, () =>
          [...arr].sort((a, b) => {
            if (typeof a === "number" && typeof b === "number") return a - b;
            return this.toString(a).localeCompare(this.toString(b));
          }),
        );
      case "petakan":
      case "map":
        return this.boundMethod("petakan", 1, (args) => {
          const cb = args[0];
          return arr.map((item, idx) =>
            this.invokeCallback(cb, [item, idx], loc),
          );
        });
      case "saring":
      case "filter":
        return this.boundMethod("saring", 1, (args) => {
          const cb = args[0];
          return arr.filter((item, idx) =>
            Boolean(this.invokeCallback(cb, [item, idx], loc)),
          );
        });
      case "reduksi":
      case "reduce":
        return this.boundMethod("reduksi", [1, 2], (args) => {
          const cb = args[0];
          let acc: Value = args.length >= 2 ? args[1] : arr[0];
          const startIdx = args.length >= 2 ? 0 : 1;
          for (let i = startIdx; i < arr.length; i++) {
            acc = this.invokeCallback(cb, [acc, arr[i]!, i], loc);
          }
          return acc;
        });
      case "cari":
      case "find":
        return this.boundMethod("cari", 1, (args) => {
          const cb = args[0];
          for (let i = 0; i < arr.length; i++) {
            if (this.invokeCallback(cb, [arr[i]!, i], loc)) {
              return arr[i]!;
            }
          }
          return null;
        });
      case "setiap":
      case "every":
        return this.boundMethod("setiap", 1, (args) => {
          const cb = args[0];
          return arr.every((item, idx) =>
            Boolean(this.invokeCallback(cb, [item, idx], loc)),
          );
        });
      case "beberapa":
      case "some":
        return this.boundMethod("beberapa", 1, (args) => {
          const cb = args[0];
          return arr.some((item, idx) =>
            Boolean(this.invokeCallback(cb, [item, idx], loc)),
          );
        });
      case "salin":
      case "slice":
        return this.boundMethod("salin", [0, 2], (args) => {
          const start = typeof args[0] === "number" ? args[0] : 0;
          const end = typeof args[1] === "number" ? args[1] : arr.length;
          return arr.slice(start, end);
        });
      default:
        return undefined;
    }
  }

  private getMapMember(map: Map<string, Value>, prop: string): Value | undefined {
    switch (prop) {
      case "ukuran":
      case "panjang":
      case "size":
        return map.size;
      case "kunci":
      case "keys":
        return this.boundMethod("kunci", 0, () => Array.from(map.keys()));
      case "nilai":
      case "values":
        return this.boundMethod("nilai", 0, () => Array.from(map.values()));
      case "entri":
      case "entries":
        return this.boundMethod("entri", 0, () =>
          Array.from(map.entries()).map(([k, v]) => [k, v] as Value),
        );
      case "punya":
      case "has":
        return this.boundMethod("punya", 1, (args) =>
          map.has(this.toString(args[0])),
        );
      case "hapus":
      case "delete":
        return this.boundMethod("hapus", 1, (args) =>
          map.delete(this.toString(args[0])),
        );
      case "bersihkan":
      case "clear":
        return this.boundMethod("bersihkan", 0, () => {
          map.clear();
          return null;
        });
      default:
        return undefined;
    }
  }

  private boundMethod(
    name: string,
    arity: number | "variadic" | readonly [number, number],
    fn: (args: Value[]) => Value,
  ): NativeFunctionValue {
    return {
      kind: "NativeFunction",
      name,
      arity,
      call: fn,
    };
  }

  private invokeCallback(callee: Value, args: Value[], loc: Location): Value {
    if (this.isFunction(callee)) {
      const acceptedArgs = args.slice(0, callee.params.length);
      return this.callFunction(callee, acceptedArgs, loc);
    }
    return this.callFunction(callee, args, loc);
  }

  // ==========================================================
  // Indexing & Slicing (`a[i]` & `a[start:end:step]`)
  // ==========================================================

  private evalIndex(expr: IndexExprNode, env: Environment): Value {
    const obj = this.evaluate(expr.object, env);
    const idx = this.evaluate(expr.index, env);

    if (Array.isArray(obj)) {
      if (typeof idx !== "number" || !Number.isInteger(idx)) {
        throw this.createRuntimeError(
          `index Daftar harus bilangan bulat (Angka), dapat ${this.typeName(idx)}`,
          ErrorCode.INVALID_CAST,
          expr.loc,
        );
      }
      const resolved = idx < 0 ? obj.length + idx : idx;
      if (resolved < 0 || resolved >= obj.length) {
        throw this.createRuntimeError(
          `index di luar batas: ${idx} (panjang ${obj.length})`,
          ErrorCode.INDEX_OUT_OF_BOUNDS,
          expr.loc,
        );
      }
      return obj[resolved];
    }

    if (obj instanceof Map) {
      const key = String(idx);
      if (!obj.has(key)) {
        throw this.createRuntimeError(
          `key tidak ditemukan di Peta: \`${key}\``,
          ErrorCode.KEY_NOT_FOUND,
          expr.loc,
        );
      }
      return obj.get(key);
    }

    if (typeof obj === "string") {
      if (typeof idx !== "number" || !Number.isInteger(idx)) {
        throw this.createRuntimeError(
          `index Teks harus bilangan bulat (Angka), dapat ${this.typeName(idx)}`,
          ErrorCode.INVALID_CAST,
          expr.loc,
        );
      }
      const resolved = idx < 0 ? obj.length + idx : idx;
      if (resolved < 0 || resolved >= obj.length) {
        throw this.createRuntimeError(
          `index di luar batas: ${idx} (panjang ${obj.length})`,
          ErrorCode.INDEX_OUT_OF_BOUNDS,
          expr.loc,
        );
      }
      return obj[resolved]!;
    }

    throw this.createRuntimeError(
      `tipe ${this.typeName(obj)} tidak bisa diakses dengan index`,
      ErrorCode.NOT_INDEXABLE,
      expr.loc,
    );
  }

  private evalSlice(expr: SliceExprNode, env: Environment): Value {
    const obj = this.evaluate(expr.object, env);
    if (!Array.isArray(obj) && typeof obj !== "string") {
      throw this.createRuntimeError(
        `operasi slice \`[awal:akhir]\` hanya untuk Daftar atau Teks, dapat ${this.typeName(obj)}`,
        ErrorCode.NOT_INDEXABLE,
        expr.loc,
      );
    }

    const len = obj.length;
    const rawStep = expr.step ? this.evaluate(expr.step, env) : 1;
    if (typeof rawStep !== "number" || !Number.isInteger(rawStep) || rawStep === 0) {
      throw this.createRuntimeError(
        "langkah (step) pada slice harus bilangan bulat bukan nol",
        ErrorCode.INVALID_OPERATOR,
        expr.loc,
      );
    }

    const rawStart = expr.start ? this.evaluate(expr.start, env) : null;
    const rawEnd = expr.end ? this.evaluate(expr.end, env) : null;

    if (rawStart !== null && typeof rawStart !== "number") {
      throw this.createRuntimeError(
        "batas awal slice harus Angka",
        ErrorCode.TYPE_MISMATCH,
        expr.loc,
      );
    }
    if (rawEnd !== null && typeof rawEnd !== "number") {
      throw this.createRuntimeError(
        "batas akhir slice harus Angka",
        ErrorCode.TYPE_MISMATCH,
        expr.loc,
      );
    }

    let start: number;
    let end: number;

    if (rawStep > 0) {
      start = rawStart === null ? 0 : rawStart < 0 ? Math.max(0, len + rawStart) : Math.min(len, rawStart);
      end = rawEnd === null ? len : rawEnd < 0 ? Math.max(0, len + rawEnd) : Math.min(len, rawEnd);
    } else {
      start = rawStart === null ? len - 1 : rawStart < 0 ? Math.max(-1, len + rawStart) : Math.min(len - 1, rawStart);
      end = rawEnd === null ? -1 : rawEnd < 0 ? Math.max(-1, len + rawEnd) : Math.min(len - 1, rawEnd);
    }

    if (Array.isArray(obj)) {
      const out: Value[] = [];
      if (rawStep > 0) {
        for (let i = start; i < end; i += rawStep) out.push(obj[i]!);
      } else {
        for (let i = start; i > end; i += rawStep) out.push(obj[i]!);
      }
      return out;
    } else {
      let out = "";
      if (rawStep > 0) {
        for (let i = start; i < end; i += rawStep) out += obj[i]!;
      } else {
        for (let i = start; i > end; i += rawStep) out += obj[i]!;
      }
      return out;
    }
  }

  // ==========================================================
  // Function Call & Spread Expansion
  // ==========================================================

  private evalCall(expr: CallExprNode, env: Environment): Value {
    const callee = this.evaluate(expr.callee, env);
    const args: Value[] = [];

    for (const argExpr of expr.args) {
      if ((argExpr as { kind: string }).kind === "SpreadExpr") {
        const spreadVal = this.evaluate(
          (argExpr as unknown as SpreadExprNode).argument,
          env,
        );
        args.push(...this.iterate(spreadVal, argExpr));
      } else {
        args.push(this.evaluate(argExpr, env));
      }
    }

    return this.callFunction(callee, args, expr.loc);
  }

  private callFunction(
    callee: Value,
    args: Value[],
    callLoc: Location,
  ): Value {
    this.functionCalls++;

    if (this.isNativeFunction(callee)) {
      if (typeof callee.arity === "number" && args.length !== callee.arity) {
        throw this.createRuntimeError(
          `fungsi \`${callee.name}\` membutuhkan ${callee.arity} argumen, tetapi dipanggil dengan ${args.length}`,
          ErrorCode.ARGUMENT_COUNT_MISMATCH,
          callLoc,
        );
      }
      if (Array.isArray(callee.arity)) {
        const [minArity, maxArity] = callee.arity;
        if (args.length < minArity || args.length > maxArity) {
          throw this.createRuntimeError(
            `fungsi \`${callee.name}\` membutuhkan ${minArity}-${maxArity} argumen, tetapi dipanggil dengan ${args.length}`,
            ErrorCode.ARGUMENT_COUNT_MISMATCH,
            callLoc,
          );
        }
      }
      return callee.call(args, callLoc);
    }

    if (this.isFunction(callee)) {
      const required = callee.params.filter((p) => !p.defaultValue).length;
      const max = callee.params.length;
      if (args.length < required || args.length > max) {
        const range = required === max ? `${required}` : `${required}-${max}`;
        throw this.createRuntimeError(
          `fungsi \`${callee.name}\` membutuhkan ${range} argumen, tetapi dipanggil dengan ${args.length}`,
          ErrorCode.ARGUMENT_COUNT_MISMATCH,
          callLoc,
        );
      }

      if (this.callStack.length >= this.maxCallDepth) {
        throw this.createRuntimeError(
          `kedalaman pemanggilan fungsi melampaui batas maksimum (${this.maxCallDepth}) — kemungkinan rekursi tanpa henti pada \`${callee.name}\``,
          ErrorCode.INTERNAL_ERROR,
          callLoc,
        );
      }

      this.callStack.push({
        functionName: callee.name,
        location: callLoc,
      });
      if (this.callStack.length > this.maxCallDepthReached) {
        this.maxCallDepthReached = this.callStack.length;
      }

      const fnEnv = new Environment(callee.closure);

      try {
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

          if (this.checkTypes && param.type) {
            this.assertMatchesType(
              value,
              param.type,
              callLoc,
              `argumen parameter \`${param.name}\` pada fungsi \`${callee.name}\``,
            );
          }

          fnEnv.define(param.name, value, true);
        }

        let returnVal: Value = undefined;
        try {
          if (callee.isArrow) {
            returnVal = this.evaluate(callee.body as ExprNode, fnEnv);
          } else {
            this.executeBlock(callee.body as BlockNode, fnEnv);
          }
        } catch (e) {
          if (e instanceof ReturnSignal) {
            returnVal = e.value;
          } else {
            throw e;
          }
        }

        if (this.checkTypes && callee.returnType) {
          this.assertMatchesType(
            returnVal,
            callee.returnType,
            callLoc,
            `nilai kembalian fungsi \`${callee.name}\``,
          );
        }

        return returnVal;
      } finally {
        this.callStack.pop();
      }
    }

    throw this.createRuntimeError(
      `nilai bertipe ${this.typeName(callee)} tidak bisa dipanggil sebagai fungsi`,
      ErrorCode.NOT_CALLABLE,
      callLoc,
    );
  }

  private evalList(expr: ListExprNode, env: Environment): Value {
    const out: Value[] = [];
    for (const el of expr.elements) {
      if ((el as { kind: string }).kind === "SpreadExpr") {
        const spreadVal = this.evaluate(
          (el as unknown as SpreadExprNode).argument,
          env,
        );
        out.push(...this.iterate(spreadVal, el));
      } else {
        out.push(this.evaluate(el, env));
      }
    }
    return out;
  }

  private evalListComp(expr: ListCompExprNode, env: Environment): Value {
    const iterableVal = this.evaluate(expr.iterable, env);
    const items = this.iterate(iterableVal, expr.iterable);
    const result: Value[] = [];

    for (const item of items) {
      const compEnv = new Environment(env);
      compEnv.define(expr.variable, item, false);
      if (expr.filter) {
        const pass = this.evaluate(expr.filter, compEnv);
        if (!this.truthy(pass, expr.filter)) continue;
      }
      result.push(this.evaluate(expr.element, compEnv));
    }

    return result;
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
      name: "<anonim>",
      params: expr.params,
      returnType: expr.returnType,
      body: expr.body,
      closure: env,
      isArrow: true,
    };
  }

  // ==========================================================
  // Operators (dengan Perbaikan Perbandingan String & Koleksi)
  // ==========================================================

  private applyBinaryOp(
    op: BinaryOperator,
    left: Value,
    right: Value,
    expr: ExprNode,
  ): Value {
    switch (op) {
      case "+":
        return this.add(left, right, expr);
      case "-":
        return this.numericOp(left, right, expr, (a, b) => a - b);
      case "*":
        // Dukung pengulangan string `"ha" * 3` seperti Python
        if (typeof left === "string" && typeof right === "number" && right >= 0) {
          return left.repeat(Math.floor(right));
        }
        return this.numericOp(left, right, expr, (a, b) => a * b);
      case "/":
        if (right === 0) {
          throw this.createRuntimeError(
            "pembagian dengan nol",
            ErrorCode.DIVISION_BY_ZERO,
            expr.loc,
          );
        }
        return this.numericOp(left, right, expr, (a, b) => a / b);
      case "%":
        if (right === 0) {
          throw this.createRuntimeError(
            "modulo dengan nol",
            ErrorCode.DIVISION_BY_ZERO,
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
      case "and":
        return this.truthy(left, expr) && this.truthy(right, expr);
      case "or":
        return this.truthy(left, expr) || this.truthy(right, expr);
    }
  }

  private add(left: Value, right: Value, expr: ExprNode): Value {
    if (typeof left === "string" || typeof right === "string") {
      return this.toString(left) + this.toString(right);
    }
    if (typeof left === "number" && typeof right === "number") {
      return left + right;
    }
    if (Array.isArray(left) && Array.isArray(right)) {
      return [...left, ...right];
    }
    if (left instanceof Map && right instanceof Map) {
      const merged = new Map<string, Value>(left);
      for (const [k, v] of right) merged.set(k, v);
      return merged;
    }
    throw this.createRuntimeError(
      `operator \`+\` tidak dapat digunakan antara ${this.typeName(left)} dan ${this.typeName(right)}`,
      ErrorCode.INVALID_OPERATOR,
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
      throw this.createRuntimeError(
        `operator aritmatika hanya untuk Angka, dapat ${this.typeName(left)} dan ${this.typeName(right)}`,
        ErrorCode.INVALID_OPERATOR,
        expr.loc,
      );
    }
    return fn(left, right);
  }

  private compareOp(
    left: Value,
    right: Value,
    expr: ExprNode,
    fn: (a: number | string, b: number | string) => boolean,
  ): Value {
    if (typeof left === "number" && typeof right === "number") {
      return fn(left, right);
    }
    if (typeof left === "string" && typeof right === "string") {
      return fn(left, right);
    }
    throw this.createRuntimeError(
      `perbandingan tidak valid antara ${this.typeName(left)} dan ${this.typeName(right)}`,
      ErrorCode.INVALID_OPERATOR,
      expr.loc,
    );
  }

  // ==========================================================
  // Runtime Type Validation (`TypeNode`)
  // ==========================================================

  private assertMatchesType(
    value: Value,
    typeNode: TypeNode,
    loc: Location,
    contextDesc: string,
  ): void {
    if (!this.matchesType(value, typeNode)) {
      throw this.createRuntimeError(
        `ketidakcocokan tipe pada ${contextDesc}: diharapkan \`${this.formatType(typeNode)}\`, tetapi mendapat \`${this.typeName(value)}\``,
        ErrorCode.TYPE_MISMATCH,
        loc,
      );
    }
  }

  private matchesType(value: Value, typeNode: TypeNode): boolean {
    switch (typeNode.kind) {
      case "PrimitiveType":
        switch (typeNode.name) {
          case "Angka":
            return typeof value === "number" && !Number.isNaN(value);
          case "Teks":
            return typeof value === "string";
          case "Boolean":
            return typeof value === "boolean";
          case "Null":
            return value === null;
          case "Kosong":
            return value === undefined || value === null;
          case "Error":
            return this.isErrorValue(value);
        }
        return false;

      case "NullableType":
        if (value === null || value === undefined) return true;
        return this.matchesType(value, typeNode.inner);

      case "UnionType":
        return typeNode.members.some((m) => this.matchesType(value, m));

      case "NamedType": {
        const aliased = this.typeAliases.get(typeNode.name);
        if (aliased) {
          return this.matchesType(value, aliased);
        }
        if (typeNode.name === "Daftar" || typeNode.name === "List") {
          if (!Array.isArray(value)) return false;
          if (typeNode.typeArgs.length === 1) {
            const elemType = typeNode.typeArgs[0]!;
            return value.every((el) => this.matchesType(el, elemType));
          }
          return true;
        }
        if (typeNode.name === "Peta" || typeNode.name === "Map") {
          if (!(value instanceof Map)) return false;
          if (typeNode.typeArgs.length === 2) {
            const valType = typeNode.typeArgs[1]!;
            for (const v of value.values()) {
              if (!this.matchesType(v, valType)) return false;
            }
          }
          return true;
        }
        if (typeNode.name === "ApaSaja" || typeNode.name === "Any") {
          return true;
        }
        return true;
      }

      case "RecordType": {
        if (!(value instanceof Map)) return false;
        for (const field of typeNode.fields) {
          const fieldVal = value.get(field.name);
          if (!this.matchesType(fieldVal, field.type)) return false;
        }
        return true;
      }

      case "FunctionType":
        return this.isFunction(value) || this.isNativeFunction(value);
    }
  }

  private formatType(typeNode: TypeNode): string {
    switch (typeNode.kind) {
      case "PrimitiveType":
        return typeNode.name;
      case "NullableType":
        return `${this.formatType(typeNode.inner)}?`;
      case "UnionType":
        return typeNode.members.map((m) => this.formatType(m)).join(" | ");
      case "NamedType":
        return typeNode.typeArgs.length > 0
          ? `${typeNode.name}<${typeNode.typeArgs.map((a) => this.formatType(a)).join(", ")}>`
          : typeNode.name;
      case "RecordType":
        return `{ ${typeNode.fields.map((f) => `${f.name}: ${this.formatType(f.type)}`).join(", ")} }`;
      case "FunctionType":
        return `(${typeNode.params.map((p) => this.formatType(p)).join(", ")}) -> ${this.formatType(typeNode.returns)}`;
    }
  }

  // ==========================================================
  // Helpers
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

    if (this.isErrorValue(a) && this.isErrorValue(b)) {
      return a.message === b.message && a.code === b.code;
    }

    return false;
  }

  private truthy(value: Value, expr: ExprNode): boolean {
    if (typeof value === "boolean") return value;
    throw this.createRuntimeError(
      `kondisi harus bertipe Boolean, tetapi mendapat ${this.typeName(value)}`,
      ErrorCode.TYPE_MISMATCH,
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
      return "[" + value.map((v) => this.formatElement(v)).join(", ") + "]";
    }
    if (value instanceof Map) {
      const entries = Array.from(value.entries())
        .map(([k, v]) => `"${k}": ${this.formatElement(v)}`)
        .join(", ");
      return "{" + entries + "}";
    }
    if (this.isFunction(value)) return `<fungsi ${value.name}>`;
    if (this.isNativeFunction(value)) return `<fungsi bawaan ${value.name}>`;
    if (this.isErrorValue(value)) return `Error: ${value.message}`;
    return String(value);
  }

  private formatElement(value: Value): string {
    if (typeof value === "string") return `"${value}"`;
    return this.toString(value);
  }

  private isFunction(v: Value): v is FunctionValue {
    return (
      typeof v === "object" &&
      v !== null &&
      "kind" in v &&
      v.kind === "Function"
    );
  }

  private isNativeFunction(v: Value): v is NativeFunctionValue {
    return (
      typeof v === "object" &&
      v !== null &&
      "kind" in v &&
      v.kind === "NativeFunction"
    );
  }

  private isErrorValue(v: Value): v is ErrorValue {
    return (
      typeof v === "object" &&
      v !== null &&
      !Array.isArray(v) &&
      !(v instanceof Map) &&
      "kind" in v &&
      v.kind === "Error"
    );
  }

  private toErrorValue(value: Value): ErrorValue {
    if (value === null || value === undefined) {
      return { kind: "Error", message: "error tanpa pesan", stack: [...this.callStack] };
    }
    if (typeof value === "string") {
      return { kind: "Error", message: value, stack: [...this.callStack] };
    }
    if (this.isErrorValue(value)) {
      return value.stack ? value : { ...value, stack: [...this.callStack] };
    }
    return {
      kind: "Error",
      message: this.toString(value),
      stack: [...this.callStack],
    };
  }

  private createRuntimeError(
    message: string,
    code: string,
    loc?: Location,
  ): RuntimeError {
    const frames = [...this.callStack];
    return new RuntimeError(
      { kind: "Error", message, code, stack: frames },
      loc,
      frames,
    );
  }

  private formatStackTrace(frames: readonly StackFrame[]): string[] {
    if (frames.length === 0) return [];
    const lines = [...frames]
      .reverse()
      .slice(0, 10)
      .map((f) => {
        const locStr = f.location
          ? ` (${f.location.file}:${f.location.start.line}:${f.location.start.column})`
          : "";
        return `di dalam fungsi \`${f.functionName}\`${locStr}`;
      });
    return [`Jejak pemanggilan (stack trace): ${lines.join(" <- ")}`];
  }

  private defaultValueForType(type: TypeNode | null): Value {
    if (!type) return null;
    if (type.kind === "NullableType") return null;
    if (type.kind === "PrimitiveType") {
      switch (type.name) {
        case "Angka": return 0;
        case "Teks": return "";
        case "Boolean": return false;
        case "Null": return null;
        case "Kosong": return undefined;
        case "Error": return { kind: "Error", message: "" };
      }
    }
    if (type.kind === "NamedType") {
      if (type.name === "Daftar" || type.name === "List") return [];
      if (type.name === "Peta" || type.name === "Map") return new Map();
    }
    return null;
  }

  private iterate(value: Value, expr: ExprNode): Value[] {
    if (Array.isArray(value)) return value;

    if (typeof value === "string") {
      return Array.from(value);
    }

    if (value instanceof Map) {
      return Array.from(value.entries()).map(([k, v]) => [k, v] as Value);
    }

    throw this.createRuntimeError(
      `nilai bertipe ${this.typeName(value)} tidak dapat diiterasi`,
      ErrorCode.INVALID_OPERATOR,
      expr.loc,
    );
  }

  private deepClone(value: Value): Value {
    if (Array.isArray(value)) {
      return value.map((el) => this.deepClone(el));
    }
    if (value instanceof Map) {
      const copy = new Map<string, Value>();
      for (const [k, v] of value.entries()) {
        copy.set(k, this.deepClone(v));
      }
      return copy;
    }
    return value;
  }

  // ==========================================================
  // Built-ins & Standard Library Modules
  // ==========================================================

  private installBuiltins(): void {
    // 1. I/O & Formatting
    this.defineNative("tulis", "variadic", (args) => {
      this.onPrint(args.map((a) => this.toString(a)).join(" "));
      return undefined;
    });

    this.defineNative("print", "variadic", (args) => {
      this.onPrint(args.map((a) => this.toString(a)).join(" "));
      return undefined;
    });

    // 2. Konversi Tipe & Konstruktor
    this.defineNative("Angka", 1, (args, loc) => {
      const v = args[0]!;
      if (typeof v === "number") return v;
      if (typeof v === "string") {
        const trimmed = v.trim();
        const n = trimmed.length === 0 ? NaN : Number(trimmed);
        if (Number.isNaN(n)) {
          throw this.createRuntimeError(
            `tidak bisa mengonversi \`${v}\` ke Angka`,
            ErrorCode.INVALID_CAST,
            loc,
          );
        }
        return n;
      }
      if (typeof v === "boolean") return v ? 1 : 0;
      throw this.createRuntimeError(
        `tidak bisa mengonversi ${this.typeName(v)} ke Angka`,
        ErrorCode.INVALID_CAST,
        loc,
      );
    });

    this.defineNative("Teks", 1, (args) => this.toString(args[0]!));

    this.defineNative("Boolean", 1, (args) => {
      const v = args[0];
      if (v === null || v === undefined || v === false || v === 0 || v === "") {
        return false;
      }
      if (Array.isArray(v)) return v.length > 0;
      if (v instanceof Map) return v.size > 0;
      return true;
    });

    this.defineNative("Daftar", [0, 1], (args, loc) => {
      if (args.length === 0) return [];
      const v = args[0]!;
      if (Array.isArray(v)) return [...v];
      if (typeof v === "string") return Array.from(v);
      if (v instanceof Map) return Array.from(v.entries());
      throw this.createRuntimeError(
        `tidak bisa membuat Daftar dari ${this.typeName(v)}`,
        ErrorCode.INVALID_CAST,
        loc,
      );
    });

    this.defineNative("Peta", [0, 1], (args, loc) => {
      if (args.length === 0) return new Map<string, Value>();
      const v = args[0]!;
      if (v instanceof Map) return new Map(v);
      if (Array.isArray(v)) {
        const map = new Map<string, Value>();
        for (const pair of v) {
          if (Array.isArray(pair) && pair.length >= 2) {
            map.set(this.toString(pair[0]), pair[1]);
          } else {
            throw this.createRuntimeError(
              "Peta(daftar) membutuhkan elemen pasangan [kunci, nilai]",
              ErrorCode.TYPE_MISMATCH,
              loc,
            );
          }
        }
        return map;
      }
      throw this.createRuntimeError(
        `tidak bisa membuat Peta dari ${this.typeName(v)}`,
        ErrorCode.INVALID_CAST,
        loc,
      );
    });

    this.defineNative("Error", [1, 2], (args) => {
      const msg = this.toString(args[0]!);
      const code = args[1] !== undefined ? this.toString(args[1]) : undefined;
      return {
        kind: "Error",
        message: msg,
        code,
        stack: [...this.callStack],
      } as ErrorValue;
    });

    // 3. Introspection & Koleksi
    this.defineNative("tipe", 1, (args) => this.typeName(args[0]!));

    this.defineNative("panjang", 1, (args, loc) => {
      const v = args[0]!;
      if (typeof v === "string") return v.length;
      if (Array.isArray(v)) return v.length;
      if (v instanceof Map) return v.size;
      throw this.createRuntimeError(
        `panjang() tidak berlaku untuk ${this.typeName(v)}`,
        ErrorCode.TYPE_MISMATCH,
        loc,
      );
    });

    // `rentang(akhir)`, `rentang(awal, akhir)`, atau `rentang(awal, akhir, langkah)`
    this.defineNative("rentang", [1, 3], (args, loc) => {
      let start = 0;
      let end = 0;
      let step = 1;

      if (args.length === 1) {
        if (typeof args[0] !== "number") {
          throw this.createRuntimeError("rentang() membutuhkan Angka", ErrorCode.TYPE_MISMATCH, loc);
        }
        end = args[0];
      } else {
        if (typeof args[0] !== "number" || typeof args[1] !== "number") {
          throw this.createRuntimeError("rentang() membutuhkan Angka", ErrorCode.TYPE_MISMATCH, loc);
        }
        start = args[0];
        end = args[1];
        if (args.length === 3) {
          if (typeof args[2] !== "number" || args[2] === 0) {
            throw this.createRuntimeError(
              "langkah pada rentang() harus Angka bukan nol",
              ErrorCode.INVALID_OPERATOR,
              loc,
            );
          }
          step = args[2];
        }
      }

      const result: Value[] = [];
      if (step > 0) {
        for (let i = start; i < end; i += step) result.push(i);
      } else {
        for (let i = start; i > end; i += step) result.push(i);
      }
      return result;
    });

    this.defineNative("enumerasi", 1, (args, loc) => {
      const v = args[0]!;
      if (!Array.isArray(v) && typeof v !== "string") {
        throw this.createRuntimeError(
          "enumerasi() hanya untuk Daftar atau Teks",
          ErrorCode.TYPE_MISMATCH,
          loc,
        );
      }
      const arr = Array.isArray(v) ? v : Array.from(v);
      return arr.map((item, idx) => [idx, item] as Value);
    });

    this.defineNative("zip", 2, (args, loc) => {
      const a = args[0];
      const b = args[1];
      if (!Array.isArray(a) || !Array.isArray(b)) {
        throw this.createRuntimeError(
          "zip() membutuhkan dua Daftar",
          ErrorCode.TYPE_MISMATCH,
          loc,
        );
      }
      const len = Math.min(a.length, b.length);
      const out: Value[] = [];
      for (let i = 0; i < len; i++) {
        out.push([a[i]!, b[i]!]);
      }
      return out;
    });

    this.defineNative("klon", 1, (args) => this.deepClone(args[0]));

    this.defineNative("pastikan", [1, 2], (args, loc) => {
      const cond = args[0];
      const msg =
        args[1] !== undefined
          ? this.toString(args[1])
          : "pemeriksaan `pastikan` (assertion) gagal";
      if (cond !== true) {
        throw this.createRuntimeError(msg, ErrorCode.INTERNAL_ERROR, loc);
      }
      return true;
    });

    // 4. Fungsi Matematika Global
    this.defineNative("abs", 1, (args, loc) => {
      if (typeof args[0] !== "number") {
        throw this.createRuntimeError("abs() membutuhkan Angka", ErrorCode.TYPE_MISMATCH, loc);
      }
      return Math.abs(args[0]);
    });

    this.defineNative("bulat", 1, (args, loc) => {
      if (typeof args[0] !== "number") {
        throw this.createRuntimeError("bulat() membutuhkan Angka", ErrorCode.TYPE_MISMATCH, loc);
      }
      return Math.round(args[0]);
    });

    this.defineNative("lantai", 1, (args, loc) => {
      if (typeof args[0] !== "number") {
        throw this.createRuntimeError("lantai() membutuhkan Angka", ErrorCode.TYPE_MISMATCH, loc);
      }
      return Math.floor(args[0]);
    });

    this.defineNative("langit", 1, (args, loc) => {
      if (typeof args[0] !== "number") {
        throw this.createRuntimeError("langit() membutuhkan Angka", ErrorCode.TYPE_MISMATCH, loc);
      }
      return Math.ceil(args[0]);
    });

    this.defineNative("akar", 1, (args, loc) => {
      if (typeof args[0] !== "number" || args[0] < 0) {
        throw this.createRuntimeError("akar() membutuhkan Angka >= 0", ErrorCode.TYPE_MISMATCH, loc);
      }
      return Math.sqrt(args[0]);
    });

    this.defineNative("min", "variadic", (args, loc) => {
      const nums = args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
      if (nums.length === 0 || !nums.every((n): n is number => typeof n === "number")) {
        throw this.createRuntimeError("min() membutuhkan minimal satu Angka", ErrorCode.TYPE_MISMATCH, loc);
      }
      return Math.min(...nums);
    });

    this.defineNative("maks", "variadic", (args, loc) => {
      const nums = args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
      if (nums.length === 0 || !nums.every((n): n is number => typeof n === "number")) {
        throw this.createRuntimeError("maks() membutuhkan minimal satu Angka", ErrorCode.TYPE_MISMATCH, loc);
      }
      return Math.max(...nums);
    });

    // 5. Internal Compiler/Parser Desugaring Helpers (`__coalesce` & `__contains`)
    this.defineNative("__coalesce", 2, (args) => {
      const left = args[0];
      return left !== null && left !== undefined ? left : args[1];
    });

    this.defineNative("__contains", 2, (args, loc) => {
      const container = args[0];
      const item = args[1];
      if (Array.isArray(container)) {
        return container.some((el) => this.valuesEqual(el, item));
      }
      if (typeof container === "string") {
        return container.includes(this.toString(item));
      }
      if (container instanceof Map) {
        return container.has(this.toString(item));
      }
      throw this.createRuntimeError(
        `operator \`in\` tidak dapat digunakan pada ${this.typeName(container)}`,
        ErrorCode.INVALID_OPERATOR,
        loc,
      );
    });
  }

  private installBuiltinModules(): void {
    // 1. Modul `stdlib`
    this.moduleCache.set("stdlib", this.global);

    // 2. Modul `math` / `matematika`
    const mathEnv = new Environment(null);
    mathEnv.define("PI", Math.PI, false, true);
    mathEnv.define("E", Math.E, false, true);
    mathEnv.define("abs", this.global.get("abs"), false, true);
    mathEnv.define("bulat", this.global.get("bulat"), false, true);
    mathEnv.define("lantai", this.global.get("lantai"), false, true);
    mathEnv.define("langit", this.global.get("langit"), false, true);
    mathEnv.define("akar", this.global.get("akar"), false, true);
    mathEnv.define("min", this.global.get("min"), false, true);
    mathEnv.define("maks", this.global.get("maks"), false, true);
    mathEnv.define(
      "sin",
      this.boundMethod("sin", 1, (a) => Math.sin(Number(a[0]))),
      false,
      true,
    );
    mathEnv.define(
      "cos",
      this.boundMethod("cos", 1, (a) => Math.cos(Number(a[0]))),
      false,
      true,
    );
    mathEnv.define(
      "tan",
      this.boundMethod("tan", 1, (a) => Math.tan(Number(a[0]))),
      false,
      true,
    );
    mathEnv.define(
      "log",
      this.boundMethod("log", 1, (a) => Math.log(Number(a[0]))),
      false,
      true,
    );
    mathEnv.define(
      "acak",
      this.boundMethod("acak", [0, 2], (a) => {
        if (a.length === 2 && typeof a[0] === "number" && typeof a[1] === "number") {
          const min = Math.ceil(a[0]);
          const max = Math.floor(a[1]);
          return Math.floor(Math.random() * (max - min + 1)) + min;
        }
        return Math.random();
      }),
      false,
      true,
    );
    this.moduleCache.set("math", mathEnv);
    this.moduleCache.set("matematika", mathEnv);

    // 3. Modul `json`
    const jsonEnv = new Environment(null);
    jsonEnv.define(
      "urai",
      this.boundMethod("urai", 1, (args, loc) => {
        try {
          const parsed = JSON.parse(this.toString(args[0]));
          return this.jsToValue(parsed);
        } catch {
          throw this.createRuntimeError(
            "gagal mengurai string JSON",
            ErrorCode.INVALID_STRING_LITERAL,
            loc,
          );
        }
      }),
      false,
      true,
    );
    jsonEnv.define(
      "teks",
      this.boundMethod("teks", [1, 2], (args) => {
        const indent = typeof args[1] === "number" ? args[1] : 0;
        return JSON.stringify(this.valueToJs(args[0]), null, indent);
      }),
      false,
      true,
    );
    this.moduleCache.set("json", jsonEnv);

    // 4. Modul `waktu`
    const timeEnv = new Environment(null);
    timeEnv.define(
      "sekarang",
      this.boundMethod("sekarang", 0, () => Date.now()),
      false,
      true,
    );
    timeEnv.define(
      "iso",
      this.boundMethod("iso", 0, () => new Date().toISOString()),
      false,
      true,
    );
    this.moduleCache.set("waktu", timeEnv);
  }

  private jsToValue(val: unknown): Value {
    if (
      val === null ||
      typeof val === "number" ||
      typeof val === "string" ||
      typeof val === "boolean"
    ) {
      return val;
    }
    if (Array.isArray(val)) {
      return val.map((item) => this.jsToValue(item));
    }
    if (typeof val === "object") {
      const map = new Map<string, Value>();
      for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
        map.set(k, this.jsToValue(v));
      }
      return map;
    }
    return null;
  }

  private valueToJs(val: Value): unknown {
    if (Array.isArray(val)) {
      return val.map((item) => this.valueToJs(item));
    }
    if (val instanceof Map) {
      const obj: Record<string, unknown> = {};
      for (const [k, v] of val.entries()) {
        obj[k] = this.valueToJs(v);
      }
      return obj;
    }
    return val;
  }

  private defineNative(
    name: string,
    arity: number | "variadic" | readonly [number, number],
    fn: (args: Value[], callSite?: Location) => Value,
  ): void {
    const value: NativeFunctionValue = {
      kind: "NativeFunction",
      name,
      arity,
      call: fn,
    };
    this.global.define(name, value, false, true);
  }
}

// ============================================================
// Convenience
// ============================================================

export function run(
  program: ProgramNode,
  file: string,
  reporter: Reporter,
  onPrint?: (line: string) => void,
  options?: Omit<InterpreterOptions, "file" | "reporter" | "onPrint">,
): Value {
  const interpreter = new Interpreter({ file, reporter, onPrint, ...options });
  return interpreter.run(program);
}
```
