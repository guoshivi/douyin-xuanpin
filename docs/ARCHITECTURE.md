# 通用架构与数据流

## 模块职责

| 模块组 | 文件 | 职责 |
|---|---|---|
| 入口和设置 | cli、settings-server、settings-model、storage-settings、lan-access | 入口参数、配置草稿、设置接口、目录格式与本机网络边界 |
| 规则 | metrics、policy、priorities | 原始指标解析、规则判断、透明排序 |
| 任务 | task-manager、pipeline | 生命周期、步骤协调、暂停与恢复状态 |
| 持久化 | ledger、store、storage、private-checkpoint | SQLite、资产记录、存储核验及本地证据 |
| 浏览器 | browser/actions、extract、selection-round、selection-protocol、protocol、round | 生产适配器、页面数据解析、子进程协议与回执 |
| 工具及隔离 | command、verifier、safety、public-safety、product-links、media | 有界工具执行、结构校验、可公开视图与媒体核验 |
| 可选同步 | feishu/sync | 用户态外部表格适配器，身份与目标配置在本地 |
| UI | settings.html/css/mjs、display、form-lock | 设置表单、显示格式与异步交互锁 |

## 数据流

设置草稿 → schema 校验与配置 revision → 冻结任务参数 → 浏览器适配器 → 候选规则 → 外部动作读取确认 → 本地资产核验 → 可选外部同步 → 公共任务视图。

上述描述只说明设计，不代表真实站点集成已通过。业务执行可能产生外部写入，必须另行授权。

## 配置契约

`config/selection.example.json` 使用 schema_version=2；各字段在 settings-model.mjs 中进行校验。

- business_modes/categories：模式和类目范围；示例不含真实类目或账户。
- priorities：季节与近期趋势偏好；日期、统计窗口和基线必须明确。
- focus_metrics/rules/decisions：指标、比较规则和价格/销量/转化口径；未确定口径不能冒充已确认事实。
- limits/video_scope：执行上限和视频范围；不是吞吐或成功率承诺。
- feishu：可选同步行为，不提供任何 app/base/table 或用户凭据。
- storage.video_root：经批准的本地绝对目录；示例仅为 EXAMPLE 占位符。

公共视图不是证据全集。身份、私有回执及数据库均只保存在部署方运行目录，不进入 Git。
