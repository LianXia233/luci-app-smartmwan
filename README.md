# luci-app-smartmwan

面向 **OpenWrt 25.12 / ImmortalWrt（openwrt-25.12 基线）** 的多 WAN 智能选路插件：
策略路由 + firewall4/nftables 数据面 + Rust 异步守护进程 + LuCI 原生 JavaScript 界面。

**本项目不使用 Lua。** 后端为 Rust，前端为 LuCI ucode-era 原生 JS（`L.view`），
RPC 桥接为 rpcd 的 ucode 插件。仓库里出现任何 `*.lua` 都视为回归，
`scripts/no-lua-check.sh` 会把它当构建失败处理。

## 为什么只做 25.12+

OpenWrt 25.12 把包管理从 opkg 换成 **apk**，LuCI 也从 Lua 迁移到 ucode
（`luci-base` 不再带 `luasrc/`）。这两件事决定了本插件的形态：交付物是 `.apk`，
界面是 JS + rpcd ucode，而不是一份还能在 21.02 上跑的兼容代码。
兼容性细节与来源见 [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md#固件与工具链事实)。

## 目录结构

```text
src/                    Rust 后端（1 个库 + 1 个守护进程二进制）
  lib.rs                分层文档、错误类型、fwmark 布局（全项目最重要的约定）
  config/               UCI 文本解析 / 迁移 / 类型化模型 / 结构化校验
  system/               netlink、策略路由、接口拓扑、nftables 生成、conntrack、exec
  health/               探测（ICMP/TCP/UDP/DNS）、滑动窗口指标、线路状态机
  scheduler/            负载均衡桶分配、主备切换、滞回去抖、低延迟择优
  rules/                流量分类（游戏白名单 / 客户端匹配 / 域名动态集合）  ← 未实现
  transaction.rs        校验→下发→回读→回滚 的单事务层                    ← 未实现
  rpc/                  Unix socket JSON RPC + ACL + 审计日志             ← 未实现
  main.rs               守护进程入口与 tokio 监督循环                      ← 未实现
root/                   打包进 ipk/apk 的运行时文件（UCI 默认值、procd、nftables.d、rpcd ucode/acl、menu.d）
htdocs/                 LuCI 前端资源（view JS + css）
scripts/                构建与检查脚本（含 Lua 禁用扫描）
docs/                   要求对照 / 架构 / 配置 / 安全 / 测试 / 路线图 / 进度 / 交接
tests/                  跨层集成测试
```

## 当前状态（2026-10-26）

后端四层（config / system / health / scheduler）已实现并通过单元测试，
`cargo test --offline --lib` = **276 passed / 0 failed**。
规则层、事务层、RPC 层、守护进程入口、前端与打包尚未完成。
逐条完成度见 [docs/PROGRESS.md](docs/PROGRESS.md)，交付判据见 [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md)。

**现在这个仓库不能装到路由器上用**——守护进程入口还没实现，
`enabled` 默认关闭且数据面一次写操作都没跑过。请把本文与文档目录当作工程记录，
而不是安装说明。

## 开发环境命令

```sh
cargo test --offline --lib                           # 单元测试（沙箱内可跑，276 条）
cargo clippy --offline --all-targets -- -D warnings  # Lint：必须 0 警告
cargo fmt --all -- --check                           # 风格：必须无差异
cargo build --offline --release                      # 构建 smartmwand
./scripts/no-lua-check.sh                            # Lua 禁用扫描（三个维度）
```

本沙箱**没有** `nft` 二进制，也没有 netfilter 内核支持 —— 这限制了「数据面语法验证」与
「真机验证」两件事；`clippy` / `rustfmt` 现在可用，因此 Lint 与风格结论是可以交付的。
详见 [docs/TESTING.md](docs/TESTING.md)。

## 设计要点（读代码前先读这段）

* **fwmark 是合同**。`src/lib.rs::marks` 定义了 `0x5` 魔数 + 槽位/类别/代际/桶的位布局，
  `ip rule` 只用低 8 位掩码，因此桶图怎么变都不会让已建立连接换出口。
* **不做高频全量重建**。规则总数恒等于启用线路数；桶图变化用
  `replace rule handle`，重排受单轮预算与最小间隔约束（`scheduler::balancing`）。
* **不拼接 shell**。所有外部命令走 `system::exec` 的白名单 + 参数数组 + 超时 + 输出封顶。
* **不谎报**。`Unsupported`/`LocalError` 不计入线路失败；没有采样就说没有采样；
  没有可用线路就不分流；加权 ECMP 直接返回不支持而不是伪实现。
* **默认不改变现状**。`global.enabled = 0`，首次安装不动任何用户网络配置。

## 许可

GPL-2.0-or-later（见 [LICENSE](LICENSE)，SPDX 标识符与 Cargo.toml/Makefile 一致）。
