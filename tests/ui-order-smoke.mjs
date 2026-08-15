import fs from 'node:fs/promises';
import vm from 'node:vm';

const contentSource = await fs.readFile(new URL('../content.js', import.meta.url), 'utf8');
const contentListenerStart = contentSource.indexOf('chrome.runtime.onMessage.addListener');
if (contentListenerStart < 0) throw new Error('content message listener not found');

const contentContext = vm.createContext({
  window: {
    __XIANYU_CONTENT_SCRIPT_INSTALLED__: false,
    scrollX: 0,
    scrollY: 0,
    innerWidth: 1600,
    innerHeight: 900,
    addEventListener() {},
    getComputedStyle() { return { display: 'block', visibility: 'visible', opacity: '1' }; }
  },
  document: {
    addEventListener() {},
    querySelectorAll() { return []; },
    querySelector() { return null; },
    documentElement: { scrollTop: 0, scrollLeft: 0 }
  },
  location: { href: 'https://www.goofish.com/search?q=test', pathname: '/search', search: '?q=test' },
  URL,
  Date,
  Set,
  Map,
  Math,
  Number,
  String,
  Boolean,
  Object,
  Array,
  Promise,
  Error,
  RegExp,
  JSON,
  MouseEvent: class MouseEvent {},
  setTimeout,
  clearTimeout
});

const contentTestSource = `${contentSource.slice(0, contentListenerStart)}
globalThis.__contentApi = { sortCandidatesByVisualOrder };
})();`;
vm.runInContext(contentTestSource, contentContext);

function card(id, top, left) {
  return {
    id,
    node: {
      getBoundingClientRect() {
        return { top, left, width: 240, height: 400 };
      }
    }
  };
}

const shuffled = [
  card('row2-left', 520, 100),
  card('row1-right', 100, 500),
  card('row1-left', 100, 100),
  card('row2-right', 520, 500)
];
const visualOrder = contentContext.__contentApi.sortCandidatesByVisualOrder(shuffled).map(item => item.id);
const expectedOrder = ['row1-left', 'row1-right', 'row2-left', 'row2-right'];
if (JSON.stringify(visualOrder) !== JSON.stringify(expectedOrder)) {
  throw new Error(`visual order mismatch: ${visualOrder.join(', ')}`);
}

const searchFunctionStart = contentSource.indexOf('function searchLinkItems()');
const searchFunctionEnd = contentSource.indexOf('function buildDetailItem()', searchFunctionStart);
const searchFunction = contentSource.slice(searchFunctionStart, searchFunctionEnd);
if (searchFunction.includes('for (const networkItem of networkBuffer)')) {
  throw new Error('search links still append network-only items after visible cards');
}
if (!searchFunction.includes('sortCandidatesByVisualOrder')) {
  throw new Error('search links do not use visual row-major sorting');
}
if (!contentSource.includes("message?.type === 'PREPARE_PUBLIC_PAGE'")) {
  throw new Error('public page preparation message is missing');
}
if (!contentSource.includes("bodyText.includes('短信登录')") || !contentSource.includes('dismissPublicLoginOverlay')) {
  throw new Error('login overlay handling is missing');
}

const panelSource = await fs.readFile(new URL('../sidepanel.js', import.meta.url), 'utf8');
const panelHtml = await fs.readFile(new URL('../sidepanel.html', import.meta.url), 'utf8');
const panelCss = await fs.readFile(new URL('../sidepanel.css', import.meta.url), 'utf8');
if (!panelHtml.includes('id="detailSuccessCard"') || !panelHtml.includes('id="storeSuccessCard"')) {
  throw new Error('current detail/store screens must have visible completion cards');
}
if (!panelSource.includes("setCollectionSuccess('detail', true") || !panelSource.includes("setCollectionSuccess('store', true")) {
  throw new Error('current detail/store collection must show a completion state after success');
}
if (!panelCss.includes('.success-orb') || !panelCss.includes('.collection-success-card')) {
  throw new Error('collection completion card styling is missing');
}
if (!panelHtml.includes('采集当前店铺评价') || panelSource.includes("textContent = '采集当前店铺页'")) {
  throw new Error('store collection action should be named as current store reviews');
}
const panelBootStart = panelSource.indexOf("document.addEventListener('DOMContentLoaded'");
if (panelBootStart < 0) throw new Error('sidepanel boot listener not found');
const elements = new Map([
  ['currentCommitButton', { disabled: true, textContent: '' }],
  ['currentExportButton', { disabled: true, textContent: '' }],
  ['currentCollectHint', { textContent: '' }]
]);
const panelContext = vm.createContext({
  document: {
    getElementById(id) { return elements.get(id) || null; },
    querySelectorAll() { return []; },
    querySelector() { return null; }
  },
  window: {},
  chrome: {},
  URL,
  Date,
  Set,
  Map,
  Math,
  Number,
  String,
  Boolean,
  Object,
  Array,
  Promise,
  Error,
  RegExp,
  JSON,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval
});
const panelTestSource = `${panelSource.slice(0, panelBootStart)}
globalThis.__panelApi = {
  sameDetailSource,
  setPending(items) { pendingCurrentItems = items; currentItemsCommitted = false; renderCurrentResultActions(); }
};
})();`;
vm.runInContext(panelTestSource, panelContext);

if (!panelContext.__panelApi.sameDetailSource(
  'https://www.goofish.com/item?spm=old&id=100000000001',
  'https://www.goofish.com/item?spm=new&id=100000000001'
)) throw new Error('same item with rewritten tracking parameters is treated as a new detail');
if (panelContext.__panelApi.sameDetailSource(
  'https://www.goofish.com/item?id=100000000001',
  'https://www.goofish.com/item?id=100000000002'
)) throw new Error('different item details are treated as the same result source');

panelContext.__panelApi.setPending([{ itemId: '100000000001' }]);
if (elements.get('currentCommitButton').disabled || elements.get('currentExportButton').disabled) {
  throw new Error('current detail result actions remain disabled after a real row is staged');
}

console.log(JSON.stringify({ ok: true, visualOrder, resultActionsEnabled: true }));
