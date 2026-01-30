"use strict";

let connection;
let audioPlayer, statusBadge, playerStatus, musicUrlInput;
let userListElement, chatMessagesElement, chatInputElement, chatSendButton;

// Persistência
const LS_USER = "dtom_username_v1";

// WebRTC
let inCall = false;
let localStream = null;
let peerConnections = {};
// ICE candidates podem chegar antes do remoteDescription; guardamos até estar pronto.
const pendingIce = {};
const rtcConfig = {
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    bundlePolicy: "max-bundle",
    rtcpMuxPolicy: "require"
};

// YouTube IFrame API
let ytPlayer = null;
let ytReady = false;
let ytUnlocked = false;
let currentMusicToken = 0;
let suppressEndedNotify = false;

document.addEventListener("DOMContentLoaded", function () {
    audioPlayer = document.getElementById("dtomPlayer");
    statusBadge = document.getElementById("connection-status");
    playerStatus = document.getElementById("player-status");
    musicUrlInput = document.getElementById("musicUrl");
    userListElement = document.getElementById("user-list");
    chatMessagesElement = document.getElementById("chat-messages");
    chatInputElement = document.getElementById("chat-input");
    chatSendButton = document.getElementById("btnSendChat");

    window.DTOMAudioUI?.initUI?.();

    const loginModalElement = document.getElementById("loginModal");
    const loginModal = loginModalElement ? new bootstrap.Modal(loginModalElement) : null;
    const userNameInput = document.getElementById("userNameInput");
    const btnConfirmLogin = document.getElementById("btnConfirmLogin");

    connection = new signalR.HubConnectionBuilder()
        .withUrl("/dtomHub")
        .withAutomaticReconnect()
        .build();

    // Users
    connection.on("UpdateUserList", (users) => {
        if (!userListElement) return;
        userListElement.innerHTML = "";
        (users || []).forEach((user) => {
            const div = document.createElement("div");
            div.className = "user-item-modern";
            div.id = `user-${user.id}`;
            div.innerHTML = `<i class="bi bi-person-fill neon-text"></i> ${escapeHtml(user.name || "")}`;
            userListElement.appendChild(div);
        });
    });

    // Chat
    connection.on("ReceiveMessage", (userName, message, timestamp) => {
        if (!chatMessagesElement) return;
        const div = document.createElement("div");
        div.className = "chat-message";
        div.innerHTML = `<strong>${escapeHtml(userName)}:</strong> <span>${escapeHtml(message)}</span> <small>${escapeHtml(timestamp)}</small>`;
        chatMessagesElement.appendChild(div);
        chatMessagesElement.scrollTop = chatMessagesElement.scrollHeight;
    });

    // ===== YouTube =====
    function loadYouTubeApiOnce() {
        return new Promise((resolve) => {
            if (window.YT && window.YT.Player) {
                ytReady = true;
                return resolve();
            }
            const tag = document.createElement("script");
            tag.src = "https://www.youtube.com/iframe_api";
            const prev = window.onYouTubeIframeAPIReady;
            window.onYouTubeIframeAPIReady = () => {
                try { if (typeof prev === "function") prev(); } catch { }
                ytReady = true;
                resolve();
            };
            document.head.appendChild(tag);
        });
    }

    async function ensureYTPlayer() {
        const host = document.getElementById("yt-host");
        if (!host) return null;

        await loadYouTubeApiOnce();
        if (ytPlayer) return ytPlayer;

        return new Promise((resolve) => {
            ytPlayer = new YT.Player("yt-host", {
                height: "0",
                width: "0",
                videoId: "",
                playerVars: {
                    autoplay: 1,
                    controls: 0,
                    rel: 0,
                    playsinline: 1,
                    origin: window.location.origin
                },
                events: {
                    onReady: () => {
                        window.DTOMAudioUI?.setYouTubePlayer?.(ytPlayer);
                        if (!inCall) {
                            try { ytPlayer.mute(); ytPlayer.pauseVideo(); } catch { }
                        }
                        resolve(ytPlayer);
                    },
                    onStateChange: (e) => {
                        if (e.data === YT.PlayerState.ENDED) {
                            if (suppressEndedNotify) return;
                            if (inCall && currentMusicToken) {
                                connection.invoke("MusicEnded", currentMusicToken).catch(() => { });
                            }
                        }
                    },
                    onError: (e) => console.error("YT error:", e)
                }
            });
        });
    }

    function stopYouTubeLocal() {
        if (!ytPlayer) return;
        try {
            suppressEndedNotify = true;
            ytPlayer.stopVideo();
        } catch { }
        try { ytPlayer.mute(); } catch { }
        setTimeout(() => { suppressEndedNotify = false; }, 500);
        if (playerStatus) playerStatus.innerText = "Música parada";
    }

    async function playYouTube(videoId, startSeconds, token) {
        currentMusicToken = Number(token) || 0;
        if (!inCall) return stopYouTubeLocal();

        const p = await ensureYTPlayer();
        if (!p) return;

        const start = Math.max(0, Math.floor(Number(startSeconds) || 0));
        try {
            suppressEndedNotify = true;
            p.loadVideoById({ videoId, startSeconds: start });
            p.playVideo();

            if (ytUnlocked) {
                try { p.unMute(); } catch { }
            } else {
                try { p.mute(); } catch { }
            }

            if (playerStatus) playerStatus.innerText = "Música tocando (YouTube)";
        } finally {
            setTimeout(() => { suppressEndedNotify = false; }, 500);
        }
    }

    async function pauseYouTube(atSeconds, token) {
        currentMusicToken = Number(token) || currentMusicToken;
        const p = await ensureYTPlayer();
        if (!p) return;
        if (!inCall) return stopYouTubeLocal();

        try {
            suppressEndedNotify = true;
            p.pauseVideo();
            const t = Math.max(0, Number(atSeconds) || 0);
            try { p.seekTo(t, true); } catch { }
            if (!ytUnlocked) p.mute();
            if (playerStatus) playerStatus.innerText = "Música pausada";
        } finally {
            setTimeout(() => { suppressEndedNotify = false; }, 500);
        }
    }

    // Eventos do Hub
    connection.on("PlayYouTube", (videoId, startSeconds, token) => playYouTube(videoId, startSeconds, token));
    connection.on("PauseYouTube", (_videoId, atSeconds, token) => pauseYouTube(atSeconds, token));
    connection.on("StopYouTube", (_token) => { currentMusicToken = 0; stopYouTubeLocal(); });

    // ===== WebRTC =====
    connection.on("ExistingVoiceUsers", (ids) => {     
        for (const id of (ids || [])) {
            if (!id || id === connection.connectionId) continue;
            if (peerConnections[id]) continue;
            createPeerConnection(id);
        }
    });

    connection.on("UserJoinedVoice", async (senderId) => {
        if (!senderId || senderId === connection.connectionId) return;

        
        if (!inCall || !localStream) return;

        const pc = createPeerConnection(senderId);

        try {
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            await connection.invoke("SendOffer", senderId, offer);
        } catch (e) {
            console.error("Erro criando offer para", senderId, e);
        }
    });

    connection.on("ReceiveOffer", async (senderId, offer) => {
        const pc = createPeerConnection(senderId);

        // Segurança extra contra colisão de ofertas (glare): se não estiver estável, fazemos rollback.
        if (pc.signalingState !== "stable") {
            try { await pc.setLocalDescription({ type: "rollback" }); } catch { }
        }

        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        await flushPendingIce(senderId);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await connection.invoke("SendAnswer", senderId, answer);
    });

    connection.on("ReceiveAnswer", async (senderId, answer) => {
        const pc = peerConnections[senderId];
        if (!pc) return;
        await pc.setRemoteDescription(new RTCSessionDescription(answer));
        await flushPendingIce(senderId);
    });

    connection.on("ReceiveIceCandidate", async (senderId, candidate) => {
        if (!candidate || !senderId) return;

        // Pode chegar ICE antes do pc existir (ou antes do offer/answer). Criamos/bufferizamos.
        const pc = peerConnections[senderId] || createPeerConnection(senderId);

        // Se o remoteDescription ainda não existe, guardamos e aplicamos depois.
        if (!pc.remoteDescription || !pc.remoteDescription.type) {
            (pendingIce[senderId] ||= []).push(candidate);
            return;
        }

        try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch { }
    });

    connection.on("UserLeftVoice", (userId) => {
        if (peerConnections[userId]) {
            peerConnections[userId].close();
            delete peerConnections[userId];
        }
        delete pendingIce[userId];
        window.DTOMAudioUI?.stopSpeaking?.(userId);
        const el = document.getElementById(`remote-audio-${userId}`);
        if (el) el.remove();
    });

    async function flushPendingIce(peerId) {
        const pc = peerConnections[peerId];
        const list = pendingIce[peerId];
        if (!pc || !list || !list.length) return;
        if (!pc.remoteDescription || !pc.remoteDescription.type) return;

        for (const c of list.splice(0, list.length)) {
            try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch { }
        }
        if (!pendingIce[peerId]?.length) delete pendingIce[peerId];
    }

    // ===== Start + login persistente =====
    connection.start().then(async () => {
        if (statusBadge) {
            statusBadge.innerHTML = '<span class="dot"></span> Online';
            statusBadge.classList.add("connected");
        }

        const savedName = safeGetLS(LS_USER);
        if (userNameInput && savedName) userNameInput.value = savedName;

        if (savedName) {
            await connection.invoke("SetUserName", savedName).catch(() => { });
            loginModal?.hide();
        } else {
            loginModal?.show();
            loginModalElement?.addEventListener("shown.bs.modal", () => userNameInput?.focus());
        }

        ensureYTPlayer();
    }).catch(err => console.error("Erro SignalR:", err));

    function performLogin() {
        let userName = (userNameInput?.value || "").trim();
        if (!userName) userName = "Anônimo_" + Math.floor(Math.random() * 100);
        safeSetLS(LS_USER, userName);

        connection.invoke("SetUserName", userName)
            .then(() => {
                addSystemMessage(`Bem-vindo à rede, ${userName}!`);
                loginModal?.hide();
            })
            .catch(() => addSystemMessage("❌ Não consegui acessar a rede."));
    }

    btnConfirmLogin?.addEventListener("click", performLogin);
    userNameInput?.addEventListener("keydown", (e) => { if (e.key === "Enter") performLogin(); });

    // ===== Chat: Enter envia / Ctrl+Enter quebra =====
    function handleSendMessage() {
        const msg = (chatInputElement?.value || "").trimEnd();
        if (!msg) return;

        connection.invoke("SendMessage", msg)
            .then(() => { chatInputElement.value = ""; chatInputElement.focus(); })
            .catch(() => addSystemMessage("❌ Erro ao enviar mensagem."));
    }

    chatSendButton?.addEventListener("click", handleSendMessage);
    chatInputElement?.addEventListener("keydown", (e) => {
        if (e.key !== "Enter") return;
        if (e.ctrlKey || e.metaKey) return; // quebra linha
        e.preventDefault();
        handleSendMessage();
    });

    // ===== Música: adiciona na fila =====
    document.getElementById("btnTransmitir")?.addEventListener("click", async function () {
        const btn = this;
        const url = (musicUrlInput?.value || "").trim();
        if (!url) return;

        if (!inCall) {
            addSystemMessage("⚠️ Entre na call para adicionar músicas na fila.");
            return;
        }

        ytUnlocked = true;
        try { ytPlayer?.unMute(); } catch { }

        btn.disabled = true;
        connection.invoke("RequestMusic", url)
            .then(() => { musicUrlInput.value = ""; })
            .catch(() => addSystemMessage("❌ Erro ao adicionar música."))
            .finally(() => { btn.disabled = false; });
    });

    // ===== Voz =====
    document.getElementById("btnJoinVoice")?.addEventListener("click", joinVoice);

    async function joinVoice() {
        const btn = document.getElementById("btnJoinVoice");
        if (!btn) return;

        if (btn.classList.contains("active")) {
            leaveVoice();
            await connection.invoke("LeaveVoice").catch(() => { });
            return;
        }

        try {
            // Garante que o AudioContext (singleton) está liberado por gesto do usuário
            await window.DTOMAudioUI?.unlock?.();

            const raw = await navigator.mediaDevices.getUserMedia({
                audio: {
                    channelCount: 1,
                    echoCancellation: false,
                    noiseSuppression: true,
                    autoGainControl: true
                }
            });

            localStream = await window.DTOMAudioUI.processMicStream(raw);
            window.DTOMAudioUI.setMicTrack?.(raw.getAudioTracks()[0]);

            inCall = true;
            btn.classList.add("active");
            btn.innerText = "SAIR";
            btn.style.backgroundColor = "#ff4444";

            addSystemMessage("🎙️ Você entrou na call.");
            window.DTOMAudioUI?.monitorSpeaking?.(localStream, connection.connectionId);

            await connection.invoke("JoinVoice"); // <-- aqui vem ExistingVoiceUsers + sync música

            ytUnlocked = true;
            try { ytPlayer?.unMute(); } catch { }
        } catch (err) {
            console.error(err);
            addSystemMessage("❌ Falha no microfone.");
        }
    }

    function leaveVoice() {
        const btn = document.getElementById("btnJoinVoice");
        if (!btn) return;

        inCall = false;

        // Para o efeito de speaking glow do usuário local
        window.DTOMAudioUI?.stopSpeaking?.(connection?.connectionId);

        for (let id in peerConnections) {
            peerConnections[id].close();
            delete peerConnections[id];
            delete pendingIce[id];
            window.DTOMAudioUI?.stopSpeaking?.(id);
        }
        document.querySelectorAll("[id^='remote-audio-']").forEach(el => el.remove());

        if (localStream) {
            localStream.getTracks().forEach(t => t.stop());
            localStream = null;
        }

        btn.classList.remove("active");
        btn.innerText = "ENTRAR";
        btn.style.backgroundColor = "";

        addSystemMessage("🔇 Você saiu da call.");
        stopYouTubeLocal();
    }

    function createPeerConnection(senderId) {
        if (peerConnections[senderId]) return peerConnections[senderId];

        const pc = new RTCPeerConnection(rtcConfig);
        peerConnections[senderId] = pc;


        if (localStream) {
            localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
        }

        pc.ontrack = (e) => {
            if (!inCall) return;

            const container = document.getElementById("remote-audios") || document.body;
            let audio = document.getElementById(`remote-audio-${senderId}`);
            if (!audio) {
                audio = document.createElement("audio");
                audio.id = `remote-audio-${senderId}`;
                audio.autoplay = true;
                audio.playsInline = true;
                container.appendChild(audio);
            }

            // fallback se e.streams vier vazio (alguns casos)
            const remoteStream = (e.streams && e.streams[0]) ? e.streams[0] : new MediaStream([e.track]);

            audio.srcObject = remoteStream;
            audio.muted = false;
            audio.volume = 1.0;
            audio.play().catch(console.warn);
            monitorVolume(remoteStream, senderId);
        };



        pc.onicecandidate = (e) => {
            if (e.candidate) connection.invoke("SendIceCandidate", senderId, e.candidate);
        };

        return pc;
    }

    // speaking glow agora é gerenciado pelo DTOMAudioUI (AudioContext singleton)
});

function escapeHtml(t) {
    const d = document.createElement("div");
    d.textContent = String(t ?? "");
    return d.innerHTML;
}

function addSystemMessage(m) {
    const el = document.getElementById("chat-messages");
    if (!el) return;
    const div = document.createElement("div");
    div.className = "chat-message";
    div.style.fontStyle = "italic";
    div.style.opacity = "0.8";
    div.innerHTML = `<span style="color:#6E7681;"><i class="bi bi-info-circle me-1"></i> ${escapeHtml(m)}</span>`;
    el.appendChild(div);
    el.scrollTop = el.scrollHeight;
}

function safeGetLS(key) {
    try { return localStorage.getItem(key) || ""; } catch { return ""; }
}

function safeSetLS(key, val) {
    try { localStorage.setItem(key, String(val)); } catch { }
}
