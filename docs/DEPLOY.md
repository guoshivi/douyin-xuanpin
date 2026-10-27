# 部署手册（另一台电脑）

本仓库是**源码 + 设置面板**的部署包，不含登录状态、真实配置、数据库、素材或运行证据。
按本文件可在另一台 Mac 上把面板跑起来；真实选品跑批还需要额外的浏览器与账号环境，见第 4 节。

> 状态口径：源码同步自开发机当前正式版（2026-10-27）。它**不是独立验收通过的发布版**；
> `wip/*` 分支上的下载链改造属于未验收候选，**不要用于部署**。

## 1. 环境要求

| 组件 | 要求 | 说明 |
|---|---|---|
| macOS | 13+ | 目录选择器用 osascript；其他系统不保证 |
| Node.js | >= 22.5 | 需要内置 `node:sqlite`；Node 22 需加 `--experimental-sqlite`，Node 24+ 可直接用 |
| Git | 任意近期版本 | 仅拉代码用 |
| ego 浏览器（ego lite） | 仅真实跑批需要 | 面板启动不需要 |
| ffmpeg / ffprobe | 仅媒体核验需要 | 面板启动不需要 |
| lark-cli | 仅飞书同步需要 | `--core-only` 模式完全不需要 |

零 npm 依赖：不需要 `npm install`。

## 2. 拉取与自检

```sh
git clone https://github.com/guoshivi/douyin-xuanpin.git
cd douyin-xuanpin
node --version
node --check src/cli.mjs
```

Node 22 用户请确认 SQLite 可用（不报错即通过）：

```sh
node --experimental-sqlite -e "import('node:sqlite').then(()=>console.log('sqlite ok'))"
```

## 3. 建立本机配置

```sh
cp config/selection.example.json config/selection.json
```

编辑 `config/selection.json`，至少改这一项为本机真实可写目录：

```json
"storage": { "video_root": "/Users/<你的用户名>/Movies/选品视频" }
```

- `config/site-map.local.json` 已随仓库提供（平台类目表），面板的「类目范围」依赖它，缺失会显示「类目选项未加载」。
- **不要把 `config/selection.json` 提交回 Git**；它是本机配置。
- 面板保存配置只影响新任务，不会自动开始跑批。

## 4. 启动设置面板

```sh
node src/cli.mjs settings --no-open --core-only
```

需要手机/局域网访问时（把 IP 换成本机当前地址）：

```sh
node src/cli.mjs settings --core-only --lan --lan-address 192.168.1.10 --port 56115 --no-open
```

看到 `SETTINGS_READY http://127.0.0.1:56115/` 即启动成功，浏览器打开该地址。
`--core-only` = 飞书同步全禁；局域网模式仅信任私有网段，没有账号登录，不要暴露到公网。

本机 IP 查询：

```sh
ipconfig getifaddr en0
```

## 5. 真实跑批的额外前提（面板不需要）

选品跑批通过 `ego-browser` 驱动浏览器，必须另外准备：

1. 安装 ego lite，确认 CLI 在 PATH：`command -v ego-browser`。
2. 在 ego 默认 profile 登录你的达人账号（选品广场 / 选品车）。
3. 安装灵剪AI 类下载扩展（提供下载2 / 下载1 按钮）；扩展不在本仓库内，需自行安装。
4. 罗盘 `compass.jinritemai.com` 需要商家角色会话；掉登录会在跑批中报 `BROWSER_BLOCKED`。
5. 媒体核验需要 `ffmpeg` / `ffprobe`；`lark-cli` 只在非 core-only 模式需要。

跑批入口在面板内，不在命令行；命令行只负责启动面板。

## 6. 可数验收清单

- [ ] `node --version` >= 22，SQLite 探测输出 ok
- [ ] 面板启动输出含 `SETTINGS_READY`
- [ ] 浏览器打开面板，标题为「选品工作台 · 设置与任务」
- [ ] `/api/tasks` 返回 200 且 `tasks` 为数组
- [ ] 保存一次配置后刷新，字段保持不变
- [ ] 未启动任何真实跑批（部署验收不等于业务验收）

六项全过才算「部署可用」；真实跑批另做小批验证。

## 7. 已知限制（必须知道）

1. **下载回退链未通过最终验收**：候选在「最终核对后、身份校验期间下载状态变化」时可能误报成功或误跳过，因此候选未合入本包。真实跑批请按小批观察，不要无人值守跑大单。
2. 整套流程依赖 ego 浏览器、扩展和登录态；换机后首次跑批失败，优先查登录 / 扩展 / 罗盘角色，而不是改配置。
3. NAS/共享盘路径需本机已挂载且可写；路径不存在时任务会在启动阶段失败。
4. 面板局域网模式无鉴权，仅限可信内网。
5. 旧业务文档与验收证据不在仓库内，不能据此推断历史批次结论。

## 8. 目录

- `src/`：后端与自动化源码（37 个模块）
- `ui/`：设置面板前端（5 个文件）
- `tests/`：41 个测试与 fake Ego；缺媒体夹具的用例会失败，属预期
- `config/selection.example.json`：配置模板
- `config/site-map.local.json`：平台类目表
- `docs/`：架构、AI 交接、安全与状态文档

## 9. 回滚

本包不修改系统环境；停止面板即 Ctrl+C。配置与数据库都在本机 `config/`、`data/`（首次运行创建），
删除该目录即回到全新状态——**删除前先备份 `config/selection.json` 与 `data/state.sqlite`**。
