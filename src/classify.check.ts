// Self-check for the deterministic classifier: npm run check:classify
import assert from "node:assert";
import { classify } from "./classify.js";

const docs = classify([{ path: "docs/NOTES.md", status: "A" }], "+hello\n");
assert.equal(docs.level, "light");
assert.ok(docs.labels.includes("docs-only"));

const spec = classify([{ path: "docs/SPEC.md", status: "M" }], "+text\n");
assert.equal(spec.level, "high");
assert.ok(spec.sensitivePaths.includes("docs/SPEC.md"));

const ci = classify([{ path: ".github/workflows/ci.yml", status: "M" }], "+run: x\n");
assert.equal(ci.level, "high");

const secret = classify([{ path: "src/app.ts", status: "M" }], '+const api_key = "abcdef123456";\n');
assert.equal(secret.level, "high");
assert.ok(secret.labels.includes("secret-like-content"));

const lock = classify([{ path: "package-lock.json", status: "M" }], "+{}\n");
assert.equal(lock.level, "normal");
assert.ok(lock.labels.includes("lockfile"));

const code = classify([{ path: "src/app.ts", status: "M" }], "+export const x = 1;\n");
assert.equal(code.level, "normal");
assert.deepEqual(code.labels, []);

console.log("classify checks passed");
