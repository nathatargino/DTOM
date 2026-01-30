using Microsoft.AspNetCore.SignalR;
using System.Collections.Concurrent;
using System.Text.RegularExpressions;
using YoutubeExplode.Videos;

namespace DTOM.Hubs
{
    public class DtomHub : Hub
    {
        private static readonly ConcurrentDictionary<string, string> Users = new();

        // Estado global do YouTube
        private static string? _currentVideoId;
        private static DateTime? _startTimeUtc;

        // Participantes da call de voz
        private static readonly ConcurrentDictionary<string, bool> VoiceUsers = new();

        // ===== Usuários / Login =====
        public async Task SetUserName(string name)
        {
            if (string.IsNullOrWhiteSpace(name)) name = "Anônimo";

            Users[Context.ConnectionId] = name;

            var userListData = Users.Select(u => new { id = u.Key, name = u.Value }).ToList();
            await Clients.All.SendAsync("UpdateUserList", userListData);

            // sincroniza música pra quem entrou depois
            if (!string.IsNullOrWhiteSpace(_currentVideoId) && _startTimeUtc.HasValue)
            {
                var elapsedSeconds = (DateTime.UtcNow - _startTimeUtc.Value).TotalSeconds;
                await Clients.Caller.SendAsync("PlayYouTube", _currentVideoId, elapsedSeconds);
            }
        }

        public override async Task OnDisconnectedAsync(Exception? exception)
        {
            Users.TryRemove(Context.ConnectionId, out _);

            // se estava na call, avisa
            if (VoiceUsers.TryRemove(Context.ConnectionId, out _))
            {
                await Clients.Others.SendAsync("UserLeftVoice", Context.ConnectionId);
            }

            var userListData = Users.Select(u => new { id = u.Key, name = u.Value }).ToList();
            await Clients.All.SendAsync("UpdateUserList", userListData);

            await base.OnDisconnectedAsync(exception);
        }

        // ===== Música (YouTube embed) =====
        public async Task RequestMusic(string youtubeUrl)
        {
            var videoId = ExtractYouTubeVideoId(youtubeUrl);

            if (string.IsNullOrWhiteSpace(videoId))
            {
                await Clients.Caller.SendAsync("ReceiveMessage", "SISTEMA", "⚠️ Link do YouTube inválido.", DateTime.Now.ToString("HH:mm"));
                return;
            }

            _currentVideoId = videoId;
            _startTimeUtc = DateTime.UtcNow;

            await Clients.All.SendAsync("PlayYouTube", videoId, 0);
            await Clients.All.SendAsync("ReceiveMessage", "SISTEMA", "🎶 Sintonizando via YouTube (player oficial)...", DateTime.Now.ToString("HH:mm"));
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

            try { return VideoId.Parse(url).Value; } catch { return null; }
        }

        // ===== Chat =====
        public async Task SendMessage(string message)
        {
            if (string.IsNullOrWhiteSpace(message)) return;

            if (!Users.TryGetValue(Context.ConnectionId, out var userName))
                userName = "Anônimo";

            await Clients.All.SendAsync("ReceiveMessage", userName, message, DateTime.Now.ToString("HH:mm:ss"));
        }

        // ===== WebRTC signaling (ESSENCIAL PRA VOZ) =====

        public async Task JoinVoice()
        {
            // marca como participante
            VoiceUsers[Context.ConnectionId] = true;

            // avisa os outros para criarem offer para este usuário
            await Clients.Others.SendAsync("UserJoinedVoice", Context.ConnectionId);
        }

        public async Task LeaveVoice()
        {
            if (VoiceUsers.TryRemove(Context.ConnectionId, out _))
            {
                await Clients.Others.SendAsync("UserLeftVoice", Context.ConnectionId);
            }
        }

        public Task SendOffer(string targetId, object offer) =>
            Clients.Client(targetId).SendAsync("ReceiveOffer", Context.ConnectionId, offer);

        public Task SendAnswer(string targetId, object answer) =>
            Clients.Client(targetId).SendAsync("ReceiveAnswer", Context.ConnectionId, answer);

        public Task SendIceCandidate(string targetId, object candidate) =>
            Clients.Client(targetId).SendAsync("ReceiveIceCandidate", Context.ConnectionId, candidate);
    }
}
