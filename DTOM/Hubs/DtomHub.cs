using Microsoft.AspNetCore.SignalR;
using System.Collections.Concurrent;
using System.Text.RegularExpressions;

namespace DTOM.Hubs
{
    /// <summary>
    /// Hub principal para gerenciamento de chat, chamadas de voz e sincronização de música.
    /// Utiliza estados estáticos para persistência em memória durante o ciclo de vida da aplicação.
    /// </summary>
    public class DtomHub : Hub
    {
        private const string VoiceGroup = "VOICE";

        // Gerenciamento de Identidade: Mapeia ConnectionId -> Nome do Usuário
        private static readonly ConcurrentDictionary<string, string> Users = new();

        // Gerenciamento de Presença na Call: Mapeia ConnectionId -> Ativo
        private static readonly ConcurrentDictionary<string, bool> VoiceUsers = new();

        #region Estado Global de Música

        private static readonly object MusicLock = new();
        private static readonly Queue<string> MusicQueue = new();
        private static string? CurrentVideoId;
        private static DateTime? StartUtc;
        private static bool IsPaused;
        private static double PausedAtSeconds;

        /// <summary>
        /// Token incremental para evitar condições de corrida (Race Conditions) 
        /// entre comandos de Play/Stop de diferentes usuários.
        /// </summary>
        private static long PlayToken;

        #endregion

        #region Gerenciamento de Usuários

        /// <summary>
        /// Define o nome de exibição do usuário e atualiza a lista global.
        /// </summary>
        public async Task SetUserName(string name)
        {
            if (string.IsNullOrWhiteSpace(name))
                name = "Anônimo";

            Users[Context.ConnectionId] = name;

            var userListData = Users.Select(u => new { id = u.Key, name = u.Value }).ToList();
            await Clients.All.SendAsync("UpdateUserList", userListData);
        }

        public override async Task OnDisconnectedAsync(Exception? exception)
        {
            Users.TryRemove(Context.ConnectionId, out _);

            // Se o usuário estava em uma chamada, remove do grupo e notifica os pares
            if (VoiceUsers.TryRemove(Context.ConnectionId, out _))
            {
                await Groups.RemoveFromGroupAsync(Context.ConnectionId, VoiceGroup);
                await Clients.Group(VoiceGroup).SendAsync("UserLeftVoice", Context.ConnectionId);
            }

            var userListData = Users.Select(u => new { id = u.Key, name = u.Value }).ToList();
            await Clients.All.SendAsync("UpdateUserList", userListData);

            await base.OnDisconnectedAsync(exception);
        }

        #endregion

        #region Chat e Comandos

        /// <summary>
        /// Processa mensagens de texto e identifica comandos iniciados por "/".
        /// </summary>
        public async Task SendMessage(string message)
        {
            if (string.IsNullOrWhiteSpace(message)) return;

            if (!Users.TryGetValue(Context.ConnectionId, out var userName))
                userName = "Anônimo";

            var trimmed = message.Trim();

            if (trimmed.StartsWith("/", StringComparison.Ordinal))
            {
                await HandleChatCommand(trimmed, userName);
                return;
            }

            await Clients.All.SendAsync("ReceiveMessage", userName, message, DateTime.Now.ToString("HH:mm:ss"));
        }

        private async Task HandleChatCommand(string cmdLine, string userName)
        {
            if (!VoiceUsers.ContainsKey(Context.ConnectionId))
            {
                await Clients.Caller.SendAsync("ReceiveMessage", "SISTEMA",
                    "⚠️ Entre na call para usar comandos de música.", DateTime.Now.ToString("HH:mm"));
                return;
            }

            var cmd = cmdLine.Split(' ', 2)[0].ToLowerInvariant();

            switch (cmd)
            {
                case "/play":
                case "/pause":
                    await TogglePause(userName);
                    break;
                case "/skip":
                    await Skip(userName);
                    break;
                case "/leave":
                    await StopAndClear(userName);
                    break;
                default:
                    await Clients.Caller.SendAsync("ReceiveMessage", "SISTEMA",
                        "⚠️ Comandos: /play, /pause, /skip, /leave", DateTime.Now.ToString("HH:mm"));
                    break;
            }
        }

        #endregion

        #region Voz e Sincronização WebRTC

        /// <summary>
        /// Adiciona o usuário ao grupo de voz e sincroniza o estado atual da música para o novo integrante.
        /// </summary>
        public async Task JoinVoice()
        {
            VoiceUsers[Context.ConnectionId] = true;
            await Groups.AddToGroupAsync(Context.ConnectionId, VoiceGroup);

            // Lista de IDs ativos para o handshake P2P no Frontend
            var existing = VoiceUsers.Keys.Where(id => id != Context.ConnectionId).ToList();
            await Clients.Caller.SendAsync("ExistingVoiceUsers", existing);

            await Clients.GroupExcept(VoiceGroup, Context.ConnectionId)
                .SendAsync("UserJoinedVoice", Context.ConnectionId);

            // Captura de Snapshot para sincronização de tempo real da mídia
            (string? vid, bool paused, double atSeconds, long token) snap;
            lock (MusicLock)
            {
                snap = (CurrentVideoId, IsPaused, IsPaused ? PausedAtSeconds : GetElapsedUnsafe(), PlayToken);
            }

            if (!string.IsNullOrWhiteSpace(snap.vid))
            {
                string targetEvent = snap.paused ? "PauseYouTube" : "PlayYouTube";
                await Clients.Caller.SendAsync(targetEvent, snap.vid, snap.atSeconds, snap.token);
            }
        }

        public async Task LeaveVoice()
        {
            if (VoiceUsers.TryRemove(Context.ConnectionId, out _))
            {
                await Groups.RemoveFromGroupAsync(Context.ConnectionId, VoiceGroup);
                await Clients.Group(VoiceGroup).SendAsync("UserLeftVoice", Context.ConnectionId);
            }
        }

        // Métodos de Signaling WebRTC (Proxy de mensagens SDP/ICE entre Peers)
        public Task SendOffer(string targetId, object offer) =>
            Clients.Client(targetId).SendAsync("ReceiveOffer", Context.ConnectionId, offer);

        public Task SendAnswer(string targetId, object answer) =>
            Clients.Client(targetId).SendAsync("ReceiveAnswer", Context.ConnectionId, answer);

        public Task SendIceCandidate(string targetId, object candidate) =>
            Clients.Client(targetId).SendAsync("ReceiveIceCandidate", Context.ConnectionId, candidate);

        #endregion

        #region Lógica de Fila de Música

        /// <summary>
        /// Extrai o ID do vídeo e adiciona à fila global ou inicia a reprodução imediata.
        /// </summary>
        public async Task RequestMusic(string youtubeUrl)
        {
            if (!VoiceUsers.ContainsKey(Context.ConnectionId))
            {
                await Clients.Caller.SendAsync("ReceiveMessage", "SISTEMA",
                    "⚠️ Entre na call para tocar/escutar música.", DateTime.Now.ToString("HH:mm"));
                return;
            }

            var videoId = ExtractYouTubeVideoId(youtubeUrl);
            if (string.IsNullOrWhiteSpace(videoId))
            {
                await Clients.Caller.SendAsync("ReceiveMessage", "SISTEMA",
                    "⚠️ Link do YouTube inválido.", DateTime.Now.ToString("HH:mm"));
                return;
            }

            bool startNow = false;
            long token;
            int queueCount;

            lock (MusicLock)
            {
                if (string.IsNullOrWhiteSpace(CurrentVideoId))
                {
                    CurrentVideoId = videoId;
                    IsPaused = false;
                    PausedAtSeconds = 0;
                    StartUtc = DateTime.UtcNow;
                    PlayToken++;
                    token = PlayToken;
                    startNow = true;
                }
                else
                {
                    MusicQueue.Enqueue(videoId);
                    token = PlayToken;
                }
                queueCount = MusicQueue.Count;
            }

            if (startNow)
            {
                await Clients.Group(VoiceGroup).SendAsync("PlayYouTube", videoId, 0d, token);
                await Clients.Group(VoiceGroup).SendAsync("ReceiveMessage", "SISTEMA",
                    $"🎶 Tocando agora. Fila: {queueCount}", DateTime.Now.ToString("HH:mm:ss"));
            }
            else
            {
                await Clients.Group(VoiceGroup).SendAsync("ReceiveMessage", "SISTEMA",
                    $"➕ Adicionada na fila. Posição: {queueCount}", DateTime.Now.ToString("HH:mm:ss"));
            }
        }

        public async Task MusicEnded(long token)
        {
            if (!VoiceUsers.ContainsKey(Context.ConnectionId)) return;

            string? next = null;
            long newToken;
            bool stopped = false;

            lock (MusicLock)
            {
                if (token != PlayToken) return;

                if (MusicQueue.TryDequeue(out next))
                {
                    CurrentVideoId = next;
                    IsPaused = false;
                    PausedAtSeconds = 0;
                    StartUtc = DateTime.UtcNow;
                    PlayToken++;
                    newToken = PlayToken;
                }
                else
                {
                    ResetMusicState();
                    PlayToken++;
                    newToken = PlayToken;
                    stopped = true;
                }
            }

            if (stopped)
                await Clients.Group(VoiceGroup).SendAsync("StopYouTube", newToken);
            else
                await Clients.Group(VoiceGroup).SendAsync("PlayYouTube", next!, 0d, newToken);
        }

        private async Task Skip(string userName)
        {
            string? next = null;
            long token;
            bool stopped = false;

            lock (MusicLock)
            {
                if (MusicQueue.TryDequeue(out next))
                {
                    CurrentVideoId = next;
                    IsPaused = false;
                    PausedAtSeconds = 0;
                    StartUtc = DateTime.UtcNow;
                }
                else
                {
                    ResetMusicState();
                    stopped = true;
                }
                PlayToken++;
                token = PlayToken;
            }

            if (stopped)
            {
                await Clients.Group(VoiceGroup).SendAsync("StopYouTube", token);
                await Clients.Group(VoiceGroup).SendAsync("ReceiveMessage", "SISTEMA",
                    $"⏭️ {userName} pulou. Fila vazia.", DateTime.Now.ToString("HH:mm:ss"));
            }
            else
            {
                await Clients.Group(VoiceGroup).SendAsync("PlayYouTube", next!, 0d, token);
                await Clients.Group(VoiceGroup).SendAsync("ReceiveMessage", "SISTEMA",
                    $"⏭️ {userName} pulou para a próxima.", DateTime.Now.ToString("HH:mm:ss"));
            }
        }

        private async Task TogglePause(string userName)
        {
            (string? vid, bool paused, double atSeconds, long token) snap;

            lock (MusicLock)
            {
                if (string.IsNullOrWhiteSpace(CurrentVideoId))
                {
                    snap = (null, false, 0, PlayToken);
                }
                else if (!IsPaused)
                {
                    PausedAtSeconds = GetElapsedUnsafe();
                    IsPaused = true;
                    StartUtc = null;
                    snap = (CurrentVideoId, true, PausedAtSeconds, PlayToken);
                }
                else
                {
                    IsPaused = false;
                    StartUtc = DateTime.UtcNow.AddSeconds(-PausedAtSeconds);
                    snap = (CurrentVideoId, false, PausedAtSeconds, PlayToken);
                }
            }

            if (string.IsNullOrWhiteSpace(snap.vid))
            {
                await Clients.Caller.SendAsync("ReceiveMessage", "SISTEMA",
                    "⚠️ Não há música ativa.", DateTime.Now.ToString("HH:mm"));
                return;
            }

            string evt = snap.paused ? "PauseYouTube" : "PlayYouTube";
            string msg = snap.paused ? "⏸️ pausou." : "▶️ retomou.";

            await Clients.Group(VoiceGroup).SendAsync(evt, snap.vid, snap.atSeconds, snap.token);
            await Clients.Group(VoiceGroup).SendAsync("ReceiveMessage", "SISTEMA",
                $"{userName} {msg}", DateTime.Now.ToString("HH:mm:ss"));
        }

        private async Task StopAndClear(string userName)
        {
            long token;
            lock (MusicLock)
            {
                MusicQueue.Clear();
                ResetMusicState();
                PlayToken++;
                token = PlayToken;
            }

            await Clients.Group(VoiceGroup).SendAsync("StopYouTube", token);
            await Clients.Group(VoiceGroup).SendAsync("ReceiveMessage", "SISTEMA",
                $"🛑 {userName} parou a música.", DateTime.Now.ToString("HH:mm:ss"));
        }

        #endregion

        #region Helpers de Tempo e Regex

        private void ResetMusicState()
        {
            CurrentVideoId = null;
            IsPaused = false;
            PausedAtSeconds = 0;
            StartUtc = null;
        }

        private static double GetElapsedUnsafe()
        {
            if (!StartUtc.HasValue) return PausedAtSeconds;
            return Math.Max(0, (DateTime.UtcNow - StartUtc.Value).TotalSeconds);
        }

        private static string? ExtractYouTubeVideoId(string url)
        {
            if (string.IsNullOrWhiteSpace(url)) return null;

            // Suporta formatos: standard (v=), youtu.be, shorts e embed
            var patterns = new[]
            {
                @"v=([A-Za-z0-9_-]{11})",
                @"youtu\.be\/([A-Za-z0-9_-]{11})",
                @"shorts\/([A-Za-z0-9_-]{11})",
                @"embed\/([A-Za-z0-9_-]{11})"
            };

            foreach (var p in patterns)
            {
                var m = Regex.Match(url, p);
                if (m.Success) return m.Groups[1].Value;
            }
            return null;
        }

        #endregion
    }
}