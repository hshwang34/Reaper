// Brand guard for the desktop shell: what the tray, the sign-in page and the
// errors that reach the wizard say must not contain the jargon in
// docs/product/BRAND.md §8. Same blocklist (parsed from that file) and same
// idea as web/test/copy.test.ts; the ~30-line scanner is duplicated rather than
// shared because the two packages have no common test-utils home. Log lines
// (log()/warn()) are for developers and are exempt; comments and imports
// never count.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const main = join(here, "..", "src", "main");

function blocklist(md: string): string[] {
  const section = md.slice(md.indexOf("## 8. Jargon blocklist"));
  const m = section.match(/```\n([\s\S]*?)\n```/);
  assert.ok(m, "BRAND.md §8 must contain a fenced blocklist");
  return m[1]!.split("\n").map((l) => l.trim().toLowerCase()).filter(Boolean);
}

/** String literals a person could read — not imports, types, or log()/warn() arguments. */
function userFacingStrings(src: string, fileName: string): Array<{ text: string; line: number }> {
  const sf = ts.createSourceFile(fileName, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: Array<{ text: string; line: number }> = [];
  const visit = (n: ts.Node) => {
    if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n) || ts.isTypeNode(n)) return;
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && ["log", "warn"].includes(n.expression.text)) return;
    const isText =
      ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n);
    if (isText) out.push({ text: n.text, line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1 });
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

test("desktop shell copy has no jargon from BRAND.md §8", () => {
  const terms = blocklist(readFileSync(join(root, "docs/product/BRAND.md"), "utf8"));
  const bad: string[] = [];
  for (const f of ["main.ts", "signIn.ts", "obsDiscovery.ts", "cloudLink.ts", "trayCopy.ts"]) {
    const file = join(main, f);
    for (const { text, line } of userFacingStrings(readFileSync(file, "utf8"), file)) {
      for (const t of terms) {
        const re = new RegExp(`(?<![\\w-])${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`, "i");
        if (re.test(text)) bad.push(`${f}:${line} "${t}" in ${JSON.stringify(text.trim().slice(0, 80))}`);
      }
    }
  }
  assert.deepEqual(bad, [], "rewrite these (docs/product/BRAND.md §3 and §8)");
});
