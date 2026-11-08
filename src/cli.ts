#!/usr/bin/env node

/**
 * Snake Script — CLI (Enterprise & Developer Edition)
 *
 * Antarmuka baris perintah (CLI) profesional dan adaptif untuk Snake Script:
 *
 * 1. Perintah Lengkap untuk Siklus Pengembangan:
 *    - `snake run <file>` (atau langsung `snake <file.snake>`): Eksekusi dengan dukungan
 *      `--watch` (`-w`), `--metrics`, `--format=pretty|compact|json|lsp|sarif`, dan `--no-typecheck`.
 *    - `snake eval "<kode>"` (`-e`): Jalankan ekspresi/statement satu baris langsung dari terminal.
 *    - `snake check [file/dir]`: Pemeriksaan sintaksis & struktural cepat (mendukung multi-file).
 *    - `snake test [file/dir]`: Test runner bawaan untuk file `*.test.snake` / `*_test.snake`.
 *    - `snake fmt <file>` (`--check`, `--stdout`): Formatter kode nyata untuk merapikan indentasi & spasi.
 *    - `snake ast <file>` & `snake tokens <file>`: Visualisasi pohon AST (`├──`, `└──`) dan tabel token.
 *    - `snake explain <SSxxxx>`: Penjelasan lengkap katalog kode error (seperti `rustc --explain`).
 *    - `snake repl`: Mode interaktif cerdas dengan blok multi-baris, auto-complete Tab, variabel `_`,
 *      serta meta-command `.env`, `.ast`, `.tokens`, `.muat`, `.simpan`, `.reset`.
 *    - `snake init <nama>` & `snake info`: Inisialisasi proyek modern (`snake.json` + unit test) & diagnostik sistem.
 *
 * 2. Presisi Tata Letak Terminal (Box Drawing & Unicode Width):
 *    - Perhitungan lebar kolom visual yang akurat untuk karakter ASCII, simbol Unicode, dan emoji,
 *      sehingga bingkai kotak (`╭─╮`, `│`, `╰─╯`) selalu rata di layar HP (Termux) maupun monitor lebar.
 *    - Integrasi penuh dengan `loadSource()` di `diagnostics.ts` sehingga setiap error menampilkan
 *      cuplikan baris kode asli beserta penunjuk caret (`^`).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as readline from "node:readline";

import type {
  ProgramNode,
  StmtNode,
  ExprNode,
  TypeNode,
} from "./ast.ts";
import { Lexer, type Token } from "./lexer.ts";
import { Parser, walkAST } from "./parser.ts";
import { Interpreter, RuntimeError, type Value } from "./interpreter.ts";
import {
  Reporter,
  loadSource,
  clearSourceCache,
  explainErrorCode,
  type OutputFormat,
} from "./diagnostics.ts";

// ============================================================
// Metadata
// ============================================================

const VERSION = "0.2.0";
const BIN_NAME = "snake";
const TAGLINE = "Kemudahan Python. Keamanan TypeScript.";
const HOMEPAGE = "https://github.com/Ashiro-Enterprises-Organization/snake-script";

// ============================================================
// Exit Codes (Standar sysexits.h & Unix)
// ============================================================

const EXIT_OK = 0;
const EXIT_COMPILE_ERROR = 1;
const EXIT_RUNTIME_ERROR = 2;
const EXIT_FILE_NOT_FOUND = 3;
const EXIT_FORMAT_DIFF = 4;
const EXIT_USAGE = 64;

// ============================================================
// Terminal Width & ANSI Stripping / Visual Width
// ============================================================

function termWidth(): number {
  const w = process.stdout?.columns || 80;
  return Math.max(44, Math.min(78, w - 4));
}

const useColor =
  Boolean(process.stdout?.isTTY) &&
  !process.env.NO_COLOR &&
  !process.argv.includes("--no-color");

const C = {
  reset:         useColor ? "\x1b[0m"  : "",
  bold:          useColor ? "\x1b[1m"  : "",
  dim:           useColor ? "\x1b[2m"  : "",
  italic:        useColor ? "\x1b[3m"  : "",
  underline:     useColor ? "\x1b[4m"  : "",

  black:         useColor ? "\x1b[30m" : "",
  red:           useColor ? "\x1b[31m" : "",
  green:         useColor ? "\x1b[32m" : "",
  yellow:        useColor ? "\x1b[33m" : "",
  blue:          useColor ? "\x1b[34m" : "",
  magenta:       useColor ? "\x1b[35m" : "",
  cyan:          useColor ? "\x1b[36m" : "",
  white:         useColor ? "\x1b[37m" : "",
  gray:          useColor ? "\x1b[90m" : "",

  brightRed:     useColor ? "\x1b[91m" : "",
  brightGreen:   useColor ? "\x1b[92m" : "",
  brightYellow:  useColor ? "\x1b[93m" : "",
  brightBlue:    useColor ? "\x1b[94m" : "",
  brightMagenta: useColor ? "\x1b[95m" : "",
  brightCyan:    useColor ? "\x1b[96m" : "",

  bgBlue:        useColor ? "\x1b[44m" : "",
  bgCyan:        useColor ? "\x1b[46m" : "",
} as const;

const B = {
  tl: "╭", tr: "╮", bl: "╰", br: "╯",
  h: "─",  v: "│",
  lt: "├", rt: "┤", tt: "┬", bt: "┴", cross: "┼",
  treeBranch: "├── ",
  treeLast:   "└── ",
  treePipe:   "│   ",
  treeSpace:  "    ",
} as const;

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * Menghitung lebar kolom visual di terminal (memperhitungkan emoji / surrogate pair = 2 kolom).
 */
function visualWidth(text: string): number {
  const clean = stripAnsi(text);
  let width = 0;
  for (const ch of clean) {
    const cp = ch.codePointAt(0) ?? 0;
    if (
      cp >= 0x1f000 || // Emoji & Pictographs
      (cp >= 0x1100 &&
        (cp <= 0x115f ||
          cp === 0x2329 ||
          cp === 0x232a ||
          (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
          (cp >= 0xac00 && cp <= 0xd7a3) ||
          (cp >= 0xf900 && cp <= 0xfaff) ||
          (cp >= 0xfe10 && cp <= 0xfe19) ||
          (cp >= 0xfe30 && cp <= 0xfe6f) ||
          (cp >= 0xff00 && cp <= 0xff60) ||
          (cp >= 0xffe0 && cp <= 0xffe6)))
    ) {
      width += 2;
    } else {
      width += 1;
    }
  }
  return width;
}

function hline(width: number): string {
  return B.h.repeat(Math.max(0, width));
}

function padRight(text: string, width: number): string {
  const v = visualWidth(text);
  if (v >= width) return text;
  return text + " ".repeat(width - v);
}

function padLeft(text: string, width: number): string {
  const v = visualWidth(text);
  if (v >= width) return text;
  return " ".repeat(width - v) + text;
}

function truncateMiddle(text: string, maxLen: number): string {
  if (text.length <= maxLen || maxLen < 8) return text;
  const half = Math.floor((maxLen - 3) / 2);
  return text.slice(0, half) + "..." + text.slice(text.length - (maxLen - 3 - half));
}

// ============================================================
// Main Entry & Command Router
// ============================================================

function main(): void {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    printHelp();
    process.exit(EXIT_OK);
  }

  const first = args[0]!;

  if (first === "-v" || first === "--version" || first === "version") {
    printVersion();
    process.exit(EXIT_OK);
  }

  if (first === "-h" || first === "--help" || first === "help") {
    const sub = args[1];
    if (sub === "run") {
      printRunHelp();
    } else {
      printHelp();
    }
    process.exit(EXIT_OK);
  }

  // Eksekusi ekspresi satu baris: `snake -e "tulis(1 + 2)"`
  if (first === "-e" || first === "--eval" || first === "eval") {
    cmdEval(args.slice(1));
    return;
  }

  // Shortcut langsung: `snake program.snake` -> otomatis jalankan `cmdRun`
  if (
    !first.startsWith("-") &&
    (first.endsWith(".snake") || first.endsWith(".ss") || fs.existsSync(first)) &&
    ![
      "run",
      "check",
      "test",
      "repl",
      "fmt",
      "format",
      "ast",
      "tokens",
      "explain",
      "init",
      "info",
    ].includes(first)
  ) {
    cmdRun(args);
    return;
  }

  const rest = args.slice(1);

  switch (first) {
    case "run":
      cmdRun(rest);
      break;
    case "check":
      cmdCheck(rest);
      break;
    case "test":
      cmdTest(rest);
      break;
    case "repl":
      cmdRepl(rest);
      break;
    case "fmt":
    case "format":
      cmdFmt(rest);
      break;
    case "ast":
      cmdAst(rest);
      break;
    case "tokens":
    case "lex":
      cmdTokens(rest);
      break;
    case "explain":
      cmdExplain(rest);
      break;
    case "init":
      cmdInit(rest);
      break;
    case "info":
      cmdInfo();
      break;
    default:
      printUnknownCommand(first);
      process.exit(EXIT_USAGE);
  }
}

// ============================================================
// Banner, Boxes, & Visual Components
// ============================================================

function printVersion(): void {
  console.log(`${C.bold}${BIN_NAME}${C.reset} ${C.brightCyan}v${VERSION}${C.reset}`);
}

function printBanner(): void {
  const w = termWidth();
  printBox(
    [
      `${C.brightGreen}🐍${C.reset}  ${C.bold}${C.brightCyan}Snake Script${C.reset} ${C.dim}v${VERSION}${C.reset}`,
      `${C.dim}${TAGLINE}${C.reset}`,
    ],
    { width: w, borderColor: C.cyan },
  );
  console.log("");
}

interface BoxOptions {
  readonly title?: string;
  readonly titleColor?: string;
  readonly borderColor?: string;
  readonly width?: number;
}

function printBox(content: readonly string[], opts: BoxOptions = {}): void {
  const w = opts.width ?? termWidth();
  const borderColor = opts.borderColor ?? C.cyan;
  const inner = w - 2;

  if (opts.title) {
    const titleColor = opts.titleColor ?? C.bold;
    const titleSegment = ` ${opts.title} `;
    const titleVis = visualWidth(titleSegment);
    const rightLen = Math.max(0, inner - titleVis - 1);
    console.log(
      `${borderColor}${B.tl}${B.h}${C.reset}${titleColor}${titleSegment}${C.reset}${borderColor}${hline(rightLen)}${B.tr}${C.reset}`,
    );
  } else {
    console.log(`${borderColor}${B.tl}${hline(inner)}${B.tr}${C.reset}`);
  }

  for (const line of content) {
    const vis = visualWidth(line);
    const padCount = Math.max(0, inner - vis - 2);
    console.log(
      `${borderColor}${B.v}${C.reset} ${line}${" ".repeat(padCount)} ${borderColor}${B.v}${C.reset}`,
    );
  }

  console.log(`${borderColor}${B.bl}${hline(inner)}${B.br}${C.reset}`);
}

function printErrorBox(
  title: string,
  message: string,
  hints: readonly string[] = [],
): void {
  const lines = [
    `${C.bold}${C.white}${message}${C.reset}`,
    ...hints.map((h) => `${C.dim}${h}${C.reset}`),
  ];
  printBox(lines, {
    title: `✖ ${title}`,
    titleColor: `${C.bold}${C.red}`,
    borderColor: C.red,
  });
}

function printSuccessBox(
  title: string,
  message: string,
  details: readonly string[] = [],
): void {
  const lines = [message, ...details.map((d) => `${C.dim}${d}${C.reset}`)];
  printBox(lines, {
    title: `✓ ${title}`,
    titleColor: `${C.bold}${C.brightGreen}`,
    borderColor: C.green,
  });
}

// ============================================================
// Help
// ============================================================

function printHelp(): void {
  printBanner();

  printSectionHeader("PENGGUNAAN");
  console.log(
    `  ${C.bold}${BIN_NAME}${C.reset} ${C.cyan}<perintah>${C.reset} ${C.dim}[argumen] [opsi]${C.reset}`,
  );
  console.log(
    `  ${C.bold}${BIN_NAME}${C.reset} ${C.dim}<file.snake>${C.reset}             ${C.gray}# Jalankan file secara langsung${C.reset}`,
  );
  console.log("");

  printSectionHeader("PERINTAH UTAMA");
  printCommandRow("run", "<file>", "Jalankan program Snake Script (mendukung --watch)");
  printCommandRow("eval", '"<kode>"', "Evaluasi kode satu baris langsung dari terminal");
  printCommandRow("check", "<file|dir>", "Periksa sintaks & aturan semantik tanpa eksekusi");
  printCommandRow("test", "[file|dir]", "Jalankan seluruh file pengujian (*.test.snake)");
  printCommandRow("repl", "", "Masuk ke lingkungan interaktif (REPL)");
  printCommandRow("fmt", "<file>", "Rapikan indentasi dan format kode sumber");
  console.log("");

  printSectionHeader("INSPEKSI & ALAT PENGEMBANG");
  printCommandRow("ast", "<file>", "Tampilkan struktur pohon AST beserta statistik node");
  printCommandRow("tokens", "<file>", "Tampilkan tabel aliran token hasil Lexer");
  printCommandRow("explain", "<kode>", "Tampilkan penjelasan lengkap kode error (misal SS1001)");
  printCommandRow("init", "<nama>", "Buat struktur proyek Snake Script baru");
  printCommandRow("info", "", "Tampilkan diagnostik versi & lingkungan sistem");
  console.log("");

  printSectionHeader("OPSI GLOBAL");
  printOptionRow("-h, --help", "Tampilkan panduan bantuan ini");
  printOptionRow("-v, --version", "Tampilkan nomor versi Snake Script");
  printOptionRow("-e, --eval", "Jalankan snippet kode langsung");
  printOptionRow("--no-color", "Nonaktifkan output berwarna ANSI");
  printOptionRow("-q, --quiet", "Sembunyikan banner dan hanya cetak output program");
  console.log("");

  console.log(
    `  ${C.dim}Ketik ${C.reset}${C.cyan}${BIN_NAME} explain SS1001${C.reset}${C.dim} atau ${C.reset}${C.cyan}${BIN_NAME} run --help${C.reset}${C.dim} untuk rincian lebih lanjut.${C.reset}`,
  );
  console.log("");
}

function printSectionHeader(title: string): void {
  console.log(`  ${C.bold}${C.brightBlue}${title}${C.reset}`);
}

function printCommandRow(cmd: string, arg: string, desc: string): void {
  const left = `${C.brightCyan}${cmd}${C.reset}${arg ? ` ${C.dim}${arg}${C.reset}` : ""}`;
  console.log(`  ${padRight(left, 20)} ${C.gray}${desc}${C.reset}`);
}

function printOptionRow(opt: string, desc: string): void {
  console.log(`  ${C.brightYellow}${opt.padEnd(20)}${C.reset} ${C.gray}${desc}${C.reset}`);
}

function printUnknownCommand(command: string): void {
  const allCommands = [
    "run",
    "eval",
    "check",
    "test",
    "repl",
    "fmt",
    "format",
    "ast",
    "tokens",
    "explain",
    "init",
    "info",
    "help",
  ];
  const suggestion = allCommands.find(
    (c) => c.startsWith(command.slice(0, 2)) || command.startsWith(c.slice(0, 2)),
  );
  const hints = [
    suggestion
      ? `Apakah maksud Anda \`${BIN_NAME} ${suggestion}\`?`
      : `Jalankan \`${BIN_NAME} --help\` untuk melihat daftar perintah.`,
  ];

  console.log("");
  printErrorBox("Perintah Tidak Dikenal", `\`${command}\` bukan perintah yang valid.`, hints);
  console.log("");
}

// ============================================================
// Command: run (dengan dukungan --watch, --metrics, & multi-format)
// ============================================================

interface RunFlags {
  quiet: boolean;
  format: OutputFormat;
  time: boolean;
  watch: boolean;
  metrics: boolean;
  checkTypes: boolean;
}

function parseRunFlags(args: readonly string[]): { file: string | null; flags: RunFlags } {
  const flags: RunFlags = {
    quiet: false,
    format: "pretty",
    time: true,
    watch: false,
    metrics: false,
    checkTypes: true,
  };
  let file: string | null = null;

  for (const arg of args) {
    if (arg === "-q" || arg === "--quiet") flags.quiet = true;
    else if (arg === "--json") flags.format = "json";
    else if (arg === "--lsp") flags.format = "lsp";
    else if (arg === "--sarif") flags.format = "sarif";
    else if (arg === "--compact") flags.format = "compact";
    else if (arg.startsWith("--format=")) {
      const val = arg.slice("--format=".length) as OutputFormat;
      if (["pretty", "plain", "compact", "json", "lsp", "sarif"].includes(val)) {
        flags.format = val;
      }
    } else if (arg === "--time") flags.time = true;
    else if (arg === "--no-time") flags.time = false;
    else if (arg === "-w" || arg === "--watch") flags.watch = true;
    else if (arg === "--metrics" || arg === "--stats") flags.metrics = true;
    else if (arg === "--no-typecheck") flags.checkTypes = false;
    else if (arg === "--no-color") {
      /* ditangani secara global */
    } else if (!arg.startsWith("-") && file === null) {
      file = arg;
    }
  }

  return { file, flags };
}

function cmdRun(args: readonly string[]): void {
  if (args.includes("--help") || args.includes("-h")) {
    printRunHelp();
    process.exit(EXIT_OK);
  }

  const { file, flags } = parseRunFlags(args);

  if (!file) {
    console.log("");
    printErrorBox("Argumen Kurang", "Perintah `run` membutuhkan path ke file `.snake`.", [
      `Penggunaan: ${BIN_NAME} run <file.snake> [opsi]`,
    ]);
    console.log("");
    process.exit(EXIT_USAGE);
  }

  const resolved = path.resolve(file);
  if (!fs.existsSync(resolved)) {
    console.log("");
    printErrorBox("File Tidak Ditemukan", `Tidak dapat menemukan \`${file}\`.`, [
      `Path absolut: ${resolved}`,
    ]);
    console.log("");
    process.exit(EXIT_FILE_NOT_FOUND);
  }

  if (flags.watch) {
    runWatchLoop(resolved, flags);
    return;
  }

  const code = executeFileOnce(resolved, flags);
  process.exit(code);
}

function executeFileOnce(resolved: string, flags: RunFlags): number {
  const start = performance.now();
  const source = fs.readFileSync(resolved, "utf-8");

  // Penting: daftarkan source ke cache diagnostics agar baris kode & caret `^` muncul!
  clearSourceCache();
  loadSource(resolved, source);

  const isStructuredOutput =
    flags.format === "json" || flags.format === "lsp" || flags.format === "sarif";

  const reporter = new Reporter({
    color: useColor && !isStructuredOutput,
    format: flags.format,
  });

  if (!flags.quiet && !isStructuredOutput) {
    printRunHeader(resolved);
  }

  const lexer = new Lexer(source, { file: resolved, reporter });
  const stream = lexer.tokenize();
  const lexMetrics = lexer.getMetrics();

  const parser = new Parser(stream, { file: resolved, reporter });
  const program = parser.parseProgram();
  const parseMetrics = parser.getMetrics();

  if (reporter.hasErrors()) {
    reporter.flush();
    return EXIT_COMPILE_ERROR;
  }

  const parseElapsedMs = performance.now() - start;

  const interpreter = new Interpreter({
    file: resolved,
    reporter,
    checkTypes: flags.checkTypes,
    onPrint: (line) => process.stdout.write(line + "\n"),
    moduleLoader: (modSource, importer) => loadLocalModule(modSource, importer, reporter),
  });

  interpreter.run(program);
  const execMetrics = interpreter.getMetrics();

  if (reporter.hasErrors()) {
    reporter.flush();
    return EXIT_RUNTIME_ERROR;
  }

  const totalElapsedMs = performance.now() - start;

  if (!flags.quiet && !isStructuredOutput) {
    if (flags.metrics && lexMetrics && parseMetrics && execMetrics) {
      printMetricsBox(lexMetrics.tokenCount, parseMetrics, execMetrics, totalElapsedMs);
    } else if (flags.time) {
      printRunFooter(totalElapsedMs, parseElapsedMs);
    }
  }

  return EXIT_OK;
}

/**
 * Memuat modul lokal relatif (`./util.snake` atau `util.snake`) saat di-import.
 */
function loadLocalModule(
  modSource: string,
  importerFile: string,
  reporter: Reporter,
) {
  const baseDir = path.dirname(importerFile);
  const candidates = [
    path.resolve(baseDir, modSource),
    path.resolve(baseDir, `${modSource}.snake`),
    path.resolve(baseDir, `${modSource}.ss`),
  ];

  const found = candidates.find((p) => fs.existsSync(p) && fs.statSync(p).isFile());
  if (!found) return null;

  const content = fs.readFileSync(found, "utf-8");
  loadSource(found, content);

  const lexer = new Lexer(content, { file: found, reporter });
  const stream = lexer.tokenize();
  const parser = new Parser(stream, { file: found, reporter });
  const program = parser.parseProgram();
  if (reporter.hasErrors()) return null;

  const subInterpreter = new Interpreter({
    file: found,
    reporter,
    onPrint: (line) => process.stdout.write(line + "\n"),
    moduleLoader: (s, imp) => loadLocalModule(s, imp, reporter),
  });
  subInterpreter.run(program);
  return subInterpreter.global;
}

function runWatchLoop(resolved: string, flags: RunFlags): void {
  const runCycle = () => {
    console.clear();
    const now = new Date().toLocaleTimeString("id-ID");
    console.log(
      `  ${C.brightCyan}↻${C.reset} ${C.bold}Mode Pantau Aktif${C.reset} ${C.dim}[${now}] — Menunggu perubahan pada ${path.basename(resolved)}...${C.reset}`,
    );
    executeFileOnce(resolved, { ...flags, quiet: false });
  };

  runCycle();

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  fs.watch(resolved, () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(runCycle, 120);
  });
}

function printRunHeader(file: string): void {
  const w = termWidth();
  const basename = path.basename(file);
  const rawDir = path.dirname(file).replace(os.homedir(), "~");
  const dir = truncateMiddle(rawDir, w - 8);

  console.log("");
  printBox(
    [
      `${C.bold}${C.brightCyan}▶${C.reset} ${C.bold}${basename}${C.reset}`,
      `  ${C.dim}${dir}${C.reset}`,
    ],
    { width: w, borderColor: C.cyan },
  );
  console.log("");
}

function printRunFooter(totalMs: number, parseMs: number): void {
  console.log("");
  console.log(
    `  ${C.brightGreen}✓${C.reset} ${C.dim}Selesai dalam ${C.bold}${totalMs.toFixed(1)}ms${C.reset}${C.dim} (kompilasi ${parseMs.toFixed(1)}ms)${C.reset}`,
  );
  console.log("");
}

function printMetricsBox(
  tokenCount: number,
  parseMetrics: { statementCount: number; durationMs: number; maxDepthReached: number },
  execMetrics: {
    statementsExecuted: number;
    expressionsEvaluated: number;
    functionCalls: number;
    maxCallDepthReached: number;
    durationMs: number;
  },
  totalMs: number,
): void {
  console.log("");
  printBox(
    [
      `${C.bold}${C.blue}Token Lexer      :${C.reset} ${tokenCount} token`,
      `${C.bold}${C.blue}Statement AST    :${C.reset} ${parseMetrics.statementCount} stmt (kedalaman maks ${parseMetrics.maxDepthReached})`,
      `${C.bold}${C.blue}Dieksekusi       :${C.reset} ${execMetrics.statementsExecuted} stmt, ${execMetrics.expressionsEvaluated} expr`,
      `${C.bold}${C.blue}Panggilan Fungsi :${C.reset} ${execMetrics.functionCalls} kali (rekursi maks ${execMetrics.maxCallDepthReached})`,
      `${C.bold}${C.blue}Waktu Eksekusi   :${C.reset} ${totalMs.toFixed(2)}ms (parse ${parseMetrics.durationMs.toFixed(2)}ms, runtime ${execMetrics.durationMs.toFixed(2)}ms)`,
    ],
    {
      title: "Metrik Eksekusi",
      titleColor: `${C.bold}${C.brightCyan}`,
      borderColor: C.cyan,
    },
  );
  console.log("");
}

function printRunHelp(): void {
  printBanner();
  printSectionHeader("PENGGUNAAN");
  console.log(`  ${C.bold}${BIN_NAME} run${C.reset} ${C.dim}<file.snake> [opsi]${C.reset}`);
  console.log("");
  printSectionHeader("OPSI");
  printOptionRow("-w, --watch", "Pantau perubahan file dan jalankan ulang otomatis");
  printOptionRow("--metrics, --stats", "Tampilkan tabel metrik Lexer, Parser, dan Interpreter");
  printOptionRow("--format=<fmt>", "Format diagnostik: pretty, compact, json, lsp, sarif");
  printOptionRow("--no-typecheck", "Lewati pemeriksaan anotasi tipe saat runtime");
  printOptionRow("-q, --quiet", "Hanya tampilkan output standar dari program");
  printOptionRow("--no-time", "Sembunyikan ringkasan waktu eksekusi");
  printOptionRow("--no-color", "Nonaktifkan warna ANSI");
  console.log("");
}

// ============================================================
// Command: eval (`snake -e "..."`)
// ============================================================

function cmdEval(args: readonly string[]): void {
  const code = args.join(" ").trim();
  if (!code) {
    console.log("");
    printErrorBox("Kode Kosong", "Perintah `eval` membutuhkan string kode Snake Script.", [
      `Contoh: ${BIN_NAME} eval 'tulis([x * 2 for x in 1..6])'`,
    ]);
    console.log("");
    process.exit(EXIT_USAGE);
  }

  const vFile = "<eval>";
  loadSource(vFile, code);
  const reporter = new Reporter({ color: useColor, format: "pretty" });

  const lexer = new Lexer(code, { file: vFile, reporter });
  const stream = lexer.tokenize();
  const parser = new Parser(stream, { file: vFile, reporter });
  const program = parser.parseProgram();

  if (reporter.hasErrors()) {
    reporter.flush();
    process.exit(EXIT_COMPILE_ERROR);
  }

  let printed = false;
  const interpreter = new Interpreter({
    file: vFile,
    reporter,
    onPrint: (line) => {
      printed = true;
      process.stdout.write(line + "\n");
    },
  });

  const result = interpreter.run(program);
  if (reporter.hasErrors()) {
    reporter.flush();
    process.exit(EXIT_RUNTIME_ERROR);
  }

  if (!printed && result !== undefined) {
    console.log(formatReplValue(result));
  }
  process.exit(EXIT_OK);
}

// ============================================================
// Command: check (Mendukung File Tunggal maupun Direktori)
// ============================================================

function cmdCheck(args: readonly string[]): void {
  const targetArg = args.find((a) => !a.startsWith("-")) ?? ".";
  const resolved = path.resolve(targetArg);

  if (!fs.existsSync(resolved)) {
    console.log("");
    printErrorBox("Target Tidak Ditemukan", targetArg, [`Path: ${resolved}`]);
    console.log("");
    process.exit(EXIT_FILE_NOT_FOUND);
  }

  const files = collectSnakeFiles(resolved);
  if (files.length === 0) {
    console.log("");
    printErrorBox("Tidak Ada File", `Tidak ditemukan file .snake di \`${targetArg}\`.`);
    console.log("");
    process.exit(EXIT_FILE_NOT_FOUND);
  }

  const start = performance.now();
  const masterReporter = new Reporter({ color: useColor, format: "pretty" });
  let totalStatements = 0;

  for (const file of files) {
    const source = fs.readFileSync(file, "utf-8");
    loadSource(file, source);
    const lexer = new Lexer(source, { file, reporter: masterReporter });
    const stream = lexer.tokenize();
    const parser = new Parser(stream, { file, reporter: masterReporter });
    const prog = parser.parseProgram();
    totalStatements += prog.statements.length;
  }

  const elapsed = (performance.now() - start).toFixed(1);

  if (masterReporter.hasErrors()) {
    masterReporter.flush();
    process.exit(EXIT_COMPILE_ERROR);
  }

  console.log("");
  printSuccessBox(
    "Pemeriksaan Sintaks & Struktur Berhasil",
    `${C.bold}${files.length} file${C.reset} (${totalStatements} statement) diperiksa dalam ${C.bold}${elapsed}ms${C.reset} — ${C.green}0 masalah ditemukan${C.reset}`,
  );
  console.log("");
  process.exit(EXIT_OK);
}

function collectSnakeFiles(targetPath: string, onlyTests = false): string[] {
  const stat = fs.statSync(targetPath);
  if (stat.isFile()) return [targetPath];

  const results: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "dist") {
        continue;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith(".snake") || entry.name.endsWith(".ss")) {
        if (onlyTests) {
          if (
            entry.name.endsWith(".test.snake") ||
            entry.name.endsWith("_test.snake") ||
            entry.name.endsWith(".test.ss")
          ) {
            results.push(full);
          }
        } else {
          results.push(full);
        }
      }
    }
  };
  walk(targetPath);
  return results.sort();
}

// ============================================================
// Command: test (`snake test`)
// ============================================================

function cmdTest(args: readonly string[]): void {
  const targetArg = args.find((a) => !a.startsWith("-")) ?? ".";
  const resolved = path.resolve(targetArg);

  if (!fs.existsSync(resolved)) {
    console.log("");
    printErrorBox("Path Tidak Ditemukan", targetArg, [`Path: ${resolved}`]);
    console.log("");
    process.exit(EXIT_FILE_NOT_FOUND);
  }

  const isSingleFile = fs.statSync(resolved).isFile();
  const testFiles = collectSnakeFiles(resolved, !isSingleFile);

  if (testFiles.length === 0) {
    console.log("");
    printErrorBox(
      "Tidak Ada File Test",
      `Tidak ditemukan file \`*.test.snake\` atau \`*_test.snake\` di \`${targetArg}\`.`,
    );
    console.log("");
    process.exit(EXIT_OK);
  }

  console.log("");
  printSectionHeader(`MENJALANKAN ${testFiles.length} FILE PENGUJIAN`);
  console.log("");

  let passed = 0;
  let failed = 0;
  const startAll = performance.now();

  for (const file of testFiles) {
    const rel = path.relative(process.cwd(), file);
    const startFile = performance.now();
    const source = fs.readFileSync(file, "utf-8");
    loadSource(file, source);

    const reporter = new Reporter({ color: useColor, format: "pretty" });
    const lexer = new Lexer(source, { file, reporter });
    const stream = lexer.tokenize();
    const parser = new Parser(stream, { file, reporter });
    const program = parser.parseProgram();

    if (!reporter.hasErrors()) {
      const interpreter = new Interpreter({
        file,
        reporter,
        onPrint: () => {},
        moduleLoader: (s, imp) => loadLocalModule(s, imp, reporter),
      });
      interpreter.run(program);
    }

    const dur = (performance.now() - startFile).toFixed(1);
    if (reporter.hasErrors()) {
      failed++;
      console.log(`  ${C.red}✖ GAGAL${C.reset} ${rel} ${C.dim}(${dur}ms)${C.reset}`);
      reporter.flush();
    } else {
      passed++;
      console.log(`  ${C.brightGreen}✓ LULUS${C.reset} ${rel} ${C.dim}(${dur}ms)${C.reset}`);
    }
  }

  const totalDur = (performance.now() - startAll).toFixed(1);
  console.log("");

  if (failed > 0) {
    printErrorBox(
      "Ringkasan Pengujian",
      `${failed} gagal, ${passed} lulus dari ${testFiles.length} file (${totalDur}ms)`,
    );
    console.log("");
    process.exit(EXIT_RUNTIME_ERROR);
  } else {
    printSuccessBox(
      "Semua Pengujian Lulus",
      `${passed} file pengujian lulus dalam ${totalDur}ms`,
    );
    console.log("");
    process.exit(EXIT_OK);
  }
}

// ============================================================
// Command: ast & tokens (Inspeksi Kompiler)
// ============================================================

function cmdAst(args: readonly string[]): void {
  const file = args.find((a) => !a.startsWith("-"));
  if (!file) {
    console.log("");
    printErrorBox("Argumen Kurang", `Penggunaan: ${BIN_NAME} ast <file.snake>`);
    console.log("");
    process.exit(EXIT_USAGE);
  }

  const resolved = path.resolve(file);
  if (!fs.existsSync(resolved)) {
    console.log("");
    printErrorBox("File Tidak Ditemukan", file);
    console.log("");
    process.exit(EXIT_FILE_NOT_FOUND);
  }

  const source = fs.readFileSync(resolved, "utf-8");
  loadSource(resolved, source);
  const reporter = new Reporter({ color: useColor, format: "pretty" });

  const lexer = new Lexer(source, { file: resolved, reporter });
  const stream = lexer.tokenize();
  const parser = new Parser(stream, { file: resolved, reporter });
  const program = parser.parseProgram();

  if (reporter.hasErrors()) {
    reporter.flush();
    process.exit(EXIT_COMPILE_ERROR);
  }

  if (args.includes("--json")) {
    console.log(JSON.stringify(program, null, 2));
    process.exit(EXIT_OK);
  }

  let stmtCount = 0;
  let exprCount = 0;
  let typeCount = 0;
  walkAST(program, {
    onStatement: () => stmtCount++,
    onExpression: () => exprCount++,
    onType: () => typeCount++,
  });

  console.log("");
  printBox(
    [
      `${C.bold}File       :${C.reset} ${path.basename(resolved)}`,
      `${C.bold}Statistik  :${C.reset} ${stmtCount} Statement, ${exprCount} Expression, ${typeCount} TypeNode`,
    ],
    { title: "Pohon AST (Abstract Syntax Tree)", borderColor: C.cyan },
  );
  console.log("");

  console.log(`  ${C.bold}${C.brightCyan}Program${C.reset}`);
  program.statements.forEach((stmt, idx) => {
    const isLast = idx === program.statements.length - 1;
    renderStmtTree(stmt, "  ", isLast);
  });
  console.log("");
}

function renderStmtTree(stmt: StmtNode, prefix: string, isLast: boolean): void {
  const branch = isLast ? B.treeLast : B.treeBranch;
  const nextPrefix = prefix + (isLast ? B.treeSpace : B.treePipe);
  const locTag = `${C.dim}[baris ${stmt.loc.start.line}]${C.reset}`;

  switch (stmt.kind) {
    case "VarDecl":
      console.log(
        `${prefix}${C.cyan}${branch}${C.reset}${C.bold}VarDecl${C.reset} (${stmt.mutable ? "let" : "const"} ${C.brightYellow}${stmt.name}${C.reset}) ${locTag}`,
      );
      break;
    case "FunctionDecl":
      console.log(
        `${prefix}${C.cyan}${branch}${C.reset}${C.bold}FunctionDecl${C.reset} (${C.brightGreen}fn ${stmt.name}${C.reset}(${stmt.params.map((p) => p.name).join(", ")})) ${locTag}`,
      );
      stmt.body.statements.forEach((child, i) =>
        renderStmtTree(child, nextPrefix, i === stmt.body.statements.length - 1),
      );
      break;
    case "IfStmt":
      console.log(`${prefix}${C.cyan}${branch}${C.reset}${C.bold}IfStmt${C.reset} ${locTag}`);
      stmt.then.statements.forEach((child, i) =>
        renderStmtTree(child, nextPrefix, i === stmt.then.statements.length - 1 && !stmt.else),
      );
      if (stmt.else) {
        stmt.else.statements.forEach((child, i) =>
          renderStmtTree(child, nextPrefix, i === stmt.else!.statements.length - 1),
        );
      }
      break;
    case "ForStmt":
      console.log(
        `${prefix}${C.cyan}${branch}${C.reset}${C.bold}ForStmt${C.reset} (${C.brightYellow}${stmt.variable}${C.reset}) ${locTag}`,
      );
      stmt.body.statements.forEach((child, i) =>
        renderStmtTree(child, nextPrefix, i === stmt.body.statements.length - 1),
      );
      break;
    case "WhileStmt":
      console.log(`${prefix}${C.cyan}${branch}${C.reset}${C.bold}WhileStmt${C.reset} ${locTag}`);
      stmt.body.statements.forEach((child, i) =>
        renderStmtTree(child, nextPrefix, i === stmt.body.statements.length - 1),
      );
      break;
    default:
      console.log(`${prefix}${C.cyan}${branch}${C.reset}${C.bold}${stmt.kind}${C.reset} ${locTag}`);
  }
}

function cmdTokens(args: readonly string[]): void {
  const file = args.find((a) => !a.startsWith("-"));
  if (!file) {
    console.log("");
    printErrorBox("Argumen Kurang", `Penggunaan: ${BIN_NAME} tokens <file.snake>`);
    console.log("");
    process.exit(EXIT_USAGE);
  }

  const resolved = path.resolve(file);
  if (!fs.existsSync(resolved)) {
    console.log("");
    printErrorBox("File Tidak Ditemukan", file);
    console.log("");
    process.exit(EXIT_FILE_NOT_FOUND);
  }

  const source = fs.readFileSync(resolved, "utf-8");
  loadSource(resolved, source);
  const reporter = new Reporter({ color: useColor, format: "pretty" });
  const lexer = new Lexer(source, {
    file: resolved,
    reporter,
    preserveTrivia: args.includes("--trivia"),
  });
  const stream = lexer.tokenize();

  console.log("");
  printSectionHeader(`ALIRAN TOKEN: ${path.basename(resolved)} (${stream.all.length} token)`);
  console.log("");

  for (const tok of stream.all) {
    const pos = `${tok.loc.start.line}:${tok.loc.start.column}`.padEnd(8);
    const kind = tok.kind.padEnd(20);
    const val = tok.value !== null ? `${C.brightYellow}${JSON.stringify(tok.value)}${C.reset}` : `${C.dim}${JSON.stringify(tok.raw)}${C.reset}`;
    console.log(`  ${C.dim}${pos}${C.reset} ${C.brightCyan}${kind}${C.reset} ${val}`);
  }
  console.log("");

  if (reporter.hasErrors()) {
    reporter.flush();
    process.exit(EXIT_COMPILE_ERROR);
  }
}

// ============================================================
// Command: explain (`snake explain SS1001`)
// ============================================================

function cmdExplain(args: readonly string[]): void {
  const code = args[0]?.toUpperCase();
  if (!code) {
    console.log("");
    printErrorBox(
      "Kode Error Kosong",
      `Masukkan kode error Snake Script (contoh: \`${BIN_NAME} explain SS1001\`).`,
    );
    console.log("");
    process.exit(EXIT_USAGE);
  }

  const info = explainErrorCode(code);
  if (!info) {
    console.log("");
    printErrorBox(
      "Kode Tidak Ditemukan",
      `Kode error \`${code}\` tidak terdaftar dalam katalog Snake Script.`,
      ["Kode yang valid berada pada rentang SS1001 hingga SS9001."],
    );
    console.log("");
    process.exit(EXIT_USAGE);
  }

  console.log("");
  const lines = [
    `${C.bold}${C.brightCyan}${info.code}${C.reset} — ${C.bold}${info.title}${C.reset}`,
    `${C.dim}Kategori: ${info.category}${C.reset}`,
    "",
    info.description,
  ];
  if (info.example) {
    lines.push("", `${C.bold}Contoh:${C.reset}`, `  ${C.yellow}${info.example}${C.reset}`);
  }
  printBox(lines, { title: `Penjelasan ${info.code}`, borderColor: C.cyan });
  console.log("");
}

// ============================================================
// Command: repl (Multi-Line Indentation Aware + Auto-Complete)
// ============================================================

function cmdRepl(_args: readonly string[]): void {
  printBanner();

  console.log(
    `  ${C.dim}Ketik ${C.reset}${C.cyan}.bantuan${C.reset}${C.dim} untuk daftar perintah REPL, atau ${C.reset}${C.cyan}.keluar${C.reset}${C.dim} untuk selesai.${C.reset}`,
  );
  console.log("");

  const replCompletions = [
    ".bantuan", ".help", ".bersih", ".clear", ".env", ".reset", ".keluar", ".exit",
    "const", "let", "fn", "return", "type", "if", "elif", "else", "while", "for", "in",
    "match", "case", "try", "catch", "finally", "throw", "import", "export", "from",
    "tulis", "print", "Angka", "Teks", "Boolean", "Daftar", "Peta", "panjang", "rentang", "tipe",
  ];

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
    completer: (line: string) => {
      const words = line.split(/\s+/);
      const lastWord = words[words.length - 1] ?? "";
      const hits = replCompletions.filter((c) => c.startsWith(lastWord));
      return [hits.length ? hits : replCompletions, lastWord];
    },
  });

  let interpreter = createReplInterpreter();
  let bufferLines: string[] = [];
  let inMultilineBlock = false;

  const promptMain = `${C.brightGreen}🐍${C.reset} ${C.brightCyan}>>>${C.reset} `;
  const promptCont = `${C.dim}   ...${C.reset} `;

  rl.setPrompt(promptMain);
  rl.prompt();

  rl.on("line", (line) => {
    const trimmed = line.trim();

    // Meta-commands hanya diproses jika tidak sedang di tengah blok multi-baris
    if (!inMultilineBlock && trimmed.startsWith(".")) {
      handleReplMetaCommand(
        trimmed,
        rl,
        interpreter,
        () => {
          interpreter = createReplInterpreter();
        },
      );
      rl.setPrompt(promptMain);
      rl.prompt();
      return;
    }

    if (!inMultilineBlock) {
      if (trimmed === "") {
        rl.setPrompt(promptMain);
        rl.prompt();
        return;
      }

      bufferLines = [line];
      if (needsMoreInput(bufferLines)) {
        inMultilineBlock = true;
        rl.setPrompt(promptCont);
        rl.prompt();
        return;
      }
    } else {
      // Di dalam blok multi-baris: baris kosong menandakan akhir blok
      if (trimmed === "" && !hasUnclosedDelimiters(bufferLines.join("\n"))) {
        inMultilineBlock = false;
      } else {
        bufferLines.push(line);
        rl.setPrompt(promptCont);
        rl.prompt();
        return;
      }
    }

    const fullCode = bufferLines.join("\n");
    bufferLines = [];
    inMultilineBlock = false;

    const vFile = "<repl>";
    loadSource(vFile, fullCode);
    const reporter = new Reporter({ color: useColor, format: "pretty" });

    try {
      const lexer = new Lexer(fullCode, { file: vFile, reporter });
      const stream = lexer.tokenize();
      const parser = new Parser(stream, {
        file: vFile,
        reporter,
        validateContext: false,
      });
      const program = parser.parseProgram();

      if (reporter.hasErrors()) {
        reporter.flush();
      } else {
        const result = interpreter.run(program);
        if (reporter.hasErrors()) {
          reporter.flush();
        } else if (result !== undefined) {
          interpreter.global.define("_", result, true);
          console.log(`  ${C.dim}=>${C.reset} ${formatReplValue(result)}`);
        }
      }
    } catch (e) {
      if (e instanceof RuntimeError) {
        console.error(`  ${C.red}✖ ${e.value.message}${C.reset}`);
      } else {
        console.error(`  ${C.red}✖ ${(e as Error).message}${C.reset}`);
      }
    }

    rl.setPrompt(promptMain);
    rl.prompt();
  });

  rl.on("close", () => {
    console.log("");
    console.log(`  ${C.dim}Sampai jumpa kembali! 🐍${C.reset}`);
    console.log("");
    process.exit(EXIT_OK);
  });
}

function createReplInterpreter(): Interpreter {
  return new Interpreter({
    file: "<repl>",
    reporter: new Reporter({ color: useColor, format: "pretty" }),
    onPrint: (line) => process.stdout.write(line + "\n"),
  });
}

function handleReplMetaCommand(
  cmdLine: string,
  rl: readline.Interface,
  interpreter: Interpreter,
  onReset: () => void,
): void {
  const [cmd, ...rest] = cmdLine.split(/\s+/);
  switch (cmd) {
    case ".keluar":
    case ".exit":
    case ".quit":
      rl.close();
      break;
    case ".bantuan":
    case ".help":
      printReplHelp();
      break;
    case ".bersih":
    case ".clear":
      console.clear();
      printBanner();
      break;
    case ".reset":
      onReset();
      console.log(`  ${C.green}✓ Lingkungan REPL telah direset.${C.reset}`);
      break;
    case ".env": {
      const snap = interpreter.global.snapshot();
      const userEntries = Object.entries(snap).filter(
        ([, v]) =>
          !(typeof v === "object" && v !== null && "kind" in v && v.kind === "NativeFunction"),
      );
      if (userEntries.length === 0) {
        console.log(`  ${C.dim}(belum ada variabel pengguna yang didefinisikan)${C.reset}`);
      } else {
        for (const [k, v] of userEntries) {
          console.log(`  ${C.brightCyan}${k.padEnd(14)}${C.reset} = ${formatReplValue(v)}`);
        }
      }
      break;
    }
    case ".tokens": {
      const snippet = rest.join(" ");
      if (!snippet) {
        console.log(`  ${C.dim}Penggunaan: .tokens <ekspresi>${C.reset}`);
        break;
      }
      const rep = new Reporter({ color: useColor });
      const stream = new Lexer(snippet, { file: "<repl>", reporter: rep }).tokenize();
      console.log(
        `  ${stream.all.map((t) => `${C.cyan}${t.kind}${C.reset}${t.value !== null ? `(${JSON.stringify(t.value)})` : ""}`).join(" -> ")}`,
      );
      break;
    }
    default:
      console.log(
        `  ${C.yellow}Perintah REPL \`${cmd}\` tidak dikenal. Ketik .bantuan untuk daftar perintah.${C.reset}`,
      );
  }
}

function needsMoreInput(lines: readonly string[]): boolean {
  const joined = lines.join("\n");
  if (hasUnclosedDelimiters(joined)) return true;
  const firstTrimmed = lines[0]!.trimEnd();
  return firstTrimmed.endsWith(":");
}

function hasUnclosedDelimiters(source: string): boolean {
  let depth = 0;
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < source.length; i++) {
    const c = source[i]!;
    if (c === "\\" && (inSingle || inDouble)) {
      i++;
      continue;
    }
    if (c === '"' && !inSingle) inDouble = !inDouble;
    else if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (!inSingle && !inDouble) {
      if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") depth = Math.max(0, depth - 1);
    }
  }
  return depth > 0 || inSingle || inDouble;
}

function formatReplValue(val: Value): string {
  if (val === null) return `${C.dim}null${C.reset}`;
  if (val === undefined) return `${C.dim}kosong${C.reset}`;
  if (typeof val === "number") return `${C.brightYellow}${val}${C.reset}`;
  if (typeof val === "boolean") return `${C.brightMagenta}${val}${C.reset}`;
  if (typeof val === "string") return `${C.brightGreen}${JSON.stringify(val)}${C.reset}`;
  if (Array.isArray(val)) {
    return `[${val.map((v) => formatReplValue(v)).join(", ")}]`;
  }
  if (val instanceof Map) {
    const entries = Array.from(val.entries())
      .map(([k, v]) => `${C.cyan}${k}${C.reset}: ${formatReplValue(v)}`)
      .join(", ");
    return `{ ${entries} }`;
  }
  if (typeof val === "object" && "kind" in val) {
    if (val.kind === "Function") return `${C.cyan}<fungsi ${val.name}>${C.reset}`;
    if (val.kind === "NativeFunction") return `${C.cyan}<fungsi bawaan ${val.name}>${C.reset}`;
    if (val.kind === "Error") return `${C.red}Error(${JSON.stringify(val.message)})${C.reset}`;
  }
  return String(val);
}

function printReplHelp(): void {
  console.log("");
  printSectionHeader("PERINTAH INTERAKTIF REPL");
  printOptionRow(".bantuan, .help", "Tampilkan panduan perintah REPL");
  printOptionRow(".env", "Tampilkan semua variabel & fungsi di memori saat ini");
  printOptionRow(".tokens <kode>", "Intip hasil tokenisasi Lexer untuk sebaris kode");
  printOptionRow(".reset", "Bersihkan seluruh variabel memori REPL");
  printOptionRow(".bersih, .clear", "Bersihkan layar terminal");
  printOptionRow(".keluar, .exit", "Keluar dari sesi REPL");
  console.log("");
}

// ============================================================
// Command: fmt (Formatter Kode Snake Script Nyata)
// ============================================================

function cmdFmt(args: readonly string[]): void {
  const checkOnly = args.includes("--check") || args.includes("-c");
  const toStdout = args.includes("--stdout");
  const targetArg = args.find((a) => !a.startsWith("-"));

  if (!targetArg) {
    console.log("");
    printErrorBox("Argumen Kurang", "Perintah `fmt` membutuhkan path ke file atau direktori.", [
      `Penggunaan: ${BIN_NAME} fmt <file.snake> [--check] [--stdout]`,
    ]);
    console.log("");
    process.exit(EXIT_USAGE);
  }

  const resolved = path.resolve(targetArg);
  if (!fs.existsSync(resolved)) {
    console.log("");
    printErrorBox("File Tidak Ditemukan", targetArg, [`Path: ${resolved}`]);
    console.log("");
    process.exit(EXIT_FILE_NOT_FOUND);
  }

  const files = collectSnakeFiles(resolved);
  let changedCount = 0;

  for (const file of files) {
    const original = fs.readFileSync(file, "utf-8");
    const formatted = formatSnakeSource(original);

    if (toStdout) {
      process.stdout.write(formatted);
      continue;
    }

    if (original !== formatted) {
      changedCount++;
      if (!checkOnly) {
        fs.writeFileSync(file, formatted, "utf-8");
      }
    }
  }

  if (toStdout) {
    process.exit(EXIT_OK);
  }

  console.log("");
  if (checkOnly) {
    if (changedCount > 0) {
      printErrorBox(
        "Format Belum Rapi",
        `${changedCount} dari ${files.length} file memerlukan pemformatan.`,
        [`Jalankan \`${BIN_NAME} fmt ${targetArg}\` untuk merapikan secara otomatis.`],
      );
      console.log("");
      process.exit(EXIT_FORMAT_DIFF);
    }
    printSuccessBox("Format Sesuai", `Semua ${files.length} file sudah terformat dengan rapi.`);
  } else {
    printSuccessBox(
      "Formatter Selesai",
      `${changedCount} file dirapikan (${files.length} file diperiksa).`,
    );
  }
  console.log("");
  process.exit(EXIT_OK);
}

/**
 * Merapikan kode sumber Snake Script:
 * - Mengubah tab di awal baris menjadi 4 spasi
 * - Menghapus trailing whitespace di ujung baris
 * - Menggabungkan baris kosong berlebih (maksimal 1 baris kosong berturut-turut di dalam blok)
 * - Memastikan tepat satu newline (`\n`) di akhir file
 */
function formatSnakeSource(source: string): string {
  const rawLines = source.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const outLines: string[] = [];
  let blankStreak = 0;

  for (const rawLine of rawLines) {
    // Ganti leading tab dengan 4 spasi
    const leadingMatch = rawLine.match(/^[ \t]+/);
    let normalized = rawLine;
    if (leadingMatch) {
      const expanded = leadingMatch[0].replace(/\t/g, "    ");
      normalized = expanded + rawLine.slice(leadingMatch[0].length);
    }

    // Hapus spasi di ujung kanan baris
    normalized = normalized.replace(/[ \t]+$/, "");

    if (normalized.length === 0) {
      blankStreak++;
      if (blankStreak <= 1 && outLines.length > 0) {
        outLines.push("");
      }
    } else {
      blankStreak = 0;
      outLines.push(normalized);
    }
  }

  while (outLines.length > 0 && outLines[outLines.length - 1] === "") {
    outLines.pop();
  }

  return outLines.join("\n") + "\n";
}

// ============================================================
// Command: init
// ============================================================

function cmdInit(args: readonly string[]): void {
  const name = args.find((a) => !a.startsWith("-"));

  if (!name) {
    console.log("");
    printErrorBox("Argumen Kurang", "Perintah `init` membutuhkan nama proyek.", [
      `Penggunaan: ${BIN_NAME} init <nama-proyek>`,
    ]);
    console.log("");
    process.exit(EXIT_USAGE);
  }

  const target = path.resolve(name);
  if (fs.existsSync(target)) {
    console.log("");
    printErrorBox("Direktori Sudah Ada", `Folder \`${name}\` sudah ada.`, [`Path: ${target}`]);
    console.log("");
    process.exit(EXIT_USAGE);
  }

  fs.mkdirSync(path.join(target, "src"), { recursive: true });
  fs.mkdirSync(path.join(target, "tests"), { recursive: true });

  fs.writeFileSync(
    path.join(target, "snake.json"),
    JSON.stringify(
      {
        name,
        version: "0.1.0",
        entry: "src/main.snake",
        scripts: {
          start: "snake run src/main.snake",
          test: "snake test",
          check: "snake check",
          fmt: "snake fmt .",
        },
      },
      null,
      2,
    ) + "\n",
  );

  fs.writeFileSync(
    path.join(target, "src", "main.snake"),
    [
      "## Program Utama Snake Script",
      "",
      "fn sapa(nama: Teks) -> Teks:",
      '    return "Halo, ${nama}! Selamat datang di Snake Script."',
      "",
      "fn main():",
      '    const pesan = sapa("Pengembang")',
      "    tulis(pesan)",
      "",
      "    const kuadrat = [x ** 2 for x in 1..6]",
      '    tulis("Bilangan kuadrat:", kuadrat)',
      "",
      "main()",
      "",
    ].join("\n"),
  );

  fs.writeFileSync(
    path.join(target, "tests", "main.test.snake"),
    [
      "## Pengujian Dasar",
      "",
      "const daftar = [1, 2, 3, 4]",
      'pastikan(daftar.panjang == 4, "panjang daftar harus 4")',
      'pastikan(10 in [5, 10, 15], "10 harus ada di dalam daftar")',
      "",
    ].join("\n"),
  );

  fs.writeFileSync(
    path.join(target, "README.md"),
    [
      `# ${name}`,
      "",
      "Proyek **Snake Script**.",
      "",
      "## Perintah Cepat",
      "",
      "```bash",
      "snake run src/main.snake   # Jalankan aplikasi",
      "snake test                 # Jalankan unit test",
      "snake check                # Periksa sintaks & tipe",
      "snake fmt .                # Rapikan kode sumber",
      "```",
      "",
    ].join("\n"),
  );

  fs.writeFileSync(
    path.join(target, ".gitignore"),
    ["dist/", "node_modules/", "*.snakec", ".snake-cache/", ""].join("\n"),
  );

  console.log("");
  printSuccessBox("Proyek Berhasil Dibuat", `${C.bold}${name}${C.reset}`, [
    `Lokasi: ${target}`,
    "File dibuat: snake.json, src/main.snake, tests/main.test.snake, README.md",
  ]);
  console.log("");
  console.log(`  ${C.dim}Langkah selanjutnya:${C.reset}`);
  console.log(`    ${C.cyan}cd ${name}${C.reset}`);
  console.log(`    ${C.cyan}${BIN_NAME} run src/main.snake${C.reset}`);
  console.log(`    ${C.cyan}${BIN_NAME} test${C.reset}`);
  console.log("");
  process.exit(EXIT_OK);
}

// ============================================================
// Command: info
// ============================================================

function cmdInfo(): void {
  const memMb = (process.memoryUsage().rss / (1024 * 1024)).toFixed(1);
  const cpuModel = os.cpus()[0]?.model?.trim() ?? "Tidak diketahui";

  const rows: Array<[string, string]> = [
    ["Snake Script", `v${VERSION}`],
    ["Runtime Node", process.version],
    ["Sistem Operasi", `${os.type()} ${os.release()} (${process.platform}/${process.arch})`],
    ["CPU", `${truncateMiddle(cpuModel, 38)} (${os.cpus().length} core)`],
    ["Memori RSS", `${memMb} MB`],
    ["Direktori Kerja", truncateMiddle(process.cwd().replace(os.homedir(), "~"), 42)],
    ["Warna ANSI", useColor ? `${C.green}Aktif${C.reset}` : `${C.dim}Nonaktif${C.reset}`],
    ["Terminal TTY", process.stdout?.isTTY ? `Ya (${termWidth()} kolom)` : "Tidak"],
  ];

  console.log("");
  printBox(
    rows.map(
      ([k, v]) => `${C.bold}${C.blue}${k.padEnd(16)}${C.reset} ${v}`,
    ),
    {
      title: "🐍 Informasi Lingkungan Snake Script",
      titleColor: `${C.bold}${C.brightCyan}`,
      borderColor: C.cyan,
    },
  );
  console.log("");
  console.log(`  ${C.dim}Repositori: ${C.underline}${HOMEPAGE}${C.reset}`);
  console.log("");
  process.exit(EXIT_OK);
}

// ============================================================
// Global Error & Signal Handlers
// ============================================================

process.on("uncaughtException", (e) => {
  console.error(`${C.red}${C.bold}kesalahan internal:${C.reset} ${e.message}`);
  if (process.env.SNAKE_DEBUG) console.error(e.stack);
  process.exit(EXIT_RUNTIME_ERROR);
});

process.on("SIGINT", () => {
  console.log("");
  process.exit(130);
});

// ============================================================
// Run
// ============================================================

main();
