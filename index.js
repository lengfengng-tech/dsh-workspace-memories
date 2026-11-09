/**
 * Host half of the Workspace Memory bundle.
 *
 * Every workspace owns one memory directory of Markdown files that supplement
 * project files such as AGENTS.md. Two storage modes:
 *
 * - `home` (default): `<DSH home>/workspace-memory/<workspace-key>/` — OUTSIDE
 *   the project tree, so machine-local or sensitive notes (server configs,
 *   environment quirks, personal conventions) can never be committed to the
 *   project repository by accident.
 * - `workspace`: `<workspace>/.dsh/memory/` — inside the project, for memories
 *   the team may want to version alongside the code.
 *
 * Three contributions make the memory real:
 *
 * 1. Panel API — exact Fetch routes on Connection's shared `/api` channel so
 *    the browser panel can list, read, create, update, and delete the files.
 *    Every route accepts an optional `scope=global` field addressing the
 *    cross-workspace memory directory (`<storageDir>/_global/`):
 *      GET  /api/workspace-memory/list?workspaceId=<id>[&scope=global]
 *      GET  /api/workspace-memory/read?workspaceId=<id>[&scope=global]&name=<file>
 *      POST /api/workspace-memory/write   { workspaceId, [scope], name, content }
 *      POST /api/workspace-memory/delete  { workspaceId, [scope], name }
 * 2. Prompt injection — an `agent/created` listener registers two per-agent
 *    system-prompt sections: `global-memory` (every workspace) followed by
 *    `workspace-memory` (this directory).
 * 3. Agent tool — `save_workspace_memory` lets the model persist a memory
 *    file itself, scoped to the workspace or globally.
 *
 * Route responses use one envelope: `{ ok: true, value }` or
 * `{ ok: false, error: { code, message } }`. The panel addresses memory only
 * by registered workspace id, never by free-form path.
 */

import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

export const name = 'workspace-memory'
export const inject = ['connection', 'workspaceRegistry', 'systemPrompt', 'tools', 'sessions']

const ROUTE_PREFIX = '/api/workspace-memory'
const DEFAULT_DIRECTORY = '.dsh/memory'
const DEFAULT_STORAGE = 'home'
const MAX_NAME_LENGTH = 100
const MAX_CONTENT_BYTES = 1024 * 1024
const PROMPT_MAX_FILES = 20
const PROMPT_MAX_FILE_CHARS = 32768
const PROMPT_SECTION_ORDER = 9800
const GLOBAL_SECTION_ORDER = 9700
/** Selector value the panel uses for the cross-workspace scope. */
const GLOBAL_WORKSPACE_ID = '__global__'
/** Reserved directory name under the storage root; workspace keys always carry a `-<hash>` suffix, so this cannot collide. */
const GLOBAL_DIR_NAME = '_global'
const GLOBAL_SEED_FILE = 'preferences.md'
/** Starter template for the global scope: persona, style, communication, and formatting hints in one file. */
export const GLOBAL_SEED_CONTENT = `# 全局偏好 / Global Preferences
<!-- 全局记忆对每一个工作区生效，适合放人格、风格、沟通、格式这类跨项目的个人偏好。
     工作区记忆优先于本文件；只填你在乎的项，其余留空即可。
     懒得自己填？在任意会话对 Agent 说「帮我配置全局偏好」，它会逐个问你几个问题并自动写好。 -->

## 人格 / Persona
<!-- 你是谁、希望 AI 以什么身份/视角与你交流（例如：资深搭档、严格评审、耐心的老师） -->

## 风格 / Style
<!-- 语言风格：正式还是口语、中文还是英文优先、技术深度、是否允许玩笑 -->

## 沟通 / Communication
<!-- 亲切程度、热情程度、emoji 使用、回复详细还是简洁 -->

## 格式 / Formatting
<!-- 回答格式：要不要标题和小标题、列表、表格、代码块、可视化/图示 -->
`
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
  const storage = config.storage === undefined ? DEFAULT_STORAGE : config.storage
  if (storage !== 'home' && storage !== 'workspace') {
    throw new Error(`workspace-memory: config.storage must be "home" or "workspace", got ${JSON.stringify(config.storage)}`)
  }
  const directory = typeof config.directory === 'string' && config.directory.trim() !== ''
    ? config.directory.trim()
    : DEFAULT_DIRECTORY
  if (path.isAbsolute(directory) || directory.split(/[/\\]/).includes('..')) {
    throw new Error(`workspace-memory: config.directory must stay inside the workspace, got ${JSON.stringify(config.directory)}`)
  }
  const storageDir = typeof config.storageDir === 'string' && config.storageDir.trim() !== ''
    ? path.resolve(config.storageDir.trim())
    : path.join(os.homedir(), '.dsh', 'workspace-memory')

  /** Absolute directory holding the cross-workspace global memory files. */
  const globalDir = path.join(storageDir, GLOBAL_DIR_NAME)

  /**
   * Seed the global memory directory with one starter template. Runs only
   * while the directory does not exist yet; an existing directory (even an
   * emptied one) is never rewritten, so user edits always win. Concurrent
   * callers share one attempt, so an activation-time seed and a first list
   * cannot race each other into a half-seeded state.
   */
  let globalSeed = null
  async function seedGlobalMemory() {
    globalSeed ??= (async () => {
      try {
        await fs.mkdir(globalDir, { recursive: false })
      } catch {
        return // already exists — seeding is one-shot
      }
      await fs.writeFile(path.join(globalDir, GLOBAL_SEED_FILE), GLOBAL_SEED_CONTENT, 'utf8')
    })().catch(() => { /* seeding must never break the caller */ })
    return globalSeed
  }
  void seedGlobalMemory()

  // ---------------------------------------------------------------------------
  // Shared memory-file helpers
  // ---------------------------------------------------------------------------

  /**
   * Stable, collision-safe directory key for one workspace path.
   * @param {string} workspacePath - absolute workspace root.
   * @returns {string} `<basename>-<8 hex chars of sha256>`.
   */
  function workspaceKey(workspacePath) {
    const base = path.basename(workspacePath).replace(/[^A-Za-z0-9._-]/g, '_') || 'workspace'
    const hash = crypto.createHash('sha256').update(workspacePath).digest('hex').slice(0, 8)
    return `${base}-${hash}`
  }

  /**
   * Resolve the memory directory for one workspace root.
   * @param {string} workspacePath - absolute workspace root.
   * @returns {{ dir: string, display: string } | { error: Response }}
   */
  function memoryDirFor(workspacePath) {
    if (storage === 'workspace') {
      const dir = path.resolve(workspacePath, directory)
      if (dir !== workspacePath && !dir.startsWith(workspacePath + path.sep)) {
        return { error: fail(400, 'workspace-memory/invalid-directory', 'The memory directory escapes the workspace.') }
      }
      return { dir, display: directory }
    }
    return { dir: path.join(storageDir, workspaceKey(workspacePath)), display: `${storageDir}/${workspaceKey(workspacePath)}` }
  }

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
   * @returns {Promise<string>} absolute workspace-root path.
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

  /** Per-directory cache: directory signature -> rendered section text. */
  const memoryCaches = new Map()

  /**
   * Render one memory section for a memory directory, re-reading file contents
   * only when the directory signature (names, sizes, mtimes) changed. Runs
   * synchronously because prompt-section providers are synchronous; the stat
   * round-trip over a handful of small files is negligible per model step.
   * @param {string} dir - absolute memory directory.
   * @param {'workspace' | 'global'} kind - which scope this section renders.
   * @returns {string} section text, empty when no memory exists.
   */
  function buildMemoryText(dir, kind) {
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
    const cached = memoryCaches.get(dir)
    if (cached !== undefined && cached.signature === signature) return cached.text

    let text = ''
    if (files.length > 0) {
      const heading = kind === 'global' ? '## Global Memory' : '## Workspace Memory'
      const intro = kind === 'global'
        ? 'These global memory files apply to EVERY workspace — cross-project persona, style, and preferences. They are managed from the "Workspace Memory" sidebar panel (the 全局/Global scope) and stored in the DSH data directory. Workspace memory, when present, takes precedence over these global notes for project-specific matters. When the user asks you to remember a personal preference that should follow them across projects, persist it here with the save_workspace_memory tool and scope "global".'
        : 'This workspace has durable memory files, one Markdown file per topic, managed from the "Workspace Memory" sidebar panel. By default they live in the DSH data directory OUTSIDE the project tree, so machine-local details (server configurations, environment quirks, personal conventions) never land in the repository. Treat them as trusted project memory alongside AGENTS.md. When the user asks you to remember a project decision, convention, server detail, or preference, persist it with the save_workspace_memory tool.'
      const parts = [heading, '', intro, '']
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
        parts.push(`### \`${file.name}\``, '', content, '')
      }
      if (files.length > PROMPT_MAX_FILES) {
        parts.push(`[${String(files.length - PROMPT_MAX_FILES)} more memory files not shown]`, '')
      }
      text = parts.join('\n').trim()
    }
    memoryCaches.set(dir, { signature, text })
    return text
  }

  // ---------------------------------------------------------------------------
  // Panel API routes
  // ---------------------------------------------------------------------------

  /**
   * Resolve the fenced memory directory for one scope.
   * @param {string | null} workspaceId - registry workspace id from the client
   *   (ignored for the global scope).
   * @param {unknown} scope - 'global' for the cross-workspace scope; anything
   *   else (including undefined) keeps the original per-workspace behavior.
   * @returns {{ dir: string, display: string, scope: 'workspace' | 'global' } | { error: Response }}
   */
  function resolveMemoryDir(workspaceId, scope) {
    if (scope === 'global' || workspaceId === GLOBAL_WORKSPACE_ID) {
      return { dir: globalDir, display: globalDir, scope: 'global' }
    }
    if (typeof workspaceId !== 'string' || workspaceId === '') {
      return { error: fail(400, 'workspace-memory/workspace-required', 'A workspaceId query or body field is required.') }
    }
    const workspace = ctx.workspaceRegistry.get(workspaceId)
    if (workspace === undefined) {
      return { error: fail(404, 'workspace-memory/unknown-workspace', `Unknown workspace: ${workspaceId}`) }
    }
    const resolved = memoryDirFor(path.resolve(workspace.path))
    if (resolved.error) return resolved
    return { ...resolved, scope: 'workspace' }
  }

  async function handleList(request) {
    const params = new URL(request.url).searchParams
    const resolved = resolveMemoryDir(params.get('workspaceId'), params.get('scope'))
    if (resolved.error) return resolved.error
    if (resolved.scope === 'global') await seedGlobalMemory().catch(() => {})
    return ok({ directory: resolved.display, storage, scope: resolved.scope, files: await listFiles(resolved.dir) })
  }

  async function handleRead(request) {
    const params = new URL(request.url).searchParams
    const resolved = resolveMemoryDir(params.get('workspaceId'), params.get('scope'))
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
    const resolved = resolveMemoryDir(body.workspaceId, body.scope)
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
    const resolved = resolveMemoryDir(body.workspaceId, body.scope)
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
      // Global memory follows the user into every workspace and sorts before
      // the workspace section, so project-specific notes read as overrides.
      const globalDispose = agent.ctx.systemPrompt.section({
        name: 'global-memory',
        order: GLOBAL_SECTION_ORDER,
        // Same rationale as the workspace section: user prose stays literal.
        interpolate: false,
        text: () => buildMemoryText(globalDir, 'global'),
      })
      agentRegistrations.add(globalDispose)
    } catch { /* the agent may already be disposed; its context rejects registration */ }
    try {
      const cwd = agentCwd(agent)
      if (typeof cwd !== 'string' || cwd === '') return
      void resolveRoot(cwd).then((root) => {
        try {
          const memory = memoryDirFor(root)
          if (memory.error) return
          const dir = memory.dir
          const dispose = agent.ctx.systemPrompt.section({
            name: 'workspace-memory',
            order: PROMPT_SECTION_ORDER,
            // Memory files are user prose: any `{{...}}` they contain (for example a
            // documented `docker inspect --format '{{json .Config.Env}}'` command) is
            // literal text, not a prompt variable reference. Opting this section out of
            // interpolation keeps such notes from failing prompt assembly.
            interpolate: false,
            text: () => buildMemoryText(dir, 'workspace'),
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
      'Save durable memory as a Markdown file. '
      + 'By default the memory is scoped to this workspace and injected into every session working in it; with scope "global" it applies to every workspace instead (persona, style, and cross-project preferences belong there). '
      + 'Memories are stored outside the project directory by default (in the DSH data directory), so machine-local details such as server configurations never enter the repository. '
      + 'Use it when the user asks you to remember a project decision, convention, server detail, preference, or fact across sessions. '
      + 'Memory files can be reviewed in the Workspace Memory sidebar panel.',
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
        scope: {
          type: 'string',
          enum: ['workspace', 'global'],
          description: 'Which memory scope to write: "workspace" (default, this workspace only) or "global" (every workspace).',
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
      const scope = args?.scope === 'global' ? 'global' : 'workspace'
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
      let dir
      if (scope === 'global') {
        await seedGlobalMemory().catch(() => {})
        dir = globalDir
      } else {
        const cwd = agentCwd(exec.agent)
        if (typeof cwd !== 'string' || cwd === '') {
          throw new Error('This session has no working directory, so there is no workspace to remember for.')
        }
        const root = await resolveRoot(cwd)
        const memory = memoryDirFor(root)
        if (memory.error) throw new Error('The configured memory directory escapes the workspace.')
        dir = memory.dir
      }
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(path.join(dir, name), args.content, 'utf8')
      return scope === 'global'
        ? `Saved global memory "${name}"; every session in every workspace now sees it.`
        : `Saved workspace memory "${name}"; every session in this workspace now sees it.`
    },
  }), 'workspace-memory: save tool')
}
