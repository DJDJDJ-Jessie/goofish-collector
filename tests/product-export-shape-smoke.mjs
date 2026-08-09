import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../xlsx.js', import.meta.url), 'utf8');
const context = vm.createContext({
  window: {}, Blob, Uint8Array, ArrayBuffer, TextEncoder, TextDecoder, URL, console
});
vm.runInContext(source, context);

const item = {
  itemId: '107391917237',
  itemUrl: 'https://www.goofish.com/item?id=107391917237',
  description: '\u5546\u54c1\u6587\u6848',
  viewCount: '27',
  wantCount: '3',
  price: '\u00a510',
  category: '\u91d1\u878d',
  sellerName: '\u6d4b\u8bd5\u5e97\u94fa',
  collectedAt: '2026-08-08T12:00:00.000Z'
};
const invalidApiCountItem = {
  ...item,
  itemId: '107391917238',
  wantCount: '55.00827',
  viewCount: '5.5万'
};

const blob = context.window.XianyuXlsx.createWorkbook([item, invalidApiCountItem], [], [], {});
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
const productXml = new TextDecoder().decode(entries.get('xl/worksheets/sheet1.xml'));
const orderedHeaders = ['\u5546\u54c1\u6587\u6848', '\u6d4f\u89c8\u6570', '\u60f3\u8981\u6570', '\u4ef7\u683c'];
let previousIndex = -1;
for (const header of orderedHeaders) {
  const index = productXml.indexOf(header);
  if (index <= previousIndex) throw new Error(`product header order is wrong near ${header}`);
  previousIndex = index;
}
if (!productXml.includes('27') || !productXml.includes('3')) {
  throw new Error('product browse/want counts were not written to the product sheet');
}
if (productXml.includes('55.00827') || !productXml.includes('55000')) {
  throw new Error('invalid decimal interaction counts were not normalized before export');
}
if ((productXml.match(/<row /g) || []).length !== 3) {
  throw new Error('product sheet should contain one header row and two item rows');
}

console.log(JSON.stringify({ ok: true, productColumns: 20, viewCount: '27', wantCount: '3', compactViewCount: '55000' }));
