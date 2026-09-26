# dsh-easy-exit

[English](../README.md) | 中文

方便地关掉 `dsh web` 服务：一个**会话标题栏退出按钮**加一个 **agent 工具**，
两者都接到启动器自己的有界停机路径上。

> **能力声明。** 本插件能停止 `dsh web` 进程——这就是它的全部用途。停机是优雅的
> （先 dispose 整棵 Cordis 树，会话与已保存的状态都会保留），并且路由受连接层自身的认证闸门保护；
> 但装上它，就等于给浏览器上一个按钮和一个 agent 工具"结束服务"的能力。
> 任何要以你的凭据运行的东西，装之前请先读源码。

## 为什么需要它

关掉 `dsh web` 原本只有两条路：找到服务所在的控制台窗口按 `Ctrl+C`，或者按 PID 杀进程。
本插件把"退出"放到你已经在的地方——浏览器里。

它同时补了一个文档空白：`ctx.appExit` 是**唯一**对插件开放的优雅退出入口，而它只在
`dsh-cmdline` 的 README 里被顺带提了一句。下面两个坑很容易踩、且难以定位，所以在这里写明：

- 在工具里**同步**调用 `ctx.appExit` 会毁掉工具结果（树会先被 dispose）——**退出必须延迟**；
- 用**裸 `parameters` 对象**注册的工具会被服务端拒绝
  （`Invalid schema … got 'type: null'`）——规格必须经 `defineTool` 编译。

## 怎么用

### 1. 标题栏按钮

一个电源按钮（⏻）位于**会话标题栏右侧的工具区**，与官方自带的那些操作同排。
每个会话都能看到它，既不需要展开侧边栏，也不依赖右侧边栏。

- **第一次点击**进入待确认：按钮变红并展开为"确认退出"，5 秒内有效。
- **5 秒内再点一次**才真正关掉服务；没跟上就自动失效。

之所以要两步确认，是因为这个退出是**进程级**的：它会停掉每一个已打开的标签页、每一个会话。

服务停掉后，插件会请浏览器把这个标签页也关掉——所以退出通常连标签页一起收走。

但这个请求受浏览器策略限制、只能"尽力而为"：`window.close()` **只对页面自己打开的窗口有效**，
由命令行或用户打开的标签页会被**静默拒绝**（无异常、无返回值）。因此按钮同时会变成
"服务已停止，可以关闭此页面了。"——如果标签页还在，原因就是这个。
重新启动请运行桌面脚本（`启动 DeepSeek Harness.cmd`）。

### 2. 有任务在跑时，退出会被拒绝

只要还有后台任务在运行，退出就会**被拒绝**，并把它们列出来：

```
1 job is still working: long build (running). Stopping the server now would kill
that work. Wait for it to finish, or ask again with force to stop anyway.
```

这正是这道守卫的意义：停服会**连带杀掉所有运行中的任务**，而因为误点丢掉一个构建或一次测试，
比没有这个按钮更糟。默认是**等它跑完**；`force` —— 一个明确的第二个动作 —— 才是唯一能丢弃这些工作的方式。

### 3. `/exit` 斜杠命令

输入 `/exit` 会打开命令弹窗，只有一行"关闭 dsh web 服务"。选中它**不会立即退出**，
而是弹出共享弹窗自带的风险确认（"确定关闭 dsh web？"），所以这一步永远需要第二个明确动作。

这个入口是**可选**的：只有当客户端的命令能力可用时才注册。按钮不依赖它。

### 4. agent 工具

宿主侧注册了 `shutdown_dsh_web`，所以你可以直接说：

> 关掉 dsh web / 退出 DeepSeek Harness / stop the server

| 参数 | 类型 | 默认 | 含义 |
|---|---|---|---|
| `force` | boolean | `false` | 即使仍有任务在跑也退出，并使用强制退出路径、返回非零退出码 |

不带 `force` 时，只要有任务在跑，工具就会拒绝并报告是哪些任务，所以 agent 不会误丢正在运行的工作；
带 `force` 时，等同于按钮所需的同一个"第二个动作"。
工具会**先返回结果，再安排退出**（延迟 250 毫秒），所以回答不会被"进程中途停下"截断。

## 停机是怎么实现的

本插件**从不自己杀进程**。它调用 **`ctx.appExit(code)`**——CLI 在插件树挂载之前装到上下文上的退出请求，
接到启动器的停机控制器（`@deepseek-ai/dsh-cmdline`，见它的 `README.md`）。该控制器会：

1. dispose 整棵应用树（与 `Ctrl+C` 触发的同一套拆除流程）；
2. 以请求的退出码退出；
3. 若 dispose 卡住，**5 秒上限**后强制退出。

因此会话、费用账本、看板状态、设置全部保留，**只是进程停下**。

实现被两个已记录的细节塑形：

- `shutdown.shutdown(code)` 设的是 `process.exitCode`，依赖事件循环自然排空；
  真正保证进程离开的是那个 5 秒上限。**任何让事件循环继续存活的东西（比如一个多余的 `setInterval`）都会推迟退出**
  ——这就是本插件不添加任何此类句柄的原因。
- 退出永远是延迟的，因为同步 dispose 会在 HTTP 响应（以及工具结果）送达读者之前就把它们销毁。

如果 `ctx.appExit` 不存在（某个载体没有安装 CLI 的退出请求），本插件会改为**给自己发 SIGINT**，
启动器会把它映射到同一套有界停机，并在结果里说明这一点，而不是静默失败。

## 授权

`POST /easy-exit/api` 由 **`connection.admit`** 把关——也就是连接层自己的浏览器信任与认证检查，
和它的 RPC / Fetch 路由用的是同一套。未认证的请求得到 `401`，跨站或非 loopback 的得到 `403`，
所以没有浏览器会话 cookie 的本地进程无法停掉服务。

实测行为：未认证 `POST` → `401`；带会话 cookie → `200`
`{"ok":true,"route":"appExit",…}`，服务约 0.5 秒内停止。

如果 connection 服务缺失，插件回退到本地的 loopback / 同源 / `sec-fetch-site` 围栏，
**不会 fail open**。

## 文件构成

| 文件 | 作用 |
|---|---|
| `lib/index.js` | 宿主侧：注册工具、挂载路由、请求退出 |
| `lib/client.js` | 客户端侧：标题栏按钮与 `/exit` 命令（classic-script 的工厂函数体，不是 ES 模块） |
| `cordis.patch.yml` | bundle 补丁：插入 `easy-exit` 这一行 loader 条目 |
| `smoke.mjs` | 宿主侧测试，不需要 DSH 运行时 |
| `e2e.mjs` | 实测：token 换 cookie → 带认证 POST → 服务真的停止 |
| `verify-client.mjs` | 实测：下发的组合脚本里确实含**本插件**的注册调用（见下方陷阱） |

客户端半边必须是**classic script**，通过 `window.__ModuleLoader__.load({ id, factory })` 加载
——不能用 `import`/`export`，且 `require` 只能针对 shell 冻结的模块表（React、Cordis、静态 UI 库）。
它注册到会话级槽位 `conversation.session.header.utilities`，该槽位的占用者**收不到任何 owner props**
——所以翻译函数是通过注册时的 inject 工厂传入的。

**检查下发 bundle 时的陷阱：** 一个浏览器行的组合脚本会把**该行所有插件**拼在一起，
所以对某个槽位名做子串匹配**什么都证明不了**。`@linxin666/dsh-remote-web-ui` 注册的是已废弃的
`sidebar.footer.action` 槽位，它的字面量会出现在和我们同一个 body 里——
于是 `body.includes('sidebar.footer.action')` 这种断言，**即使 bundle 完全不含本插件的代码也会报 `true`**。
`verify-client.mjs` 因此锚定在**我们自己的注册对象**上（槽位名与条目 id 相邻），
而不是锚定在任何出现在 body 里的槽位名。

## 安装

```sh
dsh plugin --profile web add dsh-easy-exit
```

之后需要重启 `dsh web`：宿主侧会立即挂载，但浏览器 bundle 是在包加载时解析的。

> **故意不提供 git 安装方式。** npm 12 默认 `allow-git=none`，
> 所以 `npm install github:<owner>/<repo>` 会失败并报
> `EALLOWGIT: Fetching packages of type "git" have been disabled`。
> 推荐那条路等于在标准的 npm 12 环境下给出一个必然报错的安装方式。
> 请从 registry 安装；开发时用 `link:` 检出。

用镜像源的用户可以继续用镜像——`dsh-easy-exit` 是普通的公开包，从镜像装没问题。
只有**发布**必须发到权威源，见下文。

## 发布

发布走 GitHub Actions 的 **[可信发布（trusted publishing）](https://docs.npmjs.com/trusted-publishers)**，
因此**不保存任何 npm token，也不需要输一次性验证码**：

```sh
npm version patch --no-git-tag-version   # 或 minor / major
git commit -am "chore: release x.y.z"
git push
# 然后：Actions -> publish -> Run workflow
```

[publish workflow](../.github/workflows/publish.yml) 由 `workflow_dispatch` 触发；
若希望发版自动开始，可加 tag 触发器。它需要 `id-token: write`，
npm 会用这个 OIDC 身份换取短期有效的 registry 凭据。`--provenance` 会在透明度日志里记录 SLSA 来源证明。

信任关系每个包只需配置一次，而且它是一个**账号级**操作：

```sh
npm login --registry=https://registry.npmjs.org/
npm trust github dsh-easy-exit --file publish.yml --repo <owner>/<repo> --allow-publish
```

该命令需要**交互式浏览器认证**，所以要在终端里运行，并在浏览器确认期间**保持窗口打开**。
注意它授权的范围：**任何对该仓库有写权限的人**此后都能发布。

下面三件事各花掉了一整个排查 session，所以记录下来：

- **workflow 必须先安装依赖。** `npm publish` 会触发 `prepack`，`prepack` 会跑 smoke 套件，
  而套件 import 了 `@deepseek-ai/dsh-tools`；没有 `npm ci` 的话，发布会在认证之前就以
  `ERR_MODULE_NOT_FOUND` 挂掉。
- **workflow 必须在较新的 Node 上跑较新的 npm。** Node 20 镜像自带 npm 10.x，
  它不具备 OIDC 交换能力，即使 `id-token: write` 已授予也会报 `ENEEDAUTH`；
  而 npm 12 还要求 Node 为 `^22.22.2 || ^24.15.0 || >=26`。
- **发布成功不等于立刻可下载。** npm 会回
  `Your package is being processed and may take a few minutes to become available`；
  这里版本元数据约 3 分钟后出现，tarball 再晚几分钟。**发布后的 404 不是失败。**

bypass-2FA 的 granular token 目前仍能直接发布（0.1.0 就是这么发的），
但 npm 正在取消这条直接发布的路（目标 2027 年 1 月），所以**它不该是你依赖的方式**。

`prepack` 会跑测试套件，所以套件失败会同时挡住 `npm pack` 和 `npm publish`
——这一点是实测过的：把套件改成非零退出，观察 `npm pack` 是否传递该退出码。

本地发布还需要**显式指定权威源**，因为像 `https://registry.npmmirror.com/` 这样的镜像是只读缓存，
既拒绝发布、也会滞后于新版本：

```sh
npm publish --registry=https://registry.npmjs.org/
```

## 开发时安装

本包是纯 ESM，无构建步骤。

```powershell
cd "$env:USERPROFILE\.dsh\profiles\web"
pnpm add "link:D:\dev\dsh-easy-exit"
# 或通过 CLI：
dsh plugin --profile web add "link:D:\dev\dsh-easy-exit"
```

`link:` 安装会建立符号链接（`dsh plugin` 会同时写入依赖和 bundle 条目），
所以改 `lib/` 下的代码无需重装。

**宿主侧热生效，客户端侧不会。** 设置了 `patchReload: live` 的 profile 会立即接受宿主侧改动
——`shutdown_dsh_web` 工具可以出现在**已经运行**的会话里。浏览器 bundle 则是在包加载时解析的，
所以按钮需要**重启 `dsh web`**（然后刷新页面）才会出现。

## 验证

套件是自包含的：`@deepseek-ai/dsh-tools` 是锁定版本的 devDependency
（宿主在运行时会提供它，所以对使用者它是 `peerDependency`，在这里是 `devDependency`）。

```powershell
npm ci
npm test                        # 86 项宿主侧断言，不需要 DSH 运行时
```

每次 push 都会通过 [test workflow](../.github/workflows/test.yml) 运行 `npm test`。

实测检查需要一个**临时实例**——绝不要用你正在使用的那个：

```powershell
$env:DSH_WEB_PORT = "3099"; dsh web --port 3099 --no-open   # 另开一个窗口
# 然后从它的输出里复制 ?token=… 的值：
node e2e.mjs 3099 "<token>"             # 未认证 401、已认证 200、服务停止
node verify-client.mjs 3099 "<token>"   # 客户端 bundle 携带本插件的注册
```

`smoke.mjs` 覆盖了退出路径（优雅、强制、信号回退、重复请求拒绝）、编译后的工具 schema、
准入闸门、信任围栏，以及路由的各种状态码。

## 已知限制

- 退出是**进程级**的：它会停掉每一个已打开的浏览器标签页和每一个会话，不只是你自己的。
- 任务守卫会**按活跃会话逐个查询**任务注册表，因为 `list(caller)` 按设计就是会话作用域的，裸 `list()` 看不到会话拥有的任务。不属于任何活跃会话的任务仍能看到；但载体若没有 sessions 服务，就只能看到无主任务。
- 浏览器无法关闭不是它自己打开的标签页，所以按钮只能告诉你"服务已停止"，标签页需要你自己关。
- `inject` 刻意只列了 `tools`，因此工具在任何 profile 里都会加载。HTTP 路由通过
  `ctx.inject(['webServer','webRuntime'], …)` 挂载，会等到这些服务存在才加载
  ——没有 web server 的载体依然能拿到工具，只是没有按钮。
- 路由位于自己的前缀下（`/easy-exit/api`），而不是连接层的 `/api` 通道上，
  所以它的授权依赖 `connection.admit` 可被取到；回退围栏更弱，但**不会 fail open**。
