/**
 * Browser half of the Workspace Memory bundle.
 *
 * Registers one `sidebar.panellist` entry whose id addresses the keyed `main`
 * panel of the same id. The panel lists every registered Workspace, shows the
 * Markdown memory files under its `.dsh/memory` directory, and edits, creates,
 * and deletes them through the Host half's `/api/workspace-memory/*` routes.
 * React comes from the browser module table; styling uses only theme tokens.
 */
window.__ModuleLoader__.load({
  id: 'dsh-workspace-memory',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useState, useSyncExternalStore } = React

    const NS = 'workspaceMemory'
    const PANEL_ID = 'workspace-memory'

    const en = {
      'panel.title': 'Workspace Memory',
      'panel.subtitle': 'Per-workspace memory files, stored in the DSH data directory by default — outside the project folder, so server configs and other machine-local notes never get committed. Injected into every session of the workspace.',
      'workspace.label': 'Workspace',
      'workspace.none': 'No workspace is registered yet.',
      'action.refresh': 'Refresh',
      'action.new': 'New file',
      'action.save': 'Save',
      'action.delete': 'Delete',
      'action.confirmDelete': 'Confirm delete',
      'action.cancel': 'Cancel',
      'action.create': 'Create',
      'list.loading': 'Loading…',
      'list.empty': 'No memory files yet',
      'list.emptyHint': 'Create a .md file to keep notes, conventions, and decisions for this workspace.',
      'list.error': 'Failed to load memory files.',
      'new.nameLabel': 'File name',
      'new.placeholder': 'e.g. architecture.md',
      'new.invalid': 'Use letters, digits, dot, underscore or hyphen; the .md extension is added when missing.',
      'editor.hint': 'Select a memory file on the left, or create a new one.',
      'editor.placeholder': 'Write the memory content in Markdown…',
      'editor.dirty': 'Unsaved changes',
      'editor.readonlyMissing': 'This file no longer exists on disk.',
      'notice.saved': 'Saved.',
      'notice.created': 'Created.',
      'notice.deleted': 'Deleted.',
      'error.generic': 'Operation failed.',
    }

    const zh = {
      'panel.title': '工作区记忆',
      'panel.subtitle': '每个工作区独立的记忆文件，默认保存在 DSH 数据目录、不进入项目文件夹——服务器配置等本机敏感信息不会被误提交。自动注入该工作区每个会话的上下文。',
      'workspace.label': '工作区',
      'workspace.none': '尚未注册任何工作区。',
      'action.refresh': '刷新',
      'action.new': '新建文件',
      'action.save': '保存',
      'action.delete': '删除',
      'action.confirmDelete': '确认删除',
      'action.cancel': '取消',
      'action.create': '创建',
      'list.loading': '加载中…',
      'list.empty': '还没有记忆文件',
      'list.emptyHint': '创建一个 .md 文件，记录这个工作区专属的笔记、约定和决策。',
      'list.error': '记忆文件加载失败。',
      'new.nameLabel': '文件名',
      'new.placeholder': '例如 architecture.md',
      'new.invalid': '可使用字母、数字、点、下划线和连字符；缺少 .md 后缀时会自动补上。',
      'editor.hint': '在左侧选择一个记忆文件，或新建一个。',
      'editor.placeholder': '用 Markdown 记录记忆内容…',
      'editor.dirty': '有未保存的修改',
      'editor.readonlyMissing': '该文件在磁盘上已不存在。',
      'notice.saved': '已保存。',
      'notice.created': '已创建。',
      'notice.deleted': '已删除。',
      'error.generic': '操作失败。',
    }

    const fallback = (key) => en[key] || key

    /**
     * Call one Host-half route and unwrap its envelope.
     * @param {string} action - route suffix: list, read, write, or delete.
     * @param {{ query?: Record<string, string>, body?: unknown }} [options] - request shape.
     * @returns the route's value, or a thrown Error carrying its message.
     */
    async function api(action, options = {}) {
      const query = options.query ? '?' + new URLSearchParams(options.query).toString() : ''
      const response = await fetch(`/api/workspace-memory/${action}${query}`, {
        method: options.body === undefined ? 'GET' : 'POST',
        headers: options.body === undefined ? undefined : { 'content-type': 'application/json' },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      })
      const data = await response.json().catch(() => null)
      if (!response.ok || data === null || data.ok !== true) {
        const message = data && data.error && typeof data.error.message === 'string'
          ? data.error.message
          : `HTTP ${response.status}`
        throw new Error(message)
      }
      return data.value
    }

    function formatBytes(bytes) {
      if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return ''
      if (bytes < 1024) return `${bytes} B`
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
      return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    }

    function formatTime(iso) {
      const time = Date.parse(iso || '')
      return Number.isNaN(time) ? '' : new Date(time).toLocaleString()
    }

    /** Normalize a user-typed file name to a `.md` file name, or null. */
    function normalizeName(input) {
      const trimmed = String(input || '').trim()
      if (trimmed === '') return null
      const name = trimmed.endsWith('.md') ? trimmed : `${trimmed}.md`
      if (name.length > 100 || name.startsWith('.') || name.includes('..') || /[\s/\\:*?"<>|\x00-\x1f\x7f]/.test(name)) {
        return null
      }
      return name
    }

    /** Decorative glyph for the sidebar row; the row owns the accessible label. */
    function MemoryPanelIcon({ size }) {
      const edge = typeof size === 'number' ? size : 18
      return h('svg', {
        viewBox: '0 0 24 24', width: edge, height: edge, 'aria-hidden': true,
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.7,
        strokeLinecap: 'round', strokeLinejoin: 'round',
        style: { display: 'block' },
      },
        h('path', { d: 'M6 3.5h8l4 4V20a1.5 1.5 0 0 1-1.5 1.5h-10A1.5 1.5 0 0 1 5 20V5a1.5 1.5 0 0 1 1-1.5z' }),
        h('path', { d: 'M14 3.5V8h4' }),
        h('path', { d: 'M8.5 12h7' }),
        h('path', { d: 'M8.5 15.5h7' }),
        h('path', { d: 'M8.5 8.8h2.5' }),
      )
    }

    const CSS = `
.dwm-root {
  display: flex; flex-direction: column; height: 100%; box-sizing: border-box;
  padding: 24px 28px; gap: 16px; overflow: hidden;
  color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base);
  font-size: 13px; line-height: 1.5;
}
.dwm-root *, .dwm-root *::before, .dwm-root *::after { box-sizing: border-box; }
.dwm-header { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.dwm-title { margin: 0; font-size: 18px; font-weight: 600; }
.dwm-subtitle { margin: 4px 0 0; color: var(--dsw-alias-label-secondary); max-width: 560px; }
.dwm-header-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dwm-label { color: var(--dsw-alias-label-secondary); margin-right: 2px; }
.dwm-select, .dwm-input {
  font: inherit; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; padding: 5px 10px; min-width: 180px;
}
.dwm-select:focus-visible, .dwm-input:focus-visible, .dwm-textarea:focus-visible,
.dwm-button:focus-visible, .dwm-row:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px;
}
.dwm-button {
  font: inherit; cursor: pointer; border-radius: 8px; padding: 5px 12px;
  color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l1);
}
.dwm-button:hover:not(:disabled) { border-color: var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); }
.dwm-button:disabled { opacity: 0.5; cursor: default; }
.dwm-button--primary {
  background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary));
  border-color: transparent;
  color: var(--dsw-alias-label-primary-foreground, var(--dsw-alias-bg-base));
}
.dwm-button--primary:hover:not(:disabled) {
  background: var(--dsw-alias-button-primary-hover, var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary)));
}
.dwm-button--danger { color: var(--dsw-alias-state-error-primary); }
.dwm-notice {
  border-radius: 8px; padding: 8px 12px; border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-secondary);
}
.dwm-notice--error { color: var(--dsw-alias-state-error-primary); }
.dwm-notice--ok { color: var(--dsw-alias-state-success-primary); }
.dwm-body { display: flex; gap: 16px; flex: 1; min-height: 0; }
.dwm-list {
  width: 280px; flex: none; display: flex; flex-direction: column; min-height: 0;
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; background: var(--dsw-alias-bg-layer-1);
}
.dwm-list-scroll { overflow-y: auto; flex: 1; padding: 6px; display: flex; flex-direction: column; gap: 2px; }
.dwm-row {
  display: flex; flex-direction: column; gap: 2px; width: 100%; text-align: left;
  font: inherit; cursor: pointer; border: 1px solid transparent; border-radius: 8px;
  padding: 8px 10px; color: var(--dsw-alias-label-primary); background: transparent;
}
.dwm-row:hover { background: var(--dsw-alias-bg-layer-2); }
.dwm-row--active { border-color: var(--dsw-alias-brand-primary); background: var(--dsw-alias-bg-layer-2); }
.dwm-row-name { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dwm-row-meta { color: var(--dsw-alias-label-secondary); font-size: 12px; }
.dwm-list-empty { padding: 24px 16px; text-align: center; color: var(--dsw-alias-label-secondary); }
.dwm-list-empty strong { display: block; color: var(--dsw-alias-label-primary); margin-bottom: 4px; }
.dwm-new-form { display: flex; flex-direction: column; gap: 8px; padding: 10px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.dwm-new-actions { display: flex; gap: 8px; }
.dwm-editor {
  flex: 1; min-width: 0; display: flex; flex-direction: column; min-height: 0;
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; background: var(--dsw-alias-bg-layer-1);
}
.dwm-editor-head {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 10px 14px; border-bottom: 1px solid var(--dsw-alias-border-l1);
}
.dwm-editor-name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dwm-editor-dirty { color: var(--dsw-alias-state-warn-primary); font-size: 12px; font-weight: 400; margin-left: 8px; }
.dwm-editor-actions { display: flex; gap: 8px; flex: none; }
.dwm-textarea {
  flex: 1; width: 100%; resize: none; border: none; padding: 14px; font: inherit;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12.5px;
  color: var(--dsw-alias-label-primary); background: transparent; border-radius: 0 0 12px 12px;
}
.dwm-editor-empty {
  flex: 1; display: flex; align-items: center; justify-content: center;
  color: var(--dsw-alias-label-secondary); padding: 24px; text-align: center;
}
`

    /**
     * The root-scoped Workspace Memory panel rendered in the `main` seat.
     * @param {{ t?: (key: string) => string }} props - framework props; `t` is bound to this plugin's namespace.
     */
    function WorkspaceMemoryPanel(props) {
      const t = typeof props.t === 'function' ? props.t : fallback
      const injected = props.__ctx
      const workspacesStore = injected.workspaces && injected.workspaces.list
      const sessionsStore = injected.sessions && injected.sessions.list

      const workspaceSnapshot = useSyncExternalStore(
        workspacesStore ? workspacesStore.subscribe.bind(workspacesStore) : () => () => {},
        workspacesStore ? workspacesStore.getSnapshot.bind(workspacesStore) : () => null,
      )
      const workspaces = useMemo(
        () => (workspaceSnapshot && Array.isArray(workspaceSnapshot.items) ? workspaceSnapshot.items : []),
        [workspaceSnapshot],
      )

      const [workspaceId, setWorkspaceId] = useState(null)
      const [filesState, setFilesState] = useState({ status: 'idle', files: [] })
      const [selected, setSelected] = useState(null)
      const [content, setContent] = useState('')
      const [savedContent, setSavedContent] = useState('')
      const [notice, setNotice] = useState(null)
      const [creating, setCreating] = useState(false)
      const [newName, setNewName] = useState('')
      const [newInvalid, setNewInvalid] = useState(false)
      const [confirmingDelete, setConfirmingDelete] = useState(false)
      const [busy, setBusy] = useState(false)

      // Default the selector to the Workspace of the Session the main view
      // retains, falling back to the first listed Workspace.
      useEffect(() => {
        if (workspaces.length === 0) {
          if (workspaceId !== null) setWorkspaceId(null)
          return
        }
        if (workspaceId !== null && workspaces.some((item) => item.workspaceId === workspaceId)) return
        let fallbackId = workspaces[0].workspaceId
        try {
          const sessions = sessionsStore ? sessionsStore.getSnapshot() : null
          const current = sessions && sessions.byId
            ? Object.values(sessions.byId).find((session) => session && session.retainedBy && session.retainedBy.mainView > 0)
            : undefined
          if (current) {
            const owner = workspaces.find((item) => Array.isArray(item.sessionIds) && item.sessionIds.includes(current.id))
            if (owner) fallbackId = owner.workspaceId
          }
        } catch { /* the default above stands */ }
        setWorkspaceId(fallbackId)
      }, [workspaces, workspaceId, sessionsStore])

      const refresh = useCallback(async (id, options = {}) => {
        if (!id) {
          setFilesState({ status: 'idle', files: [] })
          return []
        }
        if (!options.quiet) setFilesState((previous) => ({ ...previous, status: 'loading' }))
        try {
          const value = await api('list', { query: { workspaceId: id } })
          const files = Array.isArray(value.files) ? value.files : []
          setFilesState({ status: 'ready', files })
          return files
        } catch (error) {
          setFilesState({ status: 'error', files: [], message: error.message })
          return []
        }
      }, [])

      useEffect(() => {
        setSelected(null)
        setContent('')
        setSavedContent('')
        setNotice(null)
        setCreating(false)
        setConfirmingDelete(false)
        void refresh(workspaceId)
      }, [workspaceId, refresh])

      const openFile = useCallback(async (name) => {
        if (!workspaceId) return
        setBusy(true)
        setNotice(null)
        setConfirmingDelete(false)
        try {
          const value = await api('read', { query: { workspaceId, name } })
          setSelected(name)
          setContent(value.content)
          setSavedContent(value.content)
        } catch (error) {
          setNotice({ kind: 'error', text: error.message })
        } finally {
          setBusy(false)
        }
      }, [workspaceId])

      const saveFile = useCallback(async () => {
        if (!workspaceId || !selected) return
        setBusy(true)
        setNotice(null)
        try {
          await api('write', { body: { workspaceId, name: selected, content } })
          setSavedContent(content)
          setNotice({ kind: 'ok', text: t('notice.saved') })
          await refresh(workspaceId, { quiet: true })
        } catch (error) {
          setNotice({ kind: 'error', text: error.message })
        } finally {
          setBusy(false)
        }
      }, [workspaceId, selected, content, refresh, t])

      const createFile = useCallback(async () => {
        if (!workspaceId) return
        const name = normalizeName(newName)
        if (name === null) {
          setNewInvalid(true)
          return
        }
        setNewInvalid(false)
        setBusy(true)
        setNotice(null)
        try {
          await api('write', { body: { workspaceId, name, content: '' } })
          setCreating(false)
          setNewName('')
          setNotice({ kind: 'ok', text: t('notice.created') })
          await refresh(workspaceId, { quiet: true })
          await openFile(name)
        } catch (error) {
          setNotice({ kind: 'error', text: error.message })
        } finally {
          setBusy(false)
        }
      }, [workspaceId, newName, refresh, openFile, t])

      const deleteFile = useCallback(async () => {
        if (!workspaceId || !selected) return
        if (!confirmingDelete) {
          setConfirmingDelete(true)
          return
        }
        setBusy(true)
        setNotice(null)
        try {
          await api('delete', { body: { workspaceId, name: selected } })
          setSelected(null)
          setContent('')
          setSavedContent('')
          setConfirmingDelete(false)
          setNotice({ kind: 'ok', text: t('notice.deleted') })
          await refresh(workspaceId, { quiet: true })
        } catch (error) {
          setNotice({ kind: 'error', text: error.message })
        } finally {
          setBusy(false)
        }
      }, [workspaceId, selected, confirmingDelete, refresh, t])

      const dirty = selected !== null && content !== savedContent
      const selectedMissing = selected !== null
        && filesState.status === 'ready'
        && !filesState.files.some((file) => file.name === selected)

      // ---- file list column ----
      let listBody
      if (!workspaceId) {
        listBody = h('div', { className: 'dwm-list-empty' }, t('workspace.none'))
      } else if (filesState.status === 'loading' || filesState.status === 'idle') {
        listBody = h('div', { className: 'dwm-list-empty' }, t('list.loading'))
      } else if (filesState.status === 'error') {
        listBody = h('div', { className: 'dwm-list-empty' },
          h('strong', null, t('list.error')),
          filesState.message || '')
      } else if (filesState.files.length === 0) {
        listBody = h('div', { className: 'dwm-list-empty' },
          h('strong', null, t('list.empty')),
          t('list.emptyHint'))
      } else {
        listBody = filesState.files.map((file) => h('button', {
          key: file.name,
          type: 'button',
          className: file.name === selected ? 'dwm-row dwm-row--active' : 'dwm-row',
          onClick: () => { void openFile(file.name) },
        },
          h('span', { className: 'dwm-row-name' }, file.name),
          h('span', { className: 'dwm-row-meta' }, `${formatBytes(file.bytes)} · ${formatTime(file.updatedAt)}`),
        ))
      }

      const newForm = creating && h('div', { className: 'dwm-new-form' },
        h('label', { className: 'dwm-label', htmlFor: 'dwm-new-name' }, t('new.nameLabel')),
        h('input', {
          id: 'dwm-new-name',
          className: 'dwm-input',
          value: newName,
          placeholder: t('new.placeholder'),
          autoFocus: true,
          onChange: (event) => { setNewName(event.target.value); setNewInvalid(false) },
          onKeyDown: (event) => {
            if (event.key === 'Enter') void createFile()
            if (event.key === 'Escape') { setCreating(false); setNewName(''); setNewInvalid(false) }
          },
        }),
        newInvalid && h('div', { className: 'dwm-notice dwm-notice--error' }, t('new.invalid')),
        h('div', { className: 'dwm-new-actions' },
          h('button', { type: 'button', className: 'dwm-button dwm-button--primary', disabled: busy, onClick: () => { void createFile() } }, t('action.create')),
          h('button', {
            type: 'button', className: 'dwm-button',
            onClick: () => { setCreating(false); setNewName(''); setNewInvalid(false) },
          }, t('action.cancel')),
        ),
      )

      // ---- editor column ----
      const editorBody = selected === null
        ? h('div', { className: 'dwm-editor-empty' }, t('editor.hint'))
        : h(React.Fragment, null,
            h('div', { className: 'dwm-editor-head' },
              h('span', { className: 'dwm-editor-name' },
                selected,
                dirty && h('span', { className: 'dwm-editor-dirty' }, t('editor.dirty')),
              ),
              h('span', { className: 'dwm-editor-actions' },
                h('button', {
                  type: 'button', className: 'dwm-button dwm-button--primary',
                  disabled: busy || !dirty,
                  onClick: () => { void saveFile() },
                }, t('action.save')),
                h('button', {
                  type: 'button',
                  className: confirmingDelete ? 'dwm-button dwm-button--danger' : 'dwm-button',
                  disabled: busy,
                  onClick: () => { void deleteFile() },
                  onBlur: () => setConfirmingDelete(false),
                }, confirmingDelete ? t('action.confirmDelete') : t('action.delete')),
              ),
            ),
            selectedMissing
              ? h('div', { className: 'dwm-editor-empty' }, t('editor.readonlyMissing'))
              : h('textarea', {
                  className: 'dwm-textarea',
                  value: content,
                  placeholder: t('editor.placeholder'),
                  spellCheck: false,
                  onChange: (event) => setContent(event.target.value),
                }),
          )

      return h('div', { className: 'dwm-root' },
        h('style', null, CSS),
        h('header', { className: 'dwm-header' },
          h('div', null,
            h('h1', { className: 'dwm-title' }, t('panel.title')),
            h('p', { className: 'dwm-subtitle' }, t('panel.subtitle')),
          ),
          h('div', { className: 'dwm-header-actions' },
            h('label', { className: 'dwm-label', htmlFor: 'dwm-workspace' }, t('workspace.label')),
            h('select', {
              id: 'dwm-workspace',
              className: 'dwm-select',
              value: workspaceId || '',
              disabled: workspaces.length === 0,
              onChange: (event) => setWorkspaceId(event.target.value || null),
            },
              workspaces.length === 0 && h('option', { value: '' }, t('workspace.none')),
              workspaces.map((item) => h('option', { key: item.workspaceId, value: item.workspaceId },
                item.title && item.title.trim() !== '' ? `${item.title} — ${item.path}` : item.path)),
            ),
            h('button', {
              type: 'button', className: 'dwm-button',
              disabled: !workspaceId || busy,
              onClick: () => { setNotice(null); void refresh(workspaceId) },
            }, t('action.refresh')),
            h('button', {
              type: 'button', className: 'dwm-button dwm-button--primary',
              disabled: !workspaceId || busy,
              onClick: () => { setCreating(true); setConfirmingDelete(false) },
            }, t('action.new')),
          ),
        ),
        notice && h('div', {
          className: notice.kind === 'error' ? 'dwm-notice dwm-notice--error' : 'dwm-notice dwm-notice--ok',
          role: 'status',
        }, notice.text || t('error.generic')),
        h('div', { className: 'dwm-body' },
          h('aside', { className: 'dwm-list' },
            newForm,
            h('div', { className: 'dwm-list-scroll' }, listBody),
          ),
          h('section', { className: 'dwm-editor' }, editorBody),
        ),
      )
    }

    return {
      inject: ['slots', 'locale', 'workspaces', 'sessions'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'workspace-memory: dictionaries')
        const t = ctx.locale.bind(NS)
        // The slot system injects registered components rather than passing the
        // plugin context, so the panel reads its stores through one prop.
        const withCtx = (Component) => (props) => h(Component, { ...props, __ctx: ctx })
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 20,
          locale: NS,
          label: () => t('panel.title'),
        }, MemoryPanelIcon))
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          locale: NS,
        }, withCtx(WorkspaceMemoryPanel)))
      },
    }
  },
})
