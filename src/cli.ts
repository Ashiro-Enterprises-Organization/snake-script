#!/usr/bin/env node

/**
 * Snake Script — CLI (Premium Edition)
 *
 * Desain: profesional, modern, dengan box drawing.
 * Width menyesuaikan terminal — aman di HP maupun desktop.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";

import { Lexer, TokenStream } from "./lexer.ts";
import { Parser } from "./parser.ts";
import { Interpreter, RuntimeError } from "./interpreter.ts";
import { Reporter, clearSourceCache } from "./diagnostics.ts";

// ============================================================
// Metadata
// ============================================================

const VERSION = "0.1.0";
const BIN_NAME = "snake";
const TAGLINE = "Kemudahan Python. Keamanan TypeScript.";
const HOMEPAGE = "https://github.com/Ashiro-Enterprises-Organization/snake-script";

// ============================================================
// Exit Codes
// ============================================================

const EXIT_OK = 0;
const EXIT_COMPILE_ERROR = 1;
const EXIT_RUNTIME_ERROR = 2;
const EXIT_FILE_NOT_FOUND = 3;
const EXIT_USAGE = 64;

// ============================================================
// Terminal Width
// ============================================================

function termWidth(): number {
  const w = process.stdout.columns || 80;
  // Min 40, max 72 — supaya tidak terlalu lebar di HP atau desktop
  return Math.max(40, Math.min(72, w - 4));
}

// ============================================================
// Color Palette
// ============================================================

const useColor =
  process.stdout.isTTY &&
  !process.env.NO_COLOR &&
  !process.argv.includes("--no-color");

const C = {
  reset:   useColor ? "\x1b[0m"  : "",
  bold:    useColor ? "\x1b[1m"  : "",
  dim:     useColor ? "\x1b[2m"  : "",
  italic:  useColor ? "\x1b[3m"  : "",

  // Foreground
  black:   useColor ? "\x1b[30m" : "",
  red:     useColor ? "\x1b[31m" : "",
  green:   useColor ? "\x1b[32m" : "",
  yellow:  useColor ? "\x1b[33m" : "",
  blue:    useColor ? "\x1b[34m" : "",
  magenta: useColor ? "\x1b[35m" : "",
  cyan:    useColor ? "\x1b[36m" : "",
  white:   useColor ? "\x1b[37m" : "",
  gray:    useColor ? "\x1b[90m" : "",

  // Bright
  brightRed:     useColor ? "\x1b[91m" : "",
  brightGreen:   useColor ? "\x1b[92m" : "",
  brightYellow:  useColor ? "\x1b[93m" : "",
  brightBlue:    useColor ? "\x1b[94m" : "",
  brightMagenta: useColor ? "\x1b[95m" : "",
  brightCyan:    useColor ? "\x1b[96m" : "",

  // Background
  bgBlue:   useColor ? "\x1b[44m"  : "",
  bgCyan:   useColor ? "\x1b[46m"  : "",
} as const;

// ============================================================
// Box Drawing
// ============================================================

const B = {
  tl: "╭", tr: "╮", bl: "╰", br: "╯",
  h: "─",  v: "│",
  lt: "├", rt: "┤", tt: "┬", bt: "┴", cross: "┼",
} as const;

/**
 * Bikin garis horizontal dengan lebar tertentu.
 */
function hline(width: number): string {
  return B.h.repeat(Math.max(0, width));
}

/**
 * Center text dalam lebar tertentu.
 */
function center(text: string, width: number): string {
  const visible = stripAnsi(text).length;
  if (visible >= width) return text;
  const left = Math.floor((width - visible) / 2);
  const right = width - visible - left;
  return " ".repeat(left) + text + " ".repeat(right);
}

/**
 * Pad text ke kanan.
 */
function padRight(text: string, width: number): string {
  const visible = stripAnsi(text).length;
  if (visible >= width) return text;
  return text + " ".repeat(width - visible);
}

/**
 * Pad text ke kiri.
 */
function padLeft(text: string, width: number): string {
  const visible = stripAnsi(text).length;
  if (visible >= width) return text;
  return " ".repeat(width - visible) + text;
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

// ============================================================
// Main Entry
// ============================================================

function main(): void {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    printHelp();
    process.exit(EXIT_USAGE);
  }

  if (args.includes("-v") || args.includes("--version")) {
    printVersion();
    process.exit(EXIT_OK);
  }

  if (args[0] === "-h" || args[0] === "--help") {
    printHelp();
    process.exit(EXIT_OK);
  }

  const command = args[0]!;
  const rest = args.slice(1);

  switch (command) {
    case "run":         cmdRun(rest); break;
    case "check":       cmdCheck(rest); break;
    case "repl":        cmdRepl(rest); break;
    case "fmt":
    case "format":      cmdFmt(rest); break;
    case "init":        cmdInit(rest); break;
    case "info":        cmdInfo(); break;
    case "help":        printHelp(); break;
    default:
      printUnknownCommand(command);
      process.exit(EXIT_USAGE);
  }
}

// ============================================================
// Banner & Version
// ============================================================

function printVersion(): void {
  console.log(`${C.bold}${BIN_NAME}${C.reset} ${C.cyan}${VERSION}${C.reset}`);
}

function printBanner(): void {
  const w = termWidth();
  const inner = w - 4;

  console.log("");
  console.log(`${C.cyan}${B.tl}${hline(inner + 2)}${B.tr}${C.reset}`);

  // Baris 1: judul
  const title = `${C.bold}${C.brightCyan}Snake Script${C.reset}`;
  const titleVisible = "Snake Script";
  const line1 = `  ${C.brightGreen}🐍${C.reset}  ${title}${" ".repeat(Math.max(0, inner - titleVisible.length - 5))}`;
  console.log(`${C.cyan}${B.v}${C.reset}${line1}${C.cyan}${B.v}${C.reset}`);

  // Baris 2: versi
  const line2 = `      ${C.dim}v${VERSION}${C.reset}${" ".repeat(Math.max(0, inner - VERSION.length - 7))}`;
  console.log(`${C.cyan}${B.v}${C.reset}${line2}${C.cyan}${B.v}${C.reset}`);

  // Baris 3: kosong
  console.log(`${C.cyan}${B.v}${C.reset}${" ".repeat(inner + 2)}${C.cyan}${B.v}${C.reset}`);

  // Baris 4: tagline
  const taglineLine = `  ${C.dim}${TAGLINE}${C.reset}${" ".repeat(Math.max(0, inner - TAGLINE.length - 2))}`;
  console.log(`${C.cyan}${B.v}${C.reset}${taglineLine}${C.cyan}${B.v}${C.reset}`);

  console.log(`${C.cyan}${B.bl}${hline(inner + 2)}${B.br}${C.reset}`);
  console.log("");
}

// ============================================================
// Help
// ============================================================

function printHelp(): void {
  printBanner();

  const w = termWidth();

  // Section: Penggunaan
  printSectionHeader("PENGGUNAAN");
  console.log(`  ${C.bold}${BIN_NAME}${C.reset} ${C.dim}<perintah>${C.reset} ${C.dim}[opsi]${C.reset}`);
  console.log("");

  // Section: Perintah
  printSectionHeader("PERINTAH");
  printCommandRow("run", "<file>", "Jalankan program Snake Script");
  printCommandRow("check", "<file>", "Periksa sintaks tanpa menjalankan");
  printCommandRow("repl", "", "Mode interaktif");
  printCommandRow("fmt", "<file>", "Rapikan format kode");
  printCommandRow("init", "<nama>", "Buat proyek baru");
  printCommandRow("info", "", "Info versi & lingkungan");
  console.log("");

  // Section: Opsi
  printSectionHeader("OPSI");
  printOptionRow("-h, --help", "Tampilkan bantuan ini");
  printOptionRow("-v, --version", "Tampilkan versi");
  printOptionRow("--no-color", "Matikan warna ANSI");
  printOptionRow("-q, --quiet", "Mode senyap");
  console.log("");

  // Footer
  console.log(`${C.dim}  Jalankan ${C.reset}${C.cyan}${BIN_NAME} <perintah> --help${C.reset}${C.dim} untuk info lebih lanjut.${C.reset}`);
  console.log("");
}

function printSectionHeader(title: string): void {
  console.log(`  ${C.bold}${C.blue}${title}${C.reset}`);
}

function printCommandRow(cmd: string, arg: string, desc: string): void {
  const cmdCol = `  ${C.brightCyan}${BIN_NAME} ${C.bold}${C.white}${cmd}${C.reset}`;
  const argCol = arg ? ` ${C.dim}${arg}${C.reset}` : "";
  console.log(`${cmdCol}${argCol}`);
  console.log(`      ${C.gray}${desc}${C.reset}`);
}

function printOptionRow(opt: string, desc: string): void {
  console.log(`  ${C.brightYellow}${opt.padEnd(16)}${C.reset}${C.gray}${desc}${C.reset}`);
}

function printUnknownCommand(command: string): void {
  console.log("");
  printErrorBox(
    "Perintah tidak dikenal",
    `\`${command}\` bukan perintah yang valid.`,
    [`Jalankan \`${BIN_NAME} --help\` untuk daftar perintah.`],
  );
  console.log("");
}

// ============================================================
// Boxes
// ============================================================

interface BoxOptions {
  title?: string;
  titleColor?: string;
  borderColor?: string;
  width?: number;
}

function printBox(content: string[], opts: BoxOptions = {}): void {
  const w = opts.width ?? termWidth();
  const borderColor = opts.borderColor ?? C.cyan;
  const inner = w - 2;

  // Top border with optional title
  if (opts.title) {
    const titleColor = opts.titleColor ?? C.bold;
    const title = `${titleColor} ${opts.title} ${C.reset}`;
    const titleVisible = ` ${opts.title} `;
    const leftBar = "─";
    const rightBar = "─".repeat(Math.max(0, inner - titleVisible.length - 1));
    console.log(`${borderColor}${B.tl}${leftBar}${C.reset}${title}${borderColor}${rightBar}${B.tr}${C.reset}`);
  } else {
    console.log(`${borderColor}${B.tl}${hline(inner)}${B.tr}${C.reset}`);
  }

  // Content
  for (const line of content) {
    const visible = stripAnsi(line).length;
    const padding = Math.max(0, inner - visible - 2);
    console.log(`${borderColor}${B.v}${C.reset} ${line}${" ".repeat(padding)} ${borderColor}${B.v}${C.reset}`);
  }

  // Bottom
  console.log(`${borderColor}${B.bl}${hline(inner)}${B.br}${C.reset}`);
}

function printErrorBox(title: string, message: string, hints: string[] = []): void {
  const w = termWidth();
  const inner = w - 2;

  console.log(`${C.red}${B.tl}─ ${C.bold}${title}${C.reset}${C.red} ${"─".repeat(Math.max(0, inner - title.length - 4))}${B.tr}${C.reset}`);
  console.log(`${C.red}${B.v}${C.reset} ${message}${" ".repeat(Math.max(0, inner - stripAnsi(message).length - 2))} ${C.red}${B.v}${C.reset}`);

  for (const hint of hints) {
    console.log(`${C.red}${B.v}${C.reset} ${C.dim}${hint}${C.reset}${" ".repeat(Math.max(0, inner - stripAnsi(hint).length - 2))} ${C.red}${B.v}${C.reset}`);
  }

  console.log(`${C.red}${B.bl}${hline(inner)}${B.br}${C.reset}`);
}

function printSuccessBox(title: string, message: string): void {
  const w = termWidth();
  const inner = w - 2;
  const check = `${C.brightGreen}✓${C.reset}`;

  console.log(`${C.green}${B.tl}─${C.reset} ${check} ${C.bold}${title}${C.reset} ${C.green}${"─".repeat(Math.max(0, inner - title.length - 5))}${B.tr}${C.reset}`);
  console.log(`${C.green}${B.v}${C.reset} ${message}${" ".repeat(Math.max(0, inner - stripAnsi(message).length - 2))} ${C.green}${B.v}${C.reset}`);
  console.log(`${C.green}${B.bl}${hline(inner)}${B.br}${C.reset}`);
}

// ============================================================
// Command: run
// ============================================================

function cmdRun(args: string[]): void {
  if (args.includes("--help") || args.includes("-h")) {
    printRunHelp();
    process.exit(EXIT_OK);
  }

  const { file, flags } = parseRunFlags(args);

  if (!file) {
    printErrorBox(
      "Argumen kurang",
      "Perintah `run` butuh path ke file.",
      [`Penggunaan: ${BIN_NAME} run <file.snake>`],
    );
    console.log("");
    process.exit(EXIT_USAGE);
  }

  const resolved = path.resolve(file);

  if (!fs.existsSync(resolved)) {
    printErrorBox(
      "File tidak ditemukan",
      file,
      [`Path: ${resolved}`],
    );
    console.log("");
    process.exit(EXIT_FILE_NOT_FOUND);
  }

  const start = Date.now();
  const source = fs.readFileSync(resolved, "utf-8");
  const reporter = new Reporter({
    color: useColor && !flags.json,
    format: flags.json ? "json" : "pretty",
  });

  // Header panel
  if (!flags.quiet && !flags.json) {
    printRunHeader(resolved);
  }

  // Compile
  const lexer = new Lexer(source, { file: resolved, reporter });
  const stream = lexer.tokenize();
  const parser = new Parser(stream, { file: resolved, reporter });
  const program = parser.parseProgram();

  if (reporter.hasErrors()) {
    reporter.flush();
    process.exit(EXIT_COMPILE_ERROR);
  }

  const parseTime = Date.now() - start;

  // Execute
  const interpreter = new Interpreter({
    file: resolved,
    reporter,
    onPrint: (line) => process.stdout.write(line + "\n"),
  });

  try {
    interpreter.run(program);
  } catch (e) {
    if (e instanceof RuntimeError) {
      reporter.report({
        severity: "error",
        code: e.value.code ?? "SS9001",
        message: e.value.message,
        location: e.location ?? program.loc,
      });
      reporter.flush();
      process.exit(EXIT_RUNTIME_ERROR);
    }
    console.error(`${C.red}${C.bold}internal error:${C.reset} ${(e as Error).message}`);
    if (process.env.SNAKE_DEBUG) {
      console.error((e as Error).stack);
    }
    process.exit(EXIT_RUNTIME_ERROR);
  }

  if (reporter.hasErrors()) {
    reporter.flush();
    process.exit(EXIT_RUNTIME_ERROR);
  }

  if (!flags.quiet && !flags.json && flags.time) {
    const total = Date.now() - start;
    printRunFooter(total, parseTime);
  }

  process.exit(EXIT_OK);
}

function printRunHeader(file: string): void {
  const w = termWidth();
  const inner = w - 2;
  const basename = path.basename(file);
  const dir = path.dirname(file).replace(process.env.HOME ?? "", "~");

  const label = `${C.bold}${C.brightCyan}▶${C.reset} ${C.bold}${basename}${C.reset}`;
  const labelVisible = `▶ ${basename}`;
  const padding = " ".repeat(Math.max(0, inner - labelVisible.length - 2));

  console.log("");
  console.log(`${C.cyan}${B.tl}${hline(inner)}${B.tr}${C.reset}`);
  console.log(`${C.cyan}${B.v}${C.reset} ${label}${padding} ${C.cyan}${B.v}${C.reset}`);

  const dirLine = `  ${C.dim}${dir}${C.reset}`;
  const dirVisible = `  ${dir}`;
  const dirPadding = " ".repeat(Math.max(0, inner - dirVisible.length - 2));
  console.log(`${C.cyan}${B.v}${C.reset} ${dirLine}${dirPadding} ${C.cyan}${B.v}${C.reset}`);

  console.log(`${C.cyan}${B.bl}${hline(inner)}${B.br}${C.reset}`);
  console.log("");
}

function printRunFooter(totalMs: number, parseMs: number): void {
  console.log("");
  console.log(`  ${C.dim}${C.brightGreen}✓${C.reset} ${C.dim}Selesai dalam ${C.bold}${totalMs}ms${C.reset}${C.dim} (parse ${parseMs}ms)${C.reset}`);
  console.log("");
}

function printRunHelp(): void {
  printBanner();
  printSectionHeader("PENGGUNAAN");
  console.log(`  ${C.bold}${BIN_NAME} run${C.reset} ${C.dim}<file>${C.reset} ${C.dim}[opsi]${C.reset}`);
  console.log("");
  printSectionHeader("ARGUMEN");
  printOptionRow("<file>", "Path ke file .snake");
  console.log("");
  printSectionHeader("OPSI");
  printOptionRow("-w, --watch", "Pantau perubahan dan jalankan ulang");
  printOptionRow("--json", "Output error dalam format JSON");
  printOptionRow("--no-color", "Matikan warna ANSI");
  printOptionRow("-q, --quiet", "Hanya tampilkan output program");
  printOptionRow("--time", "Tampilkan waktu eksekusi");
  printOptionRow("-h, --help", "Tampilkan bantuan");
  console.log("");
  printSectionHeader("EXIT CODE");
  printOptionRow("0", "Sukses");
  printOptionRow("1", "Error kompilasi");
  printOptionRow("2", "Error runtime");
  printOptionRow("3", "File tidak ditemukan");
  console.log("");
}

interface RunFlags {
  readonly quiet: boolean;
  readonly json: boolean;
  readonly time: boolean;
  readonly watch: boolean;
}

function parseRunFlags(args: string[]): { file: string | null; flags: RunFlags } {
  const flags: RunFlags = {
    quiet: false,
    json: false,
    time: true, // default true untuk tampilkan footer
    watch: false,
  };
  let file: string | null = null;

  for (const arg of args) {
    if (arg === "-q" || arg === "--quiet") flags.quiet = true;
    else if (arg === "--json") flags.json = true;
    else if (arg === "--time") flags.time = true;
    else if (arg === "--no-time") flags.time = false;
    else if (arg === "-w" || arg === "--watch") flags.watch = true;
    else if (arg === "--no-color") { /* handled globally */ }
    else if (!arg.startsWith("-")) file = arg;
  }

  return { file, flags };
}

// ============================================================
// Command: check
// ============================================================

function cmdCheck(args: string[]): void {
  const file = args.find((a) => !a.startsWith("-"));

  if (!file) {
    printErrorBox(
      "Argumen kurang",
      "Perintah `check` butuh path ke file.",
      [`Penggunaan: ${BIN_NAME} check <file.snake>`],
    );
    console.log("");
    process.exit(EXIT_USAGE);
  }

  const resolved = path.resolve(file);

  if (!fs.existsSync(resolved)) {
    printErrorBox("File tidak ditemukan", file, [`Path: ${resolved}`]);
    console.log("");
    process.exit(EXIT_FILE_NOT_FOUND);
  }

  const source = fs.readFileSync(resolved, "utf-8");
  const reporter = new Reporter({ color: useColor, format: "pretty" });

  const start = Date.now();

  const lexer = new Lexer(source, { file: resolved, reporter });
  const stream = lexer.tokenize();
  const parser = new Parser(stream, { file: resolved, reporter });
  parser.parseProgram();

  const elapsed = Date.now() - start;

  if (reporter.hasErrors()) {
    reporter.flush();
    process.exit(EXIT_COMPILE_ERROR);
  }

  const basename = path.basename(resolved);
  console.log("");
  printSuccessBox(
    "Check",
    `${basename} — ${C.green}${C.bold}tidak ada masalah${C.reset} ${C.dim}(${elapsed}ms)${C.reset}`,
  );
  console.log("");
  process.exit(EXIT_OK);
}

// ============================================================
// Command: repl
// ============================================================

function cmdRepl(_args: string[]): void {
  printBanner();

  console.log(`  ${C.dim}Ketik ${C.reset}${C.cyan}.bantuan${C.reset}${C.dim} untuk bantuan, ${C.reset}${C.cyan}.keluar${C.reset}${C.dim} untuk keluar.${C.reset}`);
  console.log("");

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  const interpreter = new Interpreter({
    file: "<repl>",
    reporter: new Reporter({ color: false, format: "plain" }),
    onPrint: (line) => process.stdout.write(line + "\n"),
  });

  let buffer = "";

  const promptMain = `${C.brightGreen}🐍${C.reset} ${C.brightCyan}>>>${C.reset} `;
  const promptCont = `${C.dim}...${C.reset} `;

  rl.setPrompt(promptMain);
  rl.prompt();

  rl.on("line", (line) => {
    const trimmed = line.trim();

    if (trimmed === ".keluar" || trimmed === ".exit" || trimmed === ".quit") {
      rl.close();
      return;
    }

    if (trimmed === ".bantuan" || trimmed === ".help") {
      printReplHelp();
      rl.setPrompt(promptMain);
      rl.prompt();
      return;
    }

    if (trimmed === ".bersih" || trimmed === ".clear") {
      console.clear();
      printBanner();
      rl.setPrompt(promptMain);
      rl.prompt();
      return;
    }

    if (trimmed === "") {
      rl.setPrompt(promptMain);
      rl.prompt();
      return;
    }

    buffer += (buffer ? "\n" : "") + line;

    const isIncomplete = endsWithBlockOpener(line);

    if (isIncomplete) {
      rl.setPrompt(promptCont);
      rl.prompt();
      return;
    }

    const reporter = new Reporter({ color: true, format: "pretty" });

    try {
      const lexer = new Lexer(buffer, { file: "<repl>", reporter });
      const stream = lexer.tokenize();
      const parser = new Parser(stream, { file: "<repl>", reporter });
      const program = parser.parseProgram();

      if (reporter.hasErrors()) {
        reporter.flush();
      } else {
        interpreter.run(program);
      }
    } catch (e) {
      if (e instanceof RuntimeError) {
        console.error(`  ${C.red}✖${C.reset} ${C.red}${e.value.message}${C.reset}`);
      } else {
        console.error(`  ${C.red}✖${C.reset} ${C.red}${(e as Error).message}${C.reset}`);
      }
    }

    buffer = "";
    rl.setPrompt(promptMain);
    rl.prompt();
  });

  rl.on("close", () => {
    console.log("");
    console.log(`  ${C.dim}Sampai jumpa.${C.reset}`);
    console.log("");
    process.exit(EXIT_OK);
  });
}

function endsWithBlockOpener(line: string): boolean {
  const trimmed = line.trimEnd();
  return trimmed.endsWith(":") || trimmed.endsWith("{");
}

function printReplHelp(): void {
  console.log("");
  printSectionHeader("PERINTAH REPL");
  printOptionRow(".bantuan, .help", "Tampilkan bantuan");
  printOptionRow(".bersih, .clear", "Bersihkan layar");
  printOptionRow(".keluar, .exit", "Keluar dari REPL");
  console.log("");
}

// ============================================================
// Command: fmt
// ============================================================

function cmdFmt(args: string[]): void {
  const file = args.find((a) => !a.startsWith("-"));

  if (!file) {
    printErrorBox(
      "Argumen kurang",
      "Perintah `fmt` butuh path ke file.",
      [`Penggunaan: ${BIN_NAME} fmt <file.snake>`],
    );
    console.log("");
    process.exit(EXIT_USAGE);
  }

  console.log("");
  printBox(
    [`${C.yellow}⚠${C.reset}  Formatter belum diimplementasikan.`, "", `  ${C.dim}Rencana: v0.5.0${C.reset}`],
    { title: "Warning", titleColor: `${C.bold}${C.yellow}`, borderColor: C.yellow },
  );
  console.log("");
  process.exit(EXIT_OK);
}

// ============================================================
// Command: init
// ============================================================

function cmdInit(args: string[]): void {
  const name = args.find((a) => !a.startsWith("-"));

  if (!name) {
    printErrorBox(
      "Argumen kurang",
      "Perintah `init` butuh nama proyek.",
      [`Penggunaan: ${BIN_NAME} init <nama>`],
    );
    console.log("");
    process.exit(EXIT_USAGE);
  }

  const target = path.resolve(name);

  if (fs.existsSync(target)) {
    printErrorBox(
      "Direktori sudah ada",
      name,
      [`Path: ${target}`],
    );
    console.log("");
    process.exit(EXIT_USAGE);
  }

  fs.mkdirSync(target, { recursive: true });
  fs.mkdirSync(path.join(target, "src"), { recursive: true });

  fs.writeFileSync(
    path.join(target, "src", "main.snake"),
    [
      'fn main():',
      '    tulis("Halo dari Snake Script!")',
      "",
      "main()",
      "",
    ].join("\n"),
  );

  fs.writeFileSync(
    path.join(target, "README.md"),
    [
      `# ${name}`,
      "",
      "Proyek Snake Script.",
      "",
      "## Menjalankan",
      "",
      "```bash",
      "snake run src/main.snake",
      "```",
      "",
    ].join("\n"),
  );

  fs.writeFileSync(
    path.join(target, ".gitignore"),
    ["dist/", "node_modules/", "*.snakec", ".snake-cache/", ""].join("\n"),
  );

  console.log("");
  printSuccessBox(
    "Proyek dibuat",
    `${C.bold}${name}${C.reset}`,
  );
  console.log("");
  console.log(`  ${C.dim}Langkah selanjutnya:${C.reset}`);
  console.log(`    ${C.cyan}cd ${name}${C.reset}`);
  console.log(`    ${C.cyan}snake run src/main.snake${C.reset}`);
  console.log("");
  process.exit(EXIT_OK);
}

// ============================================================
// Command: info
// ============================================================

function cmdInfo(): void {
  const w = termWidth();
  const inner = w - 2;

  // Header box
  console.log("");
  console.log(`${C.cyan}${B.tl}${hline(inner)}${B.tr}${C.reset}`);

  const title = `${C.brightGreen}🐍${C.reset}  ${C.bold}${C.brightCyan}Snake Script${C.reset}`;
  const titleVisible = "🐍  Snake Script";
  const tPad = " ".repeat(Math.max(0, inner - titleVisible.length - 2));
  console.log(`${C.cyan}${B.v}${C.reset} ${title}${tPad} ${C.cyan}${B.v}${C.reset}`);

  const sub = `    ${C.dim}v${VERSION}${C.reset}`;
  const subVisible = `    v${VERSION}`;
  const sPad = " ".repeat(Math.max(0, inner - subVisible.length - 2));
  console.log(`${C.cyan}${B.v}${C.reset} ${sub}${sPad} ${C.cyan}${B.v}${C.reset}`);

  console.log(`${C.cyan}${B.lt}${hline(inner)}${B.rt}${C.reset}`);

  // Info rows
  const rows: Array<[string, string]> = [
    ["Versi", VERSION],
    ["Node", process.version],
    ["Platform", `${process.platform} ${process.arch}`],
    ["CWD", process.cwd().replace(process.env.HOME ?? "", "~")],
    ["Warna", useColor ? `${C.green}aktif${C.reset}` : `${C.dim}nonaktif${C.reset}`],
    ["TTY", process.stdout.isTTY ? "ya" : "tidak"],
  ];

  for (const [key, value] of rows) {
    const keyCol = `${C.bold}${C.blue}${key.padEnd(10)}${C.reset}`;
    const valueCol = value;
    const line = `  ${keyCol} ${valueCol}`;
    const visible = stripAnsi(line).length;
    const padding = " ".repeat(Math.max(0, inner - visible - 2));
    console.log(`${C.cyan}${B.v}${C.reset} ${line}${padding} ${C.cyan}${B.v}${C.reset}`);
  }

  console.log(`${C.cyan}${B.bl}${hline(inner)}${B.br}${C.reset}`);

  // Footer link
  console.log("");
  console.log(`  ${C.dim}${HOMEPAGE}${C.reset}`);
  console.log("");
  process.exit(EXIT_OK);
}

// ============================================================
// Global Error Handler
// ============================================================

process.on("uncaughtException", (e) => {
  console.error(`${C.red}${C.bold}internal error:${C.reset} ${e.message}`);
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
