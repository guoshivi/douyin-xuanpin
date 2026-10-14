# W20 fix3 独立候选

**未完成、未部署、不可发布。** 整体验收仍 BLOCKED；本地保存不表示修复通过。main 保存生产 Wave19/UIv8 来源快照，候选不得覆盖主分支或原生产源码。

## 明确候选范围

五个源码文件：
- src/browser/actions.mjs
- src/browser/selection-round.mjs
- src/browser/selection-protocol.mjs
- src/browser/extension-download.mjs（相对 main 新增）
- src/pipeline.mjs

一份候选测试：tests/wave20-fix3-unavailable.test.mjs。

此外仅 README 和此 WIP 文档标识候选状态；其他文件继承 main。

## 验收边界

此次仅静态语法和隐私审计，不运行新候选测试，不做真实浏览器、下载、加车、NAS、飞书或部署。原候选局部自报绿不是父独立验收。尚未证明完整流程可用；不复制原始接线证据、业务日志或媒体来补验收。

原候选来源和逐文件 SHA-256 保存在本地审核 manifest，不随此分支上传。发布任何 blob 前仍须父独立隐私审核和同仓库新的明确授权。无合并、无 push、无生产改动。

## 额外隐私去标识

extension-download.mjs 的观察到的本机安装标识仅在此副本中换为 32 位重复字母占位符，相关注释不再声称具备已验证能力；原候选不改。这不是原候选的部署绑定，不能直接用于运行。selection-protocol.mjs 与 main 的生产原始文件字节相同，虽在候选来源白名单中，Git 不产生该文件差异。
