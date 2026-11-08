/**
 * Snake Script — Advanced Parser (Pratt + Recursive Descent)
 *
 * Mengubah TokenStream menjadi AST (ProgramNode) dengan fitur kelas produksi:
 *
 * 1. Hybrid Recursive Descent & Pratt (Precedence Climbing) Expression Engine:
 *    - Tabel binding-power eksplisit untuk operator prefix, infix (left/right/non-assoc),
 *      dan postfix.
 *    - Mendukung pipeline (`|>`), nullish coalescing (`??`), optional chaining (`?.`),
 *      error propagation (`?`), slice (`a[1:5:2]`), list comprehension, spread (`...`),
 *      inline conditional (`a if cond else b`), serta multi-line lambda.
 *
 * 2. Rich Pattern Matching & Destructuring:
 *    - Mendukung Wildcard (`_`), Literal (termasuk angka negatif), Range (`1..10`),
 *      List destructuring (`[x, y, ...sisa]`), Record destructuring (`{ nama, umur: u }`),
 *      Constructor/Extractor (` Hasil(nilai)`), OrPattern (`A | B`), dan Binding (`as`).
 *
 * 3. Intelligent Error Recovery & Diagnostics:
 *    - Multi-level panic recovery: Top-level, Block-level, Match-case-level,
 *      Record-field-level, dan Delimiter-balanced skipping (`()`, `[]`, `{}`).
 *    - Fuzzy matching (Levenshtein distance) untuk saran perbaikan typo tipe primitif
 *      dan keyword Bahasa Indonesia / Snake Script ("Maksud Anda `Angka`?").
 *    - Pelacakan konteks semantik (`ParseContext`: loop, fungsi, match, blok) untuk
 *      mendeteksi `break`/`continue` di luar loop atau `return` di luar fungsi sejak tahap parse.
 *    - Proteksi kedalaman rekursi (`maxRecursionDepth`) dan batas maksimum error (`maxErrors`).
 *
 * 4. AST Introspection & Traversal Utilities:
 *    - Disertai `walkAST`, `countNodes`, dan `formatASTSummary` untuk inspeksi dan tooling.
 */

import type {
  Location,
  ProgramNode,
  StmtNode,
  DeclNode,
  ExprNode,
  TypeNode,
  PatternNode,
  BlockNode,
  ParamNode,
  FieldDeclNode,
  MapEntryNode,
  ElifClauseNode,
  CaseClauseNode,
  BinaryOperator,
  AssignOperator,
  ImportKind,
  PrimitiveTypeName,
} from "./ast.ts";

import { Lexer, TokenStream, type Token, type TokenKind } from "./lexer.ts";
import type { Reporter } from "./diagnostics.ts";
import { ErrorCode, InternalError } from "./diagnostics.ts";

// ============================================================
// Parser Options & Configuration
// ============================================================

export interface ParserOptions {
  readonly file: string;
  readonly reporter: Reporter;
  /** Mode recovery: lanjut parse setelah error. Default: true. */
  readonly recoverOnError?: boolean;
  /** Batas maksimum error sebelum parser berhenti total. Default: 100. */
  readonly maxErrors?: number;
  /** Batas maksimum kedalaman ekspresi/blok bersarang. Default: 256. */
  readonly maxRecursionDepth?: number;
  /** Validasi konteks sintaksis (`break`/`continue` di dalam loop, `return` di dalam fn). Default: true. */
  readonly validateContext?: boolean;
  /** Hook opsional untuk tracing/debugging setiap node statement/ekspresi yang selesai di-parse. */
  readonly onNodeParsed?: (node: StmtNode | ExprNode | TypeNode | PatternNode) => void;
}

export interface ParseMetrics {
  readonly file: string;
  readonly statementCount: number;
  readonly errorCount: number;
  readonly recoveryCount: number;
  readonly maxDepthReached: number;
  readonly durationMs: number;
}

// ============================================================
// Extended AST Node Extensions (Backward-Compatible)
// ============================================================

export interface SliceExprNode {
  readonly kind: "SliceExpr";
  readonly object: ExprNode;
  readonly start: ExprNode | null;
  readonly end: ExprNode | null;
  readonly step: ExprNode | null;
  readonly loc: Location;
}

export interface ListCompExprNode {
  readonly kind: "ListCompExpr";
  readonly element: ExprNode;
  readonly variable: string;
  readonly iterable: ExprNode;
  readonly filter: ExprNode | null;
  readonly loc: Location;
}

export interface ConditionalExprNode {
  readonly kind: "ConditionalExpr";
  readonly consequent: ExprNode;
  readonly condition: ExprNode;
  readonly alternate: ExprNode;
  readonly loc: Location;
}

export interface SpreadExprNode {
  readonly kind: "SpreadExpr";
  readonly argument: ExprNode;
  readonly loc: Location;
}

export interface TryPropagateExprNode {
  readonly kind: "TryPropagateExpr";
  readonly operand: ExprNode;
  readonly loc: Location;
}

export interface ListPatternNode {
  readonly kind: "ListPattern";
  readonly elements: PatternNode[];
  readonly rest: string | null;
  readonly loc: Location;
}

export interface RecordPatternFieldNode {
  readonly key: string;
  readonly pattern: PatternNode;
  readonly loc: Location;
}

export interface RecordPatternNode {
  readonly kind: "RecordPattern";
  readonly fields: RecordPatternFieldNode[];
  readonly loc: Location;
}

export interface RangePatternNode {
  readonly kind: "RangePattern";
  readonly start: number | string;
  readonly end: number | string;
  readonly inclusive: boolean;
  readonly loc: Location;
}

export interface ExtractorPatternNode {
  readonly kind: "ExtractorPattern";
  readonly name: string;
  readonly args: PatternNode[];
  readonly loc: Location;
}

// ============================================================
// Primitive Type Names & Fuzzy Suggestion Dictionary
// ============================================================

const PRIMITIVE_TYPES: ReadonlySet<string> = new Set([
  "Angka",
  "Teks",
  "Boolean",
  "Null",
  "Kosong",
  "Error",
]);

const COMMON_TYPE_ALIASES: Readonly<Record<string, PrimitiveTypeName>> = {
  number: "Angka",
  int: "Angka",
  float: "Angka",
  angka: "Angka",
  string: "Teks",
  str: "Teks",
  teks: "Teks",
  bool: "Boolean",
  boolean: "Boolean",
  void: "Kosong",
  kosong: "Kosong",
  null: "Null",
  nil: "Null",
  error: "Error",
  err: "Error",
};

const STATEMENT_START_KEYWORDS: ReadonlySet<TokenKind> = new Set<TokenKind>([
  "CONST",
  "LET",
  "FN",
  "TYPE",
  "IF",
  "WHILE",
  "FOR",
  "MATCH",
  "TRY",
  "RETURN",
  "BREAK",
  "CONTINUE",
  "THROW",
  "IMPORT",
  "EXPORT",
]);

const ASSIGNMENT_TOKENS: ReadonlySet<TokenKind> = new Set<TokenKind>([
  "EQ",
  "PLUS_EQ",
  "MINUS_EQ",
  "STAR_EQ",
  "SLASH_EQ",
  "PERCENT_EQ",
]);

// ============================================================
// Precedence Table (Pratt Binding Powers)
// ============================================================

const enum Precedence {
  NONE = 0,
  ASSIGNMENT = 10,   // = += -= *= /= %=
  CONDITIONAL = 15,  // expr if cond else alt
  PIPELINE = 20,     // |>
  COALESCE = 25,     // ??
  OR = 30,           // or
  AND = 40,          // and
  NOT = 50,          // not (prefix)
  COMPARISON = 60,   // == != < <= > >= in
  RANGE = 70,        // ..
  ADDITIVE = 80,     // + -
  MULTIPLICATIVE = 90, // * / %
  POWER = 100,       // ** (right-assoc)
  UNARY = 110,       // - (prefix)
  POSTFIX = 120,     // . [] () ?
}

interface InfixRule {
  readonly leftBP: number;
  readonly rightBP: number;
  readonly nonAssociative?: boolean;
}

const INFIX_RULES: Partial<Record<TokenKind, InfixRule>> = {
  OR:       { leftBP: Precedence.OR, rightBP: Precedence.OR + 1 },
  AND:      { leftBP: Precedence.AND, rightBP: Precedence.AND + 1 },
  EQ_EQ:    { leftBP: Precedence.COMPARISON, rightBP: Precedence.COMPARISON + 1, nonAssociative: true },
  BANG_EQ:  { leftBP: Precedence.COMPARISON, rightBP: Precedence.COMPARISON + 1, nonAssociative: true },
  LT:       { leftBP: Precedence.COMPARISON, rightBP: Precedence.COMPARISON + 1, nonAssociative: true },
  LT_EQ:    { leftBP: Precedence.COMPARISON, rightBP: Precedence.COMPARISON + 1, nonAssociative: true },
  GT:       { leftBP: Precedence.COMPARISON, rightBP: Precedence.COMPARISON + 1, nonAssociative: true },
  GT_EQ:    { leftBP: Precedence.COMPARISON, rightBP: Precedence.COMPARISON + 1, nonAssociative: true },
  IN:       { leftBP: Precedence.COMPARISON, rightBP: Precedence.COMPARISON + 1, nonAssociative: true },
  DOT_DOT:  { leftBP: Precedence.RANGE, rightBP: Precedence.RANGE + 1, nonAssociative: true },
  PLUS:     { leftBP: Precedence.ADDITIVE, rightBP: Precedence.ADDITIVE + 1 },
  MINUS:    { leftBP: Precedence.ADDITIVE, rightBP: Precedence.ADDITIVE + 1 },
  STAR:     { leftBP: Precedence.MULTIPLICATIVE, rightBP: Precedence.MULTIPLICATIVE + 1 },
  SLASH:    { leftBP: Precedence.MULTIPLICATIVE, rightBP: Precedence.MULTIPLICATIVE + 1 },
  PERCENT:  { leftBP: Precedence.MULTIPLICATIVE, rightBP: Precedence.MULTIPLICATIVE + 1 },
  STAR_STAR:{ leftBP: Precedence.POWER, rightBP: Precedence.POWER }, // right-associative
};

// ============================================================
// Semantic Context Tracking
// ============================================================

type ParseContextKind = "top-level" | "function" | "loop" | "match" | "try" | "block";

// ============================================================
// Parser
// ============================================================

export class Parser {
  private readonly stream: TokenStream;
  private readonly file: string;
  private readonly reporter: Reporter;
  private readonly recoverOnError: boolean;
  private readonly maxErrors: number;
  private readonly maxRecursionDepth: number;
  private readonly validateContext: boolean;
  private readonly onNodeParsed?: (node: StmtNode | ExprNode | TypeNode | PatternNode) => void;

  /** Depth tracker untuk mencegah stack overflow & infinite loop di recovery. */
  private recoveryDepth = 0;
  private recursionDepth = 0;
  private maxDepthReached = 0;

  /** Statistik dan penghitung error. */
  private errorCount = 0;
  private recoveryCount = 0;
  private lastErrorLine = -1;

  /** Stack konteks untuk validasi struktural (`break`, `continue`, `return`). */
  private readonly contextStack: ParseContextKind[] = ["top-level"];

  constructor(stream: TokenStream, opts: ParserOptions) {
    this.stream = stream;
    this.file = opts.file;
    this.reporter = opts.reporter;
    this.recoverOnError = opts.recoverOnError ?? true;
    this.maxErrors = opts.maxErrors ?? 100;
    this.maxRecursionDepth = opts.maxRecursionDepth ?? 256;
    this.validateContext = opts.validateContext ?? true;
    this.onNodeParsed = opts.onNodeParsed;
  }

  // ==========================================================
  // Public API
  // ==========================================================

  /**
   * Entry point: parse seluruh program menjadi `ProgramNode`.
   */
  parseProgram(): ProgramNode {
    const startTime = performance.now();
    const startTok = this.peek();
    const statements: StmtNode[] = [];

    while (!this.check("EOF")) {
      if (this.check("NEWLINE")) {
        this.next();
        continue;
      }

      // Tangani DEDENT yatim di top-level secara aman tanpa loop tak berujung
      if (this.check("DEDENT") || this.check("INDENT")) {
        const stray = this.next();
        this.error(
          ErrorCode.UNEXPECTED_TOKEN,
          `indentasi tidak valid di level terluar (\`${stray.kind}\`)`,
          stray,
        );
        continue;
      }

      try {
        const stmt = this.parseStatement();
        if (stmt) {
          statements.push(stmt);
          this.onNodeParsed?.(stmt);
        }
      } catch (e) {
        if (e instanceof ParsePanic) {
          if (!this.recoverOnError || this.errorCount >= this.maxErrors) {
            break;
          }
          this.synchronize();
        } else {
          throw e;
        }
      }
    }

    const endTok = this.peek();
    const durationMs = performance.now() - startTime;
    this.lastMetrics = {
      file: this.file,
      statementCount: statements.length,
      errorCount: this.errorCount,
      recoveryCount: this.recoveryCount,
      maxDepthReached: this.maxDepthReached,
      durationMs,
    };

    return {
      kind: "Program",
      statements,
      loc: this.locOf(startTok, endTok),
    };
  }

  private lastMetrics: ParseMetrics | null = null;

  /**
   * Ambil metrik hasil parsing terakhir.
   */
  getMetrics(): ParseMetrics | null {
    return this.lastMetrics;
  }

  // ==========================================================
  // Statement Dispatch
  // ==========================================================

  private parseStatement(): StmtNode | null {
    return this.withRecursionGuard(() => {
      const tok = this.peek();

      switch (tok.kind) {
        case "IMPORT":
          return this.parseImport();
        case "EXPORT":
          return this.parseExport();
        case "TYPE":
          return this.parseTypeDecl();
        case "CONST":
        case "LET":
          return this.parseVarDecl();
        case "FN":
          // Jika `fn(` atau `fn<T>(` muncul sebagai ekspresi anonim di awal baris,
          // arahkan ke expression statement, bukan deklarasi fungsi bernama.
          if (this.peekKind(1) === "LPAREN" || this.peekKind(1) === "LT") {
            return this.parseExprStmt();
          }
          return this.parseFunctionDecl();
        case "IF":
          return this.parseIf();
        case "WHILE":
          return this.parseWhile();
        case "FOR":
          return this.parseFor();
        case "MATCH":
          return this.parseMatch();
        case "TRY":
          return this.parseTry();
        case "RETURN":
          return this.parseReturn();
        case "BREAK":
          return this.parseBreak();
        case "CONTINUE":
          return this.parseContinue();
        case "THROW":
          return this.parseThrow();
        case "NEWLINE":
          this.next();
          return null;
        case "EOF":
          return null;
        default:
          return this.parseExprStmt();
      }
    });
  }

  // ==========================================================
  // Import / Export
  // ==========================================================

  private parseImport(): StmtNode {
    const startTok = this.expect("IMPORT");
    let importKind: ImportKind = "default";
    const names: string[] = [];
    let alias: string | null = null;

    if (this.check("STAR")) {
      // import * as name from "..."
      this.next();
      this.expect("AS");
      alias = this.expectIdentifier("nama alias namespace setelah `as`");
      importKind = "namespace";
    } else if (this.check("LBRACE")) {
      // import { a, b } from "..." (mendukung multi-baris di dalam kurung kurawal)
      this.next();
      importKind = "named";
      this.skipNewlinesAndIndents();

      if (!this.check("RBRACE")) {
        do {
          this.skipNewlinesAndIndents();
          if (this.check("RBRACE")) break;
          const importedName = this.expectIdentifier("nama simbol yang di-import");
          if (this.match("AS")) {
            const localAlias = this.expectIdentifier("nama alias lokal setelah `as`");
            names.push(`${importedName} as ${localAlias}`);
          } else {
            names.push(importedName);
          }
          this.skipNewlinesAndIndents();
        } while (this.match("COMMA"));
      }

      this.skipNewlinesAndIndents();
      this.expect("RBRACE");
    } else {
      // import name from "..."
      importKind = "default";
      alias = this.expectIdentifier("nama modul default");
    }

    this.expect("FROM");
    const sourceTok = this.expect("STRING");
    const source = String(sourceTok.value ?? "");

    if (source.trim().length === 0) {
      this.error(
        ErrorCode.UNEXPECTED_TOKEN,
        "path modul pada `import ... from` tidak boleh string kosong",
        sourceTok,
      );
    }

    const endTok = this.expectLineEnd();

    return {
      kind: "ImportStmt",
      importKind,
      names,
      alias,
      source,
      loc: this.locOf(startTok, endTok),
    };
  }

  private parseExport(): StmtNode {
    const startTok = this.expect("EXPORT");

    if (!this.inContext("top-level")) {
      this.error(
        ErrorCode.UNEXPECTED_TOKEN,
        "`export` hanya diizinkan di level terluar (top-level)",
        startTok,
      );
    }

    let decl: DeclNode;

    if (this.check("CONST") || this.check("LET")) {
      decl = this.parseVarDeclNode();
    } else if (this.check("FN")) {
      decl = this.parseFunctionDeclNode();
    } else if (this.check("TYPE")) {
      decl = this.parseTypeDeclNode();
    } else {
      this.error(
        ErrorCode.UNEXPECTED_TOKEN,
        "hanya `const`, `let`, `fn`, atau `type` yang dapat di-export",
        this.peek(),
      );
      throw new ParsePanic();
    }

    return {
      kind: "ExportStmt",
      declaration: decl,
      loc: {
        start: startTok.loc.start,
        end: decl.loc.end,
        file: this.file,
      },
    };
  }

  // ==========================================================
  // Type Declaration
  // ==========================================================

  private parseTypeDecl(): StmtNode {
    return this.parseTypeDeclNode();
  }

  private parseTypeDeclNode(): DeclNode {
    const startTok = this.expect("TYPE");
    const name = this.expectIdentifier("nama tipe setelah `type`");
    const typeParams = this.parseOptionalTypeParams();

    this.expect("EQ");
    // Izinkan union type yang dimulai dengan `|` di baris baru
    this.match("PIPE");
    const value = this.parseTypeExpr();
    const endTok = this.expectLineEnd();

    return {
      kind: "TypeDecl",
      name,
      typeParams,
      value,
      loc: this.locOf(startTok, endTok),
    };
  }

  // ==========================================================
  // Variable Declaration
  // ==========================================================

  private parseVarDecl(): StmtNode {
    return this.parseVarDeclNode();
  }

  private parseVarDeclNode(): DeclNode {
    const startTok = this.peek();
    const mutable = startTok.kind === "LET";
    this.next();

    const name = this.expectIdentifier(
      `nama variabel setelah \`${mutable ? "let" : "const"}\``,
    );

    let typeAnnotation: TypeNode | null = null;
    if (this.match("COLON")) {
      typeAnnotation = this.parseTypeExpr();
    }

    let initializer: ExprNode | null = null;
    if (this.match("EQ")) {
      initializer = this.parseExpression();
    }

    if (!mutable && !initializer) {
      this.error(
        ErrorCode.UNEXPECTED_TOKEN,
        `deklarasi \`const ${name}\` wajib memiliki nilai awal (\`= ...\`)`,
        this.peek(),
      );
    } else if (!typeAnnotation && !initializer) {
      this.error(
        ErrorCode.UNEXPECTED_TOKEN,
        `deklarasi \`${name}\` harus punya anotasi tipe (\`: Tipe\`) atau nilai awal (\`= ...\`)`,
        this.peek(),
      );
    }

    const endTok = this.expectLineEnd();

    return {
      kind: "VarDecl",
      mutable,
      name,
      typeAnnotation,
      initializer,
      loc: this.locOf(startTok, endTok),
    };
  }

  // ==========================================================
  // Function Declaration
  // ==========================================================

  private parseFunctionDecl(): StmtNode {
    return this.parseFunctionDeclNode();
  }

  private parseFunctionDeclNode(): DeclNode {
    const startTok = this.expect("FN");
    const name = this.expectIdentifier("nama fungsi setelah `fn`");
    const typeParams = this.parseOptionalTypeParams();
    const params = this.parseParamList();

    let returnType: TypeNode | null = null;
    if (this.match("ARROW")) {
      returnType = this.parseTypeExpr();
    }

    // Dukung shorthand one-liner: `fn tambah(a: Angka, b: Angka) -> Angka => a + b`
    if (this.match("FAT_ARROW")) {
      const expr = this.withContext("function", () => this.parseExpression());
      const endTok = this.expectLineEnd();
      const bodyLoc = this.locOf(startTok, endTok);
      const syntheticReturn: StmtNode = {
        kind: "ReturnStmt",
        value: expr,
        loc: expr.loc,
      };
      const body: BlockNode = {
        kind: "Block",
        statements: [syntheticReturn],
        loc: bodyLoc,
      };
      return {
        kind: "FunctionDecl",
        name,
        typeParams,
        params,
        returnType,
        body,
        loc: bodyLoc,
      };
    }

    this.expect("COLON");
    const body = this.withContext("function", () => this.parseBlock());

    return {
      kind: "FunctionDecl",
      name,
      typeParams,
      params,
      returnType,
      body,
      loc: {
        start: startTok.loc.start,
        end: body.loc.end,
        file: this.file,
      },
    };
  }

  private parseParamList(): ParamNode[] {
    this.expect("LPAREN");
    const params: ParamNode[] = [];
    const seenNames = new Set<string>();

    this.skipNewlinesAndIndents();
    if (!this.check("RPAREN")) {
      do {
        this.skipNewlinesAndIndents();
        if (this.check("RPAREN")) break;
        const param = this.parseParam();
        if (seenNames.has(param.name)) {
          this.error(
            ErrorCode.UNEXPECTED_TOKEN,
            `parameter duplikat \`${param.name}\` di dalam deklarasi fungsi`,
            this.stream.previous(),
          );
        }
        seenNames.add(param.name);
        params.push(param);
        this.skipNewlinesAndIndents();
      } while (this.match("COMMA"));
    }

    this.skipNewlinesAndIndents();
    this.expect("RPAREN");

    // Validasi: parameter default tidak boleh mendahului parameter wajib
    let seenDefault = false;
    let firstDefaultName: string | null = null;
    for (const p of params) {
      if (p.defaultValue) {
        seenDefault = true;
        if (!firstDefaultName) firstDefaultName = p.name;
      } else if (seenDefault) {
        this.error(
          ErrorCode.UNEXPECTED_TOKEN,
          `parameter \`${p.name}\` tanpa default tidak boleh setelah parameter \`${firstDefaultName}\` yang berdefault`,
          this.peek(),
        );
      }
    }

    return params;
  }

  private parseParam(): ParamNode {
    const startTok = this.peek();
    const name = this.expectIdentifier("nama parameter");
    this.expect("COLON");
    const type = this.parseTypeExpr();

    let defaultValue: ExprNode | null = null;
    if (this.match("EQ")) {
      defaultValue = this.parseExpression();
    }

    return {
      kind: "Param",
      name,
      type,
      defaultValue,
      loc: this.locOf(startTok, this.stream.previous()),
    };
  }

  // ==========================================================
  // If / Elif / Else
  // ==========================================================

  private parseIf(): StmtNode {
    const startTok = this.expect("IF");
    const condition = this.parseExpression();
    this.expect("COLON");
    const then = this.parseBlock();

    const elifs: ElifClauseNode[] = [];
    while (this.check("ELIF")) {
      const elifTok = this.expect("ELIF");
      const elifCond = this.parseExpression();
      this.expect("COLON");
      const elifBody = this.parseBlock();
      elifs.push({
        kind: "ElifClause",
        condition: elifCond,
        body: elifBody,
        loc: {
          start: elifTok.loc.start,
          end: elifBody.loc.end,
          file: this.file,
        },
      });
    }

    let elseBlock: BlockNode | null = null;
    if (this.match("ELSE")) {
      // Dukung `else if` sebagai alias ramah pengguna untuk `elif`
      if (this.check("IF")) {
        const nestedIf = this.parseIf();
        elseBlock = {
          kind: "Block",
          statements: [nestedIf],
          loc: nestedIf.loc,
        };
      } else {
        this.expect("COLON");
        elseBlock = this.parseBlock();
      }
    }

    const endLoc =
      elseBlock?.loc ??
      (elifs.length > 0 ? elifs[elifs.length - 1]!.loc : then.loc);

    return {
      kind: "IfStmt",
      condition,
      then,
      elifs,
      else: elseBlock,
      loc: {
        start: startTok.loc.start,
        end: endLoc.end,
        file: this.file,
      },
    };
  }

  // ==========================================================
  // While
  // ==========================================================

  private parseWhile(): StmtNode {
    const startTok = this.expect("WHILE");
    const condition = this.parseExpression();
    this.expect("COLON");
    const body = this.withContext("loop", () => this.parseBlock());

    return {
      kind: "WhileStmt",
      condition,
      body,
      loc: {
        start: startTok.loc.start,
        end: body.loc.end,
        file: this.file,
      },
    };
  }

  // ==========================================================
  // For
  // ==========================================================

  private parseFor(): StmtNode {
    const startTok = this.expect("FOR");
    const variable = this.check("UNDERSCORE")
      ? (this.next(), "_")
      : this.expectIdentifier("nama variabel iterasi setelah `for`");
    this.expect("IN");
    const iterable = this.parseExpression();
    this.expect("COLON");
    const body = this.withContext("loop", () => this.parseBlock());

    return {
      kind: "ForStmt",
      variable,
      iterable,
      body,
      loc: {
        start: startTok.loc.start,
        end: body.loc.end,
        file: this.file,
      },
    };
  }

  // ==========================================================
  // Match (dengan Clause-Level Error Recovery)
  // ==========================================================

  private parseMatch(): StmtNode {
    const startTok = this.expect("MATCH");
    const subject = this.parseExpression();
    this.expect("COLON");
    this.expect("NEWLINE");
    this.expect("INDENT");

    const cases: CaseClauseNode[] = [];
    let elseBlock: BlockNode | null = null;

    this.withContext("match", () => {
      while (!this.check("DEDENT") && !this.check("EOF")) {
        if (this.check("NEWLINE")) {
          this.next();
          continue;
        }

        try {
          if (this.check("CASE")) {
            if (elseBlock) {
              this.error(
                ErrorCode.UNEXPECTED_TOKEN,
                "klausa `case` tidak boleh berada setelah klausa `else` di dalam `match`",
                this.peek(),
              );
            }
            cases.push(this.parseCaseClause());
            continue;
          }

          if (this.check("ELSE")) {
            if (elseBlock) {
              this.error(
                ErrorCode.UNEXPECTED_TOKEN,
                "hanya satu klausa `else` yang diizinkan di dalam `match`",
                this.peek(),
              );
            }
            this.next();
            this.expect("COLON");
            elseBlock = this.parseBlock();
            continue;
          }

          this.error(
            ErrorCode.UNEXPECTED_TOKEN,
            "diharapkan `case` atau `else` di dalam blok `match`",
            this.peek(),
          );
          throw new ParsePanic();
        } catch (e) {
          if (e instanceof ParsePanic) {
            if (!this.recoverOnError || this.errorCount >= this.maxErrors) {
              throw e;
            }
            this.synchronizeInMatch();
          } else {
            throw e;
          }
        }
      }
    });

    if (!this.check("EOF")) {
      this.expect("DEDENT");
    }

    if (cases.length === 0 && !elseBlock) {
      this.error(
        ErrorCode.UNEXPECTED_TOKEN,
        "pernyataan `match` harus memiliki minimal satu klausa `case` atau `else`",
        startTok,
      );
    }

    const endLoc =
      elseBlock?.loc ??
      (cases.length > 0 ? cases[cases.length - 1]!.loc : startTok.loc);

    return {
      kind: "MatchStmt",
      subject,
      cases,
      else: elseBlock,
      loc: {
        start: startTok.loc.start,
        end: endLoc.end,
        file: this.file,
      },
    };
  }

  private parseCaseClause(): CaseClauseNode {
    const startTok = this.expect("CASE");
    // Izinkan leading pipe `case | A | B:`
    this.match("PIPE");
    const pattern = this.parsePattern();

    let guard: ExprNode | null = null;
    if (this.match("IF")) {
      guard = this.parseExpression();
    }

    this.expect("COLON");
    const body = this.parseBlock();

    return {
      kind: "CaseClause",
      pattern,
      guard,
      body,
      loc: {
        start: startTok.loc.start,
        end: body.loc.end,
        file: this.file,
      },
    };
  }

  // ==========================================================
  // Patterns (Structural, Range, List, Record, Extractor, Or)
  // ==========================================================

  private parsePattern(): PatternNode {
    return this.withRecursionGuard(() => {
      const startTok = this.peek();
      const first = this.parsePrimaryPattern();

      if (this.check("PIPE")) {
        const patterns: PatternNode[] = [first];
        while (this.match("PIPE")) {
          patterns.push(this.parsePrimaryPattern());
        }
        const node: PatternNode = {
          kind: "OrPattern",
          patterns,
          loc: this.locOf(startTok, this.stream.previous()),
        };
        this.onNodeParsed?.(node);
        return node;
      }

      this.onNodeParsed?.(first);
      return first;
    });
  }

  private parsePrimaryPattern(): PatternNode {
    const tok = this.peek();

    // 1. Wildcard `_`
    if (tok.kind === "UNDERSCORE") {
      this.next();
      return { kind: "WildcardPattern", loc: tok.loc };
    }

    // 2. Number / String literal (dengan dukungan RangePattern `1..10` atau `"a".."z"`)
    if (tok.kind === "NUMBER" || tok.kind === "STRING") {
      this.next();
      if (this.match("DOT_DOT")) {
        const endTok = this.expect(tok.kind);
        const rangeNode: RangePatternNode = {
          kind: "RangePattern",
          start: tok.value as number | string,
          end: endTok.value as number | string,
          inclusive: true,
          loc: this.locOf(tok, endTok),
        };
        return rangeNode as unknown as PatternNode;
      }
      return {
        kind: "LiteralPattern",
        value: tok.value,
        loc: tok.loc,
      };
    }

    // 3. Boolean / Null literal
    if (tok.kind === "TRUE" || tok.kind === "FALSE" || tok.kind === "NULL") {
      this.next();
      const value =
        tok.kind === "TRUE" ? true : tok.kind === "FALSE" ? false : null;
      return { kind: "LiteralPattern", value, loc: tok.loc };
    }

    // 4. Negative numeric literal (dengan dukungan RangePattern `-10..0`)
    if (tok.kind === "MINUS" && this.peekKind(1) === "NUMBER") {
      this.next();
      const numTok = this.expect("NUMBER");
      const startVal = -(numTok.value as number);

      if (this.match("DOT_DOT")) {
        let endVal: number;
        let endTok: Token;
        if (this.match("MINUS")) {
          endTok = this.expect("NUMBER");
          endVal = -(endTok.value as number);
        } else {
          endTok = this.expect("NUMBER");
          endVal = endTok.value as number;
        }
        const rangeNode: RangePatternNode = {
          kind: "RangePattern",
          start: startVal,
          end: endVal,
          inclusive: true,
          loc: this.locOf(tok, endTok),
        };
        return rangeNode as unknown as PatternNode;
      }

      return {
        kind: "LiteralPattern",
        value: startVal,
        loc: this.locOf(tok, numTok),
      };
    }

    // 5. List destructuring pattern: `[a, b, ...rest]`
    if (tok.kind === "LBRACKET") {
      return this.parseListPattern();
    }

    // 6. Record/Map destructuring pattern: `{ nama, umur: u }`
    if (tok.kind === "LBRACE") {
      return this.parseRecordPattern();
    }

    // 7. Parenthesized pattern: `(A | B)`
    if (tok.kind === "LPAREN") {
      this.next();
      const inner = this.parsePattern();
      this.expect("RPAREN");
      return inner;
    }

    // 8. Identifier binding atau Extractor pattern `Some(x)`
    if (tok.kind === "IDENTIFIER") {
      this.next();
      const name = String(tok.value);

      if (this.check("LPAREN")) {
        this.next();
        const args: PatternNode[] = [];
        if (!this.check("RPAREN")) {
          do {
            if (this.check("RPAREN")) break;
            args.push(this.parsePattern());
          } while (this.match("COMMA"));
        }
        const closeTok = this.expect("RPAREN");
        const extractor: ExtractorPatternNode = {
          kind: "ExtractorPattern",
          name,
          args,
          loc: this.locOf(tok, closeTok),
        };
        return extractor as unknown as PatternNode;
      }

      return {
        kind: "BindingPattern",
        name,
        loc: tok.loc,
      };
    }

    this.error(
      ErrorCode.UNEXPECTED_TOKEN,
      `pola tidak valid: \`${tok.kind}\``,
      tok,
    );
    throw new ParsePanic();
  }

  private parseListPattern(): PatternNode {
    const startTok = this.expect("LBRACKET");
    const elements: PatternNode[] = [];
    let rest: string | null = null;

    if (!this.check("RBRACKET")) {
      do {
        if (this.check("RBRACKET")) break;
        // Rest pattern `..sisa`
        if (this.match("DOT_DOT")) {
          rest = this.check("UNDERSCORE")
            ? (this.next(), "_")
            : this.expectIdentifier("nama variabel rest setelah `..`");
          break;
        }
        elements.push(this.parsePattern());
      } while (this.match("COMMA"));
    }

    const endTok = this.expect("RBRACKET");
    const node: ListPatternNode = {
      kind: "ListPattern",
      elements,
      rest,
      loc: this.locOf(startTok, endTok),
    };
    return node as unknown as PatternNode;
  }

  private parseRecordPattern(): PatternNode {
    const startTok = this.expect("LBRACE");
    const fields: RecordPatternFieldNode[] = [];

    if (!this.check("RBRACE")) {
      do {
        if (this.check("RBRACE")) break;
        const fieldStart = this.peek();
        const key = this.expectIdentifier("nama properti pola record");
        let pattern: PatternNode;
        if (this.match("COLON")) {
          pattern = this.parsePattern();
        } else {
          pattern = {
            kind: "BindingPattern",
            name: key,
            loc: fieldStart.loc,
          };
        }
        fields.push({
          key,
          pattern,
          loc: this.locOf(fieldStart, this.stream.previous()),
        });
      } while (this.match("COMMA"));
    }

    const endTok = this.expect("RBRACE");
    const node: RecordPatternNode = {
      kind: "RecordPattern",
      fields,
      loc: this.locOf(startTok, endTok),
    };
    return node as unknown as PatternNode;
  }

  // ==========================================================
  // Try / Catch / Finally
  // ==========================================================

  private parseTry(): StmtNode {
    const startTok = this.expect("TRY");
    this.expect("COLON");
    const body = this.withContext("try", () => this.parseBlock());

    let errorName = "_";
    let catchBody: BlockNode;
    let finallyBody: BlockNode | null = null;

    if (this.match("CATCH")) {
      // Izinkan `catch:` tanpa nama variabel error (default ke `_`) maupun `catch err:`
      if (!this.check("COLON")) {
        errorName = this.check("UNDERSCORE")
          ? (this.next(), "_")
          : this.expectIdentifier("nama variabel error setelah `catch`");
      }
      this.expect("COLON");
      catchBody = this.parseBlock();

      if (this.match("FINALLY")) {
        this.expect("COLON");
        finallyBody = this.parseBlock();
      }
    } else if (this.match("FINALLY")) {
      // Izinkan `try ... finally` tanpa `catch` dengan menyusun catchBody kosong
      this.expect("COLON");
      finallyBody = this.parseBlock();
      catchBody = {
        kind: "Block",
        statements: [],
        loc: finallyBody.loc,
      };
    } else {
      this.error(
        ErrorCode.UNEXPECTED_TOKEN,
        "blok `try` harus diikuti oleh `catch` atau `finally`",
        this.peek(),
      );
      throw new ParsePanic();
    }

    const endLoc = finallyBody?.loc ?? catchBody.loc;

    return {
      kind: "TryStmt",
      body,
      errorName,
      catchBody,
      finallyBody,
      loc: {
        start: startTok.loc.start,
        end: endLoc.end,
        file: this.file,
      },
    };
  }

  // ==========================================================
  // Return / Break / Continue / Throw
  // ==========================================================

  private parseReturn(): StmtNode {
    const startTok = this.expect("RETURN");

    if (this.validateContext && !this.inContext("function")) {
      this.error(
        ErrorCode.UNEXPECTED_TOKEN,
        "`return` hanya dapat digunakan di dalam fungsi",
        startTok,
      );
    }

    let value: ExprNode | null = null;
    if (
      !this.check("NEWLINE") &&
      !this.check("EOF") &&
      !this.check("DEDENT")
    ) {
      value = this.parseExpression();
    }

    const endTok = this.expectLineEnd();

    return {
      kind: "ReturnStmt",
      value,
      loc: this.locOf(startTok, endTok),
    };
  }

  private parseBreak(): StmtNode {
    const startTok = this.expect("BREAK");

    if (this.validateContext && !this.inContext("loop")) {
      this.error(
        ErrorCode.UNEXPECTED_TOKEN,
        "`break` hanya dapat digunakan di dalam perulangan (`while` atau `for`)",
        startTok,
      );
    }

    const endTok = this.expectLineEnd();
    return {
      kind: "BreakStmt",
      loc: this.locOf(startTok, endTok),
    };
  }

  private parseContinue(): StmtNode {
    const startTok = this.expect("CONTINUE");

    if (this.validateContext && !this.inContext("loop")) {
      this.error(
        ErrorCode.UNEXPECTED_TOKEN,
        "`continue` hanya dapat digunakan di dalam perulangan (`while` atau `for`)",
        startTok,
      );
    }

    const endTok = this.expectLineEnd();
    return {
      kind: "ContinueStmt",
      loc: this.locOf(startTok, endTok),
    };
  }

  private parseThrow(): StmtNode {
    const startTok = this.expect("THROW");
    const value = this.parseExpression();
    const endTok = this.expectLineEnd();
    return {
      kind: "ThrowStmt",
      value,
      loc: this.locOf(startTok, endTok),
    };
  }

  // ==========================================================
  // Expression Statement
  // ==========================================================

  private parseExprStmt(): StmtNode {
    const startTok = this.peek();
    const expr = this.parseExpression();
    const endTok = this.expectLineEnd();

    return {
      kind: "ExprStmt",
      expression: expr,
      loc: this.locOf(startTok, endTok),
    };
  }

  // ==========================================================
  // Block (Multi-line Indented & Single-line Inline Support)
  // ==========================================================

  private parseBlock(): BlockNode {
    return this.withRecursionGuard(() => {
      // Dukung single-line block setelah `:` (misal: `if x > 0: return x`)
      if (!this.check("NEWLINE")) {
        const startTok = this.peek();
        const stmt = this.parseStatement();
        const statements = stmt ? [stmt] : [];
        const endLoc = stmt ? stmt.loc.end : startTok.loc.end;
        return {
          kind: "Block",
          statements,
          loc: {
            start: startTok.loc.start,
            end: endLoc,
            file: this.file,
          },
        };
      }

      const startTok = this.expect("NEWLINE");

      // Lewati baris kosong sebelum INDENT
      while (this.check("NEWLINE")) {
        this.next();
      }

      this.expect("INDENT");

      const statements: StmtNode[] = [];

      while (!this.check("DEDENT") && !this.check("EOF")) {
        if (this.check("NEWLINE")) {
          this.next();
          continue;
        }

        try {
          const stmt = this.parseStatement();
          if (stmt) {
            statements.push(stmt);
            this.onNodeParsed?.(stmt);
          }
        } catch (e) {
          if (e instanceof ParsePanic) {
            if (!this.recoverOnError || this.errorCount >= this.maxErrors) {
              throw e;
            }
            this.synchronizeInBlock();
          } else {
            throw e;
          }
        }
      }

      const endTok = this.check("DEDENT") ? this.next() : this.peek();

      return {
        kind: "Block",
        statements,
        loc: {
          start: startTok.loc.start,
          end: endTok.loc.end,
          file: this.file,
        },
      };
    });
  }

  // ==========================================================
  // Expression — Pratt (Precedence Climbing) Engine
  // ==========================================================

  private parseExpression(): ExprNode {
    return this.withRecursionGuard(() => {
      const expr = this.parseAssignment();
      this.onNodeParsed?.(expr);
      return expr;
    });
  }

  private parseAssignment(): ExprNode {
    const startTok = this.peek();
    const left = this.parseConditionalExpr();

    if (ASSIGNMENT_TOKENS.has(this.peek().kind)) {
      const opTok = this.next();
      const operator = this.assignOperatorOf(opTok.kind);
      const value = this.parseAssignment(); // right-associative

      if (
        left.kind !== "Identifier" &&
        left.kind !== "MemberExpr" &&
        left.kind !== "IndexExpr"
      ) {
        this.error(
          ErrorCode.UNEXPECTED_TOKEN,
          "target assignment harus berupa variabel (identifier), properti objek (`a.b`), atau elemen indeks (`a[i]`)",
          opTok,
        );
      }

      return {
        kind: "AssignExpr",
        operator,
        target: left,
        value,
        loc: {
          start: startTok.loc.start,
          end: value.loc.end,
          file: this.file,
        },
      };
    }

    return left;
  }

  /**
   * Ekspresi kondisional sebaris (Python-style):
   * `nilai_benar if kondisi else nilai_salah`
   */
  private parseConditionalExpr(): ExprNode {
    const startTok = this.peek();
    const expr = this.parsePrattExpr(Precedence.NONE);

    if (this.match("IF")) {
      const condition = this.parsePrattExpr(Precedence.NONE);
      this.expect("ELSE");
      const alternate = this.parseConditionalExpr();
      const condNode: ConditionalExprNode = {
        kind: "ConditionalExpr",
        consequent: expr,
        condition,
        alternate,
        loc: {
          start: startTok.loc.start,
          end: alternate.loc.end,
          file: this.file,
        },
      };
      return condNode as unknown as ExprNode;
    }

    return expr;
  }

  /**
   * Inti Pratt Parser: mem-parse prefix dan loop infix/postfix berdasarkan binding power.
   */
  private parsePrattExpr(minBP: number): ExprNode {
    let left = this.parsePrefixExpr();

    while (true) {
      const tok = this.peek();

      // 1. Operator Pipeline `|>` (disintesis sebagai `PIPE` + `GT` atau ` CallExpr`)
      if (
        tok.kind === "PIPE" &&
        this.peekKind(1) === "GT" &&
        Precedence.PIPELINE >= minBP
      ) {
        this.next(); // PIPE
        this.next(); // GT
        const right = this.parsePrattExpr(Precedence.PIPELINE + 1);
        left = this.desugarPipeline(left, right);
        continue;
      }

      // 2. Operator Nullish Coalescing `??` (dua token QUESTION berurutan)
      if (
        tok.kind === "QUESTION" &&
        this.peekKind(1) === "QUESTION" &&
        Precedence.COALESCE >= minBP
      ) {
        const q1 = this.next();
        const q2 = this.next();
        if (q1.loc.end.line === q2.loc.start.line) {
          const right = this.parsePrattExpr(Precedence.COALESCE + 1);
          left = {
            kind: "CallExpr",
            callee: {
              kind: "Identifier",
              name: "__coalesce",
              loc: this.locOf(q1, q2),
            },
            args: [left, right],
            loc: {
              start: left.loc.start,
              end: right.loc.end,
              file: this.file,
            },
          };
          continue;
        }
      }

      // 3. Operator `not in` (kombinasi NOT + IN)
      if (
        tok.kind === "NOT" &&
        this.peekKind(1) === "IN" &&
        Precedence.COMPARISON >= minBP
      ) {
        const notTok = this.next();
        this.next(); // IN
        const right = this.parsePrattExpr(Precedence.COMPARISON + 1);
        const inCall: ExprNode = {
          kind: "CallExpr",
          callee: {
            kind: "Identifier",
            name: "__contains",
            loc: notTok.loc,
          },
          args: [right, left],
          loc: {
            start: left.loc.start,
            end: right.loc.end,
            file: this.file,
          },
        };
        left = {
          kind: "UnaryExpr",
          operator: "not",
          operand: inCall,
          loc: {
            start: left.loc.start,
            end: right.loc.end,
            file: this.file,
          },
        };
        continue;
      }

      // 4. Operator Infix dari tabel precedence
      const rule = INFIX_RULES[tok.kind];
      if (!rule || rule.leftBP < minBP) {
        break;
      }

      const opTok = this.next();
      const right = this.parsePrattExpr(rule.rightBP);

      if (opTok.kind === "DOT_DOT") {
        // Range direpresentasikan sebagai pemanggilan `rentang(a, b)`
        left = {
          kind: "CallExpr",
          callee: {
            kind: "Identifier",
            name: "rentang",
            loc: left.loc,
          },
          args: [left, right],
          loc: {
            start: left.loc.start,
            end: right.loc.end,
            file: this.file,
          },
        };
      } else if (opTok.kind === "IN") {
        left = {
          kind: "CallExpr",
          callee: {
            kind: "Identifier",
            name: "__contains",
            loc: opTok.loc,
          },
          args: [right, left],
          loc: {
            start: left.loc.start,
            end: right.loc.end,
            file: this.file,
          },
        };
      } else {
        left = {
          kind: "BinaryExpr",
          operator: this.binaryOperatorOf(opTok.kind),
          left,
          right,
          loc: {
            start: left.loc.start,
            end: right.loc.end,
            file: this.file,
          },
        };
      }

      // Cegah chaining operator non-associative tanpa tanda kurung (misal `a < b < c`)
      if (rule.nonAssociative) {
        const nextRule = INFIX_RULES[this.peek().kind];
        if (nextRule && nextRule.leftBP === rule.leftBP) {
          this.error(
            ErrorCode.UNEXPECTED_TOKEN,
            `operator perbandingan/rentang \`${this.peek().kind}\` tidak dapat dirangkai secara langsung; gunakan \`and\` atau tanda kurung`,
            this.peek(),
          );
        }
      }
    }

    return left;
  }

  /**
   * Transformasi pipeline `a |> f(x, y)` menjadi `f(a, x, y)` dan `a |> f` menjadi `f(a)`.
   */
  private desugarPipeline(left: ExprNode, right: ExprNode): ExprNode {
    if (right.kind === "CallExpr") {
      return {
        kind: "CallExpr",
        callee: right.callee,
        args: [left, ...right.args],
        loc: {
          start: left.loc.start,
          end: right.loc.end,
          file: this.file,
        },
      };
    }
    return {
      kind: "CallExpr",
      callee: right,
      args: [left],
      loc: {
        start: left.loc.start,
        end: right.loc.end,
        file: this.file,
      },
    };
  }

  private parsePrefixExpr(): ExprNode {
    if (this.check("NOT")) {
      const startTok = this.next();
      const operand = this.parsePrattExpr(Precedence.NOT);
      return {
        kind: "UnaryExpr",
        operator: "not",
        operand,
        loc: {
          start: startTok.loc.start,
          end: operand.loc.end,
          file: this.file,
        },
      };
    }

    if (this.check("MINUS")) {
      const startTok = this.next();
      const operand = this.parsePrattExpr(Precedence.UNARY);
      return {
        kind: "UnaryExpr",
        operator: "-",
        operand,
        loc: {
          start: startTok.loc.start,
          end: operand.loc.end,
          file: this.file,
        },
      };
    }

    // Unary `+` (no-op numerik eksplisit)
    if (this.check("PLUS")) {
      this.next();
      return this.parsePrattExpr(Precedence.UNARY);
    }

    return this.parsePostfix();
  }

  private parsePostfix(): ExprNode {
    let expr = this.parsePrimary();

    while (true) {
      if (this.check("DOT")) {
        this.next();
        const name = this.expectMemberName();
        expr = {
          kind: "MemberExpr",
          object: expr,
          property: name,
          loc: {
            start: expr.loc.start,
            end: this.stream.previous().loc.end,
            file: this.file,
          },
        };
      } else if (this.check("QUESTION") && this.peekKind(1) === "DOT") {
        // Optional chaining `obj?.prop`
        this.next(); // QUESTION
        this.next(); // DOT
        const name = this.expectMemberName();
        expr = {
          kind: "MemberExpr",
          object: expr,
          property: name,
          loc: {
            start: expr.loc.start,
            end: this.stream.previous().loc.end,
            file: this.file,
          },
        };
      } else if (this.check("LBRACKET")) {
        expr = this.parseIndexOrSlice(expr);
      } else if (this.check("LPAREN")) {
        this.next();
        const args = this.parseArgList();
        const close = this.expect("RPAREN");
        expr = {
          kind: "CallExpr",
          callee: expr,
          args,
          loc: {
            start: expr.loc.start,
            end: close.loc.end,
            file: this.file,
          },
        };
      } else if (
        this.check("QUESTION") &&
        this.peekKind(1) !== "QUESTION" &&
        this.peekKind(1) !== "DOT"
      ) {
        // Postfix `?` untuk error propagation (Rust/Snake Script style `bacaFile()?`)
        const qTok = this.next();
        const propNode: TryPropagateExprNode = {
          kind: "TryPropagateExpr",
          operand: expr,
          loc: {
            start: expr.loc.start,
            end: qTok.loc.end,
            file: this.file,
          },
        };
        expr = propNode as unknown as ExprNode;
      } else {
        break;
      }
    }

    return expr;
  }

  /**
   * Mendukung pengaksesan indeks biasa `a[i]` maupun slice `a[awal:akhir:langkah]`.
   */
  private parseIndexOrSlice(object: ExprNode): ExprNode {
    this.expect("LBRACKET");

    let start: ExprNode | null = null;
    if (!this.check("COLON")) {
      start = this.parseExpression();
    }

    // Jika tidak ada `:`, ini adalah IndexExpr standar
    if (!this.match("COLON")) {
      if (!start) {
        this.error(
          ErrorCode.UNEXPECTED_TOKEN,
          "indeks tidak boleh kosong",
          this.peek(),
        );
        throw new ParsePanic();
      }
      const close = this.expect("RBRACKET");
      return {
        kind: "IndexExpr",
        object,
        index: start,
        loc: {
          start: object.loc.start,
          end: close.loc.end,
          file: this.file,
        },
      };
    }

    // Slice expression: `object[start:end:step]`
    let end: ExprNode | null = null;
    if (!this.check("COLON") && !this.check("RBRACKET")) {
      end = this.parseExpression();
    }

    let step: ExprNode | null = null;
    if (this.match("COLON") && !this.check("RBRACKET")) {
      step = this.parseExpression();
    }

    const close = this.expect("RBRACKET");
    const sliceNode: SliceExprNode = {
      kind: "SliceExpr",
      object,
      start,
      end,
      step,
      loc: {
        start: object.loc.start,
        end: close.loc.end,
        file: this.file,
      },
    };
    return sliceNode as unknown as ExprNode;
  }

  private parseArgList(): ExprNode[] {
    const args: ExprNode[] = [];
    this.skipNewlinesAndIndents();

    if (!this.check("RPAREN")) {
      do {
        this.skipNewlinesAndIndents();
        if (this.check("RPAREN")) break;

        if (this.match("DOT_DOT")) {
          const dotTok = this.stream.previous();
          const arg = this.parseExpression();
          const spread: SpreadExprNode = {
            kind: "SpreadExpr",
            argument: arg,
            loc: {
              start: dotTok.loc.start,
              end: arg.loc.end,
              file: this.file,
            },
          };
          args.push(spread as unknown as ExprNode);
        } else {
          args.push(this.parseExpression());
        }
        this.skipNewlinesAndIndents();
      } while (this.match("COMMA"));
    }

    this.skipNewlinesAndIndents();
    return args;
  }

  private parsePrimary(): ExprNode {
    const tok = this.peek();

    switch (tok.kind) {
      case "NUMBER":
      case "STRING":
      case "RAW_STRING":
      case "MULTILINE_STRING":
        return this.parseLiteral();

      case "TRUE":
      case "FALSE":
      case "NULL":
        return this.parseBooleanOrNull();

      case "STRING_INTERP_START":
        return this.parseInterpolatedString();

      case "IDENTIFIER":
        this.next();
        return {
          kind: "Identifier",
          name: String(tok.value),
          loc: tok.loc,
        };

      case "UNDERSCORE":
        this.next();
        return {
          kind: "Identifier",
          name: "_",
          loc: tok.loc,
        };

      case "FN":
        return this.parseFunctionExpr();

      case "LPAREN":
        return this.parseParenExpr();

      case "LBRACKET":
        return this.parseListLiteralOrComprehension();

      case "LBRACE":
        return this.parseMapLiteral();

      default:
        this.error(
          ErrorCode.UNEXPECTED_TOKEN,
          `ekspresi tidak valid: ditemukan \`${tok.kind}\``,
          tok,
        );
        throw new ParsePanic();
    }
  }

  private parseLiteral(): ExprNode {
    const tok = this.next();
    const literalKind: "number" | "string" =
      tok.kind === "NUMBER" ? "number" : "string";

    return {
      kind: "Literal",
      value: tok.value,
      literalKind,
      loc: tok.loc,
    };
  }

  private parseBooleanOrNull(): ExprNode {
    const tok = this.next();
    const value =
      tok.kind === "TRUE" ? true : tok.kind === "FALSE" ? false : null;
    const literalKind = tok.kind === "NULL" ? "null" : "boolean";
    return {
      kind: "Literal",
      value,
      literalKind: literalKind as "boolean",
      loc: tok.loc,
    };
  }

  private parseInterpolatedString(): ExprNode {
    const startTok = this.expect("STRING_INTERP_START");
    const parts: (string | ExprNode)[] = [];

    if (startTok.value) parts.push(String(startTok.value));

    // Ekspresi pertama di dalam `${...}`
    parts.push(this.parseExpression());

    while (this.check("STRING_INTERP_MIDDLE")) {
      const midTok = this.next();
      if (midTok.value) parts.push(String(midTok.value));
      parts.push(this.parseExpression());
    }

    const endTok = this.expect("STRING_INTERP_END");
    if (endTok.value) parts.push(String(endTok.value));

    return {
      kind: "InterpolatedString",
      parts,
      loc: this.locOf(startTok, endTok),
    };
  }

  private parseFunctionExpr(): ExprNode {
    const startTok = this.expect("FN");
    const typeParams = this.parseOptionalTypeParams();
    const params = this.parseParamList();

    let returnType: TypeNode | null = null;
    if (this.match("ARROW")) {
      returnType = this.parseTypeExpr();
    }

    this.expect("FAT_ARROW");
    const body = this.withContext("function", () => this.parseExpression());

    return {
      kind: "FunctionExpr",
      typeParams,
      params,
      returnType,
      body,
      loc: {
        start: startTok.loc.start,
        end: body.loc.end,
        file: this.file,
      },
    };
  }

  private parseParenExpr(): ExprNode {
    const startTok = this.expect("LPAREN");
    this.skipNewlinesAndIndents();
    const inner = this.parseExpression();
    this.skipNewlinesAndIndents();
    const endTok = this.expect("RPAREN");
    return {
      kind: "ParenExpr",
      inner,
      loc: this.locOf(startTok, endTok),
    };
  }

  /**
   * Mendukung list literal `[1, 2, 3]`, multiline list, spread `[..awal, 4]`,
   * serta list comprehension `[x * 2 for x in daftar if x > 0]`.
   */
  private parseListLiteralOrComprehension(): ExprNode {
    const startTok = this.expect("LBRACKET");
    const elements: ExprNode[] = [];

    this.skipNewlinesAndIndents();

    if (!this.check("RBRACKET")) {
      // Cek elemen pertama
      if (this.match("DOT_DOT")) {
        const dotTok = this.stream.previous();
        const arg = this.parseExpression();
        const spread: SpreadExprNode = {
          kind: "SpreadExpr",
          argument: arg,
          loc: { start: dotTok.loc.start, end: arg.loc.end, file: this.file },
        };
        elements.push(spread as unknown as ExprNode);
      } else {
        const firstElem = this.parseExpression();
        this.skipNewlinesAndIndents();

        // Cek apakah ini List Comprehension: `[expr for x in iterable if cond]`
        if (this.match("FOR")) {
          const variable = this.expectIdentifier("nama variabel iterasi pada list comprehension");
          this.expect("IN");
          const iterable = this.parsePrattExpr(Precedence.NONE);
          let filter: ExprNode | null = null;
          if (this.match("IF")) {
            filter = this.parsePrattExpr(Precedence.NONE);
          }
          this.skipNewlinesAndIndents();
          const endTok = this.expect("RBRACKET");
          const compNode: ListCompExprNode = {
            kind: "ListCompExpr",
            element: firstElem,
            variable,
            iterable,
            filter,
            loc: this.locOf(startTok, endTok),
          };
          return compNode as unknown as ExprNode;
        }

        elements.push(firstElem);
      }

      while (this.match("COMMA")) {
        this.skipNewlinesAndIndents();
        if (this.check("RBRACKET")) break;
        if (this.match("DOT_DOT")) {
          const dotTok = this.stream.previous();
          const arg = this.parseExpression();
          const spread: SpreadExprNode = {
            kind: "SpreadExpr",
            argument: arg,
            loc: { start: dotTok.loc.start, end: arg.loc.end, file: this.file },
          };
          elements.push(spread as unknown as ExprNode);
        } else {
          elements.push(this.parseExpression());
        }
        this.skipNewlinesAndIndents();
      }
    }

    this.skipNewlinesAndIndents();
    const endTok = this.expect("RBRACKET");
    return {
      kind: "ListExpr",
      elements,
      loc: this.locOf(startTok, endTok),
    };
  }

  private parseMapLiteral(): ExprNode {
    const startTok = this.expect("LBRACE");
    const entries: MapEntryNode[] = [];
    const seenKeys = new Set<string>();

    this.skipNewlinesAndIndents();

    if (!this.check("RBRACE")) {
      do {
        this.skipNewlinesAndIndents();
        if (this.check("RBRACE")) break;
        const entry = this.parseMapEntry();
        if (seenKeys.has(entry.key)) {
          this.error(
            ErrorCode.UNEXPECTED_TOKEN,
            `key map duplikat \`${entry.key}\``,
            this.stream.previous(),
          );
        }
        seenKeys.add(entry.key);
        entries.push(entry);
        this.skipNewlinesAndIndents();
      } while (this.match("COMMA"));
    }

    this.skipNewlinesAndIndents();
    const endTok = this.expect("RBRACE");
    return {
      kind: "MapExpr",
      entries,
      loc: this.locOf(startTok, endTok),
    };
  }

  private parseMapEntry(): MapEntryNode {
    const startTok = this.peek();
    let key: string;

    if (this.check("STRING")) {
      const tok = this.next();
      key = String(tok.value);
      this.expect("COLON");
      const value = this.parseExpression();
      return {
        kind: "MapEntry",
        key,
        value,
        loc: this.locOf(startTok, this.stream.previous()),
      };
    }

    if (this.check("IDENTIFIER")) {
      const tok = this.next();
      key = String(tok.value);

      // Mendukung shorthand property `{ nama, umur }` seperti ES6/Rust
      if (!this.check("COLON")) {
        const value: ExprNode = {
          kind: "Identifier",
          name: key,
          loc: tok.loc,
        };
        return {
          kind: "MapEntry",
          key,
          value,
          loc: tok.loc,
        };
      }

      this.expect("COLON");
      const value = this.parseExpression();
      return {
        kind: "MapEntry",
        key,
        value,
        loc: this.locOf(startTok, this.stream.previous()),
      };
    }

    this.error(
      ErrorCode.UNEXPECTED_TOKEN,
      "key map harus berupa string atau identifier",
      this.peek(),
    );
    throw new ParsePanic();
  }

  // ==========================================================
  // Type Expression (Union, Nullable, Generic, Function, Record)
  // ==========================================================

  private parseTypeExpr(): TypeNode {
    return this.withRecursionGuard(() => {
      const node = this.parseUnionType();
      this.onNodeParsed?.(node);
      return node;
    });
  }

  private parseUnionType(): TypeNode {
    const startTok = this.peek();
    const first = this.parsePostfixType();

    if (this.check("PIPE")) {
      const members: TypeNode[] = [first];
      while (this.match("PIPE")) {
        members.push(this.parsePostfixType());
      }
      return {
        kind: "UnionType",
        members,
        loc: this.locOf(startTok, this.stream.previous()),
      };
    }

    return first;
  }

  /**
   * Menangani postfix modifier pada SEMUA tipe:
   * - Nullable `?` (`Angka?`, `{ nama: Teks }?`, `((Angka) -> Teks)?`)
   * - List shorthand `[]` (`Angka[]` -> `Daftar<Angka>`)
   */
  private parsePostfixType(): TypeNode {
    const startTok = this.peek();
    let type = this.parsePrimaryType();

    while (true) {
      if (this.check("QUESTION")) {
        const qTok = this.next();
        type = {
          kind: "NullableType",
          inner: type,
          loc: {
            start: startTok.loc.start,
            end: qTok.loc.end,
            file: this.file,
          },
        };
      } else if (this.check("LBRACKET") && this.peekKind(1) === "RBRACKET") {
        this.next(); // LBRACKET
        const closeTok = this.next(); // RBRACKET
        type = {
          kind: "NamedType",
          name: "Daftar",
          typeArgs: [type],
          loc: {
            start: startTok.loc.start,
            end: closeTok.loc.end,
            file: this.file,
          },
        };
      } else {
        break;
      }
    }

    return type;
  }

  private parsePrimaryType(): TypeNode {
    const tok = this.peek();

    // 1. Record type: `{ nama: Teks, umur: Angka? }`
    if (tok.kind === "LBRACE") {
      return this.parseRecordType();
    }

    // 2. Function type `(Angka, Teks) -> Boolean` ATAU grouped type `(Angka | Teks)`
    if (tok.kind === "LPAREN") {
      return this.parseParenOrFunctionType();
    }

    // 3. Token `NULL` sebagai tipe primitif `Null`
    if (tok.kind === "NULL") {
      this.next();
      return {
        kind: "PrimitiveType",
        name: "Null",
        loc: tok.loc,
      };
    }

    // 4. Identifier: tipe primitif, saran typo, atau user-defined generic type
    if (tok.kind === "IDENTIFIER") {
      this.next();
      const name = String(tok.value);

      if (PRIMITIVE_TYPES.has(name)) {
        return {
          kind: "PrimitiveType",
          name: name as PrimitiveTypeName,
          loc: tok.loc,
        };
      }

      // Cek apakah pengguna mengetik huruf kecil (`angka`, `teks`, `string`, `number`)
      const aliasTarget = COMMON_TYPE_ALIASES[name.toLowerCase()];
      if (aliasTarget && name !== aliasTarget && !this.check("LT")) {
        const suggestion = findClosestMatch(name, [...PRIMITIVE_TYPES]);
        const hint = suggestion ?? aliasTarget;
        this.error(
          ErrorCode.UNEXPECTED_TOKEN,
          `tipe primitif \`${name}\` tidak dikenal; apakah maksud Anda \`${hint}\`?`,
          tok,
        );
        return {
          kind: "PrimitiveType",
          name: hint as PrimitiveTypeName,
          loc: tok.loc,
        };
      }

      const typeArgs: TypeNode[] = [];
      if (this.check("LT")) {
        this.next();
        do {
          if (this.check("GT")) break;
          typeArgs.push(this.parseTypeExpr());
        } while (this.match("COMMA"));
        this.expect("GT");
      }

      return {
        kind: "NamedType",
        name,
        typeArgs,
        loc: {
          start: tok.loc.start,
          end: this.stream.previous().loc.end,
          file: this.file,
        },
      };
    }

    this.error(
      ErrorCode.UNEXPECTED_TOKEN,
      `tipe tidak valid: ditemukan \`${tok.kind}\``,
      tok,
    );
    throw new ParsePanic();
  }

  private parseRecordType(): TypeNode {
    const startTok = this.expect("LBRACE");
    const fields: FieldDeclNode[] = [];
    const seenFields = new Set<string>();

    const multiLine = this.check("NEWLINE");
    if (multiLine) {
      this.next();
      this.expect("INDENT");
    }

    while (!this.check("RBRACE") && !this.check("EOF")) {
      if (this.check("NEWLINE")) {
        this.next();
        continue;
      }

      const fieldStart = this.peek();
      const name = this.expectIdentifier("nama field pada tipe record");
      if (seenFields.has(name)) {
        this.error(
          ErrorCode.UNEXPECTED_TOKEN,
          `field duplikat \`${name}\` di dalam tipe record`,
          fieldStart,
        );
      }
      seenFields.add(name);

      this.expect("COLON");
      const type = this.parseTypeExpr();

      fields.push({
        kind: "FieldDecl",
        name,
        type,
        loc: this.locOf(fieldStart, this.stream.previous()),
      });

      // Izinkan pemisah koma maupun newline
      this.match("COMMA");
      if (multiLine && this.check("NEWLINE")) {
        this.next();
      }
    }

    if (multiLine && this.check("DEDENT")) {
      this.next();
    }

    const endTok = this.expect("RBRACE");
    return {
      kind: "RecordType",
      fields,
      loc: this.locOf(startTok, endTok),
    };
  }

  /**
   * Membedakan `(Angka, Teks) -> Boolean` (FunctionType)
   * dari `(Angka | Teks)?` (Parenthesized Union Type).
   */
  private parseParenOrFunctionType(): TypeNode {
    const startTok = this.expect("LPAREN");

    // Kasus `() -> Tipe`
    if (this.match("RPAREN")) {
      this.expect("ARROW");
      const returns = this.parseTypeExpr();
      return {
        kind: "FunctionType",
        params: [],
        returns,
        loc: {
          start: startTok.loc.start,
          end: returns.loc.end,
          file: this.file,
        },
      };
    }

    const firstType = this.parseTypeExpr();

    // Jika hanya ada 1 tipe di dalam `(...)` dan setelah `)` TIDAK ada `->`,
    // maka ini adalah grouped type `(Angka | Teks)`.
    if (!this.check("COMMA") && this.match("RPAREN")) {
      if (!this.match("ARROW")) {
        return firstType;
      }
      const returns = this.parseTypeExpr();
      return {
        kind: "FunctionType",
        params: [firstType],
        returns,
        loc: {
          start: startTok.loc.start,
          end: returns.loc.end,
          file: this.file,
        },
      };
    }

    const params: TypeNode[] = [firstType];
    while (this.match("COMMA")) {
      if (this.check("RPAREN")) break;
      params.push(this.parseTypeExpr());
    }

    this.expect("RPAREN");
    this.expect("ARROW");
    const returns = this.parseTypeExpr();

    return {
      kind: "FunctionType",
      params,
      returns,
      loc: {
        start: startTok.loc.start,
        end: returns.loc.end,
        file: this.file,
      },
    };
  }

  // ==========================================================
  // Type Parameters
  // ==========================================================

  private parseOptionalTypeParams(): string[] {
    if (!this.check("LT")) return [];
    this.next();
    const params: string[] = [];
    const seen = new Set<string>();

    do {
      if (this.check("GT")) break;
      const paramName = this.expectIdentifier("nama parameter tipe generik");
      if (seen.has(paramName)) {
        this.error(
          ErrorCode.UNEXPECTED_TOKEN,
          `parameter tipe generik duplikat \`${paramName}\``,
          this.stream.previous(),
        );
      }
      seen.add(paramName);
      params.push(paramName);
    } while (this.match("COMMA"));

    this.expect("GT");
    return params;
  }

  // ==========================================================
  // Helpers — Context & Recursion Guard
  // ==========================================================

  private withContext<T>(ctx: ParseContextKind, fn: () => T): T {
    this.contextStack.push(ctx);
    try {
      return fn();
    } finally {
      this.contextStack.pop();
    }
  }

  private inContext(target: ParseContextKind): boolean {
    if (target === "top-level") {
      return this.contextStack.length === 1 && this.contextStack[0] === "top-level";
    }
    for (let i = this.contextStack.length - 1; i >= 0; i--) {
      const current = this.contextStack[i];
      if (current === target) return true;
      // Batas fungsi memutus akses `loop` luar untuk `break`/`continue`
      if (target === "loop" && current === "function") return false;
    }
    return false;
  }

  private withRecursionGuard<T>(fn: () => T): T {
    this.recursionDepth++;
    if (this.recursionDepth > this.maxDepthReached) {
      this.maxDepthReached = this.recursionDepth;
    }
    if (this.recursionDepth > this.maxRecursionDepth) {
      const tok = this.peek();
      this.recursionDepth--;
      this.error(
        ErrorCode.UNEXPECTED_TOKEN,
        `kedalaman ekspresi/blok melampaui batas maksimum (${this.maxRecursionDepth})`,
        tok,
      );
      throw new ParsePanic();
    }
    try {
      return fn();
    } finally {
      this.recursionDepth--;
    }
  }

  // ==========================================================
  // Helpers — Token Stream Navigation
  // ==========================================================

  private peek(offset = 0): Token {
    return this.stream.peek(offset);
  }

  private peekKind(offset = 0): TokenKind {
    return this.stream.peekKind(offset);
  }

  private next(): Token {
    return this.stream.next();
  }

  private check(kind: TokenKind): boolean {
    return this.stream.check(kind);
  }

  private match(kind: TokenKind): boolean {
    return this.stream.match(kind);
  }

  private expect(kind: TokenKind, contextHint?: string): Token {
    if (this.check(kind)) {
      return this.next();
    }
    const tok = this.peek();
    const detail = contextHint
      ? `diharapkan ${contextHint} (\`${kind}\`), ditemukan \`${tok.kind}\``
      : `diharapkan \`${kind}\`, ditemukan \`${tok.kind}\``;
    this.error(ErrorCode.UNEXPECTED_TOKEN, detail, tok);
    throw new ParsePanic();
  }

  private expectIdentifier(contextHint?: string): string {
    const tok = this.expect("IDENTIFIER", contextHint);
    return String(tok.value);
  }

  /**
   * Mengizinkan nama properti member (`obj.prop`) berupa IDENTIFIER maupun keyword
   * tertentu (misal `obj.type`, `obj.match`, `obj.else`).
   */
  private expectMemberName(): string {
    const tok = this.peek();
    if (tok.kind === "IDENTIFIER") {
      this.next();
      return String(tok.value);
    }
    if (tok.value !== undefined && tok.value !== null && /^[a-zA-Z_]\w*$/.test(String(tok.value))) {
      this.next();
      return String(tok.value);
    }
    return this.expectIdentifier("nama properti setelah `.`");
  }

  /**
   * Lewati token NEWLINE, INDENT, dan DEDENT di dalam ekspresi kurung/list/map multi-baris.
   */
  private skipNewlinesAndIndents(): void {
    while (
      this.check("NEWLINE") ||
      this.check("INDENT") ||
      this.check("DEDENT")
    ) {
      this.next();
    }
  }

  /**
   * Konsumsi NEWLINE, atau EOF, atau DEDENT sebagai terminator statement.
   */
  private expectLineEnd(): Token {
    if (this.check("NEWLINE")) {
      return this.next();
    }
    if (this.check("EOF") || this.check("DEDENT")) {
      return this.peek();
    }
    const tok = this.peek();
    this.error(
      ErrorCode.UNEXPECTED_TOKEN,
      `diharapkan akhir baris (\`NEWLINE\`), ditemukan \`${tok.kind}\``,
      tok,
    );
    throw new ParsePanic();
  }

  // ==========================================================
  // Helpers — Location
  // ==========================================================

  private locOf(start: Token, end: Token): Location {
    return {
      start: start.loc.start,
      end: end.loc.end,
      file: this.file,
    };
  }

  // ==========================================================
  // Helpers — Operator Mapping
  // ==========================================================

  private binaryOperatorOf(kind: TokenKind): BinaryOperator {
    switch (kind) {
      case "PLUS": return "+";
      case "MINUS": return "-";
      case "STAR": return "*";
      case "SLASH": return "/";
      case "PERCENT": return "%";
      case "STAR_STAR": return "**";
      case "EQ_EQ": return "==";
      case "BANG_EQ": return "!=";
      case "LT": return "<";
      case "LT_EQ": return "<=";
      case "GT": return ">";
      case "GT_EQ": return ">=";
      case "AND": return "and";
      case "OR": return "or";
      default:
        throw new InternalError(`unknown binary operator: ${kind}`);
    }
  }

  private assignOperatorOf(kind: TokenKind): AssignOperator {
    switch (kind) {
      case "EQ": return "=";
      case "PLUS_EQ": return "+=";
      case "MINUS_EQ": return "-=";
      case "STAR_EQ": return "*=";
      case "SLASH_EQ": return "/=";
      case "PERCENT_EQ": return "%=";
      default:
        throw new InternalError(`unknown assign operator: ${kind}`);
    }
  }

  // ==========================================================
  // Error Reporting & Multi-Level Recovery
  // ==========================================================

  private error(code: string, message: string, tok: Token): void {
    // Hindari cascading error beruntun pada baris yang sama jika masih dalam proses panik
    if (this.recoveryDepth > 0 && tok.loc.start.line === this.lastErrorLine) {
      return;
    }
    this.lastErrorLine = tok.loc.start.line;
    this.errorCount++;

    this.reporter.report({
      severity: "error",
      code,
      message,
      location: tok.loc,
    });
  }

  /**
   * Skip token sampai synchronization point berikutnya di top-level:
   * NEWLINE, DEDENT, EOF, atau keyword yang memulai statement baru,
   * sambil menjaga keseimbangan kurung `()`, `[]`, `{}`.
   */
  private synchronize(): void {
    if (this.recoveryDepth > 1000) {
      throw new InternalError("parser recovery loop detected");
    }
    this.recoveryDepth++;
    this.recoveryCount++;

    try {
      let delimiterDepth = 0;

      while (!this.check("EOF")) {
        const kind = this.peek().kind;

        if (kind === "LPAREN" || kind === "LBRACKET" || kind === "LBRACE") {
          delimiterDepth++;
          this.next();
          continue;
        }

        if (kind === "RPAREN" || kind === "RBRACKET" || kind === "RBRACE") {
          if (delimiterDepth > 0) delimiterDepth--;
          this.next();
          continue;
        }

        if (delimiterDepth === 0) {
          if (this.check("NEWLINE")) {
            this.next();
            return;
          }
          if (this.check("DEDENT")) {
            return;
          }
          if (STATEMENT_START_KEYWORDS.has(kind)) {
            return;
          }
        }

        this.next();
      }
    } finally {
      this.recoveryDepth--;
    }
  }

  /**
   * Synchronize di dalam block — berhenti pada DEDENT atau akhir baris yang seimbang.
   */
  private synchronizeInBlock(): void {
    this.recoveryCount++;
    let indentBalance = 0;

    while (!this.check("EOF")) {
      const kind = this.peek().kind;

      if (kind === "INDENT") {
        indentBalance++;
        this.next();
        continue;
      }

      if (kind === "DEDENT") {
        if (indentBalance === 0) return;
        indentBalance--;
        this.next();
        continue;
      }

      if (indentBalance === 0 && kind === "NEWLINE") {
        this.next();
        return;
      }

      this.next();
    }
  }

  /**
   * Synchronize khusus di dalam blok `match` — lompat ke klausa `case` atau `else` berikutnya.
   */
  private synchronizeInMatch(): void {
    this.recoveryCount++;
    let indentBalance = 0;

    while (!this.check("EOF")) {
      const kind = this.peek().kind;

      if (kind === "INDENT") {
        indentBalance++;
        this.next();
        continue;
      }

      if (kind === "DEDENT") {
        if (indentBalance === 0) return;
        indentBalance--;
        this.next();
        continue;
      }

      if (indentBalance === 0 && (kind === "CASE" || kind === "ELSE")) {
        return;
      }

      this.next();
    }
  }
}

// ============================================================
// ParsePanic — Sinyal Internal
// ============================================================

/**
 * Exception internal untuk sinyal ke parseProgram / parseBlock / parseMatch
 * bahwa kita perlu recovery. Bukan error yang dilaporkan ke user
 * — error sudah dilaporkan via reporter sebelum throw.
 */
class ParsePanic extends Error {
  constructor() {
    super("parse panic");
    this.name = "ParsePanic";
  }
}

// ============================================================
// Fuzzy Matching Helper (Levenshtein Distance)
// ============================================================

function levenshteinDistance(a: string, b: string): number {
  const s1 = a.toLowerCase();
  const s2 = b.toLowerCase();
  const m = s1.length;
  const n = s2.length;

  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array<number>(n + 1).fill(0),
  );

  for (let i = 0; i <= m; i++) dp[i]![0] = i;
  for (let j = 0; j <= n; j++) dp[0]![j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
      dp[i]![j] = Math.min(
        dp[i - 1]![j]! + 1,
        dp[i]![j - 1]! + 1,
        dp[i - 1]![j - 1]! + cost,
      );
    }
  }

  return dp[m]![n]!;
}

function findClosestMatch(
  input: string,
  candidates: readonly string[],
  maxDistance = 2,
): string | null {
  let best: string | null = null;
  let bestDist = maxDistance + 1;

  for (const candidate of candidates) {
    const dist = levenshteinDistance(input, candidate);
    if (dist < bestDist) {
      bestDist = dist;
      best = candidate;
    }
  }

  return best;
}

// ============================================================
// AST Visitor & Inspection Utilities
// ============================================================

export interface ASTVisitor {
  onStatement?(stmt: StmtNode): void;
  onExpression?(expr: ExprNode): void;
  onType?(type: TypeNode): void;
  onPattern?(pattern: PatternNode): void;
}

/**
 * Menelusuri seluruh node di dalam `ProgramNode` secara rekursif.
 */
export function walkAST(program: ProgramNode, visitor: ASTVisitor): void {
  const visitBlock = (block: BlockNode | null | undefined): void => {
    if (!block) return;
    for (const s of block.statements) visitStmt(s);
  };

  const visitType = (type: TypeNode | null | undefined): void => {
    if (!type) return;
    visitor.onType?.(type);
    switch (type.kind) {
      case "NullableType":
        visitType(type.inner);
        break;
      case "UnionType":
        for (const m of type.members) visitType(m);
        break;
      case "NamedType":
        for (const arg of type.typeArgs) visitType(arg);
        break;
      case "RecordType":
        for (const f of type.fields) visitType(f.type);
        break;
      case "FunctionType":
        for (const p of type.params) visitType(p);
        visitType(type.returns);
        break;
    }
  };

  const visitPattern = (pat: PatternNode | null | undefined): void => {
    if (!pat) return;
    visitor.onPattern?.(pat);
    if (pat.kind === "OrPattern") {
      for (const p of pat.patterns) visitPattern(p);
    }
  };

  const visitExpr = (expr: ExprNode | null | undefined): void => {
    if (!expr) return;
    visitor.onExpression?.(expr);
    switch (expr.kind) {
      case "BinaryExpr":
        visitExpr(expr.left);
        visitExpr(expr.right);
        break;
      case "UnaryExpr":
        visitExpr(expr.operand);
        break;
      case "AssignExpr":
        visitExpr(expr.target);
        visitExpr(expr.value);
        break;
      case "CallExpr":
        visitExpr(expr.callee);
        for (const arg of expr.args) visitExpr(arg);
        break;
      case "MemberExpr":
        visitExpr(expr.object);
        break;
      case "IndexExpr":
        visitExpr(expr.object);
        visitExpr(expr.index);
        break;
      case "ListExpr":
        for (const el of expr.elements) visitExpr(el);
        break;
      case "MapExpr":
        for (const entry of expr.entries) visitExpr(entry.value);
        break;
      case "ParenExpr":
        visitExpr(expr.inner);
        break;
      case "FunctionExpr":
        for (const p of expr.params) {
          visitType(p.type);
          visitExpr(p.defaultValue);
        }
        visitType(expr.returnType);
        visitExpr(expr.body);
        break;
      case "InterpolatedString":
        for (const part of expr.parts) {
          if (typeof part !== "string") visitExpr(part);
        }
        break;
    }
  };

  const visitStmt = (stmt: StmtNode): void => {
    visitor.onStatement?.(stmt);
    switch (stmt.kind) {
      case "ExportStmt":
        visitStmt(stmt.declaration);
        break;
      case "TypeDecl":
        visitType(stmt.value);
        break;
      case "VarDecl":
        visitType(stmt.typeAnnotation);
        visitExpr(stmt.initializer);
        break;
      case "FunctionDecl":
        for (const p of stmt.params) {
          visitType(p.type);
          visitExpr(p.defaultValue);
        }
        visitType(stmt.returnType);
        visitBlock(stmt.body);
        break;
      case "IfStmt":
        visitExpr(stmt.condition);
        visitBlock(stmt.then);
        for (const el of stmt.elifs) {
          visitExpr(el.condition);
          visitBlock(el.body);
        }
        visitBlock(stmt.else);
        break;
      case "WhileStmt":
        visitExpr(stmt.condition);
        visitBlock(stmt.body);
        break;
      case "ForStmt":
        visitExpr(stmt.iterable);
        visitBlock(stmt.body);
        break;
      case "MatchStmt":
        visitExpr(stmt.subject);
        for (const c of stmt.cases) {
          visitPattern(c.pattern);
          visitExpr(c.guard);
          visitBlock(c.body);
        }
        visitBlock(stmt.else);
        break;
      case "TryStmt":
        visitBlock(stmt.body);
        visitBlock(stmt.catchBody);
        visitBlock(stmt.finallyBody);
        break;
      case "ReturnStmt":
        visitExpr(stmt.value);
        break;
      case "ThrowStmt":
        visitExpr(stmt.value);
        break;
      case "ExprStmt":
        visitExpr(stmt.expression);
        break;
    }
  };

  for (const stmt of program.statements) {
    visitStmt(stmt);
  }
}

// ============================================================
// Convenience Functions
// ============================================================

/**
 * Parse source langsung dari string menjadi `ProgramNode`.
 */
export function parse(
  source: string,
  file: string,
  reporter: Reporter,
  options?: Omit<ParserOptions, "file" | "reporter">,
): ProgramNode {
  const lexer = new Lexer(source, { file, reporter });
  const stream = lexer.tokenize();
  const parser = new Parser(stream, { file, reporter, ...options });
  return parser.parseProgram();
}

/**
 * Parse source sekaligus mengembalikan metrik performa & diagnostik.
 */
export function parseWithMetrics(
  source: string,
  file: string,
  reporter: Reporter,
  options?: Omit<ParserOptions, "file" | "reporter">,
): { program: ProgramNode; metrics: ParseMetrics } {
  const lexer = new Lexer(source, { file, reporter });
  const stream = lexer.tokenize();
  const parser = new Parser(stream, { file, reporter, ...options });
  const program = parser.parseProgram();
  const metrics = parser.getMetrics()!;
  return { program, metrics };
}
