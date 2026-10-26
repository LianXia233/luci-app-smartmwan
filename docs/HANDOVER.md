# 交接文档

面向**下一个接手的人**（或下一次重启会话的自己）。只写「不知道就会做错」的内容；
能从代码读出来的不重复。读法顺序：本文件 → `docs/ARCHITECTURE.md` → `docs/PROGRESS.md`。

## 1. 三十秒版

* 这是 OpenWrt/ImmortalWrt **25.12+** 的多 WAN 智能选路插件，**后端 Rust、前端 LuCI JS + ucode，全项目零 Lua**；
* 已完成：配置层、系统交互层、健康层、调度层、规则层（329 单测全绿）；
* 未完成：事务层、RPC 层、守护进程入口、前端、打包。**现在装到路由器上不能用**；
* 规则层要说清一句：它能产出 `GameSpec`，也有端到端单测喂进 `firewall::build()`，
  但**运行期没有任何调用者** —— 接线是 M6/M7 的活，别把「代码完成」当成「设备上生效」；
* 下一步唯一正确落点：`src/transaction.rs`（M6），在事务层里把规则层接上。

## 2. 改了会出事的八条不变式

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
* 游戏预置库**绝不内置编造的服务器 IP/端口**，只放用户可编辑的数据文件（`presets::tests::no_preset_is_bundled_in_code`
  与 `missing_source_is_error` 两条单测把「代码零内置」和「缺来源即拒绝」钉住）。

### 2.7 规则层的六条不变式（M5 新增，最容易在重构时被写坏）

* **规则层不生成 nft 文本**。`config`（用户写了什么）→ `rules`（这些条件在数据面上意味着什么）→
  `system::firewall`（怎么写成 nft 脚本）。把「匹配范围」和「语法兼容性」塞进同一个函数，
  两类错误的表现会互相掩盖。产物只有 `Vec<firewall::GameSpec>`（契约在 `src/system/firewall.rs:146`）。
* **条件必须出现在最终文本里**，测试要按存在性断言（`ether saddr @…`、`ip saddr @…_cli4`、
  `ip daddr @…_dst4`），不能只断言集合被**声明**过 —— 这正是 `051829f`/`e1f31f2` 两个缺陷
  当时躲过全部测试的原因。集合引用一律带字段名，拼接处**不做任何过滤**。
* **能力不足 ⇒ 不下发该条件**，绝不退化成「无目的条件的兜底规则」。后者会命中该主机全部新建连接，
  比条件不生效严重一个量级。同理：元素数量超上限（客户端 512 / 全局集合 2048 / 每规则 32 域名 /
  每域名 32 地址）一律 **Error 不截断**；坏值**报错不跳过**（跳过等于「拦 10 段」变「拦 9 段」）。
* **降级路径的通用判据：匹配面不得变宽**。三类同类缺陷都修在 `firewall::build()`：
  MAC 匹配项被 `@` 前缀过滤丢弃（`051829f`）、域名条件不支持时落到无目的兜底（`e1f31f2`）、
  `caps.ether_sets == false` 时只丢客户端条件继续下发规则 —— 最后一条最阴，因为规则**还有**
  目的条件看起来仍然精确，实际从「一台主机」变成「全 LAN」，而且旧警告文案写着「降级为不匹配」
  （`c2e8067`）。现在规则想限定主机（写了 `client_mac` 或客户端 IP）却一个可用匹配项都不剩时，
  **整条 `continue` 不下发**。新增任何条件降级分支时，照这条判据自查，并按
  「条件还在文本里 / 规则整条不存在」写断言。
* **不猜线路**。`selection=best` 而本轮没有择优结论时进 `Compiled::pending`，UI 显示「等待质量判定」；
  主备模式 + `game_policy=follow` 时游戏规则整体不下发。
* slug 由**规则段名**决定（`matchers::slug_of(&rule.name)`），不是预置项 id；改 id 改不了集合名。
  slug 里**不能用 `clamp_str`**（它会追加 `…[截断 N→M 字节]` 这种人看的标记，而 slug 要进 nft 对象名）。

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
* 未识别的用户手写键在 `encode_into()` 回写时原样保留，不静默丢弃；
* `dns_ttl_floor_s`（M5 新增，默认 300，校验 `30..=86400`）：UCI 键名与字段名**一致**，
  它是 `getaddrinfo` 拿不到 TTL 时的**下界折中**，不是「真实 TTL」。改这个值等于同时改
  解析频率与集合里旧 IP 的残留时间，两边都要在 UI 里如实说明；
  新增键必须同时改三处：`schema.rs`（默认值）、`config/mod.rs`（decode/encode/diff）、`validate.rs`（区间）。

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

* 远端：`https://github.com/LianXia233/luci-app-smartmwan`，分支 `main`；远端**已有历史**，
  普通 `git push` 即可（`branch.main.remote/merge` 已配好），不要再假设这是个空仓库；
* **远端 URL 里不留 token**，token 只在该次命令里内联使用，绝不写进 `.git/config`、
   remote URL、文档或提交信息；任何一次把 token 明文贴进对话后都应视为已泄露，
  **建议仓库所有者轮换该 token**；
* 提交身份统一为 **`LianXia233 <49828512+LianXia233@users.noreply.github.com>`**（作者与提交者相同），
  用**每条命令的** `-c user.name=... -c user.email=...` 传入，**绝不执行 `git config`**。
  带 `49828512+` 前缀的写法保证 GitHub 一定能把提交归属到该账号（不带前缀的
  `LianXia233@users.noreply.github.com` 不保证）。
  *历史已被重写一次（2026-10-26，按仓库所有者的明确指示）*：`f90e088..2e8b3d1` 的 13 个提交
  原先混用两种身份（早期 `LianXia233` + 后续 `smartmwan-dev <dev@localhost>`），
  已用 `git filter-branch` 统一身份并 `--force-with-lease` 强推。
  **树内容与提交信息逐字节未变**（`git diff` 对比重写前分支为空），但 **hash 全变**：
  任何人手里有旧 clone，必须 `git fetch && git reset --hard origin/main` 或重新 clone，
  不要在旧历史上继续提交。**不要再做第二次历史重写。**
  本地留有重写前的分支 `backup/pre-author-rewrite`（只是防呆备份，远端没有它）；
  确认无误后可以 `git branch -D backup/pre-author-rewrite` 删掉，删之前它同时是
  「内容未被改动」的证据（`git diff backup/pre-author-rewrite main` 应为空）。
  *另一处遗留违规*：本轮为了让 push 省事执行过 `git config branch.main.remote/merge`，
  与本条约定冲突，合规等效做法是首次 `git push -u origin main`；
  若要清理 `git config --unset branch.main.remote` 即可，但**不要新增** `git config` 改动。
* 提交规范：`build:` / `feat:` / `fix(scope):` / `test(scope):` / `docs:` / `chore:`，中文正文，
  一次提交只做一件事（原子提交）；
* **每完成一个阶段同步更新**：`CHANGELOG.md`、`docs/REQUIREMENTS.md`（状态列）、`docs/ROADMAP.md`（勾选）、
  `docs/PROGRESS.md`（数字与落点）、`docs/HANDOVER.md`（新增不变式）；
* 文档里的数字（测试数、行数）必须来自实际命令输出，不能沿用上一版的数字。

## 7. 接手后的正确动作序列

1. 跑 `cargo test --offline --lib`（期望 **329**）+ `./scripts/no-lua-check.sh`（期望 0）确认基线；
   再加 `cargo clippy --offline --all-targets -- -D warnings` 与 `cargo fmt --all -- --check`，两个都必须零；
2. **M6 事务层** `src/transaction.rs`：单事务锁 → `config` 校验 → `rules::compile()` →
   `firewall::build()` → `nft -c` 干跑（能力具备时）→ apply → verify → last-good，
   失败按 `Undo` **逆序**回滚；启动时按 `NS` 前缀与 `OUR_RTPROT` 回收上次崩溃的残留。
   规则层在这一步**第一次有运行期调用者**（`firewall::Input::games`）；
3. **M7 RPC + main**：≥19 方法 + 统一信封 + `SO_PEERCRED` ACL + 审计 + tokio 监督循环
   （探测环 / 调度环 / **域名集合刷新环** / SIGHUP 重载 / SIGTERM 优雅关停且关停必须撤销自己的对象）；
4. M8 前端、M9 打包、M10 真机，按 `docs/ROADMAP.md` 的 DoD 逐条收口。

**不要在事务层之前先写 RPC/main** —— 那会让 RPC 暴露没有数据面支撑的方法。
`GameSpec` 契约（`src/system/firewall.rs:146`）已被 `build()` 消费、被规则层产出、
被端到端单测串起来，**不要为了「装配方便」去改它**；要接的是调用方。

## 8. 绝对不要做的事

* 不要为了「页面能跑起来」而写假数据或 mock 状态；
* 不要在 `root/` 下手写与 `firewall::include_file_text()` 不同的 nft 片段（必须同源生成）；
* 不要 flush 任何非 `inet smw` 的表，不要删非 `smw`/`smw_` 前缀的对象；
* 不要覆盖 `/etc/config/network` 或 `/etc/config/firewall`（本项目对它们只读）；
* 不要引入 `luci-lua-runtime` 或任何 `*.lua`（`no-lua-check.sh` 会拦，但也别靠脚本兜底）；
* **不要内置任何游戏服务器 IP/端口**，也不要加载没有 `source` 的预置项数据文件；
* **不要在规则条件上「放宽」**：能力不支持就不下发该条件，不要退回无目的/无客户端的兜底规则；
  元素超上限不要截断，要报错；
* 不要在匹配项拼接处加任何形式的 `filter`（`051829f` 那个缺陷就是这么来的）；
  集合引用必须带字段名；
* 不要把 `git reset --hard` / `push --force` 用在已有历史上；文档与代码问题用新提交修正。
