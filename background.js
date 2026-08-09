'use strict';

const STORAGE_KEY = 'xianyu_public_items_v1';
const STORE_PROFILES_KEY = 'xianyu_public_store_profiles_v1';
const JOB_KEY = 'xianyu_collect_job_v1';
const JOB_ALARM = 'xianyu_collect_job_alarm_v1';
const SETTINGS_KEY = 'xianyu_collect_settings_v1';
const HISTORY_KEY = 'xianyu_collect_history_v1';
const MONITORS_KEY = 'xianyu_monitor_configs_v1';
const MONITOR_RUNS_KEY = 'xianyu_monitor_runs_v1';
const MONITOR_ALARM_PREFIX = 'xianyu_monitor_alarm_v1:';
const OFFSCREEN_PATH = 'offscreen.html';
const MAX_ITEMS = 2000;
const MAX_STORE_PROFILES = 200;
const MAX_STORE_REVIEWS = 1000;
const MAX_HISTORY = 50;
const MAX_MONITORS = 100;
const MAX_MONITOR_LINKS = 500;
const TAB_MESSAGE_TIMEOUT_MS = 12000;
const JOB_STALE_TIMEOUT_MS = 90000;
const cancelledJobIds = new Set();
const monitorRunLocks = new Set();

function markJobCancelled(jobId) {
  if (!jobId) return;
  cancelledJobIds.add(jobId);
  while (cancelledJobIds.size > 200) {
    cancelledJobIds.delete(cancelledJobIds.values().next().value);
  }
}

function isJobCancelled(job) {
  return Boolean(job?.id && cancelledJobIds.has(job.id));
}

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
  'viewCount',
  'wantCount',
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
  // 兼容旧版本已经保存的内部类目编号：导出前自动清掉，避免用户必须先手动清空全部数据。
  if (isInternalCategory(item.category)) item.category = '';
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

function isInternalCategory(value) {
  return /^类目ID\s*\d+$/i.test(cleanText(value || '', 200));
}

function preferCategoryValue(oldValue, newValue) {
  const oldCategory = cleanText(oldValue || '', 500);
  const newCategory = cleanText(newValue || '', 500);
  if (!oldCategory) return newCategory;
  if (!newCategory) return oldCategory;
  if (isInternalCategory(oldCategory) && !isInternalCategory(newCategory)) return newCategory;
  if (!isInternalCategory(oldCategory) && isInternalCategory(newCategory)) return oldCategory;
  return newCategory;
}

function mergeItemValues(old, item) {
  const merged = { ...old };
  for (const [field, value] of Object.entries(item || {})) {
    if (ARRAY_FIELDS.has(field)) continue;
    if (field === 'category') {
      if (value) {
        merged.category = preferCategoryValue(old.category, value);
      } else if (isInternalCategory(old.category) && /(?:^|,)dom(?:,|$)/i.test(item.dataSource || '')) {
        // 当前 DOM 明确没有公开类目名称时，不把接口里的内部 categoryId 导出为类目。
        merged.category = '';
      }
      continue;
    }
    // 异步接口或二次 DOM 扫描的空值不能覆盖已经成功识别的字段。
    if (value !== undefined && value !== null && String(value) !== '') merged[field] = value;
  }
  return merged;
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
    const merged = mergeItemValues(old, item);

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
    Number(review?.reviewIndex) > 0 ? Number(review.reviewIndex) : '',
    cleanText(review?.reviewer, 160),
    cleanText(review?.feedback, 1000),
    cleanText(review?.timeIp, 160),
    cleanUrl(review?.images?.[0] || '')
  ].join('|');
}

function sanitizeReview(input) {
  if (!input || typeof input !== 'object') return null;
  const review = {
    reviewIndex: Math.max(0, Number(input.reviewIndex) || 0),
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

function sanitizeStoreProfile(input, sourcePage = '', options = {}) {
  if (!input || typeof input !== 'object') return null;
  const includeProductOnlyFields = options.forProduct === true;
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
    sellerReviewCount: cleanText(input.sellerReviewCount || input.reviewCount || '', 100),
    reviews,
    reviewCountLoaded: reviews.length,
    sourcePage: cleanUrl(input.sourcePage || sourcePage),
    collectedAt: cleanText(input.collectedAt || input.capturedAt || '', 80) || new Date().toISOString()
  };
  // 开店时长和好评率只在“商品详情补充店铺字段”时作为商品字段使用。
  // 店铺页本身不提供可靠的这两个字段，不能把账号页/评价数量推算值写进店铺资料表。
  if (includeProductOnlyFields) {
    profile.storeDuration = cleanText(input.storeDuration || '', 300);
    profile.sellerGoodRate = rateText(input.sellerGoodRate || input.goodRate || '');
  }
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

function monitorAlarmName(monitorId) {
  return `${MONITOR_ALARM_PREFIX}${cleanText(monitorId, 100)}`;
}

function monitorKind(value) {
  return value === 'store' ? 'store' : 'product';
}

function monitorKindLabel(value) {
  return monitorKind(value) === 'store' ? '店铺' : '商品';
}

function isAbsoluteDownloadFolder(value) {
  const text = cleanText(value || '', 200);
  return /^(?:[a-z]:[\\/]|[\\/]{1,2})/i.test(text)
    || /(^|[\\/])\.\.(?:[\\/]|$)/.test(text);
}

function normalizeMonitorFolder(value, fallback = DEFAULT_SETTINGS.downloadFolder) {
  const raw = cleanText(value || fallback, 160);
  if (isAbsoluteDownloadFolder(raw)) {
    throw new Error('监控下载位置只能填写 Chrome 默认下载目录下的相对文件夹，不能填写绝对路径。');
  }
  return normalizeSettings({ downloadFolder: raw }).downloadFolder;
}

function normalizeMonitorLinks(kind, input) {
  const values = Array.isArray(input) ? input : String(input || '').split(/[\s,]+/);
  const validator = monitorKind(kind) === 'store' ? validSellerUrl : validItemUrl;
  return [...new Set(values
    .map(value => validator(cleanUrl(value)))
    .filter(Boolean))].slice(0, MAX_MONITOR_LINKS);
}

function monitorTimeParts(input, fallback = {}) {
  const hour = Number(input?.hour ?? fallback.hour ?? 9);
  const minute = Number(input?.minute ?? fallback.minute ?? 0);
  return {
    hour: Number.isFinite(hour) ? Math.max(0, Math.min(23, Math.floor(hour))) : 9,
    minute: Number.isFinite(minute) ? Math.max(0, Math.min(59, Math.floor(minute))) : 0
  };
}

function nextMonitorRunAt(config, from = Date.now()) {
  const now = new Date(from);
  const next = new Date(from);
  next.setHours(config.hour, config.minute, 0, 0);
  if (next.getTime() <= from + 500) next.setDate(next.getDate() + 1);
  return next.getTime();
}

function normalizeMonitorConfig(input = {}, previous = {}) {
  const kind = monitorKind(input.kind || previous.kind);
  const parts = monitorTimeParts(input, previous);
  const now = new Date().toISOString();
  const id = cleanText(input.id || previous.id || `monitor-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, 100);
  const links = normalizeMonitorLinks(kind, input.links ?? previous.links);
  const folder = normalizeMonitorFolder(
    input.downloadFolder ?? previous.downloadFolder,
    kind === 'store' ? '闲鱼研究监控/店铺' : '闲鱼研究监控/商品'
  );
  return {
    id,
    kind,
    name: cleanText(input.name || previous.name || `${monitorKindLabel(kind)}监控`, 80),
    links,
    hour: parts.hour,
    minute: parts.minute,
    downloadFolder: folder,
    mode: input.mode !== undefined ? (input.mode === 'api' ? 'api' : 'rpa') : (previous.mode === 'api' ? 'api' : 'rpa'),
    enabled: input.enabled !== undefined ? input.enabled !== false : previous.enabled !== false,
    createdAt: cleanText(previous.createdAt || input.createdAt || now, 80),
    updatedAt: now,
    nextRunAt: Number(input.nextRunAt || previous.nextRunAt || 0),
    lastRunAt: cleanText(input.lastRunAt || previous.lastRunAt || '', 80),
    lastRunStatus: cleanText(input.lastRunStatus || previous.lastRunStatus || '', 40),
    lastRunMessage: cleanText(input.lastRunMessage || previous.lastRunMessage || '', 1000),
    lastRunFile: cleanText(input.lastRunFile || previous.lastRunFile || '', 300),
    lastRunCount: Math.max(0, Number(input.lastRunCount ?? previous.lastRunCount ?? 0) || 0),
    lastRunFailureCount: Math.max(0, Number(input.lastRunFailureCount ?? previous.lastRunFailureCount ?? 0) || 0)
  };
}

async function readMonitors() {
  const result = await chrome.storage.local.get(MONITORS_KEY);
  const values = Array.isArray(result[MONITORS_KEY]) ? result[MONITORS_KEY] : [];
  return values.map(value => {
    try { return normalizeMonitorConfig(value, value); } catch (_) { return null; }
  }).filter(Boolean).slice(0, MAX_MONITORS);
}

async function writeMonitors(monitors) {
  const normalized = (Array.isArray(monitors) ? monitors : [])
    .map(value => {
      try { return normalizeMonitorConfig(value, value); } catch (_) { return null; }
    })
    .filter(Boolean)
    .slice(0, MAX_MONITORS);
  await chrome.storage.local.set({ [MONITORS_KEY]: normalized });
  return normalized;
}

async function readMonitorRuns() {
  const result = await chrome.storage.local.get(MONITOR_RUNS_KEY);
  return result[MONITOR_RUNS_KEY] && typeof result[MONITOR_RUNS_KEY] === 'object'
    ? result[MONITOR_RUNS_KEY]
    : {};
}

async function writeMonitorRuns(runs) {
  await chrome.storage.local.set({ [MONITOR_RUNS_KEY]: runs || {} });
  return runs || {};
}

async function readMonitorRun(monitorId) {
  const runs = await readMonitorRuns();
  return runs[monitorId] || null;
}

async function writeMonitorRun(run) {
  const runs = await readMonitorRuns();
  runs[run.monitorId] = run;
  await writeMonitorRuns(runs);
  return run;
}

async function deleteMonitorRun(monitorId) {
  const runs = await readMonitorRuns();
  delete runs[monitorId];
  await writeMonitorRuns(runs);
  return runs;
}

async function patchMonitor(monitorId, patch) {
  const monitors = await readMonitors();
  const index = monitors.findIndex(item => item.id === monitorId);
  if (index < 0) return null;
  monitors[index] = normalizeMonitorConfig({ ...monitors[index], ...patch }, monitors[index]);
  await writeMonitors(monitors);
  return monitors[index];
}

async function scheduleMonitorAlarm(config, when = nextMonitorRunAt(config)) {
  const name = monitorAlarmName(config.id);
  await chrome.alarms.clear(name).catch(() => {});
  if (config.enabled) {
    chrome.alarms.create(name, { when: Math.max(Date.now() + 500, Number(when) || nextMonitorRunAt(config)) });
  }
  return when;
}

function itemsForJob(job, items) {
  if (Array.isArray(job?.stagedItems)) {
    return job.stagedItems.map(item => sanitizeItem(item)).filter(Boolean);
  }
  const resultKeys = new Set(Array.isArray(job.resultKeys) ? job.resultKeys : []);
  return resultKeys.size
    ? items.filter(item => resultKeys.has(itemKey(item)))
    : items;
}

function historySummary(job, items, extra = {}) {
  const snapshot = Array.isArray(extra.itemsSnapshot)
    ? extra.itemsSnapshot.map(item => sanitizeItem(item)).filter(Boolean)
    : itemsForJob(job, items);
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
    itemsSnapshot: Array.isArray(extra.itemsSnapshot)
      ? extra.itemsSnapshot
      : itemsForJob(job, items),
    storeProfilesSnapshot: Array.isArray(extra.storeProfilesSnapshot)
      ? extra.storeProfilesSnapshot
      : []
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

async function writeJob(job, options = {}) {
  if (!options.force && isJobCancelled(job)) return readJob();
  await chrome.storage.local.set({ [JOB_KEY]: job });
  return job;
}

function jobIsActive(job) {
  return Boolean(job && !['completed', 'stopped', 'failed'].includes(job.status));
}

async function canContinueJob(job) {
  if (!job?.id || isJobCancelled(job)) return false;
  const current = await readJob();
  return Boolean(current && current.id === job.id && jobIsActive(current));
}

function jobMessage(job, message) {
  return {
    ...job,
    message,
    updatedAt: new Date().toISOString()
  };
}

function jobUpdatedAt(job) {
  return Date.parse(job?.updatedAt || job?.createdAt || '') || 0;
}

async function recoverStaleJob(job) {
  if (!jobIsActive(job)) return job;

  const updatedAt = jobUpdatedAt(job);
  const age = updatedAt ? Date.now() - updatedAt : JOB_STALE_TIMEOUT_MS + 1;
  if (age < JOB_STALE_TIMEOUT_MS) return job;

  // “ready-to-collect” 只表示闹钟可能漏掉了，不应直接把任务判死；重新排一个
  // 短闹钟可以修复扩展重载/Service Worker 睡眠后遗失的单次 alarm。
  if (job.status === 'ready-to-collect') {
    return scheduleJob(job, 'ready-to-collect', 250);
  }

  const reason = job.status === 'waiting-page'
    ? '采集标签页长时间没有完成加载'
    : '页面长时间没有返回采集结果';
  return finishJob(
    { ...job, staleRecovered: true },
    'failed',
    `${reason}（超过 ${Math.round(JOB_STALE_TIMEOUT_MS / 1000)} 秒），已自动释放任务锁；已经采集的数据仍保留，请重新开始。`
  );
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

function sendTabMessage(tabId, message, timeoutMs = TAB_MESSAGE_TIMEOUT_MS) {
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
    type: type === 'links'
      ? '链接批量'
      : type === 'store'
        ? '店铺资料'
        : type === 'monitor-product'
          ? '商品监控'
          : type === 'monitor-store'
            ? '店铺监控'
        : type === 'detail'
          ? '当前详情'
          : type === 'data'
            ? '数据中心商品'
            : '搜索跨页',
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
    const isStoreExport = exportType === 'store' || exportType === 'monitor-store';
    const exportCount = isStoreExport
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
      exportKind: isStoreExport ? 'store' : 'product',
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

async function preparePublicPage(tabId, expectedPageType, options = {}) {
  await ensureContentReceiver(tabId);
  const result = await sendTabMessage(tabId, {
    type: 'PREPARE_PUBLIC_PAGE',
    expectedPageType,
    maxAttempts: Math.max(3, Number(options.maxAttempts) || 12)
  }, Math.max(TAB_MESSAGE_TIMEOUT_MS, Number(options.timeoutMs) || 18_000));
  if (!result?.ok || !result.ready) {
    throw new Error(result?.error || `闲鱼${expectedPageType || ''}页面尚未稳定加载。`);
  }
  return result;
}

async function sendCollectionCommand(tabId) {
  await preparePublicPage(tabId, 'detail', { maxAttempts: 14, timeoutMs: 20_000 });
  return sendTabMessage(tabId, { type: 'COLLECT_CURRENT_PAGE', persistToDataCenter: false });
}

async function sendApiCollectionCommand(tabId) {
  await preparePublicPage(tabId, 'detail', { maxAttempts: 14, timeoutMs: 20_000 });
  return sendTabMessage(tabId, { type: 'START_API_CAPTURE', persistToDataCenter: false });
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
  if (profile.profileScope !== 'account-info-scope') return false;

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

function applyProfileToItem(item, profile) {
  const base = sanitizeItem(item || {});
  if (!base || !profile) return base;

  const patch = { ...base };
  for (const field of [
    'sellerName', 'sellerUrl', 'sellerLocation', 'sellerFollowers', 'sellerFollowing',
    'sellerProductCount', 'sellerIntro', 'storeDuration', 'sellerReviewSummary', 'sellerReviewCount'
  ]) {
    if (profile[field]) patch[field] = profile[field];
  }

  const profileGoodRate = rateText(profile.sellerGoodRate || profile.goodRate || '');
  if (profileGoodRate && !rateText(patch.itemGoodRate || '')) {
    patch.itemGoodRate = profileGoodRate;
    if (!patch.reviewSummary || !rateText(patch.reviewSummary)) patch.reviewSummary = profileGoodRate;
  }
  if (Array.isArray(profile.reviewSamples) && profile.reviewSamples.length) {
    patch.reviewSamples = profile.reviewSamples;
  }
  patch.dataSource = [base.dataSource, 'account-dom'].filter(Boolean).join(',');
  return sanitizeItem(patch);
}

async function persistStoreProfile(profile, sourcePage = '') {
  const clean = sanitizeStoreProfile(profile, sourcePage);
  if (!clean) return null;
  const profiles = mergeStoreProfiles(await readStoreProfiles(), [clean]);
  await writeStoreProfiles(profiles);
  return profiles.find(item => storeProfileIdentity(item) === storeProfileIdentity(clean)) || clean;
}

function mergeStagedItemWithProfile(job, item, profile) {
  const enriched = applyProfileToItem(item, profile);
  if (!enriched) return job;
  return {
    ...job,
    stagedItems: mergeItems(Array.isArray(job.stagedItems) ? job.stagedItems : [], [enriched])
  };
}

// Keep the legacy helper for previously committed data, but use the same
// profile-to-item mapping as staged product tasks.
async function mergeStoredItemWithProfile(identity, profile) {
  const items = await readItems();
  const existing = items.find(item => itemKey(item) === itemKey(identity || {}));
  const patch = applyProfileToItem(existing, profile);
  if (!patch) return false;
  await writeItems(mergeItems(items, [patch]));
  return true;
}

async function fetchSellerProfile(sellerUrl) {
  const url = validSellerUrl(sellerUrl);
  if (!url) throw new Error('没有识别到有效的卖家账号页链接。');

  const tab = await tabsCreate({ url, active: false });
  try {
    await waitForTabComplete(tab.id);
    await preparePublicPage(tab.id, 'account', { maxAttempts: 14, timeoutMs: 20_000 });
    const info = await ensureContentReceiver(tab.id);
    if (info?.pageType !== 'account') throw new Error('卖家账号页未正确加载。');
    return await readStableAccountProfile(tab.id);
  } finally {
    await tabsRemove(tab.id).catch(() => {});
  }
}

async function fetchSellerProfileInTab(tabId, sellerUrl, returnUrl) {
  const url = validSellerUrl(sellerUrl);
  const originalUrl = validItemUrl(returnUrl) || cleanUrl(returnUrl || '');
  if (!url || !Number.isInteger(Number(tabId))) {
    throw new Error('当前商品页没有可复用的标签页。');
  }

  try {
    await tabsUpdate(Number(tabId), { url });
    await waitForTabComplete(Number(tabId));
    await preparePublicPage(Number(tabId), 'account', { maxAttempts: 14, timeoutMs: 20_000 });
    const info = await ensureContentReceiver(Number(tabId));
    if (info?.pageType !== 'account') throw new Error('卖家账号页未正确加载。');
    return await readStableAccountProfile(Number(tabId));
  } finally {
    // 当前详情页补采集复用原标签页；资料读取后恢复商品详情，避免留下额外标签页。
    if (originalUrl) {
      try {
        await tabsUpdate(Number(tabId), { url: originalUrl });
        await waitForTabComplete(Number(tabId));
        await preparePublicPage(Number(tabId), 'detail', { maxAttempts: 14, timeoutMs: 20_000 });
      } catch (_) {
        // 店铺资料已经读到时，不让返回原详情页失败覆盖有效补采集结果。
      }
    }
  }
}

async function discoverSellerEntry(tabId) {
  const numericTabId = Number(tabId);
  if (!Number.isInteger(numericTabId)) return null;
  await preparePublicPage(numericTabId, 'detail', { maxAttempts: 12, timeoutMs: 18_000 });
  const info = await ensureContentReceiver(numericTabId);
  if (info?.pageType !== 'detail') return null;
  const entry = await sendTabMessage(numericTabId, { type: 'GET_SELLER_ENTRY' });
  const sellerUrl = validSellerUrl(entry?.sellerUrl || '');
  if (!sellerUrl) return null;
  return {
    ...entry,
    sellerUrl
  };
}

function collectedItemForLink(result, link) {
  const items = [
    ...(Array.isArray(result?.items) ? result.items : []),
    ...(Array.isArray(result?.stagedItems) ? result.stagedItems : [])
  ];
  const itemId = cleanText(link?.itemId, 200);
  const exact = items.find(item => itemId && cleanText(item?.itemId, 200) === itemId)
    || items.find(item => cleanUrl(item?.itemUrl || '') === cleanUrl(link?.itemUrl || ''));
  return exact || items[0] || null;
}

async function prepareSellerEnrichment(job, item, pendingCount) {
  if (job.collectSellerInfo === false) return { kind: 'disabled', job };
  if (!(await canContinueJob(job))) return { kind: 'cancelled', job: await readJob() };
  let currentItem = sanitizeItem(item || {});
  let sellerUrl = validSellerUrl(currentItem?.sellerUrl || '');
  if (!sellerUrl && job.tabId) {
    try {
      const discovered = await discoverSellerEntry(job.tabId);
      sellerUrl = validSellerUrl(discovered?.sellerUrl || '');
      if (sellerUrl && currentItem) {
        currentItem = sanitizeItem({
          ...currentItem,
          sellerUrl,
          sellerName: currentItem.sellerName || discovered.sellerName || ''
        });
      }
    } catch (_) {
      // 详情页仍在渲染时先保留原结果，后续任务重试会再次发现卖家入口。
    }
  }
  if (!(await canContinueJob(job))) return { kind: 'cancelled', job: await readJob() };
  if (!sellerUrl) return { kind: 'unavailable', job };

  const jobWithSellerEntry = currentItem
    ? {
        ...job,
        stagedItems: mergeItems(Array.isArray(job.stagedItems) ? job.stagedItems : [], [currentItem])
      }
    : job;

  const key = sellerProfileKey(sellerUrl);
  const cached = jobWithSellerEntry.sellerProfiles?.[key]
    || (await readStoreProfiles()).find(profile => sellerProfileKey(profile?.sellerUrl || '') === key);
  if (!(await canContinueJob(job))) return { kind: 'cancelled', job: await readJob() };
  const identity = itemIdentity(currentItem);
  if (cached) {
    const stagedJob = mergeStagedItemWithProfile(jobWithSellerEntry, currentItem, cached);
    return { kind: 'cached', job: {
      ...stagedJob,
      sellerProfiles: { ...(jobWithSellerEntry.sellerProfiles || {}), [key]: cached }
    } };
  }

  const waiting = jobMessage({
    ...jobWithSellerEntry,
    status: 'waiting-page',
    stage: 'account-page',
    pendingItem: identity,
    pendingSellerUrl: sellerUrl,
    pendingSellerKey: key,
    pendingCount: Math.max(0, Number(pendingCount) || 0),
    sellerRetries: 0
  }, '正在打开卖家账号页，补充店铺简介和公开评价…');
  if (!(await canContinueJob(job))) return { kind: 'cancelled', job: await readJob() };
  await writeJob(waiting);
  if (!(await canContinueJob(waiting))) return { kind: 'cancelled', job: await readJob() };
  await tabsUpdate(job.tabId, { url: sellerUrl });
  if (!(await canContinueJob(waiting))) return { kind: 'cancelled', job: await readJob() };
  return {
    kind: 'scheduled',
    job: await scheduleJob(waiting, 'ready-to-collect', Math.max(1400, Number(job.delayMs) || 1600))
  };
}

async function scheduleJob(job, status, delayMs = 1000) {
  if (!(await canContinueJob(job))) return readJob();
  const next = jobMessage({ ...job, status }, job.message || '等待下一步');
  await writeJob(next);
  if (!(await canContinueJob(next))) return readJob();
  await chrome.alarms.clear(JOB_ALARM);
  if (!(await canContinueJob(next))) return readJob();
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

async function finishJob(job, status, message, options = {}) {
  const force = Boolean(options.force);
  if (!force && isJobCancelled(job)) return readJob();
  await chrome.alarms.clear(JOB_ALARM);
  const current = await readJob();
  if (!current || current.id !== job?.id || !jobIsActive(current) || (!force && isJobCancelled(job))) {
    return current || job;
  }
  const finalJob = jobMessage({ ...(force ? current : job), status }, message);
  const persistedJob = await writeJob(finalJob, { force });
  if (!force && (isJobCancelled(job) || persistedJob?.id !== job.id || persistedJob?.status !== status)) {
    return persistedJob || await readJob();
  }

  if (status === 'stopped' && options.closeTaskTab && Number.isInteger(Number(finalJob.tabId))) {
    await tabsRemove(Number(finalJob.tabId)).catch(() => {});
  }

  const jobItems = itemsForJob(finalJob, await readItems());

  let exportResult = null;
  if (status === 'completed') {
    const settings = await readSettings();
    if (settings.downloadMode === 'auto') {
      try {
        exportResult = await runExport(jobItems, settings, {
          type: finalJob.type,
          mode: finalJob.mode,
          // 商品任务只导出商品结果。店铺资料和评价必须通过“当前店铺页”单独导出，
          // 不能因为浏览器里有历史店铺资料就混入商品工作簿。
          storeProfiles: []
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
    fileName: finalJob.fileName,
    itemsSnapshot: jobItems,
    storeProfilesSnapshot: []
  });
  await notifyJobFinished(finalJob, exportResult);
  return finalJob;
}

async function advanceLinkJob(job, failureMessage = '') {
  if (!(await canContinueJob(job))) return readJob();
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
    if (!(await canContinueJob(next))) return readJob();
    await writeJob(waiting);
    if (!(await canContinueJob(waiting))) return readJob();
    await tabsUpdate(job.tabId, { url: job.links[nextIndex] });
    if (!(await canContinueJob(waiting))) return readJob();
    return scheduleJob(waiting, 'ready-to-collect', Math.max(1000, Number(job.delayMs) || 1400));
  } catch (error) {
    return advanceLinkJob(next, error.message || String(error));
  }
}

async function processLinkJob(job) {
  if (!(await canContinueJob(job))) return readJob();
  try {
    const pageInfo = await ensureContentReceiver(job.tabId);
    if (pageInfo?.pageType !== 'detail') {
      throw new Error('自动打开后当前标签页不是商品详情页，未写入非详情页面数据。');
    }
    const expectedUrl = job.links?.[job.index] || '';
    if (expectedUrl && !itemUrlsMatch(pageInfo.url, expectedUrl)) {
      throw new Error('当前详情页链接与待采集商品不一致，已等待页面重新导航。');
    }
    const result = assertDetailCollection(await sendCollectionByMode(job.tabId, job.mode), expectedUrl);
    const count = Number(result?.count ?? result?.added ?? 0);
    const next = {
      ...job,
      stagedItems: Array.isArray(result?.stagedItems) ? result.stagedItems : job.stagedItems,
      resultKeys: [...new Set([...(job.resultKeys || []), ...(result.keys || [])])],
      retries: 0
    };
    const detailItem = collectedItemForLink(result, { itemUrl: job.links?.[job.index] || '' });
    const enrichment = await prepareSellerEnrichment(next, detailItem, count);
    if (enrichment.kind === 'cancelled') return enrichment.job;
    if (enrichment.kind === 'scheduled') return enrichment.job;
    return advanceLinkJob({
      ...enrichment.job,
      collected: Number(job.collected || 0) + count
    });
  } catch (error) {
    if (isJobCancelled(job)) return readJob();
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

function isInvalidDetailRecord(item) {
  const text = `${item?.title || ''}\n${item?.description || ''}`;
  const hasProductSignal = Boolean(
    item?.sellerUrl || item?.sellerName || item?.price || (Array.isArray(item?.images) && item.images.length)
  );
  return !hasProductSignal && /闲鱼社区服务协议|用户协议|隐私政策|平台规则|服务条款/i.test(text);
}

function assertDetailCollection(result, expectedUrl = '') {
  if (!result || result.ok === false) {
    throw new Error(result?.error || '详情页没有返回采集结果');
  }
  if (result.pageType !== 'detail') {
    throw new Error('当前打开的页面不是商品详情页，已跳过，避免把搜索卡片写入结果');
  }
  const items = (Array.isArray(result.items) ? result.items : [])
    .filter(item => !isInvalidDetailRecord(item));
  const count = Number(result.count ?? result.added ?? items.length ?? 0);
  if (!count || !items.length) {
    throw new Error('当前页面没有识别到有效商品详情，可能仍在加载或打开了平台协议页，已等待页面完成渲染后重试。');
  }
  const expectedId = itemIdFromUrl(expectedUrl);
  if (expectedId && !items.some(item => (
    cleanText(item?.itemId, 200) === expectedId || itemIdFromUrl(item?.itemUrl) === expectedId
  ))) {
    throw new Error('当前详情页与待采集商品不一致，未写入当前页面数据。');
  }
  return { ...result, items, count: items.length };
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
  if (!(await canContinueJob(job))) return readJob();
  const waiting = jobMessage({
    ...job,
    status: 'waiting-page',
    stage,
    pageUrl: stage === 'search-page' ? cleanUrl(url) : job.pageUrl,
    expectedDetailUrl: stage === 'detail-page' ? cleanUrl(url) : '',
    expectedSearchPage: stage === 'search-page' ? Number(job.expectedSearchPage || 0) : 0
  }, message);
  await writeJob(waiting);
  if (!(await canContinueJob(waiting))) return readJob();
  await tabsUpdate(job.tabId, { url });
  if (!(await canContinueJob(waiting))) return readJob();

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
  if (!(await canContinueJob(job))) return readJob();
  try {
    const pageInfo = await ensureContentReceiver(job.tabId);
    if (pageInfo?.pageType !== 'search') {
      throw new Error(`采集专用标签页当前不是搜索结果页（实际为${pageInfo?.pageType || '未知页面'}）。`);
    }
    const result = await sendTabMessage(job.tabId, { type: 'GET_SEARCH_LINKS' }, 35_000);
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
    if (isJobCancelled(job)) return readJob();
    const retries = Number(job.retries || 0) + 1;
    if (retries <= 2) {
      return scheduleJob({ ...job, retries }, 'ready-to-collect', 1500);
    }
    return finishJob({ ...job, retries }, 'failed', `搜索页链接发现失败：${error.message || String(error)}`);
  }
}

async function processSearchDetail(job) {
  if (!(await canContinueJob(job))) return readJob();
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
    const result = assertDetailCollection(
      await sendCollectionByMode(job.tabId, job.mode),
      currentLink.itemUrl
    );
    const count = Number(result.count ?? result.added ?? 0);
    const next = {
      ...job,
      stagedItems: Array.isArray(result?.stagedItems) ? result.stagedItems : job.stagedItems,
      expectedDetailUrl: '',
      resultKeys: [...new Set([...(job.resultKeys || []), ...(result.keys || [])])]
    };
    const detailItem = collectedItemForLink(result, currentLink);
    const enrichment = await prepareSellerEnrichment(next, detailItem, count);
    if (enrichment.kind === 'cancelled') return enrichment.job;
    if (enrichment.kind === 'scheduled') return enrichment.job;
    return advanceSearchDetail(enrichment.job, count);
  } catch (error) {
    if (isJobCancelled(job)) return readJob();
    const retries = Number(job.retries || 0) + 1;
    if (retries <= 2) {
      return scheduleJob({ ...job, retries }, 'ready-to-collect', 1500);
    }
    return advanceSearchDetail({ ...job, retries: 0 }, 0, error.message || String(error));
  }
}

async function finishPendingSellerStep(job, profile = null, errorMessage = '') {
  if (!(await canContinueJob(job))) return readJob();
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
    // 商品任务只把账号页基础资料合并回商品暂存行；完整店铺资料/评价必须由
    // “采集当前店铺页”明确提交，避免店铺表出现只读到首屏资料的半成品。
    const productProfile = sanitizeStoreProfile(profile, job.pendingSellerUrl || '');
    const sellerProfiles = {
      ...(job.sellerProfiles || {}),
      ...(key ? { [key]: productProfile || profile } : {})
    };
    next = mergeStagedItemWithProfile(next, pending, productProfile || profile);
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
  if (!(await canContinueJob(job))) return readJob();
  try {
    const pageInfo = await ensureContentReceiver(job.tabId);
    if (pageInfo?.pageType !== 'account') throw new Error('当前页面不是卖家账号页。');
    const profile = await readStableAccountProfile(job.tabId);
    return finishPendingSellerStep(job, profile);
  } catch (error) {
    if (isJobCancelled(job)) return readJob();
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
  if (!(await canContinueJob(rawJob))) return readJob();

  const job = normalizeSearchJob(rawJob);
  const collectingMessage = job.stage === 'account-page'
    ? '正在读取卖家账号页的公开简介和评价…'
    : job.type === 'search' && job.stage === 'search-page'
      ? '正在读取当前搜索页的商品详情链接…'
      : '正在采集当前商品详情页…';
  const collecting = { ...job, status: 'collecting' };
  await writeJob(jobMessage(collecting, collectingMessage));
  if (!(await canContinueJob(collecting))) return readJob();
  if (job.stage === 'account-page') await processAccountPage(collecting);
  else if (job.type === 'links') await processLinkJob(collecting);
  else if (job.type === 'search' && job.stage === 'detail-page') await processSearchDetail(collecting);
  else if (job.type === 'search') await processSearchPage(collecting);
}

async function startLinksJob(links, delayMs = 1500, mode = 'rpa') {
  const current = await recoverStaleJob(await readJob());
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
    stagedItems: [],
    committedToDataCenter: false,
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
  await writeJob(job);
  return scheduleJob(job, 'ready-to-collect', 1400);
}

async function startSearchJob(startUrl, targetCount, maxPages, delayMs = 1800, mode = 'rpa') {
  const current = await recoverStaleJob(await readJob());
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
    stagedItems: [],
    committedToDataCenter: false,
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
  await writeJob(job);
  return scheduleJob(job, 'ready-to-collect', 1800);
}

function monitorRunProgress(run) {
  const total = Array.isArray(run?.links) ? run.links.length : 0;
  const index = Math.min(total, Math.max(0, Number(run?.index) || 0));
  return {
    status: cleanText(run?.status || '', 40),
    index,
    total,
    currentLink: cleanUrl(run?.links?.[index] || ''),
    itemCount: Array.isArray(run?.items) ? run.items.length : 0,
    storeCount: Array.isArray(run?.storeProfiles) ? run.storeProfiles.length : 0,
    failureCount: Array.isArray(run?.failures) ? run.failures.length : 0,
    message: cleanText(run?.message || '', 1000),
    updatedAt: cleanText(run?.updatedAt || '', 80)
  };
}

async function monitorView() {
  const monitors = await readMonitors();
  const runs = await readMonitorRuns();
  return monitors.map(config => ({
    ...config,
    running: Boolean(runs[config.id]),
    run: runs[config.id] ? monitorRunProgress(runs[config.id]) : null
  }));
}

async function scheduleMonitorStep(monitorId, delayMs = 1200) {
  const name = monitorAlarmName(monitorId);
  await chrome.alarms.clear(name).catch(() => {});
  chrome.alarms.create(name, { when: Date.now() + Math.max(500, Number(delayMs) || 1200) });
}

async function monitorExportSettings(config) {
  const settings = await readSettings();
  const baseName = cleanDownloadPart(config.name || `${monitorKindLabel(config.kind)}监控`, '闲鱼监控');
  return normalizeSettings({
    ...settings,
    mode: config.mode,
    downloadMode: 'auto',
    saveAs: false,
    downloadFolder: config.downloadFolder,
    fileNameTemplate: `${baseName}-{type}-{date}-{time}-{count}`
  });
}

async function ensureMonitorTab(run, url) {
  let tabId = Number(run.tabId);
  if (!Number.isInteger(tabId)) {
    const tab = await tabsCreate({ url, active: false });
    tabId = Number(tab.id);
  }

  try {
    await tabsUpdate(tabId, { url });
  } catch (error) {
    const tab = await tabsCreate({ url, active: false });
    tabId = Number(tab.id);
  }

  await waitForTabComplete(tabId, 35_000).catch(() => {});
  return tabId;
}

async function collectMonitorProduct(tabId, link, mode, collectSellerInfo) {
  const pageInfo = await ensureContentReceiver(tabId);
  if (pageInfo?.pageType !== 'detail') {
    throw new Error('监控打开的页面不是商品详情页，已跳过，避免把搜索卡片写入商品表。');
  }
  const result = assertDetailCollection(await sendCollectionByMode(tabId, mode), link);
  let item = collectedItemForLink(result, { itemUrl: link });
  if (!item) throw new Error('详情页没有返回可保存的商品记录。');

  if (collectSellerInfo !== false) {
    let sellerUrl = validSellerUrl(item.sellerUrl || '');
    if (!sellerUrl) {
      const entry = await discoverSellerEntry(tabId);
      sellerUrl = validSellerUrl(entry?.sellerUrl || '');
      if (sellerUrl) item = sanitizeItem({
        ...item,
        sellerUrl,
        sellerName: item.sellerName || entry.sellerName || ''
      }, link);
    }

    if (sellerUrl) {
      const profile = await fetchSellerProfileInTab(tabId, sellerUrl, link);
      const productProfile = sanitizeStoreProfile(
        { ...profile, reviews: [] },
        sellerUrl,
        { forProduct: true }
      );
      item = applyProfileToItem(item, productProfile || profile);
    }
  }

  return sanitizeItem({ ...item, sourcePage: link }, link);
}

async function collectMonitorStore(tabId, link) {
  const pageInfo = await ensureContentReceiver(tabId);
  if (pageInfo?.pageType !== 'account') {
    throw new Error('监控打开的页面不是店铺/账号页，已跳过。');
  }
  const result = await sendTabMessage(tabId, {
    type: 'COLLECT_CURRENT_STORE_PAGE',
    persistToDataCenter: false
  }, 55_000);
  if (!result?.ok) throw new Error(result?.error || '店铺页没有返回可保存的数据。');
  const profile = sanitizeStoreProfile(result.profile || result, link);
  if (!profile) throw new Error('店铺页没有识别到公开资料或评价。');
  return profile;
}

async function notifyMonitorFinished(config, status, message) {
  const settings = await readSettings();
  if (!settings.notifyOnComplete || !chrome.notifications?.create) return;
  const statusLabel = status === 'completed' ? '完成' : status === 'partial' ? '部分完成' : status === 'stopped' ? '已停止' : '失败';
  await chrome.notifications.create(`xianyu-monitor-${config.id}-${Date.now()}`, {
    type: 'basic',
    title: `闲鱼研究采集器 · ${config.name || `${monitorKindLabel(config.kind)}监控`} ${statusLabel}`,
    message,
    iconUrl: chrome.runtime.getURL('icon.svg')
  }).catch(() => {});
}

async function finishMonitorRun(run, options = {}) {
  const current = await readMonitorRun(run.monitorId);
  if (!current || current.id !== run.id) return current || run;
  const configs = await readMonitors();
  const config = configs.find(item => item.id === run.monitorId);
  const count = run.kind === 'store'
    ? (Array.isArray(run.storeProfiles) ? run.storeProfiles.length : 0)
    : (Array.isArray(run.items) ? run.items.length : 0);
  const failures = Array.isArray(run.failures) ? run.failures : [];
  let exportResult = null;
  let exportError = '';

  if (config && options.skipExport !== true && count > 0 && options.status !== 'stopped') {
    try {
      const settings = await monitorExportSettings(config);
      exportResult = await runExport(
        run.kind === 'store' ? [] : run.items,
        settings,
        {
          type: run.kind === 'store' ? 'monitor-store' : 'monitor-product',
          mode: run.mode,
          storeProfiles: run.kind === 'store' ? run.storeProfiles : []
        }
      );
    } catch (error) {
      exportError = error?.message || String(error);
    }
  }

  let status = options.status || (count > 0 ? 'completed' : 'failed');
  if (status === 'completed' && (failures.length || exportError)) status = 'partial';
  if (!count && !options.status) status = 'failed';
  const parts = [
    `${monitorKindLabel(run.kind)}监控${status === 'completed' ? '完成' : status === 'partial' ? '部分完成' : status === 'stopped' ? '已停止' : '失败'}`,
    run.kind === 'store' ? `成功 ${count} 个店铺` : `成功 ${count} 条商品`,
    failures.length ? `失败 ${failures.length} 条` : '',
    exportResult?.filename ? `Excel 已下载：${exportResult.filename}` : '',
    exportError ? `自动下载失败：${exportError}` : '',
    options.message || ''
  ].filter(Boolean).join('，');

  if (Number.isInteger(Number(run.tabId))) await tabsRemove(Number(run.tabId)).catch(() => {});
  await chrome.alarms.clear(monitorAlarmName(run.monitorId)).catch(() => {});
  await deleteMonitorRun(run.monitorId);

  if (config) {
    const nextRunAt = config.enabled ? nextMonitorRunAt(config) : 0;
    const updated = normalizeMonitorConfig({
      ...config,
      nextRunAt,
      lastRunAt: new Date().toISOString(),
      lastRunStatus: status,
      lastRunMessage: parts,
      lastRunFile: exportResult?.filename || '',
      lastRunCount: count,
      lastRunFailureCount: failures.length
    }, config);
    const nextConfigs = configs.map(item => item.id === config.id ? updated : item);
    await writeMonitors(nextConfigs);
    if (updated.enabled) await scheduleMonitorAlarm(updated, nextRunAt);
    await notifyMonitorFinished(updated, status, parts);
  }
  return { ...run, status, message: parts, exportResult, exportError };
}

async function processMonitorRunStep(monitorId) {
  if (monitorRunLocks.has(monitorId)) return readMonitorRun(monitorId);
  monitorRunLocks.add(monitorId);
  try {
    const run = await readMonitorRun(monitorId);
    if (!run) return null;
    const config = (await readMonitors()).find(item => item.id === monitorId);
    if (!config || (!config.enabled && run.force !== true)) {
      return finishMonitorRun(run, { status: 'stopped', skipExport: true, message: '监控已暂停或删除。' });
    }

    const total = Array.isArray(run.links) ? run.links.length : 0;
    if ((Number(run.index) || 0) >= total) return finishMonitorRun(run);
    const link = run.links[run.index];
    const collecting = {
      ...run,
      status: 'collecting',
      currentLink: link,
      updatedAt: new Date().toISOString(),
      message: `正在处理第 ${Number(run.index) + 1}/${total} 个${monitorKindLabel(run.kind)}链接。`
    };
    await writeMonitorRun(collecting);

    let next = { ...collecting };
    try {
      const tabId = await ensureMonitorTab(collecting, link);
      next.tabId = tabId;
      if (run.kind === 'store') {
        const profile = await collectMonitorStore(tabId, link);
        next.storeProfiles = mergeStoreProfiles(next.storeProfiles || [], [profile]);
      } else {
        const settings = await readSettings();
        const item = await collectMonitorProduct(tabId, link, run.mode, settings.collectSellerInfo !== false);
        next.items = mergeItems(next.items || [], [item]);
      }
    } catch (error) {
      next.failures = [
        ...(next.failures || []),
        { url: link, error: error?.message || String(error) }
      ].slice(-100);
    }

    next.index = Number(run.index || 0) + 1;
    next.status = 'waiting';
    next.updatedAt = new Date().toISOString();
    next.message = `已处理 ${next.index}/${total} 个${monitorKindLabel(run.kind)}链接，${run.kind === 'store' ? `成功 ${next.storeProfiles?.length || 0} 个店铺` : `成功 ${next.items?.length || 0} 条商品`}。`;
    await writeMonitorRun(next);
    if (next.index >= total) return finishMonitorRun(next);
    await scheduleMonitorStep(monitorId, 1400);
    return next;
  } finally {
    monitorRunLocks.delete(monitorId);
  }
}

async function startMonitorRun(monitorId, force = false) {
  const config = (await readMonitors()).find(item => item.id === monitorId);
  if (!config) throw new Error('找不到这条监控配置。');
  if (!config.enabled && !force) throw new Error('这条监控已暂停，请先重新启用。');
  const existing = await readMonitorRun(monitorId);
  if (existing) throw new Error('这条监控正在运行，请等待本轮完成。');
  if (!config.links.length) throw new Error('这条监控没有有效链接。');

  const settings = await readSettings();
  const run = {
    id: `monitor-run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    monitorId,
    kind: config.kind,
    mode: config.mode,
    links: [...config.links],
    index: 0,
    status: 'waiting',
    tabId: 0,
    items: [],
    storeProfiles: [],
    failures: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    message: `监控已启动，共 ${config.links.length} 个${monitorKindLabel(config.kind)}链接。`,
    collectSellerInfo: settings.collectSellerInfo !== false,
    force
  };
  await writeMonitorRun(run);
  await scheduleMonitorStep(monitorId, 250);
  return run;
}

async function syncMonitorAlarms() {
  const monitors = await readMonitors();
  let changed = false;
  for (const config of monitors) {
    if (!config.enabled) {
      await chrome.alarms.clear(monitorAlarmName(config.id)).catch(() => {});
      continue;
    }
    let alarm = null;
    if (typeof chrome.alarms.get === 'function') {
      alarm = await chrome.alarms.get(monitorAlarmName(config.id)).catch(() => null);
    }
    if (!alarm) {
      const nextRunAt = nextMonitorRunAt(config);
      await scheduleMonitorAlarm(config, nextRunAt);
      config.nextRunAt = nextRunAt;
      changed = true;
    }
  }
  if (changed) await writeMonitors(monitors);
  return monitors;
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
  const monitorsResult = await chrome.storage.local.get(MONITORS_KEY);
  if (!Array.isArray(monitorsResult[MONITORS_KEY])) await writeMonitors([]);
  await syncMonitorAlarms();
  await configureSidePanel();
});

chrome.runtime.onStartup.addListener(() => {
  void configureSidePanel();
  void syncMonitorAlarms();
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
  else if (alarm.name?.startsWith(MONITOR_ALARM_PREFIX)) {
    const monitorId = alarm.name.slice(MONITOR_ALARM_PREFIX.length);
    void (async () => {
      const run = await readMonitorRun(monitorId);
      if (run) await processMonitorRunStep(monitorId);
      else {
        const config = (await readMonitors()).find(item => item.id === monitorId);
        if (config?.enabled) {
          try {
            await startMonitorRun(monitorId);
            await processMonitorRunStep(monitorId);
          } catch (_) {
            // 监控配置可能在闹钟触发的同时被删除或暂停；下一次保存会重新同步闹钟。
          }
        }
      }
    })();
  }
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
        const resultKeys = incoming.map(itemKey);
        const activeJob = activeJobBeforeWrite || await readJob();
        const belongsToActiveTask = Boolean(
          activeJob
          && jobIsActive(activeJob)
          && activeJob.tabId === sender?.tab?.id
          && ['links', 'search'].includes(activeJob.type)
        );

        // 详情页单采和批量任务默认只写入“本次结果暂存区”。这样用户可以先检查结果，
        // 再决定是否合并进数据中心商品总表；也不会因为一次店铺采集而带出旧商品。
        if (message.persistToDataCenter === false) {
          if (belongsToActiveTask) {
            const previousStaged = Array.isArray(activeJob.stagedItems) ? activeJob.stagedItems : [];
            const oldKeys = new Set(previousStaged.map(itemKey));
            const stagedItems = mergeItems(previousStaged, incoming);
            await writeJob({
              ...activeJob,
              stagedItems,
              resultKeys: [...new Set([...(activeJob.resultKeys || []), ...resultKeys])],
              updatedAt: new Date().toISOString()
            });
            return {
              ok: true,
              count: incoming.length,
              added: stagedItems.filter(item => !oldKeys.has(itemKey(item))).length,
              total: (await readItems()).length,
              stagedCount: stagedItems.length,
              stagedItems,
              keys: resultKeys,
              items: incoming,
              staged: true
            };
          }
          return {
            ok: true,
            count: incoming.length,
            added: incoming.length,
            total: (await readItems()).length,
            keys: resultKeys,
            items: incoming,
            staged: true
          };
        }

        const existing = await readItems();
        const oldKeys = new Set(existing.map(itemKey));
        const merged = mergeItems(existing, incoming);
        const added = merged.filter(item => !oldKeys.has(itemKey(item))).length;
        await writeItems(merged);
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
          keys: resultKeys,
          items: incoming,
          staged: false
        };
      }

      case 'COMMIT_ITEMS': {
        const pageUrl = message.sourcePage || sender?.tab?.url || '';
        const incoming = (Array.isArray(message.items) ? message.items : [])
          .map(item => sanitizeItem({ ...item, sourcePage: item.sourcePage || pageUrl }, pageUrl))
          .filter(Boolean);
        if (!incoming.length) return { ok: false, error: '没有可加入数据中心的商品结果。' };
        const existing = await readItems();
        const oldKeys = new Set(existing.map(itemKey));
        const merged = mergeItems(existing, incoming);
        const added = merged.filter(item => !oldKeys.has(itemKey(item))).length;
        await writeItems(merged);
        return { ok: true, count: incoming.length, added, total: merged.length };
      }

      case 'COMMIT_JOB_RESULT': {
        const job = await readJob();
        if (!job || (message.jobId && job.id !== message.jobId)) {
          throw new Error('当前任务结果不存在或已经被替换。');
        }
        const incoming = Array.isArray(job.stagedItems) ? job.stagedItems : [];
        if (!incoming.length) return { ok: false, error: '当前任务没有可加入数据中心的商品结果。' };
        const existing = await readItems();
        const oldKeys = new Set(existing.map(itemKey));
        const merged = mergeItems(existing, incoming);
        const added = merged.filter(item => !oldKeys.has(itemKey(item))).length;
        await writeItems(merged);
        await writeJob({
          ...job,
          committedToDataCenter: true,
          updatedAt: new Date().toISOString(),
          message: `${job.message || '任务完成'} 已加入数据中心商品表。`
        }, { force: true });
        return { ok: true, count: incoming.length, added, total: merged.length };
      }

      case 'COLLECT_STORE_PROFILE': {
        const profile = sanitizeStoreProfile(message.profile || {}, sender?.tab?.url || message.sourcePage || '');
        if (!profile) throw new Error('当前店铺页没有读取到可保存的公开资料。');
        const persist = message.persistToDataCenter !== false;
        const profiles = persist
          ? await persistStoreProfile(profile, sender?.tab?.url || message.sourcePage || '')
          : null;
        const currentProfiles = persist ? await readStoreProfiles() : await readStoreProfiles();
        return {
          ok: true,
          staged: !persist,
          profile,
          storeCount: currentProfiles.length,
          reviewCount: profile.reviews?.length || 0,
          totalReviews: currentProfiles.reduce((sum, item) => sum + Number(item.reviewCountLoaded || item.reviews?.length || 0), 0)
        };
      }

      case 'COMMIT_STORE_PROFILE': {
        const profile = sanitizeStoreProfile(message.profile || {}, sender?.tab?.url || message.sourcePage || '');
        if (!profile) throw new Error('没有可加入数据中心的店铺资料。');
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
        let item = sanitizeItem(message.item || {}, sender?.tab?.url || '');
        const requestedTabId = Number(message.tabId ?? sender?.tab?.id);
        let sellerUrl = validSellerUrl(item?.sellerUrl || '');
        if (!sellerUrl && Number.isInteger(requestedTabId)) {
          try {
            const discovered = await discoverSellerEntry(requestedTabId);
            sellerUrl = validSellerUrl(discovered?.sellerUrl || '');
            if (sellerUrl && item) {
              item = sanitizeItem({
                ...item,
                sellerUrl,
                sellerName: item.sellerName || discovered.sellerName || ''
              }, sender?.tab?.url || '');
            }
          } catch (_) {
            // 没有发现入口时返回可解释结果，前端仍保留商品详情结果。
          }
        }
        if (!item || !sellerUrl) {
          return {
            ok: true,
            enriched: false,
            sellerEntryFound: false,
            reason: '当前详情页暂未发现卖家账号页入口，请等待卖家信息渲染后重试。'
          };
        }
        const profile = Number.isInteger(requestedTabId)
          ? await fetchSellerProfileInTab(requestedTabId, sellerUrl, message.returnUrl || item.itemUrl)
          : await fetchSellerProfile(sellerUrl);
        // 商品任务只补基础店铺字段；完整评价和评价图片必须由“采集当前店铺页”加载，
        // 防止把账号页首屏的少量评价误报为完整店铺评价。
        const profileForProduct = sanitizeStoreProfile(
          { ...profile, reviews: [] },
          sellerUrl,
          { forProduct: true }
        );
        const enrichedItem = applyProfileToItem(item, profileForProduct || profile);
        return { ok: true, enriched: Boolean(enrichedItem), item: enrichedItem, profile: profileForProduct || profile };
      }

      case 'GET_ITEMS':
        return { ok: true, items: await readItems() };

      case 'GET_STATUS':
        return { ok: true, count: (await readItems()).length, storeCount: (await readStoreProfiles()).length };

      case 'GET_MONITORS':
        await syncMonitorAlarms();
        return { ok: true, monitors: await monitorView() };

      case 'SAVE_MONITOR': {
        const raw = message.monitor && typeof message.monitor === 'object' ? message.monitor : {};
        const monitors = await readMonitors();
        const existing = raw.id ? monitors.find(item => item.id === cleanText(raw.id, 100)) : null;
        const normalized = normalizeMonitorConfig(raw, existing || {});
        if (!normalized.links.length) {
          throw new Error(`请至少填写一个有效的${monitorKindLabel(normalized.kind)}链接。`);
        }
        const nextRunAt = normalized.enabled ? nextMonitorRunAt(normalized) : 0;
        const saved = normalizeMonitorConfig({ ...normalized, nextRunAt }, existing || normalized);
        const nextMonitors = existing
          ? monitors.map(item => item.id === existing.id ? saved : item)
          : [saved, ...monitors];
        await writeMonitors(nextMonitors);
        await chrome.alarms.clear(monitorAlarmName(saved.id)).catch(() => {});
        if (saved.enabled) await scheduleMonitorAlarm(saved, nextRunAt);
        const active = await readMonitorRun(saved.id);
        if (active && !saved.enabled) await finishMonitorRun(active, { status: 'stopped', skipExport: true, message: '配置已暂停。' });
        return { ok: true, monitor: saved, monitors: await monitorView() };
      }

      case 'SET_MONITOR_ENABLED': {
        const monitorId = cleanText(message.monitorId, 100);
        const monitors = await readMonitors();
        const current = monitors.find(item => item.id === monitorId);
        if (!current) throw new Error('找不到这条监控配置。');
        const enabled = message.enabled !== false;
        const nextRunAt = enabled ? nextMonitorRunAt(current) : 0;
        const updated = normalizeMonitorConfig({ ...current, enabled, nextRunAt }, current);
        await writeMonitors(monitors.map(item => item.id === monitorId ? updated : item));
        await chrome.alarms.clear(monitorAlarmName(monitorId)).catch(() => {});
        if (enabled) await scheduleMonitorAlarm(updated, nextRunAt);
        else {
          const active = await readMonitorRun(monitorId);
          if (active) await finishMonitorRun(active, { status: 'stopped', skipExport: true, message: '监控已暂停。' });
        }
        return { ok: true, monitors: await monitorView() };
      }

      case 'DELETE_MONITOR': {
        const monitorId = cleanText(message.monitorId, 100);
        const active = await readMonitorRun(monitorId);
        if (active) await finishMonitorRun(active, { status: 'stopped', skipExport: true, message: '监控配置已删除。' });
        await chrome.alarms.clear(monitorAlarmName(monitorId)).catch(() => {});
        const monitors = await readMonitors();
        await writeMonitors(monitors.filter(item => item.id !== monitorId));
        await deleteMonitorRun(monitorId);
        return { ok: true, monitors: await monitorView() };
      }

      case 'RUN_MONITOR_NOW': {
        const monitorId = cleanText(message.monitorId, 100);
        const run = await startMonitorRun(monitorId, true);
        await processMonitorRunStep(monitorId);
        return { ok: true, run, monitors: await monitorView() };
      }

      case 'GET_STORE_STATUS': {
        const sellerUrl = validSellerUrl(message.sellerUrl || sender?.tab?.url || '');
        const profiles = await readStoreProfiles();
        const key = sellerProfileKey(sellerUrl);
        const profile = key
          ? profiles.find(item => sellerProfileKey(item?.sellerUrl || '') === key) || null
          : null;
        return {
          ok: true,
          exists: Boolean(profile),
          storeCount: profiles.length,
          profile: profile ? {
            sellerName: profile.sellerName,
            sellerUrl: profile.sellerUrl,
            reviewCount: Number(profile.reviewCountLoaded || profile.reviews?.length || 0),
            collectedAt: profile.collectedAt
          } : null
        };
      }

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
        const taskType = message.taskType || 'data';
        const items = Array.isArray(message.items)
          ? message.items.map(item => sanitizeItem(item)).filter(Boolean)
          : taskType === 'store'
            ? []
            : await readItems();
        let storeProfiles = taskType === 'store'
          ? (Array.isArray(message.storeProfiles)
            ? message.storeProfiles.map(profile => sanitizeStoreProfile(profile)).filter(Boolean)
            : await readStoreProfiles())
          : [];
        if (taskType === 'store' && message.sellerUrl) {
          const key = sellerProfileKey(message.sellerUrl);
          if (key) storeProfiles = storeProfiles.filter(profile => sellerProfileKey(profile.sellerUrl) === key);
        }
        const result = await runExport(items, settings, {
          type: taskType,
          mode: message.mode || settings.mode,
          storeProfiles
        });
        return { ok: true, result };
      }

      case 'EXPORT_JOB_RESULT': {
        const job = await readJob();
        if (!job || (message.jobId && job.id !== message.jobId)) {
          throw new Error('当前任务结果不存在或已经被替换。');
        }
        const settings = await readSettings();
        const items = Array.isArray(job.stagedItems)
          ? job.stagedItems
          : itemsForJob(job, await readItems());
        const result = await runExport(items, settings, {
          type: job.type,
          mode: job.mode || settings.mode,
          storeProfiles: []
        });
        return { ok: true, result };
      }

      case 'EXPORT_HISTORY': {
        const history = await readHistory();
        const entry = history.find(item => item.id === message.id);
        if (!entry) throw new Error('找不到这条历史任务。');
        const settings = await readSettings();
        const isStoreHistory = entry.type === 'store';
        const result = await runExport(isStoreHistory ? [] : (entry.itemsSnapshot || []), settings, {
          type: entry.type,
          mode: entry.mode,
          storeProfiles: isStoreHistory && Array.isArray(entry.storeProfilesSnapshot)
            ? entry.storeProfilesSnapshot
            : []
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
        return { ok: true, job: await recoverStaleJob(await readJob()) };

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
        markJobCancelled(job.id);
        const stopped = await finishJob(
          job,
          'stopped',
          '任务已由用户停止，采集专用标签页已关闭。',
          { force: true, closeTaskTab: true }
        );
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
