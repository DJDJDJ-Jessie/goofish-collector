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
    const rowXml = allRows.map((row, rowIndex) => {
      const style = rowIndex === 0 ? 1 : 0;
      const height = rowHeights[rowIndex + 1];
      const heightAttribute = height ? ` ht="${height}" customHeight="1"` : '';
      const cells = row.map((value, columnIndex) => cell(`${columnName(columnIndex)}${rowIndex + 1}`, value, style)).join('');
      return `<row r="${rowIndex + 1}"${heightAttribute}>${cells}</row>`;
    }).join('');

    const cols = widths.length
      ? `<cols>${widths.map((width, index) => `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`).join('')}</cols>`
      : '';
    const lastColumn = columnName(headers.length - 1);
    const drawing = options.drawingRelId ? `<drawing r:id="${xmlEscape(options.drawingRelId)}"/>` : '';

    return `${XML_HEADER}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews>
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
      itemId: item.itemId || '',
      title: item.title || '',
      description: item.description || '',
      price: item.price || '',
      category: item.category || '',
      images: list(item.images),
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
    const title = cleanFilePart(item.title, item.itemId || '商品');
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
      storeDuration: profile?.storeDuration || '',
      sellerGoodRate: rateText(profile?.sellerGoodRate || ''),
      sellerReviewCount: profile?.sellerReviewCount || '',
      sourcePage: profile?.sourcePage || profile?.sellerUrl || '',
      collectedAt: profile?.collectedAt || '',
      reviews: reviews.map((review, index) => ({
        reviewIndex: review?.reviewIndex || index + 1,
        reviewer: review?.reviewer || '',
        role: review?.role || '',
        feedback: review?.feedback || '',
        timeIp: review?.timeIp || '',
        images: Array.isArray(review?.images) ? review.images.filter(Boolean) : [],
        collectedAt: review?.collectedAt || profile?.collectedAt || ''
      }))
    };
  }

  function imageExtent(asset) {
    const width = Math.max(1, Number(asset?.width) || 800);
    const height = Math.max(1, Number(asset?.height) || 600);
    const scale = Math.min(1, 170 / width, 115 / height);
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
      const extent = imageExtent(placement.asset);
      const name = placement.asset.fileName || placement.asset.mediaName;
      return `<xdr:oneCellAnchor>
  <xdr:from><xdr:col>${placement.col}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${placement.row}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>
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

  function workbookFiles(items, imageAssets, storeProfiles) {
    const safeItems = Array.isArray(items) ? items : [];
    const safeProfiles = (Array.isArray(storeProfiles) ? storeProfiles : []).map(normalizeStoreProfile);
    const media = assignMediaAssets(imageAssets);
    const productAssets = media.assets.filter(asset => asset.kind !== 'review');
    const reviewAssets = media.assets.filter(asset => asset.kind === 'review');
    const byItem = new Map();
    for (const asset of productAssets) {
      const key = asset.itemKey || itemKey(asset);
      const previous = byItem.get(key);
      // 主表应优先展示该商品第一张成功下载的图片；如果全部失败，
      // 才保留第一条失败记录，让图片索引表继续显示失败原因。
      if (!previous || (!previous.bytes?.length && asset.bytes?.length)) byItem.set(key, asset);
    }

    const mainHeaders = [
      '商品ID', '商品链接', '主图文件名', '商品图片（已嵌入）', '商品文案', '价格', '类目', '店铺名称',
      '卖家账号页', '卖家地区', '粉丝数', '关注数', '卖家商品数', '店铺简介', '开店时长', '商品好评率',
      '店铺评价数', '采集时间'
    ];
    const mainRows = [];
    const mainPlacements = [];
    const mainRowHeights = {};

    safeItems.forEach((raw, itemIndex) => {
      const item = normalizeItem(raw);
      const asset = byItem.get(itemKey(item));
      const hasImage = Boolean(asset?.bytes?.length);
      const statusFileName = asset?.fileName || (item.images.length ? suggestedProductFileName(item) : '');
      const reviewCount = item.sellerReviewCount || (item.sellerReviewSummary.match(/\d+/)?.[0] || '');
      mainRows.push([
        item.itemId, item.itemUrl, statusFileName,
        hasImage ? '已嵌入' : '未嵌入', item.description, item.price, item.category, item.sellerName,
        item.sellerUrl, item.sellerLocation, item.sellerFollowers, item.sellerFollowing, item.sellerProductCount,
        item.sellerIntro, item.storeDuration, item.itemGoodRate, reviewCount, item.collectedAt
      ]);

      if (hasImage) {
        const row = itemIndex + 1;
        mainPlacements.push({ asset, row, col: 3 });
        mainRowHeights[itemIndex + 2] = 96;
      }
    });

    const imageHeaders = [
      '商品ID', '商品标题（内部识别）', '图片序号', '图片（已嵌入）', '图片文件名', '图片下载状态',
      '商品链接', '采集时间', '失败时原始地址'
    ];
    const imageRows = [];
    const imagePlacements = [];
    const imageRowHeights = {};

    productAssets.forEach((asset, index) => {
      const embedded = Boolean(asset.bytes?.length);
      const row = index + 1;
      imageRows.push([
        asset.itemId || '', asset.title || '', asset.imageIndex || index + 1,
        embedded ? '已嵌入' : '未嵌入', asset.fileName || '',
        embedded ? '已嵌入 Excel' : `下载失败：${asset.error || '未知错误'}`,
        asset.itemUrl || '', asset.collectedAt || '', embedded ? '' : (asset.url || '')
      ]);
      if (embedded) {
        imagePlacements.push({ asset, row, col: 3 });
        imageRowHeights[index + 2] = 96;
      }
    });

    const reviewAssetMap = new Map();
    for (const asset of reviewAssets) {
      const key = asset.reviewKey || `${asset.sellerUrl || asset.storeName || ''}|review:${asset.reviewIndex || ''}`;
      if (!reviewAssetMap.has(key)) reviewAssetMap.set(key, []);
      reviewAssetMap.get(key).push(asset);
    }

    const storeHeaders = [
      '店铺名称', '卖家账号页', '卖家地区', '粉丝数', '关注数', '卖家商品数', '店铺简介', '开店时长',
      '商品好评率', '店铺评价数', '采集时间', '来源页面', '已采集评价数'
    ];
    const storeRows = safeProfiles.map(profile => [
      profile.sellerName, profile.sellerUrl, profile.sellerLocation, profile.sellerFollowers,
      profile.sellerFollowing, profile.sellerProductCount, profile.sellerIntro, profile.storeDuration,
      profile.sellerGoodRate, profile.sellerReviewCount, profile.collectedAt, profile.sourcePage,
      profile.reviews.length
    ]);

    const reviewHeaders = [
      '店铺名称', '卖家账号页', '评价序号', '评价人', '身份', '评价内容', '评价时间/地区',
      '评价图片数', '评价图片文件名', '采集时间'
    ];
    const reviewRows = [];
    for (const profile of safeProfiles) {
      profile.reviews.forEach((review, index) => {
        const assets = reviewAssetMap.get(reviewKey(profile, review, index)) || [];
        reviewRows.push([
          profile.sellerName, profile.sellerUrl, review.reviewIndex || index + 1, review.reviewer,
          review.role, review.feedback, review.timeIp, review.images.length,
          assets.map(asset => asset.fileName || '').filter(Boolean).join('\n'), review.collectedAt
        ]);
      });
    }

    const reviewImageHeaders = [
      '店铺名称', '卖家账号页', '评价序号', '图片序号', '评价图片（已嵌入）', '图片文件名',
      '图片下载状态', '失败时原始地址', '采集时间'
    ];
    const reviewImageRows = [];
    const reviewImagePlacements = [];
    const reviewImageRowHeights = {};
    reviewAssets.forEach((asset, index) => {
      const embedded = Boolean(asset.bytes?.length);
      const row = index + 1;
      reviewImageRows.push([
        asset.storeName || '', asset.sellerUrl || '', asset.reviewIndex || '', asset.imageIndex || index + 1,
        embedded ? '已嵌入' : '未嵌入', asset.fileName || '',
        embedded ? '已嵌入 Excel' : `下载失败：${asset.error || '未知错误'}`,
        embedded ? '' : (asset.url || ''), asset.collectedAt || ''
      ]);
      if (embedded) {
        reviewImagePlacements.push({ asset, row, col: 4 });
        reviewImageRowHeights[index + 2] = 96;
      }
    });

    const notes = [
      ['项目', '说明'],
      ['商品主表', '商品主表按需求固定为 18 列：商品 ID、链接、主图文件名、真实嵌入图片、商品文案、价格、类目、店铺资料、商品好评率、店铺评价数和采集时间。'],
      ['图片处理', '导出时会下载图片并将真实图片二进制嵌入 Excel；商品图片上限只限制商品图，已读取的评价图片会单独处理；图片索引表和评价图片表也会嵌入真实图片，不把 URL 当作图片本身。'],
      ['店铺资料', '“店铺资料”表保存当前店铺页可见的名称、账号页、地区、粉丝、关注、商品数、简介、开店时长、好评率和评价数。'],
      ['店铺评价', '“店铺评价”表一行对应一条已加载的公开评价；“评价图片”表逐张保存评价图片，并显示下载状态。'],
      ['类目说明', '服务类商品优先使用详情属性区的“服务类型”（例如“金融”）作为类目；如果页面没有服务类型，再使用面包屑或 URL 中可核对的 categoryId，不编造类目名称。'],
      ['图片文件名', '商品图片格式为“商品标题_店铺名_商品ID_图序号.扩展名”；评价图片格式为“店铺名_评价序号_图序号.扩展名”。'],
      ['下载失败', '如果图片 CDN 拒绝扩展程序访问，会在对应状态列标出错误；成功下载的图片不会退回成只保留链接。'],
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
    const mainDrawing = addDrawing(1, mainPlacements);
    const imageDrawing = addDrawing(2, imagePlacements);
    const reviewImageDrawing = addDrawing(5, reviewImagePlacements);
    const imageDefaults = [...new Set(media.mediaFiles.map(file => file.extension))]
      .map(extension => `<Default Extension="${extension}" ContentType="${contentTypeForExtension(extension)}"/>`)
      .join('');
    const drawingOverrides = drawingEntries
      .map(entry => `<Override PartName="/xl/drawings/${entry.fileName}" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>`)
      .join('');

    const files = [
      {
        name: '[Content_Types].xml',
        data: `${XML_HEADER}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  ${imageDefaults}
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  ${[1, 2, 3, 4, 5, 6].map(number => `<Override PartName="/xl/worksheets/sheet${number}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('\n  ')}
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
        data: `${XML_HEADER}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="商品数据" sheetId="1" r:id="rId1"/><sheet name="图片索引" sheetId="2" r:id="rId2"/><sheet name="店铺资料" sheetId="3" r:id="rId3"/><sheet name="店铺评价" sheetId="4" r:id="rId4"/><sheet name="评价图片" sheetId="5" r:id="rId5"/><sheet name="说明" sheetId="6" r:id="rId6"/></sheets></workbook>`
      },
      {
        name: 'xl/_rels/workbook.xml.rels',
        data: `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${[1, 2, 3, 4, 5, 6].map(number => `<Relationship Id="rId${number}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${number}.xml"/>`).join('')}<Relationship Id="rId7" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`
      },
      {
        name: 'xl/styles.xml',
        data: `${XML_HEADER}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="10"/><color theme="1"/><name val="Calibri"/></font><font><b/><sz val="10"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE54841"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf><xf numFmtId="0" fontId="1" fillId="2" borderId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`
      },
      {
        name: 'xl/worksheets/sheet1.xml',
        data: sheetXml(mainHeaders, mainRows, [18, 44, 48, 20, 64, 12, 22, 22, 44, 14, 12, 12, 14, 42, 14, 18, 14, 22], {
          rowHeights: mainRowHeights,
          drawingRelId: mainDrawing ? 'rId1' : ''
        })
      },
      {
        name: 'xl/worksheets/sheet2.xml',
        data: sheetXml(imageHeaders, imageRows, [18, 32, 10, 24, 54, 24, 44, 22, 60], {
          rowHeights: imageRowHeights,
          drawingRelId: imageDrawing ? 'rId1' : ''
        })
      },
      {
        name: 'xl/worksheets/sheet3.xml',
        data: sheetXml(storeHeaders, storeRows, [22, 44, 14, 12, 12, 14, 48, 14, 18, 14, 22, 44, 14])
      },
      {
        name: 'xl/worksheets/sheet4.xml',
        data: sheetXml(reviewHeaders, reviewRows, [22, 44, 10, 18, 12, 80, 32, 12, 56, 22])
      },
      {
        name: 'xl/worksheets/sheet5.xml',
        data: sheetXml(reviewImageHeaders, reviewImageRows, [22, 44, 10, 10, 24, 56, 24, 60, 22], {
          rowHeights: reviewImageRowHeights,
          drawingRelId: reviewImageDrawing ? 'rId1' : ''
        })
      },
      {
        name: 'xl/worksheets/sheet6.xml',
        data: sheetXml(notes[0], notes.slice(1), [18, 110])
      }
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

  function createWorkbook(items, imageAssets = [], storeProfiles = []) {
    const safeItems = Array.isArray(items) ? items.slice(0, 2000) : [];
    const bytes = zipStore(workbookFiles(safeItems, imageAssets, storeProfiles));
    return new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }

  window.XianyuXlsx = { createWorkbook };
})();
