/**
 * Snake Script — Parser
 *
 * Mengubah TokenStream menjadi AST (Program).
 *
 * Strategi: recursive descent dengan precedence climbing untuk ekspresi.
 * Setiap method di class ini memetakan langsung ke satu rule di GRAMMAR.ebnf.
 *
 * Error recovery:
 * - Mode panic: saat error, parser skip sampai synchronization point
 *   (NEWLINE, DEDENT, atau keyword yang memulai statement baru).
 * - Satu kali parsing bisa melaporkan banyak error.
 */

import type {
  Location,
  Position,
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
  UnaryOperator,
  AssignOperator,
  ImportKind,
  PrimitiveTypeName,
} from "./ast.ts";

import { TokenStream, type Token, type TokenKind } from "./lexer.ts";
import type { Reporter } from "./diagnostics.ts";
import { ErrorCode, InternalError } from "./diagnostics.ts";

// ============================================================
// Parser Options
// ============================================================

export interface ParserOptions {
  readonly file: string;
  readonly reporter: Reporter;
  /** Mode recovery: lanjut parse setelah error. Default true. */
  readonly recoverOnError?: boolean;
}

// ============================================================
// Parser
// ============================================================

export class Parser {
  private readonly stream: TokenStream;
  private readonly file: string;
  private readonly reporter: Reporter;
  private readonly recoverOnError: boolean;

  /** Depth tracker untuk mencegah infinite loop di recovery. */
  private recoveryDepth = 0;

  constructor(stream: TokenStream, opts: ParserOptions) {
    this.stream = stream;
    this.file = opts.file;
    this.reporter = opts.reporter;
    this.recoverOnError = opts.recoverOnError ?? true;
  }

  // ==========================================================
  // Public API
  // ==========================================================

  /**
   * Entry point: parse seluruh program.
   */
  parseProgram(): ProgramNode {
    const statements: StmtNode[] = [];
    const startTok = this.peek();

    while (!this.check("EOF")) {
      try {
        const stmt = this.parseStatement();
        if (stmt) statements.push(stmt);
      } catch (e) {
        if (e instanceof ParsePanic) {
          this.synchronize();
        } else {
          throw e;
        }
      }
    }

    const endTok = this.peek();
    return {
      kind: "Program",
      statements,
      loc: this.locOf(startTok, endTok),
    };
  }

  // ==========================================================
  // Statement Dispatch
  // ==========================================================

  private parseStatement(): StmtNode | null {
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
  }

  // ==========================================================
  // Import / Export
  // ==========================================================

  private parseImport(): StmtNode {
    const startTok = this.expect("IMPORT");
    let importKind: ImportKind = "default";
    let names: string[] = [];
    let alias: string | null = null;

    if (this.match("STAR")) {
      // import * as name from "..."
      importKind = "namespace";
      this.expect("AS");
      alias = this.expectIdentifier();
    } else if (this.check("LBRACE")) {
      // import { a, b } from "..."
      importKind = "named";
      this.next(); // {
      if (!this.check("RBRACE")) {
        do {
          names.push(this.expectIdentifier());
        } while (this.match("COMMA") && !this.check("RBRACE"));
      }
      this.expect("RBRACE");
    } else {
      // import name from "..."
      importKind = "default";
      alias = this.expectIdentifier();
    }

    this.expect("FROM");
    const sourceTok = this.expect("STRING");
    const source = String(sourceTok.value ?? "");

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
    let decl: DeclNode;

    if (this.check("CONST") || this.check("LET")) {
      decl = this.parseVarDecl() as never;
    } else if (this.check("FN")) {
      decl = this.parseFunctionDecl() as never;
    } else if (this.check("TYPE")) {
      decl = this.parseTypeDecl() as never;
    } else {
      this.error(
        ErrorCode.UNEXPECTED_TOKEN,
        "hanya const, let, fn, atau type yang dapat di-export",
        this.peek(),
      );
      throw new ParsePanic();
    }

    return {
      kind: "ExportStmt",
      declaration: decl,
      loc: this.locOf(startTok, { loc: decl.loc } as Token),
    };
  }

  // ==========================================================
  // Type Declaration
  // ==========================================================

  private parseTypeDecl(): StmtNode {
    const startTok = this.expect("TYPE");
    const name = this.expectIdentifier();

    const typeParams = this.parseOptionalTypeParams();

    this.expect("EQ");
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
    const startTok = this.peek();
    const mutable = startTok.kind === "LET";
    this.next(); // const / let

    const name = this.expectIdentifier();

    let typeAnnotation: TypeNode | null = null;
    if (this.match("COLON")) {
      typeAnnotation = this.parseTypeExpr();
    }

    let initializer: ExprNode | null = null;
    if (this.match("EQ")) {
      initializer = this.parseExpression();
    }

    if (!typeAnnotation && !initializer) {
      this.error(
        ErrorCode.UNEXPECTED_TOKEN,
        `deklarasi \`${name}\` harus punya tipe atau nilai awal`,
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
    const startTok = this.expect("FN");
    const name = this.expectIdentifier();

    const typeParams = this.parseOptionalTypeParams();

    const params = this.parseParamList();

    let returnType: TypeNode | null = null;
    if (this.match("ARROW")) {
      returnType = this.parseTypeExpr();
    }

    this.expect("COLON");
    const body = this.parseBlock();

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

    if (!this.check("RPAREN")) {
      do {
        if (this.check("RPAREN")) break;
        params.push(this.parseParam());
      } while (this.match("COMMA"));
    }

    this.expect("RPAREN");

    // Validasi: parameter default tidak boleh mendahului parameter wajib
    let seenDefault = false;
    for (const p of params) {
      if (p.defaultValue) {
        seenDefault = true;
      } else if (seenDefault) {
        this.error(
          ErrorCode.UNEXPECTED_TOKEN,
          `parameter \`${p.name}\` tanpa default tidak boleh setelah parameter berdefault`,
          this.peek(),
        );
      }
    }

    return params;
  }

  private parseParam(): ParamNode {
    const startTok = this.peek();
    const name = this.expectIdentifier();
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
      loc: this.locOf(startTok, this.prevToken()),
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
      this.expect("COLON");
      elseBlock = this.parseBlock();
    }

    const endLoc = elseBlock?.loc ??
      (elifs.length > 0 ? elifs[elifs.length - 1]!.loc : then.loc);

    return {
      kind: "IfStmt",
      condition,
      then,
      elifs,
      else: elseBlock,
      loc: { start: startTok.loc.start, end: endLoc.end, file: this.file },
    };
  }

  // ==========================================================
  // While
  // ==========================================================

  private parseWhile(): StmtNode {
    const startTok = this.expect("WHILE");
    const condition = this.parseExpression();
    this.expect("COLON");
    const body = this.parseBlock();

    return {
      kind: "WhileStmt",
      condition,
      body,
      loc: { start: startTok.loc.start, end: body.loc.end, file: this.file },
    };
  }

  // ==========================================================
  // For
  // ==========================================================

  private parseFor(): StmtNode {
    const startTok = this.expect("FOR");
    const variable = this.expectIdentifier();
    this.expect("IN");
    const iterable = this.parseExpression();
    this.expect("COLON");
    const body = this.parseBlock();

    return {
      kind: "ForStmt",
      variable,
      iterable,
      body,
      loc: { start: startTok.loc.start, end: body.loc.end, file: this.file },
    };
  }

  // ==========================================================
  // Match
  // ==========================================================

  private parseMatch(): StmtNode {
    const startTok = this.expect("MATCH");
    const subject = this.parseExpression();
    this.expect("COLON");
    this.expect("NEWLINE");
    this.expect("INDENT");

    const cases: CaseClauseNode[] = [];
    let elseBlock: BlockNode | null = null;

    while (!this.check("DEDENT") && !this.check("EOF")) {
      if (this.check("CASE")) {
        cases.push(this.parseCaseClause());
      } else if (this.check("ELSE")) {
        const elseTok = this.next();
        this.expect("COLON");
        const body = this.parseBlock();
        elseBlock = body;
        // Setelah else, harus DEDENT
        void elseTok;
        break;
      } else if (this.check("NEWLINE")) {
        this.next();
      } else {
        this.error(
          ErrorCode.UNEXPECTED_TOKEN,
          "diharapkan `case` atau `else` di dalam match",
          this.peek(),
        );
        throw new ParsePanic();
      }
    }

    if (!this.check("EOF")) this.expect("DEDENT");

    const endLoc = elseBlock?.loc ??
      (cases.length > 0 ? cases[cases.length - 1]!.loc : startTok.loc);

    return {
      kind: "MatchStmt",
      subject,
      cases,
      else: elseBlock,
      loc: { start: startTok.loc.start, end: endLoc.end, file: this.file },
    };
  }

  private parseCaseClause(): CaseClauseNode {
    const startTok = this.expect("CASE");
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
      loc: { start: startTok.loc.start, end: body.loc.end, file: this.file },
    };
  }

  // ==========================================================
  // Patterns
  // ==========================================================

  private parsePattern(): PatternNode {
    const startTok = this.peek();
    const first = this.parsePrimaryPattern();

    if (this.check("PIPE")) {
      const patterns: PatternNode[] = [first];
      while (this.match("PIPE")) {
        patterns.push(this.parsePrimaryPattern());
      }
      return {
        kind: "OrPattern",
        patterns,
        loc: this.locOf(startTok, this.prevToken()),
      };
    }

    return first;
  }

  private parsePrimaryPattern(): PatternNode {
    const tok = this.peek();

    if (tok.kind === "UNDERSCORE") {
      this.next();
      return { kind: "WildcardPattern", loc: tok.loc };
    }

    if (tok.kind === "NUMBER" || tok.kind === "STRING") {
      this.next();
      return {
        kind: "LiteralPattern",
        value: tok.value,
        loc: tok.loc,
      };
    }

    if (tok.kind === "TRUE" || tok.kind === "FALSE" || tok.kind === "NULL") {
      this.next();
      const value =
        tok.kind === "TRUE" ? true : tok.kind === "FALSE" ? false : null;
      return { kind: "LiteralPattern", value, loc: tok.loc };
    }

    if (tok.kind === "MINUS" && this.peek(1).kind === "NUMBER") {
      this.next();
      const numTok = this.expect("NUMBER");
      return {
        kind: "LiteralPattern",
        value: -(numTok.value as number),
        loc: this.locOf(tok, numTok),
      };
    }

    if (tok.kind === "IDENTIFIER") {
      this.next();
      return { kind: "BindingPattern", name: String(tok.value), loc: tok.loc };
    }

    this.error(
      ErrorCode.UNEXPECTED_TOKEN,
      `pola tidak valid: ${tok.kind}`,
      tok,
    );
    throw new ParsePanic();
  }

  // ==========================================================
  // Try / Catch / Finally
  // ==========================================================

  private parseTry(): StmtNode {
    const startTok = this.expect("TRY");
    this.expect("COLON");
    const body = this.parseBlock();

    this.expect("CATCH");
    const errorName = this.expectIdentifier();
    this.expect("COLON");
    const catchBody = this.parseBlock();

    let finallyBody: BlockNode | null = null;
    if (this.match("FINALLY")) {
      this.expect("COLON");
      finallyBody = this.parseBlock();
    }

    const endLoc = finallyBody?.loc ?? catchBody.loc;

    return {
      kind: "TryStmt",
      body,
      errorName,
      catchBody,
      finallyBody,
      loc: { start: startTok.loc.start, end: endLoc.end, file: this.file },
    };
  }

  // ==========================================================
  // Return / Break / Continue / Throw
  // ==========================================================

  private parseReturn(): StmtNode {
    const startTok = this.expect("RETURN");

    let value: ExprNode | null = null;
    if (!this.check("NEWLINE") && !this.check("EOF") && !this.check("DEDENT")) {
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
    const endTok = this.expectLineEnd();
    return { kind: "BreakStmt", loc: this.locOf(startTok, endTok) };
  }

  private parseContinue(): StmtNode {
    const startTok = this.expect("CONTINUE");
    const endTok = this.expectLineEnd();
    return { kind: "ContinueStmt", loc: this.locOf(startTok, endTok) };
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
  // Block
  // ==========================================================

  private parseBlock(): BlockNode {
    const startTok = this.expect("NEWLINE");
    this.expect("INDENT");

    const statements: StmtNode[] = [];

    while (!this.check("DEDENT") && !this.check("EOF")) {
      if (this.check("NEWLINE")) {
        this.next();
        continue;
      }
      try {
        const stmt = this.parseStatement();
        if (stmt) statements.push(stmt);
      } catch (e) {
        if (e instanceof ParsePanic) {
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
      loc: { start: startTok.loc.start, end: endTok.loc.end, file: this.file },
    };
  }

  // ==========================================================
  // Expression — Precedence Climbing
  // ==========================================================

  private parseExpression(): ExprNode {
    return this.parseAssignment();
  }

  private parseAssignment(): ExprNode {
    const startTok = this.peek();
    const left = this.parseLogicOr();

    if (
      this.check("EQ") ||
      this.check("PLUS_EQ") ||
      this.check("MINUS_EQ") ||
      this.check("STAR_EQ") ||
      this.check("SLASH_EQ") ||
      this.check("PERCENT_EQ")
    ) {
      const opTok = this.next();
      const operator = this.assignOperatorOf(opTok.kind);
      const value = this.parseAssignment();

      // Validasi target
      if (left.kind !== "Identifier" && left.kind !== "MemberExpr" && left.kind !== "IndexExpr") {
        this.error(
          ErrorCode.UNEXPECTED_TOKEN,
          "sisi kiri assignment harus identifier, member, atau index",
          opTok,
        );
      }

      return {
        kind: "AssignExpr",
        operator,
        target: left,
        value,
        loc: { start: startTok.loc.start, end: value.loc.end, file: this.file },
      };
    }

    return left;
  }

  private parseLogicOr(): ExprNode {
    let left = this.parseLogicAnd();

    while (this.check("OR")) {
      const opTok = this.next();
      const right = this.parseLogicAnd();
      left = {
        kind: "BinaryExpr",
        operator: "or",
        left,
        right,
        loc: { start: left.loc.start, end: right.loc.end, file: this.file },
      };
      void opTok;
    }

    return left;
  }

  private parseLogicAnd(): ExprNode {
    let left = this.parseLogicNot();

    while (this.check("AND")) {
      const opTok = this.next();
      const right = this.parseLogicNot();
      left = {
        kind: "BinaryExpr",
        operator: "and",
        left,
        right,
        loc: { start: left.loc.start, end: right.loc.end, file: this.file },
      };
      void opTok;
    }

    return left;
  }

  private parseLogicNot(): ExprNode {
    if (this.check("NOT")) {
      const startTok = this.next();
      const operand = this.parseLogicNot();
      return {
        kind: "UnaryExpr",
        operator: "not",
        operand,
        loc: { start: startTok.loc.start, end: operand.loc.end, file: this.file },
      };
    }
    return this.parseComparison();
  }

  private parseComparison(): ExprNode {
    const left = this.parseRange();

    if (
      this.check("EQ_EQ") ||
      this.check("BANG_EQ") ||
      this.check("LT") ||
      this.check("LT_EQ") ||
      this.check("GT") ||
      this.check("GT_EQ")
    ) {
      const opTok = this.next();
      const right = this.parseRange();
      return {
        kind: "BinaryExpr",
        operator: this.binaryOperatorOf(opTok.kind),
        left,
        right,
        loc: { start: left.loc.start, end: right.loc.end, file: this.file },
      };
    }

    return left;
  }

  private parseRange(): ExprNode {
    const left = this.parseAdditive();

    if (this.check("DOT_DOT")) {
      this.next();
      const right = this.parseAdditive();
      // Range direpresentasikan sebagai pemanggilan fungsi `rentang`
      return {
        kind: "CallExpr",
        callee: {
          kind: "Identifier",
          name: "rentang",
          loc: left.loc,
        },
        args: [left, right],
        loc: { start: left.loc.start, end: right.loc.end, file: this.file },
      };
    }

    return left;
  }

  private parseAdditive(): ExprNode {
    let left = this.parseMultiplicative();

    while (this.check("PLUS") || this.check("MINUS")) {
      const opTok = this.next();
      const right = this.parseMultiplicative();
      left = {
        kind: "BinaryExpr",
        operator: opTok.kind === "PLUS" ? "+" : "-",
        left,
        right,
        loc: { start: left.loc.start, end: right.loc.end, file: this.file },
      };
    }

    return left;
  }

  private parseMultiplicative(): ExprNode {
    let left = this.parsePower();

    while (
      this.check("STAR") ||
      this.check("SLASH") ||
      this.check("PERCENT")
    ) {
      const opTok = this.next();
      const op: BinaryOperator =
        opTok.kind === "STAR" ? "*" :
        opTok.kind === "SLASH" ? "/" : "%";
      const right = this.parsePower();
      left = {
        kind: "BinaryExpr",
        operator: op,
        left,
        right,
        loc: { start: left.loc.start, end: right.loc.end, file: this.file },
      };
    }

    return left;
  }

  private parsePower(): ExprNode {
    const left = this.parseUnary();

    if (this.check("STAR_STAR")) {
      this.next();
      const right = this.parsePower(); // right-associative
      return {
        kind: "BinaryExpr",
        operator: "**",
        left,
        right,
        loc: { start: left.loc.start, end: right.loc.end, file: this.file },
      };
    }

    return left;
  }

  private parseUnary(): ExprNode {
    if (this.check("MINUS")) {
      const startTok = this.next();
      const operand = this.parseUnary();
      return {
        kind: "UnaryExpr",
        operator: "-",
        operand,
        loc: { start: startTok.loc.start, end: operand.loc.end, file: this.file },
      };
    }

    return this.parsePostfix();
  }

  private parsePostfix(): ExprNode {
    let expr = this.parsePrimary();

    while (true) {
      if (this.check("DOT")) {
        const dotTok = this.next();
        const name = this.expectIdentifier();
        expr = {
          kind: "MemberExpr",
          object: expr,
          property: name,
          loc: { start: expr.loc.start, end: this.prevToken().loc.end, file: this.file },
        };
        void dotTok;
      } else if (this.check("LBRACKET")) {
        this.next();
        const index = this.parseExpression();
        const close = this.expect("RBRACKET");
        expr = {
          kind: "IndexExpr",
          object: expr,
          index,
          loc: { start: expr.loc.start, end: close.loc.end, file: this.file },
        };
      } else if (this.check("LPAREN")) {
        this.next();
        const args = this.parseArgList();
        const close = this.expect("RPAREN");
        expr = {
          kind: "CallExpr",
          callee: expr,
          args,
          loc: { start: expr.loc.start, end: close.loc.end, file: this.file },
        };
      } else {
        break;
      }
    }

    return expr;
  }

  private parseArgList(): ExprNode[] {
    const args: ExprNode[] = [];
    if (!this.check("RPAREN")) {
      do {
        if (this.check("RPAREN")) break;
        args.push(this.parseExpression());
      } while (this.match("COMMA"));
    }
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
        return this.parseListLiteral();

      case "LBRACE":
        return this.parseMapLiteral();

      default:
        this.error(
          ErrorCode.UNEXPECTED_TOKEN,
          `ekspresi tidak valid: ${tok.kind}`,
          tok,
        );
        throw new ParsePanic();
    }
  }

  private parseLiteral(): ExprNode {
    const tok = this.next();
    let literalKind: "number" | "string";

    if (tok.kind === "NUMBER") literalKind = "number";
    else literalKind = "string";

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
    return {
      kind: "Literal",
      value,
      literalKind: "boolean",
      loc: tok.loc,
    };
  }

  private parseInterpolatedString(): ExprNode {
    const startTok = this.expect("STRING_INTERP_START");
    const parts: (string | ExprNode)[] = [];

    if (startTok.value) parts.push(String(startTok.value));

    // Baca ekspresi di dalam interpolation
    let expr = this.parseExpression();
    parts.push(expr);

    while (this.check("STRING_INTERP_MIDDLE")) {
      const midTok = this.next();
      if (midTok.value) parts.push(String(midTok.value));
      expr = this.parseExpression();
      parts.push(expr);
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
    const body = this.parseExpression();

    return {
      kind: "FunctionExpr",
      typeParams,
      params,
      returnType,
      body,
      loc: { start: startTok.loc.start, end: body.loc.end, file: this.file },
    };
  }

  private parseParenExpr(): ExprNode {
    const startTok = this.expect("LPAREN");
    const inner = this.parseExpression();
    const endTok = this.expect("RPAREN");
    return {
      kind: "ParenExpr",
      inner,
      loc: this.locOf(startTok, endTok),
    };
  }

  private parseListLiteral(): ExprNode {
    const startTok = this.expect("LBRACKET");
    const elements: ExprNode[] = [];

    if (!this.check("RBRACKET")) {
      do {
        if (this.check("RBRACKET")) break;
        elements.push(this.parseExpression());
      } while (this.match("COMMA"));
    }

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

    if (!this.check("RBRACE")) {
      do {
        if (this.check("RBRACE")) break;
        entries.push(this.parseMapEntry());
      } while (this.match("COMMA"));
    }

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
    } else if (this.check("IDENTIFIER")) {
      const tok = this.next();
      key = String(tok.value);
    } else {
      this.error(
        ErrorCode.UNEXPECTED_TOKEN,
        "key map harus string atau identifier",
        this.peek(),
      );
      throw new ParsePanic();
    }

    this.expect("COLON");
    const value = this.parseExpression();

    return {
      kind: "MapEntry",
      key,
      value,
      loc: this.locOf(startTok, this.prevToken()),
    };
  }

  // ==========================================================
  // Type Expression
  // ==========================================================

  private parseTypeExpr(): TypeNode {
    return this.parseUnionType();
  }

  private parseUnionType(): TypeNode {
    const startTok = this.peek();
    const first = this.parsePrimaryType();

    if (this.check("PIPE")) {
      const members: TypeNode[] = [first];
      while (this.match("PIPE")) {
        members.push(this.parsePrimaryType());
      }
      return {
        kind: "UnionType",
        members,
        loc: this.locOf(startTok, this.prevToken()),
      };
    }

    return first;
  }

  private parsePrimaryType(): TypeNode {
    const tok = this.peek();

    // Record type: { nama: Teks, umur: Angka? }
    if (tok.kind === "LBRACE") {
      return this.parseRecordType();
    }

    // Function type: (Angka, Teks) -> Boolean
    if (tok.kind === "LPAREN") {
      return this.parseFunctionType();
    }

    // Identifier (bisa jadi nama tipe primitif atau user-defined)
    if (tok.kind === "IDENTIFIER") {
      this.next();
      const name = String(tok.value);

      // Cek apakah ini tipe primitif
      const primitives: PrimitiveTypeName[] = [
        "Angka", "Teks", "Boolean", "Null", "Kosong", "Error",
      ];

      let base: TypeNode;

      if (primitives.includes(name as PrimitiveTypeName)) {
        base = {
          kind: "PrimitiveType",
          name: name as PrimitiveTypeName,
          loc: tok.loc,
        };
      } else {
        // Named type dengan optional type args
        const typeArgs: TypeNode[] = [];
        if (this.check("LT")) {
          this.next();
          do {
            if (this.check("GT")) break;
            typeArgs.push(this.parseTypeExpr());
          } while (this.match("COMMA"));
          this.expect("GT");
        }
        base = {
          kind: "NamedType",
          name,
          typeArgs,
          loc: { start: tok.loc.start, end: this.prevToken().loc.end, file: this.file },
        };
      }

      // Cek nullable suffix `?`
      if (this.check("QUESTION")) {
        const qTok = this.next();
        return {
          kind: "NullableType",
          inner: base,
          loc: { start: tok.loc.start, end: qTok.loc.end, file: this.file },
        };
      }

      return base;
    }

    this.error(
      ErrorCode.UNEXPECTED_TOKEN,
      `tipe tidak valid: ${tok.kind}`,
      tok,
    );
    throw new ParsePanic();
  }

  private parseRecordType(): TypeNode {
    const startTok = this.expect("LBRACE");
    const fields: FieldDeclNode[] = [];

    // Record type bisa multi-line atau single-line
    const multiLine = this.check("NEWLINE");
    if (multiLine) {
      this.next(); // NEWLINE
      this.expect("INDENT");
    }

    while (!this.check("RBRACE") && !this.check("EOF")) {
      if (this.check("NEWLINE")) {
        this.next();
        continue;
      }

      const fieldStart = this.peek();
      const name = this.expectIdentifier();
      this.expect("COLON");
      const type = this.parseTypeExpr();

      fields.push({
        kind: "FieldDecl",
        name,
        type,
        loc: this.locOf(fieldStart, this.prevToken()),
      });

      // Konsumsi newline opsional
      if (multiLine && this.check("NEWLINE")) this.next();
    }

    if (multiLine && this.check("DEDENT")) this.next();

    const endTok = this.expect("RBRACE");
    return {
      kind: "RecordType",
      fields,
      loc: this.locOf(startTok, endTok),
    };
  }

  private parseFunctionType(): TypeNode {
    const startTok = this.expect("LPAREN");
    const params: TypeNode[] = [];

    if (!this.check("RPAREN")) {
      do {
        if (this.check("RPAREN")) break;
        params.push(this.parseTypeExpr());
      } while (this.match("COMMA"));
    }

    this.expect("RPAREN");
    this.expect("ARROW");
    const returns = this.parseTypeExpr();

    return {
      kind: "FunctionType",
      params,
      returns,
      loc: { start: startTok.loc.start, end: returns.loc.end, file: this.file },
    };
  }

  // ==========================================================
  // Type Parameters
  // ==========================================================

  private parseOptionalTypeParams(): string[] {
    if (!this.check("LT")) return [];
    this.next();
    const params: string[] = [];
    do {
      if (this.check("GT")) break;
      params.push(this.expectIdentifier());
    } while (this.match("COMMA"));
    this.expect("GT");
    return params;
  }

  // ==========================================================
  // Helpers — Token Stream Navigation
  // ==========================================================

  private peek(offset = 0): Token {
    return this.stream.peek(offset);
  }

  private next(): Token {
    return this.stream.next();
  }

  private prevToken(): Token {
    // TokenStream tidak expose prev; kita perlu track manual
    // Untuk sekarang, kita return peek karena kita sering panggil
    // setelah advance. Bisa diperbaiki nanti.
    return this.stream.peek();
  }

  private check(kind: TokenKind): boolean {
    return this.stream.check(kind);
  }

  private match(kind: TokenKind): boolean {
    return this.stream.match(kind);
  }

  private expect(kind: TokenKind): Token {
    if (this.check(kind)) {
      return this.next();
    }
    const tok = this.peek();
    this.error(
      ErrorCode.UNEXPECTED_TOKEN,
      `diharapkan ${kind}, ditemukan ${tok.kind}`,
      tok,
    );
    throw new ParsePanic();
  }

  private expectIdentifier(): string {
    const tok = this.expect("IDENTIFIER");
    return String(tok.value);
  }

  /**
   * Konsumsi NEWLINE, atau EOF, atau DEDENT sebagai terminator.
   * Beberapa statement tidak butuh NEWLINE eksplisit di akhir (mis. di EOF).
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
      `diharapkan akhir baris, ditemukan ${tok.kind}`,
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
  // Error Reporting & Recovery
  // ==========================================================

  private error(code: string, message: string, tok: Token): void {
    this.reporter.report({
      severity: "error",
      code,
      message,
      location: tok.loc,
    });
  }

  /**
   * Skip token sampai synchronization point berikutnya:
   * NEWLINE, DEDENT, EOF, atau keyword yang memulai statement baru.
   */
  private synchronize(): void {
    if (this.recoveryDepth > 1000) {
      throw new InternalError("parser recovery loop detected");
    }
    this.recoveryDepth++;

    try {
      while (!this.check("EOF")) {
        if (this.check("NEWLINE")) {
          this.next();
          return;
        }
        if (this.check("DEDENT")) return;

        switch (this.peek().kind) {
          case "CONST":
          case "LET":
          case "FN":
          case "TYPE":
          case "IF":
          case "WHILE":
          case "FOR":
          case "MATCH":
          case "TRY":
          case "RETURN":
          case "IMPORT":
          case "EXPORT":
            return;
          default:
            this.next();
        }
      }
    } finally {
      this.recoveryDepth--;
    }
  }

  /**
   * Synchronize di dalam block — berhenti pada DEDENT.
   */
  private synchronizeInBlock(): void {
    while (!this.check("EOF") && !this.check("DEDENT")) {
      if (this.check("NEWLINE")) {
        this.next();
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
 * Exception internal untuk sinyal ke parseProgram / parseBlock
 * bahwa kita perlu melakukan recovery. Bukan error yang dilaporkan
 * ke user — error sudah dilaporkan via reporter sebelum throw.
 */
class ParsePanic extends Error {
  constructor() {
    super("parse panic");
    this.name = "ParsePanic";
  }
}

// ============================================================
// Convenience
// ============================================================

/**
 * Parse source langsung dari string.
 */
export function parse(
  source: string,
  file: string,
  reporter: Reporter,
): ProgramNode {
  // Import lex di sini untuk hindari circular dependency
  // (lexer tidak import parser, tapi parser import lexer)
  const { Lexer } = require("./lexer.ts") as typeof import("./lexer.ts");
  const lexer = new Lexer(source, { file, reporter });
  const stream = lexer.tokenize();
  const parser = new Parser(stream, { file, reporter });
  return parser.parseProgram();
}
