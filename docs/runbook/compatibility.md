# 0.1.0 适配基线：DSH 0.2.0-rc.2

本版本由上游 0.2.1 改名（`dsh-wechat-channel`）并升级基线而来，针对 npm 当前 latest 的 DSH `0.2.0-rc.2`（入口与 `dsh-agent` / `dsh-web-app` / `dsh-settings` 组件同为 `0.2.0-rc.2`）。相对上游的改动：

- **peerDependencies 基线**：`@deepseek-ai/dsh-agent` 由钉死 `0.1.5-rc.2` 改为 `>=0.2.0-rc.2 <0.3.0-0`。DSH 0.2 自带插件兼容闸门，会拿 `@deepseek-ai/dsh*` 的 peer 与运行时版本比对，旧值会让 `dsh plugin add` 直接拒绝安装。
- **`dsh.client.inject`**：删除 0.2 已不存在的 `@deepseek-ai/dsh-client-runtime`；`slots` / `sessions` 客户端服务与 React 由 Web shell 的静态模块表提供，`settings.section` 槽位仍由 `@deepseek-ai/dsh-client-ui-settings` 提供。
- **`typertGateway.wireStream.open` 签名**：0.2 变为 `open(endpoint, payload, uplink, peer, signal)`，插件原先按 0.1 的 `open(endpoint, payload, signal)` 调用，导致真正的 signal 位置变成 `undefined`，`AbortSignal.any` 抛 `signals[0] is not of type AbortSignal`。现按 5 参数调用，`$events` 作为 Gateway 自有流配一个立即半关闭的空 uplink。
- **插件标识**：包名、插件 id、客户端 bundle id、HTTP 路由（`/dsh-wechat-channel/api`）、请求标记头与默认数据目录（`$DSH_HOME/plugins/wechat-channel`）统一改名，避免与同名插件共存时冲突。
- **运行时校验**：`scripts/dsh-runtime.mjs` 由钉死单一补丁版本改为校验 `0.2.` 线内的版本，并保持要求各组件彼此一致（混装仍会报错）。
- **脚本的 Windows 兼容**：`scripts/dsh-loop-smoke.mjs` 之前把 `C:\...` 绝对路径当 ESM 模块说明符写入探针，Windows 上必然 `ERR_UNSUPPORTED_ESM_URL_SCHEME`，现改用 `pathToFileURL`；`scripts/dsh-smoke.mjs` 的探针改用 0.2 的批量 `attachments.saveImages([...])`，并对 agent factory 注册晚于插件激活的情况加了有界重试；devDependencies 里钉死的 `react` / `@types/react` 放宽为 caret，否则新 lockfile 与 `react-dom` 的 peer 范围冲突。

以下为上游历史记录，其中版本信息只对 DSH 0.1.5 系列有效。

# 0.2.1 运行修复

当前实现额外使用 sessionController.resolveAgent 进行模型和 preset 完整恢复。iLink 发送按可省略 ret 的默认零语义判定成功；发送顺序约束限定在同一任务的分片内。运行时单实例问题与备份说明见 runtime-deduplication.md。

# 当前适配基线：插件 0.2.0

2026-09-11 npm latest 的 DSH 入口为 0.1.5-rc.1，实际配套服务组件为 0.1.5-rc.2。本文下方旧版记录是历史证据；当前实现以本节和“最新版适配”部分为准。

- Host 不再依赖 apiProxy，改用 sessionQuery、typertGateway、connection。
- 图片、文件均为原生持久化附件，文件使用 saveFileStream。
- 所有插件 HTTP 读写及附件下载都调用官方 connection.requestRejection。
- 安装后由 dsh.bundle.patch 自动激活，脚本通过真正 plugin add 验证，不能用手工插入插件行代替。
- npm run dsh:web 会核验并复用兼容本机安装；不会随内部包的独立 latest 标签拼装版本。

以下为历史记录及各轮接入证据。

# DSH compatibility

## Supported runtime

This adapter targets `@deepseek-ai/dsh@0.1.5-rc.1` with the official `0.1.5-rc.2` component packages. Older `apiProxy` integration is removed. The host requires `agents`, `sessions`, `attachments`, `sessionQuery`, `typertGateway`, `connection`, and the existing tool/Web UI services.

## Verified source contracts

Contracts were checked against the installed official package JS and declarations, not the third-party WeChat bridge:

- `dsh-agent/lib/types/runtime-types.d.ts`: `followup`, `inbox.remove`, cancellation with `keepInbox`; existing live agents remain borrowed and only adapter-resumed handles are disposed.
- `dsh-session/lib/types/types.d.ts`: durable `agent/inbox/spliced`, `user/message`, turn boundaries, and assembled `assistant/message.data.message.content`. `stream`, `step`, and `interrupted` are part of current assistant records. Turn and terminal sequence remain available for native Trace association.
- `dsh-session/lib/types/index.d.ts`: current immutable history is `session.snapshotEvents()` (the old `.events` property is absent); exact Trace positions use `eventAt(seq)`. `sessions.flush(session)` is the durability checkpoint. Submission/reconciliation and terminal publication must wait for successful flush.
- `dsh-session-query/lib/types/index.d.ts`: `sessionQuery.listSessions()` returns records with `header`, `live`, and `persisted`; the adapter excludes subagent origins and overlays current Agent status.
- `dsh-attachment/lib/types/index.d.ts`: image `saveImages`; file `saveFileStream` stores exact bytes and returns `{attachmentId,name,bytes}`. Both use native message attachment blocks. Plugin input identity is rechecked after attachment I/O to prevent duplicate submission.
- `dsh-tools/lib/types/index.d.ts`: attachment sending still uses `tools.register` with canonical output schema/render and exact current Agent identity.

## Shared interaction arbitration

The plugin opens the official `typertGateway.wireStream.open('$events', {args:{}}, signal)` carrier. It waits for the `ready` frame, handles `approval/request` and `user-questions/request` waterfall frames, and consumes cancellation frames. Other events and unrelated desktop turns explicitly delegate with `kind:next`.

Responses use `connection.createSharedFetchHandler('/api')` to dispatch the standard `$events/result` envelope in process. The Host holds this capability; it is not exposed as a browser-authentication bypass. Management routes retain their own Connection authentication. Desktop and WeChat responses reach the **same Gateway pending-event arbiter**; no second approval service or local competing tool execution is introduced.

The Gateway acknowledges transport receipt even if another client already answered. Therefore the plugin's boolean response means “submitted to DSH”, not “WeChat necessarily won a simultaneous desktop response”. Gateway cancellation prevents subsequent known-late local responses; DSH approval audit events remain authoritative. A plugin/Host restart does not recreate withdrawn approvals from persisted WeChat messages.

## Validation scope

Adapter tests cover concurrent retry deduplication, persistence failure/recovery, flush before terminal publication, live Agent ownership, cancellation preserving desktop input, current Gateway ready/waterfall/cancel envelopes, single-shot answers, cold session listing, native file storage before followup, and session/turn/sequence Trace correlation. Full Host startup and real WeChat/model testing must be reported separately; these adapter fixtures alone do not establish end-to-end compatibility.

## Deterministic real-loop smoke

Run `node scripts/dsh-loop-smoke.mjs` after building the plugin. It installs into a temporary `DSH_HOME`, uses an empty temporary workspace, registers a local `LlmAdapter` through the official provider seam, and submits text, image, and file messages through the actual adapter and Agent loop. It checks completed turns, extracted responses, native session attachment blocks, terminal sequence references, and retry deduplication. No provider HTTP request or iLink login is performed; the temporary Host is stopped afterward.

The official LLM layer projects native file blocks to a read-only saved-path text handle for every provider (`dsh-llm` `projectFilesToText`). Thus a file remains a native attachment in DSH session history while the provider receives text. This is intentional DSH behavior, not a plugin fallback.
