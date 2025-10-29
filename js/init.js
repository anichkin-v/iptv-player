/* localiz.init.js — SAFE init (self-sufficient)
   - Loads i18n.js dynamically if not present
   - Initializes I18N_AJAX and applies translations
   - Exposes global alias: window.t
   Usage in HTML (any order is OK):
     <script src="./localiz.init.js" data-i18n-base="./i18n" data-default-lang="ru" data-supported="ru,en,uz"></script>
*/
(function(){
    // Prevent multiple init attempts
    if (window.__i18n_init_in_progress) {
        console.log('[i18n] init already in progress, skipping duplicate');
        return;
    }

    const CFG = {
        basePath: (document.currentScript && document.currentScript.getAttribute('data-i18n-base')) || './i18n',
        defaultLang: (document.currentScript && document.currentScript.getAttribute('data-default-lang')) || 'ru',
        supported: (document.currentScript && document.currentScript.getAttribute('data-supported')) || 'ru,en,uz'
    };

    function loadScript(src){
        return new Promise((resolve, reject)=>{
            const s = document.createElement('script');
            s.src = src;
            s.async = true;
            s.onload = resolve;
            s.onerror = () => reject(new Error('Failed to load: ' + src));
            document.head.appendChild(s);
        });
    }

    async function ensureI18N(){
        if (window.I18N_AJAX) {
            console.log('[i18n] I18N_AJAX already loaded');
            return;
        }

        const base = (CFG.basePath || './i18n').replace(/\/+$/,'');
        console.log('[i18n] loading i18n.js from:', base + '/i18n.js');

        await loadScript(base + '/i18n.js');

        if (!window.I18N_AJAX) {
            throw new Error('I18N_AJAX is still undefined after loading i18n.js');
        }

        console.log('[i18n] i18n.js loaded successfully');
    }

    async function init(){
        window.__i18n_init_in_progress = true;

        try {
            // Check if already initialized
            if (window.I18N_AJAX && window.I18N_AJAX.isInitialized()) {
                console.log('[i18n] already initialized, setting up global alias only');
                window.t = (k, fb) => window.I18N_AJAX.t(k, fb);
                document.documentElement.setAttribute('data-i18n-ready','1');
                return;
            }

            await ensureI18N();

            const langs = (CFG.supported || 'ru,en,uz').split(',').map(s=>s.trim()).filter(Boolean);

            console.log('[i18n] initializing with config:', {
                defaultLang: CFG.defaultLang,
                supported: langs,
                basePath: CFG.basePath
            });

            // Initialize and wait for completion
            await window.I18N_AJAX.init({
                defaultLang: CFG.defaultLang,
                supported: langs,
                basePath: CFG.basePath
            });

            // Global alias for convenience
            window.t = (k, fb) => window.I18N_AJAX.t(k, fb);

            // Apply translations - this is safe now because init() handles the timing
            if (window.I18N_AJAX.isInitialized()) {
                // Apply is already handled by the init process, but we can safely call it again
                await window.I18N_AJAX.apply();
            }

            document.documentElement.setAttribute('data-i18n-ready','1');
            console.log('[i18n] ready (safe init completed)');

        } catch(err){
            console.error('[i18n] init failed:', err);
            // Set ready attribute even on failure to prevent hanging
            document.documentElement.setAttribute('data-i18n-ready','error');

            // Set up a minimal fallback
            if (!window.t) {
                window.t = (k, fb) => fb !== undefined ? fb : k;
                console.log('[i18n] fallback translator installed');
            }
        } finally {
            window.__i18n_init_in_progress = false;
        }
    }

    // Handle different loading states
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, {once:true});
    } else {
        // DOM already ready, initialize immediately
        setTimeout(init, 0); // Use setTimeout to avoid blocking
    }
})();