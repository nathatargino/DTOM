using Microsoft.AspNetCore.SignalR;
using System.Collections.Concurrent;
using System.Text.RegularExpressions;
using YoutubeExplode;
using YoutubeExplode.Videos;


namespace DTOM.Hubs
{
    public class DtomHub : Hub
    {
        private static readonly ConcurrentDictionary<string, string> Users = new();

        // Estado global do YouTube (para sincronizar quem entrar depois)
        private static string? _currentVideoId;
        private static DateTime? _startTimeUtc;

        public async Task SetUserName(string name)
        {
            if (string.IsNullOrWhiteSpace(name))
                name = "Anônimo";

            Users[Context.ConnectionId] = name;

            var userListData = Users.Select(u => new { id = u.Key, name = u.Value }).ToList();
            await Clients.All.SendAsync("UpdateUserList", userListData);

            // Se já tem música tocando, sincroniza só o caller
            if (!string.IsNullOrWhiteSpace(_currentVideoId) && _startTimeUtc.HasValue)
            {
                var elapsedSeconds = (DateTime.UtcNow - _startTimeUtc.Value).TotalSeconds;
                await Clients.Caller.SendAsync("PlayYouTube", _currentVideoId, elapsedSeconds);
            }
        }

        public override async Task OnDisconnectedAsync(Exception? exception)
        {
            Users.TryRemove(Context.ConnectionId, out _);

            var userListData = Users.Select(u => new { id = u.Key, name = u.Value }).ToList();
            await Clients.All.SendAsync("UpdateUserList", userListData);

            await base.OnDisconnectedAsync(exception);
        }

        public async Task RequestMusic(string youtubeUrl)
        {
            if (string.IsNullOrWhiteSpace(youtubeUrl))
                return;
            var videoId = VideoId.Parse(youtubeUrl);

            _currentVideoId = videoId.Value;
            _startTimeUtc = DateTime.UtcNow;

            await Clients.All.SendAsync("PlayYouTube", videoId.Value, 0);
        }


        public async Task SendMessage(string message)
        {
            if (string.IsNullOrWhiteSpace(message)) return;

            if (!Users.TryGetValue(Context.ConnectionId, out var userName))
                userName = "Anônimo";

            await Clients.All.SendAsync("ReceiveMessage", userName, message, DateTime.Now.ToString("HH:mm:ss"));
        }

        public Task JoinVoice() =>
            Clients.Others.SendAsync("UserJoinedVoice", Context.ConnectionId);

        // Suporta: watch?v=, youtu.be/, shorts/, embed/
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
