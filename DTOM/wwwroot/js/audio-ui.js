"use strict";

/**
 * Módulo DTOMAudioUI
 * Gerencia a pipeline de áudio do sistema, incluindo integração com YouTube,
 * processamento de microfone local, áudio remoto via WebRTC e feedback visual de voz.
 */
window.DTOMAudioUI = (() => {
    /** @constant {string} Chave para persistência das configurações de áudio no LocalStorage */
    const LS_KEY = "dtom_audio_settings_v1";

    /** @type {Object} Estado interno de volumes e estados de mute */
    const state = {
        ytVol: 100,      // Range: 0..100
        micVol: 100,     // Range: 0..200
        remoteVol: 100,  // Range: 0..200
        micMuted: false,
        callMuted: false
    };

    // Referências do Web Audio API Singleton
    let audioCtx = null;
    let unlockBound = false;

    // Instância do Player do YouTube
    let ytPlayer = null;

    // Referências da Pipeline do Microfone Local
    let micTrack = null;
    let micGain = null;
    let micDest = null;

    /** @type {Map<string, Object>} Pipelines de áudio remoto: { gain, dest, userId } */
    const remotePipes = new Map();

    /** @type {Map<string, Object>} Monitores de amplitude para efeito de brilho (Glow) */
    const speakingMonitors = new Map();

    // ===== Funções Utilitárias (Helpers) =====

    /** Limita um número entre um valor mínimo e máximo */
    function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }

    /** Converte valor percentual (0-200) para valor de ganho linear (0.0-2.0) */
    function pctToGain(p) { return clamp(p, 0, 200) / 100; }

    /** Realiza o parse seguro de inteiros com valor padrão de fallback */
    function safeInt(v, d = 0) {
        const n = Number.parseInt(v, 10);
        return Number.isFinite(n) ? n : d;
    }

    /** Garante a existência de uma única instância do AudioContext */
    function ensureCtx() {
        if (!audioCtx) {
            audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        }
        return audioCtx;
    }

    /** Libera o estado do AudioContext (necessário devido a políticas de autoplay de navegadores) */
    async function unlock() {
        try {
            const ctx = ensureCtx();
            if (ctx.state === "suspended") {
                await ctx.resume();
            }
        } catch {
            // Falha silenciosa na tentativa de resume
        }
    }

    /** Registra listeners globais para desbloquear o áudio no primeiro gesto do usuário */
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

    /** Recupera configurações persistidas do armazenamento local */
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
            // Erro ao carregar ou parsear JSON do LocalStorage
        }
    }

    /** Salva o estado atual das configurações no armazenamento local */
    function save() {
        try { localStorage.setItem(LS_KEY, JSON.stringify(state)); } catch { }
    }

    /** Aplica o volume atual à instância do player do YouTube */
    function applyYT() {
        if (!ytPlayer || typeof ytPlayer.setVolume !== "function") return;
        try {       
            const volumeFinal = state.callMuted ? 0 : clamp(state.ytVol, 0, 100);
            ytPlayer.setVolume(volumeFinal);
        } catch { }
    }

    /** Aplica ganho e estado de mute ao nó de áudio do microfone */
    function applyMic() {
        if (micGain) micGain.gain.value = pctToGain(state.micVol);
        if (micTrack) micTrack.enabled = !state.micMuted;
    }

    /** Atualiza o ganho de todos os fluxos de áudio remotos ativos */
    function applyRemote() {
        const g = state.callMuted ? 0 : pctToGain(state.remoteVol);
        for (const pipe of remotePipes.values()) {
            try { pipe.gain.gain.value = g; } catch { }
        }
    }

    /** Atualiza o estado global e propaga as mudanças para os nós de áudio e UI */
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

    // ===== Gerenciamento de Interface (UI Binding) =====

    /** Atualiza o conteúdo de texto de um label com o valor percentual */
    function setLabel(id, v) {
        const el = document.getElementById(id);
        if (el) el.textContent = `${v}%`;
    }

    /** Sincroniza os elementos de input (sliders) com o estado interno */
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

    /** Inicializa os event listeners dos componentes de UI de áudio */
    function bindUi() {
        bindUnlockOnce();

        const yt = document.getElementById("uiYtVol");
        const mic = document.getElementById("uiMicVol");
        const rem = document.getElementById("uiRemoteVol");
        const reset = document.getElementById("uiAudioReset");
        const btnCallMute = document.getElementById("uiCallMute");
        const btnMicMute = document.getElementById("uiMicMute");

        /** Atualiza visualmente os botões de mute (ícones e classes) */
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

                // Inverte o estado de mute da "chamada" 
                state.callMuted = !state.callMuted;

                // 1. Silencia/Restaura os áudios remotos (WebRTC)
                applyRemote();

                // 2. Silencia/Restaura o player do YouTube
                applyYT();

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

        syncMuteButtons();
        syncUiFromState();

        /** Handler disparado ao interagir com os sliders de volume */
        const onInput = async () => {
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

    // ===== Processamento de Sinais de Áudio =====

    /** Processa a stream bruta do microfone adicionando controle de ganho */
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

    /** Conecta uma stream remota WebRTC a um elemento de áudio via GainNodes */
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

    /** Monitora o nível de áudio de uma stream para aplicar efeito visual de fala */
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
            // Erro ao inicializar analyser
        }
    }

    /** Interrompe o monitoramento de fala e remove efeitos visuais */
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

    /** Inicializa o módulo, carregando dados e vinculando interface */
    function initUI() {
        load();
        bindUi();
        applyYT();
        applyMic();
        applyRemote();
        bindUnlockOnce();
    }

    // API Pública do Módulo
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