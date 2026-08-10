const API = 'https://iptv-org.github.io/api';
const state = { all: [], visible: [], active: null, hls: null };
const el = {
  video: document.querySelector('#video'), list: document.querySelector('#channelList'), status: document.querySelector('#status'),
  count: document.querySelector('#channelCount'), search: document.querySelector('#search'), country: document.querySelector('#countryFilter'),
  empty: document.querySelector('#playerEmpty'), error: document.querySelector('#playerError'),
  nowLogo: document.querySelector('#nowLogo'), now: document.querySelector('#nowPlaying'),
  watchNav: document.querySelector('#watchNav'), browseNav: document.querySelector('#browseNav')
};

async function getData() {
  const paths = ['channels.json', 'streams.json', 'logos.json', 'countries.json', 'categories.json'];
  const results = await Promise.all(paths.map(path => fetch(`${API}/${path}`).then(r => { if (!r.ok) throw new Error(path); return r.json(); })));
  return Object.fromEntries(paths.map((path, index) => [path, results[index]]));
}

function option(select, value, label) { const node = new Option(label, value); select.add(node); }
function makeInitials(name = 'TV') { return name.split(/\s+/).slice(0, 2).map(word => word[0]).join('').toUpperCase(); }
function logoHTML(item, className) { return item.logo ? `<img src="${item.logo}" alt="" loading="lazy" onerror="this.remove()">` : makeInitials(item.name); }
function esc(value = '') { const div = document.createElement('div'); div.textContent = value; return div.innerHTML; }

function populateFilters(countries) {
  const usedCountries = new Set(state.all.map(item => item.country).filter(Boolean));
  countries.filter(c => usedCountries.has(c.code)).sort((a,b) => a.name.localeCompare(b.name)).forEach(c => option(el.country, c.code, `${c.flag || ''} ${c.name}`.trim()));
}

function filter() {
  const query = el.search.value.trim().toLocaleLowerCase(); const country = el.country.value;
  state.visible = state.all.filter(item => (!query || `${item.name} ${item.countryName} ${item.categories.join(' ')}`.toLocaleLowerCase().includes(query)) && (!country || item.country === country));
  renderList();
}

function renderList() {
  const limit = 150; const items = state.visible.slice(0, limit);
  el.count.textContent = `${state.visible.length.toLocaleString()} channels`;
  el.status.hidden = state.visible.length > 0;
  el.status.textContent = state.visible.length ? '' : 'No channels match those filters.';
  el.list.innerHTML = items.map(item => `<button class="channel-card ${state.active?.key === item.key ? 'active' : ''}" data-key="${item.key}"><span class="card-logo">${logoHTML(item, 'card-logo')}</span><span class="card-info"><strong>${esc(item.name)}</strong><small>${esc(item.countryName || 'Global')} · ${esc(item.categories[0] || 'General')}</small></span><span class="quality">${esc(item.quality || 'LIVE')}</span></button>`).join('');
  if (state.visible.length > limit) el.list.insertAdjacentHTML('beforeend', `<div class="status">Showing the first ${limit}. Refine your search to narrow results.</div>`);
}

function setNowPlaying(item) {
  el.nowLogo.innerHTML = logoHTML(item); el.now.querySelector('h1').textContent = item.name;
  el.now.querySelector('.stream-meta').textContent = [item.countryName, item.quality || 'Live broadcast'].filter(Boolean).join(' · ');
}

function play(item) {
  state.active = item; el.empty.hidden = true; el.error.hidden = true; setNowPlaying(item); renderList();
  showWatch();
  if (state.hls) { state.hls.destroy(); state.hls = null; }
  el.video.pause(); el.video.removeAttribute('src'); el.video.load();
  const fail = () => { el.error.hidden = false; };
  if (window.Hls?.isSupported() && /\.m3u8($|\?)/i.test(item.url)) {
    state.hls = new Hls({ enableWorker: true, lowLatencyMode: true }); state.hls.loadSource(item.url); state.hls.attachMedia(el.video);
    state.hls.on(Hls.Events.ERROR, (_, data) => { if (data.fatal) fail(); });
  } else { el.video.src = item.url; }
  el.video.play().catch(() => {}); el.video.onerror = fail;
}

function showBrowse() {
  document.body.classList.remove('watch-mode');
  document.body.classList.add('browse-mode');
  el.browseNav.classList.add('active'); el.watchNav.classList.remove('active');
  setTimeout(() => el.search.focus(), 100);
}

function showWatch() {
  document.body.classList.remove('browse-mode');
  document.body.classList.add('watch-mode');
  el.watchNav.classList.add('active'); el.browseNav.classList.remove('active');
}

async function init() {
  try {
    const data = await getData();
    const channelById = new Map(data['channels.json'].map(channel => [channel.id, channel]));
    const countryByCode = new Map(data['countries.json'].map(country => [country.code, country]));
    const logoByChannel = new Map(data['logos.json'].filter(logo => logo.in_use !== false).map(logo => [logo.channel, logo.url]));
    const unique = new Set();
    state.all = data['streams.json'].filter(stream => stream.channel && stream.url && !unique.has(`${stream.channel}|${stream.url}`) && unique.add(`${stream.channel}|${stream.url}`)).map((stream, index) => {
      const channel = channelById.get(stream.channel) || {}; const country = countryByCode.get(channel.country);
      return { key:index, name:stream.title || channel.name || stream.channel, url:stream.url, quality:stream.quality, country:channel.country, countryName:country?.name, categories:channel.categories || [], website:channel.website, logo:logoByChannel.get(stream.channel) };
    }).sort((a,b) => a.name.localeCompare(b.name));
    populateFilters(data['countries.json']); filter();
  } catch (error) { el.status.textContent = 'Could not load the IPTV-org channel guide. Check your connection and refresh.'; el.count.textContent = 'Offline'; console.error(error); }
}
el.list.addEventListener('click', event => { const card = event.target.closest('[data-key]'); if (card) play(state.all.find(item => item.key === Number(card.dataset.key))); });
[el.search, el.country].forEach(input => input.addEventListener(input.tagName === 'INPUT' ? 'input' : 'change', filter));
el.browseNav.addEventListener('click', showBrowse);
el.watchNav.addEventListener('click', showWatch);
init();
