# OpenCode Go Automatic Key Sync Design

## 中文

### 目标

在用户已通过远端隔离浏览器完成 OpenCode Google 登录后，New API 自动进入该账户的 API Keys 页面、触发已有 Key 的复制控件、仅在复制内容通过 API key 语义校验时写入加密凭证，并在同一受控操作中刷新 OpenCode Go 配额与激活绑定通道。

### 实施进度

- 已实现受限 `sync`：仅接受 OpenCode 工作区 Key 页面，使用语义化 Copy 控件和真实 CDP 鼠标事件读取本次复制结果；点击前清空远端浏览器剪贴板，并在服务层串行化复制阶段，避免旧值或多账户并发交叉采集。
- 公开登录状态新增无敏感 `page=keys|workspace`；URL 继续脱敏工作区标识。前端按 `account_id:started_at` 会话键仅自动同步一次，并保留显式 Sync 作为失败重试。
- 已实现 root-only `/api/opencode/accounts/:id/sync`，串联加密保存、Go 配额读取和既有激活事务；公开响应只包含账户布尔状态与配额元数据。
- 本地 Node、Go 服务/控制器/路由、前端状态机和类型检查均已通过。已完成远端原子 rollout、版本头、浏览器页面和侧车 smoke 验证。当前未从默认受限状态位置发现可供脱敏探针使用的登录会话；账户级 `/sync` 仍由已认证的前端在 Key 页面自动发起。

### 已验证事实

- 登录浏览器当前可达 OpenCode 的 Key 管理页面，但 cookie、storage 与历史 JSON 响应并不包含 API key。
- OpenCode Go 的公开文档要求将 Zen/Go API key 作为独立凭证使用；网站 session cookie 不能替代该 key。
- `slkiser/opencode-quota` 以 `workspaceId + auth cookie` 请求 Go 配额页面，并从 SSR/data-slot 页面结构读取 rolling、weekly、monthly 窗口。

### 架构

浏览器 sidecar 增加一个受限的 `sync` 操作。它仅允许在 `opencode.ai` 工作区的 Key 页面工作，先导航/确认 API Keys 页面，再定位与 API Key 语义关联的复制控件，真实点击后从浏览器剪贴板读取候选值。sidecar 不输出 key 到日志、截图、状态或 UI；候选值仅作为内部 `browser_state.api_key` 返回给 Go 服务。

Go 服务从同一浏览器状态提取 `workspace_id`、cookie 和 API key。控制器用现有加密模型持久化这些材料，随后调用独立的 Go 配额读取器。该读取器只向固定的 OpenCode Go dashboard URL 发送同源 cookie，解析 usage windows，保存无敏感 JSON 快照。最后复用现有 `ActivateOpenCodeAccount` 事务更新通道 key、唯一 Active 标记和通道缓存。

### 安全与失败语义

- 仅接受明确由 API Key 复制动作产生、非掩码且满足长度/字符约束的剪贴板值。
- 不扫描整页文本，不读取任意剪贴板历史，不把 workspace id 放入公开状态 URL。
- `sync` 没有找到复制控件、复制值无效、配额页面不可解析或通道不兼容时返回分类错误；不会把账户标记为 Active。
- Go 配额失败不回滚成功保存的 API key，但会保留 `LastQuotaCheckedAt` 之前的配额值并将错误安全地返回给调用方。激活只在 API key 成功提取后执行。

### 取舍

不使用 cookie 反推 API key，也不自动创建新的 API key。前者违反上游凭证边界，后者会改变用户账户持久状态且需要命名/轮换策略。实现只复制用户已经存在并在 Key 页面显式暴露给当前隔离浏览器的 key。

## English

### Goal

After a user completes the OpenCode Google sign-in in the remote isolated browser, New API automatically reaches the account's API Keys page, invokes the existing key copy control, persists only a semantically validated API key as encrypted material, refreshes OpenCode Go quota, and activates the bound channel in the same controlled workflow.

### Implementation Status

- A constrained `sync` flow is implemented: it accepts only the OpenCode workspace Key page, uses a semantic Copy control and real CDP mouse events, clears the remote browser clipboard before the click, and serializes the copy phase in the service to prevent stale values or cross-account concurrent capture.
- Public login status now exposes only `page=keys|workspace`; workspace identifiers remain redacted in URLs. The frontend auto-syncs once per `account_id:started_at` session key and retains an explicit Sync retry.
- A root-only `/api/opencode/accounts/:id/sync` endpoint now composes encrypted persistence, Go quota retrieval, and the existing activation transaction; its public response contains only account booleans and quota metadata.
- Local Node, Go service/controller/router, frontend state-machine, and type checks pass. The remote atomic rollout, version header, browser page, and sidecar smoke are complete. No login session was found in the default restricted state location for a redacted probe; the authenticated frontend still initiates account-level `/sync` automatically on the Key page.

### Verified Facts

- The logged-in browser can reach the OpenCode key-management page, while its cookie, storage, and historical JSON responses do not contain an API key.
- OpenCode Go documents the Zen/Go API key as a distinct credential; a website session cookie is not a substitute.
- `slkiser/opencode-quota` reads Go quota from the workspace dashboard with a workspace id and auth cookie, parsing rolling, weekly, and monthly usage windows from SSR/data-slot markup.

### Architecture

The browser sidecar gains a constrained `sync` operation. It operates only on the OpenCode workspace key page, confirms or navigates to API Keys, finds a copy control associated with API-key semantics, performs a real click, and reads the resulting candidate from the browser clipboard. It never logs or renders the key; the candidate is returned only as internal `browser_state.api_key` material to the Go service.

The Go service extracts workspace id, cookie, and API key from the same browser state. The controller persists them through the existing encrypted account model, invokes an isolated Go quota reader against the fixed OpenCode dashboard URL, stores a non-sensitive usage snapshot, then reuses `ActivateOpenCodeAccount` for the channel-key update transaction, exclusive active marker, and channel-cache refresh.

### Security and Failure Semantics

- Accept only a non-masked, length- and character-validated clipboard value produced by an explicit API-key copy action.
- Do not scan arbitrary document text, inspect clipboard history, or expose workspace ids in public status URLs.
- Missing copy controls, invalid copied values, unparsable dashboard quota, and incompatible channels produce classified failures and never mark an account active.
- A quota refresh failure does not roll back a successfully persisted API key. It preserves the previous quota snapshot; activation is attempted only after key extraction succeeds.

### Trade-off

The design neither derives an API key from a cookie nor creates a new key automatically. The former violates the upstream credential boundary; the latter mutates the user's account and requires lifecycle and rotation policy. The implementation copies only a key already exposed to the logged-in isolated browser.
