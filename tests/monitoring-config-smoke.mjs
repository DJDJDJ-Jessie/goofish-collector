import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const MONITORS_KEY = 'xianyu_monitor_configs_v1';
const RUNS_KEY = 'xianyu_monitor_runs_v1';
const JOB_KEY = 'xianyu_collect_job_v1';
const storage = new Map();
const alarms = new Map();
const messageListeners = [];

function event(listeners) {
  return {
    addListener(listener) { listeners.push(listener); },
    removeListener(listener) {
      const index = listeners.indexOf(listener);
      if (index >= 0) listeners.splice(index, 1);
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
    getURL(path) { return `chrome-extension://monitor-test/${path}`; },
    onInstalled: event([]),
    onStartup: event([]),
    onMessage: event(messageListeners)
  },
  alarms: {
    async clear(name) { alarms.delete(name); return true; },
    create(name, info) { alarms.set(name, info); },
    async get(name) { return alarms.has(name) ? { name, ...alarms.get(name) } : null; },
    onAlarm: event([])
  },
  tabs: {
    create(_options, callback) { callback({ id: 301, status: 'complete' }); },
    update(_tabId, _properties, callback) { callback({ id: 301, status: 'complete' }); },
    remove(_tabId, callback) { callback(); },
    get(_tabId, callback) { callback({ id: 301, status: 'complete' }); },
    sendMessage(_tabId, _message, callback) { callback({ ok: false }); },
    onUpdated: event([]),
    onRemoved: event([])
  },
  action: {
    onClicked: event([]),
    setBadgeText() { return Promise.resolve(); },
    setBadgeBackgroundColor() { return Promise.resolve(); }
  },
  notifications: { create() { return Promise.resolve(); } },
  sidePanel: {
    setPanelBehavior() { return Promise.resolve(); },
    open() { return Promise.resolve(); }
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

const source = await fs.readFile(new URL('../background.js', import.meta.url), 'utf8');
vm.runInContext(`${source}\n;globalThis.__monitorTestApi = { monitorView };`, context);

async function send(message) {
  return new Promise((resolve, reject) => {
    try {
      const returned = messageListeners[0](message, { tab: { id: 1 } }, resolve);
      assert.equal(returned, true, `${message.type} must keep the response channel open`);
    } catch (error) {
      reject(error);
    }
  });
}

const product = await send({
  type: 'SAVE_MONITOR',
  monitor: {
    kind: 'product',
    name: '产品快照',
    links: [
      'https://www.goofish.com/item?id=100000000001',
      'https://www.goofish.com/item?id=100000000002'
    ],
    hour: 7,
    minute: 5,
    downloadFolder: '研究监控/商品',
    mode: 'rpa'
  }
});
assert.equal(product.ok, true);
assert.equal(product.monitor.kind, 'product');
assert.equal(product.monitor.links.length, 2);
assert.equal(product.monitor.hour, 7);
assert.equal(product.monitor.minute, 5);
assert.equal(product.monitor.downloadFolder, '研究监控/商品');
assert.ok(product.monitor.nextRunAt > Date.now());

const store = await send({
  type: 'SAVE_MONITOR',
  monitor: {
    kind: 'store',
    name: '店铺快照',
    links: ['https://www.goofish.com/personal?userId=store-1'],
    hour: 23,
    minute: 40,
    downloadFolder: '研究监控/店铺',
    mode: 'api'
  }
});
assert.equal(store.ok, true);
assert.equal(store.monitor.kind, 'store');
assert.equal(store.monitor.links.length, 1);
assert.equal(store.monitor.mode, 'api');

// 模拟 Service Worker 重启时仍有一条未完成的监控：恢复应安排短步骤，
// 而不是把本轮任务推迟到下一天。
storage.set(RUNS_KEY, {
  [store.monitor.id]: {
    id: 'monitor-run-recovery',
    monitorId: store.monitor.id,
    kind: 'store',
    links: [...store.monitor.links],
    index: 0,
    items: [],
    storeProfiles: [],
    failures: []
  }
});
alarms.delete(`xianyu_monitor_alarm_v1:${store.monitor.id}`);
await send({ type: 'GET_MONITORS' });
assert.ok(alarms.get(`xianyu_monitor_alarm_v1:${store.monitor.id}`)?.when - Date.now() < 5000);

// 编辑配置时，当前这一轮仍应继续推进；新链接和时间从下一轮开始生效。
const editedStore = await send({
  type: 'SAVE_MONITOR',
  monitor: {
    id: store.monitor.id,
    kind: 'store',
    name: store.monitor.name,
    links: store.monitor.links,
    hour: 2,
    minute: 20,
    downloadFolder: store.monitor.downloadFolder,
    mode: 'api',
    enabled: true
  }
});
assert.equal(editedStore.ok, true);
assert.equal(editedStore.monitor.hour, 2);
assert.ok(alarms.get(`xianyu_monitor_alarm_v1:${store.monitor.id}`)?.when - Date.now() < 5000);
storage.delete(RUNS_KEY);

const storedConfigs = storage.get(MONITORS_KEY);
assert.equal(storedConfigs.length, 2);
assert.equal(JSON.stringify(storedConfigs.map(item => item.kind).sort()), JSON.stringify(['product', 'store']));
assert.equal(storage.has(RUNS_KEY), false, 'saving a monitor must not create a normal or monitor run');
assert.equal(storage.has(JOB_KEY), false, 'saving a monitor must not occupy the normal task lock');
assert.ok([...alarms.keys()].every(name => name.startsWith('xianyu_monitor_alarm_v1:')));

const paused = await send({
  type: 'SET_MONITOR_ENABLED',
  monitorId: product.monitor.id,
  enabled: false
});
assert.equal(paused.ok, true);
assert.equal(paused.monitors.find(item => item.id === product.monitor.id).enabled, false);
assert.equal([...alarms.keys()].length, 1, 'pausing a monitor must clear only its own alarm');

const snapshot = await context.__monitorTestApi.monitorView();
assert.equal(snapshot.length, 2);
assert.equal(snapshot.find(item => item.id === product.monitor.id).running, false);

const panel = await fs.readFile(new URL('../sidepanel.js', import.meta.url), 'utf8');
const html = await fs.readFile(new URL('../sidepanel.html', import.meta.url), 'utf8');
for (const marker of ['GET_MONITORS', 'SAVE_MONITOR', 'RUN_MONITOR_NOW', 'monitorProductEntry', 'monitorStoreEntry']) {
  if (!panel.includes(marker) && !html.includes(marker)) throw new Error(`monitor UI marker missing: ${marker}`);
}

console.log(JSON.stringify({
  ok: true,
  monitors: storedConfigs.length,
  kinds: storedConfigs.map(item => item.kind),
  alarms: alarms.size,
  normalJobKeyPresent: storage.has(JOB_KEY)
}));
