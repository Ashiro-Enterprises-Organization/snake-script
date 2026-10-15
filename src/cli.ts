#!/usr/bin/env node

/**
 * Snake Script — CLI
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

// ============================================================
// Exit Codes
// ============================================================

const EXIT_OK = 0;
const EXIT_COMPILE_ERROR = 1;
const EXIT_RUNTIME_ERROR = 2;
const EXIT_FILE_NOT_FOUND = 3;
const EXIT_USAGE = 64;

// ============================================================
// ANSI Colors
// ============================================================

const useColor =
  process.stdout.isTTY && !process.env.NO_COLOR && !process.argv.includes("--no-color");

const c = {
  reset: useColor ? "\x1b[0m" : "",
  bold: useColor ? "\x1b[1m" : "",
  dim: useColor ? "\x1b[2m" : "",
  red: useColor ? "\x1b[31m" : "",
  green: useColor ? "\x1b[32m" : "",
  yellow: useColor ? "\x1b[33m" : "",
  blue: useColor ? "\x1b[34m" : "",
  cyan: useColor ? "\x1b[36m" : "",
};

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
    console.log(`${BIN_NAME} ${VERSION}`);
    process.exit(EXIT_OK);
  }

  if (args[0] === "-h" || args[0] === "--help") {
    printHelp();
    process.exit(EXIT_OK);
  }

  const command = args[0]!;
  const rest = args.slice(1);

  switch (command) {
    case "run":
      cmdRun(rest);
      break;
    case "check":
      cmdCheck(rest);
      break;
    case "repl":
      cmdRepl(rest);
      break;
    case "fmt":
    case "format":
      cmdFmt(rest);
      break;
    case "init":
      cmdInit(rest);
      break;
    case "info":
      cmdInfo();
      break;
    case "help":
      printHelp();
      break;
    default:
      console.error(`${c.red}error:${c.reset} perintah tidak dikenal: \`${command}\``);
      console.error(`\nJalankan \`${BIN_NAME} --help\` untuk daftar perintah.`);
      process.exit(EXIT_USAGE);
  }
}

// ============================================================
// Command: run
// ============================================================

function cmdRun(args: string[]): void {
  const { file, flags } = parseRunFlags(args);

  if (!file) {
    console.error(`${c.red}error:${c.reset} perintah \`run\` butuh argumen <file>`);
    console.error(`\nPenggunaan: ${BIN_NAME} run <file.snake>`);
    process.exit(EXIT_USAGE);
  }

  const resolved = path.resolve(file);

  if (!fs.existsSync(resolved)) {
    console.error(`${c.red}error:${c.reset} file tidak ditemukan: ${file}`);
    process.exit(EXIT_FILE_NOT_FOUND);
  }

  const start = Date.now();
  const source = fs.readFileSync(resolved, "utf-8");
  const reporter = new Reporter({
    color: useColor && !flags.json,
    format: flags.json ? "json" : "pretty",
  });

  const lexer = new Lexer(source, { file: resolved, reporter });
  const stream = lexer.tokenize();
  const parser = new Parser(stream, { file: resolved, reporter });
  const program = parser.parseProgram();

  if (reporter.hasErrors()) {
    reporter.flush();
    process.exit(EXIT_COMPILE_ERROR);
  }

  const parseTime = Date.now() - start;

  if (!flags.quiet) {
    console.error(`${c.dim}Menjalankan ${path.basename(resolved)}${c.reset}`);
  }

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
    console.error(`${c.red}internal error:${c.reset} ${(e as Error).message}`);
    if (process.env.SNAKE_DEBUG) {
      console.error((e as Error).stack);
    }
    process.exit(EXIT_RUNTIME_ERROR);
  }

  if (reporter.hasErrors()) {
    reporter.flush();
    process.exit(EXIT_RUNTIME_ERROR);
  }

  if (!flags.quiet && flags.time) {
    const total = Date.now() - start;
    console.error(
      `${c.dim}Selesai dalam ${total}ms (parse ${parseTime}ms)${c.reset}`,
    );
  }

  process.exit(EXIT_OK);
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
    time: false,
    watch: false,
  };
  let file: string | null = null;

  for (const arg of args) {
    if (arg === "-q" || arg === "--quiet") flags.quiet = true;
    else if (arg === "--json") flags.json = true;
    else if (arg === "--time") flags.time = true;
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
    console.error(`${c.red}error:${c.reset} perintah \`check\` butuh argumen <file>`);
    console.error(`\nPenggunaan: ${BIN_NAME} check <file.snake>`);
    process.exit(EXIT_USAGE);
  }

  const resolved = path.resolve(file);

  if (!fs.existsSync(resolved)) {
    console.error(`${c.red}error:${c.reset} file tidak ditemukan: ${file}`);
    process.exit(EXIT_FILE_NOT_FOUND);
  }

  const source = fs.readFileSync(resolved, "utf-8");
  const reporter = new Reporter({ color: useColor, format: "pretty" });

  const lexer = new Lexer(source, { file: resolved, reporter });
  const stream = lexer.tokenize();
  const parser = new Parser(stream, { file: resolved, reporter });
  parser.parseProgram();

  if (reporter.hasErrors()) {
    reporter.flush();
    process.exit(EXIT_COMPILE_ERROR);
  }

  console.error(
    `${c.green}ok${c.reset} ${path.basename(resolved)} — ${c.dim}tidak ada masalah${c.reset}`,
  );
  process.exit(EXIT_OK);
}

// ============================================================
// Command: repl
// ============================================================

function cmdRepl(_args: string[]): void {
  console.error(`${c.bold}${BIN_NAME} ${VERSION}${c.reset} — ${TAGLINE}`);
  console.error(`${c.dim}Ketik \`.keluar\` untuk keluar, \`.bantuan\` untuk bantuan.${c.reset}`);
  console.error("");

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${c.green}>>>${c.reset} `,
    terminal: true,
  });

  const interpreter = new Interpreter({
    file: "<repl>",
    reporter: new Reporter({ color: false, format: "plain" }),
    onPrint: (line) => process.stdout.write(line + "\n"),
  });

  let buffer = "";

  rl.prompt();

  rl.on("line", (line) => {
    const trimmed = line.trim();

    if (trimmed === ".keluar" || trimmed === ".exit" || trimmed === ".quit") {
      rl.close();
      return;
    }

    if (trimmed === ".bantuan" || trimmed === ".help") {
      printReplHelp();
      rl.prompt();
      return;
    }

    if (trimmed === ".bersih" || trimmed === ".clear") {
      console.clear();
      rl.prompt();
      return;
    }

    if (trimmed === "") {
      rl.prompt();
      return;
    }

    buffer += (buffer ? "\n" : "") + line;

    const isIncomplete = endsWithBlockOpener(line);

    if (isIncomplete) {
      rl.setPrompt(`${c.dim}...${c.reset} `);
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
        console.error(`${c.red}error:${c.reset} ${e.value.message}`);
      } else {
        console.error(`${c.red}error:${c.reset} ${(e as Error).message}`);
      }
    }

    buffer = "";
    rl.setPrompt(`${c.green}>>>${c.reset} `);
    rl.prompt();
  });

  rl.on("close", () => {
    console.error("");
    process.exit(EXIT_OK);
  });
}

function endsWithBlockOpener(line: string): boolean {
  const trimmed = line.trimEnd();
  return trimmed.endsWith(":") || trimmed.endsWith("{");
}

function printReplHelp(): void {
  console.error(`${c.bold}Perintah REPL:${c.reset}`);
  console.error(`  .bantuan, .help    Tampilkan bantuan ini`);
  console.error(`  .bersih, .clear    Bersihkan layar`);
  console.error(`  .keluar, .exit     Keluar dari REPL`);
  console.error("");
}

// ============================================================
// Command: fmt
// ============================================================

function cmdFmt(args: string[]): void {
  const file = args.find((a) => !a.startsWith("-"));

  if (!file) {
    console.error(`${c.red}error:${c.reset} perintah \`fmt\` butuh argumen <file>`);
    process.exit(EXIT_USAGE);
  }

  console.error(
    `${c.yellow}warning:${c.reset} formatter belum diimplementasikan (rencana v0.5.0)`,
  );
  process.exit(EXIT_OK);
}

// ============================================================
// Command: init
// ============================================================

function cmdInit(args: string[]): void {
  const name = args.find((a) => !a.startsWith("-"));

  if (!name) {
    console.error(`${c.red}error:${c.reset} perintah \`init\` butuh argumen <nama>`);
    process.exit(EXIT_USAGE);
  }

  const target = path.resolve(name);

  if (fs.existsSync(target)) {
    console.error(`${c.red}error:${c.reset} direktori sudah ada: ${name}`);
    process.exit(EXIT_USAGE);
  }

  fs.mkdirSync(target, { recursive: true });
  fs.mkdirSync(path.join(target, "src"), { recursive: true });

  fs.writeFileSync(
    path.join(target, "src", "main.snake"),
    [
      "fn main():",
      '    tulis("Halo dari ${main}!")',
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
      `snake run src/main.snake`,
      "```",
      "",
    ].join("\n"),
  );

  fs.writeFileSync(
    path.join(target, ".gitignore"),
    ["dist/", "node_modules/", "*.snakec", ".snake-cache/", ""].join("\n"),
  );

  console.error(`${c.green}ok${c.reset} proyek dibuat di ${c.bold}${name}${c.reset}`);
  console.error(`${c.dim}  cd ${name} && snake run src/main.snake${c.reset}`);
  process.exit(EXIT_OK);
}

// ============================================================
// Command: info
// ============================================================

function cmdInfo(): void {
  console.log(`${c.bold}${BIN_NAME} ${VERSION}${c.reset}`);
  console.log(TAGLINE);
  console.log("");
  console.log(`node:       ${process.version}`);
  console.log(`platform:   ${process.platform} ${process.arch}`);
  console.log(`cwd:        ${process.cwd()}`);
  console.log(`color:      ${useColor ? "aktif" : "nonaktif"}`);
  console.log(`tty:        ${process.stdout.isTTY ? "ya" : "tidak"}`);
  process.exit(EXIT_OK);
}

// ============================================================
// Help
// ============================================================

function printHelp(): void {
  console.log(`${c.bold}${BIN_NAME} ${VERSION}${c.reset}`);
  console.log(TAGLINE);
  console.log("");
  console.log(`${c.bold}PENGGUNAAN:${c.reset}`);
  console.log(`    ${BIN_NAME} <PERINTAH> [OPSI]`);
  console.log("");
  console.log(`${c.bold}PERINTAH:${c.reset}`);
  console.log(`    run <file>       Jalankan program Snake Script`);
  console.log(`    check <file>     Periksa sintaks tanpa menjalankan`);
  console.log(`    repl             Mode interaktif`);
  console.log(`    fmt <file>       Rapikan format kode`);
  console.log(`    init <nama>      Buat proyek baru`);
  console.log(`    info             Tampilkan info versi dan lingkungan`);
  console.log("");
  console.log(`${c.bold}OPSI:${c.reset}`);
  console.log(`    -h, --help       Tampilkan bantuan`);
  console.log(`    -v, --version    Tampilkan versi`);
  console.log(`    --no-color       Matikan warna`);
  console.log(`    -q, --quiet      Mode senyap`);
  console.log("");
  console.log(`${c.dim}Jalankan '${BIN_NAME} <PERINTAH> --help' untuk info lebih lanjut.${c.reset}`);
}

// ============================================================
// Global Error Handler
// ============================================================

process.on("uncaughtException", (e) => {
  console.error(`${c.red}internal error:${c.reset} ${e.message}`);
  if (process.env.SNAKE_DEBUG) console.error(e.stack);
  process.exit(EXIT_RUNTIME_ERROR);
});

process.on("SIGINT", () => {
  console.error("");
  process.exit(130);
});

// ============================================================
// Run
// ============================================================

main();
