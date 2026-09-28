/**
 * Snake Script — Abstract Syntax Tree
 *
 * Setiap node AST merepresentasikan satu konstruksi bahasa.
 * Node didefinisikan sebagai discriminated union dengan field `kind`
 * sebagai tag. Ini memungkinkan type narrowing yang aman di parser,
 * analyzer, dan interpreter.
 *
 * Konvensi:
 * - Semua node memiliki `kind` dan `loc` (lokasi di source code).
 * - Nama interface diberi suffix `Node` untuk kejelasan.
 * - Semua field readonly — AST tidak dimutasi setelah dibuat.
 */

// ============================================================
// Lokasi di Source Code
// ============================================================

/**
 * Posisi di dalam file source. `offset` adalah index byte dari awal
 * file (0-based). `line` dan `column` adalah 1-based untuk konsumsi
 * manusia — editor modern menampilkan baris mulai dari 1.
 */
export interface Position {
  readonly offset: number;
  readonly line: number;
  readonly column: number;
}

/**
 * Rentang lokasi. `end` bersifat eksklusif.
 */
export interface Location {
  readonly start: Position;
  readonly end: Position;
  readonly file: string;
}

// ============================================================
// Base Node
// ============================================================

export interface BaseNode {
  readonly kind: string;
  readonly loc: Location;
}

// ============================================================
// Tipe (Type Expressions)
// ============================================================

/**
 * Tipe primitif bawaan bahasa.
 */
export type PrimitiveTypeName =
  | "Angka"
  | "Teks"
  | "Boolean"
  | "Null"
  | "Kosong"
  | "Error";

export interface PrimitiveTypeNode extends BaseNode {
  readonly kind: "PrimitiveType";
  readonly name: PrimitiveTypeName;
}

/**
 * Tipe bernama, mis. `User` atau `Daftar<Angka>`.
 */
export interface NamedTypeNode extends BaseNode {
  readonly kind: "NamedType";
  readonly name: string;
  readonly typeArgs: readonly TypeNode[];
}

/**
 * Tipe nullable: `T?`.
 */
export interface NullableTypeNode extends BaseNode {
  readonly kind: "NullableType";
  readonly inner: TypeNode;
}

/**
 * Union type: `A | B | C`.
 */
export interface UnionTypeNode extends BaseNode {
  readonly kind: "UnionType";
  readonly members: readonly TypeNode[];
}

/**
 * Tipe record: `{ nama: Teks, umur: Angka? }`.
 */
export interface RecordTypeNode extends BaseNode {
  readonly kind: "RecordType";
  readonly fields: readonly FieldDeclNode[];
}

export interface FieldDeclNode extends BaseNode {
  readonly kind: "FieldDecl";
  readonly name: string;
  readonly type: TypeNode;
}

/**
 * Tipe fungsi: `(Angka, Teks) -> Boolean`.
 */
export interface FunctionTypeNode extends BaseNode {
  readonly kind: "FunctionType";
  readonly params: readonly TypeNode[];
  readonly returns: TypeNode;
}

/**
 * Union semua node tipe.
 */
export type TypeNode =
  | PrimitiveTypeNode
  | NamedTypeNode
  | NullableTypeNode
  | UnionTypeNode
  | RecordTypeNode
  | FunctionTypeNode;

// ============================================================
// Ekspresi (Expressions)
// ============================================================

export interface LiteralNode extends BaseNode {
  readonly kind: "Literal";
  readonly value: string | number | boolean | null;
  readonly literalKind: "number" | "string" | "boolean" | "null";
}

/**
 * Identifier — referensi ke variabel atau fungsi.
 */
export interface IdentifierNode extends BaseNode {
  readonly kind: "Identifier";
  readonly name: string;
}

/**
 * Binary expression: `a + b`, `x and y`, `n == 0`.
 */
export type BinaryOperator =
  | "+"  | "-"  | "*"  | "/"  | "%"  | "**"
  | "==" | "!=" | "<"  | "<=" | ">"  | ">="
  | "and" | "or";

export interface BinaryExprNode extends BaseNode {
  readonly kind: "BinaryExpr";
  readonly operator: BinaryOperator;
  readonly left: ExprNode;
  readonly right: ExprNode;
}

/**
 * Unary expression: `-x`, `not flag`.
 */
export type UnaryOperator = "-" | "not";

export interface UnaryExprNode extends BaseNode {
  readonly kind: "UnaryExpr";
  readonly operator: UnaryOperator;
  readonly operand: ExprNode;
}

/**
 * Assignment: `x = 5`, `count += 1`.
 * Note: assignment adalah ekspresi (mengembalikan nilai yang di-assign),
 * tapi di Snake Script hanya boleh muncul di statement position.
 */
export type AssignOperator = "=" | "+=" | "-=" | "*=" | "/=" | "%=";

export interface AssignExprNode extends BaseNode {
  readonly kind: "AssignExpr";
  readonly operator: AssignOperator;
  readonly target: ExprNode;
  readonly value: ExprNode;
}

/**
 * Akses anggota: `obj.field`.
 */
export interface MemberExprNode extends BaseNode {
  readonly kind: "MemberExpr";
  readonly object: ExprNode;
  readonly property: string;
}

/**
 * Akses index: `arr[0]`, `map["key"]`.
 */
export interface IndexExprNode extends BaseNode {
  readonly kind: "IndexExpr";
  readonly object: ExprNode;
  readonly index: ExprNode;
}

/**
 * Pemanggilan fungsi: `tambah(1, 2)`.
 */
export interface CallExprNode extends BaseNode {
  readonly kind: "CallExpr";
  readonly callee: ExprNode;
  readonly args: readonly ExprNode[];
}

/**
 * Literal daftar: `[1, 2, 3]`.
 */
export interface ListExprNode extends BaseNode {
  readonly kind: "ListExpr";
  readonly elements: readonly ExprNode[];
}

/**
 * Literal peta: `{ "a": 1, "b": 2 }`.
 */
export interface MapExprNode extends BaseNode {
  readonly kind: "MapExpr";
  readonly entries: readonly MapEntryNode[];
}

export interface MapEntryNode extends BaseNode {
  readonly kind: "MapEntry";
  readonly key: string;
  readonly value: ExprNode;
}

/**
 * Bagian dari interpolated string.
 * Contoh: `"Halo ${nama}, umur ${umur}!"` menghasilkan:
 *   [Teks("Halo "), Expr(nama), Teks(", umur "), Expr(umur), Teks("!")]
 */
export type InterpPartNode = string | ExprNode;

export interface InterpolatedStringNode extends BaseNode {
  readonly kind: "InterpolatedString";
  readonly parts: readonly InterpPartNode[];
}

/**
 * Fungsi sebagai ekspresi (arrow):
 *   `fn(a: Angka, b: Angka) -> Angka => a + b`
 */
export interface FunctionExprNode extends BaseNode {
  readonly kind: "FunctionExpr";
  readonly typeParams: readonly string[];
  readonly params: readonly ParamNode[];
  readonly returnType: TypeNode | null;
  readonly body: ExprNode;
}

export interface ParamNode extends BaseNode {
  readonly kind: "Param";
  readonly name: string;
  readonly type: TypeNode;
  readonly defaultValue: ExprNode | null;
}

/**
 * Parenthesized expression — berguna untuk mempertahankan informasi
 * pengelompokan di AST (meskipun secara semantik sama dengan inner).
 */
export interface ParenExprNode extends BaseNode {
  readonly kind: "ParenExpr";
  readonly inner: ExprNode;
}

/**
 * Union semua node ekspresi.
 */
export type ExprNode =
  | LiteralNode
  | IdentifierNode
  | BinaryExprNode
  | UnaryExprNode
  | AssignExprNode
  | MemberExprNode
  | IndexExprNode
  | CallExprNode
  | ListExprNode
  | MapExprNode
  | InterpolatedStringNode
  | FunctionExprNode
  | ParenExprNode;

// ============================================================
// Statement
// ============================================================

/**
 * Import:
 *   `import { PI, luas } from "matematika"`
 *   `import * as mat from "matematika"`
 *   `import matematika from "matematika"`
 */
export type ImportKind = "named" | "namespace" | "default";

export interface ImportStmtNode extends BaseNode {
  readonly kind: "ImportStmt";
  readonly importKind: ImportKind;
  readonly names: readonly string[];
  readonly alias: string | null;
  readonly source: string;
}

/**
 * Export — membungkus deklarasi yang diekspor.
 */
export interface ExportStmtNode extends BaseNode {
  readonly kind: "ExportStmt";
  readonly declaration: DeclNode;
}

/**
 * Deklarasi tipe: `type UserId = Angka`.
 */
export interface TypeDeclNode extends BaseNode {
  readonly kind: "TypeDecl";
  readonly name: string;
  readonly typeParams: readonly string[];
  readonly value: TypeNode;
}

/**
 * Deklarasi variabel: `const x = 5` atau `let y: Angka = 10`.
 */
export interface VarDeclNode extends BaseNode {
  readonly kind: "VarDecl";
  readonly mutable: boolean; // true = let, false = const
  readonly name: string;
  readonly typeAnnotation: TypeNode | null;
  readonly initializer: ExprNode | null;
}

/**
 * Deklarasi fungsi:
 *   `fn tambah(a: Angka, b: Angka) -> Angka: ...`
 */
export interface FunctionDeclNode extends BaseNode {
  readonly kind: "FunctionDecl";
  readonly name: string;
  readonly typeParams: readonly string[];
  readonly params: readonly ParamNode[];
  readonly returnType: TypeNode | null;
  readonly body: BlockNode;
}

/**
 * Block — kumpulan statement di dalam indentasi.
 * Body dari if, while, for, fn, dll.
 */
export interface BlockNode extends BaseNode {
  readonly kind: "Block";
  readonly statements: readonly StmtNode[];
}

/**
 * If / elif / else.
 * `elifs` adalah daftar kondisi-elif dalam urutan.
 */
export interface IfStmtNode extends BaseNode {
  readonly kind: "IfStmt";
  readonly condition: ExprNode;
  readonly then: BlockNode;
  readonly elifs: readonly ElifClauseNode[];
  readonly else: BlockNode | null;
}

export interface ElifClauseNode extends BaseNode {
  readonly kind: "ElifClause";
  readonly condition: ExprNode;
  readonly body: BlockNode;
}

export interface WhileStmtNode extends BaseNode {
  readonly kind: "WhileStmt";
  readonly condition: ExprNode;
  readonly body: BlockNode;
}

/**
 * For-in loop. Snake Script hanya punya satu bentuk for:
 *   `for x in iterable: ...`
 */
export interface ForStmtNode extends BaseNode {
  readonly kind: "ForStmt";
  readonly variable: string;
  readonly iterable: ExprNode;
  readonly body: BlockNode;
}

/**
 * Match statement (pattern matching).
 */
export interface MatchStmtNode extends BaseNode {
  readonly kind: "MatchStmt";
  readonly subject: ExprNode;
  readonly cases: readonly CaseClauseNode[];
  readonly else: BlockNode | null;
}

export interface CaseClauseNode extends BaseNode {
  readonly kind: "CaseClause";
  readonly pattern: PatternNode;
  readonly guard: ExprNode | null;
  readonly body: BlockNode;
}

/**
 * Pattern untuk match. Untuk sekarang sederhana — literal,
 * wildcard, atau alternatif.
 */
export interface LiteralPatternNode extends BaseNode {
  readonly kind: "LiteralPattern";
  readonly value: string | number | boolean | null;
}

export interface WildcardPatternNode extends BaseNode {
  readonly kind: "WildcardPattern";
}

export interface BindingPatternNode extends BaseNode {
  readonly kind: "BindingPattern";
  readonly name: string;
}

export interface OrPatternNode extends BaseNode {
  readonly kind: "OrPattern";
  readonly patterns: readonly PatternNode[];
}

export type PatternNode =
  | LiteralPatternNode
  | WildcardPatternNode
  | BindingPatternNode
  | OrPatternNode;

/**
 * Try / catch / finally.
 */
export interface TryStmtNode extends BaseNode {
  readonly kind: "TryStmt";
  readonly body: BlockNode;
  readonly errorName: string;
  readonly catchBody: BlockNode;
  readonly finallyBody: BlockNode | null;
}

export interface ReturnStmtNode extends BaseNode {
  readonly kind: "ReturnStmt";
  readonly value: ExprNode | null;
}

export interface BreakStmtNode extends BaseNode {
  readonly kind: "BreakStmt";
}

export interface ContinueStmtNode extends BaseNode {
  readonly kind: "ContinueStmt";
}

export interface ThrowStmtNode extends BaseNode {
  readonly kind: "ThrowStmt";
  readonly value: ExprNode;
}

/**
 * Expression statement — ekspresi yang dievaluasi untuk efek sampingnya.
 * Mis. `print("halo")` atau `x += 1`.
 */
export interface ExprStmtNode extends BaseNode {
  readonly kind: "ExprStmt";
  readonly expression: ExprNode;
}

/**
 * Union semua statement.
 */
export type StmtNode =
  | ImportStmtNode
  | ExportStmtNode
  | TypeDeclNode
  | VarDeclNode
  | FunctionDeclNode
  | IfStmtNode
  | WhileStmtNode
  | ForStmtNode
  | MatchStmtNode
  | TryStmtNode
  | ReturnStmtNode
  | BreakStmtNode
  | ContinueStmtNode
  | ThrowStmtNode
  | ExprStmtNode;

/**
 * Union semua deklarasi top-level yang bisa di-export.
 */
export type DeclNode =
  | TypeDeclNode
  | VarDeclNode
  | FunctionDeclNode;

// ============================================================
// Program Root
// ============================================================

/**
 * Root dari AST — seluruh isi file `.snake`.
 */
export interface ProgramNode extends BaseNode {
  readonly kind: "Program";
  readonly statements: readonly StmtNode[];
}

/**
 * Union semua node AST. Berguna untuk visitor generik.
 */
export type Node =
  | ProgramNode
  | TypeNode
  | ExprNode
  | StmtNode
  | DeclNode
  | BlockNode
  | ParamNode
  | FieldDeclNode
  | MapEntryNode
  | ElifClauseNode
  | CaseClauseNode
  | PatternNode;

// ============================================================
// Type Guards
// ============================================================

/**
 * Cek apakah node adalah tipe tertentu. TypeScript akan
 * mempersempit tipe secara otomatis setelah guard.
 *
 * Contoh:
 *   if (isNode(node, "Literal")) {
 *     node.value   // OK, node sudah di-narrow ke LiteralNode
 *   }
 */
export function isNode<K extends Node["kind"]>(
  node: Node,
  kind: K,
): node is Extract<Node, { kind: K }> {
  return node.kind === kind;
}

/**
 * Cek apakah node adalah ekspresi.
 */
export function isExpr(node: Node): node is ExprNode {
  return (
    node.kind === "Literal" ||
    node.kind === "Identifier" ||
    node.kind === "BinaryExpr" ||
    node.kind === "UnaryExpr" ||
    node.kind === "AssignExpr" ||
    node.kind === "MemberExpr" ||
    node.kind === "IndexExpr" ||
    node.kind === "CallExpr" ||
    node.kind === "ListExpr" ||
    node.kind === "MapExpr" ||
    node.kind === "InterpolatedString" ||
    node.kind === "FunctionExpr" ||
    node.kind === "ParenExpr"
  );
}

/**
 * Cek apakah node adalah statement.
 */
export function isStmt(node: Node): node is StmtNode {
  return (
    node.kind === "ImportStmt" ||
    node.kind === "ExportStmt" ||
    node.kind === "TypeDecl" ||
    node.kind === "VarDecl" ||
    node.kind === "FunctionDecl" ||
    node.kind === "IfStmt" ||
    node.kind === "WhileStmt" ||
    node.kind === "ForStmt" ||
    node.kind === "MatchStmt" ||
    node.kind === "TryStmt" ||
    node.kind === "ReturnStmt" ||
    node.kind === "BreakStmt" ||
    node.kind === "ContinueStmt" ||
    node.kind === "ThrowStmt" ||
    node.kind === "ExprStmt"
  );
}

// ============================================================
// Factory Helpers (dipakai parser)
// ============================================================

/**
 * Helper untuk membuat node dengan lokasi yang digabung dari
 * beberapa node. Berguna di parser untuk membentuk parent node.
 */
export function span(start: BaseNode, end: BaseNode): Location {
  return {
    start: start.loc.start,
    end: end.loc.end,
    file: start.loc.file,
  };
}

/**
 * Helper untuk membuat lokasi tunggal dari satu token.
 */
export function loc(start: Position, end: Position, file: string): Location {
  return { start, end, file };
}
