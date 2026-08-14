/**
 * ════════════════════════════════════════════════════════════════════
 *  Robo Rangers — Smart Ambulance AI — app.js
 *  Voice-AI Orchestrated Emergency Response System
 *
 *  APIs Used:
 *   • Web Speech API        — continuous voice recognition
 *   • Google Gemini 2.5     — AI brain (scene analysis + action dispatch)
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
  mapsKey:       '',
  junctionLat:   null,
  junctionLng:   null,
  junctionRadius:300,
  hospitalName:  '',
  hospitalPhone: '',

  save() {
    localStorage.setItem('sma_config', JSON.stringify({
      geminiKey:     this.geminiKey,
      mapsKey:       this.mapsKey,
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
  mapsLoaded:       false,
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

// Maps objects
let gMap            = null;
let gHospitalMap    = null;
let ambulanceMarker = null;
let hospitalMarker  = null;
let directionsRenderer = null;
let directionsService  = null;

// BLE UUIDs — must match ESP32 firmware
const BLE_SERVICE_UUID = '12345678-1234-1234-1234-123456789abc';
const BLE_CHAR_UUID    = 'abcdefab-cdef-abcd-efab-cdefabcdefab';

// ═══════════════════════════════════════════════════════════════════
//  BOOTSTRAP
// ═══════════════════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => {
  CONFIG.load();
  populateSettingsUI();
  bindUIEvents();
  startGPS();
  startNormalTrafficCycle();
  updateBTStatusUI();
  toast('🚑 Smart Ambulance AI ready — describe an emergency or use voice', 'info', 5000);
});

// ═══════════════════════════════════════════════════════════════════
//  GOOGLE MAPS LOADER
// ═══════════════════════════════════════════════════════════════════
function loadMapsAPI() {
  if (STATE.mapsLoaded || !CONFIG.mapsKey) {
    if (!CONFIG.mapsKey) {
      toast('⚙️ Enter your Google Maps API key in Settings to enable maps', 'warning', 6000);
    }
    return;
  }

  const script = document.createElement('script');
  script.src = `https://maps.googleapis.com/maps/api/js?key=${CONFIG.mapsKey}&libraries=marker,geometry,places&callback=window.__mapsReady`;
  script.async = true;
  document.head.appendChild(script);

  window.__mapsReady = () => {
    STATE.mapsLoaded = true;
    initMap('map', (m) => { gMap = m; });
    initMap('hospital-map', (m) => { gHospitalMap = m; });
    directionsService  = new google.maps.DirectionsService();
    directionsRenderer = new google.maps.DirectionsRenderer({
      map: gMap,
      suppressMarkers: true,
      polylineOptions: {
        strokeColor: '#3b82f6',
        strokeOpacity: 0.9,
        strokeWeight: 4,
      }
    });
    toast('🗺️ Google Maps loaded', 'success');
  };
}

function initMap(elementId, callback) {
  const el = document.getElementById(elementId);
  if (!el) return;
  const center = STATE.currentPos || { lat: 20.5937, lng: 78.9629 };
  const map = new google.maps.Map(el, {
    zoom: 15,
    center,
    mapId: 'ambulance_map',
    disableDefaultUI: false,
    styles: [{
      featureType: 'all',
      elementType: 'geometry',
      stylers: [{ color: '#0d1220' }]
    }, {
      featureType: 'road',
      elementType: 'geometry.fill',
      stylers: [{ color: '#1e293b' }]
    }, {
      featureType: 'road',
      elementType: 'labels.text.fill',
      stylers: [{ color: '#94a3b8' }]
    }, {
      featureType: 'water',
      elementType: 'geometry',
      stylers: [{ color: '#050d1a' }]
    }, {
      featureType: 'poi',
      elementType: 'geometry',
      stylers: [{ color: '#111827' }]
    }]
  });
  callback(map);
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
      updateMapAmbulanceMarker(pos);
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

function updateMapAmbulanceMarker(pos) {
  if (!STATE.mapsLoaded || !gMap) return;

  if (!ambulanceMarker) {
    const el = document.createElement('div');
    el.style.cssText = 'font-size:28px;cursor:pointer;filter:drop-shadow(0 0 8px rgba(59,130,246,0.8));';
    el.textContent = '🚑';
    ambulanceMarker = new google.maps.marker.AdvancedMarkerElement({
      map: gMap,
      position: pos,
      content: el,
      title: 'Ambulance',
    });

    if (gHospitalMap) {
      const el2 = document.createElement('div');
      el2.style.cssText = 'font-size:28px;filter:drop-shadow(0 0 8px rgba(59,130,246,0.8));';
      el2.textContent = '🚑';
      new google.maps.marker.AdvancedMarkerElement({ map: gHospitalMap, position: pos, content: el2 });
    }
  } else {
    ambulanceMarker.position = pos;
  }
  gMap.panTo(pos);
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
    toast('❌ Web Bluetooth not supported in this browser. Use Chrome or Edge.', 'error', 6000);
    return;
  }

  try {
    setBTUI('connecting', 'Scanning for TRAFFIC_LIGHT...');
    const device = await navigator.bluetooth.requestDevice({
      filters: [
        { name: 'TRAFFIC_LIGHT' },
        { name: 'SmartAmbulance' },
      ],
      optionalServices: [BLE_SERVICE_UUID],
    });

    STATE.bluetoothDevice = device;
    setBTUI('connecting', `Found ${device.name} — connecting...`);

    device.addEventListener('gattserverdisconnected', onBLEDisconnected);

    const server  = await device.gatt.connect();
    const service = await server.getPrimaryService(BLE_SERVICE_UUID);
    STATE.bleCharacteristic = await service.getCharacteristic(BLE_CHAR_UUID);
    STATE.bleConnected = true;

    setBTUI('connected', `Connected: ${device.name}`);
    document.getElementById('emg-on-btn').disabled  = false;
    document.getElementById('emg-off-btn').disabled = false;
    document.getElementById('bt-connect-btn').textContent = `📡 ${device.name}`;
    document.getElementById('bt-connect-btn').classList.add('connected');

    toast(`✅ Bluetooth connected to ${device.name}`, 'success');
  } catch (err) {
    STATE.bleConnected = false;
    if (err.name !== 'NotFoundError') {
      setBTUI('error', 'Connection failed: ' + err.message);
      toast('❌ Bluetooth connection failed: ' + err.message, 'error');
    } else {
      setBTUI('idle', 'Not connected');
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
    if (command === 'EMG_ON') activateEmergencyTrafficUI();
    if (command === 'EMG_OFF') deactivateEmergencyTrafficUI();
    toast(`📡 BLE (simulated): ${command}`, 'info');
    return;
  }

  try {
    const encoder = new TextEncoder();
    await STATE.bleCharacteristic.writeValue(encoder.encode(command));
    if (command === 'EMG_ON') activateEmergencyTrafficUI();
    if (command === 'EMG_OFF') deactivateEmergencyTrafficUI();
    toast(`✅ Sent to ESP32: ${command}`, 'success');
  } catch (err) {
    toast(`❌ BLE write failed: ${err.message}`, 'error');
  }
}

function setBTUI(status, text) {
  const dot    = document.getElementById('bt-dot');
  const label  = document.getElementById('bt-label');
  const detail = document.getElementById('bt-detail-status');
  const card   = document.getElementById('card-bt');
  const val    = document.getElementById('bt-status');

  const map = { connected: 'active', error: 'error', connecting: 'warn', idle: '' };
  dot.className    = 'indicator-dot ' + (map[status] || '');
  label.textContent = 'BT';
  if (val) val.textContent = text || '—';
  if (detail) detail.textContent = text || '—';
  if (card) card.className = 'status-card ' + (map[status] || '');
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
      "type": "GET_ROUTE"
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
- For severity >= 3, always include ACTIVATE_EMERGENCY and BLE_COMMAND EMG_ON
- For cardiac/chest pain, recommend cardiac_center
- For accidents/trauma, recommend trauma_center
- Always include VOICE_RESPONSE with clear crew instruction
- For de-escalation commands like "turn off", "end emergency", "all clear": include BLE_COMMAND EMG_OFF and deactivate
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
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent`,
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
        await searchHospitals(action.specialization || 'general');
        markChipDone('FIND_HOSPITAL');
        break;

      case 'GET_ROUTE':
        await calculateRoute();
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
//  HOSPITAL SEARCH — Google Places API (New)
// ═══════════════════════════════════════════════════════════════════
async function searchHospitals(specialization = 'general') {
  if (!STATE.currentPos) {
    toast('❌ GPS location required to search hospitals', 'error');
    return;
  }

  if (!CONFIG.mapsKey) {
    toast('⚙️ Google Maps API key required for hospital search', 'warning', 5000);
    useFallbackHospital();
    return;
  }

  try {
    toast('🔍 Searching for hospitals...', 'info', 3000);

    const response = await fetch('https://places.googleapis.com/v1/places:searchNearby', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': CONFIG.mapsKey,
        'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.location,places.internationalPhoneNumber,places.rating',
      },
      body: JSON.stringify({
        includedTypes: ['hospital', 'emergency_room_physician'],
        maxResultCount: 10,
        locationRestriction: {
          circle: {
            center: { latitude: STATE.currentPos.lat, longitude: STATE.currentPos.lng },
            radius: 15000,
          }
        }
      })
    });

    const data = await response.json();
    const hospitals = data.places || [];

    if (!hospitals.length) {
      toast('⚠️ No hospitals found nearby — using manual setting', 'warning');
      useFallbackHospital();
      return;
    }

    // Pick first (closest) — TODO: rank by ETA in future
    const best = hospitals[0];
    STATE.selectedHospital = {
      name:    best.displayName?.text || 'Hospital',
      address: best.formattedAddress || '',
      phone:   best.internationalPhoneNumber || CONFIG.hospitalPhone || '',
      lat:     best.location?.latitude,
      lng:     best.location?.longitude,
    };

    showHospitalCard();
    toast(`🏥 Hospital found: ${STATE.selectedHospital.name}`, 'success');
  } catch (err) {
    toast('❌ Hospital search failed: ' + err.message, 'error');
    useFallbackHospital();
  }
}

function useFallbackHospital() {
  if (CONFIG.hospitalName || CONFIG.hospitalPhone) {
    STATE.selectedHospital = {
      name:    CONFIG.hospitalName || 'Configured Hospital',
      address: '',
      phone:   CONFIG.hospitalPhone || '',
      lat:     null, lng: null,
    };
    showHospitalCard();
  }
}

function showHospitalCard() {
  if (!STATE.selectedHospital) return;
  const h = STATE.selectedHospital;

  document.getElementById('hospital-name-display').textContent = h.name;
  document.getElementById('hospital-address').textContent = h.address || 'Address not available';
  document.getElementById('hosp-phone').textContent = h.phone || 'N/A';
  document.getElementById('hospital-card').classList.remove('hidden');

  // Place hospital marker on map
  if (STATE.mapsLoaded && gMap && h.lat && h.lng) {
    if (hospitalMarker) hospitalMarker.map = null;
    const el = document.createElement('div');
    el.style.cssText = 'font-size:26px;cursor:pointer;';
    el.textContent = '🏥';
    hospitalMarker = new google.maps.marker.AdvancedMarkerElement({
      map: gMap, position: { lat: h.lat, lng: h.lng }, content: el, title: h.name
    });
  }

  prepareSMS();
  calculateRoute();
}

// ═══════════════════════════════════════════════════════════════════
//  ROUTE CALCULATION — Google Directions API
// ═══════════════════════════════════════════════════════════════════
async function calculateRoute() {
  if (!STATE.currentPos || !STATE.selectedHospital?.lat) return;
  if (!STATE.mapsLoaded || !directionsService) {
    toast('🗺️ Maps not loaded yet', 'warning');
    return;
  }

  try {
    directionsService.route({
      origin: STATE.currentPos,
      destination: { lat: STATE.selectedHospital.lat, lng: STATE.selectedHospital.lng },
      travelMode: google.maps.TravelMode.DRIVING,
      drivingOptions: {
        departureTime: new Date(),
        trafficModel: 'bestguess',
      }
    }, (result, status) => {
      if (status !== 'OK') return;
      directionsRenderer?.setDirections(result);

      const leg = result.routes[0].legs[0];
      STATE.routeETA      = leg.duration_in_traffic?.text || leg.duration.text;
      STATE.routeDistance = leg.distance.text;

      document.getElementById('eta-value').textContent    = STATE.routeETA;
      document.getElementById('hosp-eta').textContent     = STATE.routeETA;
      document.getElementById('hosp-distance').textContent = STATE.routeDistance;
      document.getElementById('hdash-eta').textContent    = STATE.routeETA;
      document.getElementById('hdash-dist').textContent   = STATE.routeDistance;
      document.getElementById('nearby-dist-display').textContent = STATE.routeDistance;

      prepareSMS();
      toast(`✅ Route calculated: ${STATE.routeDistance}, ETA ${STATE.routeETA}`, 'success');
    });
  } catch (err) {
    toast('❌ Routing error: ' + err.message, 'error');
  }
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
  document.getElementById('gemini-key').value    = CONFIG.geminiKey    || '';
  document.getElementById('maps-key').value      = CONFIG.mapsKey      || '';
  document.getElementById('junction-lat').value  = CONFIG.junctionLat  || '';
  document.getElementById('junction-lng').value  = CONFIG.junctionLng  || '';
  document.getElementById('junction-radius').value = CONFIG.junctionRadius || 300;
  document.getElementById('hospital-name').value = CONFIG.hospitalName || '';
  document.getElementById('hospital-phone').value = CONFIG.hospitalPhone || '';
}

function saveSettings() {
  CONFIG.geminiKey     = document.getElementById('gemini-key').value.trim();
  CONFIG.mapsKey       = document.getElementById('maps-key').value.trim();
  CONFIG.junctionLat   = parseFloat(document.getElementById('junction-lat').value) || null;
  CONFIG.junctionLng   = parseFloat(document.getElementById('junction-lng').value) || null;
  CONFIG.junctionRadius = parseInt(document.getElementById('junction-radius').value) || 300;
  CONFIG.hospitalName  = document.getElementById('hospital-name').value.trim();
  CONFIG.hospitalPhone = document.getElementById('hospital-phone').value.trim();
  CONFIG.save();

  closeSettings();
  toast('✅ Settings saved!', 'success');

  // Load maps if key was just entered
  if (CONFIG.mapsKey && !STATE.mapsLoaded) loadMapsAPI();
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

  // Keyboard shortcut: Space = toggle voice, E = emergency, Escape = end
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    if (e.code === 'Space') { e.preventDefault(); toggleVoice(); }
    if (e.key === 'Escape') { if (STATE.emergencyActive) deactivateEmergencyMode(); }
  });

  // Load maps if key already saved
  if (CONFIG.mapsKey) loadMapsAPI();
}
