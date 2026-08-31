document.addEventListener('DOMContentLoaded', () => {
  // Elements
  const connectionDot = document.getElementById('connectionDot');
  const statusBadgeText = document.getElementById('statusBadgeText');
  const authModeBadge = document.getElementById('authModeBadge');
  const headerPhone = document.getElementById('headerPhone');

  // Tabs & Views
  const tabQr = document.getElementById('tabQr');
  const tabPairing = document.getElementById('tabPairing');
  const qrCard = document.getElementById('qrCard');
  const pairingCard = document.getElementById('pairingCard');
  const connectedCard = document.getElementById('connectedCard');
  const connectedPhone = document.getElementById('connectedPhone');

  // QR elements
  const qrPlaceholder = document.getElementById('qrPlaceholder');
  const qrImage = document.getElementById('qrImage');

  // Pairing elements
  const phoneDisplay = document.getElementById('phoneDisplay');
  const pairingCodeValue = document.getElementById('pairingCodeValue');
  const btnCopyPairing = document.getElementById('btnCopyPairing');

  // Actions
  const btnConnect = document.getElementById('btnConnect');
  const btnResetSession = document.getElementById('btnResetSession');
  const btnDisconnect = document.getElementById('btnDisconnect');
  const btnClearLogs = document.getElementById('btnClearLogs');
  const logConsole = document.getElementById('logConsole');
  const logCountBadge = document.getElementById('logCountBadge');
  const toast = document.getElementById('toast');

  // Settings
  const configForm = document.getElementById('configForm');
  const selectAuthMode = document.getElementById('selectAuthMode');
  const inputApiKey = document.getElementById('inputApiKey');
  const inputPhone = document.getElementById('inputPhone');
  const btnToggleApiKey = document.getElementById('btnToggleApiKey');

  // AI Simulator
  const testInput = document.getElementById('testInput');
  const btnSendTest = document.getElementById('btnSendTest');
  const testChatWindow = document.getElementById('testChatWindow');
  const quickChips = document.querySelectorAll('.quick-chip');

  let currentChatId = 'test-session-' + Date.now();
  let currentAuthMode = 'qr';
  let totalLogs = 0;

  // Initialize
  fetchStatus();
  setupSseStream();

  // Tab Switching
  tabQr.addEventListener('click', () => switchTab('qr'));
  tabPairing.addEventListener('click', () => switchTab('pairing'));

  function switchTab(mode) {
    currentAuthMode = mode;
    if (mode === 'qr') {
      tabQr.classList.add('active');
      tabPairing.classList.remove('active');
      authModeBadge.textContent = 'QR Mode';
      if (selectAuthMode) selectAuthMode.value = 'qr';
      if (!pairingCard.classList.contains('hidden') || !connectedCard.classList.contains('hidden')) {
        pairingCard.classList.add('hidden');
      }
      qrCard.classList.remove('hidden');
    } else {
      tabPairing.classList.add('active');
      tabQr.classList.remove('active');
      authModeBadge.textContent = 'Pairing Mode';
      if (selectAuthMode) selectAuthMode.value = 'pairing';
      if (!qrCard.classList.contains('hidden') || !connectedCard.classList.contains('hidden')) {
        qrCard.classList.add('hidden');
      }
      pairingCard.classList.remove('hidden');
    }
  }

  // Toggle API Key Show/Hide
  if (btnToggleApiKey) {
    btnToggleApiKey.addEventListener('click', () => {
      if (inputApiKey.type === 'password') {
        inputApiKey.type = 'text';
        btnToggleApiKey.textContent = 'Hide';
      } else {
        inputApiKey.type = 'password';
        btnToggleApiKey.textContent = 'Show';
      }
    });
  }

  // Copy Pairing Code
  if (btnCopyPairing) {
    btnCopyPairing.addEventListener('click', () => {
      const code = pairingCodeValue.textContent.trim();
      if (code && code !== 'CONNECTING...' && code !== 'DISCONNECTED') {
        navigator.clipboard.writeText(code).then(() => {
          showToast('Pairing code copied to clipboard!', 'success');
        }).catch(() => {
          showToast('Failed to copy code.', 'error');
        });
      }
    });
  }

  // Quick prompt chips
  quickChips.forEach(chip => {
    chip.addEventListener('click', () => {
      const prompt = chip.getAttribute('data-prompt');
      testInput.value = prompt;
      sendTestMessage();
    });
  });

  async function fetchStatus() {
    try {
      const res = await fetch('/api/status');
      const data = await res.json();
      if (data.success) {
        if (data.config) {
          if (data.config.phoneNumber) {
            const clean = data.config.phoneNumber.replace(/[^0-9]/g, '');
            phoneDisplay.textContent = '+' + clean;
            headerPhone.textContent = '+' + clean;
            inputPhone.value = data.config.phoneNumber;
          }
          if (data.config.authMode) {
            currentAuthMode = data.config.authMode;
            if (selectAuthMode) selectAuthMode.value = data.config.authMode;
            switchTab(data.config.authMode);
          }
        }
        updateUiStatus(data.status);
      }
    } catch (e) {
      console.error('Failed to fetch status:', e);
    }
  }

  function updateUiStatus(status) {
    if (!status) return;

    // Update connection badge & dot
    if (status.connected) {
      connectionDot.className = 'dot connected';
      statusBadgeText.className = 'status-badge connected';
      statusBadgeText.textContent = 'Active & Connected';

      // Show Connected View
      connectedCard.classList.remove('hidden');
      qrCard.classList.add('hidden');
      pairingCard.classList.add('hidden');

      const userJid = status.user?.id || '';
      const userPhoneStr = userJid ? userJid.split(':')[0] : inputPhone.value;
      connectedPhone.textContent = '+' + userPhoneStr.replace(/[^0-9]/g, '');
      headerPhone.textContent = '+' + userPhoneStr.replace(/[^0-9]/g, '');

    } else if (status.connecting) {
      connectionDot.className = 'dot connecting';
      statusBadgeText.className = 'status-badge connecting';
      statusBadgeText.textContent = 'Connecting...';

      connectedCard.classList.add('hidden');

      if (currentAuthMode === 'qr') {
        qrCard.classList.remove('hidden');
        pairingCard.classList.add('hidden');
      } else {
        pairingCard.classList.remove('hidden');
        qrCard.classList.add('hidden');
      }

      // Handle QR code display
      if (status.qrCodeUrl) {
        qrPlaceholder.classList.add('hidden');
        qrImage.src = status.qrCodeUrl;
        qrImage.classList.remove('hidden');
      } else {
        qrPlaceholder.classList.remove('hidden');
        qrImage.classList.add('hidden');
      }

      // Handle Pairing Code display
      if (status.pairingCode) {
        pairingCodeValue.textContent = status.pairingCode;
      } else {
        pairingCodeValue.textContent = 'GENERATING...';
      }

    } else {
      connectionDot.className = 'dot disconnected';
      statusBadgeText.className = 'status-badge disconnected';
      statusBadgeText.textContent = 'Disconnected';

      connectedCard.classList.add('hidden');
      if (currentAuthMode === 'qr') {
        qrCard.classList.remove('hidden');
        pairingCard.classList.add('hidden');
      } else {
        pairingCard.classList.remove('hidden');
        qrCard.classList.add('hidden');
      }
      qrPlaceholder.classList.remove('hidden');
      qrImage.classList.add('hidden');
      pairingCodeValue.textContent = 'DISCONNECTED';
    }
  }

  function setupSseStream() {
    const eventSource = new EventSource('/api/stream');

    eventSource.addEventListener('status', (e) => {
      try {
        const statusData = JSON.parse(e.data);
        updateUiStatus(statusData);
      } catch (err) {}
    });

    eventSource.addEventListener('log', (e) => {
      try {
        const logItem = JSON.parse(e.data);
        appendLog(logItem);
      } catch (err) {}
    });

    eventSource.onerror = (err) => {
      console.warn('SSE EventSource error, reconnecting...', err);
    };
  }

  function appendLog(logItem) {
    totalLogs++;
    if (logCountBadge) logCountBadge.textContent = `${totalLogs} events`;

    const div = document.createElement('div');
    div.className = `log-entry ${logItem.type || 'info'}`;
    div.innerHTML = `<span class="time">[${logItem.timestamp}]</span> ${escapeHtml(logItem.message)}`;
    logConsole.appendChild(div);
    logConsole.scrollTop = logConsole.scrollHeight;
  }

  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function showToast(message, type = 'info') {
    toast.textContent = message;
    toast.className = `toast ${type}`;
    setTimeout(() => {
      toast.className = 'toast hidden';
    }, 3500);
  }

  // Button Listeners
  btnConnect.addEventListener('click', async () => {
    appendLog({ timestamp: new Date().toLocaleTimeString(), type: 'info', message: `Connecting with ${currentAuthMode.toUpperCase()} mode...` });
    showToast('Initiating WhatsApp connection...', 'info');

    // Reset QR placeholder
    qrPlaceholder.classList.remove('hidden');
    qrImage.classList.add('hidden');

    try {
      const res = await fetch('/api/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phoneNumber: inputPhone.value.trim(),
          authMode: currentAuthMode
        })
      });
      const data = await res.json();
      if (data.success) {
        showToast('Connecting! Check QR code or pairing code.', 'success');
      } else {
        showToast('Error: ' + data.error, 'error');
      }
    } catch (err) {
      showToast('Connection failed: ' + err.message, 'error');
    }
  });

  btnResetSession.addEventListener('click', async () => {
    if (confirm('Are you sure you want to clear the session files and generate a brand new QR Code?')) {
      showToast('Clearing session cache...', 'info');
      qrPlaceholder.classList.remove('hidden');
      qrImage.classList.add('hidden');
      try {
        const res = await fetch('/api/reset-session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            phoneNumber: inputPhone.value.trim(),
            authMode: currentAuthMode
          })
        });
        const data = await res.json();
        if (data.success) {
          showToast('Session reset! Generating fresh QR Code...', 'success');
        } else {
          showToast('Error: ' + data.error, 'error');
        }
      } catch (err) {
        showToast('Reset failed: ' + err.message, 'error');
      }
    }
  });

  btnDisconnect.addEventListener('click', async () => {
    if (confirm('Are you sure you want to disconnect WhatsApp?')) {
      try {
        const res = await fetch('/api/disconnect', { method: 'POST' });
        const data = await res.json();
        if (data.success) {
          showToast('Disconnected WhatsApp session.', 'info');
        }
      } catch (err) {
        showToast('Disconnect error: ' + err.message, 'error');
      }
    }
  });

  btnClearLogs.addEventListener('click', () => {
    logConsole.innerHTML = '';
    totalLogs = 0;
    if (logCountBadge) logCountBadge.textContent = '0 events';
  });

  configForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const apiKey = inputApiKey.value.trim();
    const phone = inputPhone.value.trim();
    const mode = selectAuthMode.value;

    try {
      const res = await fetch('/api/save-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          geminiApiKey: apiKey || undefined,
          phoneNumber: phone,
          authMode: mode
        })
      });
      const data = await res.json();
      if (data.success) {
        showToast('Configuration saved successfully! 💾', 'success');
        if (phone) {
          const clean = phone.replace(/[^0-9]/g, '');
          phoneDisplay.textContent = '+' + clean;
          headerPhone.textContent = '+' + clean;
        }
        if (mode) switchTab(mode);
      } else {
        showToast('Error: ' + data.error, 'error');
      }
    } catch (err) {
      showToast('Failed to save settings: ' + err.message, 'error');
    }
  });

  // AI Simulator Test
  btnSendTest.addEventListener('click', sendTestMessage);
  testInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') sendTestMessage();
  });

  async function sendTestMessage() {
    const text = testInput.value.trim();
    if (!text) return;

    appendChatBubble('user', 'You', text);
    testInput.value = '';

    try {
      const res = await fetch('/api/test-ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: text,
          chatId: currentChatId,
          apiKey: inputApiKey.value.trim() || undefined
        })
      });
      const data = await res.json();
      if (data.success && data.reply) {
        appendChatBubble('bot', '🤖 AI Assistant', data.reply);
      } else {
        appendChatBubble('bot', '🤖 AI Assistant', '⚠️ Error: ' + (data.error || 'Failed to get response from AI.'));
      }
    } catch (err) {
      appendChatBubble('bot', '🤖 AI Assistant', '⚠️ Connection error: ' + err.message);
    }
  }

  function appendChatBubble(role, senderTitle, text) {
    const div = document.createElement('div');
    div.className = `chat-bubble ${role}`;
    
    const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    div.innerHTML = `
      <div class="bubble-header">${escapeHtml(senderTitle)}</div>
      <div class="bubble-body">${escapeHtml(text).replace(/\n/g, '<br>')}</div>
      <div class="bubble-time">${timeStr}</div>
    `;
    testChatWindow.appendChild(div);
    testChatWindow.scrollTop = testChatWindow.scrollHeight;
  }
});
