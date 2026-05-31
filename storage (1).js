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

  // 更新「傳送到備忘錄」連結的 href
  updateNotesLink();

  document.getElementById('summary').classList.add('show');
}

// ─── Apple 備忘錄匯出 ────────────────────────────
// 原理：Apple 備忘錄支援一個叫做「x-callback-url」的 URL scheme
// 格式是：  mobilenotes://compose?body=文字內容
// 在 iPhone 上點擊這個連結，iOS 會自動打開「備忘錄」app 並建立一則新備忘錄
// 文字內容需要先用 encodeURIComponent() 把特殊字元（換行、中文等）編碼
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

function updateNotesLink() {
  const link = document.getElementById('notes-link');
  if (!link) return;

  const text = buildNotesText();

  // mobilenotes:// 是 Apple 備忘錄的 URL scheme
  // 只有 iPhone/iPad 的 Safari 才能打開，電腦上會沒有反應
  // encodeURIComponent 把換行(\n)和中文都轉成 URL 可以傳遞的格式
  link.href = 'mobilenotes://compose?body=' + encodeURIComponent(text);
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
