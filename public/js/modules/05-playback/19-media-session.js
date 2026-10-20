// Windows routes the keyboard media keys through Chromium's media session, and the
// play/pause key works without any code because toggling the audible element is Chromium's
// own default. Previous/next are different: they are only delivered to a page that has
// registered previoustrack/nexttrack action handlers, so without this module the keys land
// nowhere and the taskbar tile shows a nameless session.
var mediaSessionSignature = '';
var mediaSessionActionsBound = false;

function getMediaSessionApi() {
  if (typeof navigator === 'undefined' || !navigator.mediaSession) return null;
  return navigator.mediaSession;
}

function mediaSessionTitleOf(song) {
  return String((song && (song.name || song.title)) || '未命名歌曲');
}

function mediaSessionArtistOf(song) {
  if (typeof currentArtistNames === 'function') {
    var names = currentArtistNames(song || {});
    if (names.length) return names.join(' / ');
  }
  return String((song && song.artist) || '').trim() || '未知歌手';
}

function mediaSessionArtImagesOf(song) {
  var images = [];
  if (typeof songCoverSrc !== 'function') return images;
  [96, 256, 512].forEach(function (size) {
    var src = '';
    try { src = String(songCoverSrc(song, size) || ''); } catch (e) { src = ''; }
    if (!src || /^(blob|data):/i.test(src)) return;
    try {
      images.push({ src: new URL(src, location.href).href, sizes: size + 'x' + size, type: 'image/jpeg' });
    } catch (e) { }
  });
  return images;
}

function mediaSessionIsPlaying() {
  return !!(typeof playing !== 'undefined' && playing && typeof audio !== 'undefined' && audio && !audio.paused);
}

function mediaSessionDurationOf(song) {
  var sec = 0;
  if (typeof playbackDurationFromSong === 'function') sec = Number(playbackDurationFromSong(song)) || 0;
  if (!sec && typeof audio !== 'undefined' && audio && isFinite(audio.duration) && audio.duration > 0) sec = audio.duration;
  return sec;
}

function mediaSessionSeekTo(details) {
  if (typeof audio === 'undefined' || !audio) return;
  var seconds = Number(details && details.seekTime);
  if (!isFinite(seconds)) return;
  var duration = Number(audio.duration);
  var limit = isFinite(duration) && duration > 0 ? duration : seconds;
  audio.currentTime = Math.max(0, Math.min(seconds, limit));
}

function bindMediaSessionActions(session) {
  if (mediaSessionActionsBound) return;
  mediaSessionActionsBound = true;
  try {
    session.setActionHandler('play', function () { if (!mediaSessionIsPlaying()) togglePlay(); });
    session.setActionHandler('pause', function () { if (mediaSessionIsPlaying()) togglePlay(); });
    session.setActionHandler('stop', function () { if (mediaSessionIsPlaying()) togglePlay(); });
    session.setActionHandler('previoustrack', function () { prevTrack(true); });
    session.setActionHandler('nexttrack', function () { nextTrack(true); });
    session.setActionHandler('seekto', mediaSessionSeekTo);
  } catch (e) {
    mediaSessionActionsBound = false;
  }
}

function writeMediaSessionPosition(session, duration) {
  if (typeof session.setPositionState !== 'function' || typeof MediaPositionState !== 'function') return;
  if (!duration) return;
  try {
    session.setPositionState(new MediaPositionState({
      duration: duration,
      position: audio && isFinite(audio.currentTime) ? audio.currentTime : 0,
      playbackRate: audio && audio.playbackRate ? audio.playbackRate : 1
    }));
  } catch (e) { }
}

function syncMediaSession() {
  var session = getMediaSessionApi();
  if (!session) return;
  bindMediaSessionActions(session);
  var song = typeof currentCoverSong === 'function' ? currentCoverSong() : null;
  if (!song) return;
  var isPlaying = mediaSessionIsPlaying();
  var duration = mediaSessionDurationOf(song);
  var signature = [
    String((song.id || song.mid || song.hash || song.localPath) || ''),
    mediaSessionTitleOf(song),
    mediaSessionArtistOf(song),
    String(Math.round(duration)),
    isPlaying ? '1' : '0'
  ].join('|');
  if (signature === mediaSessionSignature) return;
  mediaSessionSignature = signature;
  try {
    if (typeof MediaMetadata === 'function') {
      session.metadata = new MediaMetadata({
        title: mediaSessionTitleOf(song),
        artist: mediaSessionArtistOf(song),
        album: String(song.album || ''),
        artwork: mediaSessionArtImagesOf(song)
      });
    }
    session.playbackState = isPlaying ? 'playing' : 'paused';
    writeMediaSessionPosition(session, duration);
  } catch (e) { }
}
