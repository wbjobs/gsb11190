'use strict';
// 冒烟测试：用 DOM mock 驱动 app.js，验证打字机核心行为
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

function makeEl() {
  const el = {
    children: [],
    style: {},
    className: '',
    textContent: '',
    value: '',
    disabled: false,
    clientWidth: 520,
    clientHeight: 90,
    width: 520,
    height: 90,
    scrollTop: 0,
    scrollHeight: 0,
    listeners: {},
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    appendChild(c) { this.children.push(c); return c; },
    getContext() {
      return {
        setTransform() {}, clearRect() {}, beginPath() {}, moveTo() {},
        lineTo() {}, stroke() {}, fillText() {}, setLineDash() {},
        strokeStyle: '', fillStyle: '', font: '', lineWidth: 0,
      };
    },
  };
  return el;
}

function createEnv() {
  const ids = [
    'input', 'output', 'btnSample', 'btnStart', 'btnPause', 'btnResume',
    'btnReset', 'speed', 'speedLabel', 'statFps', 'statFrame', 'statChars',
    'statEta', 'statLongtask', 'statDegrade', 'fpsCanvas',
  ];
  const els = {};
  for (const id of ids) els[id] = makeEl();
  els.speed.value = '60'; // 60 字/秒，便于计算

  let rafQueue = [];
  const docListeners = {};
  const sandbox = {
    document: {
      hidden: false,
      getElementById: (id) => els[id],
      createTextNode: (data) => ({ data: data || '', appendData(s) { this.data += s; } }),
      createElement: () => makeEl(),
      addEventListener: (t, fn) => { (docListeners[t] ||= []).push(fn); },
    },
    window: { devicePixelRatio: 1 },
    performance: { now: () => nowMs },
    requestAnimationFrame: (fn) => { rafQueue.push(fn); return rafQueue.length; },
    cancelAnimationFrame: () => { rafQueue = []; },
    PerformanceObserver: class { observe() {} },
    console,
  };
  let nowMs = 0;
  vm.createContext(sandbox);
  const src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  vm.runInContext(src, sandbox);

  return {
    els,
    docListeners,
    setNow(ms) { nowMs = ms; },
    // 驱动一帧
    frame(dtMs) {
      nowMs += dtMs;
      const q = rafQueue;
      rafQueue = [];
      for (const fn of q) fn(nowMs);
    },
    click(id) { for (const fn of els[id].listeners.click || []) fn(); },
    getTextNode() {
      // output 的第一个子节点是文本节点
      return els.output.children[0];
    },
  };
}

// --- 用例 1：逐字推进 + 速度正确 ---
{
  const env = createEnv();
  env.els.input.value = '字'.repeat(100); // 100 字
  env.setNow(1000);
  env.click('btnStart'); // lastTime = 1000
  for (let i = 0; i < 60; i++) env.frame(16.7); // 约 1 秒
  const node = env.getTextNode();
  assert.ok(node.data.length >= 55 && node.data.length <= 65, `60字/秒 × 1秒 ≈ 60 字，实际 ${node.data.length}`);
  assert.strictEqual(node.data, '字'.repeat(node.data.length), '内容应逐字正确');
  console.log('✓ 用例1 逐字推进与速度正确，1秒显示', node.data.length, '字');
}

// --- 用例 2：暂停/继续位置精确 ---
{
  const env = createEnv();
  env.els.input.value = 'a'.repeat(1000);
  env.setNow(0);
  env.click('btnStart');
  for (let i = 0; i < 30; i++) env.frame(16.7);
  env.click('btnPause');
  const paused = env.getTextNode().data.length;
  for (let i = 0; i < 30; i++) env.frame(16.7); // 暂停期间帧不应推进
  assert.strictEqual(env.getTextNode().data.length, paused, '暂停期间不应新增字符');
  env.click('btnResume');
  for (let i = 0; i < 30; i++) env.frame(16.7);
  const resumed = env.getTextNode().data.length;
  assert.ok(resumed > paused, '继续后应继续推进');
  assert.ok(resumed - paused <= 35, `恢复后不应跳字，增量 ${resumed - paused}`);
  console.log('✓ 用例2 暂停/继续位置精确，暂停于', paused, '，恢复半秒后', resumed);
}

// --- 用例 3：后台恢复不跳字（dt 突增被夹紧） ---
{
  const env = createEnv();
  env.els.input.value = 'b'.repeat(100000);
  env.setNow(0);
  env.click('btnStart');
  for (let i = 0; i < 10; i++) env.frame(16.7);
  const before = env.getTextNode().data.length;
  env.frame(30_000); // 模拟后台 30 秒后恢复的一帧
  const after = env.getTextNode().data.length;
  assert.ok(after - before <= 10, `后台恢复最多补 100ms≈6 字，实际补 ${after - before}`);
  console.log('✓ 用例3 后台恢复不跳字，突增帧仅补', after - before, '字');
}

// --- 用例 4：10 万字高速跑完不崩 ---
{
  const env = createEnv();
  env.els.input.value = '字'.repeat(100000);
  env.els.speed.value = '2000';
  // 重新触发 input 事件让速度生效
  for (const fn of env.els.speed.listeners.input || []) fn();
  env.setNow(0);
  env.click('btnStart');
  let frames = 0;
  while (env.getTextNode().data.length < 100000 && frames < 20000) {
    env.frame(16.7);
    frames++;
  }
  assert.strictEqual(env.getTextNode().data.length, 100000, '10 万字应全部显示');
  assert.ok(env.els.statEta.textContent.includes('完成'), '完成后应显示已完成');
  console.log('✓ 用例4 10 万字在', frames, '帧内全部显示，未崩溃');
}

// --- 用例 5：重置 ---
{
  const env = createEnv();
  env.els.input.value = '重置测试文本';
  env.setNow(0);
  env.click('btnStart');
  for (let i = 0; i < 10; i++) env.frame(16.7);
  env.click('btnReset');
  assert.strictEqual(env.getTextNode().data, '', '重置后输出应为空');
  assert.ok(env.els.statChars.textContent.startsWith('0'), '重置后计数应归零');
  console.log('✓ 用例5 重置正确');
}

console.log('\n全部冒烟测试通过');
