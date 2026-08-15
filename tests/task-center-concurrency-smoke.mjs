import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const JOBS_KEY = 'xianyu_collect_jobs_v2';
const LEGACY_JOB_KEY = 'xianyu_collect_job_v1';
const storage = new Map();
const messageListeners = [];
const tabUpdates = [];

function event(listeners) {
  return {
    addListener(listener) {
      listeners.push(listener);
    },
    removeListener(listener) {
      const index = listeners.indexOf(listener);
      if (index >= 0) listeners.splice(index, 1);
    }
  };
}

const chrome = {
  storage: {
    local: {
      async get(keys) {
        if (typeof keys === 'string') return { [keys]: storage.get(keys) };
        const result = {};
        for (const key of Array.isArray(keys) ? keys : Object.keys(keys || {})) {
          if (storage.has(key)) result[key] = storage.get(key);
        }
        return result;
      },
      async set(values) {
        for (const [key, value] of Object.entries(values)) storage.set(key, value);
      }
    }
  },
  runtime: {
    lastError: null,
    getURL(path) {
      return `chrome-extension://task-center-test/${path}`;
    },
    sendMessage() {
      return Promise.resolve({ ok: true });
    },
    onInstalled: event([]),
    onStartup: event([]),
    onMessage: event(messageListeners)
  },
  alarms: {
    clear() {
      return Promise.resolve(true);
    },
    create() {},
    onAlarm: event([])
  },
  tabs: {
    create(_options, callback) {
      callback({ id: 101 });
    },
    get(_tabId, callback) {
      callback({ id: 77, url: 'https://www.goofish.com/item?id=store-item-1' });
    },
    update(_tabId, properties, callback) {
      tabUpdates.push(properties?.url || '');
      callback({ id: 77, url: properties?.url || '' });
    },
    remove(_tabId, callback) {
      callback();
    },
    sendMessage() {
      return Promise.resolve({ ok: true });
    },
    onUpdated: event([]),
    onRemoved: event([])
  },
  action: {
    onClicked: event([]),
    setBadgeText() {
      return Promise.resolve();
    },
    setBadgeBackgroundColor() {
      return Promise.resolve();
    }
  },
  notifications: {
    create() {
      return Promise.resolve();
    }
  },
  sidePanel: {
    setPanelBehavior() {
      return Promise.resolve();
    },
    open() {
      return Promise.resolve();
    }
  },
  downloads: {
    download(_options, callback) {
      callback(1);
    }
  },
  offscreen: {
    createDocument() {
      return Promise.resolve();
    },
    closeDocument() {
      return Promise.resolve();
    }
  },
  scripting: {
    executeScript() {
      return Promise.resolve();
    }
  }
};

const context = vm.createContext({
  chrome,
  console,
  URL,
  Date,
  Math,
  Map,
  Set,
  Promise,
  Number,
  String,
  Boolean,
  Object,
  Array,
  JSON,
  RegExp,
  Error,
  TypeError,
  parseInt,
  parseFloat,
  isNaN,
  setTimeout,
  clearTimeout
});

const source = fs.readFileSync(new URL('../background.js', import.meta.url), 'utf8');
vm.runInContext(
  `${source}\n;globalThis.__taskCenterTestApi = { writeJob, readJobs, readJob, jobLinkUrl, jobLinkItemId, collectedItemForLink, advanceLinkJob };`,
  context
);

assert.equal(
  context.__taskCenterTestApi.jobLinkUrl({ itemId: 'object-link-1', itemUrl: 'https://www.goofish.com/item?id=object-link-1' }),
  'https://www.goofish.com/item?id=object-link-1',
  'store-products link objects must normalize to a string URL before navigation'
);
assert.equal(
  context.__taskCenterTestApi.jobLinkItemId({ itemId: 'object-link-1', itemUrl: 'https://www.goofish.com/item?id=object-link-1' }),
  'object-link-1',
  'store-products link objects must keep their item id'
);
const matched = context.__taskCenterTestApi.collectedItemForLink({ items: [{
  itemId: 'object-link-1',
  itemUrl: 'https://www.goofish.com/item?id=object-link-1',
  title: '店铺商品'
}] }, { itemId: 'object-link-1', itemUrl: 'https://www.goofish.com/item?id=object-link-1' });
assert.equal(matched?.title, '店铺商品', 'detail results must match a normalized store-products link object');

const objectNavigationJob = {
  id: 'store-products-navigation',
  type: 'store-products',
  status: 'collecting',
  stage: 'detail-page',
  tabId: 88,
  links: [
    { itemId: 'navigation-1', itemUrl: 'https://www.goofish.com/item?id=navigation-1' },
    { itemId: 'navigation-2', itemUrl: 'https://www.goofish.com/item?id=navigation-2' }
  ],
  index: 0,
  collected: 0,
  visited: 0,
  failures: [],
  sellerFailures: [],
  qualityWarnings: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString()
};
await context.__taskCenterTestApi.writeJob(objectNavigationJob);
const advancedObjectJob = await context.__taskCenterTestApi.advanceLinkJob(objectNavigationJob, '详情页等待超时');
assert.equal(
  tabUpdates.at(-1),
  'https://www.goofish.com/item?id=navigation-2',
  'store-products navigation must pass the object itemUrl string to tabs.update'
);
assert.equal(advancedObjectJob.failures?.[0]?.url, 'https://www.goofish.com/item?id=navigation-1');
assert.equal(advancedObjectJob.failures?.[0]?.itemId, 'navigation-1');

const now = new Date().toISOString();
const firstJob = {
  id: 'parallel-first',
  type: 'links',
  status: 'ready-to-collect',
  tabId: 11,
  links: ['https://www.goofish.com/item?id=first'],
  stagedItems: [],
  resultKeys: [],
  createdAt: now,
  updatedAt: now
};
const secondJob = {
  id: 'parallel-second',
  type: 'search',
  status: 'ready-to-collect',
  tabId: 22,
  links: [],
  stagedItems: [],
  resultKeys: [],
  createdAt: now,
  updatedAt: now
};

await Promise.all([
  context.__taskCenterTestApi.writeJob(firstJob),
  context.__taskCenterTestApi.writeJob(secondJob)
]);

let jobs = await context.__taskCenterTestApi.readJobs();
assert.deepEqual(
  new Set(jobs.map(job => job.id)),
  new Set(['parallel-first', 'parallel-second', 'store-products-navigation']),
  'concurrent task updates must not overwrite another task or navigation regression fixture'
);

const storeProductsJob = {
  id: 'store-products-smoke',
  type: 'store-products',
  status: 'collecting',
  stage: 'detail-page',
  tabId: 77,
  links: ['https://www.goofish.com/item?id=store-item-1'],
  index: 0,
  stagedItems: [],
  resultKeys: [],
  collected: 0,
  visited: 0,
  failures: [],
  sellerFailures: [],
  qualityWarnings: [],
  createdAt: now,
  updatedAt: now
};
await context.__taskCenterTestApi.writeJob(storeProductsJob);

const collectResponse = await new Promise((resolve, reject) => {
  try {
    const returned = messageListeners[0]({
      type: 'COLLECT_ITEMS',
      pageType: 'detail',
      persistToDataCenter: false,
      items: [{
        itemId: 'store-item-1',
        itemUrl: 'https://www.goofish.com/item?id=store-item-1',
        title: '店铺商品详情',
        description: '商品详情文案',
        price: '80',
        images: ['https://img.example/store-item-1.jpg'],
        sellerName: '测试店铺'
      }]
    }, {
      tab: { id: 77, url: 'https://www.goofish.com/item?id=store-item-1' }
    }, resolve);
    assert.equal(returned, true, 'COLLECT_ITEMS must keep the response channel open');
  } catch (error) {
    reject(error);
  }
});

assert.equal(collectResponse.ok, true);
assert.equal(collectResponse.staged, true);
assert.equal(collectResponse.stagedItems.length, 1, 'store-products results must enter the task staging area');
assert.equal(collectResponse.stagedItems[0].itemId, 'store-item-1');

jobs = await context.__taskCenterTestApi.readJobs();
const storedStoreJob = jobs.find(job => job.id === storeProductsJob.id);
assert.equal(storedStoreJob?.stagedItems?.length, 1, 'store-products staging must persist in the task center');
assert.equal(storage.has(LEGACY_JOB_KEY), true, 'legacy primary task key remains available for migration');

console.log(JSON.stringify({
  ok: true,
  taskCount: jobs.length,
  stagedStoreProducts: storedStoreJob.stagedItems.length
}));
