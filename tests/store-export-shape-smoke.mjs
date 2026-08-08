import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../xlsx.js', import.meta.url), 'utf8');
const context = vm.createContext({
  window: {}, Blob, Uint8Array, ArrayBuffer, TextEncoder, TextDecoder, URL, console
});
vm.runInContext(source, context);

const imageBytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
const profile = {
  sellerName: '综合测试店铺',
  sellerUrl: 'https://www.goofish.com/personal?userId=store-merge-1',
  sellerLocation: '西安',
  sellerFollowers: '9',
  sellerFollowing: '83',
  sellerProductCount: '22',
  sellerIntro: '12345',
  storeDuration: '239天',
  sellerGoodRate: '100%',
  sellerReviewCount: '101',
  collectedAt: '2026-08-08T12:00:00.000Z',
  reviews: [
    {
      reviewIndex: 1,
      reviewer: '买家1',
      role: '普通用户',
      feedback: '评价一',
      timeIp: '今天 西安',
      images: ['https://img.example/review-1.jpg'],
      collectedAt: '2026-08-08T12:00:01.000Z'
    },
    {
      reviewIndex: 2,
      reviewer: '买家2',
      role: '回头客',
      feedback: '评价二',
      timeIp: '昨天 成都',
      images: ['https://img.example/review-2a.jpg', 'https://img.example/review-2b.jpg'],
      collectedAt: '2026-08-08T12:00:02.000Z'
    }
  ]
};
const reviewAssets = [
  {
    kind: 'review', reviewKey: `${profile.sellerUrl}|review:1`, storeName: profile.sellerName,
    sellerUrl: profile.sellerUrl, reviewIndex: 1, imageIndex: 1, url: profile.reviews[0].images[0],
    fileName: '综合测试店铺_评价001_图01.jpg', bytes: imageBytes, extension: 'jpg', width: 1, height: 1
  },
  {
    kind: 'review', reviewKey: `${profile.sellerUrl}|review:2`, storeName: profile.sellerName,
    sellerUrl: profile.sellerUrl, reviewIndex: 2, imageIndex: 1, url: profile.reviews[1].images[0],
    fileName: '综合测试店铺_评价002_图01.jpg', bytes: imageBytes, extension: 'jpg', width: 1, height: 1
  },
  {
    kind: 'review', reviewKey: `${profile.sellerUrl}|review:2`, storeName: profile.sellerName,
    sellerUrl: profile.sellerUrl, reviewIndex: 2, imageIndex: 2, url: profile.reviews[1].images[1],
    fileName: '综合测试店铺_评价002_图02.jpg', bytes: imageBytes, extension: 'jpg', width: 1, height: 1
  }
];

const blob = context.window.XianyuXlsx.createWorkbook([], reviewAssets, [profile], { kind: 'store' });
const bytes = new Uint8Array(await blob.arrayBuffer());

function readStoredZip(input) {
  const entries = new Map();
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  let offset = 0;
  while (offset + 4 <= input.length && view.getUint32(offset, true) === 0x04034b50) {
    const compressedSize = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const nameStart = offset + 30;
    const name = new TextDecoder().decode(input.slice(nameStart, nameStart + nameLength));
    const dataStart = nameStart + nameLength + extraLength;
    entries.set(name, input.slice(dataStart, dataStart + compressedSize));
    offset = dataStart + compressedSize;
  }
  return entries;
}

const entries = readStoredZip(bytes);
const workbookXml = new TextDecoder().decode(entries.get('xl/workbook.xml'));
const combinedXml = new TextDecoder().decode(entries.get('xl/worksheets/sheet1.xml'));
const noteXml = new TextDecoder().decode(entries.get('xl/worksheets/sheet2.xml'));
const drawingXml = new TextDecoder().decode(entries.get('xl/drawings/drawing1.xml'));

if (!workbookXml.includes('name="店铺综合"') || workbookXml.includes('name="店铺评价"') || workbookXml.includes('name="评价图片"')) {
  throw new Error('store workbook did not collapse data into the combined sheet');
}
if (!combinedXml.includes('店铺名称') || !combinedXml.includes('评价内容') || !combinedXml.includes('评价图片状态') || !combinedXml.includes('评价图片')) {
  throw new Error('combined store headers are incomplete');
}
if (!combinedXml.includes('综合测试店铺') || !combinedXml.includes('评价一') || !combinedXml.includes('评价二')) {
  throw new Error('profile and review values were not written to the same sheet');
}
if ((combinedXml.match(/<row /g) || []).length !== 3) {
  throw new Error('combined sheet should contain one row per review plus a header');
}
if ((drawingXml.match(/<xdr:oneCellAnchor>/g) || []).length !== 3 || !drawingXml.includes('<xdr:colOff>1095375</xdr:colOff>')) {
  throw new Error('all review images were not embedded on their corresponding combined row');
}
if (!noteXml.includes('店铺综合表')) throw new Error('combined export explanation is missing');

console.log(JSON.stringify({
  ok: true,
  sheets: ['店铺综合', '说明'],
  combinedRows: 2,
  embeddedReviewImages: 3
}));
