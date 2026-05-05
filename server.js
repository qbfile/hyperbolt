require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const app = express();

// ── Storage configuration ──
const STORAGE_DIR = '/data';

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

// ── Helper function to format bytes ──
function formatBytes(bytes) {
    if (!bytes || bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// ── Serve static files from /data ──
app.use('/storage-files', express.static(STORAGE_DIR));

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

// ── Download Manager Routes ──

// POST /download-to-hf — Download a file from URL and save to /data
app.post('/download-to-hf', express.json(), async (req, res) => {
    const { url, folder, customName } = req.body;

    if (!url) {
        return res.status(400).json({ success: false, error: 'URL is required' });
    }

    try {
        // Determine filename
        let fileName = customName;

        if (!fileName) {
            // Try HEAD request for Content-Disposition
            try {
                const headRes = await axios.head(url, { timeout: 5000 });
                const disposition = headRes.headers['content-disposition'];
                if (disposition) {
                    const match = disposition.match(/filename[^;=\n]*=(["\']?)([^"\';]*)\1/);
                    if (match && match[2]) {
                        fileName = match[2].trim();
                    }
                }
            } catch (e) {
                // HEAD might fail, continue with URL parsing
            }

            // If still no filename, parse URL
            if (!fileName) {
                const urlParts = url.split('/').filter(p => p);
                const skipWords = ['download', 'api', 'files', 'get', 'fetch', 'resolve', 'main'];
                
                // Walk backwards through URL path segments
                for (let i = urlParts.length - 1; i >= 0; i--) {
                    let segment = decodeURIComponent(urlParts[i]);
                    
                    // Remove query params
                    segment = segment.split('?')[0];
                    
                    // Check if it has a file extension
                    const hasExtension = /\.[a-zA-Z0-9]{2,}$/.test(segment);
                    
                    if (hasExtension && !skipWords.includes(segment.toLowerCase())) {
                        // Remove encoding artifacts like "encoded%3A" or "encoded:"
                        segment = segment.replace(/encoded[:%]/g, '');
                        fileName = segment;
                        break;
                    }
                }

                // Fallback
                if (!fileName) {
                    fileName = `file_${Date.now()}`;
                }
            }
        }

        // Ensure filename is safe
        fileName = fileName.replace(/[<>:"|?*]/g, '_').replace(/\s+/g, '_');

        // Determine save path
        const subdir = folder ? folder.replace(/[^a-zA-Z0-9\-_]/g, '') : '';
        const savePath = subdir 
            ? path.join(STORAGE_DIR, subdir, fileName)
            : path.join(STORAGE_DIR, fileName);

        // Security check
        if (!savePath.startsWith(STORAGE_DIR)) {
            return res.status(403).json({ success: false, error: 'Invalid save path' });
        }

        // Ensure directory exists
        const saveDir = path.dirname(savePath);
        if (!fs.existsSync(saveDir)) {
            fs.mkdirSync(saveDir, { recursive: true });
        }

        // Respond immediately with success
        res.json({ success: true, fileName, savePath });

        // Download in background
        (async () => {
            try {
                const response = await axios.get(url, { responseType: 'stream', timeout: 60000 });
                response.data.pipe(fs.createWriteStream(savePath));
                response.data.on('end', () => {
                    console.log(`Downloaded: ${fileName} to ${savePath}`);
                });
                response.data.on('error', (err) => {
                    console.error(`Download error for ${fileName}:`, err);
                    try { fs.unlinkSync(savePath); } catch {}
                });
            } catch (err) {
                console.error(`Failed to download ${url}:`, err.message);
                try { fs.unlinkSync(savePath); } catch {}
            }
        })();
    } catch (err) {
        console.error('Download error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// GET /list-hf-files — List all files in /data directory
app.get('/list-hf-files', (req, res) => {
    try {
        const files = [];

        function walk(dir, relPath = '') {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            entries.forEach(entry => {
                const fullPath = path.join(dir, entry.name);
                const urlPath = relPath ? `${relPath}/${entry.name}` : entry.name;

                if (entry.isDirectory()) {
                    walk(fullPath, urlPath);
                } else if (entry.isFile()) {
                    const stats = fs.statSync(fullPath);
                    files.push({
                        name: entry.name,
                        filePath: fullPath,
                        urlPath,
                        size: stats.size,
                        sizeFormatted: formatBytes(stats.size),
                        created: new Date(stats.birthtime).toLocaleString(),
                        downloadUrl: `/storage-files/${urlPath}`
                    });
                }
            });
        }

        if (!fs.existsSync(STORAGE_DIR)) {
            return res.json([]);
        }

        walk(STORAGE_DIR);
        res.json(files);
    } catch (err) {
        console.error('List files error:', err);
        res.status(500).json({ error: err.message });
    }
});

// DELETE /delete-hf-file — Delete a file from /data
app.delete('/delete-hf-file', express.json(), (req, res) => {
    const { filePath } = req.body;

    if (!filePath) {
        return res.status(400).json({ success: false, error: 'filePath is required' });
    }

    // Security check
    if (!filePath.startsWith(STORAGE_DIR)) {
        return res.status(403).json({ success: false, error: 'Invalid file path' });
    }

    try {
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            console.log(`Deleted: ${filePath}`);
            res.json({ success: true, message: 'File deleted' });
        } else {
            res.status(404).json({ success: false, error: 'File not found' });
        }
    } catch (err) {
        console.error('Delete error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
