(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  let activeTab = null;

  function isGoofishUrl(url) {
    try { return new URL(url).hostname.endsWith('goofish.com'); } catch (_) { return false; }
  }

  function setStatus(message, kind = '') {
    const node = $('status');
    node.textContent = message;
    node.className = `status ${kind}`.trim();
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

  function sendToTab(tabId, message) {
    return new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(tabId, message, response => {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message));
        else resolve(response);
      });
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

  async function sendToTabWithRecovery(tabId, message) {
    try {
      return await sendToTab(tabId, message);
    } catch (firstError) {
      // 处理插件刚加载、旧标签页未刷新导致的“Receiving end does not exist”。
      await executeScript({
        target: { tabId },
        world: 'MAIN',
        files: ['main-world.js']
      }).catch(() => {});
      await executeScript({
        target: { tabId },
        world: 'ISOLATED',
        files: ['image-utils.js', 'content.js']
      });
      try {
        return await sendToTab(tabId, message);
      } catch (secondError) {
        throw new Error(secondError?.message || firstError?.message || '无法连接当前闲鱼页面');
      }
    }
  }

  async function refreshCount() {
    const response = await sendRuntime({ type: 'GET_STATUS' });
    if (!response?.ok) throw new Error(response?.error || '读取数据数量失败');
    $('itemCount').textContent = response.count;
  }

  async function refreshCurrentTab() {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    activeTab = tabs[0] || null;
    const supported = Boolean(activeTab && isGoofishUrl(activeTab.url || ''));
    const badge = $('siteBadge');
    const button = $('collectButton');

    if (!supported) {
      badge.textContent = '请打开闲鱼';
      badge.className = 'badge warn';
      $('pageTitle').textContent = '当前标签页不是 goofish.com';
      $('pageType').textContent = '不可用';
      button.disabled = true;
      return;
    }

    badge.textContent = '闲鱼页面';
    badge.className = 'badge ok';
    button.disabled = false;
    $('pageTitle').textContent = activeTab.title || activeTab.url;

    try {
      const page = await sendToTabWithRecovery(activeTab.id, { type: 'GET_PAGE_INFO' });
      if (page?.ok) {
        $('pageTitle').textContent = page.title || activeTab.url;
        $('pageType').textContent = page.pageType === 'detail' ? '详情页' : page.pageType === 'account' ? '账号页' : '搜索页';
      }
    } catch (_) {
      $('pageType').textContent = '待采集';
    }
  }

  async function collectCurrentPage() {
    if (!activeTab?.id) return;
    const button = $('collectButton');
    button.disabled = true;
    button.textContent = '正在读取页面…';
    setStatus('正在整理当前页面的公开信息…');

    try {
      const page = await sendToTabWithRecovery(activeTab.id, { type: 'GET_PAGE_INFO' });
      if (!page?.ok || page.pageType !== 'detail') {
        setStatus('当前是搜索页。请使用“逐个打开详情页并跨页采集”，或先打开一个商品详情页。', 'error');
        return;
      }
      const result = await sendToTabWithRecovery(activeTab.id, { type: 'COLLECT_CURRENT_PAGE' });
      if (!result?.ok) throw new Error(result?.error || '采集失败');
      await refreshCount();
      const count = result.count ?? result.added ?? 0;
      setStatus(count ? `本次识别 ${count} 条，已合并到本机数据。` : '当前页面暂未识别到商品，请先等待页面加载或滚动后重试。', count ? 'success' : '');
    } catch (error) {
      setStatus(error.message || '采集失败，请刷新闲鱼页面后重试。', 'error');
    } finally {
      button.disabled = false;
      button.textContent = '采集当前详情页';
    }
  }

  async function clearItems() {
    if (!confirm('确定清空本机已采集的数据吗？此操作不可从插件内恢复。')) return;
    const response = await sendRuntime({ type: 'CLEAR_ITEMS' });
    if (!response?.ok) throw new Error(response?.error || '清空失败');
    await refreshCount();
    setStatus('本机数据已清空。', 'success');
  }

  function fileName() {
    const date = new Date().toISOString().slice(0, 10);
    return `闲鱼商品研究-${date}.xlsx`;
  }

  const MAX_EMBED_IMAGES = 1000;
  const MAX_IMAGE_SIDE = 1600;
  const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

  function itemKey(item) {
    if (item.itemId) return `id:${item.itemId}`;
    if (item.itemUrl) return `url:${item.itemUrl}`;
    return `text:${[item.title, item.sellerName, item.price].join('|')}`;
  }

  function cleanFilePart(value, fallback) {
    const cleaned = String(value || fallback || '')
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/\s+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^[_\.\-]+|[_\.\-]+$/g, '')
      .slice(0, 70);
    return cleaned || fallback || '未命名';
  }

  function imageFileName(item, imageIndex, extension) {
    const title = cleanFilePart(item.title, item.itemId || '商品');
    const seller = cleanFilePart(item.sellerName, '未知店铺');
    const id = item.itemId ? cleanFilePart(String(item.itemId).slice(-16), '') : '无ID';
    const sequence = String(imageIndex).padStart(2, '0');
    return `${title}_${seller}_${id}_图${sequence}.${extension || 'jpg'}`;
  }

  function mimeFromBytes(bytes, fallback = '', url = '') {
    if (bytes?.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
      return 'image/png';
    }
    if (bytes?.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
      return 'image/jpeg';
    }
    if (bytes?.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
      return 'image/gif';
    }
    if (bytes?.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP') {
      return 'image/webp';
    }
    if (String(fallback).toLowerCase().startsWith('image/')) return String(fallback).split(';')[0].toLowerCase();
    const extension = String(url).toLowerCase().match(/\.(jpg|jpeg|png|gif|webp)(?:[?#]|$)/)?.[1];
    return extension === 'png' ? 'image/png'
      : extension === 'gif' ? 'image/gif'
        : extension === 'webp' ? 'image/webp'
          : 'image/jpeg';
  }

  function extensionFromMime(mime) {
    if (mime === 'image/png') return 'png';
    if (mime === 'image/gif') return 'gif';
    return 'jpg';
  }

  function canvasToBlob(canvas, mime, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('图片格式转换失败')), mime, quality);
    });
  }

  async function decodeImageBlob(blob, sourceUrl) {
    const rawBytes = new Uint8Array(await blob.arrayBuffer());
    const sourceMime = mimeFromBytes(rawBytes, blob.type, sourceUrl);
    let width = 800;
    let height = 600;
    let bitmap = null;

    try {
      bitmap = await createImageBitmap(blob);
      width = bitmap.width || width;
      height = bitmap.height || height;
    } catch (_) {
      const supportedRaw = ['image/jpeg', 'image/png', 'image/gif'].includes(sourceMime);
      if (supportedRaw && rawBytes.length <= MAX_IMAGE_BYTES) {
        return {
          bytes: rawBytes,
          mime: sourceMime,
          extension: extensionFromMime(sourceMime),
          width,
          height
        };
      }
      throw new Error('浏览器无法解码该图片格式');
    }

    try {
      const supported = ['image/jpeg', 'image/png', 'image/gif'].includes(sourceMime);
      const withinLimit = width <= MAX_IMAGE_SIDE && height <= MAX_IMAGE_SIDE && rawBytes.length <= MAX_IMAGE_BYTES;
      if (supported && withinLimit) {
        return {
          bytes: rawBytes,
          mime: sourceMime,
          extension: extensionFromMime(sourceMime),
          width,
          height
        };
      }

      const scale = Math.min(1, MAX_IMAGE_SIDE / width, MAX_IMAGE_SIDE / height);
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      const context = canvas.getContext('2d');
      if (!context) throw new Error('无法创建图片画布');
      if (sourceMime !== 'image/png') {
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, canvas.width, canvas.height);
      }
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

      const outputMime = sourceMime === 'image/png' ? 'image/png' : 'image/jpeg';
      const outputBlob = await canvasToBlob(canvas, outputMime, 0.86);
      const outputBytes = new Uint8Array(await outputBlob.arrayBuffer());
      return {
        bytes: outputBytes,
        mime: outputMime,
        extension: extensionFromMime(outputMime),
        width: canvas.width,
        height: canvas.height
      };
    } finally {
      bitmap.close();
    }
  }

  async function downloadImage(sourceUrl) {
    const response = await fetch(sourceUrl, { credentials: 'omit', redirect: 'follow' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const blob = await response.blob();
    if (!blob.size) throw new Error('图片为空');
    return decodeImageBlob(blob, sourceUrl);
  }

  async function prepareImageAssets(items, perItemLimit) {
    const candidates = [];
    let totalAvailable = 0;

    for (const item of items) {
      const urls = [...new Set((Array.isArray(item.images) ? item.images : []).filter(Boolean))];
      totalAvailable += urls.length;
      const selected = perItemLimit > 0 ? urls.slice(0, perItemLimit) : urls;
      selected.forEach((url, index) => candidates.push({
        item,
        itemKey: itemKey(item),
        imageIndex: index + 1,
        url
      }));
    }

    const truncated = totalAvailable > MAX_EMBED_IMAGES;
    const jobs = candidates.slice(0, MAX_EMBED_IMAGES);
    if (!jobs.length) return { assets: [], requested: 0, truncated };

    const cache = new Map();
    const assets = new Array(jobs.length);
    let cursor = 0;
    let completed = 0;

    async function worker() {
      while (cursor < jobs.length) {
        const index = cursor++;
        const job = jobs[index];
        let imagePromise = cache.get(job.url);
        if (!imagePromise) {
          imagePromise = downloadImage(job.url).catch(error => ({
            error: error?.message || String(error)
          }));
          cache.set(job.url, imagePromise);
        }

        const image = await imagePromise;
        const extension = image.extension || 'jpg';
        assets[index] = {
          itemKey: job.itemKey,
          itemId: job.item.itemId || '',
          title: job.item.title || '',
          sellerName: job.item.sellerName || '',
          itemUrl: job.item.itemUrl || '',
          collectedAt: job.item.collectedAt || '',
          imageIndex: job.imageIndex,
          url: job.url,
          fileName: imageFileName(job.item, job.imageIndex, extension),
          ...(image.bytes ? image : { error: image.error || '下载失败' })
        };

        completed += 1;
        setStatus(`正在下载并处理图片 ${completed}/${jobs.length}…`);
      }
    }

    const workerCount = Math.min(4, jobs.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    return { assets, requested: jobs.length, truncated };
  }

  async function exportItems() {
    const button = $('exportButton');
    button.disabled = true;
    button.textContent = '正在下载图片…';
    try {
      const response = await sendRuntime({ type: 'GET_ITEMS' });
      if (!response?.ok) throw new Error(response?.error || '读取数据失败');
      if (!response.items?.length) {
        setStatus('还没有可导出的数据，请先采集一个详情页或启动批量详情采集。', 'error');
        return;
      }

      const perItemLimit = Number($('imageLimit').value || 0);
      const prepared = await prepareImageAssets(response.items, perItemLimit);
      setStatus('正在把真实图片写入 Excel…');
      const blob = window.XianyuXlsx.createWorkbook(response.items, prepared.assets);
      const url = URL.createObjectURL(blob);
      try {
        await chrome.downloads.download({ url, filename: fileName(), saveAs: true });
      } finally {
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      }

      const embedded = prepared.assets.filter(asset => asset.bytes?.length).length;
      const failed = prepared.assets.length - embedded;
      const suffix = [
        `${embedded} 张图片已嵌入`,
        failed ? `${failed} 张下载失败` : '',
        prepared.truncated ? `超过总计 ${MAX_EMBED_IMAGES} 张的图片未处理` : ''
      ].filter(Boolean).join('，');
      setStatus(`已导出 ${response.items.length} 条商品记录；${suffix || '没有图片可处理'}。`, failed ? '' : 'success');
    } finally {
      button.disabled = false;
      button.textContent = '导出 Excel（内嵌图片）';
    }
  }

  function parseProductLinks(value) {
    return [...new Set(String(value || '')
      .split(/[\s,]+/)
      .map(text => text.trim())
      .filter(Boolean)
      .filter(isGoofishUrl))];
  }

  function jobIsActive(job) {
    return Boolean(job && !['completed', 'stopped', 'failed'].includes(job.status));
  }

  async function refreshJob() {
    const response = await sendRuntime({ type: 'GET_JOB_STATUS' });
    if (!response?.ok) throw new Error(response?.error || '读取批量任务状态失败');

    const job = response.job;
    const badge = $('jobBadge');
    const stopButton = $('stopJobButton');
    const linkButton = $('batchLinkButton');
    const searchButton = $('searchCrawlButton');

    if (!job) {
      badge.textContent = '无任务';
      badge.className = 'page-type';
      $('jobStatus').textContent = '搜索页只用于发现商品链接，不会作为最终记录保存；插件会逐个打开详情页。每页约 40 条时，目标 100 条会跨约 3 页并访问 100 个详情页。';
      stopButton.disabled = true;
      linkButton.disabled = false;
      searchButton.disabled = !Boolean(activeTab && isGoofishUrl(activeTab.url || ''));
      return;
    }

    const active = jobIsActive(job);
    const typeText = job.type === 'links' ? '链接批量' : '搜索跨页';
    badge.textContent = active ? `${typeText}进行中` : (job.status === 'completed' ? '已完成' : '已停止');
    badge.className = active ? 'badge warn' : (job.status === 'completed' ? 'badge ok' : 'badge');
    stopButton.disabled = !active;
    linkButton.disabled = active;
    searchButton.disabled = active || !Boolean(activeTab && isGoofishUrl(activeTab.url || ''));

    const progress = job.type === 'links'
      ? `详情链接 ${Math.min(Number(job.index || 0), job.links?.length || 0)}/${job.links?.length || 0}，成功 ${job.collected || 0} 条`
      : `详情页 ${job.visited || 0}/${job.targetCount || 0}，成功 ${job.collected || 0} 条，搜索页 ${job.pagesProcessed || 0}/${job.maxPages || 0}`;
    const failures = job.failures?.length ? `，失败 ${job.failures.length} 个` : '';
    $('jobStatus').textContent = `${job.message || '任务处理中'}（${progress}${failures}）`;
  }

  async function startLinkBatch() {
    const links = parseProductLinks($('linkInput').value);
    if (!links.length) {
      setStatus('请先粘贴至少一个有效的闲鱼商品详情链接。', 'error');
      return;
    }

    try {
      const response = await sendRuntime({ type: 'START_BATCH_LINKS', links, delayMs: 1800 });
      if (!response?.ok) throw new Error(response?.error || '启动链接批量采集失败');
      $('linkInput').value = '';
      setStatus(`已启动 ${links.length} 个商品链接的批量采集。`, 'success');
      await refreshJob();
    } catch (error) {
      setStatus(error.message || '启动批量采集失败', 'error');
      await refreshJob().catch(() => {});
    }
  }

  async function startSearchCrawl() {
    if (!activeTab?.id || !isGoofishUrl(activeTab.url || '')) {
      setStatus('请先打开闲鱼搜索结果页。', 'error');
      return;
    }
    if ($('pageType').textContent === '详情页') {
      setStatus('当前是商品详情页，请切换到搜索结果页后再启动跨页采集。', 'error');
      return;
    }

    const targetCount = Math.max(1, Number($('targetCount').value || 0));
    const maxPages = Math.max(1, Number($('maxPages').value || 0));
    if (!targetCount || !maxPages) {
      setStatus('目标商品数和页数都必须大于 0。', 'error');
      return;
    }

    try {
      const response = await sendRuntime({
        type: 'START_SEARCH_CRAWL',
        startUrl: activeTab.url,
        targetCount,
        maxPages,
        delayMs: 2200
      });
      if (!response?.ok) throw new Error(response?.error || '启动搜索跨页采集失败');
      setStatus(`已启动跨页采集，目标 ${targetCount} 条、最多 ${maxPages} 页。`, 'success');
      await refreshJob();
    } catch (error) {
      setStatus(error.message || '启动跨页采集失败', 'error');
      await refreshJob().catch(() => {});
    }
  }

  async function stopJob() {
    try {
      const response = await sendRuntime({ type: 'STOP_JOB' });
      if (!response?.ok) throw new Error(response?.error || '停止任务失败');
      setStatus('批量任务已停止，已采集的数据仍保留在本机。', 'success');
      await refreshJob();
    } catch (error) {
      setStatus(error.message || '停止任务失败', 'error');
    }
  }

  document.addEventListener('DOMContentLoaded', async () => {
    $('collectButton').addEventListener('click', () => collectCurrentPage());
    $('exportButton').addEventListener('click', () => exportItems().catch(error => setStatus(error.message, 'error')));
    $('clearButton').addEventListener('click', () => clearItems().catch(error => setStatus(error.message, 'error')));
    $('batchLinkButton').addEventListener('click', () => startLinkBatch());
    $('searchCrawlButton').addEventListener('click', () => startSearchCrawl());
    $('stopJobButton').addEventListener('click', () => stopJob());

    try {
      await Promise.all([refreshCurrentTab(), refreshCount()]);
      await refreshJob();
    } catch (error) {
      setStatus(error.message || '插件初始化失败', 'error');
    }

    const jobPollTimer = setInterval(() => refreshJob().catch(() => {}), 1000);
    window.addEventListener('unload', () => clearInterval(jobPollTimer), { once: true });
  });
})();
