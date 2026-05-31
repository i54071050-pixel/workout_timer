/* ═══════════════════════════════════════════════
   storage.js — 結算顯示與匯出到 Apple 備忘錄
   修改這裡：結算版面、匯出格式、備忘錄文字樣式
   ═══════════════════════════════════════════════ */

// ─── 結算畫面 ─────────────────────────────────────
function showSummary(complete) {
  document.getElementById('summary-title').textContent = complete ? '🎉 訓練完成！' : '訓練結算';

  // 總訓練壁鐘時長（按下開始到結束的真實時間）
  if (wallclockStart) {
    const end  = wallclockEnd || Date.now();
    document.getElementById('sum-wallclock').textContent = fmtTime(Math.floor((end - wallclockStart) / 1000));
  } else {
    document.getElementById('sum-wallclock').textContent = '—';
  }

  document.getElementById('sum-active').textContent  = fmtTime(totalActive);
  document.getElementById('sum-sets').textContent    = completedSets;
  document.getElementById('sum-actions').textContent = completedActions;

  // 動作完成紀錄
  const log = document.getElementById('summary-log');
  log.innerHTML = sessionLog.length
    ? sessionLog.map(l => `<div>${escHtml(l)}</div>`).join('')
    : '<div>尚無完成紀錄</div>';

  document.getElementById('summary').classList.add('show');
}

function buildNotesText() {
  // 取得今天的日期，格式：2025/05/29
  const today = new Date();
  const dateStr = today.getFullYear() + '/' +
    String(today.getMonth() + 1).padStart(2, '0') + '/' +
    String(today.getDate()).padStart(2, '0');

  // 計算總訓練壁鐘時長
  let totalStr = '—';
  if (wallclockStart) {
    const end  = wallclockEnd || Date.now();
    totalStr = fmtTime(Math.floor((end - wallclockStart) / 1000));
  }

  // 組合備忘錄的文字內容
  // 每一行用 \n 換行
  const lines = [
    `🏋️ 健身紀錄 ${dateStr}`,
    ``,
    `⏱ 總時長：${totalStr}`,
    `💪 訓練秒：${fmtTime(totalActive)}`,
    `📊 完成組數：${completedSets} 組`,
    `✅ 完成動作：${completedActions} 個`,
    ``,
    `─────────────────`,
  ];

  // 加入每個動作的詳細紀錄
  if (sessionLog.length) {
    sessionLog.forEach(l => lines.push(l));
  } else {
    lines.push('（無完成紀錄）');
  }

  // 加入課表備註（使用者填寫的動作名稱和重量）
  const hasNotes = routine.some(r => r.note || r.weight);
  if (hasNotes) {
    lines.push('');
    lines.push('─────────────────');
    lines.push('📝 課表備註');
    routine.forEach(r => {
      if (r.note || r.weight) {
        const parts = [r.label];
        if (r.note) parts.push(r.note);
        if (r.weight) parts.push(r.weight + ' kg');
        lines.push('• ' + parts.join(' · '));
      }
    });
  }

  lines.push('');
  lines.push('─────────────────');
  lines.push('by Gym Timer');

  return lines.join('\n');
}

function copyToClipboard() {
  const text = buildNotesText();
  const btn = document.getElementById('copy-btn');

  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => {
      btn.textContent = '✅ 已複製！去備忘錄貼上';
      setTimeout(() => { btn.innerHTML = '📋 複製訓練紀錄'; }, 3000);
    }).catch(() => fallbackCopy(text, btn));
  } else {
    fallbackCopy(text, btn);
  }
}

function fallbackCopy(text, btn) {
  // 舊版瀏覽器或 Safari 的備用方法
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.focus(); ta.select();
  try {
    document.execCommand('copy');
    btn.textContent = '✅ 已複製！去備忘錄貼上';
    setTimeout(() => { btn.innerHTML = '📋 複製訓練紀錄'; }, 3000);
  } catch(e) {
    btn.textContent = '❌ 複製失敗，請手動選取';
  }
  document.body.removeChild(ta);
}

// 分頁切換（tab bar 用）
function switchTab(name) {
  document.querySelectorAll('.tab-page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('page-' + name).classList.add('active');
  document.getElementById('tab-' + name).classList.add('active');
}

function goToTimer() {
  if (!routine.length) { alert('請先加入至少一個訓練動作'); return; }
  switchTab('timer');
}
