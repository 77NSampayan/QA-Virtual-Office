/**
 * Local-only classification of tool targets. Runs inside the forwarder; only the resulting
 * category leaves the hook process — never the path or command itself.
 */
import type { CommandCategory, FileCategory } from './events.ts';

const TEST_PATH_PATTERNS: RegExp[] = [
  /(^|[\\/])(tests?|__tests__|specs?|e2e|cypress|playwright|testcases?|test-cases?)[\\/]/i,
  /\.(spec|test|e2e|cy)\.[cm]?[jt]sx?$/i,
  /(^|[\\/])test_[^\\/]*\.py$/i,
  /_test\.(py|go)$/i,
  /(^|[\\/])conftest\.py$/i,
  /\.robot$/i,
  /\.resource$/i,
  /Tests?\.(java|cs|kt)$/,
  /\.feature$/i,
  /test[-_ ]?(cases?|scenarios?|plan)[^\\/]*\.(md|csv|xlsx?|json|ya?ml|txt)$/i,
];

const DOC_EXT = /\.(md|mdx|txt|rst|adoc|docx?|pdf|rtf|odt)$/i;
const CONFIG_PATTERNS: RegExp[] = [
  /(^|[\\/])package(-lock)?\.json$/i,
  /\.config\.[cm]?[jt]s$/i,
  /\.(json|jsonc|ya?ml|toml|ini|cfg|conf|properties|xml|env\.example)$/i,
  /(^|[\\/])(dockerfile|makefile|\.editorconfig|\.gitignore)$/i,
];
const SOURCE_EXT =
  /\.([cm]?[jt]sx?|py|java|kt|cs|go|rs|rb|php|swift|c|cc|cpp|h|hpp|scala|sql|sh|ps1|psm1|bat|cmd|vue|svelte|html?|css|scss|less)$/i;

export function classifyFile(filePath: unknown): FileCategory | undefined {
  if (typeof filePath !== 'string' || filePath.length === 0 || filePath.length > 4096) {
    return undefined;
  }
  if (TEST_PATH_PATTERNS.some((re) => re.test(filePath))) return 'test';
  if (DOC_EXT.test(filePath)) return 'doc';
  if (CONFIG_PATTERNS.some((re) => re.test(filePath))) return 'config';
  if (SOURCE_EXT.test(filePath)) return 'source';
  return 'other';
}

const TEST_RUN_RE = new RegExp(
  [
    String.raw`\bplaywright\s+test\b`,
    String.raw`\bpytest\b`,
    String.raw`\bpy\.test\b`,
    String.raw`\bpython\d?(\.exe)?\s+-m\s+(pytest|unittest|robot)\b`,
    String.raw`(^|[\s;&|])robot(\.exe)?\s`,
    String.raw`\bpabot\b`,
    String.raw`\bvitest\b`,
    String.raw`\bjest\b`,
    String.raw`\bmocha\b`,
    String.raw`\bcypress\s+run\b`,
    String.raw`\bmvnw?(\.cmd)?\s+(\S+\s+)*(test|verify)\b`,
    String.raw`\bgradlew?(\.bat)?\s+(\S+\s+)*test\b`,
    String.raw`\bdotnet\s+test\b`,
    String.raw`\bgo\s+test\b`,
    String.raw`\bcargo\s+test\b`,
    String.raw`\b(npm|pnpm|yarn|bun)\s+(run\s+)?(test|e2e|test:\S+)\b`,
    String.raw`\bnewman\s+run\b`,
  ].join('|'),
  'i',
);
const INSTALL_RE =
  /\b(npm\s+(i|install|ci|add)|pnpm\s+(i|install|add)|yarn\s+(add|install)|pip3?\s+install|poetry\s+(add|install)|uv\s+(add|pip\s+install|sync)|mvnw?\s+(\S+\s+)*install\b)/i;
const BUILD_RE =
  /\b((npm|pnpm|yarn|bun)\s+(run\s+)?build\b|tsc\b|vite\s+build|mvnw?\s+(\S+\s+)*(package|compile)\b|gradlew?\s+(\S+\s+)*(build|assemble)\b|dotnet\s+build\b|make\b|msbuild\b|cargo\s+build\b|go\s+build\b)/i;
const GIT_RE = /(^|[\s;&|(])git(\.exe)?\s/i;

export function classifyCommand(command: unknown): CommandCategory | undefined {
  if (typeof command !== 'string' || command.length === 0) return undefined;
  const cmd = command.slice(0, 8192);
  if (TEST_RUN_RE.test(cmd)) return 'test_run';
  if (INSTALL_RE.test(cmd)) return 'install';
  if (BUILD_RE.test(cmd)) return 'build';
  if (GIT_RE.test(cmd)) return 'git';
  return 'other';
}

export const COMMAND_TOOLS = ['Bash', 'PowerShell'] as const;
