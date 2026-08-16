(() => {
  'use strict';

  const global = typeof globalThis !== 'undefined' ? globalThis : window;
  const IMAGE_ATTRIBUTES = ['src', 'currentSrc', 'data-src', 'data-lazy-src', 'data-original', 'data-ks-lazyload'];
  const TRACKING_OR_TRANSFORM_KEY = /^(?:resize|width|height|quality|thumbnail|thumb|process|imageview|crop|format|spm|scm|ut_sk|utsk|from|source)$/i;
  const OVERLAY_PATTERN = /(?:sold\s*out|soldout|sellout|out[-_ ]of[-_ ]stock|badge|watermark|overlay|mask|stamp|status|已售|已卖|售罄|下架)/i;
  const THUMBNAIL_PATTERN = /(?:thumbnail|thumb|缩略|mini|small|preview)/i;
  const CAROUSEL_SELECTOR = '[class^="item-main-window-carousel"], [class*="item-main-window-carousel"]';
  const SLIDE_SELECTOR = '[class^="carouselItem"], [class*=" carouselItem"]';

  function absoluteUrl(value, baseHref = '') {
    if (!value) return '';
    const raw = String(value).trim();
    if (!raw || raw.startsWith('data:') || raw.startsWith('blob:')) return '';
    try {
      const base = baseHref || global.location?.href || 'https://www.goofish.com/';
      const url = new URL(raw.startsWith('//') ? `https:${raw}` : raw, base);
      return /^https?:$/.test(url.protocol) ? url.href : '';
    } catch (_) {
      return '';
    }
  }

  function stripImageVariant(pathname) {
    let path = String(pathname || '');
    // Ali CDN often turns `image.heic` into `image.heic_790x10000Q90.jpg_.webp`
    // or `image.heic_Q90.jpg_.webp`.  Remove the complete derivative suffix so
    // all sizes and formats point back to the same uploaded image.
    path = path.replace(/(?:[_-]q\d+|[_-]\d{2,5}x\d{2,5}(?:q\d+)?)(?:\.[a-z\d]+_?)*$/i, '');
    path = path.replace(/@[!_][^/]+$/i, '');
    // Keep the original extension when the CDN inserted a simple `_300x300`
    // token before it.
    path = path.replace(/([_-])\d{2,5}x\d{2,5}(?=\.[a-z\d]{2,8}$)/i, '');
    return path;
  }

  function canonicalizeUrl(value, baseHref = '') {
    const direct = absoluteUrl(value, baseHref);
    if (!direct) return '';
    try {
      const url = new URL(direct);
      for (const key of [...url.searchParams.keys()]) {
        if (TRACKING_OR_TRANSFORM_KEY.test(key)) url.searchParams.delete(key);
      }
      url.hash = '';
      url.pathname = stripImageVariant(url.pathname);
      return url.href;
    } catch (_) {
      return direct;
    }
  }

  function urlScore(value) {
    const url = String(value || '');
    const lower = url.toLowerCase();
    let score = 0;
    if (!THUMBNAIL_PATTERN.test(lower)) score += 30;
    if (!OVERLAY_PATTERN.test(lower)) score += 30;
    if (!/(?:_\d{2,5}x\d{2,5}|[?&](?:width|height|resize)=)/i.test(lower)) score += 45;
    if (/_q(?:80|90|95|100)/i.test(lower)) score += 10;
    const sizes = [...lower.matchAll(/(?:^|[_=&-])(\d{2,5})x(\d{2,5})/g)]
      // Ali CDN uses a very large second dimension such as `220x10000` as a
      // crop limit.  The first/smaller dimension is the actual delivered size.
      .map(match => Math.min(Number(match[1]), Number(match[2])))
      .filter(Number.isFinite);
    if (sizes.length) score += Math.min(120, Math.max(...sizes) / 10);
    return score;
  }

  function dedupeUrls(values, baseHref = '') {
    const groups = new Map();
    for (const value of Array.isArray(values) ? values : []) {
      const url = absoluteUrl(value, baseHref);
      const key = canonicalizeUrl(url, baseHref) || url;
      if (!url || !key) continue;
      const existing = groups.get(key);
      if (!existing || urlScore(url) > existing.score) {
        groups.set(key, { url, score: urlScore(url), order: existing?.order ?? groups.size });
      }
    }
    return [...groups.values()]
      .sort((left, right) => left.order - right.order)
      .map(entry => entry.url);
  }

  function nodeText(node) {
    if (!node) return '';
    const values = [
      typeof node.className === 'string' ? node.className : '',
      node.id || '',
      node.getAttribute?.('alt') || '',
      node.getAttribute?.('title') || '',
      node.getAttribute?.('aria-label') || '',
      node.getAttribute?.('data-testid') || '',
      node.getAttribute?.('data-role') || ''
    ];
    return values.filter(Boolean).join(' ');
  }

  function hasNodeFlag(node, pattern, maxLevels = 5) {
    let current = node;
    for (let level = 0; current && level < maxLevels; level++, current = current.parentElement) {
      if (pattern.test(nodeText(current))) return true;
    }
    return false;
  }

  function imageSourceUrls(img) {
    const values = [];
    for (const attribute of IMAGE_ATTRIBUTES) {
      const value = attribute === 'currentSrc'
        ? img.currentSrc
        : img.getAttribute?.(attribute);
      if (value) values.push(value);
    }
    return dedupeUrls(values, global.location?.href || '');
  }

  function imageCandidate(img, slideIndex, order, options = {}) {
    const baseHref = global.location?.href || '';
    const urls = imageSourceUrls(img);
    if (!urls.length) return [];
    const naturalWidth = Number(img.naturalWidth) || 0;
    const naturalHeight = Number(img.naturalHeight) || 0;
    const rect = img.getBoundingClientRect?.() || { width: 0, height: 0 };
    const overlay = hasNodeFlag(img, OVERLAY_PATTERN) || urls.some(url => OVERLAY_PATTERN.test(url));
    const thumbnail = hasNodeFlag(img, THUMBNAIL_PATTERN);
    return urls.map((url, sourceIndex) => {
      let score = urlScore(url) - sourceIndex;
      if (naturalWidth >= 700 || naturalHeight >= 700) score += 80;
      else if (naturalWidth >= 300 || naturalHeight >= 300) score += 45;
      if (Number(rect.width) >= 300 || Number(rect.height) >= 300) score += 35;
      if (options.inSlide) score += 100;
      return {
        url,
        canonicalUrl: canonicalizeUrl(url, baseHref),
        slideIndex,
        order,
        score,
        overlay,
        thumbnail,
        inSlide: Boolean(options.inSlide)
      };
    });
  }

  function selectDetailImageUrls(candidates, options = {}) {
    const groups = new Map();
    for (const candidate of Array.isArray(candidates) ? candidates : []) {
      if (!candidate?.url || candidate.overlay || candidate.thumbnail) continue;
      const key = candidate.canonicalUrl || canonicalizeUrl(candidate.url) || candidate.url;
      const existing = groups.get(key);
      if (!existing || candidate.score > existing.score) {
        groups.set(key, {
          ...candidate,
          firstOrder: existing?.firstOrder ?? candidate.order ?? groups.size
        });
      }
    }

    const selected = [...groups.values()]
      .sort((left, right) => left.firstOrder - right.firstOrder)
      .map(candidate => candidate.url);
    return options.only ? selected.slice(0, 1) : selected;
  }

  function collectDetailImageUrls(root) {
    if (!root?.querySelector) return [];
    const carousel = root.querySelector(CAROUSEL_SELECTOR);
    if (!carousel) return [];

    const slides = [...(carousel.querySelectorAll?.(SLIDE_SELECTOR) || [])];
    const candidates = [];
    const sourceNodes = slides.length
      ? slides.flatMap((slide, slideIndex) => [...(slide.querySelectorAll?.('img') || [])]
        .map((img, imageIndex) => ({ img, slideIndex, imageIndex, inSlide: true })))
      : [...(carousel.querySelectorAll?.('img') || [])]
        .map((img, imageIndex) => ({ img, slideIndex: 0, imageIndex, inSlide: false }));

    sourceNodes.forEach(({ img, slideIndex, imageIndex, inSlide }) => {
      candidates.push(...imageCandidate(img, slideIndex, imageIndex, { inSlide }));
    });

    const className = typeof carousel.className === 'string' ? carousel.className : '';
    const only = /(?:^|\s)only(?:--|\s|$)/i.test(className);
    return selectDetailImageUrls(candidates, { only });
  }

  global.XianyuImageUtils = Object.freeze({
    absoluteUrl,
    canonicalizeUrl,
    dedupeUrls,
    selectDetailImageUrls,
    collectDetailImageUrls
  });
})();
