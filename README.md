# Snack Meet

Snack Meet 是独立维护的、本地优先的 macOS 会议工作台：自动感知会议应用的麦克风占用，录制麦克风与系统声音，生成转写、总结、智能标题和关键词，并允许按会议决定是否保留原始音频。

## 独立发布原则

- 唯一代码仓库：`https://github.com/noahchen93/snack-meet`
- 不拉取、不检查、不安装 Meetily 或 Snack Record 的上游更新。
- 自动更新暂时关闭；版本只从 Snack Meet 自己的 Releases 页面发布。
- 每次安装替换完整 `Snack Meet.app`，不会向旧 App 注入单个二进制。
- macOS bundle identifier 暂时保留 `com.meetily.ai`，仅用于迁移既有数据和 TCC 权限；它不代表任何上游关系。

## 技术结构

```text
meetily/frontend/
├── src/                 Next.js / React UI
└── src-tauri/           Rust、录音、检测、数据库与模型运行时

build.sh                 构建完整 Snack Meet.app
install.sh               校验、签名并原子替换 /Applications/Snack Meet.app
```

`meetily/` 是迁移期间保留的源码目录名。实际 Cargo 包、产品名和版本体系均已独立为 Snack Meet。

## 构建与安装

需要完整 Xcode、Rust、Node.js、pnpm，以及受信任的本地 ffmpeg。构建过程不会从原上游下载可执行文件。

```bash
zsh build.sh
zsh install.sh
```

安装器只保留 `/Applications/Snack Meet.app`，发现旧 `Meetily.app` 或 `Snack Record.app` 时会将其移到废纸篓。旧版本在清空废纸篓前仍可恢复。

## 质量门禁

根目录 `.github/workflows/ci.yml` 会在提交和 PR 上运行：

- TypeScript 类型检查
- ESLint
- Next.js 生产构建
- Rust 格式检查、Clippy 和单元测试

## 许可证与来源

Snack Meet 以 MIT License 发布。项目演进过程中采用过 MIT 许可的 Meetily 和 Snack Record 代码；法定署名与许可证全文见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。这些署名不构成运行时依赖或更新关系。
