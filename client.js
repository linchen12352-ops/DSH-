/**
 * Browser half of @local/session-mover.
 *
 * 左侧栏入口 + 主面板页面：把会话从一个工作区移动到另一个工作区。
 * 读写全部走宿主半挂接的同源路由（/session-mover/state、/session-mover/move），
 * 面板只发同源相对请求，不持有任何会话数据副本。
 *
 * 装载形态以 window.__ModuleLoader__ 为准，与本仓库既有客户端插件同式：
 * 顶层一次 load，factory 里给出 inject / apply。
 */
window.__ModuleLoader__.load({
  id: '@local/session-mover',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useState } = React

    const PANEL_ID = 'session-mover'
    const STATE_URL = '/session-mover/state'
    const MOVE_URL = '/session-mover/move'
    const QQ_URL = '/session-mover/qq'
    const DELETE_URL = '/session-mover/delete'
    const EXPORT_URL = '/session-mover/export'
    const IMPORT_URL = '/session-mover/import'

    const STYLE_ID = 'smv-styles'
    const css = `
.smv-page {
  height: 100%;
  overflow: auto;
  padding: 28px 32px 64px;
  box-sizing: border-box;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
}
.smv-head {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 6px;
}
.smv-title {
  font-size: 18px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
}
.smv-spacer { flex: 1; }
.smv-note {
  font-size: 13px;
  line-height: 1.7;
  color: var(--dsw-alias-label-tertiary);
  margin: 0 0 18px;
  max-width: 760px;
}
.smv-btn {
  appearance: none;
  border: 1px solid var(--dsw-alias-border-l2);
  background: transparent;
  color: var(--dsw-alias-label-primary);
  border-radius: 8px;
  padding: 5px 12px;
  font-size: 13px;
  cursor: pointer;
  font-family: inherit;
}
.smv-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.smv-btn:disabled { opacity: .5; cursor: default; }
.smv-btn[data-primary="1"] {
  border-color: transparent;
  background: var(--dsw-alias-state-business-primary);
  color: #fff;
}
.smv-error {
  border: 1px solid var(--dsw-alias-state-error-primary);
  color: var(--dsw-alias-state-error-primary);
  border-radius: 8px;
  padding: 10px 12px;
  font-size: 13px;
  margin-bottom: 14px;
  white-space: pre-wrap;
}
.smv-ok {
  border: 1px solid var(--dsw-alias-state-success-primary);
  color: var(--dsw-alias-state-success-primary);
  border-radius: 8px;
  padding: 10px 12px;
  font-size: 13px;
  margin-bottom: 14px;
}
.smv-card {
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1);
  border-radius: 12px;
  padding: 14px 16px;
  margin-bottom: 14px;
}
.smv-card-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-bottom: 4px;
}
.smv-card-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
}
.smv-count {
  font-size: 12px;
  color: var(--dsw-alias-label-caption);
}
.smv-path {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  color: var(--dsw-alias-label-caption);
  margin-bottom: 10px;
  word-break: break-all;
}
.smv-empty {
  font-size: 13px;
  color: var(--dsw-alias-label-tertiary);
  padding: 6px 0;
}
.smv-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 8px;
  border-radius: 8px;
}
.smv-row + .smv-row { border-top: 1px solid var(--dsw-alias-border-l1); }
.smv-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
.smv-row-main { min-width: 0; flex: 1; }
.smv-row-title {
  font-size: 13px;
  color: var(--dsw-alias-label-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.smv-row-id {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  color: var(--dsw-alias-label-caption);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.smv-badge {
  font-size: 11px;
  color: var(--dsw-alias-state-warn-label, var(--dsw-alias-label-tertiary));
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 999px;
  padding: 1px 8px;
}
.smv-picker {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 10px 8px 4px;
  border-top: 1px dashed var(--dsw-alias-border-l2);
}
.smv-picker-label {
  font-size: 12px;
  color: var(--dsw-alias-label-tertiary);
}
.smv-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.smv-tabs {
  display: flex;
  align-items: center;
  gap: 18px;
  margin: 6px 0 16px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
}
.smv-tab {
  appearance: none;
  border: none;
  background: transparent;
  position: relative;
  padding: 6px 0 9px;
  font-size: 13px;
  font-family: inherit;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
}
.smv-tab[data-active="1"] { color: var(--dsw-alias-label-primary); }
.smv-tab[data-active="1"]::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  bottom: -1px;
  height: 2px;
  border-radius: 2px;
  background: var(--dsw-alias-label-primary);
}
.smv-scope {
  font-size: 11px;
  color: var(--dsw-alias-label-secondary);
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 999px;
  padding: 1px 8px;
  flex: none;
}
.smv-select, .smv-text {
  appearance: none;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  border-radius: 8px;
  padding: 5px 8px;
  font-size: 12px;
  font-family: inherit;
  max-width: 100%;
}
.smv-text { min-width: 0; flex: 1; }
.smv-newRow {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 10px 8px 2px;
  border-top: 1px dashed var(--dsw-alias-border-l2);
  margin-top: 6px;
}
.smv-note2 {
  font-size: 12px;
  color: var(--dsw-alias-label-tertiary);
  margin: 0 0 12px;
}
`

    /** 侧栏入口图标：两个集装箱互移的抽象图形。 */
    function MoverIcon({ size = 16 }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true,
      },
      h('path', {
        d: 'M4 7.5h11.5M12.5 4.5 15.5 7.5 12.5 10.5',
        stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round',
      }),
      h('path', {
        d: 'M20 16.5H8.5M11.5 13.5 8.5 16.5 11.5 19.5',
        stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round',
      }))
    }

    function Styles() {
      return h('style', { 'data-plugin': 'session-mover' }, css)
    }

    async function readJson(response) {
      const text = await response.text()
      let body
      try {
        body = text === '' ? {} : JSON.parse(text)
      } catch {
        throw new Error(`宿主返回了无法解析的内容（HTTP ${response.status}）`)
      }
      if (body.ok !== true) throw new Error(body.error ?? `请求失败（HTTP ${response.status}）`)
      return body
    }

    /** 目标选择器：渲染在所属会话行下面。 */
    function PickerRow({ session, workspaces, busy, onCancel, onPick }) {
      const targets = workspaces.filter(workspace => workspace.id !== session.workspaceId)
      return h('div', { className: 'smv-picker' },
        h('span', { className: 'smv-picker-label' }, '移动到：'),
        targets.length === 0
          ? h('span', { className: 'smv-picker-label' }, '没有别的工作区可选')
          : targets.map(target => h('button', {
            key: target.id,
            type: 'button',
            className: 'smv-btn',
            'data-primary': '1',
            disabled: busy,
            onClick: () => onPick(session.id, target.id),
          }, target.title)),
        h('button', { type: 'button', className: 'smv-btn', disabled: busy, onClick: onCancel }, '取消'))
    }

    /** 单个待导入条目：可改名、选工作区。 */
    function ImportRow({ item, workspaces, busy, draft, onPatch, onImport }) {
      // 原工作目录在本机不存在时必须先选工作区，否则没有落地的 cwd
      const needWorkspace = item.cwdMissing === true && draft.workspaceId === ''
      return h('div', null,
        h('div', { className: 'smv-row' },
          h('div', { className: 'smv-row-main' },
            h('div', { className: 'smv-row-title', title: item.name }, item.name),
            h('div', { className: 'smv-row-id', title: item.reason || item.cwd },
              item.cwdMissing
                ? `原目录不存在：${item.cwd}  ·  请下方选工作区`
                : `${item.cwd}  ·  原 id ${item.sourceId}`)),
          h('button', {
            type: 'button',
            className: 'smv-btn',
            'data-primary': '1',
            disabled: busy || draft.title.trim() === '' || needWorkspace,
            title: needWorkspace ? '先选一个目标工作区' : '导入',
            onClick: () => onImport(item.name, { title: draft.title.trim(), workspaceId: draft.workspaceId }),
          }, '导入')),
        h('div', { className: 'smv-picker' },
          h('span', { className: 'smv-picker-label' }, '会话名：'),
          h('input', {
            className: 'smv-text',
            value: draft.title,
            disabled: busy,
            onChange: event => onPatch(item.name, { title: event.target.value }),
          }),
          h('span', { className: 'smv-picker-label' }, '工作区：'),
          h('select', {
            className: 'smv-select',
            value: draft.workspaceId,
            disabled: busy,
            onChange: event => onPatch(item.name, { workspaceId: event.target.value }),
          },
          h('option', { value: '' }, item.cwdMissing ? '必须选一个' : '按原目录'),
          workspaces.map(workspace => h('option', { key: workspace.id, value: workspace.id }, workspace.title)))))
    }

    /** 会话导入面板：从导入目录里挑一个，导入时可改名、选工作区，并换成新的会话 id。 */
    function ImportPanel({ imports, workspaces, busy, paths, onImport }) {
      const [drafts, setDrafts] = useState({})

      const draftFor = (item) => drafts[item.name] ?? {
        title: item.title ?? item.name,
        workspaceId: (workspaces.find(workspace => workspace.path === item.cwd)?.id) ?? '',
      }
      const patch = (name, next) => setDrafts(current => ({
        ...current,
        [name]: { ...(current[name] ?? {}), ...next },
      }))

      const rows = imports.candidates.map((item) => {
        if (!item.ok) {
          return h('div', { key: item.name, className: 'smv-row' },
            h('div', { className: 'smv-row-main' },
              h('div', { className: 'smv-row-title', title: item.name }, item.name),
              h('div', { className: 'smv-row-id', title: item.reason }, item.reason)),
            h('span', {
              className: 'smv-badge',
              style: { color: 'var(--dsw-alias-state-error-primary)' },
            }, '格式异常无法导入'))
        }
        return h(ImportRow, {
          key: item.name,
          item,
          workspaces,
          busy,
          draft: draftFor(item),
          onPatch: patch,
          onImport,
        })
      })

      return h('div', null,
        h('p', { className: 'smv-note2' },
          `把导出的那种文件夹（<会话名>/session-<id>/session.v4.jsonl.zstd）放进 ${paths.importRoot}，这里会列出来。`,
          '导入时可以改会话名、选目标工作区；系统会换成新的会话 id，原目录保留不删。'),
        imports.error === '' ? null : h('div', { className: 'smv-error' }, imports.error),
        imports.candidates.length === 0
          ? h('div', { className: 'smv-empty' }, '导入目录里没有东西')
          : h('div', { className: 'smv-card' },
            h('div', { className: 'smv-card-head' },
              h('span', { className: 'smv-card-title' }, '待导入'),
              h('span', { className: 'smv-count' }, `${imports.candidates.length} 个`)),
            rows))
    }

    /** 会话导出面板：一个会话一份副本，复制到导出目录/<会话名>/。 */
    function ExportPanel({ state, busy, paths, onExport }) {
      const groups = [
        ...state.workspaces.map(workspace => ({
          key: workspace.id,
          title: workspace.title,
          note: workspace.path,
          sessions: workspace.sessions,
        })),
        ...(state.ungrouped.length === 0 ? [] : [{
          key: 'ungrouped',
          title: '未分组',
          note: '没有任何工作区登记',
          sessions: state.ungrouped,
        }]),
      ]

      return h('div', null,
        h('p', { className: 'smv-note2' },
          `导出会在 ${paths.exportRoot} 下建一个以会话名命名的文件夹，把该会话的 session-<id> 目录完整复制进去；`,
          '原会话不动。重复导出同一个会话会替换旧副本。'),
        state.error === '' ? null : h('div', { className: 'smv-error' }, state.error),
        groups.length === 0
          ? h('div', { className: 'smv-empty' }, '没有可导出的会话')
          : groups.map(group => h('div', { key: group.key, className: 'smv-card' },
            h('div', { className: 'smv-card-head' },
              h('span', { className: 'smv-card-title' }, group.title),
              h('span', { className: 'smv-count' }, `${group.sessions.length} 个会话`)),
            h('div', { className: 'smv-path' }, group.note),
            group.sessions.length === 0
              ? h('div', { className: 'smv-empty' }, '空')
              : group.sessions.map(session => h('div', { key: session.id, className: 'smv-row' },
                h('div', { className: 'smv-row-main' },
                  h('div', { className: 'smv-row-title', title: session.title }, session.title),
                  h('div', { className: 'smv-row-id', title: session.id }, `${session.id}  ·  ${group.title}`)),
                session.live ? h('span', { className: 'smv-badge' }, '打开中') : null,
                h('button', {
                  type: 'button',
                  className: 'smv-btn',
                  disabled: busy,
                  title: `复制一份到 ${paths.exportRoot}`,
                  onClick: () => onExport(session.id),
                }, '导出'))))))
    }

    /** 会话删除面板：一次一个，必须输入口令。 */
    function DeletePanel({ state, busy, password, deleteTarget, onPassword, onPick, onCancel, onConfirm }) {
      const groups = [
        ...state.workspaces.map(workspace => ({
          key: workspace.id,
          title: workspace.title,
          note: workspace.path,
          sessions: workspace.sessions,
        })),
        ...(state.ungrouped.length === 0 ? [] : [{
          key: 'ungrouped',
          title: '未分组',
          note: '没有任何工作区登记',
          sessions: state.ungrouped,
        }]),
      ]

      const row = (session, groupTitle) => h('div', { key: session.id },
        h('div', { className: 'smv-row' },
          h('div', { className: 'smv-row-main' },
            h('div', { className: 'smv-row-title', title: session.title }, session.title),
            h('div', { className: 'smv-row-id', title: session.id }, `${session.id}  ·  ${groupTitle}`)),
          session.live ? h('span', { className: 'smv-badge' }, '打开中') : null,
          h('button', {
            type: 'button',
            className: 'smv-btn',
            disabled: busy || session.live,
            title: session.live ? '会话正在打开，先关掉它再删除' : '删除这个会话',
            onClick: () => onPick(session.id),
          }, deleteTarget === session.id ? '收起' : '删除')),
        deleteTarget === session.id
          ? h('div', { className: 'smv-picker' },
            h('span', { className: 'smv-picker-label' }, '输入密码：'),
            h('input', {
              className: 'smv-text',
              type: 'password',
              placeholder: '删除口令',
              value: password,
              disabled: busy,
              autoFocus: true,
              onChange: event => onPassword(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter' && password !== '' && !busy) onConfirm(session.id)
              },
            }),
            h('button', {
              type: 'button',
              className: 'smv-btn',
              'data-primary': '1',
              disabled: busy || password === '',
              onClick: () => onConfirm(session.id),
            }, '确认删除'),
            h('button', { type: 'button', className: 'smv-btn', disabled: busy, onClick: onCancel }, '取消'))
          : null)

      return h('div', null,
        h('p', { className: 'smv-note2' },
          '删除会连同会话日志一起抹掉，不能恢复；一次只能删一个，需要输入口令。'),
        state.error === '' ? null : h('div', { className: 'smv-error' }, state.error),
        groups.length === 0
          ? h('div', { className: 'smv-empty' }, '没有可删除的会话')
          : groups.map(group => h('div', { key: group.key, className: 'smv-card' },
            h('div', { className: 'smv-card-head' },
              h('span', { className: 'smv-card-title' }, group.title),
              h('span', { className: 'smv-count' }, `${group.sessions.length} 个会话`)),
            h('div', { className: 'smv-path' }, group.note),
            group.sessions.length === 0
              ? h('div', { className: 'smv-empty' }, '空')
              : group.sessions.map(session => row(session, group.title)))))
    }

    /** QQ 映射面板：openid ↔ 会话 id。 */
    function QqPanel({ qq, busy, onSet }) {
      const [scope, setScope] = useState('c2c')
      const [openid, setOpenid] = useState('')
      const [sessionId, setSessionId] = useState('')
      // 没装 qqbot 插件就没有映射文件，这一栏整块不可用
      const unavailable = qq.available === false

      const options = qq.sessions.map(session => h('option', {
        key: session.id,
        value: session.id,
      }, session.title))

      return h('div', null,
        h('p', { className: 'smv-note2' },
          `QQ 这边哪个聊天接哪个会话，靠 ${qq.prefsPath ?? 'qqbot 的映射文件'} 里的键值。`,
          '插件启动时把它读进内存，所以改完要重启宿主才生效。'),
        qq.error === '' ? null : h('div', { className: 'smv-error' }, qq.error),
        unavailable
          ? h('div', { className: 'smv-empty' },
            `本机没有 ${qq.prefsPath ?? 'qqbot 的映射文件'}，这一栏不可用。装上 QQ 机器人插件并跑过一次之后才有这个文件。`)
          : h('div', { className: 'smv-card' },
          h('div', { className: 'smv-card-head' },
            h('span', { className: 'smv-card-title' }, '当前映射'),
            h('span', { className: 'smv-count' }, `${qq.entries.length} 条`)),
          qq.entries.length === 0
            ? h('div', { className: 'smv-empty' }, '还没有任何 QQ 映射')
            : qq.entries.map(entry => h('div', { key: entry.key, className: 'smv-row' },
              h('span', { className: 'smv-scope' }, entry.scope === 'group' ? '群聊' : '私聊'),
              h('div', { className: 'smv-row-main' },
                h('div', { className: 'smv-row-id', title: entry.openid }, entry.openid),
                h('div', { className: 'smv-row-title' }, entry.key)),
              h('select', {
                className: 'smv-select',
                value: entry.sessionId,
                disabled: busy,
                onChange: event => onSet({ key: entry.key, sessionId: event.target.value }),
              }, h('option', { value: entry.sessionId }, entry.title), options),
              h('button', {
                type: 'button',
                className: 'smv-btn',
                disabled: busy,
                title: '解除绑定',
                onClick: () => onSet({ key: entry.key, sessionId: '' }),
              }, '解绑'))),
          unavailable ? null : h('div', { className: 'smv-newRow' },
            h('span', { className: 'smv-picker-label' }, '新增：'),
            h('select', {
              className: 'smv-select',
              value: scope,
              disabled: busy,
              onChange: event => setScope(event.target.value),
            },
            h('option', { value: 'c2c' }, '私聊'),
            h('option', { value: 'group' }, '群聊')),
            h('input', {
              className: 'smv-text',
              placeholder: 'openid',
              value: openid,
              disabled: busy,
              onChange: event => setOpenid(event.target.value),
            }),
            h('select', {
              className: 'smv-select',
              value: sessionId,
              disabled: busy,
              onChange: event => setSessionId(event.target.value),
            },
            h('option', { value: '' }, '选择会话…'),
            options),
            h('button', {
              type: 'button',
              className: 'smv-btn',
              'data-primary': '1',
              disabled: busy || openid.trim() === '' || sessionId === '',
              onClick: () => {
                onSet({ scope, openid: openid.trim(), sessionId, key: '' })
                setOpenid('')
                setSessionId('')
              },
            }, '添加'))))
    }

    function SessionMoverPage() {
      const [state, setState] = useState({ loading: true, workspaces: [], ungrouped: [], paths: undefined, error: '' })
      const [tab, setTab] = useState('sessions')
      const [imports, setImports] = useState({ candidates: [], error: '' })
      const [deleteTarget, setDeleteTarget] = useState('')
      const [password, setPassword] = useState('')
      const [qq, setQq] = useState({ entries: [], sessions: [], error: '' })
      const [moving, setMoving] = useState('')
      const [busy, setBusy] = useState(false)
      const [toast, setToast] = useState({ kind: '', text: '' })

      const refresh = useCallback(async () => {
        try {
          const body = await readJson(await fetch(STATE_URL, { headers: { accept: 'application/json' } }))
          setState({
            loading: false,
            workspaces: body.workspaces ?? [],
            ungrouped: body.ungrouped ?? [],
            paths: body.paths ?? {},
            error: '',
          })
        } catch (error) {
          setState(previous => ({
            loading: false,
            workspaces: previous.workspaces,
            ungrouped: previous.ungrouped,
            paths: previous.paths,
            error: String(error?.message ?? error),
          }))
        }
      }, [])

      useEffect(() => { void refresh() }, [refresh])

      const refreshQq = useCallback(async () => {
        try {
          const body = await readJson(await fetch(QQ_URL, { headers: { accept: 'application/json' } }))
          setQq({
            entries: body.entries ?? [],
            sessions: body.sessions ?? [],
            prefsPath: body.prefsPath ?? '',
            available: body.available !== false,
            error: '',
          })
        } catch (failure) {
          setQq(previous => ({ ...previous, error: String(failure?.message ?? failure) }))
        }
      }, [])

      useEffect(() => {
        if (tab === 'qq') void refreshQq()
      }, [tab, refreshQq])

      const move = useCallback(async (sessionId, targetWorkspaceId) => {
        setBusy(true)
        setToast({ kind: '', text: '' })
        try {
          const body = await readJson(await fetch(MOVE_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId, targetWorkspaceId }),
          }))
          setToast({ kind: 'ok', text: body.message ?? '已移动' })
          setMoving('')
          await refresh()
        } catch (error) {
          setToast({ kind: 'error', text: String(error?.message ?? error) })
        } finally {
          setBusy(false)
        }
      }, [refresh])

      const total = useMemo(
        () => state.workspaces.reduce((sum, workspace) => sum + workspace.sessions.length, 0),
        [state.workspaces])

      // 目录路径由宿主半给，用户在别的机器上装也不会看到写死的 /root
      const paths = state.paths ?? { importRoot: '导入目录（读取中）', exportRoot: '导出目录（读取中）' }

      const removeSession = useCallback(async (sessionId) => {
        setBusy(true)
        setToast({ kind: '', text: '' })
        try {
          const body = await readJson(await fetch(DELETE_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId, password }),
          }))
          setToast({ kind: 'ok', text: body.message ?? '已删除' })
          setDeleteTarget('')
          setPassword('')
          await refresh()
        } catch (failure) {
          setToast({ kind: 'error', text: String(failure?.message ?? failure) })
          setPassword('')
        } finally {
          setBusy(false)
        }
      }, [password, refresh])

      const refreshImports = useCallback(async () => {
        try {
          const body = await readJson(await fetch(IMPORT_URL, { headers: { accept: 'application/json' } }))
          setImports({ candidates: body.candidates ?? [], error: '' })
        } catch (failure) {
          setImports(previous => ({ ...previous, error: String(failure?.message ?? failure) }))
        }
      }, [])

      const importOne = useCallback(async (name, options = {}) => {
        setBusy(true)
        setToast({ kind: '', text: '' })
        try {
          const body = await readJson(await fetch(IMPORT_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name, title: options.title, workspaceId: options.workspaceId }),
          }))
          setImports({ candidates: body.candidates ?? [], error: '' })
          setToast({ kind: 'ok', text: `${body.message ?? '已导入'}（新会话 id：${body.sessionId}）` })
          await refresh()
        } catch (failure) {
          setToast({ kind: 'error', text: String(failure?.message ?? failure) })
        } finally {
          setBusy(false)
        }
      }, [refresh])

      const exportOne = useCallback(async (sessionId) => {
        setBusy(true)
        setToast({ kind: '', text: '' })
        try {
          const body = await readJson(await fetch(EXPORT_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId }),
          }))
          setToast({ kind: 'ok', text: body.path === undefined ? (body.message ?? '已导出') : `已导出到 ${body.path}` })
        } catch (failure) {
          setToast({ kind: 'error', text: String(failure?.message ?? failure) })
        } finally {
          setBusy(false)
        }
      }, [])

      const qqSet = useCallback(async (payload) => {
        setBusy(true)
        setToast({ kind: '', text: '' })
        try {
          const body = await readJson(await fetch(QQ_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          }))
          setQq({
            entries: body.entries ?? [],
            sessions: body.sessions ?? [],
            prefsPath: body.prefsPath ?? '',
            available: body.available !== false,
            error: '',
          })
          setToast({ kind: 'ok', text: '已保存，重启宿主后生效' })
        } catch (failure) {
          setToast({ kind: 'error', text: String(failure?.message ?? failure) })
        } finally {
          setBusy(false)
        }
      }, [])

      return h('div', { className: 'smv-page' },
        h(Styles),
        h('div', { className: 'smv-head' },
          h('span', { className: 'smv-title' }, '会话变动'),
          h('span', { className: 'smv-count' }, tab === 'sessions'
            ? (state.loading ? '读取中…' : `${state.workspaces.length} 个工作区 · ${total} 个会话${state.ungrouped.length > 0 ? ` · ${state.ungrouped.length} 个未分组` : ''}`)
            : tab === 'qq' ? `${qq.entries.length} 条 QQ 映射`
            : tab === 'import' ? `${imports.candidates.length} 个待导入`
            : `${total + state.ungrouped.length} 个会话`),
          h('span', { className: 'smv-spacer' }),
          h('button', {
            type: 'button',
            className: 'smv-btn',
            disabled: state.loading || busy,
            onClick: () => {
              if (tab === 'qq') { void refreshQq() } else if (tab === 'import') { void refreshImports() } else { void refresh() }
            },
          }, '刷新')),
        h('div', { className: 'smv-tabs' },
          h('button', {
            type: 'button',
            className: 'smv-tab',
            'data-active': tab === 'sessions' ? '1' : '0',
            onClick: () => { setTab('sessions'); setToast({ kind: '', text: '' }) },
          }, '会话移动'),
          h('button', {
            type: 'button',
            className: 'smv-tab',
            'data-active': tab === 'qq' ? '1' : '0',
            onClick: () => { setTab('qq'); setToast({ kind: '', text: '' }) },
          }, 'QQ 映射'),
          h('button', {
            type: 'button',
            className: 'smv-tab',
            'data-active': tab === 'delete' ? '1' : '0',
            onClick: () => {
              setTab('delete')
              setToast({ kind: '', text: '' })
              setDeleteTarget('')
              setPassword('')
              void refresh()
            },
          }, '会话删除'),
          h('button', {
            type: 'button',
            className: 'smv-tab',
            'data-active': tab === 'export' ? '1' : '0',
            onClick: () => { setTab('export'); setToast({ kind: '', text: '' }); void refresh() },
          }, '会话导出'),
          h('button', {
            type: 'button',
            className: 'smv-tab',
            'data-active': tab === 'import' ? '1' : '0',
            onClick: () => { setTab('import'); setToast({ kind: '', text: '' }); void refreshImports() },
          }, '会话导入')),
        toast.kind === 'error' ? h('div', { className: 'smv-error' }, toast.text) : null,
        toast.kind === 'ok' ? h('div', { className: 'smv-ok' }, toast.text) : null,
        tab === 'qq'
          ? h(QqPanel, { qq, busy, onSet: qqSet })
          : tab === 'import'
          ? h(ImportPanel, {
            imports,
            workspaces: state.workspaces,
            busy,
            paths,
            onImport: importOne,
          })
          : tab === 'export'
          ? h(ExportPanel, { state, busy, paths, onExport: exportOne })
          : tab === 'delete'
          ? h(DeletePanel, {
            state,
            busy,
            password,
            deleteTarget,
            onPassword: setPassword,
            onPick: id => { setDeleteTarget(current => (current === id ? '' : id)); setPassword('') },
            onCancel: () => { setDeleteTarget(''); setPassword('') },
            onConfirm: removeSession,
          })
          : h('div', null,
        h('p', { className: 'smv-note' },
          '把会话搬到另一个工作区。会话 ID 与全部历史保持不变，只改它的工作目录和归属；',
          '会话的工作目录会变成目标工作区的目录，之后在这个会话里执行命令就落在新目录下。'),
        state.error === '' ? null : h('div', { className: 'smv-error' }, state.error),
        state.workspaces.map(workspace => h('div', { key: workspace.id },
          h('div', { className: 'smv-card smv-workspace' },
            h('div', { className: 'smv-card-head' },
              h('span', { className: 'smv-card-title' }, workspace.title),
              h('span', { className: 'smv-count' }, `${workspace.sessions.length} 个会话`)),
            h('div', { className: 'smv-path' }, workspace.path),
            workspace.sessions.length === 0
              ? h('div', { className: 'smv-empty' }, '这个工作区还没有会话')
              : workspace.sessions.map(session => h('div', { key: session.id },
                h('div', { className: 'smv-row' },
                  h('div', { className: 'smv-row-main' },
                    h('div', { className: 'smv-row-title', title: session.title }, session.title),
                    h('div', { className: 'smv-row-id', title: session.id }, session.id)),
                  session.live ? h('span', { className: 'smv-badge' }, '打开中') : null,
                  h('button', {
                    type: 'button',
                    className: 'smv-btn',
                    disabled: busy || session.live,
                    title: session.live ? '会话正在打开，先关掉它再移动' : '选择目标工作区',
                    onClick: () => {
                      setToast({ kind: '', text: '' })
                      setMoving(current => (current === session.id ? '' : session.id))
                    },
                  }, moving === session.id ? '收起' : '移动')),
                moving === session.id
                  ? h(PickerRow, {
                    session: { ...session, workspaceId: workspace.id },
                    workspaces: state.workspaces,
                    busy,
                    onCancel: () => setMoving(''),
                    onPick: move,
                  })
                  : null))))),
        state.ungrouped.length === 0
          ? null
          : h('div', { className: 'smv-card smv-ungrouped' },
            h('div', { className: 'smv-card-head' },
              h('span', { className: 'smv-card-title' }, '未分组'),
              h('span', { className: 'smv-count' }, `${state.ungrouped.length} 个会话`)),
            h('div', { className: 'smv-path' }, '磁盘上有、但没有任何工作区登记它 —— 删过工作区之后就会这样'),
            state.ungrouped.map(session => h('div', { key: session.id },
              h('div', { className: 'smv-row' },
                h('div', { className: 'smv-row-main' },
                  h('div', { className: 'smv-row-title', title: session.title }, session.title),
                  h('div', { className: 'smv-row-id', title: session.id }, `${session.id}${session.cwd === '' ? '' : `  ·  ${session.cwd}`}`)),
                session.live ? h('span', { className: 'smv-badge' }, '打开中') : null,
                h('button', {
                  type: 'button',
                  className: 'smv-btn',
                  disabled: busy || session.live,
                  title: session.live ? '会话正在打开，先关掉它再移动' : '选择目标工作区',
                  onClick: () => {
                    setToast({ kind: '', text: '' })
                    setMoving(current => (current === session.id ? '' : session.id))
                  },
                }, moving === session.id ? '收起' : '分组')),
              moving === session.id
                ? h(PickerRow, {
                  session: { ...session, workspaceId: '' },
                  workspaces: state.workspaces,
                  busy,
                  onCancel: () => setMoving(''),
                  onPick: move,
                })
                : null)))))
    }

    return {
      inject: ['layout', 'slots'],
      apply(ctx) {
        const sites = []
        if (typeof ctx.inject === 'function') {
          ctx.inject(['layout', 'slots'], (pageCtx) => {
            const slots = pageCtx.slots
            const layout = pageCtx.layout
            if (slots === undefined) return undefined
            sites.push(slots.inject('main', () => slots.register({
              name: 'main',
              key: PANEL_ID,
            }, SessionMoverPage)))
            sites.push(slots.inject('sidebar.panellist', () => slots.register({
              name: 'sidebar.panellist',
              id: PANEL_ID,
              order: 30,
              label: '会话变动',
            }, MoverIcon)))
            if (typeof layout?.selectPanel === 'function') {
              // 首次装载不自动跳转：入口在左侧栏，用户点了才进。
            }
            return () => {
              for (const dispose of sites.splice(0)) dispose()
            }
          })
        }
        return () => {
          for (const dispose of sites.splice(0)) dispose()
        }
      },
    }
  },
})
