#  LAN Chat

> Real-time chat application with voice calls, AI chatbot, GIF sharing, and encrypted voice messages — built from scratch with Python and vanilla JavaScript.

---

##  Features

-  **Real-time group messaging** — all users see messages instantly
-  **Private direct messages** — send DMs to specific users
-  **AI Chatbot** — type `@ai` followed by any question
-  **GIF sharing** — search and send GIFs via Giphy
-  **Voice messages** — hold the mic button to record and send audio clips
-  **Voice calls** — live peer-to-peer voice calls via WebRTC
-  **Encrypted storage** — voice files saved on disk are AES-256 encrypted
-  **Persistent history** — all messages saved in MySQL and loaded on login
-  **Stay logged in** — session cookies keep you authenticated after refresh

---

##  Tech Stack

### Backend
| Library | Purpose |
|---------|---------|
| `Flask` | Web framework — HTTP routes and static files |
| `flask-sock` | WebSocket support for real-time communication |
| `mysql-connector-python` | MySQL database driver |
| `cryptography` (Fernet) | AES-256 encryption of voice files |
| `requests` | HTTP client for external API calls |
| `hashlib` | SHA-256 password hashing |
| `threading` | Non-blocking AI chatbot responses |
| `base64` + `uuid` | Audio encoding and unique file naming |

### Frontend
| API | Purpose |
|-----|---------|
| WebSocket API | Persistent real-time connection to server |
| WebRTC (RTCPeerConnection) | Peer-to-peer voice calls |
| MediaRecorder API | Microphone recording for voice messages |
| MediaDevices API | Microphone access |
| Fetch API | REST calls for auth and session management |
| FileReader API | Convert audio blobs to base64 |

### External Services
| Service | Purpose |
|---------|---------|
| [Groq API](https://console.groq.com) | AI chatbot (llama-3.3-70b-versatile) |
| [Giphy API](https://developers.giphy.com) | GIF search and trending |
| [Metered.ca](https://dashboard.metered.ca) | Free TURN server for cross-network calls |
| [ngrok](https://ngrok.com) | Reverse proxy — expose local server to internet |

---

##  Project Structure

```
lan-chat/
├── server.py              ← Python backend (Flask + WebSocket)
├── requirements.txt       ← Python dependencies
├── uploads/               ← Encrypted voice message files (auto-created)
└── public/
    ├── index.html         ← HTML structure
    ├── style.css          ← Dark theme styling
    └── app.js             ← All JavaScript logic
```

---

##  Installation

### 1. Clone the project
```bash
git clone https://github.com/your-username/lan-chat.git
cd lan-chat
```

### 2. Install Python dependencies
```bash
pip install -r requirements.txt
```

### 3. Install and start MySQL
Make sure MySQL is running on your machine, then update the credentials in `server.py`:
```python
DB_CONFIG = {
    "host":     "localhost",
    "port":     3306,
    "user":     "root",
    "password": "YOUR_MYSQL_PASSWORD",  # ← change this
    "database": "lanchat"
}
```
> The database and tables are created **automatically** on first run — no manual SQL needed.

### 4. Configure API keys

Open `server.py` and set your Groq API key:
```python
GROK_API_KEY = "your-groq-key-here"
```

Open `public/app.js` and set your Giphy API key:
```javascript
const GIPHY_API_KEY = 'your-giphy-key-here';
```

### 5. Set up TURN server (for voice calls over ngrok)

1. Sign up free at [dashboard.metered.ca](https://dashboard.metered.ca)
2. Create an app → go to **TURN Credentials** → click **Get JavaScript Code**
3. Replace `TURN_CONFIG` at the top of `public/app.js` with the provided code

### 6. Run the server
```bash
python server.py
```

Output:
```
 Connecting to MySQL...
 Database ready.

 LAN Chat Server running!
   Local:   http://localhost:3000
   Network: http://192.168.x.x:3000

   For ngrok: ngrok http 3000
```

---

##  Exposing to the Internet (ngrok)

To allow access from other networks:

```bash
# Terminal 1 — run the server
python server.py

# Terminal 2 — start ngrok tunnel
ngrok http 3000
```

Share the generated URL with your friends:
```
https://xxxx.ngrok-free.app  ← share this
```

> **Note:** ngrok URL changes every restart on the free plan. Set a fixed `SECRET_KEY` in `server.py` so users stay logged in when it restarts:
> ```python
> app.secret_key = "my-fixed-secret-key-here"
> ```

---

##  Security

### Encryption key
Voice messages are encrypted with AES-256 before being saved to disk. The key is set in `server.py`:
```python
ENCRYPTION_KEY = "your-fernet-key-here"
```

Generate a new key:
```bash
python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
```

>  **Never change this key** after saving voice messages — they will become unreadable.

### Environment variables (recommended for production)
```bash
# Windows
set SECRET_KEY=your-secret-key
set ENCRYPTION_KEY=your-fernet-key
set GROK_API_KEY=your-groq-key

# Linux / Mac
export SECRET_KEY=your-secret-key
export ENCRYPTION_KEY=your-fernet-key
export GROK_API_KEY=your-groq-key
```

---

##  Usage

| Feature | How to use |
|---------|-----------|
| **Send message** | Type and press Enter |
| **Private DM** | Click a user in the sidebar |
| **AI chatbot** | Type `@ai your question` |
| **Send GIF** | Click the GIF button → search → click a GIF |
| **Voice message** | Hold the 🎤 button → release to send |
| **Voice call** | Hover a user in the sidebar → click  |
| **Mute call** | Click 🎤 in the call bar |
| **Hang up** | Click 📵 in the call bar |

---

## API Keys — Where to get them

| API | Link | Free tier |
|-----|------|-----------|
| Groq API | [console.groq.com](https://console.groq.com) |  Free |
| Giphy API | [developers.giphy.com](https://developers.giphy.com) | Free |
| Metered TURN | [dashboard.metered.ca](https://dashboard.metered.ca) |  Free (500MB/month) |
| ngrok | [ngrok.com](https://ngrok.com) |  Free |

---

##  Database Schema

```sql
CREATE TABLE users (
    id         INT AUTO_INCREMENT PRIMARY KEY,
    username   VARCHAR(50) UNIQUE NOT NULL,
    password   VARCHAR(64) NOT NULL,       -- SHA-256 hash
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE messages (
    id       INT AUTO_INCREMENT PRIMARY KEY,
    sender   VARCHAR(50) NOT NULL,
    receiver VARCHAR(50) DEFAULT NULL,     -- NULL = public message
    content  TEXT NOT NULL,
    sent_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

---

##  How WebRTC Voice Calls Work

```
Caller                  Server (WebSocket relay)        Callee
  │                             │                          │
  │──── call_offer (SDP) ──────▶│──── call_offer ─────────▶│
  │                             │                          │ (accepts)
  │◀─── call_answer (SDP) ──────│◀─── call_answer ─────────│
  │                             │                          │
  │──── ice_candidate ─────────▶│──── ice_candidate ───────▶│
  │◀─── ice_candidate ──────────│◀─── ice_candidate ────────│
  │                             │                          │
  └──────────── Audio flows directly P2P (or via TURN) ───┘
```

> The server only relays the handshake. Audio never touches the server.

---

##  Testing Checklist

- [x] Register and login with correct/wrong credentials
- [x] Stay logged in after page refresh
- [x] Public messages visible to all users
- [x] Private messages only visible to correct recipient
- [x] AI chatbot responds to `@ai` questions
- [x] GIF search and sending
- [x] Voice message recording and playback
- [x] Voice message history after logout/login
- [x] Voice calls on same WiFi (LAN)
- [x] Voice calls over ngrok with TURN server
- [x] Encrypted files unplayable when opened directly from uploads/

---

##  Troubleshooting

| Problem | Solution |
|---------|----------|
| MySQL connection failed | Make sure MySQL is running. Check `DB_CONFIG` credentials in `server.py` |
| API key not working | Make sure there are no spaces around the key. Restart the server after changing |
| GIFs not loading | Check your Giphy API key in `app.js` |
| Voice call connects but no audio | Add TURN server credentials in `app.js`. Check browser console for ICE errors |
| Microphone access denied | Make sure you're on HTTPS (use ngrok). Click Allow in the browser popup |
| Session lost on restart | Set a fixed `app.secret_key` in `server.py` instead of a random one |
| Encrypted files unreadable | Never change `ENCRYPTION_KEY` after saving voice messages |

---

##  Team

| Role | Responsibilities |
|------|-----------------|
| **Person 1** — Backend Developer | Flask server, WebSocket, MySQL, sessions, AI chatbot, voice encryption |
| **Person 2** — Frontend HTML/CSS | Page structure, dark theme, animations, call UI, GIF picker |
| **Person 3** — Frontend JavaScript | WebSocket client, WebRTC, MediaRecorder, Giphy integration |
| **Person 4** — DevOps & Integration | MySQL setup, ngrok, TURN server, environment variables, testing |

---

##  License

This project was built for educational purposes.

---

<div align="center">
  Built with Python, Flask, WebSocket, WebRTC & vanilla JavaScript
</div>
