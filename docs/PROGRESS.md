# 进度文档

> 本文件反映**当前工作树**。任何「已完成」都必须能用下面的命令复核；
> 不能用命令复核的结论一律写成「待验证」。

最后更新：0.4.0-dev 周期，规则层（M5）收口之后。

## 1. 一句话状态

后端五层（配置 / 系统交互 / 健康 / 调度 / 规则）已完成并有 329 个单元测试全绿；
**事务层、RPC 层、守护进程入口、前端、打包尚未实现，因此本仓库现在不能装到路由器上用。**
规则层尤其要说清：它的产物只被单测喂进数据面生成器，运行期还没有任何调用者（M6/M7 才接上）。

## 2. 可复核指标

```sh
cargo test --offline --lib                          # 期望：329 passed; 0 failed
cargo clippy --offline --all-targets -- -D warnings # 期望：0 警告
cargo fmt --all -- --check                          # 期望：无差异
cargo build --offline                               # 期望：0 警告
./scripts/no-lua-check.sh                           # 期望：退出码 0
find src -name '*.rs' -print0 | xargs -0 cat | wc -l # 行数口径，见 §3 注
```

本环境实测结果（2026-10-26 复核，工具链 1.99.1）：

| 命令 | 结果 |
|---|---|
| `cargo test --offline --lib` | `329 passed; 0 failed; 0 ignored` 用时 ~0.30s |
| `./scripts/no-lua-check.sh` | 退出码 0；注入 `src/accidentally_controller.lua` 或 `require("luci.dispatcher")` 后退出码 1（已实测两个方向） |
| `cargo clippy --offline --all-targets -- -D warnings` | **通过，0 警告**。工具链从 1.98.1 升到 1.99.1 后 clippy 组件才可用；首轮暴露 20 条，已按语义逐条处理（见提交 `32b97ad`） |
| `cargo fmt --all -- --check` | **通过，无差异**（同一提交建立了 rustfmt 基线） |
| `cargo build --offline` | 0 警告 |
| `nft -c -f <脚本>` | **不可用**：沙箱没有 `nft` 二进制（uid 0 也没有），且无 netfilter 内核支持 |

## 3. 模块完成度

| 模块 | 行数 | 单测 | 状态 | 说明 |
|---|---:|---:|---|---|
| `src/lib.rs` | 340 | 6 | 完成 | fwmark 布局、错误类型、`NS` 前缀、版本常量 |
| `src/config/` | 4020 | 51 | 完成 | UCI 文本解析/序列化、schema v4、迁移、校验、diff、last-good |
| `src/system/` | 8233 | 109 | 代码完成 / 待真机 | netlink、route、interface、conntrack、exec、firewall |
| `src/health/` | 3275 | 49 | 完成 | 四类探测 + 滑窗指标 + 状态机 + Registry |
| `src/scheduler/` | 3586 | 58 | 完成 | balancing / failover / latency / hysteresis / 装配层 |
| `src/rules/` | 2270 | 51 | 完成（仅代码） | matchers / presets / dns_sets / compile；**运行期尚无调用者** |
| `src/logging.rs` | 539 | 5 | 完成 | 分级 + 环形缓冲 + 轮转 + 脱敏（`recent()`/`dropped()`） |
| `src/transaction.rs` | 1 | 0 | **占位** | 校验→下发→回读→回滚编排 |
| `src/rpc/` | 1 | 0 | **占位** | Unix socket JSON RPC + ACL + 审计 |
| `src/main.rs` | 1 | 0 | **占位** | 守护进程入口与 tokio 监督循环 |

合计 `src/**/*.rs` = 22,266 行。`rules` 的文件分布：`mod.rs` 721、`dns_sets.rs` 617、
`matchers.rs` 476、`presets.rs` 456。

> 行数口径注：本表改用 `find <dir> -name '*.rs' -print0 | xargs -0 cat | wc -l`
> （原始文件行数，含空行与注释）。此前记录的四层数字（3524 / 7181 / 2904 / 3063，合计 17,494）
> 是另一种口径留下的偏低值，**不是**代码被改小了；今后一律用上表那条命令复核。

按子模块的测试分布（用于判断「哪里测得厚、哪里薄」）：

```text
system::firewall   25   config::validate    20   system::route        19
health             18   system::interface   17   scheduler::balancing 17
system::netlink    15   rules::dns_sets     15   system               15
rules              14   scheduler           14   config               14
scheduler::failover 12  rules::matchers     12   health::probe        12
health::state      11   system::exec        10   rules::presets       10
config::uci        10   scheduler::latency   9   system::conntrack    8
health::metrics     8   config::schema        7  scheduler::hysteresis 6
core_tests          6   logging               5
```

合计 329（`config 51 / system 109 / health 49 / scheduler 58 / rules 51 / logging 5 / lib 6`）。

## 4. 目录现状（诚实版）

```text
src/            后端核心，见上表
docs/           本文档集（要求/路线图/进度/交接/架构/配置/安全/测试）
research/       两份上游审计（luci.md、buildsystem.md）—— 设计依据
scripts/        no-lua-check.sh
root/           仅空目录骨架（空目录不入 git，M9 建包时按代码常量创建）：
                etc/{config,init.d,rc.d,nftables.d}
                usr/share/luci/menu.d  usr/share/rpcd/{acl.d,ucode}
                usr/share/smartmwan/presets   ← 与 `rules::presets::PRESET_DIR` 同名
htdocs/         仅空目录骨架：luci-static/resources/{view/smartmwan,smartmwan}
tests/          空（集成测试未开始）
Makefile        不存在（打包未开始）
```

> 骨架目录本轮做了一次**对齐**：原来是 `root/usr/share/smartmwan/games`，
> 而代码里的常量是 `PRESET_DIR = "/usr/share/smartmwan/presets"`（`src/rules/presets.rs:50`）。
> 两处不一致的后果是「装了包但预置目录不存在 / 用户往 games 里放文件读不到」，
> 因此以代码常量为准。路径的唯一权威来源是 `src/rules/presets.rs::PRESET_DIR`。

## 5. 提交历史与阶段

| 提交 | 阶段 | 内容 |
|---|---|---|
| `f90e088` | build | crate 清单、`Cargo.lock`、`LICENSE`（GPLv2 全文）、`.gitignore` |
| `4bef8ae` | feat | 后端核心四层（配置 / 系统 / 健康 / 调度），259 测试 |
| `fa1c5a0` | test | 桶分配算法 17 条不变式单测，276 测试 |
| `c71ac12` | docs | 验收矩阵、路线图、进度、交接 |
| `32b97ad` | chore | clippy 归零 + rustfmt 基线 |
| `f803ad8` | docs | 架构/配置/安全/测试文档 + 两份上游研究笔记 |
| `051829f` | fix(firewall) | MAC 条件必须真的出现在规则文本里（此前被 `@` 前缀过滤整条丢弃） |
| `e1f31f2` | fix(firewall) | 域名条件不再被固定网段挤掉，也不再把匹配面放宽成兜底规则（+1 测试） |
| `c78d247` | feat(rules) | 规则层四模块：matchers / presets / dns_sets / compile（+50 测试 → 327） |
| `e766b4f` | test(rules) | 补同文件重复 id 的单测 + 更正预置项 id 注释（+1 测试 → 328） |
| `c2e8067` | fix(firewall) | 客户端条件全部失效时整条规则不下发，不再放宽到全 LAN（+1 测试 → 329） |
| `2e8b3d1` | docs | M5 落地后的文档同步（数字全部重测） |
| （本提交） | docs | 作者身份统一后的历史重写留痕 + 全部哈希引用更正 |

> **关于本表的哈希**：2026-10-26 按仓库所有者的明确指示，用 `git filter-branch` 把全部提交的
> author/committer 统一为 `LianXia233`（见 `docs/HANDOVER.md` §6），并 `--force-with-lease` 强推。
> **提交内容逐字节未变**（`git diff` 空），但**所有哈希都变了**，本表与全仓文档里的哈希引用已随之更正。
> 这是唯一一次重写，此后不得再改写；旧克隆需 `git fetch && git reset --hard origin/main`。

> **更正 `c78d247` 的提交说明**：其中「新增 51 条（rules 30 + dns_sets 21）」分布写错了。
> 实测为：`c78d247` 新增 **50** 条，全部在 `rules`（`dns_sets` 15 / `matchers` 12 /
> `presets` 9 / `mod` 14）；第 **51** 条来自 `e1f31f2`（`system::firewall`，24 条里新增的那条）。
> 也就是说「51」这个总数跨了两个提交，分布也不是它写的那样。当前 `rules` 已有 51 条
> （`e766b4f` 又补了 1 条同文件重复 id 的分支），总数 329。
> 按「不改写已提交历史」的约定，此处留痕而不 amend。后来的身份统一重写**只换了作者字段**，
> 没有动这条提交说明，所以本更正依然有效。

## 6. 本轮修过的真实缺陷（不是「顺手优化」）

这些是测试暴露出来的、会影响行为的错误，记录在此避免回归：

1. `interval_elapsed(last=0, …)` 把「从未切换过」当成「刚切换过」，导致进程启动后第一次决策被永久卡住
   —— 现在 `last_change_ms == 0` 直接判为间隔已满足。
2. `failover` 的最小切换计时语义：任何**真实**变更（含「变为不分流」）都刷新；未变更
   （尤其全灭期间的 `None→None`）绝不刷新，否则恢复后还要多等一个间隔。
3. 探测批次取消路径写成 `JoinSet::shutdown()`，它返回 future，未 await 等于什么都没做，
   取消会退化成「等全部探测跑完」—— 改为 `abort_all()`。
4. `latency` 丢包归一化基准为 0 时被 `.max(1)` 变成「该项扣满」，与「关掉该项」的用户意图相反
   —— 现在基准为 0 表示该项不参与扣分。
5. `Prober` 的并发额度原先是 `SystemProber` 私有方法（死代码），提升为 trait 的
   `free_permits()`，批次超额度时在日志里如实写「超出的部分排队执行」。
6. `scheduler::slot_map()` 曾经吞掉 `assign_slots()` 的错误并回退为空表 —— 那会把「配置有错」
   伪装成「没有线路」。改为返回 `Result` 并向上传播，配了 24 条以上线路时明确报错。
7. **MAC 条件整条丢失**（`051829f`，数据面缺陷）。`firewall.rs` 拼接规则匹配项时有一句
   `.filter(|m| !m.starts_with('@'))`，而裸集合引用正好以 `@` 开头 —— 每条 MAC 匹配项都被丢掉，
   「只针对这台主机」的规则静默放大成命中该范围内全部新建连接。现在集合引用必须带字段名
   （`ether saddr @set`）且拼接处不再过滤，并补了 `ether saddr` / `ip saddr` / `ip daddr`
   三条**存在性**断言。旧测试只断言集合被**声明**过，所以一直没红 —— 这是「测试看着厚、
   其实没测到关键路径」的典型，写规则层时按「条件必须出现在最终文本里」补测。
8. **目的条件互相挤掉 + 不支持时退化成兜底规则**（`e1f31f2`，数据面缺陷）。同一 v4 规则里
   `target` 与 `domain` 只取第一类非空，域名条件不生效；更糟的是域名集合因能力不足被跳过时，
   规则落到「无目的条件」分支，变成命中该主机全部新建连接的兜底规则。现在同族每个目的条件各一条规则，
   只有本来就没有任何目的条件时才下无目的规则；顺带删掉循环外多推的一条重复所有权标签。
9. **客户端条件全部失效时规则被放宽到全 LAN**（`c2e8067`，同类第三处）。规则用 `client_mac`
   限定主机，但设备 nft 不支持 `ether_addr` 集合（`caps.ether_sets == false`）时，代码只丢匹配项
   并写一条警告 —— 少一个条件不是「不生效」而是「匹配面变大」：降级后命中**全 LAN** 的新连接并打上
   游戏标记。更要命的是警告文案当时写「已降级为不匹配」，与真实行为相反，看日志会被误导。
   现在与域名条件同一处理原则：客户端条件全部无法生效时**整条不下发** + 如实说明；
   新增 `mac_only_rule_is_not_emitted_when_ether_sets_unsupported`（旧代码会让它失败）。

三条同类缺陷的共同教训：**能力降级路径必须证明「匹配面没有变宽」**。
只断言集合被声明、或者只断言「有警告产出」都不够，要断言最终规则文本里条件还在，
或者规则整条不存在。

## 7. 下一步（严格顺序）

1. **M6 事务层**（当前落点）：`src/transaction.rs` —— 把 `route::Applier` 与 `firewall::Nft`
   收进单事务锁，validate → plan → dry-run → apply → verify → last-good，失败按 `Undo` 逆序回滚；
   **并把规则层真正接上**：`rules::compile()` 的产物在这里进入 `firewall::Input::games`。
2. **M7 RPC + main**：≥19 方法 + 统一信封 + peer-cred ACL + tokio 监督循环（含域名集合刷新环）+ CLI；
3. **M8 前端**：先 ucode 桥与 ACL，再 7 个 JS 视图与 CSS；
4. **M9 打包**：Makefile + apk + procd + `/etc/nftables.d` 片段（由代码生成，保证同源）+
   `root/usr/share/smartmwan/presets/` 目录与 README（数据文件仍需权威来源）；
5. **M10 自动化 + 真机**：只有在拿到设备后才能把 M2 的「待真机」条目改成「完成」。

## 8. 已知阻塞与风险

| 项 | 影响 | 现状 |
|---|---|---|
| 沙箱无 `nft` / 无 netfilter 内核支持 | 无法验证 nftables 语法与 `ip rule` 下发 | 已把语法风险集中到 `firewall::probe_scripts()` 的能力探测，设备上不通过即降级为警告 |
| ~~无 clippy / rustfmt~~ | ~~无法交付 Lint 与风格结论~~ | **本次已解除**：工具链升到 1.99.1 后组件可用，clippy 0 警告 + rustfmt 基线已建立（`32b97ad`） |
| 无真机 | 5G 重拨、IPv6 绕过、断电重启幂等 等只能在 M10 验证 | 相关逻辑已有代码级防护，但结论必须留白 |
| 游戏预置库需要权威来源 | 违反「不得编造服务器 IP/端口」的风险 | 加载器与校验已就位（`rules::presets`），但**不内置任何数据**；`source` 字段缺失即整条拒绝，单测 `no_preset_is_bundled_in_code` + `missing_source_is_error` 钉住 |
| `getaddrinfo` 不返回 TTL | 域名集合的元素寿命只能取一个下界，偏长会留残值、偏短会加重解析 | 用 `global.dns_ttl_floor_s`（默认 300s，校验 30..86400）作为折中并在 schema 注释、`dns_sets.rs` 模块头、`docs/CONFIGURATION.md` 三处如实写明「这是不完备而非最优」；真 TTL 需换解析器（会引入依赖面），暂未做 |
| DNS 解析结果 ≠ 真实连接目的 | CDN 任播 / GeoDNS / 轮询会让域名规则命中不足 | 属产品固有限制，UI 与文档必须并列展示；DoH/DoT 流量无法从 53 端口识别，不做 SNI/DPI 识别 |
