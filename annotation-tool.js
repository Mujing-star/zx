/* ============================================================
 * 页面批注工具（审阅用浮层，不修改页面现有内容与逻辑）
 *
 * 数据模型：
 *   - 批注的工作列表 = 文件中已保存批注（页面内 annoEmbeddedData 数据块）
 *                    + 本机未保存的改动（localStorage）
 *   - 红色标记 = 未保存到文件（仅自己可见，刷新不丢）
 *   - 蓝色标记 = 已保存到 HTML 文件（git 提交后同事可见）
 *   - 点「保存到 HTML 文件」把工作列表直接写回本 HTML 文件，
 *     提交 Git 分支后，同事打开页面即可看到全部批注
 *
 * 移除方法：删除 HTML 末尾的批注数据块和 script 引用即可。
 * ============================================================ */
(function () {
    'use strict';
    if (window.__annoToolLoaded) return;
    window.__annoToolLoaded = true;

    var PAGE_NAME = decodeURIComponent(location.pathname.split('/').pop() || 'page');
    var STORAGE_KEY = 'anno-tool:' + PAGE_NAME;
    var HANDLE_KEY = 'anno-file-handle:' + PAGE_NAME;
    var Z = 2147483000;

    var annotations = [];    // 工作列表 {id, note, selector, snippet, date}
    var fileMap = {};        // 文件中已保存的批注 {id: annotation}
    var removedIds = {};     // 本机已删除、但文件里还存在的批注 id
    var annotateMode = false;
    var editorState = null;  // {target, existing}
    var els = {};            // 工具自身 DOM 引用
    var rafPending = false;
    var fileHandle = null;   // 本会话内缓存的文件句柄

    var STATE_TEXT = { draft: '未保存', modified: '已修改', saved: '已入文件' };
    var STATE_COLOR = { draft: '#d93025', modified: '#e8890c', saved: '#3370ff' };

    function stateOf(a) {
        var f = fileMap[a.id];
        if (!f) return 'draft';
        if (f.note !== a.note || f.selector !== a.selector) return 'modified';
        return 'saved';
    }

    /* ---------------- 数据加载 ---------------- */
    function loadFileAnnotations() {
        fileMap = {};
        var el = document.getElementById('annoEmbeddedData');
        if (!el) return [];
        var list = [];
        try { list = JSON.parse(el.textContent || '[]') || []; } catch (e) {}
        list = list.filter(function (a) { return a && a.id; });
        list.forEach(function (a) { fileMap[a.id] = a; });
        return list;
    }

    function loadLocal() {
        try {
            var v = JSON.parse(localStorage.getItem(STORAGE_KEY));
            if (v && v.list) return { list: v.list || [], removed: v.removed || [] };
        } catch (e) {}
        return { list: [], removed: [] };
    }

    function persist() {
        var removed = [];
        for (var id in removedIds) if (removedIds.hasOwnProperty(id)) removed.push(id);
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify({ list: annotations, removed: removed }));
        } catch (e) { /* 隐私模式下降级为内存保存 */ }
    }

    function loadAll() {
        var fromFile = loadFileAnnotations();
        var stored = loadLocal();
        removedIds = {};
        stored.removed.forEach(function (id) { removedIds[id] = true; });
        var merged = [], byId = {};
        fromFile.forEach(function (a) {
            if (!removedIds[a.id] && !byId[a.id]) { byId[a.id] = true; merged.push(a); }
        });
        stored.list.forEach(function (a) {
            if (!a || !a.id || removedIds[a.id]) return;
            if (byId[a.id]) {
                for (var i = 0; i < merged.length; i++) {
                    if (merged[i].id === a.id) { merged[i] = a; break; }
                }
            } else {
                byId[a.id] = true;
                merged.push(a);
            }
        });
        annotations = merged;
    }

    /* ---------------- 工具函数 ---------------- */
    function cssEscape(s) {
        if (window.CSS && CSS.escape) return CSS.escape(s);
        return String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
    }
    function cssPath(el) {
        var parts = [];
        while (el && el.nodeType === 1 && el !== document.body && el !== document.documentElement) {
            var part = el.tagName.toLowerCase();
            if (el.id) {
                parts.unshift('#' + cssEscape(el.id));
                break;
            }
            var parent = el.parentNode;
            if (!parent) break;
            var same = [];
            for (var i = 0; i < parent.children.length; i++) {
                if (parent.children[i].tagName === el.tagName) same.push(parent.children[i]);
            }
            if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(el) + 1) + ')';
            parts.unshift(part);
            el = parent;
        }
        return parts.join(' > ');
    }
    function resolveEl(selector) {
        try { return document.querySelector(selector); } catch (e) { return null; }
    }
    function snippetOf(el) {
        if (!el) return '';
        var t = el.getAttribute && (el.getAttribute('placeholder') || el.getAttribute('value'));
        if (!t) t = (el.innerText || el.textContent || '');
        t = t.replace(/\s+/g, ' ').trim();
        return t.length > 40 ? t.slice(0, 40) + '…' : t;
    }
    function today() {
        var d = new Date();
        function p(n) { return (n < 10 ? '0' : '') + n; }
        return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
    }
    function isOwnUI(el) {
        return !!(el && el.closest && el.closest('.anno-ui'));
    }

    /* ---------------- 样式 ---------------- */
    function injectStyle() {
        var css =
            '.anno-ui{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;}' +
            '.anno-ui *{box-sizing:border-box;}' +
            '#annoToolbar{position:fixed;right:16px;bottom:16px;z-index:' + (Z + 4) + ';display:flex;gap:8px;transition:right .2s;}' +
            '#annoToolbar.anno-toolbar-shift{right:356px;}' +
            '.anno-btn{border:none;border-radius:6px;padding:9px 14px;font-size:13px;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.25);line-height:1;}' +
            '.anno-btn-primary{background:#d93025;color:#fff;}' +
            '.anno-btn-primary.anno-active{background:#7a1a12;outline:2px solid #ffb4ab;}' +
            '.anno-btn-plain{background:#1f2329;color:#fff;position:relative;}' +
            '.anno-count{position:absolute;top:-7px;right:-7px;background:#d93025;color:#fff;font-size:10px;min-width:16px;height:16px;border-radius:8px;display:flex;align-items:center;justify-content:center;padding:0 4px;}' +
            '#annoHighlight{position:fixed;border:2px dashed #d93025;background:rgba(217,48,37,.08);z-index:' + Z + ';pointer-events:none;display:none;border-radius:3px;}' +
            '.anno-pin{position:fixed;width:20px;height:20px;border-radius:50%;background:#d93025;color:#fff;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;z-index:' + (Z + 1) + ';cursor:pointer;box-shadow:0 1px 4px rgba(0,0,0,.35);border:2px solid #fff;line-height:1;padding:0;}' +
            '.anno-pin-saved{background:#3370ff;}' +
            '.anno-pin-modified{background:#e8890c;}' +
            '#annoEditor{position:fixed;width:300px;background:#fff;border-radius:8px;box-shadow:0 8px 30px rgba(0,0,0,.28);z-index:' + (Z + 3) + ';padding:12px;display:none;border-top:3px solid #d93025;}' +
            '#annoEditor .anno-editor-title{font-size:12px;color:#646a73;margin-bottom:8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}' +
            '#annoEditor textarea{width:100%;height:84px;resize:vertical;border:1px solid #dee0e3;border-radius:6px;padding:8px;font-size:13px;font-family:inherit;line-height:1.5;}' +
            '#annoEditor textarea:focus{outline:none;border-color:#d93025;}' +
            '#annoEditor .anno-editor-btns{display:flex;justify-content:flex-end;gap:8px;margin-top:10px;}' +
            '.anno-btn-sm{border:none;border-radius:5px;padding:6px 14px;font-size:12px;cursor:pointer;}' +
            '.anno-btn-save{background:#d93025;color:#fff;}' +
            '.anno-btn-cancel{background:#f0f1f3;color:#1f2329;}' +
            '#annoDrawer{position:fixed;top:0;right:0;width:340px;max-width:90vw;height:100vh;background:#fff;box-shadow:-4px 0 20px rgba(0,0,0,.18);z-index:' + (Z + 2) + ';display:none;flex-direction:column;}' +
            '#annoDrawer .anno-drawer-head{padding:14px 16px;border-bottom:1px solid #f0f0f0;display:flex;align-items:center;justify-content:space-between;}' +
            '#annoDrawer .anno-drawer-head b{font-size:15px;}' +
            '#annoDrawer .anno-drawer-list{flex:1;overflow-y:auto;padding:10px 12px;}' +
            '.anno-item{border:1px solid #f0f0f0;border-radius:8px;padding:10px 12px;margin-bottom:10px;}' +
            '.anno-item .anno-item-top{display:flex;align-items:center;gap:8px;margin-bottom:4px;}' +
            '.anno-item .anno-item-num{background:#d93025;color:#fff;font-size:11px;font-weight:700;width:18px;height:18px;border-radius:50%;display:flex;align-items:center;justify-content:center;flex:none;}' +
            '.anno-item .anno-item-snippet{font-size:11px;color:#8f959e;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;}' +
            '.anno-item .anno-item-state{font-size:10px;flex:none;border:1px solid currentColor;border-radius:3px;padding:0 4px;line-height:1.6;}' +
            '.anno-item .anno-item-note{font-size:13px;color:#1f2329;white-space:pre-wrap;word-break:break-word;}' +
            '.anno-item .anno-item-ops{display:flex;gap:10px;margin-top:8px;}' +
            '.anno-item .anno-item-ops button{border:none;background:none;color:#3370ff;font-size:12px;cursor:pointer;padding:0;}' +
            '.anno-item .anno-item-ops button.anno-op-del{color:#d93025;}' +
            '.anno-item .anno-item-date{font-size:11px;color:#bbb;flex:none;}' +
            '#annoDrawer .anno-drawer-foot{padding:12px 16px 4px;border-top:1px solid #f0f0f0;display:flex;gap:8px;flex-wrap:wrap;}' +
            '#annoDrawer .anno-drawer-foot button{flex:1;border:none;border-radius:6px;padding:9px 0;font-size:12px;cursor:pointer;white-space:nowrap;}' +
            '.anno-btn-savefile{background:#d93025;color:#fff;}' +
            '.anno-btn-export{background:#1f2329;color:#fff;}' +
            '.anno-btn-clear{background:#f0f1f3;color:#646a73;}' +
            '.anno-foot-hint{font-size:11px;color:#8f959e;padding:0 16px 12px;line-height:1.6;}' +
            '.anno-empty{text-align:center;color:#bbb;font-size:13px;padding:40px 0;}' +
            '.anno-sec-head{font-size:12px;color:#8f959e;margin:8px 4px;font-weight:600;}' +
            '.anno-flash{position:fixed;border:2px solid #d93025;background:rgba(217,48,37,.12);z-index:' + Z + ';pointer-events:none;border-radius:3px;transition:opacity .6s;}' +
            '#annoToast{position:fixed;left:50%;bottom:70px;transform:translateX(-50%);background:rgba(0,0,0,.78);color:#fff;font-size:13px;padding:8px 18px;border-radius:6px;z-index:' + (Z + 5) + ';display:none;max-width:80vw;}' +
            'body.anno-mode-on, body.anno-mode-on *{cursor:crosshair !important;}';
        var style = document.createElement('style');
        style.id = 'annoToolStyle';
        style.textContent = css;
        document.head.appendChild(style);
    }

    /* ---------------- UI 构建 ---------------- */
    function buildUI() {
        var toolbar = document.createElement('div');
        toolbar.id = 'annoToolbar';
        toolbar.className = 'anno-ui';
        toolbar.innerHTML =
            '<button class="anno-btn anno-btn-plain" id="annoListBtn" title="查看本页全部批注">批注列表<span class="anno-count" id="annoCount" style="display:none;">0</span></button>' +
            '<button class="anno-btn anno-btn-primary" id="annoModeBtn" title="开启后点击页面任意元素即可添加批注">✎ 添加批注</button>';
        document.body.appendChild(toolbar);

        var hl = document.createElement('div');
        hl.id = 'annoHighlight';
        hl.className = 'anno-ui';
        document.body.appendChild(hl);

        var editor = document.createElement('div');
        editor.id = 'annoEditor';
        editor.className = 'anno-ui';
        editor.innerHTML =
            '<div class="anno-editor-title" id="annoEditorTitle"></div>' +
            '<textarea id="annoTextarea" placeholder="输入批注内容…"></textarea>' +
            '<div class="anno-editor-btns">' +
            '  <button class="anno-btn-sm anno-btn-cancel" id="annoCancelBtn">取消</button>' +
            '  <button class="anno-btn-sm anno-btn-save" id="annoSaveBtn">保存批注</button>' +
            '</div>';
        document.body.appendChild(editor);

        var drawer = document.createElement('div');
        drawer.id = 'annoDrawer';
        drawer.className = 'anno-ui';
        drawer.innerHTML =
            '<div class="anno-drawer-head"><b>本页批注</b><button class="anno-btn-sm anno-btn-cancel" id="annoDrawerClose">关闭</button></div>' +
            '<div class="anno-drawer-list" id="annoDrawerList"></div>' +
            '<div class="anno-drawer-foot">' +
            '  <button class="anno-btn-savefile" id="annoSaveFileBtn">保存到 HTML 文件</button>' +
            '  <button class="anno-btn-export" id="annoExportBtn">导出 Markdown</button>' +
            '  <button class="anno-btn-clear" id="annoClearBtn">清空</button>' +
            '</div>' +
            '<div class="anno-foot-hint">红色＝未保存（仅自己可见）；蓝色＝已保存到文件（提交 Git 后同事可见）</div>';
        document.body.appendChild(drawer);

        var toast = document.createElement('div');
        toast.id = 'annoToast';
        toast.className = 'anno-ui';
        document.body.appendChild(toast);

        els.toolbar = toolbar;
        els.hl = hl;
        els.editor = editor;
        els.drawer = drawer;
        els.toast = toast;

        document.getElementById('annoModeBtn').addEventListener('click', toggleMode);
        document.getElementById('annoListBtn').addEventListener('click', toggleDrawer);
        document.getElementById('annoDrawerClose').addEventListener('click', toggleDrawer);
        document.getElementById('annoSaveBtn').addEventListener('click', saveFromEditor);
        document.getElementById('annoCancelBtn').addEventListener('click', closeEditor);
        document.getElementById('annoSaveFileBtn').addEventListener('click', saveToFile);
        document.getElementById('annoExportBtn').addEventListener('click', exportMarkdown);
        document.getElementById('annoClearBtn').addEventListener('click', clearAll);
    }

    function toast(msg) {
        els.toast.textContent = msg;
        els.toast.style.display = 'block';
        clearTimeout(els.toast.__t);
        els.toast.__t = setTimeout(function () { els.toast.style.display = 'none'; }, 2200);
    }

    /* ---------------- 批注模式 ---------------- */
    function toggleMode() {
        annotateMode = !annotateMode;
        document.body.classList.toggle('anno-mode-on', annotateMode);
        document.getElementById('annoModeBtn').classList.toggle('anno-active', annotateMode);
        if (!annotateMode) hideHighlight();
        else toast('批注模式已开启：点击页面任意元素添加批注，Esc 退出');
    }

    function onMouseMove(e) {
        if (!annotateMode || rafPending) return;
        rafPending = true;
        requestAnimationFrame(function () {
            rafPending = false;
            var t = e.target;
            if (isOwnUI(t) || !annotateMode) { hideHighlight(); return; }
            var r = t.getBoundingClientRect();
            if (r.width === 0 && r.height === 0) { hideHighlight(); return; }
            els.hl.style.display = 'block';
            els.hl.style.left = r.left + 'px';
            els.hl.style.top = r.top + 'px';
            els.hl.style.width = r.width + 'px';
            els.hl.style.height = r.height + 'px';
        });
    }
    function hideHighlight() { els.hl.style.display = 'none'; }

    function onClickCapture(e) {
        if (!annotateMode) return;
        if (isOwnUI(e.target)) return; // 工具自身 UI 不拦截
        e.preventDefault();
        e.stopPropagation();
        hideHighlight();
        openEditor(e.clientX, e.clientY, e.target, null);
    }

    /* ---------------- 编辑器 ---------------- */
    function openEditor(x, y, target, existing) {
        editorState = { target: target, existing: existing };
        var title = existing
            ? ('批注 #' + (annotations.indexOf(existing) + 1) + '（' + STATE_TEXT[stateOf(existing)] + '）')
            : ('批注到：' + (snippetOf(target) || target.tagName.toLowerCase()));
        document.getElementById('annoEditorTitle').textContent = title;
        document.getElementById('annoTextarea').value = existing ? existing.note : '';
        var w = 300, h = 190;
        var left = Math.max(8, Math.min(x, window.innerWidth - w - 16));
        var top = Math.max(8, Math.min(y, window.innerHeight - h - 16));
        els.editor.style.left = left + 'px';
        els.editor.style.top = top + 'px';
        els.editor.style.display = 'block';
        setTimeout(function () { document.getElementById('annoTextarea').focus(); }, 0);
    }
    function closeEditor() {
        els.editor.style.display = 'none';
        editorState = null;
    }
    function saveFromEditor() {
        if (!editorState) return;
        var note = document.getElementById('annoTextarea').value.trim();
        if (!note) { toast('批注内容不能为空'); return; }
        if (editorState.existing) {
            editorState.existing.note = note;
            editorState.existing.date = today();
        } else {
            annotations.push({
                id: 'a' + Date.now(),
                note: note,
                selector: cssPath(editorState.target),
                snippet: snippetOf(editorState.target),
                date: today()
            });
        }
        persist();
        closeEditor();
        renderAll();
        toast('批注已保存（点「保存到 HTML 文件」后同事可见）');
    }

    /* ---------------- 标记（pins） ---------------- */
    function renderAll() {
        var old = document.querySelectorAll('.anno-pin');
        for (var i = 0; i < old.length; i++) old[i].parentNode.removeChild(old[i]);
        annotations.forEach(function (a, idx) {
            var st = stateOf(a);
            var pin = document.createElement('button');
            pin.className = 'anno-pin anno-ui' + (st === 'saved' ? ' anno-pin-saved' : st === 'modified' ? ' anno-pin-modified' : '');
            pin.textContent = idx + 1;
            pin.title = '[' + STATE_TEXT[st] + '] ' + a.note;
            pin.setAttribute('data-anno-id', a.id);
            pin.addEventListener('click', function (ev) {
                ev.preventDefault();
                ev.stopPropagation();
                openEditor(ev.clientX, ev.clientY, null, a);
            });
            document.body.appendChild(pin);
        });
        updatePins();
        renderCount();
        renderDrawer();
    }

    function updatePins() {
        annotations.forEach(function (a) {
            var pin = document.querySelector('.anno-pin[data-anno-id="' + a.id + '"]');
            if (!pin) return;
            var el = resolveEl(a.selector);
            if (!el) { pin.style.display = 'none'; return; }
            var r = el.getBoundingClientRect();
            var visible = (r.width > 0 || r.height > 0) && r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < window.innerWidth;
            if (!visible) { pin.style.display = 'none'; return; }
            pin.style.display = 'flex';
            pin.style.left = (r.left - 10) + 'px';
            pin.style.top = (r.top - 10) + 'px';
        });
    }

    /* ---------------- 列表抽屉 ---------------- */
    function renderCount() {
        var c = document.getElementById('annoCount');
        c.textContent = annotations.length;
        c.style.display = annotations.length ? 'flex' : 'none';
    }

    function renderDrawer() {
        var list = document.getElementById('annoDrawerList');
        list.innerHTML = '';
        if (!annotations.length) {
            list.innerHTML = '<div class="anno-empty">暂无批注<br>点击右下角「✎ 添加批注」开始</div>';
            return;
        }
        var unsaved = annotations.filter(function (a) { return stateOf(a) !== 'saved'; });
        var saved = annotations.filter(function (a) { return stateOf(a) === 'saved'; });
        if (unsaved.length) {
            appendSectionHead(list, '未保存到文件（' + unsaved.length + '）——同事还看不到');
            unsaved.forEach(function (a) { list.appendChild(buildItem(a)); });
        }
        if (saved.length) {
            appendSectionHead(list, '已保存到文件（' + saved.length + '）——同事可见');
            saved.forEach(function (a) { list.appendChild(buildItem(a)); });
        }
    }

    function appendSectionHead(list, text) {
        var h = document.createElement('div');
        h.className = 'anno-sec-head';
        h.textContent = text;
        list.appendChild(h);
    }

    function buildItem(a) {
        var st = stateOf(a);
        var item = document.createElement('div');
        item.className = 'anno-item';
        var top = document.createElement('div');
        top.className = 'anno-item-top';
        var num = document.createElement('span');
        num.className = 'anno-item-num';
        num.style.background = STATE_COLOR[st];
        num.textContent = annotations.indexOf(a) + 1;
        var snip = document.createElement('span');
        snip.className = 'anno-item-snippet';
        snip.textContent = a.snippet || '(无文本元素)';
        var tag = document.createElement('span');
        tag.className = 'anno-item-state';
        tag.style.color = STATE_COLOR[st];
        tag.textContent = STATE_TEXT[st];
        var date = document.createElement('span');
        date.className = 'anno-item-date';
        date.textContent = a.date || '';
        top.appendChild(num); top.appendChild(snip); top.appendChild(tag); top.appendChild(date);
        var note = document.createElement('div');
        note.className = 'anno-item-note';
        note.textContent = a.note;
        var ops = document.createElement('div');
        ops.className = 'anno-item-ops';
        var bLocate = document.createElement('button');
        bLocate.textContent = '定位';
        bLocate.addEventListener('click', function () { locateAnnotation(a); });
        var bEdit = document.createElement('button');
        bEdit.textContent = '编辑';
        bEdit.addEventListener('click', function (ev) { openEditor(ev.clientX || window.innerWidth / 2, 200, null, a); });
        var bDel = document.createElement('button');
        bDel.textContent = '删除';
        bDel.className = 'anno-op-del';
        bDel.addEventListener('click', function () {
            if (!confirm('删除这条批注？')) return;
            annotations.splice(annotations.indexOf(a), 1);
            if (fileMap[a.id]) removedIds[a.id] = true; // 文件里也有，记录下来防止复活
            persist();
            renderAll();
            toast('已删除（保存到 HTML 文件后对同事生效）');
        });
        ops.appendChild(bLocate); ops.appendChild(bEdit); ops.appendChild(bDel);
        item.appendChild(top); item.appendChild(note); item.appendChild(ops);
        return item;
    }

    function toggleDrawer() {
        var d = els.drawer;
        var show = d.style.display !== 'flex';
        d.style.display = show ? 'flex' : 'none';
        els.toolbar.classList.toggle('anno-toolbar-shift', show); // 抽屉打开时工具条左移，避免遮挡
        if (show) renderDrawer();
    }

    function locateAnnotation(a) {
        var el = resolveEl(a.selector);
        if (!el) { toast('未找到对应元素（页面结构可能已变化）'); return; }
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        setTimeout(function () {
            var r = el.getBoundingClientRect();
            var flash = document.createElement('div');
            flash.className = 'anno-flash anno-ui';
            flash.style.left = r.left + 'px';
            flash.style.top = r.top + 'px';
            flash.style.width = r.width + 'px';
            flash.style.height = r.height + 'px';
            document.body.appendChild(flash);
            setTimeout(function () { flash.style.opacity = '0'; }, 500);
            setTimeout(function () { flash.parentNode && flash.parentNode.removeChild(flash); }, 1200);
        }, 400);
    }

    /* ---------------- 保存到 HTML 文件 ---------------- */
    function serializeAnnotations() {
        var clean = annotations.map(function (a) {
            return { id: a.id, note: a.note, selector: a.selector, snippet: a.snippet, date: a.date };
        });
        // 转义 "</"，防止批注内容里的 </script> 破坏 HTML
        return JSON.stringify(clean, null, 2).replace(/<\//g, '<\\/');
    }

    function saveToFile() {
        var json = serializeAnnotations();
        if (window.showOpenFilePicker || window.__annoTestHandle) {
            directWrite(json);
        } else {
            fallbackDownload(json);
        }
    }

    function directWrite(json) {
        getFileHandle().then(function (h) {
            if (!h) return; // 用户取消选择文件
            return h.getFile().then(function (f) { return f.text(); }).then(function (text) {
                if (text.indexOf('id="annoEmbeddedData"') < 0) {
                    toast('所选文件不含批注数据块，请选择本页面对应的 HTML 文件');
                    return;
                }
                var marker = /(<script[^>]*id="annoEmbeddedData"[^>]*>)[\s\S]*?(<\/script>)/;
                if (!marker.test(text)) {
                    toast('写入失败：文件中未找到批注数据块');
                    return;
                }
                var newText = text.replace(marker, function (m, p1, p2) { return p1 + json + p2; });
                return h.createWritable().then(function (w) {
                    return w.write(newText).then(function () { return w.close(); });
                }).then(function () {
                    afterSaved(json);
                    toast('已保存到 HTML 文件，提交 Git 后同事即可看到');
                });
            });
        }).catch(function (e) {
            if (e && e.name === 'AbortError') return; // 用户取消
            toast('保存失败：' + (e && e.message ? e.message : e));
        });
    }

    function afterSaved(json) {
        var el = document.getElementById('annoEmbeddedData');
        if (el) el.textContent = json;
        loadFileAnnotations();
        removedIds = {}; // 删除记录已写入文件，无需再追踪
        persist();
        renderAll();
    }

    function getFileHandle() {
        if (window.__annoTestHandle) return Promise.resolve(window.__annoTestHandle);
        if (fileHandle) {
            return verifyHandle(fileHandle).then(function (ok) {
                return ok ? fileHandle : pickFile();
            });
        }
        return idbGet(HANDLE_KEY).then(function (h) {
            if (!h) return pickFile();
            return verifyHandle(h).then(function (ok) {
                if (ok) { fileHandle = h; return h; }
                return pickFile();
            });
        });
    }

    function pickFile() {
        return window.showOpenFilePicker({
            types: [{ description: '本页面对应的 HTML 文件（' + PAGE_NAME + '）', accept: { 'text/html': ['.html', '.htm'] } }]
        }).then(function (handles) {
            fileHandle = handles[0];
            idbSet(HANDLE_KEY, fileHandle);
            return fileHandle;
        });
    }

    function verifyHandle(h) {
        var opts = { mode: 'readwrite' };
        return h.queryPermission(opts).then(function (p) {
            if (p === 'granted') return true;
            return h.requestPermission(opts).then(function (p2) { return p2 === 'granted'; });
        });
    }

    /* IndexedDB：缓存文件句柄，下次保存免选文件 */
    function idbOpen() {
        return new Promise(function (res, rej) {
            var req = indexedDB.open('anno-tool-db', 1);
            req.onupgradeneeded = function () { req.result.createObjectStore('handles'); };
            req.onsuccess = function () { res(req.result); };
            req.onerror = function () { rej(req.error); };
        });
    }
    function idbGet(key) {
        return idbOpen().then(function (db) {
            return new Promise(function (res) {
                var rq = db.transaction('handles', 'readonly').objectStore('handles').get(key);
                rq.onsuccess = function () { res(rq.result || null); };
                rq.onerror = function () { res(null); };
            });
        }).catch(function () { return null; });
    }
    function idbSet(key, val) {
        return idbOpen().then(function (db) {
            return new Promise(function (res) {
                var tx = db.transaction('handles', 'readwrite');
                tx.objectStore('handles').put(val, key);
                tx.oncomplete = function () { res(); };
                tx.onerror = function () { res(); };
            });
        }).catch(function () {});
    }

    /* 降级方案：浏览器不支持直接写文件时，导出完整 HTML 由用户手动替换 */
    function fallbackDownload(json) {
        var clone = document.documentElement.cloneNode(true);
        var own = clone.querySelectorAll('.anno-ui, #annoToolStyle');
        for (var i = 0; i < own.length; i++) own[i].parentNode.removeChild(own[i]);
        var bodyEl = clone.querySelector('body');
        if (bodyEl) bodyEl.classList.remove('anno-mode-on');
        var dataEl = clone.querySelector('#annoEmbeddedData');
        if (!dataEl) { toast('当前页面缺少批注数据块，无法保存'); return; }
        dataEl.textContent = json;
        var html = '<!DOCTYPE html>\n' + clone.outerHTML;
        var blob = new Blob([html], { type: 'text/html;charset=utf-8' });
        var url = URL.createObjectURL(blob);
        var link = document.createElement('a');
        link.href = url;
        link.download = PAGE_NAME;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
        toast('当前浏览器不支持直接写文件：已下载完整 HTML，请替换项目中的同名文件');
    }

    /* ---------------- 导出 Markdown ---------------- */
    function exportMarkdown() {
        var title = document.title || PAGE_NAME;
        var lines = [];
        lines.push('# 页面批注：' + title);
        lines.push('');
        lines.push('- 页面文件：' + PAGE_NAME);
        lines.push('- 导出日期：' + today());
        lines.push('- 批注数量：' + annotations.length);
        lines.push('');
        if (!annotations.length) lines.push('（暂无批注）');
        annotations.forEach(function (a, idx) {
            lines.push('## 批注 ' + (idx + 1));
            lines.push('');
            lines.push('- 页面元素：' + (a.snippet || '(无文本元素)'));
            lines.push('- 状态：' + STATE_TEXT[stateOf(a)]);
            lines.push('- 元素定位：`' + a.selector + '`');
            lines.push('- 批注日期：' + (a.date || ''));
            lines.push('');
            lines.push('> ' + a.note.split('\n').join('\n> '));
            lines.push('');
        });
        var blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/markdown;charset=utf-8' });
        var url = URL.createObjectURL(blob);
        var link = document.createElement('a');
        link.href = url;
        link.download = '页面批注-' + PAGE_NAME.replace(/\.html?$/i, '') + '-' + today() + '.md';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
        toast('已导出 ' + annotations.length + ' 条批注');
    }

    function clearAll() {
        if (!annotations.length) { toast('暂无批注'); return; }
        if (!confirm('确定删除本页全部 ' + annotations.length + ' 条批注？此操作不可恢复。')) return;
        annotations.forEach(function (a) { if (fileMap[a.id]) removedIds[a.id] = true; });
        annotations = [];
        persist();
        renderAll();
        toast('已清空（保存到 HTML 文件后才会从文件中删除）');
    }

    /* ---------------- 全局事件 ---------------- */
    function bindEvents() {
        document.addEventListener('mousemove', onMouseMove, true);
        document.addEventListener('click', onClickCapture, true);
        window.addEventListener('scroll', updatePins, true);
        window.addEventListener('resize', updatePins);
        setInterval(updatePins, 600); // 页面切换页签/内容后自动校正标记位置
        document.addEventListener('keydown', function (e) {
            if (e.key !== 'Escape') return;
            if (els.editor.style.display === 'block') { closeEditor(); return; }
            if (annotateMode) toggleMode();
        });
    }

    /* ---------------- 启动 ---------------- */
    function init() {
        injectStyle();
        buildUI();
        loadAll();
        renderAll();
        bindEvents();
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
