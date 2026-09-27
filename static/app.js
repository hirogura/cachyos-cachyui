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
// 外部ツールタブ (selfEx/selfcode/EasyLXD/VM Manager/Disk Manager) は別ページを開くだけで
// 対応する tab-xxx セクションが存在しないため、汎用リスナー・switchTabから除外する。
const EXTERNAL_TABS = new Set(['selfex', 'selfcode', 'easylxd', 'vmmanager', 'diskmanager']);
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

async function restartCachyUI(auto = false) {
  // auto=true の場合は確認ダイアログを出さずに再起動する (アップデート完了後の自動連携用)
  if (!auto && !confirm('cachy-UIを再起動しますか？')) return false;
  try {
    const resp = await fetch('/api/cachyui/restart', { method: 'POST' });
    const data = await resp.json();
    if (data.success) {
      if (!auto) {
        showStatus('cachy-UIを再起動しました。3秒後にページを更新します。', 'success');
        setTimeout(() => location.reload(), 3000);
      }
      return true;
    } else {
      showStatus(`再起動に失敗しました: ${data.errors || data.stderr}`, 'error');
      return false;
    }
  } catch (e) {
    showStatus(`再起動エラー: ${e.message}`, 'error');
    return false;
  }
}

// 再起動後の復旧待ち (アップデート完了後の自動連携用)
async function waitForCachyUI(timeoutMs = 60000) {
  const start = Date.now();
  // 再起動開始直後は旧プロセスがまだ応答するため、少し待ってから確認する
  await new Promise(r => setTimeout(r, 4000));
  while (Date.now() - start < timeoutMs) {
    try {
      const resp = await fetch('/api/system/info', { cache: 'no-store' });
      if (resp.ok) return true;
    } catch (e) {
      // 再起動中は接続失敗するので継続する
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  return false;
}

// アップデート完了後の自動連携: 再起動 → リフレッシュ → リロード
async function autoRestartAndRefreshAfterUpdate() {
  showStatus('アップデート完了！自動で「cachy-UI再起動」を実行します...', 'success');
  const ok = await restartCachyUI(true);
  if (!ok) {
    showStatus('自動再起動に失敗しました。サイドバーの「cachy-UI再起動」を手動で実行してください', 'error');
    return;
  }
  showStatus('cachy-UIを再起動中...復旧後に自動でリフレッシュします', 'info');
  const back = await waitForCachyUI(60000);
  if (!back) {
    showStatus('再起動コマンドを送信しました。ページを手動で更新してください', 'info');
    setTimeout(() => location.reload(), 2000);
    return;
  }
  showStatus('再起動完了！自動で「cachy-UIリフレッシュ」を実行します', 'success');
  try {
    refreshCurrentTab();
  } catch (e) {
    console.error('Auto refresh error:', e);
  }
  // 新版の app.js/index.html を確実に取得するためリロードする
  setTimeout(() => location.reload(), 1000);
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
  if (!confirm('cachy-UIを更新しますか？\nGitHubから最新版を取得してセットアップします。\n\n・完了まで数分かかる場合があります\n・完了後は自動で「cachy-UI再起動」→「cachy-UIリフレッシュ」を実行します')) return;

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
        // アップデート完了後は自動で再起動→リフレッシュを実行する
        autoRestartAndRefreshAfterUpdate();
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
      document.getElementById('btn-cachy-upgrade-all').style.display = 'none';
      document.getElementById('package-list-container').innerHTML =
        '<p class="muted">利用可能なアップデートはありません。</p>';
    } else {
      status.className = 'status-msg show info';
      status.textContent = `${data.count}個のパッケージがアップデート可能です。`;
      document.getElementById('btn-upgrade-all').style.display = 'inline-block';
      document.getElementById('btn-cachy-upgrade-all').style.display = 'none';

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

// --- Cachy-Update (公式 + AUR + Flatpak) ---
function cachyPackageRow(p, fn) {
  const detail = (p.info && p.info !== p.name) ? ` <span class="muted" style="font-size:0.75rem;">${escapeHtml(p.info)}</span>` : '';
  return `
    <div class="package-item">
      <span>${escapeHtml(p.name)}${detail}</span>
      <button class="btn btn-sm btn-primary" onclick="${fn}('${escapeJs(p.name)}')">更新</button>
    </div>`;
}

async function checkCachyUpdate() {
  const status = document.getElementById('package-status');
  status.className = 'status-msg show info';
  status.innerHTML = '<span class="spinner"></span> Cachy-Update確認中... (公式・AUR・Flatpakを確認するため時間がかかる場合があります)';

  try {
    const resp = await fetch('/api/packages/cachy-update');
    const data = await resp.json();

    document.getElementById('btn-upgrade-all').style.display = 'none';
    if (data.count === 0) {
      status.className = 'status-msg show success';
      status.textContent = '全パッケージが最新です (公式・AUR・Flatpak)。';
      document.getElementById('btn-cachy-upgrade-all').style.display = 'none';
      document.getElementById('package-list-container').innerHTML =
        '<p class="muted">利用可能なアップデートはありません。</p>';
      return;
    }

    status.className = 'status-msg show info';
    const parts = [];
    if (data.packages_count) parts.push(`公式 ${data.packages_count}件`);
    if (data.aur_count) parts.push(`AUR ${data.aur_count}件 (${escapeHtml(data.aur_helper || '')})`);
    if (data.flatpak_count) parts.push(`Flatpak ${data.flatpak_count}件`);
    status.innerHTML = `計${data.count}件のアップデートが可能です (${parts.join(' / ')})。`;
    document.getElementById('btn-cachy-upgrade-all').style.display = 'inline-block';

    const container = document.getElementById('package-list-container');
    let html = '';
    if ((data.packages || []).length) {
      html += `<h3 style="margin:0.5rem 0;">公式リポジトリ (${data.packages_count}件)</h3>`;
      html += data.packages.map(p => cachyPackageRow(p, 'upgradePackage')).join('');
    }
    if ((data.aur || []).length) {
      html += `<h3 style="margin:0.5rem 0;">AUR (${data.aur_count}件${data.aur_helper ? ` / ${escapeHtml(data.aur_helper)}` : ''})</h3>`;
      html += data.aur.map(p => cachyPackageRow(p, 'upgradeAurPackage')).join('');
    } else if (!data.aur_helper) {
      html += `<p class="muted">AUR: AURヘルパー (paru/yay/pikaur) がないためスキップしました。</p>`;
    }
    if ((data.flatpak || []).length) {
      html += `<h3 style="margin:0.5rem 0;">Flatpak (${data.flatpak_count}件)</h3>`;
      html += data.flatpak.map(p => cachyPackageRow(p, 'upgradeFlatpakPackage')).join('');
    } else if (!data.flatpak_available) {
      html += `<p class="muted">Flatpak: 対象外 (未導入またはアプリなし) のためスキップしました。</p>`;
    }
    container.innerHTML = html || '<p class="muted">利用可能なアップデートはありません。</p>';
  } catch (e) {
    status.className = 'status-msg show error';
    status.textContent = `エラー: ${e.message}`;
  }
}

async function upgradeCachyAll() {
  if (!confirm('Cachy-Updateと同じ一括更新を行いますか？\n\n公式リポジトリ → AUR → Flatpak の順に更新します。\n数分かかる場合があります。')) return;

  const status = document.getElementById('package-status');
  status.className = 'status-msg show info';
  status.innerHTML = '<span class="spinner"></span> Cachy-Updateで一括更新中... (数分かかる場合があります)';

  try {
    const resp = await fetch('/api/packages/cachy-update/upgrade', { method: 'POST' });
    const data = await resp.json();
    if (data.success) {
      status.className = 'status-msg show success';
      status.textContent = data.output ? `一括更新が完了しました。\n${data.output}` : '一括更新が完了しました。';
      checkCachyUpdate();
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

async function upgradeAurPackage(name) {
  const status = document.getElementById('package-status');
  status.className = 'status-msg show info';
  status.innerHTML = `<span class="spinner"></span> ${name} (AUR) を更新中...`;

  try {
    const resp = await fetch(`/api/packages/upgrade-aur/${encodeURIComponent(name)}`, { method: 'POST' });
    const data = await resp.json();
    if (data.success) {
      status.className = 'status-msg show success';
      status.textContent = `${name} を更新しました。`;
      checkCachyUpdate();
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

async function upgradeFlatpakPackage(appId) {
  const status = document.getElementById('package-status');
  status.className = 'status-msg show info';
  status.innerHTML = `<span class="spinner"></span> ${appId} (Flatpak) を更新中...`;

  try {
    const resp = await fetch('/api/packages/upgrade-flatpak', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: appId }),
    });
    const data = await resp.json();
    if (data.success) {
      status.className = 'status-msg show success';
      status.textContent = `${appId} を更新しました。`;
      checkCachyUpdate();
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

// --- Disks (表示専用: Disk Manager「パーティション操作」と同構成。操作は Disk Manager で行う) ---
const DISK_FS_COLORS = {
  ext4: '#16a34a', btrfs: '#0e7490', xfs: '#65a30d', ntfs: '#2563eb',
  vfat: '#eab308', exfat: '#f97316', fat32: '#eab308', fat16: '#eab308',
  swap: '#a855f7', '': '#64748b'
};

function diskFsColor(fstype) {
  fstype = (fstype || '').toLowerCase();
  return DISK_FS_COLORS[fstype] || '#0891b2';
}

function diskSegTitle(p) {
  return p.path + ' ' + p.size + (p.fstype ? ' [' + p.fstype + ']' : '') +
    (p.used ? ' 使用中' + p.used : '') + (p.mountpoint ? ' mounted:' + p.mountpoint : '');
}

async function loadDisks() {
  const container = document.getElementById('disks-container');
  const statusMsg = document.getElementById('disk-status-msg');
  container.innerHTML = '<p class="muted"><span class="spinner"></span> ディスク情報を取得中...</p>';
  statusMsg.className = 'status-msg';

  try {
    const resp = await fetch('/api/disks/info');
    const data = await resp.json();
    const devices = data.devices || [];

    if (devices.length === 0) {
      statusMsg.className = 'status-msg show info';
      statusMsg.textContent = 'ディスクデバイスが検出されませんでした。';
      container.innerHTML = '';
      document.getElementById('disk-legend').innerHTML = '';
      return;
    }

    buildDiskLegend(devices);
    container.innerHTML = devices.map(renderDiskInfo).join('');

  } catch (e) {
    statusMsg.className = 'status-msg show error';
    statusMsg.textContent = `ディスク情報取得エラー: ${e.message}`;
    container.innerHTML = '';
  }
}

function buildDiskLegend(devices) {
  const seen = {};
  devices.forEach(d => (d.partitions || []).forEach(p => { seen[(p.fstype || '').toLowerCase()] = true; }));
  const items = Object.keys(seen).map(f =>
    '<span><span class="disk-sw" style="background:' + diskFsColor(f) + '"></span>' + escapeHtml(f || '不明') + '</span>').join('') +
    '<span><span class="disk-sw disk-sw-free"></span>空き領域</span>' +
    '<span class="muted">■ 内側の暗い部分は使用中容量（参考値）</span>';
  document.getElementById('disk-legend').innerHTML = items;
}

function renderDiskInfo(d) {
  const sysBadge = d.is_system ? '<span class="disk-sys-badge">システム</span>' : '';
  const tableLabel = d.needs_init ? 'なし（未初期化）' : (d.table || '不明');
  const head = '<div class="disk-dev-path">' + escapeHtml(d.path) + ' — ' + escapeHtml(d.size) + ' [' + escapeHtml(tableLabel) + ']' + sysBadge + '</div>' +
    '<div class="disk-dev-meta">モデル: ' + escapeHtml(d.model || '-') + ' / シリアル: <span class="disk-serial">' + escapeHtml(d.serial || '-') + '</span> / 接続: ' + escapeHtml(d.tran || '不明') + '</div>';

  if (d.needs_init && !d.is_system) {
    const bar = '<div class="disk-pbar"><div class="disk-seg disk-free" style="width:100%" title="未初期化領域 ' + escapeHtml(d.size) + '">' +
      '<div class="disk-seg-label">未初期化 ' + escapeHtml(d.size) + '</div></div></div>';
    const rows = '<tr><td>未初期化領域</td><td>' + escapeHtml(d.size) + '</td><td>-</td><td>-</td><td>-</td><td>-</td></tr>';
    return '<div class="disk-dev">' + head +
      '<div class="muted" style="margin-top:8px">パーティションテーブルがありません。初期化・作成は Disk Manager で行ってください。</div>' +
      bar +
      '<table class="disk-part-table"><tr><th>パーティション</th><th>容量</th><th>FS</th><th>使用率</th><th>ラベル</th><th>マウント</th></tr>' + rows + '</table></div>';
  }

  const total = d.size_bytes || 1;
  const items = [];
  (d.partitions || []).forEach(p => items.push({ kind: 'part', start: p.start_bytes || 0, bytes: p.size_bytes || 0, p: p }));
  (d.free_spaces || []).forEach(f => items.push({ kind: 'free', start: f.start_bytes || 0, bytes: f.size_bytes || 0, f: f }));
  items.sort((a, b) => a.start - b.start);

  let bar = '<div class="disk-pbar">';
  items.forEach(it => {
    const pct = Math.max(0.6, it.bytes / total * 100);
    if (it.kind === 'part') {
      const p = it.p;
      let usePct = 0;
      if (p.used_bytes && p.size_bytes) usePct = Math.min(100, p.used_bytes / p.size_bytes * 100);
      const short = p.path.replace(d.path, '').replace('/dev/', '') || p.path;
      bar += '<div class="disk-seg" style="width:' + pct + '%;background:' + diskFsColor(p.fstype) + '" title="' + escapeHtml(diskSegTitle(p)) + '">' +
        (usePct ? '<div class="disk-used" style="width:' + usePct + '%"></div>' : '') +
        '<div class="disk-seg-label">' + escapeHtml(short) + '</div></div>';
    } else {
      const f = it.f;
      bar += '<div class="disk-seg disk-free" style="width:' + pct + '%" title="空き領域 ' + escapeHtml(f.size) + '">' +
        '<div class="disk-seg-label">空き ' + escapeHtml(f.size) + '</div></div>';
    }
  });
  bar += '</div>';

  const rows = (d.partitions || []).map(p => {
    let usePct = 0, useTxt = '-';
    if (p.used_bytes && p.size_bytes) {
      usePct = Math.min(100, p.used_bytes / p.size_bytes * 100);
      useTxt = p.use_percent || (usePct.toFixed(0) + '%');
    } else if (p.size_bytes) {
      useTxt = p.use_percent || '-';
    }
    const ubar = '<div class="disk-ubar"><div style="width:' + usePct + '%"></div></div>';
    return '<tr>' +
      '<td>' + escapeHtml(p.path) + '</td><td>' + escapeHtml(p.size) + '</td><td>' + escapeHtml(p.fstype || '-') + '</td>' +
      '<td>' + escapeHtml(useTxt) + '<br>' + ubar + '</td>' +
      '<td>' + escapeHtml(p.label || p.partlabel || '-') + '</td><td>' + escapeHtml(p.mountpoint || '-') + '</td></tr>';
  }).join('') + (d.free_spaces || []).map(f =>
    '<tr><td>空き領域</td><td>' + escapeHtml(f.size) + '</td><td>-</td><td>-</td><td>-</td><td>-</td></tr>'
  ).join('');

  return '<div class="disk-dev">' + head + bar +
    '<table class="disk-part-table"><tr><th>パーティション</th><th>容量</th><th>FS</th><th>使用率</th><th>ラベル</th><th>マウント</th></tr>' +
    (rows || '<tr><td colspan="6">パーティション情報がありません</td></tr>') + '</table></div>';
}

// ISOダウンロード進捗表示でも使う汎用ヘルパー (旧ディスク操作部にあった定義を残す)。
function formatBytesJS(b) {
  if (b >= 1024**3) return (b / 1024**3).toFixed(1) + ' GB';
  if (b >= 1024**2) return (b / 1024**2).toFixed(0) + ' MB';
  if (b >= 1024) return (b / 1024).toFixed(0) + ' KB';
  return b + ' B';
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
    const timeoutSel = document.getElementById('limine-timeout-select');
    if (timeoutSel && data.timeout && /^[1-9]$|^10$/.test(String(data.timeout).trim())) {
      timeoutSel.value = String(data.timeout).trim();
    }
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
        <tr><td style="color:var(--text-muted);">timeout (表示時間)</td><td><b>${d.timeout ? escapeHtml(String(d.timeout)) + '秒' : '未設定'}</b></td></tr>
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

async function setLimineTimeout() {
  const sel = document.getElementById('limine-timeout-select');
  const el = document.getElementById('limine-timeout-status');
  const value = (sel && sel.value || '').trim();
  if (!/^(10|[1-9])$/.test(value)) { if (el) { el.className = 'status-msg show error'; el.textContent = '1〜10秒の範囲で選択してください'; } return; }
  if (!confirm(`表示時間 (timeout) を「${value}秒」に設定しますか？`)) return;
  try {
    const resp = await fetch('/api/limine/timeout', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value }),
    });
    const data = await resp.json();
    if (el) { el.className = `status-msg show ${data.success ? 'success' : 'error'}`; el.textContent = data.message || data.detail || ''; }
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

// --- selfEx ---
async function openSelfex() {
  try {
    const resp = await fetch('/api/selfex/status');
    const data = await resp.json();

    if (data.installed && data.url) {
      window.open(data.url, '_blank');
    } else if (data.installed) {
      switchTab('terminal');
      showStatus('selfExはインストール済みです。URLを取得できませんでした。', 'info');
    } else {
      if (!confirm('selfExはまだインストールされていません。\nインストールしますか？')) return;
      switchTab('terminal');
      showStatus('selfExをインストール中... ターミナルで進捗を確認できます。', 'info');
      setTimeout(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          const installCmd = 'sudo bash -c "$(curl -fsSL https://raw.githubusercontent.com/hirogura/selfex/main/install-selfex1.sh)"\n';
          ws.send(JSON.stringify({ type: 'input', data: installCmd }));
        } else {
          showStatus('ターミナルに接続できません', 'error');
        }
      }, 500);
    }
  } catch (e) {
    showStatus(`selfEx確認エラー: ${e.message}`, 'error');
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

// --- Disk Manager ---
async function openDiskManager() {
  try {
    const resp = await fetch('/api/diskmanager/status');
    const data = await resp.json();

    if (data.installed && data.url) {
      window.open(data.url, '_blank');
    } else if (data.installed) {
      switchTab('terminal');
      showStatus('Disk Managerはインストール済みです。URLを取得できませんでした。', 'info');
    } else {
      if (!confirm('Disk Managerはまだインストールされていません。\nインストールしますか？')) return;
      switchTab('terminal');
      showStatus('Disk Managerをインストール中... ターミナルで進捗を確認できます。', 'info');
      setTimeout(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          const installCmd = 'sudo wget -O /tmp/diskmanager-install.sh https://raw.githubusercontent.com/hirogura/diskmanager/main/install.sh && sudo bash /tmp/diskmanager-install.sh\n';
          ws.send(JSON.stringify({ type: 'input', data: installCmd }));
        } else {
          showStatus('ターミナルに接続できません', 'error');
        }
      }, 500);
    }
  } catch (e) {
    showStatus(`Disk Manager確認エラー: ${e.message}`, 'error');
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
      html += `<div class="muted" style="margin-top:0.3rem;">注: バックアップ/復元時は次回1回のみ AutoBackup/AutoRestore を既定起動にし、処理前後 (ocs_prerun/ocs_postrun) で default_entry を通常 (バックアップ後は linux-cachyos の番号) へ戻し、remember_last_entry は no 固定です。メイン区画開始前の superblock 読み込みには時間がかかることがありますが仕様です。</div>`;
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
    `バックアップを開始しますか？\n\n保存先パーティション: ${device}\n\n・Limineエントリを作成し、次回起動のみ AutoBackup を自動選択します\n・バックアップ完了後は通常の linux-cachyos から自動で起動します\n・処理完了後に自動で再起動します`);
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
  statusEl.className = 'status-msg';
  statusEl.textContent = '';
  try {
    const resp = await fetch(`/api/snapper/snapshots?config=${encodeURIComponent(config)}`);
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.detail || `HTTP ${resp.status}`);
    // Limineスナップショット起動中のフォールバック表示は警告として残しつつ一覧は表示する
    if (data.warning) {
      statusEl.className = 'status-msg show info';
      statusEl.textContent = data.warning;
    }
    if (!data.snapshots || data.snapshots.length === 0) {
      container.innerHTML = '<p class="muted">スナップショットはありません。ページ上部の「作成」ボタンで作成できます。</p>';
      return;
    }
    // スナップショット起動中は起動中の番号を保持し、復元確認で使う
    window._snapperBoot = !!data.snapshot_boot;
    window._snapperBootId = (data.boot_snapshot ?? null);
    const bootId = window._snapperBootId;
    container.innerHTML = `
      <table class="proc-table">
        <thead>
          <tr><th>#</th><th>日時</th><th>説明</th><th>クリーンアップ</th><th>操作</th><th style="white-space:nowrap;"><button class="btn btn-sm btn-danger" onclick="deleteSnapperBulk()">一括削除</button></th></tr>
        </thead>
        <tbody>
          ${data.snapshots.map(s => {
            const num = Number(s.number) || 0;
            const isBoot = window._snapperBoot && bootId !== null && num === bootId;
            return `
            <tr${isBoot ? ' style="background:rgba(14,116,144,0.12);"' : ''}>
              <td>${s.number}${isBoot ? ' <span class="badge badge-active">起動中</span>' : ''}</td>
              <td>${escapeHtml(s.date || '-')}</td>
              <td>${escapeHtml(s.description || '-')}<span class="muted"> (${escapeHtml(s.type || '')})</span></td>
              <td>${escapeHtml(s.cleanup || '-')}</td>
              <td>
                <div class="btn-group">
                  <button class="btn btn-sm btn-primary" onclick="restoreSnapper(${num})">復元</button>
                  <button class="btn btn-sm btn-danger" onclick="deleteSnapper(${num})">削除</button>
                </div>
              </td>
              <td style="text-align:center;">
                <input type="checkbox" class="snapper-del-check" value="${num}" ${num === 0 ? 'disabled title="現在のシステム (#0) は削除できません"' : ''}>
              </td>
            </tr>`;}).join('')}
        </tbody>
      </table>
      <p class="muted" style="margin-top:0.5rem;font-size:0.78rem;">削除したいスナップショットにチェックを入れて「一括削除」を押してください（#0 は削除できません）。<a href="#" onclick="toggleSnapperChecks(true);return false;">全選択</a> / <a href="#" onclick="toggleSnapperChecks(false);return false;">全解除</a></p>`;
  } catch (e) {
    container.innerHTML = '';
    statusEl.className = 'status-msg show error';
    statusEl.textContent = `一覧取得エラー: ${e.message}`;
  }
}

function toggleSnapperChecks(on) {
  document.querySelectorAll('.snapper-del-check:not(:disabled)').forEach(c => { c.checked = !!on; });
}

async function deleteSnapperBulk() {
  const sel = document.getElementById('snapper-config-select');
  const config = (sel && sel.value) || 'root';
  const checks = Array.from(document.querySelectorAll('.snapper-del-check:checked')).map(c => Number(c.value) || 0).filter(n => n !== 0);
  if (!checks.length) {
    showStatus('一括削除するスナップショットにチェックを入れてください', 'error');
    return;
  }
  if (!confirm(`チェックした ${checks.length} 件のスナップショットを一括削除しますか？\n\n#${checks.join(', #')}\n\n削除後は元に戻せません。`)) return;
  const statusEl = document.getElementById('snapper-status-msg');
  statusEl.className = 'status-msg show info';
  statusEl.innerHTML = '<span class="spinner"></span> 一括削除中...';
  try {
    const resp = await fetch('/api/snapper/delete-many', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config, numbers: checks }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || !data.success) {
      throw new Error(data.detail || data.message || `HTTP ${resp.status}`);
    }
    statusEl.className = 'status-msg show success';
    statusEl.textContent = data.message;
    showStatus(data.message, 'success');
    loadSnapperSnapshots();
  } catch (e) {
    statusEl.className = 'status-msg show error';
    statusEl.textContent = `一括削除エラー: ${e.message}`;
  }
}

// --- Snapper サブボリューム一覧モーダル ---
async function openSnapperSubvolModal() {
  const sel = document.getElementById('snapper-config-select');
  const config = (sel && sel.value) || 'root';
  document.getElementById('snapper-subvol-config-label').textContent = `設定: ${config}`;
  document.getElementById('snapper-subvol-status').className = 'status-msg';
  document.getElementById('snapper-subvol-status').textContent = '';
  document.getElementById('snapper-subvol-body').innerHTML = '<p class="muted"><span class="spinner"></span> 取得中...</p>';
  document.getElementById('snapper-subvol-modal').style.display = 'flex';
  try {
    const resp = await fetch(`/api/snapper/subvolumes?config=${encodeURIComponent(config)}`);
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.detail || `HTTP ${resp.status}`);
    const body = document.getElementById('snapper-subvol-body');
    const cfgRows = (data.configs || []).map(c =>
      `<tr><td>${escapeHtml(c.config)}</td><td style="font-family:monospace;">${escapeHtml(c.subvolume || '-')}</td></tr>`
    ).join('');
    let btrfsHtml = '';
    if ((data.btrfs_subvolumes || []).length) {
      btrfsHtml = `<pre class="terminal-output" style="max-height:220px;overflow:auto;">${escapeHtml(data.btrfs_subvolumes.join('\n'))}</pre>
        <p class="muted" style="font-size:0.75rem;margin-top:0.3rem;">${data.btrfs_count} 件 (対象: ${escapeHtml(data.list_target || '')})</p>`;
    } else {
      btrfsHtml = `<p class="muted">${escapeHtml(data.btrfs_error || 'btrfs サブボリューム情報を取得できませんでした。')}</p>`;
    }
    body.innerHTML = `
      <h4 style="margin:0 0 0.4rem;">設定されているサブボリューム</h4>
      <table class="proc-table"><thead><tr><th>設定</th><th>サブボリューム</th></tr></thead><tbody>${cfgRows || '<tr><td colspan="2" class="muted">設定がありません</td></tr>'}</tbody></table>
      <h4 style="margin:1rem 0 0.4rem;">btrfs サブボリューム一覧 <span class="muted" style="font-weight:400;">(${escapeHtml(data.subvolume || '')})</span></h4>
      ${btrfsHtml}`;
  } catch (e) {
    document.getElementById('snapper-subvol-body').innerHTML = '';
    const st = document.getElementById('snapper-subvol-status');
    st.className = 'status-msg show error';
    st.textContent = `取得エラー: ${e.message}`;
  }
}

function closeSnapperSubvolModal() {
  document.getElementById('snapper-subvol-modal').style.display = 'none';
}

// --- Snapper 保持数 (number/timeline) モーダル ---
const SNAPPER_LIMIT_DEFS = [
  { key: 'NUMBER_CLEANUP', label: 'number クリーンアップ', type: 'yesno', desc: '古い number スナップショットを自動削除する' },
  { key: 'NUMBER_MIN_AGE', label: 'NUMBER_MIN_AGE (秒)', type: 'number', desc: 'この秒数より新しいスナップショットは削除対象外' },
  { key: 'NUMBER_LIMIT', label: 'NUMBER_LIMIT', type: 'number', desc: 'number スナップショットの保持数' },
  { key: 'NUMBER_LIMIT_IMPORTANT', label: 'NUMBER_LIMIT_IMPORTANT', type: 'number', desc: 'important な number スナップショットの保持数' },
  { key: 'TIMELINE_CREATE', label: 'timeline 作成', type: 'yesno', desc: 'timeline スナップショットを自動作成する' },
  { key: 'TIMELINE_CLEANUP', label: 'timeline クリーンアップ', type: 'yesno', desc: '古い timeline スナップショットを自動削除する' },
  { key: 'TIMELINE_MIN_AGE', label: 'TIMELINE_MIN_AGE (秒)', type: 'number', desc: 'この秒数より新しいスナップショットは削除対象外' },
  { key: 'TIMELINE_LIMIT_HOURLY', label: 'TIMELINE_LIMIT_HOURLY', type: 'number', desc: '時間単位の保持数' },
  { key: 'TIMELINE_LIMIT_DAILY', label: 'TIMELINE_LIMIT_DAILY', type: 'number', desc: '日単位の保持数' },
  { key: 'TIMELINE_LIMIT_WEEKLY', label: 'TIMELINE_LIMIT_WEEKLY', type: 'number', desc: '週単位の保持数' },
  { key: 'TIMELINE_LIMIT_MONTHLY', label: 'TIMELINE_LIMIT_MONTHLY', type: 'number', desc: '月単位の保持数' },
  { key: 'TIMELINE_LIMIT_YEARLY', label: 'TIMELINE_LIMIT_YEARLY', type: 'number', desc: '年単位の保持数' },
  { key: 'EMPTY_PRE_POST_CLEANUP', label: 'empty pre-post クリーンアップ', type: 'yesno', desc: '空の pre/post ペアを自動削除する' },
  { key: 'EMPTY_PRE_POST_MIN_AGE', label: 'EMPTY_PRE_POST_MIN_AGE (秒)', type: 'number', desc: '空ペア削除の最低経過秒数' },
];

async function openSnapperLimitsModal() {
  const sel = document.getElementById('snapper-config-select');
  const config = (sel && sel.value) || 'root';
  document.getElementById('snapper-limits-config-label').textContent = `設定: ${config}`;
  document.getElementById('snapper-limits-status').className = 'status-msg';
  document.getElementById('snapper-limits-status').textContent = '';
  document.getElementById('snapper-limits-body').innerHTML = '<p class="muted"><span class="spinner"></span> 読み込み中...</p>';
  document.getElementById('snapper-limits-modal').style.display = 'flex';
  try {
    const resp = await fetch(`/api/snapper/config/detail?config=${encodeURIComponent(config)}`);
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.detail || `HTTP ${resp.status}`);
    const vals = data.values || {};
    document.getElementById('snapper-limits-body').innerHTML = SNAPPER_LIMIT_DEFS.map(d => {
      const cur = vals[d.key] ?? '';
      let input;
      if (d.type === 'yesno') {
        input = `<select data-key="${d.key}" style="width:120px;padding:0.4rem;background:var(--bg-base);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text-primary);">
          <option value="yes" ${cur === 'yes' ? 'selected' : ''}>yes</option>
          <option value="no" ${cur === 'no' ? 'selected' : ''}>no</option>
        </select>`;
      } else {
        input = `<input type="number" min="0" data-key="${d.key}" value="${escapeAttr(String(cur))}" style="width:120px;padding:0.4rem;background:var(--bg-base);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text-primary);">`;
      }
      return `<div style="display:flex;gap:0.6rem;align-items:center;justify-content:space-between;padding:0.35rem 0;border-bottom:1px solid var(--border);">
        <div><div style="font-weight:600;font-size:0.82rem;">${d.label} <span class="muted" style="font-weight:400;font-family:monospace;">${d.key}</span></div>
        <div class="muted" style="font-size:0.72rem;">${d.desc}${cur !== '' ? ` (現在: ${escapeHtml(String(cur))})` : ''}</div></div>
        ${input}</div>`;
    }).join('');
  } catch (e) {
    document.getElementById('snapper-limits-body').innerHTML = '';
    const st = document.getElementById('snapper-limits-status');
    st.className = 'status-msg show error';
    st.textContent = `取得エラー: ${e.message}`;
  }
}

function closeSnapperLimitsModal() {
  document.getElementById('snapper-limits-modal').style.display = 'none';
}

async function submitSnapperLimits() {
  const sel = document.getElementById('snapper-config-select');
  const config = (sel && sel.value) || 'root';
  const inputs = Array.from(document.querySelectorAll('#snapper-limits-body [data-key]'));
  if (!inputs.length) return;
  const values = {};
  inputs.forEach(el => { values[el.getAttribute('data-key')] = el.value.trim(); });
  const statusEl = document.getElementById('snapper-limits-status');
  const btn = document.getElementById('btn-snapper-limits-submit');
  btn.disabled = true;
  statusEl.className = 'status-msg show info';
  statusEl.innerHTML = '<span class="spinner"></span> 保存中...';
  try {
    const resp = await fetch('/api/snapper/config/set', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config, values }),
    });
    const data = await resp.json().catch(() => ({}));
    btn.disabled = false;
    if (!resp.ok || !data.success) {
      throw new Error(data.detail || data.message || `HTTP ${resp.status}`);
    }
    statusEl.className = 'status-msg show success';
    statusEl.textContent = data.message;
    showStatus(data.message, 'success');
    setTimeout(closeSnapperLimitsModal, 1200);
  } catch (e) {
    btn.disabled = false;
    statusEl.className = 'status-msg show error';
    statusEl.textContent = `保存エラー: ${e.message}`;
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
  let msg = `スナップショット #${number} に復元しますか？\n\n現在のシステム状態は上書きされます。\n復元後は再起動が必要です。`;
  if (window._snapperBoot) {
    const bootNote = (window._snapperBootId !== null && window._snapperBootId !== undefined)
      ? `現在は #${window._snapperBootId} で起動中です。\n` : '';
    msg = `スナップショット起動中です。\n${bootNote}#${number} の内容でシステムを復元しますか？\n\n現行システムはバックアップとして残し、対応カーネルも復元します。\n復元後は必ず再起動してください（自動では再起動しません）。`;
  }
  if (!confirm(msg)) return;
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
  await loadVentoyUI();
  await loadLidSwitch();
  await loadDblock();
}

// --- Webアプリ: Ventoy-UI ---
async function loadVentoyUI() {
  const badgeEl = document.getElementById('ventoy-ui-badge');
  const detailEl = document.getElementById('ventoy-ui-detail');
  const statusEl = document.getElementById('ventoy-ui-status');
  if (!badgeEl) return;
  badgeEl.innerHTML = '<span class="badge badge-other">確認中...</span>';
  if (detailEl) detailEl.textContent = '';
  if (statusEl) { statusEl.className = 'status-msg'; statusEl.textContent = ''; }
  try {
    const resp = await fetch('/api/ventoyui/status');
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.detail || `HTTP ${resp.status}`);
    renderVentoyUI(data);
  } catch (e) {
    badgeEl.innerHTML = '<span class="badge badge-other">不明</span>';
    if (statusEl) {
      statusEl.className = 'status-msg show error';
      statusEl.textContent = `状態取得エラー: ${e.message}`;
    }
  }
}

function renderVentoyUI(data) {
  const badgeEl = document.getElementById('ventoy-ui-badge');
  const detailEl = document.getElementById('ventoy-ui-detail');
  if (!badgeEl) return;
  badgeEl.innerHTML = data.installed
    ? '<span class="badge badge-active">導入済み</span>'
    : '<span class="badge badge-other">未導入</span>';
  if (detailEl) {
    const parts = [];
    if (data.active) parts.push(`サービス: ${data.active}`);
    if (data.url) parts.push(data.url);
    else if (data.installed) parts.push('URLを取得できませんでした');
    detailEl.textContent = parts.join(' / ');
  }
}

async function installVentoyUI() {
  const statusEl = document.getElementById('ventoy-ui-status');
  const btn = document.getElementById('btn-ventoy-ui-install');
  if (!confirm('Ventoy-UIをインストールしますか？\n\n/opt/ventoy-ui に取得し、systemd サービス (ventoy-ui) として登録・起動します。\n数分かかる場合があります。')) return;
  if (btn) btn.disabled = true;
  if (statusEl) {
    statusEl.className = 'status-msg show info';
    statusEl.innerHTML = '<span class="spinner"></span> インストール中...';
  }
  try {
    const resp = await fetch('/api/ventoyui/install', { method: 'POST' });
    const data = await resp.json().catch(() => ({}));
    if (btn) btn.disabled = false;
    if (!resp.ok) throw new Error(data.detail || `HTTP ${resp.status}`);
    if (statusEl) {
      statusEl.className = `status-msg show ${data.success ? 'success' : 'error'}`;
      statusEl.textContent = data.message || '';
    }
    showStatus(data.message || 'インストールが完了しました', data.success ? 'success' : 'error');
    loadVentoyUI();
  } catch (e) {
    if (btn) btn.disabled = false;
    if (statusEl) {
      statusEl.className = 'status-msg show error';
      statusEl.textContent = `エラー: ${e.message}`;
    }
  }
}

async function openVentoyUI() {
  const statusEl = document.getElementById('ventoy-ui-status');
  try {
    const resp = await fetch('/api/ventoyui/status');
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.detail || `HTTP ${resp.status}`);
    renderVentoyUI(data);
    if (data.installed && data.url) {
      window.open(data.url, '_blank');
      return;
    }
    if (data.installed) {
      if (statusEl) {
        statusEl.className = 'status-msg show info';
        statusEl.textContent = 'Ventoy-UIはインストール済みですが、URLを取得できませんでした。';
      }
      showStatus('Ventoy-UIはインストール済みです。URLを取得できませんでした。', 'info');
      return;
    }
    if (statusEl) {
      statusEl.className = 'status-msg show error';
      statusEl.textContent = 'Ventoy-UIはまだインストールされていません。「インストール」を押してください。';
    }
    showStatus('Ventoy-UIはまだインストールされていません', 'error');
  } catch (e) {
    if (statusEl) {
      statusEl.className = 'status-msg show error';
      statusEl.textContent = `エラー: ${e.message}`;
    }
  }
}

// --- 設定: ノートPCで画面を閉じてもスリープしない (systemd-logind) ---
async function loadLidSwitch() {
  const badgeEl = document.getElementById('lid-switch-badge');
  const detailEl = document.getElementById('lid-switch-detail');
  const statusEl = document.getElementById('lid-switch-status');
  if (!badgeEl) return;
  badgeEl.innerHTML = '<span class="badge badge-other">確認中...</span>';
  if (detailEl) detailEl.textContent = '';
  if (statusEl) { statusEl.className = 'status-msg'; statusEl.textContent = ''; }
  try {
    const resp = await fetch('/api/system/lid-switch');
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.detail || `HTTP ${resp.status}`);
    renderLidSwitch(data);
  } catch (e) {
    badgeEl.innerHTML = '<span class="badge badge-other">不明</span>';
    if (statusEl) {
      statusEl.className = 'status-msg show error';
      statusEl.textContent = `状態取得エラー: ${e.message}`;
    }
  }
}

function renderLidSwitch(data) {
  const badgeEl = document.getElementById('lid-switch-badge');
  const detailEl = document.getElementById('lid-switch-detail');
  if (!badgeEl) return;
  badgeEl.innerHTML = data.enabled
    ? '<span class="badge badge-active">有効</span>'
    : '<span class="badge badge-other">無効</span>';
  if (detailEl) detailEl.textContent = data.detail || '';
}

async function setLidSwitch(enable) {
  const statusEl = document.getElementById('lid-switch-status');
  const btnEnable = document.getElementById('btn-lid-switch-enable');
  const btnDisable = document.getElementById('btn-lid-switch-disable');
  if (!confirm(enable
    ? '「ノートPCで画面を閉じてもスリープしない」を有効にしますか？\n蓋閉じ時の動作を ignore に設定し systemd-logind を再起動します。'
    : '「ノートPCで画面を閉じてもスリープしない」を無効にしますか？\n蓋を閉じると通常通りスリープするよう戻します。')) return;
  if (btnEnable) btnEnable.disabled = true;
  if (btnDisable) btnDisable.disabled = true;
  if (statusEl) {
    statusEl.className = 'status-msg show info';
    statusEl.innerHTML = '<span class="spinner"></span> 設定を適用中...';
  }
  try {
    const resp = await fetch('/api/system/lid-switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enable }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.detail || `HTTP ${resp.status}`);
    if (data.success) {
      if (statusEl) {
        statusEl.className = 'status-msg show success';
        statusEl.textContent = data.message || '設定を適用しました。';
      }
      renderLidSwitch(data);
      showStatus(data.message || '設定を適用しました', 'success');
    } else {
      if (statusEl) {
        statusEl.className = 'status-msg show error';
        statusEl.textContent = data.message || '設定に失敗しました。';
      }
    }
  } catch (e) {
    if (statusEl) {
      statusEl.className = 'status-msg show error';
      statusEl.textContent = `エラー: ${e.message}`;
    }
  } finally {
    if (btnEnable) btnEnable.disabled = false;
    if (btnDisable) btnDisable.disabled = false;
  }
}

// --- 設定: ロックファイルを削除する (CachyOS Hello の Remove db lock と同じ動作) ---
async function loadDblock() {
  const badgeEl = document.getElementById('dblock-badge');
  const detailEl = document.getElementById('dblock-detail');
  const statusEl = document.getElementById('dblock-status');
  if (!badgeEl) return;
  badgeEl.innerHTML = '<span class="badge badge-other">確認中...</span>';
  if (detailEl) detailEl.textContent = '';
  if (statusEl) { statusEl.className = 'status-msg'; statusEl.textContent = ''; }
  try {
    const resp = await fetch('/api/system/pacman-dblock');
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.detail || `HTTP ${resp.status}`);
    renderDblock(data);
  } catch (e) {
    badgeEl.innerHTML = '<span class="badge badge-other">不明</span>';
    if (statusEl) {
      statusEl.className = 'status-msg show error';
      statusEl.textContent = `状態取得エラー: ${e.message}`;
    }
  }
}

function renderDblock(data) {
  const badgeEl = document.getElementById('dblock-badge');
  const detailEl = document.getElementById('dblock-detail');
  if (!badgeEl) return;
  badgeEl.innerHTML = data.exists
    ? '<span class="badge badge-warn">ロックあり</span>'
    : '<span class="badge badge-active">ロックなし</span>';
  if (detailEl) detailEl.textContent = data.exists ? `${data.path || '/var/lib/pacman/db.lck'} が存在します` : 'ロックファイルはありません';
}

async function removeDbLock() {
  const statusEl = document.getElementById('dblock-status');
  const btn = document.getElementById('btn-dblock-run');
  if (!confirm('pacman のロックファイルを削除しますか？\n\nCachyOS Hello の「Remove db lock」と同じく /var/lib/pacman/db.lck を削除します。\nパッケージ操作 (pacman・paru・yay・アップデート) が動いていないことを確認してください。')) return;
  if (btn) btn.disabled = true;
  if (statusEl) {
    statusEl.className = 'status-msg show info';
    statusEl.innerHTML = '<span class="spinner"></span> 削除中...';
  }
  try {
    const resp = await fetch('/api/system/pacman-dblock', { method: 'POST' });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.detail || `HTTP ${resp.status}`);
    if (statusEl) {
      statusEl.className = `status-msg show ${data.success ? 'success' : 'error'}`;
      statusEl.textContent = data.message || '';
    }
    showStatus(data.message || '', data.success ? 'success' : 'error');
    renderDblock(data);
  } catch (e) {
    if (statusEl) {
      statusEl.className = 'status-msg show error';
      statusEl.textContent = `エラー: ${e.message}`;
    }
  } finally {
    if (btn) btn.disabled = false;
  }
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

