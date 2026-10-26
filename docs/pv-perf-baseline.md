# PV 绘制性能基线（preset 13 / JIZURA 引擎）

更新日期：2026-10-26
测量工具：`scripts/pv-draw-bench.js`（离线、只读、不改动产品代码路径）
护栏：`tests/pv-draw-bench-guard.test.js`（knob 仍存在于 vendor 引擎）、
`tests/pv-draw-tier.test.js`（档位选项与自动档状态机）与
`tests/pv-planner-idle-release.test.js`（规划窗口的空闲释放，步骤 #10），三者都已接入 `scripts/quick-check.js`

## 1. 这份基线回答的第一个问题：瓶颈在"制定"还是"播放"

**在播放。** 制定（planning）不在播放帧里，也不可能挤占播放帧：

- 制定跑在一个独立的隐藏 renderer 进程（`pv-planner.js`，`createPvPlanner`，串行队列、8 秒超时），
  引擎以文本注入，返回值是 JSON 字符串。渲染主进程根本不与它共享一帧的时间片。
  这个窗口现在归 `pv-planner-pool.js` 管，应用安静下来时会被回收（§6）。
- 实测 `J.plan` 引擎内部耗时 81.9 / 60.0 ms，首次调用墙钟 267 ms（含建窗口 + 求值 2.1 MB 引擎），
  窗口复用时 65 ms。产物 plan JSON 约 342 KB。
- 渲染侧拿到 plan 之后的成本可以忽略：`JSON.parse` 0.98–1.07 ms，`repairPlanTails` 0.23–0.4 ms。

播放侧才是每帧都要付的钱：`public/js/modules/02-visual/17-pv-preset.js:243` 每个 koma 同步调用一次
`renderer.frame(ctx, plan, t, { scale })`，调用期间主线程被完全占住。

## 2. 复现命令

```bash
node_modules/electron/dist/electron.exe scripts/pv-draw-bench.js --markdown
```

输出同时落到 `%TEMP%\mineradio-pv-draw-bench\result.md`。常用参数：

- `--plan=<archive.json>` 钉住一份档案，两次运行才可比；缺省时按体积挑最大的档案（就是下表这份）
- `--sizes=1920x1080 --dprs=1.5` 只跑一个视野盒；盒子里的像素由 contain 适配算出，表头会写明实际画布
- `--phases=full,fast,fastNoTrans` 只跑关心的选项
- `--samples=120`（默认）沿整首曲子均匀取样，`--limit=3` 跑体积前三大档案

`--cache` 或环境变量 `MINERADIO_PV_CACHE_DIR` 指定档案目录；找不到时以 `PV_BENCH_NO_CACHE` 具名失败，
不会给出一张空表。

**这台机器的绝对值不能当结论**（`docs/LOW_SPEC_OPTIMIZATION_DOCTRINE.md` 性能验收一节）：下表只用于
"同一场景改动前后对比"。跨机只比相对节省，不比毫秒。

## 3. 基线数据

场景：`东方セレブ ~ABUNAI SISTERS~`（网易云 749160，日文 + 译文，yrc 逐词），
312 镜头（其中 156 个带转场）/ 100 行歌词 / 708 事件 / 329.31 秒 / 设计 1440×1080，
引擎 `jizura 0.10.1`（fingerprint `096195a0fe8dbfb6`），schema `mineradio-pv-v2`。

### 3.50 Mpx（1920×1080 视野 @ dpr 1.5 → 画布 2160×1620，最接近 2K 全屏）

| 选项 | 关掉了什么 | 均值 ms | p50 | p95 | p99 | max | >16.7ms | 转场帧均值 | 普通帧均值 | 相对 full |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| cold | 全新 renderer（字形缓存空） | 16.34 | 9.8 | 64.7 | 90.5 | 146.3 | 27/120 | — | — | — |
| full | 无（现状） | 7.44 | 6.2 | 16.6 | 27.5 | 38.4 | 5/120 | 11.74 | 6.31 | — |
| fast | 逐字形模糊 + 相机滤镜 + 辉光/泛光 | 3.95 | 2.0 | 14.5 | 23.0 | 28.4 | 3/120 | 10.74 | 2.16 | 47% |
| noGhost | 两条色差错影通道 | 5.97 | 4.6 | 16.3 | 21.8 | 23.7 | 4/120 | 10.93 | 4.67 | 20% |
| noPost | 整条后处理链（glitch、扫描线、颗粒、暗角） | 4.24 | 1.8 | 14.2 | 23.4 | 28.2 | 3/120 | 11.53 | 2.33 | 43% |
| noTrans | 镜头切换的上镜头合成 | 6.09 | 5.1 | 12.6 | 20.9 | 40.1 | 2/120 | 5.80 | 6.16 | 18% |
| fastNoTrans | fast + noTrans | 1.82 | 1.1 | 6.2 | 10.2 | 23.0 | 1/120 | 1.93 | 1.79 | 76% |
| cheap | fast + noGhost + noTrans | 0.62 | 0.4 | 2.0 | 2.6 | 3.5 | 0/120 | 0.64 | 0.61 | 92% |
| warm | 预热用的矮画布（17-pv-preset 现状） | 1.37 | 0.3 | 9.2 | 12.2 | 14.5 | 0/120 | — | — | 82% |
| bleed | 黑边补色（drawImage 降采样） | 0.00 | 0 | 0 | 0.1 | 0.1 | 0/120 | — | — | 100% |

其余盒子同一份方案的 `full` 均值：960×720 → 5.73，1440×1080（两种盒型都算出这个画布）→ 7.28 / 6.88。

## 4. 怎么读这张表

- **超预算的不是均值，是尾部。** `full` 均值 7.44 ms 看着能过，但一帧 16.7 ms 的预算下 p95 已到 16.6、
  max 38.4，120 帧里 5 帧直接超；每 83.3 ms 才要求交付一个 koma（`PV_TARGET_FPS = 12`），所以观感上
  表现为"偶尔一顿"，而不是 CPU 占用高。优化目标是把尾部压平，不是把均值再降一半。
- **转场帧约是普通帧的 1.9 倍**（11.74 vs 6.31）。这份方案 312 镜头里 156 个带转场，转场时引擎会
  递归再跑一遍上一镜头。
- **画布面积不是主成本。** 0.69 Mpx 与 3.50 Mpx 的 `full` 均值只差 5.73 → 7.44（像素 5 倍），
  说明大头在按字形/按事件的工作，不在填充率。所以"按画布面积决定档位"这个前提需要修正：面积只能
  当次要因子，档位触发必须看实测帧耗时。
- **单个开关里 `fast` 最值钱（47%），`noGhost` 最差（20%）。** 但组合远超相加：
  `fast`+`noGhost`+`noTrans` = 0.62 ms（92%），比任何单项都快一个数量级。这个超线性值得怀疑是否
  命中了引擎的某条 early-out，**必须先在真实画面上肉眼确认降级幅度，再决定是否用作档位**（原则的
  第二边界：前台可见播放观感不能肉眼变差）。
- **首曲冷启动是另一种卡顿。** 字形缓存为空时均值 16.34、max 146.3、27/120 超帧，
  对应"第一句歌词出来时明显卡一下"。`pvWarmNextKoma` 现在只花 1.37 ms/步，方向是对的。
- **`bleed`（黑边补色）实测免费**，不用为它做任何优化。

## 5. 档位设计与自动档（步骤 #8 / #9）

用户已定：默认 **自动**，另有 **效果档**、**性能档** 手动选择。基线给的定义是：

| 档位 | 传给 `renderer.frame` 的选项 | 依据 |
| --- | --- | --- |
| 效果档 | `{ scale }` | 现状，永不降级 |
| 性能档 | `{ scale, fast: true, noTrans: true }` | 均值降到 1/4、p95 降到 1/2.7，有实测数据支撑 |
| 自动 | 由实测帧耗时在这一档与那一档之间选 | 见下 |

### 自动档的实现（`17-pv-preset.js` 的 `PV_AUTO_*` / `pvAuto*`）

判据只有 PV 自己那一帧的实测耗时，其它一概不看：

| 量 | 取值 | 为什么 |
| --- | --- | --- |
| 预算 | `1000/60` ms | 一次 `frame()` 超过一帧预算，就是真的掉帧；`full` 基线的 p95 恰好压在 16.6 ms |
| 窗口 | 24 个 koma = 2 秒 | 短于一个镜头的抖动不该算数，长到能代表"持续" |
| 进档 | 一窗 ≥14/24 掉帧，且连续 3 窗（6 秒） | 原则要的是"持续高压力"，一次冷启动峰值不算 |
| 落点 | 只在镜头边界生效 | 性能档会改转场的画法，半个转场用旧档、半个用新档就是原则禁止的闪回 |
| 恢复 | 下一份 plan（换歌）或用户手动选效果档 | 见下 |

**为什么读的是 PV 自己的耗时，不是全局的 `sampleAdaptiveFrameCost` / `adaptiveFrameLoadState`。**
两个原因，都写在了代码注释里：全局那条链路已经把 PV 这一帧算进去了，再读它就是同一个成本数两遍；
更要紧的是，全局压力可能来自背景 WebGL 场景，那时候把 PV 歌词的发光与转场关掉，等于为了一个和 PV
无关的原因砍 PV 的画面——正是第二边界禁止的"肉眼可见的无端降级"。所以自动档只认 `renderer.frame`
自己的墙钟耗时。

**为什么降了档不在本首歌内自动恢复。** 降档之后每一帧都便宜，是降档本身造成的，用降级后的耗时判断
"现在不压力了"是自证：要么永远不回效果档，要么每几十秒来回抖一次（回到效果档就要重新掉六秒的帧）。
唯一的诚实测法是偷偷画一帧效果档再测——那就是把当初要省的掉帧重新付给用户的眼睛，而且效果档/性能档
交替出现本身就是可见的闪烁。所以恢复点定为：换 plan（下一首歌，内容是新的证据）、回绕（拖回几秒=
重新听一遍）、或者用户直接点效果档。原则要求的是"压力持续才降"，这条实现把它的对偶也守住了：
"不为一个猜测而恢复"。

原则约束的落点，逐条对到代码：

- "持续 + 滞回"：`PV_AUTO_ENTER_WINDOWS`（连续窗口）+ 整窗计数，不是单帧阈值；
- "只在边界原子替换、不闪回"：`pvAutoBoundary()` 把 pending 决定压到新镜头第一个 koma 才落地；
- "保留歌词可读性"：性能档只发 `fast` + `noTrans`，两者都不动文字；`noHud` 永远不发（它是唯一
  可能拿走用户要看的文字的开关），这一点由 `tests/pv-draw-tier.test.js` 用 knob 白名单钉住；
- "日志说明为什么切、切到哪一档"：`[PvDrawTier] full -> lean: 15/24 draws over 16.7ms, held for
  3 windows (cut 6)`，同时计数进 `window.__mineradioPerf`（`pv.draw.tier.*`），
  `pvPresetStatus().auto` 里能看到窗口计数、连击数、切换次数和最后一行日志；
- "用户可关闭"：手动选效果档/性能档即整机关闭自动，且会丢弃自动已有的决定（不会在下次切回自动时
  突然拿出旧的降级）；
- "能力检测 + 失败回退"：引擎在性能档下抛异常 → `pvAutoGiveUp()` 回到效果档并对这份 plan 停止尝试；
- "字段进完整重启持久化 + MR2 末尾追加"：`pvDrawQuality` 已进 `USER_FX_SHARE_KEYS` 末尾，旧短码顺序未动。

### 步骤 #8 验收实测

命令：`node_modules/electron/dist/electron.exe scripts/pv-draw-bench.js --sizes=1920x1080,1280x720 --dprs=1.5,1 --phases=full,fastNoTrans`（同一份档案 `lyrics-v1-d2eefa2d…json`，2026-10-23）。
判定看两端：`full` 必须回到基线（证明效果档没被顺手改慢），`fastNoTrans` 必须压住尾部（这才是性能档存在的理由）。

| 画布 | full 均值 / p95 / 超帧 | fastNoTrans 均值 / p95 / 超帧 | 相对 full |
| --- | --- | --- | --- |
| 2160×1620（3.50 Mpx，最接近 2K 全屏） | 7.29 / 16.4 / 5 of 120 | **1.86 / 5.4 / 0 of 120** | 74% |
| 1440×1080（1.56 Mpx） | 7.49 / 18.3 / 8 | 1.65 / 5.0 / 1 | 78% |
| 960×720（0.69 Mpx，小窗口） | 5.35 / 11.5 / 1 | 1.10 / 2.7 / 0 | 79% |

`full` 三个盒子与 §3 基线（7.44 / 7.28 / 5.73）在 1–6% 内，说明这一档只是"不传额外选项"，没有引入成本。
性能档在大盒子上均值 1.86 ms、p95 5.4 ms、120 帧 0 帧超 16.7 ms，验收通过。`cold` 行是每个盒子必跑的
全新 renderer（字形缓存空），不代表任何一档。

### 步骤 #9 验收实测

自动档没有新的毫秒可测（它只是在前一档的表里挑一行），要验收的是"什么时候挑、挑了几次"，所以判据是
`tests/pv-draw-tier.test.js` 里用合成耗时驱动状态机的 17 个用例，其中这几条是原则的直接翻译：

| 用例 | 断言的边界 |
| --- | --- |
| 单帧/单窗/双窗压力不降档 | 冷启动峰值、一个 heavy 镜头都不足以改变画面；13/24 差一个也不切 |
| 连续 3 窗才切，且切在新镜头第一帧 | 中间每一帧仍画效果档，不出现半旧半新的转场 |
| 降档对本 plan 粘住，下一 plan 回到效果档 | 恢复不靠降级后的耗时自证 |
| 五分钟"十秒重十秒轻" | `autoChanges ≤ 2`：抖动压力最多换来两次切换，不会变成闪光灯 |
| 手动选效果/性能 | 自动整套停摆，且丢弃已攒的决定；切回自动时从效果档重新判断 |
| 引擎在性能档抛异常 | 回效果档并对这份 plan 停止尝试，回绕/释放都不会重新武装它 |

护栏不是摆设：现场改现场还原（源码 diff 为空）把五处不变量逐个破坏，红条数依次是
"边界才落地"改成一有决定就切 2 条、`renderer.frame` 绕开档位直接传 `{ scale }` 2 条、删掉
`pvAutoObserve(cost)` 3 条、删掉手动档那半个条件 1 条、连续窗口从 3 改成 1 2 条。
其中"边界"和"绕开档位"两条由那两个跑真模块的用例抓到：`loadLive()` 把整个 preset 模块装进 vm，
用一个只在引擎里推进的假时钟喂耗时，所以"哪一帧拿到了哪组选项"是被执行出来的，不是正则匹配出来的。

## 6. 规划隐藏窗口的空闲释放（步骤 #10）

§1 说了制定不挤占播放帧，但它仍是一个活着的 renderer 进程：`pv-planner.js` 建出来的 480×320 隐藏窗口
一旦为某首歌建过，就永远开着，里面驻着 2.1 MB 引擎文本和它求值出来的字形/缓存。之前只有手动释放
（`POST /api/pv/planner {release:true}`），没人会去点。步骤 #10 要的是：应用自己安静下来的时候，把这个
窗口还给系统，并且不能为此制造新的 bug。

实现拆成三块，池子在 `pv-planner-pool.js`（`createPvPlannerPool`，依赖全部注入：`appRoot` /
`createPlanner` / `isBusy` / `log` / `idleReleaseMs`），`server.js` 只提供 `isBusy: () => pvPlanInFlight.size`
和日志，真正的"什么时候算空闲"由 `desktop/main.js` 决定。

### 6.1 释放只挂在已有的空闲路径上

| 路径 | 挂在哪 | 为什么算空闲 |
| --- | --- | --- |
| 手动内存整理 | `trimAppMemoryNow()`，在 `foreground-visible` 闸门之后第一句 | 这个闸门本来就在，释放只是它已经判定为后台的顺带动作 |
| 定时内存整理 | `runMemoryAutoTick()`，紧接着它的 `foreground-visible` return | 同上，且沿用用户已有的 `memoryAutoTrimApp` / `memoryAutoTrimOnBackground` 开关当关闭入口 |
| 窗口状态变化 | `sendWindowState()`（24 个调用点的唯一出口）把 `!isMainWindowForegroundVisible()` 推给 `setPvPlannerBackground` | 最小化/隐藏后进入"安静期"计时 |

原则禁止"前台可见播放时强行回收"，所以这里没有任何新的定时器或轮询去主动找时机——`main.js` 里
`idleReleasePvPlanner` 附近不许出现 `setInterval` / `setTimeout`，这条由 `scripts/quick-check.js` 正则钉住。

安静期的回收是**一次性**的：后台状态下每次取用窗口都重新武装 45 秒（`PV_IDLE_RELEASE_MS`，
可用 `MINERADIO_PV_PLANNER_IDLE_MS` 覆盖），到点只在没有计划在路上时才关。定时器 `.unref()`，
不为了等它而让进程多活一秒。回到前台立刻取消武装。

### 6.2 三个不能省的边界

- **有计划在飞就不动**。`isBusy()` 读的是 `server.js` 的请求去重表：两个调用方共享一份计划仍是一次计划，
  而在飞的计划意味着有个窗口正卡在它的 `executeJavaScript` 上。被拒时不重试，而是重新武装等下一个安静期，
  并累加 `refusedWhileBusy`、打一行 `[PvPlanner] idle release (…) refused: N plan(s) in flight`。
- **计数跨窗口累加**。`liveStats()` 把已销毁窗口的计数与当前窗口的相加，"最新值"类字段才覆盖。
  否则每次重建就把 `windowsCreated` 抹回 1，一个"绿色"读数恰好掩盖了它一直在抖动重建这件事——
  而这正是本次要观察的现象。
- **引擎指纹不匹配仍然记住**。`failure` 存进池子，`idleRelease` 不清除，免得每首歌都重建一次窗口再
  每首都失败。

手动释放路由保持无条件（哪怕有计划在飞也照关，调用方拿到 `PV_PLAN_TIMEOUT` 是它自己要求的），
文档化的理由是：它就是调试口，不能变成空闲路径——空闲路径必须无条件地"不打断正在干的活"。

### 6.3 验收：单元测试 12 例

`tests/pv-planner-idle-release.test.js`（已进 `scripts/quick-check.js`，跟随 `runPvPipelineCheck()`）。
假窗口记下构造参数，假计划用 `blockOn` 把执行卡在 `executeJavaScript` 中间来制造"在飞"：

| 组 | 断言 |
| --- | --- |
| 建窗 | 懒创建；`options.show === false`；`backgroundThrottling === false`（否则后台根本不会被调用） |
| 释放与重建 | 释放真的 `destroy()`；下一份计划重建窗口且照样出结果 |
| 在飞拒绝 | `reason:'plan-in-flight'` + `refusedWhileBusy` 增加，而那份计划仍然正常返回 |
| 计数 | 跨两次窗口：`windowsCreated` 2 / `plans` 3 / `releases` 2 / `lastEngineMs` 7 |
| 日志与命名 | `[PvPlanner] … tray-hide`；`not-open` 是空操作且一行日志都不打 |
| 失败记忆 | 指纹不匹配的失败活过一次 `idleRelease`（`createCalls === 1`） |
| 手动 vs 空闲 | `release('manual')` 在调用方卡住时仍无条件关闭 |
| 安静期 | 后台静默 45 秒后自动回收（`lastReleaseReason:'background-quiet'`）；后台重建的窗口会被再收一次（`releases` 2）；回前台取消武装；被在飞拒绝后重新武装 |

### 6.4 验收：实机探针与两次不一致的运行

探针 `tmp/pv-planner-idle-live.js`（HTTP 打 `GET /api/pv/planner` + `POST /api/pv/plan`，
合成歌曲键 `__idle-release-probe__` 保证缓存必然 miss；CDP 驱动 `trimAppMemory` / `minimize` / `restore`）。
判定与观察分开写，因为"释放发生过"和"读取时窗口还开着"是两件事：

- 前台时 `trimAppMemoryNow` 返回 `foreground-visible`，窗口 `open:true` 不变——**这条边界实测到了**。
- 最小化后走定时整理路径，释放发生过：一次全绿运行里读到 `open:false releases:1 lastReleaseReason:'minimize'`，
  随后 plan B 把它重建，`windowsCreated:2 plans:2`，计数没有被抹掉。引擎内部耗时在 16.8–22.4 ms。
- `tmp/pv-planner-idle-live.log` 存的是另一次运行：最小化成功（`minimized:true visible:false`），
  但 +5.99 秒应用把自己的窗口恢复了（`window-restored`，`windowMinimizeIntentional:true`，
  没有 `window-minimize-recovered`），于是 +4 秒那次定时整理回答 `foreground-visible` 而跳过，
  整个探针读到 `releases:0`。

两次不一致各暴露一个真实问题，也都已经处理：

1. **后台的 PV 预取会在释放后几秒把窗口重新建起来**。所以回收不做成"后台就关一次"，而是"每次取用后
   重新计时、静默才关"，并额外测了"后台重建的窗口会被再收一次"这一例。
2. **应用会在最小化后约 4–6 秒自行恢复窗口**。这与用户报的"自动最小化"是同一个方向的现象，
   还没有归因（嫌疑：`focusMainWindow` `desktop/main.js:2184`、`showMainWindowSafe` `desktop/main.js:5407`、
   wallpaper-engine 的 suspend/resume；已排除 `restoreUnexpectedMainWindowMinimize`，因为它必写
   `window-minimize-recovered`）。这一步不修它，但要记在这里：**任何依赖"最小化后仍保持最小化"的
   内存回收，实际回收量都会被这个自恢复打折。**

还没测的：**每个 renderer 进程实际省下多少 MB**。池子的计数器证明窗口确实关了，但没测回内存的量；
要测需要在释放前后各读一次 `app.getProcessMemoryInfo()`，属于步骤 #12 的实机清单。

## 7. 复现性

同一命令连跑两次（含 JIT 预热与"第二遍才计时"两步，见 `scripts/pv-draw-bench.js` 的 `PAGE_SWEEP`）：

| 选项 | 3.50 Mpx run A / run B | 偏差 |
| --- | --- | --- |
| cold | 16.45 / 16.34 | 1% |
| full | 7.40 / 7.44 | 1% |
| noGhost | 5.92 / 5.97 | 1% |
| noPost | 4.80 / 4.24 | 12% |
| fast | 4.75 / 3.95 | 17% |
| noTrans | 6.78 / 6.09 | 10% |
| fastNoTrans | 1.74 / 1.82 | 4% |
| cheap | 0.34 / 0.62 | 45% |

`full` / `cold` / `noGhost` / `fastNoTrans` 这类决策相关行在 10% 内。`fast`、`noPost`、`cheap` 的相对
偏差大是因为绝对值已经进了 0.3–4.8 ms 区间，此时 ±0.3 ms 的取样噪声就是几十个百分点——判定档位时
要看 `full` 和 `fastNoTrans` 两端，不要拿中间项的百分比当尺子。

未加预热前，同一档位同一尺寸在两次运行里给过 9.15 / 5.68 ms 的差距，这就是 `PAGE_SWEEP` 里
`warmup` 和"跑两遍只取第二遍"存在的原因；删掉它们，这张表就退回不可比。

## 8. 护栏为什么必须存在

`fast` / `noGhost` / `noPost` / `noTrans` / `noHud` 只是 vendor 引擎读取的 `opt` 字段名。vendor 是
sha1 钉住的、不允许修改的第三方文件；一旦哪天换了指纹或上游改了参数名，设置里那一档会照旧"生效"、
数字照旧显示，但一个效果都没关——静默失效。`tests/pv-draw-bench-guard.test.js` 把每个 knob 钉在引擎
源码的具体表达式上（例如 `/this\.filterOK && !opt\.fast/`），并把同一份源码改名后重跑一遍，证明护栏
确实会红。这条检查已经进 `node scripts/quick-check.js`。

## 9. 还没测、需要单独确认的

- preset 13 期间主 WebGL 通路并没有停下：`renderer.render(scene, camera)` 每帧照旧执行，
  `applyVisualTakeover` 只隐藏了 particles / float / backCover / stageLyrics 几组，`fx.bloom` 开着时
  bloom 粒子仍在画。这份额外成本没有算进上表，需要在实机播放场景里量。
- 桌面实际帧交付率（`pvPresetState.lastCostMs`、`draws`、`skips` 已在状态里，但没有汇总成用户可见指标）。
- 自动档到现在只在合成耗时里跑过：这台机器画 `full` 的 p95 才 16.4 ms，凑不出"连续三窗 14/24 掉帧"
  的压力，所以实机上还没真见过一次切换（盒子越小越快，逼不出压力：0.69 Mpx 的 `full` 才 5.35 ms）。
  步骤 #12 的实机清单要用 4K 视野盒 + dpr 2，或人为把机器压满，把它逼出来，
  确认 `[PvDrawTier]` 日志与 `pvPresetStatus().auto` 对得上。
