# dsh-plugin-session-mover（会话变动）

一个本地 DSH（DeepSeek Harness）插件。纯 JavaScript，无构建步骤、无依赖。

在左侧栏加一个 **会话变动** 面板，五个标签页：

| 标签 | 做什么 |
|---|---|
| 会话移动 | 把会话挪到另一个工作区。会话 **id 与全部历史不变**，只改写日志第一帧的 `cwd`、移动目录、改工作区归属 |
| QQ 映射 | 读写 `~/.dsh-qqbot/model-prefs.json`（QQ 会话 → 模型偏好），改完需重启宿主；文件不存在时该栏自动禁用 |
| 会话删除 | 必须输确认口令（默认 `confirm_modification`，可自行改）；目录先进回收站再从工作区摘除；成功后在 `~/AI会话记录/` 的镜像文件名后加「（已删除）」 |
| 会话导出 | 完整复制到 `~/导出会话/<会话名>/session-<id>/` |
| 会话导入 | 从 `~/导入会话/` 读副本，生成新 id（唯一会改 id 的流程），可改名、选工作区 |

详细行为与限制见 [docs/DETAIL.md](docs/DETAIL.md)。

## 安装

在 DSH 里用插件管理器安装这个包目录（克隆后的仓库根目录）：

```
plugin_manager  action=install_bundle  target=/绝对路径/dsh-plugin-session-mover
```

或图形界面：**插件 → 添加插件**，选这个目录。

宿主半依赖 `webServer` 服务；浏览器半依赖 `@deepseek-ai/dsh-client-ui-layout` 与 `@deepseek-ai/dsh-client-ui-sidebar`，两者由 dsh 自带，无需声明依赖。

## 结构

```
package.json        # dsh.bundle.patch + dsh.client 两段声明
cordis.patch.yml    # 往 Loader 里插入插件行
index.js            # 宿主半：路由 + 会话日志读写
client.js           # 浏览器半：__ModuleLoader__.load + slots.register
icon.svg
locale/{zh,en}.json # 插件管理里显示的标题/描述
docs/DETAIL.md      # 详情页
```

## 目录与可移植性

没有写死的绝对路径，装到谁的机器上都按下面这套走：

| 用途 | 默认位置 | 环境变量覆盖 |
|---|---|---|
| 导入目录 | `~/导入会话` | `SESSION_MOVER_IMPORT_DIR` |
| 导出目录 | `~/导出会话` | `SESSION_MOVER_EXPORT_DIR` |
| 存档目录（可选） | `~/AI会话记录` | `SESSION_MOVER_ARCHIVE_DIR` |
| QQ 映射文件（可选） | `~/.dsh-qqbot/model-prefs.json` | `DSH_QQBOT_PREFS` |

回收站（`<DSH 数据目录>/trash-sessions`）和投影缓存目录不猜路径：从会话日志的实际位置往上游三级反推 DSH 数据目录，所以 DSH 装在哪儿、`DSH_HOME` 叫什么都不影响删除。

- 存档目录和 QQ 映射文件**不存在就优雅退化**：删除时跳过改名，QQ 标签显示「本机没有这个文件，这一栏不可用」。
- 导入目录不存在时会自动建一个空目录。

## 注意

- **删除口令是 `index.js` 里的明文常量** `DELETE_PASSWORD`，默认 `confirm_modification`。想换成自己的密码就改这一行；它不是安全边界，只是拦一下误操作。
- 碰了不少宿主内部 API（`workspaceRegistry` 的 `indexHeader`/`archivedSessionIds`、`sessionPersistence`、`sessionQuery`、`sessions.get`），DSH 大版本升级后需要复核。
- 正在打开的会话不让移动或删除——存储句柄还指着旧路径，会提示先关掉它。
- Linux/macOS 上验证过；Windows 只用平台无关的 `node:path` 与 `realpath` 写，未实测。
- 需要 **Node ≥ 22.15**：读写会话日志用的是 `node:zlib` 的 zstd API。
