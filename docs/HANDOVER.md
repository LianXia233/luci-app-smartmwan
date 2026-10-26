# 交接文档

面向**下一个接手的人**（或下一次重启会话的自己）。只写「不知道就会做错」的内容；
能从代码读出来的不重复。读法顺序：本文件 → `docs/ARCHITECTURE.md` → `docs/PROGRESS.md`。

## 1. 三十秒版

* 这是 OpenWrt/ImmortalWrt **25.12+** 的多 WAN 智能选路插件，**后端 Rust、前端 LuCI JS + ucode，全项目零 Lua**；
* 已完成：配置层、系统交互层、健康层、调度层（276 单测全绿）；
* 未完成：规则层、事务层、RPC 层、守护进程入口、前端、打包。**现在装到路由器上不能用**；
* 下一步唯一正确落点：`src/rules`（任务书执行顺序第 6 步「游戏路由」）。

## 2. 改了会出事的六条不变式

### 2.1 fwmark 布局是数据平面合同

`src/lib.rs::marks`：bit24..27 = 魔数 `0x5`，bit28..31 **必须为 0**（留给 fw4/netifd/别人），
bit16..23 bucket、bit12..15 gen、bit8..11 class、bit0..7 slot。

* `RULE_MASK == SLOT_MASK`：**任何改变 bucket/gen/class 的决策都不得改变选表**，否则已建立连接会换出口。
  这条有单测 `bucket_and_gen_changes_do_not_affect_table`，别删。
* `table = TABLE_BASE(100) + slot`，`slot` 1..=24 ⇒ 表号 101..124，恒 < 253（避开 main/local/universe）。
* 所有权判定写成**区间** `0x05000000-0x05ffffff`（`own_range_text()`），刻意不用 nft 位运算表达式，
  因为位运算在 `ct mark` 上的语法兼容性更弱。`marks::own_range_text()` 与 `OWN_MIN/OWN_MAX` 的一致性
  由单测锁死 —— 改常量必须同时改文本，否则设备上的所有权判断整体失效。
* 落在别人标记区间的连接，本插件**完全不介入**（宁可走 main 表），这是有意的保守设计，不是 bug。

### 2.2 槽位必须由配置顺序唯一决定

`config::decode()` 把 `wans` 按 `(priority, name)` 排序，`system::assign_slots()` 按该顺序发 1..=N。
⇒ 槽位/表号/规则在两次进程之间可复现，**重启不会产生重复或错位规则**。
不要改成按 UCI 文件顺序或 HashMap 迭代顺序 —— 那会让桶全部重排。
线路数 > `MAX_WANS` 时 `assign_slots` 返回 `Err`，`scheduler::slot_map()` 必须继续向上传播（曾经被吞掉过）。

### 2.3 外部命令只有一条通道

`src/system/exec.rs` 是唯一出口：绝对路径白名单（不做 `$PATH` 查找）、参数数组直接 `execve`（**永不 `sh -c`**）、
硬超时 + `kill_on_drop`、stdout/stderr 字节封顶且超限后继续排空管道（否则子进程卡在写上）、
`stdin=/dev/null`、环境清空只留最小 `PATH`、非零退出码一定是错误。
新增可执行程序**必须**同时进 `ALLOWED_PROGRAMS`；测试专用的 `TEST_PROGRAMS` 只在 `#[cfg(test)]` 存在，
所以 release 里不可能通过测试通道放宽白名单。
优先 netlink / `/sys` / `/proc`，只有 `nft` 这类没有稳定库接口或需要原子事务的才走 exec。

### 2.4 调度状态只有一个所有者

`scheduler::Scheduler` 独占 `failover::Machine` 与 `latency::Picker`；RPC 层只能调用它的公开方法
（`force`/`release_forced`/`on_config_change`/`decide`/`ranking`…），**不得另建一份 Machine**，
否则两套状态机各自切换会互相打架。计划中的 RPC 需要与之互斥（同一把锁）。

两条容易写错的语义（都已修过，别再退回）：

* `hysteresis::interval_elapsed(0, …) == true`：`last==0` 表示「从未变更」，不存在间隔约束；
* `failover` 的最小切换计时：**真实变更才刷新**（含「变为不分流」），`None→None` 不刷新。

### 2.5 「不做高频全量重建」在两处落地

* 应用层：`Outcome.changed` 来自**真实桶图比较**（`buckets != self.buckets`），决策没变就没有任何数据面写入；
* 内核层：低频配置变更才 `delete table inet smw` + 整表重建（单批原子）；
  高频桶重排只 `nft replace rule ... handle N` 替换 `smw:bucket:*` 那几条，规则数量恒定。

⇒ 新增任何「周期性下发」逻辑时，必须先证明自己产生了 diff。

### 2.6 诚实性（产品级要求，不是口号）

* 未探测成功的能力一律 `Error::Unsupported` + 降级 note，**不伪造**（`WeightedEcmp` 是样板案例）；
* 未完成首轮探测时 `decide()` 输出 note「尚未完成首轮探测…周期 Xms、超时 Yms」且**不承载流量**；
* 全线路不可用 ⇒ 桶全 0 + `all_dead=true`，UI 必须显示「无可用出口」，不能显示「正常」；
* 主备模式下备份线路不承载普通流量，除非 `game_policy=exception` 且规则显式命中；
* 游戏预置库**绝不内置编造的服务器 IP/端口**，只放用户可编辑的数据文件。

## 3. nftables / fw4 的事实依据（勿凭记忆改写）

* firewall4 是 ucode 实现，表名 `inet fw4`；本插件用**独立的** `inet smw` 表，绝不碰 fw4 的对象；
* `/etc/nftables.d/*.nft` 的挂接机制：UCI `config include` + `type 'nftables'` + `position`（已核对，不是猜的）；
* hook 优先级 `-150`（`HOOK_PRIO`）：在 conntrack(-200) 之后、路由决策之前，因此 `ct state`/`ct mark` 可用且标记能影响选表；
* 安装期静态占位 `/etc/nftables.d/smartmwan.nft` 由 `firewall::include_file_text()` 生成，
  **只声明表 + 一条空 prerouting 链**。`type route hook output` 未经设备实测，不得进占位文件
  （本次刚修过这个错：曾经多写一条名为 output 却挂 prerouting 的链）；
* 待真机实测的语法集中在 `firewall::probe_scripts()`：`jhash ... map`、`th sport/dport`、
  `type route hook output`、`flags dynamic,timeout` 集合、`ether_addr` 集合、规则 `comment`。
  探测不通过 → 该语法**不写进程序**，转为 `Issue::Warning`。

## 4. 配置层要记住的键名

UCI 文件 `/etc/config/smartmwan`，段类型 `smartmwan`(global) / `wan` / `game` / `score`。
完整表在 `docs/CONFIGURATION.md`。几个反直觉的（**UCI 键名 ≠ Rust 字段名**）：

| UCI 键 | 结构体字段 |
|---|---|
| `probe_interval` / `probe_timeout` | `health.interval_ms` / `health.timeout_ms` |
| `recover_warmup_ms` | `health.warmup_ms` |
| `probe_target`（list） | `probe_targets` |
| `lan_zone`（list） | `lan_zones` |
| `target` / `port` / `client_ip` / `client_mac` / `domain`（list） | `targets` / `ports` / `client_ips` / `client_macs` / `domains` |
| `rtt_weight` / `jitter_weight` / `loss_weight` / `instability_penalty` | `score.rtt` / `.jitter` / `.loss` / `.instability` |

* 线路段/游戏段**必须具名**（段名是主键，用于规则定位与冲突提示）；
* 线路的 health 字段留空即继承 global（`decode_health(sec, base)` 的 base 语义）；
* `enabled` 默认 `0`：**首次安装绝不能改变现有路由**（单测 `defaults_are_safe_disabled`）；
* 未识别的用户手写键在 `encode_into()` 回写时原样保留，不静默丢弃。

## 5. 本环境的限制（结论必须带这些前提）

| 限制 | 后果 |
|---|---|
| 无 `nft` 二进制、无 netfilter 内核支持 | 所有 nft/`ip rule` 行为只到「文本正确 + 单测」，不能声称设备可用 |
| `raw.githubusercontent.com` TLS 中断 | 上游源码引用改用本地已核对文件/镜像站 |
| 沙箱网络改动有风险 | 虽然是 uid 0 且 netlink 读路径可用（`ip -o rule list` 正常），但**不在沙箱里增删路由/规则**：容器网络一坏就把环境搞没，且与目标设备无关 |
| `cargo --offline` | 构建/测试一律加 `--offline` |

**已解除的限制（2026-10-26）**：clippy 与 rustfmt 之前不可用（1.98.1 的组件包在镜像 404），
把 stable 升到 1.99.1 后即可。⇒ 现在必须保持
`cargo clippy --offline --all-targets -- -D warnings` 与 `cargo fmt --all -- --check` 双零，
新增代码不过这两关就不要提交。

## 6. Git 与协作约定

* 远端：`https://github.com/LianXia233/luci-app-smartmwan`，分支 `main`；
* **远端 URL 里不留 token**（token 只在该次命令里内联使用）；仓库远端目前是空的，首个 push 需要
  `git push -u origin main`；
* 提交身份用**每条命令的** `-c user.name=... -c user.email=...`，**绝不执行 `git config`**；
* 提交规范：`build:` / `feat:` / `fix(scope):` / `test(scope):` / `docs:` / `chore:`，中文正文，
  一次提交只做一件事（原子提交）；
* **每完成一个阶段同步更新**：`CHANGELOG.md`、`docs/REQUIREMENTS.md`（状态列）、`docs/ROADMAP.md`（勾选）、
  `docs/PROGRESS.md`（数字与落点）、`docs/HANDOVER.md`（新增不变式）；
* 文档里的数字（测试数、行数）必须来自实际命令输出，不能沿用上一版的数字。

## 7. 接手后的正确动作序列

1. 跑 `cargo test --offline --lib`（期望 276）+ `./scripts/no-lua-check.sh`（期望 0）确认基线；
2. 实现 `src/rules/matchers.rs`（纯函数：`(Config, GameRule) → 匹配器 + 冲突 Issue`）→ 单测；
3. `src/rules/games.rs`（预置数据加载器，**无来源数据不入库**）→ `src/rules/dns_sets.rs`（域名→动态集合 + 过期）；
4. 让规则层产出 `firewall::GameSpec`（契约**已存在**于 `src/system/firewall.rs:143`，`Input.games` 已被 `build()`
   消费且有单测用手写 spec 覆盖）：规则层的职责是把 `Vec<GameRule>` 编译成按 `(priority, name)` 排序、
   slug 化、族分拣、带 `dns_set`/`mark` 的 `GameSpec`，而不是改数据面接口；补「配置→GameSpec→nft 文本」的黄金样本测试；
5. 然后才做 `src/transaction.rs`（M6）。**不要在规则层之前先写 RPC/main** —— 那会让 RPC 暴露没有数据面支撑的方法。

## 8. 绝对不要做的事

* 不要为了「页面能跑起来」而写假数据或 mock 状态；
* 不要在 `root/` 下手写与 `firewall::include_file_text()` 不同的 nft 片段（必须同源生成）；
* 不要 flush 任何非 `inet smw` 的表，不要删非 `smw`/`smw_` 前缀的对象；
* 不要覆盖 `/etc/config/network` 或 `/etc/config/firewall`（本项目对它们只读）；
* 不要引入 `luci-lua-runtime` 或任何 `*.lua`（`no-lua-check.sh` 会拦，但也别靠脚本兜底）；
* 不要把 `git reset --hard` / `push --force` 用在已有历史上；文档与代码问题用新提交修正。
