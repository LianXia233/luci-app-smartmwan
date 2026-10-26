# 更新日志

遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 风格，
版本号遵循语义化版本。**未发布**段落反映当前工作树，而非某个已归档标签。

## [未发布] — 0.4.0-dev

### 新增

* **仓库与构建基线**：`Cargo.toml`（1 库 + 1 守护进程二进制）、`Cargo.lock`、
  `LICENSE`（GPL-2.0-or-later 全文）、`.gitignore`。依赖刻意最小化：
  tokio / libc / serde / serde_json / thiserror，并在清单里逐条写明「不引入
  ubus / rtnetlink / conntrack / libuci FFI」的原因。
* **配置层 `src/config`**：原生 UCI 文本解析与序列化（不依赖 libuci）、
  schema v4 模型、就地迁移（旧键名 `primary_interface`→`primary`、
  `failback` 布尔→枚举）、默认值继承（线路健康参数覆盖全局）、
  结构化校验报告（errors / warnings / schema_version）。
  未识别的用户键在回写时原样保留，不静默丢弃。
* **系统交互层 `src/system`**：手写 rtnetlink 编解码（GETRULE / GETROUTE / GETADDR，
  IPv4 与 IPv6 双族）、策略路由差量下发 + 冲突审计 + 回读校验、
  netifd/`/etc/config/network` 与 firewall zone 拓扑解析、接口计数器采样、
  conntrack 按标记统计、nftables 程序生成与能力探测脚本、
  唯一外部命令通道（程序白名单 + 参数数组 + 超时 + kill_on_drop + 输出封顶）。
* **健康层 `src/health`**：ICMP / TCP / UDP / DNS 四种探测，**全部绑定出口设备
  与源地址**（`SO_BINDTODEVICE` + 显式 bind），避免「所有探测都走默认路由」这个
  多 WAN 经典错误；滑动窗口指标（RTT / 抖动 / 丢包 / 不稳定度 / P95）；
  `UNKNOWN→HEALTHY→DEGRADED→FAILED→RECOVERING→HEALTHY` 状态机含预热与
  时间驱动迁移；`Unsupported` / `LocalError` **不计入线路失败**。
* **调度层 `src/scheduler`**：静态哈希桶分配（SrcIP … FullFiveTuple /
  WeightedHash）、动态算法（LeastNewConnections / LeastTraffic）带单轮搬动预算与
  优势闸门、主备切换与四条件回切（预热 / 稳定时间 / 连续成功 / 最小间隔 + 二次确认）、
  游戏低延迟评分与滞回择优、强制切换与「目标暂不可用时保留指令」语义。
* **规则层 `src/rules`**（任务书执行顺序第 6 步「游戏路由」）：把「用户写的条件」编译成
  数据面能接受的 `firewall::GameSpec`，本身不生成任何 nft 文本 —— 匹配范围与语法兼容性
  放进同一个函数时，两类错误的表现会互相掩盖。四个模块：
  `matchers.rs`（CIDR 归一即网络位清零、裸地址补 /32|/128、按族分拣去重；端口拒绝 `0` 起点、
  `0-1024`、逆序与取反；MAC 接受冒号/短横/点分三种写法并统一小写；域名拒通配符与 URL；
  **遇到坏值一律报错而不是跳过**，跳过会让「拦 10 段」静默变成「拦 9 段」）、
  `presets.rs`（预置项从 `/usr/share/smartmwan/presets/*.json` 加载，**代码里不内置任何
  游戏服务器 IP/端口**，`source` 来源字段缺失即整条拒绝；单文件 512KiB 上限、跨文件重名检测、
  一个坏文件让整批失败而不是静默忽略）、
  `dns_sets.rs`（域名→动态集合的注册表：按域对账增量、过期、两寿命窗口的陈旧刷新，
  解析走 `spawn_blocking` + 超时并分类 `NotFound`/`Timeout`/`LocalError`，
  **解析失败不清空旧元素也不计为线路失败**）、
  `mod.rs`（`compile()` 负责预置项与规则的合并语义、slug 去重、族分拣、启停与模式感知，
  择优结论未出时进 `pending` 而不是猜一条线路）。
  新增配置项 `global.dns_ttl_floor_s`（默认 300 秒，校验 30..=86400）——`getaddrinfo`
  不返回 TTL，集合元素寿命只能取一个下界，这是明知不完备的折中而非最优值，已在 schema 注释里写明。
  端到端单测 `compiled_specs_are_accepted_by_firewall_build` 把「配置→GameSpec→nft 文本」串起来，
  契约漂移在提交前就会被抓到。本层 **51 条单测**（`dns_sets` 15 / `matchers` 12 / `presets` 10 /
  `mod` 14），lib 单测从 276 增至 328；数据面同类缺陷再修一处后为 **329**。
* **事务层 `src/transaction.rs`**（任务书执行顺序第 4 步的 4b「事务编排」，M6）：把此前各自单测的
  模块接成一条真正的提交链路 —— `校验 → 计划（观测内核 + rules::compile + firewall::build）→
  nft 试算 → 路由下发 → 路由复核 → nft 提交 → nft 复核 → 写 last-good 快照`，八阶段顺序固定。
  顺序背后是两条硬道理：nft 试算必须在任何内核写入之前（语法不过就不该碰内核）；
  路由必须**先于** nft 提交（反过来会出现「包已打上 `0x05…` 标记、策略路由还没装」的黑洞窗口，
  表现为突然全量走 main 表且没有任何报错）。失败时 `unwind()` 按逆序回滚（先 nft 后路由），
  每一条撤销失败都写进 `Receipt.rollback` 并记错误日志 —— **该字段非空就意味着内核状态需人工确认**。
  三个刻意的不对称：
  ① 复核不通过**绝不**写快照（快照只能描述设备上确实生效的状态）；
  ② 快照写入失败**不**回滚已验证的数据面，但 `ok=false` 且错误文案写「数据面已生效但快照写入失败」
  （为了一个文件没写成就拆掉通的上网路径，是把小故障升级成大故障）；
  ③ 找不到 `nft` 可执行文件时**拒绝** enabled 提交（半套状态比不更危险，也绝不只装半套路由），
  但**允许**停用提交（清场不需要 nft，两个 nft 阶段记为「跳过」并写明依据）。
  `Coordinator::submit()` 刻意**不返回 `Result`**：任何结局都是一份 `Receipt`
  （阶段记录 / issues / pending / rollback / 变更摘要 / nft 通道种类），
  因为「失败但已回滚」与「失败且未提交」对运维是两个完全不同的动作，RPC 层不得把它压成 bool。
  `reclaim()` 负责回收上次崩溃的残留：按 `NS` 前缀、`RULE_MASK`、`OUR_RTPROT`、表号区间判定所有权，
  **只删自己的对象**，别人的规则与路由保留并原文列进 `foreign`。
  幂等以证据判定（`Diff` 为空 **且** `applied.nft` 逐字节相同 ⇒ `changed=false`），但仍执行试算与两侧复核。
  规则层在这一步**第一次有调用者**：`game_rule_from_config_reaches_the_nft_program` 从 UCI `config game`
  段一路断言到集合名、`ip daddr @set` 与 `smw:game:<slug>` 标签。
  新增 **21 条单测**，lib 单测 329 → **350**。
  **限定**：nft 通道在单测里是 `FirewallExec::Sim` 替身，它**不验证 nft 语法**，只验证编排顺序；
  真机必须换 `FirewallExec::Real`（`nft -c -f` / `nft -f` / `nft -a list`）后重跑同一批结论（M10）。
* **工程闸门**：`cargo clippy --offline --all-targets -- -D warnings` 归零
  （20 条 lib 告警逐条修，只保留 1 处带中文说明的 `#[allow]`，在测试夹具里）；
  `cargo fmt --all` 建立基线，此后 `clippy` / `fmt --check` 与单测同为提交前置条件。
* **文档集**：`README.md`、`docs/REQUIREMENTS.md`（任务书 15 节 → 可核查验收矩阵）、
  `docs/ROADMAP.md`（M0–M10 与各自 DoD）、`docs/PROGRESS.md`（模块完成度与实测数字）、
  `docs/HANDOVER.md`（「改了会出事」的不变式清单），以及禁 Lua 自动化检查
  `scripts/no-lua-check.sh`（已实测「干净→退出 0 / 注入→退出 1」两个方向）。
* **技术文档**：`docs/ARCHITECTURE.md`（分层与决策循环、fwmark 布局、nft 对象命名、
  RPC 方法表）、`docs/CONFIGURATION.md`（UCI 键名/默认值全表与校验规则）、
  `docs/SECURITY.md`（任务书安全清单逐条对应到代码位置）、
  `docs/TESTING.md`（测试矩阵与 10 条交付标准的诚实回答）、
  `research/luci.md` 与 `research/buildsystem.md`（去 Lua 前端与 apk/rust 打包研究笔记，
  含「必须在真实 SDK 里复验」的来源声明）。

### 变更

* 骨架目录 `root/usr/share/smartmwan/games/` 改名为 `presets/`，与代码常量
  `rules::presets::PRESET_DIR = "/usr/share/smartmwan/presets"` 对齐。两处不一致的后果是
  「装了包但预置目录不存在」或「用户往 games 里放文件读不到」；今后路径以代码常量为唯一权威。
* 文档的行数口径统一为「原始文件行数（含空行与注释）」，统计命令写进 `docs/PROGRESS.md` §2；
  旧表里偏低的数字（合计 17,494）不是代码变少了，是口径不同。
* `interval_elapsed()` 现在把 `last_change_ms == 0`（从未变更过）判为「间隔已满足」，
  否则进程启动后的第一次决策会被一个不存在的历史切换永久卡住。
* `failover::Machine` 的最小切换计时改为「任何真实变更都刷新（含变为不分流）」，
  未变更（尤其全灭期间的 `None→None`）不刷新。
* `latency::Scored` 的丢包归一化基准为 0 时按「该项不参与扣分」处理，
  不再用 `max(1)` 把「关掉某项权重」变成「该项直接扣满」。

* 提交历史身份统一：13 个提交的 author/committer 全部改为 `LianXia233`（2026-10-26，
  按仓库所有者的明确指示，`git filter-branch` + `--force-with-lease` 强推）。
  **树内容与提交信息逐字节未变**，但所有短哈希都变了，因此全仓文档里的哈希引用
  （`docs/PROGRESS.md` §5 提交表、`docs/HANDOVER.md`、`docs/ROADMAP.md`、本文件的修复条目等）
  已逐条更正为重写后的值。此后不再改写历史；有旧克隆者需 `git fetch && git reset --hard origin/main`。

### 修复

* `Debounce::offer()` 触发后到下一次未命中之间保持沉默（一次性触发语义），
  避免回切/择优动作被反复执行。
* 探测批次取消路径：`JoinSet::abort_all()` 取代 `shutdown()`（后者返回 future，
  未 await 时什么都不做，取消会退化成「等全部探测跑完」）。
* **规则层三处「静默放宽匹配面」的数据面缺陷**（同一类：不报错、甚至带一条看起来合理的警告，
  只是多命中流量）：
  1. MAC 条件整条丢失（`051829f`）。生成器把匹配项拼进规则时带了一个
     `.filter(|m| !m.starts_with('@'))`，而裸集合引用恰好以 `@` 开头，于是**每一条** MAC
     匹配项都被丢掉：一条「只针对这台主机」的游戏规则退化成命中该范围内全部新建连接。
     现在集合引用一律带字段名（`ether saddr @smw_g_<slug>_mac`）且拼接处不再做任何过滤，
     并补了 `ether saddr @…` / `ip saddr @…_cli4` / `ip daddr @…_dst4` 三条存在性断言
     —— 旧测试只检查集合是否**声明**过，所以一直是绿的。
  2. 域名条件被固定网段挤掉，不支持时还退化成兜底规则（`e1f31f2`）。同一规则的 v4 目的条件
     原先只取「第一类非空」，同时写了 `target` 和 `domain` 时域名条件不生效；而域名条件因
     设备 nft 不支持 `dynamic,timeout` 集合被跳过时，规则会落到「无目的条件」分支，
     变成命中该主机全部新建连接的兜底规则 —— 比「不生效」严重得多。现在同一族的
     每个目的条件各出一条规则，只有「本来就没有任何目的条件」时才下无目的规则，
     并去掉了循环外多推的一条重复所有权标签。
  3. 客户端条件全部失效时规则被放宽到全 LAN（`c2e8067`）。规则用 `client_mac` 限定主机，
     而设备 nft 不支持 `ether_addr` 集合时，代码只丢掉该匹配项并写一条警告 ——
     少一个条件不是「不生效」而是「匹配面变大」，降级后命中**全 LAN** 的新连接；
     且警告文案写的是「已降级为不匹配」，与真实行为相反。现在客户端条件全部无法生效时
     **整条规则不下发**（与域名条件同一原则），并把文案改成如实描述。
     共同教训：能力降级路径必须能证明「匹配面没有变宽」—— 断言最终文本里条件还在，或规则整条不存在。
* 安装期 nftables 静态占位（`firewall::include_file_text()`）不再声明第二条挂
  `prerouting` 的 `output` 链：链名与 hook 类型不一致是语义错误（重复注册同一 hook），
  而 `type route hook output` 属于未经设备实测的语法，写进静态占位会让 fw4 在不支持的
  内核上直接启动失败。`output` 链改为运行期按能力探测结果添加，并加了对应断言。
* **带 `comment` 的保护/绕行规则没登记进 `Program::tags`**（`9abc322`，M6 暴露）。
  `firewall::build()` 为保护源地址与绕行目的地址生成了 4 条带标签的规则，却只把游戏与桶规则
  登记进 `tags`。M5 之前没人拿 `tags` 与内核实际规则做集合比对，所以漏登记一直没被发现；
  事务层的复核阶段一比就露馅，报「多余标签」——**把一次本来正确的提交判成失败并回滚**。
  现在生成文本与登记 tag 在同一处完成。教训：`tags` 不是元数据，是复核的判据，二者必须同源。
* **`config::diff()` 漏了 `global.hash_seed`**（`9abc322`）。改种子会重排全部新建连接的落线，
  属于用户必须「在应用前看得见」的变更，但变更清单里不出现，`smartmwan.diff` 的摘要就少报一项。
  同类问题只能靠「diff 覆盖 schema 全部字段」的核对来防，新增字段时除 `schema.rs` /
  `decode` / `encode` / `validate` 外还要过 `diff()` 这一关。

### 已知缺失（尚未实现，别当作已完成）

* `src/rpc`（Unix socket JSON RPC + ACL + 审计）——占位。
* `src/main`（守护进程入口与 tokio 监督循环）——占位。**因此事务层虽然完成，却还没有运行期调用者**：
  没有任何进程会去读 UCI、按周期决策并调用 `Coordinator::submit()`。
* 事务层的 nft 通道只在 `FirewallExec::Sim` 替名下验证过编排顺序；
  **nft 语法与真实下发未验证**（沙箱无 `nft`、无 netfilter 内核支持），归 M10。
* 桶轮排的热替换（`Nft::replace_rule`）已实现并有单测，但**尚未被周期循环接上**（M7）。
* 预置项**数据文件**未提供（`root/usr/share/smartmwan/presets/*.json`）：加载器与校验已就位，
  但因「不得编造服务器 IP/端口」，在拿到可引用来源之前不入库任何具体地址。
* 域名集合的**周期刷新环**未接：`rules::dns_sets` 的对账与解析逻辑完成，
  但没人按 `dns_ttl_floor_s` 定时驱动它（M7 的监督循环）。
* LuCI 前端 7 个页面、CSS、rpcd ucode 桥、ACL JSON、menu.d JSON——未创建。
* OpenWrt 包 Makefile、procd 脚本、UCI 默认配置、`/etc/nftables.d` 片段、
  apk 维护脚本——未创建。
* 真机验证：**未做**。沙箱是 root 容器，但没有 `nft` 二进制、没有 netfilter 支持、
  没有路由器；`ip rule` / `ip route` 只读可用，因此 netlink 解码有单测背书，
  下发路径、fw4 语法、LuCI 页面与 apk 安装全部未经真实设备验证。
  本轮新增两项只能在设备上确认：`flags dynamic,timeout` 集合的实际老化行为，
  以及 `ether saddr @set` 在 bridge 口与 VLAN 子接口上的匹配范围。
  M6 之后还多一项：**事务层的八阶段编排在真实 `nft` 通道上是否仍然成立**
  （单测走的是 `FirewallExec::Sim` 替身，只证明顺序与回滚逻辑，不证明语法）。
* 沙箱可交付的静态结论已齐：`clippy -D warnings` 0 告警、`fmt --check` 无差异、
  `build` 0 告警、350 单测通过、禁 Lua 检查通过 —— 这五项每次提交前重跑。

## [0.3.0] — 2026-10-26（内部里程碑）

* 健康层探测与服务闭合（218 单测）。

## [0.2.0] — 2026-10-26（内部里程碑）

* 系统层策略路由与 netlink 编解码。

## [0.1.0] — 2026-10-26（内部里程碑）

* 配置层与 fwmark 布局定稿。
