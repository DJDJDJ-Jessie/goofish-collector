import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../xlsx.js', import.meta.url), 'utf8');
const context = vm.createContext({
  window: {}, Blob, Uint8Array, ArrayBuffer, TextEncoder, TextDecoder, URL, console
});
vm.runInContext(source, context);

const imageBytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
const profile = {
  sellerName: '\u7efc\u5408\u6d4b\u8bd5\u5e97\u94fa',
  sellerUrl: 'https://www.goofish.com/personal?userId=store-merge-1',
  sellerLocation: '\u897f\u5b89',
  sellerFollowers: '9',
  sellerFollowing: '83',
  sellerProductCount: '22',
  sellerIntro: '12345',
  storeDuration: '239\u5929',
  sellerGoodRate: '100%',
  sellerReviewCount: '101',
  collectedAt: '2026-08-08T12:00:00.000Z',
  reviews: [
    {
      reviewIndex: 1,
      reviewer: '\u4e70\u5bb61',
      role: '\u666e\u901a\u7528\u6237',
      feedback: '\u8bc4\u4ef7\u4e00',
      timeIp: '\u4eca\u5929 \u897f\u5b89',
      images: ['https://img.example/review-1.jpg'],
      collectedAt: '2026-08-08T12:00:01.000Z'
    },
    {
      reviewIndex: 2,
      reviewer: '\u4e70\u5bb62',
      role: '\u56de\u5934\u5ba2',
      feedback: '\u8bc4\u4ef7\u4e8c',
      timeIp: '\u6628\u5929 \u6210\u90fd',
      images: ['https://img.example/review-2a.jpg', 'https://img.example/review-2b.jpg'],
      collectedAt: '2026-08-08T12:00:02.000Z'
    }
  ]
};
const reviewAssets = [
  {
    kind: 'review', reviewKey: `${profile.sellerUrl}|review:1`, storeName: profile.sellerName,
    sellerUrl: profile.sellerUrl, reviewIndex: 1, imageIndex: 1, url: profile.reviews[0].images[0],
    fileName: '\u7efc\u5408\u6d4b\u8bd5\u5e97\u94fa_\u8bc4\u4ef7001_\u56fe1.jpg', bytes: imageBytes, extension: 'jpg', width: 1, height: 1
  },
  {
    kind: 'review', reviewKey: `${profile.sellerUrl}|review:2`, storeName: profile.sellerName,
    sellerUrl: profile.sellerUrl, reviewIndex: 2, imageIndex: 1, url: profile.reviews[1].images[0],
    fileName: '\u7efc\u5408\u6d4b\u8bd5\u5e97\u94fa_\u8bc4\u4ef7002_\u56fe1.jpg', bytes: imageBytes, extension: 'jpg', width: 1, height: 1
  },
  {
    kind: 'review', reviewKey: `${profile.sellerUrl}|review:2`, storeName: profile.sellerName,
    sellerUrl: profile.sellerUrl, reviewIndex: 2, imageIndex: 2, url: profile.reviews[1].images[1],
    fileName: '\u7efc\u5408\u6d4b\u8bd5\u5e97\u94fa_\u8bc4\u4ef7002_\u56fe2.jpg', bytes: imageBytes, extension: 'jpg', width: 1, height: 1
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
const profileXml = new TextDecoder().decode(entries.get('xl/worksheets/sheet1.xml'));
const reviewXml = new TextDecoder().decode(entries.get('xl/worksheets/sheet2.xml'));
const drawingXml = new TextDecoder().decode(entries.get('xl/drawings/drawing1.xml'));
const reviewRelsXml = new TextDecoder().decode(entries.get('xl/worksheets/_rels/sheet2.xml.rels'));

const expectedSheets = [
  '\u5e97\u94fa\u8d44\u6599',
  '\u5e97\u94fa\u8bc4\u4ef7\u7efc\u5408'
];
if (!expectedSheets.every(name => workbookXml.includes(`name="${name}"`)) || (workbookXml.match(/<sheet /g) || []).length !== 2) {
  throw new Error('store workbook should contain exactly profile and review sheets');
}
if (workbookXml.includes('\u8bf4\u660e') || workbookXml.includes('\u5e97\u94fa\u7efc\u5408')) {
  throw new Error('store workbook should not keep the old combined or extra notes sheet');
}
if (!profileXml.includes('\u5e97\u94fa\u540d\u79f0') || !profileXml.includes('12345')) {
  throw new Error('store profile sheet is missing profile values');
}
if (profileXml.includes('\u5f00\u5e97\u65f6\u957f') || profileXml.includes('\u5546\u54c1\u597d\u8bc4\u7387')
  || profileXml.includes('239\u5929') || profileXml.includes('100%')) {
  throw new Error('store profile sheet must not export product-only duration or fabricated good-rate fields');
}
if (!reviewXml.includes('\u8bc4\u4ef7\u5185\u5bb9') || !reviewXml.includes('\u8bc4\u4ef7\u56fe\u7247\u72b6\u6001') || !reviewXml.includes('\u8bc4\u4ef7\u56fe\u7247')) {
  throw new Error('store review sheet is missing review/image columns');
}
if (!reviewXml.includes('\u8bc4\u4ef7\u4e00') || !reviewXml.includes('\u8bc4\u4ef7\u4e8c') || !reviewXml.includes('\u56fe2.jpg')) {
  throw new Error('review values and image names were not written to the review sheet');
}
if ((profileXml.match(/<row /g) || []).length !== 2 || (reviewXml.match(/<row /g) || []).length !== 3) {
  throw new Error('profile sheet should have one profile row and review sheet one row per review');
}
if ((drawingXml.match(/<xdr:oneCellAnchor>/g) || []).length !== 3 || !drawingXml.includes('<xdr:col>10</xdr:col>') || !drawingXml.includes('<xdr:colOff>1095375</xdr:colOff>')) {
  throw new Error('all review images were not embedded on the review sheet rows');
}
if (!reviewRelsXml.includes('../drawings/drawing1.xml') || entries.has('xl/worksheets/_rels/sheet1.xml.rels')) {
  throw new Error('review drawing should be attached only to the review sheet');
}

console.log(JSON.stringify({
  ok: true,
  sheets: expectedSheets,
  profileRows: 1,
  reviewRows: 2,
  embeddedReviewImages: 3
}));
