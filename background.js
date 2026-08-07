'use strict';

const STORAGE_KEY = 'xianyu_public_items_v1';
const STORE_PROFILES_KEY = 'xianyu_public_store_profiles_v1';
const JOB_KEY = 'xianyu_collect_job_v1';
const JOB_ALARM = 'xianyu_collect_job_alarm_v1';
const SETTINGS_KEY = 'xianyu_collect_settings_v1';
const HISTORY_KEY = 'xianyu_collect_history_v1';
const OFFSCREEN_PATH = 'offscreen.html';
const MAX_ITEMS = 2000;
const MAX_STORE_PROFILES = 200;
const MAX_STORE_REVIEWS = 1000;
const MAX_HISTORY = 50;

const DEFAULT_SETTINGS = Object.freeze({
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
});

const ARRAY_FIELDS = new Set(['images', 'reviewSamples']);
const ALLOWED_FIELDS = [
  'itemId',
  'title',
  'description',
  'price',
  'category',
  'images',
  'itemUrl',
  'sellerName',
  'sellerUrl',
  'sellerLocation',
  'sellerFollowers',
  'sellerFollowing',
  'sellerProductCount',
  'sellerIntro',
  'storeDuration',
  'reviewSummary',
  'itemGoodRate',
  'sellerReviewSummary',
  'sellerReviewCount',
  'reviewSamples',
  'publishedAt',
  'sourcePage',
  'dataSource',
  'collectedAt'
];

function cleanText(value, maxLength = 10000) {
  if (value === undefined || value === null) return '';
  return String(value)
    .replace(/\u0000/g, '')
    .replace(/\r\n/g, '\n')
    .trim()
    .slice(0, maxLength);
}

function rateText(value) {
  const text = cleanText(value, 200).replace(/\s+/g, ' ');
  const match = text.match(/(?:好评率|好评|positive\s*rate|praise\s*rate)?\s*[:：]?\s*(\d+(?:\.\d+)?)\s*%/i);
  if (!match) return '';
  const number = Number(match[1]);
  return Number.isFinite(number) && number >= 0 && number <= 100 ? `${match[1]}%` : '';
}

function publicIntroText(value, maxLength = 4000) {
  // 简介是用户自定义文本，纯数字也可能是合法简介；是否为简介必须由页面语义位置决定。
  return cleanText(value, maxLength);
}

function cleanUrl(value) {
  const url = cleanText(value, 2000);
  if (!url) return '';
  return url.startsWith('//') ? `https:${url}` : url;
}

function sanitizeItem(input, sourcePage = '') {
  if (!input || typeof input !== 'object') return null;

  const item = {};
  for (const field of ALLOWED_FIELDS) {
    if (!(field in input)) continue;

    if (ARRAY_FIELDS.has(field)) {
      const values = Array.isArray(input[field]) ? input[field] : [input[field]];
      item[field] = [...new Set(
        values
          .map(value => cleanText(value, field === 'images' ? 2000 : 1000))
          .filter(Boolean)
      )].slice(0, field === 'images' ? 30 : 20);
      continue;
    }

    item[field] = field === 'itemUrl' || field === 'sellerUrl' || field === 'sourcePage'
      ? cleanUrl(input[field])
      : cleanText(input[field], field === 'description' ? 12000 : 4000);
  }

  if (!item.sourcePage && sourcePage) item.sourcePage = cleanUrl(sourcePage);
  if (!item.collectedAt) item.collectedAt = new Date().toISOString();
  if (!item.dataSource) item.dataSource = 'dom';
  item.itemGoodRate = rateText(item.itemGoodRate || item.goodRate || item.reviewSummary || '');
  item.sellerIntro = publicIntroText(item.sellerIntro, 3000);

  const hasUsefulData = item.itemId || item.itemUrl || item.title || item.images?.length;
  return hasUsefulData ? item : null;
}

function itemKey(item) {
  if (item.itemId) return `id:${item.itemId}`;
  if (item.itemUrl) return `url:${item.itemUrl}`;
  return `text:${[item.title, item.sellerName, item.price].join('|')}`;
}

function mergeArrayValues(first, second) {
  return [...new Set([...(first || []), ...(second || [])].filter(Boolean))];
}

function mergeItems(previous, incoming) {
  const byKey = new Map();
  for (const raw of Array.isArray(previous) ? previous : []) {
    const item = sanitizeItem(raw);
    if (item) byKey.set(itemKey(item), item);
  }

  for (const raw of Array.isArray(incoming) ? incoming : []) {
    const item = sanitizeItem(raw);
    if (!item) continue;

    const key = itemKey(item);
    const old = byKey.get(key) || {};
    const merged = { ...old, ...item };

    for (const field of ARRAY_FIELDS) {
      merged[field] = mergeArrayValues(old[field], item[field]);
    }

    const sources = new Set(
      `${old.dataSource || ''},${item.dataSource || ''}`
        .split(',')
        .map(value => value.trim())
        .filter(Boolean)
    );
    if (sources.size) merged.dataSource = [...sources].join(',');
    byKey.set(key, merged);
  }

  return [...byKey.values()]
    .sort((a, b) => String(b.collectedAt || '').localeCompare(String(a.collectedAt || '')))
    .slice(0, MAX_ITEMS);
}

async function readItems() {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  return Array.isArray(result[STORAGE_KEY])
    ? result[STORAGE_KEY].map(item => sanitizeItem(item)).filter(Boolean)
    : [];
}

async function writeItems(items) {
  await chrome.storage.local.set({ [STORAGE_KEY]: items.slice(0, MAX_ITEMS) });
  return items;
}

function reviewIdentity(review) {
  return [
    cleanText(review?.reviewer, 160),
    cleanText(review?.feedback, 1000),
    cleanText(review?.timeIp, 160),
    cleanUrl(review?.images?.[0] || '')
  ].join('|');
}

function sanitizeReview(input) {
  if (!input || typeof input !== 'object') return null;
  const review = {
    reviewer: cleanText(input.reviewer || input.userName || '', 160),
    role: cleanText(input.role || input.tag || '', 60),
    feedback: cleanText(input.feedback || input.content || input.text || '', 12000),
    timeIp: cleanText(input.timeIp || input.time || input.location || '', 240),
    images: [...new Set((Array.isArray(input.images) ? input.images : [])
      .map(cleanUrl)
      .filter(Boolean))].slice(0, 20),
    collectedAt: cleanText(input.collectedAt || '', 80) || new Date().toISOString()
  };
  return review.feedback || review.reviewer || review.images.length ? review : null;
}

function sanitizeStoreProfile(input, sourcePage = '') {
  if (!input || typeof input !== 'object') return null;
  const sellerUrl = validSellerUrl(input.sellerUrl || '') || cleanUrl(input.sellerUrl || '');
  const reviews = (Array.isArray(input.reviews) ? input.reviews : [])
    .map(sanitizeReview)
    .filter(Boolean)
    .slice(0, MAX_STORE_REVIEWS);
  const profile = {
    sellerName: cleanText(input.sellerName || input.storeName || '', 500),
    sellerUrl,
    sellerLocation: cleanText(input.sellerLocation || '', 300),
    sellerFollowers: cleanText(input.sellerFollowers || '', 100),
    sellerFollowing: cleanText(input.sellerFollowing || '', 100),
    sellerProductCount: cleanText(input.sellerProductCount || '', 100),
    sellerIntro: publicIntroText(input.sellerIntro || '', 4000),
    storeDuration: cleanText(input.storeDuration || '', 300),
    sellerGoodRate: rateText(input.sellerGoodRate || input.goodRate || ''),
    sellerReviewCount: cleanText(input.sellerReviewCount || input.reviewCount || '', 100),
    reviews,
    reviewCountLoaded: reviews.length,
    sourcePage: cleanUrl(input.sourcePage || sourcePage),
    collectedAt: cleanText(input.collectedAt || input.capturedAt || '', 80) || new Date().toISOString()
  };
  return profile.sellerUrl || profile.sellerName || profile.reviews.length ? profile : null;
}

function storeProfileIdentity(profile) {
  return sellerProfileKey(profile?.sellerUrl || '')
    || `name:${cleanText(profile?.sellerName || '', 500)}`;
}

function mergeStoreProfiles(previous, incoming) {
  const byKey = new Map();
  for (const raw of Array.isArray(previous) ? previous : []) {
    const profile = sanitizeStoreProfile(raw);
    if (profile) byKey.set(storeProfileIdentity(profile), profile);
  }
  for (const raw of Array.isArray(incoming) ? incoming : [incoming]) {
    const profile = sanitizeStoreProfile(raw);
    if (!profile) continue;
    const key = storeProfileIdentity(profile);
    const old = byKey.get(key) || {};
    const reviewMap = new Map();
    for (const review of [...(old.reviews || []), ...(profile.reviews || [])]) {
      const id = reviewIdentity(review);
      if (id) reviewMap.set(id, review);
    }
    const reviews = [...reviewMap.values()].slice(-MAX_STORE_REVIEWS);
    byKey.set(key, {
      ...old,
      ...profile,
      reviews,
      reviewCountLoaded: reviews.length,
      collectedAt: profile.collectedAt || old.collectedAt || new Date().toISOString()
    });
  }
  return [...byKey.values()]
    .sort((a, b) => String(b.collectedAt || '').localeCompare(String(a.collectedAt || '')))
    .slice(0, MAX_STORE_PROFILES);
}

async function readStoreProfiles() {
  const result = await chrome.storage.local.get(STORE_PROFILES_KEY);
  return Array.isArray(result[STORE_PROFILES_KEY])
    ? result[STORE_PROFILES_KEY].map(profile => sanitizeStoreProfile(profile)).filter(Boolean)
    : [];
}

async function writeStoreProfiles(profiles) {
  const clean = mergeStoreProfiles([], profiles);
  await chrome.storage.local.set({ [STORE_PROFILES_KEY]: clean });
  return clean;
}

async function readSettings() {
  const result = await chrome.storage.local.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(result[SETTINGS_KEY] || {}) };
}

function normalizeSettings(input = {}) {
  const folder = cleanText(input.downloadFolder ?? DEFAULT_SETTINGS.downloadFolder, 160)
    .replace(/[\\:*?"<>|]+/g, '_')
    .replace(/\.\.+/g, '.')
    .split('/')
    .map(part => part.trim())
    .filter(part => part && part !== '.')
    .join('/');
  const template = cleanText(input.fileNameTemplate ?? DEFAULT_SETTINGS.fileNameTemplate, 160)
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\.xlsx$/i, '')
    .trim() || DEFAULT_SETTINGS.fileNameTemplate;

  return {
    ...DEFAULT_SETTINGS,
    ...input,
    mode: input.mode === 'api' ? 'api' : 'rpa',
    downloadMode: input.downloadMode === 'auto' ? 'auto' : 'manual',
    downloadFolder: folder || DEFAULT_SETTINGS.downloadFolder,
    fileNameTemplate: template,
    saveAs: Boolean(input.saveAs),
    imageLimit: Math.max(0, Math.min(30, Number(input.imageLimit) || 0)),
    maxEmbedImages: Math.max(1, Math.min(1000, Number(input.maxEmbedImages) || DEFAULT_SETTINGS.maxEmbedImages)),
    collectSellerInfo: input.collectSellerInfo !== false,
    notifyOnComplete: input.notifyOnComplete !== false,
    keepHistoryDays: Math.max(1, Math.min(365, Number(input.keepHistoryDays) || DEFAULT_SETTINGS.keepHistoryDays))
  };
}

async function writeSettings(settings) {
  const normalized = normalizeSettings(settings);
  await chrome.storage.local.set({ [SETTINGS_KEY]: normalized });
  return normalized;
}

async function readHistory() {
  const result = await chrome.storage.local.get(HISTORY_KEY);
  return Array.isArray(result[HISTORY_KEY]) ? result[HISTORY_KEY] : [];
}

async function writeHistory(history) {
  await chrome.storage.local.set({ [HISTORY_KEY]: history.slice(0, MAX_HISTORY) });
  return history;
}

function itemsForJob(job, items) {
  const resultKeys = new Set(Array.isArray(job.resultKeys) ? job.resultKeys : []);
  return resultKeys.size
    ? items.filter(item => resultKeys.has(itemKey(item)))
    : items;
}

function historySummary(job, items, extra = {}) {
  const snapshot = itemsForJob(job, items);
  return {
    id: job.id,
    type: job.type,
    mode: job.mode || 'rpa',
    status: job.status,
    message: job.message || '',
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    completedAt: new Date().toISOString(),
    targetCount: Number(job.targetCount || job.links?.length || 0),
    maxPages: Number(job.maxPages || 0),
    visited: Number(job.visited || 0),
    collected: Number(job.collected || 0),
    failures: Array.isArray(job.failures) ? job.failures.slice(0, 100) : [],
    autoExportStatus: extra.autoExportStatus || '',
    fileName: extra.fileName || '',
    itemCount: Array.isArray(snapshot) ? snapshot.length : 0,
    itemsSnapshot: Array.isArray(snapshot) ? snapshot.slice(0, MAX_ITEMS) : [],
    storeProfilesSnapshot: Array.isArray(extra.storeProfilesSnapshot)
      ? extra.storeProfilesSnapshot.slice(0, MAX_STORE_PROFILES)
      : []
  };
}

async function recordHistory(job, extra = {}) {
  const items = await readItems();
  const history = await readHistory();
  const next = history.filter(entry => entry.id !== job.id);
  next.unshift(historySummary(job, items, {
    ...extra,
    storeProfilesSnapshot: await readStoreProfiles()
  }));
  const settings = await readSettings();
  const cutoff = Date.now() - settings.keepHistoryDays * 24 * 60 * 60 * 1000;
  const retained = next.filter(entry => {
    const time = Date.parse(entry.completedAt || entry.updatedAt || entry.createdAt || '') || Date.now();
    return time >= cutoff;
  });
  try {
    return await writeHistory(retained);
  } catch (_) {
    // 单次数据量过大时保留元数据，避免历史写入失败影响当前采集结果。
    const compact = retained.map(entry => ({ ...entry, itemsSnapshot: [], storeProfilesSnapshot: [] }));
    return writeHistory(compact);
  }
}

async function readJob() {
  const result = await chrome.storage.local.get(JOB_KEY);
  return result[JOB_KEY] || null;
}

async function writeJob(job) {
  await chrome.storage.local.set({ [JOB_KEY]: job });
  return job;
}

function jobIsActive(job) {
  return Boolean(job && !['completed', 'stopped', 'failed'].includes(job.status));
}

function jobMessage(job, message) {
  return {
    ...job,
    message,
    updatedAt: new Date().toISOString()
  };
}

function tabsCreate(options) {
  return new Promise((resolve, reject) => {
    chrome.tabs.create(options, tab => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(tab);
    });
  });
}

function tabsUpdate(tabId, updateProperties) {
  return new Promise((resolve, reject) => {
    chrome.tabs.update(tabId, updateProperties, tab => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(tab);
    });
  });
}

function tabsRemove(tabId) {
  return new Promise((resolve, reject) => {
    chrome.tabs.remove(tabId, () => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve();
    });
  });
}

function waitForTabComplete(tabId, timeoutMs = 25000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finish(new Error('卖家账号页加载超时。')), timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
    }

    function finish(error, tab) {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(tab);
    }

    function onUpdated(updatedTabId, changeInfo, tab) {
      if (updatedTabId === tabId && changeInfo.status === 'complete') finish(null, tab);
    }

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.get(tabId, tab => {
      const error = chrome.runtime.lastError;
      if (error) return finish(new Error(error.message));
      if (tab?.status === 'complete') finish(null, tab);
    });
  });
}

function sendTabMessage(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, response => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(response);
    });
  });
}

function waitMs(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, Number(milliseconds) || 0)));
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

function sendRuntimeMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, response => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(response);
    });
  });
}

let offscreenCreating = null;
let exportQueue = Promise.resolve();

async function hasOffscreenDocument() {
  if (!chrome.offscreen) return false;
  const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_PATH);
  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [offscreenUrl]
    });
    return contexts.length > 0;
  }
  const clientsList = await self.clients.matchAll();
  return clientsList.some(client => client.url === offscreenUrl);
}

async function ensureOffscreenDocument() {
  if (!chrome.offscreen) throw new Error('当前 Chrome 不支持后台 Excel 导出，请升级浏览器后重试。');
  if (await hasOffscreenDocument()) return;
  if (!offscreenCreating) {
    offscreenCreating = chrome.offscreen.createDocument({
      url: OFFSCREEN_PATH,
      reasons: ['BLOBS'],
      justification: '在后台下载图片并生成包含真实图片的 Excel 文件。'
    }).finally(() => {
      offscreenCreating = null;
    });
  }
  await offscreenCreating;
}

function cleanDownloadPart(value, fallback = '未命名') {
  const cleaned = cleanText(value, 120)
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[_\.\-]+|[_\.\-]+$/g, '');
  return cleaned || fallback;
}

function downloadFileName(settings, count, type, mode) {
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const time = now.toTimeString().slice(0, 8).replace(/:/g, '');
  const values = {
    date,
    time,
    count: String(count),
    type: type === 'links' ? '链接批量' : type === 'store' ? '店铺资料' : '搜索跨页',
    mode: mode === 'api' ? '接口观察' : '页面详情'
  };
  const base = cleanDownloadPart(
    String(settings.fileNameTemplate || DEFAULT_SETTINGS.fileNameTemplate)
      .replace(/\{(date|time|count|type|mode)\}/g, (_match, key) => values[key]),
    '闲鱼商品研究'
  );
  const folder = String(settings.downloadFolder || '')
    .split('/')
    .map(part => cleanDownloadPart(part, ''))
    .filter(Boolean)
    .join('/');
  return `${folder ? `${folder}/` : ''}${base}.xlsx`;
}

function runExport(items, settings, context = {}) {
  const task = async () => {
    await ensureOffscreenDocument();
    const exportType = context.type || 'search';
    const exportCount = exportType === 'store'
      ? (Array.isArray(context.storeProfiles) ? context.storeProfiles.length : 0)
      : (Array.isArray(items) ? items.length : 0);
    const filename = downloadFileName(
      settings,
      exportCount,
      exportType,
      context.mode || settings.mode
    );
    const prepared = await sendRuntimeMessage({
      type: 'OFFSCREEN_EXPORT',
      target: 'offscreen',
      items: Array.isArray(items) ? items : [],
      storeProfiles: Array.isArray(context.storeProfiles) ? context.storeProfiles : [],
      settings: normalizeSettings(settings),
      filename
    });
    if (!prepared?.ok || !prepared.url) {
      throw new Error(prepared?.error || '后台 Excel 生成失败');
    }

    let downloadId;
    try {
      downloadId = await new Promise((resolve, reject) => {
        chrome.downloads.download({
          url: prepared.url,
          filename,
          saveAs: Boolean(settings.saveAs)
        }, id => {
          const error = chrome.runtime.lastError;
          if (error) reject(new Error(error.message));
          else resolve(id);
        });
      });
    } finally {
      await sendRuntimeMessage({
        type: 'OFFSCREEN_RELEASE',
        target: 'offscreen',
        url: prepared.url
      }).catch(() => {});
      await chrome.offscreen.closeDocument().catch(() => {});
    }

    return { ...prepared, filename, downloadId };
  };

  const next = exportQueue.then(task, task);
  exportQueue = next.catch(() => {});
  return next;
}

async function ensureContentReceiver(tabId) {
  try {
    return await sendTabMessage(tabId, { type: 'GET_PAGE_INFO' });
  } catch (firstError) {
    // 兼容插件刚加载、原标签页未刷新、或静态脚本尚未注入的情况。
    await executeScript({
      target: { tabId },
      world: 'MAIN',
      files: ['main-world.js']
    }).catch(() => {});
    await executeScript({
      target: { tabId },
      world: 'ISOLATED',
      files: ['content.js']
    });
    return sendTabMessage(tabId, { type: 'GET_PAGE_INFO' });
  }
}

async function sendCollectionCommand(tabId) {
  await ensureContentReceiver(tabId);
  return sendTabMessage(tabId, { type: 'COLLECT_CURRENT_PAGE' });
}

async function sendApiCollectionCommand(tabId) {
  await ensureContentReceiver(tabId);
  return sendTabMessage(tabId, { type: 'START_API_CAPTURE' });
}

async function sendCollectionByMode(tabId, mode) {
  return mode === 'api'
    ? sendApiCollectionCommand(tabId)
    : sendCollectionCommand(tabId);
}

function validSellerUrl(value) {
  const url = cleanUrl(value);
  if (!url) return '';
  try {
    const parsed = new URL(url);
    return parsed.hostname.endsWith('goofish.com') && /^\/personal(?:[/?#]|$)/i.test(parsed.pathname)
      ? parsed.href
      : '';
  } catch (_) {
    return '';
  }
}

function validItemUrl(value) {
  const url = cleanUrl(value);
  if (!url) return '';
  try {
    const parsed = new URL(url);
    const hasItemRoute = /^\/item(?:[/?#]|$)|^\/detail(?:[/?#]|$)/i.test(parsed.pathname);
    const hasItemId = ['id', 'itemId', 'item_id', 'auctionId', 'auction_id'].some(key => parsed.searchParams.has(key));
    return parsed.hostname.endsWith('goofish.com') && (hasItemRoute || hasItemId) ? parsed.href : '';
  } catch (_) {
    return '';
  }
}

function itemIdFromUrl(value) {
  const url = cleanUrl(value);
  if (!url) return '';
  try {
    const parsed = new URL(url);
    for (const key of ['itemId', 'item_id', 'itemid', 'id', 'auctionId', 'auction_id']) {
      const found = parsed.searchParams.get(key);
      if (found) return cleanText(found, 200);
    }
    const match = parsed.pathname.match(/(?:item|detail)[/_-]?(\d{5,})/i);
    return match ? cleanText(match[1], 200) : '';
  } catch (_) {
    return '';
  }
}

function itemUrlsMatch(first, second) {
  const firstId = itemIdFromUrl(first);
  const secondId = itemIdFromUrl(second);
  if (firstId && secondId) return firstId === secondId;
  try {
    const a = new URL(cleanUrl(first));
    const b = new URL(cleanUrl(second));
    a.hash = '';
    b.hash = '';
    for (const key of ['spm', 'scm', 'from', 'source']) {
      a.searchParams.delete(key);
      b.searchParams.delete(key);
    }
    return a.href === b.href;
  } catch (_) {
    return cleanUrl(first) === cleanUrl(second);
  }
}

function sellerProfileKey(value) {
  const url = validSellerUrl(value);
  if (!url) return '';
  try {
    const parsed = new URL(url);
    const userId = parsed.searchParams.get('userId');
    return `${parsed.origin}${parsed.pathname}${userId ? `?userId=${userId}` : ''}`;
  } catch (_) {
    return url;
  }
}

function itemIdentity(item) {
  return {
    itemId: cleanText(item?.itemId, 200),
    itemUrl: cleanUrl(item?.itemUrl || ''),
    sellerUrl: validSellerUrl(item?.sellerUrl || '')
  };
}

function accountProfileSignature(profile) {
  return [
    'sellerName', 'sellerUrl', 'sellerLocation', 'sellerFollowers', 'sellerFollowing',
    'sellerProductCount', 'sellerIntro', 'storeDuration', 'sellerGoodRate',
    'sellerReviewCount'
  ].map(field => cleanText(profile?.[field], 1000)).join('|');
}

function accountProfileLooksReady(profile) {
  if (!profile?.ok || profile.pageType !== 'account') return false;
  if (!validSellerUrl(profile.sellerUrl)) return false;

  const sellerName = cleanText(profile.sellerName, 500);
  if (!sellerName || /^(?:登录|请登录|闲鱼用户|用户)$/i.test(sellerName)) return false;

  // 账号页是异步渲染的。仅拿到昵称而没有任何资料字段时，仍然属于骨架屏/未完成状态。
  return [
    profile.sellerLocation,
    profile.sellerFollowers,
    profile.sellerFollowing,
    profile.sellerProductCount,
    profile.sellerIntro,
    profile.storeDuration,
    profile.sellerGoodRate,
    profile.sellerReviewCount
  ].some(value => cleanText(value, 1000));
}

async function readStableAccountProfile(tabId, options = {}) {
  const maxAttempts = Math.max(3, Number(options.maxAttempts) || 10);
  let previousSignature = '';
  let stableReads = 0;
  let lastProfile = null;
  let lastError = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const profile = await sendTabMessage(tabId, { type: 'GET_ACCOUNT_PROFILE' });
      if (accountProfileLooksReady(profile)) {
        const signature = accountProfileSignature(profile);
        stableReads = signature && signature === previousSignature ? stableReads + 1 : 1;
        previousSignature = signature;
        lastProfile = profile;

        // 连续两次读取完全一致，才把资料交给合并逻辑，避免把异步渲染中的邻近数字当成字段值。
        if (stableReads >= 2) return profile;
      } else if (profile?.ok) {
        lastProfile = profile;
        stableReads = 0;
        previousSignature = '';
      }
    } catch (error) {
      lastError = error;
    }

    if (attempt < maxAttempts - 1) {
      await waitMs(attempt < 2 ? 700 : 1000);
    }
  }

  if (accountProfileLooksReady(lastProfile)) return lastProfile;
  throw lastError || new Error('卖家账号页资料尚未稳定加载，未写入商品字段。');
}

async function mergeStoredItemWithProfile(identity, profile) {
  const items = await readItems();
  const key = itemKey(identity || {});
  const existing = items.find(item => itemKey(item) === key);
  if (!existing || !profile) return false;

  const patch = { ...existing };
  for (const field of [
    'sellerName', 'sellerUrl', 'sellerLocation', 'sellerFollowers', 'sellerFollowing',
    'sellerProductCount', 'sellerIntro', 'sellerReviewSummary', 'sellerReviewCount'
  ]) {
    if (profile[field]) patch[field] = profile[field];
  }
  const profileGoodRate = rateText(profile.sellerGoodRate || '');
  if (profileGoodRate && !rateText(patch.itemGoodRate || '')) {
    // 详情页的 reviewSummary 可能是一段文案，但这不应阻止账号页的明确百分比
    // 写入“商品好评率”；判断依据必须是目标字段是否已有合法百分比，而不是摘要是否为空。
    patch.itemGoodRate = profileGoodRate;
    if (!patch.reviewSummary || !rateText(patch.reviewSummary)) patch.reviewSummary = profileGoodRate;
  }
  if (Array.isArray(profile.reviewSamples) && profile.reviewSamples.length) {
    patch.reviewSamples = profile.reviewSamples;
  }
  patch.dataSource = [existing.dataSource, 'account-dom'].filter(Boolean).join(',');
  const merged = mergeItems(items, [patch]);
  await writeItems(merged);
  return true;
}

async function fetchSellerProfile(sellerUrl) {
  const url = validSellerUrl(sellerUrl);
  if (!url) throw new Error('没有识别到有效的卖家账号页链接。');

  const tab = await tabsCreate({ url, active: false });
  try {
    await waitForTabComplete(tab.id);
    const info = await ensureContentReceiver(tab.id);
    if (info?.pageType !== 'account') throw new Error('卖家账号页未正确加载。');
    return await readStableAccountProfile(tab.id);
  } finally {
    await tabsRemove(tab.id).catch(() => {});
  }
}

function collectedItemForLink(result, link) {
  const items = Array.isArray(result?.items) ? result.items : [];
  const itemId = cleanText(link?.itemId, 200);
  const exact = items.find(item => itemId && cleanText(item?.itemId, 200) === itemId)
    || items.find(item => cleanUrl(item?.itemUrl || '') === cleanUrl(link?.itemUrl || ''));
  return exact || items[0] || null;
}

async function prepareSellerEnrichment(job, item, pendingCount) {
  if (job.collectSellerInfo === false) return { kind: 'disabled', job };
  const sellerUrl = validSellerUrl(item?.sellerUrl || '');
  if (!sellerUrl) return { kind: 'unavailable', job };

  const key = sellerProfileKey(sellerUrl);
  const cached = job.sellerProfiles?.[key];
  const identity = itemIdentity(item);
  if (cached) {
    await mergeStoredItemWithProfile(identity, cached);
    return { kind: 'cached', job };
  }

  const waiting = jobMessage({
    ...job,
    status: 'waiting-page',
    stage: 'account-page',
    pendingItem: identity,
    pendingSellerUrl: sellerUrl,
    pendingSellerKey: key,
    pendingCount: Math.max(0, Number(pendingCount) || 0),
    sellerRetries: 0
  }, '正在打开卖家账号页，补充店铺简介和公开评价…');
  await writeJob(waiting);
  await tabsUpdate(job.tabId, { url: sellerUrl });
  return {
    kind: 'scheduled',
    job: await scheduleJob(waiting, 'ready-to-collect', Math.max(1400, Number(job.delayMs) || 1600))
  };
}

async function scheduleJob(job, status, delayMs = 1000) {
  const next = jobMessage({ ...job, status }, job.message || '等待下一步');
  await writeJob(next);
  await chrome.alarms.clear(JOB_ALARM);
  chrome.alarms.create(JOB_ALARM, {
    when: Date.now() + Math.max(250, Number(delayMs) || 1000)
  });
  return next;
}

async function notifyJobFinished(job, exportResult = null) {
  const settings = await readSettings();
  const statusLabel = job.status === 'completed' ? '采集完成' : job.status === 'stopped' ? '采集已停止' : '采集失败';
  const detail = `成功 ${job.collected || 0} 条${job.failures?.length ? `，失败 ${job.failures.length} 条` : ''}${job.sellerFailures?.length ? `，店铺资料补充失败 ${job.sellerFailures.length} 条` : ''}`;
  const message = exportResult?.filename
    ? `${detail}，Excel 已下载：${exportResult.filename}`
    : detail;

  if (chrome.action?.setBadgeText) {
    await chrome.action.setBadgeText({ text: job.status === 'completed' ? '✓' : '!' }).catch(() => {});
    await chrome.action.setBadgeBackgroundColor({
      color: job.status === 'completed' ? '#2f8f68' : '#c65c52'
    }).catch(() => {});
  }

  if (settings.notifyOnComplete && chrome.notifications?.create) {
    await chrome.notifications.create(`xianyu-${job.id}`, {
      type: 'basic',
      title: `闲鱼研究采集器｜${statusLabel}`,
      message,
      iconUrl: chrome.runtime.getURL('icon.svg')
    }).catch(() => {});
  }
}

async function finishJob(job, status, message) {
  await chrome.alarms.clear(JOB_ALARM);
  const finalJob = jobMessage({ ...job, status }, message);
  await writeJob(finalJob);

  let exportResult = null;
  if (status === 'completed') {
    const settings = await readSettings();
    if (settings.downloadMode === 'auto') {
      try {
        exportResult = await runExport(itemsForJob(finalJob, await readItems()), settings, {
          type: finalJob.type,
          mode: finalJob.mode,
          storeProfiles: await readStoreProfiles()
        });
        finalJob.autoExportStatus = 'completed';
        finalJob.fileName = exportResult.filename;
        finalJob.message = `${message} Excel 已自动下载：${exportResult.filename}`;
        await writeJob(finalJob);
      } catch (error) {
        finalJob.autoExportStatus = 'failed';
        finalJob.autoExportError = error?.message || String(error);
        finalJob.message = `${message}，但自动下载失败：${finalJob.autoExportError}`;
        await writeJob(finalJob);
      }
    } else {
      finalJob.autoExportStatus = 'pending-manual';
      await writeJob(finalJob);
    }
  }

  await recordHistory(finalJob, {
    autoExportStatus: finalJob.autoExportStatus,
    fileName: finalJob.fileName
  });
  await notifyJobFinished(finalJob, exportResult);
  return finalJob;
}

async function advanceLinkJob(job, failureMessage = '') {
  const nextIndex = Number(job.index || 0) + 1;
  const failures = [...(job.failures || [])];
  if (failureMessage && job.links?.[job.index]) {
    failures.push({ url: job.links[job.index], error: failureMessage });
  }

  const next = {
    ...job,
    stage: 'detail-page',
    index: nextIndex,
    failures,
    retries: 0,
    pagesProcessed: nextIndex,
    pendingItem: null,
    pendingSellerUrl: '',
    pendingSellerKey: '',
    pendingCount: 0
  };

  if (nextIndex >= job.links.length) {
    return finishJob(next, 'completed', `链接采集完成：${next.collected} 条商品，失败 ${failures.length} 条。`);
  }

  try {
    const waiting = jobMessage(
      { ...next, status: 'waiting-page' },
      `正在打开第 ${nextIndex + 1}/${job.links.length} 个商品链接…`
    );
    await writeJob(waiting);
    await tabsUpdate(job.tabId, { url: job.links[nextIndex] });
    return scheduleJob(waiting, 'ready-to-collect', Math.max(1000, Number(job.delayMs) || 1400));
  } catch (error) {
    return advanceLinkJob(next, error.message || String(error));
  }
}

async function processLinkJob(job) {
  try {
    const result = assertDetailCollection(await sendCollectionByMode(job.tabId, job.mode));
    const count = Number(result?.count ?? result?.added ?? 0);
    const next = {
      ...job,
      resultKeys: [...new Set([...(job.resultKeys || []), ...(result.keys || [])])],
      retries: 0
    };
    const item = collectedItemForLink(result, { itemId: '', itemUrl: job.links?.[job.index] });
    const enrichment = await prepareSellerEnrichment(next, item, count);
    if (enrichment.kind === 'scheduled') return enrichment.job;
    return advanceLinkJob({
      ...enrichment.job,
      collected: Number(job.collected || 0) + count
    });
  } catch (error) {
    const retries = Number(job.retries || 0) + 1;
    if (retries <= 2) {
      return scheduleJob({ ...job, retries }, 'ready-to-collect', 1500);
    }
    return advanceLinkJob({ ...job, retries: 0 }, error.message || String(error));
  }
}

function searchLinkKey(link) {
  if (link?.itemId) return `id:${cleanText(link.itemId, 200)}`;
  const rawUrl = cleanUrl(link?.itemUrl || '');
  if (!rawUrl) return '';
  try {
    const url = new URL(rawUrl);
    url.hash = '';
    return `url:${url.href}`;
  } catch (_) {
    return `url:${rawUrl}`;
  }
}

function compactSearchLink(input) {
  if (!input || typeof input !== 'object') return null;
  const itemUrl = validItemUrl(input.itemUrl || '');
  if (!itemUrl) return null;
  return {
    itemId: cleanText(input.itemId, 200),
    title: cleanText(input.title, 1000),
    itemUrl,
    sellerName: cleanText(input.sellerName, 500),
    sourcePage: cleanUrl(input.sourcePage || '')
  };
}

function assertDetailCollection(result) {
  if (!result || result.ok === false) {
    throw new Error(result?.error || '详情页没有返回采集结果');
  }
  if (result.pageType !== 'detail') {
    throw new Error('当前打开的页面不是商品详情页，已跳过，避免把搜索卡片写入结果');
  }
  return result;
}

function normalizeSearchJob(job) {
  if (job?.type !== 'search') return job;
  return {
    ...job,
    mode: job.mode === 'api' ? 'api' : 'rpa',
    stage: ['detail-page', 'account-page'].includes(job.stage) ? job.stage : 'search-page',
    pageUrl: cleanUrl(job.pageUrl || job.startUrl || ''),
    pageLinks: Array.isArray(job.pageLinks) ? job.pageLinks : [],
    detailIndex: Math.max(0, Number(job.detailIndex) || 0),
    expectedDetailUrl: cleanUrl(job.expectedDetailUrl || ''),
    expectedSearchPage: Math.max(0, Number(job.expectedSearchPage) || 0),
    seenLinks: Array.isArray(job.seenLinks) ? job.seenLinks : [],
    resultKeys: Array.isArray(job.resultKeys) ? job.resultKeys : [],
    sellerProfiles: job.sellerProfiles && typeof job.sellerProfiles === 'object' ? job.sellerProfiles : {},
    collectSellerInfo: job.collectSellerInfo !== false,
    visited: Math.max(0, Number(job.visited) || 0),
    countSearchPage: job.countSearchPage !== false
  };
}

async function navigateSearchJob(job, url, stage, message, delayMs) {
  const waiting = jobMessage({
    ...job,
    status: 'waiting-page',
    stage,
    pageUrl: stage === 'search-page' ? cleanUrl(url) : job.pageUrl,
    expectedDetailUrl: stage === 'detail-page' ? cleanUrl(url) : '',
    expectedSearchPage: stage === 'search-page' ? Number(job.expectedSearchPage || 0) : 0
  }, message);
  await writeJob(waiting);
  await tabsUpdate(job.tabId, { url });

  // tabs.onUpdated 会在页面完成后再次安排任务；这里保留一个兜底闹钟，
  // 避免某些单页导航或插件刚重载时漏掉 onUpdated 事件。
  return scheduleJob(waiting, 'ready-to-collect', delayMs);
}

async function advanceSearchDetail(job, count = 0, failureMessage = '') {
  const currentLink = job.pageLinks?.[job.detailIndex];
  const failures = [...(job.failures || [])];
  if (failureMessage && currentLink?.itemUrl) {
    failures.push({ url: currentLink.itemUrl, error: failureMessage });
  }

  const visited = Number(job.visited || 0) + 1;
  const collected = Number(job.collected || 0) + Math.max(0, Number(count) || 0);
  const nextIndex = Number(job.detailIndex || 0) + 1;
  const next = {
    ...job,
    visited,
    collected,
    failures,
    detailIndex: nextIndex,
    retries: 0
  };

  if (visited >= Number(job.targetCount || 0)) {
    return finishJob(
      next,
      collected > 0 ? 'completed' : 'failed',
      collected > 0
        ? `详情页采集完成：已访问 ${visited} 个详情页，成功写入 ${collected} 条商品，处理 ${job.pagesProcessed} 页。`
        : `详情页任务未成功写入商品：已尝试访问 ${visited} 个详情页，请检查页面是否真的加载为商品详情页。`
    );
  }

  if (nextIndex < (job.pageLinks?.length || 0)) {
    const following = job.pageLinks[nextIndex];
    return navigateSearchJob(
      next,
      following.itemUrl,
      'detail-page',
      `正在采集搜索第 ${job.pagesProcessed} 页详情：${nextIndex + 1}/${job.pageLinks.length}…`,
      Math.max(1500, Number(job.delayMs) || 1800)
    );
  }

  if (Number(job.pagesProcessed || 0) >= Number(job.maxPages || 0)) {
    return finishJob(
      next,
      collected > 0 ? 'completed' : 'failed',
      collected > 0
        ? `已达到页数上限：访问 ${visited} 个详情页，成功写入 ${collected} 条商品，处理 ${job.pagesProcessed} 页。`
        : `任务未成功写入商品：已尝试访问 ${visited} 个详情页，请检查详情页导航和页面加载状态。`
    );
  }

  const searchUrl = job.pageUrl || job.startUrl;
  return navigateSearchJob(
    {
      ...next,
      stage: 'search-page',
      pageLinks: [],
      detailIndex: 0,
      countSearchPage: false,
      expectedDetailUrl: '',
      expectedSearchPage: 0,
      searchPageRetries: 0
    },
    searchUrl,
    'search-page',
    `第 ${job.pagesProcessed} 页详情已处理，正在返回搜索页寻找下一页…`,
    Math.max(1600, Number(job.delayMs) || 1800)
  );
}

async function processSearchPage(job) {
  try {
    const pageInfo = await ensureContentReceiver(job.tabId);
    if (pageInfo?.pageType !== 'search') {
      throw new Error(`采集专用标签页当前不是搜索结果页（实际为${pageInfo?.pageType || '未知页面'}）。`);
    }
    const result = await sendTabMessage(job.tabId, { type: 'GET_SEARCH_LINKS' });
    if (!result?.ok) throw new Error(result?.error || '没有收到搜索页商品链接');

    const pager = result.pager || {};
    if (job.expectedSearchPage && pager.current && pager.current < job.expectedSearchPage) {
      throw new Error(`搜索页仍停留在第 ${pager.current} 页，正在等待第 ${job.expectedSearchPage} 页加载。`);
    }

    const pageUrl = cleanUrl(result.pageUrl || pageInfo?.url || job.pageUrl || job.startUrl);
    const pagesProcessed = Number(job.pagesProcessed || 0) + (job.countSearchPage === false ? 0 : 1);
    const targetCount = Number(job.targetCount || 0);
    const remaining = Math.max(0, targetCount - Number(job.visited || 0));
    const seen = new Set(job.seenLinks || []);
    const pageLinks = [];

    for (const raw of Array.isArray(result.items) ? result.items : []) {
      const link = compactSearchLink(raw);
      const key = searchLinkKey(link);
      if (!link || !key || seen.has(key)) continue;
      seen.add(key);
      pageLinks.push(link);
      if (pageLinks.length >= remaining) break;
    }

    const next = {
      ...job,
      stage: 'search-page',
      pageUrl,
      pagesProcessed,
      pageLinks,
      detailIndex: 0,
      seenLinks: [...seen],
      countSearchPage: false,
      retries: 0,
      searchPageRetries: 0,
      expectedDetailUrl: ''
    };

    if (pageLinks.length) {
      return navigateSearchJob(
        next,
        pageLinks[0].itemUrl,
        'detail-page',
        `已从第 ${pagesProcessed} 页找到 ${pageLinks.length} 个详情链接，正在打开第 1 个…`,
        Math.max(1500, Number(job.delayMs) || 1800)
      );
    }

    // 搜索结果是异步渲染的。空列表不能直接当成“采集完成”，否则新标签页
    // 还没渲染商品卡片时就会出现“完成 0 条”的假成功。
    const emptyRetries = Number(job.searchPageRetries || 0) + 1;
    if (remaining > 0 && emptyRetries <= 4) {
      return scheduleJob(
        { ...next, searchPageRetries: emptyRetries },
        'ready-to-collect',
        Math.max(2200, Number(job.delayMs) || 2200)
      );
    }

    if (Number(job.visited || 0) >= targetCount) {
      return finishJob(next, 'completed', `详情页采集完成：已访问 ${job.visited} 个详情页，成功写入 ${job.collected} 条商品。`);
    }
    if (pagesProcessed >= Number(job.maxPages || 0)) {
      return finishJob(
        next,
        Number(job.collected || 0) > 0 ? 'completed' : 'failed',
        Number(job.collected || 0) > 0
          ? `已达到页数上限：访问 ${job.visited || 0} 个详情页，成功写入 ${job.collected || 0} 条商品，处理 ${pagesProcessed} 页。`
          : `任务未成功写入商品：搜索页已处理 ${pagesProcessed} 页但没有进入有效详情页。`
      );
    }

    const nextPage = await sendTabMessage(job.tabId, { type: 'GO_NEXT_PAGE' });
    if (!nextPage?.moved) {
      if (Number(job.visited || 0) === 0) {
        return finishJob(
          next,
          'failed',
          `搜索页没有发现可打开的商品详情链接，已停止任务；请确认结果列表已经加载后重试。`
        );
      }
      return finishJob(
        next,
        'completed',
        `未找到可用的下一页页码或分页控件：已访问 ${job.visited || 0} 个详情页，成功写入 ${job.collected || 0} 条商品。`
      );
    }

    return scheduleJob(
      {
        ...next,
        stage: 'search-page',
        pageLinks: [],
        detailIndex: 0,
        countSearchPage: true,
        searchPageRetries: 0,
        expectedDetailUrl: '',
        expectedSearchPage: Number(nextPage.page || pager.current || 0) + (nextPage.page ? 0 : 1)
      },
      'ready-to-collect',
      Math.max(1600, Number(job.delayMs) || 1800)
    );
  } catch (error) {
    const retries = Number(job.retries || 0) + 1;
    if (retries <= 2) {
      return scheduleJob({ ...job, retries }, 'ready-to-collect', 1500);
    }
    return finishJob({ ...job, retries }, 'failed', `搜索页链接发现失败：${error.message || String(error)}`);
  }
}

async function processSearchDetail(job) {
  const currentLink = job.pageLinks?.[job.detailIndex];
  if (!currentLink?.itemUrl) {
    return advanceSearchDetail(job, 0, '详情链接为空');
  }

  try {
    const pageInfo = await ensureContentReceiver(job.tabId);
    if (pageInfo?.pageType !== 'detail') {
      throw new Error('自动打开后当前标签页不是商品详情页，未写入搜索卡片数据。');
    }
    if (job.expectedDetailUrl && !itemUrlsMatch(pageInfo.url, job.expectedDetailUrl)) {
      throw new Error('当前详情页链接与待采集商品不一致，已等待页面重新导航。');
    }
    const result = assertDetailCollection(await sendCollectionByMode(job.tabId, job.mode));
    const count = Number(result.count ?? result.added ?? 0);
    const next = {
      ...job,
      expectedDetailUrl: '',
      resultKeys: [...new Set([...(job.resultKeys || []), ...(result.keys || [])])]
    };
    const item = collectedItemForLink(result, currentLink);
    const enrichment = await prepareSellerEnrichment(next, item, count);
    if (enrichment.kind === 'scheduled') return enrichment.job;
    return advanceSearchDetail(enrichment.job, count);
  } catch (error) {
    const retries = Number(job.retries || 0) + 1;
    if (retries <= 2) {
      return scheduleJob({ ...job, retries }, 'ready-to-collect', 1500);
    }
    return advanceSearchDetail({ ...job, retries: 0 }, 0, error.message || String(error));
  }
}

async function finishPendingSellerStep(job, profile = null, errorMessage = '') {
  const pending = job.pendingItem || {};
  const count = Math.max(0, Number(job.pendingCount) || 0);
  let next = {
    ...job,
    pendingItem: null,
    pendingSellerUrl: '',
    pendingSellerKey: '',
    pendingCount: 0,
    sellerRetries: 0
  };

  if (profile) {
    const key = job.pendingSellerKey || sellerProfileKey(job.pendingSellerUrl);
    const sellerProfiles = {
      ...(job.sellerProfiles || {}),
      ...(key ? { [key]: profile } : {})
    };
    await mergeStoredItemWithProfile(pending, profile);
    next = { ...next, sellerProfiles };
  }

  if (errorMessage) {
    next = {
      ...next,
      sellerFailures: [
        ...(job.sellerFailures || []),
        { itemId: pending.itemId || '', sellerUrl: job.pendingSellerUrl || '', error: errorMessage }
      ].slice(-100)
    };
  }

  if (job.type === 'links') {
    return advanceLinkJob({
      ...next,
      collected: Number(job.collected || 0) + count
    });
  }
  return advanceSearchDetail(next, count, '');
}

async function processAccountPage(job) {
  try {
    const pageInfo = await ensureContentReceiver(job.tabId);
    if (pageInfo?.pageType !== 'account') throw new Error('当前页面不是卖家账号页。');
    const profile = await readStableAccountProfile(job.tabId);
    return finishPendingSellerStep(job, profile);
  } catch (error) {
    const retries = Number(job.sellerRetries || 0) + 1;
    if (retries <= 2) {
      return scheduleJob({ ...job, sellerRetries: retries }, 'ready-to-collect', 1600);
    }
    return finishPendingSellerStep(job, null, error.message || String(error));
  }
}

async function processJobAlarm() {
  const rawJob = await readJob();
  if (!rawJob || !jobIsActive(rawJob) || rawJob.status !== 'ready-to-collect') return;

  const job = normalizeSearchJob(rawJob);
  const collectingMessage = job.stage === 'account-page'
    ? '正在读取卖家账号页的公开简介和评价…'
    : job.type === 'search' && job.stage === 'search-page'
      ? '正在读取当前搜索页的商品详情链接…'
      : '正在采集当前商品详情页…';
  await writeJob(jobMessage({ ...job, status: 'collecting' }, collectingMessage));
  const collecting = { ...job, status: 'collecting' };
  if (job.stage === 'account-page') await processAccountPage(collecting);
  else if (job.type === 'links') await processLinkJob(collecting);
  else if (job.type === 'search' && job.stage === 'detail-page') await processSearchDetail(collecting);
  else if (job.type === 'search') await processSearchPage(collecting);
}

async function startLinksJob(links, delayMs = 1500, mode = 'rpa') {
  const current = await readJob();
  if (jobIsActive(current)) throw new Error('已有采集任务正在运行，请先停止当前任务。');

  const settings = await readSettings();
  const tab = await tabsCreate({ url: links[0], active: false });
  const job = {
    id: `links-${Date.now()}`,
    type: 'links',
    mode: mode === 'api' ? 'api' : 'rpa',
    status: 'waiting-page',
    stage: 'detail-page',
    links,
    index: 0,
    pagesProcessed: 0,
    collected: 0,
    resultKeys: [],
    sellerProfiles: {},
    sellerFailures: [],
    collectSellerInfo: settings.collectSellerInfo !== false,
    failures: [],
    retries: 0,
    delayMs: Math.max(1000, Number(delayMs) || 1500),
    tabId: tab.id,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    message: `已打开采集标签页，共 ${links.length} 个链接。`
  };
  return scheduleJob(job, 'ready-to-collect', 1400);
}

async function startSearchJob(startUrl, targetCount, maxPages, delayMs = 1800, mode = 'rpa') {
  const current = await readJob();
  if (jobIsActive(current)) throw new Error('已有采集任务正在运行，请先停止当前任务。');

  let parsedStart;
  try {
    parsedStart = new URL(startUrl);
  } catch (_) {
    throw new Error('搜索跨页采集需要有效的闲鱼搜索结果页链接。');
  }
  if (!parsedStart.hostname.endsWith('goofish.com') || !/^\/search(?:[/?#]|$)/i.test(parsedStart.pathname)) {
    throw new Error('搜索跨页采集只能从闲鱼搜索结果页启动。');
  }

  const settings = await readSettings();
  const tab = await tabsCreate({ url: startUrl, active: false });
  const job = {
    id: `search-${Date.now()}`,
    type: 'search',
    mode: mode === 'api' ? 'api' : 'rpa',
    status: 'waiting-page',
    startUrl,
    stage: 'search-page',
    pageUrl: startUrl,
    pageLinks: [],
    detailIndex: 0,
    expectedDetailUrl: '',
    expectedSearchPage: 0,
    seenLinks: [],
    visited: 0,
    countSearchPage: true,
    targetCount: Math.max(1, Number(targetCount) || 100),
    maxPages: Math.max(1, Number(maxPages) || 10),
    pagesProcessed: 0,
    collected: 0,
    resultKeys: [],
    sellerProfiles: {},
    sellerFailures: [],
    collectSellerInfo: settings.collectSellerInfo !== false,
    failures: [],
    retries: 0,
    searchPageRetries: 0,
    delayMs: Math.max(1500, Number(delayMs) || 1800),
    tabId: tab.id,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    message: `已打开搜索采集标签页，目标 ${Math.max(1, Number(targetCount) || 100)} 条。`
  };
  return scheduleJob(job, 'ready-to-collect', 1800);
}

async function configureSidePanel() {
  if (!chrome.sidePanel?.setPanelBehavior) return;
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
}

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await readItems();
  if (!Array.isArray(existing)) await writeItems([]);
  const settingsResult = await chrome.storage.local.get(SETTINGS_KEY);
  if (!settingsResult[SETTINGS_KEY]) await writeSettings(DEFAULT_SETTINGS);
  await configureSidePanel();
});

chrome.runtime.onStartup.addListener(() => {
  void configureSidePanel();
});

chrome.action.onClicked.addListener(tab => {
  if (!chrome.sidePanel?.open || !tab?.windowId) return;
  void chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== 'complete') return;
  void (async () => {
    const job = await readJob();
    if (!job || job.tabId !== tabId || !jobIsActive(job)) return;
    if (job.status === 'waiting-page') {
      await scheduleJob(job, 'ready-to-collect', job.type === 'links' ? 1000 : 1500);
    }
  })();
});

chrome.tabs.onRemoved.addListener(tabId => {
  void (async () => {
    const job = await readJob();
    if (!job || job.tabId !== tabId || !jobIsActive(job)) return;
    await finishJob(job, 'stopped', '采集专用标签页被关闭，任务已停止。');
  })();
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === JOB_ALARM) void processJobAlarm();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target === 'offscreen') return false;

  (async () => {
    switch (message?.type) {
      case 'COLLECT_ITEMS': {
        const pageUrl = sender?.tab?.url || message.sourcePage || '';
        const activeJobBeforeWrite = await readJob();
        if (message.pageType && message.pageType !== 'detail') {
          return {
            ok: true,
            count: 0,
            added: 0,
            total: (await readItems()).length,
            ignored: true,
            reason: '只有商品详情页数据会进入商品主表。'
          };
        }
        if (activeJobBeforeWrite?.type === 'search'
          && activeJobBeforeWrite.tabId === sender?.tab?.id
          && activeJobBeforeWrite.stage === 'search-page') {
          return {
            ok: true,
            count: 0,
            added: 0,
            total: (await readItems()).length,
            ignored: true,
            reason: '搜索列表只用于发现详情链接，不直接写入商品主表。'
          };
        }
        const incoming = (Array.isArray(message.items) ? message.items : [])
          .map(item => sanitizeItem({ ...item, sourcePage: item.sourcePage || pageUrl }, pageUrl))
          .filter(Boolean);
        const existing = await readItems();
        const oldKeys = new Set(existing.map(itemKey));
        const merged = mergeItems(existing, incoming);
        const added = merged.filter(item => !oldKeys.has(itemKey(item))).length;
        await writeItems(merged);
        const activeJob = activeJobBeforeWrite || await readJob();
        const resultKeys = incoming.map(itemKey);
        if (activeJob && jobIsActive(activeJob) && activeJob.tabId === sender?.tab?.id && resultKeys.length) {
          await writeJob({
            ...activeJob,
            resultKeys: [...new Set([...(activeJob.resultKeys || []), ...resultKeys])],
            updatedAt: new Date().toISOString()
          });
        }
        return {
          ok: true,
          count: incoming.length,
          added,
          total: merged.length,
          keys: resultKeys
        };
      }

      case 'COLLECT_STORE_PROFILE': {
        const profile = sanitizeStoreProfile(message.profile || {}, sender?.tab?.url || message.sourcePage || '');
        if (!profile) throw new Error('当前店铺页没有读取到可保存的公开资料。');
        const profiles = mergeStoreProfiles(await readStoreProfiles(), [profile]);
        await writeStoreProfiles(profiles);
        return {
          ok: true,
          storeCount: profiles.length,
          reviewCount: profile.reviews?.length || 0,
          totalReviews: profiles.reduce((sum, item) => sum + Number(item.reviewCountLoaded || item.reviews?.length || 0), 0)
        };
      }

      case 'ENRICH_SINGLE_ITEM': {
        const item = sanitizeItem(message.item || {}, sender?.tab?.url || '');
        const sellerUrl = validSellerUrl(item?.sellerUrl || '');
        if (!item || !sellerUrl) {
          return { ok: true, enriched: false, reason: '当前详情页没有公开的卖家账号页链接。' };
        }
        const profile = await fetchSellerProfile(sellerUrl);
        const enriched = await mergeStoredItemWithProfile(item, profile);
        return { ok: true, enriched, profile };
      }

      case 'GET_ITEMS':
        return { ok: true, items: await readItems() };

      case 'GET_STATUS':
        return { ok: true, count: (await readItems()).length, storeCount: (await readStoreProfiles()).length };

      case 'GET_SETTINGS':
        return { ok: true, settings: await readSettings() };

      case 'SAVE_SETTINGS':
        return { ok: true, settings: await writeSettings(message.settings || {}) };

      case 'GET_HISTORY':
        return { ok: true, history: await readHistory() };

      case 'DELETE_HISTORY': {
        const history = await readHistory();
        const next = history.filter(entry => entry.id !== message.id);
        await writeHistory(next);
        return { ok: true, history: next };
      }

      case 'CLEAR_HISTORY':
        await writeHistory([]);
        return { ok: true, history: [] };

      case 'EXPORT_ITEMS': {
        const settings = await readSettings();
        const result = await runExport(await readItems(), settings, {
          type: message.taskType || 'search',
          mode: message.mode || settings.mode,
          storeProfiles: await readStoreProfiles()
        });
        return { ok: true, result };
      }

      case 'EXPORT_HISTORY': {
        const history = await readHistory();
        const entry = history.find(item => item.id === message.id);
        if (!entry) throw new Error('找不到这条历史任务。');
        const settings = await readSettings();
        const result = await runExport(entry.itemsSnapshot || [], settings, {
          type: entry.type,
          mode: entry.mode,
          storeProfiles: Array.isArray(entry.storeProfilesSnapshot)
            ? entry.storeProfilesSnapshot
            : await readStoreProfiles()
        });
        const next = history.map(item => item.id === entry.id
          ? { ...item, lastExportAt: new Date().toISOString(), fileName: result.filename }
          : item);
        await writeHistory(next);
        return { ok: true, result };
      }

      case 'CLEAR_ITEMS':
        await writeItems([]);
        await writeStoreProfiles([]);
        return { ok: true, count: 0 };

      case 'GET_JOB_STATUS':
        return { ok: true, job: await readJob() };

      case 'START_BATCH_LINKS': {
        const links = [...new Set((Array.isArray(message.links) ? message.links : [])
          .map(value => cleanUrl(value))
          .map(value => validItemUrl(value))
          .filter(Boolean))].slice(0, 500);
        if (!links.length) throw new Error('没有识别到有效的闲鱼商品链接。');
        const settings = await readSettings();
        return { ok: true, job: await startLinksJob(links, message.delayMs, message.mode || settings.mode) };
      }

      case 'START_SEARCH_CRAWL': {
        const startUrl = cleanUrl(message.startUrl || sender?.tab?.url || '');
        if (!startUrl || !startUrl.includes('goofish.com')) throw new Error('请先在闲鱼搜索结果页启动跨页采集。');
        const settings = await readSettings();
        return {
          ok: true,
          job: await startSearchJob(startUrl, message.targetCount, message.maxPages, message.delayMs, message.mode || settings.mode)
        };
      }

      case 'STOP_JOB': {
        const job = await readJob();
        if (!job || !jobIsActive(job)) return { ok: true, job };
        const stopped = await finishJob(job, 'stopped', '任务已由用户停止。');
        return { ok: true, job: stopped };
      }

      default:
        return { ok: false, error: '未知消息类型' };
    }
  })()
    .then(sendResponse)
    .catch(error => sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    }));

  return true;
});
