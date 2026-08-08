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
  `${source}\n;globalThis.__stopTestApi = { scheduleJob, processJobAlarm };`,
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

console.log(JSON.stringify({
  ok: true,
  stoppedStatus: storage.get(JOB_KEY).status,
  removedTabs,
  clearedAlarms: clearedAlarms.length,
  createdAlarms: createdAlarms.length
}));
