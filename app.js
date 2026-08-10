const API = 'https://iptv-org.github.io/api';
const CACHE_VERSION = 2;
const CACHE_TTL = 15 * 60 * 1000;
const PROBE_CONCURRENCY = 6;
const PROBE_TIMEOUT = 7000;

const state = {
  candidates: [], visible: [], active: null, hls: null,
  countryCodes: new Map(), countryChoices: [], countryIndex: -1,
  currentCountry: null, scanToken: 0
};

const el = {
  video: document.querySelector('#video'), list: document.querySelector('#channelList'), status: document.querySelector('#status'),
  country: document.querySelector('#countryFilter'), countryToggle: document.querySelector('#countryToggle'), countryOptions: document.querySelector('#countryOptions'),
  empty: document.querySelector('#playerEmpty'), loading: document.querySelector('#loadingScreen'), loadingMessage: document.querySelector('#loadingMessage'),
  watchNav: document.querySelector('#watchNav'), browseNav: document.querySelector('#browseNav')
};

async function getData() {
  const paths = ['channels.json', 'streams.json', 'logos.json', 'countries.json', 'blocklist.json'];
  const results = await Promise.all(paths.map(path => fetch(`${API}/${path}`).then(response => {
    if (!response.ok) throw new Error(path);
    return response.json();
  })));
  return Object.fromEntries(paths.map((path, index) => [path, results[index]]));
}

function initials(name = 'TV') { return name.split(/\s+/).slice(0, 2).map(word => word[0]).join('').toUpperCase(); }
function logo(item) { return item.logo ? `<img src="${item.logo}" alt="" loading="lazy" onerror="this.remove()">` : initials(item.name); }
function escapeHTML(value = '') { const node = document.createElement('div'); node.textContent = value; return node.innerHTML; }
function cacheKey(code) { return `nuod:playable:${CACHE_VERSION}:${code}`; }

function metadataAllowsStream(stream, blockedChannels) {
  const label = (stream.label || '').toLocaleLowerCase();
  const restricted = /geo|block|restrict|vpn|location|country/.test(label);
  return stream.channel && typeof stream.url === 'string' && stream.url.startsWith('https://') && !stream.referrer && !stream.user_agent && !restricted && !blockedChannels.has(stream.channel);
}

function readCachedStreams(code, candidates) {
  try {
    const cached = JSON.parse(localStorage.getItem(cacheKey(code)) || 'null');
    if (!cached || Date.now() - cached.checkedAt > CACHE_TTL) return null;
    const urls = new Set(cached.urls);
    return candidates.filter(item => urls.has(item.url));
  } catch { return null; }
}

function writeCachedStreams(code, streams) {
  try { localStorage.setItem(cacheKey(code), JSON.stringify({ checkedAt: Date.now(), urls: streams.map(item => item.url) })); } catch {}
}

function invalidateCountryCache(code) {
  try { localStorage.removeItem(cacheKey(code)); } catch {}
}

async function fetchChecked(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT);
  try {
    const response = await fetch(url, { cache: 'no-store', redirect: 'follow', ...options, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchTextChecked(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT);
  try {
    const response = await fetch(url, { cache: 'no-store', redirect: 'follow', signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

function firstMediaUri(playlist) {
  const lines = playlist.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const streamIndex = lines.findIndex(line => line.startsWith('#EXT-X-STREAM-INF'));
  if (streamIndex >= 0) return { uri: lines.slice(streamIndex + 1).find(line => !line.startsWith('#')), nested: true };
  return { uri: lines.find(line => !line.startsWith('#')), nested: false };
}

function taggedUri(playlist, tag) {
  const line = playlist.split(/\r?\n/).find(entry => entry.trim().startsWith(tag));
  return line?.match(/URI="([^"]+)"/)?.[1] || null;
}

async function probeHls(url) {
  let playlistUrl = url;
  for (let depth = 0; depth < 3; depth += 1) {
    const text = await fetchTextChecked(playlistUrl);
    if (!text.trimStart().startsWith('#EXTM3U')) return false;
    const media = firstMediaUri(text);
    if (!media.uri) return false;
    const nextUrl = new URL(media.uri, playlistUrl).href;
    if (media.nested) {
      playlistUrl = nextUrl;
      continue;
    }
    const dependencies = [taggedUri(text, '#EXT-X-KEY'), taggedUri(text, '#EXT-X-MAP'), media.uri].filter(Boolean);
    for (const dependency of dependencies) {
      const resource = await fetchChecked(new URL(dependency, playlistUrl).href, { headers: { Range: 'bytes=0-1023' } });
      await resource.body?.cancel();
    }
    return true;
  }
  return false;
}

async function probeStream(item) {
  try {
    if (/\.m3u8(?:$|\?)/i.test(item.url)) return await probeHls(item.url);
    const response = await fetchChecked(item.url, { headers: { Range: 'bytes=0-1023' } });
    const type = response.headers.get('content-type') || '';
    await response.body?.cancel();
    return /video|audio|mpegurl|octet-stream/i.test(type);
  } catch {
    return false;
  }
}

async function probeStreams(candidates, token) {
  const playable = [];
  let cursor = 0;
  let checked = 0;
  async function worker() {
    while (cursor < candidates.length && token === state.scanToken) {
      const item = candidates[cursor++];
      if (await probeStream(item)) playable.push(item);
      checked += 1;
      el.loadingMessage.textContent = `Checking channels… ${checked}/${candidates.length}`;
    }
  }
  await Promise.all(Array.from({ length: Math.min(PROBE_CONCURRENCY, candidates.length) }, worker));
  return playable.sort((a, b) => a.name.localeCompare(b.name));
}

function populateCountries(countries) {
  const usedCodes = new Set(state.candidates.map(item => item.country).filter(Boolean));
  state.countryChoices = countries.filter(country => usedCodes.has(country.code)).sort((a, b) => a.name.localeCompare(b.name));
  state.countryChoices.forEach(country => state.countryCodes.set(country.name.toLocaleLowerCase(), country.code));
}

function removeCountry(code) {
  state.countryChoices = state.countryChoices.filter(country => country.code !== code);
  for (const [name, countryCode] of state.countryCodes) if (countryCode === code) state.countryCodes.delete(name);
}

function renderCountryOptions(query = '') {
  const normalized = query.trim().toLocaleLowerCase();
  const matches = state.countryChoices.filter(country => !normalized || country.name.toLocaleLowerCase().includes(normalized)).slice(0, 12);
  state.countryIndex = matches.length ? 0 : -1;
  el.countryOptions.innerHTML = matches.length
    ? matches.map((country, index) => `<li id="country-option-${index}" role="option" data-country="${escapeHTML(country.name)}" aria-selected="${index === 0}">${country.flag || ''}<span>${escapeHTML(country.name)}</span></li>`).join('')
    : '<li class="country-empty">No matching countries</li>';
  syncCountryHighlight();
}

function syncCountryHighlight() {
  const options = [...el.countryOptions.querySelectorAll('[role="option"]')];
  options.forEach((option, index) => option.setAttribute('aria-selected', String(index === state.countryIndex)));
  const active = options[state.countryIndex];
  if (active) {
    el.country.setAttribute('aria-activedescendant', active.id);
    active.scrollIntoView({ block: 'nearest' });
  } else {
    el.country.removeAttribute('aria-activedescendant');
  }
}

function openCountryMenu(showAll = false) {
  renderCountryOptions(showAll ? '' : el.country.value);
  el.countryOptions.hidden = false;
  el.country.setAttribute('aria-expanded', 'true');
}

function closeCountryMenu() {
  el.countryOptions.hidden = true;
  el.country.setAttribute('aria-expanded', 'false');
  el.country.removeAttribute('aria-activedescendant');
  state.countryIndex = -1;
}

function showLoading(message) {
  el.loadingMessage.textContent = message;
  el.loading.hidden = false;
}

function hideLoading() { el.loading.hidden = true; }

function channelFromUrl() { return new URL(location.href).searchParams.get('channel'); }

function updateChannelUrl(item) {
  const url = new URL(location.href);
  if (url.searchParams.get('channel') === item.channelId) return;
  url.searchParams.set('channel', item.channelId);
  history.pushState({ channel: item.channelId }, '', url);
}

function clearChannelUrl() {
  const url = new URL(location.href);
  if (!url.searchParams.has('channel')) return;
  url.searchParams.delete('channel');
  history.replaceState({}, '', url);
}

function renderList(message = '') {
  const items = state.visible.slice(0, 150);
  el.status.hidden = items.length > 0 && !message;
  el.status.textContent = message || (items.length ? '' : 'No playable channels found for this country.');
  el.list.innerHTML = items.map(item => `<button class="channel-card ${state.active?.key === item.key ? 'active' : ''}" data-key="${item.key}"><span class="card-logo">${logo(item)}</span><span class="card-info"><strong>${escapeHTML(item.name)}</strong><small>${escapeHTML(item.countryName || 'Global')}</small></span><span class="quality">${escapeHTML(item.quality || 'LIVE')}</span></button>`).join('');
}

async function loadCountry(name, { background = false } = {}) {
  const code = state.countryCodes.get(name.trim().toLocaleLowerCase());
  if (!code) return;
  const token = ++state.scanToken;
  state.currentCountry = code;
  closeCountryMenu();
  if (!background) showLoading('Preparing channel checks…');
  const candidates = state.candidates.filter(item => item.country === code);
  let playable = readCachedStreams(code, candidates);
  if (!playable) {
    playable = await probeStreams(candidates, token);
    if (token !== state.scanToken) return;
    writeCachedStreams(code, playable);
  }
  state.visible = playable;
  if (!playable.length) {
    removeCountry(code);
    el.country.value = '';
  }
  renderList();
  if (!background) hideLoading();
}

async function selectCountry(name) {
  el.country.value = name;
  closeCountryMenu();
  await loadCountry(name);
  el.country.focus();
}

function showBrowse() {
  document.body.classList.replace('watch-mode', 'browse-mode');
  el.browseNav.classList.add('active');
  el.watchNav.classList.remove('active');
  setTimeout(() => el.country.focus(), 100);
}

function showWatch() {
  document.body.classList.replace('browse-mode', 'watch-mode');
  el.watchNav.classList.add('active');
  el.browseNav.classList.remove('active');
}

function removeFailedStream(item) {
  state.scanToken += 1;
  state.visible = state.visible.filter(stream => stream.url !== item.url);
  state.candidates = state.candidates.filter(stream => stream.url !== item.url);
  invalidateCountryCache(item.country);
  state.active = null;
  if (state.hls) { state.hls.destroy(); state.hls = null; }
  el.video.pause();
  el.video.removeAttribute('src');
  el.video.load();
  el.empty.hidden = false;
  clearChannelUrl();
  showBrowse();
  renderList('That channel became unavailable and was removed.');
}

function play(item, { updateUrl = true } = {}) {
  if (!item) return;
  state.active = item;
  el.empty.hidden = true;
  if (updateUrl) updateChannelUrl(item);
  showWatch();
  if (state.hls) { state.hls.destroy(); state.hls = null; }
  el.video.pause();
  el.video.removeAttribute('src');
  el.video.load();
  let failed = false;
  const fail = () => { if (!failed) { failed = true; removeFailedStream(item); } };
  if (window.Hls?.isSupported() && /\.m3u8($|\?)/i.test(item.url)) {
    state.hls = new Hls({ enableWorker: true, lowLatencyMode: true });
    state.hls.loadSource(item.url);
    state.hls.attachMedia(el.video);
    state.hls.on(Hls.Events.ERROR, (_, data) => { if (data.fatal) fail(); });
  } else {
    el.video.src = item.url;
  }
  el.video.play().catch(error => {
    if (error.name !== 'NotAllowedError' && error.name !== 'AbortError') fail();
  });
  el.video.onerror = fail;
}

async function init() {
  try {
    const data = await getData();
    el.loadingMessage.textContent = 'Building channel catalog…';
    const channels = new Map(data['channels.json'].map(channel => [channel.id, channel]));
    const countries = new Map(data['countries.json'].map(country => [country.code, country]));
    const logos = new Map(data['logos.json'].filter(item => item.in_use !== false).map(item => [item.channel, item.url]));
    const blockedChannels = new Set(data['blocklist.json'].map(item => item.channel));
    const seen = new Set();
    state.candidates = data['streams.json'].filter(stream => metadataAllowsStream(stream, blockedChannels) && !seen.has(`${stream.channel}|${stream.url}`) && seen.add(`${stream.channel}|${stream.url}`)).map((stream, key) => {
      const channel = channels.get(stream.channel) || {};
      const country = countries.get(channel.country);
      return { key, channelId: stream.channel, name: stream.title || channel.name || stream.channel, url: stream.url, quality: stream.quality, country: channel.country, countryName: country?.name, logo: logos.get(stream.channel) };
    });
    populateCountries(data['countries.json']);
    const requestedChannel = channelFromUrl();
    const target = requestedChannel ? state.candidates.find(item => item.channelId === requestedChannel) : null;
    if (target) {
      el.country.value = target.countryName || '';
      state.visible = [target];
      renderList();
      hideLoading();
      play(target, { updateUrl: false });
      loadCountry(target.countryName, { background: true });
    } else {
      if (requestedChannel) clearChannelUrl();
      await loadCountry('Philippines');
    }
  } catch (error) {
    el.loadingMessage.textContent = 'Could not load channels. Check your connection and refresh.';
    console.error(error);
  }
}

el.country.addEventListener('focus', () => openCountryMenu(true));
el.country.addEventListener('click', () => { if (el.countryOptions.hidden) openCountryMenu(true); });
el.country.addEventListener('input', () => openCountryMenu());
el.country.addEventListener('keydown', event => {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    if (el.countryOptions.hidden) openCountryMenu(true);
    const options = [...el.countryOptions.querySelectorAll('[role="option"]')];
    const direction = event.key === 'ArrowDown' ? 1 : -1;
    state.countryIndex = Math.max(0, Math.min(options.length - 1, state.countryIndex + direction));
    syncCountryHighlight();
  } else if (event.key === 'Enter' && !el.countryOptions.hidden) {
    const active = el.countryOptions.querySelectorAll('[role="option"]')[state.countryIndex];
    if (active) { event.preventDefault(); selectCountry(active.dataset.country); }
  } else if (event.key === 'Escape') {
    closeCountryMenu();
  }
});
el.countryToggle.addEventListener('click', () => {
  if (el.countryOptions.hidden) { el.country.focus(); openCountryMenu(true); } else closeCountryMenu();
});
el.countryOptions.addEventListener('mousedown', event => {
  const option = event.target.closest('[data-country]');
  if (option) { event.preventDefault(); selectCountry(option.dataset.country); }
});
document.addEventListener('mousedown', event => {
  if (!event.target.closest('.country-field')) closeCountryMenu();
});
el.list.addEventListener('click', event => {
  const card = event.target.closest('[data-key]');
  if (card) play(state.visible.find(item => item.key === Number(card.dataset.key)));
});
el.browseNav.addEventListener('click', showBrowse);
el.watchNav.addEventListener('click', showWatch);
window.addEventListener('popstate', () => {
  const requestedChannel = channelFromUrl();
  if (!requestedChannel) {
    if (state.hls) { state.hls.destroy(); state.hls = null; }
    el.video.pause();
    el.empty.hidden = false;
    state.active = null;
    showBrowse();
    renderList();
    return;
  }
  const target = state.candidates.find(item => item.channelId === requestedChannel);
  if (target) {
    el.country.value = target.countryName || '';
    state.visible = [target];
    play(target, { updateUrl: false });
    loadCountry(target.countryName, { background: true });
  }
});
init();
