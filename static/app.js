/* cachy-UI - Frontend Logic */

let currentTab = 'dashboard';
let term = null;
let ws = null;
let fitAddon = null;
let refreshInterval = null;
let wifiStatusData = null;
let selectedWifiNetwork = null;
let pendingTerminalCwd = null;

// --- Tab Navigation ---
// 外部ツールタブ (servEX/selfcode/EasyLXD/VM Manager) は別ページを開くだけで
// 対応する tab-xxx セクションが存在しないため、汎用リスナー・switchTabから除外する。
const EXTERNAL_TABS = new Set(['servex', 'selfcode', 'easylxd', 'vmmanager']);
document.querySelectorAll('.nav-links li').forEach(li => {
  li.addEventListener('click', () => {
    if (EXTERNAL_TABS.has(li.dataset.tab)) return;
    switchTab(li.dataset.tab);
  });
});

function switchTab(tab) {
  if (EXTERNAL_TABS.has(tab)) return;
  currentTab = tab;
  document.querySelectorAll('.nav-links li').forEach(l => l.classList.toggle('active', l.dataset.tab === tab));
  document.querySelectorAll('.tab-content').forEach(t => t.classList.toggle('active', t.id === `tab-${tab}`));

  // Load data for the tab
  if (tab === 'dashboard') loadDashboard();
  else if (tab === 'services') loadServices();
  else if (tab === 'packages') {} // Don't auto-check
  else if (tab === 'ports') {} // Don't auto-scan
  else if (tab === 'terminal') {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      connectTerminal();
    } else if (fitAddon) {
      setTimeout(() => fitAddon.fit(), 50);
    }
  } else if (tab === 'wifi') {
    loadWifiStatus();
  } else if (tab === 'disks') {
    loadDisks();
  } else if (tab === 'limine') {
    loadLimine();
  } else if (tab === 'backup') {
    loadBackupPage();
  } else if (tab === 'snapper') {
    loadSnapperPage();
  } else if (tab === 'apps') {
    loadAppsPage();
  } else if (tab === 'fleet') {
    loadFleetPage();
  }
}

function refreshCurrentTab() {
  switchTab(currentTab);
}

async function restartCachyUI() {
  if (!confirm('cachy-UIを再起動しますか？')) return;
  try {
    const resp = await fetch('/api/cachyui/restart', { method: 'POST' });
    const data = await resp.json();
    if (data.success) {
      showStatus('cachy-UIを再起動しました。3秒後にページを更新します。', 'success');
      setTimeout(() => location.reload(), 3000);
    } else {
      showStatus(`再起動に失敗しました: ${data.errors || data.stderr}`, 'error');
    }
  } catch (e) {
    showStatus(`再起動エラー: ${e.message}`, 'error');
  }
}

async function rebootSystem() {
  if (!confirm('PC（サーバー本体）を再起動しますか？\n再起動中はサーバーおよびcachy-UIへの接続が一時的に切断されます。')) return;
  try {
    const resp = await fetch('/api/system/reboot', { method: 'POST' });
    const data = await resp.json();
    if (data.success) {
      showStatus('PCの再起動を開始しました。しばらく待ってから再度アクセスしてください。', 'info');
    } else {
      showStatus(`PC再起動に失敗しました: ${data.message || data.errors}`, 'error');
    }
  } catch (e) {
    showStatus('PCの再起動コマンドを送信しました。サーバーが再起動中です...', 'info');
  }
}

// ===== cachy-UI update =====
let cachyuiUpdateState = null; // { t, phase }

async function updateCachyUI() {
  if (!confirm('cachy-UIを更新しますか？\nGitHubから最新版を取得してセットアップします。\n\n・完了まで数分かかる場合があります\n・完了後、サイドバーの「cachy-UI再起動」で再起動すると新版が有効になります')) return;

  showStatus('アップデートを開始しています...', 'info');
  try {
    const resp = await fetch('/api/system/selfupdate', { method: 'POST' });
    const data = await resp.json();
    if (!data.success) {
      showStatus(data.message || 'アップデートを開始できませんでした', 'error');
      return;
    }
  } catch (e) {
    showStatus(`アップデート開始エラー: ${e.message}`, 'error');
    return;
  }
  cachyuiUpdateState = { t: Date.now(), phase: 'watching' };
  showStatus('アップデート実行中... このページを開いたままお待ちください', 'info');
  pollServuiUpdate();
}

function pollServuiUpdate() {
  const st = cachyuiUpdateState;
  if (!st || st.phase !== 'watching') return;
  fetch('/api/system/selfupdate/status', { cache: 'no-store' })
    .then(r => {
      if (!r.ok) throw new Error('not ok');
      return r.json();
    })
    .then(data => {
      if (!st || st.phase !== 'watching') return;
      if (data.done && !data.running) {
        st.phase = 'done';
        showStatus('アップデート完了！サイドバーの「cachy-UI再起動」を実行すると新版が有効になります', 'success');
        return;
      }
      if (!data.running && !data.done) {
        st.phase = 'done';
        const lastLine = (data.log || '').trim().split('\n').filter(Boolean).pop() || '';
        showStatus(`アップデートに失敗しました ${lastLine.slice(0, 120)}`, 'error');
        return;
      }
      if (Date.now() - st.t > 15 * 60 * 1000) {
        st.phase = 'done';
        showStatus('アップデートの状態を確認できませんでした（タイムアウト）', 'error');
        return;
      }
      setTimeout(pollServuiUpdate, 3000);
    })
    .catch(() => {
      if (!st || st.phase !== 'watching') return;
      setTimeout(pollServuiUpdate, 3000);
    });
}

async function shutdownSystem() {
  if (!confirm('PC（サーバー本体）をシャットダウンしますか？\nシャットダウン後はサーバーの電源が切れ、cachy-UIにアクセスできなくなります。')) return;
  try {
    const resp = await fetch('/api/system/shutdown', { method: 'POST' });
    const data = await resp.json();
    if (data.success) {
      showStatus('PCのシャットダウンを開始しました。サーバーの電源が切れます。', 'info');
    } else {
      showStatus(`PCシャットダウンに失敗しました: ${data.message || data.errors}`, 'error');
    }
  } catch (e) {
    showStatus('PCのシャットダウンコマンドを送信しました。サーバーがシャットダウン中です...', 'info');
  }
}


// --- Dashboard ---
async function loadDashboard() {
  try {
    const resp = await fetch('/api/system/info');
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    if (!data || !data.cpu || !data.memory || !data.disk) {
      throw new Error('ダッシュボードの応答が不正です');
    }

    // サイドバーのホスト名表示
    const hostEl = document.getElementById('sidebar-hostname');
    if (hostEl && data.hostname) hostEl.textContent = data.hostname;

    // CPU
    const cpuPct = data.cpu.percent;
    document.getElementById('cpu-usage').textContent = `${cpuPct}%`;
    const cpuBar = document.getElementById('cpu-bar');
    cpuBar.style.width = `${cpuPct}%`;
    cpuBar.className = `stat-bar-fill ${cpuPct > 80 ? 'danger' : cpuPct > 60 ? 'warn' : ''}`;
    
    // CPU Temperature
    const tempEl = document.getElementById('cpu-temp-detail');
    if (tempEl) {
      if (data.cpu.temp !== null && data.cpu.temp !== undefined) {
        const tempVal = data.cpu.temp;
        const tempClass = tempVal >= 80 ? 'text-danger' : tempVal >= 65 ? 'text-warn' : 'text-accent';
        tempEl.innerHTML = `CPU温度: <span class="${tempClass}">${tempVal}°C</span>`;
      } else {
        tempEl.textContent = 'CPU温度: --';
      }
    }

    document.getElementById('cpu-detail').textContent =
      `${data.cpu.count_physical}コア | Load: ${data.cpu.load_avg['1min']} / ${data.cpu.load_avg['5min']} / ${data.cpu.load_avg['15min']}`;

    // Memory
    const memPct = data.memory.percent;
    document.getElementById('mem-usage').textContent = `${memPct}%`;
    const memBar = document.getElementById('mem-bar');
    memBar.style.width = `${memPct}%`;
    memBar.className = `stat-bar-fill ${memPct > 80 ? 'danger' : memPct > 60 ? 'warn' : ''}`;
    const memUsedGB = (data.memory.used / 1073741824).toFixed(1);
    const memTotalGB = (data.memory.total / 1073741824).toFixed(1);
    document.getElementById('mem-detail').textContent = `${memUsedGB} GB / ${memTotalGB} GB`;

    // Disk
    const diskPct = data.disk.percent;
    document.getElementById('disk-usage').textContent = `${diskPct}%`;
    const diskBar = document.getElementById('disk-bar');
    diskBar.style.width = `${diskPct}%`;
    diskBar.className = `stat-bar-fill ${diskPct > 80 ? 'danger' : diskPct > 60 ? 'warn' : ''}`;
    const diskUsedGB = (data.disk.used / 1073741824).toFixed(1);
    const diskTotalGB = (data.disk.total / 1073741824).toFixed(1);
    document.getElementById('disk-detail').textContent = `${diskUsedGB} GB / ${diskTotalGB} GB`;

    // System info
    const uptimeH = Math.floor(data.uptime_seconds / 3600);
    const uptimeM = Math.floor((data.uptime_seconds % 3600) / 60);
    document.getElementById('sys-info').textContent =
      `ホスト名: ${data.hostname}\n` +
      `OS: ${data.os}\n` +
      `カーネル: ${data.kernel}\n` +
      `稼働時間: ${uptimeH}h ${uptimeM}m\n` +
      `ネット送信: ${(data.network.bytes_sent / 1048576).toFixed(1)} MB\n` +
      `ネット受信: ${(data.network.bytes_recv / 1048576).toFixed(1)} MB`;

    // Processes
    const procResp = await fetch('/api/system/processes');
    const procs = await procResp.json();
    const procList = document.getElementById('proc-list');
    procList.innerHTML = procs.map(p => `
      <tr>
        <td>${p.pid}</td>
        <td>${escapeHtml(p.name)}</td>
        <td>${p.cpu.toFixed(1)}</td>
        <td>${p.memory.toFixed(1)}</td>
        <td>${escapeHtml(p.user)}</td>
      </tr>
    `).join('');

  } catch (e) {
    console.error('Dashboard load error:', e);
  }
}

// --- Ports ---
async function scanPorts() {
  const container = document.getElementById('ports-list-container');
  container.innerHTML = '<p class="muted">スキャン中...</p>';
  try {
    const resp = await fetch('/api/ports/listen');
    const text = await resp.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      container.innerHTML = `<p class="muted">サーバーエラー (${resp.status}): ${escapeHtml(text.slice(0, 200))}</p>`;
      return;
    }
    window._allPorts = data.ports;
    window._portIps = data.ips || [];
    renderIps(window._portIps);
    renderPorts(data.ports || []);
    if (data.error) {
      showStatus(`検出時に問題が発生しました: ${data.error}`, 'error');
    } else if (!resp.ok || !Array.isArray(data.ports)) {
      document.getElementById('ports-list-container').innerHTML =
        `<p class="muted">応答が不正です (HTTP ${resp.status})。cachy-UIの再起動が必要な可能性があります。</p>`;
    }
  } catch (e) {
    container.innerHTML = `<p class="muted">エラー: ${escapeHtml(e.message)}</p>`;
  }
}

function renderIps(ips) {
  if (!ips || !ips.length) return;
  const labels = { enp: 'LAN', tailscale: 'Tailscale' };
  const items = ips.map(ip => {
    const label = Object.keys(labels).find(k => ip.iface.startsWith(k));
    return `${label ? labels[label] : ip.iface}: ${ip.address}`;
  });
  document.getElementById('ports-status').innerHTML =
    `<span class="badge badge-active">IPアドレス</span> ${items.map(escapeHtml).join(' / ')}`;
}

function ifaceLabel(iface) {
  if (iface.startsWith('tailscale')) return 'Tailscale';
  if (iface.startsWith('enp') || iface.startsWith('eth') || iface.startsWith('ens')) return 'LAN';
  return iface;
}

function addressLabel(address) {
  const ip = window._portIps.find(i => i.address === address);
  if (ip) return ifaceLabel(ip.iface);
  if (address.startsWith('fd7a:115c:a1e0')) return 'Tailscale';
  return null;
}

function renderPorts(ports) {
  const tbody = ports.map(p => {
    const proc = p.processes.length
      ? `${p.processes.map(escapeHtml).join(', ')} <span class="muted">(PID ${p.pids.join(', ')})</span>`
      : '<span class="muted">-</span>';
    let access;
    if (p.access === 'all') {
      access = '<span class="badge badge-active">✅ 可能</span>';
    } else if (p.access === 'limited') {
      const label = addressLabel(p.address);
      access = label
        ? `<span class="badge badge-other" title="${escapeHtml(p.address)}">⚠️ ${escapeHtml(label)}経由のみ</span>`
        : `<span class="badge badge-other" title="${escapeHtml(p.address)}">⚠️ ${escapeHtml(p.address)} 経由のみ</span>`;
    } else {
      access = '<span class="badge badge-inactive">❌ ローカルのみ</span>';
    }
    return `
      <tr>
        <td>${p.port}<span class="muted">/${p.proto}</span></td>
        <td>${escapeHtml(p.address)}</td>
        <td>${proc}</td>
        <td>${access}</td>
      </tr>
    `;
  }).join('');
  document.getElementById('ports-list-container').innerHTML = `
    <table class="proc-table">
      <thead>
        <tr><th>ポート</th><th>バインドアドレス</th><th>プロセス</th><th>LANアクセス</th></tr>
      </thead>
      <tbody>${tbody || '<tr><td colspan="4" class="muted">リッスン中のサービスはありません。</td></tr>'}</tbody>
    </table>
  `;
}

// --- Services ---
async function loadServices() {
  try {
    const resp = await fetch('/api/services');
    const services = await resp.json();
    window._allServices = services;
    renderServices(services);
  } catch (e) {
    console.error('Services load error:', e);
  }
}

function renderServices(services) {
  const tbody = document.getElementById('service-list');
  tbody.innerHTML = services.map(s => {
    const badgeClass = s.active === 'active' ? 'badge-active' :
                       s.active === 'inactive' ? 'badge-inactive' : 'badge-other';
    const name = String(s.name || '');
    return `
      <tr>
        <td>${escapeHtml(name.replace('.service', ''))}</td>
        <td><span class="badge ${badgeClass}">${escapeHtml(s.active)}</span></td>
        <td>${escapeHtml(s.sub)}</td>
        <td>
          <div class="btn-group">
            <button class="btn btn-sm btn-success" onclick="serviceAction('${escapeJs(name)}','start')" title="開始"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg></button>
            <button class="btn btn-sm btn-danger" onclick="serviceAction('${escapeJs(name)}','stop')" title="停止"><svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="1"/></svg></button>
            <button class="btn btn-sm btn-primary" onclick="serviceAction('${escapeJs(name)}','restart')" title="再起動"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 4v6h-6"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/></svg></button>
            <button class="btn btn-sm btn-secondary" onclick="serviceDetail('${escapeJs(name)}')" title="詳細"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg></button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

function filterServices() {
  if (!Array.isArray(window._allServices)) return;
  const q = document.getElementById('service-search').value.toLowerCase();
  const filtered = window._allServices.filter(s =>
    s.name.toLowerCase().includes(q)
  );
  renderServices(filtered);
}

async function serviceAction(name, action) {
  try {
    const resp = await fetch(`/api/services/${encodeURIComponent(name)}/${action}`, { method: 'POST' });
    const data = await resp.json();
    if (data.success) {
      showStatus(`サービスを${action === 'start' ? '開始' : action === 'stop' ? '停止' : '再起動'}しました: ${name}`, 'success');
    } else {
      showStatus(`操作に失敗しました: ${data.stderr || data.stdout}`, 'error');
    }
    loadServices();
  } catch (e) {
    showStatus(`エラー: ${e.message}`, 'error');
  }
}

async function serviceDetail(name) {
  try {
    const resp = await fetch(`/api/services/${encodeURIComponent(name)}/status`);
    const data = await resp.json();
    document.getElementById('service-detail-name').textContent = data.name;
    document.getElementById('service-detail-output').textContent = data.status_output;
    document.getElementById('service-detail').style.display = 'block';
  } catch (e) {
    showStatus(`エラー: ${e.message}`, 'error');
  }
}

// --- Packages ---
function sanitizeAptError(err) {
  if (!err) return '';
  return err
    .replace(/^WARNING: pacman does not have a stable CLI interface\..*\n?/gm, '')
    .trim();
}

async function checkUpdates() {
  const status = document.getElementById('package-status');
  status.className = 'status-msg show info';
  status.innerHTML = '<span class="spinner"></span> アップデート確認中...';

  try {
    const resp = await fetch('/api/packages/updates');
    const data = await resp.json();

    if (data.count === 0) {
      status.className = 'status-msg show success';
      status.textContent = '全パッケージが最新です。';
      document.getElementById('btn-upgrade-all').style.display = 'none';
      document.getElementById('package-list-container').innerHTML =
        '<p class="muted">利用可能なアップデートはありません。</p>';
    } else {
      status.className = 'status-msg show info';
      status.textContent = `${data.count}個のパッケージがアップデート可能です。`;
      document.getElementById('btn-upgrade-all').style.display = 'inline-block';

      const container = document.getElementById('package-list-container');
      container.innerHTML = data.packages.map(p => `
        <div class="package-item">
          <span>${escapeHtml(p.name)}</span>
          <button class="btn btn-sm btn-primary" onclick="upgradePackage('${escapeJs(p.name)}')">更新</button>
        </div>
      `).join('');
    }
  } catch (e) {
    status.className = 'status-msg show error';
    status.textContent = `エラー: ${e.message}`;
  }
}

async function upgradePackage(name) {
  const status = document.getElementById('package-status');
  status.className = 'status-msg show info';
  status.innerHTML = `<span class="spinner"></span> ${name} を更新中...`;

  try {
    const resp = await fetch(`/api/packages/upgrade/${encodeURIComponent(name)}`, { method: 'POST' });
    const data = await resp.json();
    if (data.success) {
      status.className = 'status-msg show success';
      status.textContent = `${name} を更新しました。`;
      checkUpdates();
    } else {
      status.className = 'status-msg show error';
      const cleanErr = sanitizeAptError(data.errors);
      status.textContent = cleanErr ? `更新に失敗しました: ${cleanErr}` : '更新に失敗しました。';
    }
  } catch (e) {
    status.className = 'status-msg show error';
    status.textContent = `エラー: ${e.message}`;
  }
}

async function upgradeAll() {
  if (!confirm('全パッケージを更新しますか？')) return;

  const status = document.getElementById('package-status');
  status.className = 'status-msg show info';
  status.innerHTML = '<span class="spinner"></span> 全パッケージを更新中... (数分かかる場合があります)';

  try {
    const resp = await fetch('/api/packages/upgrade', { method: 'POST' });
    const data = await resp.json();
    if (data.success) {
      status.className = 'status-msg show success';
      status.textContent = data.output ? `全パッケージの更新が完了しました。\n${data.output}` : '全パッケージの更新が完了しました。';
      checkUpdates();
    } else {
      status.className = 'status-msg show error';
      const cleanErr = sanitizeAptError(data.errors);
      status.textContent = cleanErr ? `更新に失敗しました: ${cleanErr}` : '更新に失敗しました。';
    }
  } catch (e) {
    status.className = 'status-msg show error';
    status.textContent = `エラー: ${e.message}`;
  }
}

async function fixPackages() {
  const status = document.getElementById('package-status');
  status.className = 'status-msg show info';
  status.innerHTML = '<span class="spinner"></span> パッケージの依存関係を修復中...';

  try {
    const resp = await fetch('/api/packages/fix', { method: 'POST' });
    const data = await resp.json();
    if (data.success) {
      status.className = 'status-msg show success';
      status.textContent = 'パッケージの依存関係を修復しました。';
      checkUpdates();
    } else {
      status.className = 'status-msg show error';
      const cleanErr = sanitizeAptError(data.errors);
      status.textContent = cleanErr ? `修復に失敗しました: ${cleanErr}` : '修復に失敗しました。';
    }
  } catch (e) {
    status.className = 'status-msg show error';
    status.textContent = `エラー: ${e.message}`;
  }
}

async function forceUpgradeAll() {
  if (!confirm('Phased Updates も含めて全パッケージを強制更新しますか？')) return;

  const status = document.getElementById('package-status');
  status.className = 'status-msg show info';
  status.innerHTML = '<span class="spinner"></span> 全パッケージを強制更新中... (数分かかる場合があります)';

  try {
    const resp = await fetch('/api/packages/force-upgrade', { method: 'POST' });
    const data = await resp.json();
    if (data.success) {
      status.className = 'status-msg show success';
      status.textContent = '全パッケージの強制更新が完了しました。';
      checkUpdates();
    } else {
      status.className = 'status-msg show error';
      const cleanErr = sanitizeAptError(data.errors);
      status.textContent = cleanErr ? `更新に失敗しました: ${cleanErr}` : '更新に失敗しました。';
    }
  } catch (e) {
    status.className = 'status-msg show error';
    status.textContent = `エラー: ${e.message}`;
  }
}

async function autoremovePackages() {
  if (!confirm('不要なパッケージを削除しますか？')) return;

  const status = document.getElementById('package-status');
  status.className = 'status-msg show info';
  status.innerHTML = '<span class="spinner"></span> 不要なパッケージを削除中...';

  try {
    const resp = await fetch('/api/packages/autoremove', { method: 'POST' });
    const data = await resp.json();
    if (data.success) {
      status.className = 'status-msg show success';
      status.textContent = '不要なパッケージを削除しました。';
      checkUpdates();
    } else {
      status.className = 'status-msg show error';
      const cleanErr = sanitizeAptError(data.errors);
      status.textContent = cleanErr ? `削除に失敗しました: ${cleanErr}` : '削除に失敗しました。';
    }
  } catch (e) {
    status.className = 'status-msg show error';
    status.textContent = `エラー: ${e.message}`;
  }
}

// --- Terminal ---
function openTerminalAt(path) {
  if (!path) return;
  pendingTerminalCwd = path;
  const cwdLabel = document.getElementById('terminal-cwd-label');
  if (cwdLabel) cwdLabel.textContent = '';
  if (ws) {
    ws.onclose = null;
    ws.onerror = null;
    try { ws.close(); } catch (e) {}
    ws = null;
  }
  switchTab('terminal');
}

function connectTerminal() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.close();
    return;
  }

  const container = document.getElementById('terminal-container');
  container.innerHTML = '';

  if (term) {
    term.dispose();
  }

  term = new Terminal({
    cursorBlink: true,
    fontSize: 14,
    fontFamily: '"Fira Code", "SF Mono", Menlo, monospace',
    theme: {
      background: '#1a1b26',
      foreground: '#c0caf5',
      cursor: '#c0caf5',
      selectionBackground: '#33467c',
      black: '#15161e',
      red: '#f7768e',
      green: '#9ece6a',
      yellow: '#e0af68',
      blue: '#7aa2f7',
      magenta: '#bb9af7',
      cyan: '#7dcfff',
      white: '#a9b1d6',
    },
  });

  fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  term.open(container);
  setTimeout(() => fitAddon.fit(), 50);

  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  const cwdParam = pendingTerminalCwd ? `?cwd=${encodeURIComponent(pendingTerminalCwd)}` : '';
  const cwdLabel = document.getElementById('terminal-cwd-label');
  if (cwdLabel) {
    cwdLabel.textContent = pendingTerminalCwd ? `— ${pendingTerminalCwd} で開いています` : '';
  }
  pendingTerminalCwd = null;
  ws = new WebSocket(`${protocol}://${location.host}/ws/terminal${cwdParam}`);

  ws.onopen = () => {
    term.writeln('\x1b[36m接続中...\x1b[0m\r\n');
    ws.send(JSON.stringify({
      type: 'resize',
      cols: term.cols,
      rows: term.rows,
    }));
  };

  ws.onmessage = (event) => {
    term.write(event.data);
  };

  ws.onclose = () => {
    term.writeln('\r\n\x1b[31m接続が閉じました。再接続するには「接続」ボタンを押してください。\x1b[0m');
  };

  ws.onerror = (e) => {
    term.writeln('\r\n\x1b[31m接続エラー\x1b[0m');
  };

  term.onData(data => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'input', data }));
    }
  });

  term.onResize(({ cols, rows }) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'resize', cols, rows }));
    }
  });

  // connectTerminal() の呼び出し毎に window リスナが蓄積しないよう1回のみ登録する。
  if (!window._cachyTermResizeBound) {
    window._cachyTermResizeBound = true;
    window.addEventListener('resize', () => {
      if (fitAddon) fitAddon.fit();
    });
  }
}

// --- Wi-Fi ---
async function loadWifiStatus() {
  const statusMsg = document.getElementById('wifi-status-msg');
  const currentCard = document.getElementById('wifi-current-card');

  try {
    const resp = await fetch('/api/wifi/status');
    const data = await resp.json();
    wifiStatusData = data;

    const toggleText = document.getElementById('wifi-toggle-text');
    if (toggleText) {
      toggleText.textContent = data.enabled ? 'Wi-FiをOFFにする' : 'Wi-FiをONにする';
    }

    if (!data.available) {
      statusMsg.className = 'status-msg show info';
      statusMsg.textContent = data.message || '利用可能なWi-Fiインターフェースが見つかりません。Wi-Fiアダプターが接続されているか確認してください。';
      currentCard.style.display = 'none';
      document.getElementById('wifi-networks-container').innerHTML =
        '<p class="muted">Wi-Fiインターフェースが無効または接続されていません。</p>';
      return;
    }

    if (!data.enabled) {
      statusMsg.className = 'status-msg show info';
      statusMsg.textContent = 'Wi-Fi機能が無効化されています。「Wi-FiをONにする」ボタンをクリックして有効化してください。';
      currentCard.style.display = 'none';
      return;
    }

    statusMsg.className = 'status-msg';

    if (data.connected && data.current) {
      currentCard.style.display = 'block';
      document.getElementById('wifi-current-ssid').textContent = data.current.ssid;
      const sig = data.current.signal ? `信号強度: ${data.current.signal}% | ` : '';
      const ip = data.current.ip ? `IP: ${data.current.ip} | ` : '';
      const dev = data.current.device ? `デバイス: ${data.current.device}` : '';
      document.getElementById('wifi-current-detail').textContent = `${sig}${ip}${dev}`;
    } else {
      currentCard.style.display = 'none';
    }

    // Auto-scan on load
    scanWifi();

  } catch (e) {
    statusMsg.className = 'status-msg show error';
    statusMsg.textContent = `Wi-Fiステータス取得エラー: ${e.message}`;
  }
}

async function scanWifi() {
  const container = document.getElementById('wifi-networks-container');
  const statusMsg = document.getElementById('wifi-status-msg');
  container.innerHTML = '<p class="muted"><span class="spinner"></span> 周囲のWi-Fiネットワークをスキャン中...</p>';

  try {
    const resp = await fetch('/api/wifi/scan');
    const data = await resp.json();

    if (!data.success) {
      container.innerHTML = `<p class="muted text-danger">${escapeHtml(data.error || 'スキャンに失敗しました。')}</p>`;
      return;
    }

    if (!data.networks || data.networks.length === 0) {
      container.innerHTML = '<p class="muted">検出されたWi-Fiネットワークはありません。「Wi-Fiスキャン」をクリックして再試行してください。</p>';
      return;
    }

    container.innerHTML = `
      <table class="proc-table">
        <thead>
          <tr>
            <th>SSID</th>
            <th>電波強度</th>
            <th>セキュリティ</th>
            <th>周波数 / Ch</th>
            <th>状態</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          ${data.networks.map(net => {
            const isConnected = net.in_use;
            const isOpen = !net.security || net.security.toLowerCase() === 'open' || net.security.includes('--');
            const safeSSID = escapeHtml(net.ssid);
            const safeBSSID = escapeHtml(net.bssid || '');
            const safeSec = escapeHtml(net.security);
            const jsSSID = escapeJs(net.ssid);
            const jsBSSID = escapeJs(net.bssid || '');
            const jsSec = escapeJs(net.security);
            const freqStr = net.freq ? `${net.freq} (${net.chan || '-'})` : (net.chan || '-');

            let sigClass = 'signal-good';
            if (net.signal < 40) sigClass = 'signal-weak';
            else if (net.signal < 70) sigClass = 'signal-medium';

            return `
              <tr>
                <td>
                  <div class="wifi-ssid-cell">
                    ${isOpen ? '' : '<svg class="icon-lock" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>'}
                    <span style="font-weight:600;">${safeSSID}</span>
                  </div>
                </td>
                <td>
                  <div class="wifi-signal-wrap">
                    <span class="wifi-signal-bar ${sigClass}" style="width:${Math.max(10, net.signal)}%;"></span>
                    <span>${net.signal}%</span>
                  </div>
                </td>
                <td><span class="badge badge-other">${safeSec}</span></td>
                <td>${escapeHtml(freqStr)}</td>
                <td>
                  ${isConnected ? '<span class="badge badge-active">接続中</span>' : '<span class="badge badge-other">未接続</span>'}
                </td>
                <td>
                  ${isConnected ? `
                    <button class="btn btn-sm btn-danger" onclick="disconnectWifi('${jsSSID}')">切断</button>
                  ` : `
                    <button class="btn btn-sm btn-primary" onclick="openWifiConnect('${jsSSID}', '${jsSec}', '${jsBSSID}')">接続</button>
                  `}
                </td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    `;

  } catch (e) {
    container.innerHTML = `<p class="muted text-danger">スキャンエラー: ${escapeHtml(e.message)}</p>`;
  }
}

function openWifiConnect(ssid, security, bssid) {
  selectedWifiNetwork = { ssid, security, bssid };
  document.getElementById('wifi-modal-title').textContent = `「${ssid}」に接続`;
  document.getElementById('wifi-modal-subtitle').textContent = `セキュリティ: ${security || 'Open'}`;
  
  const pwdInput = document.getElementById('wifi-password');
  pwdInput.value = '';
  document.getElementById('wifi-modal-status').className = 'status-msg';

  const isOpen = !security || security.toLowerCase() === 'open' || security.includes('--');
  const pwdGroup = document.getElementById('wifi-pwd-group');
  if (isOpen) {
    pwdGroup.style.display = 'none';
  } else {
    pwdGroup.style.display = 'block';
    setTimeout(() => pwdInput.focus(), 100);
  }

  document.getElementById('wifi-modal').style.display = 'flex';
}

function closeWifiModal() {
  document.getElementById('wifi-modal').style.display = 'none';
  selectedWifiNetwork = null;
}

function togglePwdVisibility() {
  const pwdInput = document.getElementById('wifi-password');
  pwdInput.type = pwdInput.type === 'password' ? 'text' : 'password';
}

async function submitWifiConnect() {
  if (!selectedWifiNetwork) return;

  const password = document.getElementById('wifi-password').value;
  const statusEl = document.getElementById('wifi-modal-status');
  const submitBtn = document.getElementById('btn-wifi-connect-submit');

  statusEl.className = 'status-msg show info';
  statusEl.innerHTML = '<span class="spinner"></span> 接続中... (十数秒かかる場合があります)';
  submitBtn.disabled = true;

  try {
    const resp = await fetch('/api/wifi/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ssid: selectedWifiNetwork.ssid,
        password: password,
        bssid: selectedWifiNetwork.bssid,
      }),
    });

    const data = await resp.json();
    submitBtn.disabled = false;

    if (data.success) {
      statusEl.className = 'status-msg show success';
      statusEl.textContent = '接続に成功しました！';
      showStatus(`Wi-Fi「${selectedWifiNetwork.ssid}」に接続しました`, 'success');
      setTimeout(() => {
        closeWifiModal();
        loadWifiStatus();
      }, 1200);
    } else {
      statusEl.className = 'status-msg show error';
      statusEl.textContent = `接続エラー: ${data.message || '接続できませんでした'}`;
    }
  } catch (e) {
    submitBtn.disabled = false;
    statusEl.className = 'status-msg show error';
    statusEl.textContent = `エラー: ${e.message}`;
  }
}

async function disconnectWifi(ssid) {
  if (!confirm(`Wi-Fi接続を切断しますか？`)) return;

  try {
    const resp = await fetch('/api/wifi/disconnect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ssid: ssid || (wifiStatusData?.current?.ssid || '') }),
    });
    const data = await resp.json();
    if (data.success) {
      showStatus('Wi-Fiを切断しました', 'success');
      loadWifiStatus();
    } else {
      showStatus(`切断に失敗しました: ${data.message}`, 'error');
    }
  } catch (e) {
    showStatus(`エラー: ${e.message}`, 'error');
  }
}

async function forgetWifi() {
  const ssid = wifiStatusData?.current?.ssid;
  if (!ssid) return;
  if (!confirm(`「${ssid}」の接続設定を削除しますか？`)) return;

  try {
    const resp = await fetch('/api/wifi/forget', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ssid }),
    });
    const data = await resp.json();
    if (data.success) {
      showStatus(`「${ssid}」の設定を削除しました`, 'success');
      loadWifiStatus();
    } else {
      showStatus(`削除に失敗しました: ${data.message}`, 'error');
    }
  } catch (e) {
    showStatus(`エラー: ${e.message}`, 'error');
  }
}

async function toggleWifi() {
  if (!wifiStatusData) return;
  const targetState = !wifiStatusData.enabled;
  try {
    const resp = await fetch('/api/wifi/toggle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enable: targetState }),
    });
    const data = await resp.json();
    if (data.success) {
      showStatus(`Wi-Fiを${targetState ? '有効化' : '無効化'}しました`, 'success');
      setTimeout(loadWifiStatus, 1000);
    } else {
      showStatus(`操作に失敗しました: ${data.message}`, 'error');
    }
  } catch (e) {
    showStatus(`エラー: ${e.message}`, 'error');
  }
}

// --- Disks ---
let pendingMountDevice = null;
let pendingMountFstype = null;

async function loadDisks() {
  const container = document.getElementById('disks-container');
  const statusMsg = document.getElementById('disk-status-msg');
  container.innerHTML = '<p class="muted"><span class="spinner"></span> ディスク情報を取得中...</p>';
  statusMsg.className = 'status-msg';

  try {
    const resp = await fetch('/api/disks/info');
    const data = await resp.json();

    if (!data.devices || data.devices.length === 0) {
      statusMsg.className = 'status-msg show info';
      statusMsg.textContent = 'ディスクデバイスが検出されませんでした。';
      container.innerHTML = '';
      return;
    }

    container.innerHTML = data.devices.map(dev => renderDiskDevice(dev, 0)).join('');

  } catch (e) {
    statusMsg.className = 'status-msg show error';
    statusMsg.textContent = `ディスク情報取得エラー: ${e.message}`;
    container.innerHTML = '';
  }
}

function fsColor(fstype) {
  const colors = {
    'vfat': '#e67e22', 'fat32': '#e67e22', 'fat16': '#e67e22',
    'ext4': '#3498db', 'ext3': '#2980b9', 'ext2': '#2471a3',
    'xfs': '#27ae60',
    'btrfs': '#8e44ad',
    'swap': '#e74c3c',
    'linux-swap': '#e74c3c', 'linux-swap(v1)': '#e74c3c',
    'LVM2_member': '#16a085',
    'ntfs': '#f39c12',
    'exfat': '#d35400',
    'iso9660': '#7f8c8d',
  };
  return colors[fstype] || '#5a5e6b';
}

function flattenPartitions(dev) {
  const parts = [];
  for (const child of (dev.children || [])) {
    if (child.type === 'part' || child.type === 'lvm') {
      parts.push(child);
    }
  }
  return parts;
}

function renderDiskLayoutBar(dev) {
  const partitions = flattenPartitions(dev);
  if (partitions.length === 0) return '';

  const totalBytes = dev.size_bytes || 1;
  let segments = [];
  let usedBytes = 0;

  for (const p of partitions) {
    const pBytes = p.size_bytes || 0;
    const pct = Math.max((pBytes / totalBytes) * 100, 0.8);
    usedBytes += pBytes;
    const color = fsColor(p.fstype);
    const fsLabel = p.fstype || '未割当';
    const mountLabel = p.mountpoint ? ` (${p.mountpoint})` : '';
    const tooltip = `${p.name}: ${p.size} - ${fsLabel}${mountLabel}`;
    segments.push({ pct, color, tooltip, name: p.name, size: p.size, fstype: fsLabel });
  }

  const freeBytes = totalBytes - usedBytes;
  if (freeBytes > 0) {
    const freePct = Math.max((freeBytes / totalBytes) * 100, 0.3);
    segments.push({ pct: freePct, color: '#2c2f38', tooltip: '空き領域', name: '', size: '', fstype: '' });
  }

  const segmentsHtml = segments.map(s =>
    `<div class="disk-layout-seg" style="flex:${s.pct};background:${s.color};" title="${escapeHtml(s.tooltip)}">
      ${s.pct > 4 ? `<span class="disk-layout-seg-label">${escapeHtml(s.name)}<br>${escapeHtml(s.size)}</span>` : ''}
    </div>`
  ).join('');

  const legendHtml = partitions.map(p => {
    const color = fsColor(p.fstype);
    const mountLabel = p.mountpoint ? ` → ${p.mountpoint}` : '';
    return `<span class="disk-layout-legend-item">
      <span class="disk-layout-legend-dot" style="background:${color};"></span>
      ${escapeHtml(p.name)} <span class="disk-layout-legend-size">${escapeHtml(p.size)}</span>
      ${p.fstype ? `<span class="disk-layout-legend-fs">${escapeHtml(p.fstype)}</span>` : ''}
      ${mountLabel ? `<span class="disk-layout-legend-mount">${escapeHtml(p.mountpoint)}</span>` : ''}
    </span>`;
  }).join('');

  return `
    <div class="disk-layout-wrap">
      <div class="disk-layout-bar">${segmentsHtml}</div>
      <div class="disk-layout-legend">${legendHtml}</div>
    </div>`;
}

function renderLvmInfo(dev) {
  const lvm = dev.lvm;
  const vgName = lvm.vg_name;
  const vgSize = lvm.vg_size || lvm.pv_size;
  const vgFree = lvm.vg_free || lvm.pv_free;
  const lvs = lvm.lvs || [];

  // Build LV layout bar (similar to disk layout bar)
  const parseSize = (s) => {
    if (!s) return 0;
    const m = {'K':1024,'M':1024**2,'G':1024**3,'T':1024**4};
    s = s.replace(/[<>]/g, '').trim();
    if (s.slice(-1).toUpperCase() in m) return parseFloat(s) * m[s.slice(-1).toUpperCase()];
    return parseFloat(s) || 0;
  };

  const vgTotalBytes = parseSize(vgSize);
  const vgFreeBytes = parseSize(vgFree);
  const vgUsedBytes = vgTotalBytes - vgFreeBytes;

  const lvColors = ['#3498db', '#27ae60', '#e67e22', '#8e44ad', '#16a085', '#e74c3c', '#f39c12', '#2c3e50'];

  let segments = [];
  lvs.forEach((lv, i) => {
    const lvBytes = parseSize(lv.size);
    const pct = vgTotalBytes > 0 ? Math.max((lvBytes / vgTotalBytes) * 100, 1) : 0;
    const color = lvColors[i % lvColors.length];
    const mountLabel = lv.mountpoint ? ` → ${lv.mountpoint}` : '';
    segments.push({
      pct, color,
      tooltip: `${lv.name}: ${lv.size}${mountLabel}`,
      name: lv.name, size: lv.size, mountpoint: lv.mountpoint,
    });
  });

  if (vgFreeBytes > 0 && vgTotalBytes > 0) {
    const freePct = Math.max((vgFreeBytes / vgTotalBytes) * 100, 0.3);
    segments.push({ pct: freePct, color: '#2c2f38', tooltip: `空き: ${vgFree}`, name: '', size: '' });
  }

  const segmentsHtml = segments.map(s =>
    `<div class="disk-layout-seg" style="flex:${s.pct};background:${s.color};" title="${escapeHtml(s.tooltip)}">
      ${s.pct > 5 ? `<span class="disk-layout-seg-label">${escapeHtml(s.name)}<br>${escapeHtml(s.size)}</span>` : ''}
    </div>`
  ).join('');

  // LV rows
  const lvRows = lvs.map((lv, i) => {
    const color = lvColors[i % lvColors.length];
    const mountLabel = lv.mountpoint ? `<span class="disk-layout-legend-mount"> → ${escapeHtml(lv.mountpoint)}</span>` : '';
    const safeLvPath = escapeHtml(lv.path || `${vgName}-${lv.name}`.replace(/-/g, '--'));
    const jsLvPath = escapeJs(lv.path || `${vgName}-${lv.name}`.replace(/-/g, '--'));
    const jsLvMp = escapeJs(lv.mountpoint || '');
    const jsVg = escapeJs(vgName);
    const jsLvName = escapeJs(lv.name);
    const jsLvSize = escapeJs(lv.size);
    const jsVgFree = escapeJs(vgFree);
    let lvBtns = '';
    if (lv.mountpoint) {
      lvBtns += `<button class="btn btn-sm btn-danger" onclick="unmountDisk('${jsLvPath}','${jsLvMp}')" title="アンマウント">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" style="width:0.85rem;height:0.85rem;"><line x1="5" y1="12" x2="19" y2="12"/></svg>
      </button>`;
      const lvMpTitle = escapeAttr(lv.mountpoint);
      lvBtns += `<button class="btn btn-sm btn-secondary" onclick="openTerminalAt('${jsLvMp}')" title="${lvMpTitle} でターミナルを開く" style="margin-left:0.15rem;">ターミナルで開く</button>`;
      lvBtns += `<button class="btn btn-sm btn-secondary" onclick="unmountDisk('${jsLvPath}','${jsLvMp}',true)" title="強制アンマウント（使用中でも切り離す）" style="margin-left:0.15rem;">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" style="width:0.85rem;height:0.85rem;"><line x1="5" y1="12" x2="19" y2="12"/></svg>
      </button>`;
    } else {
      const mountDev = lv.path ? lv.path.replace('/dev/', '') : safeLvPath;
      const fsType = 'ext4';
      lvBtns += `<button class="btn btn-sm btn-primary" onclick="openDiskMountModal('${escapeJs(mountDev)}','${fsType}')" title="マウント">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" style="width:0.85rem;height:0.85rem;"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
      </button>`;
    }
    if (vgFreeBytes > 0) {
      lvBtns += `<button class="btn btn-sm btn-secondary" onclick="openLvResizeModal('${jsVg}','${jsLvName}','${jsLvSize}','${jsVgFree}')" title="VG空き領域で拡張" style="margin-left:0.15rem;">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" style="width:0.85rem;height:0.85rem;"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/></svg>
      </button>`;
    }
    lvBtns += `<button class="btn btn-sm btn-danger" onclick="deleteLv('${jsVg}','${jsLvName}')" title="論理ボリュームを削除" style="margin-left:0.15rem;">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" style="width:0.85rem;height:0.85rem;"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
    </button>`;
    return `<div style="display:flex;align-items:center;justify-content:space-between;padding:0.35rem 0;border-bottom:1px solid var(--border);">
      <div style="display:flex;align-items:center;gap:0.4rem;">
        <span style="width:8px;height:8px;border-radius:2px;background:${color};flex-shrink:0;"></span>
        <span style="font-size:0.8rem;font-weight:500;">${escapeHtml(lv.name)}</span>
        <span style="font-size:0.75rem;color:var(--text-muted);">${escapeHtml(lv.size)}</span>
        ${mountLabel}
      </div>
      <div class="btn-group">${lvBtns}</div>
    </div>`;
  }).join('');

  const createLvBtn = vgFreeBytes > 0
    ? `<button class="btn btn-sm btn-success" onclick="openLvCreateModal('${escapeJs(vgName)}','${escapeJs(vgFree)}')" title="論理ボリュームを作成" style="margin-top:0.4rem;">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" style="width:0.85rem;height:0.85rem;"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        LV 作成
      </button>`
    : '';

  return `
    <div style="margin-top:0.6rem;padding:0.6rem;background:var(--bg-base);border:1px solid var(--border);border-radius:var(--radius-sm);">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.4rem;">
        <div style="display:flex;align-items:center;gap:0.5rem;">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" style="width:1rem;height:1rem;color:var(--accent);flex-shrink:0;">
            <rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/>
          </svg>
          <span style="font-size:0.82rem;font-weight:600;">VG: ${escapeHtml(vgName)}</span>
          <span style="font-size:0.72rem;color:var(--text-muted);">PV: ${escapeHtml(vgSize)} / 空き: <span class="text-success">${escapeHtml(vgFree)}</span></span>
        </div>
        ${createLvBtn}
      </div>
      ${segmentsHtml ? `<div class="disk-layout-wrap"><div class="disk-layout-bar" style="height:24px;">${segmentsHtml}</div></div>` : ''}
      ${lvRows}
    </div>`;
}

function renderDiskDevice(dev, depth) {
  const indent = depth * 1.5;
  const isDisk = dev.type === 'disk';
  const isPart = dev.type === 'part';
  const isLoop = dev.name.startsWith('loop');
  const isRam = dev.name.startsWith('ram');

  if (isLoop || isRam) return '';

  const removableBadge = dev.removable
    ? '<span class="badge badge-warn" style="margin-left:0.5rem;">取り外し可能</span>'
    : '';
  const readonlyBadge = dev.readonly
    ? '<span class="badge badge-other" style="margin-left:0.5rem;">読み取り専用</span>'
    : '';

  const typeLabel = isDisk ? 'ディスク' : isPart ? 'パーティション' : dev.type;
  const typeBadgeClass = isDisk ? 'badge-active' : isPart ? 'badge-other' : 'badge-inactive';
  const fsLabel = dev.label ? ` <span style="font-size:0.8rem;color:var(--text-muted);margin-left:0.3rem;">${escapeHtml(dev.label)}</span>` : '';

  let actionBtn = '';
  const isLvmMember = dev.fstype === 'LVM2_member';
  if (isPart && dev.fstype && !dev.readonly && !isLvmMember) {
    const jsName = escapeJs(dev.name);
    const jsMp = escapeJs(dev.mountpoint || '');
    const jsFs = escapeJs(dev.fstype);
    if (dev.mountpoint) {
      actionBtn = `<button class="btn btn-sm btn-danger" onclick="unmountDisk('${jsName}','${jsMp}')" title="アンマウント">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" style="width:0.85rem;height:0.85rem;"><line x1="5" y1="12" x2="19" y2="12"/></svg>
        アンマウント
      </button>`;
      actionBtn += `<button class="btn btn-sm btn-secondary" onclick="unmountDisk('${jsName}','${jsMp}',true)" title="強制アンマウント（使用中でも切り離す）" style="margin-left:0.25rem;">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" style="width:0.85rem;height:0.85rem;"><line x1="5" y1="12" x2="19" y2="12"/></svg>
        強制アンマウント
      </button>`;
    } else {
      actionBtn = `<button class="btn btn-sm btn-primary" onclick="openDiskMountModal('${jsName}','${jsFs}')" title="マウント">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" style="width:0.85rem;height:0.85rem;"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        マウント
      </button>`;
    }
    if (dev.extendable) {
      const maxMb = Math.floor((dev.max_extend_bytes || 0) / (1024 * 1024));
      actionBtn += `<button class="btn btn-sm btn-secondary" onclick="openDiskExtendModal('${jsName}',${Number(dev.size_bytes) || 0},${Number(dev.max_extend_bytes) || 0})" title="隣接空き領域で拡張" style="margin-left:0.25rem;">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" style="width:0.85rem;height:0.85rem;"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/></svg>
        拡張
      </button>`;
    }
  }

  // Delete button for partitions
  let deleteBtn = '';
  if (isPart && !isLvmMember) {
    deleteBtn = `<button class="btn btn-sm btn-danger" onclick="deletePartition('${escapeJs(dev.name)}')" title="パーティションを削除" style="margin-left:0.25rem;">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" style="width:0.85rem;height:0.85rem;"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
    </button>`;
  }

  // Create button for disks with free space
  let createBtn = '';
  if (isDisk && dev.free_bytes > 0) {
    createBtn = `<button class="btn btn-sm btn-success" onclick="openDiskCreateModal('${escapeJs(dev.name)}',${Number(dev.size_bytes) || 0},${Number(dev.free_bytes) || 0})" title="空き領域にパーティションを作成">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" style="width:0.85rem;height:0.85rem;"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
      作成
    </button>`;
  }

  // Delete button for disks (wipe all partitions)
  let diskDeleteBtn = '';
  if (isDisk) {
    diskDeleteBtn = `<button class="btn btn-sm btn-danger" onclick="wipeDisk('${escapeJs(dev.name)}')" title="ディスクの全パーティションを削除" style="margin-left:0.25rem;">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" style="width:0.85rem;height:0.85rem;"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
    </button>`;
  }

  let infoRows = '';
  if (dev.fstype) infoRows += `<tr><td>ファイルシステム</td><td>${escapeHtml(dev.fstype)}</td></tr>`;
  if (dev.size) infoRows += `<tr><td>サイズ</td><td>${escapeHtml(dev.size)}</td></tr>`;
  if (dev.mountpoint) {
    const mpSafe = escapeHtml(dev.mountpoint);
    infoRows += `<tr><td>マウントポイント</td><td>${mpSafe} <button class="btn btn-sm btn-secondary" onclick="openTerminalAt('${escapeJs(dev.mountpoint)}')" title="${escapeAttr(dev.mountpoint)} でターミナルを開く" style="margin-left:0.4rem;">ターミナルで開く</button></td></tr>`;
  }
  if (dev.model) infoRows += `<tr><td>モデル</td><td>${escapeHtml(dev.model)}</td></tr>`;
  if (dev.serial) infoRows += `<tr><td>シリアル</td><td>${escapeHtml(dev.serial)}</td></tr>`;
  if (dev.uuid) infoRows += `<tr><td>UUID</td><td style="font-size:0.75rem;">${escapeHtml(dev.uuid)}</td></tr>`;
  if (dev.partlabel) infoRows += `<tr><td>パーティションラベル</td><td>${escapeHtml(dev.partlabel)}</td></tr>`;
  if (dev.label) infoRows += `<tr><td>ボリュームラベル</td><td>${escapeHtml(dev.label)}</td></tr>`;

  let usageHtml = '';
  if (dev.df) {
    const pctNum = parseInt(dev.df.use_percent) || 0;
    const barClass = pctNum > 80 ? 'danger' : pctNum > 60 ? 'warn' : '';
    usageHtml = `
      <div style="margin-top:0.5rem;">
        <div style="display:flex;justify-content:space-between;font-size:0.8rem;color:var(--text-muted);margin-bottom:0.25rem;">
          <span>${escapeHtml(dev.df.used)} / ${escapeHtml(dev.df.size)}</span>
          <span>${escapeHtml(dev.df.avail)} 空き</span>
        </div>
        <div class="stat-bar"><div class="stat-bar-fill ${barClass}" style="width:${pctNum}%;"></div></div>
        <div style="text-align:right;font-size:0.75rem;color:var(--text-muted);margin-top:0.15rem;">${escapeHtml(dev.df.use_percent)} 使用中</div>
      </div>`;
  }

  const layoutBar = isDisk ? renderDiskLayoutBar(dev) : '';
  const lvmHtml = dev.lvm ? renderLvmInfo(dev) : '';
  const children = (dev.children || []).map(c => renderDiskDevice(c, depth + 1)).filter(Boolean).join('');
  const detailId = `disk-detail-${CSS.escape(dev.name)}`;

  const cardHeader = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.5rem;">
        <div style="display:flex;align-items:center;gap:0.5rem;">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" style="width:1.2rem;height:1.2rem;flex-shrink:0;${isDisk ? 'color:var(--accent);' : ''}">
            ${isDisk
              ? '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>'
              : '<rect x="2" y="4" width="20" height="16" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/>'}
          </svg>
          <span style="font-weight:600;font-size:0.95rem;">${escapeHtml(dev.name)}</span>
          <span class="badge ${typeBadgeClass}" style="font-size:0.7rem;">${typeLabel}</span>${fsLabel}
          ${removableBadge}${readonlyBadge}
        </div>
        <div class="btn-group">
          ${createBtn}${diskDeleteBtn}${actionBtn}${deleteBtn}
          ${isDisk ? `
          <button class="btn btn-sm btn-secondary" onclick="toggleDiskDetail('${escapeJs(dev.name)}')" title="パーティション情報を表示" id="btn-toggle-detail-${detailId}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:0.85rem;height:0.85rem;transition:transform 0.15s;"><polyline points="6 9 12 15 18 9"/></svg>
            詳細
          </button>` : ''}
        </div>
      </div>`;

  const baseBody = `
      ${layoutBar}
      ${lvmHtml}
      ${infoRows ? `<table class="proc-table" style="margin:0;"><tbody>${infoRows}</tbody></table>` : ''}
      ${usageHtml}`;

  if (isDisk) {
    // ディスクの基本情報（レイアウト・サイズ・使用量）は常時表示、
    // パーティション詳細（vda1, vda2 etc.）のみ折りたたみ
    return `
    <div class="stat-card" style="margin-bottom:1rem;">
      ${cardHeader}
      ${baseBody}
      <div id="${detailId}" style="display:none;">
        ${children}
      </div>
    </div>`;
  }

  return `
    <div class="stat-card" style="margin-bottom:1rem;margin-left:${indent}rem;border-left:3px solid var(--border);">
      ${cardHeader}
      ${baseBody}
    </div>`;
}

function toggleDiskDetail(name) {
  const detailId = `disk-detail-${CSS.escape(name)}`;
  const el = document.getElementById(detailId);
  if (!el) return;
  const btn = document.getElementById(`btn-toggle-detail-${detailId}`);
  const willShow = el.style.display === 'none' || !el.style.display;
  el.style.display = willShow ? 'block' : 'none';
  if (btn) {
    const arrow = btn.querySelector('svg polyline');
    if (arrow) arrow.setAttribute('points', willShow ? '18 15 12 9 6 15' : '6 9 12 15 18 9');
  }
}

function openDiskMountModal(deviceName, fstype) {
  pendingMountDevice = deviceName;
  pendingMountFstype = fstype;

  document.getElementById('disk-mount-device').textContent = `/dev/${deviceName} (${fstype})`;
  document.getElementById('disk-mount-point').value = '';
  document.getElementById('disk-mount-status').className = 'status-msg';
  document.querySelector('input[name="disk-mount-type"][value="temp"]').checked = true;
  document.getElementById('disk-mount-persist-warn').style.display = 'none';
  document.getElementById('disk-mount-modal').style.display = 'flex';
  setTimeout(() => document.getElementById('disk-mount-point').focus(), 100);
}

function closeDiskMountModal() {
  document.getElementById('disk-mount-modal').style.display = 'none';
  pendingMountDevice = null;
  pendingMountFstype = null;
}

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('input[name="disk-mount-type"]').forEach(radio => {
    radio.addEventListener('change', (e) => {
      document.getElementById('disk-mount-persist-warn').style.display =
        e.target.value === 'persist' ? 'block' : 'none';
    });
  });

  document.getElementById('disk-create-persistent').addEventListener('change', (e) => {
    document.getElementById('disk-create-persistent-warn').style.display =
      e.target.checked ? 'block' : 'none';
  });

  document.getElementById('lv-create-persistent').addEventListener('change', (e) => {
    document.getElementById('lv-create-persistent-warn').style.display =
      e.target.checked ? 'block' : 'none';
  });
});

async function submitDiskMount() {
  if (!pendingMountDevice) return;

  const mountPoint = document.getElementById('disk-mount-point').value.trim();
  const persistent = document.querySelector('input[name="disk-mount-type"]:checked').value === 'persist';
  const statusEl = document.getElementById('disk-mount-status');
  const submitBtn = document.getElementById('btn-disk-mount-submit');

  if (!mountPoint) {
    statusEl.className = 'status-msg show error';
    statusEl.textContent = 'マウント先パスを入力してください。';
    return;
  }

  statusEl.className = 'status-msg show info';
  statusEl.innerHTML = '<span class="spinner"></span> マウント中...';
  submitBtn.disabled = true;

  try {
    const resp = await fetch('/api/disks/mount', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        device: pendingMountDevice,
        mount_point: mountPoint,
        persistent: persistent,
        fstype: pendingMountFstype,
      }),
    });
    const data = await resp.json();
    submitBtn.disabled = false;

    if (data.success) {
      statusEl.className = 'status-msg show success';
      statusEl.textContent = data.message;
      showStatus(data.message, 'success');
      setTimeout(() => {
        closeDiskMountModal();
        loadDisks();
      }, 1000);
    } else {
      statusEl.className = 'status-msg show error';
      statusEl.textContent = data.message;
    }
  } catch (e) {
    submitBtn.disabled = false;
    statusEl.className = 'status-msg show error';
    statusEl.textContent = `エラー: ${e.message}`;
  }
}

async function unmountDisk(deviceName, mountPoint, force = false) {
  const confirmMsg = force
    ? `${mountPoint} を強制アンマウントしますか？\n（使用中のプロセスがあっても強制的に切り離します）`
    : `${mountPoint} をアンマウントしますか？`;
  if (!confirm(confirmMsg)) return;

  try {
    const resp = await fetch('/api/disks/unmount', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device: deviceName, mount_point: mountPoint, force }),
    });
    const data = await resp.json();
    if (data.success) {
      showStatus(data.message, 'success');
      if (data.fstab_entry) {
        showStatus('注意: /etc/fstabにエントリが残っています', 'info');
      }
      loadDisks();
    } else {
      showStatus(data.message, 'error');
    }
  } catch (e) {
    showStatus(`エラー: ${e.message}`, 'error');
  }
}

// --- Create Partition ---
let pendingCreateDisk = null;
let pendingCreateMaxBytes = 0;

function formatBytesJS(b) {
  if (b >= 1024**3) return (b / 1024**3).toFixed(1) + ' GB';
  if (b >= 1024**2) return (b / 1024**2).toFixed(0) + ' MB';
  if (b >= 1024) return (b / 1024).toFixed(0) + ' KB';
  return b + ' B';
}

function openDiskCreateModal(diskName, totalBytes, freeBytes) {
  pendingCreateDisk = diskName;
  pendingCreateMaxBytes = freeBytes;

  const freeMb = Math.floor(freeBytes / (1024 * 1024));
  document.getElementById('disk-create-info').textContent = `/dev/${diskName} - 空き領域: ${formatBytesJS(freeBytes)}`;
  document.getElementById('disk-create-size').value = freeMb;
  document.getElementById('disk-create-size').max = freeMb;
  document.getElementById('disk-create-size-max').textContent = `${freeMb} MB`;
  document.getElementById('disk-create-fstype').value = 'ext4';
  document.getElementById('disk-create-label').value = '';
  document.getElementById('disk-create-mount').value = '';
  document.getElementById('disk-create-persistent').checked = false;
  document.getElementById('disk-create-persistent-warn').style.display = 'none';
  document.getElementById('disk-create-status').className = 'status-msg';
  document.getElementById('disk-create-modal').style.display = 'flex';
  setTimeout(() => document.getElementById('disk-create-size').focus(), 100);
}

function closeDiskCreateModal() {
  document.getElementById('disk-create-modal').style.display = 'none';
  pendingCreateDisk = null;
  pendingCreateMaxBytes = 0;
}

async function submitDiskCreate() {
  if (!pendingCreateDisk) return;

  const sizeMb = parseInt(document.getElementById('disk-create-size').value) || 0;
  const fstype = document.getElementById('disk-create-fstype').value;
  const label = document.getElementById('disk-create-label').value.trim();
  const mountPoint = document.getElementById('disk-create-mount').value.trim();
  const persistent = document.getElementById('disk-create-persistent').checked;
  const statusEl = document.getElementById('disk-create-status');
  const submitBtn = document.getElementById('btn-disk-create-submit');

  if (sizeMb < 8) {
    statusEl.className = 'status-msg show error';
    statusEl.textContent = 'サイズは8MB以上を指定してください。';
    return;
  }

  if (fstype === 'swap' && mountPoint) {
    statusEl.className = 'status-msg show error';
    statusEl.textContent = 'swapにはマウント先パスを指定できません。';
    return;
  }

  if (persistent && !mountPoint) {
    statusEl.className = 'status-msg show error';
    statusEl.textContent = '永続マウントを指定する場合はマウント先パスを入力してください。';
    return;
  }

  if (label && !/^[a-zA-Z0-9._-]+$/.test(label)) {
    statusEl.className = 'status-msg show error';
    statusEl.textContent = 'ラベル名は半角英数字と . _ - のみ使用できます。';
    return;
  }

  const labelInfo = label ? ` ラベル「${label}」` : '';
  if (!confirm(`'/dev/${pendingCreateDisk}' に ${sizeMb}MB の ${fstype} パーティション${labelInfo}を作成しますか？`)) return;

  const sizeSectors = Math.floor(sizeMb * 1024 * 1024 / 512);
  statusEl.className = 'status-msg show info';
  statusEl.innerHTML = '<span class="spinner"></span> パーティションを作成中...';
  submitBtn.disabled = true;

  try {
    const resp = await fetch('/api/disks/partition/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        disk: pendingCreateDisk,
        size_sectors: sizeSectors,
        fstype: fstype,
        label: label,
        mount_point: mountPoint,
        persistent: persistent,
      }),
    });
    const data = await resp.json();
    submitBtn.disabled = false;

    if (data.success) {
      statusEl.className = 'status-msg show success';
      statusEl.textContent = data.message;
      showStatus(data.message, 'success');
      setTimeout(() => {
        closeDiskCreateModal();
        loadDisks();
      }, 1200);
    } else {
      statusEl.className = 'status-msg show error';
      statusEl.textContent = data.message;
    }
  } catch (e) {
    submitBtn.disabled = false;
    statusEl.className = 'status-msg show error';
    statusEl.textContent = `エラー: ${e.message}`;
  }
}

// --- Extend Partition ---
let pendingExtendDevice = null;
let pendingExtendMaxBytes = 0;

function openDiskExtendModal(deviceName, currentBytes, maxExtendBytes) {
  pendingExtendDevice = deviceName;
  pendingExtendMaxBytes = maxExtendBytes;

  const currentMb = Math.floor(currentBytes / (1024 * 1024));
  const maxMb = Math.floor(maxExtendBytes / (1024 * 1024));
  const afterMb = currentMb + maxMb;

  document.getElementById('disk-extend-info').textContent = `/dev/${deviceName}`;
  document.getElementById('disk-extend-current').textContent = formatBytesJS(currentBytes);
  document.getElementById('disk-extend-max').textContent = `+${formatBytesJS(maxExtendBytes)}`;
  document.getElementById('disk-extend-after').textContent = `${formatBytesJS(currentBytes + maxExtendBytes)} (${currentMb + maxMb} MB)`;
  document.getElementById('disk-extend-status').className = 'status-msg';
  document.getElementById('disk-extend-modal').style.display = 'flex';
}

function closeDiskExtendModal() {
  document.getElementById('disk-extend-modal').style.display = 'none';
  pendingExtendDevice = null;
  pendingExtendMaxBytes = 0;
}

async function submitDiskExtend() {
  if (!pendingExtendDevice) return;

  if (!confirm(`'/dev/${pendingExtendDevice}' を最大容量まで拡張しますか？\n\n注意: ファイルシステムも自動的に拡張されます。`)) return;

  const statusEl = document.getElementById('disk-extend-status');
  const submitBtn = document.getElementById('btn-disk-extend-submit');

  statusEl.className = 'status-msg show info';
  statusEl.innerHTML = '<span class="spinner"></span> 拡張中...';
  submitBtn.disabled = true;

  try {
    const resp = await fetch('/api/disks/partition/extend', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device: pendingExtendDevice }),
    });
    const data = await resp.json();
    submitBtn.disabled = false;

    if (data.success) {
      statusEl.className = 'status-msg show success';
      statusEl.textContent = data.message;
      showStatus(data.message, 'success');
      setTimeout(() => {
        closeDiskExtendModal();
        loadDisks();
      }, 1200);
    } else {
      statusEl.className = 'status-msg show error';
      statusEl.textContent = data.message;
    }
  } catch (e) {
    submitBtn.disabled = false;
    statusEl.className = 'status-msg show error';
    statusEl.textContent = `エラー: ${e.message}`;
  }
}

// --- Create LV ---
let pendingCreateLvVg = null;

function openLvCreateModal(vgName, vgFree) {
  pendingCreateLvVg = vgName;
  document.getElementById('lv-create-info').textContent = `VG: ${vgName} - 空き: ${vgFree}`;
  document.getElementById('lv-create-name').value = '';
  document.getElementById('lv-create-size').value = '';
  document.getElementById('lv-create-fstype').value = 'ext4';
  document.getElementById('lv-create-mount').value = '';
  document.getElementById('lv-create-persistent').checked = false;
  document.getElementById('lv-create-persistent-warn').style.display = 'none';
  document.getElementById('lv-create-status').className = 'status-msg';
  document.getElementById('lv-create-modal').style.display = 'flex';
  setTimeout(() => document.getElementById('lv-create-name').focus(), 100);
}

function closeLvCreateModal() {
  document.getElementById('lv-create-modal').style.display = 'none';
  pendingCreateLvVg = null;
}

async function submitLvCreate() {
  if (!pendingCreateLvVg) return;

  const lvName = document.getElementById('lv-create-name').value.trim();
  const size = document.getElementById('lv-create-size').value.trim();
  const fstype = document.getElementById('lv-create-fstype').value;
  const mountPoint = document.getElementById('lv-create-mount').value.trim();
  const persistent = document.getElementById('lv-create-persistent').checked;
  const statusEl = document.getElementById('lv-create-status');
  const submitBtn = document.getElementById('btn-lv-create-submit');

  if (!lvName || !size) {
    statusEl.className = 'status-msg show error';
    statusEl.textContent = 'LV名とサイズを入力してください。';
    return;
  }

  if (fstype === 'swap' && mountPoint) {
    statusEl.className = 'status-msg show error';
    statusEl.textContent = 'swapにはマウント先パスを指定できません。';
    return;
  }

  if (persistent && !mountPoint) {
    statusEl.className = 'status-msg show error';
    statusEl.textContent = '永続マウントを指定する場合はマウント先パスを入力してください。';
    return;
  }

  if (!confirm(`VG '${pendingCreateLvVg}' に LV '${lvName}' (${size}, ${fstype}) を作成しますか？`)) return;

  statusEl.className = 'status-msg show info';
  statusEl.innerHTML = '<span class="spinner"></span> 論理ボリュームを作成中...';
  submitBtn.disabled = true;

  try {
    const resp = await fetch('/api/disks/lv/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        vg_name: pendingCreateLvVg,
        lv_name: lvName,
        size: size,
        fstype: fstype,
        mount_point: mountPoint,
        persistent: persistent,
      }),
    });
    const data = await resp.json();
    submitBtn.disabled = false;

    if (data.success) {
      statusEl.className = 'status-msg show success';
      statusEl.textContent = data.message;
      showStatus(data.message, 'success');
      setTimeout(() => {
        closeLvCreateModal();
        loadDisks();
      }, 1200);
    } else {
      statusEl.className = 'status-msg show error';
      statusEl.textContent = data.message;
    }
  } catch (e) {
    submitBtn.disabled = false;
    statusEl.className = 'status-msg show error';
    statusEl.textContent = `エラー: ${e.message}`;
  }
}

// --- Resize LV ---
let pendingResizeLvVg = null;
let pendingResizeLvName = null;

function openLvResizeModal(vgName, lvName, lvSize, vgFree) {
  pendingResizeLvVg = vgName;
  pendingResizeLvName = lvName;
  document.getElementById('lv-resize-info').textContent = `/dev/${vgName}/${lvName}`;
  document.getElementById('lv-resize-current').textContent = lvSize;
  document.getElementById('lv-resize-free').textContent = `+${vgFree}`;
  document.getElementById('lv-resize-size').value = '';
  document.getElementById('lv-resize-status').className = 'status-msg';
  document.getElementById('lv-resize-modal').style.display = 'flex';
  setTimeout(() => document.getElementById('lv-resize-size').focus(), 100);
}

function closeLvResizeModal() {
  document.getElementById('lv-resize-modal').style.display = 'none';
  pendingResizeLvVg = null;
  pendingResizeLvName = null;
}

async function submitLvResize() {
  if (!pendingResizeLvVg || !pendingResizeLvName) return;

  const size = document.getElementById('lv-resize-size').value.trim();
  const statusEl = document.getElementById('lv-resize-status');
  const submitBtn = document.getElementById('btn-lv-resize-submit');

  if (!size) {
    statusEl.className = 'status-msg show error';
    statusEl.textContent = 'サイズを入力してください。';
    return;
  }

  if (!confirm(`'/dev/${pendingResizeLvVg}/${pendingResizeLvName}' を ${size} にリサイズしますか？\n\nファイルシステムも自動的に拡張されます。`)) return;

  statusEl.className = 'status-msg show info';
  statusEl.innerHTML = '<span class="spinner"></span> リサイズ中...';
  submitBtn.disabled = true;

  try {
    const resp = await fetch('/api/disks/lv/resize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        vg_name: pendingResizeLvVg,
        lv_name: pendingResizeLvName,
        size: size,
      }),
    });
    const data = await resp.json();
    submitBtn.disabled = false;

    if (data.success) {
      statusEl.className = 'status-msg show success';
      statusEl.textContent = data.message;
      showStatus(data.message, 'success');
      setTimeout(() => {
        closeLvResizeModal();
        loadDisks();
      }, 1200);
    } else {
      statusEl.className = 'status-msg show error';
      statusEl.textContent = data.message;
    }
  } catch (e) {
    submitBtn.disabled = false;
    statusEl.className = 'status-msg show error';
    statusEl.textContent = `エラー: ${e.message}`;
  }
}

// --- Delete Disk (wipe all partitions) ---
async function wipeDisk(diskName) {
  if (!confirm(`ディスク '/dev/${diskName}' の全パーティションを削除しますか？\n\n⚠️ このディスク上のすべてのデータが失われます。`)) return;

  try {
    const resp = await fetch('/api/disks/disk/wipe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device: diskName }),
    });
    const data = await resp.json();
    if (data.success) {
      showStatus(data.message, 'success');
      loadDisks();
    } else {
      showStatus(data.message, 'error');
    }
  } catch (e) {
    showStatus(`エラー: ${e.message}`, 'error');
  }
}

// --- Delete Partition ---
async function deletePartition(deviceName) {
  if (!confirm(`パーティション '/dev/${deviceName}' を削除しますか？\n\nデータは完全に失われます。`)) return;

  try {
    const resp = await fetch('/api/disks/partition/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device: deviceName }),
    });
    const data = await resp.json();
    if (data.success) {
      showStatus(data.message, 'success');
      loadDisks();
    } else {
      showStatus(data.message, 'error');
    }
  } catch (e) {
    showStatus(`エラー: ${e.message}`, 'error');
  }
}

// --- Delete LV ---
async function deleteLv(vgName, lvName) {
  if (!confirm(`論理ボリューム '${lvName}' (VG: ${vgName}) を削除しますか？\n\nデータは完全に失われます。`)) return;

  try {
    const resp = await fetch('/api/disks/lv/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vg_name: vgName, lv_name: lvName }),
    });
    const data = await resp.json();
    if (data.success) {
      showStatus(data.message, 'success');
      loadDisks();
    } else {
      showStatus(data.message, 'error');
    }
  } catch (e) {
    showStatus(`エラー: ${e.message}`, 'error');
  }
}

// --- Limine (cachy-isoboot 方式) ---
let limineIsoResult = null;
let limineDlPollTimer = null;

async function loadLimine() {
  const statusMsg = document.getElementById('limine-status-msg');
  try {
    const resp = await fetch('/api/limine/info');
    const data = await resp.json();
    if (!data.exists) {
      if (statusMsg) {
        statusMsg.className = 'status-msg show error';
        statusMsg.textContent = `${data.conf || '/boot/limine.conf'} が見つかりません。Limine 環境で実行してください。`;
      }
      return;
    }
    if (statusMsg) { statusMsg.className = 'status-msg'; statusMsg.textContent = ''; }
    renderLimineSettings(data);
    renderLimineEntries(data);
    renderLimineEfi(data.efi || []);
    renderLimineDelList(data.iso_boot_entries || []);
    const defInput = document.getElementById('limine-default-input');
    if (defInput && !defInput.value && data.default_entry) defInput.value = data.default_entry;
  } catch (e) {
    if (statusMsg) {
      statusMsg.className = 'status-msg show error';
      statusMsg.textContent = `Limine情報取得エラー: ${e.message}`;
    }
  }
  loadLimineIsopart();
}

function renderLimineSettings(d) {
  const el = document.getElementById('limine-settings-container');
  if (!el) return;
  el.innerHTML = `
    <table class="info-table">
      <tbody>
        <tr><td style="color:var(--text-muted);">設定ファイル</td><td><b>${escapeHtml(d.conf || '/boot/limine.conf')}</b></td></tr>
        <tr><td style="color:var(--text-muted);">default_entry</td><td><b>${escapeHtml(d.default_entry ?? '未設定')}</b></td></tr>
        <tr><td style="color:var(--text-muted);">remember_last_entry</td><td><b>${escapeHtml(d.remember_last_entry ?? '未設定')}</b></td></tr>
        <tr><td style="color:var(--text-muted);">/iso マウント</td><td><b>${d.iso_mounted ? `あり (${escapeHtml(d.iso_source || '')} / ${escapeHtml(d.iso_fstype || '')} / ${escapeHtml(d.iso_size || '')})` : 'なし'}</b></td></tr>
      </tbody>
    </table>`;
}

function renderLimineEntries(d) {
  const el = document.getElementById('limine-entries-container');
  if (!el) return;
  const entries = d.entries || [];
  if (entries.length === 0) {
    el.innerHTML = '<p class="muted">エントリーが見つかりません</p>';
    return;
  }
  el.innerHTML = `
    <table class="info-table">
      <thead><tr><th>No.</th><th>種別</th><th>エントリー名</th></tr></thead>
      <tbody>
        ${entries.map((e) => `<tr><td>${e.index}</td><td>${escapeHtml(e.kind)}</td><td>${escapeHtml(e.name)}</td></tr>`).join('')}
      </tbody>
    </table>`;
}

function renderLimineEfi(efi) {
  const el = document.getElementById('limine-efi-container');
  if (!el) return;
  if (!efi || efi.length === 0) { el.innerHTML = '<p class="muted">EFI情報なし (efibootmgr 未導入または非UEFI)</p>'; return; }
  el.innerHTML = `<pre class="terminal-output">${escapeHtml(efi.map((e) => e.text).join('\n'))}</pre>`;
}

function renderLimineDelList(stubs) {
  const el = document.getElementById('limine-del-list');
  if (!el) return;
  if (!stubs || stubs.length === 0) { el.innerHTML = '<p class="muted">ISO Boot エントリーは登録されていません。</p>'; return; }
  el.innerHTML = stubs.map((s) => `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:0.4rem 0;border-bottom:1px solid var(--border);">
      <span style="font-family:monospace;">${escapeHtml(s)}</span>
      <button class="btn btn-danger btn-sm" onclick="deleteLimineEntry('${escapeJs(s)}')">削除</button>
    </div>`).join('');
}

async function loadLimineIsopart() {
  const el = document.getElementById('limine-isopart-status');
  if (!el) return;
  try {
    const resp = await fetch('/api/limine/isopart/status');
    const d = await resp.json();
    el.innerHTML = d.iso_mounted
      ? `<span class="text-success">/iso マウント済み:</span> <code>${escapeHtml(d.iso_info)}</code>`
      : `<span class="text-warn">/iso 未マウント。</span> <span class="muted">btrfs: ${(d.btrfs_parts || []).join(', ') || 'なし'}</span>`;
  } catch (e) {
    el.innerHTML = `<span class="text-warn">状態取得エラー: ${escapeHtml(e.message)}</span>`;
  }
}

function sendIsopartCommand() {
  switchTab('terminal');
  showStatus('create-isopart の取得コマンドをターミナルに送信しました', 'info');
  setTimeout(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'input', data: 'curl -fsSL -o /tmp/create-isopart.sh https://raw.githubusercontent.com/hirogura/create-isopart/main/create-isopart.sh && chmod +x /tmp/create-isopart.sh && sudo bash /tmp/create-isopart.sh\n' }));
    } else {
      showStatus('ターミナルに接続できません', 'error');
    }
  }, 500);
}

async function scanLimineIsos() {
  const listEl = document.getElementById('limine-iso-list');
  const statusEl = document.getElementById('limine-add-status');
  if (listEl) listEl.innerHTML = '<p class="muted"><span class="spinner"></span> /iso を検索中...</p>';
  if (statusEl) { statusEl.className = 'status-msg'; statusEl.textContent = ''; }
  const addBtn = document.getElementById('btn-limine-add');
  if (addBtn) addBtn.style.display = 'none';
  try {
    const resp = await fetch('/api/limine/isos');
    const data = await resp.json();
    if (!data.success) {
      if (listEl) listEl.innerHTML = '';
      if (statusEl) { statusEl.className = 'status-msg show error'; statusEl.textContent = data.error || 'ISO検索に失敗しました'; }
      return;
    }
    limineIsoResult = data;
    if (!data.isos || data.isos.length === 0) {
      if (listEl) listEl.innerHTML = '<p class="muted">/iso に ISO が見つかりません。先にダウンロードしてください。</p>';
      return;
    }
    if (listEl) {
      listEl.innerHTML = data.isos.map((iso, i) => `
        <div style="display:flex;gap:0.5rem;align-items:center;padding:0.4rem 0;border-bottom:1px solid var(--border);font-size:0.82rem;">
          <input type="checkbox" class="limine-iso-check" data-idx="${i}" checked>
          <span style="flex:1;font-family:monospace;">${escapeHtml(iso.name)} (${escapeHtml(iso.size || '')} / ${escapeHtml(iso.boot_type || '')})</span>
        </div>`).join('');
    }
    if (addBtn) addBtn.style.display = 'inline-block';
  } catch (e) {
    if (statusEl) { statusEl.className = 'status-msg show error'; statusEl.textContent = `エラー: ${e.message}`; }
  }
}

async function submitLimineAdd() {
  if (!limineIsoResult) return;
  const checks = Array.from(document.querySelectorAll('.limine-iso-check:checked'));
  if (checks.length === 0) { showStatus('ISOを選択してください', 'error'); return; }
  const isos = checks.map((c) => {
    const idx = parseInt(c.getAttribute('data-idx'), 10);
    return { path: limineIsoResult.isos[idx].path };
  });
  const names = isos.map((x) => x.path.split('/').pop()).join(', ');
  if (!confirm(`以下のISOブートエントリーを追加しますか？\n\n${names}\n\nカーネルを /boot/isos/ に取り出して limine.conf に追加します。`)) return;
  const statusEl = document.getElementById('limine-add-status');
  const btn = document.getElementById('btn-limine-add');
  if (btn) btn.disabled = true;
  if (statusEl) statusEl.innerHTML = '<span class="spinner"></span> エントリーを追加中... (ISO解析・コピーのため時間がかかる場合があります)';
  try {
    const resp = await fetch('/api/limine/entries/add', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isos }),
    });
    const data = await resp.json();
    if (statusEl) {
      statusEl.className = `status-msg show ${data.success ? 'success' : 'error'}`;
      statusEl.textContent = data.message || '';
    }
    if (data.success) {
      showStatus('Limineエントリーを追加しました', 'success');
      limineIsoResult = null;
      const listEl = document.getElementById('limine-iso-list');
      if (listEl) listEl.innerHTML = '';
      if (btn) btn.style.display = 'none';
      loadLimine();
    }
  } catch (e) {
    if (statusEl) { statusEl.className = 'status-msg show error'; statusEl.textContent = `エラー: ${e.message}`; }
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function deleteLimineEntry(stub) {
  if (!confirm(`エントリー「${stub}」を削除しますか？\nlimine.conf から削除されます（バックアップは /root/limine-boot-backups/ に保存）。`)) return;
  try {
    const resp = await fetch('/api/limine/entries/delete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stubs: [stub] }),
    });
    const data = await resp.json();
    const el = document.getElementById('limine-del-status');
    if (el) { el.className = `status-msg show ${data.success ? 'success' : 'error'}`; el.textContent = data.message || ''; }
    if (data.success) loadLimine();
  } catch (e) {
    showStatus(`削除エラー: ${e.message}`, 'error');
  }
}

async function setLimineDefault() {
  const input = document.getElementById('limine-default-input');
  const el = document.getElementById('limine-default-status');
  const value = (input && input.value || '').trim();
  if (!value) { if (el) { el.className = 'status-msg show error'; el.textContent = '値を入力してください'; } return; }
  if (!confirm(`default_entry を「${value}」に設定しますか？`)) return;
  try {
    const resp = await fetch('/api/limine/default', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value }),
    });
    const data = await resp.json();
    if (el) { el.className = `status-msg show ${data.success ? 'success' : 'error'}`; el.textContent = data.message || ''; }
    if (data.success) loadLimine();
  } catch (e) {
    if (el) { el.className = 'status-msg show error'; el.textContent = `エラー: ${e.message}`; }
  }
}

// --- Limine ISO ダウンロード (CachyOS + 汎用) ---
function pollLimineIsoDownloadStatus() {
  fetch('/api/limine/iso-download/status')
    .then((r) => r.json())
    .then((st) => {
      const progress = document.getElementById('limine-iso-dl-progress');
      const bar = document.getElementById('limine-iso-dl-progress-bar');
      const text = document.getElementById('limine-iso-dl-progress-text');
      const statusEl = document.getElementById('limine-iso-dl-status');
      const btn = document.getElementById('btn-limine-iso-dl');
      const cancelBtn = document.getElementById('btn-limine-iso-dl-cancel');
      if (!st.running && st.success === null && !st.filename) {
        if (progress) progress.style.display = 'none';
        return;
      }
      if (progress) progress.style.display = 'block';
      if (st.running) {
        if (cancelBtn) cancelBtn.disabled = false;
        if (btn) btn.disabled = true;
        const total = st.total || 0;
        const size = st.size || 0;
        if (total > 0 && bar) bar.style.width = `${Math.min(100, Math.round((size / total) * 100))}%`;
        if (text) text.textContent = `${st.filename}: ${formatBytesJS(size)}${total ? ` / ${formatBytesJS(total)}` : ''} ダウンロード中...`;
      } else {
        if (cancelBtn) cancelBtn.disabled = true;
        if (btn) btn.disabled = false;
        if (progress) progress.style.display = 'none';
        if (statusEl) {
          if (st.success) {
            statusEl.className = 'status-msg show success';
            statusEl.textContent = `${st.filename} のダウンロードが完了しました`;
            scanLimineIsos();
          } else if (st.success === false) {
            statusEl.className = 'status-msg show error';
            statusEl.textContent = `ダウンロード失敗: ${st.log || ''}`;
          }
        }
        stopLimineDlPolling();
      }
    })
    .catch(() => {});
}

function stopLimineDlPolling() {
  if (limineDlPollTimer) { clearInterval(limineDlPollTimer); limineDlPollTimer = null; }
}

async function loadCachyosFiles() {
  const edSel = document.getElementById('cachyos-edition-select');
  const fileSel = document.getElementById('cachyos-file-select');
  const statusEl = document.getElementById('limine-iso-dl-status');
  const edition = edSel ? edSel.value : 'desktop';
  try {
    if (statusEl) { statusEl.className = 'status-msg'; statusEl.textContent = ''; }
    const resp = await fetch(`/api/limine/cachyos-files?edition=${encodeURIComponent(edition)}`);
    const data = await resp.json();
    if (!fileSel) return;
    fileSel.innerHTML = '';
    if (!data.files || data.files.length === 0) {
      fileSel.innerHTML = '<option value="">ISOが見つかりません</option>';
      fileSel.disabled = true;
      return;
    }
    data.files.forEach((f, i) => {
      const opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = `${f.name} (${f.date || ''})`;
      fileSel.appendChild(opt);
    });
    fileSel.disabled = false;
    fileSel._files = data.files;
  } catch (e) {
    if (statusEl) { statusEl.className = 'status-msg show error'; statusEl.textContent = `CachyOSファイル取得エラー: ${e.message}`; }
  }
}

async function downloadLimineIso() {
  const fileSel = document.getElementById('cachyos-file-select');
  const input = document.getElementById('limine-iso-dl-url');
  const statusEl = document.getElementById('limine-iso-dl-status');
  const btn = document.getElementById('btn-limine-iso-dl');
  const urlInput = (input && input.value || '').trim();
  try {
    if (btn) btn.disabled = true;
    let url = urlInput;
    let filename = '';
    if (!url && fileSel && !fileSel.disabled && fileSel._files) {
      const f = fileSel._files[parseInt(fileSel.value, 10) || 0];
      if (f) { url = f.download_url; filename = f.name; }
    }
    if (!url) {
      if (statusEl) { statusEl.className = 'status-msg show error'; statusEl.textContent = 'CachyOS ISOを選択するか、直接URLを入力してください'; }
      if (btn) btn.disabled = false;
      return;
    }
    if (!filename) filename = url.split('/').pop().split('?')[0];
    const isCachy = url.includes('build.cachyos.org/ISO');
    const endpoint = isCachy ? '/api/limine/cachyos-download' : '/api/limine/iso-download';
    const resp = await fetch(endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, filename }),
    });
    const data = await resp.json();
    if (!data.success) {
      if (statusEl) { statusEl.className = 'status-msg show error'; statusEl.textContent = data.message || 'ダウンロード開始に失敗しました'; }
      if (btn) btn.disabled = false;
      return;
    }
    if (input) input.value = '';
    stopLimineDlPolling();
    pollLimineIsoDownloadStatus();
    limineDlPollTimer = setInterval(pollLimineIsoDownloadStatus, 1000);
  } catch (e) {
    if (statusEl) { statusEl.className = 'status-msg show error'; statusEl.textContent = `エラー: ${e.message}`; }
    if (btn) btn.disabled = false;
  }
}

async function cancelLimineIsoDownload() {
  const cancelBtn = document.getElementById('btn-limine-iso-dl-cancel');
  if (cancelBtn) cancelBtn.disabled = true;
  try {
    await fetch('/api/limine/iso-download/cancel', { method: 'POST' });
  } catch (e) {}
}


// --- Helpers ---
function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function escapeJs(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/</g, '\\x3c')
    .replace(/>/g, '\\x3e');
}

// HTML属性値 (value="..." 等) 用。escapeHtml は " を &quot; にするので属性値に適するが
// JS文字列と混同しないよう専用ヘルパーとして分離する。
function escapeAttr(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function showStatus(msg, type) {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    container.style.position = 'fixed';
    document.body.appendChild(container);
  }
  const el = document.createElement('div');
  el.className = `status-msg show ${type}`;
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

// --- servEX ---
async function openServex() {
  try {
    const resp = await fetch('/api/servex/status');
    const data = await resp.json();

    if (data.installed && data.url) {
      window.open(data.url, '_blank');
    } else if (data.installed) {
      switchTab('terminal');
      showStatus('servEXはインストール済みです。URLを取得できませんでした。', 'info');
    } else {
      if (!confirm('servEXはまだインストールされていません。\nインストールしますか？')) return;
      switchTab('terminal');
      showStatus('servEXをインストール中... ターミナルで進捗を確認できます。', 'info');
      setTimeout(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          const installCmd = 'cd /tmp && sudo git clone https://github.com/hirogura/servex.git && cd servex && sudo bash install-servex.sh\n';
          ws.send(JSON.stringify({ type: 'input', data: installCmd }));
        } else {
          showStatus('ターミナルに接続できません', 'error');
        }
      }, 500);
    }
  } catch (e) {
    showStatus(`servEX確認エラー: ${e.message}`, 'error');
  }
}

// --- Selfcode ---
async function openSelfcode() {
  try {
    const resp = await fetch('/api/selfcode/status');
    const data = await resp.json();

    if (data.installed && data.url) {
      // Open selfcode in new tab
      window.open(data.url, '_blank');
    } else if (data.installed) {
      // Installed but URL unknown
      switchTab('terminal');
      showStatus('selfcodeはインストール済みです。URLを取得できませんでした。', 'info');
    } else {
      // Not installed - confirm before installing
      if (!confirm('selfcodeはまだインストールされていません。\nインストールしますか？')) return;
      switchTab('terminal');
      showStatus('selfcodeをインストール中... ターミナルで進捗を確認できます。', 'info');
      setTimeout(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          const installCmd = 'sudo pacman -S --needed --noconfirm git curl nodejs npm && curl -fsSL https://raw.githubusercontent.com/hirogura/selfcode/main/install-selfcode.sh -o /tmp/install-selfcode.sh && sudo bash /tmp/install-selfcode.sh\n';
          ws.send(JSON.stringify({ type: 'input', data: installCmd }));
        } else {
          showStatus('ターミナルに接続できません', 'error');
        }
      }, 500);
    }
  } catch (e) {
    showStatus(`selfcode確認エラー: ${e.message}`, 'error');
  }
}

// --- Easy LXD ---
async function openEasyLXD() {
  try {
    const resp = await fetch('/api/easylxd/status');
    const data = await resp.json();

    if (data.installed && data.url) {
      window.open(data.url, '_blank');
    } else {
      if (!confirm('Easy LXDはまだインストールされていません。\nインストールしますか？')) return;
      switchTab('terminal');
      showStatus('Easy LXDをインストール中...', 'info');
      setTimeout(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          const installCmd = 'curl -fsSL -o /tmp/install-easylxd1.sh https://raw.githubusercontent.com/hirogura/easylxd/main/install-easylxd1.sh && chmod +x /tmp/install-easylxd1.sh && sudo /tmp/install-easylxd1.sh\n';
          ws.send(JSON.stringify({ type: 'input', data: installCmd }));
        } else {
          showStatus('ターミナルに接続できません', 'error');
        }
      }, 500);
    }
  } catch (e) {
    showStatus(`Easy LXD確認エラー: ${e.message}`, 'error');
  }
}

// --- VM Manager ---
async function openVMManager() {
  try {
    const resp = await fetch('/api/vmmanager/status');
    const data = await resp.json();

    if (data.installed && data.url) {
      window.open(data.url, '_blank');
    } else {
      if (!confirm('VM Managerはまだインストールされていません。\nインストールしますか？')) return;
      switchTab('terminal');
      showStatus('VM Managerをインストール中...', 'info');
      setTimeout(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          const installCmd = 'curl -fsSL -o /tmp/install-vmmanager.sh https://raw.githubusercontent.com/hirogura/vmmanager/main/install-vmmanager.sh && chmod +x /tmp/install-vmmanager.sh && sudo /tmp/install-vmmanager.sh\n';
          ws.send(JSON.stringify({ type: 'input', data: installCmd }));
        } else {
          showStatus('ターミナルに接続できません', 'error');
        }
      }, 500);
    }
  } catch (e) {
    showStatus(`VM Manager確認エラー: ${e.message}`, 'error');
  }
}

// --- ddrescueGUI ---
async function openDdrescueGui() {
  try {
    const resp = await fetch('/api/ddrescuegui/status');
    const data = await resp.json();

    if (data.installed && data.url) {
      window.open(data.url, '_blank');
    } else if (data.installed) {
      switchTab('terminal');
      showStatus('ddrescueGUIはインストール済みです。URLを取得できませんでした。', 'info');
    } else {
      if (!confirm('ddrescueGUIはまだインストールされていません。\nインストールしますか？')) return;
      switchTab('terminal');
      showStatus('ddrescueGUIをインストール中... ターミナルで進捗を確認できます。', 'info');
      setTimeout(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          const installCmd = 'sudo rm -rf /tmp/ddrescuegui && cd /tmp && sudo git clone https://github.com/hirogura/ddrescuegui.git && cd ddrescuegui && sudo bash install.sh\n';
          ws.send(JSON.stringify({ type: 'input', data: installCmd }));
        } else {
          showStatus('ターミナルに接続できません', 'error');
        }
      }, 500);
    }
  } catch (e) {
    showStatus(`ddrescueGUI確認エラー: ${e.message}`, 'error');
  }
}

// --- Backup / Restore ---
let backupStatusData = null;

// --- Clonezilla ISO Download ---
let czDlPollTimer = null;

function stopCzDlPolling() {
  if (czDlPollTimer) {
    clearInterval(czDlPollTimer);
    czDlPollTimer = null;
  }
}

async function loadClonezillaVersions() {
  const sel = document.getElementById('cz-version-select');
  const fileBtn = document.getElementById('btn-cz-files');
  try {
    const resp = await fetch('/api/backup/clonezilla-versions');
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    sel.innerHTML = data.versions.map(v =>
      `<option value="${escapeAttr(v.name)}">${escapeHtml(v.name)}</option>`
    ).join('') || '<option value="">バージョンがありません</option>';
    sel.disabled = false;
    fileBtn.disabled = false;
  } catch (e) {
    sel.innerHTML = '<option value="">バージョン一覧の取得に失敗しました</option>';
    showBackupStatus(`Clonezillaバージョン取得エラー: ${e.message}`, 'error');
  }
}

async function loadClonezillaFiles() {
  const version = document.getElementById('cz-version-select').value;
  const fileSel = document.getElementById('cz-file-select');
  const dlBtn = document.getElementById('btn-cz-dl');
  if (!version) return;
  fileSel.innerHTML = '<option value="">読み込み中...</option>';
  fileSel.disabled = true;
  dlBtn.disabled = true;
  try {
    const resp = await fetch(`/api/backup/clonezilla-files?version=${encodeURIComponent(version)}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    fileSel.innerHTML = data.files.map(f =>
      `<option value="${escapeAttr(f.download_url)}" data-filename="${escapeAttr(f.name)}">${escapeHtml(f.name)}</option>`
    ).join('') || '<option value="">ISOファイルがありません</option>';
    fileSel.disabled = false;
    dlBtn.disabled = false;
  } catch (e) {
    fileSel.innerHTML = '<option value="">ファイル一覧の取得に失敗しました</option>';
    showBackupStatus(`Clonezillaファイル取得エラー: ${e.message}`, 'error');
  }
}

async function pollCzDownloadStatus() {
  const statusEl = document.getElementById('cz-dl-status');
  const progress = document.getElementById('cz-dl-progress');
  const bar = document.getElementById('cz-dl-progress-bar');
  const text = document.getElementById('cz-dl-progress-text');
  const dlBtn = document.getElementById('btn-cz-dl');
  const cancelBtn = document.getElementById('btn-cz-dl-cancel');
  let s;
  try {
    const resp = await fetch('/api/limine/iso-download/status');
    s = await resp.json();
  } catch (e) {
    return;
  }
  if (s.running) {
    dlBtn.disabled = true;
    cancelBtn.disabled = false;
    progress.style.display = 'block';
    if (s.total > 0) {
      const pct = Math.min(100, Math.round((s.size / s.total) * 100));
      bar.style.width = pct + '%';
      text.textContent = `${s.filename} — ${formatBytesJS(s.size)} / ${formatBytesJS(s.total)} (${pct}%)`;
    } else {
      bar.style.width = '0%';
      text.textContent = `${s.filename} — ${formatBytesJS(s.size)}`;
    }
    statusEl.className = 'status-msg show info';
    statusEl.innerHTML = '<span class="spinner"></span> /iso にダウンロード中...';
    return;
  }
  stopCzDlPolling();
  progress.style.display = 'none';
  cancelBtn.disabled = true;
  if (s.success === true || s.success === false) {
    dlBtn.disabled = false;
    document.getElementById('cz-file-select').disabled = false;
    document.getElementById('btn-cz-files').disabled = false;
    if (s.success) {
      statusEl.className = 'status-msg show success';
      statusEl.textContent = `${s.filename} を /iso に保存しました（${formatBytesJS(s.size)}）`;
      loadBackupStatus();
    } else if (s.cancelled) {
      statusEl.className = 'status-msg show error';
      statusEl.textContent = 'ダウンロードをキャンセルしました';
    } else {
      statusEl.className = 'status-msg show error';
      statusEl.textContent = `ダウンロード失敗: ${s.log || '不明なエラー'}`;
    }
  }
}

async function downloadClonezillaIso() {
  const fileSel = document.getElementById('cz-file-select');
  const statusEl = document.getElementById('cz-dl-status');
  const dlBtn = document.getElementById('btn-cz-dl');
  const opt = fileSel.options[fileSel.selectedIndex];
  const url = fileSel.value;
  const filename = opt ? opt.dataset.filename : '';
  if (!url || !filename) {
    statusEl.className = 'status-msg show error';
    statusEl.textContent = 'ISOファイルを選択してください';
    return;
  }
  dlBtn.disabled = true;
  fileSel.disabled = true;
  document.getElementById('btn-cz-files').disabled = true;
  statusEl.className = 'status-msg show info';
  statusEl.innerHTML = '<span class="spinner"></span> ダウンロードを開始しています...';
  try {
    const resp = await fetch('/api/backup/clonezilla-download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, filename }),
    });
    const data = await resp.json();
    if (!data.success) {
      statusEl.className = 'status-msg show error';
      statusEl.textContent = data.message;
      dlBtn.disabled = false;
      fileSel.disabled = false;
      document.getElementById('btn-cz-files').disabled = false;
      return;
    }
    stopCzDlPolling();
    pollCzDownloadStatus();
    czDlPollTimer = setInterval(pollCzDownloadStatus, 1000);
  } catch (e) {
    statusEl.className = 'status-msg show error';
    statusEl.textContent = `エラー: ${e.message}`;
    dlBtn.disabled = false;
    fileSel.disabled = false;
    document.getElementById('btn-cz-files').disabled = false;
  }
}

async function cancelClonezillaDownload() {
  if (!confirm('ダウンロードをキャンセルしますか？\n保存中の部分ファイルは削除されます。')) return;
  document.getElementById('btn-cz-dl-cancel').disabled = true;
  try {
    await fetch('/api/limine/iso-download/cancel', { method: 'POST' });
  } catch (e) {}
  pollCzDownloadStatus();
}

function syncCzDownloadStatus() {
  fetch('/api/limine/iso-download/status')
    .then(r => r.json())
    .then(s => {
      if (s.running && !czDlPollTimer) {
        stopCzDlPolling();
        pollCzDownloadStatus();
        czDlPollTimer = setInterval(pollCzDownloadStatus, 1000);
      }
    })
    .catch(() => {});
}

async function loadBackupPage() {
  loadBackupStatus();
  loadBackupPartitions();
  loadClonezillaVersions();
  syncCzDownloadStatus();
}

function setBackupControlsEnabled(enabled) {
  ['backup-dest-select', 'btn-backup-run', 'restore-src-select', 'btn-restore-scan', 'restore-img-select', 'btn-restore-run'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.disabled = !enabled;
  });
}

async function loadBackupStatus() {
  const envEl = document.getElementById('backup-env-status');
  try {
    const resp = await fetch('/api/backup/status');
    backupStatusData = await resp.json();
    const d = backupStatusData;

    let html =
      `<div>Clonezilla ISO: ${d.iso_found
        ? `<span class="text-success">検出</span> (${escapeHtml(d.iso_path || '?')})`
        : `<span class="text-danger">見つかりません</span> (/iso/${'clonezilla-live-*.iso'})`}</div>` +
      `<div>保存用パーティション (/iso): ${d.iso_mounted
        ? `<span class="text-success">マウント済み</span> (${escapeHtml(d.iso_source || '?')}${d.iso_fstype ? ', ' + escapeHtml(d.iso_fstype) : ''}${d.iso_size ? ', ' + escapeHtml(d.iso_size) : ''})`
        : '<span class="text-warn">未マウント</span>'}</div>`;
    if (d.secure_boot) {
      html += `<div class="text-warn" style="margin-top:0.3rem;">⚠ Secure Boot が有効です。ISOループバックブートは起動できないため、無効化してください。</div>`;
    }
    if (!d.limine_present) {
      html += `<div class="text-warn" style="margin-top:0.3rem;">⚠ /boot/limine.conf が見つかりません。Limine 環境で実行してください。</div>`;
    } else {
      html += `<div class="muted" style="margin-top:0.3rem;">注: バックアップ時は既定を linux-cachyos に固定し remember_last_entry を無効化します。復元時は AutoRestore を一時的に既定にします。</div>`;
    }
    if (!d.iso_found || !d.iso_mounted) {
      html += `<div class="text-warn" style="margin-top:0.3rem;">${!d.iso_mounted
        ? '/iso に保存用パーティションをマウントしてください。'
        : `${escapeHtml('/iso')} に clonezilla-live-*.iso を配置してください。`}</div>`;
    }
    envEl.innerHTML = html;
    setBackupControlsEnabled(d.iso_found && d.iso_mounted);
  } catch (e) {
    envEl.innerHTML = `<span class="text-danger">状態の取得に失敗しました: ${escapeHtml(e.message)}</span>`;
  }
}

async function loadBackupPartitions() {
  const destSel = document.getElementById('backup-dest-select');
  const srcSel = document.getElementById('restore-src-select');
  try {
    const resp = await fetch('/api/backup/partitions');
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    const options = data.partitions.map(p => {
      const label = [p.device, p.size, p.fstype || '(fs不明)', p.mountpoint ? `mount=${p.mountpoint}` : null]
        .filter(Boolean).join(' / ');
      return `<option value="${escapeAttr(p.device)}">${escapeHtml(label)}</option>`;
    }).join('');
    destSel.innerHTML = options || '<option value="">パーティションがありません</option>';
    srcSel.innerHTML = options || '<option value="">パーティションがありません</option>';
  } catch (e) {
    destSel.innerHTML = '<option value="">パーティション一覧の取得に失敗しました</option>';
    srcSel.innerHTML = '<option value="">パーティション一覧の取得に失敗しました</option>';
    showBackupStatus(`パーティション一覧の取得エラー: ${e.message}`, 'error');
  }
}

function showBackupStatus(msg, type) {
  const el = document.getElementById('backup-status-msg');
  el.textContent = msg;
  el.className = `status-msg show ${type}`;
  clearTimeout(el._timer);
  el._timer = setTimeout(() => { el.className = 'status-msg'; }, 6000);
}

async function sendToTerminal(cmd, infoMsg) {
  switchTab('terminal');
  if (infoMsg) showStatus(infoMsg, 'info');
  const startTime = Date.now();
  const trySend = () => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      setTimeout(() => {
        ws.send(JSON.stringify({ type: 'input', data: cmd + '\n' }));
      }, 300);
    } else if (Date.now() - startTime < 8000) {
      setTimeout(trySend, 150);
    } else {
      showStatus('ターミナルに接続できませんでした', 'error');
    }
  };
  trySend();
}

async function prepareClonezillaRun(mode, device, image, confirmMsg) {
  if (!confirm(confirmMsg)) return false;
  setBackupControlsEnabled(false);
  showBackupStatus('Limineエントリを準備中... (ISO解析・書き込みのため時間がかかる場合があります)', 'info');
  try {
    const resp = await fetch('/api/backup/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode, device, image }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || !data.success) {
      throw new Error(data.detail || `HTTP ${resp.status}`);
    }
    showBackupStatus(`${data.message}\nまもなく再起動します...`, 'info');
    setTimeout(async () => {
      await fetch('/api/system/reboot', { method: 'POST' });
    }, 2000);
    return true;
  } catch (e) {
    showBackupStatus(`準備エラー: ${e.message}`, 'error');
    setBackupControlsEnabled(true);
    return false;
  }
}

async function runBackup() {
  const device = document.getElementById('backup-dest-select').value;
  if (!device) {
    showBackupStatus('保存先パーティションを選択してください', 'error');
    return;
  }
  await prepareClonezillaRun('backup', device, '',
    `バックアップを開始しますか？\n\n保存先パーティション: ${device}\n\n・Limineエントリを作成します\n・再起動後、Clonezilla Live がバックアップを行い、完了後に自動で再起動します`);
}

async function loadRestoreImages() {
  const srcSel = document.getElementById('restore-src-select');
  const imgSel = document.getElementById('restore-img-select');
  const device = srcSel.value;
  if (!device) {
    showBackupStatus('パーティションを選択してください', 'error');
    return;
  }
  const scanBtn = document.getElementById('btn-restore-scan');
  scanBtn.disabled = true;
  imgSel.innerHTML = '<option value="">検索中...</option>';
  try {
    const resp = await fetch('/api/backup/images', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device }),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.detail || `HTTP ${resp.status}`);
    }
    const data = await resp.json();
    if (data.images.length === 0) {
      imgSel.innerHTML = `<option value="">バックアップイメージが見つかりません (${escapeHtml(data.prefix)}-*)</option>`;
      showBackupStatus(`${device} にバックアップイメージが見つかりませんでした`, 'error');
      return;
    }
    imgSel.innerHTML = data.images.map(img =>
      `<option value="${escapeAttr(img)}">${escapeHtml(img)}</option>`).join('');
    showBackupStatus(`${data.images.length} 件のバックアップイメージが見つかりました`, 'success');
  } catch (e) {
    imgSel.innerHTML = '<option value="">イメージ一覧の取得に失敗しました</option>';
    showBackupStatus(`イメージ一覧の取得エラー: ${e.message}`, 'error');
  } finally {
    scanBtn.disabled = false;
  }
}

async function runRestore() {
  const device = document.getElementById('restore-src-select').value;
  const image = document.getElementById('restore-img-select').value;
  if (!device || !image) {
    showBackupStatus('パーティションとイメージを選択してください', 'error');
    return;
  }
  await prepareClonezillaRun('restore', device, image,
    `復元を開始しますか？\n\n復元元パーティション: ${device}\nバックアップイメージ: ${image}\n\n⚠️ 現在のシステムは選択したバックアップの内容で上書きされます\n⚠️ Limineエントリを作成し、Clonezilla Live が復元を行います\n⚠️ 処理中に電源を切らないでください`);
}

// --- Snapper ---
let snapperConfigs = [];

async function loadSnapperPage() {
  const sel = document.getElementById('snapper-config-select');
  const statusEl = document.getElementById('snapper-status-msg');
  try {
    const resp = await fetch('/api/snapper/status');
    const data = await resp.json();
    if (!data.installed) {
      statusEl.className = 'status-msg show error';
      statusEl.textContent = 'snapper がインストールされていません (sudo pacman -S snapper)';
      sel.disabled = true;
      document.getElementById('btn-snapper-create').disabled = true;
      document.getElementById('snapper-list-container').innerHTML = '';
      return;
    }
    document.getElementById('btn-snapper-create').disabled = false;
    statusEl.className = 'status-msg';
    statusEl.textContent = '';
    snapperConfigs = data.configs || [];
    if (!snapperConfigs.length) {
      sel.innerHTML = '<option value="">設定がありません</option>';
      sel.disabled = true;
      document.getElementById('snapper-list-container').innerHTML =
        '<p class="muted">snapper の設定がありません。ターミナルで snapper create-config を実行してください。</p>';
      return;
    }
    const prev = sel.value;
    sel.innerHTML = snapperConfigs.map(c =>
      `<option value="${escapeAttr(c.config)}">${escapeHtml(c.config)}${c.subvolume ? ` (${escapeHtml(c.subvolume)})` : ''}</option>`
    ).join('');
    sel.disabled = false;
    if (prev && snapperConfigs.some(c => c.config === prev)) {
      sel.value = prev;
    }
    loadSnapperSnapshots();
  } catch (e) {
    statusEl.className = 'status-msg show error';
    statusEl.textContent = `Snapper状態取得エラー: ${e.message}`;
  }
}

async function loadSnapperSnapshots() {
  const sel = document.getElementById('snapper-config-select');
  const config = (sel && sel.value) || 'root';
  const container = document.getElementById('snapper-list-container');
  const statusEl = document.getElementById('snapper-status-msg');
  container.innerHTML = '<p class="muted"><span class="spinner"></span> スナップショット一覧を取得中...</p>';
  try {
    const resp = await fetch(`/api/snapper/snapshots?config=${encodeURIComponent(config)}`);
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.detail || `HTTP ${resp.status}`);
    if (!data.snapshots || data.snapshots.length === 0) {
      container.innerHTML = '<p class="muted">スナップショットはありません。ページ上部の「作成」ボタンで作成できます。</p>';
      return;
    }
    container.innerHTML = `
      <table class="proc-table">
        <thead>
          <tr><th>#</th><th>日時</th><th>説明</th><th>クリーンアップ</th><th>操作</th></tr>
        </thead>
        <tbody>
          ${data.snapshots.map(s => `
            <tr>
              <td>${s.number}</td>
              <td>${escapeHtml(s.date || '-')}</td>
              <td>${escapeHtml(s.description || '-')}<span class="muted"> (${escapeHtml(s.type || '')})</span></td>
              <td>${escapeHtml(s.cleanup || '-')}</td>
              <td>
                <div class="btn-group">
                  <button class="btn btn-sm btn-primary" onclick="restoreSnapper(${Number(s.number) || 0})">復元</button>
                  <button class="btn btn-sm btn-danger" onclick="deleteSnapper(${Number(s.number) || 0})">削除</button>
                </div>
              </td>
            </tr>`).join('')}
        </tbody>
      </table>`;
  } catch (e) {
    container.innerHTML = '';
    statusEl.className = 'status-msg show error';
    statusEl.textContent = `一覧取得エラー: ${e.message}`;
  }
}

function openSnapperCreateModal() {
  const sel = document.getElementById('snapper-config-select');
  document.getElementById('snapper-create-config-label').textContent =
    `設定: ${(sel && sel.value) || 'root'}`;
  document.getElementById('snapper-create-desc').value = '';
  document.getElementById('snapper-create-cleanup').value = '';
  document.getElementById('snapper-create-status').className = 'status-msg';
  document.getElementById('snapper-create-modal').style.display = 'flex';
  setTimeout(() => document.getElementById('snapper-create-desc').focus(), 100);
}

function closeSnapperCreateModal() {
  document.getElementById('snapper-create-modal').style.display = 'none';
}

async function submitSnapperCreate() {
  const sel = document.getElementById('snapper-config-select');
  const config = (sel && sel.value) || 'root';
  const description = document.getElementById('snapper-create-desc').value.trim();
  const cleanup = document.getElementById('snapper-create-cleanup').value;
  const statusEl = document.getElementById('snapper-create-status');
  const submitBtn = document.getElementById('btn-snapper-create-submit');

  statusEl.className = 'status-msg show info';
  statusEl.innerHTML = '<span class="spinner"></span> 作成中...';
  submitBtn.disabled = true;
  try {
    const resp = await fetch('/api/snapper/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config, description, cleanup }),
    });
    const data = await resp.json().catch(() => ({}));
    submitBtn.disabled = false;
    if (!resp.ok || !data.success) {
      throw new Error(data.detail || data.message || `HTTP ${resp.status}`);
    }
    statusEl.className = 'status-msg show success';
    statusEl.textContent = data.message;
    showStatus(data.message, 'success');
    setTimeout(() => {
      closeSnapperCreateModal();
      loadSnapperSnapshots();
    }, 1000);
  } catch (e) {
    submitBtn.disabled = false;
    statusEl.className = 'status-msg show error';
    statusEl.textContent = `エラー: ${e.message}`;
  }
}

async function deleteSnapper(number) {
  const sel = document.getElementById('snapper-config-select');
  const config = (sel && sel.value) || 'root';
  if (!confirm(`スナップショット #${number} を削除しますか？\n\n削除後は元に戻せません。`)) return;
  const statusEl = document.getElementById('snapper-status-msg');
  try {
    const resp = await fetch('/api/snapper/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config, number }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || !data.success) {
      throw new Error(data.detail || data.message || `HTTP ${resp.status}`);
    }
    showStatus(data.message, 'success');
    loadSnapperSnapshots();
  } catch (e) {
    statusEl.className = 'status-msg show error';
    statusEl.textContent = `削除エラー: ${e.message}`;
  }
}

async function restoreSnapper(number) {
  const sel = document.getElementById('snapper-config-select');
  const config = (sel && sel.value) || 'root';
  if (!confirm(`スナップショット #${number} に復元しますか？\n\n現在のシステム状態は上書きされます。\n復元後は再起動が必要です。`)) return;
  const statusEl = document.getElementById('snapper-status-msg');
  statusEl.className = 'status-msg show info';
  statusEl.innerHTML = '<span class="spinner"></span> 復元中...';
  try {
    const resp = await fetch('/api/snapper/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config, number }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || !data.success) {
      throw new Error(data.detail || data.message || `HTTP ${resp.status}`);
    }
    statusEl.className = 'status-msg show success';
    statusEl.textContent = data.message;
    showStatus(data.message, 'success');
  } catch (e) {
    statusEl.className = 'status-msg show error';
    statusEl.textContent = `復元エラー: ${e.message}`;
  }
}

// --- Apps ---
const APPS_INSTALL_DEFS = [
  { key: 'japanese', label: '日本語入力', desc: 'fcitx5 + Mozc を導入し日本語入力を設定 (cachyos-mozcjp.sh と同じ内容)' },
  { key: 'chrome', label: 'Google Chrome', desc: 'paru を導入し google-chrome をインストール' },
  { key: 'thunderbird', label: 'Thunderbird', desc: 'thunderbird + 日本語 language pack' },
  { key: 'libreoffice', label: 'LibreOffice', desc: 'libreoffice-fresh-ja (日本語版)' },
  { key: 'vlc', label: 'VLC', desc: 'vlc メディアプレイヤー' },
  { key: 'ssh', label: 'SSH', desc: 'sshd を有効化・起動し ufw で ssh を許可' },
  { key: 'rdp', label: 'リモートデスクトップ', desc: 'krdp (KDE リモートデスクトップ)' },
];

async function loadAppsPage() {
  await loadAppsStatus();
  await loadAppsShortcuts();
}

async function loadAppsStatus() {
  const listEl = document.getElementById('apps-install-list');
  const statusEl = document.getElementById('apps-status-msg');
  listEl.innerHTML = '<p class="muted"><span class="spinner"></span> 導入状態を確認中...</p>';
  try {
    const resp = await fetch('/api/apps/status');
    const data = await resp.json();
    const apps = data.apps || {};
    listEl.innerHTML = APPS_INSTALL_DEFS.map(def => {
      const st = apps[def.key] || {};
      const badge = st.installed
        ? '<span class="badge badge-active">導入済み</span>'
        : '<span class="badge badge-other">未導入</span>';
      return `
        <div style="display:flex;gap:0.6rem;align-items:flex-start;padding:0.45rem 0;border-bottom:1px solid var(--border);">
          <input type="checkbox" class="apps-install-check" value="${def.key}" style="margin-top:0.25rem;">
          <div style="flex:1;">
            <div style="display:flex;align-items:center;gap:0.5rem;">
              <span style="font-weight:600;">${escapeHtml(def.label)}</span>${badge}
            </div>
            <div class="muted" style="font-size:0.78rem;">${escapeHtml(def.desc)}${st.detail ? ` — <span style="font-family:monospace;">${escapeHtml(st.detail)}</span>` : ''}</div>
          </div>
        </div>`;
    }).join('');
    statusEl.className = 'status-msg';
    statusEl.textContent = '';
  } catch (e) {
    listEl.innerHTML = '';
    statusEl.className = 'status-msg show error';
    statusEl.textContent = `状態取得エラー: ${e.message}`;
  }
}

async function installSelectedApps() {
  const checks = Array.from(document.querySelectorAll('.apps-install-check:checked'));
  if (checks.length === 0) {
    showStatus('インストールするアプリを選択してください', 'error');
    return;
  }
  const keys = checks.map(c => c.value);
  const labels = keys.map(k => (APPS_INSTALL_DEFS.find(d => d.key === k) || {}).label || k).join(', ');
  if (!confirm(`以下のアプリをインストールしますか？\n\n${labels}\n\n時間がかかる場合があります (Chrome のビルド等)。完了までこのページを開いたままお待ちください。`)) return;
  const statusEl = document.getElementById('apps-install-status');
  const btn = document.getElementById('btn-apps-install');
  btn.disabled = true;
  statusEl.className = 'status-msg show info';
  statusEl.innerHTML = '<span class="spinner"></span> インストール中... (数分かかる場合があります)';
  try {
    const resp = await fetch('/api/apps/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apps: keys }),
    });
    const data = await resp.json().catch(() => ({}));
    btn.disabled = false;
    if (!resp.ok) {
      throw new Error(data.detail || `HTTP ${resp.status}`);
    }
    const results = data.results || {};
    const lines = keys.map(k => {
      const r = results[k] || {};
      const label = (APPS_INSTALL_DEFS.find(d => d.key === k) || {}).label || k;
      return `${r.success ? '✅' : '❌'} ${label}`;
    }).join('\n');
    statusEl.className = `status-msg show ${data.success ? 'success' : 'error'}`;
    statusEl.textContent = `${data.message || ''}\n${lines}`;
    showStatus(data.message || 'インストールが完了しました', data.success ? 'success' : 'error');
    loadAppsStatus();
    loadAppsShortcuts();
  } catch (e) {
    btn.disabled = false;
    statusEl.className = 'status-msg show error';
    statusEl.textContent = `エラー: ${e.message}`;
  }
}

async function loadAppsShortcuts() {
  const listEl = document.getElementById('apps-shortcut-list');
  const statusEl = document.getElementById('apps-shortcut-status');
  listEl.innerHTML = '<p class="muted"><span class="spinner"></span> ショートカット情報を取得中...</p>';
  try {
    const resp = await fetch('/api/apps/shortcuts');
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.detail || `HTTP ${resp.status}`);
    const items = data.shortcuts || [];
    if (data.desktop_dir) {
      listEl.innerHTML = `<p class="muted" style="margin-bottom:0.5rem;">保存先: <code>${escapeHtml(data.desktop_dir)}</code></p>` +
        items.map(it => {
          const badge = it.created
            ? '<span class="badge badge-active">作成済み</span>'
            : it.source_found
              ? '<span class="badge badge-other">未作成</span>'
              : '<span class="badge badge-warn">アプリ未導入</span>';
          const disabled = it.source_found ? '' : 'disabled';
          return `
            <div style="display:flex;gap:0.6rem;align-items:center;padding:0.35rem 0;border-bottom:1px solid var(--border);">
              <input type="checkbox" class="apps-shortcut-check" value="${escapeHtml(it.key)}" ${disabled}>
              <span style="flex:1;">${escapeHtml(it.label)}</span>${badge}
            </div>`;
        }).join('');
    }
    statusEl.className = 'status-msg';
    statusEl.textContent = '';
  } catch (e) {
    listEl.innerHTML = '';
    statusEl.className = 'status-msg show error';
    statusEl.textContent = `ショートカット情報取得エラー: ${e.message}`;
  }
}

async function createSelectedShortcuts() {
  const checks = Array.from(document.querySelectorAll('.apps-shortcut-check:checked'));
  if (checks.length === 0) {
    showStatus('作成するショートカットを選択してください', 'error');
    return;
  }
  const keys = checks.map(c => c.value);
  const statusEl = document.getElementById('apps-shortcut-status');
  const btn = document.getElementById('btn-apps-shortcut');
  btn.disabled = true;
  statusEl.className = 'status-msg show info';
  statusEl.innerHTML = '<span class="spinner"></span> ショートカットを作成中...';
  try {
    const resp = await fetch('/api/apps/shortcuts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shortcuts: keys }),
    });
    const data = await resp.json().catch(() => ({}));
    btn.disabled = false;
    if (!resp.ok) {
      throw new Error(data.detail || `HTTP ${resp.status}`);
    }
    statusEl.className = `status-msg show ${data.success ? 'success' : 'error'}`;
    statusEl.textContent = data.message || '';
    showStatus(data.message || 'ショートカットを作成しました', data.success ? 'success' : 'error');
    loadAppsShortcuts();
  } catch (e) {
    btn.disabled = false;
    statusEl.className = 'status-msg show error';
    statusEl.textContent = `エラー: ${e.message}`;
  }
}

// --- cachy-UI Fleet (一括管理) ---
let fleetNodes = [];
let fleetDetectLoading = false;
let fleetSettings = { intervalMs: 5000, pauseHidden: false };
let fleetTimer = null;

const FLEET_SETTINGS_KEY = 'cachyui_fleet_settings';

function loadFleetSettings() {
  try {
    const raw = JSON.parse(localStorage.getItem(FLEET_SETTINGS_KEY) || '{}');
    if ([5000, 10000, 15000, 30000, 60000].includes(raw.intervalMs)) {
      fleetSettings.intervalMs = raw.intervalMs;
    }
    if (typeof raw.pauseHidden === 'boolean') {
      fleetSettings.pauseHidden = raw.pauseHidden;
    }
  } catch (e) {}
  const selI = document.getElementById('fleet-interval-select');
  const selH = document.getElementById('fleet-hidden-select');
  if (selI) selI.value = String(fleetSettings.intervalMs);
  if (selH) selH.value = fleetSettings.pauseHidden ? 'on' : 'off';
}

function saveFleetSettings() {
  const selI = document.getElementById('fleet-interval-select');
  const selH = document.getElementById('fleet-hidden-select');
  if (selI) fleetSettings.intervalMs = parseInt(selI.value, 10) || 5000;
  if (selH) fleetSettings.pauseHidden = selH.value === 'on';
  try {
    localStorage.setItem(FLEET_SETTINGS_KEY, JSON.stringify(fleetSettings));
  } catch (e) {}
  restartFleetTimer();
  // 間隔を短くした場合は即時更新
  if (currentTab === 'fleet' && !(fleetSettings.pauseHidden && document.hidden)) {
    loadFleetPins();
  }
}

function restartFleetTimer() {
  if (fleetTimer) clearInterval(fleetTimer);
  fleetTimer = setInterval(() => {
    if (currentTab !== 'fleet') return;
    if (fleetSettings.pauseHidden && document.hidden) return;
    loadFleetPins();
  }, fleetSettings.intervalMs);
}

async function loadFleetPage() {
  loadFleetPins();
  if (fleetNodes.length) renderFleetDetect();
}

async function loadFleetPins() {
  const container = document.getElementById('fleet-pinned-container');
  try {
    const resp = await fetch('/api/fleet/pins', { cache: 'no-store' });
    const data = await resp.json();
    renderFleetPinned(data.pins || []);
  } catch (e) {
    container.innerHTML = `<p class="muted text-danger">ピン留め情報の取得エラー: ${escapeHtml(e.message)}</p>`;
  }
}

function renderFleetPinned(pins) {
  const container = document.getElementById('fleet-pinned-container');
  if (!pins.length) {
    container.innerHTML = '<p class="muted">ピン留めされたcachy-UIはありません。「cachy-UI自動検出」で検出したサーバーをピン留めすると、ここに固定表示されます。</p>';
    return;
  }
  container.innerHTML = `<div class="stats-grid">${pins.map(n => renderFleetCard(n)).join('')}</div>`;
}

function renderFleetCard(n) {
  const name = n.hostname || n.key;
  const selfBadge = n.is_self ? '<span class="badge badge-active" style="font-size:0.62rem;">このPC</span>' : '';
  const offBadge = n.reachable ? '' : '<span class="badge badge-warn" style="font-size:0.62rem;">応答なし</span>';

  let body;
  if (n.reachable && n.info) {
    const inf = n.info;
    const tempTxt = (inf.cpu_temp !== null && inf.cpu_temp !== undefined) ? `${inf.cpu_temp}°C` : '--';
    body =
      fleetMetricRow('CPU使用率・温度', inf.cpu_percent, tempTxt) +
      fleetMetricRow('メモリ使用率', inf.mem_percent, `${fmtGiB(inf.mem_used)} / ${fmtGiB(inf.mem_total)}`) +
      fleetMetricRow('ディスク使用量', inf.disk_percent, `${fmtGiB(inf.disk_used)} / ${fmtGiB(inf.disk_total)}`);
  } else {
    body = '<div class="muted" style="font-size:0.78rem;padding:0.4rem 0;">cachy-UIに接続できませんでした。</div>';
  }

  return `
    <div class="stat-card fleet-card${n.reachable ? '' : ' fleet-offline'}">
      <div class="fleet-card-head">
        <div class="wifi-ssid-cell">
          <svg class="icon-pin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1z"/></svg>
          <a class="fleet-host-link" href="${escapeAttr(n.url || '#')}" target="_blank" rel="noopener" title="新しいタブで開く">${escapeHtml(name)}</a>
          ${selfBadge}${offBadge}
        </div>
        <button class="btn btn-sm btn-secondary" onclick="unpinFleetNode('${escapeJs(n.key)}')" title="ピン留めを解除">解除</button>
      </div>
      ${body}
    </div>`;
}

function fleetMetricRow(label, pct, detail) {
  const p = (typeof pct === 'number') ? Math.round(pct) : null;
  const barClass = p === null ? '' : p > 80 ? 'danger' : p > 60 ? 'warn' : '';
  return `
    <div class="fleet-metric">
      <div class="fleet-metric-label">
        <span>${label}</span>
        <span><span class="fleet-metric-val">${p === null ? '--' : p + '%'}</span> <span class="fleet-metric-detail">${escapeHtml(detail || '')}</span></span>
      </div>
      <div class="stat-bar"><div class="stat-bar-fill ${barClass}" style="width:${p === null ? 0 : p}%;"></div></div>
    </div>`;
}

function fmtGiB(bytes) {
  if (bytes === null || bytes === undefined) return '--';
  const g = bytes / 1073741824;
  return g >= 1024 ? (g / 1024).toFixed(1) + ' TB' : g.toFixed(1) + ' GB';
}

async function detectFleet() {
  if (fleetDetectLoading) return;
  const btn = document.getElementById('btn-fleet-detect');
  const container = document.getElementById('fleet-detect-container');
  fleetDetectLoading = true;
  btn.disabled = true;
  container.innerHTML = '<p class="muted"><span class="spinner"></span> Tailnet内のcachy-UIを検出中... (ノード数によっては時間がかかります)</p>';
  try {
    const resp = await fetch('/api/fleet/detect', { cache: 'no-store' });
    const data = await resp.json();
    if (!resp.ok || data.success === false) throw new Error(data.error || `HTTP ${resp.status}`);
    fleetNodes = data.nodes || [];
    renderFleetDetect();
    showStatus(`稼働中のcachy-UIを${data.count}件検出しました`, data.count ? 'success' : 'info');
  } catch (e) {
    container.innerHTML = `<p class="muted text-danger">検出エラー: ${escapeHtml(e.message)}</p>`;
  } finally {
    fleetDetectLoading = false;
    btn.disabled = false;
  }
}

function renderFleetDetect() {
  const container = document.getElementById('fleet-detect-container');
  if (!fleetNodes.length) {
    container.innerHTML = '<p class="muted">Tailnet内に稼働中のcachy-UIは見つかりませんでした。</p>';
    return;
  }
  const rows = fleetNodes.map((n, i) => {
    const inf = n.info || {};
    const pinBtn = n.pinned
      ? `<button class="btn btn-sm btn-secondary" onclick="unpinFleetNode('${escapeJs(n.key)}')">解除</button>`
      : `<button class="btn btn-sm btn-primary" onclick="pinFleetNode(${i})">ピン留め</button>`;
    const st = n.reachable
      ? '<span class="badge badge-active">稼働中</span>'
      : '<span class="badge badge-other">応答なし</span>';
    let cpu = '--', mem = '--', disk = '--';
    if (n.reachable) {
      cpu = (inf.cpu_percent === null || inf.cpu_percent === undefined) ? '--'
        : `${Math.round(inf.cpu_percent)}%${(inf.cpu_temp !== null && inf.cpu_temp !== undefined) ? ` / ${inf.cpu_temp}°C` : ''}`;
      mem = (inf.mem_percent === null || inf.mem_percent === undefined) ? '--'
        : `${Math.round(inf.mem_percent)}% (${fmtGiB(inf.mem_used)} / ${fmtGiB(inf.mem_total)})`;
      disk = (inf.disk_percent === null || inf.disk_percent === undefined) ? '--'
        : `${Math.round(inf.disk_percent)}% (${fmtGiB(inf.disk_used)} / ${fmtGiB(inf.disk_total)})`;
    }
    return `
      <tr>
        <td>
          <a class="fleet-host-link" href="${escapeAttr(n.url || '#')}" target="_blank" rel="noopener" title="新しいタブで開く">${escapeHtml(n.hostname)}</a>
          ${n.is_self ? '<span class="badge badge-other" style="font-size:0.62rem;margin-left:0.3rem;">このPC</span>' : ''}
        </td>
        <td>${st}</td>
        <td>${cpu}</td>
        <td>${mem}</td>
        <td>${disk}</td>
        <td>${pinBtn}</td>
      </tr>`;
  }).join('');
  container.innerHTML = `
    <table class="proc-table">
      <thead>
        <tr><th>ホスト名</th><th>状態</th><th>CPU使用率・温度</th><th>メモリ使用率</th><th>ディスク使用量</th><th>操作</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

async function pinFleetNode(idx) {
  const n = fleetNodes[idx];
  if (!n) return;
  try {
    const resp = await fetch('/api/fleet/pin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: n.key, fqdn: n.fqdn, hostname: n.hostname, ips: n.ips }),
    });
    const data = await resp.json();
    showStatus(data.message || 'ピン留めしました', data.success !== false ? 'success' : 'error');
  } catch (e) {
    showStatus(`エラー: ${e.message}`, 'error');
  }
  refreshFleetView();
}

async function unpinFleetNode(key) {
  try {
    const resp = await fetch('/api/fleet/unpin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key }),
    });
    const data = await resp.json();
    showStatus(data.message || 'ピン留めを解除しました', data.success !== false ? 'success' : 'error');
  } catch (e) {
    showStatus(`エラー: ${e.message}`, 'error');
  }
  refreshFleetView();
}

function refreshFleetView() {
  const dn = key => fleetNodes.find(n => n.key === key);
  fetch('/api/fleet/pins', { cache: 'no-store' })
    .then(r => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    })
    .then(data => {
      const pinnedKeys = new Set((data.pins || []).map(p => p.key));
      fleetNodes.forEach(n => { n.pinned = pinnedKeys.has(n.key); });
      renderFleetDetect();
    })
    .catch((e) => { console.error('Fleet view refresh error:', e); });
  loadFleetPins();
}

// --- Init ---
document.addEventListener('DOMContentLoaded', () => {
  loadDashboard();
  loadFleetSettings();
  restartFleetTimer();

  // 非表示中の更新を停止している場合、再表示したタイミングで即時更新
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && currentTab === 'fleet' && fleetSettings.pauseHidden) {
      loadFleetPins();
    }
  });

  refreshInterval = setInterval(() => {
    if (currentTab === 'dashboard') loadDashboard();
  }, 5000);
});

