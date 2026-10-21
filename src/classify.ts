// Deterministic risk classifier (SPEC 6.1): runs on the final tree diff,
// follows renames (both paths checked), scans added content. It routes and
// labels risk; it never approves and never merges.
export interface ChangedFile {
  path: string;
  status: string; // git name-status letter: A, M, D, R, ...
}

export interface Classification {
  level: "light" | "normal" | "high";
  labels: string[];
  sensitivePaths: string[];
  reasons: string[];
}

const SENSITIVE_PREFIXES = [".github/", "secrets/", "auth/"];
const SENSITIVE_FILES = new Set(["docs/SPEC.md", "docs/PLAN.md", "src/classify.ts"]);
const SECRET_FILE = /(^|\/)(\.env[^/]*|[^/]*\.(pem|key|p12))$/;
const LOCKFILES = new Set([
  "package-lock.json",
  "bun.lock",
  "bun.lockb",
  "pnpm-lock.yaml",
  "yarn.lock",
  "Cargo.lock",
  "go.sum",
  "poetry.lock",
]);
const BINARY_EXT = /\.(png|jpe?g|gif|ico|zip|tar|gz|wasm|exe|dll|so|dylib|bin|pdf)$/i;
const SECRET_CONTENT =
  /(-----BEGIN [A-Z ]*PRIVATE KEY-----|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}|sk-or-[A-Za-z0-9-]{10,}|(api[_-]?key|client[_-]?secret|password|passwd)\s*[:=]\s*["']?[^\s"']{8,})/;

function isSensitive(path: string): boolean {
  return (
    SENSITIVE_PREFIXES.some((prefix) => path.startsWith(prefix)) ||
    SENSITIVE_FILES.has(path) ||
    SECRET_FILE.test(path) ||
    /(^|\/)(Dockerfile|docker-compose[^/]*|wrangler[^/]*|Caddyfile)$/.test(path)
  );
}

export function classify(files: ChangedFile[], diff: string): Classification {
  const labels = new Set<string>();
  const reasons: string[] = [];
  const sensitivePaths: string[] = [];
  for (const file of files) {
    if (isSensitive(file.path)) {
      sensitivePaths.push(file.path);
      labels.add("sensitive-path");
    }
    const base = file.path.split("/").pop() ?? file.path;
    if (LOCKFILES.has(base)) {
      labels.add("lockfile");
      reasons.push(`lockfile changed: ${file.path}`);
    }
    if (BINARY_EXT.test(file.path)) {
      labels.add("binary");
      reasons.push(`binary file changed: ${file.path}`);
    }
  }
  if (diff.includes("Binary files")) labels.add("binary");
  const addedLines = diff
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"));
  if (addedLines.some((line) => SECRET_CONTENT.test(line))) {
    labels.add("secret-like-content");
    reasons.push("added content matches a secret-like pattern");
  }
  if (sensitivePaths.length > 0) {
    reasons.push(`sensitive paths need CODEOWNERS approval: ${sensitivePaths.join(", ")}`);
  }
  const docsOnly =
    files.length > 0 && files.every((file) => file.path.endsWith(".md")) && sensitivePaths.length === 0;
  if (docsOnly) labels.add("docs-only");
  const level: Classification["level"] = labels.has("sensitive-path") || labels.has("secret-like-content")
    ? "high"
    : docsOnly
      ? "light"
      : "normal";
  if (reasons.length === 0) reasons.push(`no sensitive signals; ${files.length} file(s) changed`);
  return { level, labels: [...labels], sensitivePaths, reasons };
}
