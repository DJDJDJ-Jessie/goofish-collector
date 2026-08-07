(() => {
  'use strict';

  // 只观察闲鱼页面已经发出的搜索/详情响应，不读取 cookie、不生成签名、不主动发起请求。
  if (window.__XIANYU_PUBLIC_CAPTURE_INSTALLED__) return;
  window.__XIANYU_PUBLIC_CAPTURE_INSTALLED__ = true;

  const SEARCH_PATH = 'mtop.taobao.idlemtopsearch.pc.search';
  const DETAIL_PATH = 'mtop.taobao.idle.pc.detail';
  const EVENT_NAME = 'XIANYU_PUBLIC_DATA_CAPTURED';
  const SNAPSHOT_REQUEST = 'XIANYU_REQUEST_API_SNAPSHOT';
  const SNAPSHOT_EVENT = 'XIANYU_API_SNAPSHOT';
  const BUFFER_KEY = '__XIANYU_PUBLIC_API_BUFFER__';
  const MAX_BUFFER = 8;
  const MAX_RESPONSE_CHARS = 1_500_000;

  if (!Array.isArray(window[BUFFER_KEY])) window[BUFFER_KEY] = [];

  function getRequestUrl(input) {
    try {
      if (typeof Request !== 'undefined' && input instanceof Request) return input.url;
      return new URL(String(input || ''), location.href).href;
    } catch (_) {
      return '';
    }
  }

  function getApiType(url) {
    if (!url) return null;
    if (url.includes(DETAIL_PATH)) return 'DETAIL';
    if (url.includes(SEARCH_PATH)) return 'SEARCH';
    return null;
  }

  function safeSourceUrl(url) {
    try {
      const parsed = new URL(url, location.href);
      return `${parsed.origin}${parsed.pathname}`;
    } catch (_) {
      return location.href.split('?')[0];
    }
  }

  function emit(apiType, response, url) {
    if (!response || typeof response !== 'object') return;

    try {
      const serialized = JSON.stringify(response);
      if (!serialized || serialized.length > MAX_RESPONSE_CHARS) return;

      const detail = {
        apiType,
        response: JSON.parse(serialized),
        sourceUrl: safeSourceUrl(url),
        capturedAt: Date.now()
      };
      window[BUFFER_KEY].push(detail);
      if (window[BUFFER_KEY].length > MAX_BUFFER) window[BUFFER_KEY].shift();
      document.dispatchEvent(new CustomEvent(EVENT_NAME, { detail }));
    } catch (_) {
      // 页面响应不是可序列化 JSON 时忽略，不影响闲鱼页面本身。
    }
  }

  document.addEventListener(SNAPSHOT_REQUEST, () => {
    try {
      document.dispatchEvent(new CustomEvent(SNAPSHOT_EVENT, {
        detail: { entries: window[BUFFER_KEY].slice(-MAX_BUFFER) }
      }));
    } catch (_) {
      // 页面只要能继续运行即可，快照失败不影响原页面请求。
    }
  });

  const nativeFetch = window.fetch;
  if (typeof nativeFetch === 'function') {
    window.fetch = function(...args) {
      const requestUrl = getRequestUrl(args[0]);
      const apiType = getApiType(requestUrl);
      const promise = nativeFetch.apply(this, args);

      if (!apiType || !promise || typeof promise.then !== 'function') return promise;

      return promise.then(response => {
        try {
          const clone = response.clone();
          clone.json().then(data => emit(apiType, data, requestUrl)).catch(() => {});
        } catch (_) {
          // 某些响应不能 clone，忽略即可。
        }
        return response;
      });
    };
  }

  const nativeOpen = XMLHttpRequest.prototype.open;
  const nativeSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this.__xianyuResearchUrl = getRequestUrl(url);
    this.__xianyuResearchApiType = getApiType(this.__xianyuResearchUrl);
    return nativeOpen.apply(this, [method, url, ...rest]);
  };

  XMLHttpRequest.prototype.send = function(...args) {
    const apiType = this.__xianyuResearchApiType;
    if (apiType) {
      this.addEventListener('load', () => {
        try {
          let data = this.responseType === 'json' ? this.response : this.responseText;
          if (typeof data === 'string') data = JSON.parse(data);
          emit(apiType, data, this.__xianyuResearchUrl);
        } catch (_) {
          // 非 JSON 响应忽略。
        }
      }, { once: true });
    }
    return nativeSend.apply(this, args);
  };
})();
