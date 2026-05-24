const http = require('http');
const fs = require('fs');
const path = require('path');
const dns = require('dns');
try {
    dns.setServers(['8.8.8.8', '1.1.1.1']);
} catch (e) {}
const { WebSocketServer } = require('ws');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const zlib = require('zlib');

const PORT = process.env.PORT || 3001;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://Divi_01:Divi123@cluster0.tpjds.mongodb.net/filedrop?retryWrites=true&w=majority&appName=Cluster0';

// Connect to MongoDB
mongoose.connect(MONGODB_URI)
    .then(() => console.log('Connected to MongoDB successfully.'))
    .catch(err => console.error('Failed to connect to MongoDB:', err));

// User Schema
const userSchema = new mongoose.Schema({
    mobile: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    createdAt: { type: Date, default: Date.now }
});
const User = mongoose.model('User', userSchema);

// Contact (Connected Device) Schema
const contactSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    contactMobile: { type: String, required: true },
    alias: { type: String },
    createdAt: { type: Date, default: Date.now }
});
contactSchema.index({ userId: 1, contactMobile: 1 }, { unique: true });
const Contact = mongoose.model('Contact', contactSchema);

// History Schema
const historySchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    fileName: { type: String, required: true },
    fileSize: { type: Number, required: true },
    direction: { type: String, enum: ['sent', 'received'], required: true },
    peerMobile: { type: String, required: true },
    status: { type: String, enum: ['success', 'failed'], default: 'success' },
    createdAt: { type: Date, default: Date.now }
});
const History = mongoose.model('History', historySchema);

// Helper to authenticate request
async function getAuthUser(req) {
    const userMobile = req.headers['x-user-mobile'];
    if (!userMobile) return null;
    return await User.findOne({ mobile: userMobile });
}

// Create HTTP server serving APIs and static index.html
const server = http.createServer((req, res) => {
    // Enable CORS for cross-origin requests (e.g. from the Capacitor app)
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-user-mobile');

    // Handle OPTIONS preflight requests
    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }
    // --- Register API ---
    if (req.method === 'POST' && req.url === '/api/register') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
            try {
                const { mobile, password } = JSON.parse(body);
                if (!mobile || !password) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Mobile number and password are required' }));
                    return;
                }

                const existingUser = await User.findOne({ mobile });
                if (existingUser) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Mobile number already registered' }));
                    return;
                }

                const hashedPassword = await bcrypt.hash(password, 10);
                const user = new User({ mobile, password: hashedPassword });
                await user.save();

                res.writeHead(201, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, message: 'Registration successful' }));
            } catch (err) {
                console.error('Registration Error:', err);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Internal server error during registration' }));
            }
        });
        return;
    }

    // --- Login API ---
    if (req.method === 'POST' && req.url === '/api/login') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
            try {
                const { mobile, password } = JSON.parse(body);
                if (!mobile || !password) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Mobile number and password are required' }));
                    return;
                }

                const user = await User.findOne({ mobile });
                if (!user || !(await bcrypt.compare(password, user.password))) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Invalid mobile number or password' }));
                    return;
                }

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, mobile: user.mobile }));
            } catch (err) {
                console.error('Login Error:', err);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Internal server error during login' }));
            }
        });
        return;
    }

    // --- Contacts: GET ---
    if (req.method === 'GET' && req.url === '/api/contacts') {
        getAuthUser(req).then(async user => {
            if (!user) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Unauthorized' }));
                return;
            }
            try {
                const contacts = await Contact.find({ userId: user._id }).sort({ createdAt: -1 });
                const result = contacts.map(c => ({
                    mobile: c.contactMobile,
                    alias: c.alias || '',
                    isOnline: !!clients[c.contactMobile]
                }));
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(result));
            } catch (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Server error' }));
            }
        }).catch(err => {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Server auth error' }));
        });
        return;
    }

    // --- Contacts: POST ---
    if (req.method === 'POST' && req.url === '/api/contacts') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
            try {
                const user = await getAuthUser(req);
                if (!user) {
                    res.writeHead(401, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Unauthorized' }));
                    return;
                }

                const { contactMobile, alias } = JSON.parse(body);
                if (!contactMobile) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Contact mobile number is required' }));
                    return;
                }

                // Verify contact mobile is a registered user
                const targetUser = await User.findOne({ mobile: contactMobile });
                if (!targetUser) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Mobile number is not registered on FileDrop' }));
                    return;
                }

                // Prevent adding yourself
                if (contactMobile === user.mobile) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'You cannot add your own device' }));
                    return;
                }

                // Check if already exists
                const existing = await Contact.findOne({ userId: user._id, contactMobile });
                if (existing) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Device is already connected' }));
                    return;
                }

                const contact = new Contact({
                    userId: user._id,
                    contactMobile,
                    alias: alias || ''
                });
                await contact.save();

                res.writeHead(201, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, message: 'Device connected successfully' }));
            } catch (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Server error' }));
            }
        });
        return;
    }

    // --- Contacts: DELETE ---
    if (req.method === 'DELETE' && req.url.startsWith('/api/contacts/')) {
        getAuthUser(req).then(async user => {
            if (!user) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Unauthorized' }));
                return;
            }
            try {
                const contactMobile = req.url.split('/').pop();
                if (!contactMobile) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Mobile number required' }));
                    return;
                }

                await Contact.deleteOne({ userId: user._id, contactMobile });
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, message: 'Device disconnected successfully' }));
            } catch (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Server error' }));
            }
        }).catch(err => {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Server auth error' }));
        });
        return;
    }

    // --- Online Users Scan API ---
    if (req.method === 'GET' && req.url === '/api/online-users') {
        getAuthUser(req).then(async user => {
            if (!user) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Unauthorized' }));
                return;
            }
            try {
                const onlineMobiles = Object.keys(clients).filter(m => m !== user.mobile);
                const onlineUsers = await User.find({ mobile: { $in: onlineMobiles } });
                const result = onlineUsers.map(u => ({
                    mobile: u.mobile,
                    isOnline: true
                }));
                
                onlineMobiles.forEach(m => {
                    if (!result.find(r => r.mobile === m)) {
                        result.push({ mobile: m, isOnline: true });
                    }
                });

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(result));
            } catch (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Server error' }));
            }
        }).catch(err => {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Server auth error' }));
        });
        return;
    }

    // --- History: GET ---
    if (req.method === 'GET' && req.url === '/api/history') {
        getAuthUser(req).then(async user => {
            if (!user) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Unauthorized' }));
                return;
            }
            try {
                const logs = await History.find({ userId: user._id }).sort({ createdAt: -1 }).limit(50);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(logs));
            } catch (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Server error' }));
            }
        }).catch(err => {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Server auth error' }));
        });
        return;
    }

    // --- History: DELETE ---
    if (req.method === 'DELETE' && req.url === '/api/history') {
        getAuthUser(req).then(async user => {
            if (!user) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Unauthorized' }));
                return;
            }
            try {
                await History.deleteMany({ userId: user._id });
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, message: 'History cleared successfully' }));
            } catch (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Server error' }));
            }
        }).catch(err => {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Server auth error' }));
        });
        return;
    }

    // --- History: POST ---
    if (req.method === 'POST' && req.url === '/api/history') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
            try {
                const user = await getAuthUser(req);
                if (!user) {
                    res.writeHead(401, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Unauthorized' }));
                    return;
                }

                const { fileName, fileSize, direction, peerMobile, status } = JSON.parse(body);
                if (!fileName || !fileSize || !direction || !peerMobile) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Missing required parameters' }));
                    return;
                }

                const log = new History({
                    userId: user._id,
                    fileName,
                    fileSize,
                    direction,
                    peerMobile,
                    status: status || 'success'
                });
                await log.save();

                res.writeHead(201, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true }));
            } catch (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Server error' }));
            }
        });
        return;
    }

    // --- Static File Server ---
    const pathname = req.url.split('?')[0];
    let filePath = path.join(__dirname, pathname === '/' ? 'index.html' : pathname);

    if (!filePath.startsWith(__dirname)) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('403 Forbidden');
        return;
    }

    fs.readFile(filePath, (err, content) => {
        if (err) {
            if (err.code === 'ENOENT') {
                res.writeHead(404, { 'Content-Type': 'text/plain' });
                res.end('404 Not Found');
            } else {
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end('500 Internal Server Error');
            }
        } else {
            const ext = path.extname(filePath).toLowerCase();
            let contentType = 'text/html';
            if (ext === '.js') contentType = 'text/javascript';
            if (ext === '.css') contentType = 'text/css';
            if (ext === '.json') contentType = 'application/json';
            if (ext === '.png') contentType = 'image/png';

            const acceptEncoding = req.headers['accept-encoding'] || '';
            if (acceptEncoding.includes('gzip')) {
                zlib.gzip(content, (zlibErr, compressed) => {
                    if (zlibErr) {
                        res.writeHead(500, { 'Content-Type': 'text/plain' });
                        res.end('500 Compression Error');
                    } else {
                        res.writeHead(200, {
                            'Content-Type': contentType,
                            'Content-Encoding': 'gzip'
                        });
                        res.end(compressed);
                    }
                });
            } else {
                res.writeHead(200, { 'Content-Type': contentType });
                res.end(content);
            }
        }
    });
});

const wss = new WebSocketServer({ server });
const clients = {}; // mobile -> WebSocket
const rooms = {}; // roomKey -> { sender, receiver, offer, senderCandidates, receiverCandidates }

wss.on('connection', ws => {
    ws.on('message', raw => {
        try {
            const msg = JSON.parse(raw);
            const { type, room } = msg;

            if (type === 'auth') {
                const { mobile } = msg;
                if (!mobile) return;
                ws.mobile = mobile;
                clients[mobile] = ws;
                console.log(`User registered on WebSocket: ${mobile}`);
                return;
            }

            if (type === 'initiate-transfer') {
                const { sender, target } = msg;
                console.log(`initiate-transfer: from=${sender} to=${target}`);
                const targetWs = clients[target];

                if (!targetWs) {
                    console.log(`initiate-transfer: Recipient ${target} is offline`);
                    ws.send(JSON.stringify({ type: 'error', message: 'Recipient is offline' }));
                    return;
                }

                const roomKey = `${sender}-${target}-${Date.now()}`;

                rooms[roomKey] = {
                    sender: ws,
                    receiver: targetWs,
                    offer: null,
                    senderCandidates: [],
                    receiverCandidates: []
                };

                console.log(`initiate-transfer: Created room ${roomKey}`);

                targetWs.send(JSON.stringify({
                    type: 'incoming-transfer',
                    sender,
                    room: roomKey
                }));

                ws.send(JSON.stringify({
                    type: 'transfer-initiated',
                    room: roomKey
                }));
                return;
            }

            if (type === 'offer') {
                console.log(`offer: Received offer for room ${room}`);
                const r = rooms[room];
                if (r) {
                    r.offer = msg;
                    if (r.receiver) {
                        console.log(`offer: Forwarding offer to receiver`);
                        r.receiver.send(raw.toString());
                    } else {
                        console.log(`offer: Receiver is not available in room`);
                    }
                } else {
                    console.log(`offer: Room ${room} not found`);
                }
            }

            if (type === 'answer') {
                console.log(`answer: Received answer for room ${room}`);
                const r = rooms[room];
                if (r) {
                    if (r.sender) {
                        console.log(`answer: Forwarding answer to sender`);
                        r.sender.send(raw.toString());
                    } else {
                        console.log(`answer: Sender is not available in room`);
                    }
                    if (r.receiverCandidates && r.receiverCandidates.length > 0) {
                        console.log(`answer: Forwarding ${r.receiverCandidates.length} queued receiver candidates`);
                        for (const candMsg of r.receiverCandidates) {
                            r.sender.send(JSON.stringify(candMsg));
                        }
                    }
                } else {
                    console.log(`answer: Room ${room} not found`);
                }
            }

            if (type === 'ice') {
                console.log(`ice: Received ICE candidate from ${ws.mobile || 'unknown'} for room ${room}`);
                const r = rooms[room];
                if (!r) {
                    console.log(`ice: Room ${room} not found`);
                    return;
                }
                const targetSocket = (ws === r.sender) ? r.receiver : r.sender;

                if (targetSocket) {
                    console.log(`ice: Direct forwarding candidate to ${targetSocket.mobile || 'peer'}`);
                    targetSocket.send(raw.toString());
                } else {
                    if (ws === r.sender) {
                        console.log(`ice: Queueing sender candidate`);
                        r.senderCandidates.push(msg);
                    } else {
                        console.log(`ice: Queueing receiver candidate`);
                        r.receiverCandidates.push(msg);
                    }
                }
            }

            if (type && type.startsWith('relay-')) {
                console.log(`relay: Forwarding message type ${type} for room ${room}`);
                const r = rooms[room];
                if (r) {
                    const targetSocket = (ws === r.sender) ? r.receiver : r.sender;
                    if (targetSocket) {
                        targetSocket.send(raw.toString());
                    }
                }
            }

            if (type === 'close-room') {
                console.log(`close-room: Cleaning up room ${room}`);
                if (rooms[room]) {
                    delete rooms[room];
                }
                return;
            }
        } catch (e) {
            console.error('Error handling WebSocket message:', e);
        }
    });

    ws.on('close', () => {
        if (ws.mobile && clients[ws.mobile] === ws) {
            console.log(`User went offline: ${ws.mobile}`);
            delete clients[ws.mobile];
        }

        for (const k in rooms) {
            const r = rooms[k];
            if (r.sender === ws || r.receiver === ws) {
                const peer = (ws === r.sender) ? r.receiver : r.sender;
                if (peer) {
                    try {
                        peer.send(JSON.stringify({ type: 'peer-disconnected' }));
                    } catch (e) {}
                }
                delete rooms[k];
            }
        }
    });
});

server.listen(PORT, () => {
    console.log(`Server is running at http://localhost:${PORT}`);
});