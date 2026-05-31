/* ═══════════════════════════════════════════════
   timer.js — 計時器核心邏輯
   修改這裡：訓練秒數、休息秒數、組數預設值、音效
   ═══════════════════════════════════════════════ */

// ─── 訓練模式預設值 ──────────────────────────────
// 想改預設秒數就在這裡改，不用動其他地方
const TRANSITION_SEC = 120;  // 換動作之間的緩衝秒數

const MODES = {
  warmup:     { label:'熱身組',   work:60,  rest:15, sets:2 },
  unilateral: { label:'單邊訓練', work:90,  rest:30, sets:8 },
  bilateral:  { label:'雙邊訓練', work:90,  rest:45, sets:4 }
};

// ─── 狀態變數（程式的「記憶體」）────────────────
let routine          = [];      // 課表動作清單
let actionIdx        = 0;       // 目前在第幾個動作
let setIdx           = 0;       // 目前在第幾組
let phase            = 'IDLE';  // 目前階段：IDLE/WORK/REST/TRANSITION/PAUSED
let timerId          = null;    // setInterval 的 id，用來清除計時器
let totalActive      = 0;       // 累計實際訓練秒數（只算 WORK）
let totalActiveBase  = 0;       // 暫停前已累積的 WORK 秒數基準
let completedSets    = 0;       // 已完成組數
let completedActions = 0;       // 已完成動作數
let currentSide      = 'L';     // 單邊動作：目前是左(L)或右(R)
let sessionLog       = [];      // 每個動作完成後的紀錄文字
let isRunning        = false;
let isPaused         = false;
let pausedAt         = null;    // 暫停當下的時間戳

// 計時核心：儲存「這個階段何時結束」的絕對時間戳
// 用真實時鐘而不是計數器，手機睡醒後不會有誤差
let phaseEndTime  = null;
let phaseTotal    = 0;

// 總訓練壁鐘時間（按下開始到結束）
let wallclockStart = null;
let wallclockEnd   = null;
let wallclockTimer = null;

// ─── 防螢幕休眠（iPhone 相容）────────────────────
let wakeLock = null;

// 在記憶體中製作一個 1×1 的無聲影片，讓 Safari 誤以為在播放影片
// Safari 不支援 Wake Lock API，但播放中的影片會讓螢幕保持開啟
function buildWakeVideo() {
  const video = document.getElementById('wake-video');
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 1; canvas.height = 1;
    const stream = canvas.captureStream(1);
    const mr = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' });
    const chunks = [];
    mr.ondataavailable = e => chunks.push(e.data);
    mr.onstop = () => {
      const blob = new Blob(chunks, { type: 'video/webm' });
      video.src = URL.createObjectURL(blob);
    };
    mr.start(); setTimeout(() => mr.stop(), 500);
  } catch(e) {
    console.log('Wake video 建立失敗（舊版 Safari）:', e.message);
  }
}

async function requestWakeLock() {
  const video = document.getElementById('wake-video');
  // 方法一：標準 Wake Lock API（Chrome / Android 用）
  if ('wakeLock' in navigator) {
    try { wakeLock = await navigator.wakeLock.request('screen'); } catch(e) {}
  }
  // 方法二：隱藏影片（Safari / iPhone 用）
  if (video.src) video.play().catch(() => {});
}

function releaseWakeLock() {
  const video = document.getElementById('wake-video');
  video.pause();
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
}

// 回到前景時重新取得防休眠，並補償睡著期間流逝的時間
document.addEventListener('visibilitychange', async () => {
  if (!document.hidden && isRunning && !isPaused) {
    await requestWakeLock();
    rescheduleAfterWake();
  }
});

// ─── 音效系統 ────────────────────────────────────
// 直接用程式碼合成音效，不需要音效檔案
let audioCtx = null;
function getAudio() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}
function playTone(freq, dur, type='sine', vol=0.12) {
  const ctx = getAudio();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, ctx.currentTime);
  gain.gain.setValueAtTime(vol, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur/1000);
  osc.connect(gain); gain.connect(ctx.destination);
  osc.start(); osc.stop(ctx.currentTime + dur/1000);
}
function playBeep()   { playTone(660, 120); }                          // 最後3秒倒數音
function playTimeUp() {                                                  // 階段結束音
  playTone(880, 400, 'sine', 0.15);
  setTimeout(() => playTone(880, 400, 'sine', 0.12), 420);
}
function playFinish() {                                                  // 全部完成音（Do-Mi-Sol）
  [523, 659, 784].forEach((f, i) => setTimeout(() => playTone(f, 300, 'sine', 0.13), i * 180));
}

// ─── 計時器核心 ───────────────────────────────────
function clearTimer() {
  if (timerId !== null) { clearInterval(timerId); timerId = null; }
}

// 啟動任何一個新階段
// 關鍵：儲存「何時結束」的絕對時間點，而不是倒數計數器
// 這樣手機睡著後醒來，只要做一次減法就能得到正確的剩餘秒數
function startPhase(p) {
  const action = routine[actionIdx];
  if (!action) return; // 安全防護
  
  // 【核心修正】從全域 MODES 取得該動作型態的秒數設定
  const m = MODES[action.type]; 
  phase = p;
  
  let durationSec;
  if (p === 'WORK')            durationSec = m.work;       // 修正：從 m 讀取
  else if (p === 'REST')       durationSec = m.rest;       // 修正：從 m 讀取
  else if (p === 'TRANSITION') durationSec = TRANSITION_SEC;
  
  phaseTotal   = durationSec;
  phaseEndTime = Date.now() + durationSec * 1000;  // 絕對終止時間
  updateUI();
  clearTimer();
  timerId = setInterval(tick, 500);  // 每 0.5 秒查看一次真實時鐘
}
// 每 0.5 秒執行一次
// 不做加減法，直接用「終止時間 - 現在」算出剩餘秒數
function tick() {
  if (!isRunning || isPaused) return;

  const now = Date.now();
  const remaining = Math.max(0, Math.ceil((phaseEndTime - now) / 1000));

  // 累計實際訓練秒數：用已過時間算，而不是手動計數
  if (phase === 'WORK') {
    const workElapsed = phaseTotal - remaining;
    totalActive = totalActiveBase + workElapsed;
  }

  // 最後3秒提示音（只在秒數真正改變時才響）
  if ((phase === 'REST' || phase === 'TRANSITION') && remaining <= 3 && remaining > 0) {
    const prevRemaining = Math.ceil((phaseEndTime - (now - 500)) / 1000);
    if (prevRemaining !== remaining) playBeep();
  }

  updateUI_remaining(remaining);

  // 時間到：清除計時器並進入下一階段
  if (remaining <= 0 && now >= phaseEndTime) {
    clearTimer();
    onPhaseEnd();
  }
}

// 頁面從背景回到前景後，如果時間已過期則立刻跳到下一階段
function rescheduleAfterWake() {
  if (phaseEndTime && Date.now() >= phaseEndTime) {
    clearTimer();
    onPhaseEnd();
  }
}

// ─── 階段轉換邏輯（計時器的大腦）────────────────
// 每次一個階段結束，這裡決定下一步
function onPhaseEnd() {
  const action = routine[actionIdx];
  if (!action) return;
  const m = MODES[action.type]; // 【核心修正】取得當前動作的設定檔

  // WORK 結束 → 休息
  if (phase === 'WORK') {
    totalActive = totalActiveBase + phaseTotal;
    totalActiveBase = totalActive;
    playTimeUp();
    startPhase('REST');
    return;
  }

  // REST 結束 → 看還有沒有下一組
  if (phase === 'REST') {
    completedSets++;
    setIdx++;
    if (setIdx < m.sets) { // 修正：使用 m.sets 判定
      // 還有下一組：單邊動作切換左右側，繼續 WORK
      if (action.type === 'unilateral') currentSide = currentSide === 'L' ? 'R' : 'L';
      playTimeUp();
      startPhase('WORK');
      return;
    }

    // 這個動作所有組數完成
    completedActions++;
    
    // 【核心修正】串接結算文字，使用 m.label 與 m.sets 替代原本的 undefined 欄位
    const note   = action.note   || '';
    const weight = action.weight || '';
    const detail = [note, weight ? weight + 'kg' : ''].filter(Boolean).join(' · ');
    sessionLog.push(`✓ ${m.label}${detail ? '（' + detail + '）' : ''} — ${m.sets}組完成`);
    
    actionIdx++;
    setIdx = 0;
    currentSide = 'L';
    renderList();
    
    if (actionIdx < routine.length) {
      // 還有下一個動作：進入換動作緩衝
      playTimeUp();
      startPhase('TRANSITION');
    } else {
      // 全部課表完成
      finishAll();
    }
    return;
  }

  // TRANSITION 結束 → 開始新動作
  if (phase === 'TRANSITION') {
    playTimeUp();
    startPhase('WORK');
    return;
  }
}

function finishAll() {
  playFinish();
  phase = 'IDLE';
  isRunning = false;
  wallclockEnd = Date.now();
  clearInterval(wallclockTimer); wallclockTimer = null;
  releaseWakeLock();
  updateWallclock();
  showSummary(true);
}

// ─── 壁鐘（總訓練時長）────────────────────────────
function updateWallclock() {
  const el = document.getElementById('wallclock-display');
  if (!wallclockStart) { el.textContent = '—'; return; }
  const end = wallclockEnd || Date.now();
  el.textContent = fmtTime(Math.floor((end - wallclockStart) / 1000));
}

// ─── 控制按鈕 ────────────────────────────────────
function handleStart() {
  if (!routine.length) { alert('請先在課表安排頁加入訓練動作'); return; }
  getAudio();  // 第一次使用者互動時解鎖音效

  if (isPaused) {
    // 繼續：把 phaseEndTime 往後移暫停的時間，剩餘秒數就等於暫停前的值
    const pausedMs = Date.now() - pausedAt;
    phaseEndTime += pausedMs;
    isPaused = false; isRunning = true;
    timerId = setInterval(tick, 500);
    if (!wallclockTimer) wallclockTimer = setInterval(updateWallclock, 1000);
    requestWakeLock();
     updateUI();
    updateBtns();
    return;
  }

  if (!isRunning) {
    isRunning = true;
    actionIdx = 0; setIdx = 0; currentSide = 'L';
    completedSets = 0; completedActions = 0;
    totalActive = 0; totalActiveBase = 0;
    sessionLog = [];
    wallclockStart = Date.now(); wallclockEnd = null;
    wallclockTimer = setInterval(updateWallclock, 1000);
    startPhase('WORK');
    requestWakeLock();
    updateBtns();
    renderList();
  }
}


function handlePause() {
  if (!isRunning) return;
  pausedAt = Date.now();
  // 暫停時先把當前的 WORK 累計秒數存好
  if (phase === 'WORK') {
    const remaining = Math.max(0, Math.ceil((phaseEndTime - pausedAt) / 1000));
    totalActive = totalActiveBase + (phaseTotal - remaining);
    totalActiveBase = totalActive;
  }
  isPaused = true; isRunning = false;
  clearTimer();
  clearInterval(wallclockTimer); wallclockTimer = null;
  releaseWakeLock();
  updateUI(); updateBtns();
}

function handleEarly() {
  if (!isRunning) return;
  clearTimer();
  phaseEndTime = Date.now();  // 把終止時間點設成「現在」，等於立刻過期
  onPhaseEnd();
}

function handleStop() {
  clearTimer();
  clearInterval(wallclockTimer); wallclockTimer = null;
  isRunning = false; isPaused = false; phase = 'IDLE';
  wallclockEnd = Date.now();
  releaseWakeLock();
  updateWallclock();
  showSummary(false);
}

function resetAll() {
  clearTimer();
  clearInterval(wallclockTimer); wallclockTimer = null;
  isRunning = false; isPaused = false; phase = 'IDLE';
  actionIdx = 0; setIdx = 0; phaseEndTime = null; phaseTotal = 0;
  totalActive = 0; totalActiveBase = 0;
  completedSets = 0; completedActions = 0;
  sessionLog = []; currentSide = 'L';
  wallclockStart = null; wallclockEnd = null; pausedAt = null;
  releaseWakeLock();
  document.getElementById('summary').classList.remove('show');
  updateUI(); updateBtns(); updateWallclock(); renderList();
  document.getElementById('elapsed-display').textContent = '00:00';
}

// ─── 課表管理 ────────────────────────────────────
let itemCounter = 0;

function addItem(type) {
  // 精簡資料結構：只記錄必要的唯一 id、型態、以及使用者輸入的備註與重量
  routine.push({ id: ++itemCounter, type, note: '', weight: '' });
  renderList();
}

function removeItem(id) {
  routine = routine.filter(r => r.id !== id);
  renderList();
}

// 從輸入欄更新動作備註或重量到 routine 資料裡
function updateItemField(id, field, value) {
  const item = routine.find(r => r.id === id);
  if (item) item[field] = value;
}

function renderList() {
  const el = document.getElementById('routine-list');
  document.getElementById('routine-count').textContent = routine.length + ' 個動作';

  if (!routine.length) {
    el.innerHTML = '<div class="routine-empty">按上方按鈕<br>加入訓練動作</div>';
    updateEstimatedTime(); 
    return;
  }

  el.innerHTML = routine.map((item, i) => {
    // 渲染時，動態從全域的 MODES 讀取該型態的設定值
    const m = MODES[item.type];
    
    return `
      <div class="routine-item ${i===actionIdx&&isRunning?'active':''} ${i<actionIdx&&isRunning?'done':''}">
        <div class="item-top">
          <div class="item-dot ${item.type}"></div>
          <div class="item-label">
            <div class="item-name">${m.label}</div>
            <div class="item-meta">${fmtSec(m.work)} · 休${fmtSec(m.rest)} · ${m.sets}組</div>
          </div>
          <button class="item-del" onclick="removeItem(${item.id})">✕</button>
        </div>
        <div class="item-inputs">
          <input
            class="item-input"
            type="text"
            placeholder="動作名稱（例：深蹲、臥推）"
            value="${escHtml(item.note)}"
            oninput="updateItemField(${item.id}, 'note', this.value)"
          />
          <input
            class="item-input weight"
            type="number"
            placeholder="kg"
            value="${item.weight}"
            min="0" step="0.5"
            oninput="updateItemField(${item.id}, 'weight', this.value)"
          />
        </div>
      </div>
    `;
  }).join('');

  renderProgressDots();
  updateEstimatedTime(); 
}

function renderProgressDots() {
  const el = document.getElementById('progress-dots');
  if (!routine.length) { el.innerHTML = ''; return; }
  const max = Math.min(routine.length, 10);
  el.innerHTML = Array.from({length:max}, (_,i) => {
    const cls = i < actionIdx ? 'done' : (i===actionIdx&&isRunning ? 'active' : '');
    return `<div class="prog-dot ${cls}"></div>`;
  }).join('');
}


// ─── 超精簡：自動讀取組合 ＆ 格式化顯示「X分X秒」 ───
function updateEstimatedTime() {
  const estDisplay = document.getElementById('est-time-display');
  if (!estDisplay) return; 

  if (!routine.length) {
    estDisplay.innerText = '預估時間: 0分0秒';
    return;
  }

  let totalSeconds = 0;
  const transitionTime = 120; // 換動作休息 2 分鐘 = 120 秒

  routine.forEach((item, index) => {
    // 關鍵優化：直接讀取主設定 MODES，完全不用怕 item 裡面少帶資料
    const config = MODES[item.type];
    if (!config) return;

    const work = parseInt(config.work) || 0;
    const rest = parseInt(config.rest) || 0;
    const sets = parseInt(config.sets) || 0;

    if (sets > 0) {
      // 計算單個動作總長度
      const actionTime = (work * sets) + (rest * (sets - 1));
      totalSeconds += actionTime;
      
      // 若非最後一個動作，加上換動作的 2 分鐘
      if (index < routine.length - 1) {
        totalSeconds += transitionTime;
      }
    }
  });

  // 計算分與秒（不再盲目進位，精準呈現秒數）
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  // 格式化輸出
  estDisplay.innerText = `預估時間: ${minutes}分${seconds}秒`;
}
// ─── UI 更新 ──────────────────────────────────────
let lastDisplayedRemaining = -1;

// 快速路徑：每 0.5 秒只更新數字和進度條，不重繪整個畫面
function updateUI_remaining(remaining) {
  if (remaining === lastDisplayedRemaining) return;
  lastDisplayedRemaining = remaining;

  const bt   = document.getElementById('big-time');
  const fill = document.getElementById('prog-fill');

  bt.textContent = fmtTime(remaining);
  bt.className   = 'big-time';
  if (phase === 'WORK')       bt.classList.add(remaining <= 3 && remaining > 0 ? 'countdown' : 'work');
  else if (phase === 'REST')  bt.classList.add(remaining <= 3 && remaining > 0 ? 'countdown' : 'rest');
  else if (phase === 'TRANSITION') bt.classList.add(remaining <= 3 && remaining > 0 ? 'countdown' : 'trans');

  const pct = phaseTotal > 0 ? Math.round((1 - remaining / phaseTotal) * 100) : 0;
  fill.style.width = pct + '%';
  document.getElementById('elapsed-display').textContent = fmtTime(totalActive);
}

// 完整重繪：階段切換時呼叫（背景顏色、標籤、組數點等全部更新）
function updateUI() {
  const bt         = document.getElementById('big-time');
  const pb         = document.getElementById('phase-badge');
  const fill       = document.getElementById('prog-fill');
  const sideBadge  = document.getElementById('side-badge');
  const setsText   = document.getElementById('sets-text');
  const curName    = document.getElementById('current-name');
  const pips       = document.getElementById('sets-pips');
  const timerPanel = document.getElementById('timer-panel');
  
  const action     = routine[actionIdx];
  const m          = action ? MODES[action.type] : null; // 【核心修正】動態獲取當前 Mode 設定
  
  const remaining = phaseEndTime ? Math.max(0, Math.ceil((phaseEndTime - Date.now()) / 1000)) : (m ? m.work : 90);
  
  document.getElementById('elapsed-display').textContent = fmtTime(totalActive);
  bt.textContent = fmtTime(remaining);
  bt.className   = 'big-time';
  pb.className   = 'phase-badge';
  fill.className = 'progress-bar-fill';
  
  if (isPaused) {
    timerPanel.style.background = '#16161e';
    pb.textContent = '暫停中';
  } else if (phase === 'WORK') {
    timerPanel.style.background = '#071c3a';
    bt.classList.add(remaining <= 3 && remaining > 0 ? 'countdown' : 'work');
    pb.textContent = '訓練中';
    pb.classList.add('work');
  } else if (phase === 'REST') {
    timerPanel.style.background = '#1f1200';
    bt.classList.add(remaining <= 3 && remaining > 0 ? 'countdown' : 'rest');
    pb.textContent = '休息中';
    pb.classList.add('rest');
    fill.classList.add('rest');
  } else if (phase === 'TRANSITION') {
    timerPanel.style.background = '#0a1f12';
    bt.classList.add(remaining <= 3 && remaining > 0 ? 'countdown' : 'trans');
    pb.textContent = '換動作';
    pb.classList.add('trans');
    fill.classList.add('trans');
  } else {
    timerPanel.style.background = '#1c2030';
    pb.textContent = '準備';
    bt.textContent = m ? fmtTime(m.work) : '01:30';
  }
  
  const pct = phaseTotal > 0 ? Math.round((1 - remaining / phaseTotal) * 100) : 0;
  fill.style.width = pct + '%';
  
  if (phase === 'TRANSITION') {
    const nextAction = routine[actionIdx];
    const nextM = nextAction ? MODES[nextAction.type] : null;
    curName.textContent = nextM ? '準備：' + nextM.label : '換動作中';
  } else {
    curName.textContent = m ? m.label : (isRunning ? '全部完成！' : '尚未開始');
  }
  
  if (action && action.type === 'unilateral' && isRunning && phase === 'WORK') {
    sideBadge.style.opacity = '1';
    sideBadge.textContent = currentSide === 'L' ? '左側' : '右側';
  } else {
    sideBadge.style.opacity = '0';
  }
  
  // ─── 修正組數小點點與文字顯示 ─────────────────
  const pipAction = (phase === 'TRANSITION') ? routine[actionIdx] : action;
  const pipM = pipAction ? MODES[pipAction.type] : null; // 【核心修正】改撈 Mode 的設定值
  
  if (pipM && phase !== 'TRANSITION') {
    pips.innerHTML = Array.from({length: pipM.sets}, (_, i) => { // 修正：pipM.sets
      const cls = i < setIdx ? 'done' : (i === setIdx ? (phase === 'REST' ? 'rest-active' : 'active') : '');
      return `<div class="set-pip ${cls}"></div>`;
    }).join('');
    setsText.textContent = `第 ${setIdx + 1} / ${pipM.sets} 組`; // 修正：pipM.sets
  } else if (phase === 'TRANSITION' && pipM) {
    pips.innerHTML = Array.from({length: pipM.sets}, () => `<div class="set-pip"></div>`).join('');
    setsText.textContent = `共 ${pipM.sets} 組`;
  } else {
    pips.innerHTML = '';
    setsText.textContent = '—';
  }
  
  renderProgressDots();
  lastDisplayedRemaining = -1;
}

function updateBtns() {
  const a = isRunning, p = isPaused;
  document.getElementById('btn-start').disabled = a && !p;
  document.getElementById('btn-pause').disabled = !a;
  document.getElementById('btn-early').disabled = !a|| p;
  document.getElementById('btn-stop').disabled  = !a && !p;
  document.getElementById('btn-start').children[1].textContent = p ? '繼續' : '開始';
  document.getElementById('btn-start').children[0].textContent = '▶';
}

// ─── 格式化工具函式 ───────────────────────────────
function fmtTime(s) {
  s = Math.max(0, Math.round(s));
  const m = Math.floor(s / 60), sec = s % 60;
  return (m < 10 ? '0' + m : m) + ':' + (sec < 10 ? '0' + sec : sec);
}
function fmtSec(s) {
  return s >= 60 ? Math.floor(s/60) + '分' + (s % 60 ? s % 60 + '秒' : '') : s + '秒';
}
// 防止使用者輸入的文字裡有 HTML 特殊字元造成 XSS 問題
function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
