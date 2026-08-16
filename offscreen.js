(() => {
  'use strict';

  // Prefer the original CDN bytes.  The previous 1600px/8MB cap visibly
  // blurred large product cards before Excel embedding; conversion is now a
  // fallback only for unsupported or genuinely oversized image payloads.
  const MAX_IMAGE_SIDE = 8192;
  const MAX_IMAGE_BYTES = 24 * 1024 * 1024;
  // 评价图片不与商品图片共用商品图上限；这个值只是防止异常页面一次性生成
  // 过大的工作簿。正常店铺评价数量远低于此值。
  const MAX_REVIEW_IMAGE_ASSETS = 20000;

  function cleanText(value, maxLength = 120) {
    return String(value ?? '').replace(/\u0000/g, '').trim().slice(0, maxLength);
  }

  function cleanFilePart(value, fallback = '未命名') {
    const cleaned = cleanText(value || fallback)
      .replace(/[\\/:*?"<>|]+/g, '_')
      .replace(/\s+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^[_\.\-]+|[_\.\-]+$/g, '');
    return cleaned || fallback;
  }

  function itemKey(item) {
    if (item.itemId) return `id:${item.itemId}`;
    if (item.itemUrl) return `url:${item.itemUrl}`;
    return `text:${[item.title, item.sellerName, item.price].join('|')}`;
  }

  function imageFileName(item, imageIndex, extension) {
    const title = cleanFilePart(item.title, item.itemId || '商品');
    const seller = cleanFilePart(item.sellerName, '未知店铺');
    const id = item.itemId ? cleanFilePart(String(item.itemId).slice(-16), '') : '无ID';
    const sequence = String(imageIndex).padStart(2, '0');
    return `${title}_${seller}_${id}_图${sequence}.${extension || 'jpg'}`;
  }

  function reviewImageFileName(profile, reviewIndex, imageIndex, extension) {
    const seller = cleanFilePart(profile?.sellerName, '未知店铺');
    const storeId = cleanFilePart(String(profile?.sellerUrl || '').split('userId=').pop(), '店铺');
    const review = String(reviewIndex || 1).padStart(3, '0');
    const sequence = String(imageIndex || 1).padStart(2, '0');
    return `${seller}_${storeId}_评价${review}_图${sequence}.${extension || 'jpg'}`;
  }

  function mimeFromBytes(bytes, fallback = '', url = '') {
    if (bytes?.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
    if (bytes?.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
    if (bytes?.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif';
    if (bytes?.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP') return 'image/webp';
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

  function visualDedupKeyFromCanvas(canvas) {
    try {
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) return '';
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let first = 2166136261;
      let second = 0x9e3779b9;
      for (let index = 0; index < pixels.length; index += 4) {
        const value = ((pixels[index] >> 3) << 11)
          | ((pixels[index + 1] >> 3) << 6)
          | ((pixels[index + 2] >> 3) << 1)
          | (pixels[index + 3] >> 7);
        first ^= value;
        first = Math.imul(first, 16777619);
        second ^= value + index;
        second = Math.imul(second, 2246822519);
      }
      return `visual:32:${first >>> 0}:${second >>> 0}`;
    } catch (_) {
      return '';
    }
  }

  async function visualDedupKeyFromBitmap(bitmap) {
    try {
      const size = 32;
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) return '';
      context.imageSmoothingEnabled = true;
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, size, size);
      context.drawImage(bitmap, 0, 0, size, size);
      return visualDedupKeyFromCanvas(canvas);
    } catch (_) {
      return '';
    }
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
        return { bytes: rawBytes, mime: sourceMime, extension: extensionFromMime(sourceMime), width, height };
      }
      throw new Error('浏览器无法解码该图片格式');
    }

    try {
      const visualKey = await visualDedupKeyFromBitmap(bitmap);
      const supported = ['image/jpeg', 'image/png', 'image/gif'].includes(sourceMime);
      const withinLimit = width <= MAX_IMAGE_SIDE && height <= MAX_IMAGE_SIDE && rawBytes.length <= MAX_IMAGE_BYTES;
      if (supported && withinLimit) {
        return { bytes: rawBytes, mime: sourceMime, extension: extensionFromMime(sourceMime), width, height, visualKey };
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
      const normalizedVisualKey = visualDedupKeyFromCanvas(canvas) || visualKey;
      const outputMime = sourceMime === 'image/png' ? 'image/png' : 'image/jpeg';
      const outputBlob = await canvasToBlob(canvas, outputMime, 0.96);
      return {
        bytes: new Uint8Array(await outputBlob.arrayBuffer()),
        mime: outputMime,
        extension: extensionFromMime(outputMime),
        width: canvas.width,
        height: canvas.height,
        visualKey: normalizedVisualKey
      };
    } finally {
      bitmap.close();
    }
  }

  function imageCandidates(sourceUrl) {
    const values = [String(sourceUrl || '')].filter(Boolean);
    try {
      const parsed = new URL(sourceUrl);
      const clean = new URL(parsed.href);
      for (const key of [...clean.searchParams.keys()]) {
        if (/resize|width|height|quality|thumbnail|thumb|process|imageview|crop|format|spm|scm|ut_sk|utsk|from|source/i.test(key)) {
          clean.searchParams.delete(key);
        }
      }
      if (clean.href !== parsed.href) values.push(clean.href);
      const cleanPath = stripImageVariant(parsed.pathname);
      if (cleanPath !== parsed.pathname) {
        const pathUrl = new URL(parsed.href);
        pathUrl.pathname = cleanPath;
        values.push(pathUrl.href);
      }
    } catch (_) {
      // Keep the original URL as the only candidate when it is not absolute.
    }
    return [...new Set(values)];
  }

  function stripImageVariant(pathname) {
    let path = String(pathname || '');
    path = path.replace(/(?:[_-]q\d+|[_-]\d{2,5}x\d{2,5}(?:q\d+)?)(?:\.[a-z\d]+_?)*$/i, '');
    path = path.replace(/@[!_][^/]+$/i, '');
    return path.replace(/([_-])\d{2,5}x\d{2,5}(?=\.[a-z\d]{2,8}$)/i, '');
  }

  function imageDedupKey(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    try {
      const parsed = new URL(raw);
      for (const key of [...parsed.searchParams.keys()]) {
        if (/resize|width|height|quality|thumbnail|thumb|process|imageview|crop|format|spm|scm|ut_sk|utsk|from|source/i.test(key)) {
          parsed.searchParams.delete(key);
        }
      }
      parsed.hash = '';
      parsed.pathname = stripImageVariant(parsed.pathname);
      return parsed.href;
    } catch (_) {
      return stripImageVariant(raw);
    }
  }

  function uniqueImageUrls(values) {
    const seen = new Set();
    return values
      .map(value => String(value || '').trim())
      .filter(value => {
        const key = imageDedupKey(value) || value;
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  }

  async function downloadImage(sourceUrl) {
    let lastError = null;
    for (const candidate of imageCandidates(sourceUrl)) {
      try {
        const response = await fetch(candidate, { credentials: 'omit', redirect: 'follow' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const blob = await response.blob();
        if (!blob.size) throw new Error('图片为空');
        return decodeImageBlob(blob, candidate);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error('图片下载失败');
  }

  function bytesDedupKey(value) {
    const bytes = value instanceof Uint8Array
      ? value
      : value instanceof ArrayBuffer
        ? new Uint8Array(value)
        : ArrayBuffer.isView(value)
          ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
          : null;
    if (!bytes?.length) return '';
    let hash = 2166136261;
    for (const byte of bytes) {
      hash ^= byte;
      hash = Math.imul(hash, 16777619);
    }
    return `bytes:${bytes.length}:${hash >>> 0}`;
  }

  function renumberImageFileName(fileName, imageIndex) {
    const sequence = String(imageIndex).padStart(2, '0');
    return String(fileName || '').replace(/图\d+(?=\.[a-z\d]+$)/i, `图${sequence}`);
  }

  function dedupePreparedAssets(assets) {
    const seenByScope = new Map();
    const nextIndexByScope = new Map();
    return assets.filter(Boolean).filter(asset => {
      const scope = asset.kind === 'review'
        ? `review:${asset.reviewKey || asset.itemKey || asset.storeName || ''}`
        : `product:${asset.itemKey || asset.itemId || asset.itemUrl || ''}`;
      const keys = [
        imageDedupKey(asset.url) ? `url:${imageDedupKey(asset.url)}` : '',
        bytesDedupKey(asset.bytes),
        asset.visualKey || ''
      ].filter(Boolean);
      if (!keys.length) keys.push(`index:${asset.imageIndex || ''}`);
      const seen = seenByScope.get(scope) || new Set();
      if (keys.some(key => seen.has(key))) return false;
      keys.forEach(key => seen.add(key));
      seenByScope.set(scope, seen);
      const imageIndex = (nextIndexByScope.get(scope) || 0) + 1;
      nextIndexByScope.set(scope, imageIndex);
      asset.imageIndex = imageIndex;
      asset.fileName = renumberImageFileName(asset.fileName, imageIndex);
      return true;
    });
  }

  async function prepareImageAssets(items, settings, storeProfiles, fieldConfig = {}) {
    const perItemLimit = Math.max(0, Number(settings?.imageLimit) || 0);
    const maxImages = Math.max(1, Math.min(1000, Number(settings?.maxEmbedImages) || 1000));
    const productFields = Array.isArray(fieldConfig.product) ? fieldConfig.product : null;
    const reviewFields = Array.isArray(fieldConfig.storeReview) ? fieldConfig.storeReview : null;
    const needProductImages = !productFields || productFields.some(field => ['images', 'mainImageName', 'imageStatus'].includes(field));
    const needReviewImages = !reviewFields || reviewFields.some(field => ['reviewImages', 'reviewImageNames', 'reviewImageStatus', 'reviewImageFailureUrl'].includes(field));
    const candidates = [];

    for (const item of needProductImages ? items : []) {
      const urls = uniqueImageUrls(Array.isArray(item.images) ? item.images : []);
      const selected = perItemLimit > 0 ? urls.slice(0, perItemLimit) : urls;
      selected.forEach((url, index) => candidates.push({
        kind: 'product',
        item,
        itemKey: itemKey(item),
        imageIndex: index + 1,
        url
      }));
    }

    for (const profile of needReviewImages ? (Array.isArray(storeProfiles) ? storeProfiles : []) : []) {
      for (const review of Array.isArray(profile?.reviews) ? profile.reviews : []) {
        const urls = uniqueImageUrls(Array.isArray(review?.images) ? review.images : []);
        urls.forEach((url, index) => candidates.push({
          kind: 'review',
          profile,
          reviewKey: `${profile?.sellerUrl || profile?.sellerName || '未知店铺'}|review:${review?.reviewIndex || 1}`,
          itemKey: `review:${profile?.sellerUrl || profile?.sellerName || '未知店铺'}|${review?.reviewIndex || 1}`,
          reviewIndex: review?.reviewIndex || 1,
          imageIndex: index + 1,
          url
        }));
      }
    }

    const productCandidates = candidates.filter(candidate => candidate.kind !== 'review');
    const reviewCandidates = candidates.filter(candidate => candidate.kind === 'review');
    // 商品图受设置里的上限控制；评价图片不被商品图挤占，按已采集评价逐张处理。
    const jobs = [
      ...productCandidates.slice(0, maxImages),
      ...reviewCandidates.slice(0, MAX_REVIEW_IMAGE_ASSETS)
    ];
    const assets = new Array(jobs.length);
    const cache = new Map();
    let cursor = 0;
    let completed = 0;

    async function worker() {
      while (cursor < jobs.length) {
        const index = cursor++;
        const job = jobs[index];
        const cacheKey = imageDedupKey(job.url) || job.url;
        let imagePromise = cache.get(cacheKey);
        if (!imagePromise) {
          imagePromise = downloadImage(job.url).catch(error => ({ error: error?.message || String(error) }));
          cache.set(cacheKey, imagePromise);
        }
        const image = await imagePromise;
        assets[index] = {
          kind: job.kind || 'product',
          itemKey: job.itemKey,
          itemId: job.item?.itemId || '',
          title: job.item?.title || '',
          sellerName: job.item?.sellerName || '',
          itemUrl: job.item?.itemUrl || '',
          collectedAt: job.item?.collectedAt || job.profile?.collectedAt || '',
          imageIndex: job.imageIndex,
          reviewIndex: job.reviewIndex || '',
          reviewKey: job.reviewKey || '',
          storeName: job.profile?.sellerName || '',
          sellerUrl: job.profile?.sellerUrl || '',
          url: job.url,
          fileName: job.kind === 'review'
            ? reviewImageFileName(job.profile, job.reviewIndex, job.imageIndex, image.extension || 'jpg')
            : imageFileName(job.item, job.imageIndex, image.extension || 'jpg'),
          ...(image.bytes ? image : { error: image.error || '下载失败' })
        };
        completed += 1;
      }
    }

    await Promise.all(Array.from({ length: Math.min(4, Math.max(1, jobs.length)) }, () => worker()));
    const dedupedAssets = dedupePreparedAssets(assets);
    return {
      assets: dedupedAssets,
      requested: dedupedAssets.length,
      productImageCount: dedupedAssets.filter(asset => asset.kind !== 'review').length,
      reviewImageCount: dedupedAssets.filter(asset => asset.kind === 'review').length,
      truncated: productCandidates.length > maxImages || reviewCandidates.length > MAX_REVIEW_IMAGE_ASSETS
    };
  }

  async function exportWorkbook(message) {
    const items = Array.isArray(message.items) ? message.items : [];
    const storeProfiles = Array.isArray(message.storeProfiles) ? message.storeProfiles : [];
    const fieldConfig = message.fieldConfig || {
      product: message.settings?.productFields,
      storeProfile: message.settings?.storeProfileFields,
      storeReview: message.settings?.storeReviewFields
    };
    const prepared = await prepareImageAssets(items, message.settings || {}, storeProfiles, fieldConfig);
    const blob = window.XianyuXlsx.createWorkbook(items, prepared.assets, storeProfiles, {
      kind: message.exportKind || 'product',
      fieldConfig
    });
    const url = URL.createObjectURL(blob);
    const embedded = prepared.assets.filter(asset => asset.bytes?.length).length;
    const failed = prepared.assets.length - embedded;
    return {
      ok: true,
      url,
      filename: message.filename || '闲鱼商品研究.xlsx',
      requested: prepared.requested,
      embedded,
      failed,
      truncated: prepared.truncated,
      itemCount: items.length,
      storeCount: storeProfiles.length,
      reviewCount: storeProfiles.reduce((sum, profile) => sum + (profile.reviews?.length || 0), 0)
    };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.target !== 'offscreen') return false;

    if (message.type === 'OFFSCREEN_EXPORT') {
      exportWorkbook(message)
        .then(sendResponse)
        .catch(error => sendResponse({ ok: false, error: error?.message || String(error) }));
      return true;
    }

    if (message.type === 'OFFSCREEN_RELEASE') {
      if (message.url) URL.revokeObjectURL(message.url);
      sendResponse({ ok: true });
      return false;
    }

    return false;
  });
})();
