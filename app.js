/* --- STATE MANAGEMENT --- */
const DEFAULT_STATE = {
    shape: 'square',
    length: 2, // 1: Short, 2: Med, 3: Long
    color: '#eec4c4',
    finish: 'glossy',
    pattern: 'solid',
    accentEnabled: false,
    accentIndex: 1, // default ring finger (DOM order: pinky0 ring1 middle2 index3 thumb4)

    accentColor: '#ffffff',
    nailTexture: null, // dataURL for uploaded nail texture
    tryOnEnabled: false,
    tryOnPhoto: null, // dataURL
    tryOnEdit: true,
    tryOnPositions: null,

    extType: 'gel',
    addons: []
};

let currentBuild = { ...DEFAULT_STATE };

/* --- AUTO ALIGN (MediaPipe Hands) --- */
let mpHands = null;
let mpDetectResolve = null;

function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }

function drawImageCover(ctx, img, canvasW, canvasH) {
    // Match CSS object-fit: cover used by .tryon-photo
    const iw = img.naturalWidth || img.width;
    const ih = img.naturalHeight || img.height;
    if (!iw || !ih) return;

    const scale = Math.max(canvasW / iw, canvasH / ih);
    const sw = canvasW / scale;
    const sh = canvasH / scale;
    const sx = (iw - sw) / 2;
    const sy = (ih - sh) / 2;

    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvasW, canvasH);
}

async function ensureMediaPipeHands() {
    if (mpHands) return mpHands;
    if (typeof Hands === 'undefined') return null;

    mpHands = new Hands({
        locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`
    });

    // MediaPipe docs mention `static_image_mode`; in JS this is `staticImageMode`.
    mpHands.setOptions({
        staticImageMode: true,
        maxNumHands: 1,
        modelComplexity: 1,
        minDetectionConfidence: 0.5,
        minTrackingConfidence: 0.5
    });

    mpHands.onResults((results) => {
        if (mpDetectResolve) {
            mpDetectResolve(results);
            mpDetectResolve = null;
        }
    });

    return mpHands;
}

async function detectHandOnCanvas(canvas) {
    const hands = await ensureMediaPipeHands();
    if (!hands) return null;
    return new Promise(async (resolve) => {
        mpDetectResolve = resolve;
        await hands.send({ image: canvas });
    });
}

async function autoAlignNails() {
    if (!currentBuild.tryOnEnabled) {
        showToast('Enable Try-on first.');
        return;
    }
    if (!dom.tryOnPhotoEl || dom.tryOnPhotoEl.classList.contains('hidden') || !dom.tryOnPhotoEl.src) {
        showToast('Upload a hand photo first.');
        return;
    }
    if (!dom.handContainer) return;

    const rect = dom.handContainer.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));

    // Build a canvas that matches the rendered (cropped) photo
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    drawImageCover(ctx, dom.tryOnPhotoEl, w, h);

    const results = await detectHandOnCanvas(canvas);
    if (!results || !results.multiHandLandmarks || results.multiHandLandmarks.length === 0) {
        showToast('No hand detected. Use a clear, straight-on photo with visible nails.');
        return;
    }

    const lm = results.multiHandLandmarks[0];
    const p = (i) => ({ x: lm[i].x * w, y: lm[i].y * h });

    // MediaPipe landmark indices (tip, DIP/IP)
    const map = {
        'nail-thumb':  [4, 3],
        'nail-index':  [8, 7],
        'nail-middle': [12, 11],
        'nail-ring':   [16, 15],
        'nail-pinky':  [20, 19]
    };

    const positions = {};
    dom.nails.forEach((nail) => {
        const pair = map[nail.id];
        if (!pair) return;

        const tip = p(pair[0]);
        const baseJ = p(pair[1]);

        const vx = tip.x - baseJ.x;
        const vy = tip.y - baseJ.y;

        // Convert finger direction into CSS rotation (0° = up)
        const angle = (Math.atan2(vy, vx) * 180 / Math.PI) + 90;

        const fingerLen = Math.hypot(vx, vy);

        // Anchor around the cuticle region (between DIP/IP and tip)
        const t = 0.62;
        const anchor = {
            x: tip.x + (baseJ.x - tip.x) * t,
            y: tip.y + (baseJ.y - tip.y) * t
        };

        // Use current rendered nail size (depends on your length slider/shape)
        const nailRect = nail.getBoundingClientRect();
        const nw = Math.max(1, nailRect.width);
        const nh = Math.max(1, nailRect.height);

        // Scale so the nail roughly matches the finger segment length
        const desiredH = fingerLen * 0.95;
        const scale = clamp(desiredH / nh, 0.75, 1.90);

        // Position the nail so its bottom-center sits on the anchor point.
        // Because transform-origin is bottom center, this behaves nicely with rotation.
        const leftPct = ((anchor.x - (nw / 2)) / w) * 100;
        const topPct = ((anchor.y - nh) / h) * 100;

        positions[nail.id] = {
            left: clamp(leftPct, 0, 100),
            top: clamp(topPct, 0, 100),
            transform: `rotate(${angle.toFixed(1)}deg) scale(${scale.toFixed(2)})`
        };
    });

    applyNailPositions(positions);
    currentBuild.tryOnPositions = positions;
    persistTryOnPositions();

    showToast('Auto-aligned nails. You can still fine-tune with drag.');
}


// Config for visual rendering
const LENGTH_MAP = {
    1: { height: '10%', topMod: 2 }, 
    2: { height: '13%', topMod: 0 },
    3: { height: '17%', topMod: -2 }
};

const SHAPE_STYLES = {
    square: { radius: '2px', clip: 'none' },
    almond: { radius: '50% 50% 50% 50% / 90% 90% 40% 40%', clip: 'none' },
    stiletto: { radius: '50% 50% 50% 50% / 100% 100% 40% 40%', clip: 'none' },
    coffin: { radius: '0', clip: 'polygon(15% 0%, 85% 0%, 100% 100%, 0% 100%)' }
};

const FINISH_STYLES = {
    glossy: 'linear-gradient(135deg, rgba(255,255,255,0.4) 0%, rgba(255,255,255,0) 50%)',
    matte: 'none', // Apply via filter in render
    chrome: 'linear-gradient(45deg, rgba(255,255,255,0.6) 0%, rgba(255,255,255,0) 40%, rgba(255,255,255,0.4) 100%)'
};

const PATTERNS = {
    solid: 'none',
    french: 'linear-gradient(to bottom, white 25%, transparent 25%)', // Simple french mockup
    ombre: 'linear-gradient(to top, white 0%, transparent 70%)',
    marble: 'radial-gradient(circle at 50% 50%, rgba(255,255,255,0.4), transparent)'
};

// Pricing Config
const PRICING = {
    base: 40,
    length: [0, 5, 10], // Short, Med, Long
    extType: { gel: 0, acrylic: 5, polygel: 10 },
    finish: { glossy: 0, matte: 5, chrome: 10 },
    pattern: { solid: 0, french: 15, ombre: 15, marble: 20 },
    accent: 5
};

const SWATCHES = [
    '#eec4c4', '#dba39a', '#b07d62', '#8d5524', '#f0e68c', 
    '#ff6f61', '#6b5b95', '#88b04b', '#92a8d1', '#955251', 
    '#34568b', '#000000'
];

const PRESETS = [
    { name: "Classic Nude", shape: "almond", length: 2, color: "#eec4c4", finish: "glossy", pattern: "solid", vibe: "Minimal" },
    { name: "Vampy Red", shape: "stiletto", length: 3, color: "#955251", finish: "glossy", pattern: "solid", vibe: "Glam" },
    { name: "Bridal French", shape: "coffin", length: 2, color: "#f0e68c", finish: "matte", pattern: "french", vibe: "Minimal" },
    { name: "Chrome Future", shape: "square", length: 3, color: "#92a8d1", finish: "chrome", pattern: "solid", vibe: "Party" }
];

/* --- DOM ELEMENTS --- */
const dom = {
    nails: document.querySelectorAll('.nail-layer'),
    swatchContainer: document.getElementById('color-swatches'),
    customColor: document.getElementById('custom-color'),
    shapeInputs: document.querySelectorAll('input[name="shape"]'),
    lengthSlider: document.getElementById('length-slider'),
    finishBtns: document.querySelectorAll('.toggle-btn[data-finish]'),
    patternSelect: document.getElementById('pattern-select'),
    accentToggle: document.getElementById('accent-toggle'),
    accentControls: document.getElementById('accent-controls'),
    accentColor: document.getElementById('accent-color'),
    priceEl: document.getElementById('total-price'),
    timeEl: document.getElementById('total-time'),
    breakdownEl: document.getElementById('price-breakdown'),
    resetBtn: document.getElementById('reset-btn'),
    saveBtn: document.getElementById('save-look-btn'),
    modal: document.getElementById('save-modal'),
    saveConfirmBtn: document.getElementById('confirm-save-btn'),
    saveNameInput: document.getElementById('save-name-input'),
    wishlistGrid: document.getElementById('wishlist-grid'),
    libraryGrid: document.getElementById('library-grid'),
    extTypeSelect: document.getElementById('ext-type'),
    addonChecks: document.querySelectorAll('.addon-check'),
    toast: document.getElementById('toast'),
nailTextureUpload: document.getElementById('nail-texture-upload'),
    clearNailTexture: document.getElementById('clear-nail-texture'),
    handContainer: document.getElementById('hand-container'),
    handSvg: document.getElementById('hand-svg'),
    tryOnPhotoEl: document.getElementById('tryon-photo'),
    tryOnToggle: document.getElementById('tryon-toggle'),
    tryOnControls: document.getElementById('tryon-controls'),
    tryOnUpload: document.getElementById('tryon-upload'),
    tryOnClear: document.getElementById('tryon-clear'),
    tryOnEdit: document.getElementById('tryon-edit'),
    tryOnAutoAlign: document.getElementById('tryon-auto-align'),
    tryOnResetAlignment: document.getElementById('tryon-reset-alignment')
};

/* --- INITIALIZATION --- */
function init() {
    generateSwatches();
    generateLibrary();
    loadWishlist();
    attachListeners();
    enableNailDragging();
    restoreTryOnFromStorage();

    // When the try-on photo finishes loading, optionally auto-align nails.
    if (dom.tryOnPhotoEl) {
        dom.tryOnPhotoEl.addEventListener('load', () => {
            if (currentBuild.tryOnEnabled) autoAlignNails();
        });
    }
    renderBuild();
    calculatePrice();
    setPhotoMode(!!currentBuild.tryOnEnabled);
}

/* --- LOGIC & RENDERING --- */

function updateState(key, value) {
    currentBuild[key] = value;
    renderBuild();
    calculatePrice();
}

function renderBuild() {
    // 1. Get visual properties
    const shapeStyle = SHAPE_STYLES[currentBuild.shape];
    const lenData = LENGTH_MAP[currentBuild.length];
    const finishOverlay = FINISH_STYLES[currentBuild.finish];
    const patternOverlay = PATTERNS[currentBuild.pattern];
    
    // 2. Loop through all nails
    dom.nails.forEach((nail, index) => {
        // Check if this is the accent nail (Ring finger is index 1 in DOM order usually, let's map it)
        // DOM order: pinky(0), ring(1), middle(2), index(3), thumb(4)
        const isAccent = currentBuild.accentEnabled && index === (currentBuild.accentIndex ?? 1); 

        // Apply Color
        nail.style.backgroundColor = isAccent ? currentBuild.accentColor : currentBuild.color;

        // Apply Length
        nail.style.height = lenData.height;
        // Adjust top slightly for length illusion if needed (simple implementation)
        const currentTop = parseFloat(nail.style.top) || 0; // Keeping simplistic for now

        // Apply Shape
        nail.style.borderRadius = shapeStyle.radius;
        nail.style.clipPath = shapeStyle.clip;

        
        // Apply Finish & Pattern / Photo Texture
        // Layer order: Finish overlay (top) -> pattern OR uploaded texture (bottom)
        const layers = [];
        if (finishOverlay !== 'none') layers.push(finishOverlay);

        if (currentBuild.nailTexture) {
            layers.push(`url(${currentBuild.nailTexture})`);
            nail.style.backgroundSize = 'cover';
            nail.style.backgroundPosition = 'center';
            nail.style.backgroundRepeat = 'no-repeat';
        } else if (patternOverlay !== 'none') {
            layers.push(patternOverlay);
            nail.style.backgroundSize = '';
            nail.style.backgroundPosition = '';
            nail.style.backgroundRepeat = '';
        } else {
            nail.style.backgroundSize = '';
            nail.style.backgroundPosition = '';
            nail.style.backgroundRepeat = '';
        }

        nail.style.backgroundImage = layers.join(', ');
            // Matte logic
        if(currentBuild.finish === 'matte') {
            nail.style.filter = 'contrast(0.9) brightness(1.05)';
            nail.style.boxShadow = 'none';
        } else {
            nail.style.filter = 'none';
            nail.style.boxShadow = '0 1px 2px rgba(0,0,0,0.2)';
        }
    });

    // UI State Sync (for when presets are applied)
    syncControls();
}

function syncControls() {
    // Update inputs to match state (needed when loading presets)
    document.querySelector(`input[name="shape"][value="${currentBuild.shape}"]`).checked = true;
    dom.lengthSlider.value = currentBuild.length;
    dom.customColor.value = currentBuild.color;
    
    dom.finishBtns.forEach(btn => {
        btn.classList.toggle('active', btn.dataset.finish === currentBuild.finish);
    });
    
    dom.patternSelect.value = currentBuild.pattern;
    dom.accentToggle.checked = currentBuild.accentEnabled;
    dom.accentControls.classList.toggle('hidden', !currentBuild.accentEnabled);
    dom.accentColor.value = currentBuild.accentColor;

    // Try-on controls
    if (dom.tryOnToggle) {
        dom.tryOnToggle.checked = !!currentBuild.tryOnEnabled;
        if (dom.tryOnControls) dom.tryOnControls.classList.toggle('hidden', !currentBuild.tryOnEnabled);
        if (dom.tryOnEdit) dom.tryOnEdit.checked = !!currentBuild.tryOnEdit;
    }

}

function calculatePrice() {
    let total = PRICING.base;
    let time = 60; // Base minutes

    // Inputs
    total += PRICING.length[currentBuild.length - 1];
    total += PRICING.extType[currentBuild.extType];
    total += PRICING.finish[currentBuild.finish];
    total += PRICING.pattern[currentBuild.pattern];
    if(currentBuild.accentEnabled) total += PRICING.accent;

    // Addons
    currentBuild.addons.forEach(addon => {
        total += parseInt(addon.price);
        time += 15;
    });

    // Time adjustments
    if(currentBuild.pattern !== 'solid') time += 15;
    if(currentBuild.length === 3) time += 15;

    // Render Price
    dom.priceEl.textContent = total;
    dom.timeEl.textContent = time;

    // Render Breakdown
    dom.breakdownEl.innerHTML = `
        <li><span>Base Set</span> <span>$${PRICING.base}</span></li>
        <li><span>Length/Shape</span> <span>+$${PRICING.length[currentBuild.length-1]}</span></li>
        ${currentBuild.finish !== 'glossy' ? `<li><span>${currentBuild.finish} Finish</span> <span>+$${PRICING.finish[currentBuild.finish]}</span></li>` : ''}
        ${currentBuild.pattern !== 'solid' ? `<li><span>Art Design</span> <span>+$${PRICING.pattern[currentBuild.pattern]}</span></li>` : ''}
        ${currentBuild.addons.length > 0 ? `<li><span>Add-ons</span> <span>+$${currentBuild.addons.reduce((a,b)=>a+parseInt(b.price),0)}</span></li>` : ''}
    `;
}

/* --- EVENT LISTENERS --- */

/* --- TRY ON ME (PHOTO MODE) --- */
let baseNailLayout = null; // { id: {left, top, transform} }
let isDraggingNail = false;
let dragTarget = null;
let dragStart = null;

function captureBaseNailLayout() {
    if (baseNailLayout) return;
    baseNailLayout = {};
    dom.nails.forEach(nail => {
        const id = nail.id || '';
        const left = parseFloat(nail.style.left || '0');
        const top = parseFloat(nail.style.top || '0');
        const transform = nail.style.transform || '';
        baseNailLayout[id] = { left, top, transform };
    });
}

function applyNailPositions(positions) {
    if (!positions) return;
    dom.nails.forEach(nail => {
        const id = nail.id || '';
        const pos = positions[id];
        if (!pos) return;
        nail.style.left = `${pos.left}%`;
        nail.style.top = `${pos.top}%`;
        if (typeof pos.transform === 'string') nail.style.transform = pos.transform;
    });
}

function resetNailPositions() {
    captureBaseNailLayout();
    applyNailPositions(baseNailLayout);
    currentBuild.tryOnPositions = null;
    localStorage.removeItem('nailstudio_tryon_positions');
}

function setPhotoMode(enabled) {
    currentBuild.tryOnEnabled = enabled;
    if (dom.tryOnControls) dom.tryOnControls.classList.toggle('hidden', !enabled);
    if (dom.handContainer) dom.handContainer.classList.toggle('photo-mode', enabled);

    const hasPhoto = !!currentBuild.tryOnPhoto;
    if (dom.tryOnPhotoEl) dom.tryOnPhotoEl.classList.toggle('hidden', !(enabled && hasPhoto));
    if (enabled && hasPhoto && dom.tryOnPhotoEl) dom.tryOnPhotoEl.src = currentBuild.tryOnPhoto;

    if (dom.handContainer) dom.handContainer.classList.toggle('align-mode', enabled && currentBuild.tryOnEdit);
}

function persistTryOnPositions() {
    if (!currentBuild.tryOnPositions) return;
    localStorage.setItem('nailstudio_tryon_positions', JSON.stringify(currentBuild.tryOnPositions));
}

function restoreTryOnFromStorage() {
    captureBaseNailLayout();
    try {
        const raw = localStorage.getItem('nailstudio_tryon_positions');
        if (!raw) return;
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
            currentBuild.tryOnPositions = parsed;
            applyNailPositions(parsed);
        }
    } catch (_) {}
}

function enableNailDragging() {
    captureBaseNailLayout();

    dom.nails.forEach((nail, index) => {
        if (!nail.hasAttribute('tabindex')) nail.setAttribute('tabindex', '0');

        nail.addEventListener('pointerdown', (e) => {
            if (!(currentBuild.tryOnEnabled && currentBuild.tryOnEdit)) return;
            isDraggingNail = true;
            dragTarget = nail;
            nail.setPointerCapture(e.pointerId);

            const rect = dom.handContainer.getBoundingClientRect();
            const leftPct = parseFloat(nail.style.left || '0');
            const topPct = parseFloat(nail.style.top || '0');

            dragStart = {
                startX: e.clientX,
                startY: e.clientY,
                rectW: rect.width,
                rectH: rect.height,
                startLeft: leftPct,
                startTop: topPct
            };
        });

        nail.addEventListener('pointermove', (e) => {
            if (!isDraggingNail || dragTarget !== nail || !dragStart) return;

            const dx = e.clientX - dragStart.startX;
            const dy = e.clientY - dragStart.startY;

            const dLeft = (dx / dragStart.rectW) * 100;
            const dTop = (dy / dragStart.rectH) * 100;

            const newLeft = Math.max(0, Math.min(100, dragStart.startLeft + dLeft));
            const newTop = Math.max(0, Math.min(100, dragStart.startTop + dTop));

            nail.style.left = `${newLeft}%`;
            nail.style.top = `${newTop}%`;

            if (!currentBuild.tryOnPositions) currentBuild.tryOnPositions = {};
            const id = nail.id || '';
            currentBuild.tryOnPositions[id] = {
                left: newLeft,
                top: newTop,
                transform: nail.style.transform || ''
            };
        });

        const endDrag = () => {
            if (!isDraggingNail || dragTarget !== nail) return;
            isDraggingNail = false;
            dragTarget = null;
            dragStart = null;
            persistTryOnPositions();
        };

        nail.addEventListener('pointerup', endDrag);
        nail.addEventListener('pointercancel', endDrag);

        // Accent selection when NOT editing alignment
        nail.addEventListener('click', () => {
            if (!currentBuild.accentEnabled) return;
            if (currentBuild.tryOnEnabled && currentBuild.tryOnEdit) return;
            updateState('accentIndex', index);
            showToast('Accent nail selected');
        });

        nail.addEventListener('keydown', (e) => {
            if (!currentBuild.accentEnabled) return;
            if (currentBuild.tryOnEnabled && currentBuild.tryOnEdit) return;
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                updateState('accentIndex', index);
                showToast('Accent nail selected');
            }
        });
    });
}

function attachListeners() {
    // Shape
    dom.shapeInputs.forEach(input => {
        input.addEventListener('change', (e) => updateState('shape', e.target.value));
    });

    // Length
    dom.lengthSlider.addEventListener('input', (e) => updateState('length', parseInt(e.target.value)));

    // Color
    dom.customColor.addEventListener('input', (e) => updateState('color', e.target.value));

    // Finish
    dom.finishBtns.forEach(btn => {
        btn.addEventListener('click', () => updateState('finish', btn.dataset.finish));
    });

    // Pattern
    dom.patternSelect.addEventListener('change', (e) => updateState('pattern', e.target.value));

    // Accent
    dom.accentToggle.addEventListener('change', (e) => {
        updateState('accentEnabled', e.target.checked);
        dom.accentControls.classList.toggle('hidden', !e.target.checked);
    });
    dom.accentColor.addEventListener('input', (e) => updateState('accentColor', e.target.value));

    // Nail texture upload (applies to nails)
    if (dom.nailTextureUpload) {
        dom.nailTextureUpload.addEventListener('change', (e) => {
            const file = e.target.files && e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = () => {
                currentBuild.nailTexture = reader.result;
                renderBuild();
                showToast('Nail texture applied');
            };
            reader.readAsDataURL(file);
        });
    }

    if (dom.clearNailTexture) {
        dom.clearNailTexture.addEventListener('click', () => {
            currentBuild.nailTexture = null;
            if (dom.nailTextureUpload) dom.nailTextureUpload.value = '';
            renderBuild();
            showToast('Nail texture cleared');
        });
    }

    // Try-on photo mode
    if (dom.tryOnToggle) {
        dom.tryOnToggle.addEventListener('change', (e) => {
            setPhotoMode(e.target.checked);
            if (e.target.checked) restoreTryOnFromStorage();
            showToast(e.target.checked ? 'Try-on enabled' : 'Try-on disabled');
        });
    }

    if (dom.tryOnUpload) {
        dom.tryOnUpload.addEventListener('change', (e) => {
            const file = e.target.files && e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = () => {
                currentBuild.tryOnPhoto = reader.result;
                if (dom.tryOnPhotoEl) {
                    dom.tryOnPhotoEl.src = currentBuild.tryOnPhoto;
                    dom.tryOnPhotoEl.classList.remove('hidden');
                }
                if (dom.tryOnToggle) dom.tryOnToggle.checked = true;
                setPhotoMode(true);
                showToast('Hand photo loaded');
            };
            reader.readAsDataURL(file);
        });
    }

    if (dom.tryOnClear) {
        dom.tryOnClear.addEventListener('click', () => {
            currentBuild.tryOnPhoto = null;
            if (dom.tryOnUpload) dom.tryOnUpload.value = '';
            if (dom.tryOnPhotoEl) {
                dom.tryOnPhotoEl.src = '';
                dom.tryOnPhotoEl.classList.add('hidden');
            }
            if (dom.tryOnToggle) dom.tryOnToggle.checked = false;
            setPhotoMode(false);
            showToast('Hand photo cleared');
        });
    }

    if (dom.tryOnEdit) {
        dom.tryOnEdit.addEventListener('change', (e) => {
            currentBuild.tryOnEdit = e.target.checked;
            if (dom.handContainer) dom.handContainer.classList.toggle('align-mode', currentBuild.tryOnEnabled && currentBuild.tryOnEdit);
            showToast(currentBuild.tryOnEdit ? 'Alignment edit enabled' : 'Alignment locked');
        });
    }

    if (dom.tryOnAutoAlign) {
        dom.tryOnAutoAlign.addEventListener('click', () => {
            autoAlignNails();
        });
    }

    if (dom.tryOnResetAlignment) {
        dom.tryOnResetAlignment.addEventListener('click', () => {
            resetNailPositions();
            showToast('Nail positions reset');
        });
    }


    // Pricing Factors
    dom.extTypeSelect.addEventListener('change', (e) => updateState('extType', e.target.value));
    dom.addonChecks.forEach(chk => {
        chk.addEventListener('change', () => {
            const activeAddons = Array.from(dom.addonChecks)
                .filter(c => c.checked)
                .map(c => ({ name: c.value, price: c.dataset.price }));
            updateState('addons', activeAddons);
        });
    });

    // Reset
    dom.resetBtn.addEventListener('click', () => {
        currentBuild = { ...DEFAULT_STATE };
        renderBuild();
        calculatePrice();
        showToast('Reset to default');
    });

    // Modal & Saving
    dom.saveBtn.addEventListener('click', () => {
        dom.modal.setAttribute('aria-hidden', 'false');
        dom.saveNameInput.focus();
    });
    
    dom.saveConfirmBtn.addEventListener('click', saveToWishlist);

    // Close Modal Delegator
    document.addEventListener('click', (e) => {
        if(e.target.dataset.close) {
            dom.modal.setAttribute('aria-hidden', 'true');
        }
    });

    // Booking Form (Prevent Submit)
    document.getElementById('booking-form').addEventListener('submit', (e) => {
        e.preventDefault();
        showToast('Booking Request Sent!');
        setTimeout(() => location.reload(), 2000);
    });

    // Accordion Logic
    document.querySelectorAll('.accordion-header').forEach(header => {
        header.addEventListener('click', () => {
            const item = header.parentElement;
            item.classList.toggle('active');
        });
    });
}

/* --- LIBRARY & PRESETS --- */
function generateSwatches() {
    SWATCHES.forEach(color => {
        const div = document.createElement('div');
        div.className = 'swatch';
        div.style.backgroundColor = color;
        div.addEventListener('click', () => {
            updateState('color', color);
            // Visual feedback
            document.querySelectorAll('.swatch').forEach(s => s.classList.remove('active'));
            div.classList.add('active');
        });
        dom.swatchContainer.appendChild(div);
    });
}

function generateLibrary() {
    dom.libraryGrid.innerHTML = '';
    PRESETS.forEach(preset => {
        const card = createCard(preset, 'library');
        dom.libraryGrid.appendChild(card);
    });
}

function applyPreset(preset) {
    currentBuild = { ...DEFAULT_STATE, ...preset };
    renderBuild();
    calculatePrice();
    location.href = '#builder';
    showToast(`Applied: ${preset.name}`);
}

/* --- WISHLIST & STORAGE --- */
function saveToWishlist() {
    const name = dom.saveNameInput.value.trim() || 'My Custom Look';
    const newItem = {
        id: Date.now(),
        name: name,
        config: { ...currentBuild },
        date: new Date().toLocaleDateString()
    };

    let wishlist = JSON.parse(localStorage.getItem('nailStudioWishlist') || '[]');
    wishlist.push(newItem);
    localStorage.setItem('nailStudioWishlist', JSON.stringify(wishlist));

    dom.modal.setAttribute('aria-hidden', 'true');
    dom.saveNameInput.value = '';
    loadWishlist();
    showToast('Look saved to Wishlist!');
}

function loadWishlist() {
    let wishlist = JSON.parse(localStorage.getItem('nailStudioWishlist') || '[]');
    dom.wishlistGrid.innerHTML = '';

    if(wishlist.length === 0) {
        dom.wishlistGrid.innerHTML = '<p>No saved looks yet.</p>';
        return;
    }

    wishlist.forEach(item => {
        const card = createCard({ ...item.config, name: item.name, id: item.id }, 'wishlist');
        dom.wishlistGrid.appendChild(card);
    });
}

function removeFromWishlist(id) {
    let wishlist = JSON.parse(localStorage.getItem('nailStudioWishlist') || '[]');
    wishlist = wishlist.filter(item => item.id !== id);
    localStorage.setItem('nailStudioWishlist', JSON.stringify(wishlist));
    loadWishlist();
}

/* --- UI HELPERS --- */
function createCard(data, type) {
    // Generate a mini CSS preview for the thumbnail
    const shapeStyle = SHAPE_STYLES[data.shape];
    
    const div = document.createElement('div');
    div.className = 'design-card';
    div.innerHTML = `
        <div class="card-preview">
            <div class="mini-nail" style="
                background-color: ${data.color};
                border-radius: ${shapeStyle.radius};
                ${data.shape === 'coffin' ? `clip-path: ${shapeStyle.clip};` : ''}
            "></div>
        </div>
        <div class="card-body">
            <h4>${data.name}</h4>
            <div class="card-tags">
                <span>${data.shape}</span>
                <span>${data.length === 1 ? 'Short' : data.length === 2 ? 'Med' : 'Long'}</span>
            </div>
            <div class="card-actions">
                <button class="btn-sm btn-outline" onclick='window.app.apply(${JSON.stringify(data)})'>Apply</button>
                ${type === 'wishlist' 
                    ? `<button class="btn-sm btn-text" onclick="window.app.remove(${data.id})">Remove</button>` 
                    : ''}
            </div>
        </div>
    `;
    return div;
}

function showToast(msg) {
    dom.toast.textContent = msg;
    dom.toast.classList.remove('hidden');
    setTimeout(() => {
        dom.toast.classList.add('hidden');
    }, 3000);
}

// Expose necessary functions to window for inline onclick handlers in generated HTML
window.app = {
    apply: (data) => {
        // Remove ID if present to avoid confusion
        const { id, ...config } = data;
        applyPreset(config);
    },
    remove: removeFromWishlist
};

// Run
document.addEventListener('DOMContentLoaded', init);