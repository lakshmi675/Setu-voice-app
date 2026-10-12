const LANG_NAMES = { en: 'English', hi: 'हिंदी · Hindi', kn: 'ಕನ್ನಡ · Kannada' };

// ---- Tabs -----------------------------------------------------------------
const tabs = document.querySelectorAll('.tab');
const panels = { speak: document.getElementById('panel-speak'), type: document.getElementById('panel-type') };

tabs.forEach(tab => {
  tab.addEventListener('click', () => {
    tabs.forEach(t => { t.classList.remove('active'); t.setAttribute('aria-selected', 'false'); });
    tab.classList.add('active');
    tab.setAttribute('aria-selected', 'true');
    Object.values(panels).forEach(p => p.hidden = true);
    panels[tab.dataset.tab].hidden = false;
  });
});

// ---- Source language picker (type mode) -----------------------------------
let selectedSourceLang = 'en';
const langPicker = document.getElementById('sourceLang');
langPicker.querySelectorAll('.lang-pill').forEach(btn => {
  btn.addEventListener('click', () => {
    langPicker.querySelectorAll('.lang-pill').forEach(b => { b.classList.remove('active'); b.setAttribute('aria-checked', 'false'); });
    btn.classList.add('active');
    btn.setAttribute('aria-checked', 'true');
    selectedSourceLang = btn.dataset.lang;
  });
});

// ---- Status helper ----------------------------------------------------------
const statusMsg = document.getElementById('statusMsg');
function setStatus(msg, isError = false) {
  statusMsg.textContent = msg || '';
  statusMsg.classList.toggle('error', isError);
}

// ---- Results rendering ------------------------------------------------------
const resultsEl = document.getElementById('results');
const sourceTag = document.getElementById('sourceTag');
const sourceText = document.getElementById('sourceText');
const outputTrack = document.getElementById('outputTrack');
const cardTemplate = document.getElementById('outputCardTemplate');

function renderResults(data, mode, fromHistory = false) {
  const prefix = mode === 'speak' ? 'Heard' : 'You typed';
  sourceTag.textContent = `${prefix} · ${LANG_NAMES[data.source.lang] || data.source.lang}`;
  sourceText.textContent = data.source.text;

  outputTrack.innerHTML = '';
  Object.entries(data.translations).forEach(([lang, payload]) => {
    const node = cardTemplate.content.cloneNode(true);
    const card = node.querySelector('.output-card');
    card.dataset.lang = lang;
    node.querySelector('.output-lang').textContent = LANG_NAMES[lang] || lang;
    const textEl = node.querySelector('.output-text');
    textEl.textContent = payload.text;

    const audioEl = node.querySelector('.output-audio');
    audioEl.src = `data:audio/wav;base64,${payload.audioBase64}`;

    const playBtn = node.querySelector('.play-btn');
    playBtn.addEventListener('click', () => {
      document.querySelectorAll('.output-audio').forEach(a => { if (a !== audioEl) a.pause(); });
      audioEl.currentTime = 0;
      audioEl.play();
    });

    const copyBtn = node.querySelector('.copy-btn');
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(payload.text);
        copyBtn.classList.add('copied');
        setTimeout(() => copyBtn.classList.remove('copied'), 1200);
      } catch {
        // Clipboard API unavailable — silently ignore, the text is still visible to select manually.
      }
    });

    outputTrack.appendChild(node);
  });

  resultsEl.hidden = false;
  resultsEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  if (!fromHistory) {
    saveHistory(data, mode);
    if (document.getElementById('autoPlay').checked) {
      const first = outputTrack.querySelector('.play-btn');
      if (first) first.click();
    }
  }
}

document.getElementById('startOverBtn').addEventListener('click', () => {
  resultsEl.hidden = true;
  outputTrack.innerHTML = '';
  textInput.value = '';
  setStatus('');
});

// ---- Text submission ----------------------------------------------------
const textInput = document.getElementById('textInput');
const submitTextBtn = document.getElementById('submitText');

submitTextBtn.addEventListener('click', async () => {
  const text = textInput.value.trim();
  if (!text) { setStatus('Type something first.', true); return; }

  submitTextBtn.disabled = true;
  setStatus('Bridging…');
  try {
    const res = await fetch('/api/translate-text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, sourceLang: selectedSourceLang }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Something went wrong.');
    renderResults(data, 'type');
    setStatus('');
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    submitTextBtn.disabled = false;
  }
});

// ---- Audio recording ------------------------------------------------------
const recordBtn = document.getElementById('recordBtn');
const recordLabel = recordBtn.querySelector('.record-label');
const waveform = document.getElementById('waveform');

let mediaRecorder, chunks = [], isRecording = false;

recordBtn.addEventListener('click', async () => {
  if (!isRecording) {
    if (!navigator.mediaDevices || !window.MediaRecorder) { setStatus('Recording is not supported in this browser. Use the Type tab.', true); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      chunks = [];
      const mime = pickMime();
      mediaRecorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      mediaRecorder.ondataavailable = e => chunks.push(e.data);
      mediaRecorder.onstop = () => {
        stream.getTracks().forEach(t => t.stop());
        const type = mediaRecorder.mimeType || 'audio/webm';
        submitAudio(new Blob(chunks, { type }), type);
      };
      mediaRecorder.start();
      isRecording = true;
      recordBtn.setAttribute('aria-pressed', 'true');
      recordLabel.textContent = 'Tap to stop';
      waveform.hidden = false;
      setStatus('Listening…');
    } catch (err) {
      setStatus('Microphone access is needed to record. Check your browser permissions.', true);
    }
  } else {
    mediaRecorder.stop();
    isRecording = false;
    recordBtn.setAttribute('aria-pressed', 'false');
    recordLabel.textContent = 'Tap to speak';
    waveform.hidden = true;
  }
});

function pickMime() {
  if (!window.MediaRecorder) return '';
  return ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']
    .find(t => MediaRecorder.isTypeSupported(t)) || '';
}

async function submitAudio(blob, type = 'audio/webm') {
  if (blob.size < 500) { setStatus('Nothing was recorded. Try again.', true); return; }
  const ext = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm';
  setStatus('Transcribing and bridging…');
  recordBtn.disabled = true;
  try {
    const form = new FormData();
    form.append('audio', blob, `recording.${ext}`);
    const res = await fetch('/api/translate-audio', { method: 'POST', body: form });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Something went wrong.');
    renderResults(data, 'speak');
    setStatus('');
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    recordBtn.disabled = false;
  }
}

// ---- Character counter + Ctrl+Enter --------------------------------------------
const charCount = document.getElementById('charCount');
textInput.addEventListener('input', () => { charCount.textContent = textInput.value.length; });
textInput.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') submitTextBtn.click();
});

// ---- Auto-play preference ----------------------------------------------------------
const autoPlayEl = document.getElementById('autoPlay');
try { autoPlayEl.checked = localStorage.getItem('setu.autoplay') !== '0'; } catch {}
autoPlayEl.addEventListener('change', () => {
  try { localStorage.setItem('setu.autoplay', autoPlayEl.checked ? '1' : '0'); } catch {}
});

// ---- History (text only, stored on this device) ------------------------------------
const HISTORY_KEY = 'setu.history.v1';
const MAX_HISTORY = 15;
const historySection = document.getElementById('historySection');
const historyList = document.getElementById('historyList');

function loadHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY)) || []; } catch { return []; }
}
function saveHistory(data, mode) {
  // Audio is not stored (too large) — replay re-requests nothing, text only.
  const entry = {
    t: Date.now(), mode,
    source: data.source,
    translations: Object.fromEntries(Object.entries(data.translations).map(([k, v]) => [k, { text: v.text }])),
  };
  const list = [entry, ...loadHistory()].slice(0, MAX_HISTORY);
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(list)); } catch {}
  renderHistory();
}
function renderHistory() {
  const list = loadHistory();
  historySection.hidden = list.length === 0;
  historyList.innerHTML = '';
  list.forEach(item => {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'history-item';
    const tag = document.createElement('span');
    tag.className = 'history-tag';
    tag.textContent = (item.source.lang || '').toUpperCase();
    const txt = document.createElement('span');
    txt.className = 'history-text';
    txt.textContent = item.source.text;
    btn.append(tag, txt);
    btn.addEventListener('click', () => showHistoryItem(item));
    li.appendChild(btn);
    historyList.appendChild(li);
  });
}
function showHistoryItem(item) {
  // Show text; audio can be regenerated by bridging again.
  renderResults({ source: item.source, translations: Object.fromEntries(
    Object.entries(item.translations).map(([k, v]) => [k, { text: v.text, audioBase64: '' }])) }, item.mode, true);
  outputTrack.querySelectorAll('.play-btn').forEach(b => b.hidden = true);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
document.getElementById('clearHistory').addEventListener('click', () => {
  try { localStorage.removeItem(HISTORY_KEY); } catch {}
  renderHistory();
});
renderHistory();

// ---- Online/offline ----------------------------------------------------------------------
const offlineBanner = document.getElementById('offlineBanner');
function updateOnline() { offlineBanner.hidden = navigator.onLine; }
window.addEventListener('online', updateOnline);
window.addEventListener('offline', updateOnline);
updateOnline();

// ---- PWA: service worker + install button --------------------------------------------
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}
let deferredInstall;
const installBtn = document.getElementById('installBtn');
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  deferredInstall = e;
  installBtn.hidden = false;
});
installBtn.addEventListener('click', async () => {
  if (!deferredInstall) return;
  deferredInstall.prompt();
  await deferredInstall.userChoice;
  deferredInstall = null;
  installBtn.hidden = true;
});
