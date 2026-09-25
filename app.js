'use strict';

// ---------- DOM ----------
const inputEl = document.getElementById('input');
const outputEl = document.getElementById('output');
const btnSample = document.getElementById('btnSample');
const btnStart = document.getElementById('btnStart');
const btnPause = document.getElementById('btnPause');
const btnResume = document.getElementById('btnResume');
const btnReset = document.getElementById('btnReset');
const speedEl = document.getElementById('speed');
const speedLabel = document.getElementById('speedLabel');
const statFps = document.getElementById('statFps');
const statFrame = document.getElementById('statFrame');
const statChars = document.getElementById('statChars');
const statEta = document.getElementById('statEta');
const statLongtask = document.getElementById('statLongtask');
const statDegrade = document.getElementById('statDegrade');
const fpsCanvas = document.getElementById('fpsCanvas');
const fpsCtx = fpsCanvas.getContext('2d');

// 输出区使用单个文本节点，增量 appendData，避免每次重建整段字符串
const textNode = document.createTextNode('');
const cursorEl = document.createElement('span');
cursorEl.className = 'cursor';
outputEl.appendChild(textNode);
outputEl.appendChild(cursorEl);

// ---------- 状态 ----------
const MAX_DT_MS = 100; // 单帧最大补偿时长：后台切回时不一次性补字（不跳字）
const state = {
  text: '',
  speed: Number(speedEl.value), // 字/秒
  index: 0,      // 逻辑上应显示到的字符位置
  domIndex: 0,   // 已写入 DOM 的字符位置
  carry: 0,      // 不足 1 字的小数累积
  playing: false,
  finished: false,
  rafId: 0,
  lastTime: 0,
  frameNo: 0,
  degrade: 0,    // 0=每帧更新DOM 1=每2帧 2=每4帧 3=每8帧
};

// ---------- FPS 统计 ----------
const FPS_SAMPLE_MS = 500;
const fpsHistory = []; // {fps, t}
const FPS_HISTORY_MAX = 240; // 约 2 分钟
let fpsFrames = 0;
let fpsWindowStart = 0;
let currentFps = 0;
let currentFrameMs = 0;
let lowFpsSince = 0;
let highFpsSince = 0;

// ---------- 长任务监控 ----------
let longtaskCount = 0;
try {
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      longtaskCount += 1;
      statLongtask.textContent = String(longtaskCount);
    }
  });
  observer.observe({ entryTypes: ['longtask'] });
} catch (e) {
  statLongtask.textContent = '不支持';
}

// ---------- 打字机核心 ----------
function tick(now) {
  if (!state.playing) return;
  state.rafId = requestAnimationFrame(tick);

  // 夹紧 dt：标签页从后台恢复时 now 会突增，夹紧后只按正常步长继续，不跳字
  const dt = Math.min(now - state.lastTime, MAX_DT_MS);
  state.lastTime = now;

  // FPS 统计
  fpsFrames += 1;
  state.frameNo += 1;
  if (fpsWindowStart === 0) fpsWindowStart = now;
  const windowElapsed = now - fpsWindowStart;
  if (windowElapsed >= FPS_SAMPLE_MS) {
    currentFps = (fpsFrames * 1000) / windowElapsed;
    currentFrameMs = windowElapsed / fpsFrames;
    fpsFrames = 0;
    fpsWindowStart = now;
    fpsHistory.push({ fps: currentFps, t: now });
    if (fpsHistory.length > FPS_HISTORY_MAX) fpsHistory.shift();
    updateDegrade(now);
    renderStats();
    drawFpsChart();
  }

  // 按速度推进字符
  if (!state.finished) {
    state.carry += (state.speed * dt) / 1000;
    const step = Math.floor(state.carry);
    if (step > 0) {
      state.carry -= step;
      state.index = Math.min(state.index + step, state.text.length);
      if (state.index >= state.text.length) {
        state.finished = true;
        state.carry = 0;
      }
    }
    // 低端设备降级：降低 DOM 写入频率（每 2/4/8 帧写一次）
    const frameMod = 1 << state.degrade;
    if ((state.domIndex < state.index && state.frameNo % frameMod === 0) || state.finished) {
      flushDom();
    }
    if (state.finished) {
      setPlaying(false);
      updateButtons();
    }
  }
}

function flushDom() {
  if (state.domIndex >= state.index) return;
  textNode.appendData(state.text.slice(state.domIndex, state.index));
  state.domIndex = state.index;
  // 保持输出区滚动到底部
  outputEl.scrollTop = outputEl.scrollHeight;
}

// ---------- 降级策略 ----------
function updateDegrade(now) {
  if (state.degrade < 3 && currentFps > 0 && currentFps < 45) {
    if (lowFpsSince === 0) lowFpsSince = now;
    if (now - lowFpsSince > 1500) {
      state.degrade += 1;
      lowFpsSince = 0;
      renderDegrade();
    }
  } else {
    lowFpsSince = 0;
  }
  if (state.degrade > 0 && currentFps > 55) {
    if (highFpsSince === 0) highFpsSince = now;
    if (now - highFpsSince > 5000) {
      state.degrade -= 1;
      highFpsSince = 0;
      renderDegrade();
    }
  } else {
    highFpsSince = 0;
  }
}

function renderDegrade() {
  statDegrade.textContent = state.degrade === 0 ? '无' : `每 ${1 << state.degrade} 帧写 DOM`;
  statDegrade.className = 'value' + (state.degrade > 0 ? ' warn' : '');
}

// ---------- 渲染 ----------
function renderStats() {
  statFps.textContent = currentFps > 0 ? currentFps.toFixed(1) : '—';
  statFps.className = 'value' + (currentFps > 0 && currentFps < 45 ? ' bad' : '');
  statFrame.textContent = currentFrameMs > 0 ? currentFrameMs.toFixed(1) + ' ms' : '—';
  statChars.textContent = `${state.index} / ${state.text.length}`;
  const remaining = state.text.length - state.index;
  statEta.textContent = state.finished || state.text.length === 0
    ? (state.finished ? '已完成' : '—')
    : formatEta(remaining / state.speed);
}

function formatEta(seconds) {
  if (!isFinite(seconds) || seconds < 0) return '—';
  if (seconds < 1) return '< 1 秒';
  const s = Math.ceil(seconds);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m > 0 ? `${m} 分 ${r} 秒` : `${r} 秒`;
}

function drawFpsChart() {
  const dpr = window.devicePixelRatio || 1;
  const w = fpsCanvas.clientWidth;
  const h = fpsCanvas.clientHeight;
  if (fpsCanvas.width !== w * dpr || fpsCanvas.height !== h * dpr) {
    fpsCanvas.width = w * dpr;
    fpsCanvas.height = h * dpr;
  }
  fpsCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  fpsCtx.clearRect(0, 0, w, h);

  const maxFps = 120;
  // 60 FPS 参考线
  const y60 = h - (60 / maxFps) * h;
  fpsCtx.strokeStyle = 'rgba(139,147,167,0.35)';
  fpsCtx.setLineDash([4, 4]);
  fpsCtx.beginPath();
  fpsCtx.moveTo(0, y60);
  fpsCtx.lineTo(w, y60);
  fpsCtx.stroke();
  fpsCtx.setLineDash([]);
  fpsCtx.fillStyle = 'rgba(139,147,167,0.8)';
  fpsCtx.font = '10px sans-serif';
  fpsCtx.fillText('60', 4, y60 - 3);

  if (fpsHistory.length < 2) return;
  fpsCtx.strokeStyle = '#2f6fed';
  fpsCtx.lineWidth = 1.5;
  fpsCtx.beginPath();
  const stepX = w / (FPS_HISTORY_MAX - 1);
  const offset = FPS_HISTORY_MAX - fpsHistory.length;
  for (let i = 0; i < fpsHistory.length; i++) {
    const x = (i + offset) * stepX;
    const y = h - Math.min(fpsHistory[i].fps, maxFps) / maxFps * h;
    if (i === 0) fpsCtx.moveTo(x, y);
    else fpsCtx.lineTo(x, y);
  }
  fpsCtx.stroke();
}

// ---------- 控制 ----------
function setPlaying(playing) {
  state.playing = playing;
  if (playing) {
    state.lastTime = performance.now();
    fpsWindowStart = 0;
    fpsFrames = 0;
    state.rafId = requestAnimationFrame(tick);
  } else {
    cancelAnimationFrame(state.rafId);
    flushDom(); // 暂停/结束时把未写入的字符补齐，保证位置精确
    renderStats();
  }
}

function updateButtons() {
  const hasText = state.text.length > 0;
  const started = state.index > 0 || state.playing;
  btnStart.disabled = state.playing || (!state.finished && started) || !hasText;
  btnPause.disabled = !state.playing;
  btnResume.disabled = state.playing || !started || state.finished;
  btnReset.disabled = !started && !hasText;
}

btnStart.addEventListener('click', () => {
  state.text = inputEl.value;
  if (state.text.length === 0) return;
  state.index = 0;
  state.domIndex = 0;
  state.carry = 0;
  state.finished = false;
  textNode.data = '';
  cursorEl.style.display = '';
  setPlaying(true);
  updateButtons();
  renderStats();
});

btnPause.addEventListener('click', () => {
  setPlaying(false);
  updateButtons();
});

btnResume.addEventListener('click', () => {
  if (state.finished || state.index >= state.text.length) return;
  setPlaying(true); // lastTime 重置为当前时刻，从暂停位置继续，不补帧
  updateButtons();
});

btnReset.addEventListener('click', () => {
  setPlaying(false);
  state.index = 0;
  state.domIndex = 0;
  state.carry = 0;
  state.finished = false;
  textNode.data = '';
  fpsHistory.length = 0;
  currentFps = 0;
  currentFrameMs = 0;
  longtaskCount = 0;
  statLongtask.textContent = '0';
  state.degrade = 0;
  renderDegrade();
  renderStats();
  drawFpsChart();
  updateButtons();
});

speedEl.addEventListener('input', () => {
  state.speed = Number(speedEl.value);
  speedLabel.textContent = `${state.speed} 字/秒`;
  renderStats(); // 速度变化立即刷新剩余时间估算
});

// 标签页可见性：后台时 rAF 自动停止；恢复时重置计时基准，防止 dt 突增跳字
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.playing) {
    state.lastTime = performance.now();
    fpsWindowStart = 0;
    fpsFrames = 0;
  }
});

// ---------- 10 万字测试文本 ----------
btnSample.addEventListener('click', () => {
  const paragraph =
    '打字机效果测试文本。The quick brown fox jumps over the lazy dog. ' +
    '0123456789，逐字显示、速度可调、暂停继续、性能监控。';
  const target = 100000;
  const parts = [];
  let len = 0;
  let i = 0;
  while (len < target) {
    parts.push(`【${String(++i).padStart(4, '0')}】`, paragraph, '\n');
    len += paragraph.length + 8;
  }
  inputEl.value = parts.join('');
  state.text = '';
  updateButtons();
});

updateButtons();
renderDegrade();
