'use strict';

const fs = require('fs');
const path = require('path');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const API_ROOT = 'https://api.bilibili.com';
const MUSIC_FOLDER_RE = /(音乐|音樂|music|歌曲|歌单|歌單|听歌|聽歌|曲库|曲庫|原声|原聲|ost|soundtrack)/i;

function cookieFile() {
  return process.env.BILIBILI_COOKIE_FILE || path.join(__dirname, '.bilibili-cookie');
}

function configFile() {
  return process.env.BILIBILI_CONFIG_FILE || path.join(__dirname, '.bilibili-config.json');
}

function readText(file) {
  try { return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').trim(); } catch (_) { return ''; }
}

function writeText(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, String(value || ''), 'utf8');
}

function getBilibiliCookie() {
  return readText(cookieFile());
}

function setBilibiliCookie(cookie) {
  const value = String(cookie || '').trim();
  if (!value) return false;
  writeText(cookieFile(), value);
  return true;
}

function clearBilibiliCookie() {
  try { fs.unlinkSync(cookieFile()); } catch (_) {}
  return { ok: true };
}

function cookieValue(cookie, name) {
  const found = String(cookie || '').match(new RegExp('(?:^|;\\s*)' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '=([^;]*)', 'i'));
  if (!found) return '';
  try { return decodeURIComponent(found[1] || ''); } catch (_) { return found[1] || ''; }
}

function bilibiliCookieHasLogin(cookie) {
  return !!(cookieValue(cookie, 'SESSDATA') && cookieValue(cookie, 'DedeUserID'));
}

function headers(cookie, referer) {
  const out = {
    'User-Agent': UA,
    'Referer': referer || 'https://www.bilibili.com/',
    'Origin': 'https://www.bilibili.com',
    'Accept': 'application/json, text/plain, */*',
  };
  if (cookie) out.Cookie = cookie;
  return out;
}

async function requestJSON(target, options) {
  options = options || {};
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || 12000);
  try {
    const response = await fetch(target, {
      method: options.method || 'GET',
      headers: Object.assign(headers(options.cookie, options.referer), options.headers || {}),
      body: options.body,
      signal: controller.signal,
    });
    const text = await response.text();
    let body;
    try { body = JSON.parse(text); } catch (_) { throw new Error('BILIBILI_INVALID_RESPONSE'); }
    if (!response.ok) throw new Error('BILIBILI_HTTP_' + response.status);
    if (Number(body && body.code) !== 0) {
      const error = new Error((body && (body.message || body.msg)) || ('BILIBILI_CODE_' + body.code));
      error.code = Number(body && body.code);
      throw error;
    }
    return body.data;
  } finally {
    clearTimeout(timer);
  }
}

function readConfig() {
  try {
    const parsed = JSON.parse(readText(configFile()) || '{}');
    return {
      manualFolders: Array.isArray(parsed.manualFolders)
        ? parsed.manualFolders.map(item => String(item || '').trim()).filter(Boolean).slice(0, 50)
        : [],
      autoMusicOnly: parsed.autoMusicOnly !== false,
    };
  } catch (_) {
    return { manualFolders: [], autoMusicOnly: true };
  }
}

function saveConfig(config) {
  const normalized = {
    manualFolders: Array.from(new Set((config.manualFolders || []).map(item => String(item || '').trim()).filter(Boolean))).slice(0, 50),
    autoMusicOnly: config.autoMusicOnly !== false,
  };
  writeText(configFile(), JSON.stringify(normalized, null, 2));
  return normalized;
}

function normalizeImage(url) {
  const value = String(url || '');
  return value.startsWith('//') ? 'https:' + value : value;
}

function stripHtml(value) {
  return String(value || '').replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').trim();
}

function cleanVideoTitle(title) {
  return stripHtml(title)
    .replace(/^\s*【[^】]{1,24}】\s*/g, '')
    .replace(/\s*[_\-—|｜]\s*(?:哔哩哔哩|bilibili)\s*$/i, '')
    .trim();
}

async function handleBilibiliStatus(cookie) {
  cookie = String(cookie || getBilibiliCookie());
  if (!bilibiliCookieHasLogin(cookie)) {
    return { provider: 'bilibili', loggedIn: false, nickname: '哔哩哔哩', userId: '', avatar: '', capabilities: { playlists: false, playableUrl: true } };
  }
  try {
    const nav = await requestJSON(API_ROOT + '/x/web-interface/nav', { cookie });
    return {
      provider: 'bilibili',
      loggedIn: !!nav.isLogin,
      nickname: nav.uname || '哔哩哔哩用户',
      userId: String(nav.mid || cookieValue(cookie, 'DedeUserID') || ''),
      avatar: normalizeImage(nav.face),
      vipType: Number(nav.vipType || nav.vipStatus || 0) || 0,
      vipLevel: nav.vipStatus ? 'vip' : 'none',
      isVip: !!nav.vipStatus,
      isSvip: false,
      playbackKeyReady: true,
      capabilities: { playlists: true, playableUrl: true, manualFolders: true },
    };
  } catch (error) {
    return {
      provider: 'bilibili',
      loggedIn: false,
      stale: true,
      nickname: '哔哩哔哩',
      userId: cookieValue(cookie, 'DedeUserID'),
      avatar: '',
      error: error.message,
      capabilities: { playlists: false, playableUrl: true },
    };
  }
}

function mapFolder(folder, source) {
  folder = folder || {};
  const mediaId = folder.id || folder.media_id || folder.fid;
  return {
    provider: 'bilibili',
    source: 'bilibili',
    id: String(mediaId || ''),
    name: stripHtml(folder.title || folder.name || ('收藏夹 ' + mediaId)),
    cover: normalizeImage(folder.cover || folder.pic || ''),
    trackCount: Number(folder.media_count || folder.count || folder.mediaCount || 0) || 0,
    creator: '哔哩哔哩',
    subscribed: true,
    manual: source === 'manual',
    automatic: source === 'auto',
  };
}

async function fetchFolderInfo(id, cookie) {
  const data = await requestJSON(API_ROOT + '/x/v3/fav/folder/info?media_id=' + encodeURIComponent(id), { cookie });
  return mapFolder(data, 'manual');
}

async function handleBilibiliUserPlaylists(cookie) {
  cookie = String(cookie || getBilibiliCookie());
  const status = await handleBilibiliStatus(cookie);
  if (!status.loggedIn || !status.userId) return { provider: 'bilibili', loggedIn: false, playlists: [] };
  const config = readConfig();
  const created = await requestJSON(API_ROOT + '/x/v3/fav/folder/created/list-all?up_mid=' + encodeURIComponent(status.userId), { cookie });
  const folders = Array.isArray(created && created.list) ? created.list : [];
  const selected = config.autoMusicOnly ? folders.filter(folder => MUSIC_FOLDER_RE.test(String(folder.title || ''))) : folders;
  const autoRows = selected.map(folder => mapFolder(folder, 'auto'));
  const seen = new Set(autoRows.map(row => row.id));
  const manualRows = [];
  for (const id of config.manualFolders) {
    if (seen.has(String(id))) continue;
    try {
      const row = await fetchFolderInfo(id, cookie);
      if (row.id) {
        seen.add(row.id);
        manualRows.push(row);
      }
    } catch (_) {}
  }
  return {
    provider: 'bilibili',
    loggedIn: true,
    userId: status.userId,
    playlists: autoRows.concat(manualRows),
    total: autoRows.length + manualRows.length,
    hasMore: false,
    autoMusicOnly: config.autoMusicOnly,
    manualFolders: config.manualFolders,
  };
}

function mapFavoriteResource(item, folderId) {
  item = item || {};
  const upper = item.upper || item.owner || {};
  const bvid = String(item.bvid || item.bv_id || '');
  const aid = String(item.id || item.aid || '');
  return {
    provider: 'bilibili',
    source: 'bilibili',
    type: 'bilibili',
    id: bvid || aid,
    providerSongId: bvid || aid,
    bvid,
    aid,
    cid: String(item.cid || ''),
    name: cleanVideoTitle(item.title || item.name || ''),
    artist: stripHtml(upper.name || item.author || '哔哩哔哩 UP主'),
    artistId: String(upper.mid || ''),
    album: '哔哩哔哩收藏夹',
    albumId: String(folderId || ''),
    cover: normalizeImage(item.cover || item.pic || ''),
    picUrl: normalizeImage(item.cover || item.pic || ''),
    duration: Number(item.duration || 0) * 1000,
    playable: Number(item.attr || 0) !== 9,
    page: 1,
    bType: Number(item.type || 2),
    videoUrl: bvid ? ('https://www.bilibili.com/video/' + bvid) : '',
  };
}

async function handleBilibiliPlaylistTracks(id, options, cookie) {
  options = options || {};
  cookie = String(cookie || getBilibiliCookie());
  const pn = Math.max(1, Math.floor((Math.max(0, Number(options.offset) || 0) / Math.max(1, Number(options.limit) || 20)) + 1));
  const ps = Math.max(1, Math.min(40, Number(options.limit) || 20));
  const target = API_ROOT + '/x/v3/fav/resource/list?media_id=' + encodeURIComponent(id) +
    '&pn=' + pn + '&ps=' + ps + '&keyword=&order=mtime&type=0&tid=0&platform=web';
  const data = await requestJSON(target, { cookie });
  const medias = Array.isArray(data && data.medias) ? data.medias : [];
  const tracks = medias.filter(item => Number(item.type || 2) === 2).map(item => mapFavoriteResource(item, id));
  const total = Number(data && data.info && data.info.media_count) || tracks.length;
  const offset = Math.max(0, Number(options.offset) || 0);
  return {
    provider: 'bilibili',
    playlist: mapFolder(data && data.info || { id }, 'auto'),
    tracks,
    total,
    offset,
    nextOffset: offset + medias.length,
    hasMore: !!(data && data.has_more) || (medias.length === ps && offset + medias.length < total),
  };
}

async function resolveVideoIdentity(song, cookie) {
  song = song || {};
  const query = song.bvid
    ? 'bvid=' + encodeURIComponent(song.bvid)
    : 'aid=' + encodeURIComponent(song.aid || song.id || song.providerSongId || '');
  const view = await requestJSON(API_ROOT + '/x/web-interface/view?' + query, {
    cookie,
    referer: song.bvid ? ('https://www.bilibili.com/video/' + song.bvid) : 'https://www.bilibili.com/',
  });
  const requestedCid = String(song.cid || '');
  const pages = Array.isArray(view.pages) ? view.pages : [];
  const page = pages.find(item => String(item.cid) === requestedCid) || pages[Math.max(0, Number(song.page || 1) - 1)] || pages[0] || {};
  return {
    bvid: String(view.bvid || song.bvid || ''),
    aid: String(view.aid || song.aid || ''),
    cid: String(page.cid || view.cid || song.cid || ''),
    page: Number(page.page || song.page || 1) || 1,
    title: cleanVideoTitle(view.title || song.name || ''),
    part: stripHtml(page.part || ''),
    owner: view.owner || {},
    cover: normalizeImage(view.pic || song.cover || ''),
    duration: Number(page.duration || view.duration || 0),
  };
}

async function handleBilibiliSongUrl(song, cookie) {
  cookie = String(cookie || getBilibiliCookie());
  const identity = await resolveVideoIdentity(song, cookie);
  if (!identity.bvid || !identity.cid) throw new Error('BILIBILI_VIDEO_IDENTITY_MISSING');
  const target = API_ROOT + '/x/player/playurl?bvid=' + encodeURIComponent(identity.bvid) +
    '&cid=' + encodeURIComponent(identity.cid) + '&qn=80&fnver=0&fnval=16&fourk=1';
  const data = await requestJSON(target, {
    cookie,
    referer: 'https://www.bilibili.com/video/' + identity.bvid,
  });
  let streams = [];
  if (data && data.dash) {
    if (Array.isArray(data.dash.audio)) streams = streams.concat(data.dash.audio);
    if (!streams.length && data.dash.flac && data.dash.flac.audio) streams.push(data.dash.flac.audio);
    if (!streams.length && data.dash.dolby && Array.isArray(data.dash.dolby.audio)) streams = streams.concat(data.dash.dolby.audio);
  }
  streams = streams.filter(Boolean).sort((a, b) => {
    const aCompatible = /mp4a|aac/i.test(String(a.codecs || '')) ? 1 : 0;
    const bCompatible = /mp4a|aac/i.test(String(b.codecs || '')) ? 1 : 0;
    if (aCompatible !== bCompatible) return bCompatible - aCompatible;
    return Number(b.bandwidth || b.id || 0) - Number(a.bandwidth || a.id || 0);
  });
  const chosen = String(song.quality || '').toLowerCase() === 'standard'
    ? streams.slice().sort((a, b) => Number(a.bandwidth || a.id || 0) - Number(b.bandwidth || b.id || 0))[0]
    : streams[0];
  const audioUrl = chosen && (chosen.baseUrl || chosen.base_url);
  if (!audioUrl) throw new Error('BILIBILI_AUDIO_STREAM_UNAVAILABLE');
  return {
    provider: 'bilibili',
    source: 'bilibili',
    playable: true,
    url: audioUrl,
    backupUrls: chosen.backupUrl || chosen.backup_url || [],
    level: chosen.id >= 30280 ? 'hires' : (chosen.id >= 30232 ? 'exhigh' : 'standard'),
    format: chosen.mimeType || chosen.mime_type || 'audio/mp4',
    codec: chosen.codecs || '',
    bitrate: Number(chosen.bandwidth || 0) || 0,
    br: Number(chosen.bandwidth || 0) || 0,
    bvid: identity.bvid,
    cid: identity.cid,
    page: identity.page,
    title: identity.part && identity.part !== identity.title ? (identity.title + ' · ' + identity.part) : identity.title,
    artist: identity.owner.name || '',
    cover: identity.cover,
    duration: identity.duration * 1000,
  };
}

async function addBilibiliManualFolder(value, cookie) {
  const text = String(value || '').trim();
  const idMatch = text.match(/(?:media_id=|fid=|favlist\/)(\d{2,})/i) || text.match(/^\d{2,}$/);
  const id = idMatch ? String(idMatch[1] || idMatch[0]) : '';
  if (!id) throw new Error('请输入收藏夹 ID 或收藏夹链接');
  const folder = await fetchFolderInfo(id, cookie || getBilibiliCookie());
  const config = readConfig();
  config.manualFolders.unshift(id);
  saveConfig(config);
  return { provider: 'bilibili', ok: true, folder, manualFolders: readConfig().manualFolders };
}

function removeBilibiliManualFolder(value) {
  const id = String(value || '').trim();
  const config = readConfig();
  config.manualFolders = config.manualFolders.filter(item => item !== id);
  saveConfig(config);
  return { provider: 'bilibili', ok: true, manualFolders: readConfig().manualFolders };
}

module.exports = {
  getBilibiliCookie,
  setBilibiliCookie,
  clearBilibiliCookie,
  bilibiliCookieHasLogin,
  handleBilibiliStatus,
  handleBilibiliUserPlaylists,
  handleBilibiliPlaylistTracks,
  handleBilibiliSongUrl,
  addBilibiliManualFolder,
  removeBilibiliManualFolder,
};
