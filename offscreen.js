(() => {
  'use strict';

  const MAX_IMAGE_SIDE = 1600;
  const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
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
      const supported = ['image/jpeg', 'image/png', 'image/gif'].includes(sourceMime);
      const withinLimit = width <= MAX_IMAGE_SIDE && height <= MAX_IMAGE_SIDE && rawBytes.length <= MAX_IMAGE_BYTES;
      if (supported && withinLimit) {
        return { bytes: rawBytes, mime: sourceMime, extension: extensionFromMime(sourceMime), width, height };
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
      return {
        bytes: new Uint8Array(await outputBlob.arrayBuffer()),
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

  async function prepareImageAssets(items, settings, storeProfiles) {
    const perItemLimit = Math.max(0, Number(settings?.imageLimit) || 0);
    const maxImages = Math.max(1, Math.min(1000, Number(settings?.maxEmbedImages) || 1000));
    const candidates = [];

    for (const item of items) {
      const urls = [...new Set((Array.isArray(item.images) ? item.images : []).filter(Boolean))];
      const selected = perItemLimit > 0 ? urls.slice(0, perItemLimit) : urls;
      selected.forEach((url, index) => candidates.push({
        kind: 'product',
        item,
        itemKey: itemKey(item),
        imageIndex: index + 1,
        url
      }));
    }

    for (const profile of Array.isArray(storeProfiles) ? storeProfiles : []) {
      for (const review of Array.isArray(profile?.reviews) ? profile.reviews : []) {
        const urls = [...new Set((Array.isArray(review?.images) ? review.images : []).filter(Boolean))];
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
        let imagePromise = cache.get(job.url);
        if (!imagePromise) {
          imagePromise = downloadImage(job.url).catch(error => ({ error: error?.message || String(error) }));
          cache.set(job.url, imagePromise);
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
    return {
      assets,
      requested: jobs.length,
      productImageCount: productCandidates.length,
      reviewImageCount: reviewCandidates.length,
      truncated: productCandidates.length > maxImages || reviewCandidates.length > MAX_REVIEW_IMAGE_ASSETS
    };
  }

  async function exportWorkbook(message) {
    const items = Array.isArray(message.items) ? message.items : [];
    const storeProfiles = Array.isArray(message.storeProfiles) ? message.storeProfiles : [];
    const prepared = await prepareImageAssets(items, message.settings || {}, storeProfiles);
    const blob = window.XianyuXlsx.createWorkbook(items, prepared.assets, storeProfiles, {
      kind: message.exportKind || 'product'
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
