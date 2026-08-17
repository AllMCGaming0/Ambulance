/**
 * ════════════════════════════════════════════════════════════════════
 *  Robo Rangers — Smart Ambulance AI — app.js
 *  Voice-AI Orchestrated Emergency Response System
 *
 *  APIs Used:
 *   • Web Speech API        — continuous voice recognition
 *   • Google Gemini 3.7     — AI brain (scene analysis + action dispatch)
 *   • Google Maps JS API    — live map + route rendering
 *   • Google Places API     — real-time hospital search
 *   • Google Directions API — ETA + routing
 *   • Web Bluetooth API     — ESP32 traffic light control (BLE)
 *   • Geolocation API       — live GPS tracking
 *   • Web Speech Synthesis  — AI speaks responses aloud
 *   • sms: URI scheme       — hospital SMS pre-filled
 * ════════════════════════════════════════════════════════════════════
 */

'use strict';

// ── CONFIGURATION STORE ──────────────────────────────────────────────
const CONFIG = {
  geminiKey:     '',
  placesKey:     '',   // Google Places API only (for hospital search)
  junctionLat:   null,
  junctionLng:   null,
  junctionRadius:300,
  hospitalName:  '',
  hospitalPhone: '',

  save() {
    localStorage.setItem('sma_config', JSON.stringify({
      geminiKey:     this.geminiKey,
      placesKey:     this.placesKey,
      junctionLat:   this.junctionLat,
      junctionLng:   this.junctionLng,
      junctionRadius:this.junctionRadius,
      hospitalName:  this.hospitalName,
      hospitalPhone: this.hospitalPhone,
    }));
  },

  load() {
    try {
      const stored = JSON.parse(localStorage.getItem('sma_config') || '{}');
      Object.assign(this, stored);
    } catch(e) {}
  }
};

// ── APP STATE ─────────────────────────────────────────────────────────
const STATE = {
  emergencyActive:  false,
  gpsActive:        false,
  bluetoothDevice:  null,
  bleCharacteristic:null,
  bleConnected:     false,
  voiceListening:   false,
  currentPos:       null,        // { lat, lng }
  selectedHospital: null,        // { name, address, phone, lat, lng }
  routeETA:         null,        // string e.g. "12 mins"
  routeDistance:    null,        // string e.g. "5.3 km"
  patientCondition: '',
  trafficState:     'normal',    // 'normal' | 'emg_on'
  gpsWatchId:       null,
  normalCycleTimer: null,
  normalCycleStep:  0,
};

// BLE UUIDs — must match ESP32 firmware
const BLE_SERVICE_UUID = '12345678-1234-1234-1234-123456789abc';
const BLE_CHAR_UUID    = 'abcdefab-cdef-abcd-efab-cdefabcdefab';

// ═ Default fallback location ═ Lucknow, UP, India (used when GPS not yet available)
const DEFAULT_POS = { lat: 26.76071, lng: 80.95066, label: 'Lucknow, UP (default)' };

// Leaflet map objects
let L_map             = null;
let L_ambulanceMkr    = null;
let L_hospitalMkr     = null;
let L_routeLayer      = null;

// ═══════════════════════════════════════════════════════════════════
//  BOOTSTRAP
// ═══════════════════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => {
  CONFIG.load();
  populateSettingsUI();
  bindUIEvents();
  initLeafletMap();   // start Leaflet map immediately
  startGPS();
  startNormalTrafficCycle();
  updateBTStatusUI();
  toast('🚑 Smart Ambulance AI ready — describe an emergency or use voice', 'info', 5000);
});

// ═══════════════════════════════════════════════════════════════════
//  GOOGLE MAPS LINK GENERATORS (no API key required)
// ═══════════════════════════════════════════════════════════════════

// Open location on Google Maps
function mapsLocationLink(lat, lng, label = '') {
  const q = label ? encodeURIComponent(label) + `/@${lat},${lng}` : `${lat},${lng}`;
  return `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
}

// Driving directions from origin to destination
function mapsDirectionsLink(oLat, oLng, dLat, dLng, destName = '') {
  const dest = destName
    ? `${encodeURIComponent(destName)}`
    : `${dLat},${dLng}`;
  return `https://www.google.com/maps/dir/?api=1&origin=${oLat},${oLng}&destination=${dest}&travelmode=driving`;
}

// Street View at a coordinate
function mapsStreetViewLink(lat, lng) {
  return `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${lat},${lng}`;
}

// Share location (plain Maps link anyone can open)
function mapsShareLink(lat, lng) {
  return `https://maps.google.com/?q=${lat},${lng}`;
}

// Estimate straight-line distance as text (km / m)
function straightLineDistText(lat1, lng1, lat2, lng2) {
  const m = haversineMeters(lat1, lng1, lat2, lng2);
  return m < 1000 ? `~${Math.round(m)} m (straight)` : `~${(m/1000).toFixed(1)} km (straight)`;
}
// (Maps JS API removed — using Leaflet + OpenStreetMap + OSRM instead)

// ═══════════════════════════════════════════════════════════════════
//  LEAFLET MAP (free, no API key)
// ═══════════════════════════════════════════════════════════════════

function initLeafletMap() {
  const el = document.getElementById('leaflet-map');
  if (!el || L_map) return;

  // Start at Lucknow default, or live GPS if already acquired
  const center = STATE.currentPos || DEFAULT_POS;
  L_map = L.map('leaflet-map', { zoomControl: true, attributionControl: true })
           .setView([center.lat, center.lng], 14);

  // CartoDB Dark Matter tiles — free, no key
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>, © <a href="https://carto.com/">CARTO</a>',
    subdomains: 'abcd',
    maxZoom: 19,
  }).addTo(L_map);

  // Show default ambulance position immediately so map isn't empty
  updateAmbulanceOnMap(center, /*isDefault=*/!STATE.currentPos);
}

function updateAmbulanceOnMap(pos, isDefault = false) {
  if (!L_map) return;
  const icon = L.divIcon({
    html: `<div style="font-size:28px;filter:drop-shadow(0 0 8px rgba(${isDefault ? '245,158,11' : '59,130,246'},0.9));">🚑</div>`,
    className: '', iconSize: [36, 36], iconAnchor: [18, 18],
  });
  if (!L_ambulanceMkr) {
    L_ambulanceMkr = L.marker([pos.lat, pos.lng], { icon }).addTo(L_map);
    L_ambulanceMkr.bindPopup(
      isDefault
        ? '<b>🚑 Ambulance</b><br><span style="color:#fcd34d">Default position — Lucknow</span><br><span style="font-size:11px;color:#94a3b8">Live GPS will update this</span>'
        : '<b>🚑 Ambulance</b><br>Live GPS location'
    );
  } else {
    L_ambulanceMkr.setLatLng([pos.lat, pos.lng]);
    // Update popup when switching from default to live GPS
    if (!isDefault) {
      L_ambulanceMkr.setPopupContent('<b>🚑 Ambulance</b><br>Live GPS location');
    }
  }
  if (!L_hospitalMkr) L_map.setView([pos.lat, pos.lng], 14);
}

function setHospitalOnMap(hospital) {
  if (!L_map || !hospital.lat || !hospital.lng) return;
  const icon = L.divIcon({
    html: '<div style="font-size:26px;filter:drop-shadow(0 0 10px rgba(16,185,129,0.9));">\ud83c\udfe5</div>',
    className: '', iconSize: [32, 32], iconAnchor: [16, 16],
  });
  if (L_hospitalMkr) L_map.removeLayer(L_hospitalMkr);
  L_hospitalMkr = L.marker([hospital.lat, hospital.lng], { icon }).addTo(L_map);
  L_hospitalMkr.bindPopup(
    `<b style="font-size:14px;">${hospital.name}</b><br>
    <span style="color:#94a3b8;font-size:12px;">${hospital.address || 'Hospital'}</span>`
  ).openPopup();

  // Update map status badge
  const badge = document.getElementById('map-status-badge');
  if (badge) { badge.textContent = 'Route Active'; badge.classList.add('active'); }
}

async function drawRouteOnMap(oLat, oLng, dLat, dLng) {
  if (!L_map) return null;
  try {
    const url = `https://router.project-osrm.org/route/v1/driving/${oLng},${oLat};${dLng},${dLat}?overview=full&geometries=geojson`;
    const res  = await fetch(url);
    const data = await res.json();
    if (data.code !== 'Ok' || !data.routes?.length) return null;

    const route = data.routes[0];
    if (L_routeLayer) L_map.removeLayer(L_routeLayer);
    L_routeLayer = L.geoJSON(route.geometry, {
      style: { color: '#3b82f6', weight: 5, opacity: 0.85 }
    }).addTo(L_map);

    // Fit bounds to show full route
    L_map.fitBounds(L_routeLayer.getBounds(), { padding: [40, 40] });

    const distM = route.distance;
    const durS  = route.duration;
    return {
      distanceText: distM < 1000 ? `${Math.round(distM)} m` : `${(distM/1000).toFixed(1)} km`,
      durationText: durS < 60 ? `${Math.round(durS)} sec` : `${Math.ceil(durS/60)} mins`,
      durationMins: Math.ceil(durS / 60),
    };
  } catch (e) {
    console.warn('OSRM routing failed:', e);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════
//  GPS TRACKING
// ═══════════════════════════════════════════════════════════════════
function startGPS() {
  if (!navigator.geolocation) {
    setGPSUI(false, 'GPS not supported');
    return;
  }

  STATE.gpsWatchId = navigator.geolocation.watchPosition(
    (position) => {
      const pos = {
        lat: position.coords.latitude,
        lng: position.coords.longitude,
      };
      STATE.currentPos = pos;
      STATE.gpsActive  = true;
      setGPSUI(true, `${pos.lat.toFixed(5)}, ${pos.lng.toFixed(5)}`);
      updateLocationLinks(pos);
      updateJunctionDistance();
      updateHospitalDashboard();
    },
    (err) => {
      STATE.gpsActive = false;
      const msgs = {
        1: 'GPS permission denied',
        2: 'GPS signal unavailable',
        3: 'GPS timeout',
      };
      setGPSUI(false, msgs[err.code] || 'GPS error');
    },
    { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 }
  );
}

function setGPSUI(active, text) {
  const dot   = document.getElementById('gps-dot');
  const label = document.getElementById('gps-label');
  const val   = document.getElementById('gps-coords');

  dot.className   = 'indicator-dot ' + (active ? 'active' : 'error');
  label.textContent = 'GPS';
  if (val) val.textContent = text || '—';

  const card = document.getElementById('card-gps');
  if (card) card.className = 'status-card ' + (active ? 'active' : 'error');
}

function updateLocationLinks(pos) {
  // Update map coords bar
  const latEl   = document.getElementById('coord-lat');
  const lngEl   = document.getElementById('coord-lng');
  const dot     = document.getElementById('location-pulse-dot');
  const ambLink = document.getElementById('ambulance-maps-link');

  if (latEl) latEl.textContent = pos.lat.toFixed(5);
  if (lngEl) lngEl.textContent = pos.lng.toFixed(5);
  if (dot)   dot.classList.add('active');
  if (ambLink) ambLink.href = mapsLocationLink(pos.lat, pos.lng);

  // Move ambulance marker on Leaflet map
  updateAmbulanceOnMap(pos);

  // If hospital is selected, refresh directions link
  if (STATE.selectedHospital?.lat) updateHospitalLinks();
}

// ═══════════════════════════════════════════════════════════════════
//  HAVERSINE FORMULA — Junction Distance
// ═══════════════════════════════════════════════════════════════════
function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const φ1 = lat1 * Math.PI / 180;
  const φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(Δφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(Δλ/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function updateJunctionDistance() {
  if (!STATE.currentPos || !CONFIG.junctionLat || !CONFIG.junctionLng) {
    document.getElementById('junction-dist').textContent = 'No junction set';
    return;
  }

  const dist = haversineMeters(
    STATE.currentPos.lat, STATE.currentPos.lng,
    CONFIG.junctionLat, CONFIG.junctionLng
  );

  const el = document.getElementById('junction-dist');
  if (dist < 1000) {
    el.textContent = `${Math.round(dist)} m`;
  } else {
    el.textContent = `${(dist / 1000).toFixed(2)} km`;
  }

  // Auto-trigger EMG_ON if within radius
  if (STATE.emergencyActive && dist <= CONFIG.junctionRadius && STATE.trafficState !== 'emg_on') {
    sendBLECommand('EMG_ON');
    toast(`🚦 Junction in range (${Math.round(dist)}m) — EMG_ON sent!`, 'warning', 4000);
  }
}

// ═══════════════════════════════════════════════════════════════════
//  TRAFFIC LIGHT UI SIMULATION
// ═══════════════════════════════════════════════════════════════════
const NORMAL_CYCLE = [
  { s1: 'green',  s2: 'red',    duration: 4000 },
  { s1: 'yellow', s2: 'red',    duration: 1500 },
  { s1: 'red',    s2: 'green',  duration: 4000 },
  { s1: 'red',    s2: 'yellow', duration: 1500 },
];

function startNormalTrafficCycle() {
  clearTimeout(STATE.normalCycleTimer);
  if (STATE.trafficState !== 'normal') return;

  const step = NORMAL_CYCLE[STATE.normalCycleStep % NORMAL_CYCLE.length];
  setTrafficLightUI(1, step.s1);
  setTrafficLightUI(2, step.s2);
  STATE.normalCycleStep++;
  STATE.normalCycleTimer = setTimeout(startNormalTrafficCycle, step.duration);
}

function setTrafficLightUI(signal, color) {
  const prefix = `tl${signal}-`;
  ['red','yellow','green'].forEach(c => {
    const el = document.getElementById(prefix + c);
    if (el) el.className = `tl-light ${c}${c === color ? ' on' : ''}`;
  });
}

function activateEmergencyTrafficUI() {
  clearTimeout(STATE.normalCycleTimer);
  setTrafficLightUI(1, 'green');
  setTrafficLightUI(2, 'green');
  STATE.trafficState = 'emg_on';
}

function deactivateEmergencyTrafficUI() {
  STATE.trafficState = 'normal';
  STATE.normalCycleStep = 0;
  startNormalTrafficCycle();
}

// ═══════════════════════════════════════════════════════════════════
//  WEB BLUETOOTH — ESP32 BLE CONTROL
// ═══════════════════════════════════════════════════════════════════
async function connectBluetooth() {
  if (!navigator.bluetooth) {
    toast('❌ Web Bluetooth not supported. Open in Chrome or Edge on desktop/Android.', 'error', 6000);
    return;
  }

  try {
    setBTUI('connecting', 'Opening Bluetooth picker…');
    toast('📡 Select your ESP32 from the list', 'info', 4000);

    // Accept ANY Bluetooth device so the picker shows all nearby devices,
    // not just those advertising the specific service UUID.
    // The service is added as optional so Chrome can still access it.
    const device = await navigator.bluetooth.requestDevice({
      acceptAllDevices: true,
      optionalServices: [
        BLE_SERVICE_UUID,
        // Also add well-known short UUIDs in case ESP32 uses them
        0xFFE0, 0xFFE1,
        'battery_service',
        'generic_access',
      ],
    });

    STATE.bluetoothDevice = device;
    setBTUI('connecting', `⏳ Connecting to ${device.name || 'ESP32'}…`);
    toast(`🔗 Found: ${device.name || 'Unknown device'} — connecting GATT…`, 'info', 5000);

    device.addEventListener('gattserverdisconnected', onBLEDisconnected);

    // STEP 1: Connect to GATT server
    let server;
    try {
      server = await device.gatt.connect();
      console.log('✅ GATT server connected');
    } catch (e) {
      throw new Error(`GATT connect failed: ${e.message}`);
    }

    // STEP 2: Get primary service
    let service;
    try {
      service = await server.getPrimaryService(BLE_SERVICE_UUID);
      console.log('✅ Service found:', BLE_SERVICE_UUID);
    } catch (e) {
      // List available services to help debug
      console.warn('❌ Primary service not found. Trying to list all services…');
      toast(`⚠️ Service ${BLE_SERVICE_UUID} not found on ESP32. Check firmware UUID.`, 'error', 8000);
      throw new Error(`Service UUID mismatch. ESP32 must advertise: ${BLE_SERVICE_UUID}`);
    }

    // STEP 3: Get characteristic
    let characteristic;
    try {
      characteristic = await service.getCharacteristic(BLE_CHAR_UUID);
      console.log('✅ Characteristic found:', BLE_CHAR_UUID);
    } catch (e) {
      toast(`⚠️ Characteristic ${BLE_CHAR_UUID} not found. Check firmware.`, 'error', 8000);
      throw new Error(`Characteristic UUID mismatch: ${BLE_CHAR_UUID}`);
    }

    STATE.bleCharacteristic = characteristic;
    STATE.bleConnected      = true;

    setBTUI('connected', `Connected: ${device.name || 'ESP32'}`);
    document.getElementById('emg-on-btn').disabled  = false;
    document.getElementById('emg-off-btn').disabled = false;
    document.getElementById('bt-connect-btn').textContent = `📡 ${device.name || 'ESP32'}`;
    document.getElementById('bt-connect-btn').classList.add('connected');

    toast(`✅ Bluetooth connected to ${device.name || 'ESP32'}`, 'success', 4000);

  } catch (err) {
    STATE.bleConnected = false;
    if (err.name === 'NotFoundError' || err.name === 'AbortError') {
      // User cancelled the picker — silent
      setBTUI('idle', 'Not connected — click Connect ESP32');
    } else {
      console.error('BLE Error:', err);
      setBTUI('error', err.message);
      toast(`❌ BLE: ${err.message}`, 'error', 8000);
    }
  }
}

function onBLEDisconnected() {
  STATE.bleConnected = false;
  STATE.bleCharacteristic = null;
  setBTUI('error', 'Disconnected');
  document.getElementById('emg-on-btn').disabled  = true;
  document.getElementById('emg-off-btn').disabled = true;
  document.getElementById('bt-connect-btn').classList.remove('connected');
  document.getElementById('bt-connect-btn').textContent = '📡 Connect ESP32';
  toast('⚠️ Bluetooth disconnected', 'warning');
}

async function sendBLECommand(command) {
  if (!STATE.bleConnected || !STATE.bleCharacteristic) {
    // Simulate in UI for demo
    if (command === 'EMG_ON')  activateEmergencyTrafficUI();
    if (command === 'EMG_OFF') deactivateEmergencyTrafficUI();
    toast(`📡 BLE (simulated): ${command}`, 'info');
    return;
  }

  try {
    const encoder = new TextEncoder();
    const data    = encoder.encode(command);

    // Try writeValueWithoutResponse first (faster, most ESP32 setups use it)
    // Fall back to writeValue if characteristic doesn’t support it
    const props = STATE.bleCharacteristic.properties;
    if (props.writeWithoutResponse) {
      await STATE.bleCharacteristic.writeValueWithoutResponse(data);
    } else {
      await STATE.bleCharacteristic.writeValue(data);
    }

    if (command === 'EMG_ON')  activateEmergencyTrafficUI();
    if (command === 'EMG_OFF') deactivateEmergencyTrafficUI();
    toast(`✅ Sent to ESP32: ${command}`, 'success');
  } catch (err) {
    toast(`❌ BLE write failed: ${err.message}`, 'error');
    // If device disconnected silently, reset state
    if (err.message.includes('disconnected') || err.message.includes('GATT')) {
      onBLEDisconnected();
    }
  }
}

function setBTUI(status, text) {
  const dot    = document.getElementById('bt-dot');
  const detail = document.getElementById('bt-detail-status');
  const val    = document.getElementById('bt-status');

  const dotClass = { connected: 'active', error: 'error', connecting: 'warn', idle: '' }[status] || '';
  if (dot) dot.className = `pill-dot ${dotClass}`;   // new design uses pill-dot
  if (val)    val.textContent    = text || '—';
  if (detail) detail.textContent = text || '—';
}

function updateBTStatusUI() {
  setBTUI('idle', 'Not connected — click Connect ESP32');
}

// ═══════════════════════════════════════════════════════════════════
//  VOICE ENGINE (Web Speech API)
// ═══════════════════════════════════════════════════════════════════
let recognition      = null;
let recognitionStopped = true;

function initVoiceEngine() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    toast('❌ Voice recognition not supported. Use Chrome or Edge.', 'error', 6000);
    return false;
  }

  recognition = new SpeechRecognition();
  recognition.continuous     = true;
  recognition.interimResults = true;
  recognition.lang           = 'en-US';
  recognition.maxAlternatives = 1;

  recognition.onstart = () => {
    STATE.voiceListening = true;
    recognitionStopped   = false;
    setOrbState('listening');
    setVoiceStatus('🎙️ Listening... speak an emergency scene');
    document.getElementById('voice-toggle-btn').textContent = '⏹️ Stop Listening';
    document.getElementById('voice-toggle-btn').classList.add('active');
  };

  recognition.onresult = async (event) => {
    let interim = '';
    let final   = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const r = event.results[i];
      if (r.isFinal) final += r[0].transcript;
      else interim += r[0].transcript;
    }
    if (interim) document.getElementById('voice-transcript').textContent = interim;
    if (final) {
      document.getElementById('voice-transcript').textContent = final;
      await handleVoiceInput(final.trim());
    }
  };

  recognition.onerror = (event) => {
    if (event.error === 'not-allowed') {
      recognitionStopped = true;
      toast('❌ Microphone permission denied. Please allow mic access.', 'error', 6000);
      setOrbState('idle');
      setVoiceStatus('Microphone access denied');
    }
    // 'no-speech' and 'network' are transient — let onend restart
  };

  recognition.onend = () => {
    if (!recognitionStopped) {
      // Auto-restart for continuous mode
      try { recognition.start(); } catch(e) {}
    } else {
      STATE.voiceListening = false;
      setOrbState(STATE.emergencyActive ? 'emergency' : 'idle');
      setVoiceStatus('Voice stopped — tap to restart');
      document.getElementById('voice-toggle-btn').textContent = '🎙️ Start Listening';
      document.getElementById('voice-toggle-btn').classList.remove('active');
    }
  };

  return true;
}

function toggleVoice() {
  if (!recognition) {
    const ok = initVoiceEngine();
    if (!ok) return;
  }

  if (STATE.voiceListening) {
    recognitionStopped = true;
    recognition.stop();
  } else {
    recognitionStopped = false;
    try { recognition.start(); }
    catch(e) { recognition = null; initVoiceEngine(); recognition?.start(); }
  }
}

function setOrbState(state) {
  const orb = document.getElementById('voice-orb');
  orb.className = `voice-orb ${state}`;
  const icons = { idle: '🎙️', listening: '🎙️', thinking: '🤖', speaking: '🔊', emergency: '🚨' };
  document.getElementById('orb-icon').textContent = icons[state] || '🎙️';
}

function setVoiceStatus(text) {
  document.getElementById('voice-status').textContent = text;
}

// ═══════════════════════════════════════════════════════════════════
//  GEMINI AI BRAIN
// ═══════════════════════════════════════════════════════════════════
const SYSTEM_PROMPT = `You are the AI dispatcher for a Smart Ambulance emergency response system.

When given a voice description of an emergency scene, analyze it and return ONLY a valid JSON object (no markdown, no code fences, no explanation — pure JSON).

JSON structure:
{
  "emergencyType": "cardiac_arrest|trauma|stroke|respiratory|fire|accident|unknown",
  "severityLevel": 1,
  "patientCount": 1,
  "patientCondition": "brief medical description",
  "actions": [
    {
      "type": "ACTIVATE_EMERGENCY",
      "reason": "why emergency mode"
    },
    {
      "type": "BLE_COMMAND",
      "command": "EMG_ON"
    },
    {
      "type": "FIND_HOSPITAL",
      "specialization": "trauma_center|cardiac_center|burn_unit|general"
    },
    {
      "type": "SEND_SMS"
    },
    {
      "type": "VOICE_RESPONSE",
      "message": "message to speak aloud to the crew"
    }
  ],
  "recommendedProtocol": "ACLS|ATLS|STROKE|TRAUMA|STANDARD",
  "aiSummary": "1-2 sentence summary of situation and what AI is doing"
}

RULES:
- severityLevel 1-5 (1=minor, 5=critical)
- For severity >= 3, ALWAYS include in this exact order: ACTIVATE_EMERGENCY, BLE_COMMAND EMG_ON, FIND_HOSPITAL, SEND_SMS, VOICE_RESPONSE
- FIND_HOSPITAL automatically calculates and shows the route on the map — do NOT add a separate GET_ROUTE action
- For cardiac/chest pain, recommend cardiac_center specialization
- For accidents/trauma, recommend trauma_center specialization
- Always include VOICE_RESPONSE with a clear crew instruction mentioning what the AI is doing
- For de-escalation commands like "turn off", "end emergency", "all clear": include BLE_COMMAND EMG_OFF and DEACTIVATE_EMERGENCY
- For simple questions (what's ETA, status, hospital info), respond with VOICE_RESPONSE only
- Never include text outside the JSON`;

async function callGeminiAI(transcript) {
  if (!CONFIG.geminiKey) {
    toast('⚙️ Enter your Gemini API key in Settings to enable AI', 'warning', 5000);
    return null;
  }

  const userPrompt = `Emergency voice input: "${transcript}"
Current ambulance location: ${STATE.currentPos ? `Lat ${STATE.currentPos.lat.toFixed(5)}, Lng ${STATE.currentPos.lng.toFixed(5)}` : 'Unknown'}
Emergency mode: ${STATE.emergencyActive ? 'ACTIVE' : 'OFF'}
Bluetooth traffic control: ${STATE.bleConnected ? 'Connected' : 'Not connected'}
Selected hospital: ${STATE.selectedHospital ? STATE.selectedHospital.name : 'None'}
Current ETA: ${STATE.routeETA || 'Unknown'}
Time: ${new Date().toLocaleTimeString()}`;

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.7-flash:generateContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': CONFIG.geminiKey,
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
          generationConfig: {
            responseMimeType: 'application/json',
            temperature: 0.1,
            maxOutputTokens: 1024,
          },
        }),
      }
    );

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error?.message || `HTTP ${response.status}`);
    }

    const data = await response.json();
    const jsonText = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!jsonText) throw new Error('Empty AI response');
    return JSON.parse(jsonText);
  } catch (err) {
    toast(`❌ Gemini AI error: ${err.message}`, 'error', 5000);
    console.error('Gemini error:', err);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════
//  VOICE INPUT PIPELINE
// ═══════════════════════════════════════════════════════════════════
async function handleVoiceInput(transcript) {
  if (!transcript) return;

  setOrbState('thinking');
  setVoiceStatus('🤖 AI analyzing...');
  showAIThinking();

  const aiResult = await callGeminiAI(transcript);
  if (!aiResult) {
    setOrbState('listening');
    setVoiceStatus('🎙️ Listening...');
    return;
  }

  displayAIResponse(aiResult);
  await dispatchAIActions(aiResult);

  setOrbState(STATE.emergencyActive ? 'emergency' : 'listening');
  setVoiceStatus(STATE.emergencyActive ? '🚨 Emergency Active — listening...' : '🎙️ Listening...');
}

function showAIThinking() {
  const panel = document.getElementById('ai-response');
  panel.innerHTML = '<span style="color:var(--clr-text-muted)">⏳ Analyzing emergency scene...</span>';
  document.getElementById('ai-streaming').classList.remove('hidden');
  document.getElementById('ai-action-chips').innerHTML = '';
}

function displayAIResponse(result) {
  const panel = document.getElementById('ai-response');
  const chips  = document.getElementById('ai-action-chips');

  panel.innerHTML = `
    <div style="margin-bottom:8px">
      <span style="color:var(--clr-warning);font-weight:700">
        ${severityBadge(result.severityLevel)} ${result.emergencyType?.replace(/_/g,' ').toUpperCase() || 'RESPONSE'}
      </span>
    </div>
    <div>${result.aiSummary || ''}</div>
    ${result.patientCondition ? `<div style="margin-top:8px;color:var(--clr-text-muted);font-size:13px">Patient: ${result.patientCondition}</div>` : ''}
  `;

  chips.innerHTML = '';
  (result.actions || []).forEach(action => {
    const chip = document.createElement('div');
    chip.className = 'action-chip pending';
    chip.id = `chip-${action.type}`;
    chip.textContent = actionLabel(action);
    chips.appendChild(chip);
  });

  document.getElementById('ai-streaming').classList.add('hidden');
}

function severityBadge(level) {
  const badges = ['', '🟢', '🟡', '🟠', '🔴', '🆘'];
  return badges[Math.min(level || 1, 5)];
}

function actionLabel(action) {
  const labels = {
    ACTIVATE_EMERGENCY: '🚨 Activating Emergency',
    BLE_COMMAND:        `📡 ${action.command || 'BLE'}`,
    FIND_HOSPITAL:      '🏥 Finding Hospital',
    GET_ROUTE:          '🗺️ Calculating Route',
    SEND_SMS:           '💬 Preparing SMS',
    VOICE_RESPONSE:     '🔊 Speaking',
    DEACTIVATE_EMERGENCY: '✅ Ending Emergency',
  };
  return labels[action.type] || action.type;
}

function markChipDone(type) {
  const chip = document.getElementById(`chip-${type}`);
  if (chip) chip.className = 'action-chip done';
}

// ═══════════════════════════════════════════════════════════════════
//  AI ACTION DISPATCHER
// ═══════════════════════════════════════════════════════════════════
async function dispatchAIActions(result) {
  const actions = result.actions || [];
  let hospitalSearchDone = false;

  for (const action of actions) {
    switch (action.type) {

      case 'ACTIVATE_EMERGENCY':
        activateEmergencyMode(result.patientCondition || result.aiSummary || '');
        markChipDone('ACTIVATE_EMERGENCY');
        await delay(300);
        break;

      case 'DEACTIVATE_EMERGENCY':
        deactivateEmergencyMode();
        markChipDone('DEACTIVATE_EMERGENCY');
        break;

      case 'BLE_COMMAND':
        await sendBLECommand(action.command || 'EMG_ON');
        markChipDone('BLE_COMMAND');
        await delay(300);
        break;

      case 'FIND_HOSPITAL':
        // Hospital search also draws the route automatically inside showHospitalCard()
        addChipIfMissing('FIND_HOSPITAL', '🏥 Finding Best Hospital');
        await searchHospitals(action.specialization || 'general');
        markChipDone('FIND_HOSPITAL');
        hospitalSearchDone = true;
        break;

      case 'GET_ROUTE':
        // Route is now drawn inside FIND_HOSPITAL — nothing extra needed
        markChipDone('GET_ROUTE');
        break;

      case 'SEND_SMS':
        prepareSMS();
        markChipDone('SEND_SMS');
        break;

      case 'VOICE_RESPONSE':
        if (action.message) {
          speakText(action.message);
          markChipDone('VOICE_RESPONSE');
        }
        break;
    }
    await delay(200);
  }

  // —— AUTO-GUARANTEE: if emergency is active but AI forgot FIND_HOSPITAL, run it now ——
  if (STATE.emergencyActive && !hospitalSearchDone && !STATE.selectedHospital) {
    addChipIfMissing('FIND_HOSPITAL', '🏥 Finding Best Hospital');
    toast('🔍 Auto-searching nearest hospital...', 'info', 3000);
    await delay(400);
    await searchHospitals('general');
    markChipDone('FIND_HOSPITAL');
  }
}

// Inject a UI chip if it isn’t already shown
function addChipIfMissing(type, label) {
  if (document.getElementById(`chip-${type}`)) return;
  const chips = document.getElementById('ai-action-chips');
  if (!chips) return;
  const chip = document.createElement('div');
  chip.className = 'action-chip pending';
  chip.id = `chip-${type}`;
  chip.textContent = label;
  chips.appendChild(chip);
}

// ═══════════════════════════════════════════════════════════════════
//  EMERGENCY MODE
// ═══════════════════════════════════════════════════════════════════
function activateEmergencyMode(condition) {
  if (STATE.emergencyActive) return;
  STATE.emergencyActive = true;
  if (condition) STATE.patientCondition = condition;

  document.getElementById('emg-badge').classList.remove('hidden');
  document.getElementById('emg-flash').classList.remove('hidden');
  document.getElementById('tab-hospital').style.color = '#ef4444';

  // Hospital dashboard alert
  document.getElementById('hosp-alert-banner').classList.remove('hidden');
  document.getElementById('hdash-emg-status').textContent = '🚨 EN ROUTE';
  document.getElementById('hdash-patient').textContent = STATE.patientCondition || 'Undisclosed';

  // Nearby alert tab
  document.getElementById('nearby-standby').classList.add('hidden');
  document.getElementById('nearby-alert').classList.remove('hidden');

  toast('🚨 EMERGENCY MODE ACTIVATED', 'error', 8000);
}

function deactivateEmergencyMode() {
  STATE.emergencyActive = false;
  sendBLECommand('EMG_OFF');

  document.getElementById('emg-badge').classList.add('hidden');
  document.getElementById('emg-flash').classList.add('hidden');
  document.getElementById('tab-hospital').style.color = '';

  document.getElementById('hosp-alert-banner').classList.add('hidden');
  document.getElementById('hdash-emg-status').textContent = 'Standby';

  document.getElementById('nearby-standby').classList.remove('hidden');
  document.getElementById('nearby-alert').classList.add('hidden');

  toast('✅ Emergency ended — normal operations resumed', 'success', 5000);
}

// ═══════════════════════════════════════════════════════════════════
//  HOSPITAL SEARCH — Multi-strategy (Nominatim → Overpass → Proxy)
// ═══════════════════════════════════════════════════════════════════

function buildOSMAddress(tags = {}) {
  return [
    tags['addr:housenumber'], tags['addr:street'],
    tags['addr:suburb'], tags['addr:city'],
    tags['addr:state'], tags['addr:postcode'],
  ].filter(Boolean).join(', ') || tags['addr:full'] || tags['addr:street'] || '';
}

// Convert a Nominatim result into our standard hospital object
function nominatimToHospital(item, lat, lng) {
  const bb = item.boundingbox || [];
  const hLat = parseFloat(item.lat);
  const hLng = parseFloat(item.lon);
  return {
    name:         item.display_name?.split(',')[0] || item.name || 'Hospital',
    address:      item.display_name?.split(',').slice(1, 4).join(',').trim() || '',
    phone:        item.extratags?.phone || item.extratags?.['contact:phone'] || '',
    website:      item.extratags?.website || '',
    emergency:    item.extratags?.emergency === 'yes',
    operator:     item.extratags?.operator || '',
    beds:         item.extratags?.beds || '',
    speciality:   item.extratags?.['healthcare:speciality'] || '',
    openingHours: item.extratags?.opening_hours || '',
    healthcare:   item.type || 'hospital',
    lat: hLat, lng: hLng,
    dist: haversineMeters(lat, lng, hLat, hLng),
  };
}

// STRATEGY 1: Nominatim — OSM's official search API, best CORS support
async function searchViaNominatim(lat, lng, radiusKm = 20) {
  const delta = radiusKm / 111; // approx degrees for bounding box
  const viewbox = `${lng - delta},${lat + delta},${lng + delta},${lat - delta}`;
  const url = `https://nominatim.openstreetmap.org/search?` +
    `q=hospital&format=jsonv2&limit=15&addressdetails=1&extratags=1` +
    `&bounded=1&viewbox=${viewbox}&lat=${lat}&lon=${lng}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  const res = await fetch(url, {
    signal: controller.signal,
    headers: { 'Accept-Language': 'en', 'User-Agent': 'SmartAmbulanceAI/1.0' },
  });
  clearTimeout(timer);
  if (!res.ok) throw new Error(`Nominatim HTTP ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data) || !data.length) throw new Error('No results from Nominatim');

  return data
    .map(item => nominatimToHospital(item, lat, lng))
    .filter(h => !isNaN(h.lat))
    .sort((a, b) => a.dist - b.dist);
}

// STRATEGY 2: Overpass API via POST (correct method per API spec)
async function searchViaOverpassPOST(lat, lng, radiusM = 20000) {
  const ql = `[out:json][timeout:25];(node["amenity"="hospital"](around:${radiusM},${lat},${lng});way["amenity"="hospital"](around:${radiusM},${lat},${lng});relation["amenity"="hospital"](around:${radiusM},${lat},${lng}););out center tags;`;

  const endpoints = [
    'https://overpass-api.de/api/interpreter',
    'https://lz4.overpass-api.de/api/interpreter',
  ];

  let lastErr;
  for (const ep of endpoints) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 18000);
      const res = await fetch(ep, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(ql),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!Array.isArray(data.elements)) throw new Error('Bad Overpass response');

      const results = data.elements
        .map(el => {
          const elLat = el.lat ?? el.center?.lat;
          const elLng = el.lon ?? el.center?.lon;
          const t = el.tags || {};
          return {
            name:         t.name || 'Unnamed Hospital',
            address:      buildOSMAddress(t),
            phone:        t.phone || t['contact:phone'] || t['contact:mobile'] || '',
            website:      t.website || t['contact:website'] || '',
            emergency:    t.emergency === 'yes',
            operator:     t.operator || '',
            beds:         t.beds || '',
            speciality:   t['healthcare:speciality'] || t.speciality || '',
            openingHours: t.opening_hours || '',
            healthcare:   t.healthcare || 'hospital',
            lat: elLat, lng: elLng,
            dist: elLat != null ? haversineMeters(lat, lng, elLat, elLng) : Infinity,
          };
        })
        .filter(h => h.lat != null)
        .sort((a, b) => ((a.emergency ? 0 : 8000) + a.dist) - ((b.emergency ? 0 : 8000) + b.dist));

      if (!results.length) throw new Error('Empty Overpass results');
      return results;
    } catch (e) { lastErr = e; console.warn(`Overpass POST ${ep} failed:`, e.message); }
  }
  throw lastErr;
}

// STRATEGY 3: Overpass via public CORS proxy as last resort
async function searchViaProxy(lat, lng, radiusM = 20000) {
  const ql = `[out:json][timeout:25];(node["amenity"="hospital"](around:${radiusM},${lat},${lng}););out tags;`;
  const target = `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(ql)}`;
  const proxied = `https://corsproxy.io/?url=${encodeURIComponent(target)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  const res = await fetch(proxied, { signal: controller.signal });
  clearTimeout(timer);
  if (!res.ok) throw new Error(`Proxy HTTP ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data.elements) || !data.elements.length) throw new Error('Empty proxy result');

  return data.elements
    .filter(el => el.lat && el.tags?.name)
    .map(el => ({
      name: el.tags.name, address: buildOSMAddress(el.tags),
      phone: el.tags.phone || '', website: '', emergency: false,
      operator: '', beds: '', speciality: '', openingHours: '',
      healthcare: 'hospital', lat: el.lat, lng: el.lon,
      dist: haversineMeters(lat, lng, el.lat, el.lon),
    }))
    .sort((a, b) => a.dist - b.dist);
}

// Main search — tries all three strategies in order
async function searchHospitalsOverpass(lat, lng) {
  // Strategy 1: Nominatim (best CORS support)
  try {
    const results = await searchViaNominatim(lat, lng);
    if (results.length) { console.log('✅ Nominatim found', results.length, 'hospitals'); return results; }
  } catch (e) { console.warn('Nominatim failed:', e.message); }

  // Strategy 2: Overpass POST
  try {
    const results = await searchViaOverpassPOST(lat, lng);
    if (results.length) { console.log('✅ Overpass POST found', results.length, 'hospitals'); return results; }
  } catch (e) { console.warn('Overpass POST failed:', e.message); }

  // Strategy 3: CORS proxy
  try {
    const results = await searchViaProxy(lat, lng);
    if (results.length) { console.log('✅ Proxy found', results.length, 'hospitals'); return results; }
  } catch (e) { console.warn('Proxy failed:', e.message); }

  throw new Error('All search strategies failed');
}

async function searchHospitals(specialization = 'general') {
  // Use live GPS if available, otherwise fall back to Lucknow default location
  const searchPos = STATE.currentPos || DEFAULT_POS;
  const usingDefault = !STATE.currentPos;

  if (usingDefault) {
    toast(`📍 GPS not ready — searching near ${DEFAULT_POS.label}`, 'warning', 4000);
    STATE.currentPos = DEFAULT_POS;
  }

  toast('🔍 Searching hospitals near your location...', 'info', 5000);

  try {
    const hospitals = await searchHospitalsOverpass(searchPos.lat, searchPos.lng);

    if (!hospitals.length) {
      toast('⚠️ No hospitals found within 20 km — trying fallback', 'warning');
      await searchHospitalsFallback();
      return;
    }

    // Store all results so user can switch between them
    STATE.nearbyHospitals  = hospitals.slice(0, 6);   // keep top 6
    STATE.selectedHospital = hospitals[0];             // auto-select best

    toast(`🏥 Found ${hospitals.length} nearby hospitals — best selected`, 'success', 4000);
    renderHospitalList();
    await showHospitalCard();
    switchTab('hospital');                             // jump to hospital tab

  } catch (err) {
    console.error('Hospital search error:', err);
    toast(`⚠️ Search failed: ${err.message} — trying fallback`, 'warning', 6000);
    await searchHospitalsFallback();
  }
}

// ═══════════════════════════════════════════════════════════════════
//  HOSPITAL LIST — ranked cards the user can tap to switch
// ═══════════════════════════════════════════════════════════════════
function renderHospitalList() {
  const list = document.getElementById('hospital-list');
  if (!list) return;

  const hospitals = STATE.nearbyHospitals || [];
  if (!hospitals.length) { list.innerHTML = ''; return; }

  list.innerHTML = hospitals.map((h, i) => {
    const distKm  = h.dist != null ? (h.dist < 1000 ? Math.round(h.dist) + ' m' : (h.dist/1000).toFixed(1) + ' km') : '';
    const isSelected = STATE.selectedHospital === h || STATE.selectedHospital?.name === h.name;
    const emgBadge   = h.emergency ? '<span class="hl-badge emg">🚨 Emergency</span>' : '';
    const rank = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `#${i+1}`;

    return `
      <div class="hospital-list-item${isSelected ? ' selected' : ''}" data-idx="${i}" onclick="selectHospital(${i})">
        <div class="hli-rank">${rank}</div>
        <div class="hli-body">
          <div class="hli-name">${h.name}</div>
          <div class="hli-meta">
            ${distKm ? `<span class="hli-dist">📍 ${distKm}</span>` : ''}
            ${emgBadge}
            ${h.speciality ? `<span class="hl-badge spec">⚕️ ${h.speciality.split(';')[0]}</span>` : ''}
          </div>
          ${h.address ? `<div class="hli-addr">${h.address}</div>` : ''}
        </div>
        <div class="hli-arrow">${isSelected ? '✔️' : '❯'}</div>
      </div>`;
  }).join('');
}

async function selectHospital(idx) {
  const h = (STATE.nearbyHospitals || [])[idx];
  if (!h) return;
  STATE.selectedHospital = h;
  renderHospitalList();          // refresh selection highlight
  await showHospitalCard();      // redraw map + route for new hospital
  announceHospitalFound();       // voice announce new selection
  toast(`🏥 Switched to: ${h.name}`, 'success', 3000);
}

async function searchHospitalsFallback() {
  const pos = STATE.currentPos || DEFAULT_POS;

  // Fallback 1: Places API (if key is set)
  if (CONFIG.placesKey) {
    try {
      const res  = await fetch('https://places.googleapis.com/v1/places:searchNearby', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': CONFIG.placesKey,
          'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.location,places.internationalPhoneNumber',
        },
        body: JSON.stringify({
          includedTypes: ['hospital'],
          maxResultCount: 5,
          locationRestriction: {
            circle: {
              center: { latitude: pos.lat, longitude: pos.lng },
              radius: 15000,
            }
          }
        })
      });
      const data = await res.json();
      const best = (data.places || [])[0];
      if (best) {
        STATE.selectedHospital = {
          name:      best.displayName?.text || 'Hospital',
          address:   best.formattedAddress  || '',
          phone:     best.internationalPhoneNumber || CONFIG.hospitalPhone || '',
          lat:       best.location?.latitude,
          lng:       best.location?.longitude,
          emergency: false, operator: '', beds: '', speciality: '',
          openingHours: '', website: '',
          dist: haversineMeters(pos.lat, pos.lng, best.location?.latitude, best.location?.longitude),
        };
        await showHospitalCard();
        return;
      }
    } catch (e) { console.warn('Places API fallback error:', e); }
  }
  // Fallback 2: Manual config
  useFallbackHospital();
}

function useFallbackHospital() {
  if (CONFIG.hospitalName || CONFIG.hospitalPhone) {
    STATE.selectedHospital = {
      name:         CONFIG.hospitalName || 'Configured Hospital',
      address:      '',
      phone:        CONFIG.hospitalPhone || '',
      lat:          null, lng: null,
      emergency:    false,
      operator:     '', beds: '', speciality: '',
      openingHours: '', website: '', dist: null,
    };
    showHospitalCard();
  } else {
    toast('⚙️ No hospital configured. Please enter hospital details in Settings.', 'warning', 6000);
  }
}

async function showHospitalCard() {
  if (!STATE.selectedHospital) return;
  const h = STATE.selectedHospital;

  // — Basic fields —
  document.getElementById('hospital-name-display').textContent = h.name;
  document.getElementById('hospital-address').textContent     = h.address || 'Address not available';
  document.getElementById('hosp-phone').textContent           = h.phone  || 'N/A';
  document.getElementById('hospital-card').classList.remove('hidden');

  // — Status badges —
  const badgeContainer = document.getElementById('hospital-badges');
  if (badgeContainer) {
    badgeContainer.innerHTML = '';
    if (h.emergency) {
      badgeContainer.innerHTML += '<span class="hbadge hbadge-emergency">🚨 Emergency Dept</span>';
    }
    const type = h.healthcare ? h.healthcare.replace(/_/g,' ') : 'hospital';
    badgeContainer.innerHTML += `<span class="hbadge hbadge-type">🏥 ${type.charAt(0).toUpperCase()+type.slice(1)}</span>`;
    if (h.operator) {
      badgeContainer.innerHTML += `<span class="hbadge hbadge-operator">🏢 ${h.operator}</span>`;
    }
  }

  // — Extended detail rows —
  function setDetail(rowId, valId, value, transform) {
    const row = document.getElementById(rowId);
    const el  = document.getElementById(valId);
    if (!row || !el) return;
    if (value) {
      row.classList.remove('hidden');
      if (transform) transform(el, value);
      else el.textContent = value;
    } else {
      row.classList.add('hidden');
    }
  }

  setDetail('row-beds',      'hosp-beds',      h.beds);
  setDetail('row-speciality','hosp-speciality', h.speciality ? h.speciality.replace(/;/g, ', ') : '');
  setDetail('row-hours',     'hosp-hours',      h.openingHours);
  setDetail('row-website',   'hosp-website',    h.website, (el, v) => {
    el.href        = v.startsWith('http') ? v : 'https://' + v;
    el.textContent = v.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');
  });

  // — Google Maps links —
  const hospLocLink = document.getElementById('hospital-location-link');
  const dirLink     = document.getElementById('directions-maps-link');
  const pos         = STATE.currentPos;

  if (h.lat && h.lng) {
    if (hospLocLink) hospLocLink.href = mapsLocationLink(h.lat, h.lng, h.name);
    if (dirLink && pos) {
      dirLink.href = mapsDirectionsLink(pos.lat, pos.lng, h.lat, h.lng, h.name);
      dirLink.classList.remove('hidden');
    }
  } else if (h.name) {
    if (hospLocLink) hospLocLink.href = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(h.name)}`;
  }

  // — Put hospital marker on Leaflet map —
  setHospitalOnMap(h);

  // — Draw route via OSRM (free) —
  if (pos && h.lat && h.lng) {
    const routeInfo = await drawRouteOnMap(pos.lat, pos.lng, h.lat, h.lng);
    if (routeInfo) {
      STATE.routeDistance = routeInfo.distanceText;
      STATE.routeETA      = routeInfo.durationText;
      document.getElementById('hosp-distance').textContent = routeInfo.distanceText;
      document.getElementById('hosp-eta').textContent      = routeInfo.durationText;
      document.getElementById('eta-value').textContent     = routeInfo.durationText;
      document.getElementById('hdash-eta').textContent     = routeInfo.durationText;
      document.getElementById('hdash-dist').textContent    = routeInfo.distanceText;
      const nbDist = document.getElementById('nearby-dist-display');
      if (nbDist) nbDist.textContent = routeInfo.distanceText;
    } else {
      // Straight-line estimate as fallback
      const dist = straightLineDistText(pos.lat, pos.lng, h.lat, h.lng);
      STATE.routeDistance = dist;
      document.getElementById('hosp-distance').textContent = dist;
      document.getElementById('hdash-dist').textContent    = dist;
    }
  }

  prepareSMS();
  // Announce after a short delay so everything settles
  setTimeout(() => announceHospitalFound(), 1200);
}

// ═══════════════════════════════════════════════════════════════════
//  MAPS LINKS (Google Maps, no API key needed)
// ═══════════════════════════════════════════════════════════════════

function updateHospitalLinks() {
  const h   = STATE.selectedHospital;
  const pos = STATE.currentPos;
  if (!h) return;

  const hospLocLink  = document.getElementById('hospital-location-link');
  const hospDirLink  = document.getElementById('hospital-directions-link');
  const hospSVLink   = document.getElementById('hospital-streetview-link');
  const ambShareLink = document.getElementById('ambulance-share-link');
  const noteEl       = document.getElementById('hloc-note');

  if (h.lat && h.lng) {
    if (hospLocLink) hospLocLink.href = mapsLocationLink(h.lat, h.lng, h.name);
    if (hospSVLink)  hospSVLink.href  = mapsStreetViewLink(h.lat, h.lng);
    if (hospDirLink && pos) hospDirLink.href = mapsDirectionsLink(pos.lat, pos.lng, h.lat, h.lng, h.name);
  } else if (h.name) {
    if (hospLocLink) hospLocLink.href = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(h.name)}`;
    if (hospDirLink) hospDirLink.href = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(h.name)}&travelmode=driving`;
  }
  if (pos && ambShareLink) ambShareLink.href = mapsShareLink(pos.lat, pos.lng);
  if (noteEl) noteEl.textContent = h.name ? `Links ready — ${h.name}` : 'Links activate once hospital is selected.';

  if (pos && h.lat && h.lng) {
    const dist = straightLineDistText(pos.lat, pos.lng, h.lat, h.lng);
    if (!STATE.routeDistance) {
      STATE.routeDistance = dist;
      document.getElementById('hosp-distance').textContent = dist;
      document.getElementById('hdash-dist').textContent    = dist;
      const nbEl = document.getElementById('nearby-dist-display');
      if (nbEl) nbEl.textContent = dist;
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
//  VOICE ANNOUNCEMENT — Web Speech Synthesis API
// ═══════════════════════════════════════════════════════════════════

function speakText(text) {
  if (!window.speechSynthesis) return;
  window.speechSynthesis.cancel(); // stop any previous speech

  const btn = document.getElementById('announce-btn');
  if (btn) btn.classList.add('speaking');

  const utt  = new SpeechSynthesisUtterance(text);
  utt.lang   = 'en-IN';
  utt.rate   = 0.95;
  utt.pitch  = 1.0;
  utt.volume = 1.0;

  // Pick a clear voice if available
  const voices = window.speechSynthesis.getVoices();
  const preferred = voices.find(v =>
    v.lang.startsWith('en') && (v.name.includes('Female') || v.name.includes('Google') || v.name.includes('Zira'))
  ) || voices.find(v => v.lang.startsWith('en'));
  if (preferred) utt.voice = preferred;

  utt.onend = () => {
    if (btn) btn.classList.remove('speaking');
  };
  utt.onerror = () => {
    if (btn) btn.classList.remove('speaking');
  };

  window.speechSynthesis.speak(utt);
}

function announceHospitalFound() {
  const h = STATE.selectedHospital;
  if (!h) return;

  const eta     = STATE.routeETA      ? `Estimated driving time is ${STATE.routeETA}.` : '';
  const dist    = STATE.routeDistance ? `The hospital is ${STATE.routeDistance} away.`  : '';
  const emg     = h.emergency ? 'This hospital has an emergency department.' : '';
  const spec    = h.speciality ? `It specializes in ${h.speciality.replace(/;/g, ' and ')}.` : '';
  const beds    = h.beds   ? `The facility has ${h.beds} beds.` : '';
  const phone   = h.phone  ? `Contact number is ${h.phone.replace(/[+]/g, 'plus ').replace(/-/g, ', ')}.` : '';
  const cond    = STATE.patientCondition ? `Patient condition is reported as ${STATE.patientCondition}.` : '';

  const msg = [
    'Emergency route calculated.',
    `The best hospital nearby is ${h.name}.`,
    dist, eta, emg, spec, beds, phone, cond,
    'Route has been plotted on the map.',
    'S M S notification is ready to send.',
  ].filter(Boolean).join(' ').trim();

  speakText(msg);
  toast('🔊 Announcing hospital details...', 'info', 3000);
}

// ═══════════════════════════════════════════════════════════════════
//  HOSPITAL SMS — sms: URI scheme
// ═══════════════════════════════════════════════════════════════════
function prepareSMS() {
  const h       = STATE.selectedHospital;
  const phone   = h?.phone || CONFIG.hospitalPhone || '';
  const cond    = STATE.patientCondition || '[Not specified]';
  const eta     = STATE.routeETA || '[Calculating...]';
  const dist    = STATE.routeDistance || '';
  const locLink = STATE.currentPos
    ? `https://maps.google.com/?q=${STATE.currentPos.lat},${STATE.currentPos.lng}`
    : '[No GPS]';

  const msg = `🚨 EMERGENCY AMBULANCE ALERT

Patient condition: ${cond}
Ambulance location: ${locLink}
Distance to hospital: ${dist}
Estimated arrival: ${eta}

Please prepare the emergency department immediately.

— Robo Rangers Smart Ambulance System`;

  const previewEl = document.getElementById('sms-preview-body');
  const sendBtn   = document.getElementById('send-sms-btn');

  if (previewEl) previewEl.textContent = msg;
  if (sendBtn)   sendBtn.disabled = false;

  // Store for sending
  STATE._smsMessage = msg;
  STATE._smsPhone   = phone;
}

function sendSMS() {
  const phone = STATE._smsPhone || CONFIG.hospitalPhone;
  const msg   = STATE._smsMessage || 'EMERGENCY AMBULANCE EN ROUTE';

  if (!phone) {
    toast('⚠️ No hospital phone number. Set one in Settings.', 'warning', 5000);
    return;
  }

  const smsUri = `sms:${phone}?body=${encodeURIComponent(msg)}`;
  window.location.href = smsUri;
  toast(`📱 SMS composer opened for ${phone}`, 'success');
}

// ═══════════════════════════════════════════════════════════════════
//  TEXT TO SPEECH — AI Voice Responses
// ═══════════════════════════════════════════════════════════════════
function speakText(text) {
  if (!('speechSynthesis' in window)) return;
  speechSynthesis.cancel();
  setOrbState('speaking');

  const utter = new SpeechSynthesisUtterance(text);
  utter.rate   = 1.1;
  utter.pitch  = 1.0;
  utter.volume = 0.9;

  // Pick a good voice if available
  const voices = speechSynthesis.getVoices();
  const preferred = voices.find(v =>
    v.name.includes('Google') || v.name.includes('Natural') || v.lang === 'en-US'
  );
  if (preferred) utter.voice = preferred;

  utter.onend = () => {
    if (STATE.voiceListening) setOrbState('listening');
    else setOrbState(STATE.emergencyActive ? 'emergency' : 'idle');
  };

  speechSynthesis.speak(utter);
}

// ═══════════════════════════════════════════════════════════════════
//  HOSPITAL DASHBOARD — real-time updates
// ═══════════════════════════════════════════════════════════════════
function updateHospitalDashboard() {
  if (STATE.selectedHospital && STATE.routeETA) {
    document.getElementById('hdash-eta').textContent  = STATE.routeETA;
    document.getElementById('hdash-dist').textContent = STATE.routeDistance || '—';
  }
}

// ═══════════════════════════════════════════════════════════════════
//  DEMO MODE — works without real API keys
// ═══════════════════════════════════════════════════════════════════
async function runDemoScene() {
  const scenes = [
    'There has been a road accident at the intersection. Patient is unconscious with severe head trauma. Need hospital immediately.',
    'Patient has sudden chest pain and difficulty breathing, possible cardiac arrest. Start emergency protocol now.',
    'Child with high fever and seizures. Need pediatric emergency department.',
    'Emergency all clear. Patient delivered. Turn off traffic lights and end emergency mode.',
  ];

  const scene = scenes[Math.floor(Math.random() * scenes.length)];
  document.getElementById('voice-transcript').textContent = scene;
  setVoiceStatus('🎭 Demo scene activated');
  toast('🎭 Running demo scene...', 'info', 3000);

  await handleVoiceInput(scene);
}

// ═══════════════════════════════════════════════════════════════════
//  SETTINGS UI
// ═══════════════════════════════════════════════════════════════════
function populateSettingsUI() {
  document.getElementById('gemini-key').value      = CONFIG.geminiKey    || '';
  document.getElementById('places-key').value      = CONFIG.placesKey    || '';
  document.getElementById('junction-lat').value    = CONFIG.junctionLat  || '';
  document.getElementById('junction-lng').value    = CONFIG.junctionLng  || '';
  document.getElementById('junction-radius').value = CONFIG.junctionRadius || 300;
  document.getElementById('hospital-name').value   = CONFIG.hospitalName || '';
  document.getElementById('hospital-phone').value  = CONFIG.hospitalPhone || '';
}

function saveSettings() {
  CONFIG.geminiKey     = document.getElementById('gemini-key').value.trim();
  CONFIG.placesKey     = document.getElementById('places-key').value.trim();
  CONFIG.junctionLat   = parseFloat(document.getElementById('junction-lat').value) || null;
  CONFIG.junctionLng   = parseFloat(document.getElementById('junction-lng').value) || null;
  CONFIG.junctionRadius = parseInt(document.getElementById('junction-radius').value) || 300;
  CONFIG.hospitalName  = document.getElementById('hospital-name').value.trim();
  CONFIG.hospitalPhone = document.getElementById('hospital-phone').value.trim();
  CONFIG.save();
  closeSettings();
  toast('✅ Settings saved!', 'success');
}

function openSettings() {
  document.getElementById('settings-panel').classList.remove('hidden');
  document.getElementById('settings-overlay').classList.remove('hidden');
}

function closeSettings() {
  document.getElementById('settings-panel').classList.add('hidden');
  document.getElementById('settings-overlay').classList.add('hidden');
}

// ═══════════════════════════════════════════════════════════════════
//  TAB SWITCHING
// ═══════════════════════════════════════════════════════════════════
function switchTab(tab) {
  document.querySelectorAll('.tab').forEach(t => {
    t.classList.toggle('active', t.dataset.tab === tab);
    t.setAttribute('aria-selected', t.dataset.tab === tab);
  });
  document.querySelectorAll('.tab-content').forEach(c => {
    c.classList.toggle('active', c.id === `tab-content-${tab}`);
  });
}

// ═══════════════════════════════════════════════════════════════════
//  TOAST NOTIFICATIONS
// ═══════════════════════════════════════════════════════════════════
function toast(message, type = 'info', duration = 4000) {
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  const icons = { success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️' };

  el.className = `toast ${type}`;
  el.innerHTML = `<span>${icons[type] || 'ℹ️'}</span><span>${message}</span>`;
  container.appendChild(el);

  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transform = 'translateX(20px)';
    el.style.transition = 'all 0.3s';
    setTimeout(() => el.remove(), 300);
  }, duration);
}

// ═══════════════════════════════════════════════════════════════════
//  UTILITY
// ═══════════════════════════════════════════════════════════════════
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// ═══════════════════════════════════════════════════════════════════
//  EVENT BINDINGS
// ═══════════════════════════════════════════════════════════════════
function bindUIEvents() {
  // Settings
  document.getElementById('open-settings').addEventListener('click', openSettings);
  document.getElementById('close-settings').addEventListener('click', closeSettings);
  document.getElementById('settings-overlay').addEventListener('click', closeSettings);
  document.getElementById('save-settings').addEventListener('click', saveSettings);

  // Tabs
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
  });

  // Voice
  document.getElementById('voice-toggle-btn').addEventListener('click', toggleVoice);
  document.getElementById('demo-mode-btn').addEventListener('click', runDemoScene);

  // Voice orb click
  const orb = document.getElementById('voice-orb');
  orb.addEventListener('click', toggleVoice);
  orb.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') toggleVoice(); });

  // Bluetooth
  document.getElementById('bt-connect-btn').addEventListener('click', connectBluetooth);
  document.getElementById('emg-on-btn').addEventListener('click', () => sendBLECommand('EMG_ON'));
  document.getElementById('emg-off-btn').addEventListener('click', () => sendBLECommand('EMG_OFF'));

  // Hospital SMS
  document.getElementById('sms-hospital-btn').addEventListener('click', sendSMS);
  document.getElementById('send-sms-btn').addEventListener('click', sendSMS);

  // Hospital call
  document.getElementById('call-hospital-btn').addEventListener('click', () => {
    const phone = STATE.selectedHospital?.phone || CONFIG.hospitalPhone;
    if (phone) window.location.href = `tel:${phone}`;
    else toast('No hospital phone number available', 'warning');
  });

  // Hospital voice announcement
  document.getElementById('announce-btn').addEventListener('click', () => {
    if (!STATE.selectedHospital) {
      toast('🏥 Find a hospital first to announce details', 'warning');
      return;
    }
    announceHospitalFound();
  });

  // Keyboard shortcut: Space = toggle voice, E = emergency, Escape = end
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    if (e.code === 'Space') { e.preventDefault(); toggleVoice(); }
    if (e.key === 'Escape') { if (STATE.emergencyActive) deactivateEmergencyMode(); }
  });
}
