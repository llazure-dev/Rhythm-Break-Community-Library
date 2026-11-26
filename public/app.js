'use strict';

const state = { filter: 'all', query: '', page: 1, hasMore: false, packs: [], selectedId: null, loading: false };
const $ = selector => document.querySelector(selector);
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const initials = value => String(value || 'RB').trim().split(/\s+/).slice(0, 2).map(part => part[0] || '').join('').toUpperCase() || 'RB';
const bytesLabel = bytes => {
  if (!Number.isFinite(Number(bytes))) return '';
  const units = ['B', 'KB', 'MB', 'GB']; let size = Number(bytes), index = 0;
  while (size >= 1024 && index < units.length - 1) { size /= 1024; index++; }
  return `${size >= 10 || index === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[index]}`;
};
const dateLabel = value => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'COMMUNITY SHARE';
  return new Intl.DateTimeFormat(undefined, { day: '2-digit', month: 'short', year: 'numeric' }).format(date).toUpperCase();
};
const trackCountLabel = count => `${count} ${count === 1 ? 'TRACK' : 'TRACKS'}`;

function coverMarkup(pack, className = 'row-cover') {
  if (pack.cover?.url) return `<img class="${className}" src="${escapeHtml(pack.cover.url)}" alt="${escapeHtml(pack.title)} cover" loading="lazy">`;
  const fallbackClass = className === 'detail-cover' ? 'detail-cover detail-cover-fallback' : 'row-cover-fallback';
  return `<span class="${fallbackClass}">${escapeHtml(initials(pack.title))}</span>`;
}
function setStats(stats = {}) {
  $('#stat-packs').textContent = Number(stats.uploads || 0).toLocaleString();
  $('#stat-tracks').textContent = Number(stats.tracks || 0).toLocaleString();
  $('#stat-downloads').textContent = Number(stats.downloads || 0).toLocaleString();
}
function showError(message) {
  $('#track-list').innerHTML = `<div class="error-state"><span class="empty-symbol">!</span><b>COULD NOT LOAD THE LIBRARY</b><small>${escapeHtml(message || 'Check your connection and try again.')}</small><button class="load-more" type="button" id="retry-load">TRY AGAIN</button></div>`;
  $('#retry-load')?.addEventListener('click', () => loadPacks(true));
}
function renderList() {
  const list = $('#track-list');
  const packs = state.packs;
  $('#results-count').textContent = `${packs.length.toLocaleString()} SHOWN`;
  $('#results-label').textContent = state.query ? 'SEARCH RESULTS' : state.filter === 'playlist' ? 'COMMUNITY PLAYLISTS' : state.filter === 'song' ? 'COMMUNITY TRACKS' : 'LATEST SHARES';
  if (!packs.length) {
    list.innerHTML = `<div class="empty-results"><span class="empty-symbol">♫</span><b>NOTHING HERE YET</b><small>${state.query ? 'No music matches that search.' : 'Be the first to publish a RhythmBreak pack.'}</small></div>`;
  } else {
    list.innerHTML = packs.map(pack => {
      const selected = pack.id === state.selectedId;
      const isPlaylist = pack.type === 'playlist';
      const mainCreator = isPlaylist ? `${pack.trackCount} tracks in this playlist` : (pack.tracks?.[0]?.creator || 'Unknown creator');
      return `<button class="track-row${selected ? ' selected' : ''}" type="button" data-pack-id="${escapeHtml(pack.id)}" aria-pressed="${selected}">
        <span class="row-cover-wrap">${coverMarkup(pack)}${isPlaylist ? `<span class="row-cover-count">${Number(pack.trackCount) || 0}♫</span>` : ''}</span>
        <span class="row-copy">
          <span class="row-kicker"><strong>${isPlaylist ? 'PLAYLIST' : 'TRACK'}</strong><span>·</span><span>${escapeHtml(dateLabel(pack.createdAt))}</span></span>
          <span class="row-title">${escapeHtml(pack.title)}</span>
          <span class="row-artist">${escapeHtml(mainCreator)}</span>
          <span class="row-meta"><span>${escapeHtml(trackCountLabel(pack.trackCount))}</span><span>${Number(pack.downloads || 0).toLocaleString()} DOWNLOADS</span></span>
        </span>
        <span class="row-publisher">PUBLISHED BY<b>${escapeHtml(pack.publisher)}</b></span>
      </button>`;
    }).join('');
  }
  $('#load-more').hidden = !state.hasMore;
  $('#load-more').disabled = state.loading;
}

function renderDetails() {
  const panel = $('#details-panel');
  const pack = state.packs.find(item => item.id === state.selectedId);
  if (!pack) {
    panel.classList.remove('has-selection');
    panel.innerHTML = `<div class="details-empty"><div class="empty-glyph">RB<span>♫</span></div><small>COMMUNITY LIBRARY</small><h2>Choose a track<br>to explore</h2><p>Select a song or playlist from the library to see its artwork, details and download.</p></div>`;
    return;
  }
  panel.classList.add('has-selection');
  const isPlaylist = pack.type === 'playlist';
  let banner = '';
  if (pack.banner?.kind === 'video') {
    banner = `<video src="${escapeHtml(pack.banner.url)}" autoplay muted loop playsinline></video>`;
  } else if (pack.banner?.url) {
    banner = `<img src="${escapeHtml(pack.banner.url)}" alt="${escapeHtml(pack.title)} banner">`;
  } else if (pack.cover?.url) {
    banner = `<img src="${escapeHtml(pack.cover.url)}" alt="${escapeHtml(pack.title)} artwork">`;
  }
  const trackRows = (pack.tracks || []).map((track, index) => `<div class="detail-track">
    <span class="detail-track-num">${String(index + 1).padStart(2, '0')}</span>
    <span class="detail-track-copy"><b>${escapeHtml(track.name)}</b><small>${escapeHtml(track.creator)}</small></span>
    <span class="detail-track-meta">${track.bpm ? `${Number(track.bpm)} BPM · ` : ''}${escapeHtml(track.difficulty || '')}</span>
  </div>`).join('');
  panel.innerHTML = `<div class="detail-content">
    <div class="detail-banner">${banner}<span class="banner-tag">${isPlaylist ? 'COMMUNITY PLAYLIST' : 'COMMUNITY TRACK'}</span></div>
    ${coverMarkup(pack, 'detail-cover')}
    <p class="detail-type"><span>${isPlaylist ? 'PLAYLIST' : 'SINGLE TRACK'}</span><i></i><span>${escapeHtml(dateLabel(pack.createdAt))}</span></p>
    <h2 class="detail-title">${escapeHtml(pack.title)}</h2>
    <p class="detail-creator">${isPlaylist ? `${pack.trackCount} tracks` : `by ${pack.tracks?.[0]?.creator || 'Unknown creator'}`}</p>
    <div class="detail-publisher"><span>PUBLISHED BY</span><b>${escapeHtml(pack.publisher)}</b></div>
    <div class="detail-track-heading"><span>${isPlaylist ? 'PLAYLIST CONTENTS' : 'TRACK INFORMATION'}</span><span class="detail-track-count">${escapeHtml(trackCountLabel(pack.trackCount))}</span></div>
    <div class="detail-tracks">${trackRows}</div>
    <a class="detail-download" href="/api/packs/${encodeURIComponent(pack.id)}/download"><span>↓</span> DOWNLOAD .RBPACK</a>
  </div>`;
}

async function loadPacks(reset = false) {
  if (state.loading) return;
  if (reset) { state.page = 1; state.packs = []; state.hasMore = false; }
  state.loading = true;
  $('#load-more').disabled = true;
  if (!state.packs.length) $('#track-list').innerHTML = `<div class="loading-state"><span class="loading-ring"></span><b>CONNECTING TO THE COMMUNITY</b><small>Loading shared music…</small></div>`;
  try {
    const params = new URLSearchParams({ page: String(state.page), limit: '24', type: state.filter });
    if (state.query) params.set('q', state.query);
    const response = await fetch(`/api/packs?${params}`, { headers: { Accept: 'application/json' } });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'The library is unavailable.');
    if (reset) state.packs = data.packs || [];
    else state.packs.push(...(data.packs || []));
    state.hasMore = !!data.hasMore;
    if (state.selectedId && !state.packs.some(item => item.id === state.selectedId)) state.selectedId = null;
    if (!state.selectedId && state.packs.length) state.selectedId = state.packs[0].id;
    setStats(data.stats);
    renderList(); renderDetails();
  } catch (error) {
    if (!state.packs.length) showError(error.message);
    else toast(error.message);
  } finally {
    state.loading = false;
    $('#load-more').disabled = false;
  }
}

function choosePack(id) {
  state.selectedId = id;
  renderList(); renderDetails();
  if (window.matchMedia('(max-width: 720px)').matches) {
    $('#details-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function toast(message) {
  const element = $('#toast');
  element.textContent = message;
  element.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.remove('show'), 2800);
}
function openUpload() {
  $('#upload-modal').hidden = false;
  document.body.style.overflow = 'hidden';
  setTimeout(() => $('#publisher-input').focus(), 80);
}
function closeUpload() {
  if (!$('#submit-publish').disabled) {
    $('#upload-modal').hidden = true;
    document.body.style.overflow = '';
  }
}
function resetUploadForm() {
  $('#upload-form').reset();
  $('#file-drop').classList.remove('has-file');
  $('#file-drop-title').textContent = 'Choose your .rbpack file';
  $('#file-drop-subtitle').textContent = 'Click to browse your device';
  $('#form-error').hidden = true;
  $('#upload-progress').hidden = true;
  $('#progress-bar').style.width = '0%';
  $('#submit-publish').disabled = false;
  $('#submit-publish').innerHTML = 'PUBLISH TO THE LIBRARY <span>↗</span>';
}

$('#open-upload').addEventListener('click', openUpload);
$('#close-upload').addEventListener('click', closeUpload);
$('#upload-modal').addEventListener('click', event => { if (event.target === $('#upload-modal')) closeUpload(); });
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !$('#upload-modal').hidden) closeUpload();
  if (event.key === '/' && !['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName) && $('#upload-modal').hidden) {
    event.preventDefault(); $('#search-input').focus();
  }
});

$('#track-list').addEventListener('click', event => {
  const row = event.target.closest('[data-pack-id]');
  if (row) choosePack(row.dataset.packId);
});
$('#load-more').addEventListener('click', () => { if (state.hasMore && !state.loading) { state.page++; loadPacks(false); } });
$('#refresh-button').addEventListener('click', () => loadPacks(true));
document.querySelectorAll('[data-filter]').forEach(button => button.addEventListener('click', () => {
  if (state.filter === button.dataset.filter) return;
  state.filter = button.dataset.filter;
  document.querySelectorAll('[data-filter]').forEach(tab => {
    const active = tab === button;
    tab.classList.toggle('active', active); tab.setAttribute('aria-selected', String(active));
  });
  state.selectedId = null; loadPacks(true);
}));
let searchTimer;
$('#search-input').addEventListener('input', event => {
  clearTimeout(searchTimer);
  state.query = event.target.value.trim();
  searchTimer = setTimeout(() => { state.selectedId = null; loadPacks(true); }, 260);
});

$('#pack-input').addEventListener('change', event => {
  const file = event.target.files?.[0];
  if (!file) return;
  $('#file-drop').classList.add('has-file');
  $('#file-drop-title').textContent = file.name;
  $('#file-drop-subtitle').textContent = `${bytesLabel(file.size)} · metadata will be detected automatically`;
  $('#form-error').hidden = true;
});

$('#upload-form').addEventListener('submit', event => {
  event.preventDefault();
  const form = event.currentTarget;
  const file = $('#pack-input').files?.[0];
  const publisher = $('#publisher-input').value.trim();
  const errorBox = $('#form-error');
  errorBox.hidden = true;
  if (!publisher || publisher.length < 2) { errorBox.textContent = 'Enter a publisher name with at least 2 characters.'; errorBox.hidden = false; return; }
  if (!file || !/\.rbpack$/i.test(file.name)) { errorBox.textContent = 'Choose a valid .rbpack file.'; errorBox.hidden = false; return; }
  const formData = new FormData();
  formData.append('publisher', publisher);
  formData.append('pack', file, file.name);
  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/packs');
  xhr.responseType = 'json';
  $('#submit-publish').disabled = true;
  $('#submit-publish').textContent = 'PUBLISHING…';
  $('#upload-progress').hidden = false;
  $('#progress-message').textContent = 'UPLOADING AND READING PACK';
  $('#progress-percent').textContent = '0%';
  xhr.upload.addEventListener('progress', progress => {
    if (!progress.lengthComputable) return;
    const percent = Math.round(progress.loaded / progress.total * 100);
    $('#progress-percent').textContent = `${percent}%`;
    $('#progress-bar').style.width = `${percent}%`;
    if (percent === 100) $('#progress-message').textContent = 'VERIFYING SONGS AND ARTWORK';
  });
  xhr.addEventListener('load', async () => {
    const response = xhr.response || {};
    if (xhr.status < 200 || xhr.status >= 300) {
      errorBox.textContent = response.error || 'The pack could not be published.';
      errorBox.hidden = false;
      $('#submit-publish').disabled = false;
      $('#submit-publish').innerHTML = 'PUBLISH TO THE LIBRARY <span>↗</span>';
      $('#upload-progress').hidden = true;
      return;
    }
    $('#progress-percent').textContent = '100%';
    $('#progress-bar').style.width = '100%';
    $('#progress-message').textContent = 'PUBLISHED SUCCESSFULLY';
    state.filter = 'all'; state.query = ''; state.page = 1; state.selectedId = response.pack?.id || null;
    $('#search-input').value = '';
    document.querySelectorAll('[data-filter]').forEach(tab => {
      const active = tab.dataset.filter === 'all'; tab.classList.toggle('active', active); tab.setAttribute('aria-selected', String(active));
    });
    await loadPacks(true);
    if (response.pack?.id) choosePack(response.pack.id);
    setTimeout(() => {
      $('#upload-modal').hidden = true; document.body.style.overflow = ''; resetUploadForm();
      toast(response.message || 'Music published to the community library.');
    }, 450);
  });
  xhr.addEventListener('error', () => {
    errorBox.textContent = 'Network error. Check your connection and try again.';
    errorBox.hidden = false;
    $('#submit-publish').disabled = false;
    $('#submit-publish').innerHTML = 'PUBLISH TO THE LIBRARY <span>↗</span>';
    $('#upload-progress').hidden = true;
  });
  xhr.send(formData);
});

loadPacks(true);
