# 路线图

里程碑编号与任务书第 15 节「执行顺序」一一对应。**完成定义（DoD）里有真机项的里程碑，
在没有设备的情况下不得标记为「完成」**，最多 `待真机验收`。

## M0 —— 基线与红线（已完成）

DoD：

* [x] Rust crate 骨架、GPLv2 许可证、`.gitignore`；
* [x] 依赖最小化并在清单里逐条写明取舍理由；
* [x] 禁 Lua 自动化检查 `scripts/no-lua-check.sh`，并**实测两个方向**（干净 → 0，注入 → 1）；
* [x] fwmark 布局定稿并写成不变式单测（魔数、槽位、`RULE_MASK` 只隔离槽位）。

产出：`Cargo.toml`、`src/lib.rs`、`LICENSE`、`scripts/no-lua-check.sh`。

## M1 —— 配置层（已完成）

DoD：

* [x] 原生 UCI 文本解析/序列化（不依赖 libuci，因此不需要 Lua、不需要 FFI）；
* [x] schema v4 + 默认值集中于 `schema.rs`（UI 与 `--dump-defaults` 同源）；
* [x] 就地迁移：旧键 `primary_interface`→`primary`、`failback` 布尔→枚举；
* [x] 结构化校验报告（errors/warnings/schema_version），未识别的用户键回写时原样保留；
* [x] `save`/`apply` 分离所需的三件套：`diff()`、`fingerprint()`、`Applied::{store,load}_applied`。

## M2 —— 系统交互层（代码完成，待真机）

DoD：

* [x] 手写 rtnetlink 编解码（GETRULE/GETROUTE/GETADDR，v4+v6 双族）；
* [x] 策略路由差量下发：`plan()` → `Diff` → `Applier::{apply,verify,rollback}` + `Undo`；
* [x] 优先级/掩码冲突审计 `audit_conflicts()`，只在自己的 `RULE_PRIO_BASE..+SPAN` 带内动作；
* [x] netifd 拓扑与 firewall zone 解析、`/sys` 接口计数、conntrack 按标记统计；
* [x] 唯一执行通道：绝对路径白名单 + 参数数组（不经 `sh -c`）+ 硬超时 + kill_on_drop + 输出封顶；
* [x] nftables 程序生成与能力探测脚本；
* [ ] **待真机**：`nft -c -f` / `nft -f` / `nft -a list` / `replace rule handle` 在目标设备上的实际行为；
* [ ] **待真机**：`jhash ... map`、`th sport/dport`、`type route hook output`、`flags dynamic,timeout`、
      `ether_addr` 集合、规则 `comment` —— 全部由 `probe_scripts()` 在设备上实测，探测不通过的语法
      降级为 `Issue::Warning` 而不是写进程序。

## M3 —— 健康层（已完成）

DoD：

* [x] ICMP/TCP/UDP/DNS 四类探测，均 `SO_BINDTODEVICE` + 显式源地址 bind；
* [x] ping socket（`SOCK_DGRAM/IPPROTO_ICMP`），不需要 `CAP_NET_RAW`；
* [x] 滑窗指标（RTT、抖动、丢包、不稳定度、P95；窗口 90，置信门槛 5 样本）；
* [x] `UNKNOWN→HEALTHY→DEGRADED→FAILED→RECOVERING→HEALTHY` + 预热 + 时间驱动 `tick()`；
* [x] 探测结果五分法 `Reply/Timeout/Unreachable/Unsupported/LocalError`，后两类不计入线路失败；
* [x] 状态机单测。

## M4 —— 调度层（已完成）

DoD：

* [x] 9 种算法的桶分配与动态重排，各带能力边界说明；
* [x] 动态算法的单轮搬动预算 + 优势闸门（防抖动式全量迁移）；
* [x] 主备：多级备份顺序、四条件回切、强制切换、维护模式、全灭保护；
* [x] 游戏评分与滞回择优，模式感知（`Follow` 时只允许活动线路）；
* [x] 装配层 `scheduler::decide()`：单一所有者持有 `Machine`/`Picker`，未测量首轮显式说明；
* [x] `Outcome.changed` 由真实桶图比较得出 —— 决策未变即不产生任何数据面写入（这是「不做高频全量重建」
      在应用层的落点）；
* [x] 276 个 lib 单测（其中 balancing 不变式 17 条）—— 这是 **M4 收口时**的数字，M5 之后为 329。

## M5 —— 规则层（游戏路由）（已完成）

范围：`src/rules/{mod,matchers,presets,dns_sets}.rs`（2270 行，51 条单测）

DoD：

* [x] `GameSpec`：从 UCI `config game` 段编译出匹配器集合，按 (priority, name) 确定性排序
      （`rules::compile`；slug 冲突按排序顺序加 `-2`/`-3`，同一输入两次编译产物逐字节相同）；
* [x] 冲突检查：重叠目的段与同优先级歧义在 `config::validate::overlaps()`（20 条单测），
      `pin_wan` 指向已禁用/不存在的线路在 `rules::compile` 里直接报错；
* [x] 预置库：**只提供用户可自行编辑的数据文件**（`/usr/share/smartmwan/presets/*.json`），
      本项目不内置任何服务器 IP/端口，缺 `source` 的来源声明直接拒绝加载（Error）；
      `presets::tests::no_preset_is_bundled_in_code` 把这条钉住；
* [x] 域名规则 → 动态 nft 集合：`dns_sets::Registry` 按域名对账（增/删/保留分别计数），
      `flags dynamic,timeout; size 1024` 由 `firewall` 声明，寿命来自
      `global.dns_ttl_floor_s`（默认 300 秒，校验 30..86400）；
      `MAX_SET_ELEMENTS=2048` 超限在 `rules` 层报错而不是截断；
* [x] 文档化的限制：`dns_sets` 模块头六条（getaddrinfo 拿不到 TTL、CDN/anycast、
      DoH/DoT 绕过、IPv6 不进集合但计入 `v6_skipped`、不看 SNI、解析失败不算线路故障）；
* [x] 与 `GamePolicy` 的联动：主备模式 + `game_policy=follow` 时游戏规则整体不下发
      （`rules::tests::failover_follow_blocks_game_rules`），
      `selection=best` 无择优结论时进 `pending` 而不是随便指一条线路；
* [x] 端到端单测：`rules::tests::compiled_specs_are_accepted_by_firewall_build` 把规则层产物直接
      喂进 `firewall::build()`，断言集合声明与规则文本同时出现（分层契约漂移只能在这里被抓到）；
* [x] 规则层落地过程中抓出并修复**三处数据面静默放宽**缺陷：`051829f`（MAC 匹配项被 `@` 前缀过滤
      整条丢弃）、`e1f31f2`（域名条件被固定网段挤掉，且设备不支持动态集合时退化成命中全部新建连接的
      兜底规则）、`c2e8067`（`caps.ether_sets == false` 时只丢客户端条件继续下发，把「一台主机」
      放宽成「全 LAN」，而警告文案还写着「降级为不匹配」）。三者都补了「条件必须出现在最终 nft 文本里
      或规则整条不存在」的断言 —— 旧测试只验证集合被**声明**过，所以一直是绿的
      （详见 `docs/PROGRESS.md` §6.7/6.8/6.9）。

真机才能收口的项目（不属于本层 DoD，但 M10 之前不能宣称完成）：

* [ ] `nft -c` 校验生成的脚本（沙箱无 `nft` 二进制）；
* [ ] 动态集合的真实老化行为与 `dns_ttl_floor_s` 的观感一致性；
* [ ] `ether saddr` 在目标设备 nft 版本上的实测（`probe_scripts` 的 `ether_sets`）。

## M6 —— 事务层（未开始）← **当前落点**

范围：`src/transaction.rs`，把 M2 的 `route::Applier` 与 `firewall::Nft` 编排成一次可回滚提交，
并把 M5 的规则层真正接上（`rules::compile()` → `firewall::Input::games`）。

DoD：

* [ ] **装配**：一次提交内把 `config → rules::compile → firewall::build → nft apply → route apply` 串起来，
      中间任一步失败都不留下半套状态；
* [ ] 单事务锁（同一时刻只允许一个提交者，含并发 RPC 场景）；
* [ ] validate → plan → dry-run(`nft -c`) → apply → verify → commit last-good；任一步失败按 `Undo` 逆序回滚；
* [ ] 残留检测：启动时先回收上一次崩溃留下的对象（按 `NS` 前缀与 `OUR_RTPROT` 判定所有权）；
* [ ] 重启幂等：重复 apply 不产生重复规则（以 `Diff` 为空为证据，不是以「执行成功」为证据）；
* [ ] 事务日志：每笔变更记 transaction id，与 `Applied.transaction` 对应。

## M7 —— RPC 与守护进程（未开始）

范围：`src/rpc/{mod,ubus}.rs`、`src/main.rs`

DoD：

* [ ] Unix socket + JSON，≥19 个方法（清单见 `docs/ARCHITECTURE.md`）；
* [ ] 统一信封 `{ok, data, error{code,message}, timestamp}`，错误码取 `Error::code()`；
* [ ] `SO_PEERCRED` 校验对端 uid，非 root/wwwdata 白名单一律 `Permission`；
* [ ] 读写互斥：读操作无副作用（不得为了「刷新」而触发下发）；
* [ ] 审计日志：所有写方法记调用者、参数摘要（脱敏）、事务 id、结果；
* [ ] CLI：`--config --check --once --dump-nft --dump-defaults --capabilities --print-config --restore-last-good`；
* [ ] tokio 监督循环：探测环 + 调度环 + SIGHUP 重载 + SIGTERM/SIGINT 优雅关停（关停必须撤销自己的对象）。

## M8 —— 前端（未开始）

DoD：

* [ ] 7 个标签页 JS 视图 + `smartmwan.css`（Grid + Flexbox，`.smw-` 作用域）；
* [ ] rpcd ucode 桥 `root/usr/share/rpcd/ucode/smartmwan.uc`（零 Lua）；
* [ ] `menu.d` / `acl.d` JSON，ACL 按方法粒度授权，不用 `ubus: *`；
* [ ] 空/加载/无权限/RPC 失败四态如实渲染；后端 note 直接透传，不写「正常」占位；
* [ ] `poll.add/remove` 生命周期成对，切页必须停轮询。

## M9 —— 打包与安装（未开始）

DoD：

* [ ] OpenWrt 包 Makefile（`rust-package.mk` 路径优先，否则自建交叉编译 + 架构探测）；
* [ ] **apk** 产物与维护脚本（pre/post inst、rmupgrade），依赖声明不含 `luci-lua-runtime`；
* [ ] `root/etc/config/smartmwan`（默认 `enabled=0`）、`root/etc/init.d/smartmwan`（procd）、
      `root/etc/nftables.d/smartmwan.nft`（由 `firewall::include_file_text()` 生成，保证与代码同源）；
* [ ] 升级/卸载/回滚：卸载必须清干净自己的对象，且**不删用户配置**（配置归 `conffiles`）；
* [ ] 产物校验（大小/架构/依赖闭包）与可复现性说明（锁定 `Cargo.lock`、固定 crate 版本）。

## M10 —— 自动化与真机验收（未开始）

DoD：

* [ ] CI/脚本：`cargo test`、`no-lua-check.sh`、`--check`、`--dump-nft` 快照比对、apk 构建；
* [ ] `tests/*.rs` 集成测试（配置→决策→nft 文本 的黄金样本回归）；
* [ ] 真机矩阵：x86-64 与 aarch64 各一台，至少验证 nft 语法、5G 重拨后网关变化、
      IPv6 不绕过、管理平面不失联、断电重启后规则不重复；
* [ ] 最终报告：状态/改动文件/测试命令/结果/遗留问题，全部如实。

## 明确不做的事

* 不做 opkg 时代遗留的 `.ipk` 产物（25.12 起上游已换 apk）；
* 不内置任何无来源的游戏服务器 IP/端口；
* 不为了「看起来能用」而伪造未探测成功的能力；
* 不做低端嵌入式专项优化（按任务书要求，假设现代路由 CPU 足够，直接用 tokio 多线程）。
