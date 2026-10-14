# DSH 运行时依赖必须共用同一实例

同一进程中的 DSH 服务需要使用同一份物理运行时包，仅版本号相同还不够。例如 dsh-scope 使用模块内的 Symbol("dsh.scope") 和 WeakMap；两份拷贝不能识别对方创建的 Agent 作用域，可能把 Agent 内的注册误判成全局注册。

2026-09-11 用户环境出现的实际故障：

- Web profile 与 npx 宿主目录同时存在物理独立的 DSH 包。
- 运行中反复出现 `deployment:persona-prefix is already registered` / `standard failed to mount`。
- DSH 主进程接近 100% CPU；原生会话恢复与 token 投影是采样热点，多个页面超时。
- 双模块最小复现实验证明，宿主 scope 能识别自身上下文，profile 副本识别为 undefined。

本次已将 profile 内 36 个重复的 @deepseek-ai 包备份，再链接到当前宿主对应包；没有删除会话、微信绑定或凭证。备份目录：`~/.dsh/backups/runtime-dedupe-20260911-145701/`，`manifest.json` 逐项记录原路径、备份路径和目标。

修复后实际主进程 CPU 约 0.2%，状态接口约 2 ms、会话列表约 50 ms；原 Chrome 页面恢复。这个结论来自修复前后对照，不以浏览器通用错误文案判断根因。

## 预防

- 使用 `npm run dsh:web`。启动器检查 Web profile 是否存在另一份物理运行时，发现时在启动前明确报错。
- 微信插件将 Host 提供的 peer 标记为 optional，避免安装本插件时主动补装另一套 DSH Runtime。
- 不要在 profile 中用 npm 手工补装整套 DSH peer。插件作者声明的 peer 应与宿主提供的同一实例协作。
- 如果重新安装其他插件后再次产生重复包，先停 DSH，再依据宿主实际版本备份并统一对应依赖；不要盲目删除 node_modules 或直接覆盖包源码。

## 发送队列

不确定的发送记录保留人工核对入口。它只阻塞同一条任务回复的后续分片，不能阻塞其他任务的回复。不能把 API 未确认的记录改成 sent，也不能自动重复执行对应任务。
