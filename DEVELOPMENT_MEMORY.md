# Snack Meet 开发记忆

> 记录 Snack Meet 的开发进度、架构决策、关键实现与踩坑记录。
> 最新开发在顶部，随时间累积。本文件是给后续开发者的"项目大脑"。

---

## 项目定位

Snack Meet = **meetily**（Rust + Tauri + Next.js 主应用）+ 从 **Snack Record**（Objective-C）移植的会议窗口自动检测逻辑，融合成的**单应用** macOS 菜单栏录音转写工具。

- 自动检测会议/语音通话 → 提示录音 → 系统+麦克风录音 → 转写 → 总结 → 智能命名
- bundle id 保持 `com.meetily.ai`（保留既有数据/TCC/授权），应用显示名为 "Snack Meet"
- 仓库根：`/Users/SDQ/Documents/snack-meet`（独立 git，remote 为 noahchen93/snack-meet）
- 内部 `meetily/.git` 是遗留的 vendored clone（上游 Zackriya-Solutions/meetily），**不要在里面提交**，一切以根仓库为准

## 构建 / 部署

- `zsh build.sh` → `pnpm tauri build --no-bundle`（内嵌前端 `_next`）→ 二进制落在 `meetily/target/release/meetily`（workspace 根 target，**不是** src-tauri/target）
- `zsh install.sh` → 换入 `/Applications/Snack Meet.app`
- 环境变量（手动构建时）：
  - `export PATH="$HOME/.local/lib/node-v24.18.0-darwin-arm64/bin:$PATH"`（pnpm）
  - `export DEVELOPER_DIR="/Applications/Xcode-beta.app/Contents/Developer"`（cidre 需要 Apple 框架绑定）
  - `export SNACK_MEET_SIGNING_IDENTITY=-`（ad-hoc 签名，避免 TCC 重置）
- **提速**：只改前端跑 `pnpm build`（1-2min）；只改少量 Rust 增量编译也快（target 有 ~7.8G 缓存）；别删 `target/`（否则回到 10-14min 全量）

## 当前功能状态（已完成）

### 1. 说话人分离（diarization）
- `meeting_detector`/`audio/transcription/diarization.rs`：`ChannelEnergyEstimator` 通过对比混音前 mic/system 双通道能量，把每个 VAD 语音段归为 local / remote / unknown
- **时间平滑**：能量不确定的段若紧跟确认说话人（<1.5s）则继承该说话人
- **最低能量阈值**：近静音不误判为 Remote，不污染状态
- `reset()`：每会话干净重置
- 实时转录 + **历史记录都带 speaker**（修复了 models.rs/api.rs/meeting.rs/usePaginatedTranscripts 链路，speaker 已入库并回读）
- 前端 TranscriptView / VirtualizedTranscriptView 显示"你/对方"徽章

### 2. 自动检测会议 / 语音通话
`meeting_detector.rs`：
- 监控应用：腾讯会议、Zoom、飞书、企业微信、浏览器(Chrome/Safari/Edge/Firefox)、微信语音、WhatsApp 语音
- **近即时触发**：poll 间隔 0.8s；任意监控应用检测到窗口/占用麦克风即弹询问窗（不等音频确认）
- **静音也能录**：会议应用占用麦克风即信号（即使无声）
- **麦克风检测不依赖屏幕录制权限**（`ca::Process::list()` 枚举 Core Audio 进程）；无权限时跳过窗口枚举（避免反复弹权限窗），仅麦克风检测
- 微信/WhatsApp 语音**保留持续占用门槛**（~5s，过滤按住说话语音消息误触发）
- **始终弹确认窗口**，同意才录制（microphone 触发也询问）
- 前端 `MeetingDetectorProvider.tsx` 监听 `meeting-detected` / `meeting-ended`，驱动 start/stop/save

### 3. 智能重命名（中文标题）
- `copilot_smart_rename_meeting`（copilot.rs）：保存后立即后台生成标题（独立于总结流程，总结失败也能重命名）
- **强制中文**标题（3-12 字），复用 copilot 云端/LLM 配置
- 更新 DB 会议名 + 重命名录音文件夹（`SummaryService::rename_meeting_folder` 已 pub(crate)）
- `extract_title_from_output`：从本地内置模型的"思考过程 + 候选标题"中提取最终标题（有单元测试）
- 已在真实会议验证：121 段转写 → "交通执法展台位置与布局调整方案讨论"

### 4. AI 会议副驾（实验功能）
- 悬浮窗 `ai-copilot`：边录音边基于转写自动提醒（~45s）+ 手动随时提问
- 提供背景资料（`copilot_context.md`）+ 云端模型配置（`copilot_cloud.json`：OpenAI 兼容 endpoint/model/key）
- LLM 路由：云端配置优先，否则回退到总结 LLM 配置
- 入口：tray 菜单"🧠 AI Copilot"、设置页 Copilot tab、录音悬浮窗 Bot 按钮
- 关键文件：`copilot.rs`、`ai-copilot/page.tsx`、`CopilotSettings.tsx`

### 5. 录音悬浮窗
- `recording-overlay` 透明置顶窗口，含：Bot(AI副驾) → 暂停 → 停止 → 展开 按钮
- **可拖拽**（需 `core:window:allow-start-dragging` 权限）

### 6. 首页仪表盘
- 空闲时显示最近会议记录卡片网格（标题+相对日期，点击进详情），录音时切回转写面板
- `api_get_meetings` 增加返回 `createdAt`

## 关键踩坑 / 架构决策

### 拖拽失效
- **根因**：Tauri 2 的 `core:window:default` 不包含 `start-dragging` 权限
- **解法**：`tauri.conf.json` capabilities 显式加 `core:window:allow-start-dragging`

### 反复弹屏幕录制权限窗
- **根因**：无权限时 poll 循环每 0.8s 调 `SCShareableContent` 枚举窗口 → macOS 反复弹授权窗
- **解法**：`poll_once` 开头 `preflight_screen_capture()`，无权限跳过窗口枚举，只做麦克风检测

### 检测器不启动
- **根因**：`start_detector` 强制要求屏幕录制权限，无权限直接 return，导致整个检测器停摆
- **解法**：去掉强制门槛，允许麦克风检测（不需要权限）先跑起来

### 检测慢
- **根因**：poll 2s + 需等音频确认(1s) 或静音回退(4×2s=8s) 才弹窗
- **解法**：poll 降 0.8s + 监控应用窗口/麦克风即触发 + 始终弹窗询问

### 内置模型输出思考过程
- qwen3.5:4b 等本地 GGUF 会输出 "thinking" 前缀 + 候选标题，不是干净标题
- `extract_title_from_output` 处理：跳过 thinking/drafting，取最后候选，剥引号/编号/标题前缀

### 说话人分离历史记录丢失
- speaker 已入库但读取链路缺字段 → 补 models.rs、api.rs、meeting.rs、usePaginatedTranscripts

## 文件地图（关键）

```
snack-meet/
├── meetily/frontend/src-tauri/src/
│   ├── meeting_detector.rs          # 会议/语音检测状态机（poll、触发、权限）
│   ├── copilot.rs                   # AI 副驾 + 智能重命名命令 + LLM 路由
│   ├── audio/transcription/diarization.rs  # 说话人分离
│   ├── summary/service.rs           # 总结 + rename_meeting_folder(pub(crate))
│   ├── external_trigger.rs          # auto_summarize
│   └── lib.rs                       # 命令注册
├── meetily/frontend/src/
│   ├── app/recording-overlay/page.tsx   # 录音悬浮窗
│   ├── app/ai-copilot/page.tsx          # AI 副驾悬浮窗
│   ├── app/page.tsx                     # 首页
│   ├── components/HomeDashboard.tsx     # 首页仪表盘
│   ├── components/CopilotSettings.tsx   # 设置-Copilot
│   ├── contexts/MeetingDetectorProvider.tsx
│   ├── hooks/useRecordingStop.ts        # 保存后触发智能重命名
│   └── lib/smartMeetingName.ts
├── meetily/frontend/src-tauri/tauri.conf.json  # 窗口 + capabilities 权限
├── build.sh / install.sh
└── README.md
```

## 待办 / 下一步

- [ ] 真实会议全流程验证（检测→录音→转写→总结→中文重命名）
- [ ] 微信/WhatsApp 语音通话实测（需真实通话）
- [ ] AI 副驾自动提醒的触发频率/质量调优
- [ ] 悬浮窗 AI 副驾按钮与 copilot 窗口联调确认
- [ ] 可选：双通道录音保存原始 mic/system 分离音轨，做离线精确说话人分离

### 7. 导出为 Markdown（新增）
- `useExportMeeting.ts`：把会议转写 + 总结导出为 .md 文件
- 用原生保存对话框（`@tauri-apps/plugin-dialog` 的 `save()`）选路径，再调后端 `save_transcript` 命令（std::fs 写入，无需 fs scope）
- 复用 `useCopyOperations` 的转写/总结 markdown 构建逻辑
- 入口：会议详情页 SummaryPanel 的 SummaryUpdaterButtonGroup 新增 "Export" 按钮
- 需在 `tauri.conf.json` capabilities 加 `dialog:allow-save` 权限

### 8. 行动项清单面板（新增）
- `ActionItemsPanel.tsx`：从 AI 总结中提取行动项，生成可勾选的待办清单
- 提取逻辑：优先找 key/title 含 action/待办/行动项/todo 的 section；无则回退扫描所有 blocks 中动词开头的行
- 勾选状态用 localStorage 按 meetingId 持久化（`snackmeet_action_items_<id>`）
- 支持勾选/取消、删除单项、清空全部
- 入口：会议详情页 SummaryPanel 的 BlockNoteSummaryView 上方

### 9. 默认转录模型切换：Parakeet → Local Whisper（中文支持）
- **问题**：默认 Parakeet 模型（parakeet-tdt-0.6b-v3-int8）是英文优化，不识别中文，把中文会议转成英文
- **方案**：默认 provider 从 parakeet 改为 localWhisper，默认模型改为 medium-q5_0（已下载、中英文好、量化后快）
- **改动文件**：
  - 前端：`ConfigContext.tsx`、`Sidebar/index.tsx`、`app/settings/page.tsx`、`constants/modelDefaults.ts`（DEFAULT_WHISPER_MODEL 改 medium-q5_0）、`TranscriptSettings.tsx`（Local Whisper 标为 Recommended）
  - Rust：`config.rs`（DEFAULT_WHISPER_MODEL 改 medium-q5_0）、`database/commands.rs`、`api/api.rs`、`onboarding.rs`（默认 provider 改 localWhisper）
- **已删除**：`~/Library/Application Support/com.meetily.ai/models/parakeet/`（640MB）
- **数据库**：手动 UPDATE transcript_settings SET provider='localWhisper', model='medium-q5_0'（已初始化过的库不走 fresh 路径）
- **用户可在设置 → Transcription 自由切换** provider 和模型（Local Whisper / Parakeet）
- 注意：`***` 是工具显示脱敏，实际文件里是 `null` 或 `config.apiKey`，别误改
