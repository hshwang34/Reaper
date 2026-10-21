// Brand guard: user-facing strings anywhere in web/src (viewer page, setup,
// studio, dashboard, shared features) must not contain the jargon in
// docs/product/BRAND.md §8. The list has ONE home (the fenced block in that
// file); this test parses it. Identifiers, comments, import paths and
// type-only strings are exempt — only real string literals / template text /
// JSX text are scanned. The only other exemptions are named below:
//   · OBS menu names, when QUOTED (BRAND §3) — e.g. “WebSocket Server Settings”
//   · route paths ("/ledger") — URLs, not copy
//   · the router engine's internals (log lines + job-end reason codes; no JSX,
//     nothing on screen — whatever reaches a screen goes through friendlyError)

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

/** The OBS menu names a streamer sees in OBS, which a manual "do it yourself"
 *  instruction may quote (BRAND §3). Exempt ONLY inside straight or curly
 *  quotes; the one multi-step path the setup step quotes is allowed whole. */
const OBS_NAMES = ["Browser", "WebSocket Server Settings", "Virtual Camera", "Sources", "Program", "Preview"];
const OBS_PATHS = ["Tools → WebSocket Server Settings → Enable"];
export function withoutQuotedObsNames(text: string): string {
  const names = [...OBS_PATHS, ...OBS_NAMES].map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return text.replace(new RegExp(`(["“])(?:${names.join("|")})(["”])`, "g"), "$1$2");
}

/** Router engine files whose string literals are log lines and job-end reason
 *  codes (no JSX). They never render; see the header note. */
const ENGINE_INTERNALS = ["router/stateMachine.ts", "router/decartSession.ts", "router/frameGuard.ts"];

/** "/ledger", "/moderation?limit=" — API routes, not sentences. */
const isRoute = (t: string) => /^\/[\w/?=&.-]*$/.test(t.trim());

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

test("quoted OBS menu names are exempt; the same words unquoted are not", () => {
  const terms = ["websocket", "browser source"];
  const hit = (t: string) => terms.some((x) => new RegExp(`(?<![\\w-])${x}(?![\\w-])`, "i").test(withoutQuotedObsNames(t)));
  assert.equal(hit('Or do it yourself in OBS: “Tools → WebSocket Server Settings → Enable”.'), false);
  assert.equal(hit('Open "WebSocket Server Settings" in OBS'), false);
  assert.equal(hit("add a “Browser” source in OBS"), false);
  assert.equal(hit("Turn on the WebSocket server"), true);
  assert.equal(hit("add a Browser source in OBS"), true);
});

test("web/src copy has no jargon from BRAND.md §8", () => {
  const terms = blocklist(readFileSync(join(root, "docs/product/BRAND.md"), "utf8"));
  const bad: string[] = [];
  for (const f of filesIn(webSrc)) {
    const rel = relative(webSrc, f).split("\\").join("/");
    if (ENGINE_INTERNALS.includes(rel)) continue;
    for (const { text, line } of userFacingStrings(readFileSync(f, "utf8"), f)) {
      if (isRoute(text)) continue;
      const scanned = withoutQuotedObsNames(text);
      for (const t of terms) {
        const re = new RegExp(`(?<![\\w-])${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`, "i");
        if (re.test(scanned)) bad.push(`${relative(root, f)}:${line} "${t}" in ${JSON.stringify(text.trim().slice(0, 80))}`);
      }
    }
  }
  assert.deepEqual(bad, [], "rewrite these (docs/product/BRAND.md §3 and §8)");
});
