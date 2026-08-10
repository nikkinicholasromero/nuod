const API = 'https://iptv-org.github.io/api';
const CACHE_VERSION = 4;
const CACHE_FRESH_TTL = 24 * 60 * 60 * 1000;
const CACHE_INCONCLUSIVE_TTL = 6 * 60 * 60 * 1000;
const CACHE_MAX_AGE = 7 * 24 * 60 * 60 * 1000;
const CACHE_FLUSH_INTERVAL = 10;
const PROBE_CONCURRENCY = 6;
const BACKGROUND_CONCURRENCY = 2;
const PROBE_TIMEOUT = 7000;
const PRIORITY_FOREGROUND = 100;
const PRIORITY_ACTIVE_BACKGROUND = 20;
const PRIORITY_BACKGROUND = 10;
const EVERYWHERE = '__everywhere__';

const state = {
  candidates: [], candidatesByCountry: new Map(), visible: [], active: null, hls: null,
  countryCodes: new Map(), countryByCode: new Map(), catalogCountries: [], countryChoices: [], countryIndex: -1,
  scanResults: new Map(), failedStreamIds: new Set(),
  currentCountry: null, countryRequestId: 0, catalogReady: false, playbackBusy: false, searchQuery: '', everywhereRenderTimer: null
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
function compareChannelNames(left, right) {
  const leftName = left.name.toLowerCase();
  const rightName = right.name.toLowerCase();
  return leftName < rightName ? -1 : leftName > rightName ? 1 : 0;
}

function catalogSignature(candidates) {
  let hash = 2166136261;
  const ids = [...new Set(candidates.map(streamId))].sort();
  for (const value of ids) {
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    hash ^= 255;
    hash = Math.imul(hash, 16777619);
  }
  return `${ids.length}:${(hash >>> 0).toString(36)}`;
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
    const age = Date.now() - timestamp;
    if (!timestamp || !Number.isFinite(age) || age < 0 || age > CACHE_MAX_AGE) return null;
    const candidateIds = new Set(candidates.map(streamId));
    const checkedIds = new Set(cached.checked.filter(id => candidateIds.has(id)));
    const playableIds = new Set(cached.playable.filter(id => candidateIds.has(id)));
    const unresolvedIds = new Set((Array.isArray(cached.unresolved) ? cached.unresolved : []).filter(id => candidateIds.has(id)));
    for (const id of unresolvedIds) checkedIds.delete(id);
    const complete = cached.status !== 'partial' && !unresolvedIds.size && candidates.every(item => checkedIds.has(streamId(item)));
    const signature = catalogSignature(candidates);
    return {
      code, checkedIds, playableIds, unresolvedIds, complete,
      hasInconclusive: unresolvedIds.size > 0 || Boolean(cached.inconclusive), retryAt: Number(cached.retryAt) || 0,
      checkedAt: cached.checkedAt || 0, updatedAt: cached.updatedAt || cached.checkedAt || 0,
      signature, catalogChanged: cached.catalogSignature !== signature
    };
  } catch {
    return null;
  }
}

function validationEpochIsFresh(result, now = Date.now()) {
  const age = now - (result?.checkedAt || 0);
  return Boolean(result && Number.isFinite(age) && age >= 0 && age < CACHE_FRESH_TTL);
}

function resultIsFresh(result, now = Date.now()) {
  return Boolean(result?.complete && !result.hasInconclusive && validationEpochIsFresh(result, now));
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
      playable: [...result.playableIds],
      unresolved: [...(result.unresolvedIds || [])],
      retryAt: result.retryAt || 0,
      inconclusive: Boolean(result.hasInconclusive)
    }));
  } catch {}
}

function streamsFromIds(code, playableIds) {
  if (!playableIds) return [];
  return (state.candidatesByCountry.get(code) || [])
    .filter(item => playableIds.has(streamId(item)) && !state.failedStreamIds.has(streamId(item)));
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
    if (/\.m3u8(?:$|\?)/i.test(item.url)) return { playable: await probeHls(item.url, signal), inconclusive: false };
    const response = await fetchChecked(item.url, { headers: { Range: 'bytes=0-1023' } }, signal);
    const type = response.headers.get('content-type') || '';
    await response.body?.cancel();
    return { playable: /video|audio|mpegurl|octet-stream/i.test(type), inconclusive: false };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { playable: false, inconclusive: true };
  }
}

function backgroundNetworkAllowed() {
  const connection = navigator.connection;
  return navigator.onLine && !document.hidden && !state.playbackBusy && !connection?.saveData && !['slow-2g', '2g'].includes(connection?.effectiveType);
}

const scanner = {
  jobs: new Map(), active: new Set(), sequence: 0, backgroundEnabled: false,

  plan(code) {
    const candidates = state.candidatesByCountry.get(code) || [];
    if (!candidates.length) return { needed: false, refresh: false };
    const result = state.scanResults.get(code);
    if (resultIsFresh(result)) return { needed: false, refresh: false };
    // A partial scan only belongs to one validation generation. Once that
    // generation is stale, start it again instead of making old checks fresh
    // by completing only the remaining candidates.
    if (result && !result.complete && !validationEpochIsFresh(result)) {
      return { needed: true, refresh: true };
    }
    if (result?.unresolvedIds?.size) {
      const hasUnchecked = candidates.some(item => {
        const id = streamId(item);
        return !result.checkedIds.has(id) && !result.unresolvedIds.has(id);
      });
      if (!hasUnchecked && Date.now() < result.retryAt) return { needed: false, refresh: false };
    }
    return { needed: true, refresh: Boolean(result?.complete) };
  },

  needsScan(code) {
    return this.jobs.has(code) || this.plan(code).needed;
  },

  createJob(code, fullRefresh) {
    const candidates = state.candidatesByCountry.get(code) || [];
    const previous = state.scanResults.get(code);
    const checkedIds = fullRefresh ? new Set() : new Set(previous?.checkedIds || []);
    const playableIds = new Set(previous?.playableIds || []);
    const unresolvedIds = fullRefresh ? new Set() : new Set(previous?.unresolvedIds || []);
    for (const id of unresolvedIds) checkedIds.delete(id);
    const pending = candidates.filter(item => !checkedIds.has(streamId(item)));
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    const job = {
      code, candidates, checkedIds, playableIds, unresolvedIds, pending, activeCount: 0,
      priority: PRIORITY_BACKGROUND, order: this.sequence += 1, sinceFlush: 0,
      checkedAt: fullRefresh || !previous ? 0 : previous.checkedAt || 0,
      signature: catalogSignature(candidates), promise, resolve,
      renderTimer: null, dispatchCount: 0, hasInconclusive: unresolvedIds.size > 0
    };
    this.jobs.set(code, job);
    if (!pending.length) queueMicrotask(() => this.finish(job));
    return job;
  },

  request(code, { priority = PRIORITY_BACKGROUND, defer = false } = {}) {
    const existing = this.jobs.get(code);
    if (existing) {
      existing.priority = Math.max(existing.priority, priority);
      this.reportProgress(existing, false);
      if (!defer) this.rebalance();
      return existing.promise;
    }
    const plan = this.plan(code);
    if (!plan.needed) return Promise.resolve(playableStreams(code));
    const job = this.createJob(code, plan.refresh);
    job.priority = Math.max(job.priority, priority);
    this.reportProgress(job, false);
    if (!defer) this.rebalance();
    return job.promise;
  },

  focus(code, { defer = false } = {}) {
    for (const job of this.jobs.values()) {
      job.priority = job.code === code ? PRIORITY_FOREGROUND : PRIORITY_BACKGROUND;
    }
    if (code) {
      for (const task of this.active) {
        if (task.job.code !== code) task.controller.abort();
      }
    }
    if (!defer) this.rebalance();
  },

  promoteAll() {
    for (const job of this.jobs.values()) job.priority = PRIORITY_FOREGROUND;
    this.rebalance();
  },

  demoteAll(preferredCode = null) {
    for (const job of this.jobs.values()) {
      job.priority = job.code === preferredCode ? PRIORITY_ACTIVE_BACKGROUND : PRIORITY_BACKGROUND;
    }
    this.rebalance();
  },

  setBackgroundEnabled(enabled) {
    this.backgroundEnabled = enabled;
    this.rebalance();
  },

  canRunBackground() {
    return this.backgroundEnabled && backgroundNetworkAllowed();
  },

  hasForeground() {
    return [...this.jobs.values()].some(job => job.priority >= PRIORITY_FOREGROUND && (job.pending.length || job.activeCount));
  },

  concurrencyLimit(foregroundExists = this.hasForeground()) {
    if (!navigator.onLine || document.hidden) return 0;
    if (foregroundExists) return PROBE_CONCURRENCY;
    return this.canRunBackground() ? BACKGROUND_CONCURRENCY : 0;
  },

  rebalance() {
    const foregroundExists = this.hasForeground();
    const limit = this.concurrencyLimit(foregroundExists);
    for (const task of this.active) {
      if (task.controller.signal.aborted) continue;
      const eligible = navigator.onLine && (foregroundExists
        ? task.job.priority >= PRIORITY_FOREGROUND
        : this.canRunBackground());
      if (!eligible) task.controller.abort();
    }
    const survivors = [...this.active]
      .filter(task => !task.controller.signal.aborted)
      .sort((a, b) => b.job.priority - a.job.priority || a.job.order - b.job.order);
    for (const task of survivors.slice(limit)) task.controller.abort();
    this.pump();
  },

  refresh() {
    this.rebalance();
  },

  nextJob() {
    if (!this.concurrencyLimit()) return null;
    const jobs = [...this.jobs.values()].filter(job => job.pending.length);
    const foregroundExists = this.hasForeground();
    const spreadAcrossCountries = state.currentCountry === EVERYWHERE;
    // Keep background work to one worker per country so a large catalog cannot occupy both lanes.
    let eligible;
    if (foregroundExists) {
      const foreground = jobs.filter(job => job.priority >= PRIORITY_FOREGROUND);
      const inactive = spreadAcrossCountries ? foreground.filter(job => job.activeCount === 0) : foreground;
      eligible = inactive.length ? inactive : foreground;
    } else {
      eligible = jobs.filter(job => this.canRunBackground() && job.activeCount === 0);
    }
    return eligible.sort((a, b) => b.priority - a.priority
      || (spreadAcrossCountries ? a.dispatchCount - b.dispatchCount : 0)
      || a.order - b.order)[0] || null;
  },

  pump() {
    while (true) {
      const concurrency = this.concurrencyLimit();
      if (!concurrency || this.active.size >= concurrency) return;
      const job = this.nextJob();
      if (!job) return;
      this.start(job);
    }
  },

  start(job) {
    const item = job.pending.shift();
    if (!item) return;
    if (!job.checkedAt) job.checkedAt = Date.now();
    job.dispatchCount += 1;
    const controller = new AbortController();
    const task = { job, item, controller };
    job.activeCount += 1;
    this.active.add(task);
    probeStream(item, controller.signal).then(({ playable, inconclusive }) => {
      if (controller.signal.aborted) return;
      const id = streamId(item);
      const provenByPlayback = state.active && streamId(state.active) === id && el.video.readyState >= 2;
      const wasPlayable = job.playableIds.has(id);
      if (inconclusive && !provenByPlayback) {
        job.checkedIds.delete(id);
        job.unresolvedIds.add(id);
        job.hasInconclusive = true;
      } else {
        job.checkedIds.add(id);
        job.unresolvedIds.delete(id);
        if ((playable || provenByPlayback) && !state.failedStreamIds.has(id)) job.playableIds.add(id);
        else job.playableIds.delete(id);
      }
      job.sinceFlush += 1;
      if (job.sinceFlush >= CACHE_FLUSH_INTERVAL) this.persistPartial(job);
      this.reportProgress(job, wasPlayable !== job.playableIds.has(id));
    }).catch(() => {
      if (!controller.signal.aborted) {
        const id = streamId(item);
        const wasPlayable = job.playableIds.has(id);
        job.checkedIds.delete(id);
        job.unresolvedIds.add(id);
        job.hasInconclusive = true;
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
    if (state.currentCountry === EVERYWHERE) {
      showEverywhereProgress();
      if (channelsChanged) scheduleEverywhereRender();
      return;
    }
    if (state.currentCountry !== job.code) return;
    showScanProgress(job);
    if (channelsChanged) scheduleProgressiveRender(job);
  },

  persistPartial(job) {
    job.sinceFlush = 0;
    const result = {
      code: job.code,
      checkedIds: new Set(job.checkedIds), playableIds: new Set(job.playableIds),
      unresolvedIds: new Set(job.unresolvedIds), retryAt: 0,
      complete: false, checkedAt: job.checkedAt, hasInconclusive: job.hasInconclusive,
      updatedAt: Date.now(), signature: job.signature
    };
    state.scanResults.set(job.code, result);
    writeCountryResult(result);
  },

  finish(job) {
    if (this.jobs.get(job.code) !== job || job.activeCount || job.pending.length) return;
    if (job.renderTimer) clearTimeout(job.renderTimer);
    const complete = job.unresolvedIds.size === 0;
    const result = {
      code: job.code,
      checkedIds: new Set(job.checkedIds), playableIds: new Set(job.playableIds),
      unresolvedIds: new Set(job.unresolvedIds), retryAt: complete ? 0 : Date.now() + CACHE_INCONCLUSIVE_TTL,
      complete, checkedAt: job.checkedAt, hasInconclusive: !complete,
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
      job.unresolvedIds.delete(id);
      job.pending = job.pending.filter(candidate => streamId(candidate) !== id);
      this.reportProgress(job, true);
      if (!job.pending.length && !job.activeCount) this.finish(job);
    }
    const result = state.scanResults.get(item.country);
    if (result) {
      result.checkedIds.add(id);
      result.playableIds.add(id);
      result.unresolvedIds?.delete(id);
      if ((state.candidatesByCountry.get(item.country) || []).every(candidate => result.checkedIds.has(streamId(candidate)))) {
        result.complete = true;
        result.retryAt = 0;
        result.hasInconclusive = false;
      }
      result.updatedAt = Date.now();
      writeCountryResult(result);
    }
  },

  markFailed(item) {
    const id = streamId(item);
    state.failedStreamIds.add(id);
    const job = this.jobs.get(item.country);
    if (job) {
      const wasPlayable = job.playableIds.has(id);
      job.checkedIds.add(id);
      job.playableIds.delete(id);
      job.unresolvedIds.delete(id);
      job.pending = job.pending.filter(candidate => streamId(candidate) !== id);
      this.persistPartial(job);
      this.reportProgress(job, wasPlayable);
      if (!job.pending.length && !job.activeCount) this.finish(job);
    }
    const result = state.scanResults.get(item.country);
    if (result) {
      result.checkedIds.add(id);
      result.playableIds.delete(id);
      result.unresolvedIds?.delete(id);
      if ((state.candidatesByCountry.get(item.country) || []).every(candidate => result.checkedIds.has(streamId(candidate)))) {
        result.complete = true;
        result.retryAt = 0;
        result.hasInconclusive = false;
      }
      result.updatedAt = Date.now();
      writeCountryResult(result);
    }
  },

  persistActive() {
    for (const job of this.jobs.values()) {
      if (job.checkedIds.size || job.unresolvedIds.size) this.persistPartial(job);
    }
  }
};

function populateCountries(countries) {
  state.catalogCountries = [...countries].sort((a, b) => a.name.localeCompare(b.name));
  for (const country of state.catalogCountries) {
    state.countryCodes.set(country.name.toLocaleLowerCase(), country.code);
    state.countryByCode.set(country.code, country);
    const result = readCountryResult(country.code, state.candidatesByCountry.get(country.code) || []);
    if (result) {
      state.scanResults.set(country.code, result);
      if (result.catalogChanged) writeCountryResult(result);
    }
  }
  state.countryChoices = state.catalogCountries;
}

function renderCountryOptions(query = '') {
  const normalized = query.trim().toLocaleLowerCase();
  const choices = [{ code: EVERYWHERE, name: 'Everywhere', flag: '' }, ...state.countryChoices];
  const matches = choices.filter(country => !normalized || country.name.toLocaleLowerCase().includes(normalized));
  state.countryIndex = matches.length ? 0 : -1;
  el.countryOptions.innerHTML = matches.length
    ? matches.map((country, index) => `<li id="country-option-${index}" role="option" data-country="${escapeHTML(country.code === EVERYWHERE ? EVERYWHERE : country.name)}" aria-selected="${index === 0}">${country.flag || ''}<span>${escapeHTML(country.name)}</span></li>`).join('')
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

function everywhereStreams() {
  return state.catalogCountries.flatMap(country => {
    const liveIds = scanner.jobs.get(country.code)?.playableIds;
    return streamsFromIds(country.code, liveIds ?? state.scanResults.get(country.code)?.playableIds);
  });
}

function everywhereIsScanning() {
  return [...scanner.jobs.values()].some(job => job.pending.length || job.activeCount);
}

function showEverywhereProgress() {
  const checked = state.catalogCountries.reduce((total, country) => {
    const job = scanner.jobs.get(country.code);
    const result = state.scanResults.get(country.code);
    return total + (job?.checkedIds.size ?? result?.checkedIds.size ?? 0);
  }, 0);
  const candidates = state.catalogCountries.reduce((total, country) => total + (state.candidatesByCountry.get(country.code)?.length || 0), 0);
  el.scanStatus.textContent = `Scanning channels... ${checked.toLocaleString()} / ${candidates.toLocaleString()}`;
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

function scheduleEverywhereRender() {
  if (state.everywhereRenderTimer) return;
  state.everywhereRenderTimer = setTimeout(() => {
    state.everywhereRenderTimer = null;
    if (state.currentCountry !== EVERYWHERE) return;
    state.visible = everywhereStreams();
    renderList('', { scanning: everywhereIsScanning(), preserveScroll: true });
  }, 150);
}

function renderList(message = '', { scanning = false, preserveScroll = false } = {}) {
  const previousScrollTop = el.list.scrollTop;
  const previousCards = preserveScroll ? [...el.list.querySelectorAll('.channel-card')] : [];
  const anchor = previousCards.find(card => card.offsetTop + card.offsetHeight > previousScrollTop);
  const anchorOffset = anchor ? anchor.offsetTop - previousScrollTop : 0;
  const anchorKey = anchor?.dataset.key;
  const visibleItems = state.searchQuery
    ? state.visible.filter(item => item.name.toLocaleLowerCase().includes(state.searchQuery))
    : state.visible;
  const items = [...visibleItems].sort(compareChannelNames);
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
  renderList('', { scanning, preserveScroll });
}

function handleCountryScanComplete(code, streams) {
  if (state.currentCountry === EVERYWHERE) {
    scheduleEverywhereRender();
    if (!everywhereIsScanning()) hideScanProgress();
    return;
  }
  if (state.currentCountry === code) {
    hideScanProgress(code);
    applyCountryStreams(code, streams, { preserveScroll: true });
  }
}

function loadCountry(name, { background = false } = {}) {
  if (name === EVERYWHERE) return loadEverywhere();
  const code = state.countryCodes.get(name.trim().toLocaleLowerCase());
  if (!code) return;
  state.countryRequestId += 1;
  state.currentCountry = code;
  closeCountryMenu();
  hideScanProgress();
  const result = state.scanResults.get(code);
  const cachedStreams = playableStreams(code, result);
  const needsScan = scanner.needsScan(code);
  applyCountryStreams(code, cachedStreams, { scanning: needsScan });

  let scan;
  if (needsScan && background) {
    scan = scanner.request(code, { priority: PRIORITY_ACTIVE_BACKGROUND });
  } else if (needsScan) {
    scanner.focus(code, { defer: true });
    scan = scanner.request(code, { priority: PRIORITY_FOREGROUND });
  } else if (!background) {
    scanner.focus(null);
  }
  scan?.catch(console.error);
  queueBackgroundScans();
  return scan;
}

function loadEverywhere() {
  state.countryRequestId += 1;
  state.currentCountry = EVERYWHERE;
  closeCountryMenu();
  state.visible = everywhereStreams();
  scanner.focus(null, { defer: true });

  for (const country of state.catalogCountries) {
    if (scanner.needsScan(country.code)) {
      scanner.request(country.code, { priority: PRIORITY_FOREGROUND, defer: true }).catch(console.error);
    }
  }
  scanner.rebalance();
  const scanning = everywhereIsScanning();
  renderList('', { scanning });
  if (scanning) showEverywhereProgress(); else hideScanProgress();
  queueBackgroundScans();
}

function selectCountry(name) {
  state.searchQuery = '';
  el.search.value = '';
  el.country.value = name === EVERYWHERE ? 'Everywhere' : name;
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
  scanner.setBackgroundEnabled(true);
  const countries = state.catalogCountries
    .filter(country => (state.candidatesByCountry.get(country.code)?.length || 0) > 0 && scanner.needsScan(country.code))
    .sort((a, b) => backgroundQueueRank(a) - backgroundQueueRank(b));
  for (const country of countries) {
    const priority = country.code === state.active?.country ? PRIORITY_ACTIVE_BACKGROUND : PRIORITY_BACKGROUND;
    scanner.request(country.code, { priority }).catch(console.error);
  }
}

function showBrowse() {
  document.body.classList.replace('watch-mode', 'browse-mode');
  if (state.currentCountry === EVERYWHERE) {
    scanner.promoteAll();
    if (everywhereIsScanning()) showEverywhereProgress();
  } else if (state.currentCountry) {
    if (scanner.needsScan(state.currentCountry)) {
      scanner.focus(state.currentCountry, { defer: true });
      scanner.request(state.currentCountry, { priority: PRIORITY_FOREGROUND }).catch(console.error);
    } else {
      scanner.focus(null);
    }
  }
  queueBackgroundScans();
  closeCountryMenu();
}

function showWatch() {
  document.body.classList.replace('browse-mode', 'watch-mode');
  scanner.demoteAll(state.active?.country);
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
  stopPlayback({ clearUrl: true });
  showBrowse();
  renderList('That channel became unavailable and was removed.');
}

function play(item, { updateUrl = true } = {}) {
  if (!item) return;
  state.active = item;
  state.playbackBusy = true;
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
  renderList('', { scanning: state.currentCountry === EVERYWHERE ? everywhereIsScanning() : scanner.jobs.has(state.currentCountry) });
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

function resumeBackgroundScanning() {
  state.playbackBusy = false;
  if (state.active) scanner.markPlayable(state.active);
  queueBackgroundScans();
}

for (const eventName of ['playing', 'canplay', 'seeked']) {
  el.video.addEventListener(eventName, resumeBackgroundScanning);
}

// Some browsers can recover from a stalled network request using buffered
// media without emitting another playing event. Resume quiet scanning once
// the video is visibly advancing with enough data to keep playing.
el.video.addEventListener('timeupdate', () => {
  if (state.playbackBusy && !el.video.paused && !el.video.seeking
    && el.video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) {
    resumeBackgroundScanning();
  }
});

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
