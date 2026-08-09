import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const JOB_KEY = 'xianyu_collect_job_v1';
const storage = new Map();
const messageListeners = [];
const removedTabs = [];
const clearedAlarms = [];
const createdAlarms = [];

function event(listeners) {
  return {
    addListener(listener) {
      listeners.push(listener);
    }
  };
}

const chrome = {
  storage: {
    local: {
      async get(key) {
        if (typeof key === 'string') return { [key]: storage.get(key) };
        return {};
      },
      async set(values) {
        for (const [key, value] of Object.entries(values)) storage.set(key, value);
      }
    }
  },
  runtime: {
    lastError: null,
    getURL(path) {
      return `chrome-extension://stop-test/${path}`;
    },
    onInstalled: event([]),
    onStartup: event([]),
    onMessage: event(messageListeners)
  },
  alarms: {
    clear(name) {
      clearedAlarms.push(name);
      return Promise.resolve(true);
    },
    create(name, info) {
      createdAlarms.push({ name, info });
    },
    onAlarm: event([])
  },
  tabs: {
    create(_options, callback) {
      callback({ id: 101 });
    },
    update(_tabId, _properties, callback) {
      callback({ id: 101 });
    },
    remove(tabId, callback) {
      removedTabs.push(tabId);
      callback();
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
  `${source}\n;globalThis.__stopTestApi = { scheduleJob, processJobAlarm, jobFailureRecords, terminalStatus, sanitizeStoreProfile, applyProfileToItem, missingProductFields, isInternalCategory, interactionCount };`,
  context
);

const activeJob = {
  id: 'search-stop-smoke',
  type: 'search',
  mode: 'rpa',
  status: 'collecting',
  stage: 'detail-page',
  tabId: 77,
  targetCount: 4,
  maxPages: 1,
  visited: 2,
  collected: 2,
  resultKeys: [],
  stagedItems: [],
  failures: [],
  sellerFailures: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString()
};
storage.set(JOB_KEY, activeJob);

assert.equal(messageListeners.length, 1, 'background message listener should be registered');
const response = await new Promise((resolve, reject) => {
  try {
    const returned = messageListeners[0]({ type: 'STOP_JOB' }, { tab: { id: 1 } }, resolve);
    assert.equal(returned, true, 'STOP_JOB must keep the response channel open');
  } catch (error) {
    reject(error);
  }
});

assert.equal(response.ok, true);
assert.equal(response.job.status, 'stopped');
assert.equal(storage.get(JOB_KEY).status, 'stopped');
assert.deepEqual(removedTabs, [77], 'stopping must close only the task tab');
assert.ok(clearedAlarms.includes('xianyu_collect_job_alarm_v1'), 'stopping must clear the task alarm');

const staleContinuation = await context.__stopTestApi.scheduleJob(
  { ...activeJob, status: 'collecting' },
  'ready-to-collect',
  250
);
assert.equal(staleContinuation.status, 'stopped', 'a stale continuation must see the stopped task');
assert.equal(createdAlarms.length, 0, 'a stopped task must not recreate its alarm');

await context.__stopTestApi.processJobAlarm();
assert.equal(createdAlarms.length, 0, 'a stopped task must not resume from an alarm');

const partialJob = {
  ...activeJob,
  status: 'completed',
  collected: 2,
  failures: [{ url: 'https://www.goofish.com/item?id=1', error: '详情页加载失败' }],
  sellerFailures: [{ url: 'https://www.goofish.com/item?id=2', error: '未识别卖家页' }],
  qualityWarnings: [{ url: 'https://www.goofish.com/item?id=3', fields: ['类目'], error: '字段待补充：类目' }]
};
assert.equal(context.__stopTestApi.jobFailureRecords(partialJob).length, 3, 'detail, seller and field failures must be reported together');
assert.equal(context.__stopTestApi.terminalStatus('completed', partialJob), 'partial', 'a completed task with failed links must be marked partial');

const productProfile = context.__stopTestApi.sanitizeStoreProfile({
  sellerName: '测试店铺',
  sellerUrl: 'https://www.goofish.com/personal?userId=123456789',
  sellerLocation: '陕西',
  sellerFollowers: '9',
  sellerFollowing: '83',
  sellerProductCount: '22',
  sellerIntro: '12345',
  sellerReviewCount: '101',
  storeDuration: '239天',
  sellerGoodRate: '100%'
}, '', { forProduct: true });
const enrichedProduct = context.__stopTestApi.applyProfileToItem({
  itemId: '123456789012',
  itemUrl: 'https://www.goofish.com/item?id=123456789012',
  description: '商品文案',
  viewCount: '27',
  wantCount: '3',
  price: '80',
  category: '金融',
  images: ['https://img.example.com/cover.jpg']
}, productProfile);
assert.equal(enrichedProduct.storeDuration, '239天', 'product-only duration must survive profile sanitization');
assert.equal(enrichedProduct.itemGoodRate, '100%', 'product-only good rate must survive profile sanitization');
assert.equal(enrichedProduct.sellerIntro, '12345', 'numeric store intro must remain valid text');
assert.equal(context.__stopTestApi.missingProductFields(enrichedProduct).length, 0, 'a complete product row must not report missing fields');
assert.equal(context.__stopTestApi.isInternalCategory('50023914'), true, 'plain numeric category IDs must not be exported as human categories');
assert.equal(context.__stopTestApi.interactionCount('55.00827'), '', 'internal decimal metrics must not enter interaction counts');
assert.equal(context.__stopTestApi.interactionCount('3'), '3', 'visible integer interaction counts must be preserved');
assert.equal(context.__stopTestApi.interactionCount('5.5万'), '55000', 'compact ten-thousand counts must be normalized to integers');

console.log(JSON.stringify({
  ok: true,
  stoppedStatus: storage.get(JOB_KEY).status,
  removedTabs,
  clearedAlarms: clearedAlarms.length,
  createdAlarms: createdAlarms.length
}));
