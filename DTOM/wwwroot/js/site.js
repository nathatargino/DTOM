"use strict";

let connection;
let audioPlayer, statusBadge, playerStatus, musicUrlInput;
let userListElement, chatMessagesElement, chatInputElement, chatSendButton;
let currentUserName = "";

// Variáveis WebRTC
let localStream;
let peerConnections = {};
const rtcConfig = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };

document.addEventListener("DOMContentLoaded", function () {
    // 1. Mapeamento de Elementos
    audioPlayer = document.getElementById("dtomPlayer");
    statusBadge = document.getElementById("connection-status");
    playerStatus = document.getElementById("player-status");
    musicUrlInput = document.getElementById("musicUrl");
    userListElement = document.getElementById("user-list");
    chatMessagesElement = document.getElementById("chat-messages");
    chatInputElement = document.getElementById("chat-input");
    chatSendButton = document.getElementById("btnSendChat");

    const loginModalElement = document.getElementById('loginModal');
    const loginModal = new bootstrap.Modal(loginModalElement);
    const userNameInput = document.getElementById('userNameInput');
    const btnConfirmLogin = document.getElementById('btnConfirmLogin');

    // 2. Configuração SignalR
    connection = new signalR.HubConnectionBuilder()
        .withUrl("/dtomHub")
        .withAutomaticReconnect()
        .build();

    // --- LISTENERS DE USUÁRIOS & CHAT ---
    connection.on("UpdateUserList", (users) => {
        if (!userListElement) return;
        userListElement.innerHTML = "";
        users.forEach(user => {
            const div = document.createElement("div");
            div.className = "user-item-modern";
            div.id = `user-${user.id}`;
            div.innerHTML = `<i class="bi bi-person-fill neon-text"></i> ${user.name}`;
            userListElement.appendChild(div);
        });
    });

    connection.on("ReceiveMessage", (userName, message, timestamp) => {
        const div = document.createElement("div");
        div.className = "chat-message";
        div.innerHTML = `<strong>${escapeHtml(userName)}:</strong> <span>${escapeHtml(message)}</span> <small>${timestamp}</small>`;
        chatMessagesElement.appendChild(div);
        chatMessagesElement.scrollTop = chatMessagesElement.scrollHeight;
    });

    // --- 🎵 NOVO: LISTENER DE MÚSICA (YOUTUBE) ---
    connection.on("PlayMusic", (streamUrl, startTime) => {
        if (!audioPlayer) return;
        console.log("📡 MENSAGEM RECEBIDA DO SERVIDOR! URL:", streamUrl);

        addSystemMessage("🎶 Nova frequência de áudio sintonizada.");

        audioPlayer.src = streamUrl;
        audioPlayer.play().then(() => {
            if (startTime > 0) audioPlayer.currentTime = startTime;
            if (playerStatus) playerStatus.innerText = "Sintonizado: Transmissão ativa";
        }).catch(err => {
            console.error("Erro na reprodução:", err);
            addSystemMessage("❌ Erro ao decodificar stream de áudio.");
        });
    });

    // --- LISTENERS DE VOZ (WEBRTC) ---
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

    // --- INICIALIZAÇÃO DO HUB & MODAL ---
    connection.start().then(() => {
        if (statusBadge) {
            statusBadge.innerHTML = '<span class="dot"></span> Online';
            statusBadge.classList.add("connected");
        }
        loginModal.show();
        loginModalElement.addEventListener('shown.bs.modal', () => {
            userNameInput.focus();
        });
    }).catch(err => console.error("Erro SignalR:", err));

    function performLogin() {
        let userName = userNameInput.value.trim();
        if (!userName) userName = "Anônimo_" + Math.floor(Math.random() * 100);
        currentUserName = userName;
        connection.invoke("SetUserName", userName).then(() => {
            addSystemMessage(`👋 Bem-vindo à rede, ${userName}!`);
            loginModal.hide();
        });
    }

    btnConfirmLogin?.addEventListener("click", performLogin);
    userNameInput?.addEventListener("keypress", (e) => { if (e.key === 'Enter') performLogin(); });

    // --- FUNÇÕES DE VOZ ---
    async function joinVoice() {
        const btn = document.getElementById("btnJoinVoice");
        if (btn.classList.contains("active")) {
            leaveVoice();
            return;
        }
        try {
            localStream = await navigator.mediaDevices.getUserMedia({
                audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
            });
            btn.classList.add("active");
            btn.innerText = "SAIR";
            btn.style.backgroundColor = "#ff4444";
            addSystemMessage("🎙️ Você entrou na call.");
            monitorVolume(localStream, connection.connectionId);
            await connection.invoke("JoinVoice");
        } catch (err) {
            addSystemMessage("❌ Falha no microfone.");
        }
    }

    function leaveVoice() {
        const btn = document.getElementById("btnJoinVoice");
        for (let id in peerConnections) {
            peerConnections[id].close();
            delete peerConnections[id];
        }
        if (localStream) {
            localStream.getTracks().forEach(track => track.stop());
            localStream = null;
        }
        btn.classList.remove("active");
        btn.innerText = "ENTRAR";
        btn.style.backgroundColor = "";
        addSystemMessage("🔇 Você saiu da call.");
        connection.invoke("LeaveVoice");
    }

    function createPeerConnection(senderId) {
        const pc = new RTCPeerConnection(rtcConfig);
        peerConnections[senderId] = pc;
        if (localStream) localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
        pc.ontrack = (e) => {
            const audio = new Audio();
            audio.srcObject = e.streams[0];
            audio.play();
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
            for (let i = 0; i < dataArray.length; i++) { values += dataArray[i]; }
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

    // --- EVENTOS GERAIS ---
    function handleSendMessage() {
        const msg = chatInputElement.value.trim();
        if (msg) {
            connection.invoke("SendMessage", msg).then(() => {
                chatInputElement.value = "";
                chatInputElement.focus();
            });
        }
    }

    chatSendButton?.addEventListener("click", handleSendMessage);
    chatInputElement?.addEventListener("keypress", (e) => { if (e.key === 'Enter') handleSendMessage(); });
    document.getElementById("btnJoinVoice")?.addEventListener("click", joinVoice);

    // --- 🎵 ADICIONAR MÚSICA (VERSÃO DEBUG) ---
    document.getElementById("btnTransmitir")?.addEventListener("click", function () {
        const btn = this;
        const url = musicUrlInput.value.trim();

        if (url) {
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
        }
    });

}); // <--- CHAVE E PARÊNTESES QUE FECHAM O DOMCONTENTLOADED

// --- FUNÇÕES AUXILIARES (FORA DO DOMCONTENTLOADED) ---
function escapeHtml(t) {
    const d = document.createElement('div');
    d.textContent = t;
    return d.innerHTML;
}

function addSystemMessage(m) {
    const chatMessagesElement = document.getElementById("chat-messages");
    if (!chatMessagesElement) return;
    const div = document.createElement("div");
    div.className = "chat-message";
    div.style.fontStyle = "italic";
    div.style.opacity = "0.8";
    div.innerHTML = `<span style="color: #6E7681;"><i class="bi bi-info-circle me-1"></i> ${m}</span>`;
    chatMessagesElement.appendChild(div);
    chatMessagesElement.scrollTop = chatMessagesElement.scrollHeight;
}