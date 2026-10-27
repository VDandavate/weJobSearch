// CLI argument parsing (Phase 7a seam, extracted from jobSearchCore.ts with
// zero behavior change). Every parse* function below keeps its exact original
// semantics, including quirks: `--flag value` never consumes the next token
// (the value token is revisited and skipped as a non-flag token), a value
// starting with `--` is ignored, bare boolean flags are recognized before
// value lookup (so even `--save=x` sets the flag, exactly as the original
// search parser did), and `--name=value` splits on the first `=`.
//
// The ten-plus duplicated `for` token loops collapsed into one shared
// scanner, scanCliTokens, which walks argv once and reports `--help`, bare
// boolean flags, and name/value options to per-parser callbacks. Parsers
// without flags pass no onFlag handler, which is a no-op.

import type { JobSpyAdapterRegistry } from '../scrapers/jobSpyAdapter';

export interface CliTokenHandlers {
  onHelp?: () => void;
  onFlag?: (name: string) => boolean;
  onOption?: (name: string, value: string) => void;
}

export function scanCliTokens(args: readonly string[], handlers: CliTokenHandlers): void {  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === '--help') {
      handlers.onHelp?.();
      continue;
    }
    if (!token.startsWith('--')) {
      continue;
    }
    const raw = token.slice(2);
    const equals = raw.indexOf('=');
    const name = equals === -1 ? raw : raw.slice(0, equals);
    if (handlers.onFlag?.(name) === true) {
      continue;
    }
    const value = equals === -1 ? args[index + 1] : raw.slice(equals + 1);
    if (value === undefined || value.startsWith('--')) {
      continue;
    }
    handlers.onOption?.(name, value);
  }
}

export interface ParsedGenerateArgs {
  company?: string;
  role?: string;
  variant?: string;
  dataRoot?: string;
  help?: boolean;
}

export interface ParsedPreviewResumeArgs {
  variant?: string;
  dataRoot?: string;
  help?: boolean;
}

export interface ParsedCoverLetterArgs {
  company?: string;
  role?: string;
  postingRequirements?: string[];
  postingHash?: string;
  dataRoot?: string;
  help?: boolean;
}

export interface ParsedOutreachArgs {
  contactId?: string;
  company?: string;
  role?: string;
  platform?: string;
  dataRoot?: string;
  help?: boolean;
}

export interface ParsedEvaluateArgs {
  jobUrl?: string;
  dataRoot?: string;
  registry?: JobSpyAdapterRegistry;
  help?: boolean;
}

export interface ParsedSearchArgs {
  keywords?: string;
  location?: string;
  dataRoot?: string;
  save?: boolean;
  remoteOnly?: boolean;
  minFit?: number;
  minSalary?: number;
  maxAgeDays?: number;
  radiusMiles?: number;
  registry?: JobSpyAdapterRegistry;
  help?: boolean;
}

export interface ParsedAddContactArgs {
  name?: string;
  company?: string;
  relationship?: string;
  linkedApplicationIds?: string;
  followUpDue?: string;
  dataRoot?: string;
  help?: boolean;
}

export interface ParsedReportArgs {
  format?: string;
  help?: boolean;
  noRedact?: boolean;
  output?: string;
  dataRoot?: string;
}

export interface ParsedReviewQueueArgs {
  dataRoot?: string;
  help?: boolean;
}

export interface ParsedInitArgs {
  repoRoot?: string;
  dataRoot?: string;
  help?: boolean;
}

export interface ParsedExportDataArgs {
  archivePath?: string;
  rootPath?: string;
  help?: boolean;
}

export interface ParsedImportDataArgs {
  archivePath?: string;
  rootPath?: string;
  help?: boolean;
}

export interface ParsedWipeProfileArgs {
  dataRoot?: string;
  noBackup?: boolean;
  force?: boolean;
  help?: boolean;
}

export interface ParsedPdfArgs {
  filePath?: string;
  dataRoot?: string;
  help?: boolean;
}

export interface ParsedConfirmAppArgs {
  company?: string;
  role?: string;
  notes?: string;
  postingHash?: string;
  dataRoot?: string;
  help?: boolean;
}

export interface ParsedDigestArgs {
  registry?: JobSpyAdapterRegistry;
  dataRoot?: string;
  help?: boolean;
}

export interface ParsedShowArgs {
  companyName?: string;
  roleTitle?: string;
  postingHash?: string;
  dataRoot?: string;
  help?: boolean;
}

export interface ParsedReviewArgs {
  companyName?: string;
  roleTitle?: string;
  postingHash?: string;
  dataRoot?: string;
  help?: boolean;
}

export interface ParsedUpdateStatusArgs {
  companyName?: string;
  roleTitle?: string;
  status?: string;
  notes?: string;
  postingHash?: string;
  dataRoot?: string;
  help?: boolean;
}

export function parseGenerateArgs(args: readonly string[]): ParsedGenerateArgs {
  const parsed: ParsedGenerateArgs = {};
  scanCliTokens(args, {
    onHelp: () => { parsed.help = true; },
    onOption: (name, value) => {
      switch (name) {
        case 'company': parsed.company = value; break;
        case 'role': parsed.role = value; break;
        case 'variant': parsed.variant = value; break;
        case 'dataRoot': parsed.dataRoot = value; break;
        default: break;
      }
    },
  });
  return parsed;
}

export function parseCoverLetterArgs(args: readonly string[]): ParsedCoverLetterArgs {
  const parsed: ParsedCoverLetterArgs = {};
  const postingRequirements: string[] = [];
  scanCliTokens(args, {
    onHelp: () => { parsed.help = true; },
    onOption: (name, value) => {
      switch (name) {
        case 'company': parsed.company = value; break;
        case 'role': parsed.role = value; break;
        case 'postingRequirements': postingRequirements.push(value); break;
        case 'postingHash': parsed.postingHash = value; break;
        case 'dataRoot': parsed.dataRoot = value; break;
        default: break;
      }
    },
  });
  if (postingRequirements.length > 0) {
    parsed.postingRequirements = postingRequirements.flatMap((value) =>
      value.split(',').map((requirement) => requirement.trim()).filter((requirement) => requirement.length > 0),
    );
  }
  return parsed;
}

export function parseEvaluateArgs(args: readonly string[]): ParsedEvaluateArgs {
  const parsed: ParsedEvaluateArgs = {};
  scanCliTokens(args, {
    onHelp: () => { parsed.help = true; },
    onOption: (name, value) => {
      switch (name) {
        case 'jobUrl': parsed.jobUrl = value; break;
        case 'dataRoot': parsed.dataRoot = value; break;
        default: break;
      }
    },
  });
  return parsed;
}

// Numeric CLI options fail fast on non-numeric input (B9): the parser is the
// only place that still sees the raw string, so it throws a usage error here.
// dispatchCli lets it propagate and main() maps it to exit 1 with the message.
function parseNumericOption(flag: string, value: string): number {
  const parsedValue = Number(value);
  if (!Number.isFinite(parsedValue)) {
    throw new Error(`Invalid ${flag} value '${value}': expected a finite number.`);
  }
  return parsedValue;
}
export function parseSearchArgs(args: readonly string[]): ParsedSearchArgs {
  const parsed: ParsedSearchArgs = {};
  scanCliTokens(args, {
    onHelp: () => { parsed.help = true; },
    onFlag: (name) => {
      if (name === 'save') { parsed.save = true; return true; }
      if (name === 'remoteOnly') { parsed.remoteOnly = true; return true; }
      return false;
    },
    onOption: (name, value) => {
      switch (name) {
        case 'keywords': parsed.keywords = value; break;
        case 'location': parsed.location = value; break;
        case 'dataRoot': parsed.dataRoot = value; break;
        case 'minFit': parsed.minFit = parseNumericOption('--minFit', value); break;
        case 'minSalary': parsed.minSalary = parseNumericOption('--minSalary', value); break;
        case 'maxAgeDays': parsed.maxAgeDays = parseNumericOption('--maxAgeDays', value); break;
        case 'radiusMiles': {
          const radiusValue = parseNumericOption('--radiusMiles', value);
          if (radiusValue <= 0) {
            throw new Error(`Invalid --radiusMiles value '${value}': must be a positive integer.`);
          }
          parsed.radiusMiles = radiusValue;
          break;
        }
        default: break;
      }
    },
  });
  return parsed;
}

export function parseOutreachArgs(args: readonly string[]): ParsedOutreachArgs {
  const parsed: ParsedOutreachArgs = {};
  scanCliTokens(args, {
    onHelp: () => { parsed.help = true; },
    onOption: (name, value) => {
      switch (name) {
        case 'contactId': parsed.contactId = value; break;
        case 'company': parsed.company = value; break;
        case 'role': parsed.role = value; break;
        case 'platform': parsed.platform = value; break;
        case 'dataRoot': parsed.dataRoot = value; break;
        default: break;
      }
    },
  });
  return parsed;
}

export function parseAddContactArgs(args: readonly string[]): ParsedAddContactArgs {
  const parsed: ParsedAddContactArgs = {};
  scanCliTokens(args, {
    onHelp: () => { parsed.help = true; },
    onOption: (name, value) => {
      switch (name) {
        case 'name': parsed.name = value; break;
        case 'company': parsed.company = value; break;
        case 'relationship': parsed.relationship = value; break;
        case 'linkedApplicationIds': parsed.linkedApplicationIds = value; break;
        case 'followUpDue': parsed.followUpDue = value; break;
        case 'dataRoot': parsed.dataRoot = value; break;
        default: break;
      }
    },
  });
  return parsed;
}

export function parseReportArgs(args: readonly string[]): ParsedReportArgs {
  const parsed: ParsedReportArgs = {};
  scanCliTokens(args, {
    onHelp: () => { parsed.help = true; },
    onFlag: (name) => {
      if (name === 'noRedact') { parsed.noRedact = true; return true; }
      return false;
    },
    onOption: (name, value) => {
      switch (name) {
        case 'format': parsed.format = value; break;
        case 'noRedact': parsed.noRedact = true; break;
        case 'output': parsed.output = value; break;
        case 'dataRoot': parsed.dataRoot = value; break;
        default: break;
      }
    },
  });
  return parsed;
}

export function parseReviewQueueArgs(args: readonly string[]): ParsedReviewQueueArgs {
  const parsed: ParsedReviewQueueArgs = {};
  scanCliTokens(args, {
    onHelp: () => { parsed.help = true; },
    onOption: (name, value) => {
      switch (name) {
        case 'dataRoot': parsed.dataRoot = value; break;
        default: break;
      }
    },
  });
  return parsed;
}

export interface ParsedValidateArgs {
  dataRoot?: string;
  help?: boolean;
}

export function parseValidateArgs(args: readonly string[]): ParsedValidateArgs {
  const parsed: ParsedValidateArgs = {};
  scanCliTokens(args, {
    onHelp: () => { parsed.help = true; },
    onOption: (name, value) => {
      switch (name) {
        case 'dataRoot': parsed.dataRoot = value; break;
        default: break;
      }
    },
  });
  return parsed;
}

export function parseInitArgs(args: readonly string[]): ParsedInitArgs {
  const parsed: ParsedInitArgs = {};
  scanCliTokens(args, {
    onHelp: () => { parsed.help = true; },
    onOption: (name, value) => {
      switch (name) {
        case 'repoRoot': parsed.repoRoot = value; break;
        case 'dataRoot': parsed.dataRoot = value; break;
        default: break;
      }
    },
  });
  return parsed;
}

export function parseExportDataArgs(args: readonly string[]): ParsedExportDataArgs {
  const parsed: ParsedExportDataArgs = {};
  scanCliTokens(args, {
    onHelp: () => { parsed.help = true; },
    onOption: (name, value) => {
      switch (name) {
        case 'archivePath': parsed.archivePath = value; break;
        case 'rootPath': parsed.rootPath = value; break;
        default: break;
      }
    },
  });
  return parsed;
}

export function parseImportDataArgs(args: readonly string[]): ParsedImportDataArgs {
  const parsed: ParsedImportDataArgs = {};
  scanCliTokens(args, {
    onHelp: () => { parsed.help = true; },
    onOption: (name, value) => {
      switch (name) {
        case 'archivePath': parsed.archivePath = value; break;
        case 'rootPath': parsed.rootPath = value; break;
        default: break;
      }
    },
  });
  return parsed;
}

export function parseWipeProfileArgs(args: readonly string[]): ParsedWipeProfileArgs {
  const parsed: ParsedWipeProfileArgs = {};
  scanCliTokens(args, {
    onHelp: () => { parsed.help = true; },
    onFlag: (name) => {
      if (name === 'noBackup') { parsed.noBackup = true; return true; }
      if (name === 'force') { parsed.force = true; return true; }
      return false;
    },
    onOption: (name, value) => {
      switch (name) {
        case 'dataRoot': parsed.dataRoot = value; break;
        default: break;
      }
    },
  });
  return parsed;
}

export function parsePreviewResumeArgs(args: readonly string[]): ParsedPreviewResumeArgs {
  const parsed: ParsedPreviewResumeArgs = {};
  scanCliTokens(args, {
    onHelp: () => { parsed.help = true; },
    onOption: (name, value) => {
      switch (name) {
        case 'variant': parsed.variant = value; break;
        case 'dataRoot': parsed.dataRoot = value; break;
        default: break;
      }
    },
  });
  return parsed;
}

export function parseDigestArgs(args: readonly string[]): ParsedDigestArgs {
  const parsed: ParsedDigestArgs = {};
  scanCliTokens(args, {
    onHelp: () => { parsed.help = true; },
    onOption: (name, value) => {
      switch (name) {
        case 'dataRoot': parsed.dataRoot = value; break;
        default: break;
      }
    },
  });
  return parsed;
}

export function parseShowArgs(args: readonly string[]): ParsedShowArgs {
  const parsed: ParsedShowArgs = {};
  scanCliTokens(args, {
    onHelp: () => { parsed.help = true; },
    onOption: (name, value) => {
      switch (name) {
        case 'company': parsed.companyName = value; break;
        case 'role': parsed.roleTitle = value; break;
        case 'postingHash': parsed.postingHash = value; break;
        case 'dataRoot': parsed.dataRoot = value; break;
        default: break;
      }
    },
  });
  return parsed;
}

export function parseReviewArgs(args: readonly string[]): ParsedReviewArgs {
  const parsed: ParsedReviewArgs = {};
  scanCliTokens(args, {
    onHelp: () => { parsed.help = true; },
    onOption: (name, value) => {
      switch (name) {
        case 'company': parsed.companyName = value; break;
        case 'role': parsed.roleTitle = value; break;
        case 'postingHash': parsed.postingHash = value; break;
        case 'dataRoot': parsed.dataRoot = value; break;
        default: break;
      }
    },
  });
  return parsed;
}

export function parseUpdateStatusArgs(args: readonly string[]): ParsedUpdateStatusArgs {
  const parsed: ParsedUpdateStatusArgs = {};
  scanCliTokens(args, {
    onHelp: () => { parsed.help = true; },
    onOption: (name, value) => {
      switch (name) {
        case 'company': parsed.companyName = value; break;
        case 'role': parsed.roleTitle = value; break;
        case 'status': parsed.status = value; break;
        case 'notes': parsed.notes = value; break;
        case 'postingHash': parsed.postingHash = value; break;
        case 'dataRoot': parsed.dataRoot = value; break;
        default: break;
      }
    },
  });
  return parsed;
}

export function parsePdfArgs(args: readonly string[]): ParsedPdfArgs {
  const parsed: ParsedPdfArgs = {};
  scanCliTokens(args, {
    onHelp: () => { parsed.help = true; },
    onOption: (name, value) => {
      switch (name) {
        case 'filePath': parsed.filePath = value; break;
        case 'dataRoot': parsed.dataRoot = value; break;
        default: break;
      }
    },
  });
  return parsed;
}

export function parseConfirmAppArgs(args: readonly string[]): ParsedConfirmAppArgs {
  const parsed: ParsedConfirmAppArgs = {};
  scanCliTokens(args, {
    onHelp: () => { parsed.help = true; },
    onOption: (name, value) => {
      switch (name) {
        case 'company': parsed.company = value; break;
        case 'role': parsed.role = value; break;
        case 'notes': parsed.notes = value; break;
        case 'postingHash': parsed.postingHash = value; break;
        case 'dataRoot': parsed.dataRoot = value; break;
        default: break;
      }
    },
  });
  return parsed;
}
