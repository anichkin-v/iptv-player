/**
 * I18N_AJAX — tiny runtime i18n helper with retry logic and improved error handling
 * Usage:
 *   await I18N_AJAX.init({ defaultLang: 'ru', supported: ['ru','en','uz'] })
 *   I18N_AJAX.t('ui.key')
 *   I18N_AJAX.apply()  // apply to [data-i18n] nodes
 */
window.I18N_AJAX = (function(){
    const state = {
        lang: 'ru',
        dict: {},
        defaultLang: 'ru',
        supported: ['ru','en','uz'],
        basePath: '../i18n',
        initialized: false,
        cache: new Map(),
        isLoading: false,
        initializationPromise: null, // Track initialization promise
        loadingPromise: null // Track current loading promise
    };

    // Retry mechanism for file loading
    async function fetchWithRetry(url, options = {}, maxRetries = 3, timeout = 5000) {
        let lastError;

        for (let attempt = 0; attempt < maxRetries; attempt++) {
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), timeout);

                const response = await fetch(url, {
                    ...options,
                    signal: controller.signal
                });

                clearTimeout(timeoutId);

                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
                }

                return response;
            } catch (error) {
                lastError = error;
                console.warn(`Fetch attempt ${attempt + 1}/${maxRetries} failed for ${url}:`, error.message);

                if (attempt < maxRetries - 1) {
                    await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 1000));
                }
            }
        }

        throw lastError;
    }

    async function loadLang(lang, force = false) {
        // Check cache first
        if (!force && state.cache.has(lang)) {
            console.log(`Loading ${lang} from cache`);
            state.dict = state.cache.get(lang);
            state.lang = lang;
            return;
        }

        // If loading is in progress, wait for the current loading promise
        if (state.isLoading && state.loadingPromise) {
            console.log(`Language loading already in progress, waiting for completion...`);
            try {
                await state.loadingPromise;
                // Check if the requested language was loaded
                if (state.lang === lang) {
                    return;
                }
                // If not, we need to load it (but only if not currently loading a different language)
                if (state.isLoading) {
                    console.warn(`Different language loading in progress, skipping ${lang}`);
                    return;
                }
            } catch (error) {
                console.error('Previous loading failed:', error);
                // Continue with current loading attempt
            }
        }

        state.isLoading = true;

        // Create loading promise that others can wait for
        state.loadingPromise = (async () => {
            try {
                console.log(`Loading language: ${lang}`);
                const file = `${state.basePath}/${lang}.json`;

                const response = await fetchWithRetry(file, {
                    cache: 'no-cache',
                    headers: {
                        'Cache-Control': 'no-cache',
                        'Pragma': 'no-cache'
                    }
                });

                const dict = await response.json();

                // Validate dictionary
                if (!dict || typeof dict !== 'object' || Object.keys(dict).length === 0) {
                    throw new Error(`Empty or invalid dictionary for ${lang}`);
                }

                // Save to cache and state
                state.cache.set(lang, dict);
                state.dict = dict;
                state.lang = lang;

                console.log(`Successfully loaded ${lang}, dictionary size:`, Object.keys(dict).length);

            } catch (error) {
                console.error(`Failed to load language ${lang}:`, error);

                // Fallback logic
                if (lang !== state.defaultLang) {
                    console.log(`Falling back to default language: ${state.defaultLang}`);
                    // Prevent infinite recursion by clearing loading state first
                    state.isLoading = false;
                    state.loadingPromise = null;
                    await loadLang(state.defaultLang, force);
                    return;
                } else {
                    console.error('Critical: Failed to load default language, using empty dictionary');
                    state.dict = {};
                    state.lang = lang;
                }
            }
        })();

        try {
            await state.loadingPromise;
        } finally {
            state.isLoading = false;
            state.loadingPromise = null;
        }
    }

    function t(key, fallback) {
        const v = state.dict[key];
        if (v === undefined || v === "" || v === null) {
            return (fallback !== undefined ? fallback : key);
        }
        return v;
    }

    function apply(root = document) {
        if (!state.initialized) {
            // Don't log warning - this is expected during initialization
            return Promise.resolve();
        }

        return new Promise((resolve) => {
            try {
                const nodes = root.querySelectorAll('[data-i18n]');
                nodes.forEach(node => {
                    const key = node.getAttribute('data-i18n');
                    if (!key) return;
                    const translation = t(key, key);
                    if (node.textContent !== translation) {
                        node.textContent = translation;
                    }
                });

                const attrNodes = root.querySelectorAll('[data-i18n-attr]');
                attrNodes.forEach(node => {
                    const pairs = node.getAttribute('data-i18n-attr');
                    if (!pairs) return;
                    pairs.split(',').forEach(pair => {
                        const [attr, key] = pair.split(':').map(s => s.trim());
                        if (attr && key) {
                            const translation = t(key, key);
                            if (node.getAttribute(attr) !== translation) {
                                node.setAttribute(attr, translation);
                            }
                        }
                    });
                });

                console.log(`Applied translations for ${state.lang}, processed ${nodes.length} text nodes and ${attrNodes.length} attribute nodes`);
                resolve();
            } catch (error) {
                console.error('Error applying translations:', error);
                resolve();
            }
        });
    }

    async function setLang(lang, force = false) {
        if (!state.supported.includes(lang)) {
            console.warn(`Language ${lang} not supported, ignoring`);
            return;
        }

        if (!force && state.lang === lang && state.initialized) {
            console.log(`Language ${lang} already active and initialized`);
            return;
        }

        try {
            await loadLang(lang, force);

            // Wait for DOM readiness
            if (document.readyState === 'loading') {
                await new Promise(resolve => {
                    document.addEventListener('DOMContentLoaded', resolve, { once: true });
                });
            }

            await apply();

            // Translate existing content if initialized
            if (state.initialized) {
                translateExistingContent();
            }

            try {
                document.documentElement.setAttribute('lang', lang);
            } catch(e) {
                console.error('Failed to set document lang:', e);
            }

            try {
                document.dispatchEvent(new CustomEvent('i18n:lang-changed', { detail: { lang } }));
            } catch(e) {
                console.error('Failed to dispatch lang-changed event:', e);
            }

            localStorage.setItem('lang', lang);
            console.log(`Language switched to: ${lang}`);

        } catch (error) {
            console.error(`Failed to set language to ${lang}:`, error);
        }
    }

    async function init(opts = {}) {
        // If already initialized, return immediately
        if (state.initialized) {
            console.log('I18N already initialized');
            return state.initializationPromise || Promise.resolve();
        }

        // If initialization is in progress, return the existing promise
        if (state.initializationPromise) {
            console.log('I18N initialization already in progress, waiting...');
            return state.initializationPromise;
        }

        // Create initialization promise
        state.initializationPromise = (async () => {
            try {
                console.log('Initializing I18N...');
                Object.assign(state, opts || {});

                const prefer = localStorage.getItem('lang') || state.defaultLang || 'ru';
                console.log(`Preferred language: ${prefer}`);

                await setLang(prefer);
                state.initialized = true;

                // Start automatic translation of new elements
                startAutoTranslate();

                // Translate all existing content
                translateExistingContent();

                // Dispatch initialization event
                try {
                    document.dispatchEvent(new CustomEvent('i18n:initialized', { detail: { lang: state.lang } }));
                    console.log('I18N initialization completed successfully');
                } catch(e) {
                    console.error('Failed to dispatch initialized event:', e);
                }

            } catch (error) {
                console.error('I18N initialization failed:', error);
                state.initialized = true; // Mark as initialized even on error
            }
        })();

        return state.initializationPromise;
    }

    // Function to translate all existing content
    function translateExistingContent() {
        try {
            const walker = document.createTreeWalker(
                document.body,
                NodeFilter.SHOW_TEXT,
                null,
                false
            );

            let textNode;
            while (textNode = walker.nextNode()) {
                if (textNode.textContent && textNode.textContent.includes('ui.')) {
                    const translatedText = translateText(textNode.textContent);
                    if (translatedText !== textNode.textContent) {
                        textNode.textContent = translatedText;
                    }
                }
            }

            console.log('Existing content translated');
        } catch (error) {
            console.error('Error translating existing content:', error);
        }
    }

    // Preload function for frequently used languages
    async function preloadLanguages(languages = ['ru', 'en']) {
        const preloadPromises = languages.map(async lang => {
            if (!state.cache.has(lang) && state.supported.includes(lang)) {
                try {
                    console.log(`Preloading language: ${lang}`);
                    const file = `${state.basePath}/${lang}.json`;
                    const response = await fetchWithRetry(file, { cache: 'force-cache' });
                    const dict = await response.json();
                    state.cache.set(lang, dict);
                    console.log(`Preloaded ${lang} successfully`);
                } catch (error) {
                    console.warn(`Failed to preload ${lang}:`, error);
                }
            }
        });

        await Promise.allSettled(preloadPromises);
    }

    // Function to translate text containing i18n keys
    function translateText(text) {
        if (!text || typeof text !== 'string') return text;

        return text.replace(/\bui\.[a-zA-Z_][a-zA-Z0-9_]*\b/g, (match) => {
            return t(match, match);
        });
    }

    // Function to translate notifications and dynamic content
    function translateNotification(text) {
        if (!state.initialized) {
            console.warn('I18N not initialized, cannot translate:', text);
            return text;
        }
        return translateText(text);
    }

    // MutationObserver for automatic translation of new elements
    let observer = null;

    function startAutoTranslate() {
        if (observer) return; // Already started

        observer = new MutationObserver((mutations) => {
            mutations.forEach((mutation) => {
                mutation.addedNodes.forEach((node) => {
                    if (node.nodeType === Node.ELEMENT_NODE) {
                        apply(node);

                        if (node.textContent && node.textContent.includes('ui.')) {
                            const translatedText = translateText(node.textContent);
                            if (translatedText !== node.textContent) {
                                node.textContent = translatedText;
                            }
                        }

                        const walker = document.createTreeWalker(
                            node,
                            NodeFilter.SHOW_TEXT,
                            null,
                            false
                        );

                        let textNode;
                        while (textNode = walker.nextNode()) {
                            if (textNode.textContent && textNode.textContent.includes('ui.')) {
                                const translatedText = translateText(textNode.textContent);
                                if (translatedText !== textNode.textContent) {
                                    textNode.textContent = translatedText;
                                }
                            }
                        }
                    } else if (node.nodeType === Node.TEXT_NODE) {
                        if (node.textContent && node.textContent.includes('ui.')) {
                            const translatedText = translateText(node.textContent);
                            if (translatedText !== node.textContent) {
                                node.textContent = translatedText;
                            }
                        }
                    }
                });
            });
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true,
            characterData: true
        });

        console.log('Auto-translate observer started');
    }

    function stopAutoTranslate() {
        if (observer) {
            observer.disconnect();
            observer = null;
            console.log('Auto-translate observer stopped');
        }
    }

    // Public methods
    return {
        init,
        setLang,
        getLang: () => state.lang,
        isInitialized: () => state.initialized,
        isLoading: () => state.isLoading,
        t,
        apply,
        translateText,
        translateNotification,
        startAutoTranslate,
        stopAutoTranslate,
        preloadLanguages,
        clearCache: () => {
            state.cache.clear();
        },
        getState: () => ({
            ...state,
            cache: Object.fromEntries(state.cache.entries())
        })
    };
})();

// === Notification system interceptor ===
(function() {
    function interceptNotificationMethods() {
        // Intercept console for debug notifications
        if (typeof console.log === 'function') {
            const originalLog = console.log;
            console.log = function(...args) {
                args = args.map(arg =>
                    typeof arg === 'string' && arg.includes('ui.')
                        ? (window.I18N_AJAX?.translateText?.(arg) || arg)
                        : arg
                );
                return originalLog.apply(this, args);
            };
        }

        // Intercept alert
        if (typeof window.alert === 'function') {
            const originalAlert = window.alert;
            window.alert = function(message) {
                const translatedMessage = typeof message === 'string' && message.includes('ui.')
                    ? (window.I18N_AJAX?.translateText?.(message) || message)
                    : message;
                return originalAlert.call(this, translatedMessage);
            };
        }

        // Intercept popular notification libraries
        if (window.Toastify) {
            const originalToastify = window.Toastify;
            window.Toastify = function(options) {
                if (options && typeof options.text === 'string' && options.text.includes('ui.')) {
                    options.text = window.I18N_AJAX?.translateText?.(options.text) || options.text;
                }
                return originalToastify.call(this, options);
            };
        }

        console.log('Notification interceptors installed');
    }

    // Install interceptors after i18n initialization
    document.addEventListener('i18n:initialized', () => {
        interceptNotificationMethods();
    });

    // If i18n is already initialized
    if (window.I18N_AJAX?.isInitialized?.()) {
        interceptNotificationMethods();
    }
})();

// === Language button highlight ===
(function () {
    const LANG_BTN_SELECTOR = '.lang-btn[data-lang]';
    let highlightInitialized = false;

    function getCurrentLang() {
        if (window.I18N_AJAX?.isInitialized?.() && window.I18N_AJAX?.getLang) {
            try {
                return String(window.I18N_AJAX.getLang()).toLowerCase();
            } catch(e) {
                console.error('Failed to get current lang from I18N_AJAX:', e);
            }
        }

        const ls = (localStorage.getItem('lang') || '').toLowerCase();
        const htmlLang = (document.documentElement.getAttribute('lang') || '').toLowerCase();
        return (ls || htmlLang || 'ru');
    }

    function highlightActiveLang(lang) {
        try {
            const buttons = document.querySelectorAll(LANG_BTN_SELECTOR);
            if (buttons.length === 0) {
                return; // No buttons found, don't warn
            }

            buttons.forEach(btn => {
                const btnLang = (btn.dataset.lang || '').toLowerCase();
                const isActive = btnLang === lang.toLowerCase();
                btn.classList.toggle('is-active', isActive);
                if (isActive) {
                    btn.setAttribute('aria-current', 'true');
                } else {
                    btn.removeAttribute('aria-current');
                }
            });

            console.log(`Highlighted active language: ${lang}`);
        } catch (error) {
            console.error('Failed to highlight active lang:', error);
        }
    }

    async function initLangHighlight() {
        if (highlightInitialized) return;

        const currentLang = getCurrentLang();
        highlightActiveLang(currentLang);
        highlightInitialized = true;

        setTimeout(() => {
            if (document.querySelectorAll(LANG_BTN_SELECTOR).length > 0) {
                highlightActiveLang(getCurrentLang());
            }
        }, 500);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initLangHighlight);
    } else {
        initLangHighlight();
    }

    // Language button click handler
    document.addEventListener('click', async (e) => {
        const btn = e.target.closest(LANG_BTN_SELECTOR);
        if (!btn) return;

        const lang = btn.dataset.lang;
        if (!lang) return;

        btn.classList.add('loading');

        try {
            highlightActiveLang(lang);

            if (window.I18N_AJAX?.setLang) {
                await window.I18N_AJAX.setLang(lang);
            }
        } catch (error) {
            console.error('Failed to set language:', error);
            highlightActiveLang(getCurrentLang());
        } finally {
            btn.classList.remove('loading');
        }
    });

    // Listen for i18n events
    document.addEventListener('i18n:initialized', (e) => {
        const lang = e.detail?.lang || getCurrentLang();
        highlightActiveLang(lang);
    });

    document.addEventListener('i18n:lang-changed', (e) => {
        const lang = e.detail?.lang || getCurrentLang();
        highlightActiveLang(lang);
    });
})();