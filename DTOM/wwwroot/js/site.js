"use strict";

let connection;
let audioPlayer, statusBadge, playerStatus, musicUrlInput;
let userListElement, chatMessagesElement, chatInputElement, chatSendButton;
let currentUserName = "";

// WebRTC
let localStream = null;
let peerConnections = {};
const rtcConfig = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };

// YouTube Embed (Opção A)
let ytPlayer = null;
let ytReady = false;
let pendingYT = null; // { videoId, startTime }
let ytUnlocked = false;

document.addEventListener("DOMContentLoaded", function () {
    // --- 1) Elementos ---
    audioPlayer = document.getElementById("dtomPlayer"); // pode ficar (não atrapalha)
    statusBadge = document.getElementById("connection-status");
    playerStatus = document.getElementById("player-status");
    musicUrlInput = document.getElementById("musicUrl");
    userListElement = document.getElementById("user-list");
    chatMessagesElement = document.getElementById("chat-messages");
    chatInputElement = document.getElementById("chat-input");
    chatSendButton = document.getElementById("btnSendChat");

    const loginModalElement = document.getElementById("loginModal");
    const loginModal = loginModalElement ? new bootstrap.Modal(loginModalElement) : null;
    const userNameInput = document.getElementById("userNameInput");
    const btnConfirmLogin = document.getElementById("btnConfirmLogin");

    // --- 2) SignalR ---
    connection = new signalR.HubConnectionBuilder()
        .withUrl("/dtomHub")
        .withAutomaticReconnect()
        .build();

    // --- 3) Listeners: Usuários & Chat ---
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

    connection.on("ReceiveMessage", (userName, message, timestamp) => {
        if (!chatMessagesElement) return;

        const div = document.createElement("div");
        div.className = "chat-message";
        div.innerHTML = `<strong>${escapeHtml(userName)}:</strong> <span>${escapeHtml(message)}</span> <small>${escapeHtml(timestamp)}</small>`;
        chatMessagesElement.appendChild(div);
        chatMessagesElement.scrollTop = chatMessagesElement.scrollHeight;
    });

    // Se ainda existir evento antigo no Hub, não quebra:
    connection.on("PlayMusic", (streamUrl, startTime) => {
        console.warn("⚠️ Evento PlayMusic recebido, mas o projeto está em Opção A (YouTube embed). Ignorando:", streamUrl, startTime);
    });

    // --- 5) WebRTC signaling ---
    connection.on("UserJoinedVoice", async (senderId) => {
        const pc = createPeerConnection(senderId);
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        await connection.invoke("SendOffer", senderId, offer);
    });

    connection.on("ReceiveOffer", async (senderId, offer) => {
        const pc = createPeerConnection(senderId);
        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await connection.invoke("SendAnswer", senderId, answer);
    });

    connection.on("ReceiveAnswer", async (senderId, answer) => {
        const pc = peerConnections[senderId];
        if (pc) await pc.setRemoteDescription(new RTCSessionDescription(answer));
    });

    connection.on("ReceiveIceCandidate", async (senderId, candidate) => {
        const pc = peerConnections[senderId];
        if (pc) await pc.addIceCandidate(new RTCIceCandidate(candidate));
    });

    connection.on("UserLeftVoice", (userId) => {
        if (peerConnections[userId]) {
            peerConnections[userId].close();
            delete peerConnections[userId];
        }
    });

    // --- 6) Start Hub + Modal login ---
    connection
        .start()
        .then(() => {
            if (statusBadge) {
                statusBadge.innerHTML = '<span class="dot"></span> Online';
                statusBadge.classList.add("connected");
            }

            if (loginModal) {
                loginModal.show();
                loginModalElement.addEventListener("shown.bs.modal", () => userNameInput?.focus());
            }

            // Pré-carrega o YouTube player (opcional)
            ensureYTPlayer();
        })
        .catch((err) => console.error("Erro SignalR:", err));

    function performLogin() {
        let userName = (userNameInput?.value || "").trim();
        if (!userName) userName = "Anônimo_" + Math.floor(Math.random() * 100);

        currentUserName = userName;

        connection
            .invoke("SetUserName", userName)
            .then(() => {
                addSystemMessage(`Bem-vindo à rede, ${userName}!`);
                loginModal?.hide();
            })
            .catch((err) => {
                console.error("❌ Erro no SetUserName:", err);
                addSystemMessage("❌ Não consegui acessar a rede (erro no servidor). Veja o console.");
            });
    }

    btnConfirmLogin?.addEventListener("click", performLogin);
    userNameInput?.addEventListener("keypress", (e) => {
        if (e.key === "Enter") performLogin();
    });

    // --- 7) Botões / eventos gerais ---
    function handleSendMessage() {
        const msg = (chatInputElement?.value || "").trim();
        if (!msg) return;

        connection
            .invoke("SendMessage", msg)
            .then(() => {
                chatInputElement.value = "";
                chatInputElement.focus();
            })
            .catch((err) => console.error("Erro SendMessage:", err));
    }

    chatSendButton?.addEventListener("click", handleSendMessage);
    chatInputElement?.addEventListener("keypress", (e) => {
        if (e.key === "Enter") handleSendMessage();
    });

    document.getElementById("btnJoinVoice")?.addEventListener("click", joinVoice);

    // --- 8) Botão: Adicionar música (YouTube URL) ---
    document.getElementById("btnTransmitir")?.addEventListener("click", async function () {
        const btn = this;
        const url = (musicUrlInput?.value || "").trim();
        if (!url) return;

        // libera som do YouTube (gesto do usuário)
        ytUnlocked = true;
        try { if (ytPlayer) ytPlayer.unMute(); } catch { }

        console.log("1. Botão clicado. URL:", url);
        btn.disabled = true;
        btn.innerHTML = '<i class="bi bi-hourglass-split"></i> ADICIONAR';

        console.log("2. Chamando connection.invoke('RequestMusic')...");
        connection.invoke("RequestMusic", url)
            .then(() => {
                console.log("3. O Servidor respondeu ao Invoke com sucesso!");
                musicUrlInput.value = "";
                addSystemMessage("🚀 Requisição enviada. Aguarde o processamento do servidor.");
            })
            .catch(err => {
                console.error("❌ ERRO NO INVOKE:", err);
                addSystemMessage("❌ Erro ao chamar o servidor.");
            })
            .finally(() => {
                console.log("4. Finalizado processo de clique.");
                btn.disabled = false;
                btn.innerHTML = '<i class="bi bi-play-fill"></i> ADICIONAR';
            });
    });

    // Também libera som no primeiro clique em qualquer lugar (autoplay policy)
    document.addEventListener(
        "click",
        () => {
            ytUnlocked = true;
            try {
                if (ytPlayer) ytPlayer.unMute();
            } catch { }
        },
        { once: true }
    );

    // --- YouTube helpers ---
    async function loadYouTubeApiOnce() {
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
        if (!host) {
            console.warn("⚠️ Falta a div #yt-host no HTML. Adicione: <div id='yt-host' ...></div>");
            return null;
        }

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
                    playsinline: 1
                },
                events: {
                    onReady: () => {
                        ytReady = true;
                        resolve(ytPlayer);

                        // aplica pedido pendente (se chegou antes do ready)
                        if (pendingYT) {
                            playYouTube(pendingYT.videoId, pendingYT.startTime);
                            pendingYT = null;
                        }
                    },
                    onError: (e) => {
                        console.error("❌ YouTube Player erro:", e);
                        addSystemMessage("❌ Erro do player do YouTube.");
                    }
                }
            });
        });
    }

    async function playYouTube(videoId, startTime) {
        const p = await ensureYTPlayer();
        if (!p) return;

        const start = Math.max(0, Math.floor(Number(startTime) || 0));

        try {
            // Sempre carrega
            p.loadVideoById({ videoId, startSeconds: start });

            // Deixa o vídeo iniciar
            p.playVideo();

            // Volume alto (opcional)
            try { p.setVolume(100); } catch { }

            // Se o usuário já clicou em algo, tenta desmutar depois de iniciar
            setTimeout(() => {
                if (ytUnlocked) {
                    try { p.unMute(); } catch { }
                } else {
                    // Se ainda não teve clique, mantém mutado (autoplay policy)
                    try { p.mute(); } catch { }
                }
            }, 700);

            if (playerStatus) playerStatus.innerText = "Sintonizado: Transmissão ativa (YouTube)";
            console.log("✅ YouTube tocando:", videoId, "start:", start);
        } catch (e) {
            console.error("❌ Falha ao tocar YouTube:", e);
            addSystemMessage("❌ Falha ao iniciar player do YouTube.");
        }
    }


    // --- VOZ (WebRTC) ---
    async function joinVoice() {
        const btn = document.getElementById("btnJoinVoice");
        if (!btn) return;

        // toggle simples
        if (btn.classList.contains("active")) {
            leaveVoice();
            connection.invoke("LeaveVoice").catch(() => { });
            return;
        }

        try {
            localStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    channelCount: 1,
                    echoCancellation: false,
                    noiseSuppression: true,
                    autoGainControl: true,
                    sampleRate: 48000
                }
            });

            btn.classList.add("active");
            btn.innerText = "SAIR";
            btn.style.backgroundColor = "#ff4444";

            addSystemMessage("🎙️ Você entrou na call.");
            monitorVolume(localStream, connection.connectionId);

            await connection.invoke("JoinVoice");
        } catch (err) {
            console.error("Erro microfone:", err);
            addSystemMessage("❌ Falha no microfone.");
        }
    }

    function leaveVoice() {
        const btn = document.getElementById("btnJoinVoice");
        if (!btn) return;

        for (let id in peerConnections) {
            peerConnections[id].close();
            delete peerConnections[id];
        }

        if (localStream) {
            localStream.getTracks().forEach((track) => track.stop());
            localStream = null;
        }

        btn.classList.remove("active");
        btn.innerText = "ENTRAR";
        btn.style.backgroundColor = "";

        addSystemMessage("🔇 Você saiu da call.");

        // opcional: se tiver método LeaveVoice no Hub, chame
        // connection.invoke("LeaveVoice").catch(()=>{});
    }

    function createPeerConnection(senderId) {
        const pc = new RTCPeerConnection(rtcConfig);
        peerConnections[senderId] = pc;

        if (localStream) {
            localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));
        }

        pc.ontrack = (e) => {
            const container = document.getElementById("remote-audios") || document.body;

            let audio = document.getElementById(`remote-audio-${senderId}`);
            if (!audio) {
                audio = document.createElement("audio");
                audio.id = `remote-audio-${senderId}`;
                audio.autoplay = true;
                audio.playsInline = true;
                container.appendChild(audio);
            }

            audio.srcObject = e.streams[0];
            audio.play().catch(() => { }); 

            monitorVolume(e.streams[0], senderId);
        };

        pc.onicecandidate = (e) => {
            if (e.candidate) connection.invoke("SendIceCandidate", senderId, e.candidate);
        };

        return pc;
    }

    function monitorVolume(stream, connectionId) {
        const audioContext = new (window.AudioContext || window.webkitAudioContext)();
        const source = audioContext.createMediaStreamSource(stream);
        const analyser = audioContext.createAnalyser();
        analyser.fftSize = 256;
        source.connect(analyser);

        const dataArray = new Uint8Array(analyser.frequencyBinCount);

        function checkVolume() {
            analyser.getByteFrequencyData(dataArray);
            let values = 0;
            for (let i = 0; i < dataArray.length; i++) values += dataArray[i];

            const average = values / dataArray.length;
            const userDiv = document.getElementById(`user-${connectionId}`);

            if (userDiv) {
                if (average > 15) userDiv.classList.add("speaking-glow");
                else userDiv.classList.remove("speaking-glow");
            }

            requestAnimationFrame(checkVolume);
        }

        checkVolume();
    }
});

// --- helpers fora do DOMContentLoaded ---
function escapeHtml(t) {
    const d = document.createElement("div");
    d.textContent = String(t ?? "");
    return d.innerHTML;
}

function addSystemMessage(m) {
    const chatMessagesElement = document.getElementById("chat-messages");
    if (!chatMessagesElement) return;

    const div = document.createElement("div");
    div.className = "chat-message";
    div.style.fontStyle = "italic";
    div.style.opacity = "0.8";
    div.innerHTML = `<span style="color: #6E7681;"><i class="bi bi-info-circle me-1"></i> ${escapeHtml(m)}</span>`;

    chatMessagesElement.appendChild(div);
    chatMessagesElement.scrollTop = chatMessagesElement.scrollHeight;
}
