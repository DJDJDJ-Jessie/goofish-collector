import fs from 'node:fs/promises';
import vm from 'node:vm';

const xlsxSource = await fs.readFile(new URL('../xlsx.js', import.meta.url), 'utf8');
const fieldSource = await fs.readFile(new URL('../field-config.js', import.meta.url), 'utf8');
const context = vm.createContext({ window: {}, globalThis: {}, Blob, Uint8Array, ArrayBuffer, TextEncoder, TextDecoder, URL, console });
vm.runInContext(fieldSource, context);
const fieldCatalog = context.globalThis.XianyuFieldConfig || context.XianyuFieldConfig;
context.window.XianyuFieldConfig = fieldCatalog;
vm.runInContext(xlsxSource, context);

if (fieldCatalog.fields.product.some(field => field.id === 'publishedAt')) {
  throw new Error('unsupported product field 发布时间 must not be offered in field settings');
}
for (const unsupported of ['reviewSummary', 'sellerReviewSummary', 'reviewSamples']) {
  if (fieldCatalog.fields.product.some(field => field.id === unsupported)) {
    throw new Error(`product review helper field ${unsupported} must stay out of product field settings`);
  }
}

const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
const png2 = Uint8Array.from([...png, 1]);
const item = {
  itemId: 'item-field-config-1',
  itemUrl: 'https://www.goofish.com/item?id=item-field-config-1',
  title: '测试商品',
  description: '完整文案',
  images: ['https://img.example/1.jpg', 'https://img.example/2.jpg'],
  sellerName: '测试店铺',
  collectedAt: '2026-08-12T12:00:00.000Z'
};
const assets = [1, 2].map(index => ({
  kind: 'product',
  itemKey: `id:${item.itemId}`,
  itemId: item.itemId,
  itemUrl: item.itemUrl,
  imageIndex: index,
  url: item.images[index - 1],
  fileName: `测试商品_测试店铺_item-field-config-1_图0${index}.jpg`,
  bytes: index === 1 ? png : png2,
  extension: 'jpg',
  width: 1,
  height: 1
}));

const blob = context.window.XianyuXlsx.createWorkbook([item], assets, [], {
  fieldConfig: {
    product: ['itemId', 'description', 'images', 'sellerName']
  }
});
const bytes = new Uint8Array(await blob.arrayBuffer());

function readStoredZip(input) {
  const entries = new Map();
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  let offset = 0;
  while (offset + 4 <= input.length && view.getUint32(offset, true) === 0x04034b50) {
    const size = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const nameStart = offset + 30;
    const name = new TextDecoder().decode(input.slice(nameStart, nameStart + nameLength));
    const dataStart = nameStart + nameLength + extraLength;
    entries.set(name, input.slice(dataStart, dataStart + size));
    offset = dataStart + size;
  }
  return entries;
}

const entries = readStoredZip(bytes);
const workbookXml = new TextDecoder().decode(entries.get('xl/workbook.xml'));
const sheetXml = new TextDecoder().decode(entries.get('xl/worksheets/sheet1.xml'));
if (!workbookXml.includes('name="商品数据"') || workbookXml.includes('图片索引')) {
  throw new Error('product workbook should embed images in the product sheet without an image index sheet');
}
for (const header of ['商品ID', '商品文案', '商品图片', '商品图片2', '店铺名称']) {
  if (!sheetXml.includes(header)) throw new Error(`configured product field is missing: ${header}`);
}
if (sheetXml.indexOf('商品文案') > sheetXml.indexOf('商品图片')) {
  throw new Error('configured product field order was not preserved');
}
if (!(sheetXml.indexOf('商品图片2') > sheetXml.indexOf('店铺名称'))) {
  throw new Error('additional product images should be appended after the configured fields');
}
const drawing = new TextDecoder().decode(entries.get('xl/drawings/drawing1.xml'));
if ((drawing.match(/<xdr:oneCellAnchor>/g) || []).length !== 2) {
  throw new Error('both product images should be embedded in the product row');
}

const singleImageItem = {
  ...item,
  itemId: 'item-single-image',
  itemUrl: 'https://www.goofish.com/item?id=item-single-image',
  images: [
    'https://img.example/single_300x300.jpg',
    'https://img.example/single_800x800.jpg',
    'https://img.example/single.jpg?width=1200&quality=80'
  ]
};
const duplicateAssets = singleImageItem.images.map((url, index) => ({
  kind: 'product',
  itemKey: `id:${singleImageItem.itemId}`,
  itemId: singleImageItem.itemId,
  itemUrl: singleImageItem.itemUrl,
  imageIndex: index + 1,
  url,
  fileName: `single-${index + 1}.jpg`,
  bytes: png,
  extension: 'jpg',
  width: 1,
  height: 1
}));
const singleBlob = context.window.XianyuXlsx.createWorkbook([singleImageItem], duplicateAssets, [], {
  fieldConfig: { product: ['itemId', 'images', 'sellerName'] }
});
const singleEntries = readStoredZip(new Uint8Array(await singleBlob.arrayBuffer()));
const singleSheetXml = new TextDecoder().decode(singleEntries.get('xl/worksheets/sheet1.xml'));
const singleDrawing = new TextDecoder().decode(singleEntries.get('xl/drawings/drawing1.xml'));
if ((singleSheetXml.match(/商品图片/g) || []).length !== 1 || singleSheetXml.includes('商品图片2')) {
  throw new Error('a single logical product image must not become repeated image columns');
}
if ((singleDrawing.match(/<xdr:oneCellAnchor>/g) || []).length !== 1) {
  throw new Error('a single logical product image must be embedded once');
}

const sharedItems = [1, 2].map(index => ({
  ...item,
  itemId: `item-shared-image-${index}`,
  itemUrl: `https://www.goofish.com/item?id=item-shared-image-${index}`,
  images: [`https://img.example/shared-${index}.jpg`]
}));
const sharedAssets = sharedItems.map((sharedItem, index) => ({
  kind: 'product',
  itemKey: `id:${sharedItem.itemId}`,
  itemId: sharedItem.itemId,
  itemUrl: sharedItem.itemUrl,
  imageIndex: 1,
  url: sharedItem.images[0],
  fileName: `shared-${index + 1}.jpg`,
  bytes: png,
  extension: 'jpg',
  width: 1,
  height: 1
}));
const sharedBlob = context.window.XianyuXlsx.createWorkbook(sharedItems, sharedAssets, [], {
  fieldConfig: { product: ['itemId', 'images'] }
});
const sharedEntries = readStoredZip(new Uint8Array(await sharedBlob.arrayBuffer()));
const sharedDrawing = new TextDecoder().decode(sharedEntries.get('xl/drawings/drawing1.xml'));
if ((sharedEntries instanceof Map ? [...sharedEntries.keys()].filter(name => name.startsWith('xl/media/')).length : 0) !== 1
  || (sharedDrawing.match(/<xdr:oneCellAnchor>/g) || []).length !== 2) {
  throw new Error('identical image bytes shared by two products should reuse one media file but keep two row placements');
}

console.log(JSON.stringify({ ok: true, productSheets: 2, embeddedProductImages: 2, dedupedSingleImage: true }));
