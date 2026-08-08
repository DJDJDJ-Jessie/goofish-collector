(() => {
  'use strict';

  // 允许弹窗在“插件刚加载但旧标签页未刷新”时补注入脚本，同时避免重复注入。
  if (window.__XIANYU_CONTENT_SCRIPT_INSTALLED__) return;
  window.__XIANYU_CONTENT_SCRIPT_INSTALLED__ = true;

  const NETWORK_EVENT = 'XIANYU_PUBLIC_DATA_CAPTURED';
  const API_SNAPSHOT_REQUEST = 'XIANYU_REQUEST_API_SNAPSHOT';
  const API_SNAPSHOT_EVENT = 'XIANYU_API_SNAPSHOT';
  const MAX_PAGE_ITEMS = 300;
  const MAX_NETWORK_BUFFER = 120;
  const MAX_RAW_NETWORK_BUFFER = 8;
  const MAX_DIAGNOSTIC_STRING = 10000;
  const RUNTIME_MESSAGE_TIMEOUT_MS = 12000;
  const pageItems = new Map();
  const networkBuffer = [];
  const rawNetworkBuffer = [];
  let captureEnabled = false;
  // 直接详情采集和批量任务默认先暂存。后台会在任务完成后把结果交给侧边栏，
  // 只有用户明确点击“加入数据中心商品表”时才写入长期商品主表。
  let pagePersistToDataCenter = true;
  let scanTimer = null;

  function cleanText(value, maxLength = 12000) {
    if (value === undefined || value === null) return '';
    return String(value)
      .replace(/\u0000/g, '')
      .replace(/\r\n/g, '\n')
      .split('\n')
      .map(line => line.replace(/[ \t]+/g, ' ').trim())
      .filter(Boolean)
      .join('\n')
      .trim()
      .slice(0, maxLength);
  }

  function oneLine(value, maxLength = 4000) {
    return cleanText(value, maxLength).replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function unique(values) {
    return [...new Set(values.filter(Boolean))];
  }

  function toAbsoluteUrl(value) {
    if (!value) return '';
    const raw = String(value).trim();
    if (!raw || raw.startsWith('data:') || raw.startsWith('blob:')) return '';
    try {
      const url = new URL(raw.startsWith('//') ? `https:${raw}` : raw, location.href);
      if (!/^https?:$/.test(url.protocol)) return '';
      return url.href;
    } catch (_) {
      return '';
    }
  }

  function valueToText(value, maxLength = 4000, depth = 0) {
    if (value === undefined || value === null) return '';
    if (typeof value === 'string' || typeof value === 'number') return oneLine(value, maxLength);
    if (depth > 2 || typeof value !== 'object') return '';

    for (const key of ['text', 'value', 'name', 'title', 'content', 'displayText', 'formatted']) {
      if (value[key] !== undefined && value[key] !== null) {
        const text = valueToText(value[key], maxLength, depth + 1);
        if (text) return text;
      }
    }
    return '';
  }

  function firstDirectValue(object, keys) {
    if (!object || typeof object !== 'object') return undefined;
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(object, key) && object[key] !== undefined && object[key] !== null) {
        return object[key];
      }
    }
    return undefined;
  }

  function firstNestedValue(object, keys) {
    const containers = [
      object,
      object?.item,
      object?.itemInfo,
      object?.itemData,
      object?.itemDO,
      object?.goods,
      object?.detail,
      object?.data,
      object?.model
    ];
    for (const container of containers) {
      const value = firstDirectValue(container, keys);
      if (value !== undefined) return value;
    }
    return undefined;
  }

  function imageUrlsFromValue(value, output = [], depth = 0) {
    if (value === undefined || value === null || depth > 4) return unique(output);

    if (typeof value === 'string') {
      const direct = toAbsoluteUrl(value);
      if (direct) output.push(direct);
      const matches = value.match(/https?:\/\/[^\s"'<>]+/g) || [];
      for (const match of matches) {
        const url = toAbsoluteUrl(match.replace(/[),]+$/, ''));
        if (url) output.push(url);
      }
      return unique(output).slice(0, 30);
    }

    if (Array.isArray(value)) {
      for (const entry of value) imageUrlsFromValue(entry, output, depth + 1);
      return unique(output).slice(0, 30);
    }

    if (typeof value === 'object') {
      for (const key of ['url', 'src', 'originUrl', 'picUrl', 'pic', 'imageUrl', 'imgUrl', 'thumbUrl', 'path']) {
        if (value[key]) imageUrlsFromValue(value[key], output, depth + 1);
      }
      return unique(output).slice(0, 30);
    }

    return unique(output).slice(0, 30);
  }

  function extractItemIdFromUrl(value) {
    const url = toAbsoluteUrl(value);
    if (!url) return '';

    try {
      const parsed = new URL(url);
      for (const key of ['itemId', 'item_id', 'itemid', 'id', 'auctionId', 'auction_id']) {
        const found = parsed.searchParams.get(key);
        if (found) return found;
      }
      const pathMatch = parsed.pathname.match(/(?:item|detail)[/_-]?(\d{5,})/i);
      if (pathMatch) return pathMatch[1];
    } catch (_) {
      // ignore malformed URL
    }
    return '';
  }

  function itemKey(item) {
    return item.itemId
      ? `id:${item.itemId}`
      : item.itemUrl
        ? `url:${item.itemUrl}`
        : `text:${[item.title, item.sellerName, item.price].join('|')}`;
  }

  function rateText(value) {
    const text = oneLine(value, 200);
    const match = text.match(/(?:好评率|好评|positives*rate|praises*rate)?\s*[:：]?\s*(\d+(?:\.\d+)?)\s*%/i);
    if (!match) return '';
    const number = Number(match[1]);
    return Number.isFinite(number) && number >= 0 && number <= 100 ? `${match[1]}%` : '';
  }

  function mergeLocalItem(item) {
    if (!item || !(item.itemId || item.itemUrl || item.title || item.images?.length)) return null;
    const key = itemKey(item);
    const old = pageItems.get(key) || {};
    const merged = mergeItemValues(old, item);

    for (const field of ['images', 'reviewSamples']) {
      merged[field] = unique([...(old[field] || []), ...(item[field] || [])]);
    }

    pageItems.set(key, merged);
    return merged;
  }

  function isInternalCategory(value) {
    return /^类目ID\s*\d+$/i.test(oneLine(value || '', 200));
  }

  function preferCategoryValue(oldValue, newValue) {
    const oldCategory = oneLine(oldValue || '', 500);
    const newCategory = oneLine(newValue || '', 500);
    if (!oldCategory) return newCategory;
    if (!newCategory) return oldCategory;
    if (isInternalCategory(oldCategory) && !isInternalCategory(newCategory)) return newCategory;
    if (!isInternalCategory(oldCategory) && isInternalCategory(newCategory)) return oldCategory;
    return newCategory;
  }

  function mergeItemValues(old, item) {
    const merged = { ...old };
    for (const [field, value] of Object.entries(item || {})) {
      if (field === 'images' || field === 'reviewSamples') continue;
      if (field === 'category') {
        if (value) {
          merged.category = preferCategoryValue(old.category, value);
        } else if (isInternalCategory(old.category) && /(?:^|,)dom(?:,|$)/i.test(item.dataSource || '')) {
          // DOM 已经确认当前详情没有可见类目名称时，不保留接口里的内部 categoryId。
          merged.category = '';
        }
        continue;
      }
      // 不让一次异步接口/DOM扫描的空值覆盖已经读到的有效值。
      if (value !== undefined && value !== null && String(value) !== '') merged[field] = value;
    }
    return merged;
  }

  function normalizeItem(item, source = 'dom') {
    if (!item || typeof item !== 'object') return null;
    const goodRate = rateText(item.itemGoodRate || item.goodRate || item.reviewSummary || '');
    const normalized = {
      itemId: oneLine(item.itemId || item.id || '', 200),
      title: oneLine(item.title || item.itemTitle || item.name || '', 1000),
      description: cleanText(item.description || item.desc || '', 12000),
      price: oneLine(item.price || '', 100),
      category: oneLine(item.category || '', 500),
      images: unique((Array.isArray(item.images) ? item.images : imageUrlsFromValue(item.images))
        .map(toAbsoluteUrl)
        .filter(Boolean)).slice(0, 30),
      itemUrl: toAbsoluteUrl(item.itemUrl || item.url || ''),
      sellerName: oneLine(item.sellerName || item.seller || item.userName || '', 500),
      sellerUrl: toAbsoluteUrl(item.sellerUrl || item.shopUrl || item.userUrl || ''),
      sellerLocation: oneLine(item.sellerLocation || item.location || '', 300),
      sellerFollowers: oneLine(item.sellerFollowers || item.followers || '', 100),
      sellerFollowing: oneLine(item.sellerFollowing || item.following || '', 100),
      sellerProductCount: oneLine(item.sellerProductCount || item.productCount || '', 100),
      sellerIntro: cleanText(item.sellerIntro || item.shopIntro || '', 3000),
      storeDuration: oneLine(item.storeDuration || item.openDuration || '', 300),
      reviewSummary: oneLine(item.reviewSummary || goodRate || '', 1000),
      itemGoodRate: goodRate,
      sellerReviewSummary: oneLine(item.sellerReviewSummary || '', 1000),
      sellerReviewCount: oneLine(item.sellerReviewCount || item.reviewCount || '', 100),
      reviewSamples: unique((Array.isArray(item.reviewSamples) ? item.reviewSamples : [item.reviewSamples])
        .map(value => cleanText(value, 1000))
        .filter(Boolean)).slice(0, 20),
      publishedAt: oneLine(item.publishedAt || '', 100),
      sourcePage: toAbsoluteUrl(item.sourcePage || location.href),
      dataSource: source,
      collectedAt: item.collectedAt || new Date().toISOString()
    };

    if (!normalized.itemId) normalized.itemId = extractItemIdFromUrl(normalized.itemUrl);
    if (!normalized.itemUrl && normalized.itemId) {
      normalized.itemUrl = `https://www.goofish.com/item?id=${encodeURIComponent(normalized.itemId)}`;
    }

    const hasIdentity = normalized.itemId || normalized.itemUrl || normalized.title;
    return hasIdentity ? normalized : null;
  }

  function priceFromText(value) {
    const text = oneLine(value, 6000);
    if (!text) return '';

    const explicit = text.match(/[¥￥]\s*[\d,.]+|[\d,.]+\s*元/);
    if (explicit) return explicit[0].replace(/\s+/g, '');

    const priceClass = text.match(/(?:价格|售价|单价)\s*[:：]?\s*([\d,.]+)/);
    return priceClass ? priceClass[1] : '';
  }

  function priceFromRoot(root) {
    const detailPriceNode = root?.querySelector?.(
      '[class^="item-main-info"] [class^="price--"], [class*="item-main-info"] [class*=" price--"]'
    );
    const detailPrice = oneLine(detailPriceNode?.textContent || '', 100);
    if (/^[\d,.]+$/.test(detailPrice)) return detailPrice;

    const priceNode = root?.querySelector?.('[class*="price"], [class*="Price"], [data-testid*="price"]');
    const fromNode = priceFromText(priceNode?.textContent || '');
    if (fromNode) return fromNode;

    const rawText = oneLine(root?.textContent || '', 10000);
    const fromRoot = priceFromText(rawText);
    if (fromRoot) return fromRoot;

    // 详情页价格节点有时只渲染数字，符号单独放在相邻节点中。
    const bare = rawText.match(/(?:^|[^\d])([\d]{1,7}(?:[,.]\d{1,2})?)(?:[^\d]|$)/);
    return bare ? bare[1] : '';
  }

  function imageUrlsFromRoot(root, includeSmall = false) {
    if (!root?.querySelectorAll) return [];
    const urls = [];
    for (const img of root.querySelectorAll('img')) {
      if (!includeSmall && img.naturalWidth && img.naturalHeight && (img.naturalWidth < 70 || img.naturalHeight < 70)) continue;
      for (const attr of ['src', 'data-src', 'data-lazy-src', 'data-original', 'data-ks-lazyload']) {
        const url = toAbsoluteUrl(img.getAttribute(attr));
        if (url) urls.push(url);
      }
      if (img.src) urls.push(toAbsoluteUrl(img.src));
    }
    return unique(urls.filter(Boolean)).slice(0, 30);
  }

  function detailImageUrlsFromRoot(root) {
    if (!root?.querySelectorAll) return [];
    const regions = root.querySelectorAll(`
      [class^="item-main-window-carousel"], [class*="item-main-window-carousel"],
      [class^="item-main-window-list"], [class*="item-main-window-list"],
      [class^="carouselItem"], [class*=" carouselItem"]
    `);
    const urls = [];
    for (const region of regions) urls.push(...imageUrlsFromRoot(region, true));
    return unique(urls).slice(0, 30);
  }

  function textLines(root) {
    return [...new Set((root?.innerText || root?.textContent || '')
      .split('\n')
      .map(line => line.replace(/\s+/g, ' ').trim())
      .filter(Boolean))];
  }

  function firstMeaningfulTitle(root, anchor = null) {
    const selectors = [
      'h1', 'h2', 'h3',
      '[data-testid*="title"]',
      '[class*="title"]', '[class*="Title"]',
      '[class*="name"]', '[class*="Name"]'
    ];
    for (const selector of selectors) {
      const node = root?.querySelector?.(selector);
      const value = oneLine(node?.getAttribute?.('title') || node?.textContent || '', 1000);
      if (value && !/[¥￥]\s*[\d,.]+/.test(value)) return value;
    }

    const attrs = [anchor?.getAttribute?.('title'), anchor?.getAttribute?.('aria-label')];
    for (const value of attrs) {
      const title = oneLine(value || '', 1000);
      if (title) return title;
    }

    const lines = textLines(root);
    const candidates = lines.filter(line =>
      line.length >= 3 &&
      line.length <= 180 &&
      !/[¥￥]\s*[\d,.]+/.test(line) &&
      !/^[\d,.]+\s*元$/.test(line) &&
      !/^(包邮|全新|闲置|自提|面议|已售|浏览|收藏|想要|信用|卖家)$/i.test(line)
    );
    return candidates[0] || '';
  }

  function detailTitleFromRoot(root) {
    const descriptionNode = root?.querySelector?.(
      '[class^="desc--"], [class*=" desc--"], [class*="description--"], [class*="Description--"]'
    );
    const descriptionLines = textLines(descriptionNode);
    const firstLine = descriptionLines.find(line => line.length >= 3 && line.length <= 300);
    if (firstLine) return firstLine;

    const documentTitle = oneLine(document.title || '', 300)
      .replace(/[_-]闲鱼\s*$/i, '')
      .trim();
    return documentTitle;
  }

  function categoryFromPage(root = document) {
    const breadcrumbNodes = root.querySelectorAll?.(
      'nav a, [class*="breadcrumb"] a, [class*="Breadcrumb"] a, [class*="category"] a, [class*="Category"] a'
    ) || [];
    const values = unique([...breadcrumbNodes].map(node => oneLine(node.textContent || '', 200)));
    if (values.length > 1) return values.join(' / ');
    if (values[0]) return values[0];

    // URL 中的 categoryId 只是平台内部标识，不是用户看到的类目名称。
    // 如果详情页没有公开展示类目或服务类型，宁可留空，也不把内部 ID 冒充成类目。
    return '';
  }

  function compactLabel(value) {
    return oneLine(value || '', 200).replace(/[\s:：|｜·•\-]+/g, '').trim();
  }

  function detailAttributeRows(root) {
    if (!root?.querySelectorAll) return [];
    const selectors = [
      '[class^="labels--"] [class^="item--"]',
      '[class*=" labels--"] [class*=" item--"]',
      '[class*="label-list"] [class*="item"]',
      '[class*="item-main-info"] [class^="item--"]',
      '[class*="item-main-info"] [class*=" item--"]',
      '[data-testid*="property"] [role="listitem"]',
      '[data-testid*="attribute"] [role="listitem"]'
    ];
    const rows = [];
    const seen = new Set();
    for (const selector of selectors) {
      for (const node of root.querySelectorAll(selector)) {
        if (seen.has(node)) continue;
        seen.add(node);
        rows.push(node);
      }
    }
    return rows;
  }

  function detailAttributeValue(root, labels) {
    const wanted = labels.map(compactLabel).filter(Boolean);
    if (!wanted.length) return '';
    const labelSelector = [
      '[class^="label--"]', '[class*=" label--"]',
      '[data-testid*="label"]', '[aria-label]'
    ].join(', ');
    const valueSelector = [
      '[class^="value--"]', '[class*=" value--"]',
      '[data-testid*="value"]'
    ].join(', ');

    for (const row of detailAttributeRows(root)) {
      const labelNode = row.querySelector(labelSelector);
      const label = compactLabel(labelNode?.textContent || '');
      const matched = wanted.find(candidate => label === candidate || label.startsWith(candidate));
      if (!matched) continue;

      const valueNode = row.querySelector(valueSelector);
      const value = oneLine(valueNode?.textContent || '', 500);
      if (value) return value;

      const compactRow = compactLabel(row.textContent || '');
      const start = compactRow.indexOf(matched);
      if (start >= 0) {
        const remainder = compactRow.slice(start + matched.length);
        if (remainder) return remainder;
      }
    }
    return '';
  }

  function serviceTypeFromRoot(root) {
    // 闲鱼服务类商品的详情属性区会显示“服务类型：金融”等字段。
    // 这是当前商品最准确的类目来源，优先级高于可见面包屑和 URL 内部标识。
    const stopLabels = ['预计工期', '售后服务', '计价方式'];
    const detailScope = root?.querySelector?.(
      '[class^="item-main-info"], [class*="item-main-info"], [class^="item-info"], [class*=" item-info"]'
    ) || root;

    function valueAfterLabel(value) {
      const text = oneLine(value || '', 1000);
      const labelIndex = text.indexOf('服务类型');
      if (labelIndex < 0) return '';
      let result = text.slice(labelIndex + '服务类型'.length)
        .replace(/^[\s:：|｜·•\-]+/, '')
        .trim();
      const stopAt = stopLabels
        .map(label => result.indexOf(label))
        .filter(index => index >= 0);
      if (stopAt.length) result = result.slice(0, Math.min(...stopAt));
      return oneLine(result, 300);
    }

    const rowValue = detailAttributeValue(detailScope, ['服务类型']);
    if (rowValue) return oneLine(rowValue, 300);

    // 页面版本变化时，服务属性行的 class 会变化，甚至没有 label/value class。
    // 只在短小的语义节点中寻找“服务类型”，不扫描整页推荐商品的文本。
    const nodes = [...(detailScope?.querySelectorAll?.('*') || [])]
      .filter(node => {
        const text = oneLine(node.textContent || '', 1000);
        return text.includes('服务类型') && text.length <= 500;
      })
      .sort((first, second) => oneLine(first.textContent || '').length - oneLine(second.textContent || '').length);
    for (const node of nodes) {
      const value = valueAfterLabel(node.textContent || '');
      if (value) return value;
      const childTexts = [...(node.children || [])].map(child => oneLine(child.textContent || '', 300)).filter(Boolean);
      const labelIndex = childTexts.findIndex(text => text.includes('服务类型'));
      if (labelIndex >= 0) {
        const same = valueAfterLabel(childTexts[labelIndex]);
        if (same) return same;
        const next = childTexts[labelIndex + 1];
        if (next && !stopLabels.some(label => next.includes(label))) return next;
      }
    }

    const lines = textLines(detailScope);
    for (let index = 0; index < lines.length; index++) {
      const value = valueAfterLabel(lines[index]);
      if (value) return value;
      if (/^服务类型\s*[:：|｜·•\-]?\s*$/.test(lines[index])) {
        const next = lines[index + 1] || '';
        if (next && !stopLabels.some(label => next.includes(label))) return oneLine(next, 300);
      }
    }
    return '';
  }

  function extractLabelValue(root, labels) {
    const lines = textLines(root);
    const rateOnly = labels.length === 1 && labels[0] === '好评率';
    for (const label of labels) {
      const index = lines.findIndex(line => line.includes(label));
      if (index < 0) continue;
      const sameLine = lines[index].replace(label, '').replace(/^[:：\-\s]+/, '').trim();
      const candidates = [sameLine, lines[index + 1] || ''].map(value => cleanText(value, 3000)).filter(Boolean);
      for (const candidate of candidates) {
        if (rateOnly && !rateText(candidate)) continue;
        return candidate;
      }
    }
    return '';
  }

  function sellerNameFromRoot(root) {
    const selectors = [
      '[class*="item-user-info-nick"]',
      'a[href*="/user"]', 'a[href*="/seller"]',
      '[data-testid*="seller"]', '[data-testid*="user"]',
      '[class*="seller"]', '[class*="Seller"]',
      '[class*="user-name"]', '[class*="UserName"]',
      '[class*="shop-name"]', '[class*="ShopName"]'
    ];
    for (const selector of selectors) {
      const node = root?.querySelector?.(selector);
      const value = oneLine(node?.textContent || node?.getAttribute?.('title') || '', 500);
      if (value && value.length < 100) return value;
    }
    return extractLabelValue(root, ['卖家', '店铺', '用户', '昵称']);
  }

  function isSellerPageUrl(value) {
    const url = toAbsoluteUrl(value || '');
    if (!url) return false;
    try {
      const parsed = new URL(url, location.href);
      return /^\/personal(?:[/?#]|$)/i.test(parsed.pathname)
        && parsed.hostname.endsWith('goofish.com');
    } catch (_) {
      return false;
    }
  }

  function sellerAnchorFromRoot(root) {
    if (!root?.querySelectorAll) return null;

    const nickNode = root.querySelector(
      '[class*="item-user-info-nick"], [data-testid*="seller"], [data-testid*="user"], [class*="seller-name"], [class*="shop-name"]'
    );
    const nearestAnchor = nickNode?.closest?.('a[href]');
    if (nearestAnchor && isSellerPageUrl(nearestAnchor.href)) return nearestAnchor;

    const candidates = [...root.querySelectorAll('a[href]')]
      .filter(anchor => isSellerPageUrl(anchor.href))
      .map(anchor => {
        const text = oneLine(anchor.textContent || '', 800);
        const hasSellerStats = /(?:来闲鱼|开店|入驻|卖出|好评率|粉丝|关注)/.test(text);
        const hasSellerNode = Boolean(anchor.querySelector(
          '[class*="item-user-info"], [class*="seller"], [class*="shop"]'
        ));
        return {
          anchor,
          score: (hasSellerStats ? 4 : 0) + (hasSellerNode ? 3 : 0) + (anchor.target === '_blank' ? 1 : 0)
        };
      })
      .sort((first, second) => second.score - first.score);

    return candidates[0]?.anchor || null;
  }

  function sellerEntryFromRoot(root) {
    const anchor = sellerAnchorFromRoot(root);
    const nickNode = root?.querySelector?.(
      '[class*="item-user-info-nick"], [data-testid*="seller"], [data-testid*="user"], [class*="seller-name"], [class*="shop-name"]'
    );
    return {
      sellerName: oneLine(nickNode?.textContent || anchor?.textContent || sellerNameFromRoot(root), 500),
      sellerUrl: anchor && isSellerPageUrl(anchor.href) ? toAbsoluteUrl(anchor.href) : '',
      clickable: Boolean(anchor || nickNode),
      text: oneLine(anchor?.textContent || nickNode?.parentElement?.textContent || '', 1000)
    };
  }

  function sellerUrlFromRoot(root) {
    return sellerEntryFromRoot(root).sellerUrl;
  }

  function sellerLabelsFromRoot(root) {
    return [...(root?.querySelectorAll?.('[class*="item-user-info-label"]') || [])]
      .map(node => oneLine(node.textContent || '', 200))
      .filter(Boolean);
  }

  function sellerLocationFromRoot(root) {
    const labels = sellerLabelsFromRoot(root);
    const value = labels.find(candidate => (
      !/(来闲鱼|开店|入驻|经营|卖出|好评率|粉丝|关注)/.test(candidate)
      && !/^\d+(?:\.\d+)?$/.test(candidate)
    ));
    return value || '';
  }

  function sellerMetricFromLabels(root, pattern) {
    const value = sellerLabelsFromRoot(root).find(line => pattern.test(line));
    return value || '';
  }

  function durationFromRoot(root) {
    const duration = '(\\d+年(?:\\d+个月)?|\\d+个月|\\d+天)';
    const label = '(?:来闲鱼|开店(?:时长)?|入驻(?:时长)?|经营(?:时长)?)';

    function fromText(value) {
      const text = oneLine(value || '', 10000);
      if (!text) return '';

      // 只接受“来闲鱼/开店/入驻/经营”与数字直接相邻的形式。
      // 这样“1天前来过 | 来闲鱼239天”会返回 239天，不会先截到 1天。
      const direct = text.match(new RegExp(`${label}\\s*[:：|｜·•\\-]?\\s*${duration}`));
      if (direct) return direct[1];
      const reverse = text.match(new RegExp(`${duration}\\s*${label}`));
      return reverse ? reverse[1] : '';
    }

    // 先读卖家统计标签节点，再读语义范围内的文本行，避免在整个页面任意邻近数字中猜测。
    for (const value of sellerLabelsFromRoot(root)) {
      const found = fromText(value);
      if (found) return found;
    }
    const labelNodes = root?.querySelectorAll?.(
      '[class*="infoCenterText--"], [class*="item-user-info-label"], [class*="seller-info"], [data-testid*="seller"]'
    ) || [];
    for (const node of labelNodes) {
      const found = fromText(node.textContent || '');
      if (found) return found;
    }

    const lines = textLines(root);
    for (let index = 0; index < lines.length; index++) {
      const found = fromText(lines[index]);
      if (found) return found;
      if (new RegExp(`^${label}\\s*[:：]?\\s*$`).test(lines[index])) {
        const next = lines[index + 1]?.match(new RegExp(`^${duration}$`));
        if (next) return next[1];
      }
    }
    return '';
  }

  function goodRateFromDetail(root) {
    const labeled = rateText(sellerMetricFromLabels(root, /好评率/));
    if (labeled) return labeled;
    const lines = textLines(root);
    for (let index = 0; index < lines.length; index++) {
      if (!lines[index].includes('好评率')) continue;
      const sameLine = rateText(lines[index]);
      if (sameLine) return sameLine;
      const nextLine = rateText(lines[index + 1] || '');
      if (nextLine) return nextLine;
    }
    return '';
  }

  function reviewsFromRoot(root) {
    const selectors = [
      '[class*="review"]', '[class*="Review"]',
      '[class*="comment"]', '[class*="Comment"]',
      '[class*="evaluate"]', '[class*="Evaluate"]',
      '[class*="评价"]', '[class*="信用"]'
    ];
    const samples = [];
    for (const selector of selectors) {
      for (const node of root?.querySelectorAll?.(selector) || []) {
        const value = oneLine(node.textContent || '', 1000);
        if (value && value.length >= 2 && value.length <= 1000) samples.push(value);
      }
    }
    return unique(samples).slice(0, 20);
  }

  function descriptionFromRoot(root) {
    const detailNode = root?.querySelector?.(
      '[class^="desc--"], [class*=" desc--"], [class*="description--"], [class*="Description--"]'
    );
    const detailText = cleanText(detailNode?.innerText || detailNode?.textContent || '', 12000);
    if (detailText.length >= 8) return detailText;

    const meta = document.querySelector('meta[name="description"], meta[property="og:description"]');
    const metaText = oneLine(meta?.getAttribute('content') || '', 12000);
    if (metaText) return metaText;

    const selectors = [
      '[data-testid*="description"]', '[data-testid*="desc"]',
      '[class*="description"]', '[class*="Description"]',
      '[class*="detail-content"]', '[class*="DetailContent"]',
      '[class*="desc"]', '[class*="Desc"]'
    ];
    const values = [];
    for (const selector of selectors) {
      for (const node of root?.querySelectorAll?.(selector) || []) {
        const value = cleanText(node.textContent || '', 12000);
        if (value.length >= 8) values.push(value);
      }
    }
    return values.sort((a, b) => b.length - a.length)[0] || '';
  }

  function isAccountPage() {
    return /^\/personal(?:[/?#]|$)/i.test(location.pathname);
  }

  function pageType() {
    if (isAccountPage()) return 'account';
    if (isDetailPage()) return 'detail';
    return 'search';
  }

  function numberAfterLabel(value, pattern) {
    const match = oneLine(value, 120).match(pattern);
    return match ? match[1] : '';
  }

  function accountReviewSamples(root) {
    const samples = [];
    const cards = root?.querySelectorAll?.('[class^="rateItem--"], [class*=" rateItem--"]') || [];
    for (const card of cards) {
      const reviewer = oneLine(card.querySelector('[class^="nick--ELSf2AqO"], [class*=" nick--ELSf2AqO"], [class^="nick--"], [class*=" nick--"]')?.textContent || '', 120);
      const role = oneLine(card.querySelector('[class*="tag--"]')?.textContent || '', 40);
      const feedback = cleanText(card.querySelector('[class*="feedback--"], [class*="Feedback--"]')?.textContent || '', 1000);
      const timeIp = oneLine(card.querySelector('[class*="timeIp--"], [class*="time-ip--"]')?.textContent || '', 200);
      const parts = [reviewer, role, feedback, timeIp].filter(Boolean);
      if (parts.length) samples.push(parts.join('｜'));
    }
    return unique(samples).slice(0, 20);
  }

  function reviewImagesFromCard(card) {
    const images = [];
    const allImages = [...(card?.querySelectorAll?.('img') || [])]
      .filter(image => {
        let node = image;
        for (let level = 0; level < 5 && node; level++, node = node.parentElement) {
          if (/(?:avatar|goodRate)/i.test(oneLine(node.getAttribute?.('class') || '', 200))) return false;
        }
        return true;
      });
    const originalImages = allImages.filter(image => /ant-image-img/i.test(image.getAttribute('class') || ''));
    const candidates = originalImages.length
      ? originalImages
      : allImages.filter(image => /rateImg/i.test(image.getAttribute('class') || ''));
    for (const image of (candidates.length ? candidates : allImages)) {
      const className = oneLine(image.getAttribute('class') || '', 200);
      // 头像和“好评”徽章不是买家上传的评价图片；真正的评价图通常带 rateImg。
      if (/(?:avatar|goodRate)/i.test(className)) continue;
      for (const attr of ['src', 'data-src', 'data-lazy-src', 'data-original', 'data-ks-lazyload']) {
        const url = toAbsoluteUrl(image.getAttribute(attr));
        if (url) images.push(url);
      }
    }
    return unique(images).slice(0, 20);
  }

  function accountReviewsFromPage(root = document.body) {
    const cards = root?.querySelectorAll?.('[class^="rateItem--"], [class*=" rateItem--"]') || [];
    return [...cards].map((card, index) => ({
      reviewIndex: index + 1,
      reviewer: oneLine(card.querySelector('[class^="nick--ELSf2AqO"], [class*=" nick--ELSf2AqO"], [class^="nick--"], [class*=" nick--"]')?.textContent || '', 160),
      role: oneLine(card.querySelector('[class^="tag--"], [class*=" tag--"]')?.textContent || '', 60),
      feedback: cleanText(card.querySelector('[class^="feedback--"], [class*=" feedback--"], [class*="Feedback--"]')?.textContent || '', 12000),
      timeIp: oneLine(card.querySelector('[class^="timeIp--"], [class*=" timeIp--"], [class*="time-ip--"]')?.textContent || '', 240),
      images: reviewImagesFromCard(card),
      collectedAt: new Date().toISOString()
    })).filter(review => review.feedback || review.reviewer || review.images.length);
  }

  function reviewCountFromPage(root) {
    return countFromLabelLines(textLines(root), '信用及评价');
  }

  function countFromLabelLines(lines, label) {
    const values = Array.isArray(lines) ? lines : [];
    for (let index = 0; index < values.length; index++) {
      const line = oneLine(values[index], 240);
      const labelIndex = line.indexOf(label);
      if (labelIndex < 0) continue;

      const before = line.slice(0, labelIndex).match(/(\d{1,9})\s*$/);
      if (before) return before[1];

      const after = line.slice(labelIndex + label.length);
      const sameLine = after.match(/^\s*(?:[:：|｜·•\-]\s*)?(\d{1,9})/);
      if (sameLine) return sameLine[1];

      const nextLine = oneLine(values[index + 1] || '', 80);
      if (/^\d{1,9}$/.test(nextLine)) return nextLine;
    }
    return '';
  }

  function reviewScrollContainer() {
    const list = document.querySelector('[class^="rateList--"], [class*=" rateList--"]');
    let node = list;
    while (node && node !== document.body && node !== document.documentElement) {
      try {
        const style = window.getComputedStyle(node);
        if (node.scrollHeight > node.clientHeight + 40
          && /(auto|scroll)/i.test(`${style.overflowY} ${style.overflow}`)) {
          return node;
        }
      } catch (_) {
        // 继续回退到窗口滚动。
      }
      node = node.parentElement;
    }
    return null;
  }

  function goodRateFromPage(root) {
    const direct = rateText(oneLine(root?.textContent || '', 20000).match(/好评率[^\d]{0,12}\d+(?:\.\d+)?\s*%?/i)?.[0] || '');
    if (direct) return direct;

    const reviewCount = Number(reviewCountFromPage(root));
    const goodText = textLines(root).find(value => /^好评\s*\d+$/.test(value))
      || [...(root?.querySelectorAll?.('[class*="tabItem--"], [class*="filterTab"] *') || [])]
        .map(node => oneLine(node.textContent || '', 100))
        .find(value => /^好评\s*\d+$/.test(value));
    const goodCount = Number(goodText?.match(/(\d+)/)?.[1] || 0);
    if (reviewCount > 0 && goodCount > 0) return `${((goodCount / reviewCount) * 100).toFixed(2)}%`;
    return '';
  }

  function accountProfileScope(root) {
    const infoTopSelector = '[class^="infoTop--"], [class*=" infoTop--"]';
    const explicitScope = root?.querySelector?.(infoTopSelector);
    const structureSelector = [
      '[class^="infoCenterText--"]', '[class*=" infoCenterText--"]',
      '[class^="bottom--"]', '[class*=" bottom--"]',
      '[class^="intro--"]', '[class*=" intro--"]',
      '[class^="description--"]', '[class*=" description--"]',
      '[data-testid*="intro"]', '[data-testid*="description"]'
    ].join(', ');

    // infoTop 只包含昵称，地区、粉丝/关注和简介位于它的兄弟节点。
    // 先从 infoTop 向上找同时包含这些结构的最小资料容器，不能把 infoTop 本身
    // 当作完整资料区，否则就会出现“商品数有、粉丝和简介为空”的半成品记录。
    if (explicitScope) {
      let node = explicitScope;
      for (let level = 0; level < 6 && node; level++, node = node.parentElement) {
        if (node.querySelector?.(structureSelector)) return node;
      }
    }

    // 账号页的昵称可能先渲染，资料容器稍后才挂载。沿昵称祖先向上找同时包含
    // 账号统计或简介节点的最小容器，避免把整页 body 当成店铺资料区域。
    const nickSelector = '[class^="nick--"], [class*=" nick--"]';
    for (const nickNode of root?.querySelectorAll?.(nickSelector) || []) {
      let node = nickNode;
      for (let level = 0; level < 8 && node; level++, node = node.parentElement) {
        if (node.matches?.(structureSelector) || node.querySelector?.(structureSelector)) return node;
      }
    }
    return null;
  }

  function accountProfileFromPage() {
    const root = document.body;
    const sellerUrl = toAbsoluteUrl(location.href);
    const infoScope = accountProfileScope(root);
    const exactInfoScope = infoScope || root;
    const infoValues = [...(exactInfoScope?.querySelectorAll?.('[class^="infoCenterText--"], [class*=" infoCenterText--"]') || [])]
      .map(node => oneLine(node.textContent || '', 200))
      .filter(Boolean);
    const accountNickSelector = '[class^="nick--"], [class*=" nick--"]';
    const sellerName = oneLine(
      infoScope?.querySelector?.(accountNickSelector)?.textContent
        || root?.querySelector?.('[class^="infoTop--"] ' + accountNickSelector)?.textContent
        || infoScope?.querySelector?.('a[href*="/personal"]')?.textContent
        || '',
      500
    );

    // 简介是否为数字不能靠格式判断。只要节点属于账号资料容器，纯数字也可以是合法简介；
    // 关键是排除统计、标签和评价节点，而不是用“必须包含文字”的格式规则。
    const introSelector = [
      '[class^="bottom--"]', '[class*=" bottom--"]',
      '[class^="intro--"]', '[class*=" intro--"]'
      , '[class^="description--"]', '[class*=" description--"]',
      '[data-testid*="intro"]', '[data-testid*="description"]'
    ].join(', ');
    const introCandidates = [];
    const introScopes = infoScope ? [infoScope] : [];
    for (const scope of introScopes) {
      const nodes = [...(scope?.querySelectorAll?.(introSelector) || [])];
      // 个别版本只保留了账号资料容器的匿名 class。此时只在该容器的直接子节点中
      // 选择候选，不把商品正文、推荐商品或评价卡片纳入简介。
      if (!nodes.length) nodes.push(...[...(scope?.children || [])]);
      for (const node of nodes) {
        if (node.closest?.('[class^="rateItem--"], [class*=" rateItem--"]')) continue;
        const value = cleanText(node.textContent || '', 3000);
        if (!value || value.length > 3000 || value === sellerName) continue;
        if (/^(?:宝贝|信用及评价|全部|有图|好评|来自买家|来自卖家)\s*\d*$/i.test(value)) continue;
        if (/^(?:粉丝|关注|卖出|出售)\s*\d+|^\d+\s*(?:粉丝|关注|件?宝贝)$/.test(value)) continue;
        if (/(?:来闲鱼|开店|入驻|经营|好评率)/.test(value) && value.length < 120) continue;
        const className = oneLine(node.getAttribute?.('class') || '', 200);
        if (/(?:infoTop|infoCenter|operate|tab|filter)/i.test(className)) continue;
        if (/(?:粉丝|关注|卖出|出售)\s*\d+/.test(value) && value.length < 180) continue;
        const score = (infoScope ? 10 : 0)
          + (/bottom|intro|description/i.test(className) ? 4 : 0)
          + (node.parentElement === scope ? 2 : 0);
        introCandidates.push({ value, score });
      }
      if (introCandidates.length) break;
    }
    const intro = introCandidates
      .sort((first, second) => second.score - first.score || first.value.length - second.value.length)[0]?.value || '';

    function tabCount(label) {
      const titleNode = [...(root?.querySelectorAll?.('[class^="textReal--"], [class*=" textReal--"], [role="tab"]') || [])]
        .find(node => {
          const text = oneLine(node.textContent || '', 100);
          return text === label || text.startsWith(label);
        });
      if (!titleNode) return countFromLabelLines(textLines(root), label);

      const closestTab = titleNode.closest?.('li, [role="tab"], button, [class^="tabItem--"], [class*=" tabItem--"]')
        || titleNode.parentElement;
      const scopes = unique([closestTab, titleNode.parentElement].filter(Boolean));
      for (const scope of scopes) {
        const count = countFromLabelLines(textLines(scope), label);
        if (count) return count;

        // 只有当前 tab 自己恰好有一个数字节点时才使用它；不再沿多个祖先逐层
        // 找第一个 .num--，从而避免把相邻 tab/商品数/评价数读成当前字段。
        const numbers = [...(scope.querySelectorAll?.('[class^="num--"], [class*=" num--"]') || [])]
          .map(node => oneLine(node.textContent || '', 80))
          .filter(value => /^\d{1,9}$/.test(value));
        if (numbers.length === 1) return numbers[0];
      }
      // 有明确 tab 标题但没有同一 tab 的数字时，宁可留空，不用整页的随机数字补位。
      return '';
    }

    const productCount = tabCount('宝贝');
    const reviewCount = tabCount('信用及评价') || reviewCountFromPage(root);
    const productCountText = productCount ? `宝贝 ${productCount}` : '';
    const reviewCountText = reviewCount ? `信用及评价 ${reviewCount}` : '';
    const infoLines = unique([
      ...infoValues,
      ...(infoScope ? textLines(infoScope) : [])
    ]);
    const statLines = infoLines.filter(value => /粉丝|关注/.test(value));
    const followersText = statLines.find(value => /粉丝/.test(value)) || '';
    const followingText = statLines.find(value => /关注/.test(value)) || '';
    const productHeaderText = infoLines.find(value => /(?:卖出|出售)\s*\d+\s*件?\s*宝贝|\d+\s*件?\s*宝贝/.test(value)) || '';
    const productHeaderCount = productHeaderText.match(/(?:卖出|出售)\s*(\d+)|(\d+)\s*件?\s*宝贝/);
    const productHeaderValue = productHeaderCount?.[1] || productHeaderCount?.[2] || '';
    const locationCandidates = unique([
      ...infoValues,
      ...statLines.map(value => value
        .replace(/\d{1,9}\s*粉丝/g, '')
        .replace(/\d{1,9}\s*关注/g, '')
        .replace(/[|｜·•,，]/g, ' ')
        .trim())
    ]);
    const locationText = locationCandidates.find(value => (
      value && value.length <= 100
      && !/^\d+(?:\.\d+)?$/.test(value)
      && !/(粉丝|关注|宝贝|信用及评价|好评率)/.test(value)
    )) || '';
    const profileRoot = infoScope || root;

    return {
      ok: true,
      pageType: 'account',
      sellerUrl,
      sellerName,
      profileScope: infoScope ? 'account-info-scope' : 'unresolved',
      sellerLocation: locationText,
      sellerFollowers: numberAfterLabel(followersText, /(\d+)\s*粉丝/) || countFromLabelLines(infoLines, '粉丝'),
      sellerFollowing: numberAfterLabel(followingText, /(\d+)\s*关注/) || countFromLabelLines(infoLines, '关注'),
      sellerProductCount: productCount || productHeaderValue,
      sellerIntro: intro,
      storeDuration: durationFromRoot(profileRoot) || durationFromRoot(root),
      sellerGoodRate: goodRateFromPage(profileRoot) || goodRateFromPage(root),
      sellerReviewSummary: reviewCountText,
      sellerReviewCount: reviewCount,
      reviewSamples: accountReviewSamples(root),
      reviews: accountReviewsFromPage(root),
      sourcePage: sellerUrl,
      capturedAt: new Date().toISOString()
    };
  }

  function isDetailPage() {
    const path = `${location.pathname}${location.search}`.toLowerCase();
    if (/\/item(?:[/?#]|$)|itemid=|auctionid=|\/detail(?:[/?#]|$)/.test(path)) return true;

    // 某些版本的闲鱼使用无规律的详情路由；只有在同时存在详情文案区域、
    // 商品图片且页面没有明显商品卡片链接时，才使用 DOM 兜底判断。
    const hasDetailText = Boolean(document.querySelector(
      '[data-testid*="description"], [class*="description"], [class*="Description"], [class*="detail-content"], [class*="DetailContent"]'
    ));
    const hasProductImage = Boolean(document.querySelector('img'));
    const hasItemLinks = Boolean(document.querySelector('a[href*="/item?"], a[href*="/item/"]'));
    return Boolean(document.querySelector('h1') && hasDetailText && hasProductImage && !hasItemLinks);
  }

  function candidateVisualPosition(candidate) {
    const node = candidate?.node || candidate?.anchor;
    if (!node?.getBoundingClientRect) return { top: Number.MAX_SAFE_INTEGER, left: Number.MAX_SAFE_INTEGER };
    try {
      const rect = node.getBoundingClientRect();
      return {
        top: Math.round(rect.top + (window.scrollY || document.documentElement?.scrollTop || 0)),
        left: Math.round(rect.left + (window.scrollX || document.documentElement?.scrollLeft || 0))
      };
    } catch (_) {
      return { top: Number.MAX_SAFE_INTEGER, left: Number.MAX_SAFE_INTEGER };
    }
  }

  function sortCandidatesByVisualOrder(candidates) {
    return [...candidates]
      .map((candidate, domIndex) => ({ candidate, domIndex, position: candidateVisualPosition(candidate) }))
      .sort((first, second) => (
        first.position.top - second.position.top
        || first.position.left - second.position.left
        || first.domIndex - second.domIndex
      ))
      .map(entry => entry.candidate);
  }

  function cardCandidates() {
    const standardCards = [...document.querySelectorAll(
      '[class^="feeds-item-wrap--"], [class*=" feeds-item-wrap--"]'
    )]
      .map(node => ({
        node,
        anchor: node.matches?.('a[href]')
          ? node
          : node.querySelector('a[href*="/item"], a[href*="itemId"], a[href*="item_id"]')
      }))
      .filter(candidate => candidate.anchor?.href);

    if (standardCards.length) {
      return sortCandidatesByVisualOrder(standardCards).slice(0, MAX_PAGE_ITEMS);
    }

    const anchors = [...document.querySelectorAll('a[href]')]
      .filter(anchor => /(?:\/item(?:[/?#])|[?&](?:itemId|item_id|id|auctionId)=)/i.test(anchor.href));
    const candidates = [];

    for (const anchor of anchors) {
      let node = anchor;
      for (let level = 0; level < 7 && node; level++, node = node.parentElement) {
        const images = node.querySelectorAll?.('img')?.length || 0;
        const links = node.querySelectorAll?.('a[href]')?.length || 0;
        const text = oneLine(node.textContent || '', 2500);
        if (images >= 1 && images <= 8 && links <= 8 && text.length >= 5 && text.length <= 2200 && priceFromText(text)) {
          candidates.push({ node, anchor });
          break;
        }
      }
    }

    if (!candidates.length) {
      for (const node of document.querySelectorAll('article, li, [class*="card"], [class*="Card"], [class*="item"], [class*="Item"]')) {
        const images = node.querySelectorAll?.('img')?.length || 0;
        const text = oneLine(node.textContent || '', 1800);
        if (images >= 1 && images <= 6 && text.length >= 5 && text.length <= 1800 && priceFromText(text)) {
          candidates.push({ node, anchor: node.querySelector('a[href]') });
        }
      }
    }

    const seenNodes = new Set();
    return sortCandidatesByVisualOrder(candidates.filter(candidate => {
      if (seenNodes.has(candidate.node)) return false;
      seenNodes.add(candidate.node);
      return true;
    })).slice(0, MAX_PAGE_ITEMS);
  }

  function buildCardItem(candidate) {
    const root = candidate.node;
    const anchor = candidate.anchor;
    const itemUrl = toAbsoluteUrl(anchor?.href || '');
    const itemId = extractItemIdFromUrl(itemUrl);
    const titleNode = root?.querySelector?.(
      '[class^="row1-wrap-title--"], [class*=" row1-wrap-title--"], [class^="main-title--"], [class*=" main-title--"]'
    );
    const title = oneLine(titleNode?.getAttribute?.('title') || titleNode?.textContent || '', 1000)
      || firstMeaningfulTitle(root, anchor);
    const images = imageUrlsFromRoot(root, true);
    if (!title && !itemId && !images.length) return null;

    const sellerNode = root?.querySelector?.(
      '[class^="seller-text-wrap--"], [class*=" seller-text-wrap--"], [class^="seller-text--"], [class*=" seller-text--"]'
    );

    return normalizeItem({
      itemId,
      title,
      description: title,
      price: priceFromRoot(root),
      category: categoryFromPage(),
      images,
      itemUrl,
      sellerName: oneLine(sellerNode?.getAttribute?.('title') || sellerNode?.textContent || '', 500)
        || sellerNameFromRoot(root),
      sellerIntro: extractLabelValue(root, ['店铺简介', '卖家简介', '个人简介']),
      storeDuration: durationFromRoot(root),
      reviewSummary: extractLabelValue(root, ['评价', '信用']),
      reviewSamples: reviewsFromRoot(root),
      sourcePage: location.href
    }, 'dom');
  }

  function findCardRootForAnchor(anchor) {
    let node = anchor;
    for (let level = 0; level < 7 && node; level++, node = node.parentElement) {
      const images = node.querySelectorAll?.('img')?.length || 0;
      const links = node.querySelectorAll?.('a[href]')?.length || 0;
      const text = oneLine(node.textContent || '', 1800);
      if (images >= 1 && images <= 8 && links <= 8 && text.length >= 3 && text.length <= 1800) {
        return node;
      }
    }
    return anchor;
  }

  function searchLinkItems() {
    const items = [];
    const seen = new Set();

    function identity(item) {
      const id = oneLine(item?.itemId || extractItemIdFromUrl(item?.itemUrl || ''), 200);
      return id ? `id:${id}` : `url:${toAbsoluteUrl(item?.itemUrl || '')}`;
    }

    function matchingNetworkItem(item) {
      const key = identity(item);
      if (!key || key === 'url:') return null;
      for (let index = networkBuffer.length - 1; index >= 0; index--) {
        const candidate = networkBuffer[index];
        if (!/^network:search/i.test(String(candidate?.dataSource || ''))
          && !/idlemtopsearch\.pc\.search/i.test(String(candidate?.sourcePage || ''))) continue;
        if (identity(candidate) === key) return candidate;
      }
      return null;
    }

    function addDomOrderedItem(rawItem) {
      if (!rawItem?.itemUrl) return;
      const key = identity(rawItem);
      if (!key || key === 'url:' || seen.has(key)) return;
      const networkItem = matchingNetworkItem(rawItem);
      const merged = networkItem
        ? normalizeItem({
            ...mergeItemValues(networkItem, rawItem),
            images: unique([...(networkItem.images || []), ...(rawItem.images || [])]),
            reviewSamples: unique([...(networkItem.reviewSamples || []), ...(rawItem.reviewSamples || [])]),
            itemUrl: rawItem.itemUrl,
            sourcePage: location.href
          }, 'search-dom,network:search')
        : rawItem;
      if (!merged?.itemUrl) return;
      seen.add(key);
      items.push(merged);
    }

    // 搜索顺序必须由页面上真实商品卡片的位置决定：从上到下、从左到右。
    // 接口缓存只能为同一商品补字段，不能把旧页/异步响应的顺序带进当前任务。
    for (const candidate of cardCandidates()) {
      addDomOrderedItem(buildCardItem(candidate));
    }

    // 对“面议”、价格异步加载或卡片结构变化的商品，退回到商品链接本身；
    // 仍按链接所在卡片的屏幕坐标排序。
    const anchors = [...document.querySelectorAll('a[href]')]
      .filter(anchor => /(?:\/item(?:[/?#])|[?&](?:itemId|item_id|id|auctionId)=)/i.test(anchor.href))
      .map(anchor => ({ anchor, node: findCardRootForAnchor(anchor) }));
    for (const candidate of sortCandidatesByVisualOrder(anchors)) {
      const anchor = candidate.anchor;
      const itemUrl = toAbsoluteUrl(anchor.href);
      const root = candidate.node;
      const item = normalizeItem({
        itemId: extractItemIdFromUrl(itemUrl),
        title: firstMeaningfulTitle(root, anchor),
        price: priceFromRoot(root),
        category: categoryFromPage(),
        images: imageUrlsFromRoot(root, true),
        itemUrl,
        sellerName: sellerNameFromRoot(root),
        sourcePage: location.href
      }, 'search-link');
      addDomOrderedItem(item);
    }

    return items.slice(0, MAX_PAGE_ITEMS);
  }

  function buildDetailItem() {
    const root = document.body;
    const jsonLd = [...document.querySelectorAll('script[type="application/ld+json"]')]
      .map(node => {
        try { return JSON.parse(node.textContent); } catch (_) { return null; }
      })
      .find(value => value && typeof value === 'object');

    const itemUrl = location.href;
    const title = detailTitleFromRoot(root) || valueToText(jsonLd?.name, 1000);
    const detailImages = detailImageUrlsFromRoot(root);
    const images = detailImages.length
      ? detailImages
      : imageUrlsFromValue(jsonLd?.image);
    const sellerUrl = sellerUrlFromRoot(root);
    const item = normalizeItem({
      itemId: extractItemIdFromUrl(itemUrl) || valueToText(jsonLd?.productID, 200),
      title,
      description: descriptionFromRoot(root) || valueToText(jsonLd?.description, 12000),
      price: priceFromRoot(root) || valueToText(jsonLd?.offers?.price, 100),
      category: serviceTypeFromRoot(root) || categoryFromPage(root),
      images,
      itemUrl,
      sellerName: sellerNameFromRoot(root) || valueToText(jsonLd?.brand?.name, 500),
      sellerUrl,
      sellerLocation: sellerLocationFromRoot(root),
      sellerIntro: extractLabelValue(root, ['店铺简介', '卖家简介', '个人简介']),
      storeDuration: durationFromRoot(root),
      reviewSummary: sellerMetricFromLabels(root, /好评率/) || extractLabelValue(root, ['好评率', '评价', '信用', '好评']),
      itemGoodRate: goodRateFromDetail(root),
      reviewSamples: reviewsFromRoot(root),
      publishedAt: extractLabelValue(root, ['发布时间', '上架时间']),
      sourcePage: location.href
    }, 'dom');

    return item;
  }

  function scanDom() {
    const currentPageType = pageType();
    const found = currentPageType === 'detail'
      ? [buildDetailItem()].filter(Boolean)
      : currentPageType === 'search'
        ? cardCandidates().map(buildCardItem).filter(Boolean)
        : [];

    for (const item of found) mergeLocalItem(item);
    return found;
  }

  function parseMaybeJson(value) {
    if (typeof value !== 'string') return value;
    const text = value.trim();
    if (!text || (!text.startsWith('{') && !text.startsWith('['))) return value;
    try { return JSON.parse(text); } catch (_) { return value; }
  }

  function searchNetworkItems(response, sourceUrl) {
    const resultList = response?.data?.resultList || response?.resultList;
    if (!Array.isArray(resultList)) return [];

    const found = [];
    const seen = new Set();
    for (const result of resultList) {
      const exContent = result?.data?.item?.main?.exContent || result?.exContent || {};
      const clickArgs = result?.data?.item?.main?.clickParam?.args || result?.clickParam?.args || {};
      const detailParams = exContent.detailParams || {};
      const itemId = oneLine(
        exContent.itemId || detailParams.itemId || clickArgs.item_id || clickArgs.id || '',
        200
      );
      if (!/^\d{5,}$/.test(itemId)) continue;

      const title = cleanText(
        exContent.title || detailParams.title || exContent.richTitle || '',
        12000
      );
      const price = valueToText(
        clickArgs.displayPrice || clickArgs.price || detailParams.soldPrice || exContent.price || '',
        100
      );
      const itemUrl = `https://www.goofish.com/item?id=${encodeURIComponent(itemId)}`;
      const item = normalizeItem({
        itemId,
        title,
        description: title,
        price,
        images: imageUrlsFromValue(exContent.picUrl || exContent.imageUrl || exContent.images),
        itemUrl,
        sellerName: exContent.userNickName || detailParams.userNick || '',
        sellerLocation: exContent.area || '',
        publishedAt: clickArgs.publishTime || '',
        sourcePage: sourceUrl || location.href
      }, 'network:search');
      if (!item) continue;
      const key = itemKey(item);
      if (seen.has(key)) continue;
      seen.add(key);
      found.push(item);
    }
    return found.slice(0, MAX_PAGE_ITEMS);
  }

  function normalizeNetworkRecord(record, apiType, sourceUrl) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) return null;

    const itemId = valueToText(firstNestedValue(record, [
      'itemId', 'item_id', 'itemid', 'auctionId', 'auction_id', 'itemIdStr'
    ]), 200);
    const itemUrl = toAbsoluteUrl(valueToText(firstNestedValue(record, [
      'itemUrl', 'item_url', 'url', 'detailUrl', 'jumpUrl'
    ]), 2000));
    const title = valueToText(firstNestedValue(record, [
      'title', 'itemTitle', 'item_title', 'itemName', 'name', 'subject'
    ]), 1000);
    const description = cleanText(valueToText(firstNestedValue(record, [
      'description', 'desc', 'itemDesc', 'content'
    ]), 12000), 12000);
    const price = valueToText(firstNestedValue(record, [
      'price', 'itemPrice', 'soldPrice', 'reservePrice', 'currentPrice', 'priceText'
    ]), 100);
    const images = imageUrlsFromValue(firstNestedValue(record, [
      'images', 'imageList', 'picList', 'pics', 'picUrl', 'mainPic', 'imageUrl', 'imgUrl'
    ]));
    const sellerObject = firstDirectValue(record, ['seller', 'sellerInfo', 'user', 'userInfo', 'owner', 'shop']) || {};
    const sellerName = valueToText(
      firstDirectValue(sellerObject, ['name', 'nick', 'nickname', 'userName', 'sellerName', 'shopName']) ||
      firstNestedValue(record, ['sellerName', 'nick', 'nickname', 'userName', 'shopName']),
      500
    );
    const category = valueToText(firstNestedValue(record, [
      'categoryName', 'category', 'catName', 'categoryText'
    ]), 500);
    const reviewSummary = valueToText(firstNestedValue(record, [
      'reviewSummary', 'ratingText', 'creditText', 'sellerCredit', 'evaluation'
    ]), 1000);
    const itemGoodRate = valueToText(firstNestedValue(record, [
      'goodRate', 'goodReviewRate', 'positiveRate', 'praiseRate'
    ]), 200);
    const sellerReviewCount = valueToText(firstNestedValue(record, [
      'sellerReviewCount', 'reviewCount', 'evaluationCount', 'creditCount'
    ]), 100);
    const reviewSamplesValue = firstNestedValue(record, [
      'reviews', 'reviewList', 'commentList', 'evaluationList'
    ]);
    const reviewSamples = Array.isArray(reviewSamplesValue)
      ? reviewSamplesValue.map(value => valueToText(value, 1000)).filter(Boolean).slice(0, 20)
      : [];

    if (apiType === 'SEARCH') return null;
    if (/dinamicx|\.zip(?:$|\?)|idlefish_search_item/i.test(`${itemUrl} ${title}`)) return null;
    if (!itemId && !/\/item(?:[/?#]|$)/i.test(itemUrl)) return null;
    if (!title && !images.length && !price) return null;

    const normalized = normalizeItem({
      itemId,
      title,
      description,
      price,
      category,
      images,
      itemUrl,
      sellerName,
      sellerUrl: toAbsoluteUrl(valueToText(firstDirectValue(sellerObject, ['url', 'userUrl', 'shopUrl']), 2000)),
      sellerLocation: valueToText(firstNestedValue(record, ['area', 'location', 'sellerLocation']), 300),
      sellerIntro: valueToText(firstDirectValue(sellerObject, ['intro', 'description', 'bio', 'shopIntro']), 3000),
      storeDuration: valueToText(firstNestedValue(record, ['storeDuration', 'openDuration', 'shopAge', 'registerDuration']), 300),
      reviewSummary,
      itemGoodRate: itemGoodRate || reviewSummary,
      sellerReviewSummary: valueToText(firstNestedValue(record, ['sellerReviewSummary', 'reviewCountText']), 1000),
      sellerReviewCount,
      reviewSamples,
      publishedAt: valueToText(firstNestedValue(record, ['publishedAt', 'publishTime', 'gmtCreate']), 100),
      sourcePage: location.href
    }, `network:${apiType.toLowerCase()}`);

    if (!normalized) return null;
    if (!normalized.itemUrl && normalized.itemId) {
      normalized.itemUrl = `https://www.goofish.com/item?id=${encodeURIComponent(normalized.itemId)}`;
    }
    normalized.sourcePage = toAbsoluteUrl(sourceUrl || location.href) || location.href;
    return normalized;
  }

  function extractNetworkItems(response, apiType, sourceUrl) {
    if (apiType === 'SEARCH') return searchNetworkItems(parseMaybeJson(response), sourceUrl);

    const found = [];
    const seen = new Set();
    const visited = new WeakSet();

    function walk(value, depth = 0) {
      if (depth > 8 || value === null || value === undefined) return;
      value = parseMaybeJson(value);

      if (Array.isArray(value)) {
        for (const entry of value) walk(entry, depth + 1);
        return;
      }
      if (typeof value !== 'object') return;
      if (visited.has(value)) return;
      visited.add(value);

      const candidate = normalizeNetworkRecord(value, apiType, sourceUrl);
      if (candidate) {
        const key = itemKey(candidate);
        if (!seen.has(key)) {
          seen.add(key);
          found.push(candidate);
        }
      }

      for (const child of Object.values(value)) walk(child, depth + 1);
    }

    walk(response);
    return found.slice(0, MAX_PAGE_ITEMS);
  }

  function rememberNetworkItems(items) {
    for (const item of items) {
      const merged = mergeLocalItem(item);
      if (!merged) continue;
      const key = itemKey(merged);
      const index = networkBuffer.findIndex(entry => itemKey(entry) === key);
      if (index >= 0) networkBuffer.splice(index, 1);
      networkBuffer.push(merged);
    }
    while (networkBuffer.length > MAX_NETWORK_BUFFER) networkBuffer.shift();
  }

  function diagnosticValue(value, depth = 0) {
    if (value === null || value === undefined) return value;
    if (typeof value === 'string') return value.slice(0, MAX_DIAGNOSTIC_STRING);
    if (typeof value !== 'object') return value;
    if (depth > 8) return '[TRUNCATED_DEPTH]';

    if (Array.isArray(value)) {
      return value.slice(0, 200).map(entry => diagnosticValue(entry, depth + 1));
    }

    const output = {};
    for (const [key, child] of Object.entries(value).slice(0, 160)) {
      if (/(?:cookie|authorization|token|secret|password|passwd|sign|session|sid|csrf|security)/i.test(key)) {
        output[key] = '[REDACTED]';
      } else {
        output[key] = diagnosticValue(child, depth + 1);
      }
    }
    return output;
  }

  function rememberRawNetworkPayload(payload) {
    if (!payload || typeof payload !== 'object') return;
    const entry = {
      apiType: oneLine(payload.apiType || '', 40),
      sourceUrl: toAbsoluteUrl(payload.sourceUrl || '') || location.origin,
      capturedAt: payload.capturedAt || Date.now(),
      response: diagnosticValue(payload.response)
    };
    rawNetworkBuffer.push(entry);
    while (rawNetworkBuffer.length > MAX_RAW_NETWORK_BUFFER) rawNetworkBuffer.shift();
  }

  function payloadItems(payload) {
    let safePayload = payload;
    try { safePayload = JSON.parse(JSON.stringify(payload)); } catch (_) { return []; }
    rememberRawNetworkPayload(safePayload);
    const items = extractNetworkItems(
      safePayload?.response,
      safePayload?.apiType || 'SEARCH',
      safePayload?.sourceUrl
    );
    rememberNetworkItems(items);
    return items;
  }

  function diagnosticUrl(value) {
    try {
      const url = new URL(value, location.href);
      for (const key of [
        'sign', 'token', 'access_token', 'authorization', '_m_h5_tk', '_m_h5_tk_enc',
        'session', 'sid', 'csrf', 'password', 'passwd'
      ]) url.searchParams.delete(key);
      url.hash = '';
      return url.href;
    } catch (_) {
      return '';
    }
  }

  function diagnosticDom() {
    const root = document.querySelector('main') || document.body || document.documentElement;
    if (!root) return { html: '', htmlTruncated: false, rootTag: '' };

    const clone = root.cloneNode(true);
    clone.querySelectorAll('script, style, link, noscript').forEach(node => node.remove());
    clone.querySelectorAll('input, textarea').forEach(node => {
      node.removeAttribute('value');
      node.textContent = '';
    });
    const rawHtml = clone.outerHTML || '';
    const limit = 8 * 1024 * 1024;
    return {
      html: rawHtml.slice(0, limit),
      htmlTruncated: rawHtml.length > limit,
      rootTag: root.tagName || ''
    };
  }

  function diagnosticLinks() {
    return [...document.querySelectorAll('a[href]')]
      .slice(0, 1200)
      .map(anchor => ({
        text: oneLine(anchor.textContent || '', 300),
        href: diagnosticUrl(anchor.href)
      }))
      .filter(entry => entry.href);
  }

  function diagnosticImages() {
    const output = [];
    const seen = new Set();
    for (const image of [...document.querySelectorAll('img')].slice(0, 800)) {
      for (const attr of ['src', 'data-src', 'data-lazy-src', 'data-original', 'data-ks-lazyload']) {
        const url = diagnosticUrl(image.getAttribute(attr) || '');
        if (!url || seen.has(url)) continue;
        seen.add(url);
        output.push({ url, alt: oneLine(image.alt || '', 300) });
      }
    }
    return output;
  }

  async function collectPageSnapshot() {
    document.dispatchEvent(new CustomEvent(API_SNAPSHOT_REQUEST));
    await new Promise(resolve => setTimeout(resolve, 180));
    const dom = diagnosticDom();
    const root = document.querySelector('main') || document.body || document.documentElement;
    const text = String(root?.innerText || root?.textContent || '').slice(0, 100000);
    const currentPageType = pageType();
    const accountProfile = currentPageType === 'account' ? accountProfileFromPage() : null;
    const { reviews: _reviews, ...accountProfileSummary } = accountProfile || {};
    return {
      ok: true,
      capturedAt: new Date().toISOString(),
      page: {
        url: diagnosticUrl(location.href),
        title: document.title,
        pageType: currentPageType,
        rootTag: dom.rootTag,
        htmlTruncated: dom.htmlTruncated
      },
      html: dom.html,
      visibleText: text,
      links: diagnosticLinks(),
      images: diagnosticImages(),
      normalizedItems: [...pageItems.values()].slice(0, MAX_PAGE_ITEMS),
      accountProfile: accountProfile ? accountProfileSummary : null,
      networkResponses: rawNetworkBuffer.slice(-MAX_RAW_NETWORK_BUFFER),
      networkResponseCount: rawNetworkBuffer.length
    };
  }

  function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function visibleElement(node) {
    if (!node?.getBoundingClientRect) return false;
    try {
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && Number(style.opacity || 1) > 0
        && rect.width > 8
        && rect.height > 8;
    } catch (_) {
      return false;
    }
  }

  function publicLoginDialog() {
    const bodyText = oneLine(document.body?.innerText || '', 20000);
    if (!bodyText.includes('短信登录') || !bodyText.includes('手机扫码安全登录')) return null;

    const selectors = [
      '[role="dialog"]',
      '[class*="login"]', '[class*="Login"]',
      '[class*="modal"]', '[class*="Modal"]',
      '[class*="dialog"]', '[class*="Dialog"]'
    ].join(', ');
    let candidates = [...document.querySelectorAll(selectors)]
      .filter(visibleElement)
      .filter(node => {
        const text = oneLine(node.innerText || node.textContent || '', 5000);
        return text.includes('短信登录') && text.includes('手机扫码安全登录');
      })
      .map(node => {
        const rect = node.getBoundingClientRect();
        return { node, area: rect.width * rect.height };
      })
      .sort((first, second) => first.area - second.area);

    if (!candidates.length) {
      candidates = [...document.querySelectorAll('div, section, form')]
        .filter(visibleElement)
        .filter(node => {
          const text = oneLine(node.innerText || node.textContent || '', 5000);
          return text.includes('短信登录') && text.includes('手机扫码安全登录');
        })
        .map(node => {
          const rect = node.getBoundingClientRect();
          return { node, area: rect.width * rect.height };
        })
        .sort((first, second) => first.area - second.area);
    }

    return candidates[0]?.node || null;
  }

  async function dismissPublicLoginOverlay() {
    const dialog = publicLoginDialog();
    if (!dialog) return { visible: false, dismissed: false };

    const dialogRect = dialog.getBoundingClientRect();
    const controls = [...dialog.querySelectorAll('button, [role="button"], a, div, span')]
      .filter(visibleElement)
      .map(node => {
        const rect = node.getBoundingClientRect();
        const label = oneLine([
          node.getAttribute?.('aria-label'),
          node.getAttribute?.('title'),
          node.textContent,
          node.getAttribute?.('class')
        ].filter(Boolean).join(' '), 300);
        const semanticClose = /关闭|close/i.test(label)
          || /^(?:×|x)$/i.test(oneLine(node.textContent || '', 10));
        const compactTopRight = rect.right >= dialogRect.right - 100
          && rect.top <= dialogRect.top + 100
          && rect.width <= 72
          && rect.height <= 72;
        let score = 0;
        if (!semanticClose && !compactTopRight) return { node, score };
        if (/关闭|close/i.test(label)) score += 20;
        if (/^(?:×|x)$/i.test(oneLine(node.textContent || '', 10))) score += 16;
        if (rect.right >= dialogRect.right - 100 && rect.top <= dialogRect.top + 100) score += 8;
        if (rect.width <= 72 && rect.height <= 72) score += 4;
        if (node.querySelector?.('svg')) score += 3;
        return { node, score };
      })
      .filter(entry => entry.score >= 10)
      .sort((first, second) => second.score - first.score);

    let clicked = false;
    const closeControl = controls[0]?.node;
    if (closeControl) {
      try {
        closeControl.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        clicked = true;
      } catch (_) {
        clicked = false;
      }
    }

    await delay(220);
    if (publicLoginDialog()) {
      // 当前登录窗允许点击遮罩关闭。只在确认登录窗仍可见时点击弹窗外的遮罩，
      // 不填写账号、验证码，也不触碰登录按钮。
      const outsidePoints = [
        { x: Math.max(8, Math.min(window.innerWidth - 8, dialogRect.left - 24)), y: Math.max(8, dialogRect.top + 24) },
        { x: 12, y: 12 }
      ];
      for (const point of outsidePoints) {
        const target = document.elementFromPoint(point.x, point.y);
        if (!target || dialog.contains(target)) continue;
        try {
          target.dispatchEvent(new MouseEvent('click', {
            bubbles: true,
            cancelable: true,
            view: window,
            clientX: point.x,
            clientY: point.y
          }));
          clicked = true;
          break;
        } catch (_) {
          // Continue to the next safe outside point.
        }
      }
      await delay(260);
    }

    return { visible: Boolean(publicLoginDialog()), dismissed: clicked && !publicLoginDialog() };
  }

  function detailPageLooksReady() {
    if (!isDetailPage()) return false;
    const item = buildDetailItem();
    if (!item || !sameDetailIdentity(item)) return false;
    return [
      item.description,
      item.price,
      item.sellerName,
      item.sellerUrl,
      Array.isArray(item.images) && item.images.length ? 'images' : ''
    ].filter(Boolean).length >= 3;
  }

  function accountPageLooksReady() {
    if (pageType() !== 'account') return false;
    const profile = accountProfileFromPage();
    if (!profile?.sellerName || profile.profileScope !== 'account-info-scope') return false;
    return [
      profile.sellerLocation,
      profile.sellerFollowers,
      profile.sellerFollowing,
      profile.sellerProductCount,
      profile.sellerIntro,
      profile.storeDuration,
      profile.sellerGoodRate,
      profile.sellerReviewCount
    ].filter(value => String(value ?? '').trim() !== '').length >= 2;
  }

  async function preparePublicPage(expectedPageType = '', maxAttempts = 12) {
    const expected = ['detail', 'search', 'account'].includes(expectedPageType) ? expectedPageType : pageType();
    let overlay = { visible: false, dismissed: false };
    let actual = pageType();

    for (let attempt = 0; attempt < Math.max(3, Number(maxAttempts) || 12); attempt++) {
      overlay = await dismissPublicLoginOverlay();
      actual = pageType();
      const ready = actual === expected && (
        expected === 'detail'
          ? detailPageLooksReady()
          : expected === 'account'
            ? accountPageLooksReady()
            : cardCandidates().length > 0
      );
      if (ready) {
        return { ok: true, ready: true, pageType: actual, overlayDismissed: overlay.dismissed };
      }
      if (attempt < maxAttempts - 1) await delay(attempt < 2 ? 450 : 700);
    }

    return {
      ok: true,
      ready: false,
      pageType: actual,
      overlayVisible: overlay.visible,
      error: actual !== expected
        ? `页面类型尚未就绪：期望 ${expected}，当前 ${actual}。`
        : '页面主体字段尚未稳定加载。'
    };
  }

  async function collectSearchLinksInVisualOrder() {
    const prepared = await preparePublicPage('search', 12);
    if (!prepared.ready) return { ...prepared, items: [] };

    const originalX = window.scrollX || 0;
    const originalY = window.scrollY || 0;
    const ordered = new Map();
    let stableBottomRounds = 0;
    let previousCount = 0;

    try {
      window.scrollTo({ top: 0, left: originalX, behavior: 'auto' });
      await delay(260);

      for (let round = 0; round < 18; round++) {
        await dismissPublicLoginOverlay();
        for (const item of searchLinkItems()) {
          const key = item.itemId
            ? `id:${item.itemId}`
            : `url:${toAbsoluteUrl(item.itemUrl || '')}`;
          if (!key || key === 'url:') continue;
          if (!ordered.has(key)) ordered.set(key, item);
          else ordered.set(key, {
            ...mergeItemValues(ordered.get(key), item),
            images: unique([...(ordered.get(key).images || []), ...(item.images || [])]),
            reviewSamples: unique([...(ordered.get(key).reviewSamples || []), ...(item.reviewSamples || [])])
          });
        }

        const scrollRoot = document.scrollingElement || document.documentElement;
        const maxTop = Math.max(0, scrollRoot.scrollHeight - window.innerHeight);
        const atBottom = (window.scrollY || scrollRoot.scrollTop || 0) >= maxTop - 120;
        const currentCount = ordered.size;
        stableBottomRounds = atBottom && currentCount === previousCount ? stableBottomRounds + 1 : 0;
        previousCount = currentCount;
        if (atBottom && stableBottomRounds >= 2) break;

        const nextTop = Math.min(maxTop, (window.scrollY || scrollRoot.scrollTop || 0) + Math.max(620, window.innerHeight * 0.82));
        window.scrollTo({ top: nextTop, left: originalX, behavior: 'auto' });
        await delay(round < 3 ? 320 : 460);
      }
    } finally {
      window.scrollTo({ top: originalY, left: originalX, behavior: 'auto' });
    }

    return {
      ok: true,
      ready: ordered.size > 0,
      pageType: pageType(),
      items: [...ordered.values()].slice(0, MAX_PAGE_ITEMS),
      overlayDismissed: prepared.overlayDismissed
    };
  }

  function sendRuntimeRequest(message, timeoutMs = RUNTIME_MESSAGE_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => finish(
        new Error(`扩展后台响应超时（${message?.type || '未知消息'}），请刷新闲鱼页面后重试。`)
      ), Math.max(1000, Number(timeoutMs) || RUNTIME_MESSAGE_TIMEOUT_MS));

      function finish(error, response) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(response);
      }

      try {
        chrome.runtime.sendMessage(message, response => {
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

  async function activateReviewTab() {
    const reviewCards = document.querySelectorAll('[class^="rateItem--"], [class*=" rateItem--"]');
    if (reviewCards.length) return;
    const tab = [...document.querySelectorAll('[class^="textReal--"], [class*=" textReal--"], [role="tab"], button')]
      .find(node => oneLine(node.textContent || '', 100) === '信用及评价');
    if (!tab) return;
    try { tab.click(); } catch (_) { return; }
    await delay(700);
  }

  async function loadAllAccountReviews() {
    const originalScroll = window.scrollY || 0;
    await dismissPublicLoginOverlay();
    await activateReviewTab();
    const container = reviewScrollContainer();
    let stableRounds = 0;
    let previousCount = 0;
    const expected = Math.min(1000, Number(reviewCountFromPage(document.body)) || 1000);

    for (let round = 0; round < 45; round++) {
      await dismissPublicLoginOverlay();
      const cards = [...document.querySelectorAll('[class^="rateItem--"], [class*=" rateItem--"]')];
      const count = cards.length;
      const last = cards[cards.length - 1];
      if (last?.scrollIntoView) {
        try { last.scrollIntoView({ block: 'end', behavior: 'auto' }); } catch (_) { last.scrollIntoView(); }
      }
      if (container) {
        container.scrollTop = container.scrollHeight;
      } else {
        window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'auto' });
      }
      await delay(420);
      const nextCount = document.querySelectorAll('[class^="rateItem--"], [class*=" rateItem--"]').length;
      if (nextCount === count && nextCount === previousCount) stableRounds += 1;
      else stableRounds = 0;
      previousCount = nextCount;
      if ((expected && nextCount >= expected) || stableRounds >= 3) break;
    }

    window.scrollTo({ top: originalScroll, behavior: 'auto' });
    return accountReviewsFromPage(document.body);
  }

  async function collectStoreProfile(persistToDataCenter = true) {
    const prepared = await preparePublicPage('account', 14);
    if (pageType() !== 'account') {
      return { ok: false, pageType: pageType(), error: '当前不是卖家账号页，请先打开闲鱼店铺/账号页。' };
    }
    if (!prepared.ready) {
      return { ok: false, pageType: pageType(), error: prepared.error || '店铺资料尚未稳定加载，请稍后重试。' };
    }
    const reviews = await loadAllAccountReviews();
    const profile = accountProfileFromPage();
    profile.reviews = reviews;
    profile.reviewCountLoaded = reviews.length;
    profile.collectedAt = new Date().toISOString();
    try {
      const saved = await sendRuntimeRequest({
        type: 'COLLECT_STORE_PROFILE',
        profile,
        persistToDataCenter,
        sourcePage: location.href
      });
      return {
        ok: saved?.ok !== false,
        sellerName: profile.sellerName,
        profile,
        staged: saved?.staged === true,
        storeCount: saved?.storeCount || 0,
        reviewCount: saved?.reviewCount || profile.reviews.length,
        reviewCountLoaded: profile.reviews.length,
        error: saved?.error || ''
      };
    } catch (error) {
      return { ...profile, ok: false, error: error?.message || String(error) };
    }
  }

  function isDisabledControl(node) {
    if (!node) return true;
    if (node.disabled || node.getAttribute('aria-disabled') === 'true') return true;
    return /(?:disabled|disable|不可用)/i.test(String(node.className || ''));
  }

  function isVisibleControl(node) {
    if (!node) return false;
    try {
      const style = window.getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    } catch (_) {
      return true;
    }
  }

  function controlLabel(node) {
    return oneLine(
      node?.getAttribute?.('aria-label')
        || node?.getAttribute?.('title')
        || node?.textContent
        || '',
      100
    ).replace(/^[\s<>‹«]+|[\s>›»]+$/g, '').trim();
  }

  function pageNumberFromControl(node) {
    const label = controlLabel(node);
    const match = label.match(/^(?:第\s*)?(\d{1,4})(?:\s*页)?$/i);
    return match ? Number(match[1]) : 0;
  }

  function currentPageFromUrl() {
    try {
      const url = new URL(location.href);
      for (const key of ['page', 'pageNo', 'pageNum', 'pageIndex']) {
        const value = Number(url.searchParams.get(key));
        if (Number.isInteger(value) && value > 0) return value;
      }
    } catch (_) {
      // ignore malformed URL
    }
    return 0;
  }

  function pagerState(root) {
    if (!root) return { current: 0, total: 0 };
    const tinyLabel = root.querySelector('[class*="search-page-tiny-page"]');
    const text = oneLine(tinyLabel?.textContent || '', 100);
    const fraction = text.match(/(\d{1,4})\s*\/\s*(\d{1,4})/);
    let current = fraction ? Number(fraction[1]) : 0;
    const total = fraction ? Number(fraction[2]) : 0;

    const active = root.querySelector(
      '[aria-current="page"], [aria-selected="true"], [class*="is-active"], [class*="isActive"], [class*="active"], [class*="Active"], [class*="current"], [class*="Current"]'
    );
    current = pageNumberFromControl(active) || current || currentPageFromUrl();
    return { current, total };
  }

  function pagerRoots() {
    const selectors = [
      '[class*="search-page-tiny-container"]',
      '[class^="pagination"]',
      '[class*=" pagination"]',
      '[class*="Pagination"]',
      '[aria-label*="分页"]',
      '[aria-label*="page"]',
      'nav',
      '[role="navigation"]'
    ];
    return [...document.querySelectorAll(selectors.join(','))]
      .filter(root => isVisibleControl(root))
      .sort((a, b) => (a.querySelectorAll('button, a, [role="button"], [tabindex]').length)
        - (b.querySelectorAll('button, a, [role="button"], [tabindex]').length));
  }

  function pagerControls(root) {
    return [...root.querySelectorAll('button, a, [role="button"], [tabindex], [onclick]')]
      .filter(node => !isDisabledControl(node) && isVisibleControl(node));
  }

  function numericPageControl(root, pageNumber) {
    return pagerControls(root).find(node => pageNumberFromControl(node) === pageNumber) || null;
  }

  function findNextPageControl() {
    // 闲鱼当前搜索页常见的分页器是 search-page-tiny-container：
    // 它不提供“下一页”文字，右侧只是一个没有文字的箭头；优先按页码状态寻找下一页。
    for (const root of pagerRoots()) {
      const state = pagerState(root);
      if (!state.current) continue;
      const nextNumber = state.current + 1;
      if (state.total && nextNumber > state.total) continue;

      const numeric = numericPageControl(root, nextNumber);
      if (numeric) return numeric;

      const rightArrow = root.querySelector(
        '[class*="search-page-tiny-arrow-right"]'
      )?.closest?.('button, a, [role="button"]')
        || [...root.querySelectorAll('button, a, [role="button"]')]
          .find(node => /(?:下一页|下页|next|right)/i.test(controlLabel(node)));
      if (rightArrow && !isDisabledControl(rightArrow) && isVisibleControl(rightArrow)) return rightArrow;
    }

    // 兼容其它版本：如果分页器使用文字按钮，仍然支持直接识别“下一页”。
    const candidates = [...document.querySelectorAll('button, a, [role="button"], [tabindex], [onclick]')];
    const direct = candidates.find(node => {
      if (isDisabledControl(node) || !isVisibleControl(node)) return false;
      return /^(下一页|下一頁|下页|下頁|next|next\s+page|go\s+to\s+next\s+page)$/i.test(controlLabel(node));
    });
    if (direct) return direct;
    return null;
  }

  function clickNextPage() {
    const control = findNextPageControl();
    if (!control) {
      return { ok: true, moved: false, reason: '当前页面没有识别到可用的下一页页码或分页控件。' };
    }

    try {
      control.scrollIntoView({ block: 'center', behavior: 'auto' });
    } catch (_) {
      control.scrollIntoView();
    }
    control.click();
    window.scrollTo({ top: 0, behavior: 'auto' });
    const current = pagerRoots().map(pagerState).find(state => state.current)?.current || 0;
    return {
      ok: true,
      moved: true,
      label: controlLabel(control),
      page: pageNumberFromControl(control) || (current ? current + 1 : 0),
      currentPage: current
    };
  }

  function sameDetailIdentity(item) {
    const currentId = extractItemIdFromUrl(location.href);
    const itemId = cleanText(item?.itemId, 200) || extractItemIdFromUrl(item?.itemUrl || '');
    if (currentId && itemId) return currentId === itemId;

    const currentUrl = toAbsoluteUrl(location.href);
    const itemUrl = toAbsoluteUrl(item?.itemUrl || '');
    if (!currentUrl || !itemUrl) return false;
    try {
      const a = new URL(currentUrl);
      const b = new URL(itemUrl);
      a.hash = '';
      b.hash = '';
      for (const key of ['spm', 'scm', 'from', 'source']) {
        a.searchParams.delete(key);
        b.searchParams.delete(key);
      }
      return a.href === b.href;
    } catch (_) {
      return currentUrl === itemUrl;
    }
  }

  function finalDetailItems(items) {
    const list = (Array.isArray(items) ? items.filter(Boolean) : [])
      .filter(item => {
        const text = `${item?.title || ''}\n${item?.description || ''}`;
        const hasProductSignal = Boolean(
          item?.sellerUrl || item?.sellerName || item?.price || (Array.isArray(item?.images) && item.images.length)
        );
        // 详情路由偶尔会落到平台协议/隐私页面；URL 仍带 itemId，不能仅凭路由判为商品成功。
        return hasProductSignal || !/闲鱼社区服务协议|用户协议|隐私政策|平台规则|服务条款/i.test(text);
      });
    if (!isDetailPage()) return [];
    const matched = list.filter(sameDetailIdentity);
    // 有些详情路由没有把商品 ID 放进 URL；这种情况下只接受当前详情页自己构造的
    // DOM 记录，避免把接口响应中的“为你推荐”商品写进主表。
    return matched.length ? matched : list.filter(item => sameDetailIdentity(item));
  }

  async function sendItems(items, reason, options = {}) {
    if (Object.prototype.hasOwnProperty.call(options, 'persistToDataCenter')) {
      pagePersistToDataCenter = options.persistToDataCenter !== false;
    }
    const finalItems = isDetailPage() ? finalDetailItems(items) : [];
    if (!finalItems.length) return { ok: true, count: 0, total: pageItems.size, reason, ignored: true };
    try {
      const result = await sendRuntimeRequest({
        type: 'COLLECT_ITEMS',
        items: finalItems,
        sourcePage: location.href,
        pageType: pageType(),
        reason,
        persistToDataCenter: pagePersistToDataCenter
      });
      return result || { ok: true, count: finalItems.length, total: pageItems.size };
    } catch (error) {
      return { ok: false, error: error?.message || String(error) };
    }
  }

  function scheduleScan() {
    if (!captureEnabled || scanTimer) return;
    scanTimer = setTimeout(async () => {
      scanTimer = null;
      const found = scanDom();
      await sendItems(found, 'page-change');
    }, 500);
  }

  document.addEventListener(NETWORK_EVENT, async event => {
    const items = payloadItems(event.detail);
    if (captureEnabled) await sendItems(items, 'network-response');
  });

  document.addEventListener(API_SNAPSHOT_EVENT, event => {
    const entries = Array.isArray(event.detail?.entries) ? event.detail.entries : [];
    for (const entry of entries) payloadItems(entry);
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'COLLECT_CURRENT_PAGE') {
      captureEnabled = true;
      pagePersistToDataCenter = message.persistToDataCenter !== false;
      Promise.resolve().then(async () => {
        const prepared = await preparePublicPage('detail', 14);
        if (!prepared.ready || !isDetailPage()) {
          sendResponse({
            ok: false,
            pageType: pageType(),
            error: prepared.error || '当前不是已稳定加载的商品详情页，搜索卡片不会作为最终商品记录保存。'
          });
          return;
        }
        const found = scanDom();
        const result = await sendItems(found, 'manual', { persistToDataCenter: pagePersistToDataCenter });
        sendResponse({
          ...result,
          pageType: pageType(),
          pageItems: pageItems.size,
          // 后台已经按当前详情页身份过滤过一次；优先返回过滤后的结果，
          // 避免把网络/DOM 扫描中的推荐商品带到当前详情页的单独导出里。
          items: Array.isArray(result?.items) ? result.items : found
        });
      }).catch(error => sendResponse({
        ok: false,
        pageType: pageType(),
        error: error?.message || String(error)
      }));
      return true;
    }

    if (message?.type === 'START_API_CAPTURE') {
      captureEnabled = true;
      pagePersistToDataCenter = message.persistToDataCenter !== false;
      Promise.resolve().then(async () => {
        try {
          const prepared = await preparePublicPage('detail', 14);
          if (!prepared.ready || !isDetailPage()) {
            sendResponse({
              ok: false,
              pageType: pageType(),
              mode: 'api',
              error: prepared.error || '接口观察模式必须落在已稳定加载的商品详情页。'
            });
            return;
          }
          document.dispatchEvent(new CustomEvent(API_SNAPSHOT_REQUEST));
          await delay(180);
          // 接口响应可能在扩展刚加载前就完成，因此用当前详情 DOM 做一次轻量合并，
          // 让“接口观察”在旧标签页上也有可解释的回退结果。
          const domFound = scanDom();
          const currentItemId = extractItemIdFromUrl(location.href);
          const detailNetwork = networkBuffer.filter(item => {
            if (currentItemId) {
              return cleanText(item?.itemId, 200) === currentItemId
                || extractItemIdFromUrl(item?.itemUrl || '') === currentItemId;
            }
            return sameDetailIdentity(item);
          });
          const foundByKey = new Map([...detailNetwork, ...domFound]
            .filter(sameDetailIdentity)
            .map(item => [itemKey(item), item]));
          const found = [...foundByKey.values()];
          const result = await sendItems(found, 'api-snapshot', { persistToDataCenter: pagePersistToDataCenter });
          sendResponse({
            ...result,
            pageType: 'detail',
            mode: 'api',
            pageItems: pageItems.size,
            buffered: found.length,
            // 与页面详情模式保持一致：单页导出只使用后台确认属于当前详情页的记录。
            items: Array.isArray(result?.items) ? result.items : found
          });
        } catch (error) {
          // 任何 DOM/API 解析异常都必须结束这次消息；否则后台会一直等待，
          // 任务就会把所有采集入口锁在“处理中”。
          sendResponse({
            ok: false,
            pageType: pageType(),
            mode: 'api',
            error: error?.message || String(error)
          });
        }
      });
      return true;
    }

    if (message?.type === 'PREPARE_PUBLIC_PAGE') {
      preparePublicPage(message.expectedPageType || pageType(), message.maxAttempts || 12)
        .then(sendResponse)
        .catch(error => sendResponse({ ok: false, ready: false, pageType: pageType(), error: error?.message || String(error) }));
      return true;
    }

    if (message?.type === 'GO_NEXT_PAGE') {
      sendResponse(clickNextPage());
      return false;
    }

    if (message?.type === 'GET_SEARCH_LINKS') {
      if (pageType() !== 'search') {
        sendResponse({ ok: false, pageType: pageType(), error: '当前不是搜索结果页。' });
        return false;
      }
      collectSearchLinksInVisualOrder().then(result => sendResponse({
        ...result,
        pageUrl: location.href,
        pageTitle: document.title,
        pager: pagerRoots().map(pagerState).find(state => state.current || state.total) || { current: 0, total: 0 }
      })).catch(error => sendResponse({
        ok: false,
        ready: false,
        pageType: pageType(),
        items: [],
        error: error?.message || String(error)
      }));
      return true;
    }

    if (message?.type === 'GET_PAGE_SNAPSHOT') {
      collectPageSnapshot().then(sendResponse).catch(error => sendResponse({
        ok: false,
        error: error?.message || String(error)
      }));
      return true;
    }

    if (message?.type === 'GET_PAGE_INFO') {
      sendResponse({
        ok: true,
        url: location.href,
        title: document.title,
        pageType: pageType(),
        pageItems: pageItems.size
      });
      return false;
    }

    if (message?.type === 'GET_SELLER_ENTRY') {
      preparePublicPage('detail', 10).then(prepared => {
        if (!prepared.ready || !isDetailPage()) {
          sendResponse({ ok: false, pageType: pageType(), error: prepared.error || '当前不是商品详情页。' });
          return;
        }
        const entry = sellerEntryFromRoot(document.body);
        sendResponse({
          ok: true,
          pageType: 'detail',
          ...entry,
          sourcePage: location.href
        });
      }).catch(error => sendResponse({ ok: false, pageType: pageType(), error: error?.message || String(error) }));
      return true;
    }

    if (message?.type === 'GET_ACCOUNT_PROFILE') {
      dismissPublicLoginOverlay().then(() => {
        if (pageType() !== 'account') {
          sendResponse({ ok: false, pageType: pageType(), error: '当前不是卖家账号页。' });
          return;
        }
        const profile = accountProfileFromPage();
        const { reviews: _reviews, ...summary } = profile;
        sendResponse(summary);
      }).catch(error => sendResponse({ ok: false, pageType: pageType(), error: error?.message || String(error) }));
      return true;
    }

    if (message?.type === 'COLLECT_CURRENT_STORE_PAGE') {
      collectStoreProfile(message.persistToDataCenter !== false)
        .then(sendResponse)
        .catch(error => sendResponse({ ok: false, error: error?.message || String(error) }));
      return true;
    }
    return false;
  });

  const observer = new MutationObserver(() => scheduleScan());
  function startObserver() {
    if (!document.documentElement) return;
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }
  if (document.documentElement) startObserver();
  else document.addEventListener('DOMContentLoaded', startObserver, { once: true });
  window.addEventListener('scroll', scheduleScan, { passive: true });
})();
