import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../image-utils.js', import.meta.url), 'utf8');
const context = vm.createContext({ window: {}, URL, URLSearchParams, console });
vm.runInContext(source, context);
const imageUtils = context.XianyuImageUtils;
if (!imageUtils) throw new Error('image utility module was not installed');

const oneImage = 'https://img.alicdn.com/bao/uploaded/i1/123/O1CN01abc_!!item.heic';
const thumb = `${oneImage}_220x10000Q90.jpg_.webp`;
const original = `${oneImage}_Q90.jpg_.webp`;
const visible = `${oneImage}_790x10000Q90.jpg_.webp`;
const soldStamp = 'https://img.alicdn.com/imgextra/soldout-stamp.png';
const secondImage = 'https://img.alicdn.com/bao/uploaded/i1/123/O1CN01second_!!item.jpg_790x10000Q90.jpg_.webp';

const deduped = imageUtils.dedupeUrls([thumb, original, visible]);
if (deduped.length !== 1 || deduped[0] !== visible) {
  throw new Error(`same-image CDN variants were not collapsed: ${JSON.stringify(deduped)}`);
}

const singleSelection = imageUtils.selectDetailImageUrls([
  { url: thumb, canonicalUrl: imageUtils.canonicalizeUrl(thumb), slideIndex: 0, order: 0, score: 10, thumbnail: true },
  { url: original, canonicalUrl: imageUtils.canonicalizeUrl(original), slideIndex: 0, order: 1, score: 60 },
  { url: visible, canonicalUrl: imageUtils.canonicalizeUrl(visible), slideIndex: 0, order: 2, score: 100 },
  { url: soldStamp, canonicalUrl: imageUtils.canonicalizeUrl(soldStamp), slideIndex: 0, order: 3, score: 200, overlay: true }
], { only: true });
if (singleSelection.length !== 1 || singleSelection[0] !== visible) {
  throw new Error(`single-image carousel retained an overlay or duplicate: ${JSON.stringify(singleSelection)}`);
}

const multiSelection = imageUtils.selectDetailImageUrls([
  { url: visible, canonicalUrl: imageUtils.canonicalizeUrl(visible), slideIndex: 0, order: 0, score: 100 },
  { url: secondImage, canonicalUrl: imageUtils.canonicalizeUrl(secondImage), slideIndex: 1, order: 1, score: 100 }
]);
if (multiSelection.length !== 2 || multiSelection[0] !== visible || multiSelection[1] !== secondImage) {
  throw new Error(`real multi-image carousel was collapsed incorrectly: ${JSON.stringify(multiSelection)}`);
}

function makeNode({ tagName = 'DIV', className = '', attrs = {}, currentSrc = '', naturalWidth = 0, naturalHeight = 0, rect = [0, 0], children = [] } = {}) {
  const node = {
    tagName,
    className,
    currentSrc,
    naturalWidth,
    naturalHeight,
    parentElement: null,
    children: [],
    getAttribute(name) { return attrs[name] ?? null; },
    getBoundingClientRect() { return { width: rect[0], height: rect[1] }; },
    querySelectorAll(selector) {
      const descendants = [];
      const visit = child => {
        descendants.push(child);
        child.children?.forEach(visit);
      };
      this.children.forEach(visit);
      if (selector === 'img') return descendants.filter(child => child.tagName === 'IMG');
      if (selector.includes('carouselItem')) {
        return descendants.filter(child => String(child.className || '').startsWith('carouselItem'));
      }
      return [];
    },
    querySelector(selector) {
      return selector.includes('item-main-window-carousel') ? this.children.find(child => String(child.className || '').includes('item-main-window-carousel')) || null : null;
    }
  };
  node.children = children;
  children.forEach(child => { child.parentElement = node; });
  return node;
}

const onlyCarousel = makeNode({
  className: 'item-main-window-carousel--test only--test',
  children: [makeNode({
    className: 'carouselItem--test',
    children: [
      makeNode({ tagName: 'IMG', currentSrc: thumb, naturalWidth: 220, naturalHeight: 220, rect: [220, 220] }),
      makeNode({ tagName: 'IMG', currentSrc: visible, naturalWidth: 790, naturalHeight: 790, rect: [790, 790] }),
      makeNode({ tagName: 'IMG', currentSrc: soldStamp, naturalWidth: 790, naturalHeight: 790, rect: [790, 790] })
    ]
  })]
});
const onlyRoot = makeNode({ children: [onlyCarousel] });
const collectedSingle = imageUtils.collectDetailImageUrls(onlyRoot);
if (collectedSingle.length !== 1 || collectedSingle[0] !== visible) {
  throw new Error(`detail carousel collector did not keep the visible main image: ${JSON.stringify(collectedSingle)}`);
}

const multiCarousel = makeNode({
  className: 'item-main-window-carousel--test',
  children: [
    makeNode({ className: 'carouselItem--one', children: [makeNode({ tagName: 'IMG', currentSrc: visible, naturalWidth: 790, naturalHeight: 790, rect: [790, 790] })] }),
    makeNode({ className: 'carouselItem--two', children: [makeNode({ tagName: 'IMG', currentSrc: secondImage, naturalWidth: 790, naturalHeight: 790, rect: [790, 790] })] })
  ]
});
const multiRoot = makeNode({ children: [multiCarousel] });
const collectedMulti = imageUtils.collectDetailImageUrls(multiRoot);
if (collectedMulti.length !== 2 || collectedMulti[0] !== visible || collectedMulti[1] !== secondImage) {
  throw new Error(`detail carousel collector dropped a real slide: ${JSON.stringify(collectedMulti)}`);
}

console.log(JSON.stringify({ ok: true, singleImageCount: collectedSingle.length, multiImageCount: collectedMulti.length }));
