/**
 * VH Etsy Order Sync - Popup Script
 * Handles popup UI interactions and authentication
 */

(function() {
  'use strict';

  // DOM Elements
  const elements = {
    // Navigation
    navTabs: document.querySelectorAll('.nav-tab'),
    
    // Sections
    loginSection: document.getElementById('loginSection'),
    homeSection: document.getElementById('homeSection'),
    settingsSection: document.getElementById('settingsSection'),
    
    // Login
    loginForm: document.getElementById('loginForm'),
    usernameInput: document.getElementById('username'),
    passwordInput: document.getElementById('password'),
    loginError: document.getElementById('loginError'),
    togglePassword: document.querySelector('.toggle-password'),
    
    // Home
    usernameDisplay: document.getElementById('usernameDisplay'),
    syncedCount: document.getElementById('syncedCount'),
    pendingCount: document.getElementById('pendingCount'),
    
    // Shop Name (Etsy)
    shopNameInput: document.getElementById('shopNameInput'),
    saveShopNameBtn: document.getElementById('saveShopNameBtn'),
    shopNameHint: document.getElementById('shopNameHint'),

    // Whatnot Username
    whatnotUsernameInput: document.getElementById('whatnotUsernameInput'),
    saveWhatnotUsernameBtn: document.getElementById('saveWhatnotUsernameBtn'),
    whatnotUsernameHint: document.getElementById('whatnotUsernameHint'),
    
    // Google Drive
    gdriveConnectBtn: document.getElementById('gdriveConnectBtn'),
    gdriveDisconnectBtn: document.getElementById('gdriveDisconnectBtn'),
    gdriveStatus: document.getElementById('gdriveStatus'),
    
    // Settings
    settingsUsername: document.getElementById('settingsUsername'),
    settingsShopName: document.getElementById('settingsShopName'),
    logoutBtn: document.getElementById('logoutBtn'),
    autoSyncToggle: document.getElementById('autoSyncToggle'),
    autoSyncInterval: document.getElementById('autoSyncInterval'),
    autoSyncIntervalContainer: document.getElementById('autoSyncIntervalContainer'),
    notificationsToggle: document.getElementById('notificationsToggle')
  };

  /**
   * Initialize popup
   */
  async function init() {
    // Setup event listeners
    setupEventListeners();
    
    // Load settings
    await loadSettings();
    
    // Check authentication status
    await checkAuth();
  }

  /**
   * Setup event listeners
   */
  function setupEventListeners() {
    // Navigation tabs
    elements.navTabs.forEach(tab => {
      tab.addEventListener('click', () => switchTab(tab.dataset.tab));
    });

    // Login form
    elements.loginForm.addEventListener('submit', handleLogin);

    // Toggle password visibility
    elements.togglePassword?.addEventListener('click', togglePasswordVisibility);

    // Logout button
    elements.logoutBtn?.addEventListener('click', handleLogout);

    // Settings toggles
    elements.autoSyncToggle?.addEventListener('change', handleAutoSyncToggle);
    elements.notificationsToggle?.addEventListener('change', saveSettings);
    elements.autoSyncInterval?.addEventListener('change', saveSettings);
    
    // Shop name save button (Etsy)
    elements.saveShopNameBtn?.addEventListener('click', handleSaveShopName);
    elements.shopNameInput?.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') handleSaveShopName();
    });

    // Whatnot username save button
    elements.saveWhatnotUsernameBtn?.addEventListener('click', handleSaveWhatnotUsername);
    elements.whatnotUsernameInput?.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') handleSaveWhatnotUsername();
    });
    
    // Google Drive connect/disconnect
    elements.gdriveConnectBtn?.addEventListener('click', handleGDriveConnect);
    elements.gdriveDisconnectBtn?.addEventListener('click', handleGDriveDisconnect);
  }

  /**
   * Switch between tabs
   */
  function switchTab(tabName) {
    // Update nav tabs
    elements.navTabs.forEach(tab => {
      tab.classList.toggle('active', tab.dataset.tab === tabName);
    });

    // Update sections
    elements.loginSection.style.display = 'none';
    elements.homeSection.style.display = 'none';
    elements.settingsSection.style.display = 'none';

    switch (tabName) {
      case 'home':
        elements.homeSection.style.display = 'block';
        break;
      case 'settings':
        elements.settingsSection.style.display = 'block';
        break;
      default:
        elements.loginSection.style.display = 'block';
    }
  }

  /**
   * Check authentication status
   */
  async function checkAuth() {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'ETSY_CHECK_AUTH' });
      
      if (response?.ok && response.data?.isAuthenticated) {
        showAuthenticatedUI(response.data.username);
      } else {
        showLoginUI();
      }
    } catch (e) {
      console.error('Auth check failed:', e);
      showLoginUI();
    }
  }

  /**
   * Show authenticated UI
   */
  async function showAuthenticatedUI(username) {
    elements.usernameDisplay.textContent = username || 'User';
    elements.settingsUsername.textContent = username || '-';
    
    // Load and display shop names
    await loadShopName();
    await loadWhatnotUsername();
    
    // Show home tab
    switchTab('home');
    
    // Update nav visibility
    document.querySelector('[data-tab="home"]').style.display = 'flex';
    document.querySelector('[data-tab="settings"]').style.display = 'flex';
  }
  
  /**
   * Load shop name from storage
   */
  async function loadShopName() {
    try {
      const { etsyShopName } = await chrome.storage.local.get('etsyShopName');
      if (etsyShopName) {
        elements.shopNameInput.value = etsyShopName;
        elements.settingsShopName.textContent = etsyShopName;
        showShopNameStatus('success', `✓ Shop: ${etsyShopName}`);
      } else {
        elements.settingsShopName.textContent = 'Not set';
        showShopNameStatus('error', '⚠️ Please enter your shop name to sync orders');
      }
    } catch (e) {
      console.error('Failed to load shop name:', e);
    }
  }
  
  /**
   * Handle save shop name
   */
  async function handleSaveShopName() {
    const shopName = elements.shopNameInput.value.trim();
    
    if (!shopName) {
      showShopNameStatus('error', '⚠️ Shop name cannot be empty');
      return;
    }
    
    try {
      await chrome.storage.local.set({ etsyShopName: shopName });
      elements.settingsShopName.textContent = shopName;
      
      // Visual feedback
      elements.saveShopNameBtn.classList.add('saved');
      showShopNameStatus('success', `✓ Shop "${shopName}" saved!`);
      
      setTimeout(() => {
        elements.saveShopNameBtn.classList.remove('saved');
      }, 2000);
      
      console.log('Shop name saved:', shopName);
    } catch (e) {
      console.error('Failed to save shop name:', e);
      showShopNameStatus('error', '❌ Failed to save');
    }
  }
  
  /**
   * Show shop name status message
   */
  function showShopNameStatus(type, message) {
    // Remove existing status
    const existingStatus = document.querySelector('.shop-name-status');
    if (existingStatus) existingStatus.remove();
    
    const statusEl = document.createElement('div');
    statusEl.className = `shop-name-status ${type}`;
    statusEl.textContent = message;
    
    elements.shopNameHint.parentNode.insertBefore(statusEl, elements.shopNameHint.nextSibling);
    
    // Auto-hide success after 3 seconds
    if (type === 'success') {
      setTimeout(() => statusEl.remove(), 3000);
    }
  }

  /**
   * Load Whatnot username from storage
   */
  async function loadWhatnotUsername() {
    try {
      const { whatnotUsername } = await chrome.storage.local.get('whatnotUsername');
      if (elements.whatnotUsernameInput) {
        elements.whatnotUsernameInput.value = whatnotUsername || '';
      }
      if (whatnotUsername && elements.whatnotUsernameHint) {
        elements.whatnotUsernameHint.textContent = `✓ Whatnot: @${whatnotUsername}`;
        elements.whatnotUsernameHint.style.color = '#69f0ae';
      }
    } catch (e) {
      console.error('Failed to load Whatnot username:', e);
    }
  }

  /**
   * Handle save Whatnot username
   */
  async function handleSaveWhatnotUsername() {
    const username = elements.whatnotUsernameInput?.value.trim();
    if (!username) {
      if (elements.whatnotUsernameHint) {
        elements.whatnotUsernameHint.textContent = '⚠️ Username cannot be empty';
        elements.whatnotUsernameHint.style.color = '#ff8a80';
      }
      return;
    }
    try {
      await chrome.storage.local.set({ whatnotUsername: username });
      if (elements.saveWhatnotUsernameBtn) {
        elements.saveWhatnotUsernameBtn.classList.add('saved');
        setTimeout(() => elements.saveWhatnotUsernameBtn.classList.remove('saved'), 2000);
      }
      if (elements.whatnotUsernameHint) {
        elements.whatnotUsernameHint.textContent = `✓ Whatnot "@${username}" saved!`;
        elements.whatnotUsernameHint.style.color = '#69f0ae';
        setTimeout(() => {
          elements.whatnotUsernameHint.textContent = 'Your Whatnot seller username (visible in whatnot.com/dashboard)';
          elements.whatnotUsernameHint.style.color = '';
        }, 3000);
      }
      console.log('Whatnot username saved:', username);
    } catch (e) {
      console.error('Failed to save Whatnot username:', e);
    }
  }

  /**
   * Show login UI
   */
  function showLoginUI() {
    switchTab('login');
    
    // Show only login in nav (optional - could hide nav entirely)
    document.querySelector('[data-tab="home"]').style.display = 'none';
    document.querySelector('[data-tab="settings"]').style.display = 'none';
  }

  /**
   * Handle login form submission
   */
  async function handleLogin(e) {
    e.preventDefault();
    
    const username = elements.usernameInput.value.trim();
    const password = elements.passwordInput.value;
    
    if (!username || !password) {
      showError('Please enter username and password');
      return;
    }

    // Show loading state
    const submitBtn = elements.loginForm.querySelector('.btn-login');
    const btnText = submitBtn.querySelector('.btn-text');
    const btnLoader = submitBtn.querySelector('.btn-loader');
    
    submitBtn.disabled = true;
    btnText.style.display = 'none';
    btnLoader.style.display = 'inline-flex';
    elements.loginError.style.display = 'none';

    try {
      const response = await chrome.runtime.sendMessage({
        type: 'ETSY_LOGIN',
        payload: { 
          url: 'https://vhmediaco.app/api/loginExtention/',
          username, 
          password 
        }
      });

      if (response?.ok) {
        showAuthenticatedUI(response.data?.username);
      } else {
        showError(response?.error || 'Login failed. Please check your credentials.');
      }
    } catch (e) {
      console.error('Login error:', e);
      showError('Connection error. Please try again.');
    } finally {
      submitBtn.disabled = false;
      btnText.style.display = 'inline';
      btnLoader.style.display = 'none';
    }
  }

  /**
   * Handle logout
   */
  async function handleLogout() {
    try {
      await chrome.runtime.sendMessage({ type: 'ETSY_LOGOUT' });
      showLoginUI();
      
      // Clear form
      elements.usernameInput.value = '';
      elements.passwordInput.value = '';
      elements.loginError.style.display = 'none';
    } catch (e) {
      console.error('Logout error:', e);
    }
  }

  /**
   * Toggle password visibility
   */
  function togglePasswordVisibility() {
    const input = elements.passwordInput;
    const type = input.type === 'password' ? 'text' : 'password';
    input.type = type;
    
    // Update icon (optional)
    const icon = elements.togglePassword.querySelector('.eye-icon');
    if (icon) {
      icon.style.opacity = type === 'text' ? '0.5' : '1';
    }
  }

  /**
   * Show error message
   */
  function showError(message) {
    elements.loginError.textContent = message;
    elements.loginError.style.display = 'block';
  }

  /**
   * Load settings from storage
   */
  async function loadSettings() {
    try {
      const settings = await chrome.storage.local.get(['autoSync', 'autoSyncInterval', 'notifications']);
      
      if (elements.autoSyncToggle) {
        elements.autoSyncToggle.checked = settings.autoSync || false;
      }
      if (elements.autoSyncInterval) {
        elements.autoSyncInterval.value = settings.autoSyncInterval || '5';
      }
      if (elements.autoSyncIntervalContainer) {
        elements.autoSyncIntervalContainer.style.display = settings.autoSync ? 'flex' : 'none';
      }
      if (elements.notificationsToggle) {
        elements.notificationsToggle.checked = settings.notifications !== false; // default true
      }
      
      // Check Google Drive auth status
      await checkGDriveAuth();
    } catch (e) {
      console.error('Failed to load settings:', e);
    }
  }

  /**
   * Check Google Drive authentication status
   */
  async function checkGDriveAuth() {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'GDRIVE_CHECK_AUTH' });
      updateGDriveUI(response?.authenticated || false);
    } catch (e) {
      updateGDriveUI(false);
    }
  }

  /**
   * Update Google Drive UI based on auth status
   */
  function updateGDriveUI(isConnected) {
    const statusDot = elements.gdriveStatus?.querySelector('.gdrive-status-dot');
    const statusText = elements.gdriveStatus?.querySelector('.gdrive-status-text');
    
    if (isConnected) {
      if (statusDot) {
        statusDot.className = 'gdrive-status-dot connected';
      }
      if (statusText) {
        statusText.textContent = 'Connected';
      }
      if (elements.gdriveConnectBtn) elements.gdriveConnectBtn.style.display = 'none';
      if (elements.gdriveDisconnectBtn) elements.gdriveDisconnectBtn.style.display = 'inline-flex';
    } else {
      if (statusDot) {
        statusDot.className = 'gdrive-status-dot disconnected';
      }
      if (statusText) {
        statusText.textContent = 'Not connected';
      }
      if (elements.gdriveConnectBtn) elements.gdriveConnectBtn.style.display = 'inline-flex';
      if (elements.gdriveDisconnectBtn) elements.gdriveDisconnectBtn.style.display = 'none';
    }
  }

  /**
   * Handle Google Drive connect
   */
  async function handleGDriveConnect() {
    try {
      elements.gdriveConnectBtn.disabled = true;
      elements.gdriveConnectBtn.textContent = 'Connecting...';
      
      const response = await chrome.runtime.sendMessage({ type: 'GDRIVE_CONNECT' });
      
      if (response?.ok && response?.authenticated) {
        updateGDriveUI(true);
      } else {
        alert('Failed to connect Google Drive: ' + (response?.error || 'Unknown error'));
      }
    } catch (e) {
      alert('Connection error: ' + e.message);
    } finally {
      elements.gdriveConnectBtn.disabled = false;
      elements.gdriveConnectBtn.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M15 3h4a2 2 0 012 2v14a2 2 0 01-2 2h-4"/>
          <polyline points="10 17 15 12 10 7"/>
          <line x1="15" y1="12" x2="3" y2="12"/>
        </svg>
        Connect Google Drive
      `;
    }
  }

  /**
   * Handle Google Drive disconnect
   */
  async function handleGDriveDisconnect() {
    try {
      await chrome.runtime.sendMessage({ type: 'GDRIVE_DISCONNECT' });
      updateGDriveUI(false);
    } catch (e) {
      console.error('Disconnect error:', e);
    }
  }

  /**
   * Handle auto sync toggle change
   */
  async function handleAutoSyncToggle() {
    const isEnabled = elements.autoSyncToggle?.checked || false;
    
    // Show/hide interval selector
    if (elements.autoSyncIntervalContainer) {
      elements.autoSyncIntervalContainer.style.display = isEnabled ? 'flex' : 'none';
    }
    
    await saveSettings();
    
    // Notify background script to start/stop auto sync
    chrome.runtime.sendMessage({
      type: 'TOGGLE_AUTO_SYNC',
      payload: {
        enabled: isEnabled,
        intervalMinutes: parseInt(elements.autoSyncInterval?.value || '5')
      }
    });
  }

  /**
   * Save settings to storage
   */
  async function saveSettings() {
    try {
      const autoSyncEnabled = elements.autoSyncToggle?.checked || false;
      const intervalMinutes = parseInt(elements.autoSyncInterval?.value || '5');
      
      await chrome.storage.local.set({
        autoSync: autoSyncEnabled,
        autoSyncInterval: intervalMinutes,
        notifications: elements.notificationsToggle?.checked !== false
      });
      
      // If auto sync enabled, update the alarm
      if (autoSyncEnabled) {
        chrome.runtime.sendMessage({
          type: 'TOGGLE_AUTO_SYNC',
          payload: {
            enabled: true,
            intervalMinutes: intervalMinutes
          }
        });
      }
    } catch (e) {
      console.error('Failed to save settings:', e);
    }
  }

  // Initialize on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
