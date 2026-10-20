# 安全与隐私边界

源码公开不等于运行资料可公开。备份采用明确源文件白名单、新生成文档、逐文件 SHA-256/bytes 和暂存 blob 复核，而非复制生产目录或历史。

## 永不随备份提供

整个生产 data 树、.hermes、.env、凭据、Cookie、浏览器 History、DB/SQLite、真实配置、运行 logs、截图、媒体、签名原始 URL、子 agent/Codex 事件、接线采集、第三方扩展及 decodedsource、真实商品或账户资料、原业务/验收/调查文档。

原 README/.gitignore 只作结构参考，不照搬；旧 docs 全部不读不复制。示例路径及源码中的个人机器默认路径被去标识。三条 URL userinfo 测试改用显式 TEST_USER/TEST_PASSWORD 与 example.invalid，并保留原路径部分和否定断言。

测试中的 TEST 哨兵、拒绝分支 URL 和数值边界是测试资料；扫描命中必须按上下文复核，不能只看文件扩展名。若仍有未能确定的身份或业务值，停止上传，报告仅路径、行号、规则和哈希。

本地审计、原哈希、GitHub 空仓库证据及审核者记录保存在发布准备目录的 audit 中，不属于提交树。发布前必须重新复核待上传的所有 blob，并获得父授权。
