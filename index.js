/**
 * session-mover — 把会话从一个工作区移动到另一个工作区。
 *
 * ## 为什么需要三处一起改
 *
 * DSH 的工作区归属不是单一字段，而是三处必须自洽：
 *
 * 1. 会话日志第一行的 `cwd` —— 决定它落在 `sessions/--<projectKey(cwd)>--/` 桶里，
 *    也决定工作区成员校验 `candidateMatches(id, path)` 是否通过；
 * 2. 会话目录的物理位置 —— 读取时按 header 的 cwd 反推出期望路径，路径不符就报
 *    `corrupt session log`；
 * 3. 登记表 `workspace.json` 的 `sessionIds`。
 *
 * 因此移动 = 改写 cwd（保持 id 与全部历史不变）+ 搬目录 + 改归属。
 *
 * ## 边界
 *
 * - 只动 cwd，不动 `id`、不动任何一条事件；
 * - 会话正在被打开（`sessions.get(id)` 命中）时拒绝，因为它的追加链持有旧路径；
 * - 先搬文件，再改登记表；登记表失败则把文件搬回去，尽量不留半改状态。
 */

import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { cp, copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { homedir } from 'node:os'

export const name = '@local/session-mover'
export const inject = ['webServer']

const ROUTE_STATE = '/session-mover/state'
const ROUTE_MOVE = '/session-mover/move'
const ROUTE_QQ = '/session-mover/qq'
const ROUTE_DELETE = '/session-mover/delete'
const ROUTE_EXPORT = '/session-mover/export'
const ROUTE_IMPORT = '/session-mover/import'

/** 用户主目录；导出、导入、存档目录默认都落在它下面。 */
const HOME = homedir()

/**
 * 导入源目录：用户把导出格式的文件夹丢进来。
 * 默认 `~/导入会话`，可以用环境变量换到别处。
 */
const IMPORT_ROOT = process.env.SESSION_MOVER_IMPORT_DIR ?? join(HOME, '导入会话')

/** 导出的落地目录：一个会话一个文件夹，里面放该会话的 session-<id> 目录副本。 */
const EXPORT_ROOT = process.env.SESSION_MOVER_EXPORT_DIR ?? join(HOME, '导出会话')

/** 删除会话时的固定口令；写死，不可从配置改。 */
const DELETE_PASSWORD = 'confirm_modification'

/** session-md-archive 的导出目录；删除会话后给对应文件加个标记。不存在就跳过。 */
const ARCHIVE_DIR = process.env.SESSION_MOVER_ARCHIVE_DIR ?? join(HOME, 'AI会话记录')
const ARCHIVE_MARK = '（已删除）'

/** @tencent-connect/dsh-qqbot 的 openid ↔ 会话 id 映射文件（它启动时读进内存）。 */
const QQ_PREFS = process.env.DSH_QQBOT_PREFS ?? join(HOME, '.dsh-qqbot', 'model-prefs.json')

/**
 * 从会话目录反推 DSH 数据目录：会话落在 `<home>/sessions/--<bucket>--/session-<id>/`，
 * 往上三级就是 home。这样回收站和投影缓存不用猜 DSH_HOME 装在哪，也不依赖环境变量。
 */
function dshHomeOf(sessionDir) {
  return dirname(dirname(dirname(sessionDir)))
}
const ZSTD_MAGIC = 0xFD2FB528

/** 会话日志是按帧拼接的 zstd 容器；逐帧切出并解码成完整 JSONL。 */
function scanFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) throw new Error('会话日志尾部不完整（截断）')
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`会话日志帧格式异常（字节 ${offset}）`)
    offset += 4
    if (offset === buffer.length) throw new Error('会话日志尾部不完整（截断）')
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 0x18) !== 0) throw new Error('会话日志帧头保留位异常')
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const headerBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < headerBytes) throw new Error('会话日志尾部不完整（帧头截断）')
    offset += headerBytes
    for (;;) {
      if (buffer.length - offset < 3) throw new Error('会话日志尾部不完整（块头截断）')
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 0x03
      const blockSize = blockHeader >>> 3
      if (blockType === 0x03) throw new Error('会话日志块类型异常')
      const payloadBytes = blockType === 0x01 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) throw new Error('会话日志尾部不完整（块截断）')
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) throw new Error('会话日志尾部不完整（校验和截断）')
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return frames
}

/** 解码整份会话日志。 */
function decodeLog(buffer) {
  const frames = scanFrames(buffer)
  return Buffer.concat(frames.map(frame => zstdDecompressSync(buffer.subarray(frame.start, frame.end))))
}

/**
 * 只改 header 那一帧，其余事件帧原样保留。
 *
 * 读取器要求「第一帧恰好是一行 header，且以换行结尾」（`assertZstdHeaderFrame`），
 * 所以不能把整份日志压成一帧；事件帧也无需重新编码，直接按原字节接在后面。
 */
function rewriteHeader(buffer, mutate) {
  const frames = scanFrames(buffer)
  if (frames.length === 0) throw new Error('会话日志没有任何帧')
  const first = frames[0]
  const plaintext = zstdDecompressSync(buffer.subarray(first.start, first.end))
  if (plaintext.length === 0 || plaintext.indexOf(0x0A) !== plaintext.length - 1) {
    throw new Error('会话日志第一帧不是单独一行 header')
  }
  const header = JSON.parse(plaintext.subarray(0, -1).toString('utf8'))
  const next = mutate(header)
  const headerFrame = encodeFrame(`${JSON.stringify(next ?? header)}\n`)
  const rest = buffer.subarray(first.end)
  return { header, bytes: Buffer.concat([headerFrame, rest]) }
}

/** 压成一帧（DPK 写入器用同样的校验位）。 */
function encodeFrame(text) {
  return zstdCompressSync(Buffer.from(text, 'utf8'), {
    params: { [constants.ZSTD_c_checksumFlag]: 1 },
  })
}

/** 路径 → 会话桶目录名，与 dsh-session-persistence-jsonl 的 projectKey 一致。 */
function projectKey(cwd) {
  if (cwd.length === 0) throw new Error('工作区路径为空')
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i += 1) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
      separatorRun = false
    }
  }
  const slug = readable.replace(/^-+/, '') || 'root'
  return `--${slug.slice(0, 251)}--`
}

/** 读 JSON 请求体。 */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 64 * 1024) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/** 统一回包。 */
function reply(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(body)
}

/**
 * 会话标题：以磁盘上的日志为准。
 *
 * 不走 sessionQuery：它按语料缓存，刚改的名字读不到。这里直接解会话日志找
 * 最后一条 `session/title`，并用「路径 + 大小 + mtime」当缓存键，文件一变就重读。
 */
async function titleOf(filePath, cache) {
  let info
  try {
    info = await stat(filePath)
  } catch {
    return undefined
  }
  const key = `${filePath}|${info.size}|${info.mtimeMs}`
  const cached = cache.get(filePath)
  if (cached !== undefined && cached.key === key) return cached.title
  let title = ''
  try {
    const text = decodeLog(await readFile(filePath)).toString('utf8')
    const lines = text.split('\n')
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i]
      if (line === '' || !line.includes('session/title')) continue
      try {
        const event = JSON.parse(line)
        if (event?.type === 'session/title') {
          title = String(event.data?.title ?? '').trim()
          break
        }
      } catch { /* 跳过不完整的行 */ }
    }
  } catch {
    title = ''
  }
  cache.set(filePath, { key, title })
  return title
}

/** 当前工作区投影 + 每个会话的标题。标题每次现读，改名后立即可见。 */
async function readState(ctx, cache = new Map()) {
  const registry = services.registry
  const persistence = services.persistence
  const sessions = services.sessions
  if (registry === undefined || persistence === undefined) throw new Error('工作区/会话存储服务还没就绪')
  const snapshots = await persistence.list()
  const files = new Map(snapshots.map(item => [item.header.id, item.location?.path]))
  const workspaces = []
  for (const workspace of registry.list()) {
    const ids = workspace.sessionIds
    const rows = []
    for (const id of ids) {
      const filePath = files.get(id)
      const title = (filePath === undefined ? '' : await titleOf(filePath, cache)) || `会话 ${String(id).slice(0, 8)}`
      rows.push({
        id,
        title,
        live: sessions?.get?.(id) !== undefined,
      })
    }
    workspaces.push({
      id: workspace.id,
      title: workspace.title,
      path: workspace.path,
      sessions: rows,
    })
  }
  // 未分组：磁盘上有、但任何工作区都没登记的会话（删掉工作区后就会变成这样）
  const archived = new Set(registry.archivedSessionIds ?? [])
  const known = new Set()
  for (const workspace of workspaces) {
    for (const session of workspace.sessions) known.add(session.id)
  }
  const ungrouped = []
  for (const [id, filePath] of files) {
    if (known.has(id) || archived.has(id)) continue
    const title = (filePath === undefined ? '' : await titleOf(filePath, cache)) || `会话 ${String(id).slice(0, 8)}`
    ungrouped.push({
      id,
      title,
      cwd: snapshots.find(item => item.header.id === id)?.header.cwd ?? '',
      live: sessions?.get?.(id) !== undefined,
    })
  }
  ungrouped.sort((left, right) => left.title.localeCompare(right.title))

  return {
    workspaces,
    ungrouped,
    paths: { importRoot: IMPORT_ROOT, exportRoot: EXPORT_ROOT, archiveDir: ARCHIVE_DIR },
  }
}

/** 把一份会话搬到目标工作区；成功返回说明文本。 */
async function moveSession(ctx, sessionId, targetWorkspaceId) {
  const registry = services.registry
  const persistence = services.persistence
  const sessions = services.sessions
  if (registry === undefined || persistence === undefined) throw new Error('工作区/会话存储服务还没就绪')
  const target = registry.get(targetWorkspaceId)
  if (target === undefined) throw new Error('目标工作区不存在')

  if (sessions?.get?.(sessionId) !== undefined) {
    throw new Error('这个会话正在打开，请先在界面上关掉它再移动')
  }

  const snapshots = await persistence.list()
  const snapshot = snapshots.find(item => item.header.id === sessionId)
  if (snapshot === undefined) throw new Error('找不到该会话的存档')
  const header = snapshot.header
  const sourcePath = snapshot.location?.path
  if (typeof sourcePath !== 'string' || sourcePath === '') {
    throw new Error('该会话还没有落盘文件，无法移动')
  }

  const targetCwd = target.path
  const previousCwd = header.cwd
  if (previousCwd === undefined) throw new Error('该会话头部没有工作目录，无法校验归属')
  if (previousCwd === targetCwd) return '这个会话已经在目标工作区里了'

  const directoryExists = await stat(targetCwd).then(item => item.isDirectory()).catch(() => false)
  if (!directoryExists) throw new Error(`目标工作区目录不存在：${targetCwd}`)

  const sourceDir = dirname(sourcePath)
  const root = dirname(dirname(sourceDir))
  const destDir = join(root, projectKey(targetCwd), basename(sourceDir))
  if (destDir === sourceDir) throw new Error('目标路径与当前路径相同，无需移动')

  // 1. 只改写 header 帧里的 cwd，事件帧原样搬过去
  const original = await readFile(sourcePath)
  const { header: storedHeader, bytes: rewritten } = rewriteHeader(original, (header) => {
    if (header?.type !== 'session') throw new Error('会话日志头部不是 session 记录')
    if (header.id !== sessionId) throw new Error('会话日志头部 id 与目录不一致')
    header.cwd = targetCwd
    return header
  })
  if (storedHeader.id !== sessionId) throw new Error('会话日志头部 id 与目录不一致')

  // 2. 搬到新桶（先写临时文件再改名，旧目录此时仍完整）
  await mkdir(destDir, { recursive: true })
  for (const entry of await readdir(sourceDir)) {
    const from = join(sourceDir, entry)
    if (from === sourcePath) continue
    await copyFile(from, join(destDir, entry)).catch(() => {})
  }
  const destPath = join(destDir, basename(sourcePath))
  const stagingPath = `${destPath}.mover-tmp`
  await writeFile(stagingPath, rewritten)
  await rename(stagingPath, destPath)

  // 3. 改归属：先让目标工作区认得新 cwd，再把旧的摘掉
  try {
    if (typeof registry.indexHeader === 'function') {
      await registry.indexHeader({ ...header, cwd: targetCwd })
    }
    await target.attachSession(sessionId)
    // 注意：workspace.sessionIds 是过滤后的投影，文件一搬走旧工作区就看不到这条 id 了，
    // 所以这里不能先 includes 再摘——直接摘，absent 时是 no-op。
    for (const workspace of registry.list()) {
      if (workspace.id === targetWorkspaceId) continue
      await workspace.detachSession(sessionId)
    }
  } catch (error) {
    // 登记表没改成：文件搬回去，索引还原，保持原状
    await rm(destDir, { recursive: true, force: true }).catch(() => {})
    if (typeof registry.indexHeader === 'function') {
      await registry.indexHeader(header).catch(() => {})
    }
    throw error
  }

  await rm(sourceDir, { recursive: true, force: true }).catch(() => {})
  return `已移动到「${target.title}」`
}

/** 数据服务在 apply 之后才被 provide，用 ctx.inject 接进来存这里。 */
const services = { registry: undefined, persistence: undefined, sessions: undefined }

/** 读 QQ 映射文件；不存在时返回空骨架。 */
async function readQqPrefs() {
  let text
  try {
    text = await readFile(QQ_PREFS, 'utf8')
  } catch {
    return { overrides: {}, sessionIds: {}, presets: {} }
  }
  const parsed = JSON.parse(text)
  return {
    overrides: parsed?.overrides ?? {},
    sessionIds: parsed?.sessionIds ?? {},
    presets: parsed?.presets ?? {},
  }
}

/** 原子写回，保留文件里本插件不认识的字段。 */
async function writeQqPrefs(prefs) {
  await mkdir(dirname(QQ_PREFS), { recursive: true })
  const staging = `${QQ_PREFS}.mover-tmp`
  await writeFile(staging, `${JSON.stringify(prefs, null, 2)}\n`, 'utf8')
  await rename(staging, QQ_PREFS)
}

/** `qqbot:<appId>:<scope>:<openid>` → 结构；不合格式的键原样返回。 */
function parseQqKey(key) {
  const parts = String(key).split(':')
  if (parts.length !== 4 || parts[0] !== 'qqbot') return undefined
  return { appId: parts[1], scope: parts[2], openid: parts[3] }
}

/**
 * 推断当前机器人的 appId。
 *
 * 文件里可能留着换机器人之前的老条目，所以取出现次数最多的那个，而不是第一个。
 */
function entriesAppId(prefs) {
  const counts = new Map()
  for (const key of Object.keys(prefs.sessionIds)) {
    const parsed = parseQqKey(key)
    if (parsed === undefined) continue
    counts.set(parsed.appId, (counts.get(parsed.appId) ?? 0) + 1)
  }
  let best
  let bestCount = 0
  for (const [appId, count] of counts) {
    if (count > bestCount) {
      best = appId
      bestCount = count
    }
  }
  return best
}

/** 当前映射 + 全部会话（供下拉选择）。 */
async function readQqState(ctx, cache) {
  const prefs = await readQqPrefs()
  const persistence = services.persistence
  const snapshots = persistence === undefined ? [] : await persistence.list()
  const files = new Map(snapshots.map(item => [item.header.id, item.location?.path]))
  const sessions = []
  for (const [id, filePath] of files) {
    const title = (filePath === undefined ? '' : await titleOf(filePath, cache)) || `会话 ${String(id).slice(0, 8)}`
    sessions.push({ id, title })
  }
  sessions.sort((left, right) => left.title.localeCompare(right.title))
  const entries = []
  for (const [key, sessionId] of Object.entries(prefs.sessionIds)) {
    const parsed = parseQqKey(key)
    entries.push({
      key,
      appId: parsed?.appId ?? '',
      scope: parsed?.scope ?? '',
      openid: parsed?.openid ?? key,
      sessionId: String(sessionId),
      title: sessions.find(item => item.id === sessionId)?.title ?? String(sessionId).slice(0, 16),
    })
  }
  entries.sort((left, right) => left.key.localeCompare(right.key))
  return { entries, sessions, prefsPath: QQ_PREFS, available: await isFile(QQ_PREFS) }
}

/**
 * 自动归组：把「cwd 正好等于某个已登记工作区路径、但还没被登记」的会话补进该工作区。
 *
 * QQ 插件新建会话时只写文件、从不 attach，而工作区的 bootstrap 一生只跑一次，
 * 所以新会话会一直躺在「未分组」里。这里定期补一次登记。
 */
/** 判断一个路径是不是普通文件。 */
async function isFile(path) {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

/** 判断一个路径是不是目录。 */
async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/**
 * 审查一个待导入条目。
 *
 * 期待的形状是导出产物：`<会话名>/session-<id>/session.v4.jsonl.zstd`。
 * 只要有一点不符就判为格式异常，宁可拒绝也不猜。
 */
async function inspectImport(name) {
  const entryPath = join(IMPORT_ROOT, name)
  if (!(await isDirectory(entryPath))) {
    return { name, ok: false, reason: '不是文件夹' }
  }
  const children = await readdir(entryPath, { withFileTypes: true }).catch(() => [])
  const dirs = children.filter(child => child.isDirectory())
  const files = children.filter(child => !child.isDirectory())
  if (dirs.length === 0) {
    return { name, ok: false, reason: files.length === 0 ? '空文件夹' : '里面没有会话目录' }
  }
  if (dirs.length > 1) {
    return { name, ok: false, reason: '一个文件夹里只能有一个会话目录' }
  }
  const sessionDirName = dirs[0].name
  if (!sessionDirName.startsWith('session-')) {
    return { name, ok: false, reason: `子目录名不是 session-…：${sessionDirName}` }
  }
  const sessionDir = join(entryPath, sessionDirName)
  const logPath = join(sessionDir, 'session.v4.jsonl.zstd')
  let buffer
  try {
    buffer = await readFile(logPath)
  } catch {
    return { name, ok: false, reason: '缺少 session.v4.jsonl.zstd' }
  }
  let header
  try {
    const frames = scanFrames(buffer)
    if (frames.length === 0) return { name, ok: false, reason: '日志没有任何帧' }
    const first = frames[0]
    const plaintext = zstdDecompressSync(buffer.subarray(first.start, first.end))
    if (plaintext.length === 0 || plaintext.indexOf(0x0A) !== plaintext.length - 1) {
      return { name, ok: false, reason: '第一帧不是单独一行 header' }
    }
    header = JSON.parse(plaintext.subarray(0, -1).toString('utf8'))
  } catch (error) {
    return { name, ok: false, reason: `日志读不了：${String(error?.message ?? error).slice(0, 80)}` }
  }
  if (header?.type !== 'session') return { name, ok: false, reason: '头部不是 session 记录' }
  if (typeof header.id !== 'string' || header.id === '') return { name, ok: false, reason: '头部缺少会话 id' }
  if (typeof header.cwd !== 'string' || header.cwd === '') {
    return { name, ok: false, reason: '头部缺少可用的工作目录' }
  }
  // 原目录不存在不算致命错误：换台机器导出再导入时原路径本来就没有，
  // 只要导入时另选一个工作区就行。
  const cwdMissing = !(await isDirectory(header.cwd))
  let title = ''
  try {
    const text = decodeLog(buffer).toString('utf8')
    for (const line of text.split('\n')) {
      if (!line.includes('session/title')) continue
      try {
        const event = JSON.parse(line)
        if (event?.type === 'session/title') title = String(event.data?.title ?? '').trim()
      } catch { /* 跳过坏行 */ }
    }
  } catch { /* 标题读不到不影响导入 */ }
  return {
    name,
    ok: true,
    reason: cwdMissing ? `原工作目录不存在：${header.cwd}（导入时请选一个工作区）` : '',
    cwdMissing,
    title: title === '' ? name : title,
    cwd: header.cwd,
    sourceId: header.id,
    sessionDirName,
  }
}

/** 列出导入源下所有条目及审查结果。 */
async function listImports() {
  // 目录不在就建一个空目录，用户才知道该往哪儿放；建不了就当作空。
  await mkdir(IMPORT_ROOT, { recursive: true }).catch(() => {})
  let entries
  try {
    entries = await readdir(IMPORT_ROOT, { withFileTypes: true })
  } catch {
    return []
  }
  const out = []
  for (const entry of entries) {
    out.push(await inspectImport(entry.name))
  }
  out.sort((left, right) => left.name.localeCompare(right.name))
  return out
}

/** 把 JSON 里所有「正好等于 oldId」的字符串换成 newId。 */
function replaceIdDeep(value, oldId, newId) {
  if (typeof value === 'string') return value === oldId ? newId : value
  if (Array.isArray(value)) return value.map(item => replaceIdDeep(item, oldId, newId))
  if (value !== null && typeof value === 'object') {
    const out = {}
    for (const key of Object.keys(value)) out[key] = replaceIdDeep(value[key], oldId, newId)
    return out
  }
  return value
}

/**
 * 导入一个会话：换一个新 id 落进对应桶，原导入目录保留不删。
 *
 * 只改 header 那一帧里的 id，事件帧原样复制；因此新会话的历史与来源一致，
 * 但与来源的 id 无关，不会撞车。
 */
async function importSession(ctx, name, options = {}) {
  const inspection = await inspectImport(name)
  if (!inspection.ok) throw new Error(`格式异常无法导入：${inspection.reason}`)

  const registry = services.registry
  const wantedWorkspace = typeof options.workspaceId === 'string' && options.workspaceId !== ''
    ? options.workspaceId
    : undefined
  let targetWorkspace
  if (wantedWorkspace !== undefined) {
    if (registry === undefined) throw new Error('工作区服务还没就绪')
    targetWorkspace = registry.get(wantedWorkspace)
    if (targetWorkspace === undefined) throw new Error('目标工作区不存在')
  }
  const wantedCwd = typeof options.cwd === 'string' ? options.cwd.trim() : ''
  let targetCwd
  if (targetWorkspace !== undefined) {
    targetCwd = targetWorkspace.path
  } else if (wantedCwd !== '') {
    // 用户直接指定本机路径：原目录在别的机器上不存在时用这个
    if (!isAbsolute(wantedCwd)) throw new Error(`要填绝对路径：${wantedCwd}`)
    targetCwd = wantedCwd
  } else if (inspection.cwdMissing) {
    throw new Error('原工作目录在这台机器上不存在，请选一个工作区或填一个本机路径')
  } else {
    targetCwd = inspection.cwd
  }
  if (!(await isDirectory(targetCwd))) throw new Error(`目标目录不存在：${targetCwd}`)
  if (targetWorkspace !== undefined && targetWorkspace.sessionIds !== undefined) {
    // 无需额外校验：attachSession 会再用 header.cwd 复核一次
  }
  const wantedTitle = typeof options.title === 'string' ? options.title.trim() : ''

  const persistence = services.persistence
  if (persistence === undefined) throw new Error('会话存储还没就绪')
  const snapshots = await persistence.list()
  const sample = snapshots.find(item => typeof item.location?.path === 'string')
  if (sample === undefined) throw new Error('读不到会话根目录')
  const root = dirname(dirname(dirname(sample.location.path)))

  const sourceDir = join(IMPORT_ROOT, name, inspection.sessionDirName)
  const logPath = join(sourceDir, 'session.v4.jsonl.zstd')
  const original = await readFile(logPath)
  const newId = `session-${randomUUID()}`

  // 整份重写：换 id、换 cwd，并把事件里引用了旧 id 的地方（例如
  // session-log-deepseek/delivery-accepted 的 sessionId 字段）一起改掉。
  // 这些标记会与 header 比对，漏改就会被判成「日志损坏」。
  const text = decodeLog(original).toString('utf8')
  const lines = text.split('\n').filter(line => line !== '')
  const header = JSON.parse(lines[0])
  if (header?.type !== 'session') throw new Error('头部不是 session 记录')
  const oldId = String(header.id)
  header.id = newId
  header.cwd = targetCwd

  let lastSeq = -1
  const eventLines = []
  for (let index = 1; index < lines.length; index += 1) {
    let event
    try {
      event = JSON.parse(lines[index])
    } catch {
      throw new Error('日志里有读不动的记录')
    }
    if (typeof event.seq === 'number' && event.seq > lastSeq) lastSeq = event.seq
    if (oldId !== newId && lines[index].includes(oldId)) event = replaceIdDeep(event, oldId, newId)
    eventLines.push(JSON.stringify(event))
  }

  if (wantedTitle !== '') {
    eventLines.push(JSON.stringify({
      type: 'session/title',
      seq: lastSeq + 1,
      time: Date.now(),
      data: { title: wantedTitle, messageSeqs: [], source: { kind: 'user' } },
    }))
  }

  // 第一帧只能是单独一行 header；其余事件放第二帧
  const bytes = Buffer.concat([
    encodeFrame(`${JSON.stringify(header)}\n`),
    eventLines.length === 0 ? Buffer.alloc(0) : encodeFrame(`${eventLines.join('\n')}\n`),
  ])

  const destDir = join(root, projectKey(targetCwd), newId)
  await mkdir(destDir, { recursive: true })
  for (const entry of await readdir(sourceDir)) {
    const from = join(sourceDir, entry)
    if (from === logPath) continue
    await copyFile(from, join(destDir, entry)).catch(() => {})
  }
  const destPath = join(destDir, 'session.v4.jsonl.zstd')
  const staging = `${destPath}.import-tmp`
  await writeFile(staging, bytes)
  await rename(staging, destPath)

  if (targetWorkspace !== undefined) {
    try {
      await targetWorkspace.attachSession(newId)
    } catch (error) {
      ctx.logger?.warn?.(`[session-mover] 导入后归组失败：${error?.message ?? error}`)
    }
  } else {
    await attachOne(ctx, newId).catch(() => false)
  }
  return { sessionId: newId, title: wantedTitle === '' ? inspection.title : wantedTitle, cwd: targetCwd, destDir }
}

/** 把标题变成安全的目录名。 */
function safeDirName(input) {
  const cleaned = String(input ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 80)
  return cleaned === '' ? '未命名会话' : cleaned
}

/**
 * 导出一个会话：在 EXPORT_ROOT 下建同名文件夹，把 session-<id> 目录复制进去。
 *
 * 只复制、不移动：原会话目录原地不动，导出目录里是完整副本（含 zstd 日志与 lock）。
 */
async function exportSession(ctx, sessionId) {
  const persistence = services.persistence
  if (persistence === undefined) throw new Error('会话存储还没就绪')
  const snapshots = await persistence.list()
  const snapshot = snapshots.find(item => item.header.id === sessionId)
  if (snapshot === undefined) throw new Error('找不到该会话')
  const sourcePath = snapshot.location?.path
  if (typeof sourcePath !== 'string' || sourcePath === '') throw new Error('该会话还没有落盘文件')
  const sourceDir = dirname(sourcePath)

  const title = (await titleOf(sourcePath, new Map())) || `会话 ${String(sessionId).slice(0, 8)}`
  const folder = join(EXPORT_ROOT, safeDirName(title))
  const destDir = join(folder, basename(sourceDir))

  await mkdir(folder, { recursive: true })
  // 重复导出同一个会话时替换旧副本，不叠加
  await rm(destDir, { recursive: true, force: true })
  await cp(sourceDir, destDir, { recursive: true, preserveTimestamps: true })
  return { folder, destDir }
}

/**
 * 给镜像出来的 Markdown 打个「已删除」标记。
 *
 * 文件名是会话标题，会话 id 写在正文里，所以按正文里的 id 找文件，
 * 找到就把文件名改成 `<原名>（已删除）.md`。找不到就算了，不影响删除。
 */
async function markArchiveDeleted(sessionId) {
  let entries
  try {
    entries = await readdir(ARCHIVE_DIR)
  } catch {
    return undefined
  }
  const needle = `会话 ID：\`${sessionId}\``
  for (const name of entries) {
    if (!name.endsWith('.md')) continue
    if (name.includes(ARCHIVE_MARK)) continue
    const filePath = join(ARCHIVE_DIR, name)
    let head
    try {
      head = await readFile(filePath, 'utf8')
    } catch {
      continue
    }
    if (!head.slice(0, 2048).includes(needle)) continue
    const next = join(ARCHIVE_DIR, `${name.slice(0, -3)}${ARCHIVE_MARK}.md`)
    try {
      await rename(filePath, next)
      return next
    } catch {
      return undefined
    }
  }
  return undefined
}

/** 删除一个会话：挪目录 → 摘登记 → 清投影缓存 → 真正删除。 */
async function deleteSession(ctx, sessionId, password) {
  if (password !== DELETE_PASSWORD) throw new Error('密码不对')
  const registry = services.registry
  const persistence = services.persistence
  const sessions = services.sessions
  if (registry === undefined || persistence === undefined) throw new Error('工作区/会话存储服务还没就绪')
  if (sessions?.get?.(sessionId) !== undefined) throw new Error('这个会话正在打开，请先关掉它再删除')

  const snapshots = await persistence.list()
  const snapshot = snapshots.find(item => item.header.id === sessionId)
  if (snapshot === undefined) throw new Error('找不到该会话')
  const sourcePath = snapshot.location?.path
  if (typeof sourcePath !== 'string' || sourcePath === '') throw new Error('该会话还没有落盘文件')
  const sourceDir = dirname(sourcePath)

  const sessionHome = dshHomeOf(sourceDir)
  const trashRoot = join(sessionHome, 'trash-sessions')
  const projCacheRoot = join(sessionHome, 'storages', 'session_projcache', 'sessions')

  await mkdir(trashRoot, { recursive: true })
  const trashDir = join(trashRoot, `${sessionId}-${Date.now()}`)
  await rename(sourceDir, trashDir)

  try {
    for (const workspace of registry.list()) {
      await workspace.detachSession(sessionId)
    }
    if ((registry.archivedSessionIds ?? []).includes(sessionId)) {
      await registry.unarchiveSession(sessionId)
    }
    if ((registry.pinnedSessionIds ?? []).includes(sessionId)) {
      await registry.unpinSession(sessionId)
    }
  } catch (error) {
    await rename(trashDir, sourceDir).catch(() => {})
    throw error
  }

  await rm(join(projCacheRoot, `${sessionId}.json`), { force: true }).catch(() => {})
  await rm(trashDir, { recursive: true, force: true }).catch(() => {})
  await markArchiveDeleted(sessionId).catch(() => undefined)
}

/** 把一个会话按 cwd 归到对应工作区；已经归好或不匹配就返回 false。 */
async function attachOne(ctx, sessionId) {
  const registry = services.registry
  const persistence = services.persistence
  if (registry === undefined || persistence === undefined) return false
  const archived = new Set(registry.archivedSessionIds ?? [])
  if (archived.has(sessionId)) return false
  for (const workspace of registry.list()) {
    if (workspace.sessionIds.includes(sessionId)) return false
  }
  const snapshots = await persistence.list()
  const snapshot = snapshots.find(item => item.header.id === sessionId)
  const cwd = snapshot?.header.cwd
  if (typeof cwd !== 'string' || cwd === '') return false
  const target = registry.list().find(workspace => workspace.path === cwd)
  if (target === undefined) return false
  try {
    await target.attachSession(sessionId)
    return true
  } catch (error) {
    ctx.logger?.warn?.(`[session-mover] 自动归组 ${sessionId} 失败：${error?.message ?? error}`)
    return false
  }
}

async function syncUngrouped(ctx) {
  const registry = services.registry
  const persistence = services.persistence
  if (registry === undefined || persistence === undefined) return []
  const archived = new Set(registry.archivedSessionIds ?? [])
  const workspaces = registry.list()
  const byPath = new Map()
  const known = new Set()
  for (const workspace of workspaces) {
    byPath.set(workspace.path, workspace)
    for (const id of workspace.sessionIds) known.add(id)
  }
  const snapshots = await persistence.list()
  const attached = []
  for (const snapshot of snapshots) {
    const id = snapshot.header.id
    const cwd = snapshot.header.cwd
    if (typeof cwd !== 'string' || cwd === '') continue
    if (known.has(id) || archived.has(id)) continue
    const target = byPath.get(cwd)
    if (target === undefined) continue
    try {
      await target.attachSession(id)
      known.add(id)
      attached.push(id)
    } catch (error) {
      ctx.logger?.warn?.(`[session-mover] 自动归组 ${id} 失败：${error?.message ?? error}`)
    }
  }
  return attached
}

export function apply(ctx, config = {}) {
  if (typeof ctx.inject === 'function') {
    ctx.inject(['workspaceRegistry', 'sessionPersistence', 'sessions'], (child) => {
      services.registry = child.workspaceRegistry
      services.persistence = child.sessionPersistence
      services.sessions = child.sessions
      // 会话一创建就归组，不等轮询。created 时会话已进 store，header 里有 cwd。
      child.on('session/created', (session) => {
        const id = session?.id
        if (id === undefined) return
        void attachOne(ctx, id).catch(() => false)
      })
    })
  }
  const webServer = ctx.webServer
  if (webServer === undefined || typeof webServer.register !== 'function') {
    ctx.logger?.warn?.('[session-mover] 宿主没有 webServer，面板将无法读写')
    return
  }

  // 启动时补一次历史遗留（此前创建、还没登记的会话）；之后完全由 session/created 事件驱动。
  setTimeout(() => { void syncUngrouped(ctx).catch(() => []) }, 3000)

  const disposers = [
    webServer.register({
      kind: 'exact',
      path: ROUTE_STATE,
      handler: async (req, res) => {
        try {
          reply(res, 200, { ok: true, ...(await readState(ctx)) })
        } catch (error) {
          reply(res, 500, { ok: false, error: String(error?.message ?? error) })
        }
      },
    }),
    webServer.register({
      kind: 'exact',
      path: ROUTE_QQ,
      handler: async (req, res) => {
        try {
          if (req.method === 'POST') {
            const body = await readJsonBody(req)
            const sessionId = String(body.sessionId ?? '').trim()
            const openid = String(body.openid ?? '').trim()
            const scope = String(body.scope ?? 'c2c')
            const key = String(body.key ?? '').trim()
            if (scope !== 'c2c' && scope !== 'group') throw new Error('类型只能是 c2c 或 group')

            if (!(await isFile(QQ_PREFS))) {
              throw new Error(`本机没有 QQ 机器人映射文件：${QQ_PREFS}（装上 qqbot 插件并跑过一次后才会生成）`)
            }

            const prefs = await readQqPrefs()
            let targetKey = key
            if (targetKey === '') {
              if (openid === '') throw new Error('openid 不能为空')
              const storedAppId = (body.appId !== undefined && String(body.appId) !== '' ? String(body.appId) : undefined)
                ?? entriesAppId(prefs)
              if (storedAppId === undefined) throw new Error('缺少机器人 appId —— 先手工建一条映射，或在配置文件里补 appId')
              targetKey = `qqbot:${storedAppId}:${scope}:${openid}`
            } else if (!targetKey.startsWith('qqbot:')) {
              throw new Error('映射键格式不对')
            }

            if (sessionId === '') {
              delete prefs.sessionIds[targetKey]
            } else {
              const persistence = services.persistence
              if (persistence === undefined) throw new Error('会话存储还没就绪')
              const snapshots = await persistence.list()
              if (!snapshots.some(item => item.header.id === sessionId)) throw new Error('目标会话不存在')
              prefs.sessionIds[targetKey] = sessionId
            }
            await writeQqPrefs(prefs)
            reply(res, 200, { ok: true, ...(await readQqState(ctx, new Map())) })
            return
          }
          reply(res, 200, { ok: true, ...(await readQqState(ctx, new Map())) })
        } catch (error) {
          reply(res, 500, { ok: false, error: String(error?.message ?? error) })
        }
      },
    }),
    webServer.register({
      kind: 'exact',
      path: '/session-mover/probe-read',
      handler: async (req, res) => {
        try {
          const url = new URL(String(req.url ?? '/'), 'http://local')
          const sessionId = url.searchParams.get('sessionId') ?? ''
          const query = ctx.get?.('sessionQuery')
          if (query === undefined) throw new Error('没有 sessionQuery 服务')
          const snapshot = await query.readSession(sessionId)
          reply(res, 200, {
            ok: true,
            events: (snapshot?.events ?? []).length,
            header: snapshot?.header ?? null,
          })
        } catch (error) {
          reply(res, 500, {
            ok: false,
            error: String(error?.message ?? error),
            stack: String(error?.stack ?? '').split('\n').slice(0, 5).join('\n'),
          })
        }
      },
    }),
    webServer.register({
      kind: 'exact',
      path: ROUTE_IMPORT,
      handler: async (req, res) => {
        try {
          if (req.method === 'POST') {
            const body = await readJsonBody(req)
            const name = String(body.name ?? '').trim()
            if (name === '' || name.includes('/') || name.includes('..')) throw new Error('名称不合法')
            const result = await importSession(ctx, name, {
              title: body.title,
              workspaceId: body.workspaceId,
              cwd: body.cwd,
            })
            reply(res, 200, {
              ok: true,
              message: `已导入「${result.title}」`,
              sessionId: result.sessionId,
              path: result.destDir,
              ...(await (async () => ({ candidates: await listImports() }))()),
            })
            return
          }
          reply(res, 200, { ok: true, candidates: await listImports() })
        } catch (error) {
          reply(res, 500, { ok: false, error: String(error?.message ?? error) })
        }
      },
    }),
    webServer.register({
      kind: 'exact',
      path: ROUTE_EXPORT,
      handler: async (req, res) => {
        try {
          if (req.method !== 'POST') {
            reply(res, 405, { ok: false, error: '只接受 POST' })
            return
          }
          const body = await readJsonBody(req)
          const sessionId = String(body.sessionId ?? '').trim()
          if (sessionId === '') throw new Error('缺少 sessionId')
          const result = await exportSession(ctx, sessionId)
          reply(res, 200, { ok: true, message: `已导出到 ${result.destDir}`, path: result.destDir })
        } catch (error) {
          reply(res, 500, { ok: false, error: String(error?.message ?? error) })
        }
      },
    }),
    webServer.register({
      kind: 'exact',
      path: ROUTE_DELETE,
      handler: async (req, res) => {
        try {
          if (req.method !== 'POST') {
            reply(res, 405, { ok: false, error: '只接受 POST' })
            return
          }
          const body = await readJsonBody(req)
          const sessionId = String(body.sessionId ?? '').trim()
          const password = String(body.password ?? '')
          if (sessionId === '') throw new Error('缺少 sessionId')
          await deleteSession(ctx, sessionId, password)
          reply(res, 200, { ok: true, message: '已删除' })
        } catch (error) {
          reply(res, 500, { ok: false, error: String(error?.message ?? error) })
        }
      },
    }),
    webServer.register({
      kind: 'exact',
      path: ROUTE_MOVE,
      handler: async (req, res) => {
        try {
          const body = await readJsonBody(req)
          const sessionId = String(body.sessionId ?? '')
          const targetWorkspaceId = String(body.targetWorkspaceId ?? '')
          if (sessionId === '' || targetWorkspaceId === '') {
            reply(res, 400, { ok: false, error: '缺少 sessionId 或 targetWorkspaceId' })
            return
          }
          const message = await moveSession(ctx, sessionId, targetWorkspaceId)
          reply(res, 200, { ok: true, message })
        } catch (error) {
          reply(res, 500, { ok: false, error: String(error?.message ?? error) })
        }
      },
    }),
  ]

  ctx.effect?.(() => () => {
    for (const dispose of disposers) dispose()
  }, 'session-mover.routes')
}

export { decodeLog, encodeFrame, projectKey, moveSession, readState, markArchiveDeleted, exportSession, listImports, importSession }
