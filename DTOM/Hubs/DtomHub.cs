using Microsoft.AspNetCore.SignalR;
using DTOM.Services;
using System.Collections.Concurrent;

namespace DTOM.Hubs
{
    public class DtomHub : Hub
    {
        private readonly MusicService _musicService;
        private static readonly ConcurrentDictionary<string, string> Users = new();

        private static string? _currentStreamUrl;
        private static DateTime? _startTime;

        public DtomHub(MusicService musicService)
        {
            _musicService = musicService;
        }

        // --- MÉTODOS DE WEBRTC SIGNALING ---

        // 1. Envia uma oferta (Offer) para um usuário específico
        public async Task SendOffer(string targetId, object offer)
        {
            // O targetId é o ConnectionId do destinatário
            await Clients.Client(targetId).SendAsync("ReceiveOffer", Context.ConnectionId, offer);
        }

        // 2. Envia uma resposta para quem enviou a oferta
        public async Task SendAnswer(string targetId, object answer)
        {
            await Clients.Client(targetId).SendAsync("ReceiveAnswer", Context.ConnectionId, answer);
        }

        // 3. Troca candidatos ICE entre os pares
        public async Task SendIceCandidate(string targetId, object candidate)
        {
            await Clients.Client(targetId).SendAsync("ReceiveIceCandidate", Context.ConnectionId, candidate);
        }

        // --- MÉTODOS EXISTENTES ---

        public async Task SetUserName(string name)
        {
            Users[Context.ConnectionId] = name;
            var userListData = Users.Select(u => new { id = u.Key, name = u.Value }).ToList();
            await Clients.All.SendAsync("UpdateUserList", userListData);

            if (!string.IsNullOrEmpty(_currentStreamUrl) && _startTime.HasValue)
            {
                var elapsedSeconds = (DateTime.UtcNow - _startTime.Value).TotalSeconds;
                await Clients.Caller.SendAsync("PlayMusic", _currentStreamUrl, elapsedSeconds);
            }
        }

        public override async Task OnDisconnectedAsync(Exception? exception)
        {
            Users.TryRemove(Context.ConnectionId, out _);
            await Clients.All.SendAsync("UpdateUserList", Users.Values.ToList());
            await base.OnDisconnectedAsync(exception);
        }

        public async Task RequestMusic(string youtubeUrl)
        {
            try
            {
                Console.WriteLine($"[HUB] 🚀 Iniciando extração para: {youtubeUrl}");

                // 1. Extrai a URL real do áudio
                var streamUrl = await _musicService.GetAudioStreamUrl(youtubeUrl);

                if (!string.IsNullOrWhiteSpace(streamUrl))
                {
                    Console.WriteLine("[HUB] ✅ Sucesso na extração!");

                    // 2. Cria a URL do seu Proxy (que já configuramos)
                    var proxyUrl = $"/api/music/proxy?url={Uri.EscapeDataString(streamUrl)}";

                    // 3. Avisa todo mundo
                    await Clients.All.SendAsync("PlayMusic", proxyUrl, 0);

                    // 4. Mensagem no chat para confirmar
                    await Clients.All.SendAsync("ReceiveMessage", "SISTEMA", "🎶 Sintonizando nova frequência...", DateTime.Now.ToString("HH:mm"));
                }
                else
                {
                    Console.WriteLine("[HUB] ❌ O serviço retornou URL vazia.");
                    await Clients.Caller.SendAsync("ReceiveMessage", "SISTEMA", "⚠️ Não consegui sintonizar esse link. Tente outro vídeo.", DateTime.Now.ToString("HH:mm"));
                }
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[HUB] 💥 ERRO: {ex.Message}");
            }
        }

        public async Task SendMessage(string message)
        {
            try
            {
                if (string.IsNullOrWhiteSpace(message)) return;

                if (!Users.TryGetValue(Context.ConnectionId, out var userName))
                    userName = "Anônimo";

                await Clients.All.SendAsync("ReceiveMessage", userName, message, DateTime.Now.ToString("HH:mm:ss"));
            }
            catch (Exception ex)
            {
                await Clients.Caller.SendAsync("ChatError", $"Erro no chat: {ex.Message}");
            }
        }

        public async Task JoinVoice()
        {
            // Avisa que usuário entrou
            await Clients.Others.SendAsync("UserJoinedVoice", Context.ConnectionId);
        }

    }
}