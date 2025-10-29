/*!
 * favorit.js — Избранное + Возврат последнего канала + Общие настройки
 * Вкладка User-Agent и сетевые хуки вынесены в ua_settings.js
 *
 * Требование: подключите ua_settings.js ДО этого файла.
 */
(function(){
    'use strict';

    // ---------- i18n ----------
    const tr = (k, fb) => {
        try {
            if (typeof window.t === 'function') return window.t(k, fb);
            if (window.I18N_AJAX?.t) return window.I18N_AJAX.t(k, fb);
        } catch(_) {}
        return fb ?? k;
    };

    // ---------- Storage ----------
    const LS = {
        favSet:     'fav:set',
        favFilter:  'fav:filter',
        lastUrl:    'fav:lastUrl',
        lastGroup:  'fav:lastGroup',
        resume:     'fav:resume'
    };

    // ---------- utils ----------
    const readJSON  = (k, d)=>{ try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
    const writeJSON = (k, v)=> localStorage.setItem(k, JSON.stringify(v));
    const $  = (sel, root=document) => root.querySelector(sel);
    const $$ = (sel, root=document) => Array.from(root.querySelectorAll(sel));

    // ---------- Favorites ----------
    const Favorites = {
        _set: new Set(readJSON(LS.favSet, [])),

        has(url){ return this._set.has(url); },

        toggle(url){
            if (!url) return false;
            if (this._set.has(url)) this._set.delete(url); else this._set.add(url);
            writeJSON(LS.favSet, Array.from(this._set));
            return this._set.has(url);
        },

        decorateItem(item){
            if (!item || item.nodeType !== 1) return;
            const url = item.dataset?.url || '';

            let btn = item.querySelector('.fav-toggle');
            if (!btn){
                btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'fav-toggle';
                btn.title = tr('ui.favorites','Избранное');
                btn.innerHTML = '<i class="fa-regular fa-star"></i>';
                item.appendChild(btn);
            }

            const active = this._set.has(url);
            item.classList.toggle('is-favorite', active);
            const icon = btn.querySelector('i');
            if (icon){
                icon.classList.toggle('fa-regular', !active);
                icon.classList.toggle('fa-solid', active);
            }
        },

        refreshAll(){ $$('.channel-item').forEach(item => this.decorateItem(item)); },

        applyFilter(flag){
            writeJSON(LS.favFilter, !!flag);
            const onlyFav = !!flag;
            $$('.channel-item').forEach(item => {
                if (!onlyFav) item.style.display = '';
                else item.style.display = item.classList.contains('is-favorite') ? '' : 'none';
            });
            const btn = $('#favorites-filter-btn');
            if (btn) btn.classList.toggle('active', onlyFav);
        },

        applyFilterFromState(){ this.applyFilter(!!readJSON(LS.favFilter, false)); }
    };

    // ---------- Resume ----------
    const Resume = {
        enabled(){ return !!readJSON(LS.resume, false); },
        enable(flag){ writeJSON(LS.resume, !!flag); },
        setLast(url){ if (url) localStorage.setItem(LS.lastUrl, url); },
        getLast(){ return localStorage.getItem(LS.lastUrl) || ''; },
        setLastGroup(v){ if (typeof v === 'string') localStorage.setItem(LS.lastGroup, v); },
        getLastGroup(){ return localStorage.getItem(LS.lastGroup) || ''; },

        highlightAndScroll(url){
            if (!url) return false;
            const list = document.getElementById('channels-list');
            if (!list) return false;

            list.querySelectorAll('.channel-item').forEach(it => it.classList.remove('active'));
            const el = list.querySelector(`.channel-item[data-url="${CSS.escape(url)}"]`);
            if (!el) return false;

            el.classList.add('active');
            try { el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }); } catch {}
            return true;
        },

        gotoLastWhenReady(){
            if (!this.enabled()) return;
            const targetUrl = this.getLast();
            const targetGroup = this.getLastGroup();
            if (!targetUrl) return;

            const list = document.getElementById('channels-list');

            const groupSel = document.getElementById('group-filter');
            if (groupSel && targetGroup && groupSel.value !== targetGroup) {
                groupSel.value = targetGroup;
                groupSel.dispatchEvent(new Event('input', { bubbles: true }));
                groupSel.dispatchEvent(new Event('change', { bubbles: true }));
            }

            const tryFocus = () => {
                const focused = this.highlightAndScroll(targetUrl);
                if (!focused) return false;
                const el = list?.querySelector(`.channel-item[data-url="${CSS.escape(targetUrl)}"]`);
                if (el) el.click();
                return !!el;
            };

            if (tryFocus()) return;

            if (!list) return;
            const mo = new MutationObserver(() => { if (tryFocus()) mo.disconnect(); });
            mo.observe(list, { childList: true, subtree: true });
            setTimeout(() => mo.disconnect(), 15000);
        }
    };

    // ---------- Public API ----------
    window.AppFavorites = Favorites;
    window.AppResume    = Resume;

    // ---------- UI ----------
    function ensureSettingsButton(){
        if ($('#open-settings')) return;
        const sections = $$('#header .header-section');
        const host = sections[1] || sections[0] || $('#header');
        const btn = document.createElement('button');
        btn.id = 'open-settings';
        btn.className = 'header-button';
        btn.title = tr("ui.settings","Настройки");
        btn.innerHTML = '<i class="fas fa-cog"></i>';
        host?.appendChild(btn);
    }

    function ensureFavFilterButton(){
        if ($('#favorites-filter-btn')) return;
        const fc = $('#filter-controls');
        if (!fc) return;
        const btn = document.createElement('button');
        btn.id = 'favorites-filter-btn';
        btn.className = 'header-button';
        btn.title = tr("ui.show_favorites","Показать избранные");
        btn.innerHTML = '<i class="fas fa-star"></i>';
        const sel = $('#group-filter', fc);
        if (sel && sel.nextSibling) fc.insertBefore(btn, sel.nextSibling);
        else fc.appendChild(btn);
    }

    function ensureSettingsDialog(){
        if ($('#settings-dialog')) return;
        const tpl = document.createElement('div');
        tpl.id = 'settings-dialog';
        tpl.className = 'dialog-overlay';
        tpl.innerHTML = `
      <div class="dialog">
        <div class="dialog-header">
          <div class="dialog-title"><span data-i18n="ui.settings">${tr('ui.settings','Настройки')}</span></div>
          <button class="dialog-close" title="${tr('ui.close','Закрыть')}">&times;</button>
        </div>
        <div class="dialog-body">
          <div class="dialog-tabs">
            <div class="dialog-tab active" data-tab="general-tab"><span data-i18n="ui.general">${tr('ui.general','Общие')}</span></div>
            <!-- Вкладка UA будет добавлена ua_settings.js -->
          </div>

          <div id="general-tab" class="dialog-content active">
            <label style="display:flex;align-items:center;gap:8px;">
              <input type="checkbox" id="resume-last-enabled">
              <span><span data-i18n="ui.resume_last">${tr('ui.resume_last','Возобновлять последний канал')}</span></span>
            </label>
          </div>
          <!-- Панель UA будет добавлена ua_settings.js -->
        </div>
        <div class="dialog-footer">
          <button class="btn btn-outline" id="settings-cancel"><span data-i18n="ui.cancel">${tr('ui.cancel','Отмена')}</span></button>
          <button class="btn btn-primary" id="settings-save"><span data-i18n="ui.save">${tr('ui.save','Сохранить')}</span></button>
        </div>
      </div>
    `;
        document.body.appendChild(tpl);

        // Полная инъекция вкладки и содержимого из UA-модуля
        if (window.UASettings && typeof window.UASettings.injectTabs === 'function') {
            window.UASettings.injectTabs(tpl);
        }
    }

    function bindEvents(){
        // избранное
        $('#channels-list')?.addEventListener('click', (e) => {
            const starBtn = e.target.closest('.fav-toggle');
            if (!starBtn) return;
            e.stopPropagation();
            const item = e.target.closest('.channel-item');
            const url = item?.dataset?.url || '';
            Favorites.toggle(url);
            Favorites.decorateItem(item);
        });

        // last + подсветка + сохранение группы (только если включено)
        $('#channels-list')?.addEventListener('click', (e) => {
            const item = e.target.closest('.channel-item');
            if (!item) return;
            const url = item.dataset?.url || '';

            if (Resume.enabled()) {
                if (url) Resume.setLast(url);
                const groupSel = document.getElementById('group-filter');
                if (groupSel) Resume.setLastGroup(groupSel.value || '');
            }

            const list = document.getElementById('channels-list');
            list?.querySelectorAll('.channel-item').forEach(it => it.classList.remove('active'));
            item.classList.add('active');
        });

        // временная подмена data-url на прокси-URL (если включён UA)
        const list = $('#channels-list');
        if (list && window.UASettings){
            list.addEventListener('click', (e) => {
                const item = e.target.closest('.channel-item');
                if (!item) return;
                const original = item.dataset?.url || '';
                if (!original || !window.UASettings.isEnabled()) return;
                const proxied = window.UASettings.buildProxyUrl(original);
                item.dataset.url = proxied;
                setTimeout(() => { item.dataset.url = original; }, 0);
            }, true);
        }

        // фильтр избранного
        $('#favorites-filter-btn')?.addEventListener('click', () => {
            const current = !!readJSON(LS.favFilter, false);
            Favorites.applyFilter(!current);
        });

        // открыть/закрыть настройки
        $('#open-settings')?.addEventListener('click', () => openSettingsDialog(true));
        $('#settings-dialog')?.addEventListener('click', (e) => {
            if (e.target.classList.contains('dialog-overlay')) openSettingsDialog(false);
        });
        $('#settings-dialog .dialog-close')?.addEventListener('click', () => openSettingsDialog(false));
        $('#settings-cancel')?.addEventListener('click', () => openSettingsDialog(false));
        $('#settings-save')?.addEventListener('click', saveSettings);

        // переключение вкладок (делаем после injectTabs)
        $('#settings-dialog')?.addEventListener('click', (e) => {
            const tab = e.target.closest('.dialog-tab');
            if (!tab) return;
            const dlg = $('#settings-dialog');
            $$('.dialog-tab', dlg).forEach(t => t.classList.remove('active'));
            $$('.dialog-content', dlg).forEach(c => c.classList.remove('active'));
            tab.classList.add('active');
            $('#'+tab.dataset.tab, dlg)?.classList.add('active');
        });
    }

    function openSettingsDialog(show){
        const dlg = $('#settings-dialog');
        if (!dlg) return;
        if (show){
            $('#resume-last-enabled').checked = Resume.enabled();
            if (window.UASettings) window.UASettings.onOpen(dlg);
            dlg.classList.add('active');
        } else {
            dlg.classList.remove('active');
        }
    }

    function saveSettings(){
        const wasEnabled = Resume.enabled();
        const willEnable = $('#resume-last-enabled').checked;
        Resume.enable(willEnable);
        if (window.UASettings) window.UASettings.saveFromUI($('#settings-dialog'));

        // При выключении опции очищаем сохранённые значения (чтобы не всплывали в будущем)
        if (wasEnabled && !willEnable) {
            localStorage.removeItem(LS.lastUrl);
            localStorage.removeItem(LS.lastGroup);
        }

        openSettingsDialog(false);
    }

    function observeChannelsList(){
        const list = $('#channels-list');
        if (!list) return;
        const mo = new MutationObserver((muts) => {
            let changed = false;
            for (const m of muts) if (m.addedNodes && m.addedNodes.length) { changed = true; break; }
            if (changed){
                Favorites.refreshAll();
                Favorites.applyFilterFromState();
                // Возврат к последнему — только если включено
                if (Resume.enabled()) {
                    const last = Resume.getLast();
                    if (last) Resume.highlightAndScroll(last);
                }
            }
        });
        mo.observe(list, { childList: true, subtree: true });
    }

    // ---------- mini CSS ----------
    (function injectCSS(){
        const css = `
      .lang-switcher{ display:inline-flex; gap:6px; align-items:center; margin-left:8px; }
      .lang-btn{ background:#2a2a2a; border:1px solid #444; color:#eee; padding:2px 6px; border-radius:6px; cursor:pointer; font-size:12px; }
      .lang-btn.active{ background:#3a5af9; border-color:#3a5af9; }
      .lang-btn.is-active {border-color:#3b82f6 !important; box-shadow:0 0 0 2px rgba(59,130,246,.35) inset;}

      #filter-controls{ display:grid !important; grid-template-columns:1fr auto; grid-auto-rows:minmax(32px,auto); gap:8px; align-items:center; }
      #group-filter{ grid-column:1/2; }
      #favorites-filter-btn{ grid-column:2/3; justify-self:end; }
      .channel-item .fav-toggle{ background:transparent; border:0; cursor:pointer; font-size:18px; line-height:1; padding:4px 6px; color:#ccc; }
      .channel-item.is-favorite .fav-toggle{ color:#ffd54f; }
      .channel-item.is-favorite .fav-toggle i{ filter: drop-shadow(0 0 2px rgba(255,215,0,.45)); }
      #favorites-filter-btn.active { outline: 2px solid var(--button-primary); }

      .dialog-overlay{ position:fixed; inset:0; background:rgba(0,0,0,.5); display:none; z-index:9999; }
      .dialog-overlay.active{ display:flex; align-items:center; justify-content:center; }
      .dialog{ width:560px; max-width:calc(100vw - 24px); background:#1e1e1e; color:#eee; border-radius:10px; box-shadow:0 10px 30px rgba(0,0,0,.6); }
      .dialog-header{ display:flex; justify-content:space-between; align-items:center; padding:12px 16px; border-bottom:1px solid #333; }
      .dialog-title{ font-weight:600; }
      .dialog-close{ background:transparent; border:0; color:#aaa; font-size:22px; cursor:pointer; }
      .dialog-body{ padding:12px 16px; }
      .dialog-footer{ padding:12px 16px; display:flex; gap:8px; justify-content:flex-end; border-top:1px solid #333; }
      .dialog-tabs{ display:flex; gap:8px; margin-bottom:8px; }
      .dialog-tab{ padding:6px 10px; border-radius:6px; cursor:pointer; background:#2a2a2a; color:#bbb; }
      .dialog-tab.active{ background:#3a3a3a; color:#fff; }
      .dialog-content{ display:none; }
      .dialog-content.active{ display:block; }
      .form-input{ width:100%; padding:8px 10px; border-radius:8px; border:1px solid #444; background:#131313; color:#eee; }
      .ua-note{ font-size:12px; color:#aaa; }
    `;
        const el = document.createElement('style');
        el.textContent = css;
        document.head.appendChild(el);
    })();

    // ---------- init ----------
    document.addEventListener('DOMContentLoaded', () => {
        ensureSettingsButton();
        ensureFavFilterButton();
        ensureSettingsDialog();

        bindEvents();
        observeChannelsList();

        Favorites.refreshAll();
        Favorites.applyFilterFromState();
        Resume.gotoLastWhenReady();
    });

})();
