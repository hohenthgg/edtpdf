(() => {
  'use strict';

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

  const A4_WIDTH_PX = 210 * 96 / 25.4;
  const A4_HEIGHT_PX = 297 * 96 / 25.4;
  const PDF_CSS_SCALE = 96 / 72;
  const MAX_CANVAS_PIXELS = 16 * 1024 * 1024;
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
  let exportPixelRatio = 1;
  let pdfRerenderTimer = null;
  const textModels = new WeakMap(); // pdfDocument → Map(página original → linhas e parágrafos detectados)
  const sourceCanvases = new WeakMap(); // .paper → desenho original do PDF.js, antes do reflow
  const reflowFrames = new Map();
  const pendingReflow = new Set(); // elementos ainda sendo medidos na conversão
  const grownPagesWarned = new Set();
  let reflowObserver = null;

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
    schedulePdfRerender();
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
    reflowObserver?.disconnect();
  }

  // Pixels do canvas por pixel CSS da página. A página é ampliada com
  // transform: scale(zoom), então o canvas precisa acompanhar o zoom e a
  // densidade da tela para não ser esticado (e ficar borrado).
  function pdfPixelRatio(pageState) {
    const dpr = window.devicePixelRatio || 1;
    const wanted = isExporting ? Math.max(dpr, exportPixelRatio) : dpr * (state.zoom || 1);
    const area = Math.max(1, pageState.width * pageState.height);
    return Math.max(1, Math.min(wanted, Math.sqrt(MAX_CANVAS_PIXELS / area)));
  }

  function needsPdfRender(pageState, paper) {
    if (paper.dataset.rendered !== '1') return true;
    const current = Number(paper.dataset.pixelRatio) || 0;
    const target = pdfPixelRatio(pageState);
    return Math.abs(current - target) > target * 0.05;
  }

  async function ensurePdfPageRendered(pageId) {
    const pageState = getPage(pageId);
    const paper = $(`#paper-${CSS.escape(pageId)}`);
    if (!pageState || pageState.type !== 'pdf' || !paper) return;
    if (renderPromises.has(pageId)) {
      await renderPromises.get(pageId);
      return ensurePdfPageRendered(pageId);
    }
    if (!needsPdfRender(pageState, paper)) return;
    if (!pdfDocument) throw new Error('Documento PDF não carregado.');

    const promise = (async () => {
      paper.dataset.rendering = '1';
      try {
        const firstRender = paper.dataset.rendered !== '1';
        const sourcePage = await pdfDocument.getPage(pageState.sourcePageNumber);
        const viewport = sourcePage.getViewport({ scale: PDF_CSS_SCALE });
        const outputScale = pdfPixelRatio(pageState);
        const oldCanvas = $('.pdf-canvas', paper);
        // Desenha fora da tela e só troca no fim, para a página não piscar em branco ao mudar o zoom.
        const canvas = document.createElement('canvas');
        canvas.className = 'pdf-canvas';
        canvas.setAttribute('aria-label', oldCanvas?.getAttribute('aria-label') || '');
        canvas.width = Math.floor(viewport.width * outputScale);
        canvas.height = Math.floor(viewport.height * outputScale);
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        const context = canvas.getContext('2d', { alpha: false });
        const transform = outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : null;

        await sourcePage.render({ canvasContext: context, viewport, transform, background: 'rgb(255,255,255)' }).promise;
        // Com parágrafos reformatados, a tela mostra uma composição; o desenho do PDF.js fica guardado como fonte.
        let visible = canvas;
        if (pageHasReflow(pageState)) {
          sourceCanvases.set(paper, canvas);
          visible = composeReflowCanvas(pageState, paper, canvas);
        } else {
          sourceCanvases.delete(paper);
          paper._reflowOps = [];
        }
        presentPdfCanvas(paper, visible, oldCanvas, canvas.getAttribute('aria-label'));
        paper.dataset.pixelRatio = String(outputScale);
        if (firstRender) {
          const textContent = await sourcePage.getTextContent();
          renderTextLayer(pageState, paper, viewport, textContent, sourcePage);
          createThumbnailFromCanvas(pageState, canvas);
        }
        applyReflowOffsetsToTextLayer(paper);
        paper.dataset.rendered = '1';
      } finally {
        delete paper.dataset.rendering;
        renderPromises.delete(pageId);
      }
    })();

    renderPromises.set(pageId, promise);
    return promise;
  }

  function schedulePdfRerender() {
    clearTimeout(pdfRerenderTimer);
    pdfRerenderTimer = setTimeout(() => rerenderNearbyPdfPages().catch(console.error), 180);
  }

  // Páginas longe da área visível são redesenhadas pelo observer quando voltarem a aparecer.
  async function rerenderNearbyPdfPages() {
    if (isExporting || !pdfDocument) return;
    const view = dom.workspace.getBoundingClientRect();
    const nearby = $$('.page-shell').filter(shell => {
      const rect = shell.getBoundingClientRect();
      return rect.bottom > view.top - 1300 && rect.top < view.bottom + 1300;
    });
    for (const shell of nearby) {
      if (isExporting) return;
      const pageId = shell.dataset.pageId;
      if (getPage(pageId)?.type !== 'pdf') continue;
      await ensurePdfPageRendered(pageId).catch(console.error);
    }
  }

  function renderTextLayer(pageState, paper, viewport, textContent, sourcePage) {
    const layer = $('.text-layer', paper);
    layer.innerHTML = '';
    const styles = textContent.styles || {};
    if (!textModels.has(pdfDocument)) textModels.set(pdfDocument, new Map());
    textModels.get(pdfDocument).set(pageState.sourcePageNumber, buildTextModel(viewport, textContent, sourcePage));

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
      span.dataset.baseLeft = String(tx[4]);
      span.dataset.baseTop = String(tx[5] - fontAscent);
      span.dataset.baseline = String(tx[5]);

      if (isTextItemConverted(pageState, itemIndex)) span.classList.add('converted');
      span.addEventListener('dblclick', event => {
        event.preventDefault();
        event.stopPropagation();
        if (state.mode !== 'edit' || span.classList.contains('converted')) return;
        convertPdfParagraphToOverlay(pageState, span, paper, event).catch(error => {
          console.error(error);
          convertPdfTextToOverlay(pageState, span, paper);
        });
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

  /* ── Reflow de parágrafos ────────────────────────────────────
   * O duplo clique converte o parágrafo inteiro numa caixa de texto com a
   * largura da coluna e altura automática. Quando a edição faz o parágrafo
   * crescer, a imagem da página é cortada numa faixa livre logo abaixo dele e
   * tudo o que vem depois desce junto (texto, tabelas, elementos inseridos).
   * Coordenadas de element.reflow são as da página original, sem deslocamentos.
   */

  function isTextItemConverted(page, index) {
    return (page.elements || []).some(element =>
      String(element.sourceTextItem) === String(index) || element.reflow?.items?.includes(index));
  }

  function pageHasReflow(page) {
    return (page.elements || []).some(element => element.reflow);
  }

  function getTextModel(page) {
    return textModels.get(pdfDocument)?.get(page.sourcePageNumber) || null;
  }

  const KNOWN_FONT_STACKS = [
    [/^dejavusansmono/, '"DejaVu Sans Mono", "Courier New"', 'monospace'],
    [/^dejavusans/, '"DejaVu Sans"', 'sans-serif'],
    [/^dejavuserif/, '"DejaVu Serif"', 'serif'],
    [/^(arial|helvetica|liberationsans|arimo|nimbussans)/, 'Arial, Helvetica, "Liberation Sans", Arimo', 'sans-serif'],
    [/^(timesnewroman|times|liberationserif|tinos|nimbusroman)/, '"Times New Roman", Times, "Liberation Serif", Tinos', 'serif'],
    [/^(couriernew|courier|liberationmono|cousine|nimbusmono)/, '"Courier New", Courier, "Liberation Mono", Cousine', 'monospace'],
    [/^calibri/, 'Calibri, Carlito', 'sans-serif'],
    [/^cambria/, 'Cambria, Caladea', 'serif'],
    [/^georgia/, 'Georgia', 'serif'],
    [/^verdana/, 'Verdana', 'sans-serif'],
    [/^(segoeui|segoe)/, '"Segoe UI"', 'sans-serif']
  ];

  function describePdfFont(sourcePage, fontName, style) {
    let name = '';
    try { name = sourcePage?.commonObjs.get(fontName)?.name || ''; } catch (error) { name = ''; }
    const clean = name.replace(/^[A-Z]{6}\+/, '');
    const bold = /bold|black|heavy|semibold|demi/i.test(clean);
    const italic = /italic|oblique|kursiv/i.test(clean);
    const baseName = clean.split(/[-,]/)[0].replace(/(PS)?MT$/, '').replace(/[^A-Za-z0-9]/g, '');
    const lower = baseName.toLowerCase();
    const known = KNOWN_FONT_STACKS.find(([pattern]) => pattern.test(lower));
    let generic = /mono|courier|consol/i.test(clean) ? 'monospace'
      : /sans/i.test(clean) ? 'sans-serif'
      : /serif|times|roman|georgia|garamond|cambria|book|minion|palatino|baskerville|caslon|bodoni/i.test(clean) ? 'serif'
      : (style.fontFamily === 'serif' || style.fontFamily === 'monospace' ? style.fontFamily : 'sans-serif');
    let stack;
    if (known) {
      stack = known[1];
      generic = known[2];
    } else if (baseName) {
      const spaced = baseName.replace(/([a-z])([A-Z])/g, '$1 $2');
      stack = spaced === baseName ? `"${baseName}"` : `"${spaced}", "${baseName}"`;
    } else {
      stack = generic === 'serif' ? 'Georgia, "Times New Roman"' : generic === 'monospace' ? '"Courier New"' : 'Arial';
    }
    const css = `${stack}, ${generic}`;
    return { css, bold, italic, key: `${css}|${bold}|${italic}` };
  }

  // Agrupa os trechos do PDF.js em linhas (mesma linha de base) e as linhas em
  // segmentos separados por vãos largos (colunas, células de tabela).
  function buildTextModel(viewport, textContent, sourcePage) {
    const styles = textContent.styles || {};
    const fonts = new Map();
    const items = [];
    textContent.items.forEach((item, index) => {
      if (!item.str) return;
      const tx = window.pdfjsLib.Util.transform(viewport.transform, item.transform);
      const fs = Math.hypot(tx[2], tx[3]);
      if (!fs || Math.abs(tx[1]) > 0.01 * fs || Math.abs(tx[2]) > 0.01 * fs) return;
      const style = styles[item.fontName] || {};
      if (!fonts.has(item.fontName)) fonts.set(item.fontName, describePdfFont(sourcePage, item.fontName, style));
      const ascent = clamp(style.ascent ? style.ascent : style.descent ? 1 + style.descent : 0.8, 0.6, 1.1) * fs;
      const descent = clamp(style.descent ? -style.descent : 0.2, 0.1, 0.4) * fs;
      items.push({
        index, str: item.str, blank: !item.str.trim(), fs, font: fonts.get(item.fontName),
        x: tx[4], right: tx[4] + item.width * viewport.scale, baseline: tx[5], top: tx[5] - ascent, bottom: tx[5] + descent
      });
    });

    const rows = [];
    const findRow = item => {
      for (let i = rows.length - 1; i >= 0; i--) {
        const row = rows[i];
        if (row.baseline < item.baseline - 3 * item.fs) break;
        if (Math.abs(row.baseline - item.baseline) <= 0.45 * Math.max(row.fs, item.fs)) return row;
      }
      return null;
    };
    const byBaseline = (a, b) => a.baseline - b.baseline || a.x - b.x;
    items.filter(item => !item.blank).sort(byBaseline).forEach(item => {
      const row = findRow(item);
      if (row) {
        row.items.push(item);
        if (item.fs > row.fs) { row.fs = item.fs; row.baseline = item.baseline; }
      } else {
        rows.push({ baseline: item.baseline, fs: item.fs, items: [item] });
        rows.sort((a, b) => a.baseline - b.baseline);
      }
    });
    items.filter(item => item.blank).forEach(item => findRow(item)?.items.push(item));

    const segments = [];
    rows.forEach(row => {
      row.items.sort((a, b) => a.x - b.x);
      let current = null;
      row.items.forEach(item => {
        // Vãos medidos só entre trechos visíveis: há PDFs com "espaços" largos atravessando células.
        if (current && !item.blank && item.x - current.reach > 0.9 * Math.max(row.fs, item.fs)) current = null;
        if (!current) {
          current = { items: [], reach: -Infinity };
          segments.push(current);
        }
        current.items.push(item);
        if (!item.blank) current.reach = Math.max(current.reach, item.right);
      });
    });

    const segOfItem = new Map();
    const result = [];
    segments.forEach(segment => {
      const solid = segment.items.filter(item => !item.blank);
      if (!solid.length) return;
      const main = solid.reduce((best, item) => (item.str.length * item.fs > best.str.length * best.fs ? item : best), solid[0]);
      const sizes = new Map();
      solid.forEach(item => {
        const key = Math.round(item.fs * 10) / 10;
        sizes.set(key, (sizes.get(key) || 0) + item.str.length);
      });
      const fs = [...sizes.entries()].sort((a, b) => b[1] - a[1])[0][0];
      const seg = {
        id: result.length,
        items: segment.items,
        fs,
        baseline: main.baseline,
        left: Math.min(...solid.map(item => item.x)),
        right: Math.max(...solid.map(item => item.right)),
        top: Math.min(...solid.map(item => item.top)),
        bottom: Math.max(...solid.map(item => item.bottom))
      };
      segment.items.forEach(item => segOfItem.set(item.index, seg));
      result.push(seg);
    });
    return {
      segments: result,
      segOfItem,
      minLeft: result.length ? Math.min(...result.map(seg => seg.left)) : 72
    };
  }

  function segmentFirstWordWidth(seg) {
    const first = seg.items.find(item => !item.blank);
    if (!first) return 0;
    const word = first.str.trimStart().split(/\s+/)[0] || '';
    return (first.right - first.x) * (word.length / Math.max(1, first.str.length));
  }

  function sameTextSize(a, b) {
    return Math.abs(a - b) <= Math.max(0.6, 0.08 * Math.max(a, b));
  }

  function estimateColumnRight(model, bodyLeft, fs, lines) {
    const linesRight = Math.max(...lines.map(line => line.right));
    let right = linesRight;
    // Linhas que começam no mesmo x (a coluna ou a célula) indicam até onde o texto vai.
    model.segments.forEach(seg => {
      if (Math.abs(seg.left - bodyLeft) <= 0.6 * fs) right = Math.max(right, seg.right);
    });
    // Linha isolada (título, item de lista): usa o texto vizinho que passa por baixo/cima dela.
    if (right === linesRight && lines.length === 1) {
      const line = lines[0];
      model.segments.forEach(seg => {
        if (seg !== line && Math.abs(seg.baseline - line.baseline) <= 10 * fs && seg.left <= bodyLeft + 1 && seg.right > right) right = seg.right;
      });
    }
    // Não invade o que estiver à direita nas mesmas linhas (outra coluna ou célula).
    lines.forEach(line => model.segments.forEach(seg => {
      if (seg !== line && Math.abs(seg.baseline - line.baseline) <= 0.5 * fs && seg.left >= line.right - 0.5) {
        right = Math.min(right, seg.left - 0.4 * fs);
      }
    }));
    return Math.max(right, linesRight);
  }

  // A linha de baixo continua o parágrafo se a sua primeira palavra não teria
  // cabido no fim da linha de cima (senão, a linha de cima terminou de propósito).
  function linesContinue(upper, lower, colRight) {
    const fs = upper.fs;
    const upperText = upper.items.map(item => item.str).join('').trimEnd();
    if (/[-‐]$/.test(upperText)) return true;
    const remaining = colRight - upper.right;
    return segmentFirstWordWidth(lower) + 0.25 * fs > remaining - 0.15 * fs;
  }

  function neighborLine(model, cur, direction, bodyLeft, colRight) {
    const fs = cur.fs;
    let best = null;
    model.segments.forEach(seg => {
      const dy = (seg.baseline - cur.baseline) * direction;
      if (seg === cur || dy < 0.5 * fs || dy > 2.2 * fs || !sameTextSize(seg.fs, fs)) return;
      if (seg.right <= bodyLeft - 4 * fs || seg.left >= colRight) return;
      if (!best) { best = seg; return; }
      const bestDy = (best.baseline - cur.baseline) * direction;
      if (dy < bestDy - 0.3 * fs || (Math.abs(dy - bestDy) <= 0.3 * fs && Math.abs(seg.left - bodyLeft) < Math.abs(best.left - bodyLeft))) best = seg;
    });
    return best;
  }

  function detectParagraph(model, startSeg) {
    const fs = startSeg.fs;
    const lines = [startSeg];
    let bodyLeft = startSeg.left;
    let pitch = null;
    let firstLineFound = false;

    let cur = startSeg;
    while (lines.length < 400) {
      const colRight = estimateColumnRight(model, bodyLeft, fs, lines);
      const next = neighborLine(model, cur, 1, bodyLeft, colRight);
      if (!next) break;
      const dy = next.baseline - cur.baseline;
      if (dy < 0.9 * fs || dy > 2 * fs || (pitch && Math.abs(dy - pitch) > 0.2 * pitch)) break;
      let aligned = Math.abs(next.left - bodyLeft) <= 0.6 * fs;
      let newBodyLeft = bodyLeft;
      // A linha clicada pode ser a primeira, com recuo ou marcador (as demais começam noutro x).
      if (!aligned && lines.length === 1 && Math.abs(next.left - cur.left) <= 4 * fs) {
        aligned = true;
        newBodyLeft = next.left;
      }
      if (!aligned || !linesContinue(cur, next, estimateColumnRight(model, newBodyLeft, fs, [...lines, next]))) break;
      if (newBodyLeft !== bodyLeft) firstLineFound = true;
      bodyLeft = newBodyLeft;
      pitch ||= dy;
      lines.push(next);
      cur = next;
    }

    cur = lines[0];
    while (!firstLineFound && lines.length < 400) {
      const colRight = estimateColumnRight(model, bodyLeft, fs, lines);
      const prev = neighborLine(model, cur, -1, bodyLeft, colRight);
      if (!prev) break;
      const dy = cur.baseline - prev.baseline;
      if (dy < 0.9 * fs || dy > 2 * fs || (pitch && Math.abs(dy - pitch) > 0.2 * pitch)) break;
      const aligned = Math.abs(prev.left - bodyLeft) <= 0.6 * fs;
      const isFirstLine = !aligned && Math.abs(prev.left - bodyLeft) <= 4 * fs;
      if (!(aligned || isFirstLine) || !linesContinue(prev, cur, colRight)) break;
      pitch ||= dy;
      lines.unshift(prev);
      cur = prev;
      if (isFirstLine) break;
    }

    const colRight = estimateColumnRight(model, bodyLeft, fs, lines);
    return {
      lines,
      fs,
      bodyLeft,
      firstLeft: lines[0].left,
      colRight,
      pitch: pitch || typicalLinePitch(model, startSeg),
      left: Math.min(...lines.map(line => line.left)),
      right: Math.max(...lines.map(line => line.right)),
      top: Math.min(...lines.map(line => line.top)),
      bottom: Math.max(...lines.map(line => line.bottom))
    };
  }

  function typicalLinePitch(model, seg) {
    let best = Infinity;
    model.segments.forEach(other => {
      const dy = Math.abs(other.baseline - seg.baseline);
      if (other !== seg && sameTextSize(other.fs, seg.fs) && Math.abs(other.left - seg.left) <= 0.6 * seg.fs && dy >= 0.9 * seg.fs && dy <= 2 * seg.fs) best = Math.min(best, dy);
    });
    return Number.isFinite(best) ? best : seg.fs * 1.2;
  }

  function paragraphHtml(para, baseFont) {
    const wrapRun = run => {
      let html = escapeHtml(run.text);
      if (!html) return '';
      if (run.font.css !== baseFont.css) html = `<span style="font-family:${run.font.css.replace(/"/g, "'")}">${html}</span>`;
      if (run.font.italic !== baseFont.italic) html = run.font.italic ? `<i>${html}</i>` : `<span style="font-style:normal">${html}</span>`;
      if (run.font.bold !== baseFont.bold) html = run.font.bold ? `<b>${html}</b>` : `<span style="font-weight:400">${html}</span>`;
      return html;
    };
    let html = '';
    let previousText = '';
    para.lines.forEach((line, lineIndex) => {
      const runs = [];
      let prev = null;
      line.items.forEach(item => {
        let text = item.str;
        if (prev && !prev.blank && !item.blank && item.x - prev.right > 0.15 * item.fs && !/\s$/.test(prev.str) && !/^\s/.test(text)) text = ` ${text}`;
        const font = item.blank && runs.length ? runs[runs.length - 1].font : item.font;
        const last = runs[runs.length - 1];
        if (last && last.font.key === font.key) last.text += text;
        else runs.push({ font, text });
        prev = item;
      });
      if (runs.length) {
        runs[0].text = runs[0].text.trimStart();
        runs[runs.length - 1].text = runs[runs.length - 1].text.trimEnd();
      }
      const lineText = runs.map(run => run.text).join('');
      if (lineIndex > 0 && !/[-‐]$/.test(previousText)) html += ' ';
      html += runs.map(wrapRun).join('');
      previousText = lineText;
    });
    return html;
  }

  function dominantFont(para) {
    const weights = new Map();
    para.lines.forEach(line => line.items.forEach(item => {
      if (item.blank) return;
      const entry = weights.get(item.font.key) || { font: item.font, chars: 0 };
      entry.chars += item.str.length;
      weights.set(item.font.key, entry);
    }));
    return [...weights.values()].sort((a, b) => b.chars - a.chars)[0]?.font || { css: 'Arial, sans-serif', bold: false, italic: false, key: 'default' };
  }

  function toHex(r, g, b) {
    return `#${[r, g, b].map(value => Math.round(value).toString(16).padStart(2, '0')).join('')}`;
  }

  // Cor de fundo = cor mais frequente na área do parágrafo; cor do texto = pixels mais distantes dela.
  function sampleParagraphColors(source, ratio, box) {
    try {
      const sx = clamp(Math.floor(box.x * ratio), 0, source.width - 1);
      const sy = clamp(Math.floor(box.y * ratio), 0, source.height - 1);
      const sw = clamp(Math.ceil(box.w * ratio), 1, source.width - sx);
      const sh = clamp(Math.ceil(box.h * ratio), 1, source.height - sy);
      const data = source.getContext('2d').getImageData(sx, sy, sw, sh).data;
      const bins = new Map();
      for (let i = 0; i < data.length; i += 4) {
        const key = (data[i] >> 4) << 8 | (data[i + 1] >> 4) << 4 | (data[i + 2] >> 4);
        const bin = bins.get(key) || [0, 0, 0, 0];
        bin[0]++; bin[1] += data[i]; bin[2] += data[i + 1]; bin[3] += data[i + 2];
        bins.set(key, bin);
      }
      const top = [...bins.values()].sort((a, b) => b[0] - a[0])[0];
      const bg = [top[1] / top[0], top[2] / top[0], top[3] / top[0]];
      const distance = i => Math.abs(data[i] - bg[0]) + Math.abs(data[i + 1] - bg[1]) + Math.abs(data[i + 2] - bg[2]);
      let max = 0;
      for (let i = 0; i < data.length; i += 4) max = Math.max(max, distance(i));
      let text = '#111111';
      if (max > 90) {
        const sum = [0, 0, 0, 0];
        for (let i = 0; i < data.length; i += 4) {
          if (distance(i) >= max * 0.8) { sum[0]++; sum[1] += data[i]; sum[2] += data[i + 1]; sum[3] += data[i + 2]; }
        }
        text = toHex(sum[1] / sum[0], sum[2] / sum[0], sum[3] / sum[0]);
      }
      return { bg: toHex(...bg), text };
    } catch (error) {
      return { bg: '#ffffff', text: '#111111' };
    }
  }

  function mergeTextBlocks(segments) {
    const blocks = [];
    [...segments].sort((a, b) => a.top - b.top).forEach(seg => {
      const block = blocks.find(item => seg.left < item.right && item.left < seg.right && seg.top - item.bottom <= 0.9 * Math.max(seg.fs, item.fs));
      if (block) {
        block.left = Math.min(block.left, seg.left);
        block.right = Math.max(block.right, seg.right);
        block.bottom = Math.max(block.bottom, seg.bottom);
        block.fs = Math.max(block.fs, seg.fs);
      } else {
        blocks.push({ left: seg.left, right: seg.right, top: seg.top, bottom: seg.bottom, fs: seg.fs });
      }
    });
    return blocks;
  }

  // Escolhe onde cortar a página para empurrar o conteúdo abaixo do parágrafo.
  // Corte de largura total: numa faixa sem texto e sem bordas horizontais, sem
  // partir parágrafos de outras colunas. Se não houver, só a coluna desce.
  function computeReflowCut(model, para, source, ratio, page) {
    const own = new Set(para.lines);
    const fs = para.fs;
    const colLeft = para.left;
    const colRight = para.colRight;
    const baseHeight = pageBaseHeight(page);
    const others = model.segments.filter(seg => !own.has(seg));
    const inColumn = seg => seg.right > colLeft + 0.5 && seg.left < colRight - 0.5;
    const columnLines = others.filter(inColumn);
    const below = columnLines.filter(seg => seg.top >= para.bottom - 0.5);
    const nextOwnTop = below.length ? Math.min(...below.map(seg => seg.top)) : baseHeight - 1;
    const foreignBlocks = mergeTextBlocks(others.filter(seg => !inColumn(seg)));
    const yStart = Math.min(para.bottom, nextOwnTop);
    const yEnd = Math.max(yStart, Math.min(nextOwnTop, baseHeight - 1));

    let band = null;
    let bandTop = 0;
    try {
      bandTop = clamp(Math.floor((yStart - 2) * ratio), 0, source.height - 1);
      const bandBottom = clamp(Math.ceil((yEnd + 2) * ratio), bandTop + 1, source.height);
      band = source.getContext('2d').getImageData(0, bandTop, source.width, bandBottom - bandTop);
    } catch (error) {
      band = null;
    }
    const homogeneous = (y, x0, x1) => {
      if (!band) return true;
      const row = Math.round(y * ratio) - bandTop;
      if (row < 1 || row + 1 >= band.height) return true;
      const start = clamp(Math.floor(x0 * ratio), 0, band.width);
      const end = clamp(Math.ceil(x1 * ratio), start, band.width);
      let differing = 0;
      for (let x = start; x < end; x++) {
        const a = ((row - 1) * band.width + x) * 4;
        const b = ((row + 1) * band.width + x) * 4;
        const diff = Math.abs(band.data[a] - band.data[b]) + Math.abs(band.data[a + 1] - band.data[b + 1]) + Math.abs(band.data[a + 2] - band.data[b + 2]);
        if (diff > 60) differing++;
      }
      return differing <= Math.max(2, (end - start) * 0.003);
    };
    const outside = (y, boxes) => !boxes.some(box => y > box.top - 0.5 && y < box.bottom + 0.5);

    for (let y = yStart + 0.5; y <= yEnd; y += 0.5) {
      if (outside(y, others) && outside(y, foreignBlocks) && homogeneous(y, 0, page.width)) {
        return { cut: y, x0: 0, x1: page.width, free: Math.max(0, y - para.bottom - 1) };
      }
    }
    const x0 = Math.max(0, colLeft - 0.6 * fs);
    const x1 = Math.min(page.width, colRight + 0.6 * fs);
    for (let y = yStart + 0.5; y <= yEnd; y += 0.5) {
      if (outside(y, columnLines) && homogeneous(y, x0, x1)) return { cut: y, x0, x1, free: 0 };
    }
    return { cut: yEnd, x0, x1, free: 0 };
  }

  function pageBaseHeight(page) {
    return page.originalHeightPt ? page.originalHeightPt * PDF_CSS_SCALE : page.height;
  }

  // Empurrões ativos da página, em ordem de corte. Parágrafos que cortam na mesma
  // altura (células da mesma linha de uma tabela) empurram pelo maior deles.
  function buildReflowOps(page) {
    const ops = [];
    (page.elements || [])
      .filter(element => element.reflow && element.reflow.pushed > 0.25)
      .sort((a, b) => a.reflow.cut - b.reflow.cut)
      .forEach(element => {
        const flow = element.reflow;
        const same = ops.find(op => Math.abs(op.cut - flow.cut) < 1 && op.x0 < flow.x1 && flow.x0 < op.x1);
        if (same) {
          same.push = Math.max(same.push, flow.pushed);
          same.x0 = Math.min(same.x0, flow.x0);
          same.x1 = Math.max(same.x1, flow.x1);
        } else {
          ops.push({ cut: flow.cut, x0: flow.x0, x1: flow.x1, push: flow.pushed });
        }
      });
    return ops;
  }

  // Quanto um ponto da página original (x, y) foi deslocado para baixo.
  function reflowOffsetAt(ops, x, y) {
    return ops.reduce((sum, op) => (op.cut <= y && x >= op.x0 && x <= op.x1 ? sum + op.push : sum), 0);
  }

  function lastContentRow(source, ratio) {
    if (source._lastContentRow != null) return source._lastContentRow;
    let last = 0;
    try {
      const { width, height } = source;
      const data = source.getContext('2d').getImageData(0, 0, width, height).data;
      outer: for (let y = height - 1; y >= 0; y--) {
        for (let x = 0; x < width; x++) {
          const i = (y * width + x) * 4;
          if (data[i] < 235 || data[i + 1] < 235 || data[i + 2] < 235) { last = y; break outer; }
        }
      }
    } catch (error) {
      last = source.height;
    }
    source._lastContentRow = last / ratio;
    return source._lastContentRow;
  }

  function setPdfPageHeight(page, paper, height) {
    if (Math.abs(page.height - height) < 0.5) return;
    const grewNow = height > pageBaseHeight(page) + 0.5 && page.height <= pageBaseHeight(page) + 0.5;
    page.height = height;
    paper.style.height = `${height}px`;
    const shell = paper.closest('.page-shell');
    if (shell) shell.style.height = `${height * state.zoom}px`;
    if (grewNow && !grownPagesWarned.has(page.id)) {
      grownPagesWarned.add(page.id);
      const index = state.pages.indexOf(page) + 1;
      showToast(`A página ${index} foi alongada para não cortar o conteúdo empurrado pelo texto.`, 4200);
    }
    scheduleSessionSave();
  }

  function composeReflowCanvas(page, paper, source) {
    const flows = (page.elements || []).filter(element => element.reflow);
    const ratio = source.width / page.width;
    const ops = buildReflowOps(page);
    paper._reflowOps = ops;

    // A página só cresce se o conteúdo empurrado (ou o próprio texto editado)
    // passar da margem inferior; o espaço em branco do rodapé é usado antes.
    const baseHeight = pageBaseHeight(page);
    let height = baseHeight;
    if (flows.length) {
      const last = lastContentRow(source, ratio);
      const margin = Math.max(...flows.map(element => element.reflow.margin || 48));
      const limit = Math.max(baseHeight - margin, last);
      const shift = Math.max(0, ...ops.map(op => reflowOffsetAt(ops, (op.x0 + op.x1) / 2, last)));
      const textBottom = Math.max(...flows.map(element => element.y + element.h));
      height = baseHeight + Math.max(0, Math.ceil(Math.max(last + shift, textBottom) - limit));
    }
    setPdfPageHeight(page, paper, height);
    if (!flows.length) return source;

    const out = document.createElement('canvas');
    out.width = source.width;
    out.height = Math.round(height * ratio);
    const ctx = out.getContext('2d', { alpha: false });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(source, 0, 0);
    // Apaga o texto original dos parágrafos convertidos (a caixa editável o substitui).
    flows.forEach(element => {
      const box = element.reflow.box;
      ctx.fillStyle = element.reflow.bg || '#ffffff';
      ctx.fillRect(Math.floor((box.x - 1) * ratio), Math.floor(box.y * ratio), Math.ceil((box.w + 2) * ratio), Math.ceil(box.h * ratio));
    });

    const strip = document.createElement('canvas');
    ops.forEach((op, index) => {
      const before = reflowOffsetAt(ops.slice(0, index), (op.x0 + op.x1) / 2, op.cut);
      const sy = Math.round((op.cut + before) * ratio);
      const sx = clamp(Math.floor(op.x0 * ratio), 0, out.width);
      const sw = clamp(Math.ceil(op.x1 * ratio), sx, out.width) - sx;
      const dy = Math.round(op.push * ratio);
      if (sw <= 0 || dy <= 0 || sy >= out.height) return;
      const h = out.height - sy - dy;
      if (h > 0) {
        strip.width = sw;
        strip.height = h;
        strip.getContext('2d').drawImage(out, sx, sy, sw, h, 0, 0, sw, h);
        ctx.drawImage(strip, sx, sy + dy);
      }
      // O vão aberto repete a linha de pixels do corte: bordas verticais e fundos de célula continuam.
      strip.width = sw;
      strip.height = 1;
      strip.getContext('2d').drawImage(out, sx, sy, sw, 1, 0, 0, sw, 1);
      ctx.drawImage(strip, 0, 0, sw, 1, sx, sy, sw, dy);
    });
    return out;
  }

  function presentPdfCanvas(paper, visible, current, ariaLabel) {
    visible.className = 'pdf-canvas';
    if (ariaLabel) visible.setAttribute('aria-label', ariaLabel);
    const page = getPage(paper.dataset.pageId);
    if (page) {
      visible.style.width = `${page.width}px`;
      visible.style.height = `${page.height}px`;
    }
    if (current === visible) return;
    if (current) {
      current.replaceWith(visible);
      if (current !== sourceCanvases.get(paper)) {
        current.width = 1;
        current.height = 1;
      }
    } else {
      paper.prepend(visible);
    }
  }

  function applyReflowOffsetsToTextLayer(paper) {
    const ops = paper._reflowOps || [];
    $$('.text-layer span', paper).forEach(span => {
      const top = Number(span.dataset.baseTop);
      if (!Number.isFinite(top)) return;
      const offset = ops.length ? reflowOffsetAt(ops, Number(span.dataset.baseLeft), Number(span.dataset.baseline)) : 0;
      span.style.top = `${top + offset}px`;
    });
  }

  function scheduleReflowCompose(page) {
    if (reflowFrames.has(page.id)) return;
    reflowFrames.set(page.id, requestAnimationFrame(() => {
      reflowFrames.delete(page.id);
      composeReflowNow(page);
    }));
  }

  function composeReflowNow(page) {
    const paper = $(`#paper-${CSS.escape(page.id)}`);
    // Uma renderização em andamento já compõe a página ao terminar.
    if (!paper || paper.dataset.rendered !== '1' || paper.dataset.rendering) return;
    const current = $('.pdf-canvas', paper);
    let source = sourceCanvases.get(paper);
    if (!source) {
      source = current;
      sourceCanvases.set(paper, source);
    }
    presentPdfCanvas(paper, composeReflowCanvas(page, paper, source), current);
    applyReflowOffsetsToTextLayer(paper);
  }

  // Move para baixo (ou de volta para cima) os elementos abaixo do corte de um parágrafo.
  function shiftElementsBelow(page, element, delta) {
    if (Math.abs(delta) < 0.25) return;
    const flow = element.reflow;
    const opsAbove = buildReflowOps(page).filter(op => op.cut < flow.cut - 0.5);
    const cutOnScreen = flow.cut + reflowOffsetAt(opsAbove, (flow.x0 + flow.x1) / 2, flow.cut);
    page.elements.forEach(other => {
      if (other === element) return;
      const centerX = other.x + other.w / 2;
      if (other.y < cutOnScreen - 0.5 || centerX < flow.x0 || centerX > flow.x1) return;
      other.y += delta;
      const node = $(`.editor-element[data-element-id="${CSS.escape(other.id)}"]`);
      if (node) applyElementGeometry(node, other);
    });
  }

  function groupPush(page, flow) {
    return (page.elements || []).reduce((max, element) => {
      const other = element.reflow;
      if (!other || Math.abs(other.cut - flow.cut) >= 1 || other.x0 >= flow.x1 || flow.x0 >= other.x1) return max;
      return Math.max(max, other.pushed || 0);
    }, 0);
  }

  function updateReflowElement(page, element, node) {
    const flow = element.reflow;
    if (!flow || pendingReflow.has(element.id) || !node.isConnected) return;
    const height = node.offsetHeight;
    if (!height) return;
    element.h = height;
    const push = Math.max(0, Math.round((height - flow.baseH - flow.free) * 100) / 100);
    if (Math.abs(push - (flow.pushed || 0)) < 0.25) return;
    const before = groupPush(page, flow);
    flow.pushed = push;
    shiftElementsBelow(page, element, groupPush(page, flow) - before);
    scheduleReflowCompose(page);
    scheduleSessionSave();
  }

  function observeReflowNode(node) {
    reflowObserver ||= new ResizeObserver(entries => entries.forEach(entry => {
      const target = entry.target;
      const page = getPage(target.dataset.pageId);
      const element = page?.elements?.find(item => item.id === target.dataset.elementId);
      if (element?.reflow) updateReflowElement(page, element, target);
    }));
    reflowObserver.observe(node);
  }

  async function loadElementFonts(style) {
    if (!document.fonts?.load) return;
    const size = Math.max(1, Math.round(style.fontSize || 12));
    const loads = ['normal 400', 'normal 700', 'italic 400', 'italic 700']
      .map(variant => document.fonts.load(`${variant} ${size}px ${style.fontFamily}`).catch(() => null));
    await Promise.race([Promise.all(loads), new Promise(resolve => setTimeout(resolve, 2500))]);
  }

  // Ajusta o espaçamento entre letras para a fonte substituta quebrar as linhas
  // como o original (mesmo número de linhas).
  function calibrateLetterSpacing(element, node, body, targetLines) {
    const style = element.style;
    const linePx = style.fontSize * style.lineHeight;
    const lineCount = () => Math.round(node.offsetHeight / linePx);
    const apply = value => {
      style.letterSpacing = Math.abs(value) < 0.004 * style.fontSize ? 0 : Math.round(value * 1000) / 1000;
      body.style.letterSpacing = `${style.letterSpacing}px`;
      return lineCount();
    };
    const initial = apply(0);
    if (initial === targetLines) return initial;
    let low = initial > targetLines ? -0.08 * style.fontSize : 0;
    let high = initial > targetLines ? 0 : 0.06 * style.fontSize;
    for (let i = 0; i < 8; i++) {
      const mid = (low + high) / 2;
      const count = apply(mid);
      if (count === targetLines) return count;
      if (count > targetLines) high = mid;
      else low = mid;
    }
    // Sem acerto exato: no mínimo não passa do número de linhas original (ou fica sem ajuste).
    return apply(initial > targetLines ? low : 0);
  }

  async function convertPdfParagraphToOverlay(page, span, paper, event) {
    const model = getTextModel(page);
    const startSeg = model?.segOfItem.get(Number(span.dataset.itemIndex));
    if (!startSeg) return convertPdfTextToOverlay(page, span, paper);
    const para = detectParagraph(model, startSeg);
    const items = para.lines.flatMap(line => line.items);
    if (items.some(item => isTextItemConverted(page, item.index))) return convertPdfTextToOverlay(page, span, paper);

    const source = sourceCanvases.get(paper) || $('.pdf-canvas', paper);
    const ratio = source.width / page.width;
    const box = { x: para.left, y: para.top, w: para.right - para.left, h: para.bottom - para.top };
    const colors = sampleParagraphColors(source, ratio, box);
    const cut = computeReflowCut(model, para, source, ratio, page);
    const baseFont = dominantFont(para);
    const fs = para.fs;
    const justify = para.lines.length >= 2 && para.lines.slice(0, -1).every(line => para.colRight - line.right <= 0.6 * fs);

    pushHistory();
    const element = createTextElement(page, {
      x: para.left,
      y: para.top,
      w: para.colRight - para.left + 1,
      h: box.h,
      html: paragraphHtml(para, baseFont),
      fontSize: Math.round(fs * 100) / 100,
      fontFamily: baseFont.css,
      fontWeight: baseFont.bold ? '700' : '400',
      fontStyle: baseFont.italic ? 'italic' : 'normal',
      color: colors.text,
      background: 'transparent',
      lineHeight: Math.round((para.pitch / fs) * 1000) / 1000,
      textAlign: justify ? 'justify' : 'left'
    });
    element.style.paddingLeft = Math.max(0, para.bodyLeft - para.left);
    element.style.textIndent = para.firstLeft - para.bodyLeft;
    element.reflow = {
      items: items.map(item => item.index),
      box,
      lines: para.lines.length,
      cut: cut.cut,
      x0: cut.x0,
      x1: cut.x1,
      free: cut.free,
      bg: colors.bg,
      margin: clamp(model.minLeft, 30, 110),
      baseH: box.h,
      pushed: 0
    };

    pendingReflow.add(element.id);
    page.elements.push(element);
    const node = renderElement(page, element);
    node.style.visibility = 'hidden';
    $('.overlay-layer', paper).append(node);
    try {
      await loadElementFonts(element.style);
      const body = $('.element-body', node);
      const count = calibrateLetterSpacing(element, node, body, para.lines.length);
      // Alinha a primeira linha de base da caixa com a do texto original.
      const marker = document.createElement('span');
      marker.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline';
      body.prepend(marker);
      const baselineOffset = marker.offsetTop;
      marker.remove();
      const firstBaseline = para.lines[0].baseline;
      element.y = firstBaseline + reflowOffsetAt(buildReflowOps(page), para.left, firstBaseline) - baselineOffset;
      applyElementGeometry(node, element);
      element.h = node.offsetHeight;
      element.reflow.baseH = count === para.lines.length ? element.h : para.lines.length * element.style.fontSize * element.style.lineHeight;
    } finally {
      pendingReflow.delete(element.id);
      node.style.visibility = '';
    }

    items.forEach(item => $(`.text-layer span[data-item-index="${item.index}"]`, paper)?.classList.add('converted'));
    updateReflowElement(page, element, node);
    composeReflowNow(page);
    selectElement(page.id, element.id, false);
    const body = $('.element-body', node);
    body.focus();
    const range = event && document.caretRangeFromPoint?.(event.clientX, event.clientY);
    if (range && body.contains(range.startContainer)) {
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }
    scheduleSessionSave();
    showToast('Parágrafo editável: o restante da página se ajusta ao texto.');
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
    if (element.reflow) {
      node.classList.add('flow');
      observeReflowNode(node);
    }
    return node;
  }

  function applyElementGeometry(node, element) {
    node.style.left = `${element.x}px`;
    node.style.top = `${element.y}px`;
    node.style.width = `${element.w}px`;
    node.style.height = element.reflow ? 'auto' : `${element.h}px`;
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
    body.style.letterSpacing = style.letterSpacing ? `${style.letterSpacing}px` : '';
    body.style.textIndent = style.textIndent ? `${style.textIndent}px` : '';
    body.style.paddingLeft = style.paddingLeft ? `${style.paddingLeft}px` : '';
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
      if (!op.element.reflow) op.element.h = clamp(op.h + dy, 12, op.page.height - op.element.y);
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
    const node = $(`.editor-element[data-element-id="${CSS.escape(element.id)}"]`);
    if (element.reflow) {
      // O texto original volta e o conteúdo empurrado retorna ao lugar.
      const before = groupPush(page, element.reflow);
      element.reflow.pushed = 0;
      shiftElementsBelow(page, element, groupPush(page, element.reflow) - before);
      if (node) reflowObserver?.unobserve(node);
    }
    page.elements = page.elements.filter(item => item.id !== element.id);
    const restored = element.reflow ? element.reflow.items : element.sourceTextItem != null ? [element.sourceTextItem] : [];
    restored.forEach(index => {
      $(`#paper-${CSS.escape(page.id)} .text-layer span[data-item-index="${CSS.escape(String(index))}"]`)?.classList.remove('converted');
    });
    node?.remove();
    if (element.reflow) composeReflowNow(page);
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
    // A cópia é uma caixa de texto comum: não cobre nem empurra o texto original.
    delete clone.reflow;
    delete clone.sourceTextItem;
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
    if (!element.reflow) element.h = clamp(Number($('#elementH').value || 12), 12, page.height - element.y);
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
    sourceCanvases.delete(paper);
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
      exportPixelRatio = renderScale;
      const jpegQuality = count <= 30 ? .92 : .86;
      const { jsPDF } = window.jspdf;
      let output = null;

      for (let i = 0; i < state.pages.length; i++) {
        const page = state.pages[i];
        const paper = $(`#paper-${CSS.escape(page.id)}`);
        const wasRendered = page.type !== 'pdf' || paper?.dataset.rendered === '1';
        const ratioBefore = paper?.dataset.pixelRatio;
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
        // Páginas redesenhadas em alta resolução só para a exportação são liberadas; as próximas da tela voltam a ser desenhadas depois.
        const ratioChanged = paper?.dataset.pixelRatio !== ratioBefore;
        if (page.type === 'pdf' && (!wasRendered || ratioChanged) && page.id !== previousPage) releasePdfPageRender(page.id);
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
      exportPixelRatio = 1;
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
<style>${await snapshotFontCss()}${snapshotCss()}</style>
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
      const bodyStyle = `font-family:${(style.fontFamily || 'Arial, sans-serif').replace(/"/g, "'")};font-size:${style.fontSize || 12}px;font-weight:${style.fontWeight || 400};font-style:${style.fontStyle || 'normal'};text-decoration:${style.textDecoration || 'none'};text-align:${style.textAlign || 'left'};color:${style.color || '#111'};background:${style.background || 'transparent'};line-height:${style.lineHeight || 1.2}`
        + (style.letterSpacing ? `;letter-spacing:${style.letterSpacing}px` : '')
        + (style.textIndent ? `;text-indent:${style.textIndent}px` : '')
        + (element.reflow ? `;padding-left:${style.paddingLeft || 0}px` : '');
      const className = element.reflow ? 'snapshot-element snapshot-text snapshot-flow' : 'snapshot-element snapshot-text';
      return `<div class="${className}" style="${common};${bodyStyle}">${sanitizeUserHtml(element.html || '')}</div>`;
    }
    if (element.type === 'image') {
      return `<img class="snapshot-element snapshot-image" style="${common}" src="${element.src}" alt="${escapeHtml(element.alt || '')}">`;
    }
    return `<div class="snapshot-element" style="${common};background:${element.fill || '#fff'};border:${element.border || 'none'};border-radius:${element.radius || 0}px"></div>`;
  }

  const BUNDLED_FONTS = [
    ['DejaVu Sans', 400, 'normal', 'DejaVuSans'], ['DejaVu Sans', 700, 'normal', 'DejaVuSans-Bold'],
    ['DejaVu Sans', 400, 'italic', 'DejaVuSans-Oblique'], ['DejaVu Sans', 700, 'italic', 'DejaVuSans-BoldOblique'],
    ['DejaVu Serif', 400, 'normal', 'DejaVuSerif'], ['DejaVu Serif', 700, 'normal', 'DejaVuSerif-Bold'],
    ['DejaVu Serif', 400, 'italic', 'DejaVuSerif-Italic'], ['DejaVu Serif', 700, 'italic', 'DejaVuSerif-BoldItalic']
  ];

  // O HTML exportado é um arquivo único: embute as fontes incluídas que os textos usam.
  async function snapshotFontCss() {
    const used = JSON.stringify(state.pages.map(page => (page.elements || []).filter(element => element.type === 'text')));
    const faces = await Promise.all(BUNDLED_FONTS.filter(([family]) => used.includes(family)).map(async ([family, weight, style, file]) => {
      try {
        const response = await fetch(`vendor/fonts/${file}.woff2`);
        if (!response.ok) return '';
        const base64 = arrayBufferToBase64(await response.arrayBuffer());
        return `@font-face{font-family:"${family}";src:url(data:font/woff2;base64,${base64}) format("woff2");font-weight:${weight};font-style:${style}}`;
      } catch (error) {
        return '';
      }
    }));
    return faces.join('');
  }

  function snapshotCss() {
    return `
*{box-sizing:border-box}html,body{margin:0;background:#4a4d53;font-family:Arial,sans-serif}.print-button{position:fixed;z-index:9999;right:18px;top:18px;padding:10px 14px;border:0;border-radius:8px;background:#1f56d8;color:#fff;font:600 14px Arial;cursor:pointer;box-shadow:0 5px 18px #0005}.document{display:flex;flex-direction:column;align-items:center;gap:24px;padding:30px}.page{position:relative;flex:none;overflow:hidden;background:#fff;box-shadow:0 9px 30px #0006}.page-background{position:absolute;inset:0;width:100%;height:100%;object-fit:fill}.searchable-text{position:absolute;inset:0;overflow:hidden;line-height:1}.searchable-text span{position:absolute;transform-origin:0 0;white-space:pre;color:transparent;user-select:text}.flow-content{position:absolute;overflow:hidden;font:16px Arial,sans-serif;color:#111}.flow-content p{margin:0 0 .72em}.flow-content h1{margin:0 0 .6em;font-size:2em;line-height:1.15}.flow-content h2{margin:0 0 .6em;font-size:1.5em;line-height:1.2}.flow-content h3{margin:0 0 .6em;font-size:1.2em;line-height:1.25}.overlays{position:absolute;inset:0;overflow:hidden}.snapshot-element{position:absolute;transform-origin:center}.snapshot-text{padding:2px 3px;overflow:hidden;white-space:pre-wrap;word-break:break-word}.snapshot-text.snapshot-flow{padding-top:0;padding-right:0;padding-bottom:0;overflow:visible;white-space:normal;word-break:normal;overflow-wrap:break-word}.snapshot-image{object-fit:contain}@media print{@page{margin:0}html,body{background:#fff}.print-button{display:none}.document{display:block;padding:0}.page{box-shadow:none;break-after:page;page-break-after:always;margin:0}}
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

    // O zoom do navegador e a troca de monitor mudam o devicePixelRatio.
    window.addEventListener('resize', schedulePdfRerender);

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
