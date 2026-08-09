# 闲鱼公开商品研究采集器｜开发文档

版本：0.5.14
日期：2026-08-09
实现基线：Chrome Manifest V3

## 1. 技术目标

把“页面采集、跨页导航、接口观察、图片处理、Excel 导出、任务通知”拆成可恢复的模块。任何一个页面加载或下载环节失败，都要留下可解释的状态，而不是让用户面对一个没有反应的按钮。

## 2. 总体架构

```text
侧边栏 UI
   │ chrome.runtime.sendMessage
   ▼
Service Worker（任务编排、存储、通知、下载调度）
   │ tabs.update / tabs.sendMessage / alarms
   ▼
采集专用标签页
   ├─ content.js（隔离世界：DOM 解析、消息接收、结果上报）
   └─ main-world.js（页面上下文：被动观察 fetch/XHR 的公开响应）
   │
   ├─ xlsx.js（工作簿、商品图片和评价图片对象生成）
   └─ offscreen 文档（后台图片解码、Excel 生成、自动下载）
```

### 2.1 为什么主界面使用侧边栏

采集任务会跨越多个页面和数十分钟，浏览器 action 弹窗不适合作为任务控制台。侧边栏可以在用户浏览页面时持续存在，任务状态存储在 service worker 管理的本地存储中，即使侧边栏暂时关闭，任务也不会因为 UI 消失而丢失。

### 2.2 为什么 API 模式不是直接调用闲鱼隐藏 API

闲鱼部分接口依赖登录态、临时参数和签名。把第三方签名代码直接塞进插件，会引入账号风险、维护风险和权限边界问题，也不能保证接口授权稳定。本项目的 API 模式采用“页面自身请求观察”：在 MAIN world 里只包裹页面已有的 `fetch`/`XMLHttpRequest`，读取可序列化的公开响应，再通过 DOM CustomEvent 传给隔离世界。

## 3. 模块职责

### 3.1 Service Worker：`background.js`

- 维护唯一活动任务 `xianyu_collect_job_v1`。
- 创建并复用采集标签页，处理详情链接顺序和搜索页分页；商品任务每条详情成功后在同一个任务标签页进入卖家账号页，读完基础资料再推进下一条，最后一条不跳过店铺阶段。
- 通过 `chrome.alarms` 驱动任务阶段，避免依赖某个页面脚本的长时间 Promise。
- 合并、清洗、去重商品记录，写入 `xianyu_public_items_v1`。
- 合并、清洗店铺资料和公开评价，写入 `xianyu_public_store_profiles_v1`；店铺评价保留评价图片 URL，导出阶段下载真实图片。
- 商品任务结果写入活动任务的 `stagedItems` 暂存区，不直接写入 `xianyu_public_items_v1`；只有 `COMMIT_ITEMS` 或 `COMMIT_JOB_RESULT` 才合并到数据中心商品总表。
- 维护任务历史 `xianyu_collect_history_v1`。
- 任务终态时发送通知、更新 badge，并触发自动导出流程。
- `STOP_JOB` 先登记内存取消令牌，再写入 `stopped` 终态、清除任务闹钟并关闭采集专用标签页；所有异步阶段在写状态、导航和重新排闹钟前都必须确认任务 ID 仍是当前活动任务。
- 所有 `tabs.sendMessage` 都有有限超时；页面没有响应时由阶段重试/失败逻辑接管，不能让 Service Worker 的任务 Promise 无限等待。
- 详情页和账号页导航完成后统一调用 `PREPARE_PUBLIC_PAGE`：先处理公开登录遮罩，再等待页面类型和关键语义字段稳定。`tabs.status=complete` 只表示文档加载完成，不能作为详情字段已经可读的唯一依据。
- 读取活动任务状态时检查更新时间；`collecting`/`waiting-page` 超过 90 秒没有进展时写入失败结论并释放唯一活动任务锁，`ready-to-collect` 则重新安排一次闹钟，兼容扩展重载或 Service Worker 睡眠丢失 alarm 的情况。
- 通过 `chrome.downloads` 发起最终文件下载；下载根目录由浏览器设置决定。
- 商品导出只接收商品结果和空的店铺资料集合；店铺导出只接收店铺资料/评价，生成独立的店铺工作簿，禁止通过 `readItems()` 把历史商品链接带入店铺文件。当前详情页的基础店铺补采集使用当前标签页往返，不创建临时卖家标签页。

### 3.2 侧边栏：`sidepanel.html/js/css`

- 使用首页、详情页、店铺页、批量链接、搜索跨页、数据中心、历史、设置和处理任务页组成的轻量 screen router；一级功能页只保留一个明确的父级，避免返回按钮累积历史栈。
- 店铺页采集成功后直接启用“立即下载 Excel”；店铺导出只使用当前账号对应的店铺资料和评价快照，不需要用户手动跳转到数据中心，也不包含商品工作表。
- 当前详情页采集成功后启用“加到数据中心商品表”和“导出当前详情页”；批量/搜索任务完成后启用“加到数据中心商品表”和“导出本次商品数据”。
- 当前详情成功条件以消息实际返回的 `items/stagedItems` 非空为准，不使用孤立的 `count/added` 制造假成功。暂存结果按商品 ID 关联，不因同一商品 URL 的 `spm` 等跟踪参数变化或账号页往返而被清空。
- 只负责用户操作、状态轮询、下载按钮和历史查看，不负责跨页任务循环。
- 所有任务按钮在调用前检查当前页面和任务状态。
- 展示页面详情模式与接口观察模式的差异提示，保存模式选择、下载方式和导出设置。

### 3.3 隔离世界：`content.js`

- 判断详情页/搜索页。
- 解析当前渲染 DOM。
- 从 `XIANYU_PUBLIC_DATA_CAPTURED` 事件提取公开网络响应中的商品记录。
- 维护当前页面的短期网络响应缓冲，使“开始接口观察”晚于页面请求时仍能读取最近响应。
- 接收 `COLLECT_CURRENT_PAGE`、`START_API_CAPTURE`、`GET_SEARCH_LINKS`、`GO_NEXT_PAGE` 等消息。
- 接收 `COLLECT_CURRENT_STORE_PAGE`，自动激活评价区域、滚动懒加载评价，并返回店铺资料与逐条评价图片。
- `PREPARE_PUBLIC_PAGE` 只在同时检测到“短信登录”和“手机扫码安全登录”时识别公开登录对话框；优先点击对话框关闭按钮，兜底点击遮罩安全空白处，不填写凭据、不绕过登录限制。处理后按 `detail/account/search` 的页面关键内容轮询稳定状态。
- 账号页解析先从 `infoTop--*` 向上定位同时包含账号统计和简介兄弟节点的最小资料作用域；不能把只含昵称的 `infoTop` 当成完整资料区。兼容 `bottom--*`、`intro--*`、`description--*` 和 `data-testid` 简介容器；不再在整个 `body` 中用通用 `description` 或第一个 `.num--*` 猜字段。
- 店铺页采集会轮询/读取稳定的账号资料；商品任务会在 `account-page` 阶段自动进入卖家账号页，读取稳定的基础资料后合并回 `stagedItems`；该阶段不写入全局店铺表，也不把未完整加载的评价冒充店铺任务结果。只有 `COLLECT_CURRENT_STORE_PAGE` 的明确提交才写入店铺资料/评价存储。
- 店铺简介按语义节点保留原文，纯数字是允许的用户自定义简介；数字格式只用于明确的数量、百分比和时长字段，不作为简介过滤条件。
- `GO_NEXT_PAGE` 优先识别闲鱼 `search-page-tiny-container` 分页器的当前页码并点击下一页码；若只有无文字右箭头，则点击右箭头；最后才兼容带“下一页”文字的旧版本控件。
- `GET_SEARCH_LINKS` 先滚动搜索页触发可见卡片渲染，再按元素 `getBoundingClientRect()` 的页面纵坐标、横坐标排序。网络缓冲只按商品 ID 补充对应 DOM 卡片字段，不追加 network-only 商品，确保“从左到右、逐排向下”的确定顺序。
- 商品记录只通过 `COLLECT_ITEMS` 发给 service worker；消息携带 `persistToDataCenter`，批量任务和当前详情默认传 `false`，后台将结果写入任务暂存区或返回侧边栏临时结果。当前详情的店铺补采集由 `ENRICH_SINGLE_ITEM` 复用原标签页；批量/搜索由 `account-page` 状态机完成。若详情结果没有 `sellerUrl`，后台会通过 `GET_SELLER_ENTRY` 从当前详情页卖家昵称的父级个人页链接重新发现，再进入账号页。
- 店铺资料通过 `COLLECT_STORE_PROFILE` 发给 service worker；搜索列表阶段不会通过 `COLLECT_ITEMS` 写入商品主表。
- 详情页类目解析优先调用 `serviceTypeFromRoot`，在详情属性行或短语义节点中读取“服务类型”值，并兼容标签和值被拆成多个节点；没有公开服务类型时才使用可见面包屑，平台内部 URL `categoryId` 不直接导出为类目。
- 开店时长解析只接受“来闲鱼/开店/入驻/经营”标签与时长值直接相邻的匹配；不会用任意 24 个字符范围的正则把“1天前来过”误识别成“开店 1 天”。
- 店铺简介只从账号资料作用域的 `bottom/intro/description` 语义节点读取；纯数字简介不被格式过滤，但粉丝、关注、卖出量、好评率、访问时间等统计节点会先排除。
- DOM/API/二次扫描合并使用非空字段优先策略；类目使用语义值优先策略，内部 `类目ID` 不能覆盖可见服务类型，也不会在 DOM 明确没有名称时继续冒充类目。
- `COLLECT_CURRENT_PAGE`、`START_API_CAPTURE`、店铺资料保存和商品数据保存都必须有异常回调；任何解析或运行时消息异常都要调用 `sendResponse`，避免后台误判为仍在处理中。
- 当前详情和接口观察回传侧边栏时，优先使用 `COLLECT_ITEMS` 后台返回的详情身份过滤结果，不直接使用原始扫描数组；这样单独导出只包含当前商品。

### 3.4 页面上下文：`main-world.js`

- 只观察闲鱼页面已经调用的 fetch/XHR。
- 仅匹配已知的搜索/详情响应路径；不主动发请求。
- 对响应做长度限制、JSON 序列化保护和事件派发。
- 不读取 `document.cookie`、localStorage 中的登录信息，也不记录请求头和请求体。

### 3.5 导出器：`xlsx.js` 与 offscreen 文档

- `xlsx.js` 负责生成工作簿、主表、图片索引表、错误表和图片 drawing/media。
- 店铺工作簿固定只有两张数据表：“店铺资料”和“店铺评价综合”；导出时 workbook `activeTab=0` 打开“店铺资料”，店铺资料一店一行，评价和评价图片在第二张表按评价行合并。
- 图片下载使用扩展已声明的 CDN host 权限，并优先 `credentials: omit`。
- 可识别 JPEG/PNG/GIF/WEBP；对 Excel 不适合的图片格式先在 offscreen canvas 中转为 JPEG/PNG。
- 生成文件名时清洗 Windows 非法字符，按设置拼接相对目录。

## 4. 任务状态机

```text
idle
 │
 ├─ 当前详情页 ───────────────► collected（一次性）
 │
 ├─ 批量链接
 │      └► waiting-page ► ready-to-collect ► collecting
 │             ▲                  │              │
 │             └──── 下一链接 ◄───┴── success/failure
 │
 └─ 搜索跨页
        └► search-page
              ├─ 发现链接（空列表等待重试）
              ├─ detail-page ► waiting-page ► collecting
              │                       └─ 详情页类型/商品 ID 校验 ► 下一详情 / 返回搜索页
              └─ 下一页码/分页控件 / 达到目标 / 达到页数

 任意活动状态 ──停止/标签页关闭──► stopped
 任意活动状态 ──不可恢复错误────► failed
 任意活动状态 ──90 秒无更新时间──► failed（自动释放任务锁）
正常达到目标或边界────────────► completed
```

停止语义：用户点击停止时只关闭任务创建的专用标签页，不关闭用户原本正在浏览的搜索页；已经写入本次暂存区或本地数据中心的数据保留。停止请求返回后，旧的页面响应、重试回调和闹钟即使稍后到达，也不能覆盖 `stopped` 状态或重新启动任务。

任务对象必须包含：

```js
{
  id, type: 'links' | 'search', mode: 'rpa' | 'api', status,
  tabId, startUrl, pageUrl, stage,
  links, index, pageLinks, detailIndex, seenLinks,
  expectedDetailUrl, expectedSearchPage, searchPageRetries,
  sellerProfiles, sellerFailures, collectSellerInfo,
  pendingItem, pendingSellerUrl, pendingSellerKey, pendingCount,
  targetCount, maxPages, visited, pagesProcessed, collected,
  stagedItems, committedToDataCenter,
  failures, retries, delayMs, createdAt, updatedAt, message
}
```

### 4.1 详情完整性门槛与账号页补采

- `content.js` 的 `detailPageLooksReady()` 只在详情页文案/标题、价格或图片，以及图片或完整卖家入口已经出现时返回 ready；骨架屏、协议页和推荐卡片不能进入最终商品暂存区。
- 商品任务拿到详情结果后，如果详情页没有卖家 URL，会重复请求真实卖家入口；入口来自页面可见 `/personal?userId=...` 链接、页面公开的 user/seller/shop ID 属性或语义属性，不根据昵称猜账号 URL。
- 账号页补采使用同一任务标签页，先处理公开登录遮罩，再等待账号资料语义区域稳定，连续两次读取签名一致后才合并。商品任务使用 `sanitizeStoreProfile(..., { forProduct: true })`，保留商品行需要的“开店时长”和“商品好评率”；店铺总表仍使用默认裁剪，不写入这两个不可由店铺页可靠提供的字段。
- 同一批任务内的账号页缓存标记为 `productFieldsLoaded`；持久化店铺资料只能补通用店铺字段，不能跳过商品任务所需的账号页补采。

### 4.2 字段清洗、缺失告警与失败记录

- 详情交互数按语义节点、innerText、整块文本逐层读取，并对每个候选逐个清洗；无单位小数会被跳过，解析器继续寻找当前详情页真实展示的整数。
- 服务类型解析会遍历所有详情主信息、详情属性和根节点候选容器；类目回退只允许明确的面包屑或标签行，避免推荐商品链接或内部 categoryId 抢占商品类目。

- `interactionCount()` 同时存在于 content、background 和 xlsx 三层：`5.5万/5.5w` 转成 `55000`；无单位小数被视为无效值；有效整数不会被无效接口值覆盖。
- `isInternalCategory()` 会过滤带标签的类目 ID 和长纯数字类目 ID；可见“服务类型/服务类目/服务类别”在 DOM 合并时优先级更高。
- 任务分别维护 `failures`（详情页）、`sellerFailures`（账号页）和 `qualityWarnings`（字段缺失）。任务结束时由 `terminalStatus()` 归并成 `completed`、`partial` 或 `failed`；有成功记录但存在未完成项时必须是 `partial`。
- `jobFailureRecords()` 为侧边栏和历史任务提供统一结构，包含阶段、商品 URL/ID、卖家 URL、错误原因和缺失字段；侧边栏支持复制商品 URL 重新批量采集。
- `qualityWarnings` 的语义是“当前采集没有读到预设字段”，不是“平台确认没有该字段”。除非页面出现明确的“暂无/未公开”状态，否则不能把缺失归因到平台不存在；侧边栏需把这一点直接告诉用户。

## 5. 消息协议

### UI → Service Worker

| 消息 | 作用 |
| --- | --- |
| `GET_STATUS` | 读取当前数据数 |
| `GET_ITEMS` | 读取当前数据 |
| `GET_JOB_STATUS` | 读取活动任务 |
| `START_BATCH_LINKS` | 启动链接批量任务，携带 `links/mode` |
| `START_SEARCH_CRAWL` | 启动搜索跨页任务，携带 `startUrl/targetCount/maxPages/mode` |
| `STOP_JOB` | 停止活动任务 |
| `COMMIT_ITEMS` | 把当前详情页临时结果合并到数据中心商品表 |
| `COMMIT_JOB_RESULT` | 把已完成批量/搜索任务的 `stagedItems` 合并到数据中心商品表 |
| `EXPORT_ITEMS` | 按 `taskType` 导出商品、当前详情或当前店铺；商品与店铺数据不混用 |
| `EXPORT_JOB_RESULT` | 导出当前任务暂存的商品结果，不读取历史商品集合 |
| `GET_SETTINGS` / `SAVE_SETTINGS` | 读写下载和导出设置 |
| `GET_HISTORY` / `DELETE_HISTORY` | 读写历史任务 |
| `GET_PAGE_SNAPSHOT` | 导出当前实时 DOM、公开响应、页面资源索引和账号页字段解析快照 |
| `GET_STORE_STATUS` | 按当前 `/personal?userId=...` 查询本地历史店铺资料、评价数量和最近采集时间 |
| `COLLECT_STORE_PROFILE` | 保存店铺公开资料、评价和评价图片索引 |
| `COMMIT_STORE_PROFILE` | 把当前店铺页暂存结果加入数据中心店铺表 |
| `ENRICH_SINGLE_ITEM` | 当前详情页复用原标签页访问卖家账号页，返回补齐后的商品结果 |
| `GET_SELLER_ENTRY` | 从当前商品详情页卖家昵称及其父级个人页链接发现卖家账号页 |

### Service Worker → Content

| 消息 | 作用 |
| --- | --- |
| `GET_PAGE_INFO` | 返回页面类型、标题和 URL |
| `COLLECT_CURRENT_PAGE` | RPA/DOM 详情采集 |
| `START_API_CAPTURE` | 开启接口观察并发送当前页网络缓冲 |
| `GET_SEARCH_LINKS` | 读取搜索页商品详情链接 |
| `PREPARE_PUBLIC_PAGE` | 关闭公开登录提示并等待指定页面类型的关键内容稳定 |
| `GET_ACCOUNT_PROFILE` | 读取卖家账号页简介、统计和公开评价 |
| `COLLECT_CURRENT_STORE_PAGE` | 进入评价区域、滚动加载并返回当前店铺页完整公开资料与评价 |
| `GO_NEXT_PAGE` | 识别并点击下一页码或分页控件，点击后回到顶部 |

### Content → Service Worker

`COLLECT_ITEMS` 结构：

```js
{
  type: 'COLLECT_ITEMS',
  items: [{
    itemId, title, description, price, category, images, itemUrl,
    sellerName, sellerUrl, sellerLocation, sellerFollowers, sellerFollowing,
    viewCount, wantCount, sellerProductCount, sellerIntro, storeDuration,
    reviewSummary, itemGoodRate, sellerReviewSummary, sellerReviewCount, reviewSamples,
    publishedAt, sourcePage, dataSource, collectedAt
  }],
  pageType: 'detail', sourcePage, reason
  persistToDataCenter: false
}
```

店铺消息中的 `reviews` 是对象数组，每条至少包含 `reviewer`、`role`、`feedback`、`timeIp`、`images[]` 和 `collectedAt`。`images[]` 只保留评价内容图片，不把头像和好评徽章当成评价图片。

## 6. 接口观察模式实现细节

1. `main-world.js` 在 document_start 注入，只匹配搜索和详情 API 路径。
2. 每次响应先 JSON 序列化并限制最大字符数，避免把大响应或循环对象送进 DOM 事件。
3. `content.js` 无论当前是否已开启采集，都保留少量最近网络记录的规范化结果；缓冲有数量上限和去重。
4. 收到 `START_API_CAPTURE` 后，会重复请求当前页面已经公开的快照并等待多轮响应，再与 DOM 合并；因此详情 API 晚于首屏 DOM 到达时，类目、卖家入口和交互数仍有机会补齐，不需要重新实现请求签名。
5. API 模式在详情页上仍会调用 `isDetailPage()` 守卫，禁止把搜索列表响应作为最终详情记录。
6. 详情 API 缓冲按当前商品 ID过滤，避免把相关推荐或其它商品节点并入当前详情。
7. `dataSource` 使用来源合并规则，例如 `network:detail,dom,account-dom`，方便后续筛选和质量检查。

## 7. 数据与图片导出

### 商品主表

固定 20 列，顺序为：`商品ID、商品链接、主图文件名、商品图片、商品文案、浏览数、想要数、价格、类目、店铺名称、卖家账号页、卖家地区、粉丝数、关注数、卖家商品数、店铺简介、开店时长、商品好评率、店铺评价数、采集时间`。标题、来源页面、数据来源、图片状态等作为内部字段保留，不再进入主表。浏览数和想要数来自当前详情页可见的对应标签或当前详情已收到的明确接口字段，无法对应时留空。每个商品的全部图片逐张进入“图片索引”并嵌入，主表展示第一张成功主图。

商品任务导出使用 `stagedItems` 或显式传入的临时商品集合；数据中心导出使用 `xianyu_public_items_v1`。两者只有在用户点击加入按钮后才合并。

### 图片索引表

商品图片一张一行，字段包括：商品 ID、内部标题、图片序号、图片名称、嵌入状态、失败原因、原始图片 URL。店铺评价图片在“店铺评价综合”表的评价对应行显示文件名、状态和失败原因，并由该表的 drawing 真实嵌入；图片对象由商品主表、图片索引和店铺评价综合表分别承载。

### 店铺资料表与店铺评价综合表

- “店铺资料”一店对应一行，保存店铺名称、账号页、地区、粉丝、关注、商品数、简介、店铺评价数、采集时间、来源页面和已采集评价数。店铺页不保存开店时长和商品好评率；这两个字段只允许作为商品详情任务补充到商品行，不允许进入店铺表。
- “店铺评价综合”一行对应一条评价，保存店铺名称、账号页、评价序号、评价人、身份、全文、时间/地区、图片数、图片文件名、图片状态、失败时原始地址和评价采集时间。
- 评价图片逐张真实嵌入对应评价行的“评价图片”列；同一评价多张图片使用同一行的多个 drawing anchor 横向/纵向排布，不互相覆盖。
- 店铺导出采用 `kind: 'store'` 的独立工作簿，只生成“店铺资料”“店铺评价综合”两张表；商品导出采用商品工作簿，不把店铺评价图片或历史店铺快照混入商品结果。

### 下载流程

```text
读取商品任务暂存结果或数据中心商品结果
   → 商品导出读取商品图片索引；店铺导出读取当前店铺资料、评价对象和图片对象，分别写入店铺资料行与评价综合行
   → 根据商品图片上限生成商品图片任务；评价图片单独按已加载评价全部生成任务
   → 并发下载并解码/转码
   → 生成 xlsx Blob
   → chrome.downloads.download
   → 保存历史导出信息
```

自动下载在商品任务终态为 `completed` 或 `partial` 且设置为 `auto` 时触发，使用该任务的 `stagedItems`；没有成功进入任何详情页的搜索任务会是 `failed`，不会自动下载一份“完成 0 条”的文件。手动模式只保存任务结果并显示“导出本次商品数据”按钮。当前详情页和当前店铺页采集完成后分别显示自己的导出按钮。下载错误不会丢失已采集数据。商品 ID、图片索引中的商品 ID 和店铺 ID 使用文本单元格样式，避免 Excel 将长 ID 显示成科学计数法或发生精度丢失。

## 8. 设置模型

```js
{
  mode: 'rpa' | 'api',
  downloadMode: 'auto' | 'manual',
  downloadFolder: '闲鱼研究采集',
  fileNameTemplate: '闲鱼商品研究-{date}-{count}',
  saveAs: false,
  imageLimit: 0,
  maxEmbedImages: 1000,
  collectSellerInfo: true,
  notifyOnComplete: true,
  keepHistoryDays: 30
}
```

`downloadFolder` 只能是浏览器下载根目录下的相对路径，禁止 `..` 和绝对路径。`fileNameTemplate` 最终扩展名由插件统一追加 `.xlsx`。

## 9. 错误处理

- “Receiving end does not exist”：先尝试向当前内容脚本发送消息；失败时补注入 MAIN/ISOLATED 脚本；仍失败时显示“刷新当前闲鱼页面后重试”，并把错误写入状态，不吞掉。
- 页面不是详情页：立即返回实际 `pageType=search/account` 和可操作提示；搜索页跨页入口必须在 `pageType=search` 时启用。
- 搜索专用标签页不是搜索页、详情专用阶段不是详情页或当前 URL 与待采集商品 ID 不一致：不写入数据，按阶段重试；超过次数后记录失败。
- 搜索页商品卡片暂未出现：最多等待多轮异步渲染；如果从未进入详情页，任务为失败而不是完成。
- 公开登录提示遮挡详情/账号页：先关闭提示并等待关键字段；超时后记录“页面尚未稳定加载”，禁止采集骨架屏或返回空字段成功。
- 卖家账号页读取失败：保留详情商品记录，最多重试两次；最终进入下一个商品并记录卖家资料失败，不让整批任务卡死。
- API 没有返回可识别商品：保留任务，允许用 DOM 模式重试；不能假报成功。
- 图片单张失败：写入图片索引错误列，继续其它图片和整个 Excel。
- 下载失败：保留数据和历史，状态栏显示可再次手动下载。
- 标签页被关闭：停止任务但不清空结果。
- 页面消息没有回调：消息层在 12 秒后超时；当前阶段最多按既有重试次数重试，仍失败则记录详情 URL/阶段错误并继续或结束，不阻塞其它入口。
- 活动任务超过 90 秒没有更新时间：读取任务状态时自动写入失败结论、保存历史快照、发送失败提示并释放全局任务锁；不会删除已经采集的数据。
- 搜索页没有可识别的下一页码或分页控件：结束任务并明确提示“未找到可用的下一页页码或分页控件”，不伪造成功。
- 店铺评价加载未达到页面公开总数：导出“已采集评价数”，不声称已读取隐藏或未加载评价；已加载评价图片不受商品图片上限影响，另有 20000 张异常页面保护上限。
- 详情字段仍为空：不使用邻近数字或推荐卡片补位；将商品 URL/ID 和缺失字段写入 `qualityWarnings`，任务有其它成功结果时终态为 `partial`。
- 浏览数/想要数出现无单位小数：在 content、background、xlsx 三层拒绝该值；只有页面语义标签或带“万/w”的展示值可以进入商品表。

## 10. 测试策略

### 静态检查

- `node --check` 检查 service worker、content、sidepanel、offscreen、xlsx 文件。
- JSON 解析 manifest。
- 检查 manifest 中的文件都存在。

### 单元/模拟检查

- 模拟搜索页每页 40 条、目标 100 条，验证跨约 3 页且只对详情 URL 采集。
- 模拟重复商品 ID、重复图片、缺失标题和非法文件名。
- 生成 xlsx 后检查 ZIP 内存在 `xl/media/*`、`xl/drawings/*` 和图片索引 sheet。
- 模拟 API 缓冲先于 `START_API_CAPTURE` 到达，验证能被发送。
- 模拟 `START_API_CAPTURE` 解析异常、后台消息无回调和旧 `collecting` 任务，验证都能在有限时间内得到响应，旧任务会自动释放锁。
- 用店铺诊断 DOM 模拟 151 条评价和一条评价图片，验证店铺资料表、店铺评价综合表同时生成店铺资料、评价文本、评价图片字段和真实图片 drawing；详情 API 中的相关推荐不进入商品主表。
- 用乱序 DOM 卡片模拟屏幕两行布局，验证输出严格为“第一排左→右、第二排左→右”；验证 network-only 缓存不能进入搜索任务队列。
- 模拟同一商品 URL 的跟踪参数变化和详情→账号→详情往返，验证当前详情暂存结果不丢失、两个结果按钮保持启用。
- 检查店铺工作簿 ZIP：只包含“店铺资料”“店铺评价综合”两张表，`activeTab=0`，评价综合表的评价行、图片文件名/状态和评价图片媒体与 drawing 保持存在。
- 回归检查商品导出：验证 `55.00827` 不会进入“想要数”，`5.5万` 会写成 `55000`，商品 ID 以文本单元格保存。
- 回归检查商品账号补采：验证 `239天`、`100%` 和纯数字简介经过商品专用 profile 清洗后仍写入商品行；验证纯数字类目 ID不会冒充可读类目。
- 回归检查失败汇总：验证详情失败、账号页失败和字段告警可以合并显示、复制，并把成功但有未完成项的任务归为 `partial`。

### 浏览器验收

- 旧标签页不刷新直接打开侧边栏并采集。
- 当前详情页、批量链接、搜索跨页各跑一遍；搜索跨页要验证只有页码、没有“下一页”文字按钮的页面。
- 侧边栏从首页进入详情页、设置页、任务页和数据中心后，逐页点击返回，确认不会在详情页和设置页之间循环。
- 自动下载、手动下载和另存为选项各跑一遍。
- 任务过程中关闭/重开侧边栏，确认任务继续。
- 任务完成时收到页面内提示和系统通知（用户允许时）。
- 店铺账号页点击“采集当前店铺页”，确认会滚动评价区域，完成后显示读取数量；导出后检查“店铺资料”表中的店铺字段，以及“店铺评价综合”表中评价字段和评价图片位于同一行。
- 点击“一键导出页面诊断包”，验证 ZIP 至少包含实时 DOM、可见文字、链接、图片地址和网络响应 JSON。
- 在任务执行期间关闭/重新加载扩展，验证重新打开侧边栏后旧任务不会永久禁用当前详情、店铺、批量和搜索入口。
