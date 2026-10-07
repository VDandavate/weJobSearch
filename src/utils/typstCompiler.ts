import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { CompileFormatEnum, createTypstCompiler } from '@myriaddreamin/typst.ts/compiler';
import { preloadFontAssets } from '@myriaddreamin/typst.ts/options.init';
import { PDFParse } from 'pdf-parse';

const execFileAsync = promisify(execFile);

export type TypstEngine = 'wasm' | 'systemBinary';

export interface TypstSource {
  mainFilePath: string;
  mainContent: string;
}

export interface CompilePdfOptions {
  source: TypstSource;
  outputPath: string;
  engine?: TypstEngine | 'auto';
}

export interface PdfCompileResult {
  pdfBytes: Uint8Array;
  pageCount: number;
  engine: TypstEngine;
}

export interface TextDensityReductionContext {
  source: TypstSource;
  pageCount: number;
}

export type TextDensityReducer = (context: TextDensityReductionContext) => Promise<TypstSource> | TypstSource;

export interface PageLimitCompileOptions {
  source: TypstSource;
  outputPath: string;
  maxPages?: number;
  maxReductionAttempts?: number;
  reduceTextDensity: TextDensityReducer;
}

export interface PageLimitCompileResult extends PdfCompileResult {
  reductionAttempts: number;
}

export interface TypstCompileFailure extends Error {
  diagnostics: string[];
}

export const defaultMaxPages = 1;
export const defaultMaxReductionAttempts = 5;

export async function detectSystemTypstBinary(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('typst', ['--version']);
    if (stdout.trim().length === 0) {
      return null;
    }
    return 'typst';
  } catch {
    return null;
  }
}

async function compileWithWasm(source: TypstSource): Promise<Uint8Array> {
  const compiler = createTypstCompiler();
  // Phase 6c: the WASM engine downloads its font assets from a CDN on first
  // compile, so an offline or CDN-blocked run fails here - not in compile().
  // Fail fast with an actionable memo (system binary path) instead of leaking
  // the raw fetch diagnostic.
  // U24 hardening: parallel test workers (and users) burst concurrent font
  // fetches at the CDN, which intermittently resets connections. Retry the
  // init a bounded number of times before giving up with the memo.
  const maxFontInitAttempts = 3;
  let initialized = false;
  let lastInitError: unknown = null;
  for (let attempt = 1; attempt <= maxFontInitAttempts && !initialized; attempt += 1) {
    try {
      await compiler.init({ beforeBuild: [preloadFontAssets({ assets: ['text'] })] });
      initialized = true;
    } catch (error) {
      lastInitError = error;
      if (attempt < maxFontInitAttempts) {
        await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
      }
    }
  }
  if (!initialized) {
    throw new Error(
      `Typst WASM setup failed (${(lastInitError as Error)?.message ?? lastInitError}). The WASM engine downloads ` +
        `its font assets from a CDN on first compile, so this fails offline or when the CDN ` +
        `is blocked. Fix: install a system typst binary (macOS: brew install typst; ` +
        `Debian/Ubuntu: sudo apt install typst; Windows: winget install Typst), verify with ` +
        `typst --version, and re-run - startup prefers the system binary automatically when ` +
        `detectSystemTypstBinary finds it on PATH.`,
    );
  }
  try {
    compiler.addSource(source.mainFilePath, source.mainContent);
    const result = await compiler.compile({
      mainFilePath: source.mainFilePath,
      format: CompileFormatEnum.pdf,
      diagnostics: 'full',
    });
    if (result.result === undefined) {
      const diagnostics = (result.diagnostics ?? [])
        .filter((diagnostic) => diagnostic.severity === 'error')
        .map((diagnostic) => diagnostic.message);
      const failure = new Error('Typst WASM compilation produced no PDF output') as TypstCompileFailure;
      failure.diagnostics = diagnostics.length > 0 ? diagnostics : ['Unknown compilation error'];
      throw failure;
    }
    return result.result;
  } finally {
    await compiler.reset();
  }
}

async function compileWithSystemBinary(source: TypstSource, outputPath: string): Promise<Uint8Array> {
  const tempDir = await mkdtemp(join(tmpdir(), 'weJobSearch-'));
  try {
    const inputPath = join(tempDir, 'main.typ');
    await writeFile(inputPath, source.mainContent, 'utf8');
    await execFileAsync('typst', ['compile', inputPath, outputPath, '--root', tempDir], {
      maxBuffer: 10 * 1024 * 1024,
    });
    const pdfBytes = await readFile(outputPath);
    return new Uint8Array(pdfBytes);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function resolveEngine(preference: CompilePdfOptions['engine']): Promise<TypstEngine> {
  if (preference === 'wasm' || preference === 'systemBinary') {
    return preference;
  }
  const systemBinary = await detectSystemTypstBinary();
  return systemBinary === null ? 'wasm' : 'systemBinary';
}

export async function compileTypstToPdf(options: CompilePdfOptions): Promise<PdfCompileResult> {
  await mkdir(dirname(options.outputPath), { recursive: true });
  const engine = await resolveEngine(options.engine);
  let pdfBytes: Uint8Array;
  if (engine === 'systemBinary') {
    pdfBytes = await compileWithSystemBinary(options.source, options.outputPath);
  } else {
    pdfBytes = await compileWithWasm(options.source);
    if (pdfBytes.length === 0) {
      throw new Error('Typst WASM compilation produced an empty PDF buffer');
    }
    await writeFile(options.outputPath, pdfBytes);
  }
  const pageCount = await countPdfPages(pdfBytes);
  return { pdfBytes, pageCount, engine };
}

export async function countPdfPages(pdfBytes: Uint8Array): Promise<number> {
  if (pdfBytes.length === 0) {
    throw new Error('Cannot count pages of an empty PDF buffer');
  }
  const parser = new PDFParse({ data: Buffer.from(pdfBytes) });
  try {
    const result = await parser.getText();
    return result.total;
  } finally {
    await parser.destroy();
  }
}

export async function compileWithinPageLimit(options: PageLimitCompileOptions): Promise<PageLimitCompileResult> {
  const maxPages = options.maxPages ?? defaultMaxPages;
  const maxReductionAttempts = options.maxReductionAttempts ?? defaultMaxReductionAttempts;
  let currentSource = options.source;
  let reductionAttempts = 0;
  while (true) {
    const compiled = await compileTypstToPdf({ source: currentSource, outputPath: options.outputPath });
    if (compiled.pageCount <= maxPages) {
      return { ...compiled, reductionAttempts };
    }
    if (reductionAttempts >= maxReductionAttempts) {
      throw new Error(
        `Typst PDF is ${compiled.pageCount} pages, exceeding the ${maxPages}-page limit after ${maxReductionAttempts} reduction attempts`,
      );
    }
    currentSource = await options.reduceTextDensity({
      source: currentSource,
      pageCount: compiled.pageCount,
    });
    reductionAttempts += 1;
  }
}
