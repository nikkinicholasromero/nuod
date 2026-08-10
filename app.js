const API = 'https://iptv-org.github.io/api';
const CACHE_VERSION = 3;
const CACHE_FRESH_TTL = 60 * 60 * 1000;
const CACHE_MAX_AGE = 24 * 60 * 60 * 1000;
const CACHE_FLUSH_INTERVAL = 10;
const PROBE_CONCURRENCY = 6;
const BACKGROUND_CONCURRENCY = 2;
const PROBE_TIMEOUT = 7000;
const PRIORITY_FOREGROUND = 100;
const PRIORITY_BACKGROUND = 10;

const state = {
  candidates: [], candidatesByCountry: new Map(), visible: [], active: null, hls: null,
  countryCodes: new Map(), countryByCode: new Map(), catalogCountries: [], countryChoices: [], countryIndex: -1,
  scanResults: new Map(), failedStreamIds: new Set(),
  currentCountry: null, countryRequestId: 0, catalogReady: false, playbackBusy: false, searchQuery: ''
};

const el = {
  video: document.querySelector('#video'), list: document.querySelector('#channelList'), status: document.querySelector('#status'), scanStatus: document.querySelector('#scanStatus'),
  country: document.querySelector('#countryFilter'), countryToggle: document.querySelector('#countryToggle'), countryOptions: document.querySelector('#countryOptions'), search: document.querySelector('#channelSearch'),
  empty: document.querySelector('#playerEmpty'), loading: document.querySelector('#loadingScreen'), loadingMessage: document.querySelector('#loadingMessage'),
  closeWatch: document.querySelector('#closeWatch')
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
function streamId(item) { return `${item.channelId}|${item.url}`; }
function cacheKey(code) { return `nuod:scan:${CACHE_VERSION}:${code}`; }

function catalogSignature(candidates) {
  let hash = 2166136261;
  for (const item of candidates) {
    const value = streamId(item);
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
  }
  return `${candidates.length}:${(hash >>> 0).toString(36)}`;
}

function metadataAllowsStream(stream, blockedChannels) {
  const label = (stream.label || '').toLocaleLowerCase();
  const restricted = /geo|block|restrict|vpn|location|country/.test(label);
  return stream.channel && typeof stream.url === 'string' && stream.url.startsWith('https://') && !stream.referrer && !stream.user_agent && !restricted && !blockedChannels.has(stream.channel);
}

function readCountryResult(code, candidates) {
  try {
    const cached = JSON.parse(localStorage.getItem(cacheKey(code)) || 'null');
    if (!cached || !Array.isArray(cached.checked) || !Array.isArray(cached.playable)) return null;
    const timestamp = cached.status === 'partial' ? cached.updatedAt : cached.checkedAt;
    if (!timestamp || Date.now() - timestamp > CACHE_MAX_AGE) return null;
    const candidateIds = new Set(candidates.map(streamId));
    const checkedIds = new Set(cached.checked.filter(id => candidateIds.has(id)));
    const playableIds = new Set(cached.playable.filter(id => candidateIds.has(id)));
    const complete = cached.status !== 'partial' && candidates.every(item => checkedIds.has(streamId(item)));
    return {
      code, checkedIds, playableIds, complete,
      fresh: complete && Date.now() - cached.checkedAt < CACHE_FRESH_TTL,
      checkedAt: cached.checkedAt || 0, updatedAt: cached.updatedAt || cached.checkedAt || 0,
      signature: catalogSignature(candidates)
    };
  } catch {
    return null;
  }
}

function writeCountryResult(result) {
  const status = result.complete ? (result.playableIds.size ? 'ready' : 'empty') : 'partial';
  try {
    localStorage.setItem(cacheKey(result.code), JSON.stringify({
      status,
      checkedAt: result.checkedAt || 0,
      updatedAt: result.updatedAt || Date.now(),
      catalogSignature: result.signature,
      checked: [...result.checkedIds],
      playable: [...result.playableIds]
    }));
  } catch {}
}

function streamsFromIds(code, playableIds) {
  if (!playableIds) return [];
  return (state.candidatesByCountry.get(code) || [])
    .filter(item => playableIds.has(streamId(item)) && !state.failedStreamIds.has(streamId(item)))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function playableStreams(code, result = state.scanResults.get(code)) {
  return streamsFromIds(code, result?.playableIds);
}

function linkedSignal(externalSignal) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (externalSignal?.aborted) controller.abort();
  else externalSignal?.addEventListener('abort', abort, { once: true });
  return { controller, detach: () => externalSignal?.removeEventListener('abort', abort) };
}

async function fetchChecked(url, options = {}, externalSignal) {
  const { controller, detach } = linkedSignal(externalSignal);
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT);
  try {
    const response = await fetch(url, { cache: 'no-store', redirect: 'follow', ...options, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response;
  } finally {
    clearTimeout(timer);
    detach();
  }
}

async function fetchTextChecked(url, externalSignal) {
  const response = await fetchChecked(url, {}, externalSignal);
  return response.text();
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

async function probeHls(url, signal) {
  let playlistUrl = url;
  for (let depth = 0; depth < 3; depth += 1) {
    const text = await fetchTextChecked(playlistUrl, signal);
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
      const resource = await fetchChecked(new URL(dependency, playlistUrl).href, { headers: { Range: 'bytes=0-1023' } }, signal);
      await resource.body?.cancel();
    }
    return true;
  }
  return false;
}

async function probeStream(item, signal) {
  try {
    if (/\.m3u8(?:$|\?)/i.test(item.url)) return await probeHls(item.url, signal);
    const response = await fetchChecked(item.url, { headers: { Range: 'bytes=0-1023' } }, signal);
    const type = response.headers.get('content-type') || '';
    await response.body?.cancel();
    return /video|audio|mpegurl|octet-stream/i.test(type);
  } catch (error) {
    if (signal?.aborted) throw error;
    return false;
  }
}

function backgroundNetworkAllowed() {
  const connection = navigator.connection;
  return navigator.onLine && !document.hidden && !state.playbackBusy && !connection?.saveData && !['slow-2g', '2g'].includes(connection?.effectiveType);
}

const scanner = {
  jobs: new Map(), active: new Set(), sequence: 0, backgroundEnabled: false,

  createJob(code, force) {
    const candidates = state.candidatesByCountry.get(code) || [];
    const previous = state.scanResults.get(code);
    const checkedIds = force ? new Set() : new Set(previous?.checkedIds || []);
    const playableIds = new Set(previous?.playableIds || []);
    const pending = candidates.filter(item => !checkedIds.has(streamId(item)));
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    const job = {
      code, candidates, checkedIds, playableIds, pending, activeCount: 0,
      priority: PRIORITY_BACKGROUND, order: this.sequence += 1, sinceFlush: 0,
      checkedAt: previous?.checkedAt || 0, signature: catalogSignature(candidates), promise, resolve,
      renderTimer: null
    };
    this.jobs.set(code, job);
    if (!pending.length) queueMicrotask(() => this.finish(job));
    return job;
  },

  request(code, { priority = PRIORITY_BACKGROUND, force = false } = {}) {
    const previous = state.scanResults.get(code);
    if (!force && previous?.complete) return Promise.resolve(playableStreams(code, previous));
    const job = this.jobs.get(code) || this.createJob(code, force);
    job.priority = Math.max(job.priority, priority);
    this.reportProgress(job, false);
    this.pump();
    return job.promise;
  },

  focus(code) {
    for (const job of this.jobs.values()) {
      if (job.code !== code && job.priority >= PRIORITY_FOREGROUND) job.priority = PRIORITY_BACKGROUND;
    }
    for (const task of this.active) {
      if (task.job.code !== code) task.controller.abort();
    }
    this.pump();
  },

  promote(code) {
    const job = this.jobs.get(code);
    if (!job) return;
    job.priority = PRIORITY_FOREGROUND;
    this.reportProgress(job, true);
    this.pump();
  },

  demote(code) {
    const job = this.jobs.get(code);
    if (!job || job.priority < PRIORITY_FOREGROUND) return;
    job.priority = PRIORITY_BACKGROUND;
    for (const task of this.active) {
      if (task.job === job) task.controller.abort();
    }
    this.refresh();
  },

  setBackgroundEnabled(enabled) {
    this.backgroundEnabled = enabled;
    this.refresh();
  },

  canRunBackground() {
    return this.backgroundEnabled && backgroundNetworkAllowed();
  },

  refresh() {
    if (!this.canRunBackground()) {
      for (const task of this.active) {
        if (task.job.priority < PRIORITY_FOREGROUND) task.controller.abort();
      }
    }
    this.pump();
  },

  nextJob() {
    const jobs = [...this.jobs.values()].filter(job => job.pending.length);
    const foregroundExists = [...this.jobs.values()].some(job => job.priority >= PRIORITY_FOREGROUND && (job.pending.length || job.activeCount));
    // Keep background work to one worker per country so a large catalog cannot occupy both lanes.
    const eligible = jobs.filter(job => foregroundExists
      ? job.priority >= PRIORITY_FOREGROUND
      : this.canRunBackground() && job.activeCount === 0);
    return eligible.sort((a, b) => b.priority - a.priority || a.order - b.order)[0] || null;
  },

  pump() {
    while (true) {
      const job = this.nextJob();
      if (!job) return;
      const concurrency = job.priority >= PRIORITY_FOREGROUND ? PROBE_CONCURRENCY : BACKGROUND_CONCURRENCY;
      if (this.active.size >= concurrency) return;
      this.start(job);
    }
  },

  start(job) {
    const item = job.pending.shift();
    if (!item) return;
    const controller = new AbortController();
    const task = { job, item, controller };
    job.activeCount += 1;
    this.active.add(task);
    probeStream(item, controller.signal).then(playable => {
      if (controller.signal.aborted) return;
      const id = streamId(item);
      const provenByPlayback = state.active && streamId(state.active) === id && el.video.readyState >= 2;
      const wasPlayable = job.playableIds.has(id);
      job.checkedIds.add(id);
      if ((playable || provenByPlayback) && !state.failedStreamIds.has(id)) job.playableIds.add(id);
      else job.playableIds.delete(id);
      job.sinceFlush += 1;
      if (job.sinceFlush >= CACHE_FLUSH_INTERVAL) this.persistPartial(job);
      this.reportProgress(job, wasPlayable !== job.playableIds.has(id));
    }).catch(() => {
      if (!controller.signal.aborted) {
        const id = streamId(item);
        const wasPlayable = job.playableIds.has(id);
        job.checkedIds.add(id);
        job.playableIds.delete(id);
        job.sinceFlush += 1;
        if (job.sinceFlush >= CACHE_FLUSH_INTERVAL) this.persistPartial(job);
        this.reportProgress(job, wasPlayable);
      }
    }).finally(() => {
      this.active.delete(task);
      job.activeCount -= 1;
      if (controller.signal.aborted && !state.failedStreamIds.has(streamId(item))) job.pending.unshift(item);
      if (!job.pending.length && !job.activeCount) this.finish(job);
      this.pump();
    });
  },

  reportProgress(job, channelsChanged = false) {
    if (state.currentCountry !== job.code) return;
    showScanProgress(job);
    if (channelsChanged) scheduleProgressiveRender(job);
  },

  persistPartial(job) {
    job.sinceFlush = 0;
    const result = {
      code: job.code,
      checkedIds: new Set(job.checkedIds), playableIds: new Set(job.playableIds),
      complete: false, fresh: false, checkedAt: job.checkedAt,
      updatedAt: Date.now(), signature: job.signature
    };
    state.scanResults.set(job.code, result);
    writeCountryResult(result);
  },

  finish(job) {
    if (this.jobs.get(job.code) !== job || job.activeCount || job.pending.length) return;
    if (job.renderTimer) clearTimeout(job.renderTimer);
    const result = {
      code: job.code,
      checkedIds: new Set(job.checkedIds), playableIds: new Set(job.playableIds),
      complete: true, fresh: true, checkedAt: Date.now(),
      updatedAt: Date.now(), signature: job.signature
    };
    state.scanResults.set(job.code, result);
    writeCountryResult(result);
    this.jobs.delete(job.code);
    const streams = playableStreams(job.code, result);
    handleCountryScanComplete(job.code, streams);
    job.resolve(streams);
  },

  markPlayable(item) {
    const id = streamId(item);
    state.failedStreamIds.delete(id);
    const job = this.jobs.get(item.country);
    if (job) {
      job.checkedIds.add(id);
      job.playableIds.add(id);
      job.pending = job.pending.filter(candidate => streamId(candidate) !== id);
      this.reportProgress(job, true);
      if (!job.pending.length && !job.activeCount) this.finish(job);
    }
    const result = state.scanResults.get(item.country);
    if (result) {
      result.checkedIds.add(id);
      result.playableIds.add(id);
      result.updatedAt = Date.now();
      writeCountryResult(result);
    }
    addCountry(item.country);
  },

  markFailed(item) {
    const id = streamId(item);
    state.failedStreamIds.add(id);
    const job = this.jobs.get(item.country);
    if (job) {
      const wasPlayable = job.playableIds.has(id);
      job.checkedIds.add(id);
      job.playableIds.delete(id);
      job.pending = job.pending.filter(candidate => streamId(candidate) !== id);
      this.persistPartial(job);
      this.reportProgress(job, wasPlayable);
      if (!job.pending.length && !job.activeCount) this.finish(job);
    }
    const result = state.scanResults.get(item.country);
    if (result) {
      result.checkedIds.add(id);
      result.playableIds.delete(id);
      result.updatedAt = Date.now();
      writeCountryResult(result);
    }
  },

  persistActive() {
    for (const job of this.jobs.values()) {
      if (job.checkedIds.size) this.persistPartial(job);
    }
  }
};

function populateCountries(countries) {
  const usedCodes = new Set(state.candidatesByCountry.keys());
  state.catalogCountries = countries.filter(country => usedCodes.has(country.code)).sort((a, b) => a.name.localeCompare(b.name));
  for (const country of state.catalogCountries) {
    state.countryCodes.set(country.name.toLocaleLowerCase(), country.code);
    state.countryByCode.set(country.code, country);
    const result = readCountryResult(country.code, state.candidatesByCountry.get(country.code) || []);
    if (result) state.scanResults.set(country.code, result);
  }
  state.countryChoices = state.catalogCountries.filter(country => {
    const result = state.scanResults.get(country.code);
    return !(result?.complete && result.playableIds.size === 0);
  });
}

function refreshCountryOptions() {
  if (!el.countryOptions.hidden) renderCountryOptions(el.country.value);
}

function addCountry(code) {
  const country = state.countryByCode.get(code);
  if (!country || state.countryChoices.some(choice => choice.code === code)) return;
  state.countryChoices.push(country);
  state.countryChoices.sort((a, b) => a.name.localeCompare(b.name));
  refreshCountryOptions();
}

function removeCountry(code) {
  const length = state.countryChoices.length;
  state.countryChoices = state.countryChoices.filter(country => country.code !== code);
  if (state.countryChoices.length !== length) refreshCountryOptions();
}

function renderCountryOptions(query = '') {
  const normalized = query.trim().toLocaleLowerCase();
  const matches = state.countryChoices.filter(country => !normalized || country.name.toLocaleLowerCase().includes(normalized));
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

function showScanProgress(job) {
  el.scanStatus.textContent = `Scanning channels... ${job.checkedIds.size.toLocaleString()} / ${job.candidates.length.toLocaleString()}`;
  el.scanStatus.hidden = false;
}

function hideScanProgress(code) {
  if (!code || state.currentCountry === code) {
    el.scanStatus.hidden = true;
    el.scanStatus.textContent = '';
  }
}

function scheduleProgressiveRender(job) {
  if (job.renderTimer || state.currentCountry !== job.code) return;
  job.renderTimer = setTimeout(() => {
    job.renderTimer = null;
    if (state.currentCountry !== job.code) return;
    applyCountryStreams(job.code, streamsFromIds(job.code, job.playableIds), { scanning: true, preserveScroll: true });
  }, 150);
}

function renderList(message = '', { scanning = false, preserveScroll = false } = {}) {
  const previousScrollTop = el.list.scrollTop;
  const previousCards = preserveScroll ? [...el.list.querySelectorAll('.channel-card')] : [];
  const anchor = previousCards.find(card => card.offsetTop + card.offsetHeight > previousScrollTop);
  const anchorOffset = anchor ? anchor.offsetTop - previousScrollTop : 0;
  const anchorKey = anchor?.dataset.key;
  const items = state.searchQuery
    ? state.visible.filter(item => item.name.toLocaleLowerCase().includes(state.searchQuery))
    : state.visible;
  el.status.hidden = !message && (items.length > 0 || scanning);
  el.status.textContent = message || (items.length || scanning ? '' : state.searchQuery ? 'No matching channels.' : 'No playable channels found for this country.');
  el.list.innerHTML = items.map(item => `<button class="channel-card ${state.active?.key === item.key ? 'active' : ''}" data-key="${item.key}"><span class="card-logo">${logo(item)}</span><span class="card-info"><strong>${escapeHTML(item.name)}</strong><small>${escapeHTML(item.countryName || 'Global')}</small></span><span class="quality">${escapeHTML(item.quality || 'LIVE')}</span></button>`).join('');
  if (preserveScroll) {
    const nextAnchor = anchorKey ? el.list.querySelector(`[data-key="${anchorKey}"]`) : null;
    el.list.scrollTop = nextAnchor ? nextAnchor.offsetTop - anchorOffset : previousScrollTop;
  }
}

function applyCountryStreams(code, streams, { scanning = false, preserveScroll = false } = {}) {
  const active = state.active?.country === code && !state.failedStreamIds.has(streamId(state.active)) ? state.active : null;
  state.visible = active && !streams.some(item => streamId(item) === streamId(active)) ? [active, ...streams] : streams;
  if (state.visible.length) addCountry(code);
  else if (!scanning) removeCountry(code);
  renderList('', { scanning, preserveScroll });
}

function handleCountryScanComplete(code, streams) {
  if (streams.length || state.active?.country === code) addCountry(code);
  else removeCountry(code);
  if (state.currentCountry === code) {
    hideScanProgress(code);
    applyCountryStreams(code, streams, { preserveScroll: true });
    if (!state.visible.length) el.country.value = '';
  }
}

function loadCountry(name, { background = false } = {}) {
  const code = state.countryCodes.get(name.trim().toLocaleLowerCase());
  if (!code) return;
  state.countryRequestId += 1;
  state.currentCountry = code;
  closeCountryMenu();
  hideScanProgress();
  if (!background) scanner.focus(code);

  const result = state.scanResults.get(code);
  const cachedStreams = playableStreams(code, result);
  const hasUsableCache = Boolean(result && (result.complete || cachedStreams.length));

  if (hasUsableCache) {
    applyCountryStreams(code, cachedStreams, { scanning: !result.fresh });
    if (result.complete && result.fresh) return Promise.resolve(cachedStreams);
    const priority = background ? PRIORITY_BACKGROUND : PRIORITY_FOREGROUND;
    const scan = scanner.request(code, { priority, force: result.complete });
    scan.catch(console.error);
    return scan;
  }

  if (background) {
    const scan = scanner.request(code, { priority: PRIORITY_BACKGROUND });
    scan.catch(console.error);
    return scan;
  }

  applyCountryStreams(code, [], { scanning: true });
  const scan = scanner.request(code, { priority: PRIORITY_FOREGROUND });
  scan.catch(console.error);
  return scan;
}

function selectCountry(name) {
  state.searchQuery = '';
  el.search.value = '';
  el.country.value = name;
  closeCountryMenu();
  loadCountry(name);
}

function backgroundQueueRank(country) {
  const result = state.scanResults.get(country.code);
  if (result && !result.complete) return 0;
  if (!result) return 1;
  return 2;
}

function queueBackgroundScans() {
  if (!state.catalogReady) return;
  scanner.setBackgroundEnabled(Boolean(state.active));
  if (!state.active) return;
  const countries = state.catalogCountries
    .filter(country => !state.scanResults.get(country.code)?.fresh)
    .sort((a, b) => backgroundQueueRank(a) - backgroundQueueRank(b));
  for (const country of countries) {
    const result = state.scanResults.get(country.code);
    scanner.request(country.code, { priority: PRIORITY_BACKGROUND, force: Boolean(result?.complete) }).catch(console.error);
  }
}

function showBrowse() {
  document.body.classList.replace('watch-mode', 'browse-mode');
  scanner.setBackgroundEnabled(false);
  if (state.currentCountry) {
    scanner.focus(state.currentCountry);
    scanner.promote(state.currentCountry);
  }
  closeCountryMenu();
}

function showWatch() {
  document.body.classList.replace('browse-mode', 'watch-mode');
  queueBackgroundScans();
}

function stopPlayback({ clearUrl = false } = {}) {
  if (state.hls) { state.hls.destroy(); state.hls = null; }
  el.video.pause();
  el.video.removeAttribute('src');
  el.video.onerror = null;
  el.video.load();
  state.active = null;
  state.playbackBusy = false;
  el.empty.hidden = false;
  if (clearUrl) clearChannelUrl();
}

function closeWatch() {
  stopPlayback({ clearUrl: true });
  showBrowse();
  renderList();
}

function removeFailedStream(item) {
  scanner.markFailed(item);
  state.visible = state.visible.filter(stream => streamId(stream) !== streamId(item));
  state.candidates = state.candidates.filter(stream => streamId(stream) !== streamId(item));
  if (!playableStreams(item.country).length) removeCountry(item.country);
  stopPlayback({ clearUrl: true });
  showBrowse();
  renderList('That channel became unavailable and was removed.');
}

function play(item, { updateUrl = true } = {}) {
  if (!item) return;
  state.active = item;
  state.playbackBusy = true;
  scanner.demote(item.country);
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
    el.loadingMessage.textContent = 'Building channel catalog...';
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
    for (const item of state.candidates) {
      if (!state.candidatesByCountry.has(item.country)) state.candidatesByCountry.set(item.country, []);
      state.candidatesByCountry.get(item.country).push(item);
    }
    populateCountries(data['countries.json']);
    state.catalogReady = true;
    hideLoading();

    const requestedChannel = channelFromUrl();
    const target = requestedChannel ? state.candidates.find(item => item.channelId === requestedChannel) : null;
    if (target) {
      el.country.value = target.countryName || '';
      state.currentCountry = target.country;
      state.visible = [target];
      renderList();
      play(target, { updateUrl: false });
      loadCountry(target.countryName, { background: true });
    } else {
      if (requestedChannel) clearChannelUrl();
      const defaultCountry = state.countryChoices.find(country => country.code === 'PH') || state.countryChoices[0];
      if (!defaultCountry) {
        el.country.value = '';
        state.visible = [];
        renderList();
        return;
      }
      el.country.value = defaultCountry.name;
      loadCountry(defaultCountry.name);
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
  if (el.countryOptions.hidden) openCountryMenu(true); else closeCountryMenu();
});
el.countryOptions.addEventListener('mousedown', event => {
  const option = event.target.closest('[data-country]');
  if (option) event.preventDefault();
});
el.countryOptions.addEventListener('click', event => {
  const option = event.target.closest('[data-country]');
  if (option) selectCountry(option.dataset.country);
});
el.search.addEventListener('input', () => {
  state.searchQuery = el.search.value.trim().toLocaleLowerCase();
  el.list.scrollTop = 0;
  renderList('', { scanning: scanner.jobs.has(state.currentCountry) });
});
document.addEventListener('mousedown', event => {
  if (!event.target.closest('.country-field')) closeCountryMenu();
});
el.list.addEventListener('click', event => {
  const card = event.target.closest('[data-key]');
  if (card) play(state.visible.find(item => item.key === Number(card.dataset.key)));
});
el.closeWatch.addEventListener('click', closeWatch);

for (const eventName of ['waiting', 'stalled', 'seeking']) {
  el.video.addEventListener(eventName, () => { state.playbackBusy = true; scanner.refresh(); });
}
for (const eventName of ['playing', 'canplay', 'seeked']) {
  el.video.addEventListener(eventName, () => {
    state.playbackBusy = false;
    if (state.active) scanner.markPlayable(state.active);
    queueBackgroundScans();
  });
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) scanner.persistActive();
  scanner.refresh();
});
window.addEventListener('online', () => scanner.refresh());
window.addEventListener('offline', () => scanner.refresh());
navigator.connection?.addEventListener?.('change', () => scanner.refresh());
window.addEventListener('beforeunload', () => scanner.persistActive());

window.addEventListener('popstate', () => {
  const requestedChannel = channelFromUrl();
  if (!requestedChannel) {
    stopPlayback();
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
