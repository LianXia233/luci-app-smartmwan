# 进度文档

> 本文件反映**当前工作树**。任何「已完成」都必须能用下面的命令复核；
> 不能用命令复核的结论一律写成「待验证」。

最后更新：0.4.0-dev 周期，调度层收口之后。

## 1. 一句话状态

后端四层（配置 / 系统交互 / 健康 / 调度）已完成并有 276 个单元测试全绿；
**规则层、事务层、RPC 层、守护进程入口、前端、打包尚未实现，因此本仓库现在不能装到路由器上用。**

## 2. 可复核指标

```sh
cargo test --offline --lib                          # 期望：276 passed; 0 failed
cargo clippy --offline --all-targets -- -D warnings # 期望：0 警告
cargo fmt --all -- --check                          # 期望：无差异
cargo build --offline                               # 期望：0 警告
./scripts/no-lua-check.sh                           # 期望：退出码 0
```

本环境实测结果（2026-10-26 复核）：

| 命令 | 结果 |
|---|---|
| `cargo test --offline --lib` | `276 passed; 0 failed; 0 ignored` 用时 ~0.29s |
| `./scripts/no-lua-check.sh` | 退出码 0；注入 `src/accidentally_controller.lua` 或 `require("luci.dispatcher")` 后退出码 1（已实测两个方向） |
| `cargo clippy --offline --all-targets -- -D warnings` | **通过，0 警告**。工具链本次从 1.98.1 升到 1.99.1 后 clippy 组件才可用；首轮暴露 20 条，已按语义逐条处理（见提交 `a0b32a0`） |
| `cargo fmt --all -- --check` | **通过，无差异**（同一提交建立了 rustfmt 基线） |
| `cargo build --offline` | 0 警告 |
| `nft -c -f <脚本>` | **不可用**：沙箱没有 `nft` 二进制（uid 0 也没有），且无 netfilter 内核支持 |

## 3. 模块完成度

| 模块 | 行数 | 单测 | 状态 | 说明 |
|---|---:|---:|---|---|
| `src/lib.rs` | 329 | 6 | 完成 | fwmark 布局、错误类型、`NS` 前缀、版本常量 |
| `src/config/` | 3524 | 51 | 完成 | UCI 文本解析/序列化、schema v4、迁移、校验、diff、last-good |
| `src/system/` | 7181 | 107 | 代码完成 / 待真机 | netlink、route、interface、conntrack、exec、firewall |
| `src/health/` | 2904 | 49 | 完成 | 四类探测 + 滑窗指标 + 状态机 + Registry |
| `src/scheduler/` | 3063 | 58 | 完成 | balancing / failover / latency / hysteresis / 装配层 |
| `src/logging.rs` | 533 | 5 | 完成 | 分级 + 环形缓冲 + 轮转 + 脱敏（`recent()`/`dropped()`） |
| `src/rules/` | 1 | 0 | **占位** | 游戏/客户端/域名规则 → nft 对象 |
| `src/transaction.rs` | 1 | 0 | **占位** | 校验→下发→回读→回滚编排 |
| `src/rpc/` | 1 | 0 | **占位** | Unix socket JSON RPC + ACL + 审计 |
| `src/main.rs` | 1 | 0 | **占位** | 守护进程入口与 tokio 监督循环 |

合计 `src/**/*.rs` = 17,494 行。

按子模块的测试分布（用于判断「哪里测得厚、哪里薄」）：

```text
system::firewall   23   config::validate    20   system::route        19
health::tests      18   system::interface   17   scheduler::balancing 17
system::tests      15   system::netlink     15   scheduler::tests     14
config::tests      14   scheduler::failover 12   health::probe        12
health::state      11   system::exec        10   config::uci          10
scheduler::latency  9   system::conntrack    8   config::schema       7
scheduler::hysteresis 6   logging::tests     5
```

## 4. 目录现状（诚实版）

```text
src/            后端核心，见上表
docs/           本文档集（要求/路线图/进度/交接/架构/配置/安全/测试）
research/       两份上游审计（luci.md、buildsystem.md）—— 设计依据
scripts/        no-lua-check.sh
root/           仅目录骨架，尚未落地文件：
                etc/config  etc/init.d  etc/rc.d  etc/nftables.d
                usr/share/luci/menu.d  usr/share/rpcd/{acl.d,ucode}  usr/share/smartmwan/games
htdocs/         仅目录骨架：luci-static/resources/{view/smartmwan,smartmwan}
tests/          空（集成测试未开始）
Makefile        不存在（打包未开始）
```

## 5. 提交历史与阶段

| 提交 | 阶段 | 内容 |
|---|---|---|
| `df08b54` | build | crate 清单、`Cargo.lock`、`LICENSE`（GPLv2 全文）、`.gitignore` |
| `2054e70` | feat | 后端核心四层（配置 / 系统 / 健康 / 调度），259 测试 |
| `11e6564` | test | 桶分配算法 17 条不变式单测，276 测试 |
| （docs 批次） | docs | README / CHANGELOG / 本文档集 / no-lua-check.sh |

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

## 7. 下一步（严格顺序）

1. **M5 规则层**（当前落点）：`rules/matchers.rs` → `rules/games.rs` → `rules/dns_sets.rs`，
   含冲突检查与 `GamePolicy` 联动；
2. **M6 事务层**：把 `route::Applier` + `firewall::Nft` 收进单事务锁，接 last-good；
3. **M7 RPC + main**：≥19 方法 + 统一信封 + peer-cred ACL + tokio 监督循环 + CLI；
4. **M8 前端**：先 ucode 桥与 ACL，再 7 个 JS 视图与 CSS；
5. **M9 打包**：Makefile + apk + procd + `/etc/nftables.d` 片段（由代码生成，保证同源）；
6. **M10 自动化 + 真机**：只有在拿到设备后才能把 M2 的「待真机」条目改成「完成」。

## 8. 已知阻塞与风险

| 项 | 影响 | 现状 |
|---|---|---|
| 沙箱无 `nft` / 无 netfilter 内核支持 | 无法验证 nftables 语法与 `ip rule` 下发 | 已把语法风险集中到 `firewall::probe_scripts()` 的能力探测，设备上不通过即降级为警告 |
| ~~无 clippy / rustfmt~~ | ~~无法交付 Lint 与风格结论~~ | **本次已解除**：工具链升到 1.99.1 后组件可用，clippy 0 警告 + rustfmt 基线已建立（`a0b32a0`） |
| 无真机 | 5G 重拨、IPv6 绕过、断电重启幂等 等只能在 M10 验证 | 相关逻辑已有代码级防护，但结论必须留白 |
| 游戏预置库需要权威来源 | 违反「不得编造服务器 IP/端口」的风险 | 决定：不内置任何无来源数据，只提供可编辑数据文件与加载器 |
