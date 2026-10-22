# 卸载卡死与「插件损坏」的成因

如果你在面板里点卸载，界面一直显示「卸载中」，最后被看门狗杀掉，再打开时插件已经是一副
残缺状态——这份文档解释它为什么发生、怎么修，以及 0.13.1 起改了什么。

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

## 0.13.1 起的变化

- `@huggingface/transformers` 从 `dependencies` 改为**可选 peerDependencies**。默认安装的
  插件**不带** onnxruntime，宿主进程不会再加载那个 DLL，卸载/升级不再被文件锁卡住。
- 本地语义向量因此变成需要手动开启的能力：想在 profile 里启用时，退出 DSH 后在该 profile
  目录执行 `pnpm add @huggingface/transformers`，再启动。
- `createLocalEmbedder()` 先做一次只解析、不加载的探测；模块不在就直接返回 `undefined`，
  检索自动降级为关键词，不会报错，也不会拖慢启动。
- **启用了可选嵌入之后，卸载/升级前同样必须先完全退出 DSH**——文件锁是 Windows 的行为，
  插件这边只能用「默认不加载」来规避。

## 安装命令

默认安装不需要 native 构建许可参数：

```bash
dsh plugin --profile desktop add <tgz 直链>
```

（旧文档里的 `--allow-build=onnxruntime-node --allow-build=protobufjs` 现在不再必要；
只有在你自己装可选嵌入、需要现场编译时才会用到。）
