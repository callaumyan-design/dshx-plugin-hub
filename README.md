# dshx-plugin-hub 1.0.0

把 dshmarket 插件市场并进「设置 → 内置插件」：

```
设置 → 内置插件 → [ 插件市场 | 插件列表 | 市场设置 ]
```

| 标签 | 来源 | slot 条目 |
|---|---|---|
| 插件市场 | 本插件，内容是 `market.render()`（dshmarket #602 的嵌入接口） | `settings.plugins.tab` id `dshx-market-browse`，order 5 |
| 插件列表 | 宿主自带的只读清单 | id `all`，order 10 |
| 市场设置 | dshmarket 自己的设置卡片，本插件只把标签名「插件市场」改成「市场设置」 | id `dsh-market`，order 60 |

同时调用 `market.setSettingsVisible(false)`，收起 dshmarket 单独的设置分区（id `market`，order 40）。

## 做法和边界
- 纯客户端插件；`index.js` 是空的宿主半边，只为让 profile 的 `cordis.patch.yml` 有东西可挂载。
- 宿主 asar、dshmarket 的文件都不改。
- 改名的做法：直接改 `dsh-market` 那条 ledger 条目的 `options.label`，再注册并立刻注销一个占位条目，让 slot version 加一、标签行重新读取。不能用同 id 高 priority 覆盖（标签行读的是 `slots.entries()` 原始条目，会出现两个标签），也不能重复注册宿主或市场的 locale（宿主会直接抛错）。
- 改名是装饰性的：读 ledger 失败或 label 只读时只打一条警告，标签保持原名「插件市场」，其他功能照常。
- 没有 `market` 服务（dshmarket 未装或未加载）时什么都不做；dshmarket 卸载时本插件的标签跟着消失；本插件卸载时恢复市场分区和原标签名。

## 依赖的外部契约（升级后要复查）
- dshmarket 客户端服务 `market`：`version: 1`、`render(props)`、`setSettingsVisible(bool)`（1.66.35 `src/client/index.ts`）。
- dshmarket 设置卡片在 `settings.plugins.tab` 的 id 是 `dsh-market`（= 它的 NS）。
- 宿主 `dsh-client-ui-settings-plugins`（rc.5）：标签行按 `getVersion` + locale `revision` 缓存，`resolveSlotLabel(entry.options.label)` 取名；SlotCore 的 `options` 是普通可写对象。

## 测试
```
node test.mjs     # 15 项
```
用 `test-fixtures/settings-plugins.rc5.client.js`（运行中的 rc.5 分发的真实标签容器）配上按 rc.5 SlotCore 语义复刻的 ledger 跑。宿主升级后，把新版的这个 bundle 抓下来替换 fixture 再跑一次。

运行态界面冒烟（DSH 运行中，端口每次启动都变）：
```
node ui-smoke.mjs http://127.0.0.1:<端口> [截图目录]
```
无头 Chrome（playwright-core 借用 dsh-project-spaces 的 `tests/browser-tooling`），脚本内自签 browser-session cookie、不打印。打开 设置 → 内置插件，输出导航项、标签名、页面报错。2026-10-31 在 rc.5 + dshmarket 1.66.35 上的结果：导航里没有单独的「插件市场」；标签为 插件市场 | 插件列表 | 市场设置；默认选中插件市场；0 个页面报错。截图在 `verification/`。
