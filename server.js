require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');
const app = express();

// ── Local session store (persists names/notes/keymode since Hyperbeam API never returns metadata) ──
const STORE_PATH = path.join(__dirname, 'sessions-store.json');
function loadStore() {
    try { return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8')); } catch { return {}; }
}
function saveStore(store) {
    try { fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2)); } catch (e) { console.error('Store write error:', e); }
}
function storeSession(id, meta) {
    const s = loadStore(); s[id] = meta; saveStore(s);
}
function removeSession(id) {
    const s = loadStore(); delete s[id]; saveStore(s);
}
function getStoredSession(id) {
    return loadStore()[id] || {};
}

const PORT = process.env.PORT || 5000;

const HB_API_KEY  = process.env.HB_API_KEY;
const HB_TEST_KEY = process.env.HB_TEST_KEY;
const HB_PROD_KEY = process.env.HB_PROD_KEY;

if (!HB_TEST_KEY && !HB_PROD_KEY && !HB_API_KEY) {
    console.error('At least one Hyperbeam API key (HB_TEST_KEY, HB_PROD_KEY, or HB_API_KEY) is required.');
    process.exit(1);
}

function getKey(keymode) {
    if (keymode === 'prod' && HB_PROD_KEY) return HB_PROD_KEY;
    if (keymode === 'test' && HB_TEST_KEY) return HB_TEST_KEY;
    // fallback chain
    return HB_TEST_KEY || HB_PROD_KEY || HB_API_KEY;
}

// CORS and security headers — must be registered before all routes
app.use((req, res, next) => {
    // Allow cross-origin requests (required for the Hyperbeam SDK loaded from unpkg.com)
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');

    // Content Security Policy:
    //   script-src  — allow inline scripts and the Hyperbeam SDK from unpkg.com
    //   frame-src   — allow Hyperbeam session iframes from *.hyperbeam.com
    //   connect-src — allow fetch/XHR and WebSocket (wss://) to the Hyperbeam engine API
    res.setHeader(
        'Content-Security-Policy',
        [
            "default-src 'self'",
            "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: https://unpkg.com https://replit-cdn.com",
            "frame-src https://*.hyperbeam.com https://*.replit.dev https://*.replit.co",
            "connect-src 'self' https://engine.hyperbeam.com https://*.hyperbeam.com wss://*.hyperbeam.com",
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data:",
            "media-src 'self' https://*.hyperbeam.com",
            "worker-src blob:",
            "frame-ancestors *"
        ].join('; ')
    );

    // Handle pre-flight OPTIONS requests immediately
    if (req.method === 'OPTIONS') {
        return res.sendStatus(204);
    }

    next();
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/get-browser-session', async (req, res) => {
    const hbHeaders = {
        "Authorization": `Bearer ${getKey(req.query.keymode)}`,
        "Content-Type": "application/json"
    };
    try {
        const width    = parseInt(req.query.width)  || 1280;
        const height   = parseInt(req.query.height) || 720;
        const fps      = parseInt(req.query.fps)    || 30;
        const startUrl     = req.query.url     || 'https://www.google.com';
        const sessionName  = req.query.name    || 'Untitled Session';
        const sessionNote  = req.query.note    || '';
        const keymode      = req.query.keymode || 'test';

        console.log(`Creating Hyperbeam session (${width}x${height} @ ${fps}fps — ${startUrl}) name="${sessionName}" keymode="${keymode}"`);
        const response = await fetch("https://engine.hyperbeam.com/v0/vm", {
            method: "POST",
            headers: hbHeaders,
            body: JSON.stringify({
                width, height, fps,
                start_url: startUrl,
                metadata: {
                    name: sessionName,
                    note: sessionNote,
                    keymode,
                    created_at: new Date().toISOString()
                }
            })
        });

        const raw = await response.text();
        if (!response.ok) {
            console.error("Hyperbeam API error", response.status, raw);
            return res.status(500).json({ message: "Hyperbeam API error", status: response.status, body: raw });
        }
        const data = JSON.parse(raw);
        console.log("Hyperbeam session created:", data.session_id);
        // Save locally since Hyperbeam never returns metadata on GET
        storeSession(data.session_id, { name: sessionName, note: sessionNote, keymode, created_at: new Date().toISOString() });
        res.json(data);
    } catch (err) {
        console.error("Fetch error:", err);
        res.status(500).json({ error: err.message });
    }
});

// Close a single session by ID
app.delete('/close-session/:id', async (req, res) => {
    try {
        const response = await fetch(`https://engine.hyperbeam.com/v0/vm/${req.params.id}`, {
            method: "DELETE",
            headers: { "Authorization": `Bearer ${getKey(req.query.keymode)}` }
        });
        removeSession(req.params.id);
        const text = await response.text();
        res.status(response.status).json(text ? JSON.parse(text) : { ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get full details (including embed_url) for a single session
app.get('/get-session/:id', async (req, res) => {
    try {
        const response = await fetch(`https://engine.hyperbeam.com/v0/vm/${req.params.id}`, {
            method: "GET",
            headers: { "Authorization": `Bearer ${getKey(req.query.keymode)}`, "Content-Type": "application/json" }
        });
        const data = await response.json();
        if (!response.ok) return res.status(response.status).json(data);
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/get-active-sessions', async (req, res) => {
    try {
        const response = await fetch("https://engine.hyperbeam.com/v0/vm", {
            method: "GET",
            headers: {
                "Authorization": `Bearer ${getKey(req.query.keymode)}`,
                "Content-Type": "application/json"
            }
        });

        const raw = await response.text();
        let data;
        try {
            data = raw ? JSON.parse(raw) : {};
        } catch (parseErr) {
            return res.status(500).json({
                message: "Failed to parse response",
                body: raw
            });
        }

        if (!response.ok) {
            return res.status(response.status).json({
                message: "Hyperbeam active sessions error",
                body: data
            });
        }

        const sessions = Array.isArray(data) ? data
            : Array.isArray(data.results) ? data.results : [];

        // Enrich from local store (Hyperbeam never returns metadata on GET)
        const store = loadStore();
        const enriched = sessions.map(s => {
            const id = s.session_id || s.id;
            const local = store[id] || {};
            return { ...s, session_id: id, metadata: local };
        });

        res.json(enriched);
    } catch (err) {
        console.error("Fetch error:", err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/close-all-sessions', async (req, res) => {
    console.log('Received request to close all sessions');
    const key = getKey(req.query.keymode);
    try {
        const listResponse = await fetch("https://engine.hyperbeam.com/v0/vm", {
            method: "GET",
            headers: {
                "Authorization": `Bearer ${key}`,
                "Content-Type": "application/json"
            }
        });

        const listRaw = await listResponse.text();
        let listData;
        try {
            listData = listRaw ? JSON.parse(listRaw) : {};
        } catch (parseErr) {
            return res.status(500).json({
                message: "Failed to parse sessions list",
                body: listRaw
            });
        }

        if (!listResponse.ok) {
            return res.status(listResponse.status).json({
                message: "Hyperbeam error",
                body: listData
            });
        }

        const sessions = Array.isArray(listData)
            ? listData
            : Array.isArray(listData.results)
                ? listData.results
                : Array.isArray(listData.sessions)
                    ? listData.sessions
                    : [];

        if (sessions.length === 0) {
            return res.json({ message: "No active sessions found", closed: [] });
        }

        const deleteResults = await Promise.all(sessions.map(async (session) => {
            const sessionId = session.session_id || session.id || session.sessionId;
            if (!sessionId) {
                return { session, success: false, error: "Missing session_id" };
            }

            const deleteResponse = await fetch(`https://engine.hyperbeam.com/v0/vm/${sessionId}`, {
                method: "DELETE",
                headers: {
                    "Authorization": `Bearer ${key}`,
                    "Content-Type": "application/json"
                }
            });

            const deleteRaw = await deleteResponse.text();
            let deleteData;
            try {
                deleteData = deleteRaw ? JSON.parse(deleteRaw) : {};
            } catch {
                deleteData = { raw: deleteRaw };
            }

            removeSession(sessionId);
            return {
                session_id: sessionId,
                status: deleteResponse.status,
                body: deleteData,
                success: deleteResponse.ok
            };
        }));

        res.json({ message: "Close-all-sessions completed", results: deleteResults });
    } catch (err) {
        console.error("Fetch error:", err);
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
