// --- UTILITY FUNCTIONS ---
const normalizeUsername = (value) => typeof value === 'string' ? value.trim().toLowerCase() : '';
const formatTime = (timestamp) => {
    const date = new Date(timestamp);
    return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
};

const formatDate = (timestamp) => {
    const date = new Date(timestamp);
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    
    if (date.toDateString() === today.toDateString()) {
        return 'Today';
    } else if (date.toDateString() === yesterday.toDateString()) {
        return 'Yesterday';
    } else {
        return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    }
};

const shouldShowDateSeparator = (prevTimestamp, currentTimestamp) => {
    if (!prevTimestamp) return true;
    const prevDate = new Date(prevTimestamp).toDateString();
    const currentDate = new Date(currentTimestamp).toDateString();
    return prevDate !== currentDate;
};

const getStatusIcon = (status) => {
    switch(status) {
        case 'read': return '✓✓';
        case 'delivered': return '✓✓';
        case 'sent': return '✓';
        default: return '';
    }
};

// REQUEST NOTIFICATION PERMISSION
if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
}

const showNotification = (title, options = {}) => {
    if ('Notification' in window && Notification.permission === 'granted') {
        new Notification(title, {
            icon: '💬',
            badge: '💬',
            ...options
        });
    }
};

// URL aur Session Persistence Setup
const urlParams = new URLSearchParams(window.location.search);
const loggedInUser = urlParams.get('username') || sessionStorage.getItem('username');
const authToken = sessionStorage.getItem('authToken') || localStorage.getItem('authToken') || '';

// --- GLOBAL VARIABLES ---
const errorDisplay = document.getElementById('login-error');
const toggleBtn = document.getElementById('toggle-form');
const authForm = document.getElementById('auth-form');
const submitBtn = document.getElementById('submit-btn');
let isLoginMode = true;

// Agar user session ya URL se valid login hai
if (loggedInUser && authToken) {
    document.getElementById('auth-interface').style.display = 'none';
    document.getElementById('chat-interface').style.display = 'flex';
    document.body.style.backgroundColor = '#10141d';
    
    // Live Cloud Deployment Socket Connection Configuration
    const socket = io("https://hk-chat-backend.onrender.com", {
        transports: ['websocket', 'polling']
    });
    
    const username = loggedInUser;
    const roomName = 'global';
    
    const loggedInUserLabel = document.getElementById('logged-in-user');
    if (loggedInUserLabel) loggedInUserLabel.textContent = username;

    socket.emit('new user', { username: username, room: roomName });

    const form = document.getElementById('chat-form');
    const input = document.getElementById('message-input');
    const messagesList = document.getElementById('messages');
    const imageInput = document.getElementById('image-input');
    let currentPrivateTarget = localStorage.getItem('currentPrivateTarget') || null;
    let unreadCounts = {};
    let activeUsers = [];
    let messageHistory = [];
    let lastMessageDate = null;
    const normalizedLoggedInUser = username.trim().toLowerCase();

    const previewContainer = document.getElementById('preview-container');
    const imagePreview = document.getElementById('image-preview');
    const cancelPreviewBtn = document.getElementById('cancel-preview-btn');

    // MESSAGE RENDERING WITH TIMESTAMPS, AVATARS AND STATUS
    const createMessageElement = (data) => {
        const item = document.createElement('li');
        const sender = data.from || data.user;
        const isMine = sender === username;
        
        if (isMine) {
            item.classList.add('my-msg');
        } else {
            item.classList.add('other-msg');
        }

        let html = `<span class="msg-user">${isMine ? 'Aap' : sender}</span>`;
        
        if (data.text) {
            html += `<div class="msg-text">${data.text}</div>`;
        }
        
        if (data.image) {
            html += `<img src="${data.image}" class="chat-img" alt="shared media" />`;
        }

        const timeStr = formatTime(data.timestamp);
        const statusIcon = isMine ? `<span class="msg-status ${data.status}" title="${data.status}">${getStatusIcon(data.status)}</span>` : '';
        const editedLabel = data.isEdited ? '<span class="msg-edited" title="Edited">(edited)</span>' : '';
        
        html += `<div class="msg-meta">${timeStr} ${statusIcon} ${editedLabel}</div>`;

        if (isMine) {
            html += `<div class="msg-actions">
                <button class="msg-action-btn edit-btn" data-msg-id="${data._id}" title="Edit message">✏️</button>
                <button class="msg-action-btn delete-btn" data-msg-id="${data._id}" title="Delete message">🗑️</button>
            </div>`;
        }

        item.innerHTML = html;

        const editBtn = item.querySelector('.edit-btn');
        const deleteBtn = item.querySelector('.delete-btn');
        
        if (editBtn) {
            editBtn.addEventListener('click', () => editMessage(data._id, data.text));
        }
        
        if (deleteBtn) {
            deleteBtn.addEventListener('click', () => deleteMessage(data._id));
        }

        return item;
    };

    const editMessage = (messageId, currentText) => {
        const newText = prompt('Edit message:', currentText);
        if (newText && newText !== currentText) {
            fetch('https://hk-chat-backend.onrender.com/message/edit', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
                body: JSON.stringify({ messageId, newText })
            })
            .then(res => res.json())
            .then(result => {
                if (result.success) {
                    socket.emit('message edited', result.message);
                    showNotification('Message Updated', { body: 'Your message was edited' });
                } else {
                    alert('Error editing message');
                }
            })
            .catch(err => console.error('Edit error:', err));
        }
    };

    const deleteMessage = (messageId) => {
        if (confirm('Delete this message?')) {
            fetch('https://hk-chat-backend.onrender.com/message/delete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
                body: JSON.stringify({ messageId })
            })
            .then(res => res.json())
            .then(result => {
                if (result.success) {
                    socket.emit('message deleted', messageId);
                    showNotification('Message Deleted', { body: 'Your message was deleted' });
                } else {
                    alert('Error deleting message');
                }
            })
            .catch(err => console.error('Delete error:', err));
        }
    };

    const renderMessages = (messages) => {
        if (!messagesList) return;
        messagesList.innerHTML = '';
        lastMessageDate = null;

        messages.forEach((msg) => {
            if (shouldShowDateSeparator(lastMessageDate, msg.timestamp)) {
                const dateSeparator = document.createElement('li');
                dateSeparator.classList.add('date-separator');
                dateSeparator.textContent = formatDate(msg.timestamp);
                messagesList.appendChild(dateSeparator);
            }
            
            messagesList.appendChild(createMessageElement(msg));
            lastMessageDate = msg.timestamp;
        });

        messagesList.scrollTop = messagesList.scrollHeight;
    };

    const showEmptyChatNotice = () => {
        if (!messagesList) return;
        messagesList.innerHTML = '';
        const msg = document.createElement('li');
        msg.classList.add('system-msg');
        msg.textContent = 'Select a user from the sidebar to start a private chat.';
        messagesList.appendChild(msg);
        messagesList.scrollTop = messagesList.scrollHeight;
        updateChatHeader(null);
    };

    const chatWithNameEl = document.getElementById('chat-with-name');
    const chatWithStatusEl = document.getElementById('chat-with-status');
    const chatWithAvatarEl = document.getElementById('chat-with-avatar');

    const updateChatHeader = (targetUsername) => {
        if (!chatWithNameEl) return;
        if (!targetUsername) {
            chatWithNameEl.textContent = 'Select a user to start chatting';
            if (chatWithStatusEl) chatWithStatusEl.textContent = 'One-to-one private chat';
            if (chatWithAvatarEl) chatWithAvatarEl.textContent = '?';
            return;
        }

        const found = activeUsers.find(u => normalizeUsername(u.username) === normalizeUsername(targetUsername));
        const displayName = found ? found.username.toLowerCase() : targetUsername.toLowerCase();
        if (chatWithNameEl) chatWithNameEl.textContent = displayName;
        if (chatWithAvatarEl) {
            if (found && found.avatar) {
                chatWithAvatarEl.style.backgroundImage = `url(https://hk-chat-backend.onrender.com${found.avatar})`;
                chatWithAvatarEl.textContent = '';
                chatWithAvatarEl.style.backgroundSize = 'cover';
                chatWithAvatarEl.style.backgroundPosition = 'center';
            } else {
                chatWithAvatarEl.style.backgroundImage = '';
                chatWithAvatarEl.textContent = displayName.slice(0,1).toLowerCase();
            }
        }
        if (chatWithStatusEl) chatWithStatusEl.textContent = (found && found.online) ? 'Online' : 'Offline';
    };

    // PREVIEW IMAGE HANDLING
    if (imageInput) {
        imageInput.addEventListener('change', () => {
            if (imageInput.files.length > 0) {
                const file = imageInput.files[0];
                const reader = new FileReader();
                
                reader.onload = function(e) {
                    if (imagePreview && previewContainer) {
                        imagePreview.src = e.target.result;
                        previewContainer.style.display = 'block';
                        if (input) input.placeholder = "Add a caption...";
                    }
                };
                reader.readAsDataURL(file);
            }
        });
    }

    if (cancelPreviewBtn) {
        cancelPreviewBtn.addEventListener('click', () => {
            if (imageInput && imagePreview && previewContainer) {
                imageInput.value = '';
                imagePreview.src = '';
                previewContainer.style.display = 'none';
                if (input) input.placeholder = "Message...";
            }
        });
    }

    // FORM SUBMISSION FOR SENDING MESSAGES
    if (form) {
        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            
            const hasImage = imageInput && imageInput.files.length > 0;
            const textValue = input ? input.value.trim() : '';

            if (!hasImage && textValue === '') return;

            if (!currentPrivateTarget) {
                alert('Please select a user from the sidebar to start a private chat.');
                return;
            }

            if (hasImage) {
                const file = imageInput.files[0];
                const formData = new FormData();
                formData.append('image', file);

                try {
                    const response = await fetch('https://hk-chat-backend.onrender.com/upload-image', {
                        method: 'POST',
                        body: formData
                    });
                    const result = await response.json();

                    if (!result.success) {
                        alert(result.message || 'Image upload failed.');
                        return;
                    }

                    if (currentPrivateTarget) {
                        socket.emit('private message', {
                            from: username,
                            to: currentPrivateTarget,
                            text: textValue,
                            image: `https://hk-chat-backend.onrender.com${result.url}`,
                        });
                    }

                    imageInput.value = '';
                    if (imagePreview && previewContainer) {
                        imagePreview.src = '';
                        previewContainer.style.display = 'none';
                    }
                    if (input) {
                        input.value = '';
                        input.placeholder = 'Message...';
                    }
                    showNotification('Message Sent', { body: `Image sent to ${currentPrivateTarget}` });
                } catch (error) {
                    console.error('Upload error:', error);
                    alert('Image upload failed.');
                }
            } else if (textValue !== '') {
                if (currentPrivateTarget) {
                    socket.emit('private message', {
                        from: username,
                        to: currentPrivateTarget,
                        text: textValue,
                        image: null
                    });
                }
                if (input) input.value = '';
                showNotification('Message Sent', { body: `Message sent to ${currentPrivateTarget}` });
            }
        });
    }

    // TYPING INDICATOR
    const typingIndicator = document.getElementById('typing-indicator');
    let typingTimer;

    if (input) {
        input.addEventListener('input', () => {
            socket.emit('typing', { username: username, isTyping: true });
            clearTimeout(typingTimer);
            typingTimer = setTimeout(() => {
                socket.emit('typing', { username: username, isTyping: false });
            }, 1000);
        });
    }

    socket.on('display typing', (data) => {
        if (typingIndicator && data.isTyping && data.username !== username) {
            typingIndicator.textContent = `${data.username} is typing...`;
        } else if (!data.isTyping) {
            typingIndicator.textContent = "";
        }
    });

    // CHAT MESSAGE RECEIVER
    socket.off('chat message').on('chat message', (data) => {
        const sender = data.from || data.user;
        messageHistory.push(data);
        
        if (!currentPrivateTarget || 
            (normalizeUsername(sender) === normalizeUsername(currentPrivateTarget) || 
             normalizeUsername(sender) === normalizeUsername(username))) {
            const filtered = messageHistory.filter(m => {
                return (normalizeUsername(m.from || m.user) === normalizeUsername(currentPrivateTarget) || 
                        normalizeUsername(m.from || m.user) === normalizeUsername(username)) &&
                       (normalizeUsername(m.to || m.user) === normalizeUsername(username) || 
                        normalizeUsername(m.to || m.user) === normalizeUsername(currentPrivateTarget));
            });
            renderMessages(filtered);
        }

        if (sender !== username) {
            if (document.hidden) {
                showNotification(`Message from ${sender}`, { body: data.text?.substring(0, 50) || 'Image sent' });
            }
        }
    });

    // MESSAGE EDITED/DELETED EVENTS
    socket.on('message edited', (updatedMsg) => {
        const idx = messageHistory.findIndex(m => m._id === updatedMsg._id);
        if (idx !== -1) {
            messageHistory[idx] = updatedMsg;
            const filtered = messageHistory.filter(m => {
                return (normalizeUsername(m.from || m.user) === normalizeUsername(currentPrivateTarget) || 
                        normalizeUsername(m.from || m.user) === normalizeUsername(username)) &&
                       (normalizeUsername(m.to || m.user) === normalizeUsername(username) || 
                        normalizeUsername(m.to || m.user) === normalizeUsername(currentPrivateTarget));
            });
            renderMessages(filtered);
        }
    });

    socket.on('message deleted', (messageId) => {
        messageHistory = messageHistory.filter(m => m._id !== messageId);
        const filtered = messageHistory.filter(m => {
            return (normalizeUsername(m.from || m.user) === normalizeUsername(currentPrivateTarget) || 
                    normalizeUsername(m.from || m.user) === normalizeUsername(username)) &&
                   (normalizeUsername(m.to || m.user) === normalizeUsername(username) || 
                    normalizeUsername(m.to || m.user) === normalizeUsername(currentPrivateTarget));
        });
        renderMessages(filtered);
    });

    socket.off('system notification').on('system notification', (notificationText) => {
        if (!messagesList) return;
        const item = document.createElement('li');
        item.classList.add('system-msg');
        item.textContent = notificationText;
        messagesList.appendChild(item);
        messagesList.scrollTop = messagesList.scrollHeight;
    });

    socket.on('chat history', (messages) => {
        messageHistory = messages;
        showEmptyChatNotice();
    });

    socket.on('private history', (messages) => {
        messageHistory = messages;
        renderMessages(messages);
    });

    // SIDEBAR ACTIVE USERS LIST DESIGN WITH AVATARS
    const activeUsersList = document.getElementById('active-users-list');
    const searchInput = document.getElementById('search-input') || null;

    let searchTimer = null;
    if (searchInput) {
        searchInput.addEventListener('input', () => {
            clearTimeout(searchTimer);
            searchTimer = setTimeout(async () => {
                const q = searchInput.value.trim();
                if (!q) {
                    renderActiveUsers();
                    return;
                }
                try {
                    const res = await fetch(`https://hk-chat-backend.onrender.com/search/users?q=${encodeURIComponent(q)}`, { headers: { 'Authorization': `Bearer ${authToken}` } });
                    const data = await res.json();
                    if (data.success) {
                        activeUsers = data.results.map(u => ({ username: u.username, online: !!u.online, avatar: u.avatar }));
                        renderActiveUsers();
                    }
                } catch (err) {
                    console.error('Search error', err);
                }
            }, 300);
        });
    }

    const renderActiveUsers = () => {
        if (!activeUsersList) return;
        activeUsersList.innerHTML = '';

        activeUsers.forEach((user) => {
            if (normalizeUsername(user.username) === normalizedLoggedInUser) return;
            
            const li = document.createElement('li');
            li.className = 'user-item';
            
            const userBtn = document.createElement('button');
            userBtn.className = 'user-btn';
            if (normalizeUsername(user.username) === normalizeUsername(currentPrivateTarget)) {
                userBtn.classList.add('active');
                updateChatHeader(user.username);
            }
            
            const avatar = document.createElement('span');
            avatar.className = 'user-avatar';
            if (user.avatar) {
                avatar.style.backgroundImage = `url(https://hk-chat-backend.onrender.com${user.avatar})`;
                avatar.style.backgroundSize = 'cover';
                avatar.style.backgroundPosition = 'center';
            } else {
                avatar.textContent = user.username.slice(0, 1).toLowerCase();
            }
            
            const nameSpan = document.createElement('span');
            nameSpan.className = 'user-name';
            nameSpan.textContent = user.username.toLowerCase();
            
            const statusDot = document.createElement('span');
            statusDot.className = `status-dot ${user.online ? 'online' : 'offline'}`;
            statusDot.title = user.online ? 'Online' : 'Offline';
            
            userBtn.appendChild(avatar);
            userBtn.appendChild(nameSpan);
            userBtn.appendChild(statusDot);
            
            userBtn.addEventListener('click', () => {
                document.querySelectorAll('.user-btn').forEach(btn => btn.classList.remove('active'));
                currentPrivateTarget = user.username;
                localStorage.setItem('currentPrivateTarget', currentPrivateTarget);
                userBtn.classList.add('active');
                updateChatHeader(user.username);
                socket.emit('get private history', { from: username, to: user.username });
            });
            
            li.appendChild(userBtn);

            const normalizedUser = normalizeUsername(user.username);
            if (unreadCounts[normalizedUser]) {
                const badge = document.createElement('span');
                badge.className = 'unread-badge';
                badge.textContent = unreadCounts[normalizedUser];
                li.appendChild(badge);
            }

            activeUsersList.appendChild(li);
        });
    };

    socket.on('update users list', (users) => {
        if (!activeUsersList) return;
        activeUsers = users;
        renderActiveUsers();
        if (currentPrivateTarget) {
            const matched = activeUsers.find(u => normalizeUsername(u.username) === normalizeUsername(currentPrivateTarget));
            if (matched) {
                socket.emit('get private history', { from: username, to: currentPrivateTarget });
            }
        }
        if (!currentPrivateTarget) {
            showEmptyChatNotice();
        }
    });

    // PROFILE PANEL AND MODAL
    const openProfileBtn = document.getElementById('open-profile-btn');
    const profileModal = document.getElementById('profile-modal');
    const closeProfile = document.getElementById('close-profile');
    const profileForm = document.getElementById('profile-form');
    const profileAbout = document.getElementById('profile-about');
    const profileAvatar = document.getElementById('profile-avatar');
    const profilePhone = document.getElementById('profile-phone');
    const profileEmail = document.getElementById('profile-email');
    const accountToggle = document.getElementById('account-toggle');
    const accountPanel = document.getElementById('account-panel');
    const accountAvatar = document.getElementById('account-avatar');
    const accountAvatarLarge = document.getElementById('account-avatar-large');
    const accountUsername = document.getElementById('account-username');
    const accountEmail = document.getElementById('account-email');
    const accountPhone = document.getElementById('account-phone');
    const accountEditBtn = document.getElementById('account-edit-btn');
    const accountLogoutBtn = document.getElementById('account-logout-btn');

    const loadAccountPanel = async () => {
        if (!authToken) return;
        try {
            const res = await fetch('https://hk-chat-backend.onrender.com/profile', { headers: { 'Authorization': `Bearer ${authToken}` } });
            const data = await res.json();
            if (data.success && data.user) {
                const fullAvatarUrl = data.user.avatar ? `https://hk-chat-backend.onrender.com${data.user.avatar}` : '';
                if (accountAvatar) accountAvatar.src = fullAvatarUrl;
                if (accountAvatarLarge) accountAvatarLarge.src = fullAvatarUrl;
                if (accountUsername) accountUsername.textContent = data.user.username || username;
                if (accountEmail) accountEmail.textContent = `Email: ${data.user.email || 'none'}`;
                if (accountPhone) accountPhone.textContent = `Phone: ${data.user.phone || 'none'}`;
            }
        } catch (err) {
            console.error('Could not load account panel', err);
        }
    };

    loadAccountPanel();

    const openProfileModal = async () => {
        const avatarPreview = document.getElementById('profile-avatar-preview');
        try {
            const res = await fetch('https://hk-chat-backend.onrender.com/profile', { headers: { 'Authorization': `Bearer ${authToken}` } });
            const data = await res.json();
            if (data.success && data.user) {
                profileAbout.value = data.user.about || '';
                profilePhone.value = data.user.phone || '';
                profileEmail.value = data.user.email || '';
                if (data.user.avatar) {
                    const fullAvatarUrl = `https://hk-chat-backend.onrender.com${data.user.avatar}`;
                    if (avatarPreview) {
                        avatarPreview.src = fullAvatarUrl;
                        avatarPreview.style.display = 'block';
                    }
                } else {
                    if (avatarPreview) avatarPreview.style.display = 'none';
                }
            }
        } catch (err) {
            console.error('Fetch profile error', err);
        }
        if (profileModal) profileModal.style.display = 'flex';
    };

    if (openProfileBtn) openProfileBtn.addEventListener('click', openProfileModal);
    if (closeProfile) closeProfile.addEventListener('click', () => { profileModal.style.display = 'none'; });

    if (profileForm) {
        profileForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const fd = new FormData();
            fd.append('about', profileAbout.value || '');
            fd.append('phone', profilePhone.value || '');
            fd.append('email', profileEmail.value || '');
            if (profileAvatar.files && profileAvatar.files[0]) fd.append('avatar', profileAvatar.files[0]);
            try {
                const res = await fetch('https://hk-chat-backend.onrender.com/profile', { method: 'POST', headers: { 'Authorization': `Bearer ${authToken}` }, body: fd });
                const data = await res.json();
                if (data.success) {
                    alert('Profile updated successfully!');
                    loadAccountPanel();
                    profileModal.style.display = 'none';
                }
            } catch (err) {
                console.error('Profile save error', err);
            }
        });
    }

    if (accountToggle && accountPanel) {
        accountToggle.addEventListener('click', () => { accountPanel.classList.toggle('hidden'); });
    }

    const performLogout = () => {
        socket.emit('logout');
        socket.disconnect();
        sessionStorage.clear();
        localStorage.clear();
        window.location.href = '/';
    };

    if (accountEditBtn) {
        accountEditBtn.addEventListener('click', () => {
            openProfileModal();
            accountPanel.classList.add('hidden');
        });
    }
    if (accountLogoutBtn) {
        accountLogoutBtn.addEventListener('click', () => {
            performLogout();
        });
    }

    socket.on('unread counts', (counts) => {
        unreadCounts = Object.entries(counts || {}).reduce((acc, [userKey, count]) => {
            acc[normalizeUsername(userKey)] = count;
            return acc;
        }, {});
        renderActiveUsers();
    });

    const sidebarChatBtn = document.getElementById('sidebar-chat-btn');
    if (sidebarChatBtn) {
        sidebarChatBtn.addEventListener('click', () => {
            if (accountPanel) accountPanel.classList.add('hidden');
            window.scrollTo({ top: 0, behavior: 'smooth' });
        });
    }
}

// --- LOGIN / SIGNUP FORM TOGGLE ---
if (toggleBtn) {
    toggleBtn.addEventListener('click', () => {
        if (errorDisplay) errorDisplay.style.display = 'none';
        if (isLoginMode) {
            submitBtn.textContent = "Sign Up";
            toggleBtn.innerHTML = "Have an account? <span>Log In</span>";
            isLoginMode = false;
        } else {
            submitBtn.textContent = "Log In";
            toggleBtn.innerHTML = "Don't have an account? <span>Sign up</span>";
            isLoginMode = true;
        }
    });
}

// --- CLOUD AUTHENTICATION HANDLERS ---
if (authForm) {
    authForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (errorDisplay) errorDisplay.style.display = 'none';

        const username = document.getElementById('username').value;
        const password = document.getElementById('password').value;

        const targetUrl = isLoginMode 
            ? 'https://hk-chat-backend.onrender.com/login' 
            : 'https://hk-chat-backend.onrender.com/signup';

        try {
            const response = await fetch(targetUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password })
            });

            const result = await response.json();

            if (result.success) {
                if (isLoginMode) {
                    sessionStorage.setItem('authToken', result.token);
                    sessionStorage.setItem('username', result.username);
                    localStorage.setItem('authToken', result.token);
                    window.location.href = `/?username=${result.username}`;
                } else {
                    alert(result.message);
                    if (toggleBtn) toggleBtn.click();
                }
            } else {
                if (errorDisplay) {
                    errorDisplay.textContent = result.message;
                    errorDisplay.style.display = 'block';
                }
            }
        } catch (err) {
            if (errorDisplay) {
                errorDisplay.textContent = "Server se judne me error aaya.";
                errorDisplay.style.display = 'block';
            }
        }
    });
}
