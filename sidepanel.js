(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const DEFAULT_SETTINGS = {
    mode: 'rpa',
    downloadMode: 'manual',
    downloadFolder: '闲鱼研究采集',
    fileNameTemplate: '闲鱼商品研究-{date}-{count}',
    saveAs: false,
    imageLimit: 0,
    maxEmbedImages: 1000,
    collectSellerInfo: true,
    notifyOnComplete: true,
    keepHistoryDays: 30
  };
  const TAB_MESSAGE_TIMEOUT_MS = 12000;

  let activeTab = null;
  let settings = { ...DEFAULT_SETTINGS };
  let selectedMode = 'rpa';
  let lastTerminalKey = '';
  let lastJobId = '';
  let currentScreen = 'home';
  let screenParent = 'home';
  let currentPageType = '';
  let storeDataReady = false;
  let currentStoreStatus = { exists: false, profile: null };
  let pendingCurrentItems = [];
  let pendingCurrentSourceUrl = '';
  let currentItemsCommitted = false;
  let pendingCurrentStoreProfile = null;
  let pendingCurrentStoreSourceUrl = '';
  let currentStoreCommitted = false;
  let dataTab = 'products';
  let currentTaskJob = null;

  const SCREEN_META = {
    home: { kicker: 'WORKSPACE', title: '闲鱼研究助手', subtitle: '从公开详情页整理同行商品与店铺信息' },
    detail: { kicker: 'CURRENT DETAIL', title: '采集当前详情', subtitle: '读取此刻打开的商品详情页' },
    store: { kicker: 'CURRENT STORE', title: '采集当前店铺页', subtitle: '分别读取店铺资料与店铺评价图片' },
    links: { kicker: 'BATCH INPUT', title: '批量商品链接', subtitle: '自动逐个打开商品详情页' },
    search: { kicker: 'SEARCH CRAWL', title: '搜索跨页采集', subtitle: '按页码推进，并逐个进入详情页' },
    data: { kicker: 'LOCAL DATASET', title: '数据中心', subtitle: '查看记录、下载 Excel 和图片索引' },
    history: { kicker: 'TASK ARCHIVE', title: '采集历史', subtitle: '查看任务结果，重新导出或删除' },
    settings: { kicker: 'WORKSPACE SETTINGS', title: '下载与字段设置', subtitle: '控制下载方式、图片和卖家公开资料' },
    task: { kicker: 'TASK RUNNER', title: '处理任务', subtitle: '查看逐个详情页的采集进度' }
  };

  function showScreen(name, push = true, parent = '') {
    const target = SCREEN_META[name] ? name : 'home';
    if (target === currentScreen && !$(`screen-${target}`)?.classList.contains('is-active')) {
      // Continue below so a partially rendered screen can still be repaired.
    } else if (target === currentScreen && $(`screen-${target}`)?.classList.contains('is-active')) {
      updateScreenChrome(target);
      return;
    }

    if (push && currentScreen !== target) {
      // 一级功能页统一回首页，只有“任务 → 数据中心”保留一个明确的返回关系。
      // 不再累积历史栈，避免设置页、详情页之间来回跳转。
      screenParent = parent || (target === 'data' && currentScreen === 'task' ? 'task' : 'home');
    }
    currentScreen = target;
    document.querySelectorAll('[data-screen]').forEach(screen => {
      screen.classList.toggle('is-active', screen.dataset.screen === target);
    });
    updateScreenChrome(target);
  }

  function updateScreenChrome(name = currentScreen) {
    const meta = SCREEN_META[name] || SCREEN_META.home;
    $('screenKicker').textContent = meta.kicker;
    $('screenTitle').textContent = meta.title;
    $('screenSubtitle').textContent = meta.subtitle;
    $('backButton').classList.toggle('is-hidden', name === 'home');
    $('modePanel').classList.toggle('is-hidden', !['detail', 'links', 'search'].includes(name));
  }

  function goBack() {
    const previous = screenParent || 'home';
    screenParent = 'home';
    showScreen(previous, false);
  }

  function isGoofishUrl(url) {
    try { return new URL(url).hostname.endsWith('goofish.com'); } catch (_) { return false; }
  }

  function itemIdFromUrl(value) {
    try {
      const url = new URL(value || '');
      for (const key of ['id', 'itemId', 'item_id', 'auctionId', 'auction_id']) {
        const found = url.searchParams.get(key);
        if (found) return found;
      }
      return url.pathname.match(/(?:item|detail)[/_-]?(\d{5,})/i)?.[1] || '';
    } catch (_) {
      return '';
    }
  }

  function sellerIdFromUrl(value) {
    try {
      const url = new URL(value || '');
      return url.pathname.startsWith('/personal') ? (url.searchParams.get('userId') || '') : '';
    } catch (_) {
      return '';
    }
  }

  function isDetailUrl(value) {
    return Boolean(itemIdFromUrl(value));
  }

  function isAccountUrl(value) {
    return Boolean(sellerIdFromUrl(value));
  }

  function sameDetailSource(first, second) {
    const firstId = itemIdFromUrl(first);
    const secondId = itemIdFromUrl(second);
    return Boolean(firstId && secondId && firstId === secondId);
  }

  function sameStoreSource(first, second) {
    const firstId = sellerIdFromUrl(first);
    const secondId = sellerIdFromUrl(second);
    return Boolean(firstId && secondId && firstId === secondId);
  }

  function setStatus(message, kind = '') {
    const node = $('status');
    node.textContent = message;
    node.className = `status ${kind}`.trim();
  }

  function renderCurrentResultActions() {
    const hasItems = pendingCurrentItems.length > 0;
    const commitButton = $('currentCommitButton');
    const exportButton = $('currentExportButton');
    const hint = $('currentCollectHint');
    if (commitButton) {
      commitButton.disabled = !hasItems || currentItemsCommitted;
      commitButton.textContent = currentItemsCommitted ? '已加入数据中心商品表' : '加到数据中心商品表';
    }
    if (exportButton) exportButton.disabled = !hasItems;
    if (hint && !hasItems) {
      hint.textContent = '采集完成后可以选择：加入数据中心商品总表，或只导出当前这一条商品。';
    }
  }

  function clearCurrentResult() {
    pendingCurrentItems = [];
    pendingCurrentSourceUrl = '';
    currentItemsCommitted = false;
    renderCurrentResultActions();
  }

  function clearCurrentStoreResult() {
    pendingCurrentStoreProfile = null;
    pendingCurrentStoreSourceUrl = '';
    currentStoreCommitted = false;
    renderStoreStatus(currentPageType, currentStoreStatus);
  }

  function hasCurrentStoreData() {
    return Boolean(currentStoreStatus?.exists || pendingCurrentStoreProfile);
  }

  function setDataTab(tab = 'products') {
    dataTab = tab === 'stores' ? 'stores' : 'products';
    const products = dataTab === 'products';
    $('dataProductsTab')?.classList.toggle('is-selected', products);
    $('dataStoresTab')?.classList.toggle('is-selected', !products);
    $('dataProductsTab')?.setAttribute('aria-selected', String(products));
    $('dataStoresTab')?.setAttribute('aria-selected', String(!products));
    $('dataProductsPanel')?.classList.toggle('is-hidden', !products);
    $('dataStoresPanel')?.classList.toggle('is-hidden', products);
  }

  function renderStoreStatus(pageType, status = {}) {
    currentStoreStatus = status || { exists: false, profile: null };
    const isAccount = pageType === 'account';
    const profile = currentStoreStatus.profile || null;
    const reviewCount = Number(profile?.reviewCount || 0);
    const collectedAt = profile?.collectedAt ? formatDate(profile.collectedAt) : '';
    const collectButton = $('storeCollectButton');
    const hint = $('storeCollectHint');
    const storeExportButton = $('storeExportButton');
    const storeCommitButton = $('storeCommitButton');
    const hasStoreData = hasCurrentStoreData();
    const hasPendingStore = Boolean(pendingCurrentStoreProfile);
    if (storeExportButton) {
      storeExportButton.disabled = !isAccount || !hasStoreData || $('taskRail')?.dataset.active === 'true';
    }
    if (storeCommitButton) {
      storeCommitButton.disabled = !isAccount || !hasPendingStore || currentStoreCommitted || $('taskRail')?.dataset.active === 'true';
      storeCommitButton.textContent = currentStoreCommitted ? '已加入数据中心店铺表' : '加到数据中心店铺表';
    }

    if (!isAccount) {
      $('storeCurrentState').textContent = '请进入店铺页';
      if (collectButton) collectButton.textContent = '采集当前店铺页';
      if (hint) hint.textContent = '请先打开闲鱼卖家账号页；采集完成后会在这里直接显示结果和下载入口。';
      return;
    }

    if (hasPendingStore) {
      const pendingReviewCount = Number(pendingCurrentStoreProfile?.reviewCountLoaded || pendingCurrentStoreProfile?.reviews?.length || 0);
      $('storeCurrentState').textContent = `${currentStoreCommitted ? '已加入数据中心' : '本次已采集'} · ${pendingReviewCount} 条评价`;
      if (collectButton) collectButton.textContent = '重新采集当前店铺页';
      if (hint) {
        hint.textContent = `本次已读取 ${pendingReviewCount} 条评价，结果已暂存；可以直接下载店铺 Excel，也可以点击“加到数据中心店铺表”。`;
      }
    } else if (currentStoreStatus.exists) {
      $('storeCurrentState').textContent = `历史已采集 · ${reviewCount} 条评价`;
      if (collectButton) collectButton.textContent = '重新采集当前店铺页';
      if (hint) hint.textContent = `已找到当前店铺的历史记录：${reviewCount} 条评价${collectedAt ? `，最近采集于 ${collectedAt}` : ''}。重新采集会先生成本次结果，确认后再加入店铺表。`;
    } else {
      $('storeCurrentState').textContent = '可采集 · 暂无历史记录';
      if (collectButton) collectButton.textContent = '采集当前店铺页';
      if (hint) hint.textContent = '当前店铺还没有本地采集记录；点击采集后会在这里显示完成状态、评价数量和下载入口。';
    }
  }

  function sendRuntime(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, response => {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message));
        else resolve(response);
      });
    });
  }

  function sendToTab(tabId, message, timeoutMs = TAB_MESSAGE_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => finish(
        new Error(`页面响应超时（${message?.type || '未知消息'}），请刷新闲鱼页面后重试。`)
      ), Math.max(1000, Number(timeoutMs) || TAB_MESSAGE_TIMEOUT_MS));

      function finish(error, response) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(response);
      }

      try {
        chrome.tabs.sendMessage(tabId, message, response => {
          if (settled) return;
          const error = chrome.runtime.lastError;
          if (error) finish(new Error(error.message));
          else finish(null, response);
        });
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  function executeScript(details) {
    return new Promise((resolve, reject) => {
      chrome.scripting.executeScript(details, result => {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message));
        else resolve(result);
      });
    });
  }

  async function sendToTabWithRecovery(tabId, message, timeoutMs = TAB_MESSAGE_TIMEOUT_MS) {
    try {
      return await sendToTab(tabId, message, timeoutMs);
    } catch (firstError) {
      try {
        await executeScript({ target: { tabId }, world: 'MAIN', files: ['main-world.js'] }).catch(() => {});
        await executeScript({ target: { tabId }, world: 'ISOLATED', files: ['content.js'] });
        return await sendToTab(tabId, message, timeoutMs);
      } catch (secondError) {
        throw new Error(secondError?.message || firstError?.message || '无法连接当前闲鱼页面，请刷新页面后重试。');
      }
    }
  }

  function modeLabel(mode = selectedMode) {
    return mode === 'api' ? '接口观察模式' : '页面详情模式';
  }

  function modeHint(mode = selectedMode) {
    return mode === 'api'
      ? '观察当前详情页已经公开收到的 JSON/接口响应，并与页面内容合并。'
      : '读取详情页已经展示的商品文案、图片和店铺信息。';
  }

  function setMode(mode, persist = true) {
    selectedMode = mode === 'api' ? 'api' : 'rpa';
    $('modeRpa').classList.toggle('is-selected', selectedMode === 'rpa');
    $('modeApi').classList.toggle('is-selected', selectedMode === 'api');
    $('modeRpa').setAttribute('aria-pressed', selectedMode === 'rpa');
    $('modeApi').setAttribute('aria-pressed', selectedMode === 'api');
    $('modeTitle').textContent = modeLabel();
    $('modeHint').textContent = modeHint();
    if (persist) {
      settings = { ...settings, mode: selectedMode };
      void sendRuntime({ type: 'SAVE_SETTINGS', settings }).catch(() => {});
    }
  }

  function setPageButtons(supported, pageType = currentPageType) {
    const active = Boolean($('taskRail').dataset.active === 'true');
    $('collectButton').disabled = !supported || pageType !== 'detail' || active;
    $('storeCollectButton').disabled = !supported || pageType !== 'account' || active;
    $('diagnosticButton').disabled = !supported;
    $('batchLinkButton').disabled = active;
    $('searchCrawlButton').disabled = !supported || pageType !== 'search' || active;
  }

  function updateHomePageContext({ supported = false, pageType = '', title = '', url = '' } = {}) {
    const badge = $('homeSiteState');
    if (!supported) {
      currentPageType = '';
      badge.className = 'status-dot warn';
      badge.innerHTML = '<span></span>请打开闲鱼';
      $('homePageName').textContent = title || '当前标签页不是 goofish.com';
      $('homePageHint').textContent = url || '打开闲鱼后，可直接从这里开始采集。';
      $('homePageKind').textContent = '不可用';
      return;
    }

    badge.className = 'status-dot ok';
    badge.innerHTML = '<span></span>闲鱼页面';
    $('homePageName').textContent = title || '闲鱼页面';
    $('homePageHint').textContent = url || '页面地址读取中…';
    $('homePageKind').textContent = pageType === 'detail' ? '详情页' : pageType === 'account' ? '账号页' : '搜索页';
  }

  async function refreshCurrentPage() {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    activeTab = tabs[0] || null;
    // 详情补采集会在同一标签页临时进入账号页并返回；跟踪参数也可能被闲鱼重写。
    // 只有用户明确切换到“另一个商品详情”时才清掉暂存结果，避免成功后按钮立刻变灰。
    if (pendingCurrentSourceUrl && activeTab?.url && isDetailUrl(activeTab.url)
      && !sameDetailSource(pendingCurrentSourceUrl, activeTab.url)) {
      clearCurrentResult();
    }
    if (pendingCurrentStoreSourceUrl && activeTab?.url && isAccountUrl(activeTab.url)
      && !sameStoreSource(pendingCurrentStoreSourceUrl, activeTab.url)) {
      clearCurrentStoreResult();
    }
    const supported = Boolean(activeTab && isGoofishUrl(activeTab.url || ''));
    const badge = $('siteBadge');

    if (!supported) {
      badge.className = 'status-dot warn';
      badge.innerHTML = '<span></span>请打开闲鱼';
      $('pageTitle').textContent = '当前标签页不是 goofish.com';
      $('pageUrl').textContent = activeTab?.url || '—';
      $('pageType').textContent = '不可用';
      $('currentState').textContent = '无法采集';
      $('storeSiteBadge').className = 'status-dot warn';
      $('storeSiteBadge').innerHTML = '<span></span>请打开闲鱼';
      $('storePageTitle').textContent = '当前标签页不是 goofish.com';
      $('storePageUrl').textContent = activeTab?.url || '—';
      $('storePageType').textContent = '不可用';
      renderStoreStatus('', { exists: false, profile: null });
      updateHomePageContext({ title: $('pageTitle').textContent, url: $('pageUrl').textContent });
      setPageButtons(false);
      return;
    }

    badge.className = 'status-dot ok';
    badge.innerHTML = '<span></span>闲鱼页面';
    $('pageTitle').textContent = activeTab.title || '正在读取页面…';
    $('pageUrl').textContent = activeTab.url || '—';
    $('storePageTitle').textContent = activeTab.title || '正在读取页面…';
    $('storePageUrl').textContent = activeTab.url || '—';

    try {
      const page = await sendToTabWithRecovery(activeTab.id, { type: 'GET_PAGE_INFO' });
      currentPageType = page?.pageType || '';
      const pageType = page?.pageType === 'detail' ? '详情页' : page?.pageType === 'account' ? '账号页' : '搜索页';
      $('pageTitle').textContent = page?.title || activeTab.title || activeTab.url;
      $('pageUrl').textContent = page?.url || activeTab.url;
      $('pageType').textContent = pageType;
      $('currentState').textContent = page?.pageType === 'detail' ? '可采集' : page?.pageType === 'account' ? '账号资料页' : '请进入详情';
      $('storeSiteBadge').className = 'status-dot ok';
      $('storeSiteBadge').innerHTML = '<span></span>闲鱼页面';
      $('storePageTitle').textContent = page?.title || activeTab.title || activeTab.url;
      $('storePageUrl').textContent = page?.url || activeTab.url;
      $('storePageType').textContent = page?.pageType === 'account' ? '店铺页' : page?.pageType === 'detail' ? '详情页' : '搜索页';
      const storeStatus = page?.pageType === 'account'
        ? await sendRuntime({ type: 'GET_STORE_STATUS', sellerUrl: page.url || activeTab.url }).catch(() => ({ exists: false, profile: null }))
        : { exists: false, profile: null };
      renderStoreStatus(page?.pageType || '', storeStatus);
      updateHomePageContext({
        supported: true,
        pageType: page?.pageType || 'search',
        title: $('pageTitle').textContent,
        url: $('pageUrl').textContent
      });
      setPageButtons(true, page?.pageType || 'search');
    } catch (error) {
      currentPageType = '';
      $('pageType').textContent = '待刷新';
      $('currentState').textContent = '待连接';
      $('storeSiteBadge').className = 'status-dot warn';
      $('storeSiteBadge').innerHTML = '<span></span>待连接';
      $('storePageTitle').textContent = activeTab.title || '闲鱼页面';
      $('storePageUrl').textContent = activeTab.url || '—';
      $('storePageType').textContent = '待刷新';
      renderStoreStatus('', { exists: false, profile: null });
      updateHomePageContext({ supported: true, pageType: '', title: activeTab.title || '闲鱼页面', url: activeTab.url });
      setPageButtons(true);
      setStatus(error.message || '暂时无法连接页面；请刷新闲鱼页面后重试。', 'error');
    }
  }

  async function refreshCount() {
    const response = await sendRuntime({ type: 'GET_STATUS' });
    if (!response?.ok) throw new Error(response?.error || '读取数据数量失败');
    $('itemCount').textContent = response.count;
    $('dataNumber').textContent = response.count;
    $('homeItemCount').textContent = response.count;
    $('dataProductsCount').textContent = response.count;
    $('homeStoreCount').textContent = response.storeCount || 0;
    $('dataStoreNumber').textContent = response.storeCount || 0;
    $('dataStoresCount').textContent = response.storeCount || 0;
    $('storeCount').textContent = response.storeCount || 0;
    storeDataReady = Number(response.storeCount || 0) > 0;
    const storeExportButton = $('storeExportButton');
    if (storeExportButton) {
      storeExportButton.disabled = currentPageType !== 'account' || !hasCurrentStoreData() || $('taskRail')?.dataset.active === 'true';
    }
    const storeCommitButton = $('storeCommitButton');
    if (storeCommitButton) storeCommitButton.disabled = currentPageType !== 'account' || !pendingCurrentStoreProfile || currentStoreCommitted;
    const storeDataExportButton = $('storeDataExportButton');
    if (storeDataExportButton) storeDataExportButton.disabled = !storeDataReady;
  }

  function jobIsActive(job) {
    return Boolean(job && !['completed', 'stopped', 'failed'].includes(job.status));
  }

  function jobProgress(job) {
    if (!job) return 0;
    if (job.type === 'links') {
      const total = Math.max(1, job.links?.length || 0);
      return Math.min(100, Math.round((Number(job.index || 0) / total) * 100));
    }
    const total = Math.max(1, Number(job.targetCount || 0));
    return Math.min(100, Math.round((Number(job.visited || 0) / total) * 100));
  }

  function renderJob(job) {
    const rail = $('taskRail');
    const active = jobIsActive(job);
    currentTaskJob = job || null;
    rail.dataset.active = active ? 'true' : 'false';
    rail.classList.toggle('is-complete', Boolean(job && job.status === 'completed'));
    rail.classList.toggle('is-failed', Boolean(job && ['failed', 'stopped'].includes(job.status)));

    if (!job) {
      lastJobId = '';
      $('jobBadge').textContent = '当前任务';
      $('jobHeadline').textContent = '没有活动任务';
      $('jobStatus').textContent = '任务状态会显示在这里。';
      $('jobProgressText').textContent = '0%';
      $('progressRing').style.setProperty('--progress', '0%');
      $('taskCountText').textContent = '准备开始';
      $('taskModeText').textContent = '—';
      $('taskTypeText').textContent = '—';
      $('taskCreatedText').textContent = '—';
      $('taskStateText').textContent = '—';
      $('taskFilterText').textContent = '当前未进行任何筛选';
      $('homeTaskHint').textContent = '查看当前任务进度和完成结果';
      $('stopJobButton').disabled = true;
      $('stopJobButton').textContent = '停止任务';
      $('taskExportButton').disabled = true;
      if ($('taskCommitButton')) {
        $('taskCommitButton').disabled = true;
        $('taskCommitButton').textContent = '加到数据中心商品表';
      }
      if ($('storeExportButton')) $('storeExportButton').disabled = currentPageType !== 'account' || !hasCurrentStoreData();
      if ($('storeCommitButton')) $('storeCommitButton').disabled = currentPageType !== 'account' || !pendingCurrentStoreProfile || currentStoreCommitted;
      setPageButtons(Boolean(activeTab && isGoofishUrl(activeTab.url || '')));
      return;
    }

    const typeText = job.type === 'links' ? '链接批量' : '搜索跨页';
    const stateText = active ? '正在处理' : job.status === 'completed' ? '处理完成' : job.status === 'stopped' ? '已停止' : '处理失败';
    const percent = jobProgress(job);
    $('jobBadge').textContent = `${typeText} · ${job.mode === 'api' ? 'API 模式' : '详情模式'}`;
    $('jobHeadline').textContent = stateText;
    $('jobProgressText').textContent = `${percent}%`;
    $('progressRing').style.setProperty('--progress', `${percent}%`);
    $('progressRing').style.setProperty('--ring-color', job.status === 'completed' ? 'var(--green)' : job.status === 'failed' ? 'var(--danger)' : 'var(--blue)');
    $('stopJobButton').disabled = !active;
    $('stopJobButton').textContent = active ? '停止任务' : '任务已结束';
    const stagedCount = Array.isArray(job.stagedItems) ? job.stagedItems.length : Number(job.collected || 0);
    const hasStagedItems = stagedCount > 0;
    $('taskExportButton').disabled = active || !hasStagedItems;
    if ($('taskCommitButton')) {
      $('taskCommitButton').disabled = active || !hasStagedItems || Boolean(job.committedToDataCenter);
      $('taskCommitButton').textContent = job.committedToDataCenter
        ? '已加入数据中心商品表'
        : '加到数据中心商品表';
    }
    if ($('storeExportButton')) $('storeExportButton').disabled = active || currentPageType !== 'account' || !hasCurrentStoreData();
    if ($('storeCommitButton')) $('storeCommitButton').disabled = active || currentPageType !== 'account' || !pendingCurrentStoreProfile || currentStoreCommitted;

    const progress = job.type === 'links'
      ? `详情链接 ${Math.min(Number(job.index || 0), job.links?.length || 0)}/${job.links?.length || 0}，成功 ${job.collected || 0} 条`
      : `详情页 ${job.visited || 0}/${job.targetCount || 0}，成功 ${job.collected || 0} 条，搜索页 ${job.pagesProcessed || 0}/${job.maxPages || 0}`;
    const failures = job.failures?.length ? `，失败 ${job.failures.length} 个` : '';
    const sellerFailures = job.sellerFailures?.length ? `，店铺资料失败 ${job.sellerFailures.length} 个` : '';
    $('jobStatus').textContent = `${job.message || '任务处理中'}（${progress}${failures}${sellerFailures}）`;
    $('taskCountText').textContent = progress;
    $('taskModeText').textContent = job.mode === 'api' ? 'API 模式' : '页面详情模式';
    $('taskTypeText').textContent = job.type === 'links' ? `商品详情 · ${job.links?.length || 0} 个` : `搜索详情 · ${job.targetCount || 0} 条`;
    $('taskCreatedText').textContent = formatDate(job.createdAt);
    $('taskStateText').textContent = stateText;
    $('taskFilterText').textContent = failures || sellerFailures ? `已记录${failures}${sellerFailures}` : '当前未进行任何筛选';
    $('homeTaskHint').textContent = `${stateText} · ${job.collected || 0} 条成功记录`;
    $('currentState').textContent = active ? '任务运行中' : stateText;
    setPageButtons(Boolean(activeTab && isGoofishUrl(activeTab.url || '')));
    $('collectButton').disabled = active;

    const isNewJob = job.id && job.id !== lastJobId;
    lastJobId = job.id || '';
    if (active && currentScreen !== 'task' && isNewJob) showScreen('task');

    const terminalKey = `${job.id}:${job.status}:${job.updatedAt}:${job.autoExportStatus || ''}:${job.committedToDataCenter ? 'committed' : ''}`;
    if (!active && terminalKey !== lastTerminalKey) {
      lastTerminalKey = terminalKey;
      const kind = job.status === 'completed' ? 'success' : job.status === 'failed' ? 'error' : '';
      setStatus(job.message || `任务${stateText}。`, kind);
      void refreshCount().catch(() => {});
      void refreshHistory().catch(() => {});
    }
  }

  async function refreshJob() {
    const response = await sendRuntime({ type: 'GET_JOB_STATUS' });
    if (!response?.ok) throw new Error(response?.error || '读取任务状态失败');
    renderJob(response.job);
  }

  async function collectCurrentPage() {
    if (!activeTab?.id) return;
    const button = $('collectButton');
    button.disabled = true;
    button.textContent = selectedMode === 'api' ? '正在读取公开接口…' : '正在读取页面…';
    setStatus(`正在使用${modeLabel()}整理当前详情…`);

    try {
      const page = await sendToTabWithRecovery(activeTab.id, { type: 'GET_PAGE_INFO' });
      if (!page?.ok || page.pageType !== 'detail') {
        throw new Error('当前是搜索页。请打开商品详情页，或使用“搜索跨页”自动逐个采集。');
      }
      clearCurrentResult();
      const result = await sendToTabWithRecovery(activeTab.id, {
        type: selectedMode === 'api' ? 'START_API_CAPTURE' : 'COLLECT_CURRENT_PAGE',
        persistToDataCenter: false
      }, 35_000);
      if (!result?.ok) throw new Error(result?.error || '采集失败');
      pendingCurrentItems = (Array.isArray(result.items)
        ? result.items
        : Array.isArray(result.stagedItems) ? result.stagedItems : [])
        .filter(Boolean);
      pendingCurrentSourceUrl = activeTab.url || '';
      currentItemsCommitted = false;
      const count = pendingCurrentItems.length;
      if (count > 0) {
        let enrichedCount = 0;
        for (const item of [...pendingCurrentItems]) {
          if (!item || (!item.itemId && !item.itemUrl)) continue;
          setStatus('商品详情已读取，正在进入卖家店铺页补充基础公开资料…');
          try {
            const enrichment = await sendRuntime({
              type: 'ENRICH_SINGLE_ITEM',
              item,
              tabId: activeTab.id,
              returnUrl: pendingCurrentSourceUrl || activeTab.url || ''
            });
            if (enrichment?.item) {
              pendingCurrentItems = pendingCurrentItems.map(candidate => (
                (candidate.itemId && candidate.itemId === enrichment.item.itemId)
                  || (candidate.itemUrl && candidate.itemUrl === enrichment.item.itemUrl)
                  ? enrichment.item
                  : candidate
              ));
              if (enrichment.enriched) enrichedCount += 1;
            }
          } catch (_) {
            // 商品详情结果仍然保留；店铺补充失败时提示用户用“当前店铺页”完整采集。
          }
        }
        renderCurrentResultActions();
        $('currentCollectHint').textContent = `当前详情页采集完成：${count} 条商品结果已暂存${enrichedCount ? `，已补充 ${enrichedCount} 个店铺基础资料` : ''}。请选择“加到数据中心商品表”或“导出当前详情页”；完整店铺评价请单独进入店铺页采集。`;
        setStatus(`当前详情页采集完成：${count} 条结果已暂存${enrichedCount ? `，店铺资料已补充 ${enrichedCount} 个` : ''}，等待你选择加入总表或单独导出。`, 'success');
      }
      else if (Number(result.count ?? result.added ?? 0) > 0) {
        throw new Error('页面声称采集成功，但没有返回可导出的商品行；本次不再显示假成功，请刷新页面后重试。');
      }
      else if (selectedMode === 'api') setStatus('页面没有捕获到可识别的公开详情接口；可以切换页面详情模式重试。', 'error');
      else setStatus('当前页面暂未识别到商品，请等待加载或滚动后重试。', 'error');
    } catch (error) {
      setStatus(error.message || '采集失败，请刷新闲鱼页面后重试。', 'error');
    } finally {
      button.disabled = false;
      button.textContent = '采集当前详情页';
      await refreshCurrentPage().catch(() => {});
      renderCurrentResultActions();
    }
  }

  async function commitCurrentItems() {
    if (!pendingCurrentItems.length) {
      setStatus('当前没有可加入数据中心的详情页结果。', 'error');
      return;
    }
    const button = $('currentCommitButton');
    if (button) button.disabled = true;
    try {
      const response = await sendRuntime({
        type: 'COMMIT_ITEMS',
        items: pendingCurrentItems,
        sourcePage: pendingCurrentSourceUrl
      });
      if (!response?.ok) throw new Error(response?.error || '加入数据中心失败');
      currentItemsCommitted = true;
      renderCurrentResultActions();
      await refreshCount();
      setStatus(`已将当前详情页 ${response.count || pendingCurrentItems.length} 条结果加入数据中心商品表；新增 ${response.added || 0} 条。`, 'success');
      $('currentCollectHint').textContent = '当前结果已经加入数据中心商品总表；仍可以点击“导出当前详情页”单独下载这一条结果。';
    } catch (error) {
      if (button) button.disabled = false;
      setStatus(error.message || '加入数据中心失败。', 'error');
    }
  }

  async function exportCurrentItems() {
    if (!pendingCurrentItems.length) {
      setStatus('当前没有可导出的详情页结果。', 'error');
      return;
    }
    const button = $('currentExportButton');
    if (button) {
      button.disabled = true;
      button.textContent = '正在生成 Excel…';
    }
    try {
      const response = await sendRuntime({
        type: 'EXPORT_ITEMS',
        taskType: 'detail',
        mode: selectedMode,
        items: pendingCurrentItems
      });
      if (!response?.ok) throw new Error(response?.error || '当前详情页导出失败');
      const result = response.result || {};
      setStatus(`当前详情页 Excel 已下载：${result.itemCount || pendingCurrentItems.length} 条商品，${result.embedded || 0} 张图片已嵌入。`, result.failed ? '' : 'success');
    } catch (error) {
      setStatus(error.message || '当前详情页导出失败。', 'error');
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = '导出当前详情页';
      }
    }
  }

  async function collectCurrentStorePage() {
    if (!activeTab?.id) return;
    const button = $('storeCollectButton');
    const hadHistory = Boolean(currentStoreStatus?.exists);
    button.disabled = true;
    button.textContent = '正在加载全部公开评价…';
    $('storeCollectHint').textContent = '正在读取店铺资料并滚动评价区域，请保持当前店铺页打开。';
    setStatus('正在采集当前店铺页的公开资料、评价和评价图片…');

    try {
      const page = await sendToTabWithRecovery(activeTab.id, { type: 'GET_PAGE_INFO' });
      if (!page?.ok || page.pageType !== 'account') {
        throw new Error('当前不是闲鱼店铺/账号页，请先打开卖家账号页。');
      }
      const result = await sendToTabWithRecovery(activeTab.id, {
        type: 'COLLECT_CURRENT_STORE_PAGE',
        persistToDataCenter: false
      }, 55_000);
      if (!result?.ok) throw new Error(result?.error || '店铺页采集失败');
      pendingCurrentStoreProfile = result.profile || null;
      pendingCurrentStoreSourceUrl = activeTab.url || '';
      currentStoreCommitted = false;
      const reviewCount = Number(result.reviewCount || result.reviewCountLoaded || result.reviews?.length || 0);
      renderStoreStatus('account', currentStoreStatus);
      setStatus(`${hadHistory ? '当前店铺页重新采集完成' : '当前店铺页首次采集完成'}：本次暂存 1 份店铺资料，读取 ${reviewCount} 条公开评价；现在可以直接下载或加入店铺表。`, 'success');
      $('storeCollectHint').textContent = `本次已读取 ${reviewCount} 条评价，结果已暂存。下载文件包含“店铺资料”和“店铺评价综合”两张表，评价图片会嵌入对应评价行；可以直接下载，也可以加入数据中心店铺表。`;
    } catch (error) {
      setStatus(error.message || '店铺页采集失败，请刷新账号页后重试。', 'error');
      $('storeCollectHint').textContent = '如果评价区仍在加载，请停留几秒后重试。';
    } finally {
      button.disabled = false;
      button.textContent = '采集当前店铺页';
      await refreshCurrentPage().catch(() => {});
      renderStoreStatus(currentPageType, currentStoreStatus);
    }
  }

  async function commitCurrentStore() {
    if (!pendingCurrentStoreProfile) {
      setStatus('当前没有可加入数据中心的店铺采集结果。', 'error');
      return;
    }
    const button = $('storeCommitButton');
    if (button) button.disabled = true;
    try {
      const response = await sendRuntime({
        type: 'COMMIT_STORE_PROFILE',
        profile: pendingCurrentStoreProfile,
        sourcePage: pendingCurrentStoreSourceUrl
      });
      if (!response?.ok) throw new Error(response?.error || '加入数据中心店铺表失败');
      currentStoreCommitted = true;
      await Promise.all([refreshCount(), refreshCurrentPage()]);
      setStatus(`已将当前店铺加入数据中心店铺表；本次包含 ${response.reviewCount || pendingCurrentStoreProfile.reviews?.length || 0} 条评价。`, 'success');
      $('storeCollectHint').textContent = '本次店铺资料、评价和评价图片已经加入数据中心店铺表；仍可以直接下载本次结果。';
    } catch (error) {
      if (button) button.disabled = false;
      setStatus(error.message || '加入数据中心店铺表失败。', 'error');
    }
  }

  function diagnosticJson(value) {
    return JSON.stringify(value ?? null, null, 2);
  }

  function diagnosticFilePart(value, fallback = '页面') {
    const cleaned = String(value || fallback)
      .replace(/[\\/:*?"<>|]+/g, '_')
      .replace(/\s+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^[_\.\-]+|[_\.\-]+$/g, '')
      .slice(0, 80);
    return cleaned || fallback;
  }

  function dataUrlToBytes(dataUrl) {
    const base64 = String(dataUrl || '').split(',')[1] || '';
    if (!base64 || typeof atob !== 'function') return new Uint8Array();
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }

  function downloadBlob(blob, filename, saveAs = true) {
    const url = URL.createObjectURL(blob);
    return new Promise((resolve, reject) => {
      chrome.downloads.download({ url, filename, saveAs }, id => {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message));
        else resolve(id);
      });
    }).finally(() => {
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    });
  }

  async function exportDiagnosticPackage() {
    if (!activeTab?.id || !isGoofishUrl(activeTab.url || '')) {
      setStatus('请先打开闲鱼详情页或搜索页，再导出诊断包。', 'error');
      return;
    }

    const button = $('diagnosticButton');
    button.disabled = true;
    button.textContent = '正在提取当前页面…';
    setStatus('正在自动提取实时 DOM、图片、链接和公开接口响应…');

    try {
      const snapshot = await sendToTabWithRecovery(activeTab.id, { type: 'GET_PAGE_SNAPSHOT' });
      if (!snapshot?.ok) throw new Error(snapshot?.error || '页面样本提取失败');

      let screenshot = '';
      try {
        screenshot = await chrome.tabs.captureVisibleTab(activeTab.windowId, { format: 'png' });
      } catch (_) {
        // 某些浏览器/窗口不允许扩展截取当前页，诊断包仍然可以正常生成。
      }

      const capturedAt = snapshot.capturedAt || new Date().toISOString();
      const files = [
        {
          name: 'README.txt',
          data: [
            '这是由闲鱼公开商品研究采集器自动生成的页面诊断包。',
            '包含当前动态 DOM、可见文字、链接、图片地址、当前字段解析快照和经过字段脱敏的公开接口响应。',
            '请在上传前快速检查是否包含你不希望分享的昵称、地址或其它个人信息。',
            `生成时间：${capturedAt}`
          ].join('\n')
        },
        {
          name: 'page-info.json',
          data: diagnosticJson({
            ...snapshot.page,
            capturedAt,
            normalizedItemCount: snapshot.normalizedItems?.length || 0,
            networkResponseCount: snapshot.networkResponseCount || 0
          })
        },
        { name: 'live-dom.html', data: snapshot.html || '' },
        { name: 'visible-text.txt', data: snapshot.visibleText || '' },
        { name: 'links.json', data: diagnosticJson(snapshot.links || []) },
        { name: 'image-urls.json', data: diagnosticJson(snapshot.images || []) },
        { name: 'normalized-items.json', data: diagnosticJson(snapshot.normalizedItems || []) },
        { name: 'account-profile.json', data: diagnosticJson(snapshot.accountProfile || {}) },
        { name: 'network-responses.json', data: diagnosticJson(snapshot.networkResponses || []) }
      ];
      if (screenshot) files.push({ name: 'screenshot.png', data: dataUrlToBytes(screenshot) });

      const blob = window.XianyuDiagnostic.createZip(files);
      const date = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const pageKind = snapshot.page?.pageType === 'detail'
        ? '详情页'
        : snapshot.page?.pageType === 'account' ? '账号页' : '搜索页';
      const filename = `闲鱼研究采集/页面诊断-${diagnosticFilePart(pageKind)}-${date}.zip`;
      await downloadBlob(blob, filename, true);

      const suffix = snapshot.page?.htmlTruncated ? '（DOM 较大，已按上限截取）' : '';
      setStatus(`页面诊断包已下载${suffix}，请直接把 ZIP 上传给我。`, 'success');
    } catch (error) {
      setStatus(error.message || '诊断包生成失败，请刷新闲鱼页面后重试。', 'error');
    } finally {
      button.disabled = false;
      button.textContent = '一键导出页面诊断包';
    }
  }

  function parseProductLinks(value) {
    return [...new Set(String(value || '')
      .split(/[\s,]+/)
      .map(text => text.trim())
      .filter(Boolean)
      .filter(isGoofishUrl))];
  }

  async function startLinkBatch() {
    const links = parseProductLinks($('linkInput').value);
    if (!links.length) {
      setStatus('请先粘贴至少一个有效的闲鱼商品详情链接。', 'error');
      showScreen('links');
      return;
    }
    try {
      const response = await sendRuntime({ type: 'START_BATCH_LINKS', links, mode: selectedMode, delayMs: 1800 });
      if (!response?.ok) throw new Error(response?.error || '启动链接批量采集失败');
      $('linkInput').value = '';
      setStatus(`已启动 ${links.length} 个链接的自动详情采集。`, 'success');
      showScreen('task');
      await refreshJob();
    } catch (error) {
      setStatus(error.message || '启动批量采集失败。', 'error');
      await refreshJob().catch(() => {});
    }
  }

  async function startSearchCrawl() {
    if (!activeTab?.id || !isGoofishUrl(activeTab.url || '')) {
      setStatus('请先打开闲鱼搜索结果页。', 'error');
      return;
    }
    if ($('pageType').textContent !== '搜索页') {
      setStatus('当前不是搜索结果页，请切换到搜索结果页后再启动跨页采集。', 'error');
      return;
    }
    const targetCount = Math.max(1, Number($('targetCount').value || 0));
    const maxPages = Math.max(1, Number($('maxPages').value || 0));
    try {
      const response = await sendRuntime({
        type: 'START_SEARCH_CRAWL',
        startUrl: activeTab.url,
        targetCount,
        maxPages,
        mode: selectedMode,
        delayMs: 2200
      });
      if (!response?.ok) throw new Error(response?.error || '启动搜索跨页采集失败');
      setStatus(`已启动自动跨页采集：目标 ${targetCount} 条，最多 ${maxPages} 页。`, 'success');
      showScreen('task');
      await refreshJob();
    } catch (error) {
      setStatus(error.message || '启动跨页采集失败。', 'error');
      await refreshJob().catch(() => {});
    }
  }

  async function stopJob() {
    try {
      const response = await sendRuntime({ type: 'STOP_JOB' });
      if (!response?.ok) throw new Error(response?.error || '停止任务失败');
      setStatus('任务已停止，已经采集的数据仍保留在本机。', 'success');
      await refreshJob();
    } catch (error) {
      setStatus(error.message || '停止任务失败。', 'error');
    }
  }

  async function exportItems(button = $('exportButton')) {
    const isCurrentStoreExport = button.id === 'storeExportButton';
    const isStoreExport = isCurrentStoreExport || button.id === 'storeDataExportButton';
    const idleLabel = isCurrentStoreExport ? '立即下载店铺 Excel' : button.id === 'storeDataExportButton' ? '下载店铺资料+评价 Excel' : '下载商品表 Excel';
    button.disabled = true;
    button.textContent = '正在生成 Excel…';
    setStatus('正在下载图片并生成包含真实图片的 Excel…');
    try {
      const response = await sendRuntime({
        type: 'EXPORT_ITEMS',
        mode: selectedMode,
        taskType: isStoreExport ? 'store' : 'data',
        sellerUrl: isCurrentStoreExport
          ? (pendingCurrentStoreProfile?.sellerUrl || pendingCurrentStoreSourceUrl || activeTab?.url || '')
          : undefined,
        storeProfiles: isCurrentStoreExport && pendingCurrentStoreProfile
          ? [pendingCurrentStoreProfile]
          : undefined
      });
      if (!response?.ok) throw new Error(response?.error || '导出失败');
      const result = response.result || {};
      const details = `${result.embedded || 0} 张图片已嵌入${result.failed ? `，${result.failed} 张下载失败` : ''}`;
      if (isStoreExport) {
      setStatus(`店铺资料和店铺评价 Excel 已下载：${result.storeCount || 0} 个店铺、${result.reviewCount || 0} 条评价；评价图片与评价已合并在同一张表，${details}。`, result.failed ? '' : 'success');
      if (isCurrentStoreExport && $('storeCollectHint')) {
          $('storeCollectHint').textContent = `店铺 Excel 已下载：打开“店铺资料”查看店铺字段，打开“店铺评价综合”查看评价和对应图片；本次共 ${result.reviewCount || 0} 条评价、${result.embedded || 0} 张嵌入图片。`;
        }
      } else {
        setStatus(`已下载 ${result.itemCount || 0} 条记录；${details}。`, result.failed ? '' : 'success');
      }
      await refreshHistory().catch(() => {});
    } catch (error) {
      setStatus(error.message || '导出失败，请稍后重试。', 'error');
    } finally {
      button.disabled = isCurrentStoreExport
        ? (currentPageType !== 'account' || !hasCurrentStoreData())
        : button.id === 'storeDataExportButton'
          ? !storeDataReady
          : false;
      button.textContent = idleLabel;
    }
  }

  async function exportTaskResult() {
    const job = currentTaskJob;
    if (!job?.id || jobIsActive(job)) {
      setStatus('任务仍在处理中，完成后才能导出本次商品数据。', 'warning');
      return;
    }
    const button = $('taskExportButton');
    button.disabled = true;
    button.textContent = '正在生成 Excel…';
    setStatus('正在下载本次任务图片并生成独立商品 Excel…');
    try {
      const response = await sendRuntime({ type: 'EXPORT_JOB_RESULT', jobId: job.id });
      if (!response?.ok) throw new Error(response?.error || '本次任务导出失败');
      const result = response.result || {};
      setStatus(`本次任务商品 Excel 已下载：${result.itemCount || 0} 条商品，${result.embedded || 0} 张图片已嵌入。`, result.failed ? '' : 'success');
      await refreshHistory().catch(() => {});
    } catch (error) {
      setStatus(error.message || '本次任务导出失败。', 'error');
    } finally {
      button.disabled = !(job.stagedItems?.length || job.collected);
      button.textContent = '导出本次商品数据';
    }
  }

  async function commitTaskResult() {
    const job = currentTaskJob;
    if (!job?.id || jobIsActive(job)) {
      setStatus('任务完成后才能加入数据中心商品表。', 'warning');
      return;
    }
    if (!Array.isArray(job.stagedItems) || !job.stagedItems.length) {
      setStatus('当前任务没有可加入数据中心的商品结果。', 'error');
      return;
    }
    const button = $('taskCommitButton');
    button.disabled = true;
    try {
      const response = await sendRuntime({ type: 'COMMIT_JOB_RESULT', jobId: job.id });
      if (!response?.ok) throw new Error(response?.error || '加入数据中心失败');
      setStatus(`已将本次任务 ${response.count || job.stagedItems.length} 条商品加入数据中心商品表；新增 ${response.added || 0} 条。`, 'success');
      await Promise.all([refreshCount(), refreshJob()]);
    } catch (error) {
      button.disabled = false;
      setStatus(error.message || '加入数据中心失败。', 'error');
    }
  }

  async function clearItems() {
    if (!confirm('确定清空当前已采集数据吗？历史任务不会被删除。')) return;
    const response = await sendRuntime({ type: 'CLEAR_ITEMS' });
    if (!response?.ok) throw new Error(response?.error || '清空失败');
    await refreshCount();
    setStatus('当前数据已清空，历史任务仍然保留。', 'success');
  }

  function formatDate(value) {
    const time = Date.parse(value || '');
    if (!time) return '时间未知';
    return new Date(time).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  }

  function historyType(entry) {
    return entry.type === 'links' ? '链接批量' : '搜索跨页';
  }

  async function refreshHistory() {
    const response = await sendRuntime({ type: 'GET_HISTORY' });
    if (!response?.ok) throw new Error(response?.error || '读取历史失败');
    const list = $('historyList');
    list.replaceChildren();
    const history = Array.isArray(response.history) ? response.history.slice(0, 8) : [];
    if (!history.length) {
      const empty = document.createElement('p');
      empty.className = 'empty-state';
      empty.textContent = '还没有完成的任务。';
      list.append(empty);
      return;
    }

    for (const entry of history) {
      const card = document.createElement('article');
      card.className = 'history-item';
      const title = document.createElement('div');
      title.className = 'history-title';
      const heading = document.createElement('strong');
      heading.textContent = `${historyType(entry)} · ${entry.mode === 'api' ? '接口观察' : '页面详情'}`;
      const status = document.createElement('span');
      status.className = 'summary-state';
      status.textContent = entry.status === 'completed' ? '完成' : entry.status === 'stopped' ? '停止' : '失败';
      title.append(heading, status);
      const meta = document.createElement('p');
      meta.className = 'history-meta';
      meta.textContent = `${formatDate(entry.completedAt)} · 成功 ${entry.collected || 0} 条 · 失败 ${(entry.failures || []).length} 条`;
      const actions = document.createElement('div');
      actions.className = 'history-actions';
      const exportButton = document.createElement('button');
      exportButton.type = 'button';
      exportButton.textContent = '重新导出';
      exportButton.addEventListener('click', () => exportHistory(entry.id, exportButton));
      const deleteButton = document.createElement('button');
      deleteButton.type = 'button';
      deleteButton.className = 'delete';
      deleteButton.textContent = '删除';
      deleteButton.addEventListener('click', () => deleteHistory(entry.id));
      actions.append(exportButton, deleteButton);
      card.append(title, meta, actions);
      list.append(card);
    }
  }

  async function exportHistory(id, button) {
    button.disabled = true;
    button.textContent = '生成中…';
    try {
      const response = await sendRuntime({ type: 'EXPORT_HISTORY', id });
      if (!response?.ok) throw new Error(response?.error || '历史导出失败');
      setStatus(`历史任务已重新导出：${response.result?.filename || 'Excel 文件'}。`, 'success');
    } catch (error) {
      setStatus(error.message || '历史导出失败。', 'error');
    } finally {
      button.disabled = false;
      button.textContent = '重新导出';
    }
  }

  async function deleteHistory(id) {
    if (!confirm('确定删除这条历史任务吗？')) return;
    const response = await sendRuntime({ type: 'DELETE_HISTORY', id });
    if (!response?.ok) throw new Error(response?.error || '删除历史失败');
    await refreshHistory();
    setStatus('历史任务已删除。', 'success');
  }

  function renderSettings() {
    $('downloadAuto').checked = settings.downloadMode === 'auto';
    $('downloadManual').checked = settings.downloadMode !== 'auto';
    $('downloadFolder').value = settings.downloadFolder || '';
    $('fileNameTemplate').value = settings.fileNameTemplate || '';
    $('imageLimit').value = String(settings.imageLimit ?? 0);
    $('maxEmbedImages').value = String(settings.maxEmbedImages ?? 1000);
    $('collectSellerInfo').checked = settings.collectSellerInfo !== false;
    $('saveAs').checked = Boolean(settings.saveAs);
    $('notifyOnComplete').checked = settings.notifyOnComplete !== false;
    setMode(settings.mode || 'rpa', false);
  }

  async function loadSettings() {
    const response = await sendRuntime({ type: 'GET_SETTINGS' });
    if (!response?.ok) throw new Error(response?.error || '读取设置失败');
    settings = { ...DEFAULT_SETTINGS, ...(response.settings || {}) };
    renderSettings();
  }

  async function saveSettings() {
    const next = {
      ...settings,
      mode: selectedMode,
      downloadMode: $('downloadAuto').checked ? 'auto' : 'manual',
      downloadFolder: $('downloadFolder').value,
      fileNameTemplate: $('fileNameTemplate').value,
      imageLimit: Number($('imageLimit').value || 0),
      maxEmbedImages: Number($('maxEmbedImages').value || 1000),
      collectSellerInfo: $('collectSellerInfo').checked,
      saveAs: $('saveAs').checked,
      notifyOnComplete: $('notifyOnComplete').checked
    };
    const response = await sendRuntime({ type: 'SAVE_SETTINGS', settings: next });
    if (!response?.ok) throw new Error(response?.error || '保存设置失败');
    settings = { ...settings, ...(response.settings || next) };
    renderSettings();
    setStatus('下载设置已保存；下一个任务会使用新设置。', 'success');
  }

  function bindEvents() {
    $('settingsJump').addEventListener('click', () => showScreen('settings'));
    $('pageContextJump').addEventListener('click', () => showScreen(currentPageType === 'account' ? 'store' : 'detail'));
    $('backButton').addEventListener('click', () => goBack());
    document.querySelectorAll('[data-open-screen]').forEach(button => {
      button.addEventListener('click', () => showScreen(button.dataset.openScreen));
    });
    document.querySelector('[data-action="diagnostic"]')?.addEventListener('click', () => {
      showScreen('detail');
      void exportDiagnosticPackage();
    });
    $('modeRpa').addEventListener('click', () => setMode('rpa'));
    $('modeApi').addEventListener('click', () => setMode('api'));
    $('collectButton').addEventListener('click', () => collectCurrentPage());
    $('currentCommitButton').addEventListener('click', () => commitCurrentItems());
    $('currentExportButton').addEventListener('click', () => exportCurrentItems());
    $('storeCollectButton').addEventListener('click', () => collectCurrentStorePage());
    $('storeCommitButton').addEventListener('click', () => commitCurrentStore());
    $('storeExportButton').addEventListener('click', () => exportItems($('storeExportButton')).catch(error => setStatus(error.message, 'error')));
    $('storeDataButton').addEventListener('click', () => { setDataTab('stores'); showScreen('data'); });
    $('diagnosticButton').addEventListener('click', () => exportDiagnosticPackage());
    $('batchLinkButton').addEventListener('click', () => startLinkBatch());
    $('searchCrawlButton').addEventListener('click', () => startSearchCrawl());
    $('stopJobButton').addEventListener('click', () => stopJob());
    $('exportButton').addEventListener('click', () => exportItems($('exportButton')).catch(error => setStatus(error.message, 'error')));
    $('storeDataExportButton').addEventListener('click', () => exportItems($('storeDataExportButton')).catch(error => setStatus(error.message, 'error')));
    $('taskExportButton').addEventListener('click', () => exportTaskResult().catch(error => setStatus(error.message, 'error')));
    $('taskCommitButton').addEventListener('click', () => commitTaskResult().catch(error => setStatus(error.message, 'error')));
    $('taskDataButton').addEventListener('click', () => { setDataTab('products'); showScreen('data'); });
    $('clearButton').addEventListener('click', () => clearItems().catch(error => setStatus(error.message, 'error')));
    $('dataProductsTab').addEventListener('click', () => setDataTab('products'));
    $('dataStoresTab').addEventListener('click', () => setDataTab('stores'));
    document.querySelectorAll('[data-open-data-tab]').forEach(button => {
      button.addEventListener('click', () => setDataTab(button.dataset.openDataTab));
    });
    $('saveSettingsButton').addEventListener('click', () => saveSettings().catch(error => setStatus(error.message, 'error')));
    $('linkInput').addEventListener('input', () => {
      const links = parseProductLinks($('linkInput').value);
      $('linkCount').textContent = `${links.length} 个链接`;
    });
    $('openDownloadSettings').addEventListener('click', () => {
      void chrome.tabs.create({ url: 'chrome://settings/downloads' }).catch(error => {
        setStatus(error.message || '无法打开 Chrome 下载设置。', 'error');
      });
    });

    chrome.tabs.onActivated.addListener(() => void refreshCurrentPage().catch(() => {}));
    chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
      if (activeTab?.id === tabId && (changeInfo.status === 'complete' || changeInfo.url)) {
        void refreshCurrentPage().catch(() => {});
      }
    });
  }

  document.addEventListener('DOMContentLoaded', async () => {
    bindEvents();
    updateScreenChrome('home');
    try {
      await loadSettings();
      await Promise.all([refreshCurrentPage(), refreshCount(), refreshHistory(), refreshJob()]);
    } catch (error) {
      setStatus(error.message || '插件初始化失败，请刷新侧边栏重试。', 'error');
    }

    const pollTimer = setInterval(() => {
      void refreshJob().catch(() => {});
      void refreshCount().catch(() => {});
    }, 1000);
    window.addEventListener('unload', () => clearInterval(pollTimer), { once: true });
  });
})();
