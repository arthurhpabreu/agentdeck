import fs from "node:fs";
import assert from "node:assert/strict";
import ts from "typescript";

const locales = ["en-US", "pt-BR", "es-ES"];
const dictionaries = locales.map(locale => JSON.parse(fs.readFileSync(`src/i18n/locales/${locale}.json`, "utf8")));
const keys = Object.keys(dictionaries[0]).sort();
const placeholders = value => [...value.matchAll(/\{\{(.*?)\}\}/g)].map(match => match[1]).sort();
for (const [index, dictionary] of dictionaries.entries()) {
  assert.deepEqual(Object.keys(dictionary).sort(), keys, `Missing translation in ${locales[index]}`);
  for (const key of keys) {
    assert.ok(dictionary[key].trim(), `${locales[index]}: empty ${key}`);
    assert.deepEqual(placeholders(dictionary[key]), placeholders(dictionaries[0][key]), `${locales[index]}: interpolation mismatch in ${key}`);
    assert.ok(!/[\u4e00-\u9fff\ufffd]/.test(dictionary[key]), `${locales[index]}: invalid translation ${key}`);
  }
}
function scan(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) { scan(path); continue; }
    if (!/\.tsx?$/.test(path)) continue;
    const ast = ts.createSourceFile(path, fs.readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
    function visit(node) {
      if (ts.isCallExpression(node) && /(^|\.)t$/.test(node.expression.getText(ast)) && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
        assert.ok(node.arguments[0].text in dictionaries[0], `${path}: missing key ${node.arguments[0].text}`);
      }
      if (ts.isJsxText(node) && /[a-zA-Z]{2}/.test(node.text.trim())) {
        assert.ok(["Agentdeck", "KB", "px"].includes(node.text.trim()), `${path}: hardcoded UI text ${node.text.trim()}`);
      }
      ts.forEachChild(node, visit);
    }
    visit(ast);
  }
}
scan("src");
function scanNative(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) { scanNative(path); continue; }
    if (!path.endsWith(".rs")) continue;
    const source = fs.readFileSync(path, "utf8");
    for (const match of source.matchAll(/"(native\.[a-zA-Z]+)"/g)) {
      assert.ok(match[1] in dictionaries[0], `${path}: missing native key ${match[1]}`);
    }
  }
}
scanNative("src-tauri/src");
console.log(`Validated ${keys.length} keys in EN/PT/ES, interpolation placeholders and static UI references.`);
