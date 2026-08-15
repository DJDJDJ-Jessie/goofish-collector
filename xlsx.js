(() => {
  'use strict';

  const encoder = new TextEncoder();
  const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  const DRAWING_REL_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing';
  const IMAGE_REL_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image';

  function xmlEscape(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  function u16(value) {
    return new Uint8Array([value & 0xff, (value >>> 8) & 0xff]);
  }

  function u32(value) {
    return new Uint8Array([
      value & 0xff,
      (value >>> 8) & 0xff,
      (value >>> 16) & 0xff,
      (value >>> 24) & 0xff
    ]);
  }

  function concat(parts) {
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const output = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      output.set(part, offset);
      offset += part.length;
    }
    return output;
  }

  const crcTable = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }

  // XLSX 本质上是一个 ZIP 包。这里使用无压缩 ZIP，避免依赖第三方库，
  // 同时把真实图片二进制写入 xl/media/，由 drawing XML 放到工作表上。
  function zipStore(files) {
    const locals = [];
    const centrals = [];
    let offset = 0;

    for (const file of files) {
      const name = encoder.encode(file.name);
      const data = typeof file.data === 'string' ? encoder.encode(file.data) : file.data;
      const crc = crc32(data);
      const flags = 0x0800; // UTF-8 文件名标志

      const localHeader = concat([
        u32(0x04034b50), u16(20), u16(flags), u16(0), u16(0), u16(0),
        u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0)
      ]);
      locals.push(localHeader, name, data);

      const centralHeader = concat([
        u32(0x02014b50), u16(20), u16(20), u16(flags), u16(0), u16(0), u16(0),
        u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0),
        u16(0), u16(0), u16(0), u32(0), u32(offset)
      ]);
      centrals.push(centralHeader, name);
      offset += localHeader.length + name.length + data.length;
    }

    const centralDirectory = concat(centrals);
    const end = concat([
      u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length),
      u32(centralDirectory.length), u32(offset), u16(0)
    ]);

    return concat([...locals, centralDirectory, end]);
  }

  function columnName(index) {
    let name = '';
    let value = index + 1;
    while (value > 0) {
      const remainder = (value - 1) % 26;
      name = String.fromCharCode(65 + remainder) + name;
      value = Math.floor((value - 1) / 26);
    }
    return name;
  }

  function cell(ref, value, style = 0) {
    if (value === undefined || value === null || value === '') {
      return `<c r="${ref}" s="${style}" t="inlineStr"><is><t></t></is></c>`;
    }
    return `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`;
  }

  function sheetXml(headers, rows, widths = [], options = {}) {
    const allRows = [headers, ...rows];
    const rowHeights = options.rowHeights || {};
    const textColumns = new Set(options.textColumns || []);
    const rowXml = allRows.map((row, rowIndex) => {
      const style = rowIndex === 0 ? 1 : 0;
      const height = rowHeights[rowIndex + 1];
      const heightAttribute = height ? ` ht="${height}" customHeight="1"` : '';
      const cells = row.map((value, columnIndex) => cell(
        `${columnName(columnIndex)}${rowIndex + 1}`,
        value,
        textColumns.has(columnIndex) && rowIndex > 0 ? 2 : style
      )).join('');
      return `<row r="${rowIndex + 1}"${heightAttribute}>${cells}</row>`;
    }).join('');

    const cols = widths.length
      ? `<cols>${widths.map((width, index) => `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`).join('')}</cols>`
      : '';
    const lastColumn = columnName(headers.length - 1);
    const drawing = options.drawingRelId ? `<drawing r:id="${xmlEscape(options.drawingRelId)}"/>` : '';
    const selected = options.selected ? ' tabSelected="1"' : '';

    return `${XML_HEADER}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheetViews><sheetView workbookViewId="0"${selected}><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews>
  ${cols}
  <sheetData>${rowXml}</sheetData>
  <autoFilter ref="A1:${lastColumn}${allRows.length}"/>
  ${drawing}
</worksheet>`;
  }

  function itemKey(item) {
    if (item.itemId) return `id:${item.itemId}`;
    if (item.itemUrl) return `url:${item.itemUrl}`;
    return `text:${[item.title, item.sellerName, item.price].join('|')}`;
  }

  function normalizeItem(item) {
    const list = value => Array.isArray(value) ? value : (value ? [value] : []);
    const goodRate = rateText(item.itemGoodRate || item.goodRate || item.reviewSummary || '');
    const intro = String(item.sellerIntro || '');
    return {
      itemId: String(item.itemId || ''),
      title: item.title || '',
      description: item.description || '',
      viewCount: interactionCount(item.viewCount),
      wantCount: interactionCount(item.wantCount),
      price: item.price || '',
      category: item.category || '',
      images: uniqueImageUrls(list(item.images)),
      itemUrl: item.itemUrl || '',
      sellerName: item.sellerName || '',
      sellerUrl: item.sellerUrl || '',
      sellerLocation: item.sellerLocation || '',
      sellerFollowers: item.sellerFollowers || '',
      sellerFollowing: item.sellerFollowing || '',
      sellerProductCount: item.sellerProductCount || '',
      sellerIntro: intro,
      storeDuration: item.storeDuration || '',
      reviewSummary: item.reviewSummary || '',
      itemGoodRate: goodRate,
      sellerReviewSummary: item.sellerReviewSummary || '',
      sellerReviewCount: item.sellerReviewCount || '',
      reviewSamples: list(item.reviewSamples).join('\n'),
      publishedAt: item.publishedAt || '',
      sourcePage: item.sourcePage || '',
      dataSource: item.dataSource || '',
      collectedAt: item.collectedAt || ''
    };
  }

  function rateText(value) {
    const text = String(value ?? '').replace(/\s+/g, ' ').trim();
    const match = text.match(/(?:好评率|好评|positive\s*rate|praise\s*rate)?\s*[:：]?\s*(\d+(?:\.\d+)?)\s*%/i);
    if (!match) return '';
    const number = Number(match[1]);
    return Number.isFinite(number) && number >= 0 && number <= 100 ? `${match[1]}%` : '';
  }

  function imageDedupKey(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    try {
      const parsed = new URL(raw);
      for (const key of [...parsed.searchParams.keys()]) {
        if (/resize|width|height|quality|thumbnail|thumb|process|imageview|crop|format/i.test(key)) {
          parsed.searchParams.delete(key);
        }
      }
      parsed.pathname = parsed.pathname.replace(/([_-])\d{2,5}x\d{2,5}(?=\.[a-z\d]{2,6}$)/i, '');
      return parsed.href;
    } catch (_) {
      return raw.replace(/([_-])\d{2,5}x\d{2,5}(?=\.[a-z\d]{2,6}(?:[?#]|$))/i, '');
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

  function interactionCount(value) {
    const text = String(value ?? '').replace(/\s+/g, '');
    if (!text) return '';
    const compact = text.match(/(?:^|[^\d])([\d,]+(?:\.\d+)?)(万|w)(?:人|次|个|条)?/i);
    if (compact) {
      const number = Number(compact[1].replace(/,/g, ''));
      if (Number.isFinite(number) && number >= 0) return String(Math.round(number * 10000));
    }
    if (/\d[\d,]*\.\d+/.test(text)) return '';
    const integer = text.match(/(?:^|[^\d])(\d[\d,]*)(?:人|次|个|条|浏览|想要|收藏)?(?:$|[^\d])/);
    return integer ? integer[1].replace(/,/g, '') : '';
  }

  function toBytes(value) {
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return null;
  }

  function extensionForAsset(asset) {
    const extension = String(asset?.extension || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (extension === 'png' || extension === 'gif') return extension;
    return 'jpg';
  }

  function contentTypeForExtension(extension) {
    if (extension === 'png') return 'image/png';
    if (extension === 'gif') return 'image/gif';
    return 'image/jpeg';
  }

  function assignMediaAssets(imageAssets) {
    const mediaByUrl = new Map();
    const mediaFiles = [];
    let mediaIndex = 1;

    const assets = (Array.isArray(imageAssets) ? imageAssets : []).map(raw => {
      const bytes = toBytes(raw?.bytes);
      if (!bytes || !bytes.length) return { ...raw, bytes: null };

      const dedupeKey = raw.url || `${raw.itemKey || ''}|${raw.imageIndex || mediaIndex}`;
      let media = mediaByUrl.get(dedupeKey);
      if (!media) {
        const extension = extensionForAsset(raw);
        const mediaName = `image_${String(mediaIndex++).padStart(4, '0')}.${extension}`;
        media = { mediaName, extension, bytes };
        mediaByUrl.set(dedupeKey, media);
        mediaFiles.push({
          name: `xl/media/${mediaName}`,
          data: bytes,
          extension,
          mime: contentTypeForExtension(extension)
        });
      }

      return { ...raw, bytes, mediaName: media.mediaName, extension: media.extension };
    });

    return { assets, mediaFiles };
  }

  function cleanFilePart(value, fallback = '未命名') {
    const cleaned = String(value || fallback)
      .replace(/[\\/:*?"<>|]+/g, '_')
      .replace(/\s+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^[_\.\-]+|[_\.\-]+$/g, '')
      .slice(0, 100);
    return cleaned || fallback;
  }

  function suggestedProductFileName(item) {
    const title = cleanFilePart(item.title || String(item.description || '').split('\n')[0], item.itemId || '商品');
    const seller = cleanFilePart(item.sellerName, '未知店铺');
    const id = cleanFilePart(String(item.itemId || '无ID').slice(-16), '无ID');
    return `${title}_${seller}_${id}_图01.jpg`;
  }

  function storeKey(profile) {
    return profile?.sellerUrl || profile?.sellerName || '未知店铺';
  }

  function reviewKey(profile, review, index) {
    return `${storeKey(profile)}|review:${review?.reviewIndex || index + 1}`;
  }

  function normalizeStoreProfile(profile) {
    const reviews = Array.isArray(profile?.reviews) ? profile.reviews : [];
    const intro = String(profile?.sellerIntro || '');
    return {
      sellerName: profile?.sellerName || '',
      sellerUrl: profile?.sellerUrl || '',
      sellerLocation: profile?.sellerLocation || '',
      sellerFollowers: profile?.sellerFollowers || '',
      sellerFollowing: profile?.sellerFollowing || '',
      sellerProductCount: profile?.sellerProductCount || '',
      sellerIntro: intro,
      sellerReviewCount: profile?.sellerReviewCount || '',
      sourcePage: profile?.sourcePage || profile?.sellerUrl || '',
      collectedAt: profile?.collectedAt || '',
      reviews: reviews.map((review, index) => ({
        reviewIndex: review?.reviewIndex || index + 1,
        reviewer: review?.reviewer || '',
        role: review?.role || '',
        feedback: review?.feedback || '',
        timeIp: review?.timeIp || '',
        images: uniqueImageUrls(Array.isArray(review?.images) ? review.images : []),
        collectedAt: review?.collectedAt || profile?.collectedAt || ''
      }))
    };
  }

  function imageExtent(asset, placement = {}) {
    const width = Math.max(1, Number(asset?.width) || 800);
    const height = Math.max(1, Number(asset?.height) || 600);
    const maxWidth = Math.max(24, Number(placement.maxWidth) || 170);
    const maxHeight = Math.max(24, Number(placement.maxHeight) || 115);
    const scale = Math.min(1, maxWidth / width, maxHeight / height);
    const pixelWidth = Math.max(24, Math.round(width * scale));
    const pixelHeight = Math.max(24, Math.round(height * scale));
    return {
      cx: pixelWidth * 9525,
      cy: pixelHeight * 9525
    };
  }

  function buildDrawingPackage(placements) {
    const targetToRelationship = new Map();
    const relationships = [];

    const prepared = placements.map((placement, index) => {
      const target = `../media/${placement.asset.mediaName}`;
      let relId = targetToRelationship.get(target);
      if (!relId) {
        relId = `rId${targetToRelationship.size + 1}`;
        targetToRelationship.set(target, relId);
        relationships.push(`<Relationship Id="${relId}" Type="${IMAGE_REL_TYPE}" Target="${xmlEscape(target)}"/>`);
      }
      return { ...placement, relId, id: index + 1 };
    });

    const anchors = prepared.map(placement => {
      const extent = imageExtent(placement.asset, placement);
      const name = placement.asset.fileName || placement.asset.mediaName;
      const colOffset = Math.max(0, Math.round(Number(placement.colOffsetPx) || 0) * 9525);
      const rowOffset = Math.max(0, Math.round(Number(placement.rowOffsetPx) || 0) * 9525);
      return `<xdr:oneCellAnchor>
  <xdr:from><xdr:col>${placement.col}</xdr:col><xdr:colOff>${colOffset}</xdr:colOff><xdr:row>${placement.row}</xdr:row><xdr:rowOff>${rowOffset}</xdr:rowOff></xdr:from>
  <xdr:ext cx="${extent.cx}" cy="${extent.cy}"/>
  <xdr:pic>
    <pic:nvPicPr><pic:cNvPr id="${placement.id}" name="${xmlEscape(name)}"/><pic:cNvPicPr/></pic:nvPicPr>
    <pic:blipFill><a:blip r:embed="${placement.relId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>
    <pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${extent.cx}" cy="${extent.cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>
  </xdr:pic>
  <xdr:clientData/>
</xdr:oneCellAnchor>`;
    }).join('');

    return {
      xml: `${XML_HEADER}<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${anchors}</xdr:wsDr>`,
      rels: `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationships.join('')}</Relationships>`
    };
  }

  function sheetDrawingRelsXml(drawingFileName) {
    return `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${DRAWING_REL_TYPE}" Target="../drawings/${xmlEscape(drawingFileName)}"/></Relationships>`;
  }

  function defaultFieldDefinitions() {
    return {
      product: [
        ['itemId', '商品ID'], ['itemUrl', '商品链接'], ['mainImageName', '主图文件名'], ['images', '商品图片'],
        ['title', '商品标题'], ['description', '商品文案'], ['viewCount', '浏览数'], ['wantCount', '想要数'], ['price', '价格'], ['category', '类目'],
        ['sellerName', '店铺名称'], ['sellerUrl', '卖家账号页'], ['sellerLocation', '卖家地区'], ['sellerFollowers', '粉丝数'],
        ['sellerFollowing', '关注数'], ['sellerProductCount', '卖家商品数'], ['sellerIntro', '店铺简介'], ['storeDuration', '开店时长'],
        ['itemGoodRate', '商品好评率'], ['sellerReviewCount', '店铺评价数'], ['imageStatus', '图片状态'],
        ['reviewSummary', '商品评价摘要'], ['sellerReviewSummary', '店铺评价摘要'], ['reviewSamples', '评价示例'],
        ['publishedAt', '发布时间'], ['sourcePage', '来源页面'], ['dataSource', '数据来源'], ['collectedAt', '采集时间']
      ],
      storeProfile: [
        ['sellerName', '店铺名称'], ['sellerUrl', '卖家账号页'], ['sellerLocation', '卖家地区'], ['sellerFollowers', '粉丝数'],
        ['sellerFollowing', '关注数'], ['sellerProductCount', '卖家商品数'], ['sellerIntro', '店铺简介'], ['sellerReviewCount', '店铺评价数'],
        ['collectedAt', '采集时间'], ['sourcePage', '来源页面'], ['reviewCountLoaded', '已采集评价数']
      ],
      storeReview: [
        ['sellerName', '店铺名称'], ['sellerUrl', '卖家账号页'], ['reviewIndex', '评价序号'], ['reviewer', '评价人'], ['role', '身份'],
        ['feedback', '评价内容'], ['timeIp', '评价时间/地区'], ['reviewImageCount', '评价图片数'], ['reviewImageNames', '评价图片文件名'],
        ['reviewImageStatus', '评价图片状态'], ['reviewImages', '评价图片'], ['reviewImageFailureUrl', '评价图片失败地址'],
        ['reviewCollectedAt', '评价采集时间']
      ]
    };
  }

  function selectedFieldIds(type, options) {
    const fallback = defaultFieldDefinitions()[type] || [];
    const defaultIds = {
      product: ['itemId', 'itemUrl', 'mainImageName', 'images', 'description', 'viewCount', 'wantCount', 'price', 'category', 'sellerName', 'sellerUrl', 'sellerLocation', 'sellerFollowers', 'sellerFollowing', 'sellerProductCount', 'sellerIntro', 'storeDuration', 'itemGoodRate', 'sellerReviewCount', 'collectedAt'],
      storeProfile: ['sellerName', 'sellerUrl', 'sellerLocation', 'sellerFollowers', 'sellerFollowing', 'sellerProductCount', 'sellerIntro', 'sellerReviewCount', 'collectedAt'],
      storeReview: fallback.map(([id]) => id)
    }[type] || fallback.map(([id]) => id);
    const requested = options?.fieldConfig?.[type];
    const valid = new Set(fallback.map(([id]) => id));
    const ids = Array.isArray(requested) ? requested.filter(id => valid.has(id)) : [];
    return ids.length ? [...new Set(ids)] : defaultIds.filter(id => valid.has(id));
  }

  function fieldLabel(type, id) {
    const definitions = defaultFieldDefinitions()[type] || [];
    return definitions.find(([fieldId]) => fieldId === id)?.[1] || id;
  }

  function imageAssetsByItem(productAssets, item) {
    const seen = new Set();
    const deduped = productAssets
      .filter(asset => (asset.itemKey || itemKey(asset)) === itemKey(item))
      .sort((first, second) => Number(first.imageIndex || 0) - Number(second.imageIndex || 0));
    return deduped.filter(asset => {
      const key = imageDedupKey(asset.url) || `${itemKey(item)}|${asset.imageIndex || ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).map((asset, index) => ({ ...asset, imageIndex: index + 1 }));
  }

  function imageStatusText(item, assets) {
    if (!item.images.length) return '';
    const expected = item.images.length;
    const embedded = assets.filter(asset => Boolean(asset.bytes?.length)).length;
    const failed = assets.filter(asset => !asset.bytes?.length).length + Math.max(0, expected - assets.length);
    if (embedded >= expected) return '成功';
    if (embedded > 0) return `部分成功：${embedded}/${expected}`;
    return `下载失败：${assets.find(asset => asset.error)?.error || '未获取到图片二进制'}`;
  }

  function productFieldValue(item, fieldId, assets) {
    const firstSuccess = assets.find(asset => Boolean(asset.bytes?.length));
    const firstAsset = assets[0];
    const reviewCount = item.sellerReviewCount || (item.sellerReviewSummary.match(/\d+/)?.[0] || '');
    if (fieldId === 'mainImageName') return firstSuccess?.fileName || firstAsset?.fileName || (item.images.length ? suggestedProductFileName(item) : '');
    if (fieldId === 'imageStatus') return imageStatusText(item, assets);
    if (fieldId === 'reviewCount') return reviewCount;
    if (fieldId === 'reviewSamples') return item.reviewSamples;
    return item[fieldId] ?? '';
  }

  function storeProfileFieldValue(profile, fieldId) {
    if (fieldId === 'reviewCountLoaded') return profile.reviews.length;
    return profile[fieldId] ?? '';
  }

  function reviewImageStatusText(review, assets) {
    if (!review.images.length) return '';
    const embedded = assets.filter(asset => Boolean(asset.bytes?.length)).length;
    if (embedded >= review.images.length) return '成功';
    if (embedded > 0) return `部分成功：${embedded}/${review.images.length}`;
    return `下载失败：${assets.find(asset => asset.error)?.error || '未获取到图片二进制'}`;
  }

  function workbookFiles(items, imageAssets, storeProfiles, options = {}) {
    const storeOnly = options.kind === 'store';
    const safeItems = Array.isArray(items) ? items : [];
    const safeProfiles = (Array.isArray(storeProfiles) ? storeProfiles : []).map(normalizeStoreProfile);
    const media = assignMediaAssets(imageAssets);
    const productAssets = media.assets.filter(asset => asset.kind !== 'review');
    const reviewAssets = media.assets.filter(asset => asset.kind === 'review');
    const productFieldIds = selectedFieldIds('product', options);
    const storeProfileFieldIds = selectedFieldIds('storeProfile', options);
    const storeReviewFieldIds = selectedFieldIds('storeReview', options);
    const productImageEnabled = productFieldIds.includes('images');
    const reviewImageEnabled = storeReviewFieldIds.includes('reviewImages');

    const productAssetMap = new Map();
    let productImageSlots = productImageEnabled ? 1 : 0;
    for (const raw of safeItems) {
      const item = normalizeItem(raw);
      const assets = imageAssetsByItem(productAssets, item);
      productAssetMap.set(itemKey(item), assets);
      productImageSlots = Math.max(productImageSlots, item.images.length, ...assets.map(asset => Number(asset.imageIndex) || 0));
    }
    productImageSlots = Math.min(30, productImageSlots);

    const productHeaders = [];
    for (const fieldId of productFieldIds) {
      productHeaders.push(fieldId === 'images' ? '商品图片' : fieldLabel('product', fieldId));
    }
    // 主图跟随用户选择的“商品图片”字段；其余图片统一追加到表格末尾。
    // 这样不同商品图片数量不同时，不会把后面的商品字段视觉上挤成多组。
    if (productImageEnabled) {
      for (let index = 2; index <= productImageSlots; index += 1) {
        productHeaders.push(`商品图片${index}`);
      }
    }
    const mainRows = [];
    const mainPlacements = [];
    const mainRowHeights = {};
    safeItems.forEach((raw, itemIndex) => {
      const item = normalizeItem(raw);
      const assets = productAssetMap.get(itemKey(item)) || [];
      const row = [];
      let column = 0;
      for (const fieldId of productFieldIds) {
        if (fieldId === 'images') {
          const asset = assets.find(candidate => Number(candidate.imageIndex) === 1);
          row.push('');
          if (asset?.bytes?.length) {
            mainPlacements.push({ asset, row: itemIndex + 1, col: column });
            mainRowHeights[itemIndex + 2] = Math.max(mainRowHeights[itemIndex + 2] || 0, 96);
          }
          column += 1;
        } else {
          row.push(productFieldValue(item, fieldId, assets));
          column += 1;
        }
      }
      if (productImageEnabled) {
        for (let imageIndex = 2; imageIndex <= productImageSlots; imageIndex += 1) {
          const asset = assets.find(candidate => Number(candidate.imageIndex) === imageIndex);
          row.push('');
          if (asset?.bytes?.length) {
            mainPlacements.push({ asset, row: itemIndex + 1, col: column });
            mainRowHeights[itemIndex + 2] = Math.max(mainRowHeights[itemIndex + 2] || 0, 96);
          }
          column += 1;
        }
      }
      mainRows.push(row);
    });

    const reviewAssetMap = new Map();
    for (const asset of reviewAssets) {
      const key = asset.reviewKey || `${asset.sellerUrl || asset.storeName || ''}|review:${asset.reviewIndex || ''}`;
      if (!reviewAssetMap.has(key)) reviewAssetMap.set(key, []);
      reviewAssetMap.get(key).push(asset);
    }

    let reviewImageSlots = reviewImageEnabled ? 1 : 0;
    for (const profile of safeProfiles) {
      for (const review of profile.reviews) {
        const assets = reviewAssetMap.get(reviewKey(profile, review, review.reviewIndex - 1)) || [];
        reviewImageSlots = Math.max(reviewImageSlots, review.images.length, ...assets.map(asset => Number(asset.imageIndex) || 0));
      }
    }
    reviewImageSlots = Math.min(30, reviewImageSlots);

    const storeProfileHeaders = storeProfileFieldIds.map(fieldId => fieldLabel('storeProfile', fieldId));
    const storeProfileRows = safeProfiles.map(profile => storeProfileFieldIds.map(fieldId => storeProfileFieldValue(profile, fieldId)));
    const storeReviewHeaders = [];
    for (const fieldId of storeReviewFieldIds) {
      if (fieldId === 'reviewImages') {
        for (let index = 1; index <= reviewImageSlots; index += 1) {
          storeReviewHeaders.push(index === 1 ? '评价图片' : `评价图片${index}`);
        }
      } else {
        storeReviewHeaders.push(fieldLabel('storeReview', fieldId));
      }
    }
    const storeReviewRows = [];
    const storePlacements = [];
    const storeRowHeights = {};

    function appendStoreReviewRow(profile, review, reviewIndex = 0) {
      const assets = reviewAssetMap.get(reviewKey(profile, review, reviewIndex)) || [];
      const imageNames = assets.map(asset => asset.fileName || '').filter(Boolean);
      const imageStatuses = assets.map(asset => asset.bytes?.length ? '成功' : `下载失败：${asset.error || '未知错误'}`);
      const failedUrls = assets.filter(asset => !asset.bytes?.length).map(asset => asset.url || '').filter(Boolean);
      const rowIndex = storeReviewRows.length;
      const row = [];
      let column = 0;
      for (const fieldId of storeReviewFieldIds) {
        if (fieldId === 'reviewImages') {
          for (let imageIndex = 1; imageIndex <= reviewImageSlots; imageIndex += 1) {
            const asset = assets.find(candidate => Number(candidate.imageIndex) === imageIndex);
            row.push('');
            if (asset?.bytes?.length) {
              storePlacements.push({
                asset,
                row: rowIndex + 1,
                col: column,
                colOffsetPx: ((imageIndex - 1) % 3) * 115,
                rowOffsetPx: Math.floor((imageIndex - 1) / 3) * 86,
                maxWidth: 105,
                maxHeight: 75
              });
              storeRowHeights[rowIndex + 2] = Math.max(storeRowHeights[rowIndex + 2] || 0, Math.ceil(reviewImageSlots / 3) * 86 + 10);
            }
            column += 1;
          }
        } else {
          const value = fieldId === 'sellerName' ? profile.sellerName
            : fieldId === 'sellerUrl' ? profile.sellerUrl
              : fieldId === 'reviewIndex' ? (review.reviewIndex || reviewIndex + 1)
                : fieldId === 'reviewImageCount' ? review.images.length
                  : fieldId === 'reviewImageNames' ? imageNames.join('\n')
                    : fieldId === 'reviewImageStatus' ? reviewImageStatusText(review, assets)
                      : fieldId === 'reviewImageFailureUrl' ? failedUrls.join('\n')
                        : fieldId === 'reviewCollectedAt' ? review.collectedAt || profile.collectedAt
                          : review[fieldId] ?? '';
          row.push(value);
          column += 1;
        }
      }
      storeReviewRows.push(row);
    }
    for (const profile of safeProfiles) profile.reviews.forEach((review, index) => appendStoreReviewRow(profile, review, index));

    const notes = [
      ['项目', '说明'],
      ['商品主表', '商品图片已经与商品字段放在同一张商品数据表中；主图保留在“商品图片”列，真实多图的“商品图片2、商品图片3…”统一追加到表格最后；同一逻辑图片不会重复嵌入，不再生成图片索引表。'],
      ['字段配置', `本次商品表字段：${productHeaders.join('、')}；店铺资料字段：${storeProfileHeaders.join('、')}；店铺评价字段：${storeReviewHeaders.join('、')}。字段选择和顺序在插件“设置”中统一保存。`],
      ['图片处理', '导出时会下载图片并将真实图片二进制嵌入 Excel；商品图片和评价图片分别按设置处理，失败会在图片状态字段中说明原因，不会用 URL 冒充图片本身。'],
      ['店铺表', '店铺资料和店铺评价仍是两张表：店铺资料一店一行，店铺评价综合一条评价一行，评价图片与评价文本保持同一行。店铺页无法可靠提供开店时长和商品好评率，因此不生成这两个字段。'],
      ['类目说明', '服务类商品优先使用详情属性区的“服务类型”（例如“金融”）作为类目；如果页面没有服务类型，再使用可见面包屑；只有 URL 内部 categoryId 而没有公开名称时留空，不编造类目名称。'],
      ['图片文件名', '商品图片格式为“商品标题_店铺名_商品ID_图序号.扩展名”；评价图片格式为“店铺名_评价序号_图序号.扩展名”。'],
      ['隐私边界', '插件只处理闲鱼页面公开可见或已经加载的数据，不读取聊天、Cookie，不生成签名，也不上传到外部服务器。']
    ];

    const drawingEntries = [];
    function addDrawing(sheetNumber, placements) {
      if (!placements.length) return null;
      const drawing = buildDrawingPackage(placements);
      const number = drawingEntries.length + 1;
      const entry = { sheetNumber, drawing, fileName: `drawing${number}.xml` };
      drawingEntries.push(entry);
      return entry;
    }
    const mainDrawing = storeOnly ? null : addDrawing(1, mainPlacements);
    const storeDrawing = storeOnly ? addDrawing(2, storePlacements) : null;
    const imageDefaults = [...new Set(media.mediaFiles.map(file => file.extension))]
      .map(extension => `<Default Extension="${extension}" ContentType="${contentTypeForExtension(extension)}"/>`)
      .join('');
    const drawingOverrides = drawingEntries
      .map(entry => `<Override PartName="/xl/drawings/${entry.fileName}" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>`)
      .join('');

    const productWidths = productHeaders.map(header => /图片/.test(header) ? 24 : /文案|简介|评价内容/.test(header) ? 64 : /链接|账号页|来源/.test(header) ? 44 : /ID/.test(header) ? 18 : 16);
    const profileWidths = storeProfileHeaders.map(header => /简介/.test(header) ? 48 : /链接|来源/.test(header) ? 44 : /名称/.test(header) ? 22 : 16);
    const reviewWidths = storeReviewHeaders.map(header => /图片/.test(header) ? 26 : /内容/.test(header) ? 80 : /链接/.test(header) ? 44 : 18);
    const sheetNumbers = storeOnly ? [1, 2] : [1, 2];
    const workbookSheets = storeOnly
      ? '<sheet name="店铺资料" sheetId="1" r:id="rId1"/><sheet name="店铺评价综合" sheetId="2" r:id="rId2"/>'
      : '<sheet name="商品数据" sheetId="1" r:id="rId1"/><sheet name="说明" sheetId="2" r:id="rId2"/>';
    const worksheetFiles = storeOnly
      ? [
        {
          name: 'xl/worksheets/sheet1.xml',
          data: sheetXml(storeProfileHeaders, storeProfileRows, profileWidths, { selected: true, textColumns: [0] })
        },
        {
          name: 'xl/worksheets/sheet2.xml',
          data: sheetXml(storeReviewHeaders, storeReviewRows, reviewWidths, { rowHeights: storeRowHeights, drawingRelId: storeDrawing ? 'rId1' : '' })
        }
      ]
      : [
        {
          name: 'xl/worksheets/sheet1.xml',
          data: sheetXml(productHeaders, mainRows, productWidths, {
            rowHeights: mainRowHeights,
            drawingRelId: mainDrawing ? 'rId1' : '',
            selected: true,
            textColumns: [0]
          })
        },
        {
          name: 'xl/worksheets/sheet2.xml',
          data: sheetXml(notes[0], notes.slice(1), [18, 120])
        }
      ];

    const files = [
      {
        name: '[Content_Types].xml',
        data: `${XML_HEADER}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  ${imageDefaults}
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  ${sheetNumbers.map(number => `<Override PartName="/xl/worksheets/sheet${number}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('\n  ')}
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
  ${drawingOverrides}
</Types>`
      },
      {
        name: '_rels/.rels',
        data: `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`
      },
      {
        name: 'docProps/core.xml',
        data: `${XML_HEADER}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:creator>闲鱼公开商品研究采集器</dc:creator><dc:title>闲鱼商品研究</dc:title><dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString()}</dcterms:created></cp:coreProperties>`
      },
      {
        name: 'docProps/app.xml',
        data: `${XML_HEADER}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>闲鱼公开商品研究采集器</Application></Properties>`
      },
      {
        name: 'xl/workbook.xml',
        data: `${XML_HEADER}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView activeTab="0"/></bookViews><sheets>${workbookSheets}</sheets></workbook>`
      },
      {
        name: 'xl/_rels/workbook.xml.rels',
        data: `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheetNumbers.map(number => `<Relationship Id="rId${number}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${number}.xml"/>`).join('')}<Relationship Id="rId${sheetNumbers.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`
      },
      {
        name: 'xl/styles.xml',
        data: `${XML_HEADER}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="10"/><color theme="1"/><name val="Calibri"/></font><font><b/><sz val="10"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE54841"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf><xf numFmtId="0" fontId="1" fillId="2" borderId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf><xf numFmtId="49" fontId="0" fillId="0" borderId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`
      },
      ...worksheetFiles
    ];

    for (const entry of drawingEntries) {
      files.push(
        { name: `xl/worksheets/_rels/sheet${entry.sheetNumber}.xml.rels`, data: sheetDrawingRelsXml(entry.fileName) },
        { name: `xl/drawings/${entry.fileName}`, data: entry.drawing.xml },
        { name: `xl/drawings/_rels/${entry.fileName}.rels`, data: entry.drawing.rels }
      );
    }

    files.push(...media.mediaFiles);
    return files;
  }

  function createWorkbook(items, imageAssets = [], storeProfiles = [], options = {}) {
    const safeItems = Array.isArray(items) ? items.slice(0, 2000) : [];
    const bytes = zipStore(workbookFiles(safeItems, imageAssets, storeProfiles, options));
    return new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }

  window.XianyuXlsx = { createWorkbook };
})();
