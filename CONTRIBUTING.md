# 参与开发

## 环境

- **Node.js 20+**（开发和桌面端运行都用它），零第三方依赖，不需要 `npm install`
- 安卓端需要：JDK 17、Android SDK（`android-35` + `build-tools 35.0.0`）、Gradle 8.9
  （`android/tools/fetch-gradle.ps1` 会从国内镜像拉，`android/tools/install-sdk.ps1` 装 SDK）

## 常用命令

```bash
npm start                      # 启动桌面端（默认 http://127.0.0.1:47800）
npm test                       # 全量测试：单测 + 端到端 + 对端协议（72 项）
node --test test/diff.test.mjs # 只跑差异引擎
node scripts/ui-smoke.mjs      # 真实浏览器冒烟（需要本机 Chrome，会截图到 docs/screenshots）

cd android && gradlew.bat testDebugUnitTest   # 安卓逻辑单测（30 项，JVM 上跑）
cd android && gradlew.bat assembleDebug       # 出 APK
powershell -ExecutionPolicy Bypass -File packaging/build-app.ps1   # 出便携版应用（dist/）
```

## 代码在哪

| 目录 | 内容 |
| --- | --- |
| `server.js` | HTTP 路由、任务编排、SSE、自动同步调度 |
| `lib/` | 配置存储、差异执行、传输、对端调用、zip、解包、路径安全 |
| `shared/` | 前后端共用的纯逻辑（差异引擎、纯 JS SHA-256），**不含 I/O** |
| `public/` | 桌面端界面（原生 ES 模块，无框架） |
| `android/` | 安卓 App（Kotlin，无 AndroidX） |
| `test/` | Node 原生测试（`node:test`） |
| `docs/` | 协议说明与界面截图 |

## 改代码时的几条约定

1. **零第三方运行时依赖**：桌面端只用 Node 内置模块，安卓端不引入 AndroidX。加依赖前请先开 issue 讨论。
2. **差异规则只有一份**：`shared/diff.js` 与 `android/.../Diff.kt` 必须保持一致，
   改判定逻辑时两边一起改，并同步补测试（两边的测试用例名是对应的）。
3. **删除必须走闸门**：任何删除动作都要经过 `allowDeletes` 开关和二次确认，不要新增"顺手删掉"的路径。
4. **写文件先落 `.part` 再校验再改名**，不要直接覆盖目标文件。
5. **界面文案说"同步到远端/本地"，不说"上传/下载"**：前者是"以哪边为准把两边同步成一样"，后者是单纯搬运，
   两者在语义上不同（"下载"专指「远端文件」里的自由下载）。
6. 提交前请确保 `npm test` 全绿。

## 提交信息

用一句话说清"改了什么、为什么"，中英文都行：

```
修复：手机端对端服务把请求体读了两次，导致电脑端对比挂起
新增：远端文件卡片，可单独下载对端文件而不参与同步
```
