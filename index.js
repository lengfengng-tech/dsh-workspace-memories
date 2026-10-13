/**
 * Host half of the Workspace Memory bundle.
 *
 * Every workspace registered in the Harness workspace registry owns one
 * memory directory (`<workspace>/.dsh/memory` by default) holding Markdown
 * memory files that supplement project files such as AGENTS.md.
 *
 * Three contributions make the memory real:
 *
 * 1. Panel API — exact Fetch routes on Connection's shared `/api` channel so
 *    the browser panel can list, read, create, update, and delete the files:
 *      GET  /api/workspace-memory/list?workspaceId=<id>
 *      GET  /api/workspace-memory/read?workspaceId=<id>&name=<file>
 *      POST /api/workspace-memory/write   { workspaceId, name, content }
 *      POST /api/workspace-memory/delete  { workspaceId, name }
 * 2. Prompt injection — an `agent/created` listener registers a per-agent
 *    system-prompt section that renders the workspace's current memory files
 *    into every session running in that directory.
 * 3. Agent tool — `save_workspace_memory` lets the model persist a memory
 *    file itself when the user asks it to remember something.
 *
 * Route responses use one envelope: `{ ok: true, value }` or
 * `{ ok: false, error: { code, message } }`. File access is fenced to the
 * memory directory inside the named workspace; the browser cannot reach
 * arbitrary host paths.
 */

import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'

export const name = 'workspace-memory'
export const inject = ['connection', 'workspaceRegistry', 'systemPrompt', 'tools', 'sessions']

const ROUTE_PREFIX = '/api/workspace-memory'
const DEFAULT_DIRECTORY = '.dsh/memory'
const MAX_NAME_LENGTH = 100
const MAX_CONTENT_BYTES = 1024 * 1024
const PROMPT_MAX_FILES = 20
const PROMPT_MAX_FILE_CHARS = 32768
const PROMPT_SECTION_ORDER = 9800
const INVALID_NAME_CHARS = /[\s/\\:*?"<>|]/
const CONTROL_CHARS = /[\x00-\x1f\x7f]/

/** Plain JSON response helper. */
function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

function ok(value) {
  return json(200, { ok: true, value })
}

function fail(status, code, message) {
  return json(status, { ok: false, error: { code, message } })
}

export function apply(ctx, config = {}) {
  const directory = typeof config.directory === 'string' && config.directory.trim() !== ''
    ? config.directory.trim()
    : DEFAULT_DIRECTORY
  if (path.isAbsolute(directory) || directory.split(/[/\\]/).includes('..')) {
    throw new Error(`workspace-memory: config.directory must stay inside the workspace, got ${JSON.stringify(config.directory)}`)
  }

  // ---------------------------------------------------------------------------
  // Shared memory-file helpers
  // ---------------------------------------------------------------------------

  /**
   * Validate one client-supplied memory file name.
   * @param {unknown} value - raw name from the request.
   * @returns {{ name: string } | { error: Response }}
   */
  function validateName(value) {
    if (typeof value !== 'string' || value.trim() === '') {
      return { error: fail(400, 'workspace-memory/invalid-name', 'A non-empty name field is required.') }
    }
    const name = value.trim()
    if (name.length > MAX_NAME_LENGTH
      || name.startsWith('.')
      || name.includes('..')
      || INVALID_NAME_CHARS.test(name)
      || CONTROL_CHARS.test(name)
      || !name.endsWith('.md')) {
      return {
        error: fail(400, 'workspace-memory/invalid-name',
          `Invalid memory file name ${JSON.stringify(name)}: use 1-${MAX_NAME_LENGTH} plain characters ending in .md without path separators.`),
      }
    }
    return { name }
  }

  /**
   * Normalize a tool-supplied name, appending the `.md` extension when missing.
   * @param {unknown} value - raw name from the model.
   * @returns {string | null} the normalized name, or null when invalid.
   */
  function normalizeToolName(value) {
    if (typeof value !== 'string' || value.trim() === '') return null
    const trimmed = value.trim()
    const name = trimmed.endsWith('.md') ? trimmed : `${trimmed}.md`
    return validateName(name).name ?? null
  }

  async function listFiles(dir) {
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch (error) {
      if (error && error.code === 'ENOENT') return []
      throw error
    }
    const files = []
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md') || entry.name.startsWith('.')) continue
      const stat = await fs.stat(path.join(dir, entry.name))
      files.push({ name: entry.name, bytes: stat.size, updatedAt: stat.mtime.toISOString() })
    }
    files.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    return files
  }

  /**
   * Resolve the memory root for one session working directory: the registered
   * Workspace covering it, or the directory itself when unregistered.
   * @param {string} cwd - the session header's absolute working directory.
   * @returns {Promise<string>} absolute memory-root path.
   */
  async function resolveRoot(cwd) {
    try {
      const workspace = await ctx.workspaceRegistry.resolveByPath(cwd)
      if (workspace !== undefined && typeof workspace.path === 'string') {
        return path.resolve(workspace.path)
      }
    } catch { /* unregistered or unresolvable — fall back to the directory itself */ }
    return path.resolve(cwd)
  }

  /** Best-effort read of one agent's working directory. */
  function agentCwd(agent) {
    try {
      return agent?.session?.header?.cwd ?? ctx.sessions.get(agent?.id)?.header?.cwd
    } catch {
      return undefined
    }
  }

  // ---------------------------------------------------------------------------
  // Prompt section: current memory files, refreshed when the directory changes
  // ---------------------------------------------------------------------------

  /** Per-root cache: directory signature -> rendered section text. */
  const memoryCaches = new Map()

  /**
   * Render the workspace memory section for one root, re-reading file contents
   * only when the directory signature (names, sizes, mtimes) changed. Runs
   * synchronously because prompt-section providers are synchronous; the stat
   * round-trip over a handful of small files is negligible per model step.
   * @param {string} root - absolute memory-root path.
   * @returns {string} section text, empty when no memory exists.
   */
  function buildMemoryText(root) {
    const dir = path.join(root, directory)
    let signature = 'missing'
    const files = []
    try {
      for (const entry of fsSync.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.md') || entry.name.startsWith('.')) continue
        const stat = fsSync.statSync(path.join(dir, entry.name))
        files.push({ name: entry.name, size: stat.size, mtimeMs: stat.mtimeMs })
      }
      files.sort((left, right) => left.name.localeCompare(right.name))
      signature = files.map((file) => `${file.name}:${String(file.size)}:${String(file.mtimeMs)}`).join('|')
    } catch { /* missing or unreadable directory reads as no memory */ }
    const cached = memoryCaches.get(root)
    if (cached !== undefined && cached.signature === signature) return cached.text

    let text = ''
    if (files.length > 0) {
      const parts = [
        '## Workspace Memory',
        '',
        `This workspace keeps durable memory files under \`${directory}/\`, managed from the "Workspace Memory" sidebar panel. Treat them as trusted project memory alongside AGENTS.md. When the user asks you to remember a project decision, convention, or preference, persist it with the save_workspace_memory tool.`,
        '',
      ]
      for (const file of files.slice(0, PROMPT_MAX_FILES)) {
        let content
        try {
          content = fsSync.readFileSync(path.join(dir, file.name), 'utf8')
        } catch {
          continue
        }
        if (content.length > PROMPT_MAX_FILE_CHARS) {
          content = `${content.slice(0, PROMPT_MAX_FILE_CHARS)}\n\n[truncated — the full file is ${String(content.length)} characters]`
        }
        parts.push(`### \`${directory}/${file.name}\``, '', content, '')
      }
      if (files.length > PROMPT_MAX_FILES) {
        parts.push(`[${String(files.length - PROMPT_MAX_FILES)} more memory files not shown]`, '')
      }
      text = parts.join('\n').trim()
    }
    memoryCaches.set(root, { signature, text })
    return text
  }

  // ---------------------------------------------------------------------------
  // Panel API routes
  // ---------------------------------------------------------------------------

  /**
   * Resolve the fenced memory directory for one registered workspace.
   * @param {string | null} workspaceId - registry workspace id from the client.
   * @returns {{ dir: string, workspacePath: string } | { error: Response }}
   */
  function resolveMemoryDir(workspaceId) {
    if (typeof workspaceId !== 'string' || workspaceId === '') {
      return { error: fail(400, 'workspace-memory/workspace-required', 'A workspaceId query or body field is required.') }
    }
    const workspace = ctx.workspaceRegistry.get(workspaceId)
    if (workspace === undefined) {
      return { error: fail(404, 'workspace-memory/unknown-workspace', `Unknown workspace: ${workspaceId}`) }
    }
    const workspacePath = path.resolve(workspace.path)
    const dir = path.resolve(workspacePath, directory)
    if (dir !== workspacePath && !dir.startsWith(workspacePath + path.sep)) {
      return { error: fail(400, 'workspace-memory/invalid-directory', 'The memory directory escapes the workspace.') }
    }
    return { dir, workspacePath }
  }

  async function handleList(request) {
    const workspaceId = new URL(request.url).searchParams.get('workspaceId')
    const resolved = resolveMemoryDir(workspaceId)
    if (resolved.error) return resolved.error
    return ok({ directory, files: await listFiles(resolved.dir) })
  }

  async function handleRead(request) {
    const params = new URL(request.url).searchParams
    const resolved = resolveMemoryDir(params.get('workspaceId'))
    if (resolved.error) return resolved.error
    const named = validateName(params.get('name'))
    if (named.error) return named.error
    try {
      const content = await fs.readFile(path.join(resolved.dir, named.name), 'utf8')
      const stat = await fs.stat(path.join(resolved.dir, named.name))
      return ok({ name: named.name, content, bytes: stat.size, updatedAt: stat.mtime.toISOString() })
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        return fail(404, 'workspace-memory/not-found', `Memory file not found: ${named.name}`)
      }
      throw error
    }
  }

  async function handleWrite(request) {
    const body = await request.json().catch(() => undefined)
    if (typeof body !== 'object' || body === null) {
      return fail(400, 'workspace-memory/bad-request', 'A JSON body is required.')
    }
    const resolved = resolveMemoryDir(body.workspaceId)
    if (resolved.error) return resolved.error
    const named = validateName(body.name)
    if (named.error) return named.error
    if (typeof body.content !== 'string') {
      return fail(400, 'workspace-memory/bad-request', 'The content field must be a string.')
    }
    if (Buffer.byteLength(body.content, 'utf8') > MAX_CONTENT_BYTES) {
      return fail(413, 'workspace-memory/too-large', `Memory content exceeds ${MAX_CONTENT_BYTES} bytes.`)
    }
    await fs.mkdir(resolved.dir, { recursive: true })
    await fs.writeFile(path.join(resolved.dir, named.name), body.content, 'utf8')
    const stat = await fs.stat(path.join(resolved.dir, named.name))
    return ok({ name: named.name, bytes: stat.size, updatedAt: stat.mtime.toISOString() })
  }

  async function handleDelete(request) {
    const body = await request.json().catch(() => undefined)
    if (typeof body !== 'object' || body === null) {
      return fail(400, 'workspace-memory/bad-request', 'A JSON body is required.')
    }
    const resolved = resolveMemoryDir(body.workspaceId)
    if (resolved.error) return resolved.error
    const named = validateName(body.name)
    if (named.error) return named.error
    try {
      await fs.unlink(path.join(resolved.dir, named.name))
      return ok({ name: named.name, deleted: true })
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        return fail(404, 'workspace-memory/not-found', `Memory file not found: ${named.name}`)
      }
      throw error
    }
  }

  /** Shared error boundary: an unexpected failure becomes one JSON 500. */
  const guard = (handler) => async (request) => {
    try {
      return await handler(request)
    } catch (error) {
      return fail(500, 'workspace-memory/internal', error instanceof Error ? error.message : String(error))
    }
  }

  ctx.effect(() => ctx.connection.fetch.register({
    path: `${ROUTE_PREFIX}/list`,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: guard(handleList),
  }), 'workspace-memory: list route')
  ctx.effect(() => ctx.connection.fetch.register({
    path: `${ROUTE_PREFIX}/read`,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: guard(handleRead),
  }), 'workspace-memory: read route')
  ctx.effect(() => ctx.connection.fetch.register({
    path: `${ROUTE_PREFIX}/write`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: guard(handleWrite),
  }), 'workspace-memory: write route')
  ctx.effect(() => ctx.connection.fetch.register({
    path: `${ROUTE_PREFIX}/delete`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: guard(handleDelete),
  }), 'workspace-memory: delete route')

  // ---------------------------------------------------------------------------
  // Prompt injection: one memory section per agent, owned by this plugin too
  // ---------------------------------------------------------------------------

  /** Agent-ctx disposers this plugin also tracks, so either teardown removes them. */
  const agentRegistrations = new Set()
  ctx.effect(() => () => {
    for (const dispose of agentRegistrations) void dispose()
    agentRegistrations.clear()
  }, 'workspace-memory: agent section cleanup')

  ctx.on('agent/created', ({ agent }) => {
    // This listener runs inside agent creation; it must never reject.
    try {
      const cwd = agentCwd(agent)
      if (typeof cwd !== 'string' || cwd === '') return
      void resolveRoot(cwd).then((root) => {
        try {
          const dispose = agent.ctx.systemPrompt.section({
            name: 'workspace-memory',
            order: PROMPT_SECTION_ORDER,
            text: () => buildMemoryText(root),
          })
          agentRegistrations.add(dispose)
        } catch { /* the agent may already be disposed; its context rejects registration */ }
      }, () => { /* resolution failure leaves the agent without memory */ })
    } catch { /* a session without a usable directory simply gets no memory section */ }
  })

  // ---------------------------------------------------------------------------
  // Agent tool: let the model persist a memory file itself
  // ---------------------------------------------------------------------------

  ctx.effect(() => ctx.tools.register({
    name: 'save_workspace_memory',
    description:
      'Save durable memory for this workspace as a Markdown file under .dsh/memory/. '
      + 'Use it when the user asks you to remember a project decision, convention, preference, or fact across sessions. '
      + 'Memory files are injected into every session working in this workspace and can be reviewed in the Workspace Memory sidebar panel.',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: "Memory file name, e.g. 'architecture' or 'architecture.md' (letters, digits, dot, underscore, hyphen; .md is appended when missing).",
        },
        content: {
          type: 'string',
          description: 'Complete Markdown content to store; overwrites the existing file of the same name.',
        },
      },
      required: ['name', 'content'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args, exec) {
      const cwd = agentCwd(exec.agent)
      if (typeof cwd !== 'string' || cwd === '') {
        throw new Error('This session has no working directory, so there is no workspace to remember for.')
      }
      const name = normalizeToolName(args?.name)
      if (name === null) {
        throw new Error(`Invalid memory file name ${JSON.stringify(args?.name)}: use letters, digits, dot, underscore or hyphen.`)
      }
      if (typeof args?.content !== 'string') {
        throw new Error('The content argument must be a Markdown string.')
      }
      if (Buffer.byteLength(args.content, 'utf8') > MAX_CONTENT_BYTES) {
        throw new Error(`Memory content exceeds ${MAX_CONTENT_BYTES} bytes.`)
      }
      const root = await resolveRoot(cwd)
      const dir = path.join(root, directory)
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(path.join(dir, name), args.content, 'utf8')
      return `Saved workspace memory to ${directory}/${name}; every session in this workspace now sees it.`
    },
  }), 'workspace-memory: save tool')
}
