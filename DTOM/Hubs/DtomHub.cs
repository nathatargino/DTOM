using Microsoft.AspNetCore.SignalR;
using System.Collections.Concurrent;
using System.Text.RegularExpressions;

namespace DTOM.Hubs
{
    public class DtomHub : Hub
    {
        private const string VoiceGroup = "VOICE";

        // Usuários conectados (nome)
        private static readonly ConcurrentDictionary<string, string> Users = new();

        // Quem está dentro da call
        private static readonly ConcurrentDictionary<string, bool> VoiceUsers = new();

        // ===== Música (fila) =====
        private static readonly object MusicLock = new();
        private static readonly Queue<string> MusicQueue = new(); // videoIds
        private static string? CurrentVideoId;
        private static DateTime? StartUtc;
        private static bool IsPaused;
        private static double PausedAtSeconds;
        private static long PlayToken; // incrementa a cada troca (evita race)

        // ====== Usuários / Lista ======
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

            // remove da call (se estava)
            if (VoiceUsers.TryRemove(Context.ConnectionId, out _))
            {
                await Groups.RemoveFromGroupAsync(Context.ConnectionId, VoiceGroup);
                await Clients.Group(VoiceGroup).SendAsync("UserLeftVoice", Context.ConnectionId);
            }

            // mantém formato correto {id,name}
            var userListData = Users.Select(u => new { id = u.Key, name = u.Value }).ToList();
            await Clients.All.SendAsync("UpdateUserList", userListData);

            await base.OnDisconnectedAsync(exception);
        }

        // ====== Chat (comandos) ======
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
                case "/skip":
                    await Skip(userName);
                    break;
                case "/pause":
                    await TogglePause(userName);
                    break;
                case "/leave":
                    await StopAndClear(userName);
                    break;
                default:
                    await Clients.Caller.SendAsync("ReceiveMessage", "SISTEMA",
                        "⚠️ Comandos: /skip, /pause, /leave", DateTime.Now.ToString("HH:mm"));
                    break;
            }
        }

        // ====== Voz (Call) ======
        public async Task JoinVoice()
        {
            VoiceUsers[Context.ConnectionId] = true;
            await Groups.AddToGroupAsync(Context.ConnectionId, VoiceGroup);

            // lista REAL de quem já está na call
            var existing = VoiceUsers.Keys.Where(id => id != Context.ConnectionId).ToList();
            await Clients.Caller.SendAsync("ExistingVoiceUsers", existing);

            // avisa os outros da call
            await Clients.GroupExcept(VoiceGroup, Context.ConnectionId)
                .SendAsync("UserJoinedVoice", Context.ConnectionId);

            // sincroniza música atual para quem entrou
            (string? vid, bool paused, double atSeconds, long token) snap;
            lock (MusicLock)
            {
                snap = (CurrentVideoId, IsPaused, IsPaused ? PausedAtSeconds : GetElapsedUnsafe(), PlayToken);
            }

            if (!string.IsNullOrWhiteSpace(snap.vid))
            {
                if (snap.paused)
                    await Clients.Caller.SendAsync("PauseYouTube", snap.vid, snap.atSeconds, snap.token);
                else
                    await Clients.Caller.SendAsync("PlayYouTube", snap.vid, snap.atSeconds, snap.token);
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

        // ====== Signaling (WebRTC) ======
        public Task SendOffer(string targetId, object offer) =>
            Clients.Client(targetId).SendAsync("ReceiveOffer", Context.ConnectionId, offer);

        public Task SendAnswer(string targetId, object answer) =>
            Clients.Client(targetId).SendAsync("ReceiveAnswer", Context.ConnectionId, answer);

        public Task SendIceCandidate(string targetId, object candidate) =>
            Clients.Client(targetId).SendAsync("ReceiveIceCandidate", Context.ConnectionId, candidate);

        // ====== Música: adicionar (fila) ======
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
                    $"🎶 Tocando agora. Fila: {queueCount}", DateTime.Now.ToString("HH:mm"));
            }
            else
            {
                await Clients.Group(VoiceGroup).SendAsync("ReceiveMessage", "SISTEMA",
                    $"➕ Música adicionada na fila. Posição: {queueCount}", DateTime.Now.ToString("HH:mm"));
            }
        }

        // Cliente avisa que terminou (somente quem está na call)
        public async Task MusicEnded(long token)
        {
            if (!VoiceUsers.ContainsKey(Context.ConnectionId)) return;

            string? next = null;
            long newToken;
            bool stopped = false;

            lock (MusicLock)
            {
                // ignora callbacks antigos (evita múltiplos usuários dispararem ao mesmo tempo)
                if (token != PlayToken) return;

                if (MusicQueue.Count > 0)
                {
                    next = MusicQueue.Dequeue();
                    CurrentVideoId = next;
                    IsPaused = false;
                    PausedAtSeconds = 0;
                    StartUtc = DateTime.UtcNow;
                    PlayToken++;
                    newToken = PlayToken;
                }
                else
                {
                    CurrentVideoId = null;
                    IsPaused = false;
                    PausedAtSeconds = 0;
                    StartUtc = null;
                    PlayToken++;
                    newToken = PlayToken;
                    stopped = true;
                }
            }

            if (stopped)
            {
                await Clients.Group(VoiceGroup).SendAsync("StopYouTube", newToken);
                return;
            }

            await Clients.Group(VoiceGroup).SendAsync("PlayYouTube", next!, 0d, newToken);
        }

        private async Task Skip(string userName)
        {
            string? next = null;
            long token;
            bool stopped = false;
            int queueCount;

            lock (MusicLock)
            {
                if (MusicQueue.Count > 0)
                {
                    next = MusicQueue.Dequeue();
                    CurrentVideoId = next;
                    IsPaused = false;
                    PausedAtSeconds = 0;
                    StartUtc = DateTime.UtcNow;
                    PlayToken++;
                    token = PlayToken;
                }
                else
                {
                    CurrentVideoId = null;
                    IsPaused = false;
                    PausedAtSeconds = 0;
                    StartUtc = null;
                    PlayToken++;
                    token = PlayToken;
                    stopped = true;
                }

                queueCount = MusicQueue.Count;
            }

            if (stopped)
            {
                await Clients.Group(VoiceGroup).SendAsync("StopYouTube", token);
                await Clients.Group(VoiceGroup).SendAsync("ReceiveMessage", "SISTEMA",
                    $"⏭️ {userName} pulou. Fila vazia — música parada.", DateTime.Now.ToString("HH:mm"));
                return;
            }

            await Clients.Group(VoiceGroup).SendAsync("PlayYouTube", next!, 0d, token);
            await Clients.Group(VoiceGroup).SendAsync("ReceiveMessage", "SISTEMA",
                $"⏭️ {userName} pulou para a próxima. Fila: {queueCount}", DateTime.Now.ToString("HH:mm"));
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
                    "⚠️ Não há música para pausar/retomar.", DateTime.Now.ToString("HH:mm"));
                return;
            }

            if (snap.paused)
            {
                await Clients.Group(VoiceGroup).SendAsync("PauseYouTube", snap.vid, snap.atSeconds, snap.token);
                await Clients.Group(VoiceGroup).SendAsync("ReceiveMessage", "SISTEMA",
                    $"⏸️ {userName} pausou.", DateTime.Now.ToString("HH:mm"));
            }
            else
            {
                await Clients.Group(VoiceGroup).SendAsync("PlayYouTube", snap.vid, snap.atSeconds, snap.token);
                await Clients.Group(VoiceGroup).SendAsync("ReceiveMessage", "SISTEMA",
                    $"▶️ {userName} retomou.", DateTime.Now.ToString("HH:mm"));
            }
        }

        private async Task StopAndClear(string userName)
        {
            long token;
            lock (MusicLock)
            {
                MusicQueue.Clear();
                CurrentVideoId = null;
                IsPaused = false;
                PausedAtSeconds = 0;
                StartUtc = null;
                PlayToken++;
                token = PlayToken;
            }

            await Clients.Group(VoiceGroup).SendAsync("StopYouTube", token);
            await Clients.Group(VoiceGroup).SendAsync("ReceiveMessage", "SISTEMA",
                $"🛑 {userName} parou a música e limpou a fila.", DateTime.Now.ToString("HH:mm"));
        }

        private static double GetElapsedUnsafe()
        {
            if (!StartUtc.HasValue) return PausedAtSeconds;
            return Math.Max(0, (DateTime.UtcNow - StartUtc.Value).TotalSeconds);
        }

        private static string? ExtractYouTubeVideoId(string url)
        {
            if (string.IsNullOrWhiteSpace(url)) return null;

            var m = Regex.Match(url, @"v=([A-Za-z0-9_-]{11})");
            if (m.Success) return m.Groups[1].Value;

            m = Regex.Match(url, @"youtu\.be\/([A-Za-z0-9_-]{11})");
            if (m.Success) return m.Groups[1].Value;

            m = Regex.Match(url, @"shorts\/([A-Za-z0-9_-]{11})");
            if (m.Success) return m.Groups[1].Value;

            m = Regex.Match(url, @"embed\/([A-Za-z0-9_-]{11})");
            if (m.Success) return m.Groups[1].Value;

            return null;
        }
    }
}
