# 闲鱼公开商品研究采集器｜开发文档

版本：0.5.1  
日期：2026-08-06  
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
- 创建并复用采集标签页，处理详情链接顺序和搜索页分页。
- 通过 `chrome.alarms` 驱动任务阶段，避免依赖某个页面脚本的长时间 Promise。
- 合并、清洗、去重商品记录，写入 `xianyu_public_items_v1`。
- 合并、清洗店铺资料和公开评价，写入 `xianyu_public_store_profiles_v1`；店铺评价保留评价图片 URL，导出阶段下载真实图片。
- 维护任务历史 `xianyu_collect_history_v1`。
- 任务终态时发送通知、更新 badge，并触发自动导出流程。
- 通过 `chrome.downloads` 发起最终文件下载；下载根目录由浏览器设置决定。
- 导出时同时读取商品主表数据和店铺资料快照；历史任务保留店铺资料快照，便于重新导出。

### 3.2 侧边栏：`sidepanel.html/js/css`

- 使用首页、详情页、店铺页、批量链接、搜索跨页、数据中心、历史、设置和处理任务页组成的轻量 screen router；一级功能页只保留一个明确的父级，避免返回按钮累积历史栈。
- 店铺页采集成功后直接启用“立即下载 Excel”；店铺导出使用当前本地商品数据和店铺资料快照，不需要用户手动跳转到数据中心。
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
- 账号页解析先定位 `infoTop--*` 或包含账号统计/简介节点的昵称祖先作为资料作用域；不再在整个 `body` 中用通用 `description` 或第一个 `.num--*` 猜字段。
- 后台打开卖家账号页后，会轮询 `GET_ACCOUNT_PROFILE`，直到关键字段连续两次生成相同快照；未稳定的骨架屏/异步中间态不会覆盖已经采集到的商品详情字段。
- 店铺简介按语义节点保留原文，纯数字是允许的用户自定义简介；数字格式只用于明确的数量、百分比和时长字段，不作为简介过滤条件。
- `GO_NEXT_PAGE` 优先识别闲鱼 `search-page-tiny-container` 分页器的当前页码并点击下一页码；若只有无文字右箭头，则点击右箭头；最后才兼容带“下一页”文字的旧版本控件。
- 商品记录只通过 `COLLECT_ITEMS` 发给 service worker。
- 店铺资料通过 `COLLECT_STORE_PROFILE` 发给 service worker；搜索列表阶段不会通过 `COLLECT_ITEMS` 写入商品主表。
- 详情页类目解析优先调用 `serviceTypeFromRoot`，在详情属性区读取“服务类型”值；没有该属性时才回退到面包屑或 URL `categoryId`。

### 3.4 页面上下文：`main-world.js`

- 只观察闲鱼页面已经调用的 fetch/XHR。
- 仅匹配已知的搜索/详情响应路径；不主动发请求。
- 对响应做长度限制、JSON 序列化保护和事件派发。
- 不读取 `document.cookie`、localStorage 中的登录信息，也不记录请求头和请求体。

### 3.5 导出器：`xlsx.js` 与 offscreen 文档

- `xlsx.js` 负责生成工作簿、主表、图片索引表、错误表和图片 drawing/media。
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
 正常达到目标或边界────────────► completed
```

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
  failures, retries, delayMs, createdAt, updatedAt, message
}
```

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
| `EXPORT_ITEMS` | 按设置生成并下载 Excel |
| `GET_SETTINGS` / `SAVE_SETTINGS` | 读写下载和导出设置 |
| `GET_HISTORY` / `DELETE_HISTORY` | 读写历史任务 |
| `GET_PAGE_SNAPSHOT` | 导出当前实时 DOM、公开响应、页面资源索引和账号页字段解析快照 |
| `ENRICH_SINGLE_ITEM` | 为单个详情记录读取对应卖家账号页的公开资料 |
| `COLLECT_STORE_PROFILE` | 保存店铺公开资料、评价和评价图片索引 |

### Service Worker → Content

| 消息 | 作用 |
| --- | --- |
| `GET_PAGE_INFO` | 返回页面类型、标题和 URL |
| `COLLECT_CURRENT_PAGE` | RPA/DOM 详情采集 |
| `START_API_CAPTURE` | 开启接口观察并发送当前页网络缓冲 |
| `GET_SEARCH_LINKS` | 读取搜索页商品详情链接 |
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
    sellerProductCount, sellerIntro, storeDuration,
    reviewSummary, itemGoodRate, sellerReviewSummary, sellerReviewCount, reviewSamples,
    publishedAt, sourcePage, dataSource, collectedAt
  }],
  pageType: 'detail', sourcePage, reason
}
```

店铺消息中的 `reviews` 是对象数组，每条至少包含 `reviewer`、`role`、`feedback`、`timeIp`、`images[]` 和 `collectedAt`。`images[]` 只保留评价内容图片，不把头像和好评徽章当成评价图片。

## 6. 接口观察模式实现细节

1. `main-world.js` 在 document_start 注入，只匹配搜索和详情 API 路径。
2. 每次响应先 JSON 序列化并限制最大字符数，避免把大响应或循环对象送进 DOM 事件。
3. `content.js` 无论当前是否已开启采集，都保留少量最近网络记录的规范化结果；缓冲有数量上限和去重。
4. 收到 `START_API_CAPTURE` 后，先发送缓冲记录，再处理后续响应；因此任务导航到详情页后可以等待页面自然加载，不需要重新实现请求签名。
5. API 模式在详情页上仍会调用 `isDetailPage()` 守卫，禁止把搜索列表响应作为最终详情记录。
6. 详情 API 缓冲按当前商品 ID过滤，避免把相关推荐或其它商品节点并入当前详情。
7. `dataSource` 使用来源合并规则，例如 `network:detail,dom,account-dom`，方便后续筛选和质量检查。

## 7. 数据与图片导出

### 商品主表

固定 18 列，顺序为：`商品ID、商品链接、主图文件名、商品图片（已嵌入）、商品文案、价格、类目、店铺名称、卖家账号页、卖家地区、粉丝数、关注数、卖家商品数、店铺简介、开店时长、商品好评率、店铺评价数、采集时间`。标题、来源页面、数据来源、图片状态等作为内部字段保留，不再进入主表。

### 图片索引表

商品图片一张一行，字段包括：商品 ID、内部标题、图片序号、图片名称、嵌入状态、失败原因、原始图片 URL。店铺评价图片单独一张一行，放在“评价图片”工作表；图片对象分别由商品主表、图片索引、评价图片三个 drawing 承载。

### 店铺资料与评价表

- “店铺资料”保存店铺字段和“已采集评价数”。
- “店铺评价”一行对应一条评价，保存评价人、身份、全文、时间/地区、图片数和图片文件名。
- “评价图片”逐张嵌入真实图片，并保存失败时原始图片地址。

### 下载流程

```text
读取商品数据
   → 读取店铺资料与评价图片索引
   → 根据商品图片上限生成商品图片任务；评价图片单独按已加载评价全部生成任务
   → 并发下载并解码/转码
   → 生成 xlsx Blob
   → chrome.downloads.download
   → 保存历史导出信息
```

自动下载只在任务终态为 `completed` 且设置为 `auto` 时触发；没有成功进入任何详情页的搜索任务会是 `failed`，不会自动下载一份“完成 0 条”的文件。手动模式只保存结果并显示“下载 Excel”按钮。下载错误不会丢失已采集数据。

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
- 卖家账号页读取失败：保留详情商品记录，最多重试两次；最终进入下一个商品并记录卖家资料失败，不让整批任务卡死。
- API 没有返回可识别商品：保留任务，允许用 DOM 模式重试；不能假报成功。
- 图片单张失败：写入图片索引错误列，继续其它图片和整个 Excel。
- 下载失败：保留数据和历史，状态栏显示可再次手动下载。
- 标签页被关闭：停止任务但不清空结果。
- 搜索页没有可识别的下一页码或分页控件：结束任务并明确提示“未找到可用的下一页页码或分页控件”，不伪造成功。
- 店铺评价加载未达到页面公开总数：导出“已采集评价数”，不声称已读取隐藏或未加载评价；已加载评价图片不受商品图片上限影响，另有 20000 张异常页面保护上限。

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
- 用店铺诊断 DOM 模拟 151 条评价和一条评价图片，验证店铺资料、评价文本、评价图片三张表和真实图片 drawing 均生成；详情 API 中的相关推荐不进入商品主表。

### 浏览器验收

- 旧标签页不刷新直接打开侧边栏并采集。
- 当前详情页、批量链接、搜索跨页各跑一遍；搜索跨页要验证只有页码、没有“下一页”文字按钮的页面。
- 侧边栏从首页进入详情页、设置页、任务页和数据中心后，逐页点击返回，确认不会在详情页和设置页之间循环。
- 自动下载、手动下载和另存为选项各跑一遍。
- 任务过程中关闭/重开侧边栏，确认任务继续。
- 任务完成时收到页面内提示和系统通知（用户允许时）。
- 店铺账号页点击“采集当前店铺页”，确认会滚动评价区域，完成后显示读取数量；导出后检查“店铺资料”“店铺评价”“评价图片”三张表。
- 点击“一键导出页面诊断包”，验证 ZIP 至少包含实时 DOM、可见文字、链接、图片地址和网络响应 JSON。
