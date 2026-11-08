(() => {
  'use strict';

  /* ---------- Config ---------- */
  const MODES = [
    { id: 'classic', name: 'Classic', focus: 25, break: 5 },
    { id: 'deep', name: 'Deep Work', focus: 50, break: 10 },
    { id: 'flow', name: 'Flow State', focus: 90, break: 20 },
  ];
  const THEMES = ['midnight', 'pomodoro'];
  const THEME_COLOR = { midnight: '#08142b', pomodoro: '#a8261e' };
  // ?speed=60 turns minutes into seconds (handy for trying things out).
  const SPEED = Math.max(1, Number(new URLSearchParams(location.search).get('speed')) || 1);

  const DEFAULTS = {
    theme: 'midnight',
    mode: 'classic',
    autoBreak: true,
    autoFocus: false,
    sound: true,
    notify: false,
    wake: true,
    autoHide: true,
    intent: '',
    clientId: '',
    music: true,
    pauseMusic: true,
    deviceId: '',
    playlists: { focus: null, break: null },
    order: { focus: 'shuffle', break: 'continuous' },
  };

  /* ---------- Storage ---------- */
  const store = {
    get(key, fallback) {
      try { const v = JSON.parse(localStorage.getItem(key)); return v ?? fallback; } catch { return fallback; }
    },
    set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} },
  };

  const settings = { ...DEFAULTS, ...store.get('pomo.settings', {}) };
  settings.playlists = { ...DEFAULTS.playlists, ...settings.playlists };
  settings.order = { ...DEFAULTS.order, ...settings.order };
  const saveSettings = () => store.set('pomo.settings', settings);

  let timer = { phase: 'focus', running: false, endAt: 0, remaining: null, ...store.get('pomo.timer', {}) };
  const saveTimer = () => store.set('pomo.timer', timer);

  const positions = store.get('pomo.positions', {}); // playlistId -> { trackUri, progressMs }
  const savePositions = () => store.set('pomo.positions', positions);

  const today = () => new Date().toLocaleDateString('en-CA');
  let stats = store.get('pomo.stats', { date: today(), sessions: 0, minutes: 0 });

  /* ---------- DOM ---------- */
  const $ = id => document.getElementById(id);
  const el = {
    modes: $('modes'), timer: $('timer'), phase: $('phaseLabel'), fill: $('progressFill'),
    start: $('startBtn'), reset: $('resetBtn'), skip: $('skipBtn'), intent: $('intent'),
    stats: $('stats'), nowPlaying: $('nowPlaying'), toast: $('toast'),
    drawer: $('drawer'), scrim: $('scrim'),
  };

  /* ---------- Timer ---------- */
  const mode = () => MODES.find(m => m.id === settings.mode) || MODES[0];
  const duration = (phase = timer.phase) => (mode()[phase] * 60000) / SPEED;
  const remainingMs = () => timer.running ? Math.max(0, timer.endAt - Date.now()) : (timer.remaining ?? duration());

  function format(ms) {
    const total = Math.ceil(ms / 1000);
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  function start() {
    if (timer.running) return;
    timer.endAt = Date.now() + remainingMs();
    timer.remaining = null;
    timer.running = true;
    saveTimer();
    render();
    updateWakeLock();
    music.onStart(timer.phase);
  }

  function pause() {
    if (!timer.running) return;
    timer.remaining = remainingMs();
    timer.running = false;
    saveTimer();
    render();
    updateWakeLock();
    if (settings.pauseMusic) music.pause();
  }

  function reset() {
    const wasRunning = timer.running;
    timer.running = false;
    timer.remaining = null;
    saveTimer();
    render();
    updateWakeLock();
    if (wasRunning && settings.pauseMusic) music.pause();
  }

  /** Moves to the next phase. `completed` = the phase ran out (vs. skipped). */
  function advance(completed) {
    const wasRunning = timer.running;
    const prev = timer.phase;
    const next = prev === 'focus' ? 'break' : 'focus';
    if (completed && prev === 'focus') {
      rollStats();
      stats.sessions += 1;
      stats.minutes += mode().focus;
      store.set('pomo.stats', stats);
    }
    music.leave(prev);
    timer = { phase: next, running: false, endAt: 0, remaining: null };
    saveTimer();

    const auto = completed ? (next === 'break' ? settings.autoBreak : settings.autoFocus) : wasRunning;
    if (auto) start();
    else { render(); updateWakeLock(); music.pause(); }
  }

  function complete() {
    const finished = timer.phase;
    chime(finished);
    notify(finished === 'focus' ? 'Focus session done — time for a break.' : 'Break is over — back to focus.');
    advance(true);
  }

  function setMode(id) {
    if (id === settings.mode) return;
    if (timer.running && !confirm('Switching modes resets the current timer. Continue?')) return;
    const wasRunning = timer.running;
    settings.mode = id;
    saveSettings();
    music.leave(timer.phase);
    timer = { phase: 'focus', running: false, endAt: 0, remaining: null };
    saveTimer();
    renderModes();
    render();
    updateWakeLock();
    if (wasRunning) music.pause();
  }

  /* Ticks come from a worker so they keep coming when the tab is in the background. */
  const ticker = new Worker(URL.createObjectURL(new Blob(['setInterval(() => postMessage(0), 250);'], { type: 'text/javascript' })));
  ticker.onmessage = () => {
    if (timer.running && remainingMs() <= 0) complete();
    render();
  };

  /* ---------- Rendering ---------- */
  let lastRender = '';
  function render() {
    const ms = remainingMs();
    const text = format(ms);
    const phaseName = timer.phase === 'focus' ? 'Focus' : 'Break';
    const key = `${text}|${timer.phase}|${timer.running}`;
    if (key === lastRender) return;
    lastRender = key;

    el.timer.textContent = text;
    el.phase.textContent = phaseName;
    document.body.dataset.phase = timer.phase;
    el.fill.style.width = `${(1 - ms / duration()) * 100}%`;
    el.start.textContent = timer.running ? 'Pause' : (timer.remaining != null ? 'Resume' : 'Start');
    document.title = timer.running || timer.remaining != null ? `${text} · ${phaseName}` : 'Pomodoro';
    renderStats();
  }

  function rollStats() {
    if (stats.date !== today()) stats = { date: today(), sessions: 0, minutes: 0 };
  }
  function renderStats() {
    rollStats();
    const h = Math.floor(stats.minutes / 60), m = stats.minutes % 60;
    const time = h ? `${h} h ${m} min` : `${m} min`;
    el.stats.textContent = `${stats.sessions} ${stats.sessions === 1 ? 'session' : 'sessions'} · ${time} focused today`;
  }

  function renderModes() {
    el.modes.innerHTML = '';
    for (const m of MODES) {
      const b = document.createElement('button');
      b.className = 'mode' + (m.id === settings.mode ? ' active' : '');
      b.innerHTML = `${m.name}<small>${m.focus}/${m.break}</small>`;
      b.title = `${m.focus} min focus · ${m.break} min break`;
      b.onclick = () => setMode(m.id);
      el.modes.appendChild(b);
    }
  }

  function applyTheme() {
    document.documentElement.dataset.theme = settings.theme;
    document.querySelector('meta[name="theme-color"]').content = THEME_COLOR[settings.theme];
    document.querySelectorAll('#themeSeg button').forEach(b => b.classList.toggle('active', b.dataset.value === settings.theme));
  }
  function cycleTheme() {
    settings.theme = THEMES[(THEMES.indexOf(settings.theme) + 1) % THEMES.length];
    saveSettings();
    applyTheme();
  }

  let toastTimer;
  function toast(msg, ms = 4000) {
    el.toast.textContent = msg;
    el.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove('show'), ms);
  }

  /* ---------- Sound, notifications, wake lock ---------- */
  let audioCtx;
  function chime(finishedPhase) {
    if (!settings.sound) return;
    try {
      audioCtx = audioCtx || new AudioContext();
      const notes = finishedPhase === 'focus' ? [660, 880, 1046] : [1046, 880, 660];
      notes.forEach((freq, i) => {
        const t = audioCtx.currentTime + i * 0.22;
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0, t);
        gain.gain.linearRampToValueAtTime(0.25, t + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 1.2);
        osc.connect(gain).connect(audioCtx.destination);
        osc.start(t);
        osc.stop(t + 1.3);
      });
    } catch {}
  }
  // Browsers only allow audio after a user gesture, so warm the context up on first interaction.
  document.addEventListener('pointerdown', () => {
    if (!audioCtx && settings.sound) { try { audioCtx = new AudioContext(); } catch {} }
    else if (audioCtx?.state === 'suspended') audioCtx.resume();
  }, { once: false, passive: true });

  function notify(body) {
    if (!settings.notify || !('Notification' in window) || Notification.permission !== 'granted') return;
    try { new Notification('Pomodoro', { body, icon: 'icon.svg', silent: true }); } catch {}
  }

  let wakeLock = null;
  async function updateWakeLock() {
    const want = settings.wake && timer.running && document.visibilityState === 'visible';
    try {
      if (want && !wakeLock && 'wakeLock' in navigator) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      } else if (!want && wakeLock) {
        await wakeLock.release();
        wakeLock = null;
      }
    } catch {}
  }
  document.addEventListener('visibilitychange', () => {
    updateWakeLock();
    if (document.visibilityState === 'visible') music.poll();
  });

  /* ---------- Idle: fade out controls while running ---------- */
  let idleTimer;
  function wake() {
    document.body.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      const typing = document.activeElement === el.intent;
      if (settings.autoHide && timer.running && !document.body.classList.contains('drawer-open') && !typing) {
        document.body.classList.add('idle');
      }
    }, 4000);
  }
  ['mousemove', 'pointerdown', 'keydown', 'touchstart'].forEach(e => document.addEventListener(e, wake, { passive: true }));

  /* ---------- Spotify integration ---------- */
  const playlistId = uri => (uri || '').split(':').pop();
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  const music = (() => {
    let queue = Promise.resolve();
    let loadedPhase = null; // whose playlist is currently loaded on the device
    let ours = false;       // true while music we started is (probably) playing
    let pollTimer = null;

    const active = () => settings.music && Spotify.isConnected();

    function enqueue(fn) {
      if (!active()) return;
      queue = queue.then(fn).catch(handleError);
    }

    function handleError(err) {
      console.warn('[spotify]', err);
      if (err.status === 404) toast('No active Spotify device. Open Spotify on your phone or computer, then pick it in Settings.', 6000);
      else if (err.status === 403) toast('Spotify refused playback control (Spotify Premium is required).', 6000);
      else if (err.status === 401) toast('Spotify session expired — please reconnect in Settings.', 6000);
      else toast(err.message || 'Spotify request failed.');
    }

    async function savePosition(phase) {
      const pl = settings.playlists[phase];
      if (!pl || settings.order[phase] !== 'continuous') return;
      const st = await Spotify.state();
      if (st?.item && playlistId(st.context?.uri) === pl.id) {
        positions[pl.id] = { trackUri: st.item.uri, progressMs: st.progress_ms || 0 };
        savePositions();
      }
    }

    async function playPhase(phase) {
      const pl = settings.playlists[phase];
      const device = settings.deviceId;
      if (!pl) {
        // No playlist for this phase: silence.
        if (ours) await Spotify.pause(device).catch(() => {});
        loadedPhase = null;
        ours = false;
        return;
      }
      const order = settings.order[phase];
      const body = { context_uri: pl.uri };
      const saved = positions[pl.id];
      if (order === 'continuous' && saved) {
        body.offset = { uri: saved.trackUri };
        body.position_ms = saved.progressMs;
      } else if (order === 'shuffle' && pl.total > 1) {
        body.offset = { position: Math.floor(Math.random() * pl.total) };
      }
      try {
        await Spotify.play(device, body);
      } catch (err) {
        // The saved track may have been removed from the playlist – start from the top instead.
        if (!body.offset || err.status === 403 || err.status === 401) throw err;
        await Spotify.play(device, { context_uri: pl.uri });
      }
      loadedPhase = phase;
      ours = true;
      await sleep(350);
      await Spotify.shuffle(order === 'shuffle', device).catch(() => {});
      await Spotify.repeat('context', device).catch(() => {});
      setTimeout(poll, 1500);
    }

    async function poll() {
      clearTimeout(pollTimer);
      if (!Spotify.isConnected()) { el.nowPlaying.textContent = ''; return; }
      try {
        const st = await Spotify.state();
        if (st?.item) {
          const artists = (st.item.artists || st.item.show && [st.item.show] || []).map(a => a.name).join(', ');
          el.nowPlaying.textContent = artists ? `${st.item.name} — ${artists}` : st.item.name;
          el.nowPlaying.classList.toggle('paused', !st.is_playing);
          el.nowPlaying.title = st.device?.name ? `Playing on ${st.device.name}` : '';
          // Keep "continue where I left off" positions fresh.
          if (active() && st.is_playing && loadedPhase) {
            const pl = settings.playlists[loadedPhase];
            if (pl && settings.order[loadedPhase] === 'continuous' && playlistId(st.context?.uri) === pl.id) {
              positions[pl.id] = { trackUri: st.item.uri, progressMs: st.progress_ms || 0 };
              savePositions();
            }
          }
        } else {
          el.nowPlaying.textContent = '';
        }
      } catch {}
      if (document.visibilityState === 'visible') pollTimer = setTimeout(poll, 15000);
    }

    return {
      poll,
      onStart(phase) {
        enqueue(async () => {
          if (loadedPhase === phase) { await Spotify.resume(settings.deviceId); ours = true; }
          else await playPhase(phase);
        });
      },
      leave(phase) {
        enqueue(async () => {
          if (loadedPhase === phase) await savePosition(phase);
          loadedPhase = null;
        });
      },
      pause() {
        enqueue(async () => {
          if (!ours) return;
          ours = false;
          await Spotify.pause(settings.deviceId).catch(err => { if (err.status !== 403) throw err; });
        });
      },
      test(phase) {
        if (!settings.playlists[phase]) return toast(`Pick a ${phase} playlist first.`);
        queue = queue.then(() => playPhase(phase)).then(() => toast(`Playing your ${phase} playlist.`)).catch(handleError);
      },
      forget() { loadedPhase = null; ours = false; },
    };
  })();

  /* ---------- Settings drawer ---------- */
  function openDrawer(open) {
    document.body.classList.toggle('drawer-open', open);
    el.drawer.setAttribute('aria-hidden', String(!open));
    if (open) { wake(); refreshSpotifyUI(); }
  }

  function bindToggle(id, key, onChange) {
    const input = $(id);
    input.checked = !!settings[key];
    input.addEventListener('change', async () => {
      settings[key] = input.checked;
      if (onChange) await onChange(input);
      saveSettings();
    });
  }

  bindToggle('optAutoBreak', 'autoBreak');
  bindToggle('optAutoFocus', 'autoFocus');
  bindToggle('optSound', 'sound', i => { if (i.checked) chime('focus'); });
  bindToggle('optNotify', 'notify', async input => {
    if (!input.checked) return;
    if (!('Notification' in window)) { input.checked = settings.notify = false; return toast('Notifications are not supported in this browser.'); }
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { input.checked = settings.notify = false; toast('Notifications are blocked for this site.'); }
  });
  bindToggle('optWake', 'wake', () => updateWakeLock());
  bindToggle('optAutoHide', 'autoHide');
  bindToggle('optMusic', 'music');
  bindToggle('optPauseMusic', 'pauseMusic');

  document.querySelectorAll('#themeSeg button').forEach(b => b.addEventListener('click', () => {
    settings.theme = b.dataset.value; saveSettings(); applyTheme();
  }));

  function renderOrderSegs() {
    document.querySelectorAll('[data-order]').forEach(seg => {
      seg.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.value === settings.order[seg.dataset.order]));
    });
  }
  document.querySelectorAll('[data-order] button').forEach(b => b.addEventListener('click', () => {
    settings.order[b.parentElement.dataset.order] = b.dataset.value;
    saveSettings();
    renderOrderSegs();
  }));

  // Spotify setup
  Spotify.setClientId(settings.clientId);
  $('redirectUri').textContent = Spotify.redirectUri();
  $('copyRedirect').onclick = () => navigator.clipboard?.writeText(Spotify.redirectUri()).then(() => toast('Redirect URI copied.'));
  $('clientIdInput').value = settings.clientId;
  $('saveClientId').onclick = () => {
    const id = $('clientIdInput').value.trim();
    if (!/^[0-9a-f]{32}$/i.test(id)) return toast('That does not look like a Spotify Client ID (32 characters).');
    settings.clientId = id; saveSettings(); Spotify.setClientId(id); refreshSpotifyUI();
  };
  $('changeClientId').onclick = () => { settings.clientId = ''; saveSettings(); refreshSpotifyUI(); };
  $('connectBtn').onclick = () => Spotify.login().catch(e => toast(e.message));
  $('disconnectBtn').onclick = () => {
    Spotify.logout(); music.forget(); el.nowPlaying.textContent = ''; loadedLists = false; refreshSpotifyUI();
  };
  $('refreshDevices').onclick = () => loadDevices(true);
  $('testFocus').onclick = () => music.test('focus');
  $('testBreak').onclick = () => music.test('break');
  $('resetPositions').onclick = () => {
    Object.keys(positions).forEach(k => delete positions[k]); savePositions(); toast('Saved positions cleared.');
  };

  let loadedLists = false;
  async function refreshSpotifyUI() {
    const connected = Spotify.isConnected();
    $('spSetup').hidden = !!settings.clientId;
    $('spConnect').hidden = !settings.clientId || connected;
    $('spConnected').hidden = !settings.clientId || !connected;
    if (!settings.clientId || !connected) return;
    renderOrderSegs();
    if (loadedLists) return;
    loadedLists = true;
    try {
      const [me, lists] = await Promise.all([Spotify.me(), Spotify.playlists(), loadDevices()]);
      $('spUser').textContent = me?.display_name || me?.id || 'Spotify user';
      fillPlaylists(lists);
    } catch (err) {
      loadedLists = false;
      toast(err.message || 'Could not load your Spotify data.');
    }
  }

  function fillPlaylists(lists) {
    for (const phase of ['focus', 'break']) {
      const select = $(`${phase}Playlist`);
      const current = settings.playlists[phase];
      select.innerHTML = '';
      select.append(new Option('No music', ''));
      for (const p of lists) select.append(new Option(`${p.name} (${p.total})`, p.id));
      // Keep a saved playlist selectable even if it is not in the list (e.g. followed later).
      if (current && !lists.some(p => p.id === current.id)) select.append(new Option(current.name, current.id));
      select.value = current?.id || '';
      select.onchange = () => {
        const p = lists.find(x => x.id === select.value) || (current?.id === select.value ? current : null);
        settings.playlists[phase] = p ? { id: p.id, uri: p.uri, name: p.name, total: p.total } : null;
        saveSettings();
      };
    }
  }

  async function loadDevices(announce) {
    const select = $('deviceSelect');
    try {
      const devices = await Spotify.devices();
      select.innerHTML = '';
      select.append(new Option('Currently active device', ''));
      for (const d of devices) select.append(new Option(`${d.name} · ${d.type}${d.is_active ? ' (active)' : ''}`, d.id));
      if (settings.deviceId && !devices.some(d => d.id === settings.deviceId)) {
        select.append(new Option(`${settings.deviceName || 'Saved device'} (offline)`, settings.deviceId));
      }
      select.value = settings.deviceId;
      select.onchange = () => {
        settings.deviceId = select.value;
        settings.deviceName = devices.find(d => d.id === select.value)?.name || '';
        saveSettings();
      };
      if (announce) toast(devices.length ? `Found ${devices.length} device${devices.length > 1 ? 's' : ''}.` : 'No devices found — open Spotify on your phone.');
    } catch (err) {
      if (announce) toast(err.message);
      throw err;
    }
  }

  /* ---------- Wiring ---------- */
  el.start.onclick = () => (timer.running ? pause() : start());
  el.reset.onclick = reset;
  el.skip.onclick = () => advance(false);
  $('themeBtn').onclick = cycleTheme;
  $('settingsBtn').onclick = () => openDrawer(true);
  $('closeDrawer').onclick = () => openDrawer(false);
  el.scrim.onclick = () => openDrawer(false);
  $('fullscreenBtn').onclick = toggleFullscreen;

  el.intent.value = settings.intent;
  el.intent.addEventListener('input', () => { settings.intent = el.intent.value; saveSettings(); });
  el.intent.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === 'Escape') el.intent.blur(); });

  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen?.().catch(() => {});
  }

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && document.body.classList.contains('drawer-open')) return openDrawer(false);
    const t = e.target;
    if (t.matches('input, select, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
    switch (e.key.toLowerCase()) {
      case ' ': e.preventDefault(); timer.running ? pause() : start(); break;
      case 'r': reset(); break;
      case 's': advance(false); break;
      case 't': cycleTheme(); break;
      case 'f': toggleFullscreen(); break;
      case '1': case '2': case '3': setMode(MODES[Number(e.key) - 1].id); break;
    }
  });

  /* ---------- Boot ---------- */
  applyTheme();
  renderModes();
  render();
  updateWakeLock();
  wake();

  // A timer that ran out while the page was closed: just move on to the next phase (without auto-start chains).
  if (timer.running && remainingMs() <= 0) {
    timer = { phase: timer.phase === 'focus' ? 'break' : 'focus', running: false, endAt: 0, remaining: null };
    saveTimer();
    render();
  }

  Spotify.handleRedirect()
    .then(done => {
      if (done) { toast('Spotify connected.'); openDrawer(true); }
      refreshSpotifyUI();
      music.poll();
    })
    .catch(err => { toast(err.message); refreshSpotifyUI(); });
})();
