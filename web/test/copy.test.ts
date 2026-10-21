// Brand guard: user-facing strings in the viewer portal must not contain the
// jargon in docs/product/BRAND.md §8. The list has ONE home (the fenced block
// in that file); this test parses it. Identifiers, comments, import paths and
// type-only strings are exempt — only real string literals / template text /
// JSX text are scanned. The scope widens as each surface is rewritten.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const webSrc = join(root, "web", "src");

/** BRAND.md §8: the first fenced block under the "Jargon blocklist" heading. */
export function blocklist(md: string): string[] {
  const section = md.slice(md.indexOf("## 8. Jargon blocklist"));
  const m = section.match(/```\n([\s\S]*?)\n```/);
  assert.ok(m, "BRAND.md §8 must contain a fenced blocklist");
  return m[1]!.split("\n").map((l) => l.trim().toLowerCase()).filter(Boolean);
}

function filesIn(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? filesIn(p) : /\.tsx?$/.test(p) ? [p] : [];
  });
}

/** Every piece of text a viewer could read in `src`, with its line. */
export function userFacingStrings(src: string, fileName: string): Array<{ text: string; line: number }> {
  const sf = ts.createSourceFile(fileName, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: Array<{ text: string; line: number }> = [];
  const add = (node: ts.Node, text: string) =>
    out.push({ text, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1 });
  const visit = (n: ts.Node) => {
    // Module specifiers and type positions are not copy.
    if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n) || ts.isTypeNode(n)) return;
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) add(n, n.text);
    else if (ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) add(n, n.text);
    else if (ts.isJsxText(n)) add(n, n.text);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

test("blocklist parser reads BRAND.md", () => {
  const terms = blocklist(readFileSync(join(root, "docs/product/BRAND.md"), "utf8"));
  assert.ok(terms.includes("preset") && terms.includes("decart") && terms.length >= 10);
});

test("scanner sees JSX text and literals but not comments or imports", () => {
  const hits = userFacingStrings(
    `import x from "../preset/mint.js";\n// preset in a comment\nconst a = "hello"; const b = <p>world {\`tpl \${a}\`}</p>;`,
    "x.tsx",
  ).map((h) => h.text.trim());
  assert.deepEqual(hits.filter(Boolean), ["hello", "world", "tpl"]);
});

test("viewer portal copy has no jargon from BRAND.md §8", () => {
  const terms = blocklist(readFileSync(join(root, "docs/product/BRAND.md"), "utf8"));
  const files = [...filesIn(join(webSrc, "portal")), join(webSrc, "features", "EffectArt.tsx")];
  const bad: string[] = [];
  for (const f of files) {
    for (const { text, line } of userFacingStrings(readFileSync(f, "utf8"), f)) {
      for (const t of terms) {
        const re = new RegExp(`(?<![\\w-])${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`, "i");
        if (re.test(text)) bad.push(`${relative(root, f)}:${line} "${t}" in ${JSON.stringify(text.trim().slice(0, 80))}`);
      }
    }
  }
  assert.deepEqual(bad, [], "rewrite these (docs/product/BRAND.md §3 and §8)");
});
