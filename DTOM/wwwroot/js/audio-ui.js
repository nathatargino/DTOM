"use strict";

/**
 * DTOMAudioUI
 * - AudioContext Singleton + unlock por gesto (evita autoplay block e áudio mudo)
 * - Mic/Remote via GainNodes (0–200% => 0.0–2.0)
 * - YouTube volume via IFrame API (0–100)
 * - Speaking Glow (analyser por stream, usando o mesmo AudioContext)
 * - bindUi(): reconecta listeners dos sliders e mantém labels / persistência
 */
window.DTOMAudioUI = (() => {
    const LS_KEY = "dtom_audio_settings_v1";

    const state = {
        ytVol: 100,      // 0..100 (UI atual)
        micVol: 100,     // 0..200
        remoteVol: 100,  // 0..200
        micMuted: false,
        callMuted: false
    };

    // ===== Singleton AudioContext =====
    let audioCtx = null;
    let unlockBound = false;

    // ===== YouTube =====
    let ytPlayer = null;

    // ===== Mic pipeline =====
    let micTrack = null;
    let micGain = null;
    let micDest = null;

    // ===== Remote pipelines =====
    // key: remoteStreamId (ou fallback), value: { gain, dest, userId }
    const remotePipes = new Map();

    // ===== Speaking monitor =====
    // key: userId, value: { analyser, data, rafId, source }
    const speakingMonitors = new Map();

    // ===== Helpers =====
    function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
    function pctToGain(p) { return clamp(p, 0, 200) / 100; }
    function safeInt(v, d = 0) {
        const n = Number.parseInt(v, 10);
        return Number.isFinite(n) ? n : d;
    }

    function ensureCtx() {
        if (!audioCtx) {
            audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        }
        return audioCtx;
    }

    async function unlock() {
        try {
            const ctx = ensureCtx();
            if (ctx.state === "suspended") {
                await ctx.resume();
            }
        } catch {
            // ignore
        }
    }

    // Liga um "auto-unlock" (primeiro gesto do usuário)
    function bindUnlockOnce() {
        if (unlockBound) return;
        unlockBound = true;

        const handler = async () => {
            await unlock();
            window.removeEventListener("pointerdown", handler, true);
            window.removeEventListener("keydown", handler, true);
            window.removeEventListener("touchstart", handler, true);
        };

        window.addEventListener("pointerdown", handler, true);
        window.addEventListener("keydown", handler, true);
        window.addEventListener("touchstart", handler, true);
    }

    function load() {
        try {
            const raw = localStorage.getItem(LS_KEY);
            if (!raw) return;
            const obj = JSON.parse(raw);
            if (typeof obj.ytVol === "number") state.ytVol = clamp(obj.ytVol, 0, 100);
            if (typeof obj.micVol === "number") state.micVol = clamp(obj.micVol, 0, 200);
            if (typeof obj.remoteVol === "number") state.remoteVol = clamp(obj.remoteVol, 0, 200);
            if (typeof obj.micMuted === "boolean") state.micMuted = obj.micMuted;
            if (typeof obj.callMuted === "boolean") state.callMuted = obj.callMuted;
        } catch {
            // ignore
        }
    }

    function save() {
        try { localStorage.setItem(LS_KEY, JSON.stringify(state)); } catch { }
    }

    function applyYT() {
        if (!ytPlayer || typeof ytPlayer.setVolume !== "function") return;
        try { ytPlayer.setVolume(clamp(state.ytVol, 0, 100)); } catch { }
    }

    function applyMic() {
        if (micGain) micGain.gain.value = pctToGain(state.micVol);
        if (micTrack) micTrack.enabled = !state.micMuted;
    }

    function applyRemote() {
        const g = state.callMuted ? 0 : pctToGain(state.remoteVol);
        for (const pipe of remotePipes.values()) {
            try { pipe.gain.gain.value = g; } catch { }
        }
    }

    function setValues(patch) {
        if (!patch) return;
        if (typeof patch.ytVol === "number") state.ytVol = clamp(patch.ytVol, 0, 100);
        if (typeof patch.micVol === "number") state.micVol = clamp(patch.micVol, 0, 200);
        if (typeof patch.remoteVol === "number") state.remoteVol = clamp(patch.remoteVol, 0, 200);
        if (typeof patch.micMuted === "boolean") state.micMuted = patch.micMuted;
        if (typeof patch.callMuted === "boolean") state.callMuted = patch.callMuted;

        applyYT();
        applyMic();
        applyRemote();
        save();
        syncUiFromState();
    }

    // ===== UI Binding =====
    function setLabel(id, v) {
        const el = document.getElementById(id);
        if (el) el.textContent = `${v}%`;
    }

    function syncUiFromState() {
        const yt = document.getElementById("uiYtVol");
        const mic = document.getElementById("uiMicVol");
        const rem = document.getElementById("uiRemoteVol");

        if (yt) yt.value = String(clamp(state.ytVol, safeInt(yt.min, 0), safeInt(yt.max, 100)));
        if (mic) mic.value = String(clamp(state.micVol, safeInt(mic.min, 0), safeInt(mic.max, 200)));
        if (rem) rem.value = String(clamp(state.remoteVol, safeInt(rem.min, 0), safeInt(rem.max, 200)));

        setLabel("uiYtVolLabel", clamp(state.ytVol, 0, 100));
        setLabel("uiMicVolLabel", clamp(state.micVol, 0, 200));
        setLabel("uiRemoteVolLabel", clamp(state.remoteVol, 0, 200));
    }

    function bindUi() {
        // Sempre que o layout recarregar/partial render, pode chamar de novo.
        bindUnlockOnce();

        const yt = document.getElementById("uiYtVol");
        const mic = document.getElementById("uiMicVol");
        const rem = document.getElementById("uiRemoteVol");
        const reset = document.getElementById("uiAudioReset");
        const btnCallMute = document.getElementById("uiCallMute");
        const btnMicMute = document.getElementById("uiMicMute");

        function syncMuteButtons() {
            if (btnCallMute) {
                btnCallMute.classList.toggle("active", state.callMuted);
                const icon = btnCallMute.querySelector("i");
                if (icon) {
                    icon.classList.toggle("bi-volume-up-fill", !state.callMuted);
                    icon.classList.toggle("bi-volume-mute-fill", state.callMuted);
                }
            }
            if (btnMicMute) {
                btnMicMute.classList.toggle("active", state.micMuted);
                const icon = btnMicMute.querySelector("i");
                if (icon) {
                    icon.classList.toggle("bi-mic-fill", !state.micMuted);
                    icon.classList.toggle("bi-mic-mute-fill", state.micMuted);
                }
            }
        }

        if (btnCallMute) {
            btnCallMute.onclick = async () => {
                await unlock();
                state.callMuted = !state.callMuted;
                applyRemote();
                save();
                syncMuteButtons();
            };
        }

        if (btnMicMute) {
            btnMicMute.onclick = async () => {
                await unlock();
                state.micMuted = !state.micMuted;
                applyMic();
                save();
                syncMuteButtons();
            };
        }

        // chama uma vez ao bind
        syncMuteButtons();

        // Inicializa UI com estado salvo
        syncUiFromState();

        const onInput = async () => {
            // Slider input também conta como gesto; tenta liberar o AudioContext.
            await unlock();

            if (yt) {
                const v = safeInt(yt.value, 100);
                state.ytVol = clamp(v, safeInt(yt.min, 0), safeInt(yt.max, 100));
                setLabel("uiYtVolLabel", state.ytVol);
                applyYT();
            }
            if (mic) {
                const v = safeInt(mic.value, 100);
                state.micVol = clamp(v, safeInt(mic.min, 0), safeInt(mic.max, 200));
                setLabel("uiMicVolLabel", state.micVol);
                applyMic();
            }
            if (rem) {
                const v = safeInt(rem.value, 100);
                state.remoteVol = clamp(v, safeInt(rem.min, 0), safeInt(rem.max, 200));
                setLabel("uiRemoteVolLabel", state.remoteVol);
                applyRemote();
            }
            save();
        };

        // Remove listeners antigos (se bindUi for chamado várias vezes)
        const rebind = (el) => {
            if (!el) return;
            el.oninput = null;
            el.onchange = null;
            el.addEventListener("input", onInput);
            el.addEventListener("change", onInput);
        };
        rebind(yt);
        rebind(mic);
        rebind(rem);

        if (reset) {
            reset.onclick = async () => {
                await unlock();
                setValues({ ytVol: 100, micVol: 100, remoteVol: 100, micMuted: false, callMuted: false });
            };
        }
    }

    // ===== Mic processing =====
    async function processMicStream(rawStream) {
        ensureCtx();

        try {
            const ctx = ensureCtx();
            const source = ctx.createMediaStreamSource(rawStream);
            micGain = ctx.createGain();
            micDest = ctx.createMediaStreamDestination();

            micGain.gain.value = pctToGain(state.micVol);
            source.connect(micGain);
            micGain.connect(micDest);

            micTrack = rawStream.getAudioTracks?.()[0] || null;
            applyMic();
            return micDest.stream;
        } catch {
            micTrack = rawStream.getAudioTracks?.()[0] || null;
            applyMic();
            return rawStream;
        }
    }

    // ===== Remote processing =====
    function attachRemoteStream(audioEl, remoteStream, userId = null) {
        try {
            ensureCtx();
            const streamId = remoteStream.id || (remoteStream.getAudioTracks?.()[0]?.id ?? String(Math.random()));

            if (!remotePipes.has(streamId)) {
                const ctx = ensureCtx();
                const source = ctx.createMediaStreamSource(remoteStream);
                const gain = ctx.createGain();
                const dest = ctx.createMediaStreamDestination();

                gain.gain.value = state.callMuted ? 0 : pctToGain(state.remoteVol);
                source.connect(gain);
                gain.connect(dest);

                remotePipes.set(streamId, { gain, dest, userId });
            } else {
                const p = remotePipes.get(streamId);
                if (p && userId && !p.userId) p.userId = userId;
            }

            const pipe = remotePipes.get(streamId);
            audioEl.srcObject = pipe.dest.stream;
            audioEl.autoplay = true;
            audioEl.playsInline = true;
            audioEl.muted = false;
            audioEl.volume = 1.0;
            audioEl.play().catch(() => { });
        } catch {
            audioEl.srcObject = remoteStream;
            audioEl.autoplay = true;
            audioEl.playsInline = true;
            audioEl.muted = state.callMuted;
            audioEl.volume = Math.min(1, pctToGain(state.remoteVol));
            audioEl.play().catch(() => { });
        }
    }

    // ===== Speaking Glow =====
    function monitorSpeaking(stream, userId) {
        if (!stream || !userId) return;
        ensureCtx();

        if (speakingMonitors.has(userId)) return;

        try {
            const ctx = ensureCtx();
            const source = ctx.createMediaStreamSource(stream);
            const analyser = ctx.createAnalyser();
            analyser.fftSize = 256;
            source.connect(analyser);
            const data = new Uint8Array(analyser.frequencyBinCount);

            const tick = () => {
                analyser.getByteFrequencyData(data);
                let sum = 0;
                for (let i = 0; i < data.length; i++) sum += data[i];
                const avg = sum / data.length;

                const userDiv = document.getElementById(`user-${userId}`);
                if (userDiv) {
                    if (avg > 15) userDiv.classList.add("speaking-glow");
                    else userDiv.classList.remove("speaking-glow");
                }
                const m = speakingMonitors.get(userId);
                if (m) m.rafId = requestAnimationFrame(tick);
            };

            const rafId = requestAnimationFrame(tick);
            speakingMonitors.set(userId, { analyser, data, rafId, source });
        } catch {
            // ignore
        }
    }

    function stopSpeaking(userId) {
        const m = speakingMonitors.get(userId);
        if (!m) return;
        try { if (m.rafId) cancelAnimationFrame(m.rafId); } catch { }
        try { m.source?.disconnect?.(); } catch { }
        try { m.analyser?.disconnect?.(); } catch { }
        speakingMonitors.delete(userId);

        const userDiv = document.getElementById(`user-${userId}`);
        if (userDiv) userDiv.classList.remove("speaking-glow");
    }

    function initUI() {
        load();
        bindUi();
        applyYT();
        applyMic();
        applyRemote();
        bindUnlockOnce();
    }

    return {
        initUI,
        bindUi,
        load,
        save,
        unlock,
        getState: () => ({ ...state }),
        setYouTubePlayer: (p) => { ytPlayer = p; applyYT(); },
        setValues,
        processMicStream,
        attachRemoteStream,
        setMicTrack: (t) => { micTrack = t; applyMic(); },
        monitorSpeaking,
        stopSpeaking
    };
})();
