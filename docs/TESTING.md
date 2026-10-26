# 测试与验收

## 1. 命令一览

```sh
# 单元/回归（无需网络、无需 root、无需路由器）
cargo test --offline --lib          # 期望 378 passed; 0 failed

# Lint 与风格（提交前置条件，必须带 -D warnings）
cargo clippy --offline --all-targets -- -D warnings # 期望 0 warning
cargo fmt --all -- --check                    # 期望 无差异

# 构建
cargo build --offline                # 期望 无 warning
cargo build --offline --release      # 发布前基线

# 工程红线（禁 Lua）
./scripts/no-lua-check.sh            # 期望 退出码 0

# 需要 root + OpenWrt 内核环境（沙箱做不到，见 §5）
smartmwand --check                   # 只做校验，不写内核
smartmwand --dump-nft                # 打印将要下发的 nft 程序
smartmwand --capabilities            # 在设备上实测 nft 语法能力
smartmwand --once                    # 单轮：探测→决策→下发→回读，不常驻
smartmwand --restore-last-good       # 回到上一次成功状态
```

## 2. 测试矩阵（覆盖到的层与不变式）

| 层 | 测试数 | 关键不变式 |
|---|---:|---|
| `lib` 核心 | 6 | 标记字段往返；所有权区间覆盖全部合法标记且不含他人典型值；`RULE_MASK` 只隔离槽位；UTF-8 安全截断；槽位 0 被拒 |
| `config` | 51 | UCI 文本 round-trip；未知键保留；缺字段落默认；迁移旧键；枚举非法值报错而非静默回退；默认关闭；diff/fingerprint 稳定；20 条校验规则（含同优先级规则范围重叠） |
| `system` | 118 | netlink 报文编解码逐字段；`plan()` 只在 usable 时成对产出规则与路由；`Diff::blocking()` 拦住 Error 级冲突；`Applier` 回滚逆序；优先级带所有权判定；`exec` 超时杀进程/白名单/输出封顶；conntrack 行数上限与标记解析；nft 程序文本黄金样本（含 IPv6 关闭不建 v6 集合、占位文件单一 hook、**每个条件必须出现在规则文本里**、同族多目的条件各出一条规则、能力不足时不下发该条件也不留兜底）；**能力探测判定**（8 条脚本全通过 ⇒ 含 `jhash_seed` 在内逐项开启、全失败 ⇒ `nft_exists` 仍为真而高风险语法一律关闭、`jhash_map` 以 `ct_mark_range` 为前提；`Nft::version()` 只在退出 0 且有输出时给版本号）|
| `health` | 50 | 探测四类均绑定设备与源地址；`Unsupported`/`LocalError` 不改状态；并发额度如实反映配置；取消路径能真正中断批次；滑窗指标与置信门槛；状态机全部迁移边 + 预热 + 时间驱动 `tick()` |
| `scheduler` | 58 | 权重比例 3:1→桶 48:16；DEGRADED 半权重；不可用线路 0 桶；全零映射必带原因；`WeightedEcmp` 返回 `Unsupported`；`buckets=0` 报配置错；相同输入 0 搬动；交织场景搬动数在预算内；动态算法「采样不可信」降级注记；优势闸门 0 搬动；消失槽位强制清出；连接上限触发迁移；`interval_elapsed` 的 0 语义与回绕；回切四条件；强制切换与目标不可用时保留指令；主备顺序不捏造线路 |
| `rules` | 51 | CIDR 网络位归一与按族分拣；坏值**报错不跳过**；端口拒绝 `0`/`0-1024`/逆序/取反；MAC 三种写法统一小写；域名拒通配符与 URL；slug 归一且去重确定性（`-2`/`-3`）；预置项**代码零内置**、缺 `source` 拒绝、空目的拒绝、文件内与跨文件重复 id 拒绝、坏文件整批失败、>512KiB 拒绝；域名注册表按域对账（增/删/保留/v6 跳过/满额拒绝/截断计数）、过期与两寿命陈旧窗口、**解析失败不清空旧元素**；`compile()` 合并语义（目的与域名并集、端口与协议规则赢、客户端条件只来自规则）、四种不产出情形、超上限报错不截断、`pin` 指向不存在/未启用槽位报错、mark 为 0 报错、无条件匹配报错；**端到端**：`compile()` 产物直接喂 `firewall::build()` 并断言集合声明与规则文本同时出现 |
| `logging` | 5 | 等级过滤；环形缓冲上限与 `dropped()` 计数；轮转；敏感字段脱敏 |
| `rpc` | 18 | 方法表与架构文档逐条对齐（23 个、无重名、全部带命名空间、写方法标对）；信封形状（成功不带 error、失败不带 data、protocol/timestamp 必填）；12 个错误码映射逐条锁定；帧编解码 round-trip、零长/超大/EOF 三态；陌生 uid 在分发前被拒且错误信息带 uid；无主循环时写方法明确报错（不假装成功）；缺参数是 validate 错误；`validate` 不落任何文件；密钥字段递归脱敏（密码/token/key 不进日志）；`wwwdata` 从 `/etc/passwd` 解析而非猜测、文件缺失时只允许 root；socketpair 上取 `SO_PEERCRED`；未测量时线路状态必须是 unknown/未测量（不许显示健康）；`apply` 回执原样透传（ok=false 也 ok=true 送出，rollback 字段不丢）|
| `transaction` | 21 | 阶段顺序固定（validate→plan→nft 试算→路由下发→路由复核→nft 下发→nft 复核→快照）且阶段名对日志/RPC 稳定；单事务锁串行化（第二个提交者卡在入口）；试算失败不动内核也不留状态文件；路由失败绝不进 nft 提交；nft apply 失败回滚路由并如实报告回滚结果；nft 复核失败**按逆序**回滚（先 nft 后路由）且不写快照；外来优先级冲突在任何副作用之前拦下；无 nft 通道时拒绝 enabled 提交但允许停用；幂等第二次提交（`[check, apply, check]`，`changed=false`）；快照写失败不得报成功；停用⇒自有对象全清；`reclaim()` 只删自己的规则/路由/表并列出他人对象；游戏规则从 UCI 段一路落到最终 nft 文本；`best` 无结论进 `pending` 不编造线路；事务 id 唯一且写进快照。**限定**：nft 通道是 `FirewallExec::Sim` 替身，只验编排顺序，**不验证 nft 语法** |

`tests/`（集成）目前为空 —— 计划见 §4。事务链路的编排结论现在全部落在 lib 单测里
（`transaction` 21 条），集成测试要做的是「黄金样本回归 + 真实 `FirewallExec::Real`」，二者都还没写。

## 3. 工程测试（非功能）

| 检查 | 命令 | 本环境实测 |
|---|---|---|
| 零 Lua（文件 / `require("luci.*")` / Makefile 依赖） | `./scripts/no-lua-check.sh` | 干净树退出 0；注入 `src/accidentally_controller.lua` 或 `require("luci.dispatcher")` 后退出 1（**两个方向都实测过**） |
| 依赖面 | `cargo tree` | 运行依赖仅 tokio / libc / serde / serde_json / thiserror |
| 可复现 | `Cargo.lock` 入库 | 是 |
| 无 shell 拼接 | 代码审查 + `exec.rs` 测试 | 唯一入口，参数数组、绝对路径白名单 |
| 许可证 | `LICENSE` | GPLv2 全文（含「或更高版本」模板），清单声明 `GPL-2.0-or-later` |

## 4. 计划中的测试（尚未编写）

* `tests/golden_nft.rs`：固定配置 → 期望 nft 程序文本快照，防止规则生成回归；
* `tests/config_tx.rs`：save→diff→apply→rollback→last-good 的端到端（用临时目录与假的 `RouteOps`/`Nft` 实现）。
  **M6 之后这条的范围缩小了**：编排语义已在 `transaction` 的 21 条单测里覆盖（含替身通道），
  集成测试要补的是「跨进程重启后从磁盘快照恢复」与「`FirewallExec::Real` 下的真实回滚」；
* `tests/rpc_acl.rs`：信封格式、错误码稳定性、未授权 uid 被拒、读方法无副作用；
* `tests/live_netlink.rs`：`#[ignore]` 的活体冒烟测试，只在有权限的 Linux 上显式运行，
  验证本项目的 netlink 解码与内核真实输出一致（沙箱内核可跑读路径，但不等于 OpenWrt 内核）。

## 5. 10 条交付判据（逐条如实回答）

| # | 判据 | 现在的回答 |
|---|---|---|
| 1 | 能在 OpenWrt 25.12+ 安装 | **不能** —— 无 Makefile/apk 产物（M9 未开始） |
| 2 | 能构建 | **Rust 侧能**：`cargo build --offline` 通过；**OpenWrt 侧不能**：无 SDK |
| 3 | 能测试 | 能：378 单测 + Lua 红线脚本 + WSL 真 nft/netlink 端到端（事务/回收/关停/23 方法）；`tests/` 目录的集成测试仍未写 |
| 4 | 零 Lua | 是，且有自动化证明（两个方向实测） |
| 5 | 后端为模块化 Rust 常驻服务 | **是**：`src/main.rs` 常驻守护进程（探测环/调度环/域名刷新环/信号/优雅关停）已在 WSL 真环境端到端验证；目标设备未验收 |
| 6 | 前端 7 页可用 | **否**，一个都没写 |
| 7 | 数据面真实生效 | **WSL 已验证、目标设备未验证**：`FirewallExec::Real` 在 WSL（真 nft 1.1.3 + 真 netlink）上跑通了「生成 → `nft -c` 试算 → 路由下发 → 双侧复核 → 提交 → 快照」全链路，nft 表、`ip rule`、表 101 路由都实测装上也实测删掉（关停/崩溃回收）。但 WSL 的 nft 版本与接口形态≠目标设备，本判据的最终改口必须等设备上的同一批结论 |
| 8 | 安全清单落实 | 部分：注入/配置只读/残留/探测负载/并发事务锁/**RPC ACL（SO_PEERCRED + uid 白名单）**/**审计（脱敏）**有实现与验证；**前端轮询泄漏未实现**（M8），ACL 的方法粒度授权依赖 rpcd acl.d（M8） |
| 9 | 不把模拟数据当实时状态 | 机制上成立（后端对「未测量」「全灭」「降级」都产出显式 note 且不承载流量）；前端未实现，因此该判据要等 M8 复验 |
| 10 | 列出未完成特性 | 是：`README.md`、`CHANGELOG.md`「已知缺失」、`docs/REQUIREMENTS.md` 状态列、`docs/PROGRESS.md` §4 |

## 6. 本环境的真实限制（2026-10-26 复核）

| 项 | 状态 | 说明 |
|---|---|---|
| `rustc` / `cargo` | 可用 | **1.99.1**（WSL Debian，`~/.cargo`）；此前 Windows 侧 1.98.1 的 clippy/rustfmt 组件包 404，已迁到 WSL 后可用 |
| `cargo clippy` | **可用** | 0 警告（`-D warnings`）；首轮 20 条风格警告已在 `32b97ad` 清零 |
| `cargo fmt` | **可用** | `cargo fmt --all -- --check` 无差异 |
| `nft` 二进制 / netfilter 内核模块 | **WSL 内可用** | WSL（Debian，内核 6.18）root 下有 `/usr/sbin/nft`（**1.1.3**）且 netfilter 可用：能力探测、`nft -c -f` 试算、`nft -f` 提交、`nft -a list chain` 复核全部实测通过。**注意该版本缺 `dynamic,timeout` 集合与 jhash 种子参数** —— 能力探测如实报了「不可用」，这是真实的版本差异而非缺陷；目标设备的 nft 通常更新，结论必须以设备为准 |
| 真实路由/规则下发 | **WSL 内已执行** | M7 的端到端验证就在 WSL 完成：事务八阶段、幂等复核、崩溃（kill -9）后启动回收、SIGTERM 优雅关停回收、23 个 RPC 方法请求/响应。本插件只碰自己的表（101–124）与 `inet smw`、自己的优先级带（1000–1023），对 WSL 网络零影响。**仍未在目标 OpenWrt 设备上执行** |
| OpenWrt SDK / 交叉工具链 | 不可用 | 无法产出 apk，也无法验证 `rust-package.mk` 细节（M9） |
| `raw.githubusercontent.com` | TLS 中断 | 上游源码引用改走镜像站与本地已核对文件 |

结论：**「设备可用」仍未证实，但「端到端可运行」已在 WSL 证实**。文档与 UI 文案必须保持这一口径：
WSL 的通过证明的是「编排 + 编码 + 协议 + 生命周期正确」，不是「目标设备上的 nft 版本与网络形态正确」。
