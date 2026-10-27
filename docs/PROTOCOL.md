# 对端协议

两台机器（或一台电脑 + 手机 App）之间的全部交互都走这套 HTTP 接口，
**没有任何第三方依赖**，只用 Node 内置的 `http`。手机端 `android/.../PeerServer.kt` 实现了同样的一组接口。

- 传输：明文 HTTP/1.1，一次性连接（`Connection: close`），不做 keep-alive
- 编码：JSON（UTF-8）；文件内容走裸字节流
- 端口：桌面端默认 47800，手机端默认 47820

## 鉴权

每个请求带一枚令牌，三种等价写法：

```
Authorization: Bearer <token>
X-Auth-Token: <token>
?token=<token>
```

令牌有两种身份：

| 令牌 | 谁持有 | 能做什么 |
| --- | --- | --- |
| 管理员令牌 | 本机界面（只在本机 127.0.0.1 打开） | 全部管理接口 + 对端接口 |
| 对端令牌 | 配对过的对方 | 只能访问 `/api/peer/*` 里属于它的那一份 |

配对时双方各给对方一枚令牌（`token` 字段），所以**两边都能主动发起**同步。

## 配对

```
POST /api/pair
{ "code": "123456", "id": "<对端自报的设备 id>", "name": "小米手机",
  "port": 47820, "token": "<对端给本机的令牌>", "kind": "peer|client", "platform": "android" }
→ { "token": "<本机给对端的令牌>", "id": "<本机 id>", "name": "<本机名>", "version": "1.1.0" }
```

- `code` 是界面上显示的 6 位配对码，可随时「换一个」
- 失败节流：同一 IP 每分钟最多 8 次，超出返回 429
- `kind=client` 表示"只发起、不提供服务"（旧版手机 App），电脑端不会去枚举它的文件夹

## 对端接口（本机被对方调用）

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/api/peer/greet` | 不需要令牌的自我介绍（`id`/`name`/`port`/`folderCount`），用于连通性测试和"是不是同一个实例" |
| POST | `/api/peer/folders` | 共享了哪些文件夹 `{folders:[{id,name,path}]}` |
| POST | `/api/peer/manifest` | `{folderId}` → `{root, folder, count, files:{path:{size,mtimeMs,sig}}}` |
| POST | `/api/peer/hashes` | `{folderId, paths[]}` → `{hashes:{path:sha256\|null}}`（按需算，避免每次全量读盘） |
| GET | `/api/peer/file?folderId&path` | 下载：返回 `Content-Length` + `X-File-Mtime` |
| PUT | `/api/peer/file?folderId&path` | 上传：请求头 `X-File-Sha256`、`X-File-Mtime`，服务端写 `.part` → 校验 → 原子改名 |
| POST | `/api/peer/delete` | `{folderId, paths[]}` → `{deleted, missing, failed}` |
| POST | `/api/peer/copy` | `{folderId, from, to}` → 冲突「两个都留」时另存副本 |
| GET | `/api/peer/zip` | 本机某文件夹打包（流式，`all=1` 或 `paths=a,b`） |
| PUT | `/api/peer/archive` | 上传 zip 并由服务端流式解包（手机端推整个文件夹的兜底手段，带路径穿越防护） |

`sig` = `size:roundedMtimeMs`，用来在不读内容的情况下快速判断"有没有变过"。

## 本机管理接口

只允许管理员令牌（界面只监听本机）：

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/api/info` | 本机信息、共享文件夹、对端、自动同步状态 |
| POST | `/api/folders` `/api/folders/remove` `/api/folders/rename` | 管理共享文件夹 |
| GET/POST | `/api/auto-sync` | 自动同步开关与间隔 |
| POST | `/api/jobs/scan` | 只对比，不改文件 → `{jobId}` |
| POST | `/api/jobs/apply` | 执行某个对比结果 → `{jobId}` |
| POST | `/api/jobs/sync` | 对比 + 执行（一键同步），有未决冲突时只返回计划 |
| POST | `/api/jobs/cancel` | 取消当前任务 |
| GET | `/api/jobs?id=` | 任务状态与结果 |
| GET | `/api/events` | SSE：任务进度、计划更新、对端上下线 |
| GET | `/api/peer-listing` | 浏览对端文件清单（只读，供「自由下载」用） |
| GET | `/api/peer/download` | 把对端单个文件转给浏览器（不写同步目录） |
| GET | `/api/peer/download-zip` | 把对端整个文件夹边拉边打包成 zip |

## 同步状态机

一个「同步项」= `(本机文件夹, 对端, 对方文件夹)`，基线按这三者隔离，存在 `data/baselines/` 下。

基线条目：

```json
{ "hash": "<上次同步后的内容哈希>", "remoteHash": "<对端那份的哈希>",
  "localSig": "<本机 size:mtime>", "remoteSig": "<对端 size:mtime>" }
```

判定结果（`kind`）：

| kind | 含义 | 默认动作 |
| --- | --- | --- |
| `new-local` / `new-remote` | 只有一边有 | 上传 / 下载 |
| `modified-local` / `modified-remote` | 一边变了、另一边没动 | 上传 / 下载 |
| `deleted-local` / `deleted-remote` | 一边删了、另一边没动 | 删除另一边（需开启删除） |
| `conflict-add` / `conflict-modify` | 两边都动过且内容不同 | **必须由人选择** |
| `conflict-delete-modify` | 一边删、另一边改了 | **必须由人选择**（默认保留文件） |
| `both-deleted` | 两边都删了 | 只清基线 |
| `same` | 内容一致 | 跳过 |

动作：`upload`、`download`、`delete-local`、`delete-remote`、`keep-both`（另存副本）、`newest`（仅自动同步使用）。

判定原则：

- 先用 `sig`（size + mtime，容差 1 秒）快速筛，只有"可疑"的文件才算 SHA-256
- 只有一边变过 → 直接同步，不算冲突
- 两边都变过但**内容相同** → 视为一致，不算冲突
- 删了又改/删了又建，一律当冲突，不自动决定
- 自动同步模式下，冲突按修改时间裁决：较新的留下，另一份存成 `xxx (旧版本 时间).ext` 副本；差 < 1 秒视为并列，不判

## 一次同步的时序

```
界面 → POST /api/jobs/scan  {peerId, localFolderId, remoteFolderId}
服务端 → POST /api/peer/manifest      取对端清单
服务端 → POST /api/peer/hashes        只对可疑文件取哈希
服务端 → GET  /api/events             推送 plan（SSE）
界面 → POST /api/jobs/apply {scanJobId}
服务端 → PUT  /api/peer/file …        上传（带哈希，服务端校验后改名）
服务端 → GET  /api/peer/file …        下载（写 .part → 校验 → 改名）
服务端 → POST /api/peer/delete …      删除（需人工开启）
服务端 → 写回基线，推送结果
```

手机 App 作为发起方时，方向反过来：它调用电脑的 `/api/peer/*`，自己的 `PeerServer` 则实现同一组接口供电脑调用。
