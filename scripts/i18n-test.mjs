// scripts/i18n-test.mjs — eight-language dictionary regression for client.js.
// Mirrors the host's i18n contract (see AGENTS.md): zh/en/ja/es/fr/de/ru/pt,
// identical key sets across languages, matching placeholders, no empty values.
// Run from the package root: node scripts/i18n-test.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(path.join(root, 'client.js'), 'utf8')

// Extract the dictionary block: from `const en = {` through `const fallback`.
const dictStart = source.indexOf('    const en = {')
const fallbackAt = source.indexOf('    const fallback =', dictStart)
const dictEnd = source.indexOf('\n', fallbackAt)
assert.ok(dictStart >= 0 && fallbackAt > dictStart && dictEnd > fallbackAt, 'dictionary markers exist in client.js')

const runtime = Function(`"use strict";
${source.slice(dictStart, dictEnd)}
return { en, zh, ja, es, fr, de, ru, pt, fallback }
`)()
const dicts = { zh: runtime.zh, en: runtime.en, ja: runtime.ja, es: runtime.es, fr: runtime.fr, de: runtime.de, ru: runtime.ru, pt: runtime.pt }

const languages = ['zh', 'en', 'ja', 'es', 'fr', 'de', 'ru', 'pt']
assert.deepEqual(Object.keys(runtime).filter((k) => k !== 'fallback'), ['en', 'zh', 'ja', 'es', 'fr', 'de', 'ru', 'pt'], 'all eight DSH dictionaries are defined')

const reference = Object.keys(dicts.en).sort()
const placeholders = (value) => (value.match(/\{\{[^{}]+\}\}|\{[^{}]+\}/g) || []).sort()
for (const lang of languages) {
  assert.deepEqual(Object.keys(dicts[lang]).sort(), reference, `${lang}: key set matches en`)
  for (const key of reference) {
    const value = dicts[lang][key]
    assert.equal(typeof value, 'string', `${lang}:${key} is a string`)
    assert.ok(value.trim(), `${lang}:${key} is not empty`)
    assert.deepEqual(placeholders(value), placeholders(dicts.en[key]), `${lang}:${key} placeholders match en`)
  }
}

// Fallback chain contract: en first, then zh, then the raw key.
assert.equal(runtime.fallback('notice.saved'), dicts.en['notice.saved'], 'fallback resolves through en')
assert.equal(runtime.fallback('no.such.key'), 'no.such.key', 'unknown key falls through to the key itself')

// The panel must register the full dictionary and subscribe to locale changes.
assert.ok(source.includes('ctx.locale.register(NS, DICT)'), 'client registers the eight-language DICT')
assert.ok(source.includes('localeRuntime.subscribe'), 'panel subscribes to locale changes for re-render')
assert.ok(!/ctx\.locale\.register\(NS, \{ zh, en \}\)/.test(source), 'legacy two-language registration is gone')

console.log(`i18n-test: ${reference.length} keys × ${languages.length} languages OK`)
