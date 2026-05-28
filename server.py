import json
import os
import base64
import uuid
from cryptography.fernet import Fernet
from flask import Response
import socket
import hashlib
import secrets
import threading
from dotenv import load_dotenv
try:
    import requests as http_requests
except ImportError:
    http_requests = None
import mysql.connector
from mysql.connector import Error
from datetime import datetime
from flask import Flask, send_from_directory, session, jsonify, request
from flask_sock import Sock


app = Flask(__name__, static_folder="public")
sock = Sock(app)


app.secret_key = os.environ.get("SECRET_KEY", secrets.token_hex(32))


online = {}  # { username: websocket }

DB_CONFIG = {
    "host":     "localhost",
    "port":     3306,
    "user":     "root",          
    "password": "root",  
    "database": "lanchat"        
}
load_dotenv()
GROK_API_KEY = os.getenv("API_KEY")  
GROK_MODEL   = "llama-3.3-70b-versatile"  
GROK_NAME    = "AI"                        

ENCRYPTION_KEY = os.environ.get(
    "ENCRYPTION_KEY",
    os.getenv("encr")  
)
fernet = Fernet(ENCRYPTION_KEY.encode() if isinstance(ENCRYPTION_KEY, str) else ENCRYPTION_KEY)



def hash_password(password):
    return hashlib.sha256(password.encode()).hexdigest()

def get_db():
    return mysql.connector.connect(**DB_CONFIG)


def init_db():
    # First connect without database to create it if needed
    config_no_db = {k: v for k, v in DB_CONFIG.items() if k != "database"}
    conn = mysql.connector.connect(**config_no_db)
    cursor = conn.cursor()

    cursor.execute(f"CREATE DATABASE IF NOT EXISTS `{DB_CONFIG['database']}`")
    cursor.execute(f"USE `{DB_CONFIG['database']}`")

    
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS users (
            id         INT AUTO_INCREMENT PRIMARY KEY,
            username   VARCHAR(50)  UNIQUE NOT NULL,
            password   VARCHAR(64)  NOT NULL,
            created_at DATETIME     DEFAULT CURRENT_TIMESTAMP
        )
    """)

    
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS messages (
            id         INT AUTO_INCREMENT PRIMARY KEY,
            sender     VARCHAR(50)  NOT NULL,
            receiver   VARCHAR(50)  DEFAULT NULL,  -- NULL = public message
            content    TEXT         NOT NULL,
            sent_at    DATETIME     DEFAULT CURRENT_TIMESTAMP
        )
    """)

    conn.commit()
    cursor.close()
    conn.close()
    print(" Database ready.")

# ─── DB helpers ───────────────────────────────────────────────────────────────
def db_user_exists(username):
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("SELECT 1 FROM users WHERE username = %s", (username,))
    exists = cursor.fetchone() is not None
    cursor.close()
    conn.close()
    return exists

def db_create_user(username, password):
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute(
        "INSERT INTO users (username, password) VALUES (%s, %s)",
        (username, hash_password(password))
    )
    conn.commit()
    cursor.close()
    conn.close()

def db_check_password(username, password):
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("SELECT password FROM users WHERE username = %s", (username,))
    row = cursor.fetchone()
    cursor.close()
    conn.close()
    if not row:
        return False
    return row[0] == hash_password(password)

def db_save_message(sender, content, receiver=None):
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute(
        "INSERT INTO messages (sender, receiver, content) VALUES (%s, %s, %s)",
        (sender, receiver, content)
    )
    conn.commit()
    cursor.close()
    conn.close()

def db_get_recent_messages(limit=50):
    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    cursor.execute("""
        SELECT sender, content, sent_at
        FROM messages
        WHERE receiver IS NULL
        ORDER BY sent_at DESC
        LIMIT %s
    """, (limit,))
    rows = cursor.fetchall()
    cursor.close()
    conn.close()

    
    return [
        {
            "type": "message",
            "from": r["sender"],
            "text": r["content"],
            "time": int(r["sent_at"].timestamp() * 1000)
        }
        for r in reversed(rows)
    ]


def ask_grok(question, history=[]):
    """Call the xAI Grok API and return the reply text."""
    if not GROK_API_KEY or "YOUR_GROQ_API_KEY" in GROK_API_KEY:
        return " Groq API key not set. Add your key to GROK_API_KEY in server.py"

    if not http_requests:
        return " Please run: pip install requests"

    messages = [
        {"role": "system", "content": "You are a helpful AI assistant in a LAN chat app. Keep replies concise and friendly."}
    ] + history + [
        {"role": "user", "content": question}
    ]

    try:
        resp = http_requests.post(
            "https://api.groq.com/openai/v1/chat/completions",
            headers={
                "Content-Type":  "application/json",
                "Authorization": f"Bearer {GROK_API_KEY}",
            },
            json={
                "model":       GROK_MODEL,
                "messages":    messages,
                "max_tokens":  500,
                "temperature": 0.7,
            },
            timeout=30
        )
        resp.raise_for_status()
        return resp.json()["choices"][0]["message"]["content"].strip()
    except http_requests.exceptions.HTTPError as e:
        try:
            err = e.response.json()
            return f" Groq API error {e.response.status_code}: {err}"
        except:
            return f" Groq API error: {e.response.status_code} — {e.response.text[:200]}"
    except Exception as e:
        return f" Groq error: {str(e)}"

def handle_grok_mention(sender_ws, sender_name, question):
    """Run Grok in a thread so it doesn't block the WebSocket loop."""
    def run():
       
        broadcast_all({"type": "system", "text": f"🤖 {GROK_NAME} is thinking..."})

        reply = ask_grok(question)

       
        bot_msg = {
            "type": "message",
            "from": f" {GROK_NAME}",
            "text": reply,
            "time": now_ms(),
            "bot":  True
        }
        broadcast_all(bot_msg)
        db_save_message(f"[BOT]{GROK_NAME}", reply)

    threading.Thread(target=run, daemon=True).start()


def now_ms():
    return int(datetime.now().timestamp() * 1000)

def send_json(ws, data):
    ws.send(json.dumps(data))

def broadcast(data, exclude=None):
    msg = json.dumps(data)
    for uname, ws in list(online.items()):
        if ws != exclude:
            try:
                ws.send(msg)
            except:
                pass

def broadcast_all(data):
    msg = json.dumps(data)
    for ws in list(online.values()):
        try:
            ws.send(msg)
        except:
            pass

def update_user_list():
    broadcast_all({"type": "users", "list": list(online.keys())})


@app.route("/")
def index():
    return send_from_directory("public", "index.html")

@app.route("/<path:filename>")
def static_files(filename):
    return send_from_directory("public", filename)


UPLOAD_DIR = "uploads"
os.makedirs(UPLOAD_DIR, exist_ok=True)

@app.route("/uploads/<path:filename>")
def uploaded_file(filename):
    filepath = os.path.join(UPLOAD_DIR, filename)
    if not os.path.exists(filepath):
        return "File not found", 404
    try:
        with open(filepath, "rb") as f:
            encrypted_bytes = f.read()
       
        decrypted_bytes = fernet.decrypt(encrypted_bytes)
        return Response(decrypted_bytes, mimetype="audio/webm")
    except Exception as e:
        print(f" Decrypt error: {e}")
        return "Decryption failed", 500


@app.route("/api/me")
def me():
    username = session.get("username")
    if username and db_user_exists(username):
        return jsonify({"logged_in": True, "username": username})
    return jsonify({"logged_in": False})


@app.route("/api/login", methods=["POST"])
def api_login():
    data     = request.get_json()
    username = (data.get("username") or "").strip()
    password = data.get("password") or ""

    if not username or not password:
        return jsonify({"ok": False, "error": "Username and password required."})
    if not db_user_exists(username):
        return jsonify({"ok": False, "error": "User not found."})
    if not db_check_password(username, password):
        return jsonify({"ok": False, "error": "Wrong password."})

    session["username"] = username
    session.permanent   = True          # keep session alive across browser restarts
    return jsonify({"ok": True, "username": username})


@app.route("/api/register", methods=["POST"])
def api_register():
    data     = request.get_json()
    username = (data.get("username") or "").strip()
    password = data.get("password") or ""

    if not username or not password:
        return jsonify({"ok": False, "error": "Username and password required."})
    if len(username) < 3:
        return jsonify({"ok": False, "error": "Username must be at least 3 characters."})
    if db_user_exists(username):
        return jsonify({"ok": False, "error": "Username already taken."})

    db_create_user(username, password)
    return jsonify({"ok": True})

@app.route("/api/logout", methods=["POST"])
def api_logout():
    session.clear()
    return jsonify({"ok": True})


@sock.route("/ws")
def chat(ws):
    username = None

    try:
        while True:
            raw = ws.receive()
            if raw is None:
                break

            try:
                msg = json.loads(raw)
            except:
                continue

            t = msg.get("type")

            
            if t == "register":
                uname = msg.get("username", "").strip()
                pwd   = msg.get("password", "")

                if not uname or not pwd:
                    send_json(ws, {"type": "error", "text": "Username and password required."})
                elif len(uname) < 3:
                    send_json(ws, {"type": "error", "text": "Username must be at least 3 characters."})
                elif db_user_exists(uname):
                    send_json(ws, {"type": "error", "text": "Username already taken."})
                else:
                    db_create_user(uname, pwd)
                    send_json(ws, {"type": "registered", "text": "Account created! You can now log in."})

            
            elif t == "login":
                uname = msg.get("username", "").strip()
                pwd   = msg.get("password", "")

                # Allow session resume without password (frontend sends type=session_resume)
                if not db_user_exists(uname):
                    send_json(ws, {"type": "error", "text": "User not found."})
                elif not db_check_password(uname, pwd):
                    send_json(ws, {"type": "error", "text": "Wrong password."})
                elif uname in online:
                    send_json(ws, {"type": "error", "text": "Already logged in from another window."})
                else:
                    username = uname
                    online[username] = ws

                    history = db_get_recent_messages(50)
                    send_json(ws, {"type": "history", "messages": history})
                    send_json(ws, {"type": "logged_in", "username": username})
                    broadcast({"type": "system", "text": f"{username} joined the chat 👋"}, exclude=ws)
                    update_user_list()

           
            elif t == "session_resume":
                uname = msg.get("username", "").strip()

                if not uname or not db_user_exists(uname):
                    send_json(ws, {"type": "error", "text": "Session expired. Please log in."})
                elif uname in online:
                 
                    username = uname
                    online[username] = ws
                    history = db_get_recent_messages(50)
                    send_json(ws, {"type": "history", "messages": history})
                    send_json(ws, {"type": "logged_in", "username": username})
                    update_user_list()
                else:
                    username = uname
                    online[username] = ws

                    history = db_get_recent_messages(50)
                    send_json(ws, {"type": "history", "messages": history})
                    send_json(ws, {"type": "logged_in", "username": username})
                    broadcast({"type": "system", "text": f"{username} rejoined the chat 👋"}, exclude=ws)
                    update_user_list()

          
            elif t == "message":
                if not username:
                    continue
                text = msg.get("text", "").strip()
                gif  = msg.get("gif", "").strip()
                if not text and not gif:
                    continue

                content = gif if gif else text
                db_save_message(username, content)
                entry = {"type": "message", "from": username, "text": text, "time": now_ms()}
                if gif:
                    entry["gif"] = gif
                broadcast_all(entry)

                
                if text.lower().startswith("@ai "):
                    question = text[4:].strip()
                    if question:
                        handle_grok_mention(ws, username, question)

           
            elif t == "private":
                if not username:
                    continue
                target_name = msg.get("to", "")
                text = msg.get("text", "").strip()
                gif  = msg.get("gif", "").strip()
                if not text and not gif:
                    continue

                if target_name not in online:
                    send_json(ws, {"type": "error", "text": f"{target_name} is offline."})
                else:
                    content = gif if gif else text
                    db_save_message(username, content, receiver=target_name)
                    pm = {"type": "private", "from": username, "to": target_name, "text": text, "time": now_ms()}
                    if gif:
                        pm["gif"] = gif
                    online[target_name].send(json.dumps(pm))
                    ws.send(json.dumps(pm))

            
            elif t == "call_offer":
                if not username: continue
                target = msg.get("to")
                if target in online:
                    online[target].send(json.dumps({
                        "type": "call_offer",
                        "from": username,
                        "offer": msg.get("offer")
                    }))
                else:
                    send_json(ws, {"type": "call_rejected", "reason": f"{target} is offline."})

            elif t == "call_answer":
                if not username: continue
                target = msg.get("to")
                if target in online:
                    online[target].send(json.dumps({
                        "type": "call_answer",
                        "from": username,
                        "answer": msg.get("answer")
                    }))

            elif t == "call_reject":
                if not username: continue
                target = msg.get("to")
                if target in online:
                    online[target].send(json.dumps({
                        "type": "call_rejected",
                        "from": username,
                        "reason": f"{username} declined the call."
                    }))

            elif t == "call_end":
                if not username: continue
                target = msg.get("to")
                if target in online:
                    online[target].send(json.dumps({
                        "type": "call_ended",
                        "from": username
                    }))

            elif t == "ice_candidate":
                if not username: continue
                target = msg.get("to")
                if target in online:
                    online[target].send(json.dumps({
                        "type": "ice_candidate",
                        "from": username,
                        "candidate": msg.get("candidate")
                    }))

           
            elif t == "voice":
                if not username: continue
                data = msg.get("data", "")
                if not data: continue
                try:
                    
                    header, encoded = data.split(",", 1)
                    audio_bytes = base64.b64decode(encoded)

                  
                    encrypted_bytes = fernet.encrypt(audio_bytes)

                    filename = f"{uuid.uuid4().hex}.webm"
                    filepath = os.path.join(UPLOAD_DIR, filename)
                    with open(filepath, "wb") as f:
                        f.write(encrypted_bytes)

                  
                    db_save_message(username, f"[VOICE]{filename}")

                   
                    broadcast_all({
                        "type": "voice",
                        "from": username,
                        "url":  f"/uploads/{filename}",
                        "time": now_ms()
                    })
                except Exception as e:
                    print(f" Voice save error: {e}")

    except Exception:
        pass
    finally:
        if username and online.get(username) == ws:
            del online[username]
            broadcast({"type": "system", "text": f"{username} left the chat."})
            update_user_list()


def get_local_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except:
        return "localhost"


if __name__ == "__main__":
    PORT     = 3000
    local_ip = get_local_ip()

    print("\n🔌 Connecting to MySQL...")
    try:
        init_db()
    except Error as e:
        print(f"\n MySQL connection failed: {e}")
        print("   Make sure MySQL is running and DB_CONFIG is correct in server.py\n")
        exit(1)

    print(f"\n LAN Chat Server running!")
    print(f"   Local:   http://localhost:{PORT}")
    print(f"   Network: http://{local_ip}:{PORT}")
    print(f"\n   For ngrok: ngrok http {PORT}")
    print(f"   Then share the https://xxxx.ngrok-free.app URL\n")

    app.run(host="0.0.0.0", port=PORT, debug=False)