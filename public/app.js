// ══════════════════════════════════════════════════════════════════
//  🔑 GIPHY API KEY — get free at https://developers.giphy.com
// ══════════════════════════════════════════════════════════════════

const GIPHY_API_KEY = 'ynWUtCtMuKwun5dNdwjnIbgy51S49xmI';


// ══════════════════════════════════════════════════════════════════
//  📞 TURN SERVER CONFIG — get free at https://dashboard.metered.ca
//  Required for calls over ngrok / different networks
//  Leave empty to use direct P2P (LAN only)
// ══════════════════════════════════════════════════════════════════
const TURN_CONFIG = {
  iceServers: [
    { urls: "stun:stun.relay.metered.ca:80" },
    {
      urls: "turn:global.relay.metered.ca:80",
      username: "63a55c57ea4af5914d4f3d0a",
      credential: "P3lfLyZeDsDi+r5v",
    },
    {
      urls: "turn:global.relay.metered.ca:80?transport=tcp",
      username: "63a55c57ea4af5914d4f3d0a",
      credential: "P3lfLyZeDsDi+r5v",
    },
    {
      urls: "turn:global.relay.metered.ca:443",
      username: "63a55c57ea4af5914d4f3d0a",
      credential: "P3lfLyZeDsDi+r5v",
    },
    {
      urls: "turns:global.relay.metered.ca:443?transport=tcp",
      username: "63a55c57ea4af5914d4f3d0a",
      credential: "P3lfLyZeDsDi+r5v",
    },
  ],
};
// ══════════════════════════════════════════════════════════════════

// ── State ─────────────────────────────────────────────────────────────────────
let ws             = null;
let myUsername     = null;
let pmTo           = null;
let gifPickerOpen  = false;
let searchTimer    = null;
let sessionChecked = false;

// ── WebRTC state ──────────────────────────────────────────────────────────────
let peerConn        = null;
let localStream     = null;
let callWith        = null;
let incomingOffer   = null;
let callTimerInt    = null;
let callSeconds     = 0;
let isMuted         = false;
let isCallerRole    = false;
let remoteDescSet   = false;   // track if remote description is set
let iceCandidateQueue = [];    // queue candidates that arrive early

// ── Voice recording state ────────────────────────────────────────────────────
let mediaRecorder   = null;
let audioChunks     = [];
let recordingStream = null;

// ─────────────────────────────────────────────────────────────────────────────
//  BOOT
// ─────────────────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
  showScreen('loading');
  await checkSession();
});

async function checkSession() {
  try {
    const res  = await fetch('/api/me');
    const data = await res.json();
    if (data.logged_in) {
      myUsername = data.username;
      connectWs(true);
    } else {
      showScreen('auth');
      connect();
    }
  } catch {
    showScreen('auth');
    connect();
  }
}

function showScreen(screen) {
  document.getElementById('loadingScreen').style.display = screen === 'loading' ? 'flex' : 'none';
  document.getElementById('authScreen').style.display    = screen === 'auth'    ? ''     : 'none';
  document.getElementById('chatApp').classList.toggle('visible', screen === 'chat');
}

// ─────────────────────────────────────────────────────────────────────────────
//  WEBSOCKET
// ─────────────────────────────────────────────────────────────────────────────
function connect() { connectWs(false); }

function connectWs(resumeSession) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => {
    setStatus(true);
    if (resumeSession && myUsername)
      ws.send(JSON.stringify({ type: 'session_resume', username: myUsername }));
  };
  ws.onmessage = (e) => handle(JSON.parse(e.data));
  ws.onclose   = () => { setStatus(false); setTimeout(() => connectWs(false), 2000); };
  ws.onerror   = () => ws.close();
}

function setStatus(isOnline) {
  const el = document.getElementById('connStatus');
  el.className = 'conn-status' + (isOnline ? ' connected' : '');
  el.innerHTML = `<span class="status-dot"></span> ${isOnline ? 'connected' : 'reconnecting...'}`;
}

function send(obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

// ─────────────────────────────────────────────────────────────────────────────
//  MESSAGE HANDLER
// ─────────────────────────────────────────────────────────────────────────────
function handle(msg) {
  switch (msg.type) {
    case 'registered':
      showToast(msg.text, 'success');
      setTimeout(() => switchTab('login'), 1200);
      break;
    case 'error':
      showToast(msg.text, 'error');
      if (!sessionChecked) { sessionChecked = true; showScreen('auth'); }
      break;
    case 'logged_in':
      sessionChecked = true;
      myUsername = msg.username;
      document.getElementById('myName').textContent = myUsername;
      showScreen('chat');
      break;
    case 'history':
      msg.messages.forEach(m => {
        if (m.text && m.text.startsWith('[VOICE]')) {
          const filename = m.text.replace('[VOICE]', '');
          renderVoiceMessage({
            from: m.from,
            url:  `/uploads/${filename}`,
            time: m.time
          });
        } else {
          renderMessage(m);
        }
      });
      scrollBottom();
      break;
    case 'message':
    case 'private':
    case 'system':
      renderMessage(msg);
      scrollBottom();
      break;
    case 'users':
      renderUsers(msg.list);
      break;

    case 'voice':
      renderVoiceMessage(msg);
      scrollBottom();
      break;

    // ── WebRTC signaling ────────────────────────────────────────────────────
    case 'call_offer':
      handleIncomingCall(msg);
      break;
    case 'call_answer':
      handleCallAnswer(msg);
      break;
    case 'call_rejected':
      handleCallRejected(msg);
      break;
    case 'call_ended':
      handleCallEnded();
      break;
    case 'ice_candidate':
      handleIceCandidate(msg);
      break;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  AUTH
// ─────────────────────────────────────────────────────────────────────────────
async function doLogin() {
  const username = document.getElementById('loginUser').value.trim();
  const password = document.getElementById('loginPass').value;
  if (!username || !password) return showToast('Fill in all fields.', 'error');
  const res  = await fetch('/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  const data = await res.json();
  if (!data.ok) return showToast(data.error, 'error');
  myUsername = data.username;
  send({ type: 'login', username, password });
}

async function doRegister() {
  const username = document.getElementById('regUser').value.trim();
  const password = document.getElementById('regPass').value;
  if (!username || !password) return showToast('Fill in all fields.', 'error');
  const res  = await fetch('/api/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  const data = await res.json();
  if (!data.ok) return showToast(data.error, 'error');
  showToast('Account created! You can now log in.', 'success');
  setTimeout(() => switchTab('login'), 1200);
}

async function logout() {
  hangUp();
  await fetch('/api/logout', { method: 'POST' });
  myUsername = null; pmTo = null; sessionChecked = false;
  closeGifPicker();
  showScreen('auth');
  document.getElementById('messages').innerHTML = `
    <div class="empty-state" id="emptyState">
      <div class="empty-icon">💬</div>
      <div class="empty-text">No messages yet. Say hello!</div>
    </div>`;
  ws.close();
}

// ─────────────────────────────────────────────────────────────────────────────
//  WEBRTC — CALLER SIDE
// ─────────────────────────────────────────────────────────────────────────────
async function startCall(targetUser) {
  if (callWith) return showCallNotif('Already in a call!');
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  } catch {
    return showCallNotif('❌ Microphone access denied.');
  }

  callWith      = targetUser;
  isCallerRole  = true;
  peerConn      = createPeerConn(targetUser);

  localStream.getTracks().forEach(t => peerConn.addTrack(t, localStream));

  const offer = await peerConn.createOffer();
  await peerConn.setLocalDescription(offer);

  send({ type: 'call_offer', to: targetUser, offer });
  showCallBar(targetUser, 'Calling...');
}

// ─────────────────────────────────────────────────────────────────────────────
//  WEBRTC — CALLEE SIDE
// ─────────────────────────────────────────────────────────────────────────────
function handleIncomingCall(msg) {
  if (callWith) {
    // Already in a call — auto-reject
    send({ type: 'call_reject', to: msg.from });
    return;
  }
  callWith      = msg.from;
  incomingOffer = msg.offer;
  isCallerRole  = false;
  showCallPopup(msg.from);
}

async function acceptCall() {
  hideCallPopup();
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  } catch {
    send({ type: 'call_reject', to: callWith });
    callWith = null;
    return showCallNotif('❌ Microphone access denied.');
  }

  peerConn = createPeerConn(callWith);
  localStream.getTracks().forEach(t => peerConn.addTrack(t, localStream));

  await peerConn.setRemoteDescription(new RTCSessionDescription(incomingOffer));
  remoteDescSet = true;
  await flushIceCandidateQueue();   // apply any candidates that arrived early

  const answer = await peerConn.createAnswer();
  await peerConn.setLocalDescription(answer);

  send({ type: 'call_answer', to: callWith, answer });
  showCallBar(callWith);
}

function declineCall() {
  send({ type: 'call_reject', to: callWith });
  hideCallPopup();
  callWith = null;
  incomingOffer = null;
}

async function handleCallAnswer(msg) {
  if (!peerConn) return;
  await peerConn.setRemoteDescription(new RTCSessionDescription(msg.answer));
  remoteDescSet = true;
  await flushIceCandidateQueue();   // apply any candidates that arrived early
  startCallTimer();
  updateCallBar(msg.from);
}

function handleCallRejected(msg) {
  showCallNotif(msg.reason || 'Call declined.');
  cleanupCall();
}

function handleCallEnded() {
  showCallNotif(`📵 ${callWith} ended the call.`);
  cleanupCall();
}

async function handleIceCandidate(msg) {
  if (!peerConn || !msg.candidate) return;
  if (!remoteDescSet) {
    // Remote description not set yet — queue the candidate
    console.log('📦 Queuing ICE candidate (remote desc not set yet)');
    iceCandidateQueue.push(msg.candidate);
    return;
  }
  try {
    await peerConn.addIceCandidate(new RTCIceCandidate(msg.candidate));
    console.log('✅ ICE candidate added');
  } catch(e) {
    console.warn('❌ Failed to add ICE candidate:', e);
  }
}

async function flushIceCandidateQueue() {
  console.log(`🔄 Flushing ${iceCandidateQueue.length} queued ICE candidates`);
  for (const candidate of iceCandidateQueue) {
    try {
      await peerConn.addIceCandidate(new RTCIceCandidate(candidate));
    } catch(e) {
      console.warn('❌ Failed to add queued ICE candidate:', e);
    }
  }
  iceCandidateQueue = [];
}

// ─────────────────────────────────────────────────────────────────────────────
//  WEBRTC — PEER CONNECTION
// ─────────────────────────────────────────────────────────────────────────────
function createPeerConn(targetUser) {
  const pc = new RTCPeerConnection(TURN_CONFIG);

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      console.log('🧊 Sending ICE candidate');
      send({ type: 'ice_candidate', to: targetUser, candidate: e.candidate });
    } else {
      console.log('🧊 ICE gathering complete');
    }
  };

  pc.ontrack = (e) => {
    console.log('🎤 Got remote audio track!', e.track.kind);
    const audio = document.getElementById('remoteAudio');

    if (e.streams && e.streams[0]) {
      audio.srcObject = e.streams[0];
    } else {
      if (!audio.srcObject) audio.srcObject = new MediaStream();
      audio.srcObject.addTrack(e.track);
    }

    // Unmute and set volume explicitly
    audio.muted  = false;
    audio.volume = 1.0;

    audio.play().then(() => {
      console.log('🔊 Audio playing!');
    }).catch(err => {
      console.warn('⚠️ Autoplay blocked, waiting for click:', err);
      document.addEventListener('click', () => {
        audio.play().then(() => console.log('🔊 Audio playing after click!'));
      }, { once: true });
    });
  };

  pc.onconnectionstatechange = () => {
    console.log('🔗 WebRTC connection state:', pc.connectionState);
    if (pc.connectionState === 'connected') {
      startCallTimer();
      updateCallBar(targetUser);
    }
    if (['disconnected', 'failed', 'closed'].includes(pc.connectionState)) {
      if (callWith) { showCallNotif('📵 Call disconnected.'); cleanupCall(); }
    }
  };

  pc.oniceconnectionstatechange = () => {
    console.log('🧊 ICE connection state:', pc.iceConnectionState);
    if (pc.iceConnectionState === 'failed') {
      console.error('❌ ICE failed — TURN server may not be working');
      showCallNotif('❌ Connection failed. Check TURN server config.');
    }
  };

  pc.onsignalingstatechange = () => {
    console.log('📡 Signaling state:', pc.signalingState);
  };

  return pc;
}

// ─────────────────────────────────────────────────────────────────────────────
//  CALL CONTROLS
// ─────────────────────────────────────────────────────────────────────────────
function hangUp() {
  if (callWith) send({ type: 'call_end', to: callWith });
  cleanupCall();
}

function toggleMute() {
  if (!localStream) return;
  isMuted = !isMuted;
  localStream.getAudioTracks().forEach(t => t.enabled = !isMuted);
  const btn = document.getElementById('muteBtn');
  btn.textContent = isMuted ? '🔇' : '🎤';
  btn.classList.toggle('muted', isMuted);
}

function cleanupCall() {
  if (peerConn)    { peerConn.close(); peerConn = null; }
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  const audio = document.getElementById('remoteAudio');
  audio.srcObject = null;
  clearInterval(callTimerInt);
  callSeconds = 0; isMuted = false; callWith = null; incomingOffer = null;
  remoteDescSet = false; iceCandidateQueue = [];
  hideCallPopup();
  hideCallBar();
  document.getElementById('muteBtn').textContent = '🎤';
  document.getElementById('muteBtn').classList.remove('muted');
}

// ─────────────────────────────────────────────────────────────────────────────
//  CALL UI
// ─────────────────────────────────────────────────────────────────────────────
function showCallPopup(username) {
  document.getElementById('callPopupName').textContent   = username;
  document.getElementById('callPopupAvatar').textContent = username[0].toUpperCase();
  document.getElementById('callPopup').classList.add('show');
}
function hideCallPopup() {
  document.getElementById('callPopup').classList.remove('show');
}

function showCallBar(username, status = '') {
  document.getElementById('callBarName').textContent = status || `🎤 ${username}`;
  document.getElementById('callTimer').textContent   = '00:00';
  document.getElementById('callBar').classList.add('active');
}
function updateCallBar(username) {
  document.getElementById('callBarName').textContent = `🎤 ${username}`;
}
function hideCallBar() {
  document.getElementById('callBar').classList.remove('active');
  document.getElementById('callTimer').textContent = '00:00';
}

function startCallTimer() {
  clearInterval(callTimerInt);
  callSeconds = 0;
  callTimerInt = setInterval(() => {
    callSeconds++;
    const m = String(Math.floor(callSeconds / 60)).padStart(2, '0');
    const s = String(callSeconds % 60).padStart(2, '0');
    document.getElementById('callTimer').textContent = `${m}:${s}`;
  }, 1000);
}

function showCallNotif(text) {
  renderMessage({ type: 'system', text });
  scrollBottom();
}

// ─────────────────────────────────────────────────────────────────────────────
//  CHAT
// ─────────────────────────────────────────────────────────────────────────────
function sendMsg() {
  const input = document.getElementById('msgInput');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  if (pmTo) {
    send({ type: 'private', to: pmTo, text });
  } else {
    send({ type: 'message', text });
  }
}

function sendGif(gifUrl) {
  closeGifPicker();
  if (pmTo) send({ type: 'private', to: pmTo, text: '', gif: gifUrl });
  else      send({ type: 'message', text: '', gif: gifUrl });
}

// ─────────────────────────────────────────────────────────────────────────────
//  RENDER
// ─────────────────────────────────────────────────────────────────────────────
function renderMessage(msg) {
  const container = document.getElementById('messages');
  document.getElementById('emptyState')?.remove();
  const div = document.createElement('div');

  if (msg.type === 'system') {
    div.className = 'msg system';
    div.innerHTML = `<div class="msg-bubble">${escHtml(msg.text)}</div>`;

  } else if (msg.type === 'private') {
    const isSelf = msg.from === myUsername;
    div.className = `msg private ${isSelf ? 'self' : 'other'}`;
    const label = isSelf ? `DM → ${msg.to}` : `DM from ${msg.from}`;
    const bubble = msg.gif
      ? `<img class="msg-gif" src="${escHtml(msg.gif)}" alt="GIF" loading="lazy">`
      : escHtml(msg.text);
    div.innerHTML = `
      <div class="msg-meta">
        <span class="msg-name">${escHtml(msg.from)}</span>
        <span class="msg-time">${fmtTime(msg.time)}</span>
      </div>
      <div class="pm-tag">🔒 ${escHtml(label)}</div>
      <div class="msg-bubble ${msg.gif ? 'msg-gif-wrap' : ''}">${bubble}</div>`;

  } else {
    const isSelf = msg.from === myUsername;
    const isBot  = msg.bot === true;
    div.className = `msg ${isBot ? 'bot' : isSelf ? 'self' : 'other'}`;
    const bubble = msg.gif
      ? `<img class="msg-gif" src="${escHtml(msg.gif)}" alt="GIF" loading="lazy">`
      : escHtml(msg.text);
    div.innerHTML = `
      <div class="msg-meta">
        <span class="msg-name ${isBot ? 'bot-name' : ''}">${escHtml(msg.from)}</span>
        <span class="msg-time">${fmtTime(msg.time)}</span>
      </div>
      <div class="msg-bubble ${msg.gif ? 'msg-gif-wrap' : ''}">${bubble}</div>`;
  }
  container.appendChild(div);
}

function renderUsers(list) {
  const ul = document.getElementById('userList');
  ul.innerHTML = '';
  const others = list.filter(u => u !== myUsername);
  if (others.length === 0) {
    ul.innerHTML = `<div style="padding:8px 10px;color:var(--muted);font-size:0.8rem;font-family:'JetBrains Mono',monospace;">no one else online</div>`;
    return;
  }
  others.forEach(u => {
    const item = document.createElement('div');
    item.className = 'user-item' + (pmTo === u ? ' selected' : '');
    item.innerHTML = `
      <div class="avatar">${u[0].toUpperCase()}</div>
      <span>${escHtml(u)}</span>
      <button class="call-btn" title="Call ${escHtml(u)}" onclick="event.stopPropagation(); startCall('${escHtml(u)}')">📞</button>`;
    item.onclick = () => setPM(u);
    ul.appendChild(item);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  GIF PICKER
// ─────────────────────────────────────────────────────────────────────────────
function toggleGifPicker() { gifPickerOpen ? closeGifPicker() : openGifPicker(); }

function openGifPicker() {
  gifPickerOpen = true;
  document.getElementById('gifPicker').classList.add('open');
  document.querySelector('.gif-btn').classList.add('active');
  document.getElementById('gifSearch').value = '';
  document.getElementById('gifLabel').textContent = '🔥 Trending';
  loadTrendingGifs();
  setTimeout(() => document.getElementById('gifSearch').focus(), 100);
}
function closeGifPicker() {
  gifPickerOpen = false;
  document.getElementById('gifPicker').classList.remove('open');
  document.querySelector('.gif-btn').classList.remove('active');
}

async function loadTrendingGifs() {
  const grid = document.getElementById('gifGrid');
  grid.innerHTML = '<div class="gif-loading">Loading GIFs...</div>';
  try {
    const res  = await fetch(`https://api.giphy.com/v1/gifs/trending?api_key=${GIPHY_API_KEY}&limit=18&rating=g`);
    const data = await res.json();
    renderGifGrid(data.data);
  } catch { grid.innerHTML = '<div class="gif-loading">Failed to load. Check your API key.</div>'; }
}

function searchGifs() {
  clearTimeout(searchTimer);
  const query = document.getElementById('gifSearch').value.trim();
  const label = document.getElementById('gifLabel');
  if (!query) { label.textContent = '🔥 Trending'; loadTrendingGifs(); return; }
  label.textContent = `🔍 "${query}"`;
  searchTimer = setTimeout(async () => {
    const grid = document.getElementById('gifGrid');
    grid.innerHTML = '<div class="gif-loading">Searching...</div>';
    try {
      const res  = await fetch(`https://api.giphy.com/v1/gifs/search?api_key=${GIPHY_API_KEY}&q=${encodeURIComponent(query)}&limit=18&rating=g`);
      const data = await res.json();
      renderGifGrid(data.data);
    } catch { grid.innerHTML = '<div class="gif-loading">Search failed.</div>'; }
  }, 500);
}

function renderGifGrid(gifs) {
  const grid = document.getElementById('gifGrid');
  if (!gifs || gifs.length === 0) { grid.innerHTML = '<div class="gif-loading">No GIFs found.</div>'; return; }
  grid.innerHTML = '';
  gifs.forEach(gif => {
    const item = document.createElement('div');
    item.className = 'gif-item';
    item.innerHTML = `<img src="${gif.images.fixed_height_small.url}" alt="${escHtml(gif.title)}" loading="lazy">`;
    item.onclick = () => sendGif(gif.images.fixed_height.url);
    grid.appendChild(item);
  });
}

document.addEventListener('click', (e) => {
  const picker = document.getElementById('gifPicker');
  const btn    = document.querySelector('.gif-btn');
  if (gifPickerOpen && !picker.contains(e.target) && e.target !== btn) closeGifPicker();
});

// ─────────────────────────────────────────────────────────────────────────────
//  DM
// ─────────────────────────────────────────────────────────────────────────────
function setPM(username) {
  pmTo = username;
  document.getElementById('pmTarget').textContent = username;
  document.getElementById('pmIndicator').classList.add('show');
  document.getElementById('pmBadge').style.display = 'block';
  document.getElementById('chatTitle').textContent = `@ ${username}`;
  document.getElementById('chatSub').textContent = 'private message';
  document.querySelectorAll('.user-item').forEach(el => {
    el.classList.toggle('selected', el.querySelector('span').textContent === username);
  });
  document.getElementById('msgInput').focus();
}

function clearPM() {
  pmTo = null;
  document.getElementById('pmIndicator').classList.remove('show');
  document.getElementById('pmBadge').style.display = 'none';
  document.getElementById('chatTitle').textContent = '# general';
  document.getElementById('chatSub').textContent = 'LAN broadcast';
  document.querySelectorAll('.user-item').forEach(el => el.classList.remove('selected'));
}

// ─────────────────────────────────────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────────────────────────────────────
function switchTab(tab) {
  document.getElementById('loginForm').style.display    = tab === 'login'    ? '' : 'none';
  document.getElementById('registerForm').style.display = tab === 'register' ? '' : 'none';
  document.getElementById('tabLogin').classList.toggle('active',    tab === 'login');
  document.getElementById('tabRegister').classList.toggle('active', tab === 'register');
  clearToast();
}
function showToast(text, type) {
  const t = document.getElementById('authToast');
  t.textContent = text; t.className = `toast ${type}`; t.style.display = 'block';
}
function clearToast() { document.getElementById('authToast').style.display = 'none'; }
function scrollBottom() { const m = document.getElementById('messages'); m.scrollTop = m.scrollHeight; }
function escHtml(str) {
  return String(str).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}
function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// ── Voice Recording ───────────────────────────────────────────────────────────
async function startRecording() {
  if (mediaRecorder) return;
  try {
    recordingStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    return showCallNotif('❌ Microphone access denied.');
  }

  audioChunks   = [];
  mediaRecorder = new MediaRecorder(recordingStream);

  mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) audioChunks.push(e.data);
  };

  mediaRecorder.onstop = () => {
    const blob   = new Blob(audioChunks, { type: 'audio/webm' });
    const reader = new FileReader();
    reader.onload = () => {
      if (pmTo) {
        send({ type: 'private', to: pmTo, text: '', voice: reader.result });
      } else {
        send({ type: 'voice', data: reader.result });
      }
    };
    reader.readAsDataURL(blob);
    recordingStream.getTracks().forEach(t => t.stop());
    recordingStream = null;
    mediaRecorder   = null;
    audioChunks     = [];
    document.getElementById('micBtn').classList.remove('recording');
  };

  mediaRecorder.start();
  document.getElementById('micBtn').classList.add('recording');
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop();
  }
}

// ── Render Voice Message ──────────────────────────────────────────────────────
function renderVoiceMessage(msg) {
  const container = document.getElementById('messages');
  document.getElementById('emptyState')?.remove();

  const isSelf = msg.from === myUsername;
  const div    = document.createElement('div');
  div.className = `msg ${isSelf ? 'self' : 'other'}`;

  const audio    = new Audio(msg.url || msg.data);
  let duration   = '0:00';
  let playing    = false;

  audio.onloadedmetadata = () => {
    duration = fmtDuration(audio.duration);
    div.querySelector('.voice-duration').textContent = duration;
  };

  audio.ontimeupdate = () => {
    const pct = (audio.currentTime / audio.duration) * 100;
    div.querySelector('.voice-progress-fill').style.width = pct + '%';
    div.querySelector('.voice-duration').textContent = fmtDuration(audio.currentTime);
  };

  audio.onended = () => {
    playing = false;
    div.querySelector('.voice-play-btn').textContent = '▶';
    div.querySelector('.voice-progress-fill').style.width = '0%';
    div.querySelector('.voice-duration').textContent = duration;
  };

  div.innerHTML = `
    <div class="msg-meta">
      <span class="msg-name">${escHtml(msg.from)}</span>
      <span class="msg-time">${fmtTime(msg.time)}</span>
    </div>
    <div class="msg-bubble" style="padding:8px">
      <div class="voice-msg">
        <button class="voice-play-btn">▶</button>
        <div class="voice-progress">
          <div class="voice-progress-fill"></div>
        </div>
        <span class="voice-duration">0:00</span>
      </div>
    </div>`;

  div.querySelector('.voice-play-btn').onclick = () => {
    if (playing) {
      audio.pause();
      playing = false;
      div.querySelector('.voice-play-btn').textContent = '▶';
    } else {
      audio.play();
      playing = true;
      div.querySelector('.voice-play-btn').textContent = '⏸';
    }
  };

  container.appendChild(div);
}

function fmtDuration(secs) {
  if (isNaN(secs) || !isFinite(secs)) return '0:00';
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('loginUser').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
  document.getElementById('loginPass').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
  document.getElementById('regPass').addEventListener('keydown',   e => { if (e.key === 'Enter') doRegister(); });
});