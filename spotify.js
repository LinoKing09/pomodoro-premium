/* Minimal Spotify Web API client using Authorization Code + PKCE (no backend needed). */
const Spotify = (() => {
  const AUTH_URL = 'https://accounts.spotify.com/authorize';
  const TOKEN_URL = 'https://accounts.spotify.com/api/token';
  const API = 'https://api.spotify.com/v1';
  const SCOPES = [
    'user-read-playback-state',
    'user-modify-playback-state',
    'user-read-currently-playing',
    'playlist-read-private',
    'playlist-read-collaborative',
  ].join(' ');
  const TOKEN_KEY = 'pomo.spotify.token';
  const PKCE_KEY = 'pomo.spotify.pkce';

  let clientId = '';
  let token = read(TOKEN_KEY);
  let refreshing = null;

  function read(key) {
    try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
  }
  function write(key, value) {
    try { value == null ? localStorage.removeItem(key) : localStorage.setItem(key, JSON.stringify(value)); } catch {}
  }

  const redirectUri = () => location.origin + location.pathname.replace(/index\.html$/, '');

  function randomString(len) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const bytes = crypto.getRandomValues(new Uint8Array(len));
    return Array.from(bytes, b => chars[b % chars.length]).join('');
  }
  async function challengeFor(verifier) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    return btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  async function login() {
    if (!clientId) throw new Error('Add your Spotify Client ID first.');
    const verifier = randomString(64);
    const state = randomString(16);
    write(PKCE_KEY, { verifier, state });
    const params = new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: redirectUri(),
      code_challenge_method: 'S256',
      code_challenge: await challengeFor(verifier),
      scope: SCOPES,
      state,
    });
    location.assign(`${AUTH_URL}?${params}`);
  }

  /** Completes the login if the page was opened by Spotify's redirect. */
  async function handleRedirect() {
    const params = new URLSearchParams(location.search);
    if (!params.has('code') && !params.has('error')) return false;
    const code = params.get('code');
    const state = params.get('state');
    const error = params.get('error');
    const pkce = read(PKCE_KEY);
    write(PKCE_KEY, null);
    ['code', 'state', 'error'].forEach(k => params.delete(k));
    const rest = params.toString();
    history.replaceState(null, '', redirectUri() + (rest ? `?${rest}` : '') + location.hash);

    if (error) throw new Error('Spotify login was cancelled.');
    if (!pkce || pkce.state !== state) throw new Error('Spotify login expired, please try again.');
    await tokenRequest({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri(),
      client_id: clientId,
      code_verifier: pkce.verifier,
    });
    return true;
  }

  async function tokenRequest(fields) {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error_description || data.error || 'Spotify login failed.');
      err.code = data.error;
      throw err;
    }
    token = {
      access_token: data.access_token,
      refresh_token: data.refresh_token || token?.refresh_token,
      expires_at: Date.now() + (data.expires_in - 60) * 1000,
    };
    write(TOKEN_KEY, token);
  }

  async function accessToken() {
    if (!token) throw Object.assign(new Error('Spotify is not connected.'), { status: 401 });
    if (Date.now() < token.expires_at) return token.access_token;
    if (!refreshing) {
      refreshing = tokenRequest({
        grant_type: 'refresh_token',
        refresh_token: token.refresh_token,
        client_id: clientId,
      }).finally(() => { refreshing = null; });
    }
    try {
      await refreshing;
    } catch (err) {
      if (err.code === 'invalid_grant' || err.code === 'invalid_client') logout();
      throw err;
    }
    return token.access_token;
  }

  async function api(method, path, { query, body } = {}) {
    let url = path.startsWith('http') ? path : API + path;
    if (query) {
      const q = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) if (v != null && v !== '') q.set(k, v);
      if ([...q].length) url += (url.includes('?') ? '&' : '?') + q;
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${await accessToken()}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (res.status === 401 && attempt === 0 && token) { token.expires_at = 0; continue; }
      if (res.status === 429 && attempt < 2) {
        const wait = Math.min(Number(res.headers.get('Retry-After')) || 1, 10);
        await new Promise(r => setTimeout(r, wait * 1000));
        continue;
      }
      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch {}
      if (!res.ok) {
        const err = new Error(data?.error?.message || `Spotify request failed (${res.status}).`);
        err.status = res.status;
        err.reason = data?.error?.reason;
        throw err;
      }
      return data;
    }
  }

  async function playlists() {
    const all = [];
    let next = '/me/playlists?limit=50';
    while (next && all.length < 500) {
      const page = await api('GET', next);
      for (const p of page?.items || []) {
        const item = normalize(p);
        if (item) all.push(item);
      }
      next = page?.next;
    }
    return all;
  }

  /** Turns a playlist or album object from the API into the small shape the app stores. */
  function normalize(p) {
    if (!p || !p.uri) return null;
    const images = p.images || [];
    return {
      id: p.id,
      uri: p.uri,
      type: p.type || p.uri.split(':')[1],
      name: p.name,
      total: p.items?.total ?? p.tracks?.total ?? p.total_tracks ?? 0,
      owner: p.owner?.display_name || (p.artists || []).map(a => a.name).join(', ') || '',
      image: (images[images.length - 1] || images[0])?.url || '',
    };
  }

  async function search(q) {
    const res = await api('GET', '/search', { query: { q, type: 'playlist,album', limit: 10 } });
    return [...(res?.playlists?.items || []), ...(res?.albums?.items || [])].map(normalize).filter(Boolean);
  }

  /** Finds "playlist"/"album" + ID in a share link (open.spotify.com/...) or URI (spotify:playlist:...). */
  function parseLink(text) {
    const m = String(text).match(/(playlist|album)[/:]([A-Za-z0-9]{22})/);
    return m ? { type: m[1], id: m[2] } : null;
  }

  /** Metadata for any playlist/album. Falls back to Spotify's public oEmbed when the API won't say. */
  async function lookup(type, id) {
    try {
      const item = normalize(await api('GET', `/${type}s/${id}`));
      if (item) return item;
    } catch {}
    const base = { id, uri: `spotify:${type}:${id}`, type, name: type === 'album' ? 'Album' : 'Playlist', total: 0, owner: '', image: '' };
    try {
      const res = await fetch(`https://open.spotify.com/oembed?url=${encodeURIComponent(`https://open.spotify.com/${type}/${id}`)}`);
      if (res.ok) {
        const data = await res.json();
        return { ...base, name: data.title || base.name, image: data.thumbnail_url || '' };
      }
    } catch {}
    return base;
  }

  const dev = deviceId => ({ device_id: deviceId || undefined });

  return {
    redirectUri,
    setClientId(id) { clientId = (id || '').trim(); },
    isConnected: () => !!token?.refresh_token,
    login,
    handleRedirect,
    logout() { token = null; write(TOKEN_KEY, null); },
    me: () => api('GET', '/me'),
    playlists,
    search,
    parseLink,
    lookup,
    devices: async () => (await api('GET', '/me/player/devices'))?.devices || [],
    state: () => api('GET', '/me/player'),
    play: (deviceId, body) => api('PUT', '/me/player/play', { query: dev(deviceId), body }),
    resume: deviceId => api('PUT', '/me/player/play', { query: dev(deviceId) }),
    pause: deviceId => api('PUT', '/me/player/pause', { query: dev(deviceId) }),
    shuffle: (on, deviceId) => api('PUT', '/me/player/shuffle', { query: { state: on, ...dev(deviceId) } }),
    volume: (pct, deviceId) => api('PUT', '/me/player/volume', { query: { volume_percent: Math.round(pct), ...dev(deviceId) } }),
    repeat: (mode, deviceId) => api('PUT', '/me/player/repeat', { query: { state: mode, ...dev(deviceId) } }),
  };
})();
