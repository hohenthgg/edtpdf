(() => {
  'use strict';

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

  const A4_WIDTH_PX = 210 * 96 / 25.4;
  const A4_HEIGHT_PX = 297 * 96 / 25.4;
  const PDF_CSS_SCALE = 96 / 72;
  const DB_NAME = 'natural-pdf-studio';
  const DB_STORE = 'sessions';
  const DB_KEY = 'current';

  const marginPresets = {
    normal: { top: mm(25.4), right: mm(25.4), bottom: mm(25.4), left: mm(25.4) },
    abnt: { top: mm(30), right: mm(20), bottom: mm(20), left: mm(30) },
    compact: { top: mm(15), right: mm(15), bottom: mm(15), left: mm(15) },
    wide: { top: mm(32), right: mm(32), bottom: mm(32), left: mm(32) }
  };

  const dom = {
    app: $('#app'),
    workspace: $('#workspace'),
    pagesHost: $('#pagesHost'),
    pageList: $('#pageList'),
    pageCountLabel: $('#pageCountLabel'),
    documentSubtitle: $('#documentSubtitle'),
    emptyState: $('#emptyState'),
    restoreSessionBox: $('#restoreSessionBox'),
    progressOverlay: $('#progressOverlay'),
    progressTitle: $('#progressTitle'),
    progressText: $('#progressText'),
    progressBar: $('#progressBar'),
    toast: $('#toast'),
    pdfFileInput: $('#pdfFileInput'),
    projectFileInput: $('#projectFileInput'),
    imageFileInput: $('#imageFileInput'),
    newDocumentDialog: $('#newDocumentDialog'),
    confirmDialog: $('#confirmDialog'),
    confirmTitle: $('#confirmTitle'),
    confirmMessage: $('#confirmMessage'),
    confirmOkBtn: $('#confirmOkBtn'),
    pageFloatToolbar: $('#pageFloatToolbar'),
    noSelectionHint: $('#noSelectionHint'),
    selectionControls: $('#selectionControls'),
    marginPreset: $('#marginPreset'),
    lineHeightSelect: $('#lineHeightSelect')
  };

  let state = createEmptyState();
  let pdfDocument = null;
  let pdfBuffer = null;
  let pageRenderObserver = null;
  let currentPageObserver = null;
  let selectedElementId = null;
  let activeFlowEditor = null;
  let savedRange = null;
  let saveTimer = null;
  let toastTimer = null;
  const historyStack = [];
  const HISTORY_LIMIT = 40;
  const HISTORY_MAX_SNAPSHOT = 20 * 1024 * 1024;
  let imageInsertTargetPageId = null;
  let pointerOperation = null;
  let isExporting = false;
  const renderPromises = new Map();

  if (window.pdfjsLib) {
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
  }

  function mm(value) {
    return value * 96 / 25.4;
  }

  function createEmptyState() {
    return {
      version: 1,
      title: '',
      sourceType: null,
      fileName: '',
      mode: 'edit',
      zoom: 1,
      currentPageId: null,
      nextZ: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      pages: []
    };
  }

  function uid(prefix = 'id') {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function deepClone(value) {
    return window.structuredClone ? structuredClone(value) : JSON.parse(JSON.stringify(value));
  }

  function cleanFileName(value, fallback = 'documento') {
    return String(value || fallback)
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '') || fallback;
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function sanitizeUserHtml(html) {
    const template = document.createElement('template');
    template.innerHTML = html || '';
    template.content.querySelectorAll('script, iframe, object, embed, link, meta, base').forEach(node => node.remove());
    template.content.querySelectorAll('*').forEach(node => {
      [...node.attributes].forEach(attr => {
        const name = attr.name.toLowerCase();
        const value = attr.value.trim().toLowerCase();
        if (name.startsWith('on') || value.startsWith('javascript:')) node.removeAttribute(attr.name);
      });
    });
    return template.innerHTML;
  }

  function showToast(message, duration = 2200) {
    clearTimeout(toastTimer);
    dom.toast.textContent = message;
    dom.toast.classList.add('show');
    toastTimer = setTimeout(() => dom.toast.classList.remove('show'), duration);
  }

  function setProgress(title, text = '', percent = 0) {
    dom.progressTitle.textContent = title;
    dom.progressText.textContent = text;
    dom.progressBar.style.width = `${clamp(percent, 0, 100)}%`;
    dom.progressOverlay.classList.remove('hidden');
  }

  function updateProgress(text, percent) {
    dom.progressText.textContent = text;
    dom.progressBar.style.width = `${clamp(percent, 0, 100)}%`;
  }

  function hideProgress() {
    dom.progressOverlay.classList.add('hidden');
    dom.progressBar.style.width = '0%';
  }

  function downloadBlob(blob, filename) {
    const anchor = document.createElement('a');
    const url = URL.createObjectURL(blob);
    anchor.href = url;
    anchor.download = filename;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function readFileAsDataURL(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error('Falha ao ler arquivo.'));
      reader.readAsDataURL(file);
    });
  }

  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
  }

  function base64ToArrayBuffer(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  }

  function getPage(pageId = state.currentPageId) {
    return state.pages.find(page => page.id === pageId) || null;
  }

  function getCurrentPageIndex() {
    return Math.max(0, state.pages.findIndex(page => page.id === state.currentPageId));
  }

  function getElement(elementId = selectedElementId) {
    for (const page of state.pages) {
      const element = page.elements?.find(item => item.id === elementId);
      if (element) return { page, element };
    }
    return null;
  }

  function createBlankPage(options = {}) {
    return {
      id: uid('page'),
      type: 'blank',
      width: A4_WIDTH_PX,
      height: A4_HEIGHT_PX,
      marginPreset: options.marginPreset || 'normal',
      lineHeight: Number(options.lineHeight || 1.5),
      html: options.html || '',
      elements: options.elements || [],
      thumb: null
    };
  }

  function serializeState() {
    const output = deepClone(state);
    output.pages.forEach(page => delete page.thumb);
    output.updatedAt = new Date().toISOString();
    return output;
  }

  function pushHistory() {
    try {
      const snapshot = JSON.stringify(serializeState());
      if (snapshot.length > HISTORY_MAX_SNAPSHOT) return;
      historyStack.push(snapshot);
      if (historyStack.length > HISTORY_LIMIT) historyStack.shift();
    } catch (error) {
      console.warn('Não foi possível registrar o histórico.', error);
    }
  }

  function undoLastAction() {
    if (!historyStack.length) {
      showToast('Nada para desfazer.');
      return;
    }
    try {
      const restored = JSON.parse(historyStack.pop());
      restored.pages.forEach(page => {
        page.elements ||= [];
        page.thumb = null;
      });
      state = restored;
      renderDocument({ scrollToCurrent: false });
      scheduleSessionSave();
      showToast('Ação desfeita.');
    } catch (error) {
      console.error(error);
    }
  }

  async function askConfirm(title, message, okLabel = 'Continuar') {
    dom.confirmTitle.textContent = title;
    dom.confirmMessage.textContent = message;
    dom.confirmOkBtn.textContent = okLabel;
    dom.confirmDialog.showModal();
    return new Promise(resolve => {
      const handler = () => {
        dom.confirmDialog.removeEventListener('close', handler);
        resolve(dom.confirmDialog.returnValue === 'default');
      };
      dom.confirmDialog.addEventListener('close', handler);
    });
  }

  async function confirmDocumentReplacement() {
    if (!state.pages.length) return true;
    return askConfirm(
      'Substituir documento atual?',
      'O editor trabalha com um documento por vez. Salve o projeto atual antes de continuar, caso queira preservá-lo.',
      'Substituir'
    );
  }

  function applyAppDocumentState() {
    const hasDocument = state.pages.length > 0;
    dom.app.classList.toggle('no-document', !hasDocument);
    dom.app.classList.toggle('has-document', hasDocument);
    dom.documentSubtitle.textContent = hasDocument ? (state.title || state.fileName || 'documento') : 'editor local de PDF e A4';
    dom.pageCountLabel.textContent = String(state.pages.length);
    setMode(state.mode || 'edit', false);
  }

  function setMode(mode, save = true) {
    state.mode = mode === 'read' ? 'read' : 'edit';
    document.body.classList.toggle('read-mode', state.mode === 'read');
    document.body.classList.toggle('edit-mode', state.mode === 'edit');
    $('#readModeBtn').classList.toggle('active', state.mode === 'read');
    $('#editModeBtn').classList.toggle('active', state.mode === 'edit');

    $$('.flow-editor').forEach(editor => editor.contentEditable = state.mode === 'edit' ? 'true' : 'false');
    $$('.editor-element[data-type="text"] .element-body').forEach(editor => editor.contentEditable = state.mode === 'edit' ? 'true' : 'false');

    if (state.mode === 'read') clearSelection();
    if (save) scheduleSessionSave();
  }

  function setZoom(value) {
    state.zoom = clamp(Number(value) || 1, 0.4, 2.2);
    $('#zoomLabel').textContent = `${Math.round(state.zoom * 100)}%`;
    $$('.page-shell').forEach(shell => {
      const page = getPage(shell.dataset.pageId);
      if (!page) return;
      shell.style.width = `${page.width * state.zoom}px`;
      shell.style.height = `${page.height * state.zoom}px`;
      const paper = $('.paper', shell);
      paper.style.transform = `scale(${state.zoom})`;
    });
    scheduleSessionSave();
  }

  function renderDocument(options = {}) {
    disconnectObservers();
    dom.pagesHost.innerHTML = '';
    dom.pageList.innerHTML = '';
    selectedElementId = null;
    activeFlowEditor = null;

    state.pages.forEach((page, index) => {
      const shell = createPageShell(page, index);
      dom.pagesHost.append(shell);
      dom.pageList.append(createPageThumb(page, index));
    });

    applyAppDocumentState();
    setZoom(state.zoom || 1);
    setupObservers();
    updatePageSelectionUI();
    updateSelectionInspector();

    if (state.currentPageId && options.scrollToCurrent !== false) {
      requestAnimationFrame(() => scrollToPage(state.currentPageId, false));
    }
  }

  function createPageShell(page, index) {
    const shell = document.createElement('section');
    shell.className = 'page-shell';
    shell.id = `shell-${page.id}`;
    shell.dataset.pageId = page.id;
    shell.style.width = `${page.width * state.zoom}px`;
    shell.style.height = `${page.height * state.zoom}px`;

    const paper = document.createElement('article');
    paper.className = 'paper';
    paper.id = `paper-${page.id}`;
    paper.dataset.pageId = page.id;
    paper.style.width = `${page.width}px`;
    paper.style.height = `${page.height}px`;
    paper.style.transform = `scale(${state.zoom})`;

    if (page.type === 'pdf') {
      const canvas = document.createElement('canvas');
      canvas.className = 'pdf-canvas';
      canvas.setAttribute('aria-label', `Página ${index + 1} do PDF`);
      const textLayer = document.createElement('div');
      textLayer.className = 'text-layer';
      const overlay = document.createElement('div');
      overlay.className = 'overlay-layer';
      paper.append(canvas, textLayer, overlay);
      paper.dataset.rendered = '0';
    } else {
      const base = document.createElement('div');
      base.className = 'blank-page-base';
      const guide = document.createElement('div');
      guide.className = 'margin-guide';
      const editor = document.createElement('div');
      editor.className = 'flow-editor';
      editor.contentEditable = state.mode === 'edit' ? 'true' : 'false';
      editor.spellcheck = true;
      editor.innerHTML = sanitizeUserHtml(page.html || '');
      applyBlankPageLayout(page, editor, guide);
      editor.addEventListener('focus', () => {
        activeFlowEditor = editor;
        setCurrentPage(page.id, false);
        clearSelection();
      });
      editor.addEventListener('click', () => {
        activeFlowEditor = editor;
        setCurrentPage(page.id, false);
      });
      editor.addEventListener('input', () => {
        page.html = sanitizeUserHtml(editor.innerHTML);
        checkBlankPageOverflow(page, editor, paper);
        scheduleSessionSave();
      });
      editor.addEventListener('paste', event => handlePlainPaste(event, editor));

      const overlay = document.createElement('div');
      overlay.className = 'overlay-layer';
      paper.append(base, guide, editor, overlay);
      requestAnimationFrame(() => checkBlankPageOverflow(page, editor, paper));
    }

    const overlay = $('.overlay-layer', paper);
    (page.elements || []).forEach(element => overlay.append(renderElement(page, element)));

    paper.addEventListener('pointerdown', event => {
      if (event.target === paper || event.target.classList.contains('overlay-layer') || event.target.classList.contains('pdf-canvas') || event.target.classList.contains('text-layer') || event.target.classList.contains('blank-page-base')) {
        setCurrentPage(page.id, false);
        clearSelection();
      }
    });

    const pageTag = document.createElement('div');
    pageTag.className = 'page-number-tag';
    pageTag.textContent = `Página ${index + 1}`;

    shell.append(paper, pageTag);
    return shell;
  }

  function applyBlankPageLayout(page, editor, guide) {
    const margins = marginPresets[page.marginPreset] || marginPresets.normal;
    editor.style.left = `${margins.left}px`;
    editor.style.top = `${margins.top}px`;
    editor.style.width = `${page.width - margins.left - margins.right}px`;
    editor.style.height = `${page.height - margins.top - margins.bottom}px`;
    editor.style.lineHeight = String(page.lineHeight || 1.5);

    if (guide) {
      guide.style.left = `${margins.left}px`;
      guide.style.top = `${margins.top}px`;
      guide.style.width = `${page.width - margins.left - margins.right}px`;
      guide.style.height = `${page.height - margins.top - margins.bottom}px`;
    }
  }

  function checkBlankPageOverflow(page, editor, paper) {
    const overflowing = editor.scrollHeight > editor.clientHeight + 2;
    paper.classList.toggle('overflow-warning', overflowing);
  }

  function handlePlainPaste(event, editor) {
    const html = event.clipboardData?.getData('text/html');
    if (!html) return;
    event.preventDefault();
    editor.focus();
    document.execCommand('insertHTML', false, sanitizeUserHtml(html));
    editor.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function createPageThumb(page, index) {
    const button = document.createElement('button');
    button.className = 'page-thumb';
    button.dataset.pageId = page.id;
    button.type = 'button';

    const preview = document.createElement('span');
    preview.className = `thumb-preview ${page.type === 'blank' ? 'blank' : ''}`;
    if (page.thumb) {
      const image = new Image();
      image.src = page.thumb;
      image.alt = '';
      preview.append(image);
    }

    const meta = document.createElement('span');
    meta.className = 'thumb-meta';
    const label = page.type === 'pdf' ? `PDF • original ${page.sourcePageNumber}` : 'Página A4 editável';
    meta.innerHTML = `<strong>Página ${index + 1}</strong><small>${escapeHtml(label)}</small>`;
    button.append(preview, meta);
    button.addEventListener('click', () => scrollToPage(page.id));
    return button;
  }

  function setupObservers() {
    pageRenderObserver = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (!entry.isIntersecting || isExporting) return;
        const pageId = entry.target.dataset.pageId;
        const page = getPage(pageId);
        if (page?.type === 'pdf') ensurePdfPageRendered(pageId).catch(error => console.error(error));
      });
    }, { root: dom.workspace, rootMargin: '1300px 0px', threshold: 0.01 });

    currentPageObserver = new IntersectionObserver(entries => {
      const visible = entries
        .filter(entry => entry.isIntersecting)
        .sort((a, b) => b.intersectionRatio - a.intersectionRatio);
      if (visible[0]) setCurrentPage(visible[0].target.dataset.pageId, false);
    }, { root: dom.workspace, rootMargin: '-34% 0px -50% 0px', threshold: [0.01, 0.2, 0.5, 0.8] });

    $$('.page-shell').forEach(shell => {
      pageRenderObserver.observe(shell);
      currentPageObserver.observe(shell);
    });
  }

  function disconnectObservers() {
    pageRenderObserver?.disconnect();
    currentPageObserver?.disconnect();
    pageRenderObserver = null;
    currentPageObserver = null;
  }

  async function ensurePdfPageRendered(pageId) {
    const pageState = getPage(pageId);
    const paper = $(`#paper-${CSS.escape(pageId)}`);
    if (!pageState || pageState.type !== 'pdf' || !paper || paper.dataset.rendered === '1') return;
    if (renderPromises.has(pageId)) return renderPromises.get(pageId);
    if (!pdfDocument) throw new Error('Documento PDF não carregado.');

    const promise = (async () => {
      paper.dataset.rendering = '1';
      try {
        const sourcePage = await pdfDocument.getPage(pageState.sourcePageNumber);
        const viewport = sourcePage.getViewport({ scale: PDF_CSS_SCALE });
        const canvas = $('.pdf-canvas', paper);
        const outputScale = Math.min(window.devicePixelRatio || 1, 2);
        canvas.width = Math.floor(viewport.width * outputScale);
        canvas.height = Math.floor(viewport.height * outputScale);
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        const context = canvas.getContext('2d', { alpha: false });
        const transform = outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : null;

        await sourcePage.render({ canvasContext: context, viewport, transform, background: 'rgb(255,255,255)' }).promise;
        const textContent = await sourcePage.getTextContent();
        renderTextLayer(pageState, paper, viewport, textContent);
        paper.dataset.rendered = '1';
        createThumbnailFromCanvas(pageState, canvas);
      } finally {
        delete paper.dataset.rendering;
      }
    })();

    renderPromises.set(pageId, promise);
    try {
      await promise;
    } finally {
      renderPromises.delete(pageId);
    }
  }

  function renderTextLayer(pageState, paper, viewport, textContent) {
    const layer = $('.text-layer', paper);
    layer.innerHTML = '';
    const styles = textContent.styles || {};

    textContent.items.forEach((item, itemIndex) => {
      if (!item.str) return;
      const span = document.createElement('span');
      const tx = window.pdfjsLib.Util.transform(viewport.transform, item.transform);
      const style = styles[item.fontName] || {};
      let angle = Math.atan2(tx[1], tx[0]);
      if (style.vertical) angle += Math.PI / 2;
      const fontHeight = Math.hypot(tx[2], tx[3]);
      let fontAscent = fontHeight;
      if (style.ascent) fontAscent = style.ascent * fontHeight;
      else if (style.descent) fontAscent = (1 + style.descent) * fontHeight;

      span.textContent = item.str;
      span.dataset.itemIndex = String(itemIndex);
      span.style.left = `${tx[4]}px`;
      span.style.top = `${tx[5] - fontAscent}px`;
      span.style.fontSize = `${fontHeight}px`;
      span.style.fontFamily = style.fontFamily || 'sans-serif';
      layer.append(span);

      const targetWidth = item.width * viewport.scale;
      const measuredWidth = (span.getBoundingClientRect().width / (state.zoom || 1)) || 1;
      const scaleX = targetWidth > 0 ? targetWidth / measuredWidth : 1;
      span.style.transform = `rotate(${angle}rad) scaleX(${scaleX})`;
      span.dataset.fontSize = String(fontHeight);
      span.dataset.angle = String(angle);
      span.dataset.rawText = item.str;

      if ((pageState.elements || []).some(element => String(element.sourceTextItem) === String(itemIndex))) {
        span.classList.add('converted');
      }
      span.addEventListener('dblclick', event => {
        event.preventDefault();
        event.stopPropagation();
        if (state.mode !== 'edit') return;
        convertPdfTextToOverlay(pageState, span, paper);
      });
    });
  }

  function convertPdfTextToOverlay(page, span, paper) {
    pushHistory();
    const spanRect = span.getBoundingClientRect();
    const paperRect = paper.getBoundingClientRect();
    const zoom = state.zoom || 1;
    const x = (spanRect.left - paperRect.left) / zoom;
    const y = (spanRect.top - paperRect.top) / zoom;
    const width = Math.max(36, spanRect.width / zoom);
    const height = Math.max(14, spanRect.height / zoom * 1.2);
    const fontSize = Math.max(7, Number(span.dataset.fontSize || 12));

    const element = createTextElement(page, {
      x, y, w: width, h: height,
      html: escapeHtml(span.dataset.rawText || span.textContent || ''),
      fontSize,
      fontFamily: span.style.fontFamily || 'Arial, sans-serif',
      background: '#ffffff',
      lineHeight: 1.05
    });
    element.sourceTextItem = span.dataset.itemIndex;
    page.elements.push(element);
    span.classList.add('converted');
    const overlay = $('.overlay-layer', paper);
    overlay.append(renderElement(page, element));
    selectElement(page.id, element.id);
    scheduleSessionSave();
    showToast('Texto convertido em camada editável.');
  }

  function createThumbnailFromCanvas(page, sourceCanvas) {
    try {
      const width = 92;
      const height = Math.max(40, Math.round(width * page.height / page.width));
      const thumbCanvas = document.createElement('canvas');
      thumbCanvas.width = width;
      thumbCanvas.height = height;
      thumbCanvas.getContext('2d').drawImage(sourceCanvas, 0, 0, width, height);
      page.thumb = thumbCanvas.toDataURL('image/jpeg', 0.72);
      const preview = $(`.page-thumb[data-page-id="${CSS.escape(page.id)}"] .thumb-preview`);
      if (preview) {
        preview.classList.remove('blank');
        preview.innerHTML = '';
        const image = new Image();
        image.src = page.thumb;
        image.alt = '';
        preview.append(image);
      }
    } catch (error) {
      console.warn('Não foi possível criar miniatura.', error);
    }
  }

  function setCurrentPage(pageId, scroll = false) {
    if (!getPage(pageId)) return;
    state.currentPageId = pageId;
    $$('.paper.current-page').forEach(node => node.classList.remove('current-page'));
    $(`#paper-${CSS.escape(pageId)}`)?.classList.add('current-page');
    $$('.page-thumb').forEach(node => node.classList.toggle('active', node.dataset.pageId === pageId));
    updatePageSettingsUI();
    if (scroll) scrollToPage(pageId);
  }

  function updatePageSelectionUI() {
    if (!state.currentPageId && state.pages[0]) state.currentPageId = state.pages[0].id;
    if (state.currentPageId) setCurrentPage(state.currentPageId, false);
  }

  function scrollToPage(pageId, smooth = true) {
    const shell = $(`#shell-${CSS.escape(pageId)}`);
    if (!shell) return;
    setCurrentPage(pageId, false);
    shell.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' });
  }

  function updatePageSettingsUI() {
    const page = getPage();
    const isBlank = page?.type === 'blank';
    dom.marginPreset.disabled = !isBlank;
    dom.lineHeightSelect.disabled = !isBlank;
    $('#applyPageSettingsBtn').disabled = !isBlank;
    if (isBlank) {
      dom.marginPreset.value = page.marginPreset || 'normal';
      dom.lineHeightSelect.value = String(page.lineHeight || 1.5);
    }
    const index = getCurrentPageIndex();
    $('#movePageUpBtn').disabled = index <= 0;
    $('#movePageDownBtn').disabled = index >= state.pages.length - 1;
    $('#deletePageBtn').disabled = !state.pages.length;
    $('#duplicatePageBtn').disabled = !state.pages.length;
  }

  function renderElement(page, element) {
    const node = document.createElement('div');
    node.className = 'editor-element';
    node.dataset.elementId = element.id;
    node.dataset.pageId = page.id;
    node.dataset.type = element.type;
    applyElementGeometry(node, element);

    let body;
    if (element.type === 'text') {
      body = document.createElement('div');
      body.className = 'element-body';
      body.contentEditable = state.mode === 'edit' ? 'true' : 'false';
      body.spellcheck = true;
      body.innerHTML = sanitizeUserHtml(element.html || '');
      applyTextElementStyle(body, element);
      body.addEventListener('focus', () => {
        activeFlowEditor = body;
        selectElement(page.id, element.id, false);
      });
      body.addEventListener('input', () => {
        element.html = sanitizeUserHtml(body.innerHTML);
        scheduleSessionSave();
      });
      body.addEventListener('paste', event => handlePlainPaste(event, body));
    } else if (element.type === 'image') {
      body = new Image();
      body.className = 'element-body';
      body.src = element.src;
      body.alt = element.alt || '';
    } else {
      body = document.createElement('div');
      body.className = 'element-body';
      body.style.background = element.fill || (element.type === 'highlight' ? '#ffe45c' : '#ffffff');
      body.style.border = element.border || 'none';
      body.style.borderRadius = `${element.radius || 0}px`;
    }

    const dragHandle = document.createElement('span');
    dragHandle.className = 'drag-handle';
    dragHandle.textContent = '⋮';
    dragHandle.title = 'Arrastar';
    const resizeHandle = document.createElement('span');
    resizeHandle.className = 'resize-handle';
    resizeHandle.title = 'Redimensionar';
    node.append(body, dragHandle, resizeHandle);

    node.addEventListener('pointerdown', event => {
      if (state.mode !== 'edit') return;
      selectElement(page.id, element.id, false);
      if (event.target === dragHandle || (element.type !== 'text' && event.target === node)) startElementDrag(event, page, element, node);
    });
    body.addEventListener('pointerdown', event => {
      if (state.mode !== 'edit') return;
      selectElement(page.id, element.id, false);
      if (element.type !== 'text') startElementDrag(event, page, element, node);
    });
    resizeHandle.addEventListener('pointerdown', event => startElementResize(event, page, element, node));
    return node;
  }

  function applyElementGeometry(node, element) {
    node.style.left = `${element.x}px`;
    node.style.top = `${element.y}px`;
    node.style.width = `${element.w}px`;
    node.style.height = `${element.h}px`;
    node.style.opacity = String(element.opacity ?? 1);
    node.style.zIndex = String(element.z ?? 1);
    node.style.transform = element.rotation ? `rotate(${element.rotation}deg)` : '';
  }

  function applyTextElementStyle(body, element) {
    const style = element.style || {};
    body.style.fontFamily = style.fontFamily || 'Arial, sans-serif';
    body.style.fontSize = `${style.fontSize || 12}px`;
    body.style.fontWeight = style.fontWeight || '400';
    body.style.fontStyle = style.fontStyle || 'normal';
    body.style.textDecoration = style.textDecoration || 'none';
    body.style.textAlign = style.textAlign || 'left';
    body.style.color = style.color || '#111111';
    body.style.background = style.background ?? 'transparent';
    body.style.lineHeight = String(style.lineHeight || 1.2);
  }

  function createTextElement(page, overrides = {}) {
    const width = overrides.w || Math.min(260, page.width - 80);
    const height = overrides.h || 62;
    return {
      id: uid('text'),
      type: 'text',
      x: overrides.x ?? Math.max(30, (page.width - width) / 2),
      y: overrides.y ?? 90,
      w: width,
      h: height,
      z: state.nextZ++,
      opacity: overrides.opacity ?? 1,
      rotation: overrides.rotation || 0,
      html: overrides.html ?? 'Novo texto',
      style: {
        fontFamily: overrides.fontFamily || $('#fontFamily').value || 'Arial, sans-serif',
        fontSize: overrides.fontSize || Number($('#fontSize').value || 12),
        fontWeight: overrides.fontWeight || '400',
        fontStyle: overrides.fontStyle || 'normal',
        textDecoration: overrides.textDecoration || 'none',
        textAlign: overrides.textAlign || 'left',
        color: overrides.color || $('#textColor').value || '#111111',
        background: overrides.background ?? 'transparent',
        lineHeight: overrides.lineHeight || 1.2
      }
    };
  }

  function addElementToCurrentPage(element) {
    const page = getPage();
    if (!page) return;
    pushHistory();
    page.elements ||= [];
    page.elements.push(element);
    const overlay = $(`#paper-${CSS.escape(page.id)} .overlay-layer`);
    overlay?.append(renderElement(page, element));
    selectElement(page.id, element.id);
    scheduleSessionSave();
  }

  function addTextElement(pageId = state.currentPageId) {
    const page = getPage(pageId);
    if (!page) return;
    setCurrentPage(page.id, false);
    const element = createTextElement(page, { y: findVisibleInsertionY(page) });
    addElementToCurrentPage(element);
    requestAnimationFrame(() => {
      const body = $(`.editor-element[data-element-id="${CSS.escape(element.id)}"] .element-body`);
      body?.focus();
      selectAllContent(body);
    });
  }

  function addWhiteoutElement() {
    const page = getPage();
    if (!page) return;
    addElementToCurrentPage({
      id: uid('cover'), type: 'rect', x: 80, y: findVisibleInsertionY(page), w: 240, h: 38,
      z: state.nextZ++, opacity: 1, rotation: 0, fill: '#ffffff', border: 'none', radius: 0
    });
  }

  function addHighlightElement() {
    const page = getPage();
    if (!page) return;
    addElementToCurrentPage({
      id: uid('highlight'), type: 'highlight', x: 80, y: findVisibleInsertionY(page), w: 250, h: 28,
      z: state.nextZ++, opacity: .38, rotation: 0, fill: '#ffe45c', border: 'none', radius: 2
    });
  }

  function findVisibleInsertionY(page) {
    const shell = $(`#shell-${CSS.escape(page.id)}`);
    if (!shell) return 90;
    const shellRect = shell.getBoundingClientRect();
    const workspaceRect = dom.workspace.getBoundingClientRect();
    const visibleTop = clamp((workspaceRect.top - shellRect.top) / (state.zoom || 1) + 70, 40, page.height - 130);
    return visibleTop;
  }

  async function addImageFromFile(file, pageId = imageInsertTargetPageId || state.currentPageId) {
    if (!file) return;
    const page = getPage(pageId);
    if (!page) return;
    const dataUrl = await readFileAsDataURL(file);
    const dimensions = await getImageDimensions(dataUrl);
    const maxW = Math.min(360, page.width - 80);
    const maxH = 260;
    const ratio = Math.min(maxW / dimensions.width, maxH / dimensions.height, 1);
    const w = Math.max(40, dimensions.width * ratio);
    const h = Math.max(40, dimensions.height * ratio);
    setCurrentPage(page.id, false);
    addElementToCurrentPage({
      id: uid('image'), type: 'image', x: Math.max(30, (page.width - w) / 2), y: findVisibleInsertionY(page),
      w, h, z: state.nextZ++, opacity: 1, rotation: 0, src: dataUrl, alt: file.name || 'Imagem'
    });
  }

  function getImageDimensions(src) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
      image.onerror = () => reject(new Error('Imagem inválida.'));
      image.src = src;
    });
  }

  function selectAllContent(node) {
    if (!node) return;
    const range = document.createRange();
    range.selectNodeContents(node);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function selectElement(pageId, elementId, showToolbar = true) {
    selectedElementId = elementId;
    setCurrentPage(pageId, false);
    $$('.editor-element.selected').forEach(node => node.classList.remove('selected'));
    const node = $(`.editor-element[data-element-id="${CSS.escape(elementId)}"]`);
    node?.classList.add('selected');
    updateSelectionInspector();
    if (showToolbar) positionFloatToolbar(node);
  }

  function clearSelection() {
    selectedElementId = null;
    $$('.editor-element.selected').forEach(node => node.classList.remove('selected'));
    dom.pageFloatToolbar.classList.add('hidden');
    updateSelectionInspector();
  }

  function positionFloatToolbar(node) {
    if (!node || state.mode !== 'edit') {
      dom.pageFloatToolbar.classList.add('hidden');
      return;
    }
    const rect = node.getBoundingClientRect();
    const toolbarWidth = 250;
    const left = clamp(rect.left + rect.width / 2 - toolbarWidth / 2, 10, window.innerWidth - toolbarWidth - 10);
    const top = Math.max(68, rect.top - 40);
    dom.pageFloatToolbar.style.left = `${left}px`;
    dom.pageFloatToolbar.style.top = `${top}px`;
    dom.pageFloatToolbar.classList.remove('hidden');
  }

  function updateSelectionInspector() {
    const result = getElement();
    const hasSelection = Boolean(result);
    dom.noSelectionHint.classList.toggle('hidden', hasSelection);
    dom.selectionControls.classList.toggle('hidden', !hasSelection);
    if (!result) return;
    const { element } = result;
    $('#elementX').value = Math.round(element.x);
    $('#elementY').value = Math.round(element.y);
    $('#elementW').value = Math.round(element.w);
    $('#elementH').value = Math.round(element.h);
    $('#elementOpacity').value = String(element.opacity ?? 1);

    if (element.type === 'text') {
      $('#fontFamily').value = findSelectValue($('#fontFamily'), element.style?.fontFamily) || $('#fontFamily').value;
      $('#fontSize').value = String(Math.round(element.style?.fontSize || 12));
      $('#textColor').value = toHexColor(element.style?.color || '#111111');
      $('#fillColor').value = toHexColor(element.style?.background || '#ffffff');
    } else {
      $('#fillColor').value = toHexColor(element.fill || '#ffffff');
    }
  }

  function findSelectValue(select, value) {
    return [...select.options].find(option => option.value === value)?.value || '';
  }

  function toHexColor(value) {
    if (!value || value === 'transparent') return '#ffffff';
    if (/^#[0-9a-f]{6}$/i.test(value)) return value;
    const match = value.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
    if (!match) return '#ffffff';
    return `#${[match[1], match[2], match[3]].map(number => Number(number).toString(16).padStart(2, '0')).join('')}`;
  }

  function startElementDrag(event, page, element, node) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    node.setPointerCapture?.(event.pointerId);
    pushHistory();
    pointerOperation = {
      type: 'drag', pointerId: event.pointerId, node, page, element,
      startX: event.clientX, startY: event.clientY, x: element.x, y: element.y
    };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', endPointerOperation, { once: true });
  }

  function startElementResize(event, page, element, node) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    node.setPointerCapture?.(event.pointerId);
    pushHistory();
    pointerOperation = {
      type: 'resize', pointerId: event.pointerId, node, page, element,
      startX: event.clientX, startY: event.clientY, w: element.w, h: element.h
    };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', endPointerOperation, { once: true });
  }

  function onPointerMove(event) {
    if (!pointerOperation) return;
    const op = pointerOperation;
    const zoom = state.zoom || 1;
    const dx = (event.clientX - op.startX) / zoom;
    const dy = (event.clientY - op.startY) / zoom;
    if (op.type === 'drag') {
      op.element.x = clamp(op.x + dx, 0, op.page.width - op.element.w);
      op.element.y = clamp(op.y + dy, 0, op.page.height - op.element.h);
    } else {
      op.element.w = clamp(op.w + dx, 12, op.page.width - op.element.x);
      op.element.h = clamp(op.h + dy, 12, op.page.height - op.element.y);
    }
    applyElementGeometry(op.node, op.element);
    updateSelectionInspector();
    positionFloatToolbar(op.node);
  }

  function endPointerOperation() {
    window.removeEventListener('pointermove', onPointerMove);
    pointerOperation = null;
    scheduleSessionSave();
  }

  function deleteSelectedElement() {
    const result = getElement();
    if (!result) return;
    pushHistory();
    const { page, element } = result;
    page.elements = page.elements.filter(item => item.id !== element.id);
    if (element.sourceTextItem != null) {
      const original = $(`#paper-${CSS.escape(page.id)} .text-layer span[data-item-index="${CSS.escape(String(element.sourceTextItem))}"]`);
      original?.classList.remove('converted');
    }
    $(`.editor-element[data-element-id="${CSS.escape(element.id)}"]`)?.remove();
    clearSelection();
    scheduleSessionSave();
  }

  function duplicateSelectedElement() {
    const result = getElement();
    if (!result) return;
    pushHistory();
    const { page, element } = result;
    const clone = deepClone(element);
    clone.id = uid(element.type);
    clone.x = clamp(clone.x + 14, 0, page.width - clone.w);
    clone.y = clamp(clone.y + 14, 0, page.height - clone.h);
    clone.z = state.nextZ++;
    page.elements.push(clone);
    const overlay = $(`#paper-${CSS.escape(page.id)} .overlay-layer`);
    overlay?.append(renderElement(page, clone));
    selectElement(page.id, clone.id);
    scheduleSessionSave();
  }

  function changeElementZ(direction) {
    const result = getElement();
    if (!result) return;
    pushHistory();
    const { element } = result;
    if (direction === 'front') element.z = state.nextZ++;
    else element.z = Math.max(0, Math.min(...result.page.elements.map(item => item.z || 0)) - 1);
    const node = $(`.editor-element[data-element-id="${CSS.escape(element.id)}"]`);
    if (node) node.style.zIndex = String(element.z);
    scheduleSessionSave();
  }

  function updateSelectedGeometry() {
    const result = getElement();
    if (!result) return;
    pushHistory();
    const { page, element } = result;
    element.x = clamp(Number($('#elementX').value || 0), 0, page.width - element.w);
    element.y = clamp(Number($('#elementY').value || 0), 0, page.height - element.h);
    element.w = clamp(Number($('#elementW').value || 12), 12, page.width - element.x);
    element.h = clamp(Number($('#elementH').value || 12), 12, page.height - element.y);
    const node = $(`.editor-element[data-element-id="${CSS.escape(element.id)}"]`);
    if (node) applyElementGeometry(node, element);
    positionFloatToolbar(node);
    scheduleSessionSave();
  }

  function applyFormatting(command, value) {
    const result = getElement();
    if (result?.element.type === 'text') {
      const { element } = result;
      const style = element.style ||= {};
      if (command === 'fontFamily') style.fontFamily = value;
      if (command === 'fontSize') style.fontSize = Number(value);
      if (command === 'color') style.color = value;
      if (command === 'background') style.background = value;
      if (command === 'bold') style.fontWeight = style.fontWeight === '700' ? '400' : '700';
      if (command === 'italic') style.fontStyle = style.fontStyle === 'italic' ? 'normal' : 'italic';
      if (command === 'underline') style.textDecoration = style.textDecoration === 'underline' ? 'none' : 'underline';
      if (command === 'align') {
        const sequence = ['left', 'center', 'right', 'justify'];
        style.textAlign = sequence[(sequence.indexOf(style.textAlign || 'left') + 1) % sequence.length];
      }
      const body = $(`.editor-element[data-element-id="${CSS.escape(element.id)}"] .element-body`);
      if (body) applyTextElementStyle(body, element);
      scheduleSessionSave();
      updateSelectionInspector();
      return;
    }

    if (!activeFlowEditor || !activeFlowEditor.isConnected || state.mode !== 'edit') return;
    restoreSavedRange();
    activeFlowEditor.focus();
    if (command === 'bold' || command === 'italic' || command === 'underline') document.execCommand(command, false);
    else if (command === 'align') cycleFlowAlignment();
    else if (command === 'fontFamily') document.execCommand('fontName', false, value.split(',')[0].replace(/["']/g, ''));
    else if (command === 'color') document.execCommand('foreColor', false, value);
    else if (command === 'background') document.execCommand('hiliteColor', false, value);
    else if (command === 'fontSize') applyExactFontSize(Number(value));
    syncActiveEditorToState();
  }

  function cycleFlowAlignment() {
    const node = getSelectionContainer();
    const current = node ? getComputedStyle(node).textAlign : 'left';
    const sequence = ['left', 'center', 'right', 'justify'];
    const next = sequence[(sequence.indexOf(current) + 1) % sequence.length];
    const command = { left: 'justifyLeft', center: 'justifyCenter', right: 'justifyRight', justify: 'justifyFull' }[next];
    document.execCommand(command, false);
  }

  function applyExactFontSize(size) {
    if (!Number.isFinite(size)) return;
    document.execCommand('fontSize', false, '7');
    activeFlowEditor.querySelectorAll('font[size="7"]').forEach(font => {
      const span = document.createElement('span');
      span.style.fontSize = `${size}px`;
      span.innerHTML = font.innerHTML;
      font.replaceWith(span);
    });
  }

  function getSelectionContainer() {
    const selection = window.getSelection();
    if (!selection?.rangeCount) return null;
    let node = selection.getRangeAt(0).commonAncestorContainer;
    if (node.nodeType === Node.TEXT_NODE) node = node.parentElement;
    return node;
  }

  function saveSelectionRange() {
    const selection = window.getSelection();
    if (!selection?.rangeCount) return;
    const range = selection.getRangeAt(0);
    const container = range.commonAncestorContainer.nodeType === Node.TEXT_NODE ? range.commonAncestorContainer.parentElement : range.commonAncestorContainer;
    if (container?.closest?.('.flow-editor, .editor-element[data-type="text"] .element-body')) savedRange = range.cloneRange();
  }

  function restoreSavedRange() {
    if (!savedRange) return;
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(savedRange);
  }

  function syncActiveEditorToState() {
    if (!activeFlowEditor) return;
    const paper = activeFlowEditor.closest('.paper');
    const page = getPage(paper?.dataset.pageId);
    if (!page) return;
    if (activeFlowEditor.classList.contains('flow-editor')) page.html = sanitizeUserHtml(activeFlowEditor.innerHTML);
    else {
      const id = activeFlowEditor.closest('.editor-element')?.dataset.elementId;
      const element = page.elements.find(item => item.id === id);
      if (element) element.html = sanitizeUserHtml(activeFlowEditor.innerHTML);
    }
    scheduleSessionSave();
  }

  function applyFillColor(value) {
    const result = getElement();
    if (!result) {
      applyFormatting('background', value);
      return;
    }
    const { element } = result;
    if (element.type === 'text') applyFormatting('background', value);
    else {
      element.fill = value;
      const body = $(`.editor-element[data-element-id="${CSS.escape(element.id)}"] .element-body`);
      if (body) body.style.background = value;
      scheduleSessionSave();
    }
  }

  async function openPdfFile(file) {
    if (!file) return;
    if (!window.pdfjsLib) {
      showToast('O mecanismo PDF.js não foi carregado.');
      return;
    }
    if (!(await confirmDocumentReplacement())) {
      dom.pdfFileInput.value = '';
      return;
    }

    setProgress('Abrindo PDF', 'Lendo o arquivo…', 3);
    try {
      const buffer = await file.arrayBuffer();
      pdfBuffer = buffer.slice(0);
      const loadingTask = window.pdfjsLib.getDocument({
        data: new Uint8Array(buffer.slice(0)),
        cMapUrl: 'vendor/cmaps/',
        cMapPacked: true,
        standardFontDataUrl: 'vendor/standard_fonts/'
      });
      pdfDocument = await loadingTask.promise;

      const newState = createEmptyState();
      newState.title = file.name.replace(/\.pdf$/i, '') || 'Documento PDF';
      newState.fileName = file.name;
      newState.sourceType = 'pdf';
      newState.mode = 'edit';
      newState.pages = [];

      for (let i = 1; i <= pdfDocument.numPages; i++) {
        updateProgress(`Preparando página ${i} de ${pdfDocument.numPages}`, 5 + (i / pdfDocument.numPages) * 45);
        const sourcePage = await pdfDocument.getPage(i);
        const viewport = sourcePage.getViewport({ scale: PDF_CSS_SCALE });
        newState.pages.push({
          id: uid('page'), type: 'pdf', sourcePageNumber: i,
          width: viewport.width, height: viewport.height,
          originalWidthPt: viewport.width / PDF_CSS_SCALE,
          originalHeightPt: viewport.height / PDF_CSS_SCALE,
          elements: [], thumb: null
        });
      }
      newState.currentPageId = newState.pages[0]?.id || null;
      state = newState;
      updateProgress('Montando o editor…', 60);
      renderDocument({ scrollToCurrent: false });
      await ensurePdfPageRendered(state.currentPageId);
      updateProgress('Documento pronto', 100);
      await saveSessionNow();
      hideProgress();
      showToast(`${pdfDocument.numPages} página(s) carregada(s).`);
    } catch (error) {
      console.error(error);
      hideProgress();
      showToast('Não foi possível abrir esse PDF.', 3500);
    } finally {
      dom.pdfFileInput.value = '';
    }
  }

  async function showNewDocumentDialog() {
    if (await confirmDocumentReplacement()) dom.newDocumentDialog.showModal();
  }

  async function createNewDocumentFromDialog() {
    const title = $('#newDocumentTitle').value.trim() || 'Documento sem título';
    const pageCount = clamp(Number($('#newDocumentPages').value || 1), 1, 100);
    const marginPreset = $('#newDocumentMargins').value;
    const lineHeight = Number($('#newDocumentLineHeight').value || 1.5);

    pdfDocument = null;
    pdfBuffer = null;
    state = createEmptyState();
    state.title = title;
    state.fileName = `${cleanFileName(title)}.pdf`;
    state.sourceType = 'blank';
    state.mode = 'edit';
    state.pages = Array.from({ length: pageCount }, () => createBlankPage({ marginPreset, lineHeight }));
    state.currentPageId = state.pages[0].id;
    dom.newDocumentDialog.close();
    renderDocument({ scrollToCurrent: false });
    await saveSessionNow();
    requestAnimationFrame(() => $(`#paper-${CSS.escape(state.currentPageId)} .flow-editor`)?.focus());
    showToast('Documento A4 criado.');
  }

  function addBlankPage(afterCurrent = true) {
    pushHistory();
    const page = createBlankPage({
      marginPreset: getPage()?.marginPreset || 'normal',
      lineHeight: getPage()?.lineHeight || 1.5
    });
    const index = afterCurrent && state.currentPageId ? getCurrentPageIndex() + 1 : state.pages.length;
    state.pages.splice(index, 0, page);
    state.currentPageId = page.id;
    renderDocument();
    scheduleSessionSave();
  }

  function duplicateCurrentPage() {
    const current = getPage();
    if (!current) return;
    pushHistory();
    const clone = deepClone(current);
    clone.id = uid('page');
    clone.thumb = null;
    clone.elements = (clone.elements || []).map(element => ({ ...element, id: uid(element.type), z: state.nextZ++ }));
    const index = getCurrentPageIndex() + 1;
    state.pages.splice(index, 0, clone);
    state.currentPageId = clone.id;
    renderDocument();
    scheduleSessionSave();
  }

  async function deleteCurrentPage() {
    const current = getPage();
    if (!current) return;
    if (!(await askConfirm('Excluir página?', 'Esta ação remove a página e todas as edições aplicadas nela.', 'Excluir'))) return;
    pushHistory();
    const index = getCurrentPageIndex();
    state.pages.splice(index, 1);
    if (!state.pages.length) {
      state.pages.push(createBlankPage());
      state.sourceType = 'blank';
      pdfDocument = null;
      pdfBuffer = null;
    }
    state.currentPageId = state.pages[Math.min(index, state.pages.length - 1)].id;
    renderDocument();
    scheduleSessionSave();
  }

  function moveCurrentPage(direction) {
    const index = getCurrentPageIndex();
    const target = index + direction;
    if (target < 0 || target >= state.pages.length) return;
    pushHistory();
    [state.pages[index], state.pages[target]] = [state.pages[target], state.pages[index]];
    renderDocument();
    scheduleSessionSave();
  }

  function applyPageSettings() {
    const page = getPage();
    if (!page || page.type !== 'blank') {
      showToast('Margens e espaçamento se aplicam apenas às páginas A4 criadas no editor.');
      return;
    }
    pushHistory();
    page.marginPreset = dom.marginPreset.value;
    page.lineHeight = Number(dom.lineHeightSelect.value || 1.5);
    const editor = $(`#paper-${CSS.escape(page.id)} .flow-editor`);
    const guide = $(`#paper-${CSS.escape(page.id)} .margin-guide`);
    applyBlankPageLayout(page, editor, guide);
    checkBlankPageOverflow(page, editor, editor.closest('.paper'));
    scheduleSessionSave();
    showToast('Configuração da página aplicada.');
  }

  async function ensureAllPdfPagesRendered() {
    const pdfPages = state.pages.filter(page => page.type === 'pdf');
    for (let i = 0; i < pdfPages.length; i++) {
      updateProgress(`Renderizando página ${i + 1} de ${pdfPages.length}`, 5 + (i / Math.max(1, pdfPages.length)) * 45);
      await ensurePdfPageRendered(pdfPages[i].id);
      await nextFrame();
    }
  }

  function releasePdfPageRender(pageId) {
    const paper = $(`#paper-${CSS.escape(pageId)}`);
    if (!paper || paper.dataset.rendered !== '1') return;
    const canvas = $('.pdf-canvas', paper);
    const textLayer = $('.text-layer', paper);
    if (canvas) {
      canvas.width = 1;
      canvas.height = 1;
      canvas.removeAttribute('width');
      canvas.removeAttribute('height');
    }
    if (textLayer) textLayer.innerHTML = '';
    paper.dataset.rendered = '0';
  }

  function nextFrame() {
    return new Promise(resolve => requestAnimationFrame(() => resolve()));
  }

  async function exportPdf() {
    if (!state.pages.length) return;
    if (!window.html2canvas || !window.jspdf?.jsPDF) {
      showToast('Exportador direto indisponível. Abrindo a impressão do navegador.');
      window.print();
      return;
    }

    setProgress('Gerando PDF', 'Preparando páginas…', 2);
    const previousZoom = state.zoom;
    const previousPage = state.currentPageId;
    try {
      isExporting = true;
      clearSelection();
      document.body.classList.add('export-mode');
      setZoom(1);
      await nextFrame();

      const count = state.pages.length;
      const renderScale = count <= 20 ? 1.75 : count <= 60 ? 1.35 : 1;
      const jpegQuality = count <= 30 ? .92 : .86;
      const { jsPDF } = window.jspdf;
      let output = null;

      for (let i = 0; i < state.pages.length; i++) {
        const page = state.pages[i];
        const paper = $(`#paper-${CSS.escape(page.id)}`);
        const wasRendered = page.type !== 'pdf' || paper?.dataset.rendered === '1';
        if (page.type === 'pdf') await ensurePdfPageRendered(page.id);
        updateProgress(`Convertendo página ${i + 1} de ${count}`, 8 + ((i + 1) / count) * 88);
        const canvas = await window.html2canvas(paper, {
          scale: renderScale,
          backgroundColor: '#ffffff',
          logging: false,
          useCORS: true,
          allowTaint: true,
          imageTimeout: 0,
          removeContainer: true
        });
        const widthPt = page.width * 72 / 96;
        const heightPt = page.height * 72 / 96;
        const orientation = widthPt > heightPt ? 'landscape' : 'portrait';
        if (!output) output = new jsPDF({ unit: 'pt', format: [widthPt, heightPt], orientation, compress: true, putOnlyUsedFonts: true });
        else output.addPage([widthPt, heightPt], orientation);
        output.addImage(canvas.toDataURL('image/jpeg', jpegQuality), 'JPEG', 0, 0, widthPt, heightPt, undefined, 'FAST');
        canvas.width = 1;
        canvas.height = 1;
        if (page.type === 'pdf' && !wasRendered && page.id !== previousPage) releasePdfPageRender(page.id);
        await nextFrame();
      }

      updateProgress('Finalizando arquivo…', 99);
      output.save(`${cleanFileName(state.title)}.pdf`);
      showToast('PDF gerado.');
    } catch (error) {
      console.error(error);
      showToast('Falha ao gerar o PDF. Use a impressão do navegador como alternativa.', 4000);
    } finally {
      isExporting = false;
      document.body.classList.remove('export-mode');
      setZoom(previousZoom);
      state.currentPageId = previousPage;
      if (getPage(previousPage)?.type === 'pdf') ensurePdfPageRendered(previousPage).catch(console.error);
      hideProgress();
    }
  }

  async function exportHtml() {
    if (!state.pages.length) return;
    setProgress('Gerando HTML', 'Preparando conteúdo…', 3);
    try {
      isExporting = true;
      const pagesMarkup = [];
      const count = state.pages.length;

      for (let i = 0; i < count; i++) {
        const page = state.pages[i];
        const paper = $(`#paper-${CSS.escape(page.id)}`);
        const wasRendered = page.type !== 'pdf' || paper?.dataset.rendered === '1';
        if (page.type === 'pdf') await ensurePdfPageRendered(page.id);
        updateProgress(`Empacotando página ${i + 1} de ${count}`, 10 + ((i + 1) / count) * 82);
        pagesMarkup.push(buildSnapshotPageHtml(page, i));
        if (page.type === 'pdf' && !wasRendered && page.id !== state.currentPageId) releasePdfPageRender(page.id);
        await nextFrame();
      }

      const title = escapeHtml(state.title || 'Documento');
      const html = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>${snapshotCss()}</style>
</head>
<body>
<button class="print-button" onclick="window.print()">Imprimir / salvar PDF</button>
<main class="document">${pagesMarkup.join('')}</main>
</body>
</html>`;
      downloadBlob(new Blob([html], { type: 'text/html;charset=utf-8' }), `${cleanFileName(state.title)}.html`);
      showToast('Versão HTML exportada.');
    } catch (error) {
      console.error(error);
      showToast('Não foi possível gerar o HTML.', 3500);
    } finally {
      isExporting = false;
      if (getPage()?.type === 'pdf') ensurePdfPageRendered(state.currentPageId).catch(console.error);
      hideProgress();
    }
  }

  function buildSnapshotPageHtml(page, index) {
    let base = '';
    if (page.type === 'pdf') {
      const paper = $(`#paper-${CSS.escape(page.id)}`);
      const canvas = $('.pdf-canvas', paper);
      const image = canvas.toDataURL('image/jpeg', .93);
      const textLayer = $('.text-layer', paper)?.cloneNode(true);
      textLayer?.querySelectorAll('.converted').forEach(node => node.remove());
      if (textLayer) textLayer.removeAttribute('class');
      base = `<img class="page-background" src="${image}" alt="Página ${index + 1}"><div class="searchable-text">${textLayer?.innerHTML || ''}</div>`;
    } else {
      const margins = marginPresets[page.marginPreset] || marginPresets.normal;
      const style = `left:${margins.left}px;top:${margins.top}px;width:${page.width - margins.left - margins.right}px;height:${page.height - margins.top - margins.bottom}px;line-height:${page.lineHeight || 1.5}`;
      base = `<div class="flow-content" style="${style}">${sanitizeUserHtml(page.html || '')}</div>`;
    }
    const elements = (page.elements || []).map(elementToSnapshotHtml).join('');
    return `<section class="page" style="width:${page.width}px;height:${page.height}px">${base}<div class="overlays">${elements}</div></section>`;
  }

  function elementToSnapshotHtml(element) {
    const common = `left:${element.x}px;top:${element.y}px;width:${element.w}px;height:${element.h}px;opacity:${element.opacity ?? 1};z-index:${element.z || 1};${element.rotation ? `transform:rotate(${element.rotation}deg);` : ''}`;
    if (element.type === 'text') {
      const style = element.style || {};
      const bodyStyle = `font-family:${style.fontFamily || 'Arial, sans-serif'};font-size:${style.fontSize || 12}px;font-weight:${style.fontWeight || 400};font-style:${style.fontStyle || 'normal'};text-decoration:${style.textDecoration || 'none'};text-align:${style.textAlign || 'left'};color:${style.color || '#111'};background:${style.background || 'transparent'};line-height:${style.lineHeight || 1.2}`;
      return `<div class="snapshot-element snapshot-text" style="${common};${bodyStyle}">${sanitizeUserHtml(element.html || '')}</div>`;
    }
    if (element.type === 'image') {
      return `<img class="snapshot-element snapshot-image" style="${common}" src="${element.src}" alt="${escapeHtml(element.alt || '')}">`;
    }
    return `<div class="snapshot-element" style="${common};background:${element.fill || '#fff'};border:${element.border || 'none'};border-radius:${element.radius || 0}px"></div>`;
  }

  function snapshotCss() {
    return `
*{box-sizing:border-box}html,body{margin:0;background:#4a4d53;font-family:Arial,sans-serif}.print-button{position:fixed;z-index:9999;right:18px;top:18px;padding:10px 14px;border:0;border-radius:8px;background:#1f56d8;color:#fff;font:600 14px Arial;cursor:pointer;box-shadow:0 5px 18px #0005}.document{display:flex;flex-direction:column;align-items:center;gap:24px;padding:30px}.page{position:relative;flex:none;overflow:hidden;background:#fff;box-shadow:0 9px 30px #0006}.page-background{position:absolute;inset:0;width:100%;height:100%;object-fit:fill}.searchable-text{position:absolute;inset:0;overflow:hidden;line-height:1}.searchable-text span{position:absolute;transform-origin:0 0;white-space:pre;color:transparent;user-select:text}.flow-content{position:absolute;overflow:hidden;font:16px Arial,sans-serif;color:#111}.flow-content p{margin:0 0 .72em}.flow-content h1{margin:0 0 .6em;font-size:2em;line-height:1.15}.flow-content h2{margin:0 0 .6em;font-size:1.5em;line-height:1.2}.flow-content h3{margin:0 0 .6em;font-size:1.2em;line-height:1.25}.overlays{position:absolute;inset:0;overflow:hidden}.snapshot-element{position:absolute;transform-origin:center}.snapshot-text{padding:2px 3px;overflow:hidden;white-space:pre-wrap;word-break:break-word}.snapshot-image{object-fit:contain}@media print{@page{margin:0}html,body{background:#fff}.print-button{display:none}.document{display:block;padding:0}.page{box-shadow:none;break-after:page;page-break-after:always;margin:0}}
`;
  }

  async function saveProjectFile() {
    if (!state.pages.length) return;
    setProgress('Salvando projeto', 'Preparando dados…', 20);
    try {
      const project = {
        app: 'Natural PDF Studio',
        projectVersion: 1,
        exportedAt: new Date().toISOString(),
        state: serializeState(),
        pdfBase64: pdfBuffer ? arrayBufferToBase64(pdfBuffer) : null
      };
      updateProgress('Criando arquivo…', 85);
      const json = JSON.stringify(project);
      downloadBlob(new Blob([json], { type: 'application/json' }), `${cleanFileName(state.title)}.natural-pdf.json`);
      showToast('Projeto salvo.');
    } catch (error) {
      console.error(error);
      showToast('Não foi possível salvar o projeto.');
    } finally {
      hideProgress();
    }
  }

  async function openProjectFile(file) {
    if (!file) return;
    if (!(await confirmDocumentReplacement())) {
      dom.projectFileInput.value = '';
      return;
    }
    setProgress('Abrindo projeto', 'Lendo arquivo…', 10);
    try {
      const project = JSON.parse(await file.text());
      if (!project?.state?.pages || project.projectVersion !== 1) throw new Error('Projeto inválido.');
      state = project.state;
      state.pages.forEach(page => {
        page.elements ||= [];
        page.thumb = null;
      });
      pdfBuffer = project.pdfBase64 ? base64ToArrayBuffer(project.pdfBase64) : null;
      if (pdfBuffer) {
        updateProgress('Reabrindo PDF original…', 45);
        pdfDocument = await window.pdfjsLib.getDocument({
          data: new Uint8Array(pdfBuffer.slice(0)),
          cMapUrl: 'vendor/cmaps/', cMapPacked: true,
          standardFontDataUrl: 'vendor/standard_fonts/'
        }).promise;
      } else pdfDocument = null;
      updateProgress('Montando editor…', 75);
      renderDocument({ scrollToCurrent: false });
      if (getPage()?.type === 'pdf') await ensurePdfPageRendered(state.currentPageId);
      await saveSessionNow();
      showToast('Projeto aberto.');
    } catch (error) {
      console.error(error);
      showToast('Arquivo de projeto inválido ou corrompido.', 3500);
    } finally {
      hideProgress();
      dom.projectFileInput.value = '';
    }
  }

  function openDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(DB_STORE)) request.result.createObjectStore(DB_STORE);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function saveSessionNow() {
    if (!state.pages.length) return;
    state.updatedAt = new Date().toISOString();
    try {
      const db = await openDatabase();
      const transaction = db.transaction(DB_STORE, 'readwrite');
      const store = transaction.objectStore(DB_STORE);
      store.put({
        state: serializeState(),
        pdfBlob: pdfBuffer ? new Blob([pdfBuffer], { type: 'application/pdf' }) : null
      }, DB_KEY);
      await transactionDone(transaction);
      db.close();
    } catch (error) {
      console.warn('Falha no salvamento automático.', error);
    }
  }

  function scheduleSessionSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveSessionNow, 900);
  }

  function transactionDone(transaction) {
    return new Promise((resolve, reject) => {
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  }

  async function getSavedSession() {
    try {
      const db = await openDatabase();
      const transaction = db.transaction(DB_STORE, 'readonly');
      const request = transaction.objectStore(DB_STORE).get(DB_KEY);
      const result = await new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error);
      });
      db.close();
      return result;
    } catch (error) {
      console.warn(error);
      return null;
    }
  }

  async function restoreSavedSession() {
    setProgress('Restaurando sessão', 'Lendo dados locais…', 15);
    try {
      const saved = await getSavedSession();
      if (!saved?.state?.pages?.length) throw new Error('Nenhuma sessão válida.');
      state = saved.state;
      state.pages.forEach(page => {
        page.elements ||= [];
        page.thumb = null;
      });
      pdfBuffer = saved.pdfBlob ? await saved.pdfBlob.arrayBuffer() : null;
      if (pdfBuffer) {
        updateProgress('Reabrindo PDF…', 45);
        pdfDocument = await window.pdfjsLib.getDocument({
          data: new Uint8Array(pdfBuffer.slice(0)),
          cMapUrl: 'vendor/cmaps/', cMapPacked: true,
          standardFontDataUrl: 'vendor/standard_fonts/'
        }).promise;
      } else pdfDocument = null;
      renderDocument({ scrollToCurrent: false });
      if (getPage()?.type === 'pdf') await ensurePdfPageRendered(state.currentPageId);
      showToast('Sessão restaurada.');
    } catch (error) {
      console.error(error);
      showToast('Não foi possível restaurar a sessão.');
    } finally {
      hideProgress();
    }
  }

  async function clearSavedSession() {
    try {
      const db = await openDatabase();
      const transaction = db.transaction(DB_STORE, 'readwrite');
      transaction.objectStore(DB_STORE).delete(DB_KEY);
      await transactionDone(transaction);
      db.close();
    } catch (error) {
      console.warn(error);
    }
    dom.restoreSessionBox.classList.add('hidden');
  }

  async function checkForSavedSession() {
    const saved = await getSavedSession();
    dom.restoreSessionBox.classList.toggle('hidden', !saved?.state?.pages?.length);
  }

  function bindEvents() {
    $('#openPdfBtn').addEventListener('click', () => dom.pdfFileInput.click());
    $('#emptyOpenPdfBtn').addEventListener('click', () => dom.pdfFileInput.click());
    dom.pdfFileInput.addEventListener('change', event => openPdfFile(event.target.files?.[0]));

    $('#newDocumentBtn').addEventListener('click', showNewDocumentDialog);
    $('#emptyNewDocumentBtn').addEventListener('click', showNewDocumentDialog);
    $('#newDocumentForm').addEventListener('submit', event => {
      if (event.submitter?.value === 'cancel') return;
      event.preventDefault();
      createNewDocumentFromDialog();
    });

    $('#openProjectBtn').addEventListener('click', () => dom.projectFileInput.click());
    dom.projectFileInput.addEventListener('change', event => openProjectFile(event.target.files?.[0]));
    $('#saveProjectBtn').addEventListener('click', saveProjectFile);
    $('#exportPdfBtn').addEventListener('click', exportPdf);
    $('#exportHtmlBtn').addEventListener('click', exportHtml);

    $('#readModeBtn').addEventListener('click', () => setMode('read'));
    $('#editModeBtn').addEventListener('click', () => setMode('edit'));
    $('#zoomOutBtn').addEventListener('click', () => setZoom(state.zoom - .1));
    $('#zoomInBtn').addEventListener('click', () => setZoom(state.zoom + .1));

    $('#addPageBtn').addEventListener('click', () => addBlankPage(true));
    $('#duplicatePageBtn').addEventListener('click', duplicateCurrentPage);
    $('#deletePageBtn').addEventListener('click', deleteCurrentPage);
    $('#movePageUpBtn').addEventListener('click', () => moveCurrentPage(-1));
    $('#movePageDownBtn').addEventListener('click', () => moveCurrentPage(1));
    $('#applyPageSettingsBtn').addEventListener('click', applyPageSettings);

    $('#addTextBtn').addEventListener('click', () => addTextElement());
    $('#addWhiteoutBtn').addEventListener('click', addWhiteoutElement);
    $('#addHighlightBtn').addEventListener('click', addHighlightElement);
    $('#addImageBtn').addEventListener('click', () => {
      imageInsertTargetPageId = state.currentPageId;
      dom.imageFileInput.click();
    });
    dom.imageFileInput.addEventListener('change', async event => {
      try { await addImageFromFile(event.target.files?.[0]); }
      catch (error) { console.error(error); showToast('Não foi possível inserir a imagem.'); }
      event.target.value = '';
      imageInsertTargetPageId = null;
    });

    $('#deleteElementBtn').addEventListener('click', deleteSelectedElement);
    $('#duplicateElementBtn').addEventListener('click', duplicateSelectedElement);
    $('#bringFrontBtn').addEventListener('click', () => changeElementZ('front'));
    $('#sendBackBtn').addEventListener('click', () => changeElementZ('back'));
    ['elementX', 'elementY', 'elementW', 'elementH'].forEach(id => $(`#${id}`).addEventListener('change', updateSelectedGeometry));
    $('#elementOpacity').addEventListener('input', event => {
      const result = getElement();
      if (!result) return;
      result.element.opacity = Number(event.target.value);
      const node = $(`.editor-element[data-element-id="${CSS.escape(result.element.id)}"]`);
      if (node) node.style.opacity = event.target.value;
      scheduleSessionSave();
    });

    $('#fontFamily').addEventListener('change', event => applyFormatting('fontFamily', event.target.value));
    $('#fontSize').addEventListener('change', event => applyFormatting('fontSize', event.target.value));
    $('#boldBtn').addEventListener('mousedown', event => event.preventDefault());
    $('#italicBtn').addEventListener('mousedown', event => event.preventDefault());
    $('#underlineBtn').addEventListener('mousedown', event => event.preventDefault());
    $('#alignBtn').addEventListener('mousedown', event => event.preventDefault());
    $('#boldBtn').addEventListener('click', () => applyFormatting('bold'));
    $('#italicBtn').addEventListener('click', () => applyFormatting('italic'));
    $('#underlineBtn').addEventListener('click', () => applyFormatting('underline'));
    $('#alignBtn').addEventListener('click', () => applyFormatting('align'));
    $('#textColor').addEventListener('input', event => applyFormatting('color', event.target.value));
    $('#fillColor').addEventListener('input', event => applyFillColor(event.target.value));

    $('#floatAddText').addEventListener('click', () => addTextElement());
    $('#floatAddImage').addEventListener('click', () => {
      imageInsertTargetPageId = state.currentPageId;
      dom.imageFileInput.click();
    });
    $('#floatDuplicate').addEventListener('click', duplicateSelectedElement);
    $('#floatDelete').addEventListener('click', deleteSelectedElement);

    $('#restoreSessionBtn').addEventListener('click', restoreSavedSession);
    $('#discardSessionBtn').addEventListener('click', clearSavedSession);

    document.addEventListener('selectionchange', saveSelectionRange);
    document.addEventListener('keydown', event => {
      const modifier = event.ctrlKey || event.metaKey;
      const inEditableField = Boolean(event.target.closest?.('[contenteditable="true"], input, textarea, select'));
      if (modifier && event.key.toLowerCase() === 's') {
        event.preventDefault();
        saveSessionNow();
        showToast('Sessão salva no navegador.');
      }
      if (modifier && event.key.toLowerCase() === 'z' && !inEditableField) {
        event.preventDefault();
        undoLastAction();
      }
      if (modifier && (event.key === '=' || event.key === '+')) {
        event.preventDefault();
        setZoom(state.zoom + .1);
      }
      if (modifier && event.key === '-') {
        event.preventDefault();
        setZoom(state.zoom - .1);
      }
      if ((event.key === 'Delete' || event.key === 'Backspace') && selectedElementId && !inEditableField) {
        event.preventDefault();
        deleteSelectedElement();
      }
      if (event.key === 'Escape') {
        if (document.activeElement?.closest?.('[contenteditable="true"], input, textarea')) document.activeElement.blur();
        clearSelection();
      }
    });

    dom.workspace.addEventListener('wheel', event => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      setZoom(state.zoom + (event.deltaY < 0 ? .1 : -.1));
    }, { passive: false });

    let dragDepth = 0;
    window.addEventListener('dragenter', event => {
      if (!event.dataTransfer?.types?.includes('Files')) return;
      dragDepth++;
      dom.app.classList.add('dropping');
    });
    window.addEventListener('dragleave', () => {
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth) dom.app.classList.remove('dropping');
    });
    window.addEventListener('dragover', event => event.preventDefault());
    window.addEventListener('drop', async event => {
      event.preventDefault();
      dragDepth = 0;
      dom.app.classList.remove('dropping');
      const file = event.dataTransfer?.files?.[0];
      if (!file) return;
      const name = file.name || '';
      try {
        if (file.type === 'application/pdf' || /\.pdf$/i.test(name)) await openPdfFile(file);
        else if (/\.json$/i.test(name)) await openProjectFile(file);
        else if (file.type.startsWith('image/')) {
          if (!state.pages.length) showToast('Abra ou crie um documento antes de inserir imagens.');
          else await addImageFromFile(file, state.currentPageId);
        } else showToast('Arquivo não suportado. Solte um PDF, uma imagem ou um projeto .json.');
      } catch (error) {
        console.error(error);
        showToast('Não foi possível abrir o arquivo solto.');
      }
    });

    dom.workspace.addEventListener('scroll', () => {
      const node = selectedElementId ? $(`.editor-element[data-element-id="${CSS.escape(selectedElementId)}"]`) : null;
      if (node) positionFloatToolbar(node);
    }, { passive: true });
    window.addEventListener('resize', () => {
      const node = selectedElementId ? $(`.editor-element[data-element-id="${CSS.escape(selectedElementId)}"]`) : null;
      if (node) positionFloatToolbar(node);
    });
  }

  async function init() {
    bindEvents();
    applyAppDocumentState();
    await checkForSavedSession();
  }

  init();
})();
