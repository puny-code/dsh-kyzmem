# 卸载卡死与「插件损坏」的成因

如果你在面板里点卸载，界面一直显示「卸载中」，最后被看门狗杀掉，再打开时插件已经是一副
残缺状态——这份文档解释它为什么发生、怎么修，以及 0.14.0 起怎么把它绕开。

## 症状

- 卸载/升级插件时长时间卡住，日志里 `pnpm remove` 超时或被中止。
- 之后 `~/.dsh/profiles/<profile>/node_modules/onnxruntime-node/` 只剩 `onnxruntime.dll`
  和 `onnxruntime_binding.node` 两个文件，目录删不掉。
- 插件目录还在，但 panel 打不开或行为异常（「插件损坏」）。

## 原因

0.13.0 及更早的版本把 `@huggingface/transformers` 写在 `dependencies` 里，它依赖
`onnxruntime-node`。插件加载时如果启用了本地嵌入，宿主进程会加载：

```
%USERPROFILE%\.dsh\profiles\<profile>\node_modules\onnxruntime-node\bin\napi-v6\win32\x64\onnxruntime.dll
```

Windows 在 DLL 被映射进进程期间**拒绝删除该文件**；Node 又不会卸载已经加载的原生模块。
于是只要 DSH 还在运行：

1. pnpm 删到 `onnxruntime-node` 时失败；
2. DSH 的卸载流程等不到成功，超时后被看门狗杀掉；
3. 已经删掉的部分不会回滚，留下一个半删目录。

这不是插件逻辑写错，也不只是这个插件的毛病——上游 dsh-engram 用同一份依赖和同一段
eager 初始化，只是当时没有在插件运行期间卸载过它。

## 正确顺序

**卸载、升级、重装插件之前，先完全退出 DSH。**

- Windows 托盘里的 `DeepSeek Harness` 要退出；
- 任务管理器确认没有残留的 `DeepSeek Harness.exe`；
- 然后再执行 `dsh plugin remove` / `add`，或直接重新安装。

宿主进程退出后文件锁释放，删除就不会失败。

## 修已经坏掉的 profile

以下命令先退出 DSH，再在 PowerShell 里跑（`desktop` 按你的 profile 名替换）：

```powershell
$profileDir = "$env:USERPROFILE\.dsh\profiles\desktop"

# 1) 清掉被锁住的 native 目录和 pnpm 里的残留
Remove-Item -Recurse -Force "$profileDir\node_modules\onnxruntime-node" -ErrorAction SilentlyContinue
Get-ChildItem "$profileDir\node_modules\.pnpm" -Directory -Filter '*onnx*' -ErrorAction SilentlyContinue |
  Remove-Item -Recurse -Force

# 2) 重新安装插件（profile 的 package.json 里还留着依赖声明，add 会把它补全）
dsh plugin --profile desktop add <插件 tgz 路径或 https 直链>
```

如果 pnpm 仍报「模块已存在/目录非空」，把插件目录 `node_modules\dsh-kyzmem` 也删掉再装。
实在清不干净时，删掉整个 `node_modules` 后重新 `dsh plugin add` 也可，但会重装该 profile 的
所有插件。

## 0.14.0 起：模型跑在子进程里

- `@huggingface/transformers` 回到 `dependencies`——默认安装就有语义检索，效果不打折。
- 但模型只在 `scripts/embedder-worker.mjs` 子进程里加载，宿主进程**从不** `dlopen`
  `onnxruntime.dll`，所以锁只存在于子进程。
- 卸载/热重载时插件 dispose 会先结束子进程（cordis 会等待），DLL 句柄随进程退出释放，
  pnpm 随后能正常删除文件——不再需要「先退出 DSH 才能卸载」。
- 宿主被强杀时 stdio 管道断开，子进程自行退出，不会留下持锁的孤儿进程。
- 代价：多一个常驻子进程（模型常驻内存），首次使用仍要下载模型权重。

如果仍然遇到删不掉的 `onnxruntime.dll`，那说明有别的进程加载过它（例如旧版本残留的
DSH 实例）。先确认任务管理器里没有旧的 `DeepSeek Harness.exe`，再按上面的修复步骤处理。

## 安装命令

`onnxruntime-node` 带构建脚本，pnpm 11 默认拦截，安装时仍要显式放行：

```bash
dsh plugin --profile desktop add <tgz 直链> --allow-build=onnxruntime-node --allow-build=protobufjs
```

不带参数时文件其实也装上了，但 pnpm 以非零码退出，插件管理器会提示安装失败，之后容易
出现「以为没装上又装一遍」的混乱。
