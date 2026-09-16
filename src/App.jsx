import React, { useState, useEffect, useRef, useCallback } from 'react';
import Sidebar from './components/Sidebar';
import Login from './components/Login';
import DesignCanvas from './components/DesignCanvas';
import ControlPanel from './components/ControlPanel';
import MockupPreview from './components/MockupPreview';
import MultiSizePreview from './components/MultiSizePreview';
import ContrastChecker from './components/ContrastChecker';
import QADefectAnalysis from './components/QADefectAnalysis';
import BGRemover from './components/BGRemover';
import GarmentManager from './components/GarmentManager';
import GangSheet from './components/GangSheet';
import AIArtworkLab from './components/AIArtworkLab';
import UserManagement from './components/UserManagement';
import GarmentTypes from './components/GarmentTypes';
import BatchProcessor from './components/BatchProcessor';
import MockupEngineV2 from './components/MockupEngineV2';
import Vault from './components/Vault';
import Gallery from './components/Gallery';
import TaskManager from './components/TaskManager';
import GangSheetCalculator from './components/GangSheetCalculator';
import GangSheetOptimizer from './components/GangSheetOptimizer';
import LayerPanel from './components/LayerPanel';
import { TSHIRT_SIZES, TSHIRT_COLORS, SIZE_ORDER } from './constants/tshirtSizes';
import { GARMENTS_API, SERVE_IMAGE_URL, detectApiBase, getGarmentsUrl, getServeImageUrl } from './utils/apiConfig';
import './App.css';

function App() {
  // ─── AUTH STATE ─────────────────────────────────────────────────────────────
  const [authUser, setAuthUser] = useState(null);
  const [authToken, setAuthToken] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  // True once the server (not the cache) has confirmed who this is and what they
  // may open. The landing redirect waits for it, so a stale cached page list
  // cannot bounce someone off the page they were meant to start on.
  const [authVerified, setAuthVerified] = useState(false);

  // ─── APP STATE (must be declared before any early returns — React hooks rule) ──
  // The vault is where a job starts — pick the customer's file first, then take
  // it to a tool. Opening on an empty editor made that the second step.
  const [currentPage, setCurrentPage] = useState('vault');
  const [sharedArtwork, setSharedArtwork] = useState(null);
  const [artwork, setArtwork] = useState(null);
  const [artworkFile, setArtworkFile] = useState(null);
  const [selectedSize, setSelectedSize] = useState('L');
  const [selectedColor, setSelectedColor] = useState(TSHIRT_COLORS[0]);
  const [artworkDimensions, setArtworkDimensions] = useState({ width: 10.75, height: 10.75 });
  const [lockProportion, setLockProportion] = useState(true);
  const [viewSide, setViewSide] = useState('front');
  const [artworkPosition, setArtworkPosition] = useState({ x: 0, y: 0 });
  const artworkScale = 1;
  const [artworkAreaSettings, setArtworkAreaSettings] = useState({ width: 18, height: 24, topOffset: 7 });
  const [selectedMockupSizes, setSelectedMockupSizes] = useState(
    SIZE_ORDER.reduce((acc, size) => ({ ...acc, [size]: false }), {})
  );
  const [showMockups, setShowMockups] = useState(false);
  const [customGarment, setCustomGarment] = useState(null);
  const [garmentLibrary, setGarmentLibrary] = useState([]);
  const [selectedGarmentId, setSelectedGarmentId] = useState(null);
  const [comparisonSizes, setComparisonSizes] = useState(['L']);
  const [scalingMode, setScalingMode] = useState('proportional');
  const [studioToken, setStudioToken] = useState(null);
  const [studioFileName, setStudioFileName] = useState('artwork.png');
  const [studioSaving, setStudioSaving] = useState(false);
  // PNG ya JPG. PNG default hai kyunke mockup aur gang sheet dono me shafaaf
  // hissa kaam ka hota hai; JPG tab chahiye jab file chhoti chahiye.
  const [saveFormat, setSaveFormat] = useState('png');
  const [studioMessage, setStudioMessage] = useState('');
  // Ek mockup ya gang sheet apne aap me kuch nahi hai — wo kisi design ka
  // marhala hai, aur naam usi design se aata hai (AW-<CODE>-<NNNN>-MU01).
  // Jab kaam Vault se shuru hua ho to design pehle se maloom hota hai; warna
  // save ke waqt poocha jata hai, kyunke us se pehle poochhne ka matlab hota
  // har us designer ko rokna jo sirf kuch aazma raha hai.
  const [pickOpen, setPickOpen] = useState(false);
  const [pickCustomers, setPickCustomers] = useState([]);
  const [pickCustomer, setPickCustomer] = useState('');
  const [pickDesigns, setPickDesigns] = useState([]);
  const [pickDesign, setPickDesign] = useState('');
  const [pickFilter, setPickFilter] = useState('');
  const [pickBusy, setPickBusy] = useState('');

  // Vault selection on its way to a new task, and the artwork a task is
  // currently checking back out of the vault into the editor.
  const [pendingTaskArtworks, setPendingTaskArtworks] = useState(null);
  const [openingTaskArtwork, setOpeningTaskArtwork] = useState('');

  // ─── MULTI-LAYER STATE ──────────────────────────────────────────────────────
  // When multiLayerEnabled is false, the existing artwork/artworkDimensions/
  // artworkPosition state drives everything as before (single-layer mode).
  // When enabled, layers[] array takes over — each layer has its own artwork,
  // dimensions, and position. The active layer's state is synced back to the
  // original state variables so ControlPanel/DesignCanvas work without changes.
  const [multiLayerEnabled, setMultiLayerEnabled] = useState(false);
  const [layers, setLayers] = useState([]);
  const [activeLayerId, setActiveLayerId] = useState(null);

  const createLayer = useCallback((layerArtwork = null, layerDimensions = null, layerPosition = null, name = null) => {
    const id = `layer-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    return {
      id,
      name: name || `Layer ${layers.length + 1}`,
      artwork: layerArtwork,
      artworkDimensions: layerDimensions || { width: 10.75, height: 10.75 },
      artworkPosition: layerPosition || { x: 0, y: 0 },
      lockProportion: true,
      visible: true,
      opacity: 1,
    };
  }, [layers.length]);

  const enableMultiLayer = useCallback(() => {
    if (multiLayerEnabled) return;
    // Initialize with the current single artwork as layer 1
    const firstLayer = {
      id: `layer-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      name: 'Layer 1',
      artwork: artwork,
      artworkDimensions: { ...artworkDimensions },
      artworkPosition: { ...artworkPosition },
      lockProportion: lockProportion,
      visible: true,
      opacity: 1,
    };
    setLayers([firstLayer]);
    setActiveLayerId(firstLayer.id);
    setMultiLayerEnabled(true);
  }, [multiLayerEnabled, artwork, artworkDimensions, artworkPosition, lockProportion]);

  const disableMultiLayer = useCallback(() => {
    // Revert to single-layer: take the active layer's state back to the main state
    if (layers.length > 0) {
      const active = layers.find(l => l.id === activeLayerId) || layers[0];
      setArtwork(active.artwork);
      setArtworkDimensions(active.artworkDimensions);
      setArtworkPosition(active.artworkPosition);
      setLockProportion(active.lockProportion);
    }
    setMultiLayerEnabled(false);
    setLayers([]);
    setActiveLayerId(null);
  }, [layers, activeLayerId]);

  const addLayer = useCallback(() => {
    const newLayer = createLayer();
    setLayers(prev => [...prev, newLayer]);
    setActiveLayerId(newLayer.id);
    // Sync main state to the new (empty) layer
    setArtwork(null);
    setArtworkDimensions({ width: 10.75, height: 10.75 });
    setArtworkPosition({ x: 0, y: 0 });
    setLockProportion(true);
  }, [createLayer]);

  const removeLayer = useCallback((layerId) => {
    setLayers(prev => {
      const updated = prev.filter(l => l.id !== layerId);
      if (updated.length === 0) {
        // Last layer removed — disable multi-layer
        setMultiLayerEnabled(false);
        setActiveLayerId(null);
        setArtwork(null);
        setArtworkDimensions({ width: 10.75, height: 10.75 });
        setArtworkPosition({ x: 0, y: 0 });
        return [];
      }
      // If the removed layer was active, switch to the first remaining
      if (layerId === activeLayerId) {
        const newActive = updated[0];
        setActiveLayerId(newActive.id);
        setArtwork(newActive.artwork);
        setArtworkDimensions(newActive.artworkDimensions);
        setArtworkPosition(newActive.artworkPosition);
        setLockProportion(newActive.lockProportion);
      }
      return updated;
    });
  }, [activeLayerId]);

  const selectLayer = useCallback((layerId) => {
    if (layerId === activeLayerId) return;
    // Save current state into the current active layer before switching
    setLayers(prev => prev.map(l =>
      l.id === activeLayerId
        ? { ...l, artwork, artworkDimensions, artworkPosition, lockProportion }
        : l
    ));
    // Load the selected layer's state
    const target = layers.find(l => l.id === layerId);
    if (target) {
      setActiveLayerId(layerId);
      setArtwork(target.artwork);
      setArtworkDimensions(target.artworkDimensions);
      setArtworkPosition(target.artworkPosition);
      setLockProportion(target.lockProportion);
    }
  }, [activeLayerId, artwork, artworkDimensions, artworkPosition, lockProportion, layers]);

  const updateLayerVisibility = useCallback((layerId, visible) => {
    setLayers(prev => prev.map(l => l.id === layerId ? { ...l, visible } : l));
  }, []);

  const updateLayerName = useCallback((layerId, name) => {
    setLayers(prev => prev.map(l => l.id === layerId ? { ...l, name } : l));
  }, []);

  const reorderLayers = useCallback((fromIndex, toIndex) => {
    setLayers(prev => {
      const updated = [...prev];
      const [moved] = updated.splice(fromIndex, 1);
      updated.splice(toIndex, 0, moved);
      return updated;
    });
  }, []);

  // Keep the active layer in sync with main state changes (from ControlPanel interactions)
  useEffect(() => {
    if (!multiLayerEnabled || !activeLayerId) return;
    setLayers(prev => prev.map(l =>
      l.id === activeLayerId
        ? { ...l, artwork, artworkDimensions, artworkPosition, lockProportion }
        : l
    ));
  }, [artwork, artworkDimensions, artworkPosition, lockProportion, multiLayerEnabled, activeLayerId]);

  useEffect(() => {
    const handoff = new URLSearchParams(window.location.search).get('artwork');
    if (!handoff) return;
    let active = true;
    detectApiBase().then(async (apiBase) => {
      const meta = await fetch(`${apiBase}/central-artwork.php?action=asset&token=${encodeURIComponent(handoff)}`).then(r => r.json());
      const content = await fetch(`${apiBase}/central-artwork.php?action=content&token=${encodeURIComponent(handoff)}`).then(r => r.blob());
      const dataUrl = await new Promise(resolve => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.readAsDataURL(content); });
      if (!active) return;
      setStudioToken(handoff);
      setStudioFileName(meta.data?.file_name || 'artwork.png');
      setArtwork(dataUrl);
      setArtworkFile(new File([content], meta.data?.file_name || 'artwork.png', { type: content.type || 'image/png' }));
      setCurrentPage('bgremover');
    }).catch(() => { if (active) setStudioMessage('Artwork handoff could not be loaded'); });
    return () => { active = false; };
  }, []);

  // ─── SAVING BACK TO NEXTCLOUD ───────────────────────────────────────────────
  // Each tool saves its own stage of the same design, into that customer's own
  // folder: the editor writes WRK, the mockup writes MU, the gang sheet writes
  // GS. Every save is a new numbered version — nothing is ever overwritten.
  const SAVE_STAGES = {
    bgremover: { kind: 'WRK', label: 'Save WRK', folder: 'Artworks' },
    mockupv2: { kind: 'MU', label: 'Save MU', folder: 'Mockups' },
    gangsheet: { kind: 'GS', label: 'Save GS', folder: 'Gangsheets' },
  };

  // The mockup and gang sheet pages register how to produce their output, so
  // Save asks for the finished render at the moment it is clicked rather than
  // re-rendering on every slider move.
  // Two ways to produce a mockup. The multi-size panel renders at print
  // resolution and is preferred when the designer has generated it; otherwise
  // Save MU uses the design canvas they are actually looking at, so the button
  // never refuses to save a mockup that is plainly on screen.
  const mockupHiResExportRef = useRef(null);
  const mockupCanvasExportRef = useRef(null);
  const gangsheetExportRef = useRef(null);
  const registerMockupHiResExport = useCallback((fn) => { mockupHiResExportRef.current = fn; }, []);
  const registerMockupCanvasExport = useCallback((fn) => { mockupCanvasExportRef.current = fn; }, []);
  const registerGangsheetExport = useCallback((fn) => { gangsheetExportRef.current = fn; }, []);

  // The upload's extension decides the saved file's extension, so a PNG export
  // taken from a .ai source must not be named ".ai".
  const uploadName = (blob) => {
    const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[blob.type] || 'png';
    return `studio-output.${ext}`;
  };

  // Jo tool ne banaya wo hamesha PNG hota hai. Designer JPG maange to usay
  // dobara likhna padta hai — aur JPG me shafaaf hissa hota hi nahi, isliye
  // pehle safed bhara jata hai. Bina iske transparent artwork kaale daag ke
  // saath save hoti, jo chhapai me pakdi jati, screen par nahi.
  const asFormat = async (blob, format) => {
    const wantPng = format !== 'jpg';
    if (wantPng && blob.type === 'image/png') return blob;
    if (!wantPng && blob.type === 'image/jpeg') return blob;

    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    if (!wantPng) { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height); }
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close?.();
    const out = await new Promise((resolve) => canvas.toBlob(
      resolve, wantPng ? 'image/png' : 'image/jpeg', wantPng ? undefined : 0.95));
    return out || blob;          // canvas ne mana kar diya to jo tha wahi bhej do
  };

  const postSave = async (apiBase, kind, blob, token) => {
    const form = new FormData();
    form.append('token', token || studioToken);
    form.append('kind', kind);
    form.append('file', new File([blob], uploadName(blob), { type: blob.type || 'image/png' }));
    const response = await fetch(`${apiBase}/central-artwork.php?action=save`, { method: 'POST', body: form });
    const payload = await response.json();
    if (!response.ok || !payload.data?.studio_token) throw new Error(payload.message || 'Save failed');
    return payload.data;
  };

  const saveStudioOutput = async (tokenOverride) => {
    const stage = SAVE_STAGES[currentPage];
    const token = tokenOverride || studioToken;
    if (!stage || studioSaving) return;
    // Kis design ka marhala hai — yehi ek cheez hai jo save ke liye laazmi hai.
    if (!token) { openDesignPicker(); return; }
    setStudioSaving(true);
    setStudioMessage(`Saving ${stage.kind} to ${stage.folder} as ${saveFormat.toUpperCase()}…`);
    try {
      const apiBase = await detectApiBase();

      // A gang sheet can be several sheets; each is saved as its own version.
      if (stage.kind === 'GS') {
        const sheets = gangsheetExportRef.current ? await gangsheetExportRef.current() : [];
        if (!sheets.length) throw new Error('Add artwork to the gang sheet first');
        const names = [];
        for (const blob of sheets) {
          const saved = await postSave(apiBase, 'GS', await asFormat(blob, saveFormat), token);
          setStudioToken(saved.studio_token);
          setStudioFileName(saved.file_name);
          names.push(saved.file_name);
        }
        setStudioMessage(`Saved: ${names.join(', ')}`);
        return;
      }

      let source = artwork;
      if (stage.kind === 'MU') {
        const exporter = mockupHiResExportRef.current || mockupCanvasExportRef.current;
        source = exporter ? await exporter() : null;
      }
      if (!source) {
        throw new Error(stage.kind === 'MU'
          ? 'Place an artwork on the garment first'
          : 'Open an artwork from the Vault first');
      }
      const raw = source instanceof Blob ? source : await fetch(source).then(r => r.blob());
      const saved = await postSave(apiBase, stage.kind, await asFormat(raw, saveFormat), token);
      setStudioToken(saved.studio_token);
      setStudioFileName(saved.file_name);
      setStudioMessage(`Saved: ${saved.file_name}`);
    } catch (error) {
      setStudioMessage(error.message || 'Save failed');
    } finally { setStudioSaving(false); }
  };

  // Customer ki list Vault wale hi raaste se — ek hi sach, do jagah nahi.
  const openDesignPicker = async () => {
    setPickOpen(true);
    setPickBusy('customers');
    try {
      const apiBase = await detectApiBase();
      const r = await fetch(`${apiBase}/central-artwork.php?action=facets`).then(x => x.json());
      setPickCustomers(r.data?.customers || []);
    } catch { setStudioMessage('Customer list could not be loaded'); }
    finally { setPickBusy(''); }
  };

  const loadPickDesigns = async (key) => {
    setPickCustomer(key); setPickDesign(''); setPickDesigns([]);
    if (!key) return;
    setPickBusy('designs');
    try {
      const apiBase = await detectApiBase();
      const r = await fetch(`${apiBase}/central-artwork.php?action=pieces&entity_key=${encodeURIComponent(key)}`).then(x => x.json());
      setPickDesigns(r.data?.rows || []);
    } catch { setStudioMessage('Designs could not be loaded'); }
    finally { setPickBusy(''); }
  };

  // Design chunte hi uska apna token liya jata hai, aur wahi token save ke saath
  // jata hai — isi se PrintShop jaanta hai ke yeh kaam kis design ka hai.
  const confirmDesign = async () => {
    if (!pickDesign) return;
    setPickBusy('opening');
    try {
      const apiBase = await detectApiBase();
      const r = await fetch(`${apiBase}/central-artwork.php?action=handoff&id=${encodeURIComponent(pickDesign)}`).then(x => x.json());
      const token = r.data?.token;
      if (!token) throw new Error(r.message || 'Could not open that design');
      setStudioToken(token);
      setPickOpen(false);
      await saveStudioOutput(token);
    } catch (e) { setStudioMessage(e.message || 'Could not open that design'); }
    finally { setPickBusy(''); }
  };

  // Restore session on mount
  useEffect(() => {
    let active = true;
    async function initializeAuth() {
      // DEV BYPASS: Skip auth on localhost so the app is testable without the PHP backend
      const isLocalDev = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
      if (isLocalDev) {
        const devUser = {
          id: 0,
          username: 'dev',
          email: 'dev@localhost',
          full_name: 'Local Developer',
          role: 'superadmin',
          page_access: ['vault','gallery','bgremover','qa','orders','garments','gangsheet','gscalc','gsoptimize','contrast','ailab','users','mockupv2','batch','garment-types'],
        };
        if (active) { setAuthUser(devUser); setAuthToken('dev-token'); setAuthLoading(false); }
        return;
      }

      // The cached user paints the app immediately, but it is only a cache: page
      // access and role are granted on the server and used to change, so every
      // load re-reads them. Without this an administrator's grant never reached
      // anyone who was already signed in — their browser kept the old page list
      // until the session expired.
      const token = localStorage.getItem('auth_token');
      const cached = localStorage.getItem('auth_user');
      if (token) {
        let painted = false;
        if (cached) {
          try {
            if (active) { setAuthUser(JSON.parse(cached)); setAuthToken(token); setAuthLoading(false); painted = true; }
          } catch (e) { localStorage.removeItem('auth_user'); }
        }
        try {
          const apiBase = await detectApiBase();
          const res = await fetch(`${apiBase}/auth.php?action=validate`, { headers: { Authorization: `Bearer ${token}` } });
          if (res.ok) {
            const data = await res.json();
            localStorage.setItem('auth_user', JSON.stringify(data.user));
            if (active) { setAuthUser(data.user); setAuthToken(token); setAuthVerified(true); }
            return;
          }
          if (res.status !== 401) {
            // The server is unhappy for some other reason — a cached session is
            // better than throwing the person back to a login screen.
            if (painted) return;
          } else {
            localStorage.removeItem('auth_token');
            localStorage.removeItem('auth_user');
            if (active) { setAuthUser(null); setAuthToken(null); }
          }
        } catch (e) {
          if (painted) return; // offline: keep working with what we have
        }
      }
      try {
        const apiBase = await detectApiBase();
        const res = await fetch(`${apiBase}/auth.php?action=sso`, { method: 'POST' });
        if (!res.ok) {
          if (window.location.hostname.endsWith('.decoinkssuite.com')) {
            const rd = `${window.location.origin}${window.location.pathname}${window.location.search}`;
            window.location.replace(`${window.location.origin}/outpost.goauthentik.io/start?rd=${encodeURIComponent(rd)}`);
          }
          return;
        }
        const data = await res.json();
        localStorage.setItem('auth_token', data.token);
        localStorage.setItem('auth_user', JSON.stringify(data.user));
        if (active) { setAuthUser(data.user); setAuthToken(data.token); setAuthVerified(true); }
      } catch {
        if (window.location.hostname.endsWith('.decoinkssuite.com')) {
          const rd = `${window.location.origin}${window.location.pathname}${window.location.search}`;
          window.location.replace(`${window.location.origin}/outpost.goauthentik.io/start?rd=${encodeURIComponent(rd)}`);
        }
      }
      finally { if (active) setAuthLoading(false); }
    }
    initializeAuth();
    return () => { active = false; };
  }, []);

  const handleLogin = (user, token) => {
    setAuthUser(user);
    setAuthToken(token);
    setAuthVerified(true);
  };

  const handleLogout = () => {
    const token = localStorage.getItem('auth_token');
    if (token) {
      detectApiBase().then(base => {
        fetch(`${base}/auth.php?action=logout`, {
          method: 'POST', headers: { 'Authorization': `Bearer ${token}` }
        }).catch(() => {});
      });
    }
    localStorage.removeItem('auth_token');
    localStorage.removeItem('auth_user');
    setAuthUser(null);
    setAuthToken(null);
    setAuthVerified(false);
  };

  // Check page access
  const hasPageAccess = (page) => {
    if (!authUser) return false;
    if (authUser.role === 'superadmin') return true;
    const access = authUser.page_access || [];
    return access.includes(page);
  };

  // The app opens on the Vault, but not everyone has it — a designer who only has
  // the editor and the task list used to land on "You don't have access to this
  // page" with a perfectly usable sidebar beside it. Follow the sidebar's own
  // order and open the first page this person is allowed to see.
  const PAGE_ORDER = ['tasks', 'vault', 'gallery', 'bgremover', 'mockupv2', 'gangsheet', 'garments', 'batch', 'gscalc', 'gsoptimize', 'qa', 'contrast', 'ailab', 'orders', 'garment-types', 'users'];
  useEffect(() => {
    if (!authUser || !authVerified || hasPageAccess(currentPage)) return;
    const landing = PAGE_ORDER.find(hasPageAccess);
    if (landing) setCurrentPage(landing);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authUser, authVerified, currentPage]);

  // Load garment library from server API (shared for all users), fallback to localStorage
  const loadGarmentLibrary = async () => {
    const apiBase = await detectApiBase();
    const apiUrl = `${apiBase}/garments.php`;
    const imageUrl = `${apiBase}/serve-image.php`;

    fetch(apiUrl)
      .then(res => {
        if (!res.ok) throw new Error('Server error');
        return res.json();
      })
      .then(data => {
        if (!Array.isArray(data)) throw new Error('Invalid data');
        const withUrls = data.map(g => ({
          ...g,
          dataUrl: g.dataUrl || (g.imageFile ? `${imageUrl}?file=${g.imageFile}` : null),
        })).filter(g => g.dataUrl); // only include garments that have a valid image
        setGarmentLibrary(withUrls);
        // Keep localStorage in sync
        try { localStorage.setItem('garment-library', JSON.stringify(withUrls)); } catch(e) {}
      })
      .catch(() => {
        // Fallback to localStorage — don't clear existing library on failure
        try {
          const stored = localStorage.getItem('garment-library');
          if (stored) {
            const parsed = JSON.parse(stored);
            if (Array.isArray(parsed) && parsed.length > 0) {
              setGarmentLibrary(parsed);
            }
          }
        } catch (e) {}
      });
  };

  useEffect(() => {
    loadGarmentLibrary();
  }, [currentPage]); // Reload when switching pages

  // Handle garment selection change
  const handleGarmentChange = (garmentId) => {
    setSelectedGarmentId(garmentId);
    if (garmentId) {
      const garment = garmentLibrary.find(g => g.id === garmentId);
      if (garment) setCustomGarment(garment);
    } else {
      setCustomGarment(null);
    }
  };

  // Garment selection is handled by ControlPanel's useEffect (type+size matching)
  // handleGarmentChange is called from ControlPanel when type/size changes

  const handleArtworkUpload = (file) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      setArtwork(e.target.result);
      setArtworkFile(file);

      // Auto-set artwork dimensions based on actual image DPI size
      const img = new Image();
      img.onload = () => {
        const DPI = 300;
        // Calculate actual physical size at 300 DPI
        let actualW = parseFloat((img.naturalWidth / DPI).toFixed(2));
        let actualH = parseFloat((img.naturalHeight / DPI).toFixed(2));
        const imgAspect = img.naturalWidth / img.naturalHeight;
        const maxW = artworkAreaSettings.width;
        const maxH = artworkAreaSettings.height;

        // Only scale down if the actual size exceeds the print area
        if (actualW <= maxW && actualH <= maxH) {
          // If both dimensions are smaller than 10.75", scale up the larger one to 10.75"
          const MIN_SIZE = 10.75;
          if (actualW < MIN_SIZE && actualH < MIN_SIZE) {
            if (imgAspect >= 1) {
              // wider — set width to 10.75
              actualW = MIN_SIZE;
              actualH = parseFloat((MIN_SIZE / imgAspect).toFixed(2));
            } else {
              // taller — set height to 10.75
              actualH = MIN_SIZE;
              actualW = parseFloat((MIN_SIZE * imgAspect).toFixed(2));
            }
          }
          setArtworkDimensions({ width: actualW, height: actualH });
        } else {
          // Too large — scale down to fit within print area maintaining aspect ratio
          let newW, newH;
          if (imgAspect > maxW / maxH) {
            newW = maxW;
            newH = parseFloat((maxW / imgAspect).toFixed(2));
          } else {
            newH = maxH;
            newW = parseFloat((maxH * imgAspect).toFixed(2));
          }
          setArtworkDimensions({ width: newW, height: newH });
        }
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  };

  const handlePositionChange = (pos) => {
    setArtworkPosition(pos);
  };

  const resetPosition = () => {
    setArtworkPosition({ x: 0, y: 0 });
  };

  // Cross-page navigation with shared artwork
  const sendToQA = (imageDataUrl) => {
    setSharedArtwork({ dataUrl: imageDataUrl, filename: 'processed-artwork.png' });
    setCurrentPage('qa');
  };

  const sendToMockup = (imageDataUrl) => {
    setSharedArtwork({ dataUrl: imageDataUrl, filename: 'processed-artwork.png' });
    // Also load into the design canvas artwork
    setArtwork(imageDataUrl);

    // Auto-set dimensions from image at 300 DPI (same as handleArtworkUpload)
    const img = new Image();
    img.onload = () => {
      const DPI = 300;
      let actualW = parseFloat((img.naturalWidth / DPI).toFixed(2));
      let actualH = parseFloat((img.naturalHeight / DPI).toFixed(2));
      const imgAspect = img.naturalWidth / img.naturalHeight;
      const maxW = artworkAreaSettings.width;
      const maxH = artworkAreaSettings.height;

      if (actualW <= maxW && actualH <= maxH) {
        // If both dimensions are smaller than 10.75", scale up the larger one to 10.75"
        const MIN_SIZE = 10.75;
        if (actualW < MIN_SIZE && actualH < MIN_SIZE) {
          if (imgAspect >= 1) {
            actualW = MIN_SIZE;
            actualH = parseFloat((MIN_SIZE / imgAspect).toFixed(2));
          } else {
            actualH = MIN_SIZE;
            actualW = parseFloat((MIN_SIZE * imgAspect).toFixed(2));
          }
        }
        setArtworkDimensions({ width: actualW, height: actualH });
      } else {
        let newW, newH;
        if (imgAspect > maxW / maxH) {
          newW = maxW;
          newH = parseFloat((maxW / imgAspect).toFixed(2));
        } else {
          newH = maxH;
          newW = parseFloat((maxH * imgAspect).toFixed(2));
        }
        setArtworkDimensions({ width: newW, height: newH });
      }
    };
    img.src = imageDataUrl;

    setCurrentPage('mockupv2');
  };

  // A file checked out of the Artwork Vault. It carries an asset-scoped token,
  // so whatever the designer does next can be saved straight back to that file's
  // customer folder in Nextcloud as a WRK version — no manual re-upload, and no
  // copying artwork between PrintShop and the studio.
  const openVaultAsset = (target, dataUrl, asset) => {
    if (asset?.studio_token) {
      setStudioToken(asset.studio_token);
      setStudioFileName(asset.file_name || 'artwork.png');
    }
    if (target === 'mockupv2') { sendToMockup(dataUrl); return; }
    // The asset id and customer travel with the artwork: the gang sheet files its
    // output back into this same customer's folder, and it can only work out
    // which folder that is from where the file it was handed already lives.
    setSharedArtwork({
      dataUrl,
      filename: asset?.file_name || 'vault-artwork.png',
      assetId: asset?.id || null,
      customerName: asset?.entity_name || null,
    });
    setArtwork(dataUrl);
    setCurrentPage(target);
  };

  // Vault → Task Manager. The files stay selected as vault assets: previews and
  // the payload are built on the task page, so a big selection does not block
  // the grid the person is still working in.
  // Stable identity: the task page uses this in an effect, and a new function on
  // every App render would re-run that effect mid-preparation.
  const clearPendingTaskArtworks = useCallback(() => setPendingTaskArtworks(null), []);

  const sendVaultSelectionToTasks = (assets) => {
    if (!assets?.length) return;
    setPendingTaskArtworks(assets);
    setCurrentPage('tasks');
  };

  // The other direction: an artwork attached to a task, opened into the editor.
  // Only the vault asset id was stored, so the file is checked out here exactly
  // as the Vault page does it — which is what gives the editor a save token.
  const openTaskArtwork = async (artwork) => {
    if (!artwork?.assetId || openingTaskArtwork) return;
    setOpeningTaskArtwork(artwork.assetId);
    try {
      const apiBase = await detectApiBase();
      const handoffRes = await fetch(`${apiBase}/central-artwork.php?action=handoff&id=${encodeURIComponent(artwork.assetId)}`);
      const handoff = await handoffRes.json();
      if (!handoffRes.ok || !handoff.data?.token) throw new Error(handoff.message || 'Could not check out this artwork');
      const contentRes = await fetch(`${apiBase}/central-artwork.php?action=content&token=${encodeURIComponent(handoff.data.token)}`);
      if (!contentRes.ok) throw new Error('Artwork content could not be downloaded');
      const blob = await contentRes.blob();
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('Artwork could not be read'));
        reader.readAsDataURL(blob);
      });
      openVaultAsset('bgremover', dataUrl, {
        id: artwork.assetId,
        file_name: handoff.data.file_name || artwork.fileName,
        entity_name: artwork.customerName || null,
        studio_token: handoff.data.token,
      });
    } catch (error) {
      setStudioMessage(error.message || 'This artwork could not be opened');
    } finally {
      setOpeningTaskArtwork('');
    }
  };

  const sendToBGRemover = (imageDataUrl) => {
    setSharedArtwork({ dataUrl: imageDataUrl, filename: 'artwork.png' });
    setCurrentPage('bgremover');
  };

  const renderPage = () => {
    if (currentPage === 'bgremover') {
      return (
        <BGRemover
          sharedArtwork={sharedArtwork}
          onSendToQA={sendToQA}
          onSendToMockup={sendToMockup}
          onArtworkChange={setArtwork}
        />
      );
    }

    if (currentPage === 'gallery') {
      return <Gallery />;
    }

    if (currentPage === 'vault') {
      return <Vault onOpenAsset={openVaultAsset} onSendToTasks={sendVaultSelectionToTasks} />;
    }

    if (currentPage === 'tasks') {
      return (
        <TaskManager
          pendingArtworks={pendingTaskArtworks}
          onPendingArtworksHandled={clearPendingTaskArtworks}
          onOpenArtwork={openTaskArtwork}
          openingArtwork={openingTaskArtwork}
        />
      );
    }

    if (currentPage === 'contrast') {
      return <ContrastChecker />;
    }

    if (currentPage === 'qa') {
      return (
        <QADefectAnalysis
          sharedArtwork={sharedArtwork}
          onSendToBGRemover={sendToBGRemover}
          onSendToMockup={sendToMockup}
        />
      );
    }

    if (currentPage === 'garments') {
      return (
        <GarmentManager
          onUseAsMockup={(garment) => {
            setCustomGarment(garment);
            setCurrentPage('mockupv2');
          }}
        />
      );
    }

    if (currentPage === 'gangsheet') {
      return <GangSheet sharedArtwork={sharedArtwork} onRegisterExport={registerGangsheetExport} />;
    }

    if (currentPage === 'gscalc') {
      return <GangSheetCalculator />;
    }

    if (currentPage === 'gsoptimize') {
      return <GangSheetOptimizer />;
    }

    if (currentPage === 'ailab') {
      return (
        <AIArtworkLab
          sharedArtwork={sharedArtwork}
          onSendToQA={sendToQA}
          onSendToMockup={sendToMockup}
        />
      );
    }

    if (currentPage === 'users') {
      return <UserManagement authUser={authUser} />;
    }

    if (currentPage === 'garment-types') {
      return <GarmentTypes />;
    }

    if (currentPage === 'batch') {
      return <BatchProcessor />;
    }

    if (currentPage === 'mockupv2') {
      return (
        <>
          <header className="top-bar">
            <div className="breadcrumb">
              <span>Mockup Engine V2</span>
              <span className="separator">›</span>
              <span className="active">Design Preview (Beta)</span>
            </div>
            <div className="top-actions">
              <span style={{fontSize:'11px',background:'#f59e0b',color:'white',padding:'3px 8px',borderRadius:'4px'}}>V2 Engine</span>
              <button className="btn-primary">Share / Send</button>
            </div>
          </header>
          <div className="designer-layout">
            <div className="canvas-section">
              <div className="view-controls">
                {['front', 'back'].map((side) => (
                  <button key={side} className={`view-btn ${viewSide === side ? 'active' : ''}`} onClick={() => setViewSide(side)}>
                    <ViewIcon side={side} />
                    <span>{side.charAt(0).toUpperCase() + side.slice(1)}</span>
                  </button>
                ))}
              </div>
              <div className={`canvas-with-comparison ${comparisonSizes.length > 0 ? 'has-comparison' : ''}`}>
                <DesignCanvas
                  artwork={artwork}
                  selectedSize={selectedSize}
                  selectedColor={selectedColor}
                  artworkDimensions={artworkDimensions}
                  viewSide={viewSide}
                  artworkPosition={artworkPosition}
                  artworkScale={artworkScale}
                  artworkAreaSettings={artworkAreaSettings}
                  onPositionChange={handlePositionChange}
                  customGarment={customGarment}
                  onRegisterExport={registerMockupCanvasExport}
                  multiLayerEnabled={multiLayerEnabled}
                  layers={layers}
                  activeLayerId={activeLayerId}
                />
                {comparisonSizes.length > 0 && (
                  <MultiSizePreview
                    artwork={artwork}
                    selectedColor={selectedColor}
                    artworkDimensions={artworkDimensions}
                    artworkPosition={artworkPosition}
                    artworkScale={artworkScale}
                    artworkAreaSettings={artworkAreaSettings}
                    selectedSizes={comparisonSizes}
                    viewSide={viewSide}
                    garmentLibrary={garmentLibrary}
                    scalingMode={scalingMode}
                    baseSize={selectedSize}
                    customGarment={customGarment}
                    multiLayerEnabled={multiLayerEnabled}
                    layers={layers}
                    activeLayerId={activeLayerId}
                  />
                )}
              </div>
            </div>
            <div className="controls-section">
              <LayerPanel
                multiLayerEnabled={multiLayerEnabled}
                layers={layers}
                activeLayerId={activeLayerId}
                onEnableMultiLayer={enableMultiLayer}
                onDisableMultiLayer={disableMultiLayer}
                onAddLayer={addLayer}
                onRemoveLayer={removeLayer}
                onSelectLayer={selectLayer}
                onToggleVisibility={updateLayerVisibility}
                onRenameLayer={updateLayerName}
                onReorderLayers={reorderLayers}
              />
              <ControlPanel
                selectedSize={selectedSize}
                onSizeChange={setSelectedSize}
                selectedColor={selectedColor}
                onColorChange={setSelectedColor}
                artworkDimensions={artworkDimensions}
                onDimensionsChange={setArtworkDimensions}
                lockProportion={lockProportion}
                onLockProportionChange={setLockProportion}
                artwork={artwork}
                onArtworkUpload={handleArtworkUpload}
                artworkScale={artworkScale}
                artworkPosition={artworkPosition}
                onPositionChange={handlePositionChange}
                onReset={resetPosition}
                artworkAreaSettings={artworkAreaSettings}
                onArtworkAreaSettingsChange={setArtworkAreaSettings}
                selectedMockupSizes={selectedMockupSizes}
                onMockupSizeToggle={(size) => setSelectedMockupSizes((prev) => ({ ...prev, [size]: !prev[size] }))}
                onGenerateMockups={() => setShowMockups(true)}
                garmentLibrary={garmentLibrary}
                selectedGarmentId={selectedGarmentId}
                onGarmentChange={handleGarmentChange}
                comparisonSizes={comparisonSizes}
                onComparisonSizeToggle={(size) => setComparisonSizes((prev) => prev.includes(size) ? prev.filter((s) => s !== size) : [...prev, size])}
                scalingMode={scalingMode}
                onScalingModeChange={setScalingMode}
                viewSide={viewSide}
                multiLayerEnabled={multiLayerEnabled}
                activeLayerName={multiLayerEnabled && layers.find(l => l.id === activeLayerId)?.name}
              />
            </div>
          </div>
          {showMockups && (
            <MockupPreview
              artwork={artwork}
              selectedColor={selectedColor}
              artworkDimensions={artworkDimensions}
              artworkPosition={artworkPosition}
              artworkScale={artworkScale}
              artworkAreaSettings={artworkAreaSettings}
              selectedMockupSizes={selectedMockupSizes}
              viewSide={viewSide}
              garmentLibrary={garmentLibrary}
              onRegisterExport={registerMockupHiResExport}
            />
          )}
        </>
      );
    }

    // Default: Design Preview page (orders)
    return (
      <>
        <header className="top-bar">
          <div className="breadcrumb">
            <span>Orders</span>
            <span className="separator">›</span>
            <span>PS-{new Date().toISOString().slice(2, 10).replace(/-/g, '')}-001</span>
            <span className="separator">›</span>
            <span className="active">Design Preview</span>
          </div>
          <div className="top-actions">
            <button className="btn-secondary">Save as Template</button>
            <button className="btn-primary">Share / Send</button>
          </div>
        </header>

        <div className="designer-layout">
          <div className="canvas-section">
            <div className="view-controls">
              {['front', 'back'].map((side) => (
                <button
                  key={side}
                  className={`view-btn ${viewSide === side ? 'active' : ''}`}
                  onClick={() => setViewSide(side)}
                >
                  <ViewIcon side={side} />
                  <span>{side.charAt(0).toUpperCase() + side.slice(1)}</span>
                </button>
              ))}
            </div>
            <div className={`canvas-with-comparison ${comparisonSizes.length > 0 ? 'has-comparison' : ''}`}>
              <DesignCanvas
                artwork={artwork}
                selectedSize={selectedSize}
                selectedColor={selectedColor}
                artworkDimensions={artworkDimensions}
                viewSide={viewSide}
                artworkPosition={artworkPosition}
                artworkScale={artworkScale}
                artworkAreaSettings={artworkAreaSettings}
                onPositionChange={handlePositionChange}
                customGarment={customGarment}
                onRegisterExport={registerMockupCanvasExport}
                multiLayerEnabled={multiLayerEnabled}
                layers={layers}
                activeLayerId={activeLayerId}
              />
              {comparisonSizes.length > 0 && (
                <MultiSizePreview
                  artwork={artwork}
                  selectedColor={selectedColor}
                  artworkDimensions={artworkDimensions}
                  artworkPosition={artworkPosition}
                  artworkScale={artworkScale}
                  artworkAreaSettings={artworkAreaSettings}
                  selectedSizes={comparisonSizes}
                  viewSide={viewSide}
                  garmentLibrary={garmentLibrary}
                  scalingMode={scalingMode}
                  baseSize={selectedSize}
                  customGarment={customGarment}
                  multiLayerEnabled={multiLayerEnabled}
                  layers={layers}
                  activeLayerId={activeLayerId}
                />
              )}
            </div>
          </div>

          <div className="controls-section">
            <ControlPanel
              selectedSize={selectedSize}
              onSizeChange={setSelectedSize}
              selectedColor={selectedColor}
              onColorChange={setSelectedColor}
              artworkDimensions={artworkDimensions}
              onDimensionsChange={setArtworkDimensions}
              lockProportion={lockProportion}
              onLockProportionChange={setLockProportion}
              artwork={artwork}
              onArtworkUpload={handleArtworkUpload}
              artworkScale={artworkScale}
              artworkPosition={artworkPosition}
              onPositionChange={handlePositionChange}
              onReset={resetPosition}
              artworkAreaSettings={artworkAreaSettings}
              onArtworkAreaSettingsChange={setArtworkAreaSettings}
              selectedMockupSizes={selectedMockupSizes}
              onMockupSizeToggle={(size) =>
                setSelectedMockupSizes((prev) => ({ ...prev, [size]: !prev[size] }))
              }
              onGenerateMockups={() => setShowMockups(true)}
              garmentLibrary={garmentLibrary}
              selectedGarmentId={selectedGarmentId}
              onGarmentChange={handleGarmentChange}
              comparisonSizes={comparisonSizes}
              onComparisonSizeToggle={(size) =>
                setComparisonSizes((prev) =>
                  prev.includes(size) ? prev.filter((s) => s !== size) : [...prev, size]
                )
              }
              scalingMode={scalingMode}
              onScalingModeChange={setScalingMode}
              viewSide={viewSide}
              multiLayerEnabled={multiLayerEnabled}
              activeLayerName={multiLayerEnabled && layers.find(l => l.id === activeLayerId)?.name}
            />
          </div>
        </div>

        {showMockups && (
          <MockupPreview
            artwork={artwork}
            selectedColor={selectedColor}
            artworkDimensions={artworkDimensions}
            artworkPosition={artworkPosition}
            artworkScale={artworkScale}
            artworkAreaSettings={artworkAreaSettings}
            selectedMockupSizes={selectedMockupSizes}
            viewSide={viewSide}
            garmentLibrary={garmentLibrary}
            onRegisterExport={registerMockupHiResExport}
          />
        )}
      </>
    );
  };

  // ─── AUTH GATING (after all hooks) ──────────────────────────────────────────
  if (authLoading) return <div style={{display:'flex',alignItems:'center',justifyContent:'center',height:'100vh'}}>Loading...</div>;
  if (!authUser) return <Login onLogin={handleLogin} />;

  return (
    <div className="app-layout">
      <Sidebar currentPage={currentPage} onPageChange={(page) => { if (hasPageAccess(page)) setCurrentPage(page); }} authUser={authUser} onLogout={handleLogout} hasPageAccess={hasPageAccess} />
      <main className="main-content">
        {hasPageAccess(currentPage) ? renderPage() : (
          <div style={{display:'flex',alignItems:'center',justifyContent:'center',height:'100%',color:'#64748b'}}>
            <p>You don't have access to this page. Contact your administrator.</p>
          </div>
        )}
        {/* The save bar belongs to the tool that produces the file — it used to
            follow the user onto every page, including User Management. */}
        {SAVE_STAGES[currentPage] && (
          <div style={{position:'fixed',right:24,bottom:24,zIndex:50,display:'flex',alignItems:'center',gap:10,background:'#fff',padding:'10px 12px',borderRadius:10,boxShadow:'0 8px 30px rgba(15,23,42,.18)'}}>
            {studioMessage && <span style={{fontSize:12,color:'#475569',maxWidth:360}}>{studioMessage}</span>}
            {/* Kis shakl me save karni hai. Save se PEHLE chunna padta hai,
                isliye button ke saath hi rakha hai, kisi menu me chhupa nahi. */}
            <div style={{display:'flex',gap:2,padding:2,background:'#f1f5f9',borderRadius:8}} role="group" aria-label="Save format">
              {['png','jpg'].map((f) => (
                <button key={f} onClick={() => setSaveFormat(f)} disabled={studioSaving}
                  aria-pressed={saveFormat === f}
                  style={{border:'none',cursor:'pointer',borderRadius:6,padding:'5px 11px',
                    fontSize:12,fontWeight:600,letterSpacing:'.02em',
                    background:saveFormat===f?'#fff':'transparent',
                    color:saveFormat===f?'#0f172a':'#64748b',
                    boxShadow:saveFormat===f?'0 1px 3px rgba(15,23,42,.12)':'none'}}>
                  {f.toUpperCase()}
                </button>
              ))}
            </div>
            <button onClick={() => saveStudioOutput()} disabled={studioSaving} className="btn-primary">
              {studioSaving ? 'Saving…' : `${SAVE_STAGES[currentPage].label} (${saveFormat.toUpperCase()})`}
            </button>
          </div>
        )}

        {pickOpen && (
          <div onClick={() => setPickOpen(false)}
            style={{position:'fixed',inset:0,zIndex:60,background:'rgba(15,23,42,.5)',display:'flex',alignItems:'center',justifyContent:'center',padding:16}}>
            <div onClick={(e) => e.stopPropagation()}
              style={{background:'#fff',borderRadius:12,width:'100%',maxWidth:460,boxShadow:'0 20px 60px rgba(0,0,0,.3)',overflow:'hidden'}}>
              <div style={{padding:'14px 16px',borderBottom:'1px solid #e2e8f0'}}>
                <strong style={{fontSize:14}}>Which design is this {SAVE_STAGES[currentPage]?.kind === 'GS' ? 'gang sheet' : 'mockup'} for?</strong>
                <div style={{fontSize:12,color:'#64748b',marginTop:3}}>
                  It is saved as that design&rsquo;s next {SAVE_STAGES[currentPage]?.kind}, keeping its number.
                </div>
              </div>
              <div style={{padding:16,display:'flex',flexDirection:'column',gap:10}}>
                <input value={pickFilter} onChange={(e) => setPickFilter(e.target.value)}
                  placeholder={`Filter ${pickCustomers.length} customers…`}
                  style={{padding:'8px 11px',border:'1px solid #cbd5e1',borderRadius:8,fontSize:13}} />
                <select value={pickCustomer} onChange={(e) => loadPickDesigns(e.target.value)}
                  style={{padding:'8px 11px',border:'1px solid #cbd5e1',borderRadius:8,fontSize:13}}>
                  <option value="">{pickBusy === 'customers' ? 'Loading…' : 'Select a customer…'}</option>
                  {pickCustomers
                    .filter(c => !pickFilter.trim() || (c.name || '').toLowerCase().includes(pickFilter.trim().toLowerCase()))
                    .slice(0, 400)
                    .map(c => <option key={c.key} value={c.key}>{c.name}{c.files ? ` (${c.files})` : ''}</option>)}
                </select>
                {pickCustomer && (
                  <select value={pickDesign} onChange={(e) => setPickDesign(e.target.value)}
                    style={{padding:'8px 11px',border:'1px solid #cbd5e1',borderRadius:8,fontSize:13}}>
                    <option value="">
                      {pickBusy === 'designs' ? 'Loading…'
                        : pickDesigns.length ? 'Select a design…'
                        : 'This customer has no design yet'}
                    </option>
                    {pickDesigns.map(d => <option key={d.id} value={d.id}>{d.artwork_code} — {d.file_name}</option>)}
                  </select>
                )}
              </div>
              <div style={{padding:'12px 16px',borderTop:'1px solid #e2e8f0',display:'flex',justifyContent:'flex-end',gap:8}}>
                <button onClick={() => setPickOpen(false)} className="btn-secondary">Cancel</button>
                <button onClick={confirmDesign} disabled={!pickDesign || !!pickBusy} className="btn-primary">
                  {pickBusy === 'opening' ? 'Saving…' : 'Save'}
                </button>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

function ViewIcon({ side }) {
  if (side === 'front') {
    return (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M12 2L8 6H4v14h16V6h-4L12 2z" />
      </svg>
    );
  }
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 2L8 6H4v14h16V6h-4L12 2z" />
      <line x1="12" y1="6" x2="12" y2="10" />
    </svg>
  );
}

export default App;
