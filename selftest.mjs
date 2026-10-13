/** Local self-test for the host half with a mocked ctx. */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { apply } from './index.js'

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dwm-test-'))
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dwm-home-'))

function makeCtx(config) {
  const routes = new Map()
  const listeners = new Map()
  const tools = new Map()
  const ctx = {
    workspaceRegistry: {
      get: (id) => (id === 'ws-1' ? { id: 'ws-1', path: tmp, title: 'test' } : undefined),
      resolveByPath: async (p) => (path.resolve(p) === tmp ? { id: 'ws-1', path: tmp } : undefined),
    },
    sessions: { get: () => undefined },
    systemPrompt: {},
    connection: {
      fetch: {
        register: (route) => {
          routes.set(route.path, route)
          return async () => routes.delete(route.path)
        },
      },
    },
    tools: {
      register: (definition) => {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    on: (event, listener) => listeners.set(event, listener),
    effect: (fn) => { fn() },
  }
  apply(ctx, config)
  return { routes, listeners, tools }
}

const key = `${path.basename(tmp)}-${crypto.createHash('sha256').update(path.resolve(tmp)).digest('hex').slice(0, 8)}`
const homeDir = path.join(home, key)

// === home storage (default) ===
const app = makeCtx({ storageDir: home })
assert.equal(app.routes.size, 4)
assert.ok(app.tools.has('save_workspace_memory'), 'memory tool registered')
assert.ok(app.listeners.has('agent/created'), 'agent/created listener registered')

const call = (p, request) => app.routes.get(p).fetch(request)
const env = async (r) => ({ status: r.status, body: await r.json() })

// list on a workspace without memories: empty, home-mode display path
let out = await env(await call('/api/workspace-memory/list', new Request('http://h/api/workspace-memory/list?workspaceId=ws-1')))
assert.deepEqual(out.body, { ok: true, value: { directory: homeDir, storage: 'home', files: [] } })

// unknown workspace
out = await env(await call('/api/workspace-memory/list', new Request('http://h/api/workspace-memory/list?workspaceId=nope')))
assert.equal(out.status, 404)
assert.equal(out.body.error.code, 'workspace-memory/unknown-workspace')

// write + list + read
const write = (name, content) => call('/api/workspace-memory/write', new Request('http://h/api/workspace-memory/write', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ workspaceId: 'ws-1', name, content }),
}))
out = await env(await write('architecture.md', '# Decisions\n\n- use DSH plugins\n'))
assert.equal(out.status, 200, JSON.stringify(out))
assert.equal(out.body.value.name, 'architecture.md')
// the file landed OUTSIDE the workspace, in the DSH home store
assert.equal(await fs.readFile(path.join(homeDir, 'architecture.md'), 'utf8'), '# Decisions\n\n- use DSH plugins\n')

out = await env(await call('/api/workspace-memory/list', new Request('http://h/api/workspace-memory/list?workspaceId=ws-1')))
assert.equal(out.body.value.files.length, 1)
assert.equal(out.body.value.files[0].name, 'architecture.md')

out = await env(await call('/api/workspace-memory/read', new Request('http://h/api/workspace-memory/read?workspaceId=ws-1&name=architecture.md')))
assert.equal(out.body.value.content, '# Decisions\n\n- use DSH plugins\n')

// invalid names are rejected
for (const bad of ['../x.md', 'a/b.md', '.hidden.md', 'noext', 'has space.md', 'a..b.md']) {
  out = await env(await write(bad, 'x'))
  assert.equal(out.status, 400, bad)
  assert.equal(out.body.error.code, 'workspace-memory/invalid-name', bad)
}

// --- prompt injection: agent/created registers a section rendering the files ---
let sectionText
const agent = {
  id: 'session-1',
  session: { header: { cwd: tmp } },
  ctx: {
    systemPrompt: {
      section: (section) => {
        sectionText = section.text
        return () => {}
      },
    },
  },
}
app.listeners.get('agent/created')({ agent })
await new Promise((resolve) => setImmediate(resolve)) // let resolveRoot settle
await new Promise((resolve) => setImmediate(resolve))
const rendered = sectionText()
assert.match(rendered, /## Workspace Memory/)
assert.match(rendered, /OUTSIDE the project tree/)
assert.match(rendered, /architecture\.md/)
assert.match(rendered, /use DSH plugins/)

// --- the agent tool persists a memory and the section picks it up ---
const tool = app.tools.get('save_workspace_memory')
const value = await tool.execute(
  { name: 'conventions', content: '# Conventions\n\n- pnpm only\n' },
  { agent },
)
assert.match(String(value), /Saved workspace memory "conventions\.md"/)
assert.equal(await fs.readFile(path.join(homeDir, 'conventions.md'), 'utf8'), '# Conventions\n\n- pnpm only\n')
const renderedAfter = sectionText()
assert.match(renderedAfter, /conventions\.md/)
assert.match(renderedAfter, /pnpm only/)

// tool validation failures
await assert.rejects(() => tool.execute({ name: 'a/b', content: 'x' }, { agent }), /Invalid memory file name/)
await assert.rejects(() => tool.execute({ name: 'ok', content: 42 }, { agent }), /must be a Markdown string/)

// delete + read-after-delete
out = await env(await call('/api/workspace-memory/delete', new Request('http://h/api/workspace-memory/delete', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ workspaceId: 'ws-1', name: 'architecture.md' }),
})))
assert.equal(out.body.value.deleted, true)
out = await env(await call('/api/workspace-memory/read', new Request('http://h/api/workspace-memory/read?workspaceId=ws-1&name=architecture.md')))
assert.equal(out.status, 404)

// === workspace storage mode ===
const appWs = makeCtx({ storage: 'workspace', directory: '.dsh/memory' })
const callWs = (p, request) => appWs.routes.get(p).fetch(request)
out = await env(await callWs('/api/workspace-memory/write', new Request('http://h/api/workspace-memory/write', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ workspaceId: 'ws-1', name: 'local.md', content: 'in-project' }),
})))
assert.equal(out.status, 200)
assert.equal(await fs.readFile(path.join(tmp, '.dsh/memory/local.md'), 'utf8'), 'in-project')
out = await env(await callWs('/api/workspace-memory/list', new Request('http://h/api/workspace-memory/list?workspaceId=ws-1')))
assert.equal(out.body.value.storage, 'workspace')
assert.equal(out.body.value.directory, '.dsh/memory')

// invalid storage mode throws at activation
assert.throws(() => makeCtx({ storage: 'elsewhere' }), /config\.storage must be/)

await fs.rm(tmp, { recursive: true, force: true })
await fs.rm(home, { recursive: true, force: true })
console.log('host self-test: all assertions passed')
