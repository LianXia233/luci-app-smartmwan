# 架构

设计目标只有一句话：**把「决策」与「下发」彻底分开，让每一层都能单独测试，同时保证
任何一次对内核的写入都是可解释、可回滚、幂等的。**

## 1. 分层

```text
                    ┌────────────────────────────────────────────┐
   LuCI JS 视图 ────│ rpcd ucode 桥 (smartmwan.uc)                │  零 Lua
                    └───────────────┬────────────────────────────┘
                                    │ Unix socket + JSON（统一信封）
                    ┌───────────────▼────────────────────────────┐
                    │ rpc        方法路由 / ACL / 互斥 / 审计      │  M7 未实现
                    └───────────────┬────────────────────────────┘
                                    │ 只调用公开方法，不复制状态
                    ┌───────────────▼────────────────────────────┐
                    │ scheduler  装配层：唯一持有状态机与择优器    │  完成
                    │  ├─ failover  主备/多级备份/回切/强制        │
                    │  ├─ balancing 桶→槽位分配（静态+动态）      │
                    │  ├─ latency   游戏评分与滞回择优            │
                    │  └─ hysteresis 防抖/最小间隔                │
                    └───────┬───────────────────────┬────────────┘
              读状态 ▲      │ 决策 Outcome          │ 规则
        ┌────────────┴──┐   ▼                       ▼
        │ health        │ ┌──────────────────────────────────────┐
        │ 探测+指标+状态机│ │ transaction 校验→下发→回读→回滚       │  M6 未实现
        └────────────▲──┘ └───────┬──────────────────┬───────────┘
                     │            │                  │
        ┌────────────┴────────────▼──┐   ┌───────────▼────────────┐
        │ config  UCI 解析/校验/迁移  │   │ system                │
        │       /diff/last-good      │   │  route   策略路由差量   │
        └────────────────────────────┘   │  firewall nft 程序生成  │
                                         │  netlink / interface / │
                                         │  conntrack / exec      │
                                         └────────────────────────┘
```

`rules`（M5）位于 `config` 与 `transaction` 之间：把 `config::GameRule` 编译成
`firewall::GameSpec`，不碰内核，也不做决策。

## 2. 每层的职责边界（越界就是设计错误）

| 层 | 允许做 | 禁止做 |
|---|---|---|
| `config` | 读写 `/etc/config/smartmwan`、迁移、校验、diff、last-good | 读内核状态、执行命令 |
| `system` | 观察内核（netlink/`/sys`/`/proc`）、下发内核对象、执行白名单命令 | 做任何「哪条线路更好」的判断 |
| `health` | 探测、算指标、跑状态机 | 决定谁承载流量、写内核 |
| `scheduler` | 决策（唯一状态所有者） | 直接写内核 |
| `rules` | 把规则编译成匹配器与 nft 对象描述 | 决策出口、绕过 `GamePolicy` |
| `transaction` | 编排提交与回滚 | 修改决策内容 |
| `rpc` | 鉴权、序列化、调用上面各层 | 自己保存业务状态 |

## 3. 数据流：一次周期决策

```text
1. health::run_round()          并发探测全部线路（额度受 max_concurrent_probes 限制）
2. Registry::record()           结果进滑窗 → 状态机迁移（Unsupported/LocalError 不计数）
3. interface::resolve_all()     重解析设备/地址/网关（5G 重拨后网关会变，必须每轮重算）
4. conntrack::snapshot() +
   interface::sample_traffic()  动态算法的输入
5. scheduler::decide()          → Outcome{buckets, changed, active, standby, notes, …}
6. Outcome.changed == false     → **到此为止，不写任何内核对象**
7. transaction::commit()        → rules 编译 → firewall::build() → nft -c → nft -f → 回读 → last-good
8. route::reconcile()           → ip rule / 路由表差量（只在槽位集合变化时）
```

## 4. 数据平面合同

标记布局、`RULE_MASK`、表号区间、所有权区间见 `docs/HANDOVER.md` §2.1 与
`src/lib.rs` 的模块注释。这里补充「为什么这样分」：

* **bucket 在标记里但不在 `ip rule` 掩码里**：桶重排只改 `meta mark set jhash … map{…}` 的映射值，
  选表只看 slot ⇒ 重排不会打断已建立连接（它们按 ct mark 继承仍走原出口）。
* **gen（代际）**：纯粹为了可观测性 —— 排查「这条标记是哪一轮打的」时能区分同槽位的不同批次，
  不参与任何决策。
* **class**：区分 normal/game/manual/local-policy，用于计数器与 UI 归因，同样不参与选表。
* **`ip rule` 优先级带**：`RULE_PRIO_BASE(1000) .. +MAX_WANS(24)`，`is_our_priority()` 判定所有权，
  带外规则一律视为用户的，只审计不改动。

## 5. nftables 对象命名与安装路径

* 表：`table inet smw`（`NS` 前缀）；集合/链统一 `smw_*` / `smw:*` 标签。
* 安装期静态占位：`/etc/nftables.d/smartmwan.nft`，内容由 `firewall::include_file_text()` 生成
  （打包时必须用该函数产出，不许手写第二份）。它只声明表与一条空 prerouting 链。
* fw4 挂接：UCI `config include` + `option type 'nftables'` + `option position`。
* 运行期：守护进程按能力探测结果写完整程序；桶重排只 `replace rule … handle N`。

## 6. RPC 设计

传输：Unix 域套接字（`global.rpc_socket`），JSON 长度前缀帧，一请求一响应。
鉴权：`SO_PEERCRED` 取对端 uid/gid；rpcd 以 `wwwdata` 身份连入，写方法再按 ACL 表细化。
信封：

```json
{ "ok": true,  "data": { … }, "error": null, "timestamp": 1730000000, "protocol": 1 }
{ "ok": false, "data": null,  "error": { "code": "validate", "message": "…", "details": [ … ] },
  "timestamp": 1730000000, "protocol": 1 }
```

`code` 取 `Error::code()` 的 12 个稳定值之一（`config/validate/netlink/firewall/exec/rollback/
permission/unsupported/timeout/no_route/io/json`），前端据此区分「可重试」与「需用户修正」。

### 方法清单（≥19，M7 实现时逐条落地）

| # | 方法 | 读/写 | 说明 |
|---|---|---|---|
| 1 | `smartmwan.hello` | 读 | 协议版本握手，不符则前端拒绝渲染 |
| 2 | `smartmwan.getStatus` | 读 | 运行总览：模式、活动出口、桶摘要、`notes` |
| 3 | `smartmwan.getLines` | 读 | 线路列表 + 状态 + 指标 + 槽位/表号 |
| 4 | `smartmwan.getLine` | 读 | 单线详情（含探测历史与状态迁移轨迹） |
| 5 | `smartmwan.getBalance` | 读 | 算法、桶图、份额千分比、上次重排时间与搬动数 |
| 6 | `smartmwan.getFailover` | 读 | 主备顺序、当前活动、等待回切的线路及**逐条原因** |
| 7 | `smartmwan.getGames` | 读 | 规则列表 + 命中计数 + 冲突项 |
| 8 | `smartmwan.getGameQuality` | 读 | 每条规则在各候选线路上的评分分解 |
| 9 | `smartmwan.getConnections` | 读 | conntrack 按槽位/类别统计（有上限，超限如实标注截断） |
| 10 | `smartmwan.getTraffic` | 读 | 接口计数器与平滑后的吞吐 |
| 11 | `smartmwan.getLogs` | 读 | `logging::recent(level, limit)`，只读环形缓冲 |
| 12 | `smartmwan.getConfig` | 读 | 当前生效配置 + schema 版本 + 与 last-good 的差异 |
| 13 | `smartmwan.getCapabilities` | 读 | nft 版本与各项语法探测结果（含降级说明） |
| 14 | `smartmwan.validate` | 读 | 对提交的配置跑校验，不写文件、不碰内核 |
| 15 | `smartmwan.save` | 写 | 写 `/etc/config/smartmwan`，返回 diff，**不下发** |
| 16 | `smartmwan.diff` | 读 | 待下发变更摘要（应用前确认用） |
| 17 | `smartmwan.apply` | 写 | 一次事务：校验→dry-run→下发→回读→记 last-good；失败自动回滚 |
| 18 | `smartmwan.rollback` | 写 | 恢复 last-good 并重新下发 |
| 19 | `smartmwan.forceWan` | 写 | 强制指定出口（带二次确认标志） |
| 20 | `smartmwan.releaseForced` | 写 | 取消强制，回到自动决策 |
| 21 | `smartmwan.setMaintenance` | 写 | 线路维护模式开关 |
| 22 | `smartmwan.probeNow` | 读（有网络副作用） | 立即跑一轮探测，不改配置、不下发；返回 `RoundInfo` |
| 23 | `smartmwan.reload` | 写 | 重新读取 UCI 并触发 `on_config_change` |

并发：一个全局事务互斥锁（`apply`/`rollback`/`reload`/`forceWan` 串行）；
读方法不取写锁，但读 `Scheduler` 状态用短临界区快照，避免「读到半更新的状态」。
审计：所有写方法记录调用者 uid、方法名、参数摘要（脱敏）、transaction id、结果与耗时。

## 7. 为什么自己写 netlink 和 UCI 解析

* **零 Lua 的连带要求**：走 libuci FFI 会把 Lua/uci 工具链依赖引进来，也会让「不覆盖用户配置」
  这件事失去代码级保证（`uci set` 的副作用不可控）。直接读写文本 + 只操作自己的段类型，
  才能让「未识别键原样保留」成为可测试的行为。
* **减少攻击面与包依赖**：`rtnetlink`/`conntrack` 一类 crate 要么依赖 libmnl/netlink 库，
  要么行为不透明。手写 GETRULE/GETROUTE/GETADDR 的编解码只有一处，且能用固定字节序列单测。
* **原子性**：nft 侧必须用 `nft -c -f` → `nft -f` 的两步（校验后原子提交），任何库封装都可能把它
  拆成多条命令。

代价：内核 ABI 常量与结构要自己维护，因此 netlink 模块里有完整的常量表和逐字段解析测试。

## 8. 失败与降级路径（每一条都必须对用户可见）

| 情况 | 行为 |
|---|---|
| 首轮探测未完成 | 不承载流量 + note「尚未完成首轮探测（周期/超时）」 |
| 全部线路 FAILED | 桶全 0、`all_dead=true`，UI 显示「无可用出口」，不回退成「走默认路由」这种隐式行为 |
| 算法在设备上不支持 | `Error::Unsupported` → 降级为 `WeightedHash` 并写 note「算法降级：…」 |
| nft 语法探测失败 | 该语法不写进程序 → `Issue::Warning` 说明降级后果 |
| 事务任一步失败 | 按 `Undo` 逆序回滚 + 记 transaction id，返回 `Error::Rollback` |
| 命令超时 | `Error::Timeout{operation, elapsed_ms}`，子进程被 kill 且回收 |
| 标记属于别人 | 完全不介入该连接（不抢别人的出口决策） |

## 9. 尚未决定 / 需要实现时确认

* `rules` 层是否把域名解析委托给 dnsmasq 的 ipset 兼容接口，还是自己做解析 + `add element`
  （倾向后者：可控 TTL、可如实报告解析失败，且不引入额外包依赖）；
* `WeightedEcmp` 的能力探测粒度（内核 `fib_multipath_hash` 与 `ip` 版本要分别测）；
* 多实例（同一设备跑两个 `smartmwan` 配置集）明确**不支持**：标记区间与表号区间是全局唯一资源。
