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
* **文档集**：`README.md`、`docs/REQUIREMENTS.md`（任务书 15 节 → 可核查验收矩阵）、
  `docs/ROADMAP.md`（M0–M10 与各自 DoD）、`docs/PROGRESS.md`（模块完成度与实测数字）、
  `docs/HANDOVER.md`（「改了会出事」的不变式清单），以及禁 Lua 自动化检查
  `scripts/no-lua-check.sh`（已实测「干净→退出 0 / 注入→退出 1」两个方向）。

### 变更

* `interval_elapsed()` 现在把 `last_change_ms == 0`（从未变更过）判为「间隔已满足」，
  否则进程启动后的第一次决策会被一个不存在的历史切换永久卡住。
* `failover::Machine` 的最小切换计时改为「任何真实变更都刷新（含变为不分流）」，
  未变更（尤其全灭期间的 `None→None`）不刷新。
* `latency::Scored` 的丢包归一化基准为 0 时按「该项不参与扣分」处理，
  不再用 `max(1)` 把「关掉某项权重」变成「该项直接扣满」。

### 修复

* `Debounce::offer()` 触发后到下一次未命中之间保持沉默（一次性触发语义），
  避免回切/择优动作被反复执行。
* 探测批次取消路径：`JoinSet::abort_all()` 取代 `shutdown()`（后者返回 future，
  未 await 时什么都不做，取消会退化成「等全部探测跑完」）。
* 安装期 nftables 静态占位（`firewall::include_file_text()`）不再声明第二条挂
  `prerouting` 的 `output` 链：链名与 hook 类型不一致是语义错误（重复注册同一 hook），
  而 `type route hook output` 属于未经设备实测的语法，写进静态占位会让 fw4 在不支持的
  内核上直接启动失败。`output` 链改为运行期按能力探测结果添加，并加了对应断言。

### 已知缺失（尚未实现，别当作已完成）

* `src/rules`（游戏/客户端/域名规则 → nftables 对象）——占位。
* `src/transaction`（校验→下发→回读→回滚 + last-good）——占位。
* `src/rpc`（Unix socket JSON RPC + ACL + 审计）——占位。
* `src/main`（守护进程入口与 tokio 监督循环）——占位。
* LuCI 前端 7 个页面、CSS、rpcd ucode 桥、ACL JSON、menu.d JSON——未创建。
* OpenWrt 包 Makefile、procd 脚本、UCI 默认配置、`/etc/nftables.d` 片段、
  apk 维护脚本——未创建。
* 真机验证：**未做**。本沙箱没有 `nft` 二进制、没有 root、没有路由器。
* `cargo clippy` 与 `cargo fmt`：**本环境不可用**（工具链未安装该组件），
  因此没有静态风格/Lint 结论可以交付。

## [0.3.0] — 2026-10-26（内部里程碑）

* 健康层探测与服务闭合（218 单测）。

## [0.2.0] — 2026-10-26（内部里程碑）

* 系统层策略路由与 netlink 编解码。

## [0.1.0] — 2026-10-26（内部里程碑）

* 配置层与 fwmark 布局定稿。
