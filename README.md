# DSH 微信插件

通过个人微信向电脑端 DeepSeek Harness 发消息、图片和文件，并接收任务回复与产物。支持单人绑定、消息持久化、管理面板和 DSH 原生会话关联。

独立实现，不依赖其他个人微信桥接项目。插件复用当前 DSH 的 Agent、模型、工具和权限，不启动另一套 Agent Runtime。

## 当前版本与安装

插件 **0.1.0** 适配 **DSH `0.2.0-rc.2`**（npm 当前 latest）。Node 22.18+；本项目验证环境为 Node 24.21.0 / Windows 11。DSH 0.1.5 及更早系列请使用上游插件版本，不要混用组件。

本项目目录中的推荐启动方式：

```sh
npm run dsh:web
```

启动器优先复用本机已安装且版本一致的 DSH，并检查 profile 是否存在重复的物理运行时包，避免作用域冲突；不会每次重新下载整套依赖。没有兼容安装时会给出明确安装指引，也支持 `DSH_CLI=/绝对路径/dsh/lib/bin.js`。

自动探测不到 CLI 时（例如全局安装不在 `~/.npm/_npx` 或 `~/.dsh/profiles` 下）显式指定即可：

```sh
# POSIX
DSH_CLI=/绝对路径/node_global/node_modules/@deepseek-ai/dsh/lib/bin.js npm run dsh:web
```

```powershell
# Windows PowerShell
$env:DSH_CLI = "C:\Users\<你>\tools\node_global\node_modules\@deepseek-ai\dsh\lib\bin.js"
npm run dsh:web
```

从源码首次安装（在本项目目录执行；`npm install` 后需要 `npm run build` —— 构建产物 `lib/` 已随仓库提交，因此从 Git 或 tgz 安装的消费方不需要自己构建）：

```sh
npm install
npm run build
npx --yes @deepseek-ai/dsh@0.2.0-rc.2 plugin --profile web add /你的绝对路径/dsh-wechat-channel
npm run dsh:web
```

本地目录的 `add` 只建立链接，不会替源码目录安装开发依赖或执行 `prepare`，因此首次仍需先执行上面的 `npm install`。已经以本地目录安装过的用户，更新源码后执行 `npm run build`，再重启 DSH 并刷新浏览器。

分发给其他用户时，可打包为包含构建产物的 tgz：

```sh
npm pack
dsh plugin --profile web add /你的绝对路径/dsh-wechat-channel-0.1.0.tgz
```

`npm pack` 会通过 `prepack` 自动构建（打包者需先安装开发依赖）；接收 tgz 的用户直接 `add` 即可，无需安装构建工具或手动编译。开发验证仍可执行 `npm run check`。

不用本项目启动器时，可直接运行当前已验证版本：

```sh
npx --yes @deepseek-ai/dsh@0.2.0-rc.2 web
```

DSH 会打印带登录凭据的本机启动链接，请从该链接打开页面。管理接口和附件下载均复用 DSH 的登录 Cookie；只打开不含凭据的旧地址可能收到 401。不要公开分享启动链接。

当前支持 DSH Web profile（电脑浏览器），Host 监听 `127.0.0.1`。Electron 原生 IPC-only 版本未验证。图片和普通文件均使用最新版 DSH 的原生持久化附件引用。

## 验证边界

已执行类型检查、自动化测试、构建和真实官方 DSH 隔离 Host 验证；安装自动激活、Client 资源、原生附件、会话恢复与鉴权均有测试。详细结果见 [兼容性记录](docs/runbook/compatibility.md)。

真实微信扫码绑定后的文本、图片、文件互通仍按用户安排留待之后；本次不登录用户微信、不调用用户模型账户。

## 使用

1. 打开 DSH 设置中的 **微信**。
2. 点击扫码绑定，用自己的微信扫描二维码；登录确认后，在电脑面板确认显示的本人身份。
3. 选择一个已有的 DSH 会话，再启动连接。尚无会话时先在 DSH 创建。
4. 在微信发送文字、图片或文件。插件会将消息交给所选会话，图片或文件准备失败会阻止后面的普通消息越过它。
5. 在“消息”查看处理和投递状态、预览图片或下载附件；在“执行与确认”打开对应 DSH 会话，然后进入原生 Trajectory。

面板关闭后，只要 DSH Host 仍运行，已启动的连接就会继续。插件默认不自动启动连接；需要随 Host 重启恢复时，设置插件配置 `autoStart: true`。

### 微信指令

- `/status`：连接与当前会话。
- `/stop`：停止当前绑定中微信发起的任务，保留其他桌面输入。
- `/approve 编号`、`/deny 编号`：处理仍有效的工具确认。
- `/answer 编号 回答`：回复单个问题。多字段问题在 DSH 中回答。
- `/help`：查看帮助。

修改目标会话在面板完成，只影响新收到的消息。回复出站只关联微信发起的任务，不转发其他桌面任务内容。

### 发送任务产物

Agent 可调用 `wechat_send_attachment`，指定当前工作区内的绝对文件路径。文件被复制为不可变快照，然后通过微信发送；支持常见栅格图片以及普通文件。只有正在执行的微信任务可以调用该工具，发送排队不代表微信已收到。

### 失败恢复

- **Failed to fetch / ERR_BLOCKED_BY_CLIENT**：这是浏览器到本机 DSH 的请求失败，不等于微信登录失败。若 Chrome 错误页明确显示屏蔽，请检查该站点的浏览器策略；不要反复扫码或清理凭证。
- **附件失败**：重试或取消该消息；取消前后续普通消息保持排队。
- **执行状态待核对**：不自动重跑。先在 DSH 查对应会话；必要时取消该条，再明确发送新任务。
- **等待新的微信消息**：在微信再发送一条消息刷新回复上下文。
- **发送结果待核对**：先查看微信是否已经收到，确认后才选择重新发送；可能重复。
- **微信接口已接受**：仅表示 iLink 返回接受成功，不代表用户已读。

## 数据与资源

默认数据在 `$DSH_HOME/plugins/wechat`；未设置 DSH_HOME 时使用 `~/.dsh/plugins/wechat`。插件配置 `dataDir` 可覆盖该位置。

- `bridge.sqlite`：消息、状态、会话映射和加密协议描述符。
- `credentials/key`：仅当前用户可读的本地加密密钥。数据库中的 bot token、回复上下文和媒体密钥经 AES-GCM 加密。
- `blobs/`：入站原始附件与出站快照，默认不自动删除，以免破坏 DSH 文件引用。
- `host.lock`：单 Host 锁。

默认限制：图片 20 MiB、文件 100 MiB、附件目录 2 GiB。当前媒体为有界内存缓冲，单个媒体请求串行，100 MiB 文件会带来额外内存占用。更严格的 DSH/协议限制仍然有效。

本地备份应在停用插件后同时保存数据库、WAL（若存在）、密钥和附件；不要只恢复旧数据库后立即重新收发。外部已执行的 DSH 操作无法通过数据库回退撤销。

## 开发与验证

```sh
npm run typecheck
npm test
npm run build
npm run format:check
```

- [设计方案](docs/design/wechat-plugin.md)
- [兼容性证据](docs/runbook/compatibility.md)
- [实施状态与剩余验收](docs/runbook/implementation.md)
- [验收清单](docs/design/wechat-plugin-checklist.md)

`scripts/ui-preview.mjs` 是仅供开发的虚构数据界面测试服务，不会连接微信或 DSH。
