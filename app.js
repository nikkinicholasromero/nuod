const API = 'https://iptv-org.github.io/api';
const state = { all: [], visible: [], active: null, hls: null, countryCodes: new Map() };
const el = {
  video: document.querySelector('#video'), list: document.querySelector('#channelList'), status: document.querySelector('#status'),
  country: document.querySelector('#countryFilter'), countries: document.querySelector('#countries'),
  empty: document.querySelector('#playerEmpty'), error: document.querySelector('#playerError'),
  loading: document.querySelector('#loadingScreen'), loadingMessage: document.querySelector('#loadingMessage'),
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
function playableStream(stream, blockedChannels) {
  const label = (stream.label || '').toLocaleLowerCase();
  const restricted = /geo|block|restrict|vpn|location|country/.test(label);
  return stream.channel && typeof stream.url === 'string' && stream.url.startsWith('https://') && !stream.referrer && !stream.user_agent && !restricted && !blockedChannels.has(stream.channel);
}

function populateCountries(countries) {
  const usedCodes = new Set(state.all.map(item => item.country).filter(Boolean));
  countries.filter(country => usedCodes.has(country.code)).sort((a, b) => a.name.localeCompare(b.name)).forEach(country => {
    el.countries.append(new Option(country.name));
    state.countryCodes.set(country.name.toLocaleLowerCase(), country.code);
  });
}

function filter() {
  const typedCountry = el.country.value.trim().toLocaleLowerCase();
  const countryCode = state.countryCodes.get(typedCountry);
  state.visible = state.all.filter(item => countryCode ? item.country === countryCode : item.countryName?.toLocaleLowerCase().includes(typedCountry));
  renderList();
}

function renderList() {
  const limit = 150;
  const items = state.visible.slice(0, limit);
  el.status.hidden = state.visible.length > 0;
  el.status.textContent = state.visible.length ? '' : 'No channels found for this country.';
  el.list.innerHTML = items.map(item => `<button class="channel-card ${state.active?.key === item.key ? 'active' : ''}" data-key="${item.key}"><span class="card-logo">${logo(item)}</span><span class="card-info"><strong>${escapeHTML(item.name)}</strong><small>${escapeHTML(item.countryName || 'Global')}</small></span><span class="quality">${escapeHTML(item.quality || 'LIVE')}</span></button>`).join('');
  if (state.visible.length > limit) el.list.insertAdjacentHTML('beforeend', `<div class="status">Showing the first ${limit} channels.</div>`);
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

function play(item) {
  state.active = item;
  el.empty.hidden = true;
  el.error.hidden = true;
  renderList();
  showWatch();
  if (state.hls) { state.hls.destroy(); state.hls = null; }
  el.video.pause();
  el.video.removeAttribute('src');
  el.video.load();
  const fail = () => { el.error.hidden = false; };
  if (window.Hls?.isSupported() && /\.m3u8($|\?)/i.test(item.url)) {
    state.hls = new Hls({ enableWorker: true, lowLatencyMode: true });
    state.hls.loadSource(item.url);
    state.hls.attachMedia(el.video);
    state.hls.on(Hls.Events.ERROR, (_, data) => { if (data.fatal) fail(); });
  } else {
    el.video.src = item.url;
  }
  el.video.play().catch(() => {});
  el.video.onerror = fail;
}

async function init() {
  try {
    const data = await getData();
    el.loadingMessage.textContent = 'Filtering playable channels…';
    const channels = new Map(data['channels.json'].map(channel => [channel.id, channel]));
    const countries = new Map(data['countries.json'].map(country => [country.code, country]));
    const logos = new Map(data['logos.json'].filter(item => item.in_use !== false).map(item => [item.channel, item.url]));
    const blockedChannels = new Set(data['blocklist.json'].map(item => item.channel));
    const seen = new Set();
    state.all = data['streams.json'].filter(stream => playableStream(stream, blockedChannels) && !seen.has(`${stream.channel}|${stream.url}`) && seen.add(`${stream.channel}|${stream.url}`)).map((stream, key) => {
      const channel = channels.get(stream.channel) || {};
      const country = countries.get(channel.country);
      return { key, name: stream.title || channel.name || stream.channel, url: stream.url, quality: stream.quality, country: channel.country, countryName: country?.name, logo: logos.get(stream.channel) };
    }).sort((a, b) => a.name.localeCompare(b.name));
    populateCountries(data['countries.json']);
    filter();
    el.loading.hidden = true;
  } catch (error) {
    el.status.textContent = 'Could not load the channel list. Check your connection and refresh.';
    el.loadingMessage.textContent = 'Could not load channels. Check your connection and refresh.';
    console.error(error);
  }
}

el.country.addEventListener('input', filter);
el.list.addEventListener('click', event => {
  const card = event.target.closest('[data-key]');
  if (card) play(state.all.find(item => item.key === Number(card.dataset.key)));
});
el.browseNav.addEventListener('click', showBrowse);
el.watchNav.addEventListener('click', showWatch);
init();
