using Microsoft.AspNetCore.SignalR;
using System.Collections.Concurrent;
using DTOM.Services;

namespace DTOM.Hubs
{
    public class DtomHub : Hub
    {
        private readonly MusicService _musicService;
        private static readonly ConcurrentDictionary<string, string> Users = new();

        // Estado global da música (opcional, para sincronizar quem entrar depois)
        private static string? _currentStreamUrl;
        private static DateTime? _startTimeUtc;

        public DtomHub(MusicService musicService)
        {
            _musicService = musicService;
        }

        public async Task SetUserName(string name)
        {
            if (string.IsNullOrWhiteSpace(name))
                name = "Anônimo";

            Users[Context.ConnectionId] = name;

            var userListData = Users.Select(u => new { id = u.Key, name = u.Value }).ToList();
            await Clients.All.SendAsync("UpdateUserList", userListData);

            // Se já tem música tocando, sincroniza só o caller
            if (!string.IsNullOrWhiteSpace(_currentStreamUrl) && _startTimeUtc.HasValue)
            {
                var elapsedSeconds = (DateTime.UtcNow - _startTimeUtc.Value).TotalSeconds;
                await Clients.Caller.SendAsync("PlayMusic", _currentStreamUrl, elapsedSeconds);
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
            {
                await Clients.Caller.SendAsync("ReceiveMessage", "SISTEMA", "⚠️ Cole um link do YouTube.", DateTime.Now.ToString("HH:mm"));
                return;
            }

            // O front vai tocar via endpoint do controller
            var streamEndpoint = $"/api/music/stream?youtubeUrl={Uri.EscapeDataString(youtubeUrl)}";

            _currentStreamUrl = streamEndpoint;
            _startTimeUtc = DateTime.UtcNow;

            await Clients.All.SendAsync("PlayMusic", streamEndpoint, 0);
            await Clients.All.SendAsync("ReceiveMessage", "SISTEMA", "🎶 Sintonizando nova frequência...", DateTime.Now.ToString("HH:mm"));
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
    }
}
