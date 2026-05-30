const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';

let roomActiveUsers = {};
let globalOnlineUsers = {}; // username -> active socket count
let usernameSocketIds = {}; // username -> set of socket IDs

// Helper: emit to all sockets of a username
const emitToUser = (username, event, payload) => {
    const set = usernameSocketIds[username];
    if (!set) return;
    set.forEach((socketId) => io.to(socketId).emit(event, payload));
};
const PORT = 3000;
const uploadsDir = path.join(__dirname, 'uploads');

if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

const storage = multer.diskStorage({
    destination: uploadsDir,
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
        const ext = path.extname(file.originalname);
        cb(null, `${file.fieldname}-${uniqueSuffix}${ext}`);
    }
});

const upload = multer({
    storage,
    limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB limit
    fileFilter: (req, file, cb) => {
        const allowed = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif'];
        cb(null, allowed.includes(file.mimetype));
    }
});

// Local MongoDB Database se connect karne ka code (localhost ki jagah 127.0.0.1 kiya)
mongoose.connect('mongodb://127.0.0.1:27017/chatDB')
    .then(() => console.log('Local MongoDB database se connection ho gaya! 💾💻'))
    .catch((err) => console.error('Local database connect nahi hua:', err));

// Database me message save karne ka format (Schema) design kiya
const messageSchema = new mongoose.Schema({
    user: String,
    from: String,
    to: String,
    text: String,
    image: String,
    room: String,
    isPrivate: { type: Boolean, default: false },
    isRead: { type: Boolean, default: false },
    status: { type: String, enum: ['sent', 'delivered', 'read'], default: 'sent' },
    isEdited: { type: Boolean, default: false },
    editedAt: Date,
    timestamp: { type: Date, default: Date.now }
});

// User Account ka format (Schema) design kiya
const userSchema = new mongoose.Schema({
    username: { type: String, unique: true, required: true, lowercase: true, trim: true },
    password: { type: String, required: true },
    avatar: { type: String, default: null },
    about: { type: String, default: '' },
    phone: { type: String, default: '' },
    email: { type: String, default: '' },
    lastSeen: { type: Date, default: Date.now }
});

userSchema.pre('save', async function() {
    if (this.username) {
        this.username = this.username.trim().toLowerCase();
    }
});

const User = mongoose.model('User', userSchema);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));
app.use('/uploads', express.static(uploadsDir));

const normalizeUsername = (value) => typeof value === 'string' ? value.trim().toLowerCase() : '';

messageSchema.pre('save', async function() {
    this.user = normalizeUsername(this.user);
    this.from = normalizeUsername(this.from);
    this.to = normalizeUsername(this.to);
    this.text = typeof this.text === 'string' ? this.text.trim() : this.text;
    this.room = typeof this.room === 'string' ? this.room.trim() : this.room;
});

const Message = mongoose.model('Message', messageSchema);

// JWT Middleware
const verifyToken = (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
        return res.status(401).json({ success: false, message: 'Token required' });
    }
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded;
        next();
    } catch (err) {
        res.status(401).json({ success: false, message: 'Invalid or expired token' });
    }
};

// Sanitize function to prevent XSS
const sanitize = (text) => {
    if (typeof text !== 'string') return text;
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\"/g, '&quot;')
        .replace(/'/g, '&#x27;')
        .trim();
};

const getUnreadCountsForUser = async (username) => {
    const normalizedUser = normalizeUsername(username);
    if (!normalizedUser) return {};
    const counts = await Message.aggregate([
        { $match: { isPrivate: true, to: normalizedUser, isRead: false } },
        { $group: { _id: '$from', count: { $sum: 1 } } }
    ]);
    return counts.reduce((acc, item) => {
        acc[normalizeUsername(item._id)] = item.count;
        return acc;
    }, {});
};

app.post('/upload-image', upload.single('image'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ success: false, message: 'Image upload failed.' });
    }
    const imageUrl = `/uploads/${req.file.filename}`;
    res.json({ success: true, url: imageUrl });
});

app.use((err, req, res, next) => {
    if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ success: false, message: 'Image size should be 5MB or less.' });
    }
    if (err instanceof multer.MulterError) {
        return res.status(400).json({ success: false, message: err.message });
    }
    next(err);
});

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

// PROFILE: get current user profile
app.get('/profile', verifyToken, async (req, res) => {
    try {
        const user = await User.findOne({ username: req.user.username }).select('-password');
        if (!user) return res.status(404).json({ success: false, message: 'User not found' });
        res.json({ success: true, user });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Error fetching profile' });
    }
});

// PROFILE UPDATE (about + avatar)
app.post('/profile', verifyToken, upload.single('avatar'), async (req, res) => {
    try {
        const updates = {};
        if (req.body.about) updates.about = sanitize(req.body.about);
        if (req.body.phone) updates.phone = sanitize(req.body.phone);
        if (req.body.email) updates.email = sanitize(req.body.email);
        if (req.file) updates.avatar = `/uploads/${req.file.filename}`;
        updates.lastSeen = new Date();
        const user = await User.findOneAndUpdate({ username: req.user.username }, { $set: updates }, { new: true }).select('-password');
        res.json({ success: true, user });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Profile update failed' });
    }
});

// SEARCH MESSAGES
app.get('/search/messages', verifyToken, async (req, res) => {
    const q = req.query.q || '';
    if (!q) return res.json({ success: true, results: [] });
    try {
        const regex = new RegExp(q, 'i');
        const results = await Message.find({ text: regex }).sort({ timestamp: -1 }).limit(50);
        res.json({ success: true, results });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Search failed' });
    }
});

// SEARCH USERS
app.get('/search/users', verifyToken, async (req, res) => {
    const q = req.query.q || '';
    try {
        const regex = new RegExp(q, 'i');
        const users = await User.find({ username: regex }).select('username avatar about');
        res.json({ success: true, results: users });
    } catch (err) {
        res.status(500).json({ success: false, message: 'User search failed' });
    }
});

// SIGNUP ROUTE: Naya account banane ke liye (with password hashing)
app.post('/signup', [
    body('username').trim().isLength({ min: 3, max: 20 }).withMessage('Username 3-20 characters hona chahiye'),
    body('password').isLength({ min: 6 }).withMessage('Password kam se kam 6 characters hona chahiye')
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.json({ success: false, message: errors.array()[0].msg });
    }

    const username = normalizeUsername(req.body.username);
    const password = req.body.password;
    
    try {
        const existingUser = await User.findOne({ username });
        if (existingUser) {
            return res.json({ success: false, message: "Username pehle se maujood hai! Koi doosra naam chuniye." });
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        const newUser = new User({ username, password: hashedPassword });
        await newUser.save();
        res.json({ success: true, message: "Account successfully ban gaya! Ab aap Login kar sakte hain." });
    } catch (err) {
        console.error('Signup error:', err);
        res.status(500).json({ success: false, message: "Signup mein koi galti hui." });
    }
});

// LOGIN ROUTE: Account verify karke JWT token dena
app.post('/login', [
    body('username').trim().notEmpty().withMessage('Username required'),
    body('password').notEmpty().withMessage('Password required')
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.json({ success: false, message: errors.array()[0].msg });
    }

    const username = normalizeUsername(req.body.username);
    const password = req.body.password;
    
    try {
        const user = await User.findOne({ username });
        if (!user) {
            return res.json({ success: false, message: "Galat Username ya Password! Kripya dobara check karein." });
        }

        const isPasswordMatch = await bcrypt.compare(password, user.password);
        if (!isPasswordMatch) {
            return res.json({ success: false, message: "Galat Username ya Password! Kripya dobara check karein." });
        }

        const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: '24h' });
        res.json({ success: true, username, token });
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ success: false, message: "Login mein koi galti hui." });
    }
});

// MESSAGE EDIT ROUTE (requires auth, owner-only)
app.post('/message/edit', verifyToken, async (req, res) => {
    try {
        const { messageId, newText } = req.body;
        const sanitizedText = sanitize(newText);
        const message = await Message.findById(messageId);
        if (!message) return res.json({ success: false, message: 'Message not found' });
        // only the sender may edit
        if (normalizeUsername(req.user.username) !== normalizeUsername(message.from)) {
            return res.status(403).json({ success: false, message: 'Not authorized to edit this message' });
        }
        message.text = sanitizedText;
        message.isEdited = true;
        message.editedAt = new Date();
        await message.save();
        if (!message) {
            return res.json({ success: false, message: 'Message not found' });
        }
        // notify involved users
        if (message.isPrivate) {
            emitToUser(message.from, 'message edited', message);
            emitToUser(message.to, 'message edited', message);
        } else if (message.room) {
            io.to(message.room).emit('message edited', message);
        }
        res.json({ success: true, message });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Error editing message' });
    }
});

// MESSAGE DELETE ROUTE (requires auth, owner-only)
app.post('/message/delete', verifyToken, async (req, res) => {
    try {
        const { messageId } = req.body;
        const message = await Message.findById(messageId);
        if (!message) {
            return res.json({ success: false, message: 'Message not found' });
        }
        // only sender may delete message for everyone
        if (normalizeUsername(req.user.username) !== normalizeUsername(message.from)) {
            return res.status(403).json({ success: false, message: 'Not authorized to delete this message' });
        }
        await Message.findByIdAndDelete(messageId);
        // notify involved users
        if (message.isPrivate) {
            emitToUser(message.from, 'message deleted', messageId);
            emitToUser(message.to, 'message deleted', messageId);
        } else if (message.room) {
            io.to(message.room).emit('message deleted', messageId);
        }
        res.json({ success: true, message: 'Message deleted' });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Error deleting message' });
    }
});

io.on('connection', (socket) => {
    let currentUsername = "Anjaan User";
    let currentRoom = ""; 

    async function broadcastUserStatus() {
        try {
            const registeredUsers = await User.find({}).sort({ username: 1 });
            const usersWithStatus = registeredUsers.map((user) => ({
                username: user.username,
                online: !!globalOnlineUsers[user.username]
            }));
            io.emit('update users list', usersWithStatus);
        } catch (err) {
            console.error('Users status update failed:', err);
            // fallback: broadcast only currently active names
            io.emit('update users list', Object.keys(globalOnlineUsers).map((username) => ({ username, online: true })));
        }
    }

    socket.on('new user', async (data) => {
        currentUsername = normalizeUsername(data.username) || "anjaan user";
        currentRoom = 'global';

        socket.join(currentRoom);
        console.log(`${currentUsername} joined global chat.`);

        globalOnlineUsers[currentUsername] = (globalOnlineUsers[currentUsername] || 0) + 1;
        usernameSocketIds[currentUsername] = usernameSocketIds[currentUsername] || new Set();
        usernameSocketIds[currentUsername].add(socket.id);

        if (!roomActiveUsers[currentRoom]) {
            roomActiveUsers[currentRoom] = {};
        }
        roomActiveUsers[currentRoom][socket.id] = currentUsername;

        try {
            const oldMessages = await Message.find({ room: currentRoom }).sort({ timestamp: 1 });
            socket.emit('chat history', oldMessages);
            const unreadCounts = await getUnreadCountsForUser(currentUsername);
            socket.emit('unread counts', unreadCounts);
        } catch (err) {
            console.error("History load karne me galti hui:", err);
        }

        await broadcastUserStatus();
        socket.to(currentRoom).emit('system notification', `${currentUsername} is room me shamil hua 👋`);
    });

    socket.on('get private history', async (data) => {
        const fromUser = normalizeUsername(data.from);
        const toUser = normalizeUsername(data.to);

        try {
            const history = await Message.find({
                isPrivate: true,
                $or: [
                    { from: fromUser, to: toUser },
                    { from: toUser, to: fromUser }
                ]
            }).sort({ timestamp: 1 });
            socket.emit('private history', history);

            await Message.updateMany({
                isPrivate: true,
                from: toUser,
                to: fromUser,
                isRead: false
            }, { $set: { isRead: true, status: 'read' } });

            const unreadCounts = await getUnreadCountsForUser(fromUser);
            socket.emit('unread counts', unreadCounts);
        } catch (err) {
            console.error('Private history load error:', err);
        }
    });

    socket.on('private message', async (data) => {
        const fromUser = normalizeUsername(data.from);
        const toUser = normalizeUsername(data.to);
        const isRecipientOnline = !!usernameSocketIds[toUser];
        const msgData = {
            user: fromUser,
            from: fromUser,
            to: toUser,
            text: data.text || "",
            image: data.image || null,
            room: null,
            isPrivate: true,
            isRead: false,
            status: isRecipientOnline ? 'delivered' : 'sent'
        };

        try {
            const newPrivateChat = new Message(msgData);
            await newPrivateChat.save();
            console.log('Private message DB me save ho gaya! ✅');

            // attach DB-generated id and timestamp so clients can reference the message
            msgData._id = newPrivateChat._id;
            msgData.timestamp = newPrivateChat.timestamp || newPrivateChat._id;

            if (usernameSocketIds[toUser]) {
                usernameSocketIds[toUser].forEach((socketId) => {
                    io.to(socketId).emit('chat message', msgData);
                });
            }
            if (usernameSocketIds[fromUser]) {
                usernameSocketIds[fromUser].forEach((socketId) => {
                    io.to(socketId).emit('chat message', msgData);
                });
            }

            const recipientUnread = await getUnreadCountsForUser(toUser);
            if (usernameSocketIds[toUser]) {
                usernameSocketIds[toUser].forEach((socketId) => {
                    io.to(socketId).emit('unread counts', recipientUnread);
                });
            }
            // emit delivery acknowledgement to sender
            emitToUser(fromUser, 'message status', { _id: newPrivateChat._id, status: newPrivateChat.status });
        } catch (error) {
            console.error('Private message save error:', error);
        }
    });

    // Delivery & read acknowledgements from clients
    socket.on('message delivered', async (data) => {
        try {
            const { messageId } = data;
            const msg = await Message.findByIdAndUpdate(messageId, { status: 'delivered' }, { new: true });
            if (msg) {
                emitToUser(msg.from, 'message delivered', msg);
            }
        } catch (err) {
            console.error('message delivered handling error:', err);
        }
    });

    socket.on('message read', async (data) => {
        try {
            const { messageId } = data;
            const msg = await Message.findByIdAndUpdate(messageId, { status: 'read', isRead: true }, { new: true });
            if (msg) {
                emitToUser(msg.from, 'message read', msg);
            }
        } catch (err) {
            console.error('message read handling error:', err);
        }
    });

    socket.on('chat message', async (data) => {
        const msgData = {
            user: data.user,
            from: data.user,
            to: null,
            text: data.text || "",
            image: data.image || null,
            room: currentRoom,
            isPrivate: false
        };

        try {
            const newChat = new Message(msgData);
            await newChat.save();
            console.log("Message DB me safely save ho gaya! ✅");
            // include db id and timestamp so clients can track/edit/delete
            msgData._id = newChat._id;
            msgData.timestamp = newChat.timestamp || newChat._id;
            io.to(currentRoom).emit('chat message', msgData);
        } catch (error) {
            console.error("Message save karne me error aaya:", error);
        }
    });

    socket.on('typing', (data) => {
        socket.to(currentRoom).emit('display typing', data);
    });

    function unregisterSocket() {
        if (usernameSocketIds[currentUsername]) {
            usernameSocketIds[currentUsername].delete(socket.id);
            if (usernameSocketIds[currentUsername].size === 0) {
                delete usernameSocketIds[currentUsername];
            }
        }
    }

    socket.on('logout', async () => {
        if (globalOnlineUsers[currentUsername]) {
            globalOnlineUsers[currentUsername] = Math.max(0, globalOnlineUsers[currentUsername] - 1);
            if (globalOnlineUsers[currentUsername] === 0) {
                delete globalOnlineUsers[currentUsername];
            }
        }

        unregisterSocket();

        if (currentRoom && roomActiveUsers[currentRoom]) {
            delete roomActiveUsers[currentRoom][socket.id];
        }

        await broadcastUserStatus();
        socket.to(currentRoom).emit('system notification', `${currentUsername} ne logout kiya.`);
    });

    socket.on('disconnect', async () => {
        if (globalOnlineUsers[currentUsername]) {
            globalOnlineUsers[currentUsername] = Math.max(0, globalOnlineUsers[currentUsername] - 1);
            if (globalOnlineUsers[currentUsername] === 0) {
                delete globalOnlineUsers[currentUsername];
            }
        }

        unregisterSocket();

        if (currentRoom && roomActiveUsers[currentRoom]) {
            delete roomActiveUsers[currentRoom][socket.id];
        }

        await broadcastUserStatus();
        socket.to(currentRoom).emit('system notification', `${currentUsername} ne room chhoda 🏃`);
    });
});

function startServer(port) {
    http.once('error', (err) => {
        if (err && err.code === 'EADDRINUSE') {
            console.warn(`Port ${port} in use, trying ${port + 1}...`);
            startServer(port + 1);
        } else {
            console.error('Server error:', err);
            process.exit(1);
        }
    });

    http.listen(port, () => {
        console.log(`Server is running on http://localhost:${port}`);
    });
}

startServer(PORT);