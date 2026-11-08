(() => {
  'use strict';

  /* ---------- Config ---------- */
  const PRESETS = [
    { id: 'classic', name: 'Classic', focus: 25, break: 5, long: 15 },
    { id: 'deep', name: 'Deep Work', focus: 50, break: 10, long: 30 },
    { id: 'flow', name: 'Flow State', focus: 90, break: 20, long: 40 },
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
    fade: true,
    longBreak: true,
    longEvery: 4,
    custom: { focus: 30, break: 5, long: 15 },
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
  settings.custom = { ...DEFAULTS.custom, ...settings.custom };
  const saveSettings = () => store.set('pomo.settings', settings);

  let timer = { phase: 'focus', running: false, endAt: 0, remaining: null, long: false, count: 0, ...store.get('pomo.timer', {}) };
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
  const modes = () => [...PRESETS, { id: 'custom', name: 'Custom', ...settings.custom }];
  const mode = () => modes().find(m => m.id === settings.mode) || PRESETS[0];
  const phaseKey = () => timer.phase === 'focus' ? 'focus' : (timer.long ? 'long' : 'break');
  const duration = () => (mode()[phaseKey()] * 60000) / SPEED;
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

  /** The state after the current phase. `completed` = the phase ran out (vs. skipped). */
  function nextTimer(completed) {
    let count = timer.count || 0;
    if (timer.phase === 'focus') {
      if (completed) {
        rollStats();
        stats.sessions += 1;
        stats.minutes += mode().focus;
        store.set('pomo.stats', stats);
        count += 1;
      }
      const long = settings.longBreak && count >= settings.longEvery;
      return { phase: 'break', running: false, endAt: 0, remaining: null, long, count };
    }
    if (timer.long) count = 0;
    return { phase: 'focus', running: false, endAt: 0, remaining: null, long: false, count };
  }

  function advance(completed) {
    const wasRunning = timer.running;
    const prev = timer.phase;
    music.leave(prev);
    timer = nextTimer(completed);
    saveTimer();

    const auto = completed ? (timer.phase === 'break' ? settings.autoBreak : settings.autoFocus) : wasRunning;
    if (auto) start();
    else { render(); updateWakeLock(); music.pause(); }
  }

  function complete() {
    const finished = timer.phase;
    chime(finished);
    advance(true);
    notify(finished === 'focus'
      ? (timer.long ? 'Great work — time for a long break.' : 'Focus session done — time for a break.')
      : 'Break is over — back to focus.');
  }

  function setMode(id) {
    if (id === settings.mode) return;
    if (timer.running && !confirm('Switching modes resets the current timer. Continue?')) return;
    const wasRunning = timer.running;
    settings.mode = id;
    saveSettings();
    music.leave(timer.phase);
    timer = { phase: 'focus', running: false, endAt: 0, remaining: null, long: false, count: 0 };
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
    const phaseName = timer.phase === 'focus' ? 'Focus' : (timer.long ? 'Long break' : 'Break');
    const key = `${text}|${phaseName}|${timer.running}|${timer.count}|${settings.longBreak}|${settings.longEvery}|${settings.mode}`;
    if (key === lastRender) return;
    lastRender = key;

    el.timer.textContent = text;
    el.phase.textContent = phaseName;
    renderDots();
    document.body.dataset.phase = timer.phase;
    el.fill.style.width = `${(1 - ms / duration()) * 100}%`;
    el.start.textContent = timer.running ? 'Pause' : (timer.remaining != null ? 'Resume' : 'Start');
    document.title = timer.running || timer.remaining != null ? `${text} · ${phaseName}` : 'Pomodoro';
    renderStats();
  }

  /* One dot per session until the long break. */
  function renderDots() {
    const dots = $('dots');
    if (!settings.longBreak) { dots.innerHTML = ''; return; }
    const done = Math.min(timer.count || 0, settings.longEvery);
    let html = '';
    for (let i = 0; i < settings.longEvery; i++) {
      const cls = i < done ? 'done' : (i === done && timer.phase === 'focus' ? 'current' : '');
      html += `<i class="${cls}"></i>`;
    }
    dots.innerHTML = html;
    dots.title = `${done} of ${settings.longEvery} sessions until the long break`;
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
    for (const m of modes()) {
      const b = document.createElement('button');
      b.className = 'mode' + (m.id === settings.mode ? ' active' : '');
      b.innerHTML = `${m.name}<small>${m.focus}/${m.break}</small>`;
      b.title = `${m.focus} min focus · ${m.break} min break · ${m.long} min long break`;
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
    let restoreVolume = null; // volume to return to after a fade-out
    let fadeDevice = null;

    const FADE_STEPS = 6;
    const FADE_STEP_MS = 350;

    /** Lowers the volume gradually. Only on devices that allow volume control (not iPhones). */
    async function fadeOut() {
      if (!settings.fade || !ours || restoreVolume != null) return;
      try {
        const st = await Spotify.state();
        const d = st?.device;
        if (!st?.is_playing || !d?.supports_volume || !(d.volume_percent > 5)) return;
        restoreVolume = d.volume_percent;
        fadeDevice = d.id;
        for (let i = 1; i <= FADE_STEPS; i++) {
          await Spotify.volume(restoreVolume * (1 - i / FADE_STEPS), fadeDevice);
          await sleep(FADE_STEP_MS);
        }
      } catch {
        await restore();
      }
    }

    async function fadeIn() {
      if (restoreVolume == null) return;
      const target = restoreVolume;
      try {
        for (let i = 1; i <= FADE_STEPS; i++) {
          await sleep(FADE_STEP_MS);
          await Spotify.volume(target * (i / FADE_STEPS), fadeDevice);
        }
        restoreVolume = null;
      } catch {
        await restore();
      }
    }

    async function restore() {
      if (restoreVolume == null) return;
      const target = restoreVolume;
      restoreVolume = null;
      await Spotify.volume(target, fadeDevice).catch(() => {});
    }

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
          try {
            if (loadedPhase === phase) { await Spotify.resume(settings.deviceId); ours = true; }
            else await playPhase(phase);
          } finally {
            if (ours) await fadeIn();
            else await restore();
          }
        });
      },
      leave(phase) {
        enqueue(async () => {
          if (loadedPhase === phase) {
            await fadeOut();
            await savePosition(phase);
          }
          loadedPhase = null;
        });
      },
      pause() {
        enqueue(async () => {
          if (!ours) return restore();
          await fadeOut();
          ours = false;
          try {
            await Spotify.pause(settings.deviceId).catch(err => { if (err.status !== 403) throw err; });
          } finally {
            await restore();
          }
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
  bindToggle('optFade', 'fade');
  bindToggle('optLongBreak', 'longBreak', () => { lastRender = ''; render(); });

  const longEvery = $('longEvery');
  for (let n = 2; n <= 8; n++) longEvery.append(new Option(`${n} sessions`, n));
  longEvery.value = settings.longEvery;
  longEvery.onchange = () => { settings.longEvery = Number(longEvery.value); saveSettings(); render(); };

  for (const key of ['focus', 'break', 'long']) {
    const input = $(`custom-${key}`);
    input.value = settings.custom[key];
    input.addEventListener('change', () => {
      const v = Math.round(Number(input.value));
      if (!(v >= 1 && v <= 240)) { input.value = settings.custom[key]; return toast('Use 1–240 minutes.'); }
      input.value = v;
      settings.custom[key] = v;
      saveSettings();
      renderModes();
      render();
    });
  }

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
  let myPlaylists = [];
  async function refreshSpotifyUI() {
    const connected = Spotify.isConnected();
    $('spSetup').hidden = !!settings.clientId;
    $('spConnect').hidden = !settings.clientId || connected;
    $('spConnected').hidden = !settings.clientId || !connected;
    if (!settings.clientId || !connected) return;
    renderOrderSegs();
    renderChoices();
    if (loadedLists) return;
    loadedLists = true;
    try {
      const [me, lists] = await Promise.all([Spotify.me(), Spotify.playlists(), loadDevices()]);
      $('spUser').textContent = me?.display_name || me?.id || 'Spotify user';
      myPlaylists = lists;
    } catch (err) {
      loadedLists = false;
      toast(err.message || 'Could not load your Spotify data.');
    }
  }

  const NOTE_ICON = '<svg viewBox="0 0 24 24"><path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/></svg>';
  const esc = str => String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const cover = url => url ? `<img class="cover" src="${esc(url)}" alt="" loading="lazy">` : `<span class="cover">${NOTE_ICON}</span>`;
  function describe(p) {
    const kind = p.type === 'album' ? 'Album' : 'Playlist';
    return [kind, p.owner, p.total ? `${p.total} tracks` : ''].filter(Boolean).join(' · ');
  }

  function renderChoices() {
    for (const phase of ['focus', 'break']) {
      const p = settings.playlists[phase];
      $(`${phase}Choice`).innerHTML = p
        ? `${cover(p.image)}<span class="choice-text"><strong>${esc(p.name)}</strong><small>${esc(describe(p))}</small></span><span class="choice-change">Change</span>`
        : `${cover('')}<span class="choice-text"><strong>No music</strong><small>Tap to choose a playlist</small></span><span class="choice-change">Choose</span>`;
    }
  }

  /* Picker: own playlists, Spotify search, pasted links, or whatever is playing right now. */
  const picker = (() => {
    let phase = 'focus';
    let searchTimer = null;
    let searchId = 0;
    const input = $('pickerInput');
    const list = $('pickerList');
    const label = $('pickerLabel');

    function open(which) {
      phase = which;
      $('pickerTitle').textContent = which === 'focus' ? 'Focus music' : 'Break music';
      input.value = '';
      $('picker').hidden = false;
      showMine();
      setTimeout(() => input.focus(), 30);
    }
    function close() { $('picker').hidden = true; }
    const isOpen = () => !$('picker').hidden;

    function show(title, items, emptyText) {
      label.textContent = title;
      list.innerHTML = '';
      const current = settings.playlists[phase];
      if (!items.length) {
        list.innerHTML = `<li class="picker-empty">${esc(emptyText)}</li>`;
        return;
      }
      for (const p of items) {
        const li = document.createElement('li');
        const b = document.createElement('button');
        if (p && current && p.id === current.id) b.className = 'selected';
        b.innerHTML = p
          ? `${cover(p.image)}<span class="item-text"><strong>${esc(p.name)}</strong><small>${esc(describe(p))}</small></span>`
          : `${cover('')}<span class="item-text"><strong>No music</strong><small>Silence during this phase</small></span>`;
        b.onclick = () => choose(p);
        li.appendChild(b);
        list.appendChild(li);
      }
    }

    function showMine() {
      show('Your playlists', [null, ...myPlaylists], loadedLists ? 'No playlists yet.' : 'Loading…');
    }

    function choose(p) {
      settings.playlists[phase] = p ? { ...p } : null;
      saveSettings();
      renderChoices();
      close();
      if (p) toast(`${phase === 'focus' ? 'Focus' : 'Break'} music: ${p.name}`);
    }

    async function onInput() {
      clearTimeout(searchTimer);
      const q = input.value.trim();
      const id = ++searchId;
      if (!q) return showMine();
      const link = Spotify.parseLink(q);
      if (link) {
        show('Link', [], 'Looking up…');
        const item = await Spotify.lookup(link.type, link.id);
        if (id === searchId) show('Link', [item], '');
        return;
      }
      if (/spotify\.(com|link)|spotify:/.test(q)) {
        return show('Link', [], 'Use a playlist or album link (Share → Copy link to playlist).');
      }
      const mine = myPlaylists.filter(p => p.name.toLowerCase().includes(q.toLowerCase()));
      show('Results', mine, 'Searching…');
      searchTimer = setTimeout(async () => {
        try {
          const found = await Spotify.search(q);
          if (id !== searchId) return;
          const seen = new Set(mine.map(p => p.id));
          show('Results', [...mine, ...found.filter(p => !seen.has(p.id))], 'Nothing found.');
        } catch (err) {
          if (id === searchId) show('Results', mine, err.message || 'Search failed.');
        }
      }, 350);
    }

    async function useCurrent() {
      try {
        const st = await Spotify.state();
        const ctx = st?.context;
        const link = ctx && Spotify.parseLink(ctx.uri);
        if (!link) {
          return toast(st?.item ? 'The current track is not playing from a playlist or album.' : 'Nothing is playing on Spotify right now.');
        }
        choose(await Spotify.lookup(link.type, link.id));
      } catch (err) {
        toast(err.message || 'Could not read what is playing.');
      }
    }

    input.addEventListener('input', onInput);
    $('pickerClose').onclick = close;
    $('picker').addEventListener('click', e => { if (e.target.id === 'picker') close(); });
    $('pickerCurrent').onclick = useCurrent;
    document.querySelectorAll('[data-pick]').forEach(b => b.addEventListener('click', () => open(b.dataset.pick)));
    return { open, close, isOpen };
  })();

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
    if (e.key === 'Escape' && picker.isOpen()) return picker.close();
    if (e.key === 'Escape' && document.body.classList.contains('drawer-open')) return openDrawer(false);
    const t = e.target;
    if (t.matches('input, select, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
    switch (e.key.toLowerCase()) {
      case ' ': e.preventDefault(); timer.running ? pause() : start(); break;
      case 'r': reset(); break;
      case 's': advance(false); break;
      case 't': cycleTheme(); break;
      case 'f': toggleFullscreen(); break;
      case '1': case '2': case '3': case '4': setMode(modes()[Number(e.key) - 1].id); break;
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
    timer = nextTimer(true);
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
